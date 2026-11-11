import { describe, expect, it } from 'vitest'
import { createRequestBridge } from '../src/bridge.js'
import { resolveCapabilities } from '../src/capabilities.js'

describe('GPT request bridge', () => {
  it('emits the selected native effort and independent service tier', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-6-astra' }, 'test', {
      reasoningChoices: [
        { id: 'max', label: 'Max', wireValue: 'max', source: 'upstream' },
        { id: 'ultra', label: 'Ultra', wireValue: 'ultra', source: 'upstream' },
      ],
      serviceTiers: [
        { id: 'fast', label: 'Fast', wireValue: 'fast', source: 'user' },
      ],
    })
    const bridge = createRequestBridge({
      currentSnapshot: () => undefined,
      resolveCapabilities: (modelId) =>
        modelId === capabilities.modelId ? capabilities : undefined,
    })

    expect(
      bridge.prepare({
        modelId: 'gpt-6-astra',
        reasoningId: 'ultra',
        serviceTier: 'fast',
      }),
    ).toEqual({
      model: 'gpt-6-astra',
      reasoning: { effort: 'ultra' },
      service_tier: 'fast',
    })
  })

  it('sends the declared disable value while preserving Standard mode', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-6-astra' }, 'test', {
      reasoningChoices: [
        { id: 'off', label: 'Off', wireValue: 'none', source: 'upstream' },
        { id: 'max', label: 'Max', wireValue: 'max', source: 'upstream' },
      ],
    })
    const bridge = createRequestBridge({
      currentSnapshot: () => undefined,
      resolveCapabilities: () => capabilities,
    })

    expect(
      bridge.prepare({
        modelId: 'gpt-6-astra',
        reasoningId: 'off',
        serviceTier: 'default',
      }),
    ).toEqual({
      model: 'gpt-6-astra',
      reasoning: { effort: 'none' },
      service_tier: 'default',
    })
  })
})
