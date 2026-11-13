import React from 'react'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import {
  NativeModelsSection,
  expectedModelsSectionSource,
} from 'dsh-gpt-adapter/native-context-settings'
import { ContextWindowPresetScope } from './context-window-preset.js'

function ModelsWithContextPresets(props: Record<string, unknown>) {
  return (
    <ContextWindowPresetScope.Provider
      value={props.gptContextPresetControls === true}
    >
      <NativeModelsSection {...props} />
    </ContextWindowPresetScope.Provider>
  )
}

/** Keep the native entry, controller, stores, child slots, and save operations. */
export function installNativeContextPresets(
  slots: Pick<SlotRegistry, 'entries' | 'subscribe' | 'provideRoot'>,
) {
  let current:
    | {
        entry: StoredEntry
        original: unknown
        release: () => void
      }
    | undefined
  const restore = () => {
    if (!current) return
    const { entry, original, release } = current
    current = undefined
    if (entry.component === ModelsWithContextPresets) entry.component = original
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
    if (
      entry === current?.entry &&
      entry?.component === ModelsWithContextPresets
    )
      return
    restore()
    if (!entry) return
    const original = entry.component
    if (
      typeof original !== 'function' ||
      Function.prototype.toString.call(original) !== expectedModelsSectionSource
    )
      throw new Error('原生模型设置组件与已核验版本不一致，无法安装上下文预设')
    entry.component = ModelsWithContextPresets
    try {
      // This supported root source publishes the control policy and refreshes
      // existing slot renderers after installation and disposal.
      const release = slots.provideRoot({
        props: { gptContextPresetControls: true },
      })
      current = { entry, original, release }
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
