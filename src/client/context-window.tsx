import React, { useEffect, useId, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  validContextWindow,
  type ContextWindowMode,
  type ContextWindowResolution,
} from '../context-window.js'
import styles from 'dsh-gpt-adapter/native-settings-styles'

const sources = {
  'legacy-override': '已有能力覆盖',
  'native-user': '手动设置',
  'provider-default': '供应商默认',
  upstream: '上游模型目录',
  'capability-catalog': '能力目录',
  'official-preset': '官方模型预设',
  'native-default': 'DSH 默认',
}

export function ContextWindowControl({
  provider,
  modelId,
  value,
  revision,
  busy,
  save,
}: {
  provider: string
  modelId: string
  value: ContextWindowResolution
  revision: number
  busy: boolean
  save(args: Record<string, unknown>): Promise<boolean | undefined>
}) {
  const id = useId()
  const [mode, setMode] = useState(value.mode)
  const [custom, setCustom] = useState(String(value.effectiveTokens))
  const [dirty, setDirty] = useState(false)
  const [draftRevision, setDraftRevision] = useState(revision)
  const contextKey = JSON.stringify([
    value.mode,
    value.effectiveTokens,
    value.defaultTokens,
    value.source,
  ])
  const [draftContext, setDraftContext] = useState(contextKey)
  useEffect(() => {
    if (dirty) {
      // Another model can advance the namespace without changing this draft's base.
      if (draftContext === contextKey) setDraftRevision(revision)
      return
    }
    setMode(value.mode)
    setCustom(String(value.effectiveTokens))
    setDraftRevision(revision)
    setDraftContext(contextKey)
  }, [
    value.mode,
    value.effectiveTokens,
    revision,
    dirty,
    contextKey,
    draftContext,
  ])
  const conflict = dirty && draftContext !== contextKey
  const valid =
    mode !== 'custom' ||
    (custom.trim() !== '' && validContextWindow(Number(custom)))
  function edit() {
    if (!dirty) {
      setDraftRevision(revision)
      setDraftContext(contextKey)
    }
    setDirty(true)
  }
  return (
    <form
      className={styles.field}
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid || busy || conflict) return
        void save({
          provider,
          modelId,
          mode,
          ...(mode === 'custom' ? { customTokens: Number(custom) } : {}),
          expectedRevision: draftRevision,
        }).then((saved) => {
          if (saved) setDirty(false)
        })
      }}
    >
      <label className={styles.fieldLabel} htmlFor={id}>
        {modelId}
      </label>
      <select
        id={id}
        aria-label={`${modelId} 上下文预设`}
        className={styles.input}
        value={mode}
        disabled={busy}
        onChange={(event) => {
          edit()
          setMode(event.target.value as ContextWindowMode)
        }}
      >
        <option value="default">默认</option>
        <option value="516k">516K</option>
        <option value="1m">1M</option>
        <option value="custom">自定义</option>
      </select>
      {mode === 'custom' && (
        <>
          <label className={styles.fieldLabel} htmlFor={`${id}-custom`}>
            自定义窗口（tokens）
          </label>
          <Input
            id={`${id}-custom`}
            className={styles.input}
            type="number"
            min="1"
            step="1"
            aria-label={`${modelId} 自定义窗口`}
            aria-invalid={!valid}
            aria-describedby={!valid ? `${id}-error` : undefined}
            value={custom}
            disabled={busy}
            onChange={(event) => {
              edit()
              setCustom(event.target.value)
            }}
          />
        </>
      )}
      <span className={styles.advancedHint}>
        当前：{value.effectiveTokens.toLocaleString('en-US')} tokens · 来源：
        {sources[value.source]}
      </span>
      {!valid && (
        <span id={`${id}-error`} className={styles.error} role="alert">
          请输入正的安全整数
        </span>
      )}
      {conflict && (
        <span className={styles.error} role="alert">
          此模型的设置已变化，请核对上方当前值后继续编辑。
        </span>
      )}
      <div className={styles.editorActions}>
        {conflict && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`保留 ${modelId} 草稿`}
            onClick={() => {
              setDraftRevision(revision)
              setDraftContext(contextKey)
            }}
          >
            保留草稿继续编辑
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={busy || !dirty || !valid || conflict}
          aria-label={`保存 ${modelId} 上下文`}
        >
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
    </form>
  )
}
