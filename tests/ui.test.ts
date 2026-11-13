// @vitest-environment jsdom
import React, { act, forwardRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCapabilities } from '../src/capabilities.js'
import { Config as NativeConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { installSettingsOverlay } from '../src/settings-overlay.js'

const require = createRequire(import.meta.url)
const roots: Root[] = []
const disposers: Array<() => void> = []
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function modules(name: string) {
  if (name === '@deepseek-ai/dsh-client-store') return {}
  if (name !== '@deepseek-ai/dsh-client-ui-primitives') return require(name)
  return new Proxy(
    {
      Button: forwardRef<
        HTMLButtonElement,
        React.ButtonHTMLAttributes<HTMLButtonElement> & {
          variant?: string
          size?: string
          icon?: unknown
        }
      >(({ variant, size, icon, ...props }, ref) =>
        React.createElement('button', { ...props, ref }),
      ),
      Input: forwardRef<
        HTMLInputElement,
        React.InputHTMLAttributes<HTMLInputElement>
      >((props, ref) => React.createElement('input', { ...props, ref })),
      Menu: ({
        open,
        anchor,
        items,
        onSelect,
      }: {
        open: boolean
        anchor: React.ReactNode
        items: Array<{ id: string; label: string }>
        onSelect(id: string): void
      }) =>
        React.createElement(
          'div',
          null,
          anchor,
          open &&
            items.map((item) =>
              React.createElement(
                'button',
                {
                  key: item.id,
                  role: 'menuitem',
                  onClick: () => onSelect(item.id),
                },
                item.label,
              ),
            ),
        ),
      Switch: ({
        checked,
        disabled,
        label,
        onChange,
      }: {
        checked: boolean
        disabled: boolean
        label: string
        onChange(value: boolean): void
      }) =>
        React.createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          disabled,
          onClick: () => onChange(!checked),
        }),
      AnimatedRows: ({ children }: { children: React.ReactNode }) =>
        React.createElement('div', null, children),
      Tooltip: ({ children }: { children: React.ReactNode }) => children,
      useRowDragPreview: () => ({ start() {}, clear: () => false }),
      useAnchoredPosition: () => ({ left: 20, top: 20 }),
      rankByName: (rows: unknown[]) => rows,
      isMobileDevice: () => false,
      observeStickyMenuGroups: () => () => {},
      MenuSurface: forwardRef<
        HTMLDivElement,
        React.HTMLAttributes<HTMLDivElement>
      >((props, ref) => React.createElement('div', { ...props, ref })),
    },
    {
      get(target, key) {
        return (
          target[key as keyof typeof target] ??
          (() => React.createElement('span'))
        )
      },
    },
  )
}

function loadClient() {
  let exports: { apply(ctx: unknown): void } | undefined
  const source = readFileSync('lib/client.js', 'utf8')
  Object.assign(window, {
    __ModuleLoader__: {
      load: (entry: {
        factory(require: (name: string) => unknown): typeof exports
      }) => {
        exports = entry.factory(modules)
      },
    },
  })
  new Function(source)()
  return exports!
}

