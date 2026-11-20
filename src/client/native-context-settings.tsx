import React from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { nativeModelsRuntimes } from 'dsh-gpt-adapter/native-context-settings'
import { ContextWindowPresetScope } from './context-window-preset.js'
import type { Translator } from './locales.js'

/** Keep the native entry, controller, stores, child slots, and save operations. */
export function installNativeContextPresets(
  slots: Pick<SlotRegistry, 'entries' | 'subscribe' | 'provideRoot'>,
  t: Translator,
) {
  let unavailable = false
  let disposed = false
  let syncing = false
  const listeners = new Set<() => void>()
  const publish = (next: boolean) => {
    if (unavailable === next) return
    unavailable = next
    for (const listener of listeners) listener()
  }
  let current:
    | {
        entry: StoredEntry
        original: unknown
        component: React.ComponentType<Record<string, unknown>>
        release: () => void
      }
    | undefined
  const restore = () => {
    if (!current) return
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
    if (disposed || syncing) return
    syncing = true
    try {
      let entry = findEntry()
      if (
        current &&
        entry === current.entry &&
        entry.component === current.component
      )
        return
      restore()
      // Re-read after releasing the root source, which may notify other owners.
      entry = findEntry()
      if (!entry) {
        publish(false)
        return
      }
      const original = entry.component
      const source =
        typeof original === 'function'
          ? Function.prototype.toString.call(original)
          : undefined
      const runtime = nativeModelsRuntimes.find(
        (candidate) => candidate.expectedModelsSectionSource === source,
      )
      if (!runtime) {
        publish(true)
        return
      }
      const NativeModelsSection = runtime.getComponent()
      function ModelsWithContextPresets(props: Record<string, unknown>) {
        return (
          <ContextWindowPresetScope.Provider
            value={props.gptContextPresetControls === true ? t : undefined}
          >
            <NativeModelsSection {...props} />
          </ContextWindowPresetScope.Provider>
        )
      }
      entry.component = ModelsWithContextPresets
      try {
        const release = slots.provideRoot({
          props: { gptContextPresetControls: true },
        })
        current = {
          entry,
          original,
          component: ModelsWithContextPresets,
          release,
        }
      } catch (error) {
        if (entry.component === ModelsWithContextPresets)
          entry.component = original
        throw error
      }
      publish(false)
    } catch {
      // Presets are optional; keep provider and speed controls usable.
      publish(true)
    } finally {
      syncing = false
    }
  }
  const unsubscribe = slots.subscribe('settings.section', sync)
  sync()
  return {
    getSnapshot: () => unavailable,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      restore()
      listeners.clear()
    },
  }
}
