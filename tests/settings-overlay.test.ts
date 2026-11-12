import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import {
  GPT_REASONING_LEVELS,
  resolveCapabilities,
} from '../src/capabilities.js'
import { installSettingsOverlay } from '../src/settings-overlay.js'

const preset = Object.fromEntries(
  GPT_REASONING_LEVELS.map((level) => [level, level]),
)
function fixture() {
  let enabled = true
  let raw: any = {
    providers: {
      gateway: {
        api: 'openai-responses',
        baseURL: 'https://fixture.invalid/v1',
        apiKeyEnv: 'FIXTURE_KEY',
        models: [
          {
            id: 'gpt-example',
            name: 'Original name',
            contextWindow: 128000,
            input: ['text', 'image'],
            reasoningEfforts: {
              off: null,
              minimal: 'minimal',
              low: 'low',
              high: 'high',
            },
          },
        ],
      },
    },
  }
  const originalSchema = Config.toJSON()
  const settings = {
    describe: (_options?: unknown) => [
      {
        ns: 'llm-pi-ai',
        revision: 7,
        schema: originalSchema,
        value: structuredClone(raw),
        base: {},
        user: structuredClone(raw),
      },
    ],
    async write(
      _ns: string,
      change: (current: any, base: any, schema: any) => any,
    ) {
      const next = change(structuredClone(raw), {}, Config)
      Config(next) // The real native validator still rejects Ultra in native storage.
      raw = next
    },
  }
  const beforeDescribe = settings.describe
  const beforeWrite = settings.write
  const resolve = (provider: string, model: Record<string, any>) =>
    enabled && provider === 'gateway' && model.id.startsWith('gpt-')
      ? resolveCapabilities({ id: model.id }, 'test')
      : undefined
  const dispose = installSettingsOverlay(settings, resolve)
  return {
    settings,
    dispose,
    beforeDescribe,
    beforeWrite,
    raw: () => raw,
    disable: () => {
      enabled = false
    },
    originalSchema,
  }
}
function schemaLevels(json: any) {
  const schema: any = new z(json)
  return schema.dict.providers.inner.dict.models.inner.dict.reasoningEfforts.list
    .find((branch: any) => branch.type === 'dict')!
    .sKey.list.map((entry: any) => entry.value)
}

