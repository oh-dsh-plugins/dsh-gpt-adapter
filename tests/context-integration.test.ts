import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as native from '@deepseek-ai/dsh-llm-pi-ai'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, type GptModels } from '../src/host.js'
import { JsonStorage } from '../src/storage.js'
import { syncCacheKey, synchronize } from '../src/sync.js'
import type { ModelOverride, SyncSnapshot } from '../src/types.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function fixture(
  protocol = 'openai-responses',
  catalogOverrides = false,
  inheritedLayer: boolean | 'empty-user' = false,
  cached?: {
    matching: boolean
    overrides?: Record<string, ModelOverride>
    rotateWhileResolving?: boolean
  },
) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-context-test-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', directory)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const profile = () => ({
    api: protocol,
    baseURL: 'https://fixture.invalid/v1',
    apiKeyEnv: 'TEST_KEY',
    models: [{ id: 'gpt-5.4', maxTokens: 2048 }, { id: 'gpt-4o' }],
  })
  let raw: any = { providers: { fixture: profile(), other: profile() } }
  let options: any = {
    codexCompatibility: { enabled: false },
    routes: {
      fixture: {
        enabled: true,
        refreshIntervalMs: 1800000,
        overridesJSON: '{}',
      },
    },
  }
  if (catalogOverrides) {
    raw.providers.openai = {
      api: protocol,
      baseURL: 'https://fixture.invalid/v1',
      apiKeyEnv: 'TEST_KEY',
      modelOverrides: { 'gpt-5.4': { contextWindow: 128000, maxTokens: 4096 } },
    }
    options.routes.openai = {
      enabled: true,
      refreshIntervalMs: 1800000,
      overridesJSON: '{}',
    }
  }
  const base =
    inheritedLayer === 'empty-user' ? structuredClone(raw) : undefined
  if (base) raw = {}
  const effective = () =>
    base
      ? {
          providers: Object.fromEntries(
            Object.keys({ ...base.providers, ...raw.providers }).map(
              (provider) => [
                provider,
                { ...base.providers[provider], ...raw.providers?.[provider] },
              ],
            ),
          ),
        }
      : raw
  const plugin = await import('../lib/index.js')
  const liveOptions = Config(options)
  const revisions: Record<string, number> = { 'llm-pi-ai': 1, 'gpt-adapter': 1 }
  let failCleanup = false
  let descriptionReads = 0
  let headroomTokens = 65536
  let writeGate: Promise<void> | undefined
  let afterCommit: (() => Promise<void>) | undefined
  const settings = {
    configure: () => () => {},
    describe: () => (
      descriptionReads++,
      [
        {
          ns: 'llm-pi-ai',
          value: structuredClone(effective()),
          user: structuredClone(raw),
          base: structuredClone(base ?? (inheritedLayer ? raw : {})),
          schema: native.Config.toJSON(),
          revision: revisions['llm-pi-ai'],
        },
        {
          ns: 'gpt-adapter',
          value: options,
          revision: revisions['gpt-adapter'],
        },
        { ns: 'compaction-basic', value: { headroomTokens } },
      ]
    ),
    async write(
      ns: string,
      change: (current: any, base: any, schema: any) => any,
      expected?: number,
    ) {
      if (writeGate) await writeGate
      if (
        expected !== undefined &&
        settings.describe().find((row) => row.ns === ns)?.revision !== expected
      )
        throw new Error('revision conflict')
      if (ns === 'gpt-adapter' && failCleanup)
        throw new Error('legacy cleanup failed')
      const next = change(
        structuredClone(ns === 'llm-pi-ai' ? raw : options),
        structuredClone(base ?? {}),
        native.Config,
      )
      if (ns === 'llm-pi-ai') {
        native.Config(next)
        raw = next
      } else {
        options = next
        liveOptions.routes = Config(options).routes
      }
      revisions[ns]!++
      ctx.emit('settings/document-updated', ns as any, revisions[ns]!)
      if (ns === 'llm-pi-ai' && afterCommit) {
        const wait = afterCommit
        afterCommit = undefined
        await wait()
      }
    },
    async mutate(ns: string, operations: any[], expected?: number) {
      await this.write(
        ns,
        (current) => {
          for (const operation of operations) {
            let parent = current
            for (const part of operation.path.slice(0, -1))
              parent = parent[part] ??= {}
            parent[operation.path.at(-1)] = operation.value
          }
          return current
        },
        expected,
      )
    },
  }
  ctx.provide('settings', settings)
  const credentials = new Map([
    ['TEST_KEY', 'fixture-key'],
    ['OTHER_KEY', 'fixture-key'],
  ])
  let rotateWhileResolving = cached?.rotateWhileResolving ?? false
  const credentialService = {
    resolve: async (ref: string) => {
      const value = credentials.get(ref)
      if (rotateWhileResolving) {
        rotateWhileResolving = false
        credentials.set(ref, 'rotated-key')
        ctx.emit('credentials/reference-updated', credentialRef(ref))
      }
      return value ? { value } : undefined
    },
  }
  ctx.provide('credentials', credentialService)
  let adapter: LlmAdapter | undefined
  ctx.provide('llm', {
    listConfigurableProviders: () => [],
    registerAdapter: (_providers: unknown, value: LlmAdapter) => {
      adapter = value
      return Object.assign(() => {}, { replace() {} })
    },
    registerConfigurableProviders: () =>
      Object.assign(() => {}, { replace() {} }),
    registerModelDiscovery: () => () => {},
  })
  let models: any[] = [{ id: 'gpt-5.4', context_window: 800000 }]
  let failed = !!cached
  if (cached) {
    const { snapshot } = await synchronize(
      {
        baseUrl: 'https://fixture.invalid/v1',
        apiKey: cached.matching ? 'fixture-key' : 'different-account-key',
        cacheIdentity: 'fixture:TEST_KEY',
        protocol: protocol as any,
        refreshIntervalMs: 1800000,
        overrides: cached.overrides ?? {},
      },
      undefined,
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'gpt-5.4', context_window: 333333 }] }),
        ),
    )
    await new JsonStorage(join(directory, 'storages/gpt-adapter')).write(
      'route:fixture',
      snapshot,
    )
  }
  const requests: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        if (failed) throw new Error('offline')
        return new Response(JSON.stringify({ data: models }))
      }
      requests.push(JSON.parse(String(init!.body)))
      const message = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }],
      }
      const response = {
        id: 'resp_1',
        model: 'gpt-5.4',
        status: 'completed',
        output: [message],
        usage: {
          input_tokens: 600000,
          output_tokens: 2,
          total_tokens: 600002,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }
      const events =
        protocol === 'openai-responses'
          ? [
              {
                type: 'response.created',
                response: { ...response, output: [] },
              },
              {
                type: 'response.output_item.done',
                output_index: 0,
                item: message,
              },
              { type: 'response.completed', response },
            ]
          : [
              {
                id: 'chat_1',
                object: 'chat.completion.chunk',
                model: 'gpt-5.4',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'OK' },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 600000,
                  completion_tokens: 2,
                  total_tokens: 600002,
                },
              },
            ]
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }),
  )
  await plugin.apply(ctx, liveOptions)
  const service = ctx.get('gptModels') as GptModels
  await service.refresh('fixture').catch((error) => {
    if (!cached) throw error
  })
  if (catalogOverrides) await service.refresh('openai')
  return {
    ctx,
    settings,
    credentials: credentialService,
    service,
    requests,
    revisions,
    reads: () => descriptionReads,
    resetReads: () => {
      descriptionReads = 0
    },
    headroom: (value: number) => {
      headroomTokens = value
    },
    pauseWrites: () => {
      let resume!: () => void
      writeGate = new Promise<void>((resolve) => {
        resume = () => {
          writeGate = undefined
          resolve()
        }
      })
      return resume
    },
    holdNextCommit: () => {
      let entered!: () => void, release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      afterCommit = async () => {
        entered()
        await gate
      }
      return { started, release }
    },
    raw: () => raw,
    options: () => options,
    model: () => raw.providers.fixture.models[0],
    models: (value: any[]) => {
      models = value
    },
    fail: () => {
      failed = true
    },
    rotateCredential: (value: string | undefined, ref = 'TEST_KEY') => {
      if (value === undefined) credentials.delete(ref)
      else credentials.set(ref, value)
      ctx.emit('credentials/reference-updated', credentialRef(ref))
    },
    failCleanup: () => {
      failCleanup = true
    },
    native() {
      native.apply(ctx, native.Config(effective()))
      return adapter!
    },
    async legacy(value: any) {
      await settings.mutate('gpt-adapter', [
        {
          op: 'set',
          path: ['routes', 'fixture', 'overridesJSON'],
          value: JSON.stringify(value),
        },
      ])
    },
  }
}

