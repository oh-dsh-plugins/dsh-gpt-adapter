import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-hmr'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createRequestBridge } from './bridge.js'
import { ModelSynchronizer } from './runtime.js'
import { restoreSnapshot, syncCacheKey, syncConfigKey } from './sync.js'
import { JsonStorage } from './storage.js'
import { Config as NativeConfig, PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  contextWindowTokens,
  resolveContextWindow,
  validContextWindow,
  type ContextWindowMode,
  type ContextWindowResolution,
} from './context-window.js'
import { installNativeAdapterBridge } from './native-adapter.js'
import {
  isGptModel,
  GPT_REASONING_LEVELS,
  resolveCapabilities,
} from './capabilities.js'
import {
  installSettingsOverlay,
  projectModel,
  type ContextWindowEdit,
  type ContextWindowWriter,
  type SettingsResolution,
} from './settings-overlay.js'
import {
  installCodexCompatibility,
  type CodexCompatibilityConfig,
  type CodexCompatibilityRuntime,
} from './codex.js'
import type {
  GptProtocol,
  ModelCapabilities,
  ModelOverride,
  ServiceTier,
  SpeedSelection,
  SyncConfig,
  SyncSnapshot,
  UpstreamModel,
} from './types.js'

type RouteOptions = {
  enabled: boolean
  allowUnadvertisedUltrafast?: boolean
  refreshIntervalMs: number
  capabilityCatalogUrl?: string
  overridesJSON: string
}

/** Validate the free-form JSON before it can reach native model projection. */
function parseModelOverrides(text: string): Record<string, ModelOverride> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('模型覆盖需要是有效的 JSON')
  }
  const object = (entry: unknown): entry is Record<string, any> =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  const nonempty = (entry: unknown): entry is string =>
    typeof entry === 'string' && entry.trim().length > 0
  if (!object(value)) throw new Error('模型覆盖需要是 JSON 对象')
  for (const [model, entry] of Object.entries(value)) {
    if (!object(entry)) throw new Error(`模型 ${model} 的覆盖需要是 JSON 对象`)
    const invalid = (field: string): never => {
      throw new Error(`模型 ${model} 的 ${field} 格式无效`)
    }
    if ('displayName' in entry && !nonempty(entry.displayName))
      invalid('displayName')
    if (
      'defaultReasoningId' in entry &&
      typeof entry.defaultReasoningId !== 'string'
    )
      invalid('defaultReasoningId')
    if (
      'supportsReasoning' in entry &&
      typeof entry.supportsReasoning !== 'boolean'
    )
      invalid('supportsReasoning')
    if ('contextWindow' in entry && !validContextWindow(entry.contextWindow))
      throw new Error('上下文窗口必须是正的安全整数')
    if (
      'maxOutputTokens' in entry &&
      !validContextWindow(entry.maxOutputTokens)
    )
      invalid('maxOutputTokens')
    if (
      'defaultServiceTier' in entry &&
      !['default', 'fast', 'ultrafast'].includes(entry.defaultServiceTier)
    )
      invalid('defaultServiceTier')
    if (
      'inputModalities' in entry &&
      (!Array.isArray(entry.inputModalities) ||
        entry.inputModalities.some(
          (v: unknown) => v !== 'text' && v !== 'image',
        ))
    )
      invalid('inputModalities')
    for (const field of ['reasoningChoices', 'serviceTiers']) {
      if (!(field in entry)) continue
      const choices = entry[field]
      if (
        !Array.isArray(choices) ||
        (field === 'serviceTiers' && !choices.length)
      )
        invalid(field)
      const ids = new Set<string>()
      for (const choice of choices) {
        if (
          !object(choice) ||
          !nonempty(choice.id) ||
          !nonempty(choice.label) ||
          ids.has(choice.id)
        )
          invalid(field)
        ids.add(choice.id)
        if (
          'source' in choice &&
          !['user', 'upstream', 'catalog'].includes(choice.source)
        )
          invalid(field)
        if (field === 'serviceTiers') {
          if (
            !['default', 'fast', 'ultrafast'].includes(choice.id) ||
            !['default', 'fast', 'ultrafast', 'priority'].includes(
              choice.wireValue,
            )
          )
            invalid(field)
        } else if (
          !(choice.wireValue === null || nonempty(choice.wireValue)) ||
          (choice.id === 'off' && choice.wireValue === null)
        ) {
          invalid(field)
        }
      }
    }
  }
  return value as Record<string, ModelOverride>
}

const MANUAL_ULTRAFAST = {
  id: 'manual-ultrafast',
  label: 'Ultrafast',
  wireValue: 'ultrafast',
  source: 'user',
} as const

const MANUAL_SPEED = {
  defaultServiceTier: 'default',
  serviceTiers: [
    {
      id: 'default',
      label: 'Standard',
      wireValue: 'default',
      source: 'catalog',
    },
    MANUAL_ULTRAFAST,
  ],
} satisfies SpeedCapability

type SpeedCapability = {
  defaultServiceTier: ServiceTier
  serviceTiers: Array<
    ModelCapabilities['serviceTiers'][number] | typeof MANUAL_ULTRAFAST
  >
}

function effectiveSpeed(
  capability: SpeedCapability | undefined,
  saved: ServiceTier | undefined,
): ServiceTier {
  return saved && capability?.serviceTiers.some((tier) => tier.id === saved)
    ? saved
    : (capability?.defaultServiceTier ?? 'default')
}

function validSpeedCache(
  value: unknown,
): value is Record<string, SpeedSelection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, tier]) => {
    if (!['default', 'fast', 'ultrafast', 'manual-ultrafast'].includes(tier))
      return false
    try {
      const parts: unknown = JSON.parse(key)
      return (
        Array.isArray(parts) &&
        parts.length === 3 &&
        parts.every((part) => typeof part === 'string')
      )
    } catch {
      return false
    }
  })
}

type SessionSpeeds = {
  sessionId: string
  speeds: Record<string, SpeedSelection>
}

function validSessionSpeeds(value: unknown): value is SessionSpeeds {
  if (
    !value ||
    typeof value !== 'object' ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !('speeds' in value) ||
    !validSpeedCache(value.speeds)
  )
    return false
  return Object.keys(value.speeds).every(
    (key) => JSON.parse(key)[0] === value.sessionId,
  )
}

type SettingsRead = {
  rows: any[]
  descriptor: any
  routes: PluginConfig['routes']
  manualUltrafast: Record<string, boolean>
  snapshots: Map<string, SyncSnapshot>
  overrides: Map<string, Record<string, ModelOverride>>
  models: WeakMap<object, Map<string, any>>
  upstream: Map<string, Map<string, UpstreamModel>>
  builtin: Map<string, Map<string, any>>
  outputDefaults: WeakMap<object, number>
}
export type PluginConfig = {
  routes: Record<string, RouteOptions>
  manualUltrafast?: Record<string, boolean>
  codexCompatibility?: Partial<CodexCompatibilityConfig>
}

export const name = 'gpt-adapter'
export const inject = ['settings', 'credentials', 'llm']
export const Config: z<
  PluginConfig,
  {
    routes: { get(): PluginConfig['routes'] }
    manualUltrafast: { get(): Record<string, boolean> }
    codexCompatibility: CodexCompatibilityConfig
  }
