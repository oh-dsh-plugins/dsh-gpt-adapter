import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { installReasoningSelection } from '../src/client/reasoning-selection.js'

const model = (id: string, ...efforts: string[]) => ({
  id,
  reasoning: efforts.length
    ? { defaultEffort: 'medium', efforts: efforts.map((id) => ({ id })) }
    : undefined,
})
const pick = (model: string, reasoningEffort?: string, provider = 'test') => ({
  provider,
  model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
})
const groups = [
  {
    id: 'test',
    models: [
      model('a', 'medium', 'high'),
      model('b', 'medium', 'high'),
      model('c', 'medium'),
      model('d'),
    ],
  },
  { id: 'other', models: [model('a', 'medium', 'high')] },
]

function fixture(initial = pick('a', 'medium')) {
  let current = initial
  const native = vi.fn(async (selection: ReturnType<typeof pick>) => {
    current = selection
    return { ok: true, value: undefined }
  })
  return {
    select: native,
    store: { getSnapshot: () => ({ current, groups }) },
  }
}

describe('reasoning effort on native model switches', () => {
  afterEach(() => vi.unstubAllGlobals())

  const isManaged = async ({ provider }: ReturnType<typeof pick>) =>
    provider === 'test'

  it('recovers the session choice after a page reload on a model with no reasoning', async () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key),
      setItem: (key: string, value: string) => data.set(key, value),
    })
    const before = fixture()
    const first = { directoryFor: (_id: string) => before }
    const unload = installReasoningSelection(first as never, isManaged)
    try {
      await first.directoryFor('session').select(pick('a', 'high'))
      await first.directoryFor('session').select(pick('d'))
      expect(before.select).toHaveBeenLastCalledWith(pick('d'))
    } finally {
      unload()
    }
    const after = fixture(pick('d'))
    const second = { directoryFor: (_id: string) => after }
    const dispose = installReasoningSelection(second as never, isManaged)
    try {
      const directory = second.directoryFor('session')
      await directory.select(pick('b', 'medium'))
      expect(after.select).toHaveBeenLastCalledWith(pick('b', 'high'))
      await directory.select(pick('b', 'medium'))
      await directory.select(pick('a', 'medium'))
      expect(after.select).toHaveBeenLastCalledWith(pick('a', 'medium'))
    } finally {
      dispose()
    }
  })
  it('keeps the latest session choice through both native selectors and does not leak across sessions', async () => {
    const one = fixture()
    const two = fixture()
    class Resolver extends Service {
      constructor(ctx: Context) {
        super(ctx, 'reasoningTestResolver')
      }
      directoryFor(id: string) {
        return id === 'one' ? one : two
      }
    }
    const ctx = new Context()
    new Resolver(ctx)
    const get = () => Reflect.get(ctx, 'reasoningTestResolver') as Resolver
    const dispose = installReasoningSelection(get() as never, isManaged)
    try {
      const composer = get().directoryFor('one')
      const command = get().directoryFor('one')
      expect(command).toBe(composer)
      expect(composer.store).toBe(one.store)
      // Visiting a model on native defaults must not pin those defaults.
      await composer.select(pick('b'))
      await command.select(pick('a'))
      await composer.select(pick('a', 'high'))
      await command.select(pick('b'))
      expect(one.select).toHaveBeenLastCalledWith(pick('b', 'high'))
      await composer.select(pick('c'))
      expect(one.select).toHaveBeenLastCalledWith(pick('c'))
      // /model includes the effective default when reselecting the fallback.
      await command.select(pick('c', 'medium'))
      expect(one.select).toHaveBeenLastCalledWith(pick('c', 'medium'))
      await command.select(pick('a', 'medium', 'other'))
      expect(one.select).toHaveBeenLastCalledWith(pick('a', 'medium', 'other'))
      await command.select(pick('d'))
      expect(one.select).toHaveBeenLastCalledWith(pick('d'))
      await composer.select(pick('b', 'medium'))
      expect(one.select).toHaveBeenLastCalledWith(pick('b', 'high'))
      await composer.select(pick('b', 'medium'))
      await command.select(pick('a', 'medium', 'other'))
      expect(one.select).toHaveBeenLastCalledWith(pick('a', 'medium', 'other'))
      await command.select(pick('a', 'medium'))
      expect(one.select).toHaveBeenLastCalledWith(pick('a', 'medium'))
      await composer.select(pick('b', 'medium'))
      expect(one.select).toHaveBeenLastCalledWith(pick('b', 'medium'))
      await get().directoryFor('two').select(pick('b', 'medium'))
      expect(two.select).toHaveBeenLastCalledWith(pick('b', 'medium'))
      dispose()
      expect(get().directoryFor('one')).toBe(one)
      expect(get().directoryFor).not.toBeUndefined()
      await command.select(pick('a', 'medium'))
      expect(one.select).toHaveBeenLastCalledWith(pick('a', 'medium'))
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps distinct selections ordered while the first switch is pending', async () => {
    const native = fixture(pick('a', 'high'))
    const resolver = { directoryFor: (_id: string) => native }
    let accept!: (value: boolean) => void
    const check = new Promise<boolean>((resolve) => {
      accept = resolve
    })
    const dispose = installReasoningSelection(resolver as never, () => check)
    try {
      const directory = resolver.directoryFor('session')
      const switchModel = directory.select(pick('b'))
      const chooseEffort = directory.select(pick('b', 'medium'))
      await Promise.resolve()
      expect(native.select).not.toHaveBeenCalled()
      accept(true)
      await Promise.all([switchModel, chooseEffort])
      await directory.select(pick('a'))
      expect(native.select.mock.calls.map(([selection]) => selection)).toEqual([
        pick('b', 'high'),
        pick('b', 'medium'),
        pick('a', 'medium'),
      ])
    } finally {
      dispose()
    }
  })

  it('keeps explicit non-default requests and does not remember failed choices', async () => {
    const native = fixture()
    const resolver = { directoryFor: () => native }
    const dispose = installReasoningSelection(resolver as never, isManaged)
    try {
      const directory = resolver.directoryFor()
      native.select.mockResolvedValueOnce({ ok: false } as never)
      await expect(directory.select(pick('a', 'high'))).resolves.toMatchObject({
        ok: false,
      })
      await directory.select(pick('b', 'medium'))
      await directory.select(pick('a', 'medium'))
      expect(native.select).toHaveBeenLastCalledWith(pick('a', 'medium'))
      await directory.select(pick('b', 'high'))
      expect(native.select).toHaveBeenLastCalledWith(pick('b', 'high'))
    } finally {
      dispose()
    }
  })
})
