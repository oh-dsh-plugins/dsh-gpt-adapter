import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, type GptModels } from '../src/host.js'

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

describe('built plugin and official transport integration', () => {
  it('records all supported runtimes and verifies the installed native source', async () => {
    const versions = ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3']
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(manifest.engines.dsh).toBe(versions.join(' || '))
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
        reasoning: 'high' as const,
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
        ],
      }
      const options = {
        codexCompatibility: { enabled: false },
        routes: {
          fixture: {
            enabled: true,
            refreshIntervalMs: 1800000,
            overridesJSON: '{}',
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
      if (protocol === 'openai-completions')
        options.routes = {} as typeof options.routes
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
                  {
                    id: 'gpt-unreported',
                  },
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
      await service.setSpeed(sessionId, 'fixture', 'gpt-custom', 'fast')
      native.apply(ctx, native.Config({ providers: { fixture: profile } }))
      expect(adapter).toBeDefined()
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
      // Every preset, including Ultra, works even before the upstream lists a
      // configured model, through both real SDK serializers.
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
