import React, { createContext, useContext, useState } from 'react'
import { validContextWindow } from '../context-window.js'

export const ContextWindowPresetScope = createContext(false)

type Props = {
  inputProps: React.InputHTMLAttributes<HTMLInputElement>
  tokens: number | undefined
  onValueChange(value: string): void
  onCustomValueChange(value: string): void
}

/** Reuse the native field callbacks and draft; only the field's UI changes. */
export function ContextWindowPreset({
  inputProps,
  tokens,
  onValueChange,
  onCustomValueChange,
}: Props) {
  const enabled = useContext(ContextWindowPresetScope)
  const [custom, setCustom] = useState(false)
  if (!enabled) return <input {...inputProps} />
  const mode = custom
    ? 'custom'
    : tokens === undefined
      ? 'default'
      : tokens === 516000
        ? '516k'
        : tokens === 1000000
          ? '1m'
          : 'custom'
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <select
        className={inputProps.className}
        style={{ width: '100%', maxWidth: 'none' }}
        aria-label={inputProps['aria-label']}
        disabled={inputProps.disabled}
        value={mode}
        onChange={(event) => {
          const mode = event.target.value
          setCustom(mode === 'custom')
          if (mode === 'custom') {
            if (tokens === undefined) onCustomValueChange('')
          } else {
            onValueChange(mode === '516k' ? '516K' : mode === '1m' ? '1M' : '')
          }
        }}
      >
        <option value="default">默认</option>
        <option value="516k">516K</option>
        <option value="1m">1M</option>
        <option value="custom">自定义</option>
      </select>
      {mode === 'custom' && (
        <input
          {...inputProps}
          aria-label={String(inputProps['aria-label']) + ' 自定义数值'}
          aria-invalid={!validContextWindow(tokens)}
          placeholder="输入上下文窗口"
          onChange={(event) => {
            setCustom(true)
            onCustomValueChange(event.target.value)
          }}
        />
      )}
    </div>
  )
}
