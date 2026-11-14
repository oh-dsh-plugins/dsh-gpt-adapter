import React from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { nativeModelsRuntimes } from 'dsh-gpt-adapter/native-context-settings'
import { ContextWindowPresetScope } from './context-window-preset.js'

/** Keep the native entry, controller, stores, child slots, and save operations. */
export function installNativeContextPresets(
  slots: Pick<SlotRegistry, 'entries' | 'subscribe' | 'provideRoot'>,
) {
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
  const sync = () => {
    const entry = slots
      .entries('settings.section')
      .find(
        (entry) =>
          entry.options.id === 'models' &&
          entry.children?.['settings.models.provider-card'],
      )
    if (entry === current?.entry && entry?.component === current?.component)
      return
    restore()
    if (!entry) return
    const original = entry.component
    const source =
      typeof original === 'function'
        ? Function.prototype.toString.call(original)
        : undefined
    const runtime = nativeModelsRuntimes.find(
      (candidate) => candidate.expectedModelsSectionSource === source,
    )
    if (!runtime)
      throw new Error('原生模型设置组件与已核验版本不一致，无法安装上下文预设')
    const NativeModelsSection = runtime.getComponent()
    function ModelsWithContextPresets(props: Record<string, unknown>) {
      return (
        <ContextWindowPresetScope.Provider
          value={props.gptContextPresetControls === true}
        >
          <NativeModelsSection {...props} />
        </ContextWindowPresetScope.Provider>
      )
    }
    entry.component = ModelsWithContextPresets
    try {
      // This supported root source publishes the control policy and refreshes
      // existing slot renderers after installation and disposal.
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
      entry.component = original
      throw error
    }
  }
  const unsubscribe = slots.subscribe('settings.section', sync)
  try {
    sync()
  } catch (error) {
    unsubscribe()
    throw error
  }
  return () => {
    unsubscribe()
    restore()
  }
}
