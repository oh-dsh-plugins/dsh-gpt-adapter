import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installCodexCompatibility } from '../src/codex.js'
import { installCodexInstructions } from '../src/codex-instructions.js'
import { CodexResourceCache } from '../src/codex-config.js'
import type { CodexCompatibilityConfig } from '../src/codex.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.unstubAllEnvs()
  while (cleanup.length) await cleanup.pop()!()
})
const nodeStat = fs.stat,
  nodeRead = fs.readFile
const filesystem = {
  resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
  processPath: (target: any) => target.displayPath,
  stat: async (target: any) => {
    const value = await nodeStat(target.displayPath).catch((error) => {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      return undefined
    })
    return value
      ? {
          type: value.isDirectory()
            ? 'directory'
            : value.isFile()
              ? 'file'
              : 'other',
        }
      : undefined
  },
  readText: (target: any, _signal?: AbortSignal) =>
    nodeRead(target.displayPath, 'utf8'),
  listDir: async (target: any) =>
    (await fs.readdir(target.displayPath, { withFileTypes: true })).map(
      (entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other',
        target: {
          targetKey: join(target.displayPath, entry.name),
          displayPath: join(target.displayPath, entry.name),
        },
      }),
    ),
}
const options = {
  enabled: true,
  importInstructions: false,
  importSkills: true,
  importMcpServers: false,
  importPluginResources: true,
  watch: false,
  pollIntervalMs: 250,
  mcpAllowlist: [],
}
async function put(path: string, text: string) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, text)
}
async function directory() {
  const path = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-lifecycle-'))
  cleanup.push(() => fs.rm(path, { recursive: true, force: true }))
  return path
}
async function skills(
  home: string,
  customFs: any = filesystem,
  overrides: Partial<CodexCompatibilityConfig> = {},
  collectCacheMaxEntries?: number,
) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('fs', customFs)
  await ctx.plugin(
    SkillRegistry,
    collectCacheMaxEntries === undefined ? {} : { collectCacheMaxEntries },
  )
  const registry = ctx.get('skills') as SkillRegistry
  const runtime = installCodexCompatibility(ctx, {
    ...options,
    codexHome: home,
    ...overrides,
  })
  cleanup.push(() => runtime.dispose())
  await new Promise<void>((done) => setImmediate(done))
  await runtime.refresh()
  return { ctx, registry, runtime }
}
const body = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture\n---\nFixture skill body`
const step = (
  ctx: Context,
  agent: any,
  signal = new AbortController().signal,
) =>
  ctx.get('tools')!.resolve({
    agent,
    modelSelection: { provider: 'fixture', model: 'fixture' },
    signal,
  })

describe('Codex operation ownership', () => {
  it('preserves another Agent catalog when a new unchanged scope is observed', async () => {
    const home = await directory()
    await fs.mkdir(join(home, '.git'))
    for (let index = 0; index < 24; index++)
      await put(
        join(home, 'skills', `skill-${index}`, 'SKILL.md'),
        body(`skill-${index}`),
      )
    const readText = vi.fn(filesystem.readText)
    const { ctx, registry } = await skills(home, { ...filesystem, readText })
    const a: any = {},
      b: any = {}
    a.ctx = createScope(ctx, a).ctx
    b.ctx = createScope(ctx, b).ctx
    const counts: number[] = []
    for (const scope of [a, a, b, a]) {
      readText.mockClear()
      await registry.list({ cwd: home, scope })
      counts.push(
        readText.mock.calls.filter(([target]) =>
          target.displayPath.endsWith('/SKILL.md'),
        ).length,
      )
    }
    expect(counts).toEqual([24, 0, 24, 0])
  })

  it.each([true, false])(
    'preserves a warm directory catalog when the same world visits a new directory (scoped=%s)',
    async (scoped) => {
      const home = await directory()
      await fs.mkdir(join(home, '.git'))
      const a = join(home, 'a'),
        b = join(home, 'b')
      await fs.mkdir(a)
      await fs.mkdir(b)
      for (let index = 0; index < 24; index++)
        await put(
          join(home, 'skills', `skill-${index}`, 'SKILL.md'),
          body(`skill-${index}`),
        )
      const readText = vi.fn(filesystem.readText)
      const { ctx, registry } = await skills(home, { ...filesystem, readText })
      const scope: any = {}
      scope.ctx = createScope(ctx, scope).ctx
      const counts: number[] = []
      for (const cwd of [a, a, b, a]) {
        readText.mockClear()
        await registry.list({ cwd, ...(scoped ? { scope } : {}) })
        counts.push(
          readText.mock.calls.filter(([target]) =>
            target.displayPath.endsWith('/SKILL.md'),
          ).length,
        )
      }
      expect(counts).toEqual([24, 0, 24, 0])
    },
  )

  it.each([65, 260])(
    'still revokes a known scope after %s other scopes evict its fallback',
    async (count) => {
      const home = await directory(),
        project = join(home, 'project')
      const plugin = join(home, 'plugins/cache/fixture/active/1.0.0')
      await fs.mkdir(join(project, '.git'), { recursive: true })
      await put(
        join(home, 'config.toml'),
        `[plugins."active@fixture"]\nenabled=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
      )
      const config = join(project, '.codex/config.toml')
      await put(config, '[plugins."active@fixture"]\nenabled=true\n')
      await put(
        join(plugin, '.codex-plugin/plugin.json'),
        JSON.stringify({ name: 'active', skills: './skills' }),
      )
      await put(join(plugin, 'skills/example/SKILL.md'), body('example'))
      const { ctx, registry } = await skills(home, filesystem, {}, 512)
      const a: any = {}
      a.ctx = createScope(ctx, a).ctx
      expect(
        (await registry.list({ cwd: project, scope: a })).map(
          (skill) => skill.name,
        ),
      ).toContain('active-example')
      for (let index = 0; index < count; index++) {
        const scope: any = {}
        scope.ctx = createScope(ctx, scope).ctx
        await registry.list({ cwd: project, scope })
      }
      await put(config, '[plugins."active@fixture"]\nenabled=false\n')
      expect(
        (await registry.list({ cwd: project, scope: a })).map(
          (skill) => skill.name,
        ),
      ).not.toContain('active-example')
      expect(
        await registry.get('active-example', { cwd: project, scope: a }),
      ).toBeUndefined()
    },
  )

  it('uses one scoped filesystem for parent repository discovery and path rules', async () => {
    const home = await directory(),
      project = join(home, 'project'),
      cwd = join(project, 'sub')
    await fs.mkdir(join(project, '.git'), { recursive: true })
    await fs.mkdir(cwd)
    const path = join(project, '.agents/skills/ancestor/SKILL.md'),
      selector = join(home, 'selector')
    await put(path, body('ancestor'))
    await put(
      join(home, 'config.toml'),
      `[[skills.config]]\npath=${JSON.stringify(selector)}\nenabled=false\n`,
    )
    const hostFs = {
      ...filesystem,
      resolve: async (value: string) =>
        filesystem.resolve(value === selector ? path : value),
      stat: (target: any) =>
        target.displayPath.endsWith('/.git')
          ? Promise.resolve(undefined)
          : filesystem.stat(target),
    }
    const { ctx, registry } = await skills(home, hostFs)
    const agent: any = {}
    createScope(ctx, agent)
    agent.ctx = { get: () => filesystem }
    expect(
      (await registry.list({ cwd, scope: agent })).map((skill) => skill.name),
    ).toContain('ancestor')
    expect(
      (await registry.get('ancestor', { cwd, scope: agent }))?.content,
    ).toContain('Fixture skill body')
  })

  it('revokes project plugin skills from a warm catalog and denies previously selected reads', async () => {
    const home = await directory(),
      project = join(home, 'project')
    const plugin = join(home, 'plugins/cache/fixture/active/1.0.0')
    await fs.mkdir(join(project, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[plugins."active@fixture"]\nenabled=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    )
    const config = join(project, '.codex/config.toml')
    await put(config, '[plugins."active@fixture"]\nenabled=true\n')
    await put(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'active', skills: './skills' }),
    )
    await put(join(plugin, 'skills/example/SKILL.md'), body('example'))
    const { registry, runtime } = await skills(home)
    expect(
      (await registry.list({ cwd: project })).map((skill) => skill.name),
    ).toContain('active-example')
    await put(config, '[plugins."active@fixture"]\nenabled=false\n')
    expect(
      (await registry.list({ cwd: project })).map((skill) => skill.name),
    ).not.toContain('active-example')
    expect(
      await registry.get('active-example', { cwd: project }),
    ).toBeUndefined()
    await runtime.refresh()
    expect(
      await registry.get('active-example', { cwd: project }),
    ).toBeUndefined()
  })

  it('keeps a newer scope restriction when an older read finishes later or fails', async () => {
    const home = await directory(),
      project = join(home, 'project')
    await fs.mkdir(join(project, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    )
    const config = join(project, '.codex/config.toml')
    await put(config, '')
    await put(join(home, 'skills/example/SKILL.md'), body('example'))
    let text = '[[skills.config]]\nname="example"\nenabled=true\n',
      hold = false,
      fail = false
    let entered!: () => void,
      release = () => {}
    const started = new Promise<void>((resolve) => (entered = resolve))
    const { registry } = await skills(home, {
      ...filesystem,
      async readText(target: any) {
        if (target.displayPath !== config) return filesystem.readText(target)
        if (fail) throw new Error('fixture unreadable')
        const captured = text
        if (hold) {
          hold = false
          entered()
          await new Promise<void>((resolve) => (release = resolve))
        }
        return captured
      },
    })
    await registry.snapshot({ cwd: project })
    try {
      hold = true
      const old = registry.snapshot({ cwd: project })
      await started
      text = '[[skills.config]]\nname="example"\nenabled=false\n'
      expect((await registry.snapshot({ cwd: project })).skills).toEqual([])
      release()
      expect((await old).skills).toEqual([])
      fail = true
      expect((await registry.snapshot({ cwd: project })).skills).toEqual([])
      expect(await registry.get('example', { cwd: project })).toBeUndefined()
    } finally {
      release()
    }
  })

  it.each(['readText', 'listDir'])(
    'stops native list file reads when disposal wins an uncooperative %s',
    async (stage) => {
      const home = await directory()
      for (let index = 0; index < 24; index++) {
        const name = `skill-${String(index).padStart(2, '0')}`
        await put(join(home, 'skills', name, 'SKILL.md'), body(name))
      }
      let reads = 0,
        entered!: () => void,
        release = () => {},
        signal: AbortSignal | undefined
      const started = new Promise<void>((resolve) => (entered = resolve))
      const { registry, runtime } = await skills(home, {
        ...filesystem,
        async readText(target: any, current?: AbortSignal) {
          if (target.displayPath.endsWith('/SKILL.md')) {
            reads++
            if (reads === 1 && stage === 'readText') {
              signal = current
              entered()
              await new Promise<void>((resolve) => (release = resolve))
            }
          }
          return filesystem.readText(target)
        },
        async listDir(target: any, current?: AbortSignal) {
          if (
            stage === 'listDir' &&
            target.displayPath === join(home, 'skills')
          ) {
            signal = current
            entered()
            await new Promise<void>((resolve) => (release = resolve))
          }
          return filesystem.listDir(target)
        },
      })
      try {
        const listing = registry.list({ cwd: home }).catch((error) => error)
        await started
        await runtime.dispose()
        expect(signal?.aborted).toBe(true)
        release()
        expect(await listing).toBeInstanceOf(Error)
        expect(reads).toBe(stage === 'readText' ? 1 : 0)
      } finally {
        release()
      }
    },
  )

  it('keeps policy fallback and native skill reads inside their filesystem scope', async () => {
    const home = await directory(),
      project = join(home, 'project')
    const plugin = join(home, 'plugins/cache/fixture/active/1.0.0')
    await fs.mkdir(join(project, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[plugins."active@fixture"]\nenabled=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    )
    const config = join(project, '.codex/config.toml')
    await put(config, '')
    await put(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'active', skills: './skills' }),
    )
    const skill = join(plugin, 'skills/example/SKILL.md')
    await put(skill, body('example'))
    const { ctx, registry } = await skills(home)
    let broken = true
    const world = (name: string) => {
      const agent: any = {}
      const own = createScope(ctx, agent)
      const fs = {
        ...filesystem,
        readText(target: any) {
          if (target.displayPath === config)
            return Promise.resolve(
              name === 'B' && broken
                ? 'broken = ['
                : '[plugins."active@fixture"]\nenabled=true\n',
            )
          if (target.displayPath === skill)
            return Promise.resolve(`${body('example')}\nWORLD_${name}`)
          return filesystem.readText(target)
        },
      }
      agent.ctx = {
        get: (name: string) => (name === 'fs' ? fs : own.ctx.get(name)),
      }
      return agent
    }
    const a = world('A'),
      b = world('B')
    expect(
      (await registry.get('active-example', { cwd: project, scope: a }))
        ?.content,
    ).toContain('WORLD_A')
    expect(
      await registry.get('active-example', { cwd: project, scope: b }),
    ).toBeUndefined()
    broken = false
    expect(
      (await registry.get('active-example', { cwd: project, scope: b }))
        ?.content,
    ).toContain('WORLD_B')
    expect(
      (await registry.get('active-example', { cwd: project, scope: a }))
        ?.content,
    ).toContain('WORLD_A')
  })

  it('checks public resources once per observation and once per warm skill operation', async () => {
    const home = await directory()
    await fs.mkdir(join(home, '.git'))
    await put(
      join(home, 'config.toml'),
      Array.from(
        { length: 14 },
        (_, index) => `[plugins."plugin${index}@fixture"]\nenabled=true\n`,
      ).join('\n'),
    )
    for (let index = 0; index < 14; index++)
      await put(
        join(
          home,
          `plugins/cache/fixture/plugin${index}/1.0.0/.codex-plugin/plugin.json`,
        ),
        JSON.stringify({ name: `plugin${index}`, mcpServers: {} }),
      )
    await put(join(home, 'skills/example/SKILL.md'), body('example'))
    const { registry, runtime } = await skills(home)
    await registry.list({ cwd: home })
    const metadata = vi.spyOn(fs, 'stat')
    syncBuiltinESMExports()
    await registry.list({ cwd: home })
    expect(metadata).toHaveBeenCalledTimes(1)
    metadata.mockClear()
    await registry.get('example', { cwd: home })
    expect(metadata).toHaveBeenCalledTimes(1)
    metadata.mockClear()
    await runtime.refresh()
    expect(metadata.mock.calls.length).toBeLessThan(50)
  })
})

