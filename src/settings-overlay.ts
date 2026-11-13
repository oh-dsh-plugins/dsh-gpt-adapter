import z from '@deepseek-ai/schemastery'
import { symbols } from '@deepseek-ai/cordis'
import { GPT_REASONING_LEVELS } from './capabilities.js'
import type { ModelCapabilities } from './types.js'
import { validContextWindow } from './context-window.js'

type JsonObject = Record<string, any>
type SettingsLike = {
  describe(options?: any): any[]
  write?: (
    ns: string,
    change: (current: any, base: any, schema: any) => any,
    expected?: number,
    paths?: string[][],
  ) => Promise<void>
}
export type CapabilityResolver = (
  provider: string,
  model: JsonObject,
  profile?: JsonObject,
) => ModelCapabilities | undefined

export type ContextWindowEdit = {
  provider: string
  modelId: string
  previousTokens: number | undefined
}
type ContextWrites = {
  editableContext?(provider: string, model: JsonObject): number | undefined
  validate?(provider: string, model: JsonObject, profile: JsonObject): void
  revision(): number | undefined
  saved(edits: ContextWindowEdit[], revision: number | undefined): Promise<void>
}
export type ContextWindowWriter = (
  provider: string,
  modelId: string,
  tokens: number | undefined,
  expected?: number,
) => Promise<void>

export function projectModel(
  provider: string,
  model: JsonObject,
  resolve: CapabilityResolver,
  profile?: JsonObject,
  includeContext = true,
): JsonObject {
  const capability = resolve(provider, model, profile)
  if (!capability) return model
  return {
    ...model,
    ...(includeContext && validContextWindow(capability.contextWindow)
      ? { contextWindow: capability.contextWindow }
      : {}),
    reasoningEfforts:
      capability.reasoning.status === 'unsupported'
        ? false
        : Object.fromEntries(
            capability.reasoning.choices.map((choice) => [
              choice.id,
              choice.wireValue,
            ]),
          ),
  }
}

/** A view of native configuration; the original object and its stored fields stay intact. */
export function projectConfiguration(
  value: JsonObject | undefined,
  resolve: CapabilityResolver,
): JsonObject | undefined {
  if (!value?.providers || typeof value.providers !== 'object') return value
  return {
    ...value,
    providers: Object.fromEntries(
      Object.entries(value.providers).map(([provider, raw]) => {
        const profile = raw as JsonObject
        return [
          provider,
          Array.isArray(profile?.models)
            ? {
                ...profile,
                models: profile.models.map((model: JsonObject) =>
                  projectModel(provider, model, resolve, profile),
                ),
              }
            : profile,
        ]
      }),
    ),
  }
}

function projectSchema(json: any, preserveNativeLevels: boolean): any {
  if (!json) return json
  const schema = new z(json)
  const efforts =
    schema.dict?.providers?.inner?.dict?.models?.inner?.dict?.reasoningEfforts
  const keys = efforts?.list?.find(
    (branch: any) => branch.type === 'dict',
  )?.sKey
  if (!keys?.list) throw new Error('Unsupported native Models reasoning schema')
  const offered = preserveNativeLevels
    ? [
        ...new Set([
          ...keys.list.map((entry: any) => entry.value),
          ...GPT_REASONING_LEVELS,
        ]),
      ]
    : [...GPT_REASONING_LEVELS]
  keys.list = offered.map((level) => z.const(level))
  return schema.toJSON()
}

