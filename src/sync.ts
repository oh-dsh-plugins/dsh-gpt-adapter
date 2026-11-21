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
const TIER_METADATA_VERSION = 1

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type SyncResult = {
  snapshot: SyncSnapshot
  changed: boolean
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined)
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

function validCachedHints(value: unknown, allowEmptyTiers = false): boolean {
  const hints = record(value)
  if (!hints) return false
  if (
    hints.supportsReasoning !== undefined &&
    typeof hints.supportsReasoning !== 'boolean'
  )
    return false
  if (
    hints.defaultReasoningId !== undefined &&
    typeof hints.defaultReasoningId !== 'string'
  )
    return false
  if (
    hints.contextWindow !== undefined &&
    !validContextWindow(hints.contextWindow)
  )
    return false
  if (
    hints.maxOutputTokens !== undefined &&
    (typeof hints.maxOutputTokens !== 'number' ||
      !Number.isFinite(hints.maxOutputTokens) ||
      hints.maxOutputTokens <= 0)
  )
    return false
  if (
    hints.defaultServiceTier !== undefined &&
    (typeof hints.defaultServiceTier !== 'string' ||
      !['default', 'fast', 'ultrafast'].includes(hints.defaultServiceTier))
  )
    return false
  if (
    hints.inputModalities !== undefined &&
    (!Array.isArray(hints.inputModalities) ||
      hints.inputModalities.some((item) => item !== 'text' && item !== 'image'))
  )
    return false
  for (const field of ['reasoningChoices', 'serviceTiers']) {
    const choices = hints[field]
    if (choices === undefined) continue
    if (
      !Array.isArray(choices) ||
      (field === 'serviceTiers' && !allowEmptyTiers && !choices.length)
    )
      return false
    for (const item of choices) {
      const choice = record(item)
      if (
        !choice ||
        typeof choice.id !== 'string' ||
        !choice.id ||
        typeof choice.label !== 'string' ||
        (choice.wireValue !== null && typeof choice.wireValue !== 'string')
      )
        return false
      if (
        field === 'serviceTiers' &&
        (!['default', 'fast', 'ultrafast'].includes(choice.id) ||
          !['default', 'fast', 'ultrafast', 'priority'].includes(
            String(choice.wireValue),
          ))
      )
        return false
    }
  }
  return true
}

function validCachedModels(value: unknown, raw = false): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const model = record(item)
      return (
        model !== undefined &&
        typeof model.id === 'string' &&
        model.id.length > 0 &&
        (model.displayName === undefined ||
          (typeof model.displayName === 'string' &&
            model.displayName.trim().length > 0)) &&
        (model.stale === undefined || typeof model.stale === 'boolean') &&
        (model.ultrafastSupported === undefined ||
          typeof model.ultrafastSupported === 'boolean') &&
        (model.capabilities === undefined ||
          validCachedHints(model.capabilities, raw))
      )
    })
  )
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

function structuredServiceTierIds(entries: unknown[]): string[] | undefined {
  const ids = entries.flatMap((entry) => {
    const id = typeof entry === 'string' ? entry : record(entry)?.id
    return typeof id === 'string' && serviceTier(id) ? [id] : []
  })
  // A supplemental list with no recognized entries supplies no tier hints.
  return ids.length ? ids : undefined
}

function serviceTierMetadata(sources: Record<string, unknown>[]) {
  const rawTiers = firstDefined(sources, [
    'service_tiers',
    'supported_service_tiers',
  ])
  const structured =
    Array.isArray(rawTiers) && rawTiers.some((tier) => record(tier))
  return {
    ids: structured
      ? structuredServiceTierIds(rawTiers)
      : stringArray(rawTiers),
    structured,
    supportsFast: firstDefined(sources, ['supports_fast']),
    supportsUltrafast: firstDefined(sources, ['supports_ultrafast']),
  }
}