describe('context settings and live model integration', () => {
  it('discovers new models into an empty user layer without copying inherited provider options', async () => {
    const f = await fixture('openai-responses', false, 'empty-user')
    expect(f.raw()).toEqual({})
    f.models([{ id: 'gpt-5.4' }, { id: 'gpt-new' }])
    await f.service.refresh('fixture')
    expect(Object.keys(f.raw().providers)).toEqual(['fixture'])
    expect(Object.keys(f.raw().providers.fixture)).toEqual(['models'])
    expect(f.raw().providers.fixture.models).toEqual([
      { id: 'gpt-5.4', maxTokens: 2048 },
      { id: 'gpt-4o' },
      { id: 'gpt-new', name: 'gpt-new' },
    ])
    expect(
      (await f.native().prepareCall('fixture', 'gpt-new')).model.context
        ?.contextWindow,
    ).toBeGreaterThan(0)
  })

  it('serializes context saves through legacy cleanup without rolling back a later save', async () => {
    const f = await fixture()
    await f.legacy({
      'gpt-5.4': { contextWindow: 600000 },
      'gpt-4o': { contextWindow: 600000 },
    })
    const gate = f.holdNextCommit()
    const first = f.settings.write('llm-pi-ai', (current) => {
      for (const model of current.providers.fixture.models)
        model.contextWindow = 516000
      return current
    })
    await gate.started
    let secondFinished = false
    const second = f.settings
      .write('llm-pi-ai', (current) => {
        current.providers.fixture.models[0].contextWindow = 1000000
        return current
      })
      .then(() => {
        secondFinished = true
      })
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(secondFinished).toBe(false)
    } finally {
      gate.release()
    }
    await Promise.all([first, second])
    expect(f.model().contextWindow).toBe(1000000)
    expect(JSON.parse(f.options().routes.fixture.overridesJSON)).toEqual({
      'gpt-5.4': {},
      'gpt-4o': {},
    })
  })

  it('does not compensate over a context value changed by an external profile reload', async () => {
    const f = await fixture()
    await f.legacy({ 'gpt-5.4': { contextWindow: 600000 } })
    f.failCleanup()
    const gate = f.holdNextCommit()
    const save = f.service.setContextWindow('fixture', 'gpt-5.4', '516k')
    const rejected = expect(save).rejects.toThrow('恢复失败')
    await gate.started
    f.model().contextWindow = 1000000
    f.revisions['llm-pi-ai']!++
    gate.release()
    await rejected
    expect(f.model().contextWindow).toBe(1000000)
  })

  it('rejects an old publisher and commits its replacement after pending storage work settles', async () => {
    const f = await fixture()
    const storage = (f.service as any).store as JsonStorage
    const original = storage.write.bind(storage)
    let entered!: () => void,
      release!: () => void,
      held = false
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = vi
      .spyOn(storage, 'write')
      .mockImplementation(async (key, value, beforeCommit) => {
        if (key === 'route:fixture' && !held) {
          held = true
          entered()
          await gate
        }
        await original(key, value, beforeCommit)
      })
    f.models([{ id: 'gpt-5.4', context_window: 128000 }])
    const old = f.service.refresh('fixture').catch((error) => error)
    await started
    await f.service.configure('fixture', false)
    f.models([{ id: 'gpt-5.4', context_window: 1000000 }])
    await f.service.configure('fixture', true)
    const replacement = f.service.refresh('fixture')
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(
        write.mock.calls.filter(([key]) => key === 'route:fixture'),
      ).toHaveLength(1)
    } finally {
      release()
    }
    expect(await old).toBeInstanceOf(Error)
    await replacement
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      1000000,
    )
    expect(
      (await storage.read<SyncSnapshot>('route:fixture'))!.capabilities[
        'gpt-5.4'
      ]!.contextWindow,
    ).toBe(1000000)
  })

  it('rejects a stopped publisher before its queued native model-list write commits', async () => {
    const f = await fixture()
    f.models([{ id: 'gpt-5.4' }, { id: 'gpt-new' }])
    const resume = f.pauseWrites()
    const write = vi.spyOn(f.settings, 'write')
    const pending = f.service.refresh('fixture').catch((error) => error)
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalled())
      const runners = (f.service as any).runners as Map<
        string,
        { dispose(): void }
      >
      runners.get('fixture')!.dispose()
      runners.delete('fixture')
    } finally {
      resume()
    }
    expect(await pending).toBeInstanceOf(Error)
    expect(
      f
        .raw()
        .providers.fixture.models.some((model: any) => model.id === 'gpt-new'),
    ).toBe(false)
  })

  it('revokes a pending cache publication on credential rotation and publishes only the replacement', async () => {
    const f = await fixture()
    await f.service.refresh('other')
    f.raw().providers.other.apiKeyEnv = 'OTHER_KEY'
    await f.service.refresh('other')
    const other = (f.service as any).runners.get('other')
    const nativeSnapshot = {}
    const base = { provider: 'fixture', id: 'gpt-5.4', name: 'GPT' }
    expect(
      (
        f.service.capture('fixture', 'gpt-5.4', base, nativeSnapshot)!.model
          .context as any
      ).contextWindow,
    ).toBe(800000)
    const storage = (f.service as any).store as JsonStorage
    const original = storage.write.bind(storage)
    let entered!: () => void,
      release!: () => void,
      held = false
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const committed: SyncSnapshot[] = []
    vi.spyOn(storage, 'write').mockImplementation(
      async (key, value, beforeCommit) => {
        if (key === 'route:fixture' && !held) {
          held = true
          entered()
          await gate
        }
        await original(key, value, () => {
          beforeCommit?.()
          if (key === 'route:fixture') committed.push(value as SyncSnapshot)
        })
      },
    )
    f.models([{ id: 'gpt-5.4', context_window: 128000 }])
    const old = f.service.refresh('fixture').catch((error) => error)
    await started
    let replacement: Promise<void>
    try {
      f.models([{ id: 'gpt-5.4', context_window: 1000000 }])
      f.rotateCredential('rotated-key')
      expect(
        (
          f.service.capture('fixture', 'gpt-5.4', base, nativeSnapshot)!.model
            .context as any
        ).contextWindow,
      ).not.toBe(800000)
      expect((f.service as any).runners.get('other')).toBe(other)
      expect(f.service.contextWindow('other', 'gpt-5.4').effectiveTokens).toBe(
        800000,
      )
      replacement = f.service.refresh('fixture')
    } finally {
      release()
    }
    expect(await old).toBeInstanceOf(Error)
    await replacement!
    expect(committed).toHaveLength(1)
    const persisted = (await storage.read<SyncSnapshot>('route:fixture'))!
    expect(persisted.cacheKey).toBe(
      syncCacheKey({
        baseUrl: 'https://fixture.invalid/v1',
        cacheIdentity: 'fixture:TEST_KEY',
        apiKey: 'rotated-key',
        protocol: 'openai-responses',
      }),
    )
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      1000000,
    )
    expect((f.service as any).runners.get('fixture').current()).toEqual(
      persisted,
    )
  })

  it('revokes a queued native model-list write when its credential is removed', async () => {
    const f = await fixture()
    f.models([{ id: 'gpt-5.4' }, { id: 'gpt-old-account' }])
    const resume = f.pauseWrites()
    const write = vi.spyOn(f.settings, 'write')
    const old = f.service.refresh('fixture').catch((error) => error)
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalled())
      f.rotateCredential(undefined)
    } finally {
      resume()
    }
    expect(await old).toBeInstanceOf(Error)
    await expect(f.service.refresh('fixture')).rejects.toThrow(
      'API key is unavailable',
    )
    expect(
      f.raw().providers.fixture.models.map((model: any) => model.id),
    ).not.toContain('gpt-old-account')
    expect((f.service as any).runners.get('fixture').current()).toBeUndefined()
    expect(
      f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens,
    ).not.toBe(800000)
  })

  it('keeps existing routes and snapshots on unrelated credential events', async () => {
    const f = await fixture()
    await f.service.refresh('other')
    const before = f.service.status('fixture')
    const current = (f.service as any).runners.get('fixture')
    const request = vi.mocked(fetch)
    request.mockClear()
    f.rotateCredential('unrelated-key', 'UNUSED_KEY')
    f.ctx.emit(
      'credentials/record-updated',
      credentialKey('llm-pi-ai', 'fixture'),
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect((f.service as any).runners.get('fixture')).toBe(current)
    expect(f.service.status('fixture')).toEqual(before)
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['credential-rotation', 'refresh'])(
    'does not delete a newly active model after a queued stale cleanup (%s)',
    async (change) => {
      const f = await fixture()
      await f.service.refresh('other')
      const models = [
        { id: 'gpt-5.4', context_window: 800000 },
        { id: 'gpt-4o', context_window: 128000 },
      ]
      f.models(models)
      await f.service.refresh('fixture')
      f.models(models.slice(0, 1))
      await f.service.refresh('fixture')
      expect(f.service.status('fixture').models).toContainEqual({
        id: 'gpt-4o',
        stale: true,
      })
      const before = structuredClone(f.raw().providers.fixture)
      const resume = f.pauseWrites()
      const write = vi.spyOn(f.settings, 'write')
      const pending = f.service.removeStale('fixture').catch((error) => error)
      try {
        await vi.waitFor(() => expect(write).toHaveBeenCalled())
        f.models(models)
        if (change === 'credential-rotation') f.rotateCredential('rotated-key')
        await f.service.refresh('fixture')
        expect(f.service.status('fixture').models).toContainEqual({
          id: 'gpt-4o',
          stale: false,
        })
      } finally {
        resume()
      }
      expect(await pending).toBeInstanceOf(Error)
      expect(f.raw().providers.fixture).toEqual(before)
      expect(f.service.status('fixture').models).toContainEqual({
        id: 'gpt-4o',
        stale: false,
      })
    },
  )

  it.each(['overrides', 'catalog'])(
    'rejects a result if its generation config changes before publication starts (%s)',
    async (change) => {
      const f = await fixture()
      await f.service.refresh('other')
      const storage = (f.service as any).store as JsonStorage
      const write = vi.spyOn(storage, 'write')
      const originalResolve = f.credentials.resolve.bind(f.credentials)
      const request = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (url, init) =>
        String(url) === 'https://catalog.invalid/new.json'
          ? new Response(
              JSON.stringify({
                version: 'new',
                models: {
                  'gpt-5.4': { reasoning_supported_efforts: ['high'] },
                },
              }),
            )
          : request(url, init),
      )
      let reads = 0
      let changed: Promise<void> | undefined
      vi.spyOn(f.credentials, 'resolve').mockImplementation(async (ref) => {
        const credential = await originalResolve(ref)
        if (++reads === 2)
          queueMicrotask(() => {
            changed = f.service.updateOptions(
              'fixture',
              1800000,
              change === 'catalog' ? 'https://catalog.invalid/new.json' : '',
              change === 'overrides'
                ? JSON.stringify({ 'gpt-5.4': { defaultServiceTier: 'fast' } })
                : '{}',
            )
          })
        return credential
      })
      f.models([{ id: 'gpt-5.4', context_window: 720000 }])
      await expect(f.service.refresh('fixture')).rejects.toThrow(
        'configuration changed',
      )
      await changed
      expect(
        write.mock.calls.filter(([key]) => key === 'route:fixture'),
      ).toHaveLength(0)
      expect(f.service.status('fixture').status.state).toBe('error')
      expect(
        f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens,
      ).toBe(800000)
      expect(
        (await storage.read<SyncSnapshot>('route:fixture'))!.capabilities[
          'gpt-5.4'
        ]!.contextWindow,
      ).toBe(800000)
      await f.service.refresh('fixture')
      expect(f.service.status('fixture').status.state).toBe('ready')
      expect(
        f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens,
      ).toBe(720000)
      if (change === 'overrides') {
        expect(
          f.service.capability('fixture', 'gpt-5.4')!.defaultServiceTier,
        ).toBe('fast')
      } else {
        expect(
          f.service
            .capability('fixture', 'gpt-5.4')!
            .reasoning.choices.map((choice) => choice.id),
        ).toEqual(['high'])
      }
    },
  )

  it('rejects cleanup before changing native models when its snapshot predates the current options', async () => {
    const f = await fixture()
    f.models([
      { id: 'gpt-5.4', context_window: 800000 },
      { id: 'gpt-4o', context_window: 128000 },
    ])
    await f.service.refresh('fixture')
    f.models([{ id: 'gpt-5.4', context_window: 800000 }])
    await f.service.refresh('fixture')
    const before = structuredClone(f.raw().providers.fixture)
    await f.service.updateOptions(
      'fixture',
      1800000,
      '',
      JSON.stringify({ 'gpt-5.4': { defaultServiceTier: 'fast' } }),
    )
    await expect(f.service.removeStale('fixture')).rejects.toThrow(
      'configuration changed',
    )
    expect(f.raw().providers.fixture).toEqual(before)
    await f.service.refresh('fixture')
    await f.service.removeStale('fixture')
    expect(f.raw().providers.fixture.models).toEqual([before.models[0]])
    expect(f.service.status('fixture').models).not.toContainEqual({
      id: 'gpt-4o',
      stale: true,
    })
  })

  it('rejects publication if route options change while its cache write is pending', async () => {
    const f = await fixture()
    const storage = (f.service as any).store as JsonStorage
    const original = storage.write.bind(storage)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(storage, 'write').mockImplementation(
      async (key, value, beforeCommit) => {
        if (key === 'route:fixture') {
          entered()
          await gate
        }
        await original(key, value, beforeCommit)
      },
    )
    f.models([{ id: 'gpt-5.4', context_window: 128000 }])
    const pending = f.service.refresh('fixture')
    const rejected = expect(pending).rejects.toThrow('configuration changed')
    await started
    await f.service.updateOptions(
      'fixture',
      1800000,
      '',
      JSON.stringify({ 'gpt-5.4': { defaultServiceTier: 'fast' } }),
    )
    release()
    await rejected
    expect(
      (await storage.read<SyncSnapshot>('route:fixture'))!.capabilities[
        'gpt-5.4'
      ]!.contextWindow,
    ).toBe(800000)
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      800000,
    )
  })

  it.each([true, false])(
    'restores only an identity-matching cache during offline startup (matching=%s)',
    async (matching) => {
      const f = await fixture('openai-responses', false, false, { matching })
      expect(f.service.status('fixture').status.state).toBe('error')
      const actual = f.service.contextWindow(
        'fixture',
        'gpt-5.4',
      ).effectiveTokens
      if (matching) {
        expect(actual).toBe(333333)
        expect(
          (await f.native().prepareCall('fixture', 'gpt-5.4')).model.context
            ?.contextWindow,
        ).toBe(333333)
        expect(
          (f.service as any).runners.get('fixture').current().capabilities[
            'gpt-5.4'
          ].contextWindow,
        ).toBe(333333)
      } else {
        expect(actual).not.toBe(333333)
        expect(
          (f.service as any).runners.get('fixture').current(),
        ).toBeUndefined()
      }
    },
  )

  it('recomputes an offline cache after local reasoning and speed overrides are removed', async () => {
    const f = await fixture('openai-responses', false, false, {
      matching: true,
      overrides: {
        'gpt-5.4': {
          reasoningChoices: [
            { id: 'high', label: 'High', wireValue: 'high', source: 'user' },
          ],
          serviceTiers: [
            {
              id: 'default',
              label: 'Standard',
              wireValue: 'default',
              source: 'user',
            },
          ],
        },
      },
    })
    const current = f.service.capability('fixture', 'gpt-5.4')!
    expect(current.reasoning.choices.map((choice) => choice.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
    expect(current.serviceTiers.map((choice) => choice.id)).toEqual([
      'default',
      'fast',
    ])
    expect(current.contextWindow).toBe(333333)
    const initial = (f.service as any).runners
      .get('fixture')
      .current() as SyncSnapshot
    expect(initial.capabilities['gpt-5.4']!.reasoning).toEqual(
      current.reasoning,
    )
    expect(initial.capabilities['gpt-5.4']!.serviceTiers).toEqual(
      current.serviceTiers,
    )
    expect(initial.source).toBe('cache')
    const cached = (await (
      (f.service as any).store as JsonStorage
    ).read<SyncSnapshot>('route:fixture'))!
    expect(initial.fetchedAt).toBe(cached.fetchedAt)
    expect(current.capabilityRevision).not.toBe(
      cached.capabilities['gpt-5.4']!.capabilityRevision,
    )
  })

  it('does not restore an old-account cache if its credential rotates during initialization', async () => {
    const f = await fixture('openai-responses', false, false, {
      matching: true,
      rotateWhileResolving: true,
    })
    expect(
      f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens,
    ).not.toBe(333333)
    expect((f.service as any).runners.get('fixture').current()).toBeUndefined()
  })

  it.each(['native-form', 'compatibility-rpc'])(
    'validates the current compaction budget after waiting for a write lock (%s)',
    async (path) => {
      const f = await fixture()
      const revision = f.service.status('fixture').contextRevision
      const resume = f.pauseWrites()
      const save =
        path === 'native-form'
          ? f.settings.write(
              'llm-pi-ai',
              (current) => {
                current.providers.fixture.models[0].contextWindow = 150000
                return current
              },
              revision,
            )
          : f.service.setContextWindow(
              'fixture',
              'gpt-5.4',
              'custom',
              150000,
              revision,
            )
      const rejected = expect(save).rejects.toThrow('上下文窗口必须大于')
      f.headroom(200000)
      resume()
      await rejected
      expect(f.model().contextWindow).toBeUndefined()
      expect(f.revisions['llm-pi-ai']).toBe(1)
    },
  )

  it.each(
    [1, 29, 100].flatMap((count) =>
      [false, true].map((inherited) => [count, inherited] as const),
    ),
  )(
    'bounds full settings reads for %i models (inherited layer: %s), including the native catalog path',
    async (count, inherited) => {
      const f = await fixture('openai-responses', false, inherited)
      const models = Array.from({ length: count }, (_, index) => ({
        id: `gpt-fixture-${index}`,
      }))
      f.raw().providers.fixture.models = models
      f.raw().providers.other.models = []
      f.ctx.emit(
        'settings/document-updated',
        'llm-pi-ai' as any,
        f.revisions['llm-pi-ai']!,
      )
      await Promise.resolve()
      f.resetReads()
      expect(Object.keys(f.service.status('fixture').capabilities)).toEqual(
        expect.arrayContaining(models.map((model) => model.id)),
      )
      expect(f.reads()).toBe(1)
      f.resetReads()
      f.settings.describe()
      expect(f.reads()).toBe(1)
      const adapter = f.native()
      f.resetReads()
      await Promise.all(
        models.map((model) => adapter.resolveModel('fixture', model.id)),
      )
      expect(f.reads()).toBe(1)
      f.resetReads()
      await Promise.all(
        models.map((model) => adapter.resolveModel('fixture', model.id)),
      )
      expect(f.reads()).toBe(0)
      await f.legacy({ [models[0]!.id]: { contextWindow: 516000 } })
      f.resetReads()
      const updated = await adapter.resolveModel('fixture', models[0]!.id)
      expect(updated.context?.contextWindow).toBe(516000)
      expect(f.reads()).toBe(1)
      f.resetReads()
      const oldRevision = f.service.status('fixture').contextRevision
      f.resetReads()
      f.service.modelStatus('fixture', models[0]!.id)
      expect(f.reads()).toBe(1)
      expect(f.service.status('fixture').contextRevision).toBe(oldRevision)
    },
  )

  it('bounds temporary speed results and prevents late observers from reviving removed or newer results', async () => {
    const f = await fixture()
    const extension = f.service.capture('fixture', 'gpt-5.4', {
      provider: 'fixture',
      id: 'gpt-5.4',
      name: 'GPT',
    })!
    const first = extension.prepare({ sessionId: 'old-session' })
    for (let index = 0; index < 512; index++)
      extension.prepare({ sessionId: `session-${index}` })
    const results = (f.service as any).results as Map<string, unknown>
    expect(results.size).toBe(512)
    first.observe({ service_tier: 'priority' })
    expect(
      results.has(JSON.stringify(['old-session', 'fixture', 'gpt-5.4'])),
    ).toBe(false)
    const old = extension.prepare({ sessionId: 'current' })
    const current = extension.prepare({ sessionId: 'current' })
    current.observe({ service_tier: 'default' })
    old.observe({ service_tier: 'priority' })
    expect(
      f.service.speed('current' as any, 'fixture', 'gpt-5.4').last?.actual,
    ).toBe('default')
    f.ctx.emit('api-session/removed', 'current' as any)
    current.observe({ service_tier: 'priority' })
    expect(
      f.service.speed('current' as any, 'fixture', 'gpt-5.4').last,
    ).toBeNull()
    await f.ctx.fiber.dispose()
    extension
      .prepare({ sessionId: 'after-close' })
      .observe({ service_tier: 'priority' })
    expect(results.size).toBe(0)
  })

  it('replaces speed snapshots only after a successful write and keeps previously captured calls stable', async () => {
    const f = await fixture()
    await f.service.setSpeed(
      'speed-session' as any,
      'fixture',
      'gpt-5.4',
      'fast',
    )
    const captured = f.service.capture('fixture', 'gpt-5.4', {
      provider: 'fixture',
      id: 'gpt-5.4',
      name: 'GPT',
    })!
    const before = (f.service as any).speeds
    vi.spyOn((f.service as any).store, 'write').mockRejectedValueOnce(
      new Error('disk full'),
    )
    await expect(
      f.service.setSpeed(
        'speed-session' as any,
        'fixture',
        'gpt-5.4',
        'default',
      ),
    ).rejects.toThrow('disk full')
    expect((f.service as any).speeds).toBe(before)
    await f.service.setSpeed(
      'speed-session' as any,
      'fixture',
      'gpt-5.4',
      'default',
    )
    expect((f.service as any).speeds).not.toBe(before)
    expect(
      captured.prepare({ sessionId: 'speed-session' }).payload.service_tier,
    ).toBe('priority')
    const next = f.service.capture('fixture', 'gpt-5.4', {
      provider: 'fixture',
      id: 'gpt-5.4',
      name: 'GPT',
    })!
    expect(
      next.prepare({ sessionId: 'speed-session' }).payload.service_tier,
    ).not.toBe('priority')
  })
  it('preserves native catalog modelOverrides through initial sync, refresh and stale cleanup', async () => {
    const f = await fixture('openai-responses', true)
    expect(f.raw().providers.openai).not.toHaveProperty('models')
    const before = structuredClone(f.raw().providers.openai)
    const adapter = f.native()
    expect(f.service.contextWindow('openai', 'gpt-5.4')).toMatchObject({
      mode: 'custom',
      effectiveTokens: 128000,
      source: 'native-user',
    })
    expect(
      (await adapter.prepareCall('openai', 'gpt-5.4')).model,
    ).toMatchObject({
      context: { contextWindow: 128000 },
      defaultMaxTokens: 4096,
    })
    expect(f.raw().providers.openai).toEqual(before)
    expect(f.service.status('openai').models).toContainEqual({
      id: 'gpt-5.4',
      stale: false,
    })
    expect((await adapter.prepareCall('openai', 'gpt-4o')).model.id).toBe(
      'gpt-4o',
    )
    f.models([{ id: 'gpt-5.4', context_window: 900000 }])
    await f.service.refresh('openai')
    expect(f.raw().providers.openai).toEqual(before)
    expect(
      (await f.native().prepareCall('openai', 'gpt-5.4')).model.context,
    ).toEqual({ contextWindow: 128000 })
    f.models([])
    await f.service.refresh('openai')
    await f.service.removeStale('openai')
    expect(f.service.status('openai').models).toEqual([])
    expect(f.raw().providers.openai).toEqual(before)
    expect(
      (await f.native().prepareCall('openai', 'gpt-5.4')).model.context,
    ).toEqual({ contextWindow: 128000 })
  })

  it('keeps discovered defaults automatic, tracks metadata and preserves last-good values', async () => {
    const f = await fixture()
    expect(f.service.contextWindow('fixture', 'gpt-5.4')).toMatchObject({
      mode: 'default',
      effectiveTokens: 800000,
      source: 'upstream',
    })
    expect(f.service.contextWindow('fixture', 'gpt-4o')).toMatchObject({
      effectiveTokens: 128000,
      source: 'official-preset',
    })
    await f.legacy({
      'gpt-5.4': { contextWindow: 700000, defaultServiceTier: 'fast' },
      'gpt-new': { contextWindow: 550000 },
    })
    f.models([
      { id: 'gpt-5.4', context_window: 900000 },
      { id: 'gpt-new', context_window: 600000 },
    ])
    await f.service.refresh('fixture')
    expect(
      JSON.parse(f.options().routes.fixture.overridesJSON)['gpt-5.4']
        .contextWindow,
    ).toBe(700000)
    expect(
      f
        .raw()
        .providers.fixture.models.every(
          (row: any) => !Object.hasOwn(row, 'contextWindow'),
        ),
    ).toBe(true)
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.fixture.models[0].name = 'Renamed'
      return current
    })
    expect(f.model().contextWindow).toBeUndefined()
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      700000,
    )
    expect(
      JSON.parse(f.options().routes.fixture.overridesJSON)['gpt-new'],
    ).toEqual({
      contextWindow: 550000,
    })
    expect(f.service.contextWindow('fixture', 'gpt-new').effectiveTokens).toBe(
      550000,
    )
    await f.service.setContextWindow('fixture', 'gpt-5.4', 'default')
    expect(f.service.contextWindow('fixture', 'gpt-5.4')).toMatchObject({
      mode: 'default',
      effectiveTokens: 900000,
    })
    f.fail()
    await expect(f.service.refresh('fixture')).rejects.toThrow('offline')
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      900000,
    )
  })

  it('preserves automatic and legacy capacities during stale model cleanup', async () => {
    const f = await fixture()
    f.models([
      { id: 'gpt-5.4', context_window: 900000 },
      { id: 'gpt-new', context_window: 600000 },
    ])
    await f.service.refresh('fixture')
    await f.legacy({
      'gpt-5.4': { contextWindow: 700000, defaultServiceTier: 'fast' },
    })
    f.models([{ id: 'gpt-5.4', context_window: 950000 }])
    await f.service.refresh('fixture')
    await f.service.removeStale('fixture')
    expect(
      f.raw().providers.fixture.models.map((model: any) => model.id),
    ).toEqual(['gpt-5.4', 'gpt-4o'])
    expect(
      f
        .raw()
        .providers.fixture.models.every(
          (model: any) => !Object.hasOwn(model, 'contextWindow'),
        ),
    ).toBe(true)
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      700000,
    )
    expect(
      JSON.parse(f.options().routes.fixture.overridesJSON)['gpt-5.4'],
    ).toEqual({
      contextWindow: 700000,
      defaultServiceTier: 'fast',
    })
  })

  it('saves explicit presets, resets both stores and isolates identical IDs across providers', async () => {
    const f = await fixture()
    await f.legacy({
      'gpt-5.4': { contextWindow: 600000, defaultServiceTier: 'fast' },
      'gpt-other': { contextWindow: 333333 },
    })
    const previousOther = structuredClone(f.raw().providers.other)
    await f.service.setContextWindow('fixture', 'gpt-5.4', '516k')
    expect(f.model()).toMatchObject({ contextWindow: 516000, maxTokens: 2048 })
    expect(JSON.parse(f.options().routes.fixture.overridesJSON)).toEqual({
      'gpt-5.4': { defaultServiceTier: 'fast' },
      'gpt-other': { contextWindow: 333333 },
    })
    expect(f.raw().providers.other).toEqual(previousOther)
    await f.service.setContextWindow('fixture', 'gpt-5.4', 'custom', 750000)
    expect(f.service.status('fixture').contextWindows['gpt-5.4']).toMatchObject(
      { mode: 'custom', effectiveTokens: 750000, source: 'native-user' },
    )
    await f.service.setContextWindow('fixture', 'gpt-5.4', 'default')
    expect(Object.hasOwn(f.model(), 'contextWindow')).toBe(false)
    f.models([{ id: 'gpt-5.4', context_window: 1000000 }])
    await f.service.refresh('fixture')
    expect(f.service.contextWindow('fixture', 'gpt-5.4').mode).toBe('default')
    await f.service.setContextWindow('fixture', 'gpt-5.4', '1m')
    expect(f.model().contextWindow).toBe(1000000)
    expect(f.service.contextWindow('fixture', 'gpt-5.4').mode).toBe('1m')
    await f.service.setContextWindow('other', 'gpt-5.4', '516k')
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      1000000,
    )
    expect(f.service.contextWindow('other', 'gpt-5.4').effectiveTokens).toBe(
      516000,
    )
    f.raw().providers.fixture.defaultContextWindow = 850000
    await f.service.setContextWindow('fixture', 'gpt-5.4', 'default')
    expect(f.service.contextWindow('fixture', 'gpt-5.4')).toMatchObject({
      mode: 'default',
      effectiveTokens: 850000,
      source: 'provider-default',
    })
  })

  it('rejects invalid/stale edits and compensates a failed legacy cleanup', async () => {
    const f = await fixture()
    const before = structuredClone(f.raw())
    await expect(
      f.service.setContextWindow('fixture', 'gpt-5.4', '1m', undefined, 0),
    ).rejects.toThrow('revision conflict')
    for (const tokens of [0, 1.5, 67584, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        f.service.setContextWindow('fixture', 'gpt-5.4', 'custom', tokens),
      ).rejects.toThrow()
    expect(f.raw()).toEqual(before)
    await f.legacy({
      'gpt-5.4': { contextWindow: 600000, defaultServiceTier: 'fast' },
    })
    f.failCleanup()
    await expect(
      f.service.setContextWindow('fixture', 'gpt-5.4', '516k'),
    ).rejects.toThrow('legacy cleanup failed')
    expect(f.raw()).toEqual(before)
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      600000,
    )
  })

  it('normalizes an intentional native context edit without freezing unrelated projected fields', async () => {
    const f = await fixture()
    await f.legacy({
      'gpt-5.4': { contextWindow: 600000, defaultServiceTier: 'fast' },
    })
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.fixture.models[0].contextWindow = 516000
      current.providers.fixture.models[0].name = 'Renamed'
      return current
    })
    expect(f.model()).toMatchObject({
      contextWindow: 516000,
      name: 'Renamed',
      maxTokens: 2048,
    })
    expect(
      JSON.parse(f.options().routes.fixture.overridesJSON)['gpt-5.4'],
    ).toEqual({ defaultServiceTier: 'fast' })
    expect(f.raw().providers.fixture.models[1].contextWindow).toBeUndefined()
  })

  it('pins a native manual value equal to the automatic capacity', async () => {
    const f = await fixture()
    const view = f.settings.describe().find((row) => row.ns === 'llm-pi-ai')!
    expect(view.value.providers.fixture.models[0].contextWindow).toBe(800000)
    expect(view.user!.providers.fixture.models[0].contextWindow).toBeUndefined()
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.fixture.models[0].contextWindow = 800000
      return current
    })
    expect(f.model().contextWindow).toBe(800000)
    f.models([{ id: 'gpt-5.4', context_window: 900000 }])
    await f.service.refresh('fixture')
    expect(f.service.contextWindow('fixture', 'gpt-5.4')).toMatchObject({
      effectiveTokens: 800000,
      defaultTokens: 900000,
      source: 'native-user',
    })
  })

  it('checks output-only and provider-default edits without blocking unrelated edits', async () => {
    const f = await fixture()
    await f.service.setContextWindow('fixture', 'gpt-5.4', '516k')
    const before = structuredClone(f.raw())
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.models[0].maxTokens = 1000000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    expect(f.raw()).toEqual(before)
    await f.settings.write('llm-pi-ai', (current) => {
      delete current.providers.fixture.models[0].maxTokens
      return current
    })
    const withDefaultOutput = structuredClone(f.raw())
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.defaultMaxTokens = 500000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.defaultContextWindow = 60000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    expect(f.raw()).toEqual(withDefaultOutput)
    // Existing invalid budgets do not block unrelated model-name edits.
    f.model().maxTokens = 1000000
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.fixture.models[0].name = 'Renamed'
      return current
    })
    expect(f.model().name).toBe('Renamed')
  })

  it('uses the native schema and catalog output defaults for context validation', async () => {
    const f = await fixture('openai-responses', true)
    await f.settings.write('llm-pi-ai', (current) => {
      delete current.providers.fixture.models[0].maxTokens
      return current
    })
    const sdkDefault = (f.native() as any)
      .current()
      .models.getModel('fixture', 'gpt-5.4')
    expect(sdkDefault.maxTokens).toBe(128000)
    const before = structuredClone(f.raw())
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.models[0].contextWindow = 100000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    await expect(
      f.service.setContextWindow('fixture', 'gpt-5.4', 'custom', 100000),
    ).rejects.toThrow('上下文窗口必须大于')
    expect(f.raw()).toEqual(before)
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.fixture.defaultMaxTokens = 16000
      current.providers.fixture.models[0].contextWindow = 100000
      return current
    })
    expect(
      (f.native() as any).current().models.getModel('fixture', 'gpt-5.4')
        .maxTokens,
    ).toBe(16000)
    f.raw().providers.openai.defaultMaxTokens = 500000
    const catalog = (f.native() as any)
      .current()
      .models.getModel('openai', 'gpt-4o')
    expect(catalog.maxTokens).toBe(16384)
    expect(() =>
      f.service.validateContextWindow(
        'openai',
        { id: 'gpt-4o', contextWindow: 100000 },
        f.raw().providers.openai,
      ),
    ).not.toThrow()
    expect(() =>
      f.service.validateContextWindow(
        'openai',
        { id: 'gpt-4o', contextWindow: 80000 },
        f.raw().providers.openai,
      ),
    ).toThrow('上下文窗口必须大于')
  })

  it('resets a native field to automatic resolution and removes only its legacy context', async () => {
    const f = await fixture()
    await f.service.setContextWindow('fixture', 'gpt-5.4', '516k')
    await f.legacy({
      'gpt-5.4': { contextWindow: 600000, defaultServiceTier: 'fast' },
      'gpt-other': { contextWindow: 333333 },
    })
    const view = f.settings.describe().find((row) => row.ns === 'llm-pi-ai')!
    expect(view.user!.providers.fixture.models[0].contextWindow).toBe(600000)
    await f.settings.write('llm-pi-ai', (current) => {
      delete current.providers.fixture.models[0].contextWindow
      return current
    })
    expect(f.model()).toEqual({ id: 'gpt-5.4', maxTokens: 2048 })
    expect(f.service.contextWindow('fixture', 'gpt-5.4')).toMatchObject({
      mode: 'default',
      effectiveTokens: 800000,
      source: 'upstream',
    })
    expect(JSON.parse(f.options().routes.fixture.overridesJSON)).toEqual({
      'gpt-5.4': { defaultServiceTier: 'fast' },
      'gpt-other': { contextWindow: 333333 },
    })
  })

  it('validates native context saves against the draft output budget and rolls back failed cleanup', async () => {
    const f = await fixture()
    const before = structuredClone(f.raw())
    for (const tokens of [0, 1.5, 67584, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        f.settings.write('llm-pi-ai', (current) => {
          current.providers.fixture.models[0].contextWindow = tokens
          return current
        }),
      ).rejects.toThrow()
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.models[0].contextWindow = 516000
        current.providers.fixture.models[0].maxTokens = 500000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.defaultMaxTokens = 500000
        delete current.providers.fixture.models[0].maxTokens
        current.providers.fixture.models[0].contextWindow = 516000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    expect(f.raw()).toEqual(before)
    await f.legacy({ 'gpt-5.4': { contextWindow: 600000 } })
    f.failCleanup()
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.models[0].contextWindow = 516000
        return current
      }),
    ).rejects.toThrow('legacy cleanup failed')
    expect(f.raw()).toEqual(before)
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      600000,
    )
  })

  it('validates a native reset against the provider default being saved', async () => {
    const f = await fixture()
    await f.service.setContextWindow('fixture', 'gpt-5.4', '516k')
    const before = structuredClone(f.raw())
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        delete current.providers.fixture.models[0].contextWindow
        current.providers.fixture.defaultContextWindow = 60000
        return current
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    expect(f.raw()).toEqual(before)
    await f.settings.write('llm-pi-ai', (current) => {
      delete current.providers.fixture.models[0].contextWindow
      current.providers.fixture.defaultContextWindow = 850000
      return current
    })
    expect(f.service.contextWindow('fixture', 'gpt-5.4')).toMatchObject({
      mode: 'default',
      effectiveTokens: 850000,
      source: 'provider-default',
    })
  })

  it.each(['openai-responses', 'openai-completions'])(
    'captures one capacity for info, SDK and actual native overflow detection (%s)',
    async (protocol) => {
      const f = await fixture(protocol)
      const adapter = f.native()
      await f.service.setContextWindow('fixture', 'gpt-5.4', '516k')
      expect(await adapter.resolveModel('fixture', 'gpt-5.4')).toMatchObject({
        context: { contextWindow: 516000 },
        defaultMaxTokens: 2048,
      })
      const call = await adapter.prepareCall('fixture', 'gpt-5.4')
      expect(call.model.context).toEqual({ contextWindow: 516000 })
      const snapshot = (adapter as any).current()
      const sdk = vi.spyOn(snapshot.models, 'stream')
      const nativeCapacity = snapshot.models.getModel(
        'fixture',
        'gpt-5.4',
      ).contextWindow
      await f.service.setContextWindow('fixture', 'gpt-5.4', '1m')
      const options: any = {
        provider: 'fixture',
        model: 'gpt-5.4',
        maxTokens: 1234,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      }
      const oldChunks = []
      for await (const chunk of call.stream(options)) oldChunks.push(chunk)
      expect(sdk.mock.calls.at(-1)![0]).toMatchObject({ contextWindow: 516000 })
      expect(oldChunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
      })
      const next = await adapter.prepareCall('fixture', 'gpt-5.4')
      expect(next.model.context).toEqual({ contextWindow: 1000000 })
      const newChunks = []
      for await (const chunk of next.stream(options)) newChunks.push(chunk)
      expect(sdk.mock.calls.at(-1)![0]).toMatchObject({
        contextWindow: 1000000,
      })
      expect(newChunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'stop' },
      })
      expect(snapshot.models.getModel('fixture', 'gpt-5.4').contextWindow).toBe(
        nativeCapacity,
      )
      for (const request of f.requests) {
        expect(request).not.toHaveProperty('contextWindow')
        expect(request).not.toHaveProperty('context_window')
        expect(
          request[
            protocol === 'openai-responses'
              ? 'max_output_tokens'
              : 'max_completion_tokens'
          ],
        ).toBe(1234)
      }
      await f.service.configure('fixture', false)
      expect(
        (await adapter.prepareCall('fixture', 'gpt-5.4')).model.context,
      ).toEqual({ contextWindow: nativeCapacity })
      await f.ctx.fiber.dispose()
      expect(
        (await adapter.prepareCall('fixture', 'gpt-5.4')).model.context,
      ).toEqual({ contextWindow: nativeCapacity })
    },
  )
})
