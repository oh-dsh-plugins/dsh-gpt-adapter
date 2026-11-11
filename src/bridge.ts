import { capabilityForSelection } from './capabilities.js'
import type {
  ModelCapabilities,
  PreparedGptRequest,
  RequestSelection,
  SyncSnapshot,
} from './types.js'

/** Host-facing bridge kept small so it can be implemented against DSH's adapter seam. */
export type GptCapabilityProvider = {
  currentSnapshot(): SyncSnapshot | undefined
  resolveCapabilities(modelId: string): ModelCapabilities | undefined
}

export type GptRequestBridge = {
  prepare(selection: RequestSelection): PreparedGptRequest
}

export function createRequestBridge(
  provider: GptCapabilityProvider,
): GptRequestBridge {
  return {
    prepare(selection) {
      const capabilities = provider.resolveCapabilities(selection.modelId)
      if (!capabilities)
        throw new Error(`unknown GPT model "${selection.modelId}"`)
      const resolved = capabilityForSelection(
        capabilities,
        selection.reasoningId,
        selection.serviceTier,
      )
      const effort = resolved.reasoning?.wireValue
      return {
        model: selection.modelId,
        ...(effort == null
          ? {}
          : selection.protocol === 'openai-completions'
            ? { reasoning_effort: effort }
            : { reasoning: { effort } }),
        service_tier: resolved.serviceTier.wireValue,
      }
    },
  }
}