describe('built client contributions', () => {
  it('reuses the native context field for K/M values and blank inheritance', async () => {
    let native: any
    Object.assign(window, {
      __ModuleLoader__: {
        load: (entry: any) => {
          native = entry.factory(modules)
        },
      },
    })
    const source = readFileSync(
      require.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'),
      'utf8',
    ).replace(
      'exports.apply = apply;',
      'exports.ModelListEditor = ModelListEditor; exports.apply = apply;',
    )
    new Function(source)()
    let automatic = 800000
    let raw: any = {
      providers: {
        fixture: {
          api: 'openai-responses',
          models: [
            {
              id: 'gpt-example',
              name: 'Original',
              maxTokens: 2048,
              input: ['text', 'image'],
              reasoningEfforts: false,
            },
          ],
        },
      },
    }
    const settings = {
      describe: () => [
        {
          ns: 'llm-pi-ai',
          schema: NativeConfig.toJSON(),
          value: structuredClone(raw),
          user: structuredClone(raw),
          base: {},
        },
      ],
      async write(
        _ns: string,
        change: (current: any, base: any, schema: any) => any,
      ) {
        const next = change(structuredClone(raw), {}, NativeConfig)
        NativeConfig(next)
        raw = next
      },
    }
    disposers.push(
      installSettingsOverlay(settings, (_provider, model) => ({
        ...resolveCapabilities({ id: model.id }, 'fixture'),
        contextWindow:
          raw.providers.fixture.models[0].contextWindow ?? automatic,
      })),
    )
    const initial = settings.describe()[0]!.user.providers.fixture.models
    let draft = initial
    const onBusyChange = () => {}
    function Editor() {
      const [models, setModels] = React.useState(initial)
      draft = models
      return React.createElement(native.ModelListEditor, {
        models,
        onChange: setModels,
        onBusyChange,
        probe: { settingsNs: 'llm-pi-ai', provider: 'fixture' },
        operations: {},
        t: (key: string) => key,
        disabled: false,
      })
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(React.createElement(Editor)))
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="modelAdvanced 1"]',
        )!
        .click()
    })
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="contextWindow 1"]',
    )!
    expect(input.value).toBe('')
    const save = async () =>
      settings.write('llm-pi-ai', (current) => {
        current.providers.fixture.models = structuredClone(draft)
        return current
      })
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '800K')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await save()
    expect(raw.providers.fixture.models[0].contextWindow).toBe(800000)
    automatic = 900000
    expect(
      settings.describe()[0]!.value.providers.fixture.models[0].contextWindow,
    ).toBe(800000)
    expect(
      container.querySelectorAll('input[aria-label="contextWindow 1"]'),
    ).toHaveLength(1)
    for (const [text, tokens] of [
      ['516K', 516000],
      ['1M', 1000000],
      ['750001', 750001],
      ['', undefined],
    ] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(draft[0]!.contextWindow).toBe(tokens)
      await save()
      expect(raw.providers.fixture.models[0].contextWindow).toBe(tokens)
      expect(draft[0]).toMatchObject({
        id: 'gpt-example',
        name: 'Original',
        maxTokens: 2048,
        input: ['text', 'image'],
      })
    }
    expect(Object.hasOwn(draft[0]!, 'contextWindow')).toBe(false)
    expect(
      settings.describe()[0]!.value.providers.fixture.models[0].contextWindow,
    ).toBe(900000)
  })

  it('keeps context editing in the native form and saves a catalog URL', async () => {
    const components = new Map<string, React.ComponentType<any>>()
    const status = {
      enabled: true,
      status: { state: 'ready' },
      models: [],
      capabilities: {},
      contextRevision: 7,
      contextWindows: {
        'gpt-example': {
          mode: 'custom',
          effectiveTokens: 272000,
          defaultTokens: 800000,
          source: 'native-user',
        },
      },
      options: {
        enabled: true,
        refreshIntervalMs: 1800000,
        overridesJSON: '{}',
      },
    }
    const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
    const ctx = {
      menuReady: false,
      get() {
        return undefined
      },
      connection: {
        rpc: {
          call: async (
            _channel: string,
            endpoint: string,
            payload: { args: Record<string, unknown> },
          ) => {
            calls.push({ endpoint, args: payload.args })
            return { ok: true, value: status }
          },
        },
      },
      slots: {
        entries: () => [],
        subscribe: () => () => {},
        provideRoot: () => () => {},
        inject: (_key: string, callback: () => void) => callback(),
        register: (
          entry: { name: string },
          component: React.ComponentType<any>,
        ) => {
          components.set(entry.name, component)
          return () => {}
        },
      },
      effect: (callback: () => () => void) => disposers.push(callback()),
    }
    loadClient().apply(ctx)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        React.createElement(components.get('settings.models.provider-card')!, {
          provider: { provider: 'fixture' },
          configured: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.textContent).toContain('GPT 自动适配')
    expect(container.textContent).toContain('选择预设')
    expect(
      container.querySelector('input[type=number][aria-label*=上下文]'),
    ).toBeNull()
    expect(
      Array.from(container.querySelectorAll('summary')).map(
        (row) => row.textContent,
      ),
    ).not.toContain('上下文窗口')
    expect(container.querySelectorAll('select')).toHaveLength(0)
    const input = container.querySelector<HTMLInputElement>('input[type=url]')!
    expect(
      container.querySelector(`label[for="${input.id}"]`)!.textContent,
    ).toContain('能力目录 URL')
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'https://catalog.invalid/gpt.json')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(
      calls.find((call) => call.endpoint === 'gptModels/updateOptions')!.args
        .capabilityCatalogUrl,
    ).toBe('https://catalog.invalid/gpt.json')
  })

  it('renders exactly six preset rows with the unchanged native ModelReasoningEfforts component', async () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    let native: any
    Object.assign(window, {
      __ModuleLoader__: {
        load: (entry: any) => {
          native = entry.factory(modules)
        },
      },
    })
    const source = readFileSync(
      require.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'),
      'utf8',
    ).replace(
      'exports.apply = apply;',
      'exports.ModelReasoningEfforts = ModelReasoningEfforts; exports.apply = apply;',
    )
    new Function(source)()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        React.createElement(native.ModelReasoningEfforts, {
          model: {
            id: 'gpt-example',
            reasoningEfforts: Object.fromEntries(
              levels.map((level) => [level, level]),
            ),
          },
          levels,
          position: 1,
          disabled: false,
          t: (key: string) => key,
          onChange: () => {},
        }),
      )
    })
    expect(
      Array.from(container.querySelectorAll('select')).map(
        (select) => select.value,
      ),
    ).toEqual(levels)
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type=text]'),
      ).map((input) => input.value),
    ).toEqual(levels)
    expect(
      Array.from(container.querySelectorAll('option')).some((option) =>
        ['off', 'minimal'].includes(option.value),
      ),
    ).toBe(false)
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.includes('modelReasoningAdd'),
      )!.disabled,
    ).toBe(true)
  })

  it('keeps the existing model directory and saves speed through the native composer slot', async () => {
    const components = new Map<string, React.ComponentType<any>>()
    let selected = 'default'
    const calls: string[] = []
    const status = {
      enabled: true,
      status: { state: 'ready' },
      models: [],
      options: {
        enabled: true,
        refreshIntervalMs: 1800000,
        overridesJSON: '{}',
      },
      capabilities: {
        'gpt-custom': resolveCapabilities({ id: 'gpt-custom' }, 'fixture'),
      },
    }
    const snapshot = { current: { provider: 'fixture', model: 'gpt-custom' } }
    const store = { subscribe: () => () => {}, getSnapshot: () => snapshot }
    const directory = { directoryFor: () => ({ store }) }
    const ctx = {
      get: () => directory,
      connection: {
        rpc: {
          call: async (
            _: string,
            endpoint: string,
            payload: { args: Record<string, unknown> },
          ) => {
            calls.push(endpoint)
            if (endpoint === 'gptModels/setSpeed') {
              selected = String(payload.args.tier)
              return { ok: true, value: undefined }
            }
            return {
              ok: true,
              value:
                endpoint === 'gptModels/status'
                  ? status
                  : { selected, last: null },
            }
          },
        },
      },
      slots: {
        entries: () => [],
        subscribe: () => () => {},
        provideRoot: () => () => {},
        inject: (_: string, fn: () => void) => fn(),
        register: (
          entry: { name: string },
          component: React.ComponentType<any>,
        ) => {
          components.set(entry.name, component)
          return () => {}
        },
      },
    }
    loadClient().apply(ctx)
    expect(components.has('conversation.input.model')).toBe(false)
    expect(components.has('conversation.input.left')).toBe(true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        React.createElement(components.get('conversation.input.left')!, {
          sessionId: 'fixture-session',
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-haspopup=menu]',
    )!
    expect(trigger.getAttribute('aria-label')).toBe('GPT 速度：Standard')
    await act(async () => {
      trigger.click()
    })
    const fast = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Fast')!
    await act(async () => {
      fast.click()
    })
    expect(calls).toContain('gptModels/setSpeed')
    expect(trigger.getAttribute('aria-label')).toBe('GPT 速度：Fast')
    await act(async () => {
      trigger.click()
    })
    const standard = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Standard')!
    await act(async () => {
      standard.click()
    })
    expect(trigger.getAttribute('aria-label')).toBe('GPT 速度：Standard')
  })
})
