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

async function composerFixture(
  handler: (
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<any>,
) {
  const components = new Map<string, React.ComponentType<any>>()
  const events = new Map<string, Set<(...args: any[]) => void>>()
  const subscribe = (name: string, listener: (...args: any[]) => void) => {
    const entries = events.get(name) ?? new Set()
    events.set(name, entries)
    entries.add(listener)
    return () => {
      entries.delete(listener)
    }
  }
  let selection = { current: { provider: 'fixture', model: 'gpt-custom' } }
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getSnapshot: () => selection,
  }
  const rpc = vi.fn(
    (
      _channel: string,
      endpoint: string,
      payload: { args: Record<string, unknown> },
      signal?: AbortSignal,
    ) => handler(endpoint, payload.args, signal),
  )
  loadClient().apply({
    get: () => ({ directoryFor: () => ({ store }) }),
    on: subscribe,
    remote: { $on: subscribe },
    connection: { rpc: { call: rpc } },
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
  })
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
  })
  return {
    container,
    rpc,
    emit: (name: string, ...args: unknown[]) => {
      for (const fn of events.get(name) ?? []) fn(...args)
    },
    select: (model: string) => {
      selection = { current: { provider: 'fixture', model } }
      for (const fn of listeners) fn()
    },
    subscriptions: () =>
      [...events.values()].reduce((sum, entries) => sum + entries.size, 0),
    unmount: () => {
      root.unmount()
      roots.splice(roots.indexOf(root), 1)
    },
  }
}

const modelMetadata = {
  enabled: true,
  serviceTiers: resolveCapabilities({ id: 'gpt-custom' }, 'fixture')
    .serviceTiers,
}