/** Restore only plugin-managed fields before the native Config validates a save. */
function nativeWrite(
  next: JsonObject,
  current: JsonObject,
  base: JsonObject,
  resolve: CapabilityResolver,
  contextEdits: ContextWindowEdit[],
  contextWrites?: ContextWrites,
): JsonObject {
  if (!next.providers) return next
  return {
    ...next,
    providers: Object.fromEntries(
      Object.entries(next.providers).map(([provider, raw]) => {
        const profile = raw as JsonObject
        const inherited = base?.providers?.[provider] ?? {}
        const ownershipProfile = {
          ...inherited,
          ...current.providers?.[provider],
        }
        const effectiveProfile = { ...inherited, ...profile }
        const ownsModels = Array.isArray(profile?.models)
        const models = ownsModels
          ? profile.models
          : inherited.models?.map((model: JsonObject) =>
              projectModel(provider, model, resolve, ownershipProfile),
            )
        if (!Array.isArray(models)) return [provider, profile]
        const previous: JsonObject[] = ownershipProfile.models ?? []
        const savedModels = models.map((model: JsonObject) => {
          const original = previous.find((row) => row.id === model.id)
          const capability = resolve(provider, model, ownershipProfile)
          if (!capability) return model
          const managed = projectModel(
            provider,
            model,
            resolve,
            ownershipProfile,
          )
          if (
            original &&
            JSON.stringify(model.reasoningEfforts) !==
              JSON.stringify(managed.reasoningEfforts)
          )
            throw new Error(
              'GPT 思考等级由插件预设管理；请刷新后重试，或在模型能力覆盖中修改，停用自动适配可恢复原生编辑。',
            )
          const restored = { ...model }
          const projectedContext = original
            ? projectModel(provider, original, resolve, ownershipProfile)
                .contextWindow
            : undefined
          const editedContext =
            ownsModels &&
            (original
              ? model.contextWindow !== projectedContext
              : Object.hasOwn(model, 'contextWindow'))
          const budgetChanged =
            editedContext ||
            !original ||
            model.maxTokens !== original.maxTokens ||
            (model.maxTokens === undefined &&
              effectiveProfile.defaultMaxTokens !==
                ownershipProfile.defaultMaxTokens) ||
            (model.contextWindow === undefined &&
              effectiveProfile.defaultContextWindow !==
                ownershipProfile.defaultContextWindow)
          if (!editedContext) {
            if (original && Object.hasOwn(original, 'contextWindow'))
              restored.contextWindow = original.contextWindow
            else delete restored.contextWindow
          } else {
            if (
              model.contextWindow !== undefined &&
              !validContextWindow(model.contextWindow)
            )
              throw new Error('上下文窗口必须是正的安全整数')
            contextEdits.push({
              provider,
              modelId: model.id,
              previousTokens: original?.contextWindow,
            })
          }
          if (budgetChanged)
            contextWrites?.validate?.(
              provider,
              editedContext
                ? model
                : { ...model, contextWindow: capability.contextWindow },
              profile,
            )
          if (original && Object.hasOwn(original, 'reasoningEfforts'))
            restored.reasoningEfforts = structuredClone(
              original.reasoningEfforts,
            )
          else delete restored.reasoningEfforts
          return restored
        })
        // Validate inherited models without materializing a user-owned array.
        return [
          provider,
          ownsModels ? { ...profile, models: savedModels } : profile,
        ]
      }),
    ),
  }
}