describe('Codex MCP ownership', () => {
  it('finishes the requested refresh round while polling queues later rounds', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n',
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    let block = true,
      admitted = false
    const releases: Array<() => void> = []
    const ensure = vi.fn(async () => {
      if (block) await new Promise<void>((resolve) => releases.push(resolve))
      return home
    })
    ctx.provide('fs', filesystem as any)
    ctx.provide('workingDirectory', { ensure } as any)
    ctx.provide('tools', {
      register: () => () => {},
      resolve: async () => ({ dispose() {} }),
    } as any)
    ctx.provide('agents', { list: () => [] } as any)
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importMcpServers: true,
      watch: true,
    })
    cleanup.push(() => runtime.dispose())
    await new Promise<void>((done) => setImmediate(done))
    await runtime.refresh()
    const observations = vi.spyOn(CodexResourceCache.prototype, 'observe')
    const agent = {
      ctx: {
        get: () => filesystem,
        plugin: () => ({ dispose: async () => {} }),
      },
    }
    const pending = step(ctx, agent).then(() => {
      admitted = true
    })
    try {
      await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1))
      await vi.waitFor(() =>
        expect(observations.mock.calls.length).toBeGreaterThanOrEqual(2),
      )
      releases.shift()!()
      await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(admitted).toBe(true), { timeout: 500 })
    } finally {
      block = false
      for (const release of releases) release()
      await runtime.dispose()
      await pending
    }
  })

  it('refreshes public plugin resources while a client startup remains pending', async () => {
    const home = await directory(),
      plugin = join(home, 'plugins/cache/fixture/active/1.0.0')
    const manifest = join(plugin, '.codex-plugin/plugin.json')
    const declaration = (name: string) =>
      JSON.stringify({ name: 'active', skills: `./${name}`, mcpServers: {} })
    await fs.mkdir(join(home, '.git'))
    await put(
      join(home, 'config.toml'),
      '[plugins."active@fixture"]\nenabled=true\n[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\nstartup_timeout_sec=60\n',
    )
    await put(manifest, declaration('old'))
    for (const name of ['old', 'new'])
      await put(join(plugin, name, 'example/SKILL.md'), body(name))
    let scans = 0
    const original = CodexResourceCache.prototype.observe
    vi.spyOn(CodexResourceCache.prototype, 'observe').mockImplementation(
      function (this: CodexResourceCache) {
        const reader = original.call(this)
        let observed = false
        return {
          ...reader,
          async read<T>(path: string, kind: string, load: () => Promise<T>) {
            const result = await reader.read(path, kind, load)
            if (path === manifest && !observed) {
              observed = true
              scans++
            }
            return result
          },
        }
      },
    )
    const { ctx, registry, runtime } = await skills(home, filesystem, {
      importMcpServers: true,
      watch: true,
      pollIntervalMs: 50,
    })
    ctx.provide('agents', { list: () => [] } as any)
    ctx.provide('workingDirectory', { ensure: async () => home } as any)
    ctx.provide('tools', {
      resolve: async () => ({ dispose() {} }),
      register: () => () => {},
    } as any)
    await new Promise<void>((done) => setImmediate(done))
    let release = () => {},
      entered!: () => void,
      initialized = false
    const started = new Promise<void>((resolve) => (entered = resolve))
    const agent = {
      ctx: {
        get: () => filesystem,
        plugin() {
          const fiber: any = new Promise<void>(
            (resolve) => (release = resolve),
          ).then(() => {
            initialized = true
          })
          fiber.dispose = async () => release()
          entered()
          return fiber
        },
      },
    }
    const pending = step(ctx, agent)
    try {
      await started
      const before = scans
      await vi.waitFor(() => expect(scans).toBeGreaterThan(before))
      await put(manifest, declaration('new'))
      await vi.waitFor(async () =>
        expect(
          (await registry.list({ cwd: home })).map((skill) => skill.name),
        ).toContain('active-new'),
      )
      expect(initialized).toBe(false)
    } finally {
      release()
      await pending
      await runtime.dispose()
    }
  })

  it('retains failed idle cleanup ownership and blocks client replacement', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n',
    )
    const failure = new Error('fixture transport closure unconfirmed')
    const spawn = vi.fn(() => ({
      dispose: async () => {
        throw failure
      },
    }))
    const warn = vi.fn(),
      handlers = new Map<string, (...args: any[]) => any>()
    const tools = { resolve: async (_context: any) => ({ dispose() {} }) }
    const ctx: any = {
      effect() {},
      inject(_deps: string[], apply: (child: any) => void) {
        const effects: Array<() => void> = []
        apply({
          tools,
          workingDirectory: { ensure: async () => home },
          get: () => filesystem,
          agents: { list: () => [] },
          logger: { warn },
          effect: (setup: () => () => void) => effects.push(setup()),
          on: (name: string, handler: (...args: any[]) => any) =>
            handlers.set(name, handler),
        })
        return {
          dispose: async () => {
            for (const dispose of effects) dispose()
          },
        }
      },
    }
    const agent = { ctx: { get: () => filesystem, plugin: spawn } }
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importMcpServers: true,
      mcpIdleTimeoutMs: 1,
    })
    try {
      await tools.resolve({ agent })
      handlers.get('agent/status')!({ agent, status: 'idle' })
      await vi.waitFor(() => expect(warn).toHaveBeenCalled())
      await expect(tools.resolve({ agent })).rejects.toBe(failure)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(
        runtime
          .status()
          .items.some((entry) => entry.reason?.includes('replacement blocked')),
      ).toBe(true)
      await expect(runtime.dispose()).rejects.toBe(failure)
    } finally {
      await runtime.dispose().catch(() => {})
    }
  })

  async function host(
    home: string,
    createFiber: () => any,
    mcpIdleTimeoutMs = 60000,
  ) {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const agents = Array.from({ length: 10 }, (_, index) => ({
      id: `fixture-${index}`,
      ctx: { get: () => filesystem, plugin: createFiber },
    }))
    ctx.provide('fs', filesystem as any)
    ctx.provide('workingDirectory', { ensure: async () => home } as any)
    ctx.provide('tools', {
      register: () => () => {},
      resolve: async () => ({ dispose() {} }),
    } as any)
    ctx.provide('agents', { list: () => agents } as any)
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importMcpServers: true,
      mcpIdleTimeoutMs,
    })
    cleanup.push(() => runtime.dispose())
    await new Promise<void>((done) => setImmediate(done))
    await runtime.refresh()
    return { ctx, agents, runtime }
  }

  it('cancels a new admission during idle cleanup without canceling cleanup or replacing its client', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n',
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const dispose = vi.fn(async () => gate)
    const create = vi.fn(() => ({ dispose }))
    const { ctx, agents } = await host(home, create, 1)
    const agent = agents[0]!
    await step(ctx, agent)
    ctx.emit('agent/status', { agent, status: 'idle' } as any)
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
    const caller = new AbortController()
    const reason = new Error('fixture caller canceled')
    let settled = false,
      failure: unknown
    const pending = step(ctx, agent, caller.signal).then(
      () => {
        settled = true
      },
      (error) => {
        settled = true
        failure = error
      },
    )
    try {
      caller.abort(reason)
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 })
      expect(failure).toBe(reason)
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(create).toHaveBeenCalledTimes(1)
      release()
      await step(ctx, agent)
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await pending
    }
  })

  it('keeps dormant Agents disconnected, bounds startups and reclaims idle clients', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      Array.from(
        { length: 5 },
        (_, index) =>
          `[mcp_servers.fixture${index}]\nurl="https://fixture.invalid/${index}"\n`,
      ).join('\n'),
    )
    let allocated = 0,
      live = 0,
      starting = 0,
      peak = 0,
      block = true
    const releases: Array<() => void> = []
    const { ctx, agents, runtime } = await host(home, () => {
      allocated++
      live++
      starting++
      peak = Math.max(peak, starting)
      let release!: () => void,
        disposed = false
      const fiber: any = new Promise<void>(
        (resolve) => (release = resolve),
      ).then(() => {
        starting--
      })
      fiber.dispose = async () => {
        if (!disposed) {
          disposed = true
          live--
          release()
        }
      }
      if (block) releases.push(release)
      else release()
      return fiber
    })
    expect(allocated).toBe(0)
    const tasks = agents.map((agent) => step(ctx, agent))
    try {
      await vi.waitFor(() => expect(allocated).toBe(4))
      expect(peak).toBe(4)
      block = false
      for (const release of releases) release()
      await Promise.all(tasks)
      expect(allocated).toBe(50)
      expect(peak).toBe(4)
      vi.useFakeTimers()
      for (const agent of agents)
        ctx.emit('agent/status', { agent, status: 'idle' } as any)
      await vi.advanceTimersByTimeAsync(60000)
      expect(live).toBe(0)
      vi.useRealTimers()
      await step(ctx, agents[0])
      expect(live).toBe(5)
      await runtime.dispose()
      expect(live).toBe(0)
    } finally {
      block = false
      for (const release of releases) release()
      await Promise.allSettled(tasks)
    }
  })

  it('closes starting clients before waiting for teardown and cancels queued startups', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      Array.from(
        { length: 5 },
        (_, index) =>
          `[mcp_servers.fixture${index}]\nurl="https://fixture.invalid/${index}"\nstartup_timeout_sec=60\n`,
      ).join('\n'),
    )
    const releases: Array<() => void> = []
    const created = vi.fn()
    const dispose = vi.fn()
    const { ctx, agents, runtime } = await host(home, () => {
      created()
      let release!: () => void
      const fiber: any = new Promise<void>((resolve) => (release = resolve))
      releases.push(release)
      fiber.dispose = async () => {
        dispose()
        release()
      }
      return fiber
    })
    const starting = Promise.all(agents.map((agent) => step(ctx, agent)))
    let stopping: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(4))
      stopping = runtime.dispose()
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(4), {
        timeout: 500,
      })
      await stopping
      await starting
      expect(created).toHaveBeenCalledTimes(4)
    } finally {
      for (const release of releases) release()
      await starting
      await stopping
    }
  })

  it('does not multiply public metadata checks when more Agents execute', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n' +
        Array.from(
          { length: 14 },
          (_, index) => `[plugins."plugin${index}@fixture"]\nenabled=true\n`,
        ).join('\n'),
    )
    for (let index = 0; index < 14; index++)
      await put(
        join(
          home,
          `plugins/cache/fixture/plugin${index}/1.0.0/.codex-plugin/plugin.json`,
        ),
        JSON.stringify({ name: `plugin${index}`, mcpServers: {} }),
      )
    const { ctx, agents, runtime } = await host(home, () => ({
      dispose: async () => {},
    }))
    const metadata = vi.spyOn(fs, 'stat')
    syncBuiltinESMExports()
    await step(ctx, agents[0])
    metadata.mockClear()
    await runtime.refresh()
    const single = metadata.mock.calls.length
    for (const agent of agents.slice(1)) await step(ctx, agent)
    metadata.mockClear()
    await runtime.refresh()
    expect(single).toBeGreaterThan(1)
    expect(metadata).toHaveBeenCalledTimes(single)
  })

  it.each([0, 2500])(
    'honors configurable idle retention without closing running clients (%s ms)',
    async (timeout) => {
      const home = await directory()
      await put(
        join(home, 'config.toml'),
        '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n',
      )
      const dispose = vi.fn(async () => {})
      const { ctx, agents, runtime } = await host(
        home,
        () => ({ dispose }),
        timeout,
      )
      await step(ctx, agents[0])
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(120000)
      expect(dispose).not.toHaveBeenCalled()
      ctx.emit('agent/status', { agent: agents[0], status: 'idle' } as any)
      await vi.advanceTimersByTimeAsync(2000)
      expect(dispose).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120000)
      expect(dispose).toHaveBeenCalledTimes(timeout === 0 ? 0 : 1)
      vi.useRealTimers()
      await runtime.dispose()
      expect(dispose).toHaveBeenCalledTimes(1)
    },
  )

  it('awaits transport teardown even when another owner already claimed the raw disposer', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n',
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fiber: any = { dispose: vi.fn(), inertia: undefined }
    const { ctx, agents, runtime } = await host(home, () => fiber)
    await step(ctx, agents[0])
    fiber.inertia = gate.then(() => {
      fiber.inertia = undefined
    })
    let finished = false
    const stopping = runtime.dispose().then(() => {
      finished = true
    })
    try {
      await new Promise<void>((done) => setImmediate(done))
      expect(fiber.dispose).toHaveBeenCalledTimes(1)
      expect(finished).toBe(false)
    } finally {
      release()
      await stopping
    }
    expect(finished).toBe(true)
  })
})