describe('plugin-owned reasoning on the native Models page', () => {
  it('rejects a stale native model draft after metadata changes without freezing its old capacity', async () => {
    let raw: any = {
      providers: {
        gateway: {
          api: 'openai-responses',
          baseURL: 'https://fixture.invalid/v1',
          models: [{ id: 'gpt-example' }],
        },
      },
    }
    let capacity = 800000
    let nativeRevision = 1
    const entry = {
      options: { id: 'llm-pi-ai' },
      fiber: { runtime: { Config } },
    }
    // Exercise the real private writer and path operations, without filesystem writes.
    const settings: any = Object.create(SettingsForms.prototype)
    settings.ownerContext = {
      configEditor: {
        entries: () => [entry],
        edit: async (
          _entry: unknown,
          change: (current: any, base: any) => any,
        ) => {
          const next = change(structuredClone(raw), {})
          Config(next)
          raw = next
          nativeRevision++
        },
      },
    }
    settings.describe = () => [
      {
        ns: 'llm-pi-ai',
        revision: nativeRevision,
        schema: Config.toJSON(),
        value: structuredClone(raw),
        user: structuredClone(raw),
        base: {},
      },
    ]
    const dispose = installSettingsOverlay(settings, (_provider, model) => ({
      ...resolveCapabilities({ id: model.id }, 'test'),
      contextWindow: capacity,
    }))
    try {
      const opened = settings.describe()[0]
      const draft = opened.user.providers.gateway.models
      draft[0].name = 'Renamed'
      capacity = 900000
      await expect(
        settings.mutate(
          'llm-pi-ai',
          [
            {
              op: 'set',
              path: ['providers', 'gateway', 'models'],
              value: draft,
            },
          ],
          opened.revision,
        ),
      ).rejects.toThrow('changed since it was read')
      expect(raw.providers.gateway.models[0]).toEqual({ id: 'gpt-example' })
      const refreshed = settings.describe()[0]
      expect(refreshed.revision).not.toBe(opened.revision)
      expect(settings.describe()[0].revision).toBe(refreshed.revision)
      const freshDraft = refreshed.user.providers.gateway.models
      freshDraft[0].name = 'Renamed'
      await settings.mutate(
        'llm-pi-ai',
        [
          {
            op: 'set',
            path: ['providers', 'gateway', 'models'],
            value: freshDraft,
          },
        ],
        refreshed.revision,
      )
      expect(raw.providers.gateway.models[0]).toEqual({
        id: 'gpt-example',
        name: 'Renamed',
      })
      await dispose.setContextWindow(
        'gateway',
        'gpt-example',
        516000,
        settings.describe()[0].revision,
      )
      expect(raw.providers.gateway.models[0].contextWindow).toBe(516000)
    } finally {
      dispose()
    }
  })

  it('overrides the real Cordis service across contexts and restores it on disposal', async () => {
    const ctx = new Context()
    class NativeSettings extends Service {
      constructor() {
        super(ctx, 'overlayFixture')
      }
      describe() {
        return [
          {
            ns: 'llm-pi-ai',
            schema: Config.toJSON(),
            value: {
              providers: {
                gateway: {
                  models: [
                    { id: 'gpt-example', reasoningEfforts: { low: 'low' } },
                  ],
                },
              },
            },
          },
        ]
      }
    }
    new NativeSettings()
    const service = (ctx as any).overlayFixture
    const dispose = installSettingsOverlay(service, (_provider, model) =>
      resolveCapabilities({ id: model.id }, 'test'),
    )
    const other = (ctx.extend({}) as any).overlayFixture
    expect(
      other.describe()[0].value.providers.gateway.models[0].reasoningEfforts,
    ).toEqual(preset)
    dispose()
    expect(
      other.describe()[0].value.providers.gateway.models[0].reasoningEfforts,
    ).toEqual({ low: 'low' })
    await ctx.fiber.dispose()
  })
  it('projects six presets and their schema without changing native configuration or validation', () => {
    const f = fixture()
    const original = structuredClone(f.raw())
    const view = f.settings.describe()[0]!
    expect(view.value.providers.gateway.models[0].reasoningEfforts).toEqual(
      preset,
    )
    expect(schemaLevels(view.schema)).toEqual(GPT_REASONING_LEVELS)
    expect(f.raw()).toEqual(original)
    expect(Config.toJSON()).toEqual(f.originalSchema)
    expect(() =>
      Config({
        providers: {
          gateway: { models: [{ id: 'gpt-test', reasoningEfforts: preset }] },
        },
      }),
    ).toThrow()
    f.dispose()
    expect(f.settings.describe).toBe(f.beforeDescribe)
    expect(f.settings.write).toBe(f.beforeWrite)
    expect(f.settings.describe()[0]!.value).toEqual(original)
  })
  it('saves unrelated native edits while keeping plugin-owned levels out of native storage', async () => {
    const f = fixture()
    const original = structuredClone(f.raw())
    await f.settings.write('llm-pi-ai', (current) => {
      expect(current.providers.gateway.models[0].reasoningEfforts).toEqual(
        preset,
      )
      current.providers.gateway.models[0].name = 'Renamed'
      return current
    })
    expect(f.raw().providers.gateway.models[0]).toEqual({
      ...original.providers.gateway.models[0],
      name: 'Renamed',
    })
    expect(
      f.settings.describe()[0]!.value.providers.gateway.models[0]
        .reasoningEfforts,
    ).toEqual(preset)
    f.dispose()
    expect(
      f.settings.describe()[0]!.value.providers.gateway.models[0].name,
    ).toBe('Renamed')
  })
  it('applies presets to new GPT models while saving their ordinary fields through native validation', async () => {
    const f = fixture()
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.gateway.models.push({
        id: 'gpt-new',
        name: 'New',
        input: ['text'],
        reasoningEfforts: preset,
      })
      return current
    })
    expect(f.raw().providers.gateway.models[1].reasoningEfforts).toBeUndefined()
    expect(
      f.settings.describe()[0]!.value.providers.gateway.models[1]
        .reasoningEfforts,
    ).toEqual(preset)
    f.disable()
    expect(f.settings.describe()[0]!.value).toEqual(f.raw())
    f.dispose()
  })
  it('does not silently persist edits to managed grades in native configuration', async () => {
    const f = fixture()
    const original = structuredClone(f.raw())
    await expect(
      f.settings.write('llm-pi-ai', (current) => {
        current.providers.gateway.models[0].reasoningEfforts.ultra = 'high'
        return current
      }),
    ).rejects.toThrow('GPT 思考等级由插件预设管理')
    expect(f.raw()).toEqual(original)
    f.dispose()
  })
  it('preserves non-GPT models and native choices in a shared provider namespace', async () => {
    const f = fixture()
    f.raw().providers.gateway.models.push({
      id: 'claude-fixture',
      name: 'Other',
      reasoningEfforts: { minimal: 'minimal', high: 'high' },
    })
    const original = structuredClone(f.raw().providers.gateway.models[1])
    const view = f.settings.describe()[0]!
    expect(view.value.providers.gateway.models[1]).toEqual(original)
    expect(schemaLevels(view.schema)).toContain('minimal')
    await f.settings.write('llm-pi-ai', (current) => {
      current.providers.gateway.models[1].name = 'Other renamed'
      return current
    })
    expect(f.raw().providers.gateway.models[1]).toEqual({
      ...original,
      name: 'Other renamed',
    })
    f.dispose()
  })
})
