import { symbols } from '@deepseek-ai/cordis'

/** Prepare scoped clients before DSH captures its immutable step tool admission. */
export function installMcpPreparation(
  service: any,
  prepare: (agent: any, signal?: AbortSignal) => Promise<void>,
): () => void {
  service = service[symbols.original] ?? service
  const original = service.resolve
  if (typeof original !== 'function')
    throw new Error('Unsupported DSH tool admission service')
  let active: typeof prepare | undefined = prepare
  async function resolve(this: any, context: any) {
    context.signal?.throwIfAborted()
    await active?.(context.agent, context.signal)
    return original.call(this, context)
  }
  service.resolve = resolve
  return () => {
    active = undefined
    if (service.resolve === resolve) service.resolve = original
  }
}
