import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as native from '@deepseek-ai/dsh-llm-pi-ai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as plugin from '../lib/index.js'
import { installNativeAdapterBridge } from '../src/native-adapter.js'

it('dispatches the same provider to its own registered adapter in independent graphs', async () => {
  const prototype = native.PiAiAdapter.prototype as any
  const original = prototype.prepareCall
  const cleanups: Array<() => void | Promise<unknown>> = []
  async function open(name: string) {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const llm = new LlmRuntime(ctx)
    ctx.provide('settings', {
      configure: () => () => {},
      describe: () => [],
    } as any)
    const registered = vi.spyOn(llm, 'registerAdapter')
    native.apply(
      ctx,
      native.Config({
        providers: {
          fixture: {
            api: 'openai-responses',
            baseURL: 'https://fixture.invalid/v1',
            models: [{ id: 'gpt-test' }],
          },
        },
      }),
    )
    const adapter = registered.mock.calls[0]![1]
    const dispose = installNativeAdapterBridge(
      prototype,
      (_p, _m, base) => ({ model: { ...base, name } }) as any,
      llm,
    )
    cleanups.push(dispose)
    return { adapter, dispose }
  }
  try {
    const a = await open('first')
    const patched = prototype.prepareCall
    const b = await open('second')
    expect(prototype.prepareCall).toBe(patched)
    const model = async (x: typeof a) =>
      (await x.adapter.prepareCall('fixture', 'gpt-test')).model.name
    expect(await model(a)).toBe('first')
    expect(await model(b)).toBe('second')
    a.dispose()
    expect(await model(b)).toBe('second')
    expect(await model(a)).not.toBe('second')
    b.dispose()
    expect(prototype.prepareCall).toBe(original)
  } finally {
    while (cleanups.length) await cleanups.pop()!()
  }
})

it('keeps one prototype owner across isolated Cordis registrations and replacement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-owner-'))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  const methods = () => {
    const p = native.PiAiAdapter.prototype as any
    return [p.modelInfo, p.prepareCall, p.stream]
  }
  const original = methods()
  let settingsUsers = 0
  const options = { routes: {}, codexCompatibility: { enabled: false } }
  try {
    ctx.provide('settings', {
      configure: () => {
        settingsUsers++
        return () => {
          settingsUsers--
        }
      },
      describe: () => [],
    } as any)
    ctx.provide('credentials', {} as any)
    await ctx.plugin(LlmRuntime)
    const first = await ctx.plugin(plugin, options)
    const owner = ctx.get('gptModels')
    const installed = methods()
    installed.forEach((method, i) => expect(method).not.toBe(original[i]))
    const scoped = ctx.isolate('gptModels')
    const duplicate = scoped.plugin(plugin, options)
    await expect(duplicate.await()).rejects.toThrow(
      'already owns this LLM service',
    )
    expect(methods()).toEqual(installed)
    expect(ctx.get('gptModels')?.enabledProviders()).toEqual([])
    expect(owner?.enabledProviders()).toEqual([])
    expect(scoped.get('gptModels') === undefined).toBe(true)
    expect(settingsUsers).toBe(1)
    await duplicate.dispose()
    expect(methods()).toEqual(installed)
    await first.dispose()
    expect(settingsUsers).toBe(0)
    expect(methods()).toEqual(original)
    const replacement = await scoped.plugin(plugin, options)
    expect(methods()[1]).not.toBe(original[1])
    await replacement.dispose()
    expect(methods()).toEqual(original)
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
