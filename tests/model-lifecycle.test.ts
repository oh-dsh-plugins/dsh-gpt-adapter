import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GptModels } from '../src/host.js'
import { JsonStorage } from '../src/storage.js'
import { syncCacheKey, synchronize } from '../src/sync.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-lifecycle-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const profile = (provider: string) => ({
    api: 'openai-responses',
    baseURL: `https://${provider}.invalid/v1`,
    apiKeyEnv: 'TEST_KEY',
    models: [{ id: 'gpt-fixture' }],
  })
  const raw = {
    providers: { fixture: profile('fixture'), other: profile('other') },
  }
  const route = () => ({
    enabled: true,
    refreshIntervalMs: 1800000,
    overridesJSON: '{}',
  })
  const options = { routes: { fixture: route(), other: route() } }
  const revisions: Record<string, number> = { 'llm-pi-ai': 1, 'gpt-adapter': 1 }
  const settings = {
    describe: () => [
      {
        ns: 'llm-pi-ai',
        value: structuredClone(raw),
        revision: revisions['llm-pi-ai'],
      },
      {
        ns: 'gpt-adapter',
        value: structuredClone(options),
        revision: revisions['gpt-adapter'],
      },
    ],
    async mutate(ns: string, operations: any[], expected?: number) {
      if (expected !== undefined && expected !== revisions[ns])
        throw new Error('revision conflict')
      for (const operation of operations) {
        let parent: any = options
        for (const part of operation.path.slice(0, -1)) parent = parent[part]
        parent[operation.path.at(-1)] = operation.value
      }
      revisions[ns]!++
      ctx.emit('settings/document-updated', ns as any, revisions[ns]!)
    },
  }
  ctx.provide('settings', settings as any)
  const credentials = {
    resolve: vi.fn(async () => ({ value: 'fixture-key' })),
  }
  ctx.provide('credentials', credentials as any)
  ctx.provide('llm', { listConfigurableProviders: () => [] } as any)
  const request = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'gpt-fixture',
              context_window: url.includes('new.invalid') ? 128000 : 900000,
            },
          ],
        }),
      ),
  )
  vi.stubGlobal('fetch', request)
  const service = new GptModels(ctx, options, 'gpt-adapter')
  const store = new JsonStorage(directory)
  ;(service as any).store = store
  return {
    ctx,
    raw,
    options,
    revisions,
    service,
    store,
    request,
    credentials,
    cachePath: (key: string) =>
      join(directory, createHash('sha256').update(key).digest('hex') + '.json'),
    async initialize() {
      await service.initialize()
      await Promise.all([service.refresh('fixture'), service.refresh('other')])
    },
  }
}

async function seedCache(f: Awaited<ReturnType<typeof fixture>>) {
  const { snapshot } = await synchronize(
    {
      baseUrl: f.raw.providers.fixture.baseURL,
      apiKey: 'fixture-key',
      cacheIdentity: 'fixture:TEST_KEY',
      protocol: 'openai-responses',
      refreshIntervalMs: 1800000,
    },
    undefined,
    async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'gpt-fixture', context_window: 333333 }],
        }),
      ),
  )
  await f.store.write('route:fixture', snapshot)
  return snapshot
}

async function prepareNativeCall(service: GptModels) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  const extension = service.capture('fixture', 'gpt-fixture', {
    provider: 'fixture',
    id: 'gpt-fixture',
    name: 'GPT',
  })!
  class CapturedAdapter extends LlmAdapter {
    providerInfo(provider: string) {
      return { id: provider, name: provider }
    }
    resolveModel() {
      return Promise.resolve(extension.model as any)
    }
    async *stream(): AsyncIterable<never> {
      throw new Error('This fixture only prepares calls')
    }
  }
  llm.registerAdapter(['fixture'], new CapturedAdapter())
  return llm.prepareCall({ provider: 'fixture', model: 'gpt-fixture' })
}