> = z
  .object({
    routes: z
      .dict(
        z.object({
          enabled: z.boolean().default(false),
          allowUnadvertisedUltrafast: z.boolean().default(false),
          refreshIntervalMs: z
            .number()
            .min(1000)
            .max(2147483647)
            .default(1800000),
          capabilityCatalogUrl: z.string(),
          overridesJSON: z.string().default('{}'),
        }),
      )
      .default({})
      .volatile(),
    manualUltrafast: z.dict(z.boolean()).default({}).volatile(),
    codexCompatibility: z
      .object({
        enabled: z.boolean().default(true),
        codexHome: z.string(),
        importInstructions: z.boolean().default(true),
        importSkills: z.boolean().default(true),
        importMcpServers: z.boolean().default(true),
        importPluginResources: z.boolean().default(true),
        watch: z.boolean().default(true),
        pollIntervalMs: z.number().min(250).max(60000).default(2000),
        mcpIdleTimeoutMs: z.number().min(0).max(2147483647).default(60000),
        mcpAllowlist: z.array(String).default([]),
      })
      .default({}),
  })
  .i18n({
    en: {
      routes: {
        $description: 'GPT adaptation routes',
        $value: {
          enabled: 'Enable GPT adaptation',
          allowUnadvertisedUltrafast:
            'Allow manual Ultrafast selection (requires upstream support)',
          refreshIntervalMs: 'Sync interval (milliseconds)',
          capabilityCatalogUrl: 'Capability catalog URL',
          overridesJSON: 'Model capability overrides (JSON)',
        },
      },
      manualUltrafast: {
        $description: 'Manual Ultrafast by Responses provider',
        $value: 'Allow manual Ultrafast selection (requires upstream support)',
      },
      codexCompatibility: {
        $description: 'Codex compatibility',
        enabled: 'Enable Codex compatibility',
        codexHome: 'Codex home directory',
        importInstructions: 'Import instructions',
        importSkills: 'Import skills',
        importMcpServers: 'Import MCP servers',
        importPluginResources: 'Import enabled plugin resources',
        watch: 'Watch for configuration and resource changes',
        pollIntervalMs: 'Configuration poll interval (milliseconds)',
        mcpIdleTimeoutMs:
          'MCP idle retention (milliseconds; 0 keeps connections)',
        mcpAllowlist:
          'MCP server allowlist (empty imports all enabled servers)',
      },
    },
    zh: {
      routes: {
        $description: 'GPT 适配路由',
        $value: {
          enabled: '启用 GPT 自动适配',
          allowUnadvertisedUltrafast: '允许手动选择 Ultrafast（需要上游支持）',
          refreshIntervalMs: '同步间隔（毫秒）',
          capabilityCatalogUrl: '能力目录 URL',
          overridesJSON: '模型能力覆盖（JSON）',
        },
      },
      manualUltrafast: {
        $description: '按 Responses 提供商启用手动 Ultrafast',
        $value: '允许手动选择 Ultrafast（需要上游支持）',
      },
      codexCompatibility: {
        $description: 'Codex 兼容',
        enabled: '启用 Codex 兼容',
        codexHome: 'Codex 主目录',
        importInstructions: '导入指令',
        importSkills: '导入技能',
        importMcpServers: '导入 MCP 服务器',
        importPluginResources: '导入已启用插件的资源',
        watch: '监听配置和资源变化',
        pollIntervalMs: '配置轮询间隔（毫秒）',
        mcpIdleTimeoutMs: 'MCP 空闲保留时间（毫秒；0 表示保持连接）',
        mcpAllowlist: 'MCP 服务器允许名单（空列表导入所有已启用服务器）',
      },
    },
  })

type BaseModelInfo = {
  provider: string
  id: string
  name: string
  reasoning?: unknown
  [key: string]: unknown
}
type NativeRequest = { reasoningEffort?: string; sessionId?: string }
export type NativeExtension = {
  model: BaseModelInfo
  preserveReasoning?: boolean
  tierOnly?: boolean
  prepare(options: NativeRequest): {
    payload: Record<string, unknown>
    manualUltrafast?: boolean
    observe(event: unknown): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gptModels: GptModels
  }
}

/** Source-mode Remote markers are consumed by the existing authenticated Gateway. */
export class GptModels extends Service {
  codex?: CodexCompatibilityRuntime
  contextWriter: ContextWindowWriter | undefined
  modelRevision: ((rows: any[]) => number) | undefined
  readonly typertRemote: ReturnType<typeof bindTypertRemote>
  private readonly runners = new Map<string, ModelSynchronizer>()
  private readonly runnerStates = new Map<
    string,
    { configuration: string; identity: string }
  >()
  private readonly snapshots = new Map<string, SyncSnapshot>()
  private readonly publications = new Map<string, Promise<void>>()
  private speeds = new Map<string, SpeedSelection>()
  private readonly manualSpeedEpochs = new Map<string, symbol>()
  private readonly legacySpeedSessions = new Set<string>()
  private readonly speedStore = new JsonStorage(
    dshHomePath('storages', 'gpt-adapter', 'session-speeds'),
  )
  private readonly results = new Map<
    string,
    {
      provider: string
      manualUltrafast: boolean
      tier: { requested: string; actual?: string }
    }
  >()
  private readonly store = new JsonStorage(
    dshHomePath('storages', 'gpt-adapter'),
  )
  private readonly nativeDescribe: Context['settings']['describe']
  private closed = false
  private speedWrites: Promise<void> = Promise.resolve()
  private nativeRead: { snapshot: object; read: SettingsRead } | undefined

  constructor(
    ctx: Context,
    private readonly options: PluginConfig,
    private readonly settingsNs: string,
  ) {
    super(ctx, 'gptModels')
    this.nativeDescribe = ctx.settings.describe.bind(ctx.settings)
    this.typertRemote = bindTypertRemote(this, 'gptModels')
    ctx.on('settings/document-updated', () => {
      this.nativeRead = undefined
    })
    ctx.on('llm/models-updated', () => {
      this.nativeRead = undefined
    })
    ctx.on('credentials/reference-updated', (ref) => {
      if (this.closed) return
      const read = this.readSettings()
      for (const [provider, profile] of Object.entries(
        this.configuredProfiles(read),
      )) {
        if (this.apiKeyRef(provider, profile) !== ref) continue
        this.runners.get(provider)?.dispose()
        this.runners.delete(provider)
        this.snapshots.delete(provider)
        this.nativeRead = undefined
        if (this.routeOptions(provider, profile, read)?.enabled)
          this.startRunner(provider)
        this.ctx.emit('llm/models-updated', provider)
      }
    })
    ctx.on('api-session/removed', (sessionId) => {
      const prefix = JSON.stringify([sessionId]).slice(0, -1) + ','
      for (const key of this.results.keys())
        if (key.startsWith(prefix)) this.results.delete(key)
      void this.writeSpeeds((next) => {
        for (const key of next.keys())
          if (key.startsWith(prefix)) next.delete(key)
      }).catch((error) =>
        this.ctx.logger.warn('Session speed cleanup failed', error),
      )
    })
    ctx.effect(() => async () => {
      this.closed = true
      for (const runner of this.runners.values()) runner.dispose()
      this.nativeRead = undefined
      this.results.clear()
      await Promise.allSettled([
        ...this.publications.values(),
        this.speedWrites,
      ])
    })
  }

