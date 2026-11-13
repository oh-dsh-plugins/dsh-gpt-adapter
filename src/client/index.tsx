import React, {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Button,
  Input,
  Menu,
  Switch,
  IconChevronDownOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GptModels } from '../host.js'
import type { ServiceTier } from '../types.js'
import type { ClientContext } from './compat-slots.js'
import type {
  ModelDirectoryState,
  ModelDirectoryResolver,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import styles from 'dsh-gpt-adapter/native-settings-styles'
import { installNativeContextPresets } from './native-context-settings.js'

type ProviderStatus = ReturnType<GptModels['status']>
type SpeedStatus = ReturnType<GptModels['speed']>
type ModelStatus = ReturnType<GptModels['modelStatus']>
export const inject = [
  'slots',
  'connection',
  'sessions',
  'modelDirectories',
  'remote',
]

export function apply(ctx: Context): void {
  async function call<T>(
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await (ctx as ClientContext).connection.rpc.call(
      '/api',
      `gptModels/${method}`,
      { args },
      signal,
    )
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  function useRead<T>(
    method: string,
    args: Record<string, unknown>,
    enabled: boolean,
    intervalMs = 0,
  ) {
    const [value, setValue] = useState<{ key: string; value: T }>()
    const [error, setError] = useState('')
    const controls = useRef<{
      invalidate(): void
      pause(): void
      resume(): void
    }>()
    const key = JSON.stringify(args)
    useEffect(() => {
      setValue(undefined)
      setError('')
      if (!enabled) return
      const parameters = JSON.parse(key)
      let active = true,
        running = false,
        dirty = false,
        paused = false,
        generation = 0,
        failures = 0
      let current: T | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let request: AbortController | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      const clear = () => {
        clearTimeout(timer)
        timer = undefined
      }
      const visible = () => document.visibilityState !== 'hidden'
      const cancel = () => {
        clearTimeout(deadline)
        deadline = undefined
        request?.abort()
      }
      const refresh = async () => {
        clear()
        if (!active || !visible() || paused) {
          dirty = true
          return
        }
        if (running) {
          dirty = true
          return
        }
        running = true
        dirty = false
        const sequence = generation
        const controller = new AbortController()
        request = controller
        deadline = setTimeout(
          () => controller.abort(new Error('读取 GPT 设置超时，请重试')),
          15000,
        )
        try {
          const next = await call<T>(method, parameters, controller.signal)
          if (active && sequence === generation) {
            current = next
            failures = 0
            setValue({ key, value: next })
            setError('')
          }
        } catch (failure) {
          if (active && sequence === generation) {
            failures++
            setError(
              failure instanceof Error ? failure.message : '无法读取 GPT 设置',
            )
          }
        } finally {
          clearTimeout(deadline)
          deadline = undefined
          request = undefined
          running = false
          if (active && visible() && !paused) {
            if (dirty) {
              void refresh()
              return
            }
            const delay = failures
              ? Math.min(30000, 3000 * 2 ** Math.min(failures - 1, 4))
              : method === 'status' &&
                  (current as ProviderStatus | undefined)?.status.state ===
                    'refreshing'
                ? 3000
                : intervalMs
            if (delay) timer = setTimeout(() => void refresh(), delay)
          }
        }
      }
      const invalidate = () => {
        generation++
        dirty = true
        void refresh()
      }
      const reset = () => {
        generation++
        dirty = true
        clear()
        cancel()
        void refresh()
      }
      const controller = {
        invalidate,
        pause() {
          paused = true
          generation++
          dirty = true
          clear()
          cancel()
        },
        resume() {
          paused = false
          invalidate()
        },
      }
      controls.current = controller
      const changedVisibility = () => {
        if (visible()) invalidate()
        else {
          generation++
          dirty = true
          clear()
          cancel()
        }
      }
      document.addEventListener('visibilitychange', changedVisibility)
      const disposers = [
        ctx.on('connection/reset', reset),
        ctx.remote.$on('settings/document-updated', invalidate),
        ctx.remote.$on('llm/models-updated', (provider) => {
          if (!provider || provider === parameters.provider) invalidate()
        }),
      ]
      void refresh()
      return () => {
        active = false
        generation++
        clear()
        cancel()
        document.removeEventListener('visibilitychange', changedVisibility)
        for (const dispose of disposers) dispose()
        if (controls.current === controller) controls.current = undefined
      }
    }, [method, key, enabled, intervalMs])
    return {
      value: value?.key === key ? value.value : undefined,
      error,
      refresh: () => controls.current?.invalidate(),
      pause: () => controls.current?.pause(),
      resume: () => controls.current?.resume(),
    }
  }
  function useProvider(provider: string) {
    const query = useRead<ProviderStatus>(
      'status',
      { provider },
      !!provider,
      30000,
    )
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const requests = useRef({ sequence: 0, writing: false })
    useEffect(() => {
      requests.current.sequence++
      requests.current.writing = false
      setBusy(false)
      setError('')
      return () => {
        requests.current.sequence++
      }
    }, [provider])
    async function act(method: string, args: Record<string, unknown>) {
      if (requests.current.writing) return
      requests.current.writing = true
      const sequence = ++requests.current.sequence
      query.pause()
      setBusy(true)
      setError('')
      try {
        await call(method, args)
        if (sequence !== requests.current.sequence) return false
        return true
      } catch (failure) {
        if (sequence === requests.current.sequence)
          setError(
            failure instanceof Error ? failure.message : '操作失败，请重试',
          )
        return false
      } finally {
        if (sequence === requests.current.sequence) {
          requests.current.writing = false
          setBusy(false)
          query.resume()
        }
      }
    }
    return { value: query.value, error: error || query.error, busy, act }
  }
  function AdvancedSettings({
    provider,
    value,
    busy,
    act,
  }: {
    provider: string
    value: ProviderStatus
    busy: boolean
    act(
      method: string,
      args: Record<string, unknown>,
    ): Promise<boolean | undefined>
  }) {
    const id = useId()
    const [url, setUrl] = useState(value.options.capabilityCatalogUrl ?? '')
    const [seconds, setSeconds] = useState(
      String(value.options.refreshIntervalMs / 1000),
    )
    const [overrides, setOverrides] = useState(value.options.overridesJSON)
    return (
      <details className={styles.customized}>
        <summary className={styles.customizedSummary}>同步设置</summary>
        <form
          className={styles.customizedBody}
          onSubmit={(event) => {
            event.preventDefault()
            void act('updateOptions', {
              provider,
              refreshIntervalMs: Number(seconds) * 1000,
              capabilityCatalogUrl: url.trim(),
              overridesJSON: overrides,
            })
          }}
        >
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-catalog`}>
              能力目录 URL
            </label>
            <Input
              id={`${id}-catalog`}
              className={styles.input}
              type="url"
              value={url}
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-interval`}>
              同步间隔（秒）
            </label>
            <Input
              id={`${id}-interval`}
              className={styles.input}
              type="number"
              min="1"
              max="2147483"
              value={seconds}
              disabled={busy}
              onChange={(event) => setSeconds(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-overrides`}>
              模型能力覆盖（JSON）
            </label>
            <Input
              id={`${id}-overrides`}
              className={styles.input}
              value={overrides}
              disabled={busy}
              onChange={(event) => setOverrides(event.target.value)}
            />
          </div>
          <div className={styles.editorActions}>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              保存同步设置
            </Button>
          </div>
        </form>
      </details>
    )
  }
  function ProviderExtras({
    provider,
    configured,
  }: PropsRuntime<'settings.models.provider-card'>) {
    const { value, error, busy, act } = useProvider(provider.provider)
    const stale = value?.models.filter((model) => model.stale).length ?? 0
    return (
      <section className={styles.customized} aria-label="GPT 模型适配">
        <div className={styles.rowHead}>
          <span className={styles.rowName}>GPT 自动适配</span>
          <div className={styles.rowActions}>
            {value?.enabled && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || value.status.state === 'refreshing'}
                onClick={() => {
                  void act('refresh', { provider: provider.provider })
                }}
              >
                {value.status.state === 'refreshing' ? '正在同步…' : '立即同步'}
              </Button>
            )}
            <Switch
              label="GPT 自动适配"
              checked={value?.enabled ?? false}
              disabled={!configured || !value || busy}
              onChange={(enabled) => {
                void act('configure', { provider: provider.provider, enabled })
              }}
            />
          </div>
        </div>
        {value?.enabled && (
          <div className={styles.customizedBody}>
            <p className={styles.advancedHint} role="status">
              {value.status.state === 'ready'
                ? `已同步 ${value.models.length} 个模型 · GPT 六档预设已接管原生等级；停用自动适配可恢复`
                : value.status.state === 'error'
                  ? value.status.error
                  : '等待同步'}
            </p>
            {stale > 0 && (
              <div className={styles.rowActions}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void act('removeStale', { provider: provider.provider })
                  }}
                >
                  移除上游未列出的模型（{stale}）
                </Button>
              </div>
            )}
            <p className={styles.advancedHint}>
              在「自定义设置 → 模型目录」的上下文窗口中选择预设；
              选择“自定义”后可输入数值，选择“默认”恢复自动解析。
            </p>
            <AdvancedSettings
              key={provider.provider}
              provider={provider.provider}
              value={value}
              busy={busy}
              act={act}
            />
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>
    )
  }
  function SpeedOptions({
    sessionId,
  }: PropsRuntime<'conversation.input.left'>) {
    const directory = (
      ctx.get('modelDirectories') as ModelDirectoryResolver
    ).directoryFor(sessionId).store
    const selection = useSyncExternalStore<ModelDirectoryState>(
      (fn) => directory.subscribe(fn),
      () => directory.getSnapshot(),
      () => directory.getSnapshot(),
    ).current
    const provider = selection?.provider ?? ''
    const modelId = selection?.model ?? ''
    const metadata = useRead<ModelStatus>(
      'modelStatus',
      { provider, modelId },
      !!provider && !!modelId,
    )
    const speedQuery = useRead<SpeedStatus>(
      'speed',
      { sessionId, provider, modelId },
      !!metadata.value?.enabled,
      3000,
    )
    const speed = speedQuery.value ?? { selected: 'default', last: null }
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const action = useRef(0)
    useEffect(() => {
      action.current++
      setBusy(false)
      setOpen(false)
      setError('')
      return () => {
        action.current++
      }
    }, [sessionId, provider, modelId])
    const capability = metadata.value?.enabled ? metadata.value : undefined
    if (!capability) return null
    async function select(tier: ServiceTier) {
      const sequence = ++action.current
      setBusy(true)
      speedQuery.pause()
      try {
        await call('setSpeed', { sessionId, provider, modelId, tier })
        if (sequence !== action.current) return
        setError('')
        setOpen(false)
      } catch (failure) {
        if (sequence === action.current)
          setError(failure instanceof Error ? failure.message : '设置速度失败')
      } finally {
        if (sequence === action.current) {
          setBusy(false)
          speedQuery.resume()
        }
      }
    }
    const label =
      capability.serviceTiers.find((tier) => tier.id === speed.selected)
        ?.label ?? 'Standard'
    return (
      <>
        <Menu
          open={open}
          portal
          side="top"
          compact
          selectedId={speed.selected}
          items={capability.serviceTiers.map((tier) => ({
            id: tier.id,
            label: tier.label,
            disabled: busy,
          }))}
          onClose={() => setOpen(false)}
          onSelect={(tier) => {
            void select(tier as ServiceTier)
          }}
          anchor={
            <Button
              type="button"
              variant="toolbar"
              size="sm"
              disabled={busy}
              aria-label={`GPT 速度：${label}`}
              aria-haspopup="menu"
              aria-expanded={open}
              title={
                speed.last?.actual
                  ? `实际速度：${speed.last.actual}`
                  : 'GPT 请求速度'
              }
              onClick={() => setOpen(!open)}
            >
              {label}
              <IconChevronDownOutlineRegular size={12} />
            </Button>
          }
        />
        {(error || metadata.error || speedQuery.error) && (
          <span className={styles.error} role="alert">
            {error || metadata.error || speedQuery.error}
          </span>
        )}
      </>
    )
  }
  ctx.slots.inject('settings.models.provider-card', () => {
    const restore = installNativeContextPresets(ctx.slots)
    try {
      const dispose = ctx.slots.register(
        { name: 'settings.models.provider-card', key: 'llm-pi-ai' },
        ProviderExtras,
      )
      return () => {
        dispose()
        restore()
      }
    } catch (error) {
      restore()
      throw error
    }
  })
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: 'gpt-speed', order: 20 },
      SpeedOptions,
    ),
  )
}
