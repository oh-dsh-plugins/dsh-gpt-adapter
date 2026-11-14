import { AsyncLocalStorage } from 'node:async_hooks'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

// The pinned provider omits its list signal on internal filesystem calls.
// Bind cancellation at our owned context boundary without patching DSH.
const operation = new AsyncLocalStorage<{
  signal: AbortSignal | undefined
  filesystem: any
}>()
export const skillFilesystem = Symbol('codex skill filesystem')

export class CodexSkillFileSystem extends FileSystemSkillProvider {
  constructor(
    ctx: any,
    control: ConstructorParameters<typeof FileSystemSkillProvider>[1],
    config: ConstructorParameters<typeof FileSystemSkillProvider>[2],
  ) {
    const filesystems = new WeakMap<object, any>()
    const context = new Proxy(ctx, {
      get(target, key) {
        if (key !== 'get') return Reflect.get(target, key, target)
        return (name: string) => {
          const current = operation.getStore()
          const signal = current?.signal
          signal?.throwIfAborted()
          const value =
            name === 'fs'
              ? (current?.filesystem ?? target.get(name))
              : target.get(name)
          if (name !== 'fs' || !value) return value
          let bound = filesystems.get(value)
          if (!bound) {
            bound = new Proxy(value, {
              get(fs, method) {
                const original = Reflect.get(fs, method, fs)
                if (typeof original !== 'function') return original
                if (
                  !['resolve', 'stat', 'readText', 'listDir'].includes(
                    String(method),
                  )
                )
                  return original.bind(fs)
                return async (...args: any[]) => {
                  const active = operation.getStore()?.signal
                  active?.throwIfAborted()
                  if (active && method === 'resolve')
                    args[1] = { ...args[1], signal: args[1]?.signal ?? active }
                  else if (
                    active &&
                    (method === 'stat' ||
                      method === 'readText' ||
                      method === 'listDir')
                  )
                    args[1] ??= active
                  const result = await original.apply(fs, args)
                  active?.throwIfAborted()
                  return result
                }
              },
            })
            filesystems.set(value, bound)
          }
          return bound
        }
      },
    })
    super(context, control, config)
  }

  override list(options: Parameters<FileSystemSkillProvider['list']>[0]) {
    return this.read(options, () => super.list(options))
  }

  override get(...args: Parameters<FileSystemSkillProvider['get']>) {
    return this.read(args[1], () => super.get(...args))
  }

  private read<T>(options: any, action: () => Promise<T>): Promise<T> {
    const state = {
      signal: options.signal,
      filesystem: options[skillFilesystem] ?? options.scope?.ctx?.get('fs'),
    }
    return operation.run(state, async () => {
      try {
        return await action()
      } finally {
        // Native watchers may inherit this async context and outlive the read.
        state.filesystem = undefined
      }
    })
  }
}