  async initialize(): Promise<void> {
    const loading = this.speedWrites.then(async () => {
      const savedSpeeds = await this.store.read('speeds', validSpeedCache)
      const sessions = await this.speedStore.readAll(validSessionSpeeds)
      if (this.closed) return
      const overridden = new Set(sessions.map(({ sessionId }) => sessionId))
      const next = new Map<string, SpeedSelection>()
      for (const [key, value] of Object.entries(savedSpeeds ?? {})) {
        const [sessionId] = JSON.parse(key)
        this.legacySpeedSessions.add(sessionId)
        if (!overridden.has(sessionId)) next.set(key, value)
      }
      for (const { speeds } of sessions)
        for (const [key, value] of Object.entries(speeds)) next.set(key, value)
      this.speeds = next
    })
    this.speedWrites = loading.catch(() => undefined)
    await loading
    for (const provider of this.enabledProviders()) {
      const before = this.readSettings()
      const profile = this.configuredProfiles(before)[provider]
      if (!profile || !this.routeOptions(provider, profile, before)?.enabled)
        continue
      const state = this.routeState(provider, before)
      const identity = this.routeIdentity(provider, before)
      let initial = await this.store.read<SyncSnapshot>(`route:${provider}`)
      if (initial) {
        try {
          initial = restoreSnapshot(await this.routeConfig(provider), initial)
        } catch {
          initial = undefined
        }
      }
      if (this.closed) return
      // A credential event may have replaced this route while cache I/O waited.
      if (this.runners.has(provider)) continue
      const current = this.readSettings()
      const currentProfile = this.configuredProfiles(current)[provider]
      if (
        !currentProfile ||
        !this.routeOptions(provider, currentProfile, current)?.enabled
      )
        continue
      if (
        this.routeState(provider, current) !== state ||
        this.routeIdentity(provider, current) !== identity
      )
        initial = undefined
      if (initial) {
        this.snapshots.set(provider, structuredClone(initial))
        this.nativeRead = undefined
      }
      this.startRunner(provider, initial, current)
    }
    let scheduled = false
    const reconcile = () => {
      if (this.closed) return
      const read = this.readSettings()
      const profiles = this.configuredProfiles(read)
      const enabled = new Set(this.enabledProviders(read))
      const affected = new Set([...this.runners.keys(), ...enabled])
      for (const [provider, runner] of this.runners)
        if (!enabled.has(provider)) {
          runner.dispose()
          this.runners.delete(provider)
        }
      for (const provider of new Set([
        ...this.runnerStates.keys(),
        ...this.snapshots.keys(),
      ]))
        if (!Object.hasOwn(profiles, provider)) {
          this.runnerStates.delete(provider)
          this.snapshots.delete(provider)
        }
      for (const provider of enabled) {
        const previous = this.runnerStates.get(provider)
        const identity = this.routeIdentity(provider, read)
        if (previous && previous.identity !== identity) {
          this.snapshots.delete(provider)
          this.nativeRead = undefined
        }
        if (
          this.runners.has(provider) &&
          previous?.configuration !== this.routeState(provider, read)
        ) {
          this.runners.get(provider)!.dispose()
          this.runners.delete(provider)
        }
        if (!this.runners.has(provider))
          this.startRunner(provider, this.snapshots.get(provider), read)
      }
      for (const provider of affected)
        this.ctx.emit('llm/models-updated', provider)
    }
    this.ctx.on('settings/document-updated', (ns) => {
      if (
        (ns !== 'llm-pi-ai' && ns !== this.settingsNs) ||
        scheduled ||
        this.closed
      )
        return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        reconcile()
      })
    })
    // Settings events emitted during awaited cache work predate this listener.
    reconcile()
  }

  private readSettings(rows = this.nativeDescribe()): SettingsRead {
    return {
      rows,
      descriptor: rows.find((entry) => entry.ns === 'llm-pi-ai'),
      routes: this.options.routes,
      manualUltrafast: this.options.manualUltrafast ?? {},
      snapshots: new Map(this.snapshots),
      overrides: new Map(),
      models: new WeakMap(),
      upstream: new Map(),
      builtin: new Map(),
      outputDefaults: new WeakMap(),
    }
  }

  private configuredProfiles(read = this.readSettings()): Record<string, any> {
    return read.descriptor?.value?.providers ?? {}
  }

  private modelIndex(read: SettingsRead, profile: Record<string, any>) {
    const key = profile.models ?? profile
    let index = read.models.get(key)
    if (!index) {
      index = new Map(
        (profile.models ?? []).map((model: any) => [model.id, model]),
      )
      read.models.set(key, index)
    }
    return index
  }

  private builtinIndex(read: SettingsRead, provider: string) {
    let index = read.builtin.get(provider)
    if (!index) {
      index = new Map(
        getBuiltinModels(provider as never).map((model) => [model.id, model]),
      )
      read.builtin.set(provider, index)
    }
    return index
  }

  private builtinModel(read: SettingsRead, provider: string, modelId: string) {
    return this.builtinIndex(read, provider).get(modelId)
  }

  private upstreamModel(read: SettingsRead, provider: string, modelId: string) {
    let index = read.upstream.get(provider)
    if (!index) {
      index = new Map(
        read.snapshots
          .get(provider)
          ?.models.map((model) => [model.id, model]) ?? [],
      )
      read.upstream.set(provider, index)
    }
    return index.get(modelId)
  }

  private modelOverrides(read: SettingsRead, provider: string, profile: any) {
    let overrides = read.overrides.get(provider)
    if (!overrides) {
      overrides = parseModelOverrides(
        this.routeOptions(provider, profile, read)?.overridesJSON ?? '{}',
      )
      read.overrides.set(provider, overrides!)
    }
    return overrides!
  }

  private routeOptions(
    provider: string,
    profile?: Record<string, any>,
    read?: SettingsRead,
  ): RouteOptions | undefined {
    const explicit = (read?.routes ?? this.options.routes)[provider]
    if (explicit) return explicit
    profile ??= this.configuredProfiles(read)[provider]
    if (
      !profile ||
      !['openai-responses', 'openai-completions'].includes(
        profile.api ?? 'openai-responses',
      ) ||
      !profile.models?.some((model: { id: string }) => isGptModel(model))
    )
      return undefined
    return { enabled: true, refreshIntervalMs: 1800000, overridesJSON: '{}' }
  }

  enabledProviders(read = this.readSettings()): string[] {
    const profiles = this.configuredProfiles(read)
    return [
      ...new Set([...Object.keys(profiles), ...Object.keys(read.routes)]),
    ].filter(
      (provider) =>
        this.routeOptions(provider, profiles[provider], read)?.enabled &&
        profiles[provider],
    )
  }

  private startRunner(
    provider: string,
    initial?: SyncSnapshot,
    read = this.readSettings(),
  ): void {
    if (this.closed || this.runners.has(provider)) return
    this.runnerStates.set(provider, {
      configuration: this.routeState(provider, read),
      identity: this.routeIdentity(provider, read),
    })
    const runner = new ModelSynchronizer(
      () => this.routeConfig(provider),
      async (snapshot) => {
        await this.publish(
          provider,
          snapshot,
          () =>
            this.runners.get(provider) === runner &&
            runner.getStatus().state !== 'stopped',
        )
      },
      fetch,
      initial,
    )
    this.runners.set(provider, runner)
    runner.start()
  }

  private profile(provider: string, read = this.readSettings()) {
    const descriptor = read.descriptor
    const value = descriptor?.value as
      | {
          providers?: Record<
            string,
            {
              baseURL?: string
              api?: string
              reasoning?: string
              apiKeyEnv?: string
              defaultContextWindow?: number
              models?: Array<{ id: string; [key: string]: unknown }>
              modelOverrides?: Record<string, Record<string, unknown>>
            }
          >
        }
      | undefined
    const profile = value?.providers?.[provider]
    if (!descriptor || !profile)
      throw new Error('Configure this provider in Settings → Models first')
    return { descriptor, profile }
  }

  private apiKeyRef(provider: string, profile: { apiKeyEnv?: string }) {
    return (
      profile.apiKeyEnv ??
      (provider === 'openai' ? 'OPENAI_API_KEY' : undefined)
    )
  }

  private async routeConfig(provider: string): Promise<SyncConfig> {
    const { profile } = this.profile(provider)
    const options = this.routeOptions(provider, profile)
    if (!options?.enabled) throw new Error('GPT adaptation is disabled')
    const protocol = profile.api ?? 'openai-responses'
    if (protocol !== 'openai-completions' && protocol !== 'openai-responses')
      throw new Error('GPT adaptation requires an OpenAI protocol')
    const ref = this.apiKeyRef(provider, profile)
    if (!ref)
      throw new Error('Save an API key on the existing provider card first')
    const credential = await this.ctx.credentials.resolve(credentialRef(ref))
    if (!credential) throw new Error('Provider API key is unavailable')
    const defaults = this.ctx.llm
      .listConfigurableProviders()
      .find((entry: { provider: string }) => entry.provider === provider)
    const baseUrl = profile.baseURL ?? defaults?.defaultBaseURL
    if (!baseUrl) throw new Error('Set the provider base URL')
    const overrides = parseModelOverrides(options.overridesJSON)
    return {
      baseUrl,
      apiKey: credential.value,
      cacheIdentity: `${provider}:${ref}`,
      protocol,
      refreshIntervalMs: options.refreshIntervalMs,
      ...(options.capabilityCatalogUrl
        ? { capabilityCatalogUrl: options.capabilityCatalogUrl }
        : {}),
      overrides,
    }
  }

  private routeState(provider: string, read: SettingsRead): string {
    const { profile } = this.profile(provider, read)
    const options = this.routeOptions(provider, profile, read)
    // This switch changes request selection, not the model-list runner inputs.
    const { allowUnadvertisedUltrafast: _, ...syncOptions } = options ?? {}
    return JSON.stringify([
      profile.api,
      profile.baseURL,
      profile.apiKeyEnv,
      options ? syncOptions : undefined,
    ])
  }

  private routeIdentity(provider: string, read: SettingsRead): string {
    const { profile } = this.profile(provider, read)
    return JSON.stringify([
      profile.api ?? 'openai-responses',
      profile.baseURL ??
        this.ctx.llm
          .listConfigurableProviders()
          .find((entry: { provider: string }) => entry.provider === provider)
          ?.defaultBaseURL,
      this.apiKeyRef(provider, profile),
      this.routeOptions(provider, profile, read)?.capabilityCatalogUrl ?? '',
    ])
  }

  private publish(
    provider: string,
    snapshot: SyncSnapshot,
    ownsRoute: () => boolean,
  ): Promise<void> {
    const work = (this.publications.get(provider) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.publishSnapshot(provider, snapshot, ownsRoute))
    this.publications.set(provider, work)
    const finished = () => {
      if (this.publications.get(provider) === work)
        this.publications.delete(provider)
    }
    void work.then(finished, finished)
    return work
  }

  private async publishSnapshot(
    provider: string,
    snapshot: SyncSnapshot,
    ownsRoute: () => boolean,
  ): Promise<void> {
    const assertOwner = () => {
      if (this.closed || !ownsRoute()) throw new Error('synchronizer stopped')
    }
    assertOwner()
    const read = this.readSettings()
    const state = this.routeState(provider, read)
    const assertCurrent = () => {
      assertOwner()
      if (this.routeState(provider, this.readSettings()) !== state)
        throw new Error('configuration changed during publication')
    }
    const config = await this.routeConfig(provider)
    assertCurrent()
    if (
      snapshot.cacheKey !== syncCacheKey(config) ||
      snapshot.configKey !== syncConfigKey(config)
    )
      throw new Error('configuration changed during publication')
    const { profile } = this.profile(provider, read)
    const existing = profile.models ?? []
    const ids = new Set(existing.map((model) => model.id))
    const added = snapshot.models
      .filter((model) => !model.stale && !ids.has(model.id))
      .map((model) => ({ id: model.id, name: model.displayName ?? model.id }))
    // Native catalog overrides cannot coexist with an explicit model list.
    // Keep catalog mode intact; discovery still updates the plugin snapshot.
    if (added.length && !Object.keys(profile.modelOverrides ?? {}).length) {
      const models = [...existing, ...added].map((model) =>
        this.editableModel(provider, model, ids.has(model.id), read),
      )
      const settings = this.ctx.settings as unknown as Parameters<
        typeof installSettingsOverlay
      >[0]
      await settings.write!(
        'llm-pi-ai',
        (current: any) => {
          assertCurrent()
          current.providers ??= {}
          current.providers[provider] ??= {}
          current.providers[provider].models = models
          return current
        },
        this.modelsRevision(read),
        [['providers', provider, 'models']],
      )
    }
    assertCurrent()
    await this.store.write(`route:${provider}`, snapshot, assertCurrent)
    assertCurrent()
    this.snapshots.set(provider, snapshot)
    this.nativeRead = undefined
    this.ctx.emit('llm/models-updated', provider)
  }

  @Remote
  codexStatus() {
    return (
      this.codex?.status() ?? { enabled: false, refreshing: false, items: [] }
    )
  }

  @Remote
  async refreshCodex(): Promise<void> {
    await this.codex?.refresh()
  }

  @Remote
  status(provider: string) {
    const read = this.readSettings()
    const snapshot = read.snapshots.get(provider)
    const capabilities = { ...snapshot?.capabilities }
    const profile = this.configuredProfiles(read)[provider]
    const options = this.routeOptions(provider, profile, read)
    const contextWindows: Record<string, ContextWindowResolution> = {}
    if (options?.enabled && profile) {
      for (const model of profile.models ?? []) {
        const value = this.capability(
          provider,
          model.id,
          model.name as string | undefined,
          undefined,
          read,
        )
        if (value) {
          capabilities[model.id] = value
          contextWindows[model.id] = this.contextWindow(
            provider,
            model.id,
            undefined,
            undefined,
            read,
          )
        }
      }
    }
    return {
      enabled: options?.enabled ?? false,
      status: this.runners.get(provider)?.getStatus() ?? { state: 'idle' },
      models:
        snapshot?.models.map((model) => ({
          id: model.id,
          stale: model.stale ?? false,
        })) ?? [],
      capabilities,
      contextWindows,
      contextRevision: this.modelsRevision(read),
      canConfigureUltrafastFallback: this.supportsManualUltrafast(
        provider,
        profile,
        read,
      ),
      optionsRevision: read.rows.find((row) => row.ns === this.settingsNs)
        ?.revision as number | undefined,
      options: {
        ...(options ?? {
          enabled: false,
          refreshIntervalMs: 1800000,
          overridesJSON: '{}',
        }),
        allowUnadvertisedUltrafast: this.manualUltrafastConfigured(
          provider,
          read,
        ),
      },
    }
  }

  @Remote
  modelStatus(provider: string, modelId: string) {
    const capability = this.speedCapability(provider, modelId)
    return {
      enabled: !!capability,
      serviceTiers: capability?.serviceTiers ?? [],
    }
  }

  @Remote
  async configure(provider: string, enabled: boolean): Promise<void> {
    const read = this.readSettings()
    this.profile(provider, read)
    const descriptor = read.rows.find((entry) => entry.ns === this.settingsNs)
    if (!descriptor) throw new Error('GPT plugin settings unavailable')
    await this.ctx.settings.mutate(
      this.settingsNs,
      [
        {
          op: 'set',
          path: ['routes', provider],
          value: {
            ...this.options.routes[provider],
            enabled,
            refreshIntervalMs:
              this.options.routes[provider]?.refreshIntervalMs ?? 1800000,
            overridesJSON: this.options.routes[provider]?.overridesJSON ?? '{}',
          },
        },
      ],
      descriptor.revision,
    )
  }

  private supportsManualUltrafast(
    provider: string,
    profile: { api?: string; models?: readonly { id: string }[] } | undefined,
    read: SettingsRead,
    modelId?: string,
  ): boolean {
    if (!profile) return false
    if (profile.api !== undefined) return profile.api === 'openai-responses'
    // Match the native catalog: an explicit route API wins, followed by the
    // model's API and then the catalog's single shared API, if it has one.
    const builtin = this.builtinIndex(read, provider)
    const protocols = new Set([...builtin.values()].map((model) => model.api))
    const shared =
      protocols.size === 1 ? protocols.values().next().value : undefined
    const usesResponses = (id: string) =>
      (builtin.get(id)?.api ?? shared) === 'openai-responses'
    return modelId !== undefined
      ? usesResponses(modelId)
      : (profile.models?.length ? profile.models : [...builtin.values()]).some(
          (model) => usesResponses(model.id),
        )
  }

  private manualUltrafastConfigured(
    provider: string,
    read: SettingsRead,
  ): boolean {
    // Retain settings saved by older versions that stored this on the GPT route.
    return (
      read.manualUltrafast[provider] ??
      read.routes[provider]?.allowUnadvertisedUltrafast ??
      false
    )
  }

  private manualUltrafastEnabled(
    provider: string,
    modelId: string,
    profile: { api?: string; models?: readonly { id: string }[] },
    read: SettingsRead,
  ): boolean {
    return (
      this.manualUltrafastConfigured(provider, read) &&
      this.supportsManualUltrafast(provider, profile, read, modelId)
    )
  }

  private speedCapability(
    provider: string,
    modelId: string,
    read = this.readSettings(),
  ): SpeedCapability | undefined {
    const profile = this.configuredProfiles(read)[provider]
    if (!profile) return undefined
    const automatic = this.capability(
      provider,
      modelId,
      undefined,
      profile,
      read,
    )
    if (!this.manualUltrafastEnabled(provider, modelId, profile, read))
      return automatic
    if (!automatic) return MANUAL_SPEED
    return {
      ...automatic,
      serviceTiers: [...automatic.serviceTiers, MANUAL_ULTRAFAST],
    }
  }

  @Remote
  async setUltrafastFallback(
    provider: string,
    enabled: boolean,
    expectedRevision?: number,
  ): Promise<void> {
    await this.queueSpeedWrite(async () => {
      const read = this.readSettings()
      const { profile } = this.profile(provider, read)
      if (
        typeof enabled !== 'boolean' ||
        !this.supportsManualUltrafast(provider, profile, read)
      )
        throw new Error('Ultrafast fallback is unavailable for this provider')
      const descriptor = read.rows.find((entry) => entry.ns === this.settingsNs)
      if (!descriptor) throw new Error('GPT plugin settings unavailable')
      const revision = expectedRevision ?? descriptor.revision
      // Discard dormant selections from older installs or an interrupted
      // disable before opening the manual tier again.
      if (
        enabled &&
        !this.manualUltrafastConfigured(provider, read) &&
        revision === descriptor.revision
      )
        await this.clearUltrafastFallbackSpeeds(provider)
      await this.ctx.settings.mutate(
        this.settingsNs,
        [
          {
            op: 'set',
            path: ['manualUltrafast', provider],
            value: enabled,
          },
        ],
        revision,
      )
      if (!enabled) {
        this.manualSpeedEpochs.set(provider, Symbol())
        for (const [key, result] of this.results) {
          if (result.provider === provider && result.manualUltrafast)
            this.results.delete(key)
        }
        await this.clearUltrafastFallbackSpeeds(provider)
      }
    })
  }

  private async clearUltrafastFallbackSpeeds(provider: string): Promise<void> {
    await this.persistSpeeds((next) => {
      for (const [key, tier] of next) {
        if (tier !== MANUAL_ULTRAFAST.id) continue
        const [, savedProvider] = JSON.parse(key) as [string, string, string]
        if (savedProvider === provider) next.delete(key)
      }
    })
  }

  @Remote
  async updateOptions(
    provider: string,
    refreshIntervalMs: number,
    capabilityCatalogUrl: string,
    overridesJSON: string,
    expectedRevision?: number,
  ): Promise<void> {
    const read = this.readSettings()
    const { profile } = this.profile(provider, read)
    if (
      !Number.isInteger(refreshIntervalMs) ||
      refreshIntervalMs < 1000 ||
      refreshIntervalMs > 2147483647
    )
      throw new Error('同步间隔必须在 1 秒到 2147483647 毫秒之间')
    if (capabilityCatalogUrl) {
      let url: URL
      try {
        url = new URL(capabilityCatalogUrl)
      } catch {
        throw new Error('能力目录地址需要使用 HTTP 或 HTTPS')
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('能力目录地址需要使用 HTTP 或 HTTPS')
    }
    parseModelOverrides(overridesJSON)
    const descriptor = read.rows.find((entry) => entry.ns === this.settingsNs)
    if (!descriptor) throw new Error('GPT plugin settings unavailable')
    await this.ctx.settings.mutate(
      this.settingsNs,
      [
        {
          op: 'set',
          path: ['routes', provider],
          value: {
            ...this.options.routes[provider],
            enabled:
              this.routeOptions(provider, profile, read)?.enabled ?? false,
            refreshIntervalMs,
            capabilityCatalogUrl,
            overridesJSON,
          },
        },
      ],
      expectedRevision ?? descriptor.revision,
    )
  }

  @Remote
  async refresh(provider: string): Promise<void> {
    const runner = this.runners.get(provider)
    if (!runner) throw new Error('Enable GPT adaptation first')
    await runner.refresh()
  }

  @Remote
  async removeStale(provider: string): Promise<void> {
    const runner = this.runners.get(provider)
    if (!runner) throw new Error('Enable GPT adaptation first')
    const snapshot = runner.current()
    const staleIds =
      snapshot?.models
        .filter((model) => model.stale)
        .map((model) => model.id) ?? []
    if (!staleIds.length) return
    const read = this.readSettings()
    const state = this.routeState(provider, read)
    const assertCurrent = () => {
      if (
        this.closed ||
        this.runners.get(provider) !== runner ||
        runner.getStatus().state === 'stopped'
      )
        throw new Error('synchronizer stopped')
      if (this.routeState(provider, this.readSettings()) !== state)
        throw new Error('configuration changed during cleanup')
      const stale = new Set(
        this.snapshots
          .get(provider)
          ?.models.filter((model) => model.stale)
          .map((model) => model.id),
      )
      if (staleIds.some((id) => !stale.has(id)))
        throw new Error('model list changed during cleanup')
    }
    const config = await this.routeConfig(provider)
    assertCurrent()
    if (snapshot?.configKey !== syncConfigKey(config))
      throw new Error('configuration changed during cleanup; refresh first')
    const { profile } = this.profile(provider, read)
    const staleIdSet = new Set(staleIds)
    const nextModels = profile.models?.filter(
      (model) => !staleIdSet.has(model.id),
    )
    if (nextModels) {
      const models = nextModels.map((model) =>
        this.editableModel(provider, model, true, read),
      )
      const settings = this.ctx.settings as unknown as Parameters<
        typeof installSettingsOverlay
      >[0]
      await settings.write!(
        'llm-pi-ai',
        (current: any) => {
          assertCurrent()
          current.providers ??= {}
          current.providers[provider] ??= {}
          current.providers[provider].models = models
          return current
        },
        this.modelsRevision(read),
        [['providers', provider, 'models']],
      )
    }
    assertCurrent()
    await runner.removeStale(staleIds)
  }

  /** Internal model-list writes must use the same manual fields as native drafts. */
  private editableModel(
    provider: string,
    model: Record<string, any>,
    existing = true,
    read = this.readSettings(),
  ) {
    const capability = this.capability(
      provider,
      model.id,
      model.name,
      undefined,
      read,
    )
    if (!capability) return model
    const tokens = existing
      ? this.editableContextWindow(provider, model, read)
      : model.contextWindow
    return projectModel(
      provider,
      tokens === undefined ? model : { ...model, contextWindow: tokens },
      () => capability,
      undefined,
      false,
    )
  }

  editableContextWindow(
    provider: string,
    model: Record<string, any>,
    read = this.readSettings(),
  ) {
    const context = this.contextWindow(
      provider,
      model.id,
      undefined,
      undefined,
      read,
    )
    return context.source === 'legacy-override'
      ? context.effectiveTokens
      : model.contextWindow
  }

  /** Resolve raw metadata separately from merged capabilities and cached overrides. */
  contextWindow(
    provider: string,
    modelId: string,
    nativeDefault?: number,
    profileOverride?: {
      defaultContextWindow?: number
      models?: Array<{ id: string; [key: string]: unknown }>
      modelOverrides?: Record<string, Record<string, unknown>>
    },
    read = this.readSettings(),
  ): ContextWindowResolution {
    const { descriptor, profile: storedProfile } = this.profile(provider, read)
    const inherited = (descriptor.base as any)?.providers?.[provider]
    const profile = profileOverride
      ? { ...inherited, ...profileOverride }
      : storedProfile
    const overrides = this.modelOverrides(read, provider, profile)
    const row = profile.models?.length
      ? this.modelIndex(read, profile).get(modelId)
      : profile.modelOverrides?.[modelId]
    const snapshot = read.snapshots.get(provider)
    const raw = this.upstreamModel(read, provider, modelId)
    const userProfile =
      profileOverride ?? (descriptor.user as any)?.providers?.[provider]
    // Drafts replace the user layer; absent fields fall back to the inherited
    // profile. Schema defaults alone do not express a provider override.
    const providerDefault =
      userProfile?.defaultContextWindow ??
      (profile.defaultContextWindow !== 1000000 ||
      (descriptor.base === undefined && descriptor.user === undefined)
        ? profile.defaultContextWindow
        : undefined)
    const catalogModel = this.builtinModel(read, provider, modelId)
    return resolveContextWindow({
      modelId,
      legacy: overrides[modelId]?.contextWindow,
      native: row?.contextWindow,
      providerDefault,
      upstream: raw?.capabilities?.contextWindow,
      catalog: snapshot?.catalog?.models[modelId]?.contextWindow,
      nativeDefault:
        nativeDefault ??
        catalogModel?.contextWindow ??
        profile.defaultContextWindow,
    })
  }

  /** Both native form saves and the compatibility RPC validate the same budget. */
  validateContextWindow(
    provider: string,
    model: Record<string, any>,
    profile: Record<string, any>,
    read = this.readSettings(),
  ): void {
    const effective =
      model.contextWindow ??
      this.contextWindow(provider, model.id, undefined, profile, read)
        .defaultTokens
    const compaction = read.rows.find(
      (entry) => entry.ns === 'compaction-basic',
    )?.value as any
    const policy = compaction?.modelPolicies?.find(
      (entry: any) => entry.provider === provider && entry.model === model.id,
    )
    const headroom = policy?.headroomTokens ?? compaction?.headroomTokens ?? 0
    const inherited = (read.descriptor?.base as any)?.providers?.[provider]
    let defaultMaxTokens = read.outputDefaults.get(profile)
    if (defaultMaxTokens === undefined) {
      defaultMaxTokens = NativeConfig({
        providers: {
          [provider]: {
            defaultMaxTokens:
              profile.defaultMaxTokens ?? inherited?.defaultMaxTokens,
          },
        },
      }).providers.get()[provider]!.defaultMaxTokens
      read.outputDefaults.set(profile, defaultMaxTokens)
    }
    // Match native catalog resolution: explicit model, catalog, provider default.
    const output =
      model.maxTokens ??
      this.builtinModel(read, provider, model.id)?.maxTokens ??
      defaultMaxTokens
    if (effective <= output + headroom)
      throw new Error('上下文窗口必须大于当前最大输出和压缩预留的总和')
  }

  contextWriteRevision(read = this.readSettings()): number | undefined {
    return read.rows.find((row) => row.ns === this.settingsNs)?.revision
  }

  /** Public form revisions also cover changes to projected model capacities. */
  private modelsRevision(read = this.readSettings()): number {
    if (this.modelRevision) return this.modelRevision(read.rows)
    const descriptor = read.descriptor
    if (!descriptor) throw new Error('模型设置暂不可用')
    return descriptor.revision
  }

  settingsResolution(rows: any[]): SettingsResolution {
    const read = this.readSettings(rows)
    return {
      resolve: (provider, model, profile) =>
        typeof model.id === 'string'
          ? this.capability(provider, model.id, model.name, profile, read)
          : undefined,
      writes: {
        editableContext: (provider, model) =>
          this.editableContextWindow(provider, model, read),
        validate: (provider, model, profile) =>
          this.validateContextWindow(provider, model, profile, read),
        revision: () => this.contextWriteRevision(read),
        saved: (edits, expected) => this.clearLegacyContext(edits, expected),
      },
    }
  }

  /** Remove only legacy context fields after the matching native save commits. */
  async clearLegacyContext(
    edits: ContextWindowEdit[],
    expected?: number,
  ): Promise<void> {
    const operations: Array<{ op: 'set'; path: string[]; value: string }> = []
    for (const provider of new Set(edits.map((edit) => edit.provider))) {
      const text = this.options.routes[provider]?.overridesJSON
      if (!text) continue
      const overrides = parseModelOverrides(text)
      let changed = false
      for (const edit of edits.filter((entry) => entry.provider === provider)) {
        const override = overrides[edit.modelId]
        if (override && Object.hasOwn(override, 'contextWindow')) {
          delete override.contextWindow
          changed = true
        }
      }
      if (changed)
        operations.push({
          op: 'set',
          path: ['routes', provider, 'overridesJSON'],
          value: JSON.stringify(overrides),
        })
    }
    if (operations.length)
      await this.ctx.settings.mutate(this.settingsNs, operations, expected)
  }

  @Remote
  async setContextWindow(
    provider: string,
    modelId: string,
    mode: ContextWindowMode,
    customTokens?: number,
    expectedRevision?: number,
  ): Promise<void> {
    const tokens = contextWindowTokens(mode, customTokens)
    const read = this.readSettings()
    const { profile } = this.profile(provider, read)
    if (!this.capability(provider, modelId, undefined, undefined, read))
      throw new Error('请先启用该 GPT 模型的自动适配')
    const index =
      profile.models?.findIndex((model) => model.id === modelId) ?? -1
    if (index < 0) throw new Error('模型已变更，请刷新后重试')
    if (!this.contextWriter) throw new Error('上下文设置暂不可用')
    await this.contextWriter(
      provider,
      modelId,
      tokens,
      expectedRevision ?? this.modelsRevision(read),
    )
    this.ctx.emit('llm/models-updated', provider)
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async setSpeed(
    sessionId: SessionId,
    provider: string,
    modelId: string,
    tier: SpeedSelection,
  ): Promise<void> {
    const key = JSON.stringify([sessionId, provider, modelId])
    await this.writeSpeeds((next) => {
      const read = this.readSettings()
      const capability = this.speedCapability(provider, modelId, read)
      if (!capability?.serviceTiers.some((choice) => choice.id === tier))
        throw new Error('This speed is unavailable for the selected model')
      next.set(key, tier)
    })
  }

  private writeSpeeds(
    change: (next: Map<string, SpeedSelection>) => void,
  ): Promise<void> {
    return this.queueSpeedWrite(() => this.persistSpeeds(change))
  }

  private queueSpeedWrite(work: () => Promise<void>): Promise<void> {
    const write = this.speedWrites.then(work)
    this.speedWrites = write.catch(() => undefined)
    return write
  }

  private async persistSpeeds(
    change: (next: Map<string, SpeedSelection>) => void,
  ): Promise<void> {
    const next = new Map(this.speeds)
    change(next)
    const changedBySession = new Map<string, string[]>()
    for (const key of new Set([...this.speeds.keys(), ...next.keys()])) {
      if (this.speeds.get(key) === next.get(key)) continue
      const [sessionId] = JSON.parse(key) as [string, string, string]
      const changed = changedBySession.get(sessionId) ?? []
      changed.push(key)
      changedBySession.set(sessionId, changed)
    }
    if (!changedBySession.size) return

    let persisted = this.speeds
    try {
      for (const [sessionId, changed] of changedBySession) {
        const entries = [...next].filter(
          ([key]) => JSON.parse(key)[0] === sessionId,
        )
        // An empty override keeps deleted legacy preferences from reappearing.
        if (entries.length || this.legacySpeedSessions.has(sessionId)) {
          await this.speedStore.write(sessionId, {
            sessionId,
            speeds: Object.fromEntries(entries),
          })
        } else {
          await this.speedStore.remove(sessionId)
        }
        if (persisted === this.speeds) persisted = new Map(this.speeds)
        for (const key of changed) {
          const value = next.get(key)
          if (value === undefined) persisted.delete(key)
          else persisted.set(key, value)
        }
      }
    } finally {
      // A provider-wide clear may have written only some sessions before failing.
      this.speeds = persisted
    }
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  speed(sessionId: SessionId, provider: string, modelId: string) {
    const read = this.readSettings()
    const key = JSON.stringify([sessionId, provider, modelId])
    const saved = this.speeds.get(key)
    const capability = this.speedCapability(provider, modelId, read)
    return {
      selected:
        saved && capability?.serviceTiers.some((tier) => tier.id === saved)
          ? saved
          : (capability?.defaultServiceTier ?? 'default'),
      last: capability ? (this.results.get(key)?.tier ?? null) : null,
    }
  }

  /** The same effective capability supplies the native settings page and requests. */
  capability(
    provider: string,
    modelId: string,
    displayName?: string,
    profileOverride?: { api?: string; reasoning?: string },
    read?: SettingsRead,
  ): ModelCapabilities | undefined {
    if (!isGptModel({ id: modelId })) return undefined
    read ??= this.readSettings()
    const profile = profileOverride ?? this.profile(provider, read).profile
    const options = this.routeOptions(provider, profile, read)
    if (!options?.enabled) return undefined
    if (
      !['openai-responses', 'openai-completions'].includes(
        profile.api ?? 'openai-responses',
      )
    )
      return undefined
    const overrides = this.modelOverrides(read, provider, profile)
    const override = {
      ...(GPT_REASONING_LEVELS.some((level) => level === profile.reasoning)
        ? { defaultReasoningId: profile.reasoning! }
        : {}),
      ...overrides[modelId],
    }
    const snapshot = read.snapshots.get(provider)
    const raw = this.upstreamModel(read, provider, modelId)
    const catalog = snapshot?.catalog?.models[modelId]
    // Cached capabilities already contain old local overrides. Rebuild from
    // raw metadata so removing an override takes effect without a network refresh.
    const result = resolveCapabilities(
      {
        ...(raw ?? { id: modelId, ...(displayName ? { displayName } : {}) }),
        capabilities: {
          ...catalog,
          ...(catalog?.reasoningChoices
            ? {
                reasoningChoices: catalog.reasoningChoices.map((choice) => ({
                  ...choice,
                  source: 'catalog' as const,
                })),
              }
            : {}),
          ...raw?.capabilities,
        },
      },
      snapshot?.capabilities[modelId]?.capabilityRevision ?? 'gpt-preset',
      override,
    )
    return {
      ...result,
      contextWindow: this.contextWindow(
        provider,
        modelId,
        undefined,
        undefined,
        read,
      ).effectiveTokens,
    }
  }

  /** Capture request controls for the version-checked native runtime extension. */
  capture(
    provider: string,
    modelId: string,
    base: BaseModelInfo,
    nativeSnapshot?: object,
  ): NativeExtension | undefined {
    let read: SettingsRead
    if (nativeSnapshot && this.nativeRead?.snapshot === nativeSnapshot) {
      read = this.nativeRead.read
    } else {
      read = this.readSettings()
      if (nativeSnapshot) this.nativeRead = { snapshot: nativeSnapshot, read }
    }
    const profile = this.configuredProfiles(read)[provider]
    if (!profile) return undefined
    const current = this.capability(provider, modelId, base.name, profile, read)
    const manualEnabled = this.manualUltrafastEnabled(
      provider,
      modelId,
      profile,
      read,
    )
    if (!current && !manualEnabled) return undefined
    // Outside GPT adaptation, the manual switch only forwards a selected tier.
    const tierOnly = !current
    const preserveReasoning = tierOnly || current.reasoning.status === 'unknown'
    const capabilities = current && structuredClone(current)
    const speeds = this.speeds
    const manualEpoch = this.manualSpeedEpochs.get(provider)
    const protocol = (profile.api ?? 'openai-responses') as GptProtocol
    const model = capabilities
      ? {
          ...base,
          context: {
            ...((base.context as object) ?? {}),
            contextWindow: this.contextWindow(
              provider,
              modelId,
              (base.context as { contextWindow?: number } | undefined)
                ?.contextWindow,
              undefined,
              read,
            ).effectiveTokens,
          },
          name:
            capabilities.displayName === modelId
              ? base.name
              : capabilities.displayName,
        }
      : base
    if (!preserveReasoning) delete model.reasoning
    if (!preserveReasoning && capabilities?.reasoning.choices.length)
      model.reasoning = {
        efforts: capabilities.reasoning.choices.map((choice) => ({
          id: choice.id,
          name: choice.label,
        })),
        ...(capabilities.reasoning.defaultId
          ? { defaultEffort: capabilities.reasoning.defaultId }
          : {}),
      }
    const bridge =
      capabilities &&
      createRequestBridge({
        currentSnapshot: () => undefined,
        resolveCapabilities: () => capabilities,
      })
    return {
      model,
      preserveReasoning,
      tierOnly,
      prepare: (options) => {
        const key = JSON.stringify([options.sessionId ?? '', provider, modelId])
        const saved = speeds.get(key)
        // Plain 'ultrafast' records are ambiguous: use them only as an
        // automatic choice, never as permission to send a manual tier.
        const manualPermissionCurrent =
          manualEpoch === this.manualSpeedEpochs.get(provider)
        const manualUltrafast =
          manualEnabled &&
          manualPermissionCurrent &&
          saved === MANUAL_ULTRAFAST.id
        if (!bridge && !manualUltrafast) {
          if (manualPermissionCurrent) this.results.delete(key)
          return { payload: {}, observe() {} }
        }
        const payload: Record<string, unknown> = bridge
          ? bridge.prepare({
              modelId,
              protocol,
              ...(preserveReasoning
                ? { reasoningId: null }
                : options.reasoningEffort
                  ? { reasoningId: options.reasoningEffort }
                  : {}),
              serviceTier: effectiveSpeed(
                capabilities,
                saved === 'manual-ultrafast' ? undefined : saved,
              ),
            })
          : {}
        if (manualUltrafast) payload.service_tier = MANUAL_ULTRAFAST.wireValue
        const tier: { requested: string; actual?: string } = {
          requested: String(payload.service_tier ?? 'default'),
        }
        const result = { provider, manualUltrafast, tier }
        if (!this.closed) {
          this.results.delete(key)
          this.results.set(key, result)
          if (this.results.size > 512)
            this.results.delete(this.results.keys().next().value!)
        }
        return {
          payload,
          manualUltrafast,
          observe: (event: unknown) => {
            const response =
              (
                event as {
                  response?: { service_tier?: string }
                  service_tier?: string
                } | null
              )?.response ?? (event as { service_tier?: string } | null)
            if (
              !this.closed &&
              this.results.get(key) === result &&
              typeof response?.service_tier === 'string'
            )
              tier.actual = response.service_tier
          },
        }
      },
    }
  }
}

export async function apply(
  ctx: Context,
  config: ReturnType<typeof Config>,
): Promise<void> {
  const require = createRequire(import.meta.url)
  const version = require('@deepseek-ai/dsh-llm-pi-ai/package.json').version
  const compatibility = JSON.parse(
    readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8'),
  ) as { runtimes: Array<{ adapterVersion: string; sourceSha256: string }> }
  const runtime = compatibility.runtimes.find(
    (entry) => entry.adapterVersion === version,
  )
  if (!runtime)
    throw new Error(
      `Unsupported DSH Pi AI adapter ${version}; expected ${compatibility.runtimes.map((entry) => entry.adapterVersion).join(', ')}`,
    )
  const sourceHash = createHash('sha256')
    .update(readFileSync(require.resolve('@deepseek-ai/dsh-llm-pi-ai')))
    .digest('hex')
  if (sourceHash !== runtime.sourceSha256)
    throw new Error(
      'The installed DSH Pi AI adapter differs from the verified build',
    )
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  const service = new GptModels(
    ctx,
    {
      get routes() {
        return config.routes.get() as PluginConfig['routes']
      },
      get manualUltrafast() {
        return config.manualUltrafast.get()
      },
    },
    ctx.fiber.entry?.options.id ?? name,
  )
  service.codex = installCodexCompatibility(ctx, config.codexCompatibility)
  ctx.effect(() =>
    installNativeAdapterBridge(
      PiAiAdapter.prototype as unknown as Parameters<
        typeof installNativeAdapterBridge
      >[0],
      (provider, model, base, snapshot) =>
        service.capture(provider, model, base, snapshot),
      ctx.llm,
    ),
  )
  ctx.effect(() => {
    const providers = service.enabledProviders()
    const dispose = installSettingsOverlay(
      ctx.settings as unknown as Parameters<typeof installSettingsOverlay>[0],
      (provider, model, profile) =>
        typeof model.id === 'string'
          ? service.capability(provider, model.id, model.name, profile)
          : undefined,
      {
        editableContext: (provider, model) =>
          service.editableContextWindow(provider, model),
        validate: (provider, model, profile) =>
          service.validateContextWindow(provider, model, profile),
        revision: () => service.contextWriteRevision(),
        saved: (edits, revision) => service.clearLegacyContext(edits, revision),
      },
      (rows) => service.settingsResolution(rows),
    )
    service.contextWriter = dispose.setContextWindow
    service.modelRevision = dispose.modelRevision
    return () => {
      service.contextWriter = undefined
      service.modelRevision = undefined
      dispose()
      for (const provider of providers) ctx.emit('llm/models-updated', provider)
    }
  })
  await service.initialize()
  for (const provider of service.enabledProviders())
    ctx.emit('llm/models-updated', provider)
}
