import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as native from '@deepseek-ai/dsh-llm-pi-ai'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, GptModels } from '../src/host.js'
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
  savedSpeeds?: Record<string, string>,
  sharedHome?: string,
) {
  const directory =
    sharedHome ?? (await mkdtemp(join(tmpdir(), 'dsh-context-test-')))
  if (!sharedHome)
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
        const updated = Config(options)
        liveOptions.routes = updated.routes
        liveOptions.manualUltrafast = updated.manualUltrafast
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
  if (savedSpeeds)
    await new JsonStorage(join(directory, 'storages/gpt-adapter')).write(
      'speeds',
      savedSpeeds,
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
  it('orders session deletion after an in-flight startup speed read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-speed-startup-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    vi.stubEnv('DSH_HOME', directory)
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    ctx.provide('settings', { describe: () => [] } as any)
    const service = new GptModels(ctx, { routes: {} }, 'gpt-adapter')
    const store = (service as any).store
    const saved = {
      [JSON.stringify(['removed', 'fixture', 'gpt-5.4'])]: 'fast',
    }
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const started = new Promise<void>((done) => {
      entered = done
    })
    await store.write('speeds', saved)
    vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      entered()
      await gate
      return structuredClone(saved)
    })
    const initializing = service.initialize()
    await started
    ctx.emit('api-session/removed', 'removed' as any)
    release()
    await initializing
    await (service as any).speedWrites
    expect((service as any).speeds.size).toBe(0)
    expect(await store.read('speeds')).toEqual({})
  })

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

  it('lets the native settings editor add and clear a Sol reasoning mapping', async () => {
    const f = await fixture()
    const id = 'gpt-6.2-sol'
    f.models([{ id: 'gpt-5.4' }, { id }])
    await f.service.refresh('fixture')
    const rows = (value: any) => value.providers.fixture.models
    const findModel = (models: any[]) => models.find((model) => model.id === id)
    const before = f.settings.describe()[0]!
    const mapping = { high: 'native-high' }
    const path = ['providers', 'fixture', 'models']
    expect(findModel(rows(f.raw()))).not.toHaveProperty('reasoningEfforts')
    expect(findModel(rows(before.user))).not.toHaveProperty('reasoningEfforts')
    expect(findModel(rows(before.value)).reasoningEfforts).toHaveProperty(
      'xhigh',
      'xhigh',
    )
    const models = structuredClone(rows(before.user))
    findModel(models).reasoningEfforts = mapping
    await f.settings.mutate(
      'llm-pi-ai',
      [{ op: 'set', path, value: models }],
      before.revision,
    )
    expect(findModel(rows(f.raw())).reasoningEfforts).toEqual(mapping)
    expect(
      findModel(rows(f.settings.describe()[0]!.value)).reasoningEfforts,
    ).toEqual(mapping)
    const nativeCall = await f.native().prepareCall('fixture', id)
    expect(
      nativeCall.model.reasoning?.efforts.map((effort) => effort.id),
    ).toContain('high')
    expect(
      nativeCall.model.reasoning?.efforts.map((effort) => effort.id),
    ).not.toContain('xhigh')

    const edited = rows(f.settings.describe()[0]!.user)
    delete findModel(edited).reasoningEfforts
    await f.settings.mutate('llm-pi-ai', [{ op: 'set', path, value: edited }])
    expect(findModel(rows(f.raw()))).not.toHaveProperty('reasoningEfforts')
    expect(
      findModel(rows(f.settings.describe()[0]!.value)).reasoningEfforts,
    ).toHaveProperty('xhigh', 'xhigh')
  })

  it.each(['gpt-6.2-sol', 'gpt-6.2-astra'])(
    'rejects a stale %s model draft when an identical reasoning fallback takes over',
    async (id) => {
      const f = await fixture()
      f.models([{ id: 'gpt-5.4' }, { id }])
      await f.service.refresh('fixture')
      const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      await f.legacy({
        [id]: {
          reasoningChoices: levels.map((level) => ({
            id: level,
            label: level,
            wireValue: level,
          })),
        },
      })
      const models = (value: any) => value.providers.fixture.models
      const findModel = (list: any[]) => list.find((model) => model.id === id)
      const path = ['providers', 'fixture', 'models']
      const before = f.settings.describe()[0]!
      const staleDraft = structuredClone(models(before.user))
      expect(findModel(staleDraft).reasoningEfforts).toHaveProperty('xhigh')
      findModel(staleDraft).name = 'Renamed'

      await f.legacy({})
      const after = f.settings.describe()[0]!
      expect(after.value).toEqual(before.value)
      expect(findModel(models(after.user))).not.toHaveProperty(
        'reasoningEfforts',
      )
      await expect(
        f.settings.mutate(
          'llm-pi-ai',
          [{ op: 'set', path, value: staleDraft }],
          before.revision,
        ),
      ).rejects.toThrow('revision conflict')
      expect(findModel(models(f.raw()))).not.toHaveProperty('reasoningEfforts')
      expect(f.service.status('fixture').contextRevision).toBe(after.revision)

      const freshDraft = structuredClone(models(after.user))
      findModel(freshDraft).name = 'Renamed'
      await f.settings.mutate(
        'llm-pi-ai',
        [{ op: 'set', path, value: freshDraft }],
        after.revision,
      )
      expect(findModel(models(f.raw())).name).toBe('Renamed')
      expect(findModel(models(f.raw()))).not.toHaveProperty('reasoningEfforts')
    },
  )

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
      const previousConfigKey = (await storage.read<SyncSnapshot>(
        'route:fixture',
      ))!.configKey
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
        /configuration changed|synchronizer stopped/,
      )
      await changed
      await f.service.refresh('fixture')
      expect(
        write.mock.calls
          .filter(([key]) => key === 'route:fixture')
          .some(
            ([, value]) =>
              (value as SyncSnapshot).configKey === previousConfigKey,
          ),
      ).toBe(false)
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

  it('revokes a pending publication and automatically publishes the changed options', async () => {
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
    const committed: SyncSnapshot[] = []
    vi.spyOn(storage, 'write').mockImplementation(
      async (key, value, beforeCommit) => {
        if (key === 'route:fixture') {
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
    const pending = f.service.refresh('fixture')
    const rejected = expect(pending).rejects.toThrow(
      /configuration changed|synchronizer stopped/,
    )
    await started
    await f.service.updateOptions(
      'fixture',
      1800000,
      '',
      JSON.stringify({ 'gpt-5.4': { defaultServiceTier: 'fast' } }),
    )
    release()
    await rejected
    await f.service.refresh('fixture')
    expect(committed).toHaveLength(1)
    expect(committed[0]!.capabilities['gpt-5.4']!.defaultServiceTier).toBe(
      'fast',
    )
    expect(
      (await storage.read<SyncSnapshot>('route:fixture'))!.capabilities[
        'gpt-5.4'
      ]!.contextWindow,
    ).toBe(128000)
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      128000,
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
    expect(current.reasoning).toMatchObject({
      status: 'known',
      fallback: true,
      defaultId: 'medium',
    })
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

  it('removes local capability overrides immediately while offline and preserves captured requests', async () => {
    const f = await fixture()
    await f.legacy({
      'gpt-5.4': {
        displayName: 'Old override',
        reasoningChoices: [
          { id: 'ultra', label: 'Ultra', wireValue: 'ultra', source: 'user' },
        ],
        defaultReasoningId: 'ultra',
        defaultServiceTier: 'fast',
      },
    })
    await f.service.refresh('fixture')
    const base = { provider: 'fixture', id: 'gpt-5.4', name: 'GPT' }
    const captured = f.service.capture('fixture', 'gpt-5.4', base)!
    f.fail()
    await f.legacy({})
    expect(f.service.capability('fixture', 'gpt-5.4')).toMatchObject({
      displayName: 'gpt-5.4',
      reasoning: { status: 'known', defaultId: 'medium', fallback: true },
      defaultServiceTier: 'default',
    })
    expect(
      f.service.capture('fixture', 'gpt-5.4', base)!.prepare({}).payload,
    ).toEqual({
      model: 'gpt-5.4',
      service_tier: 'default',
      reasoning: { effort: 'medium' },
    })
    expect(captured.prepare({}).payload).toMatchObject({
      reasoning: { effort: 'ultra' },
      service_tier: 'priority',
    })
  })

  it('reports the effective speed default before a model refresh', async () => {
    const f = await fixture()
    await f.legacy({ 'gpt-5.4': { defaultServiceTier: 'fast' } })
    expect(
      f.service.speed('speed-session' as any, 'fixture', 'gpt-5.4').selected,
    ).toBe('fast')
    expect(
      f.service
        .capture('fixture', 'gpt-5.4', {
          provider: 'fixture',
          id: 'gpt-5.4',
          name: 'GPT',
        })!
        .prepare({ sessionId: 'speed-session' }).payload.service_tier,
    ).toBe('priority')
  })

  it('keeps manual Ultrafast independent of model and metadata while preserving advertised selections', async () => {
    const f = await fixture()
    const modelId = 'gpt-6.2-astra'
    const otherManual = 'gateway-model-v2'
    const advertised = 'gpt-6.1-sol'
    const session = 'ultrafast-session' as Parameters<GptModels['setSpeed']>[0]
    const model = { id: modelId }
    const status = () => f.service.status('fixture')
    const tiers = (id = modelId) =>
      f.service.modelStatus('fixture', id).serviceTiers.map((tier) => tier.id)
    const speed = () => f.service.speed(session, 'fixture', modelId).selected
    const requestedTier = (id = modelId) =>
      f.service
        .capture('fixture', id, { provider: 'fixture', id, name: id })!
        .prepare({ sessionId: session }).payload.service_tier
    const toggle = (enabled: boolean) =>
      f.service.setUltrafastFallback(
        'fixture',
        enabled,
        status().optionsRevision,
      )
    const selectUltrafast = () =>
      f.service.setSpeed(session, 'fixture', modelId, 'manual-ultrafast')
    const advertisedModel = { id: advertised, supports_ultrafast: true }
    await f.settings.mutate('llm-pi-ai', [
      {
        op: 'set',
        path: ['providers', 'fixture', 'models'],
        value: [model, { id: otherManual }, advertisedModel],
      },
    ])
    f.models([model, { id: otherManual }, advertisedModel])
    await f.service.refresh('fixture')
    expect(status().canConfigureUltrafastFallback).toBe(true)
    expect(tiers()).toEqual(['default', 'fast'])
    await expect(selectUltrafast()).rejects.toThrow('This speed is unavailable')

    await toggle(true)
    expect(f.options().manualUltrafast.fixture).toBe(true)
    expect(status().options.allowUnadvertisedUltrafast).toBe(true)
    expect(f.options().routes.fixture).not.toHaveProperty(
      'allowUnadvertisedUltrafast',
    )
    expect(tiers()).toEqual(['default', 'fast', 'manual-ultrafast'])
    expect(tiers(otherManual)).toEqual(['default', 'manual-ultrafast'])
    expect(requestedTier(otherManual)).toBeUndefined()
    await f.service.setSpeed(
      session,
      'fixture',
      otherManual,
      'manual-ultrafast',
    )
    expect(requestedTier(otherManual)).toBe('ultrafast')
    await f.service.setSpeed(session, 'fixture', advertised, 'ultrafast')
    expect(requestedTier(advertised)).toBe('ultrafast')
    expect(speed()).toBe('default')
    await selectUltrafast()
    expect(speed()).toBe('manual-ultrafast')
    expect(requestedTier()).toBe('ultrafast')
    const fastSession = 'fast-session' as typeof session
    await f.service.setSpeed(fastSession, 'fixture', modelId, 'fast')

    const disable = toggle(false)
    const racedSelection = expect(selectUltrafast()).rejects.toThrow(
      'This speed is unavailable',
    )
    await Promise.all([disable, racedSelection])
    expect(tiers()).not.toContain('manual-ultrafast')
    expect(tiers(otherManual)).toEqual([])
    expect(requestedTier(advertised)).toBe('ultrafast')
    expect(speed()).toBe('default')
    await toggle(true)
    expect(tiers()).toContain('manual-ultrafast')
    expect(requestedTier(otherManual)).toBeUndefined()
    expect(requestedTier(advertised)).toBe('ultrafast')
    expect(speed()).toBe('default')
    expect(requestedTier()).toBe('default')
    expect(f.service.speed(fastSession, 'fixture', modelId).selected).toBe(
      'fast',
    )

    f.models([
      {
        ...model,
        service_tiers: ['default', 'priority', 'ultrafast'],
        supports_ultrafast: false,
      },
      advertisedModel,
    ])
    await f.service.refresh('fixture')
    expect(status().canConfigureUltrafastFallback).toBe(true)
    expect(tiers()).toContain('manual-ultrafast')
    expect(requestedTier()).toBe('default')
    await selectUltrafast()
    expect(requestedTier()).toBe('ultrafast')

    await toggle(false)
    expect(tiers()).not.toContain('manual-ultrafast')
    await expect(selectUltrafast()).rejects.toThrow('This speed is unavailable')
    expect(requestedTier()).toBe('default')

    await f.service.updateOptions(
      'fixture',
      1800000,
      '',
      JSON.stringify({
        [modelId]: {
          serviceTiers: [{ id: 'fast', label: 'Fast', wireValue: 'ultrafast' }],
          defaultServiceTier: 'fast',
        },
      }),
      status().optionsRevision,
    )
    expect(tiers()).toEqual(['default'])
    await expect(
      f.service.setSpeed(session, 'fixture', modelId, 'fast'),
    ).rejects.toThrow('This speed is unavailable')
    expect(requestedTier()).toBe('default')
  })

  it('keeps existing default and saved wire mappings until Ultrafast is explicitly selected', async () => {
    const f = await fixture()
    const provider = 'fixture'
    const id = 'gpt-5.4'
    const base = { provider, id, name: id }
    const session = 'legacy-tier' as Parameters<GptModels['setSpeed']>[0]
    const status = () => f.service.status(provider)
    const toggle = (enabled: boolean) =>
      f.service.setUltrafastFallback(
        provider,
        enabled,
        status().optionsRevision,
      )
    const tier = (sessionId?: string) =>
      f.service
        .capture(provider, id, base)!
        .prepare(sessionId ? { sessionId } : {}).payload.service_tier
    await f.service.updateOptions(
      provider,
      1800000,
      '',
      JSON.stringify({
        [id]: {
          defaultServiceTier: 'ultrafast',
          serviceTiers: [
            {
              id: 'ultrafast',
              label: 'Legacy priority',
              wireValue: 'priority',
            },
          ],
        },
      }),
      status().optionsRevision,
    )
    expect(tier()).toBe('priority')
    await f.service.setSpeed(session, provider, id, 'ultrafast')
    expect(tier(session)).toBe('priority')

    await toggle(true)
    expect(tier()).toBe('priority')
    expect(tier(session)).toBe('priority')
    expect(f.service.modelStatus(provider, id).serviceTiers).toEqual([
      expect.objectContaining({
        id: 'ultrafast',
        label: 'Legacy priority',
        wireValue: 'priority',
      }),
      expect.objectContaining({
        id: 'manual-ultrafast',
        label: 'Ultrafast',
        wireValue: 'ultrafast',
      }),
    ])
    const manual = 'explicit-manual' as typeof session
    await f.service.setSpeed(manual, provider, id, 'manual-ultrafast')
    expect(tier(manual)).toBe('ultrafast')
    await f.service.updateOptions(
      provider,
      1800000,
      '',
      '{}',
      status().optionsRevision,
    )
    expect(tier(session)).toBe('default')
    expect(tier(manual)).toBe('ultrafast')
    expect(f.service.speed(session, provider, id).selected).toBe('default')
    await toggle(false)
    expect(tier(manual)).toBe('default')
    await toggle(true)
    expect(tier(manual)).toBe('default')
  })

  it('restores stored manual selections without treating legacy automatic ones as manual', async () => {
    const provider = 'fixture'
    const id = 'gpt-5.4'
    const manual = 'saved-manual' as Parameters<GptModels['speed']>[0]
    const legacy = 'saved-automatic' as typeof manual
    const key = (session: string) => JSON.stringify([session, provider, id])
    const f = await fixture(undefined, false, false, undefined, {
      [key(manual)]: 'manual-ultrafast',
      [key(legacy)]: 'ultrafast',
    })
    const tier = (sessionId: string) =>
      f.service
        .capture(provider, id, { provider, id, name: id })!
        .prepare({ sessionId }).payload.service_tier
    expect(tier(manual)).toBe('default')
    await f.settings.mutate('gpt-adapter', [
      { op: 'set', path: ['manualUltrafast', provider], value: true },
    ])
    expect(f.service.speed(manual, provider, id).selected).toBe(
      'manual-ultrafast',
    )
    expect(tier(manual)).toBe('ultrafast')
    expect(f.service.speed(legacy, provider, id).selected).toBe('default')
    expect(tier(legacy)).toBe('default')
  })

  it('does not turn inferred GPT adaptation into an explicit route when toggling Ultrafast', async () => {
    const f = await fixture()
    const provider = 'other'
    const status = () => f.service.status(provider)
    const models = (id: string) =>
      f.settings.mutate('llm-pi-ai', [
        {
          op: 'set',
          path: ['providers', provider, 'models'],
          value: [{ id }],
        },
      ])
    const toggle = (enabled: boolean) =>
      f.service.setUltrafastFallback(
        provider,
        enabled,
        status().optionsRevision,
      )

    await models('gateway-model-v2')
    expect(status().enabled).toBe(false)
    await toggle(true)
    expect(status().options.allowUnadvertisedUltrafast).toBe(true)
    expect(status().enabled).toBe(false)
    expect(f.options().routes).not.toHaveProperty(provider)

    await models('gpt-5.4')
    expect(status().enabled).toBe(true)
    await toggle(false)
    expect(status().options.allowUnadvertisedUltrafast).toBe(false)
    expect(status().enabled).toBe(true)
    expect(f.options().routes).not.toHaveProperty(provider)
    await models('gateway-model-v2')
    expect(status().enabled).toBe(false)
  })

  it('does not revive manual tier results after the provider switch is re-enabled', async () => {
    const f = await fixture()
    const provider = 'other'
    const id = 'gateway-model-v2'
    const sessionId = 'manual-results' as Parameters<GptModels['speed']>[0]
    const model = { provider, id, name: id }
    const toggle = (enabled: boolean) =>
      f.service.setUltrafastFallback(
        provider,
        enabled,
        f.service.status(provider).optionsRevision,
      )
    await f.settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', provider, 'models'], value: [{ id }] },
    ])
    await toggle(true)
    await f.service.setSpeed(sessionId, provider, id, 'manual-ultrafast')
    const manual = f.service
      .capture(provider, id, model)!
      .prepare({ sessionId })
    const delayed = f.service.capture(provider, id, model)!
    manual.observe({ service_tier: 'ultrafast' })
    expect(f.service.speed(sessionId, provider, id).last).toEqual({
      requested: 'ultrafast',
      actual: 'ultrafast',
    })

    const auto = f.service
      .capture('fixture', 'gpt-5.4', {
        provider: 'fixture',
        id: 'gpt-5.4',
        name: 'GPT',
      })!
      .prepare({ sessionId })
    auto.observe({ service_tier: 'default' })

    await toggle(false)
    expect(f.service.capture(provider, id, model)).toBeUndefined()
    manual.observe({ service_tier: 'ultrafast' })
    await toggle(true)
    expect(f.service.speed(sessionId, provider, id)).toEqual({
      selected: 'default',
      last: null,
    })
    const delayedRequest = delayed.prepare({ sessionId })
    expect(delayedRequest.payload).not.toHaveProperty('service_tier')
    delayedRequest.observe({ service_tier: 'ultrafast' })
    expect(f.service.speed(sessionId, provider, id).last).toBeNull()
    expect(f.service.speed(sessionId, 'fixture', 'gpt-5.4').last).toEqual({
      requested: 'default',
      actual: 'default',
    })
  })

  it('reads a legacy route switch until separately overridden', async () => {
    const f = await fixture()
    await f.settings.mutate('gpt-adapter', [
      {
        op: 'set',
        path: ['routes', 'fixture', 'allowUnadvertisedUltrafast'],
        value: true,
      },
    ])
    const status = () => f.service.status('fixture')
    expect(status().options.allowUnadvertisedUltrafast).toBe(true)
    await f.service.setUltrafastFallback(
      'fixture',
      false,
      status().optionsRevision,
    )
    expect(f.options().routes.fixture.allowUnadvertisedUltrafast).toBe(true)
    expect(status().options.allowUnadvertisedUltrafast).toBe(false)
    expect(status().enabled).toBe(true)
  })

  it('offers manual Ultrafast when the only positive advertisement is stale', async () => {
    const f = await fixture()
    const id = 'gpt-6.2-sol'
    const status = () => f.service.status('fixture')
    const tiers = () =>
      f.service.modelStatus('fixture', id).serviceTiers.map((tier) => tier.id)
    f.models([{ id, service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] }])
    await f.service.refresh('fixture')
    expect(status().canConfigureUltrafastFallback).toBe(true)
    expect(tiers()).toContain('ultrafast')

    f.models([{ id: 'gpt-5.4' }])
    await f.service.refresh('fixture')
    expect(tiers()).not.toContain('ultrafast')
    expect(status().canConfigureUltrafastFallback).toBe(true)
    await f.service.setUltrafastFallback(
      'fixture',
      true,
      status().optionsRevision,
    )
    expect(tiers()).toContain('manual-ultrafast')
  })

  it('allows manual Ultrafast when the omitted API inherits Responses from the catalog', async () => {
    const f = await fixture()
    const provider = 'openai'
    const id = 'gateway-model-v2'
    const sessionId = 'implicit-responses' as Parameters<
      GptModels['setSpeed']
    >[0]
    await f.settings.mutate('llm-pi-ai', [
      {
        op: 'set',
        path: ['providers', provider],
        value: {
          baseURL: 'https://fixture.invalid/v1',
          apiKeyEnv: 'TEST_KEY',
          models: [{ id }],
        },
      },
    ])
    const status = f.service.status(provider)
    expect(status.canConfigureUltrafastFallback).toBe(true)
    await f.service.setUltrafastFallback(provider, true, status.optionsRevision)
    await f.service.setSpeed(sessionId, provider, id, 'manual-ultrafast')
    const capture = f.service.capture(provider, id, { provider, id, name: id })
    expect(capture!.prepare({ sessionId }).payload).toEqual({
      service_tier: 'ultrafast',
    })
  })

  it('does not offer the Ultrafast fallback for Chat Completions', async () => {
    const f = await fixture('openai-completions')
    const id = 'gpt-6.2-sol'
    f.models([{ id }])
    await f.service.refresh('fixture')
    expect(f.service.status('fixture').canConfigureUltrafastFallback).toBe(
      false,
    )
    await expect(
      f.service.setUltrafastFallback('fixture', true),
    ).rejects.toThrow('Ultrafast fallback is unavailable')
  })

  it('falls back from a removed saved speed without changing captured requests', async () => {
    const f = await fixture()
    await f.service.setSpeed(
      'speed-session' as any,
      'fixture',
      'gpt-5.4',
      'fast',
    )
    const base = { provider: 'fixture', id: 'gpt-5.4', name: 'GPT' }
    const captured = f.service.capture('fixture', 'gpt-5.4', base)!
    f.models([{ id: 'gpt-5.4', service_tiers: ['default'] }])
    await f.service.refresh('fixture')
    expect(
      f.service.speed('speed-session' as any, 'fixture', 'gpt-5.4').selected,
    ).toBe('default')
    expect(
      f.service
        .capture('fixture', 'gpt-5.4', base)!
        .prepare({ sessionId: 'speed-session' }).payload.service_tier,
    ).toBe('default')
    expect(
      captured.prepare({ sessionId: 'speed-session' }).payload.service_tier,
    ).toBe('priority')
  })

  it('reloads both session speeds after independent instances write in the same home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-speed-shared-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const legacy = new JsonStorage(join(home, 'storages', 'gpt-adapter'))
    await legacy.write('speeds', {
      [JSON.stringify(['legacy', 'fixture', 'gpt-5.4'])]: 'fast',
      [JSON.stringify(['deleted', 'fixture', 'gpt-5.4'])]: 'fast',
    })
    const open = () =>
      fixture(undefined, false, false, undefined, undefined, home)
    const first = await open()
    const second = await open()
    await Promise.all([
      first.service.setSpeed('one' as any, 'fixture', 'gpt-5.4', 'fast'),
      second.service.setSpeed('two' as any, 'fixture', 'gpt-5.4', 'fast'),
    ])
    first.ctx.emit('api-session/removed', 'deleted' as any)
    await (first.service as any).speedWrites
    const reloaded = await open()
    const selected = (id: string) =>
      reloaded.service.speed(id as any, 'fixture', 'gpt-5.4').selected
    expect(['one', 'two', 'legacy', 'deleted'].map(selected)).toEqual([
      'fast',
      'fast',
      'fast',
      'default',
    ])
  })

  it('migrates per-session speeds once and accepts changes made during a rollback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-speed-rollback-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const root = join(home, 'storages', 'gpt-adapter')
    const legacy = new JsonStorage(root)
    const previous = new JsonStorage(join(root, 'session-speeds'))
    const key = JSON.stringify(['keep', 'fixture', 'gpt-5.4'])
    const deleted = JSON.stringify(['deleted', 'fixture', 'gpt-5.4'])
    await legacy.write('speeds', { [key]: 'fast', [deleted]: 'fast' })
    await previous.write('keep', {
      sessionId: 'keep',
      speeds: { [key]: 'default' },
    })
    await previous.write('deleted', { sessionId: 'deleted', speeds: {} })
    const open = () =>
      fixture(undefined, false, false, undefined, undefined, home)
    const selected = (f: Awaited<ReturnType<typeof open>>) =>
      f.service.speed('keep' as any, 'fixture', 'gpt-5.4').selected
    const upgrade = await open()
    expect(selected(upgrade)).toBe('default')
    expect(await legacy.read('speeds')).toEqual({ [key]: 'default' })
    await upgrade.service.setSpeed('keep' as any, 'fixture', 'gpt-5.4', 'fast')
    expect(await legacy.read('speeds')).toEqual({ [key]: 'fast' })
    // v0.2.14 writes the same aggregate and can remove entries altogether.
    await legacy.write('speeds', {})
    expect(selected(await open())).toBe('default')
    await legacy.write('speeds', { [key]: 'fast' })
    expect(selected(await open())).toBe('fast')
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

  it('removes deleted session speeds after pending writes without losing other sessions', async () => {
    const f = await fixture()
    await f.service.setSpeed('keep' as any, 'fixture', 'gpt-5.4', 'fast')
    const store = (f.service as any).store as JsonStorage
    const write = store.write.bind(store)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const started = new Promise<void>((done) => {
      entered = done
    })
    vi.spyOn(store, 'write').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      await write(...args)
    })
    const pending = f.service.setSpeed(
      'removed' as any,
      'fixture',
      'gpt-5.4',
      'fast',
    )
    await started
    f.ctx.emit('api-session/removed', 'removed' as any)
    release()
    await pending
    await (f.service as any).speedWrites
    expect([
      ...((f.service as any).speeds as Map<string, unknown>).keys(),
    ]).toEqual([JSON.stringify(['keep', 'fixture', 'gpt-5.4'])])
    expect(await store.read('speeds')).toEqual({
      [JSON.stringify(['keep', 'fixture', 'gpt-5.4'])]: 'fast',
    })
  })
  it.each([
    null,
    { serviceTiers: {} },
    { serviceTiers: [] },
    { serviceTiers: [null] },
    { reasoningChoices: 'high' },
    { reasoningChoices: [{ id: 'high', label: 'High', wireValue: 1 }] },
    { supportsReasoning: 'false' },
    { inputModalities: 'image' },
    { maxOutputTokens: -1 },
  ])(
    'rejects malformed capability overrides before saving (%j)',
    async (override) => {
      const f = await fixture()
      const before = structuredClone(f.options())
      await expect(
        f.service.updateOptions(
          'fixture',
          1800000,
          '',
          JSON.stringify({ 'gpt-5.4': override }),
        ),
      ).rejects.toThrow()
      expect(f.options()).toEqual(before)
      expect(
        f.service.capability('fixture', 'gpt-5.4')!.reasoning,
      ).toMatchObject({
        fallback: true,
        defaultId: 'medium',
      })
      await expect(
        f.native().prepareCall('fixture', 'gpt-5.4'),
      ).resolves.toBeDefined()
    },
  )

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
    // Drain the config-triggered request before changing its upstream fixture.
    await f.service.refresh('fixture')
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
    await f.service.refresh('fixture')
    f.fail()
    await expect(f.service.refresh('fixture')).rejects.toThrow('offline')
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      900000,
    )
  })

  it('bounds stale cleanup membership work for a large catalog', async () => {
    const f = await fixture()
    const count = 1000
    const prefix = 'gpt-cleanup-fixture-'
    f.models([
      { id: 'gpt-5.4', context_window: 900000 },
      ...Array.from({ length: count }, (_, index) => ({
        id: `${prefix}${index}`,
      })),
    ])
    await f.service.refresh('fixture')
    f.models([{ id: 'gpt-5.4', context_window: 950000 }])
    await f.service.refresh('fixture')
    const other = structuredClone(f.raw().providers.other)
    let idReads = 0
    const originalMap = Array.prototype.map
    const trace = vi.spyOn(Array.prototype, 'map').mockImplementation(function (
      this: any[],
      callback: any,
      thisArg?: any,
    ) {
      const result = originalMap.call(this, callback, thisArg)
      if (result.length !== count || result[0] !== `${prefix}0`) return result
      return new Proxy(result, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) idReads++
          return Reflect.get(target, key, receiver)
        },
      })
    })
    try {
      await f.service.removeStale('fixture')
    } finally {
      trace.mockRestore()
    }
    expect(
      f.raw().providers.fixture.models.map((model: any) => model.id),
    ).toEqual(['gpt-5.4', 'gpt-4o'])
    expect(f.service.status('fixture').models).toEqual([
      { id: 'gpt-5.4', stale: false },
    ])
    expect(f.service.contextWindow('fixture', 'gpt-5.4').effectiveTokens).toBe(
      950000,
    )
    expect(f.raw().providers.other).toEqual(other)
    expect(idReads).toBeLessThan(count * 20)
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
    await f.service.refresh('fixture')
    f.models([{ id: 'gpt-5.4', context_window: 950000 }])
    await f.service.refresh('fixture')
    expect(f.service.status('fixture').models).toContainEqual({
      id: 'gpt-new',
      stale: true,
    })
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
