import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { GptModels } from '../src/host.js'
import { installSettingsOverlay } from '../src/settings-overlay.js'

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

function fixture(
  inherited: Record<string, any>,
  user: Record<string, any>,
  overrides: Record<string, any> = {},
) {
  const base = {
    providers: {
      fixture: {
        api: 'openai-responses',
        baseURL: 'https://fixture.invalid/v1',
        ...structuredClone(inherited),
      },
    },
  }
  let raw: any = { providers: { fixture: structuredClone(user) } }
  let revision = 1
  let failCleanup = false
  const legacy = structuredClone(overrides)
  const normalize = (value: any) => ({
    providers: Config(value).providers.get(),
  })
  const value = () =>
    normalize({
      providers: {
        fixture: { ...base.providers.fixture, ...raw.providers.fixture },
      },
    })
  const entry = { options: { id: 'llm-pi-ai' }, fiber: { runtime: { Config } } }
  // Exercise native path mutations, validation, revision checks, and rollback
  // using an in-memory editor instead of changing any profile files.
  const settings: any = Object.create(SettingsForms.prototype)
  settings.ownerContext = {
    configEditor: {
      entries: () => [entry],
      edit: async (
        _entry: unknown,
        change: (current: any, inherited: any) => any,
      ) => {
        const next = change(structuredClone(raw), structuredClone(base))
        Config(next)
        raw = next
        revision++
      },
    },
  }
  settings.describe = () => [
    {
      ns: 'llm-pi-ai',
      schema: Config.toJSON(),
      revision,
      value: value(),
      user: structuredClone(raw),
      base: normalize(base),
    },
    { ns: 'compaction-basic', value: { headroomTokens: 65536 } },
  ]
  // These service methods need only settings and snapshot metadata.
  const service: any = Object.create(GptModels.prototype)
  service.nativeDescribe = settings.describe.bind(settings)
  service.options = {
    routes: {
      fixture: {
        enabled: true,
        refreshIntervalMs: 1800000,
        overridesJSON: JSON.stringify(legacy),
      },
    },
  }
  service.snapshots = new Map([
    [
      'fixture',
      {
        models: [
          { id: 'gpt-example', capabilities: { contextWindow: 800000 } },
        ],
        capabilities: {},
      },
    ],
  ])
  const dispose = installSettingsOverlay(
    settings,
    (provider, model, profile) =>
      service.capability(provider, model.id, model.name, profile),
    {
      editableContext: (provider, model) =>
        service.editableContextWindow(provider, model),
      validate: (provider, model, profile) =>
        service.validateContextWindow(provider, model, profile),
      revision: () => 1,
      saved: async (edits) => {
        if (failCleanup) throw new Error('legacy cleanup failed')
        for (const edit of edits) delete legacy[edit.modelId]?.contextWindow
        service.options.routes.fixture.overridesJSON = JSON.stringify(legacy)
      },
    },
  )
  disposers.push(dispose)
  return {
    settings,
    service,
    legacy,
    raw: () => raw.providers.fixture,
    value: () => value().providers.fixture!,
    failCleanup: () => {
      failCleanup = true
    },
    async saveModels(change: (models: any[]) => void) {
      const opened = settings.describe()[0]
      const models = structuredClone(
        opened.user.providers.fixture.models ??
          opened.base.providers.fixture.models,
      )
      change(models)
      await settings.mutate(
        'llm-pi-ai',
        [
          {
            op: 'set',
            path: ['providers', 'fixture', 'models'],
            value: models,
          },
        ],
        opened.revision,
      )
    },
    async setDefaults(change: (profile: any) => void) {
      await settings.write(
        'llm-pi-ai',
        (current: any) => {
          change(current.providers.fixture)
          return current
        },
        settings.describe()[0].revision,
      )
    },
  }
}

