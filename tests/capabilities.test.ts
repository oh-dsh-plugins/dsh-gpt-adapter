import { describe, expect, it } from 'vitest'
import {
  capabilityForSelection,
  mergeCapabilities,
  resolveCapabilities,
} from '../src/capabilities.js'

describe('GPT capability resolution', () => {
  it.each(['deepseek-v4', 'legacy-model'])(
    'leaves reasoning to the host for unmanaged model %s',
    (id) => {
      expect(resolveCapabilities({ id }, 'test').reasoning).toEqual({
        status: 'unknown',
        choices: [],
      })
    },
  )
  it.each([
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-6.2-sol-alias',
    'gpt-4o',
    'gpt-new-family',
    'codex-auto-review',
  ])(
    'restores the six-level fallback for %s without declared choices',
    (id) => {
      const fallback = resolveCapabilities({ id }, 'test')
      expect(fallback.reasoning.fallback).toBe(true)
      expect(
        resolveCapabilities({ id }, 'test', undefined, true).reasoning,
      ).toEqual({ status: 'unknown', choices: [] })
      expect(fallback.reasoning.choices.map((choice) => choice.id)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ])
      expect(fallback.reasoning.defaultId).toBe('medium')
      const advertised = [
        {
          id: 'high',
          label: 'High',
          wireValue: 'high',
          source: 'upstream' as const,
        },
      ]
      const upstream = { id, capabilities: { reasoningChoices: advertised } }
      expect(resolveCapabilities(upstream, 'test').reasoning.choices).toEqual(
        advertised,
      )
      expect(
        resolveCapabilities(upstream, 'test', { reasoningChoices: [] })
          .reasoning,
      ).toEqual({ status: 'unsupported', choices: [] })
      expect(
        resolveCapabilities(
          { id, capabilities: { supportsReasoning: false } },
          'test',
        ).reasoning,
      ).toEqual({ status: 'unsupported', choices: [] })
    },
  )

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
    const selected = capabilityForSelection(
      capabilities,
      undefined,
      'ultrafast',
    )
    expect(selected.reasoning?.id).toBe('medium')
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

  it.each(['gpt-6.2-sol', 'gpt-6.2-astra'])(
    'preserves native reasoning for %s when a partial override renames it',
    (id) => {
      const original = resolveCapabilities({ id }, 'v1', undefined, true)
      const merged = mergeCapabilities(
        original,
        { displayName: 'Renamed' },
        'v2',
      )
      expect(merged.displayName).toBe('Renamed')
      expect(merged.reasoning).toEqual({ status: 'unknown', choices: [] })

      const reasoningChoices = [
        {
          id: 'high',
          label: 'High',
          wireValue: 'high',
          source: 'user' as const,
        },
      ]
      const explicit = mergeCapabilities(original, { reasoningChoices }, 'v2')
      expect(explicit.reasoning).toEqual({
        status: 'known',
        choices: reasoningChoices,
      })
    },
  )

  it('uses a configured default when no explicit effort is selected', () => {
    const capabilities = resolveCapabilities({ id: 'gpt-6-astra' }, 'test', {
      reasoningChoices: [
        { id: 'max', label: 'Max', wireValue: 'max', source: 'user' },
      ],
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