describe('built client contributions', () => {
  it('cancels a hung read on connection reset and fetches the new generation immediately', async () => {
    const pending: Array<{
      signal: AbortSignal | undefined
      finish(value: unknown): void
    }> = []
    const f = await composerFixture(async (endpoint, _args, signal) =>
      endpoint.endsWith('/modelStatus')
        ? new Promise((resolve, reject) => {
            pending.push({ signal, finish: resolve })
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          })
        : { ok: true, value: { selected: 'default', last: null } },
    )
    expect(pending).toHaveLength(1)
    await act(async () => {
      f.emit('connection/reset')
    })
    expect(pending[0]!.signal?.aborted).toBe(true)
    expect(pending).toHaveLength(2)
    await act(async () => {
      pending[1]!.finish({ ok: true, value: modelMetadata })
    })
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
    await act(async () => {
      pending[0]!.finish({
        ok: true,
        value: { enabled: false, serviceTiers: [] },
      })
    })
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
  })

  it('times out a hung read, retries with backoff and cancels pending work on unmount', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const signals: Array<AbortSignal | undefined> = []
    const f = await composerFixture(async (_endpoint, _args, signal) => {
      signals.push(signal)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    })
    expect(signals).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(signals).toHaveLength(2)
    await act(async () => {
      f.unmount()
    })
    expect(signals[1]?.aborted).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(signals).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces metadata invalidations, pauses hidden pages and releases subscriptions on unmount', async () => {
    vi.useFakeTimers()
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible')
    const pending: Array<(value: unknown) => void> = []
    const f = await composerFixture(async (endpoint) =>
      endpoint.endsWith('/modelStatus')
        ? new Promise((resolve) => pending.push(resolve))
        : { ok: true, value: { selected: 'default', last: null } },
    )
    const metadataCalls = () =>
      f.rpc.mock.calls.filter((call) => call[1].endsWith('/modelStatus')).length
    expect(metadataCalls()).toBe(1)
    await act(async () => {
      for (let index = 0; index < 20; index++)
        f.emit('llm/models-updated', 'fixture')
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(metadataCalls()).toBe(1)
    await act(async () => {
      pending.shift()!({ ok: true, value: modelMetadata })
    })
    expect(metadataCalls()).toBe(2)
    await act(async () => {
      pending.shift()!({ ok: true, value: modelMetadata })
    })
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
    await act(async () => {
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      f.emit('settings/document-updated', 'llm-pi-ai')
    })
    const before = f.rpc.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(f.rpc).toHaveBeenCalledTimes(before)
    await act(async () => {
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(metadataCalls()).toBe(3)
    await act(async () => {
      f.unmount()
      pending.shift()!({ ok: true, value: modelMetadata })
    })
    expect(f.subscriptions()).toBe(0)
    const stopped = f.rpc.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(f.rpc).toHaveBeenCalledTimes(stopped)
    expect(
      f.rpc.mock.calls.some((call) => call[1] === 'gptModels/status'),
    ).toBe(false)
  })

  it('retries failed initial metadata and returns to event-driven reads after success', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let attempts = 0
    const f = await composerFixture(async (endpoint) => {
      if (endpoint.endsWith('/modelStatus')) {
        if (++attempts === 1) throw new Error('temporary failure')
        return { ok: true, value: modelMetadata }
      }
      return { ok: true, value: { selected: 'default', last: null } }
    })
    expect(attempts).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(attempts).toBe(2)
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(attempts).toBe(2)
    await act(async () => {
      f.emit('connection/reset')
    })
    expect(attempts).toBe(3)
  })

  it('ignores metadata from a previously selected model', async () => {
    let finish: (value: unknown) => void
    const f = await composerFixture(async (endpoint, args) => {
      if (endpoint.endsWith('/modelStatus'))
        return args.modelId === 'gpt-custom'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : { ok: true, value: modelMetadata }
      return { ok: true, value: { selected: 'default', last: null } }
    })
    await act(async () => {
      f.select('gpt-new')
    })
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
    await act(async () => {
      finish!({ ok: true, value: { enabled: false, serviceTiers: [] } })
    })
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
  })

  it('does not reuse the previous model capability to query an unsupported model', async () => {
    const f = await composerFixture(async (endpoint, args) => ({
      ok: true,
      value: endpoint.endsWith('/modelStatus')
        ? args.modelId === 'gpt-custom'
          ? modelMetadata
          : { enabled: false, serviceTiers: [] }
        : { selected: 'default', last: null },
    }))
    expect(f.container.querySelector('[aria-haspopup=menu]')).not.toBeNull()
    await act(async () => {
      f.select('unsupported')
    })
    expect(f.container.querySelector('[aria-haspopup=menu]')).toBeNull()
    expect(
      f.rpc.mock.calls.some(
        (call) =>
          call[1].endsWith('/speed') && call[2].args.modelId === 'unsupported',
      ),
    ).toBe(false)
  })

  it('refreshes after a speed write without accepting the older pending read', async () => {
    let selected = 'default'
    let finish!: (value: unknown) => void
    let reads = 0
    const f = await composerFixture(async (endpoint, args) => {
      if (endpoint.endsWith('/modelStatus'))
        return { ok: true, value: modelMetadata }
      if (endpoint.endsWith('/setSpeed')) {
        selected = String(args.tier)
        return { ok: true }
      }
      if (++reads === 1)
        return new Promise((resolve) => {
          finish = resolve
        })
      return { ok: true, value: { selected, last: null } }
    })
    await act(async () => {
      f.container
        .querySelector<HTMLButtonElement>('[aria-haspopup=menu]')!
        .click()
    })
    await act(async () => {
      ;[...f.container.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
        .find((button) => button.textContent === 'Fast')!
        .click()
    })
    expect(reads).toBe(1)
    await act(async () => {
      finish({ ok: true, value: { selected: 'default', last: null } })
    })
    expect(reads).toBe(2)
    expect(
      f.container
        .querySelector('[aria-haspopup=menu]')!
        .getAttribute('aria-label'),
    ).toBe('GPT 速度：Fast')
  })
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
      'exports.apply',
      'exports.ModelListEditor = ModelListEditor; exports.apply',
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
      on: () => () => {},
      remote: { $on: () => () => {} },
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
      'exports.apply',
      'exports.ModelReasoningEfforts = ModelReasoningEfforts; exports.apply',
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
      on: () => () => {},
      remote: { $on: () => () => {} },
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
                endpoint === 'gptModels/modelStatus'
                  ? {
                      enabled: true,
                      serviceTiers:
                        status.capabilities['gpt-custom']!.serviceTiers,
                    }
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
    expect(calls).not.toContain('gptModels/status')
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
