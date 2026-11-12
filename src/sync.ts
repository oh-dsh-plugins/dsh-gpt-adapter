import { resolveCapabilities, isGptModel } from './capabilities.js'
import { validContextWindow } from './context-window.js'
import { createHash } from 'node:crypto'
import type {
  CapabilityCatalog,
  CapabilityHints,
  ModelCapabilities,
  ReasoningChoice,
  ServiceTier,
  ServiceTierChoice,
  SyncConfig,
  SyncSnapshot,
  UpstreamModel,
  UpstreamModelList,
} from './types.js'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type SyncResult = {
  snapshot: SyncSnapshot
  changed: boolean
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error(`model list exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES)
        throw new Error(`model list exceeds ${MAX_RESPONSE_BYTES} bytes`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstDefined(
  sources: Record<string, unknown>[],
  keys: string[],
): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key]
    }
  }
  return undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  )
  return values.length === value.length ? values : undefined
}

function reasoningLabel(id: string): string {
  if (id === 'xhigh') return 'XHigh'
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function reasoningChoices(value: unknown): ReasoningChoice[] | undefined {
  const values = stringArray(value)
  if (values) {
    return [...new Set(values)]
      .filter((id) => id !== 'off')
      .map((id) => ({
        id,
        label: reasoningLabel(id),
        wireValue: id,
        source: 'upstream',
      }))
  }
  const object = record(value)
  if (!object) return undefined
  return Object.entries(object).flatMap(([id, wireValue]) => {
    if (!id || typeof wireValue !== 'string' || !wireValue.trim()) return []
    return [
      {
        id,
        label: reasoningLabel(id),
        wireValue,
        source: 'upstream' as const,
      },
    ]
  })
}

function serviceTier(value: string): ServiceTier | undefined {
  if (value === 'standard') return 'default'
  if (value === 'priority') return 'fast'
  return value === 'default' || value === 'fast' || value === 'ultrafast'
    ? value
    : undefined
}

function serviceTierChoices(value: unknown): ServiceTierChoice[] | undefined {
  const values = stringArray(value)
  if (!values) return undefined
  const seen = new Set<ServiceTier>()
  return values.flatMap((value) => {
    const id = serviceTier(value)
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [
      {
        id,
        label:
          id === 'default'
            ? 'Standard'
            : id.charAt(0).toUpperCase() + id.slice(1),
        wireValue: value === 'priority' ? ('priority' as const) : id,
        source: 'upstream' as const,
      },
    ]
  })
}

function parseCapabilityHints(
  row: Record<string, unknown>,
  modelId: string,
): CapabilityHints | undefined {
  const nested = record(row.capabilities)
  const sources = nested ? [row, nested] : [row]
  const rawReasoning = firstDefined(sources, [
    'reasoning_supported_efforts',
    'supported_reasoning_efforts',
    'reasoning_efforts',
  ])
  const defaultReasoningValue = firstDefined(sources, [
    'reasoning_default_effort',
    'reasoning_effort',
  ])
  let reasoning = reasoningChoices(rawReasoning)
  if (!reasoning && typeof defaultReasoningValue === 'string') {
    reasoning = reasoningChoices([defaultReasoningValue])
  }
  const disableValue = firstDefined(sources, ['reasoning_disable_effort'])
  const canDisable = firstDefined(sources, ['can_disable_thinking']) === true
  if (
    canDisable &&
    typeof disableValue === 'string' &&
    disableValue.length > 0 &&
    reasoning &&
    !reasoning.some((choice) => choice.id === 'off')
  ) {
    reasoning = [
      { id: 'off', label: 'Off', wireValue: disableValue, source: 'upstream' },
      ...reasoning,
    ]
  }
  const supportsReasoning = firstDefined(sources, [
    'supports_reasoning',
    'reasoning_supported',
  ])
  const rawServiceTiers = firstDefined(sources, [
    'service_tiers',
    'supported_service_tiers',
  ])
  let tiers =
    serviceTierChoices(rawServiceTiers) ??
    resolveCapabilities({ id: modelId }, 'gpt-preset').serviceTiers
  const supportsFast = firstDefined(sources, ['supports_fast'])
  const supportsUltrafast = firstDefined(sources, ['supports_ultrafast'])
  const rawDefaultTier = firstDefined(sources, [
    'default_service_tier',
    'service_tier',
  ])
  const hasTierSignal =
    rawServiceTiers !== undefined ||
    typeof supportsFast === 'boolean' ||
    typeof supportsUltrafast === 'boolean'
  if (supportsFast === false) tiers = tiers.filter((tier) => tier.id !== 'fast')
  if (supportsUltrafast === false)
    tiers = tiers.filter((tier) => tier.id !== 'ultrafast')
  const tierSet = new Set(tiers.map((choice) => choice.id))
  if (supportsFast === true && !tierSet.has('fast')) {
    tiers.push({
      id: 'fast',
      label: 'Fast',
      wireValue: 'fast',
      source: 'upstream',
    })
  }
  if (supportsUltrafast === true && !tierSet.has('ultrafast')) {
    tiers.push({
      id: 'ultrafast',
      label: 'Ultrafast',
      wireValue: 'ultrafast',
      source: 'upstream',
    })
  }
  const defaultTier =
    typeof rawDefaultTier === 'string' ? serviceTier(rawDefaultTier) : undefined
  const contextWindow = firstDefined(sources, [
    'context_window',
    'context_length',
  ])
  const maxOutputTokens = firstDefined(sources, [
    'max_output_tokens',
    'max_completion_tokens',
    'max_tokens',
  ])
  const hints: CapabilityHints = {
    ...(typeof supportsReasoning === 'boolean' ? { supportsReasoning } : {}),
    ...(reasoning ? { reasoningChoices: reasoning } : {}),
    ...(typeof defaultReasoningValue === 'string'
      ? { defaultReasoningId: defaultReasoningValue }
      : {}),
    ...(hasTierSignal ? { serviceTiers: tiers } : {}),
    ...(defaultTier ? { defaultServiceTier: defaultTier } : {}),
    ...(validContextWindow(contextWindow) ? { contextWindow } : {}),
    ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? { maxOutputTokens }
      : {}),
  }
  return Object.keys(hints).length === 0 ? undefined : hints
}

function parseModelList(payload: unknown): UpstreamModel[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as UpstreamModelList).data)
  ) {
    throw new Error('upstream model response must contain a data array')
  }
  return (payload as UpstreamModelList).data.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const row = candidate as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0) return []
    const capabilities = parseCapabilityHints(row, row.id)
    return [
      {
        id: row.id,
        ...(typeof row.display_name === 'string'
          ? { displayName: row.display_name }
          : {}),
        ...(typeof row.created === 'number' ? { created: row.created } : {}),
        ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}),
        ...(typeof row.shutdown_date === 'string' || row.shutdown_date === null
          ? { shutdownDate: row.shutdown_date }
          : {}),
        ...(capabilities ? { capabilities } : {}),
      },
    ]
  })
}

function modelsEqual(
  left: SyncSnapshot | undefined,
  right: SyncSnapshot,
): boolean {
  return (
    JSON.stringify(left?.models) === JSON.stringify(right.models) &&
    JSON.stringify(left?.capabilities) === JSON.stringify(right.capabilities)
  )
}

function dedupeModels(models: UpstreamModel[]): UpstreamModel[] {
  const byId = new Map<string, UpstreamModel>()
  for (const model of models) {
    const existing = byId.get(model.id)
    byId.set(model.id, existing ? { ...existing, ...model } : model)
  }
  return [...byId.values()]
}

function mergeModels(
  fresh: UpstreamModel[],
  previous: SyncSnapshot | undefined,
  includeModel: ((model: UpstreamModel) => boolean) | undefined,
): UpstreamModel[] {
  const previousById = new Map(
    previous?.models.map((model) => [model.id, model]) ?? [],
  )
  const current = dedupeModels(fresh).map((model) => {
    const previousModel = previousById.get(model.id)
    const merged = previousModel
      ? {
          ...previousModel,
          ...model,
          ...(previousModel.capabilities || model.capabilities
            ? {
                capabilities: {
                  ...previousModel.capabilities,
                  ...model.capabilities,
                },
              }
            : {}),
        }
      : { ...model }
    delete merged.stale
    return merged
  })
  if (!previous) return current.filter(includeModel ?? isGptModel)
  const currentIds = new Set(current.map((model) => model.id))
  const retained = dedupeModels(previous.models)
    .filter((model) => !currentIds.has(model.id))
    .filter(includeModel ?? isGptModel)
    .map((model) => ({ ...model, stale: true }))
  return [...current, ...retained].filter(includeModel ?? isGptModel)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function revisionFor(
  models: UpstreamModel[],
  config: Pick<SyncConfig, 'overrides' | 'includeModel' | 'catalog'>,
): string {
  const value = stableJson({
    models: models
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id)),
    overrides: config.overrides ?? {},
    includeModel: config.includeModel ? 'custom' : 'gpt-default',
    catalog: config.catalog ?? null,
  })
  return `catalog:${createHash('sha256').update(value).digest('hex')}`
}

function cacheKey(
  config: Pick<SyncConfig, 'baseUrl' | 'cacheIdentity' | 'apiKey' | 'protocol'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.baseUrl.replace(/\/+$/, ''),
        config.cacheIdentity,
        config.protocol ?? 'openai-responses',
        config.apiKey,
      ]),
    )
    .digest('hex')
}

export async function fetchModels(
  config: Pick<SyncConfig, 'baseUrl' | 'apiKey'>,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  etag?: string,
): Promise<{ models: UpstreamModel[]; etag?: string; notModified: boolean }> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  })
  if (etag) headers.set('if-none-match', etag)
  const response = await fetchImpl(`${base}/models`, {
    headers,
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.status === 304)
    return {
      models: [],
      notModified: true,
      ...(etag === undefined ? {} : { etag }),
    }
  if (!response.ok)
    throw new Error(`model list request failed with HTTP ${response.status}`)
  const models = parseModelList(JSON.parse(await readBounded(response)))
  const nextEtag = response.headers.get('etag') ?? undefined
  return {
    models,
    notModified: false,
    ...(nextEtag === undefined ? {} : { etag: nextEtag }),
  }
}

export function buildSnapshot(
  models: UpstreamModel[],
  config: Pick<SyncConfig, 'overrides' | 'includeModel' | 'catalog'>,
  revision: string,
  previous?: SyncSnapshot,
  snapshotCacheKey = 'manual',
): SyncSnapshot {
  const filtered = dedupeModels(models).filter(
    config.includeModel ?? isGptModel,
  )
  const capabilities: Record<string, ModelCapabilities> = {}
  for (const model of filtered) {
    const catalogHints = config.catalog?.models[model.id]
    const catalogChoices = catalogHints?.reasoningChoices?.map((choice) => ({
      ...choice,
      source: 'catalog' as const,
    }))
    capabilities[model.id] = resolveCapabilities(
      {
        ...model,
        capabilities: {
          ...catalogHints,
          ...(catalogChoices ? { reasoningChoices: catalogChoices } : {}),
          ...model.capabilities,
        },
      },
      revision,
      config.overrides?.[model.id],
    )
  }
  return {
    models: filtered,
    capabilities,
    fetchedAt: new Date().toISOString(),
    source: 'network',
    cacheKey: snapshotCacheKey,
    ...(config.catalog ? { catalog: config.catalog } : {}),
  }
}

export async function synchronize(
  config: SyncConfig,
  previous: SyncSnapshot | undefined,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const currentCacheKey = cacheKey(config)
  const reusable = previous?.cacheKey === currentCacheKey ? previous : undefined
  const result = await fetchModels(config, fetchImpl, signal, reusable?.etag)
  const catalog =
    config.catalog ??
    (config.capabilityCatalogUrl
      ? await fetchCapabilityCatalog(
          config.capabilityCatalogUrl,
          fetchImpl,
          signal,
        )
      : undefined)
  const effectiveConfig = { ...config, ...(catalog ? { catalog } : {}) }
  if (result.notModified) {
    if (!reusable)
      throw new Error('upstream returned 304 without a matching cache')
    const upstreamModels =
      reusable.upstreamModels ?? reusable.models.filter((model) => !model.stale)
    const models = mergeModels(upstreamModels, reusable, config.includeModel)
    const next = buildSnapshot(
      models,
      effectiveConfig,
      revisionFor(models, effectiveConfig),
      reusable,
      currentCacheKey,
    )
    if (reusable.etag !== undefined) next.etag = reusable.etag
    next.upstreamModels = upstreamModels
    return {
      snapshot: { ...next, source: 'cache' },
      changed: !modelsEqual(reusable, next),
    }
  }
  const models = mergeModels(result.models, reusable, config.includeModel)
  const next = buildSnapshot(
    models,
    effectiveConfig,
    revisionFor(models, effectiveConfig),
    reusable,
    currentCacheKey,
  )
  next.upstreamModels = result.models
  if (result.etag !== undefined) next.etag = result.etag
  return { snapshot: next, changed: !modelsEqual(reusable, next) }
}

/** Remove only explicitly selected stale entries; a later upstream listing can restore them. */
export function pruneStale(
  snapshot: SyncSnapshot,
  modelIds: readonly string[],
): SyncSnapshot {
  const selected = new Set(modelIds)
  const models = snapshot.models.filter(
    (model) => !model.stale || !selected.has(model.id),
  )
  const capabilities = Object.fromEntries(
    models.map((model) => [model.id, snapshot.capabilities[model.id]!]),
  )
  return { ...snapshot, models, capabilities }
}

/** Catalog URL requests never receive the model-provider API key. */
export async function fetchCapabilityCatalog(
  url: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<CapabilityCatalog> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok)
    throw new Error(
      `capability catalog request failed with HTTP ${response.status}`,
    )
  const value: unknown = JSON.parse(await readBounded(response))
  const root = record(value)
  const models = record(root?.models)
  if (typeof root?.version !== 'string' || !root.version || !models)
    throw new Error('invalid capability catalog: expected version and models')
  const normalized: CapabilityCatalog['models'] = {}
  for (const [id, raw] of Object.entries(models)) {
    const row = record(raw)
    if (!id || !row) throw new Error('invalid capability catalog model')
    normalized[id] = parseCapabilityHints(row, id) ?? {}
  }
  return { version: root.version, models: normalized }
}
