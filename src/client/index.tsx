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
import { ContextWindowControl } from './context-window.js'

type ProviderStatus = ReturnType<GptModels['status']>
type SpeedStatus = ReturnType<GptModels['speed']>
export const inject = ['slots', 'connection', 'sessions', 'modelDirectories']

export function apply(ctx: Context): void {
  async function call<T>(
    method: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await (ctx as ClientContext).connection.rpc.call(
      '/api',
      `gptModels/${method}`,
      { args },
    )
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  function useProvider(provider: string) {
    const [value, setValue] = useState<ProviderStatus>()
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const requests = useRef({ sequence: 0, writing: false })
    useEffect(() => {
      let active = true
      requests.current.writing = false
      setBusy(false)
      const refresh = () => {
        if (!provider || requests.current.writing) return
        const sequence = ++requests.current.sequence
        void call<ProviderStatus>('status', { provider })
          .then((value) => {
            if (active && sequence === requests.current.sequence) {
              setValue(value)
              setError('')
            }
          })
          .catch((error) => {
            if (active && sequence === requests.current.sequence)
              setError(
                error instanceof Error ? error.message : '无法读取 GPT 设置',
              )
          })
      }
      refresh()
      const timer = setInterval(refresh, 3000)
      return () => {
        active = false
        requests.current.sequence++
        clearInterval(timer)
      }
    }, [provider])
    async function act(method: string, args: Record<string, unknown>) {
      if (requests.current.writing) return
      requests.current.writing = true
      const sequence = ++requests.current.sequence
      setBusy(true)
      try {
        await call(method, args)
        if (sequence !== requests.current.sequence) return false
        const next = await call<ProviderStatus>('status', { provider })
        if (sequence !== requests.current.sequence) return false
        setValue(next)
        setError('')
        return true
      } catch (error) {
        if (sequence === requests.current.sequence)
          setError(error instanceof Error ? error.message : '操作失败，请重试')
        return false
      } finally {
        if (sequence === requests.current.sequence) {
          requests.current.writing = false
          setBusy(false)
        }
      }
    }
    return { value, error, busy, act }
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
            {Object.keys(value.contextWindows ?? {}).length > 0 && (
              <details className={styles.customized}>
                <summary className={styles.customizedSummary}>
                  上下文窗口
                </summary>
                <div className={styles.customizedBody}>
                  {Object.entries(value.contextWindows).map(
                    ([modelId, context]) => (
                      <ContextWindowControl
                        key={modelId}
                        provider={provider.provider}
                        modelId={modelId}
                        value={context}
                        revision={value.contextRevision}
                        busy={busy}
                        save={(args) => act('setContextWindow', args)}
                      />
                    ),
                  )}
                </div>
              </details>
            )}
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
    const { value } = useProvider(provider)
    const [speed, setSpeed] = useState<SpeedStatus>({
      selected: 'default',
      last: null,
    })
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => {
      let active = true
      const refresh = () => {
        if (provider && modelId)
          void call<SpeedStatus>('speed', { sessionId, provider, modelId })
            .then((value) => {
              if (active) setSpeed(value)
            })
            .catch((error) => {
              if (active)
                setError(
                  error instanceof Error ? error.message : '无法读取速度设置',
                )
            })
      }
      refresh()
      const timer = setInterval(refresh, 3000)
      return () => {
        active = false
        clearInterval(timer)
      }
    }, [sessionId, provider, modelId])
    const capability = value?.enabled ? value.capabilities[modelId] : undefined
    if (!capability) return null
    async function select(tier: ServiceTier) {
      setBusy(true)
      try {
        await call('setSpeed', { sessionId, provider, modelId, tier })
        setSpeed(
          await call<SpeedStatus>('speed', { sessionId, provider, modelId }),
        )
        setError('')
        setOpen(false)
      } catch (error) {
        setError(error instanceof Error ? error.message : '设置速度失败')
      } finally {
        setBusy(false)
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
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </>
    )
  }
  ctx.slots.inject('settings.models.provider-card', () =>
    ctx.slots.register(
      { name: 'settings.models.provider-card', key: 'llm-pi-ai' },
      ProviderExtras,
    ),
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: 'gpt-speed', order: 20 },
      SpeedOptions,
    ),
  )
}
