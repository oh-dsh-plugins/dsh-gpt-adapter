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
  mergeCapabilities,
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
  SyncConfig,
  SyncSnapshot,
} from './types.js'

type RouteOptions = {
  enabled: boolean
  refreshIntervalMs: number
  capabilityCatalogUrl?: string
  overridesJSON: string
}
type SettingsRead = {
  rows: any[]
  descriptor: any
  routes: PluginConfig['routes']
  snapshots: Map<string, SyncSnapshot>
  overrides: Map<string, Record<string, ModelOverride>>
  models: WeakMap<object, Map<string, any>>
  upstream: Map<string, Map<string, any>>
  builtin: Map<string, Map<string, any>>
  outputDefaults: WeakMap<object, number>
}
export type PluginConfig = {
  routes: Record<string, RouteOptions>
  codexCompatibility?: Partial<CodexCompatibilityConfig>
}

export const name = 'gpt-adapter'
export const inject = ['settings', 'credentials', 'llm']
export const Config: z<
  PluginConfig,
  {
    routes: { get(): PluginConfig['routes'] }
    codexCompatibility: CodexCompatibilityConfig
  }
> = z.object({
  routes: z
    .dict(
      z.object({
        enabled: z.boolean().default(false),
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
  prepare(options: NativeRequest): {
    payload: Record<string, unknown>
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
  private readonly snapshots = new Map<string, SyncSnapshot>()
  private readonly publications = new Map<string, Promise<void>>()
  private speeds = new Map<string, ServiceTier>()
  private readonly results = new Map<
    string,
    { requested: string; actual?: string }
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
      for (const key of this.results.keys())
        if (JSON.parse(key)[0] === sessionId) this.results.delete(key)
    })
    ctx.effect(() => async () => {
      this.closed = true
      for (const runner of this.runners.values()) runner.dispose()
      this.nativeRead = undefined
      this.results.clear()
      await Promise.allSettled(this.publications.values())
    })
  }

  async initialize(): Promise<void> {
    const savedSpeeds =
      await this.store.read<Record<string, ServiceTier>>('speeds')
    for (const [key, value] of Object.entries(savedSpeeds ?? {})) {
      if (value === 'default' || value === 'fast' || value === 'ultrafast')
        this.speeds.set(key, value)
    }
    for (const provider of this.enabledProviders()) {
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
      if (initial) {
        this.snapshots.set(provider, structuredClone(initial))
        this.nativeRead = undefined
      }
      this.startRunner(provider, initial)
    }
    let scheduled = false
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
        if (this.closed) return
        const enabled = new Set(this.enabledProviders())
        const affected = new Set([...this.runners.keys(), ...enabled])
        for (const [provider, runner] of this.runners)
          if (!enabled.has(provider)) {
            runner.dispose()
            this.runners.delete(provider)
          }
        for (const provider of enabled)
          if (!this.runners.has(provider)) this.startRunner(provider)
        for (const provider of affected)
          this.ctx.emit('llm/models-updated', provider)
      })
    })
  }

  private readSettings(rows = this.nativeDescribe()): SettingsRead {
    return {
      rows,
      descriptor: rows.find((entry) => entry.ns === 'llm-pi-ai'),
      routes: this.options.routes,
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

  private builtinModel(read: SettingsRead, provider: string, modelId: string) {
    let index = read.builtin.get(provider)
    if (!index) {
      index = new Map(
        getBuiltinModels(provider as never).map((model) => [model.id, model]),
      )
      read.builtin.set(provider, index)
    }
    return index.get(modelId)
  }

  private modelOverrides(read: SettingsRead, provider: string, profile: any) {
    let overrides = read.overrides.get(provider)
    if (!overrides) {
      overrides = JSON.parse(
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

  enabledProviders(): string[] {
    const profiles = this.configuredProfiles()
    return [
      ...new Set([
        ...Object.keys(profiles),
        ...Object.keys(this.options.routes),
      ]),
    ].filter(
      (provider) =>
        this.routeOptions(provider, profiles[provider])?.enabled &&
        profiles[provider],
    )
  }

  private startRunner(provider: string, initial?: SyncSnapshot): void {
    if (this.closed || this.runners.has(provider)) return
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
    const overrides: unknown = JSON.parse(options.overridesJSON)
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
      throw new Error('Model overrides must be an object')
    return {
      baseUrl,
      apiKey: credential.value,
      cacheIdentity: `${provider}:${ref}`,
      protocol,
      refreshIntervalMs: options.refreshIntervalMs,
      ...(options.capabilityCatalogUrl
        ? { capabilityCatalogUrl: options.capabilityCatalogUrl }
        : {}),
      overrides: overrides as Record<string, ModelOverride>,
    }
  }

  private routeState(provider: string, read: SettingsRead): string {
    const { profile } = this.profile(provider, read)
    return JSON.stringify([
      profile.api,
      profile.baseURL,
      profile.apiKeyEnv,
      this.routeOptions(provider, profile, read),
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
      options: options ?? {
        enabled: false,
        refreshIntervalMs: 1800000,
        overridesJSON: '{}',
      },
    }
  }

  @Remote
  modelStatus(provider: string, modelId: string) {
    const capability = this.capability(provider, modelId)
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

  @Remote
  async updateOptions(
    provider: string,
    refreshIntervalMs: number,
    capabilityCatalogUrl: string,
    overridesJSON: string,
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
      const url = new URL(capabilityCatalogUrl)
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('能力目录地址需要使用 HTTP 或 HTTPS')
    }
    const overrides: unknown = JSON.parse(overridesJSON)
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
      throw new Error('模型覆盖需要是 JSON 对象')
    for (const entry of Object.values(overrides)) {
      if (
        entry &&
        typeof entry === 'object' &&
        'contextWindow' in entry &&
        !validContextWindow(entry.contextWindow)
      )
        throw new Error('上下文窗口必须是正的安全整数')
    }
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
      descriptor.revision,
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
    const nextModels = profile.models?.filter(
      (model) => !staleIds.includes(model.id),
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
    let upstream = read.upstream.get(provider)
    if (!upstream) {
      upstream = new Map(
        snapshot?.models.map((model) => [model.id, model]) ?? [],
      )
      read.upstream.set(provider, upstream)
    }
    const raw = upstream.get(modelId)
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
      const overrides = JSON.parse(text)
      let changed = false
      for (const edit of edits.filter((entry) => entry.provider === provider)) {
        if (
          overrides[edit.modelId] &&
          Object.hasOwn(overrides[edit.modelId], 'contextWindow')
        ) {
          delete overrides[edit.modelId].contextWindow
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
    tier: ServiceTier,
  ): Promise<void> {
    const capability = this.capability(provider, modelId)
    if (!capability?.serviceTiers.some((choice) => choice.id === tier))
      throw new Error('This speed is unavailable for the selected model')
    const key = JSON.stringify([sessionId, provider, modelId])
    const write = this.speedWrites.then(async () => {
      const next = new Map(this.speeds)
      next.set(key, tier)
      await this.store.write('speeds', Object.fromEntries(next))
      this.speeds = next
    })
    this.speedWrites = write.catch(() => undefined)
    await write
  }

  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  speed(sessionId: SessionId, provider: string, modelId: string) {
    return {
      selected:
        this.speeds.get(JSON.stringify([sessionId, provider, modelId])) ??
        this.snapshots.get(provider)?.capabilities[modelId]
          ?.defaultServiceTier ??
        'default',
      last:
        this.results.get(JSON.stringify([sessionId, provider, modelId])) ??
        null,
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
    const current = read.snapshots.get(provider)?.capabilities[modelId]
    const result = current
      ? mergeCapabilities(current, override, current.capabilityRevision)
      : resolveCapabilities(
          { id: modelId, ...(displayName ? { displayName } : {}) },
          'gpt-preset',
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
    if (!isGptModel({ id: modelId })) return undefined
    let read: SettingsRead
    if (nativeSnapshot && this.nativeRead?.snapshot === nativeSnapshot) {
      read = this.nativeRead.read
    } else {
      read = this.readSettings()
      if (nativeSnapshot) this.nativeRead = { snapshot: nativeSnapshot, read }
    }
    const current = this.capability(
      provider,
      modelId,
      base.name,
      undefined,
      read,
    )
    if (!current) return undefined
    // The plugin preset also covers configured GPT models missing from the upstream list.
    const preserveReasoning = current.reasoning.status === 'unknown'
    const capabilities: ModelCapabilities = structuredClone(current)
    const speeds = this.speeds
    const { profile } = this.profile(provider, read)
    const protocol = (profile.api ?? 'openai-responses') as GptProtocol
    const model = {
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
    if (!preserveReasoning) delete model.reasoning
    if (!preserveReasoning && capabilities.reasoning.choices.length)
      model.reasoning = {
        efforts: capabilities.reasoning.choices.map((choice) => ({
          id: choice.id,
          name: choice.label,
        })),
        ...(capabilities.reasoning.defaultId
          ? { defaultEffort: capabilities.reasoning.defaultId }
          : {}),
      }
    const bridge = createRequestBridge({
      currentSnapshot: () => undefined,
      resolveCapabilities: () => capabilities,
    })
    return {
      model,
      preserveReasoning,
      prepare: (options) => {
        const key = JSON.stringify([options.sessionId ?? '', provider, modelId])
        const payload = bridge.prepare({
          modelId,
          protocol,
          ...(preserveReasoning
            ? { reasoningId: null }
            : options.reasoningEffort
              ? { reasoningId: options.reasoningEffort }
              : {}),
          ...(speeds.has(key) ? { serviceTier: speeds.get(key)! } : {}),
        })
        const result: { requested: string; actual?: string } = {
          requested: String(payload.service_tier ?? 'default'),
        }
        if (!this.closed) {
          this.results.delete(key)
          this.results.set(key, result)
          if (this.results.size > 512)
            this.results.delete(this.results.keys().next().value!)
        }
        return {
          payload,
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
              result.actual = response.service_tier
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
  if (version !== '0.2.2-rc.1')
    throw new Error(
      `Unsupported DSH Pi AI adapter ${version}; expected 0.2.2-rc.1`,
    )
  const compatibility = JSON.parse(
    readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8'),
  )
  const sourceHash = createHash('sha256')
    .update(readFileSync(require.resolve('@deepseek-ai/dsh-llm-pi-ai')))
    .digest('hex')
  if (sourceHash !== compatibility.sourceSha256)
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
