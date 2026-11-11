import z from '@deepseek-ai/schemastery'
import { symbols } from '@deepseek-ai/cordis'
import { GPT_REASONING_LEVELS } from './capabilities.js'
import type { ModelCapabilities } from './types.js'

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

export function projectModel(
  provider: string,
  model: JsonObject,
  resolve: CapabilityResolver,
  profile?: JsonObject,
): JsonObject {
  const capability = resolve(provider, model, profile)
  if (!capability) return model
  return {
    ...model,
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
  resolve: CapabilityResolver,
): JsonObject {
  if (!next.providers) return next
  return {
    ...next,
    providers: Object.fromEntries(
      Object.entries(next.providers).map(([provider, raw]) => {
        const profile = raw as JsonObject
        if (!Array.isArray(profile?.models)) return [provider, profile]
        const previous: JsonObject[] =
          current.providers?.[provider]?.models ?? []
        return [
          provider,
          {
            ...profile,
            models: profile.models.map((model: JsonObject) => {
              const original = previous.find((row) => row.id === model.id)
              const ownershipProfile = current.providers?.[provider] ?? profile
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
              if (original && Object.hasOwn(original, 'reasoningEfforts'))
                restored.reasoningEfforts = structuredClone(
                  original.reasoningEfforts,
                )
              else delete restored.reasoningEfforts
              return restored
            }),
          },
        ]
      }),
    ),
  }
}

/** Dispose returns the native settings page to its original schema and values. */
export function installSettingsOverlay(
  settings: SettingsLike,
  resolve: CapabilityResolver,
): () => void {
  // Cordis returns a fresh tracing proxy on service access. Patch the actual
  // service so every caller sees the view, and disposal can compare identities.
  settings = (settings as any)[symbols.original] ?? settings
  const originalDescribe = settings.describe
  const originalWrite = settings.write
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
      if (!managed) return row
      return {
        ...row,
        schema: projectSchema(row.schema, other),
        value: projectConfiguration(row.value, resolve),
        base: projectConfiguration(row.base, resolve),
        user: projectConfiguration(row.user, resolve),
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
    return originalWrite!.call(
      this,
      ns,
      ns !== 'llm-pi-ai'
        ? change
        : (current, base, schema) =>
            nativeWrite(
              change(
                projectConfiguration(current, resolve),
                projectConfiguration(base, resolve),
                schema,
              ),
              current,
              resolve,
            ),
      expected,
      paths,
    )
  }
  settings.describe = describe
  if (originalWrite) settings.write = write
  return () => {
    if (settings.describe === describe) settings.describe = originalDescribe
    if (originalWrite && settings.write === write)
      settings.write = originalWrite
  }
}
