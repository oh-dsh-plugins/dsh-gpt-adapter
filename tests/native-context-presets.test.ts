// @vitest-environment jsdom
import React, { act, forwardRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { isGptModel, resolveCapabilities } from '../src/capabilities.js'
import { validContextWindow } from '../src/context-window.js'
import { installSettingsOverlay } from '../src/settings-overlay.js'
import {
  ContextWindowPreset,
  ContextWindowPresetScope,
} from '../src/client/context-window-preset.js'

const require = createRequire(import.meta.url)
const { nativeContextSettingsSource } = await import(
  pathToFileURL(resolve('scripts/native-context-settings.mjs')).href
)
const adapted = nativeContextSettingsSource()
const roots: Root[] = []
const cleanup: Array<() => void> = []
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  for (const dispose of cleanup.splice(0)) dispose()
  document.body.innerHTML = ''
})

function modules(name: string): any {
  if (name === '@deepseek-ai/dsh-client-store') return {}
  if (name !== '@deepseek-ai/dsh-client-ui-primitives') return require(name)
  return new Proxy(
    {
      AnimatedRows: ({ children }: any) =>
        React.createElement('div', null, children),
      Tooltip: ({ children }: any) => children,
      Modal: ({ open, children, footer }: any) =>
        open ? React.createElement('div', null, children, footer) : null,
      Button: forwardRef(({ variant, size, icon, ...props }: any, ref: any) =>
        React.createElement('button', { ...props, ref }),
      ),
      Input: forwardRef((props: any, ref: any) =>
        React.createElement('input', { ...props, ref }),
      ),
      Switch: ({ checked, label, disabled, onChange }: any) =>
        React.createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-label': label,
          'aria-checked': checked,
          disabled,
          onClick: () => onChange(!checked),
        }),
      useRowDragPreview: () => ({ start() {}, clear: () => false }),
      useAnchoredPosition: () => ({ left: 0, top: 0 }),
    },
    {
      get: (target, key) =>
        target[key as keyof typeof target] ??
        (() => React.createElement('span')),
    },
  )
}

function nativeComponents() {
  return new Function(
    'require',
    'ContextWindowPreset',
    'validContextWindow',
    'isGptModel',
    adapted.body,
  )(modules, ContextWindowPreset, validContextWindow, isGptModel)
}

