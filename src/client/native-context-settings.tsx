import React from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { nativeModelsRuntimes } from 'dsh-gpt-adapter/native-context-settings'
import { ContextWindowPresetScope } from './context-window-preset.js'
import { nativeModelGeneration } from './native-model-generation.js'
import type { Translator } from './locales.js'

type Section = React.ComponentType<Record<string, unknown>>

/** Keep the native entry, controller, stores, child slots, and save operations. */
export function installNativeContextPresets(
  slots: Pick<SlotRegistry, 'entries' | 'subscribe' | 'provideRoot'>,
  t: Translator,
  getModules: () => unknown,
) {
  const generation = nativeModelGeneration(getModules)
  let unavailable = false
  let disposed = false
  let installing = false
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const getEnabled = () => !disposed
  const publish = (next: boolean) => {
    if (unavailable === next || disposed) return
    unavailable = next
    notify()
  }
  let current:
    | {
        original: Section
        component: Section
        entry: StoredEntry
        release: () => void
        mounts: number
      }
    | undefined
  const restore = () => {
    if (!current || current.mounts > 0) return
    const { entry, original, component, release } = current
    current = undefined
    if (entry.component === component) entry.component = original
    release()
  }
  const findEntry = () =>
    slots
      .entries('settings.section')
      .find(
        (entry) =>
          entry.options.id === 'models' &&
          entry.children?.['settings.models.provider-card'],
      )
  const sync = () => {
    if (disposed || installing) return
    const entry = findEntry()
    if (
      !entry ||
      (current?.entry === entry && entry.component === current.component)
    )
      return
    if (current) restore()
    if (
      current ||
      !generation.duringBoot() ||
      typeof entry.component !== 'function'
    ) {
      publish(true)
      return
    }
    installing = true
    const original = entry.component as Section
    const source = Function.prototype.toString.call(original)
    if (
      !nativeModelsRuntimes.some(
        (candidate) => candidate.expectedModelsSectionSource === source,
      )
    ) {
      installing = false
      publish(true)
      return
    }
    function ModelsWithContextPresets(props: Record<string, unknown>) {
      // Resolve once for this mount. An upgrade or disable must not replace an
      // editor whose draft lives in the mounted components' React state.
      const [selected] = React.useState(() => {
        if (disposed || props.gptContextPresetControls !== true) return original
        try {
          const identity = generation.identify(entry!)
          return (
            nativeModelsRuntimes
              .find(
                (candidate) =>
                  identity &&
                  candidate.versions.includes(identity.version) &&
                  candidate.factorySha256 === identity.digest &&
                  candidate.expectedModelsSectionSource === source,
              )
              ?.getComponent() ?? original
          )
        } catch {
          return original
        }
      })
      React.useLayoutEffect(() => {
        const owner = current
        if (!owner || owner.component !== ModelsWithContextPresets) return
        owner.mounts++
        if (!disposed) publish(selected === original)
        return () => {
          owner.mounts--
          if (disposed) queueMicrotask(restore)
        }
      }, [selected])
      const enabled = React.useSyncExternalStore(subscribe, getEnabled)
      const Selected = selected
      return (
        <ContextWindowPresetScope.Provider
          value={enabled && Selected !== original ? t : undefined}
        >
          <Selected {...props} />
        </ContextWindowPresetScope.Provider>
      )
    }
    try {
      entry.component = ModelsWithContextPresets
      const release = slots.provideRoot({
        props: { gptContextPresetControls: true },
      })
      current = {
        entry,
        original,
        component: ModelsWithContextPresets,
        release,
        mounts: 0,
      }
    } catch {
      if (entry.component === ModelsWithContextPresets)
        entry.component = original
      publish(true)
    } finally {
      installing = false
    }
  }
  const unsubscribe = slots.subscribe('settings.section', sync)
  sync()
  return {
    getSnapshot: () => unavailable,
    subscribe,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      // The mounted editor keeps its draft while its fields return to native UI.
      notify()
      listeners.clear()
      restore()
    },
  }
}
