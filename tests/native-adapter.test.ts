import { describe, expect, it } from 'vitest'
import { installNativeAdapterBridge } from '../src/native-adapter.js'

async function outgoingPayload(
  body: Record<string, any>,
  api = 'openai-responses',
  preserveReasoning = false,
) {
  let sent: Record<string, any> | undefined
  const model = { api, reasoning: false }
  async function* send(_model: any, _context: any, settings: any) {
    sent = settings.onPayload(body)
  }
  const snapshot = {
    profiles: new Map([['fixture', {}]]),
    models: { stream: send, streamSimple: send },
  }
  const adapter = {
    current: () => snapshot,
    modelInfo: () => model,
    streamWithSnapshot(_options: any, current: typeof snapshot) {
      return current.models.streamSimple(model, {}, {})
    },
    async prepareCall() {},
    async *stream(_options: any) {},
  }
  const dispose = installNativeAdapterBridge(adapter, () => ({
    model: { provider: 'fixture', id: 'gpt-fixture', name: 'GPT' },
    preserveReasoning,
    prepare: () => ({ payload: { service_tier: 'default' }, observe() {} }),
  }))
  try {
    for await (const _chunk of adapter.stream({ provider: 'fixture' })) {
    }
    return sent!
  } finally {
    dispose()
  }
}

describe('native request tool compatibility', () => {
  it.each([false, true])(
    'keeps Responses optional arguments without overriding explicit strictness (preserveReasoning=%s)',
    async (preserveReasoning) => {
      const parameters = {
        type: 'object',
        properties: { provider: { type: 'string' } },
      }
      const body = {
        tools: [
          { type: 'function', name: 'list_models', parameters },
          { type: 'function', name: 'strict_tool', strict: true, parameters },
          { type: 'function', name: 'loose_tool', strict: false, parameters },
          { type: 'function', name: 'null_tool', strict: null, parameters },
          { type: 'web_search' },
          { type: 'custom', name: 'grammar_tool' },
        ],
      }
      const original = structuredClone(body)
      const sent = await outgoingPayload(
        body,
        'openai-responses',
        preserveReasoning,
      )

      expect(sent.tools).toEqual([
        { ...body.tools[0], strict: false },
        ...body.tools.slice(1),
      ])
      expect(sent.tools[0].parameters).toEqual(parameters)
      expect(body).toEqual(original)
    },
  )

  it('leaves Chat Completions tools unchanged', async () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'list_models', parameters: {} } },
      ],
    }
    const sent = await outgoingPayload(body, 'openai-completions')
    expect(sent.tools).toEqual(body.tools)
  })

  it('does not add a tools field when no tools are available', async () => {
    expect(await outgoingPayload({ input: [] })).not.toHaveProperty('tools')
  })
})