describe('model route configuration lifecycle', () => {
  it('releases a removed provider after it was disabled in an earlier event', async () => {
    const f = await fixture()
    await f.initialize()
    const internals = f.service as any
    const snapshot = internals.snapshots.get('fixture')
    f.options.routes.fixture.enabled = false
    f.ctx.emit('settings/document-updated', 'gpt-adapter' as any, 2)
    await Promise.resolve()
    expect(internals.runners.has('fixture')).toBe(false)
    expect(internals.snapshots.get('fixture')).toBe(snapshot)
    delete (f.raw.providers as Record<string, unknown>).fixture
    f.ctx.emit('settings/document-updated', 'llm-pi-ai' as any, 2)
    await Promise.resolve()
    expect(internals.runnerStates.has('fixture')).toBe(false)
    expect(internals.snapshots.has('fixture')).toBe(false)
    expect(internals.snapshots.has('other')).toBe(true)
    expect(internals.runners.has('other')).toBe(true)
  })

  it('refreshes a changed endpoint automatically and drops old capabilities while offline', async () => {
    const f = await fixture()
    await f.initialize()
    expect(f.service.capability('fixture', 'gpt-fixture')!.contextWindow).toBe(
      900000,
    )
    const old = f.service.capture('fixture', 'gpt-fixture', {
      provider: 'fixture',
      id: 'gpt-fixture',
      name: 'GPT',
    })!
    f.request.mockImplementation(async (url) => {
      if (url.includes('new.invalid')) throw new Error('new endpoint offline')
      return new Response(JSON.stringify({ data: [{ id: 'gpt-fixture' }] }))
    })
    f.raw.providers.fixture.baseURL = 'https://new.invalid/v1'
    f.ctx.emit('settings/document-updated', 'llm-pi-ai' as any, 2)
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith(
        'https://new.invalid/v1/models',
        expect.anything(),
      ),
    )
    expect(f.service.status('fixture').models).toEqual([])
    expect(
      f.service.capability('fixture', 'gpt-fixture')!.contextWindow,
    ).not.toBe(900000)
    expect(old.model.context).toEqual({ contextWindow: 900000 })
    expect(f.service.capability('other', 'gpt-fixture')!.contextWindow).toBe(
      900000,
    )
  })

  it('replans the interval without refreshing in response to model-list publication', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await f.initialize()
    f.options.routes.fixture.refreshIntervalMs = 1000
    f.ctx.emit('settings/document-updated', 'gpt-adapter' as any, 2)
    await vi.advanceTimersByTimeAsync(0)
    await f.service.refresh('fixture')
    expect(f.request).toHaveBeenCalledTimes(3)
    f.raw.providers.fixture.models[0] = {
      id: 'gpt-fixture',
      name: 'Renamed',
    } as any
    f.ctx.emit('settings/document-updated', 'llm-pi-ai' as any, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    await f.service.refresh('fixture')
    expect(f.request).toHaveBeenCalledTimes(4)
    expect(f.service.status('fixture').status.state).toBe('ready')
  })

  it('refreshes changed overrides while retaining raw metadata', async () => {
    const f = await fixture()
    await f.initialize()
    await f.service.updateOptions(
      'fixture',
      1800000,
      '',
      JSON.stringify({
        'gpt-fixture': { defaultServiceTier: 'fast' },
      }),
    )
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3))
    await f.service.refresh('fixture')
    expect(
      f.service.speed('session' as any, 'fixture', 'gpt-fixture').selected,
    ).toBe('fast')
    expect(f.service.capability('fixture', 'gpt-fixture')!.contextWindow).toBe(
      900000,
    )
  })

  it('checks the revision captured when options were opened and preserves old callers', async () => {
    const f = await fixture()
    await f.initialize()
    const opened = f.service.status('fixture').optionsRevision
    expect(opened).toBe(1)
    await f.service.updateOptions('fixture', 1000, '', '{}', opened)
    const current = structuredClone(f.options)
    await expect(
      f.service.updateOptions('fixture', 2000, '', '{}', opened),
    ).rejects.toThrow('revision conflict')
    expect(f.options).toEqual(current)
    expect(f.service.status('fixture').optionsRevision).toBe(2)
    await f.service.updateOptions('fixture', 3000, '', '{}')
    expect(f.options.routes.fixture.refreshIntervalMs).toBe(3000)
  })
})

