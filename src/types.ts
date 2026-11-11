export const REASONING_OFF = 'off' as const
export type GptProtocol = 'openai-responses' | 'openai-completions'

export type ReasoningChoice = {
  /** Stable provider-facing identifier used by the DSH selection contract. */
  id: string
  /** Label shown in the existing model selector. */
  label: string
  /** Exact value sent to the upstream API. */
  wireValue: string | null
  /** Where this choice came from. */
  source: 'upstream' | 'catalog' | 'user'
}

export type ServiceTier = 'default' | 'fast' | 'ultrafast'
export type ServiceTierWireValue = ServiceTier | 'priority'

export type ServiceTierChoice = {
  id: ServiceTier
  label: string
  wireValue: ServiceTierWireValue
  source: 'upstream' | 'catalog' | 'user'
}

export type CapabilityHints = {
  supportsReasoning?: boolean
  reasoningChoices?: ReasoningChoice[]
  defaultReasoningId?: string
  serviceTiers?: ServiceTierChoice[]
  defaultServiceTier?: ServiceTier
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: Array<'text' | 'image'>
}

export type ModelCapabilities = {
  modelId: string
  displayName: string
  reasoning: {
    status: 'known' | 'unknown' | 'unsupported'
    choices: ReasoningChoice[]
    defaultId?: string
  }
  serviceTiers: ServiceTierChoice[]
  defaultServiceTier: ServiceTier
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: Array<'text' | 'image'>
  capabilityRevision: string
}

export type UpstreamModel = {
  id: string
  displayName?: string
  created?: number
  ownedBy?: string
  shutdownDate?: string | null
  stale?: boolean
  capabilities?: CapabilityHints
}

export type UpstreamModelList = {
  data: UpstreamModel[]
}

export type ModelOverride = CapabilityHints & {
  displayName?: string
}

export type SyncConfig = {
  baseUrl: string
  apiKey: string
  /** Stable non-secret identity for the credential/account used by this route. */
  cacheIdentity: string
  protocol?: GptProtocol
  refreshIntervalMs: number
  capabilityCatalogUrl?: string
  includeModel?: (model: UpstreamModel) => boolean
  overrides?: Record<string, ModelOverride>
  catalog?: CapabilityCatalog
}

export type CapabilityCatalog = {
  version: string
  models: Record<string, CapabilityHints>
}

export type SyncSnapshot = {
  models: UpstreamModel[]
  /** Latest unfiltered upstream list, separate from retained/stale models. */
  upstreamModels?: UpstreamModel[]
  capabilities: Record<string, ModelCapabilities>
  fetchedAt: string
  source: 'network' | 'cache'
  cacheKey: string
  etag?: string
  catalog?: CapabilityCatalog
}

export type RequestSelection = {
  modelId: string
  /** null explicitly follows the upstream default; undefined uses the configured default. */
  reasoningId?: string | null
  serviceTier?: ServiceTier
  protocol?: GptProtocol
}

export type PreparedGptRequest = {
  model: string
  reasoning?: { effort: string }
  reasoning_effort?: string
  service_tier?: ServiceTierWireValue
}