async function editor(initial: any[], disabled = false, enabled = true) {
  const native = nativeComponents()
  let draft = initial
  const onBusyChange = () => {}
  function Editor() {
    const [models, setModels] = React.useState(initial)
    draft = models
    return React.createElement(
      ContextWindowPresetScope.Provider,
      { value: enabled },
      React.createElement(native.ModelListEditor, {
        models,
        onChange: setModels,
        onBusyChange,
        disabled,
        probe: { settingsNs: 'llm-pi-ai', provider: 'fixture' },
        operations: {},
        t: (key: string) => key,
      }),
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(React.createElement(Editor)))
  return {
    container,
    native,
    draft: () => draft,
    async open(position = 1) {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="modelAdvanced ' + position + '"]',
          )!
          .click(),
      )
    },
    select(position = 1) {
      return container.querySelector<HTMLSelectElement>(
        'select[aria-label="contextWindow ' + position + '"]',
      )!
    },
    custom(position = 1) {
      return container.querySelector<HTMLInputElement>(
        'input[aria-label="contextWindow ' + position + ' 自定义数值"]',
      )
    },
    async choose(mode: string, position = 1) {
      await act(async () => {
        const select = this.select(position)
        select.value = mode
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    },
    async type(value: string, position = 1) {
      await act(async () => {
        const input = this.custom(position)!
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
  }
}

describe('preset selector in the native context field', () => {
  it('offers four choices at the original field and shows an input only for custom', async () => {
    const f = await editor([
      {
        id: 'gpt-example',
        maxTokens: 2048,
        input: ['text', 'image'],
        reasoningEfforts: false,
      },
    ])
    await f.open()
    expect(
      Array.from(f.select().options).map((option) => option.textContent),
    ).toEqual(['默认', '516K', '1M', '自定义'])
    expect(f.select().value).toBe('default')
    expect(f.custom()).toBeNull()
    expect(
      f.container.querySelector('input[aria-label="contextWindow 1"]'),
    ).toBeNull()
    await f.choose('516k')
    expect(f.draft()[0].contextWindow).toBe(516000)
    expect(f.custom()).toBeNull()
    await f.choose('1m')
    expect(f.draft()[0].contextWindow).toBe(1000000)
    expect(f.custom()).toBeNull()
    await f.choose('custom')
    expect(f.custom()!.value).toBe('1M')
    await f.type('750001')
    expect(f.draft()[0].contextWindow).toBe(750001)
    expect(f.custom()!.getAttribute('aria-invalid')).toBe('false')
    await f.choose('default')
    expect(f.draft()[0]).not.toHaveProperty('contextWindow')
    expect(f.custom()).toBeNull()
    expect(f.draft()[0]).toMatchObject({
      maxTokens: 2048,
      input: ['text', 'image'],
    })
    expect(
      f.container.querySelector<HTMLInputElement>(
        'input[aria-label="maxTokens 1"]',
      )!.value,
    ).toBe('2048')
  })

  it('keeps empty or invalid custom drafts invalid in the unchanged native validator', async () => {
    const f = await editor([{ id: 'gpt-example', reasoningEfforts: false }])
    await f.open()
    await f.choose('custom')
    expect(f.custom()!.value).toBe('')
    await f.open() // Collapse and reopen an empty custom draft.
    await f.open()
    expect(f.select().value).toBe('custom')
    expect(f.custom()!.value).toBe('')
    expect(f.native.validateDeepSeekModels(f.draft()).key).toBe(
      'modelContextInvalid',
    )
    for (const text of ['', '0', '1.5', '9007199254740992']) {
      await f.type(text)
      expect(f.custom()!.getAttribute('aria-invalid')).toBe('true')
      expect(f.native.validateDeepSeekModels(f.draft()).key).toBe(
        'modelContextInvalid',
      )
    }
    await f.type('750K')
    expect(f.draft()[0].contextWindow).toBe(750000)
    expect(f.native.validateDeepSeekModels(f.draft())).toBeUndefined()
    await f.choose('516k')
    expect(f.custom()).toBeNull()
    expect(f.native.validateDeepSeekModels(f.draft())).toBeUndefined()
  })

  it('recognizes existing custom values and preserves disabled/native non-GPT controls', async () => {
    const f = await editor(
      [{ id: 'gpt-example', contextWindow: 750000, reasoningEfforts: false }],
      true,
    )
    await f.open()
    expect(f.select().value).toBe('custom')
    expect(f.custom()!.value).toBe('750K')
    expect(f.select().disabled).toBe(true)
    expect(f.custom()!.disabled).toBe(true)
    const other = await editor([
      { id: 'claude-fixture', contextWindow: 750000, reasoningEfforts: false },
    ])
    await other.open()
    expect(other.select()).toBeNull()
    expect(
      other.container.querySelector<HTMLInputElement>(
        'input[aria-label="contextWindow 1"]',
      )!.value,
    ).toBe('750K')
    const native = await editor(
      [{ id: 'gpt-example', contextWindow: 516000, reasoningEfforts: false }],
      false,
      false,
    )
    await native.open()
    expect(native.select()).toBeNull()
    expect(
      native.container.querySelector<HTMLInputElement>(
        'input[aria-label="contextWindow 1"]',
      )!.value,
    ).toBe('516K')
  })

  it.each(['10000000', '5160000'])(
    'keeps existing custom input mounted while typing %s past a preset value',
    async (target) => {
      const f = await editor([
        { id: 'gpt-example', contextWindow: 750000, reasoningEfforts: false },
      ])
      await f.open()
      for (const reopen of [false, true]) {
        if (reopen) {
          await f.type('750000')
          await f.open()
          await f.open()
        }
        const input = f.custom()!
        expect(f.select().value).toBe('custom')
        for (let length = 1; length <= target.length; length++) {
          const text = target.slice(0, length)
          await f.type(text)
          expect(f.select().value).toBe('custom')
          expect(f.custom()).toBe(input)
          expect(input.value).toBe(text)
        }
        expect(f.draft()[0].contextWindow).toBe(Number(target))
        expect(f.native.validateDeepSeekModels(f.draft())).toBeUndefined()
      }
      await f.choose('1m')
      expect(f.select().value).toBe('1m')
      expect(f.custom()).toBeNull()
      expect(f.draft()[0].contextWindow).toBe(1000000)
      await f.choose('default')
      expect(f.custom()).toBeNull()
      expect(f.draft()[0]).not.toHaveProperty('contextWindow')
    },
  )

  it('keeps custom text attached to the native row when reordering', async () => {
    const f = await editor([
      { id: 'gpt-first', contextWindow: 750000, reasoningEfforts: false },
      { id: 'gpt-second', reasoningEfforts: false },
    ])
    await f.open(1)
    await f.open(2)
    await f.type('750.')
    await act(async () => {
      f.container
        .querySelector('button[aria-label="reorderModel 1"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        )
    })
    expect(f.draft()[1].id).toBe('gpt-first')
    expect(f.custom(2)!.value).toBe('750.')
    await f.type('750K', 2)
    expect(f.draft()[1].contextWindow).toBe(750000)
  })

  it('saves selected values through the native writer and leaves canceled drafts unsaved', async () => {
    let raw: any = {
      providers: {
        fixture: {
          api: 'openai-responses',
          models: [
            { id: 'gpt-example', maxTokens: 2048, reasoningEfforts: false },
          ],
        },
      },
    }
    let automatic = 1000000
    let revision = 1
    const entry = {
      options: { id: 'llm-pi-ai' },
      fiber: { runtime: { Config } },
    }
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
          revision++
        },
      },
    }
    settings.describe = () => [
      {
        ns: 'llm-pi-ai',
        revision,
        schema: Config.toJSON(),
        value: structuredClone(raw),
        user: structuredClone(raw),
        base: {},
      },
    ]
    cleanup.push(
      installSettingsOverlay(settings, (_provider, model) => ({
        ...resolveCapabilities({ id: model.id }, 'fixture'),
        contextWindow:
          raw.providers.fixture.models[0].contextWindow ?? automatic,
      })),
    )
    const f = await editor(settings.describe()[0].user.providers.fixture.models)
    await f.open()
    const save = () =>
      settings.mutate(
        'llm-pi-ai',
        [
          {
            op: 'set',
            path: ['providers', 'fixture', 'models'],
            value: structuredClone(f.draft()),
          },
        ],
        settings.describe()[0].revision,
      )
    await f.choose('1m')
    expect(raw.providers.fixture.models[0]).not.toHaveProperty('contextWindow')
    await save()
    expect(raw.providers.fixture.models[0].contextWindow).toBe(1000000)
    automatic = 2000000
    expect(
      settings.describe()[0].value.providers.fixture.models[0].contextWindow,
    ).toBe(1000000)
    await f.choose('custom')
    await f.type('750000')
    // Cancel is the native editor discarding this array without settings.mutate.
    const reopened = await editor(
      settings.describe()[0].user.providers.fixture.models,
    )
    await reopened.open()
    expect(reopened.select().value).toBe('1m')
    await f.choose('default')
    await save()
    expect(raw.providers.fixture.models[0]).not.toHaveProperty('contextWindow')
    expect(
      settings.describe()[0].value.providers.fixture.models[0].contextWindow,
    ).toBe(2000000)
  })
})

function originalNative() {
  let result: any
  Object.assign(window, {
    __ModuleLoader__: {
      load: (entry: any) => {
        result = entry.factory(modules)
      },
    },
  })
  new Function(
    adapted.source.replace(
      'exports.apply = apply;',
      'exports.ModelsSection = ModelsSection; exports.apply = apply;',
    ),
  )()
  return result
}

function client() {
  let result: any
  Object.assign(window, {
    __ModuleLoader__: {
      load: (entry: any) => {
        result = entry.factory(modules)
      },
    },
  })
  new Function(readFileSync('lib/client.js', 'utf8'))()
  return result
}

describe('original native Models entry integration', () => {
  it('preserves the entry/controller/child slots and restores the native renderer on disposal', () => {
    const original = originalNative().ModelsSection
    expect(Function.prototype.toString.call(original)).toBe(
      adapted.expectedModelsSectionSource,
    )
    const inject = () => ({ controller: {}, operations: {} })
    const children = {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
    }
    const entry = {
      component: original,
      options: { id: 'models', order: 10 },
      inject,
      children,
    }
    const listeners = new Set<() => void>()
    const rootProps: Record<string, unknown> = {}
    const dispose: Array<() => void> = []
    client().apply({
      get: () => undefined,
      slots: {
        entries: () => [entry],
        subscribe: (_key: string, listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        provideRoot: ({ props }: any) => {
          Object.assign(rootProps, props)
          return () => {
            for (const key of Object.keys(props)) delete rootProps[key]
          }
        },
        inject: (_key: string, callback: () => () => void) => {
          dispose.push(callback())
        },
        register: () => () => {},
      },
    })
    expect(entry.component).not.toBe(original)
    expect(entry.inject).toBe(inject)
    expect(entry.children).toBe(children)
    expect(rootProps.gptContextPresetControls).toBe(true)
    for (const fn of dispose.reverse()) fn()
    expect(entry.component).toBe(original)
    expect(rootProps).toEqual({})
    expect(listeners.size).toBe(0)
    expect(
      readFileSync(
        require.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'),
        'utf8',
      ),
    ).toBe(adapted.source)
  })

  it('publishes and removes the preset policy through the real slot renderer', async () => {
    let renderer: any
    Object.assign(window, {
      __ModuleLoader__: {
        load: (entry: any) => {
          renderer = entry.factory(modules)
        },
      },
    })
    new Function(
      readFileSync(
        require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'),
        'utf8',
      ),
    )()
    const { Context } = require('@deepseek-ai/cordis')
    const ctx = new Context()
    renderer.apply(ctx)
    const flags: unknown[] = []
    const slots = ctx.slots
    const absentBinding = {
      key: undefined,
      hooks: {},
      keyedHooks: {},
      props: {},
    }
    const absentSource = {
      getSnapshot: () => absentBinding,
      subscribe: () => () => {},
    }
    slots.installScope('session', {
      current: absentSource,
      bindingSource: () => absentSource,
    })
    slots.register(
      {
        name: 'root',
        children: { 'settings.section': { kind: 'list', scope: 'root' } },
      },
      (props: any) => {
        flags.push(props.gptContextPresetControls)
        return React.createElement(
          'main',
          null,
          props.renderSlot('settings.section', {}),
        )
      },
    )
    const original = originalNative().ModelsSection
    slots.register(
      {
        name: 'settings.section',
        id: 'models',
        children: {
          'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
          'settings.models.footer': { kind: 'list', scope: 'root' },
        },
      },
      original,
    )
    const entry = slots.entries('settings.section')[0]
    const container = document.createElement('div')
    document.body.append(container)
    let unmount!: () => void
    await act(async () => {
      unmount = ctx.uiRenderer.mount(container)
    })
    const dispose: Array<() => void> = []
    await act(async () => {
      client().apply({
        get: (name: string) => ctx.get(name),
        slots: {
          entries: (name: any) => slots.entries(name),
          subscribe: (name: any, fn: any) => slots.subscribe(name, fn),
          provideRoot: (contribution: any) => slots.provideRoot(contribution),
          register: (options: any, component: any) =>
            slots.register(options, component),
          inject: (name: any, callback: any) => {
            const release = slots.inject(name, callback)
            dispose.push(release)
            return release
          },
        },
      })
    })
    expect(flags.at(-1)).toBe(true)
    expect(entry.component).not.toBe(original)
    await act(async () => {
      for (const fn of dispose.reverse()) fn()
    })
    expect(flags.at(-1)).toBeUndefined()
    expect(entry.component).toBe(original)
    await act(async () => unmount())
    await ctx.fiber.dispose()
  })

  it('rejects an incompatible native renderer without replacing it', () => {
    const original = () => null
    const entry = {
      component: original,
      options: { id: 'models' },
      children: {
        'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      },
    }
    expect(() =>
      client().apply({
        slots: {
          entries: () => [entry],
          subscribe: () => () => {},
          provideRoot: () => {
            throw new Error('must not publish')
          },
          inject: (_key: string, callback: () => void) => callback(),
          register: () => () => {},
        },
      }),
    ).toThrow('原生模型设置组件与已核验版本不一致')
    expect(entry.component).toBe(original)
  })
})
