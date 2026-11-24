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
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  PropsRuntime,
  PropsLocale,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { GptModels } from '../host.js'
import type { SpeedSelection } from '../types.js'
import type { ClientContext } from './compat-slots.js'
import type {
  ModelDirectoryState,
  ModelDirectoryResolver,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import styles from 'dsh-gpt-adapter/native-settings-styles'
import { installNativeContextPresets } from './native-context-settings.js'
import { installReasoningSelection } from './reasoning-selection.js'
import {
  NS,
  dictionaries,
  translateOwnedError,
  type Translator,
} from './locales.js'

type ProviderStatus = ReturnType<GptModels['status']>
type SpeedStatus = ReturnType<GptModels['speed']>
type ModelStatus = ReturnType<GptModels['modelStatus']>
export const inject = [
  'slots',
  'connection',
  'sessions',
  'modelDirectories',
  'remote',
  'locale',
]

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries))
  ctx.effect(() =>
    installReasoningSelection(
      ctx.get('modelDirectories'),
      ({ provider, model }) =>
        call<boolean>(
          'reasoningManaged',
          { provider, modelId: model },
          AbortSignal.timeout(3000),
        ),
    ),
  )
  const translate = ctx.locale.bind(NS)
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
      resumeAndRead(): Promise<T | undefined>
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
      const readers = new Set<(value: T | undefined) => void>()
      const completeReaders = (next: T | undefined) => {
        for (const resolve of readers) resolve(next)
        readers.clear()
      }
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
          () => controller.abort(new Error(dictionaries.en.readTimeout)),
          15000,
        )
        try {
          const next = await call<T>(method, parameters, controller.signal)
          if (active && sequence === generation) {
            current = next
            failures = 0
            setValue({ key, value: next })
            setError('')
            completeReaders(next)
          }
        } catch (failure) {
          if (active && sequence === generation) {
            failures++
            setError(
              failure instanceof Error
                ? failure.message
                : dictionaries.en.readFailed,
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
        resumeAndRead() {
          return new Promise<T | undefined>((resolve) => {
            readers.add(resolve)
            paused = false
            invalidate()
          })
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
        ctx.remote.$on('llm/adapters-updated', invalidate),
        ctx.remote.$on('llm/models-updated', (provider?: string) => {
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
        completeReaders(undefined)
      }
    }, [method, key, enabled, intervalMs])
    return {
      value: value?.key === key ? value.value : undefined,
      replaceValue: (update: (current: T | undefined) => T) =>
        setValue((previous) => ({
          key,
          value: update(previous?.key === key ? previous.value : undefined),
        })),
      error,
      refresh: () => controls.current?.invalidate(),
      pause: () => controls.current?.pause(),
      resume: () => controls.current?.resume(),
      resumeAndRead: () =>
        controls.current?.resumeAndRead() ?? Promise.resolve(undefined),
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
    async function act(
      method: string,
      args: Record<string, unknown>,
      saved?: true | ((status: ProviderStatus) => void),
    ) {
      if (requests.current.writing) return
      requests.current.writing = true
      const sequence = ++requests.current.sequence
      query.pause()
      setBusy(true)
      setError('')
      let reading = false
      try {
        await call(method, args)
        if (sequence !== requests.current.sequence) return false
        if (saved) {
          reading = true
          const status = await query.resumeAndRead()
          if (!status || sequence !== requests.current.sequence) return false
          if (typeof saved === 'function') saved(status)
        }
        return true
      } catch (failure) {
        if (sequence === requests.current.sequence)
          setError(
            failure instanceof Error
              ? failure.message
              : dictionaries.en.actionFailed,
          )
        return false
      } finally {
        if (sequence === requests.current.sequence) {
          requests.current.writing = false
          setBusy(false)
          if (!reading) query.resume()
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
    t,
  }: {
    provider: string
    value: ProviderStatus
    busy: boolean
    t: Translator
    act(
      method: string,
      args: Record<string, unknown>,
      saved?: (status: ProviderStatus) => void,
    ): Promise<boolean | undefined>
  }) {
    const id = useId()
    const [url, setUrl] = useState(value.options.capabilityCatalogUrl ?? '')
    const [seconds, setSeconds] = useState(
      String(value.options.refreshIntervalMs / 1000),
    )
    const [overrides, setOverrides] = useState(value.options.overridesJSON)
    const dirty = useRef(false)
    const revision = useRef(value.optionsRevision)
    const base = useRef(value.options)
    // Other options share this revision but must not invalidate a sync draft.
    const expectedRevision =
      (value.options.capabilityCatalogUrl ?? '') ===
        (base.current.capabilityCatalogUrl ?? '') &&
      value.options.refreshIntervalMs === base.current.refreshIntervalMs &&
      value.options.overridesJSON === base.current.overridesJSON
        ? value.optionsRevision
        : revision.current
    const adopt = (status: ProviderStatus) => {
      setUrl(status.options.capabilityCatalogUrl ?? '')
      setSeconds(String(status.options.refreshIntervalMs / 1000))
      setOverrides(status.options.overridesJSON)
      revision.current = status.optionsRevision
      base.current = status.options
      dirty.current = false
    }
    useEffect(() => {
      if (dirty.current) return
      adopt(value)
    }, [value.options, value.optionsRevision])
    return (
      <details className={styles.customized}>
        <summary className={styles.customizedSummary}>
          {t('syncSettings')}
        </summary>
        <form
          className={styles.customizedBody}
          onSubmit={(event) => {
            event.preventDefault()
            void act(
              'updateOptions',
              {
                provider,
                refreshIntervalMs: Math.round(Number(seconds) * 1000),
                capabilityCatalogUrl: url.trim(),
                overridesJSON: overrides,
                expectedRevision,
              },
              adopt,
            )
          }}
        >
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-catalog`}>
              {t('catalogUrl')}
            </label>
            <Input
              id={`${id}-catalog`}
              className={styles.input}
              type="url"
              value={url}
              disabled={busy}
              onChange={(event) => {
                dirty.current = true
                setUrl(event.target.value)
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-interval`}>
              {t('interval')}
            </label>
            <Input
              id={`${id}-interval`}
              className={styles.input}
              type="number"
              min="1"
              max="2147483.647"
              step="0.001"
              required
              value={seconds}
              disabled={busy}
              onChange={(event) => {
                dirty.current = true
                setSeconds(event.target.value)
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`${id}-overrides`}>
              {t('overrides')}
            </label>
            <Input
              id={`${id}-overrides`}
              className={styles.input}
              value={overrides}
              disabled={busy}
              onChange={(event) => {
                dirty.current = true
                setOverrides(event.target.value)
              }}
            />
          </div>
          <div className={styles.editorActions}>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              {t('saveSync')}
            </Button>
            {dirty.current && expectedRevision !== value.optionsRevision && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => adopt(value)}
              >
                {t('reloadSync')}
              </Button>
            )}
          </div>
        </form>
      </details>
    )
  }
  let contextPresets: ReturnType<typeof installNativeContextPresets> | undefined
  function ProviderExtras({
    provider,
    configured,
    t,
  }: PropsRuntime<'settings.models.provider-card'> & PropsLocale<typeof NS>) {
    const { value, error, busy, act } = useProvider(provider.provider)
    const presetsUnavailable = useSyncExternalStore(
      (listener) => contextPresets?.subscribe(listener) ?? (() => {}),
      () => contextPresets?.getSnapshot() ?? false,
    )
    const stale = value?.models.filter((model) => model.stale).length ?? 0
    return (
      <section className={styles.customized} aria-label={t('title')}>
        <div className={styles.rowHead}>
          <span className={styles.rowName}>{t('autoAdapt')}</span>
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
                {t(value.status.state === 'refreshing' ? 'syncing' : 'syncNow')}
              </Button>
            )}
            <Switch
              label={t('autoAdapt')}
              checked={value?.enabled ?? false}
              disabled={!configured || !value || busy}
              onChange={(enabled) => {
                void act('configure', { provider: provider.provider, enabled })
              }}
            />
          </div>
        </div>
        {value?.canConfigureUltrafastFallback && (
          <div className={styles.customizedBody}>
            <div className={styles.rowHead}>
              <span className={styles.rowName}>{t('manualUltrafast')}</span>
              <Switch
                label={t('manualUltrafast')}
                checked={value.options.allowUnadvertisedUltrafast ?? false}
                disabled={!configured || busy}
                onChange={(enabled) => {
                  void act(
                    'setUltrafastFallback',
                    {
                      provider: provider.provider,
                      enabled,
                      expectedRevision: value.optionsRevision,
                    },
                    true,
                  )
                }}
              />
            </div>
            <p className={styles.advancedHint}>{t('manualUltrafastHint')}</p>
          </div>
        )}
        {value?.enabled && (
          <div className={styles.customizedBody}>
            <p className={styles.advancedHint} role="status">
              {value.status.state === 'ready'
                ? t('synced', { count: value.models.length })
                : value.status.state === 'error'
                  ? translateOwnedError(value.status.error, t)
                  : t('waiting')}
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
                  {t('removeStale', { count: stale })}
                </Button>
              </div>
            )}
            <p className={styles.advancedHint}>{t('contextHint')}</p>
            <AdvancedSettings
              key={provider.provider}
              provider={provider.provider}
              value={value}
              busy={busy}
              act={act}
              t={t}
            />
          </div>
        )}
        {presetsUnavailable && (
          <p className={styles.error} role="status">
            {t('nativeMismatch')}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {translateOwnedError(error, t)}
          </p>
        )}
      </section>
    )
  }
  function SpeedOptions({
    sessionId,
    t,
  }: PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>) {
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
    if (!capability)
      return metadata.error ? (
        <span className={styles.error} role="alert">
          {translateOwnedError(metadata.error, t)}
        </span>
      ) : null
    async function select(tier: SpeedSelection) {
      const sequence = ++action.current
      setBusy(true)
      speedQuery.pause()
      try {
        await call('setSpeed', { sessionId, provider, modelId, tier })
        if (sequence !== action.current) return
        speedQuery.replaceValue((current) => ({
          selected: tier,
          last: current?.last ?? null,
        }))
        setError('')
        setOpen(false)
      } catch (failure) {
        if (sequence === action.current)
          setError(
            failure instanceof Error
              ? failure.message
              : dictionaries.en.speedFailed,
          )
      } finally {
        if (sequence === action.current) {
          setBusy(false)
          speedQuery.resume()
        }
      }
    }
    const manual = capability.serviceTiers.find(
      (tier) => tier.id === 'manual-ultrafast',
    )
    const choices = capability.serviceTiers.filter(
      (tier) =>
        !manual ||
        tier.id !== 'ultrafast' ||
        tier.label.trim().toLowerCase() !== manual.label.toLowerCase(),
    )
    const selectedChoice = capability.serviceTiers.find(
      (tier) => tier.id === speed.selected,
    )
    const selectedId =
      manual &&
      selectedChoice &&
      !choices.includes(selectedChoice) &&
      selectedChoice.wireValue === manual.wireValue
        ? manual.id
        : speed.selected
    const label = selectedChoice?.label ?? 'Standard'
    return (
      <>
        <Menu
          open={open}
          portal
          side="top"
          compact
          selectedId={selectedId}
          items={choices.map((tier) => ({
            id: tier.id,
            label: tier.label,
            disabled: busy,
          }))}
          onClose={() => setOpen(false)}
          onSelect={(tier) => {
            void select(tier as SpeedSelection)
          }}
          anchor={
            <Button
              type="button"
              variant="toolbar"
              size="sm"
              disabled={busy}
              aria-label={t('speedLabel', { label })}
              aria-haspopup="menu"
              aria-expanded={open}
              title={
                speed.last?.actual
                  ? t('actualSpeed', { tier: speed.last.actual })
                  : t('requestSpeed')
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
            {translateOwnedError(
              error || metadata.error || speedQuery.error,
              t,
            )}
          </span>
        )}
      </>
    )
  }
  ctx.slots.inject('settings.models.provider-card', () => {
    const presets = installNativeContextPresets(ctx.slots, translate, () =>
      ctx.get('modules' as never),
    )
    contextPresets = presets
    try {
      const dispose = ctx.slots.register(
        { name: 'settings.models.provider-card', key: 'llm-pi-ai', locale: NS },
        ProviderExtras,
      )
      return () => {
        dispose()
        presets.dispose()
      }
    } catch (error) {
      presets.dispose()
      throw error
    }
  })
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'gpt-speed',
        order: 20,
        locale: NS,
      },
      SpeedOptions,
    ),
  )
}
