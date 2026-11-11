import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSynchronizer } from '../src/runtime.js'
import { synchronize } from '../src/sync.js'

const config = {
  baseUrl: 'https://gateway.invalid/v1',
  apiKey: 'test-key',
  cacheIdentity: 'route',
  refreshIntervalMs: 1000,
  capabilityCatalogUrl: 'https://catalog.invalid/gpt.json',
}
const reply = (data: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), headers ? { headers } : undefined)
afterEach(() => vi.useRealTimers())

describe('automatic refresh lifecycle', () => {
  it('reads a separate capability catalog without forwarding the provider key', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('catalog.invalid')) {
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        return reply({
          version: '2026-11-10',
          models: {
            'gpt-new': {
              reasoning_supported_efforts: ['high', 'ultra'],
              service_tiers: ['default', 'ultrafast'],
            },
          },
        })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer test-key',
      )
      return reply({ data: [{ id: 'gpt-new' }] })
    })
    const result = await synchronize(config, undefined, request)
    expect(
      result.snapshot.capabilities['gpt-new']!.reasoning.choices.map(
        (choice) => choice.id,
      ),
    ).toEqual(['high', 'ultra'])
    expect(
      result.snapshot.capabilities['gpt-new']!.serviceTiers.map(
        (choice) => choice.id,
      ),
    ).toEqual(['default', 'ultrafast'])
  })

  it('refreshes on the configured interval and stops on disposal', async () => {
    vi.useFakeTimers()
    const publish = vi.fn(async () => {})
    const request = vi.fn(async () => reply({ data: [{ id: 'gpt-6-astra' }] }))
    const { capabilityCatalogUrl: _unused, ...local } = config
    const runner = new ModelSynchronizer(async () => local, publish, request)
    runner.start()
    await runner.refresh()
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(2)
    runner.dispose()
    await vi.advanceTimersByTimeAsync(10000)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(runner.getStatus().state).toBe('stopped')
  })

  it('preserves the last working snapshot when refresh fails', async () => {
    let fail = false
    const runner = new ModelSynchronizer(
      async () => ({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        cacheIdentity: config.cacheIdentity,
        refreshIntervalMs: 1000,
      }),
      async () => {},
      async () => {
        if (fail) throw new Error('offline')
        return reply({ data: [{ id: 'gpt-6-astra' }] })
      },
    )
    await runner.refresh()
    fail = true
    await expect(runner.refresh()).rejects.toThrow('offline')
    expect(runner.current()!.models[0]!.id).toBe('gpt-6-astra')
    runner.dispose()
  })

  it('cancels an in-flight refresh and prevents publishing after disposal', async () => {
    const publish = vi.fn(async () => {})
    const runner = new ModelSynchronizer(
      async () => ({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        cacheIdentity: config.cacheIdentity,
        refreshIntervalMs: 1000,
      }),
      publish,
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          )
        }),
    )
    const pending = runner.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    runner.dispose()
    await expect(pending).rejects.toThrow('cancelled')
    expect(publish).not.toHaveBeenCalled()
  })

  it('retains stale models until an explicit cleanup', async () => {
    let absent = false
    const runner = new ModelSynchronizer(
      async () => ({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        cacheIdentity: config.cacheIdentity,
        refreshIntervalMs: 1000,
      }),
      async () => {},
      async () => reply({ data: absent ? [] : [{ id: 'gpt-6-astra' }] }),
    )
    await runner.refresh()
    absent = true
    await runner.refresh()
    expect(runner.current()!.models[0]!.stale).toBe(true)
    await runner.removeStale(['gpt-6-astra'])
    expect(runner.current()!.models).toEqual([])
    runner.dispose()
  })

  it('discards results from a connection changed during a request', async () => {
    let active = { ...config, capabilityCatalogUrl: '' }
    const publish = vi.fn(async () => {})
    const calls: string[] = []
    const runner = new ModelSynchronizer(
      async () => active,
      publish,
      async (url) => {
        calls.push(url)
        if (url.includes('gateway.invalid')) {
          active = { ...active, baseUrl: 'https://other.invalid/v1' }
          return reply({ data: [{ id: 'gpt-old' }] })
        }
        return reply({ data: [{ id: 'gpt-current' }] })
      },
    )
    await runner.refresh()
    expect(calls).toEqual([
      'https://gateway.invalid/v1/models',
      'https://other.invalid/v1/models',
    ])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(runner.current()!.models.map((model) => model.id)).toEqual([
      'gpt-current',
    ])
    runner.dispose()
  })
})
