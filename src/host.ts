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
import { JsonStorage } from './storage.js'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { installNativeAdapterBridge } from './native-adapter.js'
import {
  isGptModel,
  GPT_REASONING_LEVELS,
  mergeCapabilities,
  resolveCapabilities,
} from './capabilities.js'
import { installSettingsOverlay, projectModel } from './settings-overlay.js'
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
export type PluginConfig = { routes: Record<string, RouteOptions> }

export const name = 'gpt-adapter'
export const inject = ['settings', 'credentials', 'llm']
export const Config: z<
  PluginConfig,
  { routes: { get(): PluginConfig['routes'] } }
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
  readonly typertRemote: ReturnType<typeof bindTypertRemote>
  private readonly runners = new Map<string, ModelSynchronizer>()
  private readonly snapshots = new Map<string, SyncSnapshot>()
  private readonly speeds = new Map<string, ServiceTier>()
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

  constructor(
    ctx: Context,
    private readonly options: PluginConfig,
    private readonly settingsNs: string,
  ) {
    super(ctx, 'gptModels')
    this.nativeDescribe = ctx.settings.describe.bind(ctx.settings)
    this.typertRemote = bindTypertRemote(this, 'gptModels')
    ctx.effect(() => () => {
      this.closed = true
      for (const runner of this.runners.values()) runner.dispose()
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
      const initial = await this.store.read<SyncSnapshot>(`route:${provider}`)
      if (this.closed) return
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

  private configuredProfiles(): Record<string, any> {
    return (
      (
        this.nativeDescribe().find((entry) => entry.ns === 'llm-pi-ai')
          ?.value as any
      )?.providers ?? {}
    )
  }

  private routeOptions(
    provider: string,
    profile = this.configuredProfiles()[provider],
  ): RouteOptions | undefined {
    const explicit = this.options.routes[provider]
    if (explicit) return explicit
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
        if (!this.closed) await this.publish(provider, snapshot)
      },
      fetch,
      initial,
    )
    this.runners.set(provider, runner)
    runner.start()
  }

  private profile(provider: string) {
    const descriptor = this.nativeDescribe().find(
      (entry) => entry.ns === 'llm-pi-ai',
    )
    const value = descriptor?.value as
      | {
          providers?: Record<
            string,
            {
              baseURL?: string
              api?: string
              reasoning?: string
              apiKeyEnv?: string
              models?: Array<{ id: string; [key: string]: unknown }>
            }
          >
        }
      | undefined
    const profile = value?.providers?.[provider]
    if (!descriptor || !profile)
      throw new Error('Configure this provider in Settings → Models first')
    return { descriptor, profile }
  }

  private async routeConfig(provider: string): Promise<SyncConfig> {
    const { profile } = this.profile(provider)
    const options = this.routeOptions(provider, profile)
    if (!options?.enabled) throw new Error('GPT adaptation is disabled')
    const protocol = profile.api ?? 'openai-responses'
    if (protocol !== 'openai-completions' && protocol !== 'openai-responses')
      throw new Error('GPT adaptation requires an OpenAI protocol')
    const ref =
      profile.apiKeyEnv ??
      (provider === 'openai' ? 'OPENAI_API_KEY' : undefined)
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

  private async publish(
    provider: string,
    snapshot: SyncSnapshot,
  ): Promise<void> {
    if (this.closed) return
    const { descriptor, profile } = this.profile(provider)
    const existing = profile.models ?? []
    const ids = new Set(existing.map((model) => model.id))
    const added = snapshot.models
      .filter((model) => !model.stale && !ids.has(model.id))
      .map((model) => ({ id: model.id, name: model.displayName ?? model.id }))
    if (added.length) {
      await this.ctx.settings.mutate(
        'llm-pi-ai',
        [
          {
            op: 'set',
            path: ['providers', provider, 'models'],
            value: [...existing, ...added].map((model) =>
              projectModel(provider, model, (route, row) =>
                this.capability(route, row.id, row.name),
              ),
            ),
          },
        ],
        descriptor.revision,
      )
    }
    if (this.closed) return
    await this.store.write(`route:${provider}`, snapshot)
    if (this.closed) return
    this.snapshots.set(provider, snapshot)
    this.ctx.emit('llm/models-updated', provider)
  }

  @Remote
  status(provider: string) {
    const snapshot = this.snapshots.get(provider)
    const capabilities = { ...snapshot?.capabilities }
    if (this.routeOptions(provider)?.enabled) {
      for (const model of this.profile(provider).profile.models ?? []) {
        const value = this.capability(
          provider,
          model.id,
          model.name as string | undefined,
        )
        if (value) capabilities[model.id] = value
      }
    }
    return {
      enabled: this.routeOptions(provider)?.enabled ?? false,
      status: this.runners.get(provider)?.getStatus() ?? { state: 'idle' },
      models:
        snapshot?.models.map((model) => ({
          id: model.id,
          stale: model.stale ?? false,
        })) ?? [],
      capabilities,
      options: this.routeOptions(provider) ?? {
        enabled: false,
        refreshIntervalMs: 1800000,
        overridesJSON: '{}',
      },
    }
  }

  @Remote
  async configure(provider: string, enabled: boolean): Promise<void> {
    this.profile(provider)
    const descriptor = this.ctx.settings
      .describe()
      .find((entry) => entry.ns === this.settingsNs)
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
    this.profile(provider)
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
    const descriptor = this.ctx.settings
      .describe()
      .find((entry) => entry.ns === this.settingsNs)
    if (!descriptor) throw new Error('GPT plugin settings unavailable')
    await this.ctx.settings.mutate(
      this.settingsNs,
      [
        {
          op: 'set',
          path: ['routes', provider],
          value: {
            ...this.options.routes[provider],
            enabled: this.routeOptions(provider)?.enabled ?? false,
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
    const staleIds =
      runner
        .current()
        ?.models.filter((model) => model.stale)
        .map((model) => model.id) ?? []
    const { descriptor, profile } = this.profile(provider)
    const nextModels = profile.models?.filter(
      (model) => !staleIds.includes(model.id),
    )
    if (nextModels)
      await this.ctx.settings.mutate(
        'llm-pi-ai',
        [
          {
            op: 'set',
            path: ['providers', provider, 'models'],
            value: nextModels.map((model) =>
              projectModel(provider, model, (route, row) =>
                this.capability(route, row.id, row.name),
              ),
            ),
          },
        ],
        descriptor.revision,
      )
    await runner.removeStale(staleIds)
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
      this.speeds.set(key, tier)
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
  ): ModelCapabilities | undefined {
    if (!isGptModel({ id: modelId })) return undefined
    const profile = profileOverride ?? this.profile(provider).profile
    const options = this.routeOptions(provider, profile)
    if (!options?.enabled) return undefined
    if (
      !['openai-responses', 'openai-completions'].includes(
        profile.api ?? 'openai-responses',
      )
    )
      return undefined
    const overrides = JSON.parse(options.overridesJSON) as Record<
      string,
      ModelOverride
    >
    const override = {
      ...(GPT_REASONING_LEVELS.some((level) => level === profile.reasoning)
        ? { defaultReasoningId: profile.reasoning! }
        : {}),
      ...overrides[modelId],
    }
    const current = this.snapshots.get(provider)?.capabilities[modelId]
    return current
      ? mergeCapabilities(current, override, current.capabilityRevision)
      : resolveCapabilities(
          { id: modelId, ...(displayName ? { displayName } : {}) },
          'gpt-preset',
          override,
        )
  }

  /** Capture request controls for the version-checked native runtime extension. */
  capture(
    provider: string,
    modelId: string,
    base: BaseModelInfo,
  ): NativeExtension | undefined {
    const current = this.capability(provider, modelId, base.name)
    if (!current) return undefined
    // The plugin preset also covers configured GPT models missing from the upstream list.
    const preserveReasoning = current.reasoning.status === 'unknown'
    const capabilities: ModelCapabilities = structuredClone(current)
    const speeds = new Map(this.speeds)
    const { profile } = this.profile(provider)
    const protocol = (profile.api ?? 'openai-responses') as GptProtocol
    const model = {
      ...base,
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
        this.results.set(key, { requested: payload.service_tier ?? 'default' })
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
            if (typeof response?.service_tier === 'string')
              this.results.set(key, {
                requested: payload.service_tier ?? 'default',
                actual: response.service_tier,
              })
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
  ctx.effect(() =>
    installNativeAdapterBridge(
      PiAiAdapter.prototype as unknown as Parameters<
        typeof installNativeAdapterBridge
      >[0],
      (provider, model, base) => service.capture(provider, model, base),
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
    )
    return () => {
      dispose()
      for (const provider of providers) ctx.emit('llm/models-updated', provider)
    }
  })
  await service.initialize()
  for (const provider of service.enabledProviders())
    ctx.emit('llm/models-updated', provider)
}
