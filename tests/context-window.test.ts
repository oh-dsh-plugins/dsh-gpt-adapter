import { describe, expect, it } from 'vitest'
import {
  contextWindowTokens,
  resolveContextWindow,
} from '../src/context-window.js'

describe('context window resolution', () => {
  it('distinguishes automatic defaults from equal explicit capacities', () => {
    expect(resolveContextWindow({ modelId: 'gpt-5.4' })).toMatchObject({
      mode: 'default',
      effectiveTokens: 1050000,
      source: 'official-preset',
    })
    expect(
      resolveContextWindow({ modelId: 'gpt-4o-2024-08-06' }).effectiveTokens,
    ).toBe(128000)
    expect(resolveContextWindow({ modelId: 'gpt-5.4-unknown' })).toMatchObject({
      mode: 'default',
      effectiveTokens: 1000000,
      source: 'native-default',
    })
    expect(
      resolveContextWindow({ modelId: 'gpt-new', upstream: 1000000 }).mode,
    ).toBe('default')
    expect(
      resolveContextWindow({ modelId: 'gpt-new', native: 1000000 }).mode,
    ).toBe('1m')
    expect(contextWindowTokens('516k')).toBe(516000)
    expect(contextWindowTokens('1m')).toBe(1000000)
    expect(contextWindowTokens('default')).toBeUndefined()
  })

  it('preserves manual and provider intent before route metadata and fallbacks', () => {
    const options = {
      modelId: 'gpt-5.4',
      legacy: 450000,
      native: 516000,
      providerDefault: 700000,
      upstream: 800000,
      catalog: 900000,
      nativeDefault: 1000000,
    }
    expect(resolveContextWindow(options)).toMatchObject({
      mode: 'custom',
      effectiveTokens: 450000,
      defaultTokens: 700000,
      source: 'legacy-override',
    })
    const { legacy, ...native } = options
    expect(resolveContextWindow(native).source).toBe('native-user')
    const { native: unusedNative, ...provider } = native
    expect(resolveContextWindow(provider).source).toBe('provider-default')
    const { providerDefault, ...upstream } = provider
    expect(resolveContextWindow(upstream).source).toBe('upstream')
    const { upstream: unusedUpstream, ...catalog } = upstream
    expect(resolveContextWindow(catalog).source).toBe('capability-catalog')
  })

  it('ignores invalid metadata but rejects invalid explicit user input', () => {
    for (const value of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '516000',
      null,
    ]) {
      expect(
        resolveContextWindow({
          modelId: 'gpt-4o',
          upstream: value,
          catalog: value,
        }).effectiveTokens,
      ).toBe(128000)
      expect(() =>
        resolveContextWindow({ modelId: 'gpt-4o', native: value }),
      ).toThrow('正的安全整数')
      expect(() => contextWindowTokens('custom', value as number)).toThrow()
    }
    expect(() => contextWindowTokens('invalid' as any)).toThrow()
    expect(() => contextWindowTokens('1m', 123)).toThrow()
  })
})
