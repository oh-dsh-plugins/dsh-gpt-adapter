import { describe, expect, it } from 'vitest'
import {
  resolveCapabilities,
  capabilityForSelection,
} from '../src/capabilities.js'
import { createRequestBridge } from '../src/bridge.js'
import { synchronize } from '../src/sync.js'

const config = {
  baseUrl: 'https://gateway.invalid/v1',
  apiKey: 'test-key',
  cacheIdentity: 'test-route',
  refreshIntervalMs: 1000,
}

describe('native GPT parameter contract', () => {
  it.each(['openai-responses', 'openai-completions'] as const)(
    'preserves Ultra and priority through %s',
    async (protocol) => {
      const result = await synchronize(
        { ...config, protocol },
        undefined,
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'gpt-custom',
                  reasoning_supported_efforts: ['high', 'max', 'ultra'],
                  service_tiers: ['default', 'priority', 'ultrafast'],
                },
              ],
            }),
          ),
      )
      const bridge = createRequestBridge({
        currentSnapshot: () => result.snapshot,
        resolveCapabilities: (id) => result.snapshot.capabilities[id],
      })
      const payload = bridge.prepare({
        modelId: 'gpt-custom',
        reasoningId: 'ultra',
        serviceTier: 'fast',
        protocol,
      })
      expect(payload).toEqual(
        protocol === 'openai-responses'
          ? {
              model: 'gpt-custom',
              reasoning: { effort: 'ultra' },
              service_tier: 'priority',
            }
          : {
              model: 'gpt-custom',
              reasoning_effort: 'ultra',
              service_tier: 'priority',
            },
      )
    },
  )

  it('offers Fast by preset without inventing an Ultrafast capability', () => {
    const caps = resolveCapabilities({ id: 'gpt-6-astra' }, 'test')
    expect(caps.serviceTiers.map((choice) => choice.id)).toEqual([
      'default',
      'fast',
    ])
    expect(caps.defaultServiceTier).toBe('default')
    expect(
      capabilityForSelection(caps, 'max', 'fast').serviceTier.wireValue,
    ).toBe('priority')
    expect(() => capabilityForSelection(caps, 'max', 'ultrafast')).toThrow(
      /unsupported service tier/,
    )
  })

  it('keeps explicit tier restrictions and wire mappings ahead of the preset', async () => {
    const result = await synchronize(
      config,
      undefined,
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-restricted', service_tiers: ['default'] },
              {
                id: 'gpt-alias',
                service_tiers: ['default', 'fast', 'ultrafast'],
              },
            ],
          }),
        ),
    )
    const restricted = result.snapshot.capabilities['gpt-restricted']!
    expect(restricted.serviceTiers.map((choice) => choice.id)).toEqual([
      'default',
    ])
    expect(() => capabilityForSelection(restricted, 'high', 'fast')).toThrow(
      /unsupported service tier/,
    )
    const alias = result.snapshot.capabilities['gpt-alias']!
    expect(
      capabilityForSelection(alias, 'high', 'fast').serviceTier.wireValue,
    ).toBe('fast')
    expect(
      capabilityForSelection(alias, 'high', 'ultrafast').serviceTier.wireValue,
    ).toBe('ultrafast')
    const user = resolveCapabilities({ id: 'gpt-custom' }, 'test', {
      serviceTiers: [
        {
          id: 'default',
          label: 'Standard',
          wireValue: 'default',
          source: 'user',
        },
      ],
    })
    expect(user.serviceTiers.map((choice) => choice.id)).toEqual(['default'])
    expect(
      resolveCapabilities({ id: 'legacy-model' }, 'test').serviceTiers.map(
        (choice) => choice.id,
      ),
    ).toEqual(['default'])
  })

  it('does not mistake partial metadata for a complete supported-tier list', async () => {
    const result = await synchronize(
      config,
      undefined,
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-default', default_service_tier: 'default' },
              { id: 'gpt-no-ultra', supports_ultrafast: false },
              { id: 'gpt-no-fast', supports_fast: false },
              { id: 'gpt-with-ultra', supports_ultrafast: true },
            ],
          }),
        ),
    )
    const tiers = (id: string) =>
      result.snapshot.capabilities[id]!.serviceTiers.map((choice) => choice.id)
    expect(tiers('gpt-default')).toEqual(['default', 'fast'])
    expect(tiers('gpt-no-ultra')).toEqual(['default', 'fast'])
    expect(tiers('gpt-no-fast')).toEqual(['default'])
    expect(tiers('gpt-with-ultra')).toEqual(['default', 'fast', 'ultrafast'])
  })

  it('rejects Off when its value merely omits the parameter', () => {
    const caps = resolveCapabilities({ id: 'gpt-custom' }, 'test', {
      reasoningChoices: [
        { id: 'off', label: 'Off', wireValue: null, source: 'user' },
      ],
    })
    expect(() => capabilityForSelection(caps, 'off', 'default')).toThrow(
      /explicit disable value/,
    )
  })

  it('preserves an explicit off-to-none wire mapping', async () => {
    const result = await synchronize(
      config,
      undefined,
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'gpt-custom',
                reasoning_efforts: { off: 'none', high: 'high' },
              },
            ],
          }),
        ),
    )
    const caps = result.snapshot.capabilities['gpt-custom']!
    expect(
      capabilityForSelection(caps, 'off', 'default').reasoning?.wireValue,
    ).toBe('none')
  })

  it('does not turn can_disable_thinking alone into a fake Off choice', async () => {
    const result = await synchronize(
      config,
      undefined,
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'gpt-custom',
                reasoning_supported_efforts: ['high'],
                can_disable_thinking: true,
              },
            ],
          }),
        ),
    )
    expect(
      result.snapshot.capabilities['gpt-custom']!.reasoning.choices.map(
        (choice) => choice.id,
      ),
    ).toEqual(['high'])
  })

  it('distinguishes configured defaults from explicitly following the upstream default', () => {
    const caps = resolveCapabilities({ id: 'gpt-6-astra' }, 'test', {
      defaultReasoningId: 'max',
    })
    const bridge = createRequestBridge({
      currentSnapshot: () => undefined,
      resolveCapabilities: () => caps,
    })
    expect(bridge.prepare({ modelId: caps.modelId }).reasoning?.effort).toBe(
      'max',
    )
    expect(
      bridge.prepare({ modelId: caps.modelId, reasoningId: null }),
    ).not.toHaveProperty('reasoning')
  })
})
