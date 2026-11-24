import type {
  ModelDirectory,
  ModelDirectoryResolver,
  ModelDirectoryState,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'

type Selection = Parameters<ModelDirectory['select']>[0]
type Directory = Pick<ModelDirectory, 'select' | 'store'>
type Resolver = Pick<ModelDirectoryResolver, 'directoryFor'>

const preferenceKey = 'dsh-gpt-adapter:session-reasoning:v1'
const preferenceLimit = 128

function preferences(sessionId: string) {
  let state: string | null | undefined
  let storageUnavailable = false
  function read(): Map<string, string | null> | undefined {
    if (storageUnavailable) return undefined
    try {
      const entries: unknown = JSON.parse(
        localStorage.getItem(preferenceKey) ?? '[]',
      )
      if (!Array.isArray(entries)) return new Map()
      return new Map(
        entries.filter(
          (entry): entry is [string, string | null] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            (typeof entry[1] === 'string' || entry[1] === null),
        ),
      )
    } catch {
      return undefined
    }
  }
  return {
    get: () => {
      const entries = read()
      return entries ? entries.get(sessionId) : state
    },
    set(effort: string | null) {
      state = effort
      try {
        const entries = read()
        if (!entries) return
        entries.delete(sessionId)
        entries.set(sessionId, effort)
        localStorage.setItem(
          preferenceKey,
          JSON.stringify([...entries].slice(-preferenceLimit)),
        )
      } catch {
        // Reads may work even when writes are blocked, for example at quota.
        storageUnavailable = true
      }
    },
  }
}

function sameRoute(left: Selection, right: Selection) {
  return left.provider === right.provider && left.model === right.model
}

function reasoningFor(state: ModelDirectoryState, selection: Selection) {
  return state.groups
    .find((group) => group.id === selection.provider)
    ?.models.find((model) => model.id === selection.model)?.reasoning
}

/** Keep both native selectors on the same session-owned selection and RPC. */
export function installReasoningSelection(
  service: Resolver | undefined,
  isManaged: (selection: Selection) => Promise<boolean>,
) {
  if (!service) return () => {}
  // Cordis traces service calls through a new proxy at each use site.
  const resolver =
    Reflect.get(service, Symbol.for('cordis.original')) ?? service
  const original: Resolver['directoryFor'] = resolver.directoryFor
  if (typeof original !== 'function') return () => {}
  const directories = new WeakMap<ModelDirectory, ModelDirectory>()
  let active = true

  function directoryFor(this: Resolver, ...args: Parameters<typeof original>) {
    const directory = original.apply(this, args)
    if (!active || typeof directory?.select !== 'function') return directory
    const existing = directories.get(directory)
    if (existing) return existing
    const preferred = preferences(String(args[0]))
    let tail = Promise.resolve()
    const select: Directory['select'] = (selection) => {
      const operation = tail.then(async () => {
        if (!active) return directory.select(selection)
        const state = directory.store.getSnapshot()
        const current = state.current
        const reasoning = reasoningFor(state, selection)
        const effort = selection.reasoningEffort
        const stored = preferred.get()
        let next = selection
        let remembered: string | null | undefined
        if (current && sameRoute(current, selection)) {
          // /model submits the current effective effort on a same-route pick.
          // Native effort controls only submit an actual change.
          const effective = current.reasoningEffort ?? reasoning?.defaultEffort
          if (effort !== effective) remembered = effort ?? null
        } else if (
          effort === undefined ||
          effort === reasoning?.defaultEffort
        ) {
          const desired =
            stored === undefined ? current?.reasoningEffort : stored
          if (stored === undefined) remembered = desired
          if (
            typeof desired === 'string' &&
            desired !== effort &&
            reasoning?.efforts.some(({ id }) => id === desired)
          ) {
            const managed = await isManaged(selection).catch(() => false)
            if (active && managed)
              next = { ...selection, reasoningEffort: desired }
          }
        } else {
          remembered = effort
        }
        const result = await directory.select(next)
        if (active && result.ok && remembered !== undefined)
          preferred.set(remembered)
        return result
      })
      tail = operation.then(
        () => {},
        () => {},
      )
      return operation
    }
    const wrapped = new Proxy(directory, {
      get(target, key) {
        if (key === 'select') return select
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    directories.set(directory, wrapped)
    return wrapped
  }
  const descriptor = Object.getOwnPropertyDescriptor(resolver, 'directoryFor')
  resolver.directoryFor = directoryFor
  return () => {
    active = false
    if (resolver.directoryFor !== directoryFor) return
    if (descriptor) Object.defineProperty(resolver, 'directoryFor', descriptor)
    else Reflect.deleteProperty(resolver, 'directoryFor')
  }
}
