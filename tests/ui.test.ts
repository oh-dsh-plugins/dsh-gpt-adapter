// @vitest-environment jsdom
import React, { act, forwardRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCapabilities } from '../src/capabilities.js'

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
  it.each(['resolve', 'reject'] as const)(
    'ignores an old poll that %ss after a successful context save',
    async (completion) => {
      vi.useFakeTimers()
      const components = new Map<string, React.ComponentType<any>>()
      const status = {
        enabled: true,
        status: { state: 'ready' },
        models: [],
        capabilities: {},
        options: {
          enabled: true,
          refreshIntervalMs: 1800000,
          overridesJSON: '{}',
        },
        contextRevision: 1,
        contextWindows: {
          'gpt-example': {
            mode: 'default',
            effectiveTokens: 1000000,
            defaultTokens: 1000000,
            source: 'upstream',
          },
        },
      }
      let reads = 0
      let finishPoll!: () => void
      let finishSave!: () => void
      const saves: any[] = []
      loadClient().apply({
        get: () => undefined,
        connection: {
          rpc: {
            call: async (_channel: string, endpoint: string, { args }: any) => {
              if (endpoint === 'gptModels/setContextWindow') {
                saves.push(args)
                if (saves.length === 1)
                  await new Promise<void>((resolve) => {
                    finishSave = resolve
                  })
                if (args.expectedRevision !== status.contextRevision)
                  return { ok: false, error: { message: '设置冲突' } }
                status.contextRevision++
                status.contextWindows['gpt-example'] = {
                  mode: args.mode,
                  effectiveTokens: args.mode === '516k' ? 516000 : 1000000,
                  defaultTokens: 1000000,
                  source: 'native-user',
                }
                return { ok: true }
              }
              const captured = structuredClone(status)
              if (++reads === 2)
                return new Promise((resolve, reject) => {
                  finishPoll = () =>
                    completion === 'resolve'
                      ? resolve({ ok: true, value: captured })
                      : reject(new Error('old poll failed'))
                })
              return { ok: true, value: captured }
            },
          },
        },
        slots: {
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
      })
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      roots.push(root)
      await act(async () => {
        root.render(
          React.createElement(
            components.get('settings.models.provider-card')!,
            { provider: { provider: 'fixture' }, configured: true },
          ),
        )
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      const select = container.querySelector('select')!
      const edit = async (mode: string) =>
        act(async () => {
          select.value = mode
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })
      const submit = async () =>
        act(async () => {
          select
            .closest('form')!
            .dispatchEvent(
              new Event('submit', { bubbles: true, cancelable: true }),
            )
        })
      await edit('516k')
      await submit()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(reads).toBe(2)
      await act(async () => {
        finishSave()
      })
      expect(select.value).toBe('516k')
      await act(async () => {
        finishPoll()
      })
      expect(select.value).toBe('516k')
      expect(container.textContent).toContain('当前：516,000 tokens')
      expect(container.textContent).not.toContain('old poll failed')
      await edit('1m')
      await submit()
      expect(saves.at(-1).expectedRevision).toBe(2)
      expect(status.contextWindows['gpt-example'].mode).toBe('1m')
    },
  )

  it('retains drafts, rebases unrelated saves and recovers explicit same-model conflicts', async () => {
    vi.useFakeTimers()
    const components = new Map<string, React.ComponentType<any>>()
    const status = {
      enabled: true,
      status: { state: 'ready' },
      models: [],
      capabilities: {},
      options: {
        enabled: true,
        refreshIntervalMs: 1800000,
        overridesJSON: '{}',
      },
      contextRevision: 7,
      contextWindows: {
        'gpt-example': {
          mode: 'default',
          effectiveTokens: 1000000,
          defaultTokens: 1000000,
          source: 'upstream',
        },
        'gpt-second': {
          mode: 'default',
          effectiveTokens: 1000000,
          defaultTokens: 1000000,
          source: 'upstream',
        },
      },
    }
    const saves: any[] = []
    let fail = false
    loadClient().apply({
      get: () => undefined,
      connection: {
        rpc: {
          call: async (_channel: string, endpoint: string, payload: any) => {
            if (endpoint === 'gptModels/setContextWindow') {
              saves.push(payload.args)
              if (
                fail ||
                payload.args.expectedRevision !== status.contextRevision
              )
                return { ok: false, error: { message: '设置冲突，请刷新' } }
              status.contextWindows[
                payload.args.modelId as keyof typeof status.contextWindows
              ] = {
                mode: payload.args.mode,
                effectiveTokens:
                  payload.args.customTokens ??
                  (payload.args.mode === '516k' ? 516000 : 1000000),
                defaultTokens: 1000000,
                source:
                  payload.args.mode === 'default' ? 'upstream' : 'native-user',
              }
              status.contextRevision++
            }
            return { ok: true, value: structuredClone(status) }
          },
        },
      },
      slots: {
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
    })
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
    })
    const select = container.querySelector('select')!
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      '默认',
      '516K',
      '1M',
      '自定义',
    ])
    expect(select.value).toBe('default')
    expect(container.textContent).toContain(
      '当前：1,000,000 tokens · 来源：上游模型目录',
    )
    const second = container.querySelectorAll('select')[1]!
    await act(async () => {
      second.value = '516k'
      second.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      select.value = 'custom'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const input =
      container.querySelector<HTMLInputElement>('input[type=number]')!
    const changeInput = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await changeInput('')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const save = container.querySelector<HTMLButtonElement>(
      '[aria-label="保存 gpt-example 上下文"]',
    )!
    expect(save.disabled).toBe(true)
    await changeInput('750000')
    status.contextRevision = 8
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(input.value).toBe('750000')
    expect(select.value).toBe('custom')
    const submit = async () =>
      act(async () => {
        select
          .closest('form')!
          .dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          )
      })
    fail = true
    await submit()
    expect(saves[0]).toEqual({
      provider: 'fixture',
      modelId: 'gpt-example',
      mode: 'custom',
      customTokens: 750000,
      expectedRevision: 8,
    })
    expect(container.textContent).toContain('设置冲突，请刷新')
    expect(input.value).toBe('750000')
    fail = false
    await submit()
    expect(container.textContent).toContain(
      '当前：750,000 tokens · 来源：手动设置',
    )
    expect(save.disabled).toBe(true)
    await act(async () => {
      second
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(saves.at(-1)).toEqual({
      provider: 'fixture',
      modelId: 'gpt-second',
      mode: '516k',
      expectedRevision: 9,
    })
    expect(status.contextWindows['gpt-second'].effectiveTokens).toBe(516000)
    await act(async () => {
      select.value = '1m'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submit()
    expect(saves.at(-1)).toEqual({
      provider: 'fixture',
      modelId: 'gpt-example',
      mode: '1m',
      expectedRevision: 10,
    })
    expect(
      container.querySelector('[aria-label="gpt-example 自定义窗口"]'),
    ).toBeNull()
    await act(async () => {
      select.value = 'default'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submit()
    expect(saves.at(-1)).toEqual({
      provider: 'fixture',
      modelId: 'gpt-example',
      mode: 'default',
      expectedRevision: 11,
    })
    await act(async () => {
      select.value = 'custom'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const custom = container.querySelector<HTMLInputElement>(
      '[aria-label="gpt-example 自定义窗口"]',
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(custom, '720000')
      custom.dispatchEvent(new Event('input', { bubbles: true }))
    })
    status.contextRevision++
    status.contextWindows['gpt-example'] = {
      mode: '516k',
      effectiveTokens: 516000,
      defaultTokens: 1000000,
      source: 'native-user',
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(custom.value).toBe('720000')
    expect(save.disabled).toBe(true)
    const recover = container.querySelector<HTMLButtonElement>(
      '[aria-label="保留 gpt-example 草稿"]',
    )!
    expect(recover).not.toBeNull()
    await act(async () => {
      recover.click()
    })
    await submit()
    expect(saves.at(-1)).toEqual({
      provider: 'fixture',
      modelId: 'gpt-example',
      mode: 'custom',
      customTokens: 720000,
      expectedRevision: status.contextRevision - 1,
    })
    expect(status.contextWindows['gpt-example'].effectiveTokens).toBe(720000)
  })

  it('renders settings on the existing provider card and saves a catalog URL', async () => {
    const components = new Map<string, React.ComponentType<any>>()
    const status = {
      enabled: true,
      status: { state: 'ready' },
      models: [],
      capabilities: {},
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
