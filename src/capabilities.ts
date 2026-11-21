import type {
  ModelCapabilities,
  ModelOverride,
  ReasoningChoice,
  ServiceTier,
  ServiceTierChoice,
  UpstreamModel,
} from './types.js'

const presetTier = (
  id: ServiceTier,
  label: string,
  source: ServiceTierChoice['source'] = 'catalog',
): ServiceTierChoice => ({ id, label, wireValue: id, source })

const GPT_SPEED_PRESET: ServiceTierChoice[] = [
  presetTier('default', 'Standard'),
  { ...presetTier('fast', 'Fast'), wireValue: 'priority' },
]

/** Recognized GPT profile defaults. */
export const GPT_REASONING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

// Keep existing GPT-6.2 Sol selections working on gateways with ID-only listings.
const GPT_62_SOL_REASONING: ReasoningChoice[] = [
  'low',
  'medium',
  'high',
  'xhigh',
].map((id) => ({ id, label: id, wireValue: id, source: 'catalog' }))

const GPT_PRESET = {
  serviceTiers: GPT_SPEED_PRESET,
  defaultServiceTier: 'default' as const,
}

const cloneChoices = <T extends ReasoningChoice | ServiceTierChoice>(
  choices: T[],
): T[] => choices.map((choice) => ({ ...choice }))

function catalogFor(modelId: string) {
  return isGptModel({ id: modelId }) ? GPT_PRESET : undefined
}

export function isGptModel(model: UpstreamModel): boolean {
  return /^(?:(?:gpt|codex|o[1345])[-.]|o[13]$)/i.test(model.id)
}

export function resolveCapabilities(
  model: UpstreamModel,
  revision: string,
  override?: ModelOverride,
  hasNativeReasoning = false,
): ModelCapabilities {
  const base = catalogFor(model.id)
  const upstream = model.capabilities
  const displayName = override?.displayName ?? model.displayName ?? model.id
  const choices =
    override?.reasoningChoices ??
    upstream?.reasoningChoices ??
    (!hasNativeReasoning && model.id === 'gpt-6.2-sol'
      ? GPT_62_SOL_REASONING
      : undefined)
  const supportsReasoning =
    override?.supportsReasoning ??
    (override?.reasoningChoices === undefined
      ? upstream?.supportsReasoning
      : undefined)
  const status =
    supportsReasoning === false || choices?.length === 0
      ? 'unsupported'
      : choices === undefined
        ? 'unknown'
        : 'known'
  const finalChoices = status === 'known' ? choices! : []
  const candidateDefaultReasoning =
    override?.defaultReasoningId ?? upstream?.defaultReasoningId
  const defaultReasoningId = finalChoices.some(
    (choice) => choice.id === candidateDefaultReasoning,
  )
    ? candidateDefaultReasoning
    : undefined
  const tiers = override?.serviceTiers ??
    upstream?.serviceTiers ??
    base?.serviceTiers ?? [presetTier('default', 'Standard')]
  const availableTiers = tiers.filter(
    (choice) =>
      (choice.id !== 'ultrafast' && choice.wireValue !== 'ultrafast') ||
      (model.ultrafastSupported !== false &&
        !(
          model.stale &&
          !override?.serviceTiers &&
          choice.source === 'upstream'
        )),
  )
  const serviceTiers = availableTiers.length
    ? availableTiers
    : [presetTier('default', 'Standard')]
  const candidateServiceTier =
    override?.defaultServiceTier ??
    upstream?.defaultServiceTier ??
    base?.defaultServiceTier ??
    'default'
  const fallbackServiceTier =
    serviceTiers.find((choice) => choice.id === 'default')?.id ??
    serviceTiers[0]?.id ??
    'default'
  const defaultServiceTier = serviceTiers.some(
    (choice) => choice.id === candidateServiceTier,
  )
    ? candidateServiceTier
    : fallbackServiceTier
  const contextWindow = override?.contextWindow ?? upstream?.contextWindow
  const maxOutputTokens = override?.maxOutputTokens ?? upstream?.maxOutputTokens
  const inputModalities = override?.inputModalities ?? upstream?.inputModalities

  return {
    modelId: model.id,
    displayName,
    reasoning: {
      status,
      choices: cloneChoices(finalChoices),
      ...(defaultReasoningId === undefined
        ? {}
        : { defaultId: defaultReasoningId }),
    },
    serviceTiers: cloneChoices(serviceTiers),
    defaultServiceTier,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(inputModalities === undefined
      ? {}
      : { inputModalities: [...inputModalities] }),
    capabilityRevision: revision,
  }
}

export function mergeCapabilities(
  capabilities: ModelCapabilities,
  override: ModelOverride | undefined,
  revision: string,
): ModelCapabilities {
  const currentHints: ModelOverride = {
    ...(capabilities.reasoning.status === 'unsupported'
      ? { supportsReasoning: false }
      : capabilities.reasoning.choices.length > 0
        ? {
            supportsReasoning: true,
            reasoningChoices: capabilities.reasoning.choices,
          }
        : {}),
    ...(capabilities.reasoning.defaultId === undefined
      ? {}
      : { defaultReasoningId: capabilities.reasoning.defaultId }),
    serviceTiers: capabilities.serviceTiers,
    defaultServiceTier: capabilities.defaultServiceTier,
    ...(capabilities.contextWindow === undefined
      ? {}
      : { contextWindow: capabilities.contextWindow }),
    ...(capabilities.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: capabilities.maxOutputTokens }),
    ...(capabilities.inputModalities === undefined
      ? {}
      : { inputModalities: capabilities.inputModalities }),
  }
  return resolveCapabilities(
    {
      id: capabilities.modelId,
      displayName: capabilities.displayName,
      capabilities: currentHints,
    },
    revision,
    override,
  )
}

export function capabilityForSelection(
  capabilities: ModelCapabilities,
  reasoningId: string | null | undefined,
  serviceTier: ServiceTier | undefined,
): { reasoning?: ReasoningChoice; serviceTier: ServiceTierChoice } {
  const effectiveReasoningId =
    reasoningId === null
      ? undefined
      : (reasoningId ?? capabilities.reasoning.defaultId)
  const selectedReasoning =
    effectiveReasoningId === undefined
      ? undefined
      : capabilities.reasoning.choices.find(
          (choice) => choice.id === effectiveReasoningId,
        )
  if (effectiveReasoningId !== undefined && selectedReasoning === undefined) {
    throw new Error(
      `unsupported reasoning level "${reasoningId}" for ${capabilities.modelId}`,
    )
  }
  if (selectedReasoning?.id === 'off' && selectedReasoning.wireValue === null) {
    throw new Error(
      `Off requires an explicit disable value for ${capabilities.modelId}; omitting effort follows the upstream default`,
    )
  }
  const selectedTier = capabilities.serviceTiers.find(
    (choice) => choice.id === (serviceTier ?? capabilities.defaultServiceTier),
  )
  if (!selectedTier) {
    throw new Error(
      `unsupported service tier "${serviceTier ?? capabilities.defaultServiceTier}" for ${capabilities.modelId}`,
    )
  }
  return {
    ...(selectedReasoning === undefined
      ? {}
      : { reasoning: selectedReasoning }),
    serviceTier: selectedTier,
  }
}
