import { describe, expect, it } from 'vitest'
import {
  capabilityForSelection,
  mergeCapabilities,
  resolveCapabilities,
} from '../src/capabilities.js'

describe('GPT capability resolution', () => {
  it('uses the six plugin presets for an unlisted GPT model', () => {
    const codex = resolveCapabilities({ id: 'codex-auto-review' }, 'test')
    expect(codex.reasoning.choices.map((choice) => choice.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
    const result = resolveCapabilities({ id: 'gpt-new-family' }, 'test')
    expect(
      result.reasoning.choices.map((choice) => [choice.id, choice.wireValue]),
    ).toEqual(
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((level) => [
        level,
        level,
      ]),
    )
  })
  it('keeps Max and Ultra as separate native choices', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-6-astra' }, 'test', {
      reasoningChoices: [
        { id: 'max', label: 'Max', wireValue: 'max', source: 'upstream' },
        {
          id: 'ultra',
          label: 'Ultra',
          wireValue: 'ultra',
          source: 'upstream',
        },
      ],
    })
    expect(capabilities.reasoning.choices.map((choice) => choice.id)).toContain(
      'max',
    )
    expect(capabilities.reasoning.choices.map((choice) => choice.id)).toContain(
      'ultra',
    )
    const max = capabilityForSelection(capabilities, 'max', 'default')
    const ultra = capabilityForSelection(capabilities, 'ultra', 'default')
    expect(max.reasoning?.wireValue).toBe('max')
    expect(ultra.reasoning?.wireValue).toBe('ultra')
  })

  it('keeps service tier independent from reasoning', () => {
    const capabilities = resolveCapabilities(
      {
        id: 'gpt-6-astra',
        capabilities: {
          serviceTiers: [
            {
              id: 'default',
              label: 'Standard',
              wireValue: 'default',
              source: 'upstream',
            },
            {
              id: 'ultrafast',
              label: 'Ultrafast',
              wireValue: 'ultrafast',
              source: 'upstream',
            },
          ],
        },
      },
      'test',
    )
    const selected = capabilityForSelection(capabilities, 'high', 'ultrafast')
    expect(selected.reasoning?.id).toBe('high')
    expect(selected.serviceTier.id).toBe('ultrafast')
  })

  it('rejects a level not advertised by the model', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-6.1-sol' }, 'test')
    expect(() =>
      capabilityForSelection(capabilities, 'minimal', 'default'),
    ).toThrow(/unsupported reasoning level/)
  })

  it('preserves existing capability fields for a partial override', () => {
    const original = resolveCapabilities(
      {
        id: 'gpt-custom',
        capabilities: {
          reasoningChoices: [
            {
              id: 'ultra',
              label: 'Ultra',
              wireValue: 'ultra',
              source: 'upstream',
            },
          ],
          defaultReasoningId: 'ultra',
          contextWindow: 128000,
          inputModalities: ['text', 'image'],
        },
      },
      'v1',
    )
    const merged = mergeCapabilities(original, { displayName: 'Renamed' }, 'v2')
    expect(merged.displayName).toBe('Renamed')
    expect(merged.reasoning.choices.map((choice) => choice.id)).toEqual([
      'ultra',
    ])
    expect(merged.reasoning.defaultId).toBe('ultra')
    expect(merged.contextWindow).toBe(128000)
    expect(merged.inputModalities).toEqual(['text', 'image'])
  })

  it('uses a configured default when no explicit effort is selected', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-6-astra' }, 'test', {
      defaultReasoningId: 'max',
    })
    expect(
      capabilityForSelection(capabilities, undefined, 'default').reasoning?.id,
    ).toBe('max')
  })

  it('falls back to the first advertised service tier when Standard is absent', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-custom' }, 'test', {
      serviceTiers: [
        { id: 'fast', label: 'Fast', wireValue: 'fast', source: 'user' },
      ],
    })
    expect(capabilities.defaultServiceTier).toBe('fast')
    expect(
      capabilityForSelection(capabilities, undefined, undefined).serviceTier.id,
    ).toBe('fast')
  })
})
