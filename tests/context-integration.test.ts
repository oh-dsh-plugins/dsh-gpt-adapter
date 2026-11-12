import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as native from '@deepseek-ai/dsh-llm-pi-ai'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, type GptModels } from '../src/host.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function fixture(
  protocol = 'openai-responses',
  catalogOverrides = false,
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
  const plugin = await import('../lib/index.js')
  const liveOptions = Config(options)
  const revisions: Record<string, number> = { 'llm-pi-ai': 1, 'gpt-adapter': 1 }
  let failCleanup = false
  const settings = {
    configure: () => () => {},
    describe: () => [
      {
        ns: 'llm-pi-ai',
        value: structuredClone(raw),
        user: structuredClone(raw),
        base: {},
        schema: native.Config.toJSON(),
        revision: revisions['llm-pi-ai'],
      },
      { ns: 'gpt-adapter', value: options, revision: revisions['gpt-adapter'] },
      { ns: 'compaction-basic', value: { headroomTokens: 65536 } },
    ],
    async write(
      ns: string,
      change: (current: any, base: any, schema: any) => any,
      expected?: number,
    ) {
      if (
        expected !== undefined &&
        settings.describe().find((row) => row.ns === ns)?.revision !== expected
      )
        throw new Error('revision conflict')
      if (ns === 'gpt-adapter' && failCleanup)
        throw new Error('legacy cleanup failed')
      const next = change(
        structuredClone(ns === 'llm-pi-ai' ? raw : options),
        {},
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
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'fixture-key' }),
  })
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
  let failed = false
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
  await service.refresh('fixture')
  if (catalogOverrides) await service.refresh('openai')
  return {
    ctx,
    settings,
    service,
    requests,
    revisions,
    raw: () => raw,
    options: () => options,
    model: () => raw.providers.fixture.models[0],
    models: (value: any[]) => {
      models = value
    },
    fail: () => {
      failed = true
    },
    failCleanup: () => {
      failCleanup = true
    },
    native() {
      native.apply(ctx, native.Config(raw))
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
