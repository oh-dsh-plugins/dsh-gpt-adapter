import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Config, type GptModels } from '../src/host.js'
import { installNativeAdapterBridge } from '../src/native-adapter.js'
import { JsonStorage } from '../src/storage.js'

const { supportedDshVersions, supportedDshRange } = await import(
  pathToFileURL(resolve('scripts/compat.mjs')).href
)

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function streamResponse(protocol: string, serviceTier = 'priority') {
  const message = {
    id: 'msg_1',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'OK', annotations: [] }],
  }
  const response = {
    id: 'resp_1',
    model: 'gpt-custom',
    status: 'completed',
    service_tier: serviceTier,
    output: [message],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
  const events =
    protocol === 'openai-responses'
      ? [
          { type: 'response.created', response: { ...response, output: [] } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...message, content: [] },
          },
          {
            type: 'response.content_part.added',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: 'OK',
          },
          {
            type: 'response.output_text.done',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            text: 'OK',
          },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response },
        ]
      : [
          {
            id: 'chat_1',
            object: 'chat.completion.chunk',
            model: 'gpt-custom',
            service_tier: serviceTier,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'OK' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chat_1',
            object: 'chat.completion.chunk',
            model: 'gpt-custom',
            service_tier: serviceTier,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          },
        ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('native SDK protocol boundary', () => {
  it.each(['anthropic-messages', 'openai-completions'])(
    'leaves tier-only %s calls entirely native',
    async (api) => {
      const model = { api }
      const settings = {
        serviceTier: 'native-tier',
        signal: new AbortController().signal,
      }
      const send = vi.fn(async function* (
        _model: any,
        _context: any,
        _settings: any,
      ) {})
      const prepare = vi.fn(() => ({
        payload: { service_tier: 'ultrafast' },
        manualUltrafast: true,
        observe() {},
      }))
      const snapshot = {
        profiles: new Map([['fixture', {}]]),
        models: { stream: send, streamSimple: send },
      }
      const adapter = {
        current: () => snapshot,
        modelInfo: () => model,
        streamWithSnapshot(_options: any, current: typeof snapshot) {
          return current.models.streamSimple(model, {}, settings)
        },
        async prepareCall() {},
        async *stream(_options: any) {},
      }
      const dispose = installNativeAdapterBridge(adapter, () => ({
        model: { provider: 'fixture', id: 'alias', name: 'Alias' },
        tierOnly: true,
        preserveReasoning: true,
        prepare,
      }))
      try {
        for await (const _chunk of adapter.stream({ provider: 'fixture' })) {
        }
        expect(prepare).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledExactlyOnceWith(model, {}, settings)
        expect(send.mock.calls[0]![2]).toBe(settings)
      } finally {
        dispose()
      }
    },
  )

  it.each([
    { preserveReasoning: false, manualUltrafast: true },
    { preserveReasoning: true, manualUltrafast: true },
    { preserveReasoning: false, manualUltrafast: false },
    { preserveReasoning: true, manualUltrafast: false },
  ])(
    'filters only manual tiers on adapted non-Responses calls: %j',
    async ({ preserveReasoning, manualUltrafast }) => {
      for (const nativeTier of [undefined, 'native-tier']) {
        const model = { api: 'anthropic-messages' }
        const settings = { serviceTier: nativeTier }
        const body = nativeTier ? { service_tier: nativeTier } : {}
        const payload = { service_tier: 'ultrafast' }
        let sent: Record<string, unknown> | undefined
        let sentSettings: Record<string, unknown> | undefined
        async function* send(_model: any, _context: any, next: any) {
          sentSettings = next
          sent = next.onPayload(body)
        }
        const snapshot = {
          profiles: new Map([['fixture', {}]]),
          models: { stream: send, streamSimple: send },
        }
        const adapter = {
          current: () => snapshot,
          modelInfo: () => model,
          streamWithSnapshot(_options: any, current: typeof snapshot) {
            return current.models.streamSimple(model, {}, settings)
          },
          async prepareCall() {},
          async *stream(_options: any) {},
        }
        const dispose = installNativeAdapterBridge(adapter, () => ({
          model: { provider: 'fixture', id: 'gpt-alias', name: 'GPT alias' },
          preserveReasoning,
          prepare: () => ({ payload, manualUltrafast, observe() {} }),
        }))
        try {
          for await (const _chunk of adapter.stream({ provider: 'fixture' })) {
          }
          const expectedTier = manualUltrafast ? nativeTier : 'ultrafast'
          expect(sentSettings!.serviceTier).toBe(expectedTier)
          expect(sent!.service_tier).toBe(expectedTier)
          if (expectedTier === undefined)
            expect(sent).not.toHaveProperty('service_tier')
          expect(payload.service_tier).toBe('ultrafast')
          expect(body).toEqual(nativeTier ? { service_tier: nativeTier } : {})
        } finally {
          dispose()
        }
      }
    },
  )
})

describe('built plugin and official transport integration', () => {
  it.each([
    'structured metadata',
    'initial route opt-in',
    'manual tier only',
  ] as const)(
    'sends Ultrafast only when selected through native Responses with %s',
    async (source) => {
      const native = await import('@deepseek-ai/dsh-llm-pi-ai')
      const directory = await mkdtemp(join(tmpdir(), 'dsh-gpt-ultrafast-test-'))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      vi.stubEnv('DSH_HOME', directory)
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      const tierOnly = source === 'manual tier only'
      const modelId = tierOnly ? 'gateway-model-v2' : 'gpt-6.2-astra'
      const profile = {
        api: 'openai-responses' as const,
        ...(tierOnly ? {} : { reasoning: 'high' as const }),
        baseURL: 'https://fixture.invalid/v1',
        apiKeyEnv: 'TEST_API_KEY',
        models: [
          tierOnly
            ? { id: modelId }
            : { id: modelId, reasoningEfforts: { high: 'high' } },
        ],
      }
      ctx.provide('settings', {
        configure: () => () => {},
        // No saved gpt-adapter settings: the opt-in must come from effective
        // initial configuration, not a persisted route or model override.
        describe: () => [
          {
            ns: 'llm-pi-ai',
            value: { providers: { fixture: profile } },
            revision: 1,
          },
        ],
        mutate: vi.fn(async () => {}),
      })
      ctx.provide('credentials', {
        resolve: async () => ({ value: 'fixture-key' }),
      })
      let adapter: LlmAdapter | undefined
      const adapters = new Map<string, { adapter: LlmAdapter }>()
      ctx.provide('llm', {
        adapters,
        listConfigurableProviders: () => [],
        registerAdapter: (providers: string[], value: LlmAdapter) => {
          adapter = value
          for (const provider of providers)
            adapters.set(provider, { adapter: value })
          return Object.assign(() => {}, { replace() {} })
        },
        registerConfigurableProviders: () =>
          Object.assign(() => {}, { replace() {} }),
        registerModelDiscovery: () => () => {},
      })
      const requests: Array<Record<string, unknown>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).endsWith('/models'))
            return new Response(
              JSON.stringify({
                data: [
                  source === 'structured metadata'
                    ? {
                        id: modelId,
                        service_tiers: [
                          { id: 'priority', name: 'Fast' },
                          {
                            id: 'ultrafast',
                            name: 'Ultrafast',
                            description: 'Lowest-latency service tier',
                          },
                        ],
                      }
                    : {
                        id: modelId,
                        service_tiers: [{ id: 'priority', name: 'Fast' }],
                      },
                ],
              }),
            )
          expect(String(url)).toBe('https://fixture.invalid/v1/responses')
          const body = JSON.parse(String(init!.body)) as Record<string, unknown>
          requests.push(body)
          return streamResponse(
            'openai-responses',
            String(body.service_tier ?? 'default'),
          )
        }),
      )
      const plugin = await import('../lib/index.js')
      await plugin.apply(
        ctx,
        Config({
          codexCompatibility: { enabled: false },
          routes: {
            fixture: {
              enabled: !tierOnly,
              refreshIntervalMs: 1800000,
              overridesJSON: '{}',
              allowUnadvertisedUltrafast: source !== 'structured metadata',
            },
          },
        }),
      )
      const service = ctx.get('gptModels') as GptModels
      if (!tierOnly) await service.refresh('fixture')
      expect(service.status('fixture').adapter).toBe('pending')
      expect(service.status('fixture').canConfigureUltrafastFallback).toBe(
        false,
      )
      native.apply(ctx, native.Config({ providers: { fixture: profile } }))
      expect(adapter).toBeDefined()
      expect(service.status('fixture').canConfigureUltrafastFallback).toBe(true)
      adapters.set('fixture', { adapter: {} as LlmAdapter })
      expect(service.status('fixture').adapter).toBe('native')
      expect(service.modelStatus('fixture', modelId).enabled).toBe(false)
      adapters.set('fixture', { adapter: adapter! })
      const sessionId = 'ultrafast-session' as SessionId
      const send = async () => {
        const call = await adapter!.prepareCall('fixture', modelId)
        for await (const _chunk of call.stream({
          provider: 'fixture',
          model: modelId,
          sessionId,
          ...(tierOnly ? {} : { reasoningEffort: ReasoningEffortId('high') }),
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          ],
        })) {
        }
      }
      expect(service.speed(sessionId, 'fixture', modelId).selected).toBe(
        'default',
      )
      await send()
      if (tierOnly) {
        const standard = requests.at(-1)!
        expect(standard.service_tier).not.toBe('ultrafast')
        expect(service.status('fixture').enabled).toBe(false)
        await service.setSpeed(
          sessionId,
          'fixture',
          modelId,
          'manual-ultrafast',
        )
        await send()
        const { service_tier, ...manualBody } = requests.at(-1)!
        const { service_tier: _, ...standardBody } = standard
        expect(service_tier).toBe('ultrafast')
        expect(manualBody).toEqual(standardBody)
        expect(service.speed(sessionId, 'fixture', modelId).last).toEqual({
          requested: 'ultrafast',
          actual: 'ultrafast',
        })
        await service.setSpeed(sessionId, 'fixture', modelId, 'default')
        await send()
        expect(requests.at(-1)).toEqual(standard)
        expect(service.speed(sessionId, 'fixture', modelId)).toEqual({
          selected: 'default',
          last: null,
        })
        return
      }
      expect(requests.at(-1)!.service_tier).toBe('default')
      for (const [speed, wireValue] of [
        ['fast', 'priority'],
        [
          source === 'structured metadata' ? 'ultrafast' : 'manual-ultrafast',
          'ultrafast',
        ],
        ['default', 'default'],
      ] as const) {
        await service.setSpeed(sessionId, 'fixture', modelId, speed)
        await send()
        expect(requests.at(-1)!).toMatchObject({
          model: modelId,
          service_tier: wireValue,
        })
        expect(service.speed(sessionId, 'fixture', modelId)).toMatchObject({
          selected: speed,
          last: { requested: wireValue, actual: wireValue },
        })
      }
      expect(requests.map((body) => body.service_tier)).toEqual([
        'default',
        'priority',
        'ultrafast',
        'default',
      ])
    },
  )
  it.each([false, true])(
    'never sends a saved manual Ultrafast tier to implicit Anthropic (route enabled=%s)',
    async (enabled) => {
      const native = await import('@deepseek-ai/dsh-llm-pi-ai')
      const directory = await mkdtemp(join(tmpdir(), 'dsh-gpt-anthropic-test-'))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      vi.stubEnv('DSH_HOME', directory)
      const sessionId = 'anthropic-session' as SessionId
      const modelId = 'claude-haiku-4-5'
      // Reproduce a previously saved selection without going through today's
      // protocol validation (e.g. after changing a provider's protocol).
      await new JsonStorage(join(directory, 'storages', 'gpt-adapter')).write(
        'speeds',
        {
          [JSON.stringify([sessionId, 'anthropic', modelId])]:
            'manual-ultrafast',
        },
      )
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      const profile = {
        // Deliberately omit api: the native built-in model resolves Anthropic.
        baseURL: 'https://fixture.invalid',
        apiKeyEnv: 'TEST_API_KEY',
        models: [{ id: modelId }],
      }
      ctx.provide('settings', {
        configure: () => () => {},
        describe: () => [
          {
            ns: 'llm-pi-ai',
            value: { providers: { anthropic: profile } },
            revision: 1,
          },
        ],
        mutate: vi.fn(async () => {}),
      })
      ctx.provide('credentials', {
        resolve: async () => ({ value: 'fixture-key' }),
      })
      let adapter: LlmAdapter | undefined
      const adapters = new Map<string, { adapter: LlmAdapter }>()
      ctx.provide('llm', {
        adapters,
        listConfigurableProviders: () => [],
        registerAdapter: (providers: string[], value: LlmAdapter) => {
          adapter = value
          for (const provider of providers)
            adapters.set(provider, { adapter: value })
          return Object.assign(() => {}, { replace() {} })
        },
        registerConfigurableProviders: () =>
          Object.assign(() => {}, { replace() {} }),
        registerModelDiscovery: () => () => {},
      })
      const requests: Array<Record<string, unknown>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const endpoint = new URL(String(url))
          expect(endpoint.origin).toBe('https://fixture.invalid')
          if (endpoint.pathname === '/models')
            return Response.json({ data: [] })
          expect(endpoint.pathname).toBe('/v1/messages')
          requests.push(JSON.parse(String(init!.body)))
          return Response.json(
            {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'Fixture captured the request',
              },
            },
            { status: 400 },
          )
        }),
      )
      const plugin = await import('../lib/index.js')
      await plugin.apply(
        ctx,
        Config({
          codexCompatibility: { enabled: false },
          routes: {
            anthropic: {
              enabled,
              refreshIntervalMs: 1800000,
              overridesJSON: '{}',
              allowUnadvertisedUltrafast: true,
            },
          },
        }),
      )
      const service = ctx.get('gptModels') as GptModels
      expect(service.status('anthropic').canConfigureUltrafastFallback).toBe(
        false,
      )
      await expect(
        service.setUltrafastFallback('anthropic', true),
      ).rejects.toThrow('Ultrafast fallback is unavailable')
      await expect(
        service.setSpeed(sessionId, 'anthropic', modelId, 'manual-ultrafast'),
      ).rejects.toThrow('This speed is unavailable')
      native.apply(ctx, native.Config({ providers: { anthropic: profile } }))
      expect(adapter).toBeDefined()
      const call = await adapter!.prepareCall('anthropic', modelId)
      const chunks = []
      for await (const chunk of call.stream({
        provider: 'anthropic',
        model: modelId,
        sessionId,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      }))
        chunks.push(chunk)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ model: modelId, stream: true })
      expect(requests[0]).not.toHaveProperty('service_tier')
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error' },
      })
    },
  )
  it('records all supported runtimes and verifies the installed native source', async () => {
    const versions = supportedDshVersions
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(manifest.engines.dsh).toBe(supportedDshRange)
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-'))
        expect(range).toBe(manifest.engines.dsh)
    }
    const compatibility = JSON.parse(
      await readFile('lib/compatibility.json', 'utf8'),
    )
    expect(
      compatibility.runtimes.map((runtime: any) => runtime.adapterVersion),
    ).toEqual(versions)
    const require = createRequire(import.meta.url)
    const version = require('@deepseek-ai/dsh-llm-pi-ai/package.json').version
    const runtime = compatibility.runtimes.find(
      (entry: any) => entry.adapterVersion === version,
    )
    for (const [field, name] of [
      ['sourceSha256', '@deepseek-ai/dsh-llm-pi-ai'],
      ['settingsSha256', '@deepseek-ai/dsh-client-ui-settings-models/client'],
      ['menuSha256', '@deepseek-ai/dsh-client-ui-model-selection/client'],
    ]) {
      const hash = createHash('sha256')
        .update(await readFile(require.resolve(name!)))
        .digest('hex')
      expect(runtime[field!]).toBe(hash)
    }
  })
  it('uses the implicit Cerebras Chat Completions protocol in the SDK payload', async () => {
    const native = await import('@deepseek-ai/dsh-llm-pi-ai')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-gpt-test-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    vi.stubEnv('DSH_HOME', directory)
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const provider = 'cerebras'
    const model = 'gpt-oss-120b'
    const providers = {
      [provider]: {
        baseURL: 'https://fixture.invalid/v1',
        apiKeyEnv: 'TEST_API_KEY',
        models: [{ id: model }],
      },
    }
    ctx.provide('settings', {
      configure: () => () => {},
      describe: () => [{ ns: 'llm-pi-ai', value: { providers }, revision: 1 }],
    })
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'fixture-key' }),
    })
    const adapters = new Map<string, { adapter: LlmAdapter }>()
    ctx.provide('llm', {
      adapters,
      listConfigurableProviders: () => [],
      registerAdapter: (routes: string[], adapter: LlmAdapter) => {
        for (const route of routes) adapters.set(route, { adapter })
        return Object.assign(() => {}, { replace() {} })
      },
      registerConfigurableProviders: () =>
        Object.assign(() => {}, { replace() {} }),
      registerModelDiscovery: () => () => {},
    })
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(String(url))
      if (pathname.endsWith('/models')) return Response.json({ data: [] })
      requests.push({ path: pathname, body: JSON.parse(String(init?.body)) })
      return streamResponse('openai-completions')
    })
    await (
      await import('../lib/index.js')
    ).apply(
      ctx,
      Config({
        codexCompatibility: { enabled: false },
        routes: {
          [provider]: {
            enabled: true,
            refreshIntervalMs: 1800000,
            overridesJSON: JSON.stringify({
              [model]: {
                reasoningChoices: [
                  { id: 'high', label: 'High', wireValue: 'high' },
                ],
              },
            }),
          },
        },
      }),
    )
    native.apply(ctx, native.Config({ providers }))
    const call = await adapters
      .get(provider)!
      .adapter.prepareCall(provider, model)
    for await (const _ of call.stream({
      provider,
      model,
      reasoningEffort: ReasoningEffortId('high'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) {
      /* Drain the native stream. */
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      body: { model, reasoning_effort: 'high' },
    })
    expect(requests[0]!.body).not.toHaveProperty('reasoning')
  })

  it.each(['openai-responses', 'openai-completions'] as const)(
    'sends the native effort and priority through the actual %s implementation',
    async (protocol) => {
      // The production build is part of pnpm test; imports never use a handwritten transport substitute.
      const native = await import('@deepseek-ai/dsh-llm-pi-ai')
      const directory = await mkdtemp(join(tmpdir(), 'dsh-gpt-test-'))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      vi.stubEnv('DSH_HOME', directory)
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      const profile = {
        api: protocol,
        baseURL: 'https://fixture.invalid/v1',
        apiKeyEnv: 'TEST_API_KEY',
        models: [
          { id: 'gpt-custom' },
          { id: 'legacy-model' },
          {
            id: 'gpt-local-only',
            reasoningEfforts: { off: null, minimal: 'minimal', high: 'high' },
          },
          {
            id: 'gpt-unreported',
            reasoningEfforts: { low: 'low', high: 'high' },
          },
          { id: 'gpt-4o' },
          { id: 'gpt-6.2-sol' },
          { id: 'gpt-6.2-astra' },
        ],
      }
      const options = {
        codexCompatibility: { enabled: false },
        routes: {
          fixture: {
            enabled: true,
            refreshIntervalMs: 1800000,
            overridesJSON: JSON.stringify({
              'gpt-local-only': {
                reasoningChoices: [
                  'low',
                  'medium',
                  'high',
                  'xhigh',
                  'max',
                  'ultra',
                ].map((id) => ({ id, label: id, wireValue: id })),
                defaultReasoningId: 'high',
              },
            }),
          },
        },
      }
      ctx.provide('settings', {
        configure: () => () => {},
        describe: () => [
          {
            ns: 'llm-pi-ai',
            value: { providers: { fixture: profile } },
            revision: 1,
          },
          { ns: 'gpt-adapter', value: options, revision: 1 },
        ],
        mutate: vi.fn(async () => {}),
      })
      ctx.provide('credentials', {
        resolve: async () => ({ value: 'fixture-key' }),
      })
      let adapter: LlmAdapter | undefined
      const adapters = new Map<string, { adapter: LlmAdapter }>()
      ctx.provide('llm', {
        adapters,
        listConfigurableProviders: () => [],
        registerAdapter: (providers: string[], value: LlmAdapter) => {
          adapter = value
          for (const provider of providers)
            adapters.set(provider, { adapter: value })
          return Object.assign(() => {}, { replace() {} })
        },
        registerConfigurableProviders: () =>
          Object.assign(() => {}, { replace() {} }),
        registerModelDiscovery: () => () => {},
      })
      const requests: Array<Record<string, unknown>> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).endsWith('/models'))
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: 'gpt-custom',
                    reasoning_supported_efforts: ['max', 'ultra'],
                    service_tiers: ['default', 'priority', 'ultrafast'],
                  },
                  { id: 'gpt-unreported' },
                  { id: 'gpt-4o' },
                  { id: 'gpt-6.2-sol' },
                  { id: 'gpt-6.2-astra' },
                ],
              }),
            )
          requests.push(
            JSON.parse(String(init!.body)) as Record<string, unknown>,
          )
          return streamResponse(
            protocol,
            String(requests.at(-1)!.service_tier ?? 'default'),
          )
        }),
      )
      const plugin = await import('../lib/index.js')
      const liveOptions = Config(options)
      expect(Config.dict!.routes!.meta.volatile).toBe(true)
      await plugin.apply(ctx, liveOptions)
      const service = ctx.get('gptModels') as GptModels
      await service.refresh('fixture')
      const sessionId = 'test-session' as SessionId
      native.apply(ctx, native.Config({ providers: { fixture: profile } }))
      expect(adapter).toBeDefined()
      await service.setSpeed(sessionId, 'fixture', 'gpt-custom', 'fast')
      const preserved = await adapter!.prepareCall('fixture', 'gpt-unreported')
      expect(
        preserved.model.reasoning?.efforts.map((effort) => String(effort.id)),
      ).toContain('high')
      expect(
        preserved.model.reasoning?.efforts.map((effort) => String(effort.id)),
      ).toContain('low')
      const call = await adapter!.prepareCall('fixture', 'gpt-custom')
      expect(
        call.model.reasoning?.efforts.map((effort) => String(effort.id)),
      ).toEqual(['max', 'ultra'])
      const tools = [
        {
          name: 'list_subagent_models',
          description: 'No arguments lists providers.',
          parameters: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
            },
          },
        },
        {
          name: 'subagent',
          description: 'Omit route fields to inherit defaults.',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoning_effort: { type: 'string' },
            },
            required: ['description', 'prompt'],
          },
        },
      ]
      const chunks = []
      for await (const chunk of call.stream({
        provider: 'fixture',
        model: 'gpt-custom',
        sessionId,
        reasoningEffort: ReasoningEffortId('ultra'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        tools,
      }))
        chunks.push(chunk)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.service_tier, JSON.stringify(requests[0])).toBe(
        'priority',
      )
      if (protocol === 'openai-responses')
        expect(requests[0]!.reasoning).toMatchObject({
          effort: 'ultra',
          summary: 'auto',
        })
      else expect(requests[0]!.reasoning_effort).toBe('ultra')
      const wireTools = requests[0]!.tools as any[]
      for (const [index, tool] of tools.entries()) {
        const wire =
          protocol === 'openai-responses'
            ? wireTools[index]
            : wireTools[index].function
        expect(wire.parameters).toEqual(tool.parameters)
        if (protocol === 'openai-responses') expect(wire.strict).toBe(false)
      }
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'stop' },
      })
      expect(
        service.speed(sessionId, 'fixture', 'gpt-custom').last?.actual,
      ).toBe('priority')
      // A plain /models entry offers preset Fast without upstream speed metadata.
      await service.setSpeed(sessionId, 'fixture', 'gpt-unreported', 'fast')
      const fallbackCall = await adapter!.prepareCall(
        'fixture',
        'gpt-unreported',
      )
      for await (const _chunk of fallbackCall.stream({
        provider: 'fixture',
        model: 'gpt-unreported',
        sessionId,
        reasoningEffort: ReasoningEffortId('high'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      })) {
      }
      expect(requests[1]!.service_tier).toBe('priority')
      if (protocol === 'openai-responses')
        expect(requests[1]!.reasoning).toMatchObject({ effort: 'high' })
      else expect(requests[1]!.reasoning_effort).toBe('high')
      const plain = await adapter!.prepareCall('fixture', 'gpt-4o')
      for await (const _chunk of plain.stream({
        provider: 'fixture',
        model: 'gpt-4o',
        sessionId,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      })) {
      }
      if (protocol === 'openai-responses')
        expect(requests.at(-1)!.reasoning).toMatchObject({ effort: 'medium' })
      else expect(requests.at(-1)!.reasoning_effort).toBe('medium')
      expect(plain.model.reasoning?.defaultEffort).toBe('medium')
      expect(plain.model.reasoning?.efforts.map(({ id }) => id)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ])
      // A user override can supply all six levels for a configured-only model.
      await service.setSpeed(sessionId, 'fixture', 'gpt-local-only', 'fast')
      const local = await adapter!.prepareCall('fixture', 'gpt-local-only')
      const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      expect(local.model.reasoning?.defaultEffort).toBe('high')
      expect(
        local.model.reasoning?.efforts.map((effort) => String(effort.id)),
      ).toEqual(levels)
      const page = ctx.settings
        .describe()
        .find((row) => row.ns === 'llm-pi-ai')!.value as any
      expect(
        Object.keys(
          page.providers.fixture.models.find(
            (model: any) => model.id === 'gpt-local-only',
          ).reasoningEfforts,
        ),
      ).toEqual(levels)
      for (const level of levels) {
        for await (const _chunk of local.stream({
          provider: 'fixture',
          model: 'gpt-local-only',
          sessionId,
          reasoningEffort: ReasoningEffortId(level),
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          ],
        })) {
        }
        if (protocol === 'openai-responses')
          expect(requests.at(-1)!.reasoning).toMatchObject({ effort: level })
        else expect(requests.at(-1)!.reasoning_effort).toBe(level)
        expect(requests.at(-1)!.service_tier).toBe('priority')
      }
      await service.setSpeed(sessionId, 'fixture', 'gpt-local-only', 'default')
      const standard = await adapter!.prepareCall('fixture', 'gpt-local-only')
      for await (const _chunk of standard.stream({
        provider: 'fixture',
        model: 'gpt-local-only',
        sessionId,
        reasoningEffort: ReasoningEffortId('ultra'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      })) {
      }
      expect(requests.at(-1)!.service_tier).toBe('default')
      if (protocol === 'openai-responses')
        expect(requests.at(-1)!.reasoning).toMatchObject({ effort: 'ultra' })
      else expect(requests.at(-1)!.reasoning_effort).toBe('ultra')
      expect(
        service.speed(sessionId, 'fixture', 'gpt-local-only'),
      ).toMatchObject({
        selected: 'default',
        last: { requested: 'default', actual: 'default' },
      })
      // An existing session can request xhigh when /models only lists the ID.
      const sol = await adapter!.prepareCall('fixture', 'gpt-6.2-sol')
      const solChunks = []
      for await (const chunk of sol.stream({
        provider: 'fixture',
        model: 'gpt-6.2-sol',
        sessionId,
        reasoningEffort: ReasoningEffortId('xhigh'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      }))
        solChunks.push(chunk)
      expect(solChunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'stop' },
      })
      const solPayload = requests.at(-1)!
      expect(solPayload.model).toBe('gpt-6.2-sol')
      if (protocol === 'openai-responses')
        expect(solPayload.reasoning).toMatchObject({ effort: 'xhigh' })
      else expect(solPayload.reasoning_effort).toBe('xhigh')
      expect(sol.model.reasoning?.efforts.map((effort) => effort.id)).toContain(
        'xhigh',
      )
      const astra = await adapter!.prepareCall('fixture', 'gpt-6.2-astra')
      for (const effort of ['high', 'xhigh', 'max', 'ultra']) {
        const chunks = []
        for await (const chunk of astra.stream({
          provider: 'fixture',
          model: 'gpt-6.2-astra',
          sessionId,
          reasoningEffort: ReasoningEffortId(effort),
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          ],
        }))
          chunks.push(chunk)
        expect(chunks.at(-1)).toMatchObject({
          type: 'finish',
          reason: { kind: 'stop' },
        })
        const payload = requests.at(-1)!
        expect(payload.model).toBe('gpt-6.2-astra')
        if (protocol === 'openai-responses')
          expect(payload.reasoning).toMatchObject({ effort })
        else expect(payload.reasoning_effort).toBe(effort)
      }
      const solRow = profile.models.find(({ id }) => id === 'gpt-6.2-sol')!
      Object.assign(solRow, { reasoningEfforts: { high: 'native-high' } })
      expect(
        service.capture('fixture', 'gpt-6.2-sol', {
          provider: 'fixture',
          id: 'gpt-6.2-sol',
          name: sol.model.name,
        }),
      ).toMatchObject({
        preserveReasoning: true,
      })
      const settingsView = ctx.settings.describe()[0]!.value as any
      expect(
        settingsView.providers.fixture.models.find(
          (model: { id: string }) => model.id === 'gpt-6.2-sol',
        ).reasoningEfforts,
      ).toEqual({ high: 'native-high' })
      // Non-GPT routes continue through the original adapter path.
      const legacy = await adapter!.prepareCall('fixture', 'legacy-model')
      expect(legacy.model.reasoning).toBeUndefined()
      for await (const _chunk of legacy.stream({
        provider: 'fixture',
        model: 'legacy-model',
        reasoningEffort: ReasoningEffortId('off'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        tools,
      })) {
      }
      if (protocol === 'openai-responses')
        expect((requests.at(-1)!.tools as any[])[0]).not.toHaveProperty(
          'strict',
        )
      vi.mocked(ctx.settings.mutate).mockImplementation(async (ns, ops) => {
        expect(ns).toBe('gpt-adapter')
        const operation = ops[0]!
        if (operation.op !== 'set') throw new Error('Expected route update')
        Object.assign(options.routes, { fixture: operation.value })
        liveOptions.routes = Config(options).routes
        ctx.emit('settings/document-updated', ns as SettingsNamespace, 2)
      })
      await service.configure('fixture', false)
      await Promise.resolve()
      expect(service.status('fixture').enabled).toBe(false)
      expect(service.status('fixture').status.state).toBe('idle')
      const disabled = await adapter!.prepareCall('fixture', 'gpt-unreported')
      for await (const _chunk of disabled.stream({
        provider: 'fixture',
        model: 'gpt-unreported',
        reasoningEffort: ReasoningEffortId('high'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        tools,
      })) {
      }
      if (protocol === 'openai-responses')
        expect((requests.at(-1)!.tools as any[])[0]).not.toHaveProperty(
          'strict',
        )
      expect(
        Object.keys(
          (ctx.settings.describe()[0]!.value as any).providers.fixture.models[2]
            .reasoningEfforts,
        ),
      ).toEqual(['off', 'minimal', 'high'])
      await service.configure('fixture', true)
      await Promise.resolve()
      expect(service.status('fixture').enabled).toBe(true)
      expect(
        Object.keys(
          (ctx.settings.describe()[0]!.value as any).providers.fixture.models[2]
            .reasoningEfforts,
        ),
      ).toEqual(levels)
    },
  )
})