describe('Codex instruction history', () => {
  it('examines appended nodes only and rebuilds after replacement or session restore', async () => {
    const home = await directory()
    await fs.mkdir(join(home, '.git'))
    await put(join(home, 'AGENTS.md'), 'Fixture instructions')
    vi.stubEnv('DSH_HOME', join(home, 'dsh'))
    vi.stubEnv('DSH_AGENTS_HOME', join(home, 'agents'))
    let gate: any
    installCodexInstructions(
      {
        on: (_name: string, handler: any) => (gate = handler),
        workingDirectory: { ensure: async () => home },
        get: () => filesystem,
        logger: { warn() {} },
      },
      home,
    )
    const decision = {
      kind: 'accept',
      messages: [{ source: { kind: 'human' }, content: [] }],
    }
    const signal = new AbortController().signal
    const session = {
      surface: { nodes: [] as number[], replaceGeneration: 0 },
      eventAt: vi.fn((seq: number): any => events[seq]),
    }
    const events: any[] = []
    const run = (value = session) =>
      gate(
        { agent: { session: value }, messages: [], signal },
        async () => decision,
      )
    const initial = await run()
    events.push({
      type: 'user/message',
      data: initial.messages.find(
        (message: any) => message.source?.kind === 'codex-compat',
      ),
    })
    for (let index = 1; index < 10000; index++)
      events.push({ type: 'assistant/message', data: {} })
    session.surface.nodes = events.map((_, index) => index)
    await run()
    expect(session.eventAt).toHaveBeenCalledTimes(10000)
    session.eventAt.mockClear()
    for (let index = 0; index < 3; index++) {
      session.surface.nodes.push(events.length)
      events.push({ type: 'assistant/message', data: {} })
    }
    await run()
    expect(session.eventAt).toHaveBeenCalledTimes(3)
    session.eventAt.mockClear()
    await run()
    expect(session.eventAt).not.toHaveBeenCalled()
    session.surface.replaceGeneration++
    session.surface.nodes = [10000, 10001, 10002]
    expect(
      (await run()).messages.some(
        (message: any) => message.source?.kind === 'codex-compat',
      ),
    ).toBe(true)
    expect(session.eventAt).toHaveBeenCalledTimes(3)
    session.eventAt.mockClear()
    await run({ ...session })
    expect(session.eventAt).toHaveBeenCalledTimes(3)
  })
})
