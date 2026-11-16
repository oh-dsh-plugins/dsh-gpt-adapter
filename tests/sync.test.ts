import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  fetchModels,
  fetchCapabilityCatalog,
  restoreSnapshot,
  synchronize,
  type FetchLike,
} from '../src/sync.js'

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('upstream model synchronization', () => {
  it.each(['', ' \t'])(
    'uses the model ID for an empty upstream name (%j)',
    async (displayName) => {
      const result = await synchronize(
        {
          baseUrl: 'https://fixture.invalid',
          apiKey: 'fixture',
          cacheIdentity: 'fixture',
          refreshIntervalMs: 1000,
        },
        undefined,
        async () =>
          response({
            data: [{ id: 'gpt-fixture', display_name: displayName }],
          }),
      )
      expect(result.snapshot.models[0]).not.toHaveProperty('displayName')
      expect(result.snapshot.capabilities['gpt-fixture']!.displayName).toBe(
        'gpt-fixture',
      )
    },
  )

  it.each([[[]], [['auto']], [['unknown']]])(
    'refuses unusable catalog service tiers before publishing them (%j)',
    async (serviceTiers) => {
      await expect(
        fetchCapabilityCatalog('https://catalog.invalid', async () =>
          response({
            version: 'fixture',
            models: { 'gpt-fixture': { service_tiers: serviceTiers } },
          }),
        ),
      ).rejects.toThrow('no supported service tiers')
    },
  )

  it.each([
    { models: [null] },
    { models: [{ id: 'gpt-fixture', displayName: '' }] },
    { models: [{ id: 'gpt-fixture', capabilities: { reasoningChoices: {} } }] },
    { upstreamModels: {} },
    {
      upstreamModels: [
        { id: 'gpt-fixture', capabilities: { serviceTiers: [] } },
      ],
    },
    {
      catalog: {
        version: 'fixture',
        models: { 'gpt-fixture': { serviceTiers: {} } },
      },
    },
  ])('ignores a malformed cached metadata shape (%j)', async (invalid) => {
    const config = {
      baseUrl: 'https://gateway.invalid',
      apiKey: 'fixture',
      cacheIdentity: 'fixture',
      refreshIntervalMs: 1000,
    }
    const before = (
      await synchronize(config, undefined, async () =>
        response({ data: [{ id: 'gpt-fixture' }] }),
      )
    ).snapshot
    expect(
      restoreSnapshot(config, { ...before, ...invalid } as any),
    ).toBeUndefined()
    expect(restoreSnapshot(config, before)?.models).toEqual(before.models)
  })

  it.each([
    'models-http',
    'catalog-http',
    'declared-limit',
    'stream-limit',
  ] as const)('cancels an unconsumed response body on %s', async (failure) => {
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (failure === 'stream-limit')
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
      },
      cancel() {
        cancelled++
        throw new Error('fixture cancellation failure')
      },
    })
    const response = new Response(body, {
      status: failure.endsWith('http') ? 503 : 200,
      headers:
        failure === 'declared-limit'
          ? { 'content-length': String(4 * 1024 * 1024 + 1) }
          : {},
    })
    const request = async () => response
    await expect(
      failure === 'catalog-http'
        ? fetchCapabilityCatalog('https://catalog.invalid', request)
        : fetchModels(
            { baseUrl: 'https://gateway.invalid', apiKey: 'fixture' },
            request,
          ),
    ).rejects.toThrow(failure.endsWith('http') ? 'HTTP 503' : 'exceeds')
    expect(cancelled).toBe(1)
  })

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

  it.each([false, true])(
    'reapplies a widened filter to cached raw models while preserving retained state (legacy=%s)',
    async (legacy) => {
      const config = {
        baseUrl: 'https://gateway.invalid/v1',
        apiKey: 'fixture-key',
        cacheIdentity: 'fixture',
        refreshIntervalMs: 1000,
        includeModel: (model: { id: string }) => model.id !== 'gpt-second',
      }
      const first = await synchronize(config, undefined, async () =>
        response({
          data: [
            { id: 'gpt-first' },
            { id: 'gpt-second', context_window: 128000 },
            { id: 'gpt-gone' },
          ],
        }),
      )
      const { snapshot: cached } = await synchronize(
        config,
        first.snapshot,
        async () =>
          response(
            {
              data: [
                { id: 'gpt-first' },
                { id: 'gpt-second', context_window: 128000 },
              ],
            },
            { headers: { etag: 'fixture-etag' } },
          ),
      )
      cached.fetchedAt = '2026-01-01T00:00:00.000Z'
      if (legacy) delete cached.upstreamModels
      const before = structuredClone(cached)
      const widened = {
        ...config,
        includeModel: () => true,
        overrides: { 'gpt-first': { displayName: 'Current name' } },
      }
      const restored = restoreSnapshot(widened, cached)!
      expect(restored.models.map((model) => model.id)).toEqual(
        legacy
          ? ['gpt-first', 'gpt-gone']
          : ['gpt-first', 'gpt-second', 'gpt-gone'],
      )
      expect(
        restored.models.find((model) => model.id === 'gpt-gone')?.stale,
      ).toBe(true)
      expect(restored).toMatchObject({
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        cacheKey: cached.cacheKey,
        etag: 'fixture-etag',
      })
      expect(restored.capabilities['gpt-first']!.displayName).toBe(
        'Current name',
      )
      const conditional = await synchronize(
        widened,
        cached,
        async () => new Response(null, { status: 304 }),
      )
      expect(restored.models).toEqual(conditional.snapshot.models)
      expect(restored.capabilities).toEqual(conditional.snapshot.capabilities)
      expect(cached).toEqual(before)
    },
  )

  it('restores raw metadata and current overrides without changing cache age or stale state', async () => {
    const config = {
      baseUrl: 'https://gateway.invalid/v1',
      apiKey: 'key',
      cacheIdentity: 'route',
      refreshIntervalMs: 1000,
    }
    const { snapshot: previous } = await synchronize(
      config,
      undefined,
      async () =>
        response(
          { data: [{ id: 'gpt-custom', context_window: 321000 }] },
          { headers: { etag: 'v1' } },
        ),
    )
    previous.fetchedAt = '2026-01-01T00:00:00.000Z'
    previous.models[0]!.stale = true
    const restored = restoreSnapshot(
      {
        ...config,
        overrides: { 'gpt-custom': { displayName: 'Current name' } },
      },
      previous,
    )!
    expect(restored).toMatchObject({
      models: previous.models,
      upstreamModels: previous.upstreamModels,
      fetchedAt: previous.fetchedAt,
      etag: 'v1',
      source: 'cache',
      cacheKey: previous.cacheKey,
    })
    expect(restored.capabilities['gpt-custom']).toMatchObject({
      displayName: 'Current name',
      contextWindow: 321000,
    })
    expect(previous.capabilities['gpt-custom']!.displayName).toBe('gpt-custom')
    expect(
      restoreSnapshot({ ...config, apiKey: 'another-key' }, previous),
    ).toBeUndefined()
  })

  it.each(['same', 'changed', 'removed', 'legacy'] as const)(
    'only restores a cached external catalog from the current source (%s)',
    async (mode) => {
      const config = {
        baseUrl: 'https://gateway.invalid/v1',
        apiKey: 'key',
        cacheIdentity: 'route',
        refreshIntervalMs: 1000,
        capabilityCatalogUrl: 'https://catalog.invalid/old.json',
      }
      const { snapshot: previous } = await synchronize(
        config,
        undefined,
        async (url) =>
          response(
            url.endsWith('/models')
              ? { data: [{ id: 'gpt-custom' }] }
              : {
                  version: 'v1',
                  models: { 'gpt-custom': { context_window: 321000 } },
                },
          ),
      )
      expect(previous.capabilityCatalogUrl).toBe(config.capabilityCatalogUrl)
      if (mode === 'legacy') delete previous.capabilityCatalogUrl
      const { capabilityCatalogUrl: _url, ...connection } = config
      const restored = restoreSnapshot(
        {
          ...connection,
          ...(mode === 'removed'
            ? {}
            : {
                capabilityCatalogUrl:
                  mode === 'changed'
                    ? 'https://catalog.invalid/new.json'
                    : config.capabilityCatalogUrl,
              }),
        },
        previous,
      )!
      if (mode === 'same') {
        expect(restored.catalog).toEqual(previous.catalog)
        expect(restored.capabilityCatalogUrl).toBe(config.capabilityCatalogUrl)
        expect(restored.capabilities['gpt-custom']!.contextWindow).toBe(321000)
      } else {
        expect(restored.catalog).toBeUndefined()
        expect(restored.capabilityCatalogUrl).toBeUndefined()
        expect(restored.capabilities['gpt-custom']!.contextWindow).not.toBe(
          321000,
        )
      }
    },
  )

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

  it('replaces an obsolete reasoning support flag with an explicit new effort list', async () => {
    const config = {
      baseUrl: 'https://gateway.invalid/v1',
      apiKey: 'test-key',
      cacheIdentity: 'route',
      refreshIntervalMs: 1000,
    }
    let previous = (
      await synchronize(config, undefined, async () =>
        response({ data: [{ id: 'gpt-custom', supports_reasoning: false }] }),
      )
    ).snapshot
    for (const [metadata, enabled] of [
      [{ reasoning_supported_efforts: ['low', 'high'] }, true],
      [{}, true],
      [{ reasoning_supported_efforts: [] }, false],
      [
        { supports_reasoning: false, reasoning_supported_efforts: ['high'] },
        false,
      ],
    ] as const) {
      previous = (
        await synchronize(config, previous, async () =>
          response({ data: [{ id: 'gpt-custom', ...metadata }] }),
        )
      ).snapshot
      expect(previous.capabilities['gpt-custom']!.reasoning.status).toBe(
        enabled ? 'known' : 'unsupported',
      )
      expect(
        previous.capabilities['gpt-custom']!.reasoning.choices.map((c) => c.id),
      ).toEqual(enabled ? ['low', 'high'] : [])
    }
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
