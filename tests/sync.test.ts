import { describe, expect, it } from 'vitest'
import { buildSnapshot, synchronize, type FetchLike } from '../src/sync.js'

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('upstream model synchronization', () => {
  it('filters to GPT models by default and builds capabilities', () => {
    const snapshot = buildSnapshot(
      [{ id: 'gpt-6-astra' }, { id: 'claude-sonnet-4-5' }],
      {},
      'test',
    )
    expect(snapshot.models.map((model) => model.id)).toEqual(['gpt-6-astra'])
    expect(
      snapshot.capabilities['gpt-6-astra']?.reasoning.choices.some(
        (choice) => choice.id === 'max',
      ),
    ).toBe(true)
    expect(
      snapshot.capabilities['gpt-6-astra']?.reasoning.choices.some(
        (choice) => choice.id === 'ultra',
      ),
    ).toBe(true)
  })

  it('preserves the previous snapshot on a not-modified response', async () => {
    const config = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      cacheIdentity: 'account-1',
      refreshIntervalMs: 1000,
    }
    const previous = await synchronize(config, undefined, async () =>
      response({ data: [{ id: 'gpt-6-astra' }] }, { headers: { etag: 'v1' } }),
    )
    const fetchImpl: FetchLike = async (_input, init) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('v1')
      return new Response(null, { status: 304 })
    }
    const result = await synchronize(config, previous.snapshot, fetchImpl)
    expect(result.changed).toBe(false)
    expect(result.snapshot.models).toEqual(previous.snapshot.models)
    expect(result.snapshot.source).toBe('cache')
  })

  it('reapplies local overrides when the upstream list is not modified', async () => {
    const previous = await synchronize(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'secret',
        cacheIdentity: 'account-1',
        refreshIntervalMs: 1000,
      },
      undefined,
      async () => response({ data: [{ id: 'gpt-6-astra' }] }),
    )
    const result = await synchronize(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'secret',
        cacheIdentity: 'account-1',
        refreshIntervalMs: 1000,
        overrides: { 'gpt-6-astra': { displayName: 'GPT Custom' } },
      },
      previous.snapshot,
      async () => new Response(null, { status: 304 }),
    )
    expect(result.changed).toBe(true)
    expect(result.snapshot.capabilities['gpt-6-astra']?.displayName).toBe(
      'GPT Custom',
    )
  })

  it('upgrades a cached Standard-only preset even when the model list returns 304', async () => {
    const config = {
      baseUrl: 'https://gateway.invalid/v1',
      apiKey: 'test-key',
      cacheIdentity: 'route',
      refreshIntervalMs: 1000,
    }
    const previous = await synchronize(config, undefined, async () =>
      response({ data: [{ id: 'gpt-custom' }] }, { headers: { etag: 'v1' } }),
    )
    previous.snapshot.capabilities['gpt-custom']!.serviceTiers = [
      {
        id: 'default',
        label: 'Standard',
        wireValue: 'default',
        source: 'catalog',
      },
    ]
    const result = await synchronize(
      config,
      previous.snapshot,
      async () => new Response(null, { status: 304 }),
    )
    expect(result.changed).toBe(true)
    expect(
      result.snapshot.capabilities['gpt-custom']!.serviceTiers.map((choice) => [
        choice.id,
        choice.wireValue,
      ]),
    ).toEqual([
      ['default', 'default'],
      ['fast', 'priority'],
    ])
  })

  it('does not report a change when the upstream list is identical', async () => {
    const fetchImpl: FetchLike = async () =>
      response({ data: [{ id: 'gpt-6-astra' }] })
    const config = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      cacheIdentity: 'account-1',
      refreshIntervalMs: 1000,
    }
    const previous = await synchronize(config, undefined, fetchImpl)
    const result = await synchronize(config, previous.snapshot, fetchImpl)
    expect(result.changed).toBe(false)
  })

  it('parses upstream reasoning metadata instead of discarding it', async () => {
    const result = await synchronize(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'secret',
        cacheIdentity: 'account-1',
        refreshIntervalMs: 1000,
      },
      undefined,
      async () =>
        response({
          data: [
            {
              id: 'gpt-custom',
              reasoning_supported_efforts: ['high', 'ultra'],
              reasoning_default_effort: 'ultra',
            },
          ],
        }),
    )
    const capabilities = result.snapshot.capabilities['gpt-custom']
    expect(capabilities?.reasoning.choices.map((choice) => choice.id)).toEqual([
      'high',
      'ultra',
    ])
    expect(capabilities?.reasoning.defaultId).toBe('ultra')
  })

  it('retains absent upstream models as stale and removes duplicates', async () => {
    const config = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      cacheIdentity: 'account-1',
      refreshIntervalMs: 1000,
    }
    const previous = await synchronize(config, undefined, async () =>
      response({ data: [{ id: 'gpt-6-astra' }] }),
    )
    const result = await synchronize(config, previous.snapshot, async () =>
      response({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-sol' }] }),
    )
    expect(result.snapshot.models.map((model) => model.id)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
    ])
    expect(result.snapshot.models[1]?.stale).toBe(true)
  })

  it('retains upstream capabilities when a later list omits optional metadata', async () => {
    const config = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      cacheIdentity: 'account-1',
      refreshIntervalMs: 1000,
    }
    const previous = await synchronize(config, undefined, async () =>
      response({
        data: [
          {
            id: 'gpt-custom',
            reasoning_supported_efforts: ['high', 'ultra'],
          },
        ],
      }),
    )
    const result = await synchronize(config, previous.snapshot, async () =>
      response({ data: [{ id: 'gpt-custom' }] }),
    )
    expect(
      result.snapshot.capabilities['gpt-custom']?.reasoning.choices.map(
        (choice) => choice.id,
      ),
    ).toEqual(['high', 'ultra'])
  })

  it('does not reuse an ETag across cache identities and clears missing ETags', async () => {
    const config = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      cacheIdentity: 'account-1',
      refreshIntervalMs: 1000,
    }
    const previous = await synchronize(config, undefined, async () =>
      response({ data: [{ id: 'gpt-6-astra' }] }, { headers: { etag: 'old' } }),
    )
    const requests: Array<{ etag: string | null }> = []
    const result = await synchronize(
      { ...config, cacheIdentity: 'account-2' },
      previous.snapshot,
      async (_input, init) => {
        requests.push({ etag: new Headers(init?.headers).get('if-none-match') })
        return response({ data: [{ id: 'gpt-6.1-sol' }] })
      },
    )
    expect(requests).toEqual([{ etag: null }])
    expect(result.snapshot.etag).toBeUndefined()
  })
})
