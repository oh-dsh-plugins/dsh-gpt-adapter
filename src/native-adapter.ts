import type { NativeExtension } from './host.js'
import type { PreparedGptRequest } from './types.js'

// This internal runtime seam is version- and source-hash-checked by the Host. Transport,
// message conversion, tools, cancellation and replay stay with the host adapter.
type Snapshot = {
  profiles: Map<string, Record<string, any>>
  models: {
    stream(model: any, context: any, options: any): any
    [key: string]: any
  }
}
type NativeAdapter = {
  current(): Snapshot
  modelInfo(snapshot: Snapshot, provider: string, model: string): any
  streamWithSnapshot(options: any, snapshot: Snapshot): AsyncIterable<any>
  prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<any>
  stream(options: any): AsyncIterable<any>
}

/** Install a disposable extension without replacing the host's plugin entries. */
export function installNativeAdapterBridge(
  prototype: NativeAdapter,
  capture: (
    provider: string,
    model: string,
    base: any,
    snapshot: Snapshot,
  ) => NativeExtension | undefined,
): () => void {
  const original = {
    modelInfo: prototype.modelInfo,
    prepareCall: prototype.prepareCall,
    stream: prototype.stream,
    streamWithSnapshot: prototype.streamWithSnapshot,
  }
  for (const method of Object.values(original))
    if (typeof method !== 'function')
      throw new Error('Unsupported DSH Pi AI adapter')

  function stream(
    adapter: NativeAdapter,
    options: any,
    snapshot: Snapshot,
    extension: NativeExtension | undefined,
    base: any,
  ): AsyncIterable<any> {
    if (!extension)
      return original.streamWithSnapshot.call(adapter, options, snapshot)
    // Keep the original validation on a level it already knows; the selected
    // native wire value is applied at the SDK payload boundary below.
    const fallback =
      base.reasoning?.defaultEffort ?? base.reasoning?.efforts?.[0]?.id
    const profiles = new Map(snapshot.profiles)
    if (!extension.preserveReasoning)
      profiles.set(options.provider, {
        ...profiles.get(options.provider),
        reasoning: undefined,
      })
    const models = new Proxy(snapshot.models, {
      get(target, key) {
        if (key === 'getModel' && typeof target.getModel === 'function')
          return (provider: string, modelId: string) => {
            const model = target.getModel(provider, modelId)
            const capacity = extension.model.context as
              { contextWindow?: number } | undefined
            return model &&
              provider === options.provider &&
              modelId === options.model &&
              capacity?.contextWindow
              ? { ...model, contextWindow: capacity.contextWindow }
              : model
          }
        if (key === 'streamSimple')
          return (model: any, context: any, settings: any) => {
            const call = extension.prepare(options)
            const payload = call.payload as PreparedGptRequest
            const send = extension.preserveReasoning
              ? target.streamSimple.bind(target)
              : target.stream.bind(target)
            return send(
              extension.preserveReasoning
                ? model
                : {
                    ...model,
                    reasoning: Boolean(
                      payload.reasoning || payload.reasoning_effort,
                    ),
                  },
              context,
              {
                ...settings,
                ...(!extension.preserveReasoning
                  ? {
                      reasoningEffort:
                        payload.reasoning?.effort ?? payload.reasoning_effort,
                    }
                  : {}),
                serviceTier: payload.service_tier,
                onPayload(body: Record<string, any>) {
                  const next = { ...body }
                  // Responses may normalize omitted strictness into required fields.
                  // Keep the harness's optional arguments optional on GPT routes.
                  if (
                    model.api === 'openai-responses' &&
                    Array.isArray(next.tools)
                  )
                    next.tools = next.tools.map((tool: Record<string, any>) =>
                      tool.type === 'function' && tool.strict === undefined
                        ? { ...tool, strict: false }
                        : tool,
                    )
                  if (extension.preserveReasoning)
                    return { ...next, ...payload }
                  const reasoning = payload.reasoning
                    ? { ...next.reasoning, ...payload.reasoning }
                    : undefined
                  delete next.reasoning
                  delete next.reasoning_effort
                  return {
                    ...next,
                    ...payload,
                    ...(reasoning ? { reasoning } : {}),
                  }
                },
                onProviderStreamEvent: call.observe,
              },
            )
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return original.streamWithSnapshot.call(
      adapter,
      extension.preserveReasoning
        ? options
        : { ...options, reasoningEffort: fallback },
      { ...snapshot, profiles, models },
    )
  }

  function modelInfo(
    this: NativeAdapter,
    snapshot: Snapshot,
    provider: string,
    model: string,
  ) {
    const base = original.modelInfo.call(this, snapshot, provider, model)
    return capture(provider, model, base, snapshot)?.model ?? base
  }
  function prepareCall(this: NativeAdapter, provider: string, model: string) {
    const snapshot = this.current()
    const base = original.modelInfo.call(this, snapshot, provider, model)
    const extension = capture(provider, model, base, snapshot)
    return Promise.resolve({
      model: extension?.model ?? base,
      stream: (options: any) =>
        stream(this, options, snapshot, extension, base),
    })
  }
  function directStream(this: NativeAdapter, options: any) {
    const snapshot = this.current()
    const base = original.modelInfo.call(
      this,
      snapshot,
      options.provider,
      options.model,
    )
    return stream(
      this,
      options,
      snapshot,
      capture(options.provider, options.model, base, snapshot),
      base,
    )
  }
  prototype.modelInfo = modelInfo
  prototype.prepareCall = prepareCall
  prototype.stream = directStream
  return () => {
    if (prototype.modelInfo === modelInfo)
      prototype.modelInfo = original.modelInfo
    if (prototype.prepareCall === prepareCall)
      prototype.prepareCall = original.prepareCall
    if (prototype.stream === directStream) prototype.stream = original.stream
  }
}