/** Dispose returns the native settings page to its original schema and values. */
export function installSettingsOverlay(
  settings: SettingsLike,
  resolve: CapabilityResolver,
  contextWrites?: ContextWrites,
) {
  // Cordis returns a fresh tracing proxy on service access. Patch the actual
  // service so every caller sees the view, and disposal can compare identities.
  settings = (settings as any)[symbols.original] ?? settings
  const originalDescribe = settings.describe
  const originalWrite = settings.write
  // Editable drafts contain manual values only; automatic capacities belong in
  // the effective view. Otherwise typing the current automatic value is lost.
  const editableResolve: CapabilityResolver = (provider, model, profile) => {
    const capability = resolve(provider, model, profile)
    if (!capability) return undefined
    const manual = contextWrites?.editableContext
      ? contextWrites.editableContext(provider, model)
      : model.contextWindow
    const projected = { ...capability }
    if (manual === undefined) delete projected.contextWindow
    else projected.contextWindow = manual
    return projected
  }
  let viewRevision:
    { native: number; contexts: string; revision: number } | undefined
  function describe(this: SettingsLike, options?: any) {
    return originalDescribe.call(this, options).map((row) => {
      if (row.ns !== 'llm-pi-ai') return row
      let managed = false
      let other = false
      for (const [provider, profile] of Object.entries(
        row.value?.providers ?? {},
      ))
        for (const model of (profile as JsonObject).models ?? [])
          if (resolve(provider, model, profile as JsonObject)) managed = true
          else other = true
      const value = managed
        ? projectConfiguration(row.value, resolve)
        : row.value
      // The native revision tracks stored config only. A model-list form also
      // carries derived capacities; reject its stale draft if those change.
      const contexts = JSON.stringify(
        Object.entries(value?.providers ?? {}).map(([provider, profile]) => [
          provider,
          (profile as JsonObject).models?.map((model: JsonObject) => [
            model.id,
            model.contextWindow,
          ]),
        ]),
      )
      if (typeof row.revision === 'number') {
        if (!viewRevision)
          viewRevision = {
            native: row.revision,
            contexts,
            revision: row.revision,
          }
        else if (
          viewRevision.native !== row.revision ||
          viewRevision.contexts !== contexts
        )
          viewRevision = {
            native: row.revision,
            contexts,
            revision: Math.max(row.revision, viewRevision.revision + 1),
          }
      }
      return {
        ...row,
        ...(managed
          ? {
              schema: projectSchema(row.schema, other),
              value,
              base: projectConfiguration(row.base, editableResolve),
              user: projectConfiguration(row.user, editableResolve),
            }
          : {}),
        ...(typeof row.revision === 'number'
          ? { revision: viewRevision!.revision }
          : {}),
      }
    })
  }
  async function write(
    this: SettingsLike,
    ns: string,
    change: (current: any, base: any, schema: any) => any,
    expected?: number,
    paths?: string[][],
  ) {
    const edits: ContextWindowEdit[] = []
    const legacyRevision = contextWrites?.revision()
    await originalWrite!.call(
      this,
      ns,
      ns !== 'llm-pi-ai'
        ? change
        : (current, base, schema) =>
            nativeWrite(
              change(
                projectConfiguration(structuredClone(current), editableResolve),
                projectConfiguration(structuredClone(base), editableResolve),
                schema,
              ),
              current,
              base,
              editableResolve,
              edits,
              contextWrites,
            ),
      expected,
      paths,
    )
    await finishContextWrite.call(this, ns, edits, legacyRevision, paths)
  }
  async function finishContextWrite(
    this: SettingsLike,
    ns: string,
    edits: ContextWindowEdit[],
    legacyRevision: number | undefined,
    paths?: string[][],
  ) {
    if (ns !== 'llm-pi-ai' || !edits.length || !contextWrites) return
    const committedRevision = describe
      .call(this)
      .find((row) => row.ns === ns)?.revision
    try {
      await contextWrites.saved(edits, legacyRevision)
    } catch (error) {
      // Only compensate these context edits, never replace concurrent settings.
      try {
        await originalWrite!.call(
          this,
          ns,
          (current) => {
            const restored = structuredClone(current)
            for (const edit of edits) {
              const row = restored.providers?.[edit.provider]?.models?.find(
                (model: any) => model.id === edit.modelId,
              )
              if (!row) continue
              if (edit.previousTokens === undefined) delete row.contextWindow
              else row.contextWindow = edit.previousTokens
            }
            return restored
          },
          committedRevision,
          paths,
        )
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          '上下文保存未完成，恢复失败；请刷新查看当前设置',
        )
      }
      throw error
    }
  }
  settings.describe = describe
  if (originalWrite) settings.write = write
  const dispose = () => {
    if (settings.describe === describe) settings.describe = originalDescribe
    if (originalWrite && settings.write === write)
      settings.write = originalWrite
  }
  const setContextWindow: ContextWindowWriter = async (
    provider,
    modelId,
    tokens,
    expected,
  ) => {
    if (!originalWrite) throw new Error('上下文设置暂不可用')
    if (tokens !== undefined && !validContextWindow(tokens))
      throw new Error('上下文窗口必须是正的安全整数')
    const edits: ContextWindowEdit[] = []
    const legacyRevision = contextWrites?.revision()
    const paths = [['providers', provider, 'models']]
    await originalWrite.call(
      settings,
      'llm-pi-ai',
      (current) => {
        const next = structuredClone(current)
        const model = next.providers?.[provider]?.models?.find(
          (row: any) => row.id === modelId,
        )
        if (!model) throw new Error('模型已变更，请刷新后重试')
        edits.push({ provider, modelId, previousTokens: model.contextWindow })
        if (tokens === undefined) delete model.contextWindow
        else model.contextWindow = tokens
        contextWrites?.validate?.(provider, model, next.providers[provider])
        return next
      },
      expected,
      paths,
    )
    await finishContextWrite.call(
      settings,
      'llm-pi-ai',
      edits,
      legacyRevision,
      paths,
    )
  }
  return Object.assign(dispose, { setContextWindow })
}