function serviceTierChoices(values: string[]): ServiceTierChoice[] {
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

function sourcesFor(row: Record<string, unknown>): Record<string, unknown>[] {
  const nested = record(row.capabilities)
  return nested ? [row, nested] : [row]
}

function parseCapabilityHints(
  sources: Record<string, unknown>[],
  modelId: string,
  { ids, structured, supportsFast, supportsUltrafast } = serviceTierMetadata(
    sources,
  ),
): CapabilityHints | undefined {
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
  let tiers = ids
    ? serviceTierChoices(ids)
    : resolveCapabilities({ id: modelId }, 'gpt-preset').serviceTiers
  // Codex-style structured lists can contain only the additional tiers.
  // Standard is still selectable and remains the default unless specified.
  if (
    structured &&
    tiers.length &&
    !tiers.some((tier) => tier.id === 'default')
  )
    tiers.unshift({
      id: 'default',
      label: 'Standard',
      wireValue: 'default',
      source: 'catalog',
    })
  const rawDefaultTier = firstDefined(sources, [
    'default_service_tier',
    'service_tier',
  ])
  const hasTierSignal =
    ids !== undefined ||
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
    ...(typeof supportsReasoning === 'boolean'
      ? { supportsReasoning }
      : reasoning
        ? { supportsReasoning: reasoning.length > 0 }
        : {}),
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
    const sources = sourcesFor(row)
    const tierMetadata = serviceTierMetadata(sources)
    const capabilities = parseCapabilityHints(sources, row.id, tierMetadata)
    // A list can be partial. Only an explicit flag establishes a denial.
    const ultrafastSupported =
      typeof tierMetadata.supportsUltrafast === 'boolean'
        ? tierMetadata.supportsUltrafast
        : tierMetadata.ids?.includes('ultrafast')
          ? true
          : undefined
    return [
      {
        id: row.id,
        ...(typeof row.display_name === 'string' && row.display_name.trim()
          ? { displayName: row.display_name }
          : {}),
        ...(typeof row.created === 'number' ? { created: row.created } : {}),
        ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}),
        ...(typeof row.shutdown_date === 'string' || row.shutdown_date === null
          ? { shutdownDate: row.shutdown_date }
          : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(ultrafastSupported === undefined ? {} : { ultrafastSupported }),
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
    if (model.ultrafastSupported === undefined) delete merged.ultrafastSupported
    // A successful fresh listing is authoritative for Ultrafast. Do not
    // inherit it from a previous listing that supplied more tier metadata.
    const tiers = merged.capabilities?.serviceTiers
    if (
      tiers?.some((tier) => tier.id === 'ultrafast') &&
      !model.capabilities?.serviceTiers?.some((tier) => tier.id === 'ultrafast')
    ) {
      const hints = merged.capabilities!
      const remaining = tiers.filter((tier) => tier.id !== 'ultrafast')
      if (remaining.length) hints.serviceTiers = remaining
      else delete hints.serviceTiers
      if (hints.defaultServiceTier === 'ultrafast')
        delete hints.defaultServiceTier
    }
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

export function syncCacheKey(
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

/** Bind publication to input settings without narrowing upstream cache reuse. */
export function syncConfigKey(config: SyncConfig): string {
  return createHash('sha256')
    .update(
      stableJson({
        cacheKey: syncCacheKey(config),
        refreshIntervalMs: config.refreshIntervalMs,
        capabilityCatalogUrl: config.capabilityCatalogUrl ?? null,
        overrides: config.overrides ?? {},
        catalog: config.catalog ?? null,
      }),
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
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`model list request failed with HTTP ${response.status}`)
  }
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
    if (
      model.capabilities?.serviceTiers?.length === 0 ||
      catalogHints?.serviceTiers?.length === 0
    )
      throw new Error(`model ${model.id} declares no supported service tiers`)
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

/** Rebuild derived capabilities from raw metadata and the current local config. */
export function restoreSnapshot(
  config: SyncConfig,
  cached: SyncSnapshot,
): SyncSnapshot | undefined {
  if (
    !record(cached) ||
    typeof cached.fetchedAt !== 'string' ||
    !validCachedModels(cached.models) ||
    (cached.upstreamModels !== undefined &&
      !validCachedModels(cached.upstreamModels, true)) ||
    (cached.etag !== undefined && typeof cached.etag !== 'string')
  )
    return undefined
  if (cached.catalog !== undefined) {
    const catalog = record(cached.catalog)
    const models = record(catalog?.models)
    if (
      !catalog ||
      typeof catalog.version !== 'string' ||
      !catalog.version ||
      !models ||
      !Object.entries(models).every(
        ([id, hints]) => id && validCachedHints(hints, true),
      )
    )
      return undefined
  }
  if (cached.cacheKey !== syncCacheKey(config)) return undefined
  const catalog =
    config.catalog ??
    (config.capabilityCatalogUrl &&
    config.capabilityCatalogUrl === cached.capabilityCatalogUrl
      ? cached.catalog
      : undefined)
  const effectiveConfig = { ...config, ...(catalog ? { catalog } : {}) }
  // Raw metadata can contain models excluded by the previous filter. Preserve
  // the cached view's metadata and stale flags when rebuilding the current view.
  const models = dedupeModels([
    ...(cached.upstreamModels ?? []),
    ...cached.models,
  ]).filter(config.includeModel ?? isGptModel)
  if (models.some((model) => model.capabilities?.serviceTiers?.length === 0))
    return undefined
  const next = buildSnapshot(
    models,
    effectiveConfig,
    revisionFor(models, effectiveConfig),
    cached,
    cached.cacheKey,
  )
  next.source = 'cache'
  next.configKey = syncConfigKey(config)
  next.fetchedAt = cached.fetchedAt
  // Older parsers dropped structured service tiers. Re-fetch once rather
  // than reusing an ETag whose cached payload lost that information.
  if (cached.tierMetadataVersion === TIER_METADATA_VERSION) {
    next.tierMetadataVersion = TIER_METADATA_VERSION
    if (cached.etag !== undefined) next.etag = cached.etag
  }
  if (cached.upstreamModels !== undefined)
    next.upstreamModels = cached.upstreamModels
  if (catalog && !config.catalog && config.capabilityCatalogUrl)
    next.capabilityCatalogUrl = config.capabilityCatalogUrl
  return next
}

export async function synchronize(
  config: SyncConfig,
  previous: SyncSnapshot | undefined,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const currentCacheKey = syncCacheKey(config)
  const currentConfigKey = syncConfigKey(config)
  const reusable = previous?.cacheKey === currentCacheKey ? previous : undefined
  const etag =
    reusable?.tierMetadataVersion === TIER_METADATA_VERSION
      ? reusable.etag
      : undefined
  const result = await fetchModels(config, fetchImpl, signal, etag)
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
    if (reusable.tierMetadataVersion === TIER_METADATA_VERSION)
      next.tierMetadataVersion = TIER_METADATA_VERSION
    if (etag !== undefined) next.etag = etag
    next.upstreamModels = upstreamModels
    next.configKey = currentConfigKey
    if (!config.catalog && config.capabilityCatalogUrl)
      next.capabilityCatalogUrl = config.capabilityCatalogUrl
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
  next.tierMetadataVersion = TIER_METADATA_VERSION
  next.configKey = currentConfigKey
  if (result.etag !== undefined) next.etag = result.etag
  if (!config.catalog && config.capabilityCatalogUrl)
    next.capabilityCatalogUrl = config.capabilityCatalogUrl
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
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(
      `capability catalog request failed with HTTP ${response.status}`,
    )
  }
  const value: unknown = JSON.parse(await readBounded(response))
  const root = record(value)
  const models = record(root?.models)
  if (typeof root?.version !== 'string' || !root.version || !models)
    throw new Error('invalid capability catalog: expected version and models')
  const normalized: CapabilityCatalog['models'] = {}
  for (const [id, raw] of Object.entries(models)) {
    const row = record(raw)
    if (!id || !row) throw new Error('invalid capability catalog model')
    normalized[id] = parseCapabilityHints(sourcesFor(row), id) ?? {}
  }
  return { version: root.version, models: normalized }
}