describe('startup cache recovery', () => {
  it.each(['endpoint', 'disable', 'removed', 'added'] as const)(
    'reconciles %s changes while cached-route credential resolution waits',
    async (change) => {
      const f = await fixture()
      const cached = await seedCache(f)
      let entered!: () => void, release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      f.credentials.resolve.mockImplementationOnce(async () => {
        entered()
        await gate
        return { value: 'fixture-key' }
      })
      f.request.mockImplementation(async (url) => {
        if (!url.includes('other.invalid') && !url.includes('added.invalid'))
          throw new Error('fixture endpoint offline')
        return new Response(JSON.stringify({ data: [{ id: 'gpt-fixture' }] }))
      })
      const initializing = f.service.initialize()
      await started
      try {
        if (change === 'endpoint') {
          f.raw.providers.fixture.baseURL = 'https://new.invalid/v1'
        } else if (change === 'disable') {
          f.options.routes.fixture.enabled = false
        } else if (change === 'removed') {
          delete (f.raw.providers as Record<string, unknown>).fixture
        } else {
          ;(f.raw.providers as any).added = {
            ...f.raw.providers.other,
            baseURL: 'https://added.invalid/v1',
          }
          ;(f.options.routes as any).added = { ...f.options.routes.other }
        }
        f.ctx.emit(
          'settings/document-updated',
          (change === 'disable' ? 'gpt-adapter' : 'llm-pi-ai') as any,
          2,
        )
      } finally {
        release()
      }
      await initializing
      await f.service.refresh('other')
      const internals = f.service as any
      if (change === 'endpoint') {
        await expect(f.service.refresh('fixture')).rejects.toThrow('offline')
        expect(internals.snapshots.has('fixture')).toBe(false)
        expect(
          f.service.capability('fixture', 'gpt-fixture')!.contextWindow,
        ).not.toBe(333333)
        expect(
          f.request.mock.calls.some(([url]) => url.includes('new.invalid')),
        ).toBe(true)
      } else if (change === 'disable' || change === 'removed') {
        expect(internals.runners.has('fixture')).toBe(false)
        expect(internals.snapshots.has('fixture')).toBe(false)
        expect(
          f.request.mock.calls.some(([url]) => url.includes('fixture.invalid')),
        ).toBe(false)
      } else {
        await f.service.refresh('added')
        expect(internals.runners.has('added')).toBe(true)
        expect(internals.snapshots.get('fixture')?.cacheKey).toBe(
          cached.cacheKey,
        )
        expect(
          f.service.capability('fixture', 'gpt-fixture')!.contextWindow,
        ).toBe(333333)
      }
    },
  )

  it('does not let a late startup cache replace a credential-rotation runner', async () => {
    const f = await fixture()
    const cached = await seedCache(f)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.credentials.resolve.mockImplementationOnce(async () => {
      entered()
      await gate
      return { value: 'fixture-key' }
    })
    const initializing = f.service.initialize()
    await started
    try {
      f.credentials.resolve.mockImplementation(async () => ({
        value: 'rotated-key',
      }))
      f.ctx.emit('credentials/reference-updated', credentialRef('TEST_KEY'))
    } finally {
      release()
    }
    await initializing
    await f.service.refresh('fixture')
    const persisted = await f.store.read<any>('route:fixture')
    expect(persisted.cacheKey).not.toBe(cached.cacheKey)
    expect(persisted.cacheKey).toBe(
      syncCacheKey({
        baseUrl: f.raw.providers.fixture.baseURL,
        apiKey: 'rotated-key',
        cacheIdentity: 'fixture:TEST_KEY',
        protocol: 'openai-responses',
      }),
    )
  })

  it.each(['route:fixture', 'speeds'])(
    'rebuilds after invalid JSON in %s without blocking a healthy route',
    async (key) => {
      const f = await fixture()
      await writeFile(f.cachePath(key), '{"truncated":')
      await f.initialize()
      expect(f.service.status('fixture').status.state).toBe('ready')
      expect(f.service.status('other').status.state).toBe('ready')
      expect(
        f.service.speed('session' as any, 'fixture', 'gpt-fixture').selected,
      ).toBe('default')
    },
  )

  it('ignores malformed speed cache shapes', async () => {
    const f = await fixture()
    await f.store.write('speeds', ['fast'])
    await f.initialize()
    expect((f.service as any).speeds.size).toBe(0)
  })
})

describe('native model naming contract', () => {
  it.each([
    { displayName: '' },
    { reasoningChoices: [{ id: 'high', label: '', wireValue: 'high' }] },
  ])('rejects an empty native name before saving (%j)', async (override) => {
    const f = await fixture()
    await f.initialize()
    const before = structuredClone(f.options)
    const revision = f.revisions['gpt-adapter']
    await expect(
      f.service.updateOptions(
        'fixture',
        1800000,
        '',
        JSON.stringify({
          'gpt-fixture': override,
        }),
      ),
    ).rejects.toThrow('格式无效')
    expect(f.options).toEqual(before)
    expect(f.revisions['gpt-adapter']).toBe(revision)
    await expect(prepareNativeCall(f.service)).resolves.toMatchObject({
      config: { provider: 'fixture', model: 'gpt-fixture' },
    })
  })

  it.each(['', ' \t'])(
    'prepares a model whose upstream display name is %j',
    async (displayName) => {
      const f = await fixture()
      f.request.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'gpt-fixture', display_name: displayName }],
            }),
          ),
      )
      await f.initialize()
      expect(f.service.capability('fixture', 'gpt-fixture')!.displayName).toBe(
        'gpt-fixture',
      )
      await expect(prepareNativeCall(f.service)).resolves.toMatchObject({
        config: { provider: 'fixture', model: 'gpt-fixture' },
      })
    },
  )
})