describe('native context edits with inherited configuration', () => {
  it('clears an inherited row and only its legacy context override', async () => {
    const f = fixture(
      {
        models: [
          { id: 'gpt-example', contextWindow: 300000, maxTokens: 50000 },
        ],
      },
      { apiKeyEnv: 'TEST_KEY' },
      {
        'gpt-example': { contextWindow: 600000, defaultServiceTier: 'fast' },
        'gpt-other': { contextWindow: 700000 },
      },
    )
    expect(
      f.settings.describe()[0].base.providers.fixture.models[0].contextWindow,
    ).toBe(600000)
    await f.saveModels((models) => {
      delete models[0].contextWindow
    })
    expect(f.raw().models[0]).not.toHaveProperty('contextWindow')
    expect(f.raw().models[0].maxTokens).toBe(50000)
    expect(f.legacy).toEqual({
      'gpt-example': { defaultServiceTier: 'fast' },
      'gpt-other': { contextWindow: 700000 },
    })
    expect(f.service.contextWindow('fixture', 'gpt-example')).toMatchObject({
      mode: 'default',
      effectiveTokens: 800000,
      source: 'upstream',
    })
  })

  it.each(['model', 'provider'] as const)(
    'rejects an unsafe reset to an inherited provider default (%s)',
    async (field) => {
      const f = fixture(
        { defaultContextWindow: 100000 },
        field === 'model'
          ? {
              models: [
                { id: 'gpt-example', contextWindow: 500000, maxTokens: 50000 },
              ],
            }
          : {
              defaultContextWindow: 500000,
              models: [{ id: 'gpt-example', maxTokens: 50000 }],
            },
      )
      const before = structuredClone(f.raw())
      const save =
        field === 'model'
          ? f.saveModels((models) => {
              delete models[0].contextWindow
            })
          : f.setDefaults((profile) => {
              delete profile.defaultContextWindow
            })
      await expect(save).rejects.toThrow('上下文窗口必须大于')
      expect(f.raw()).toEqual(before)
      expect(
        f.service.contextWindow('fixture', 'gpt-example').effectiveTokens,
      ).toBe(500000)
    },
  )

  it('uses the same inherited capacity for a successful reset and runtime resolution', async () => {
    const f = fixture(
      { defaultContextWindow: 300000 },
      {
        models: [
          { id: 'gpt-example', contextWindow: 500000, maxTokens: 50000 },
        ],
      },
    )
    await f.saveModels((models) => {
      delete models[0].contextWindow
    })
    expect(f.value().defaultContextWindow).toBe(300000)
    expect(f.service.contextWindow('fixture', 'gpt-example')).toMatchObject({
      mode: 'default',
      effectiveTokens: 300000,
      source: 'provider-default',
    })
  })

  it('keeps an explicit value equal to the automatic value on an inherited row', async () => {
    const f = fixture(
      { models: [{ id: 'gpt-example', maxTokens: 50000 }] },
      { apiKeyEnv: 'TEST_KEY' },
    )
    expect(
      f.settings.describe()[0].base.providers.fixture.models[0],
    ).not.toHaveProperty('contextWindow')
    await f.saveModels((models) => {
      models[0].contextWindow = 800000
    })
    expect(f.raw().models[0].contextWindow).toBe(800000)
    expect(f.service.contextWindow('fixture', 'gpt-example').source).toBe(
      'native-user',
    )
  })

  it('restores the inherited native capacity when legacy cleanup fails', async () => {
    const f = fixture(
      {
        models: [
          { id: 'gpt-example', contextWindow: 300000, maxTokens: 50000 },
        ],
      },
      { apiKeyEnv: 'TEST_KEY' },
      { 'gpt-example': { contextWindow: 600000 } },
    )
    f.failCleanup()
    await expect(
      f.saveModels((models) => {
        delete models[0].contextWindow
        models[0].name = 'Renamed'
      }),
    ).rejects.toThrow('legacy cleanup failed')
    expect(f.raw().models[0]).toMatchObject({
      contextWindow: 300000,
      name: 'Renamed',
      maxTokens: 50000,
    })
    expect(
      f.service.contextWindow('fixture', 'gpt-example').effectiveTokens,
    ).toBe(600000)
  })

  it('checks inherited models for provider budget edits without materializing their array', async () => {
    const f = fixture(
      { models: [{ id: 'gpt-example', contextWindow: 516000 }] },
      { apiKeyEnv: 'TEST_KEY' },
    )
    await expect(
      f.setDefaults((profile) => {
        profile.defaultMaxTokens = 500000
      }),
    ).rejects.toThrow('上下文窗口必须大于')
    expect(f.raw()).not.toHaveProperty('models')
    expect(f.raw()).not.toHaveProperty('defaultMaxTokens')
    await f.setDefaults((profile) => {
      profile.defaultMaxTokens = 16000
    })
    expect(f.raw().defaultMaxTokens).toBe(16000)
    expect(f.raw()).not.toHaveProperty('models')
  })

  it('allows unrelated edits without persisting automatic capacities or legacy values', async () => {
    const f = fixture(
      { models: [{ id: 'gpt-example', maxTokens: 50000 }] },
      { apiKeyEnv: 'TEST_KEY' },
      { 'gpt-example': { contextWindow: 600000 } },
    )
    await f.saveModels((models) => {
      models[0].name = 'Renamed'
    })
    expect(f.raw().models[0]).not.toHaveProperty('contextWindow')
    expect(f.legacy['gpt-example'].contextWindow).toBe(600000)
  })
})
