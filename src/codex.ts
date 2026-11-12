import { symbols } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  discoverCodexSnapshot,
  resolveCodexHome,
  readCodexConfig,
  projectDirectories,
  skillEnabled,
  skillEnabledWithFs,
  type CompatibilityItem,
  type CodexSnapshot,
  type CodexMcpConfig,
} from './codex-config.js'
import { installCodexInstructions } from './codex-instructions.js'

export type CodexCompatibilityConfig = {
  enabled: boolean
  codexHome?: string
  importInstructions: boolean
  importSkills: boolean
  importMcpServers: boolean
  importPluginResources: boolean
  watch: boolean
  pollIntervalMs: number
  mcpAllowlist: string[]
}
export type CodexCompatibilityRuntime = {
  status(): {
    enabled: boolean
    refreshing: boolean
    items: CompatibilityItem[]
  }
  refresh(): Promise<void>
  dispose(): Promise<void>
}
const fingerprint = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex')

// Same public-name encoding as the pinned DSH MCP client (DeepSeek MIT).
function publicToolName(server: string, name: string) {
  const joined = `mcp__${server}__${name}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (joined === normalized && joined.length <= 64) return joined
  const hash = createHash('sha256')
    .update(`${server}\0${name}`)
    .digest('hex')
    .slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

function installSkillPolicy(
  ctx: any,
  snapshot: () => CodexSnapshot | undefined,
  home: string,
  scopedConfig?: (options: any) => Promise<any>,
) {
  const service = ctx.skills[symbols.original] ?? ctx.skills
  const original = {
    list: service.list,
    snapshot: service.snapshot,
    get: service.get,
  }
  const policy = async (options: any) =>
    options?.cwd
      ? (scopedConfig?.(options) ??
        readCodexConfig(home, options.cwd, ctx.get('fs'), options.signal))
      : (snapshot()?.config ?? {})
  const allowed = (config: any, skill: any, signal?: AbortSignal) => {
    const fs = ctx.get('fs')
    return fs
      ? skillEnabledWithFs(config, skill, undefined, fs, signal)
      : Promise.resolve(skillEnabled(config, skill))
  }
  async function list(this: any, ...args: any[]) {
    const options = args[0]
    const config = await policy(options)
    const entries = await original.list.apply(this, args)
    return (
      await Promise.all(
        entries.map(async (skill: any) =>
          (await allowed(config, skill, options?.signal)) ? skill : undefined,
        ),
      )
    ).filter(Boolean)
  }
  async function catalog(this: any, ...args: any[]) {
    const options = args[0]
    const result = await original.snapshot.apply(this, args)
    const config = await policy(options)
    const skills = (
      await Promise.all(
        result.skills.map(async (skill: any) =>
          (await allowed(config, skill, options?.signal)) ? skill : undefined,
        ),
      )
    ).filter(Boolean)
    return {
      ...result,
      skills,
    }
  }
  async function get(this: any, ...args: any[]) {
    const options = args[1]
    const result = await original.get.apply(this, args)
    return result &&
      (await allowed(await policy(options), result, options?.signal))
      ? result
      : undefined
  }
  service.list = list
  service.snapshot = catalog
  service.get = get
  ctx.effect(() => () => {
    if (service.list === list) service.list = original.list
    if (service.snapshot === catalog) service.snapshot = original.snapshot
    if (service.get === get) service.get = original.get
  })
}

export function installCodexCompatibility(
  ctx: any,
  config: CodexCompatibilityConfig,
): CodexCompatibilityRuntime {
  let closed = false
  let refreshing = false
  let latest: CodexSnapshot | undefined
  let items: CompatibilityItem[] = []
  let tail: Promise<void> = Promise.resolve()
  type Client = {
    key: string
    fiber: any
    state: CompatibilityItem
    attempts: number
    retryAt: number
  }
  type AgentState = {
    agent: any
    clients: Map<string, Client>
    snapshot?: CodexSnapshot
    cwd?: string
    items: CompatibilityItem[]
    tail: Promise<void>
    disposed: boolean
  }
  const agents = new Map<any, AgentState>()
  let skillDispose: (() => void) | undefined
  let skills: FileSystemSkillProvider[] = []
  let skillContext: any
  let mcpContext: any
  let skillsKey = ''
  const scopedSnapshots = new Map<string, CodexSnapshot>()
  const home = resolveCodexHome(config.codexHome)
  if (!config.enabled)
    return {
      status: () => ({ enabled: false, refreshing: false, items: [] }),
      refresh: async () => {},
      dispose: async () => {},
    }

  const scopedSnapshot = async (
    cwd: string,
    signal: AbortSignal | undefined,
    fallback?: CodexSnapshot,
  ): Promise<CodexSnapshot> => {
    const key = resolve(cwd)
    const previous = scopedSnapshots.get(key) ?? fallback ?? latest
    try {
      const fs =
        skillContext?.get('fs') ?? mcpContext?.get('fs') ?? ctx.get?.('fs')
      const current = await discoverCodexSnapshot(home, config, {
        cwd,
        ...(fs ? { fs } : {}),
        ...(signal ? { signal } : {}),
        ...(previous ? { previous } : {}),
      })
      scopedSnapshots.set(key, current)
      return current
    } catch {
      return (
        previous ??
        fallback ?? { config: {}, mcp: [], skillRoots: [], items: [] }
      )
    }
  }

  const mountSkills = async (snapshot: CodexSnapshot) => {
    const nextKey = fingerprint({
      roots: snapshot.skillRoots,
      policy: snapshot.config.skills,
    })
    if (nextKey === skillsKey) return
    skillDispose?.()
    await Promise.all(skills.map((provider) => provider.dispose()))
    skills = []
    const owner = skillContext
    skillDispose = owner.skills.registerProvider((control: any) => {
      const sources = snapshot.skillRoots.map(
        (root, index) =>
          new FileSystemSkillProvider(owner, control, {
            providerName: `codex-source-${index}`,
            includeDefaultRoots: false,
            customSkillDirs: [root.path],
            watch: config.watch,
          }),
      )
      skills = sources
      return {
        name: 'codex-filesystem',
        async list(options: any) {
          const candidates: any[] = []
          let complete = true
          const activeSnapshot = options.cwd
            ? await scopedSnapshot(options.cwd, options.signal, snapshot)
            : snapshot
          const activeConfig = activeSnapshot.config
          const rootKey = (root: any) =>
            `${root.path}\0${root.plugin ?? ''}\0${root.pluginId ?? ''}`
          const activeRoots = new Set(activeSnapshot.skillRoots.map(rootKey))
          if (options.cwd) {
            const roots = await projectDirectories(
              options.cwd,
              owner.get('fs'),
              options.signal,
            )
            const project = new FileSystemSkillProvider(owner, control, {
              includeDefaultRoots: false,
              customSkillDirs: roots
                .reverse()
                .map((path) => join(path, '.agents', 'skills')),
              watch: false,
            })
            try {
              const result = await project.list(options)
              const entries = Array.isArray(result) ? result : result.candidates
              if (!Array.isArray(result) && !result.complete) complete = false
              for (const candidate of entries) {
                if (
                  !(await skillEnabledWithFs(
                    activeConfig,
                    candidate,
                    undefined,
                    owner.get('fs'),
                    options.signal,
                  ))
                )
                  continue
                candidates.push({
                  ...candidate,
                  provider: 'codex-filesystem',
                  source: 'project-agents',
                  rank: 199 + candidates.length / (entries.length + 1),
                  locator: {
                    rootPath: (candidate.locator as any)?.directory ?? options.cwd,
                    candidate,
                  },
                })
              }
            } finally {
              await project.dispose()
            }
          }
          for (const [index, provider] of sources.entries()) {
            const root = snapshot.skillRoots[index]
            if (!root || !activeRoots.has(rootKey(root))) continue
            const result = await provider.list(options)
            const entries = Array.isArray(result) ? result : result.candidates
            if (!Array.isArray(result) && !result.complete) complete = false
            for (const candidate of entries) {
              const plugin = snapshot.skillRoots[index]?.plugin
              if (
                !(await skillEnabledWithFs(
                  activeConfig,
                  candidate,
                  plugin,
                  owner.get('fs'),
                  options.signal,
                ))
              )
                continue
              candidates.push({
                ...candidate,
                name: plugin ? `${plugin}-${candidate.name}` : candidate.name,
                provider: 'codex-filesystem',
                source: plugin ? 'codex-plugin' : 'codex-user',
                rank: plugin ? 550 : 450,
                locator: { rootPath: root.path, candidate, plugin },
              })
            }
          }
          for (const root of activeSnapshot.skillRoots) {
            if (
              snapshot.skillRoots.some(
                (current) => rootKey(current) === rootKey(root),
              )
            )
              continue
            const provider = new FileSystemSkillProvider(owner, control, {
              providerName: `codex-scoped-${root.path}`,
              includeDefaultRoots: false,
              customSkillDirs: [root.path],
              watch: false,
            })
            try {
              const result = await provider.list(options)
              const entries = Array.isArray(result) ? result : result.candidates
              if (!Array.isArray(result) && !result.complete) complete = false
              for (const candidate of entries) {
                if (
                  !(await skillEnabledWithFs(
                    activeConfig,
                    candidate,
                    root.plugin,
                    owner.get('fs'),
                    options.signal,
                  ))
                )
                  continue
                candidates.push({
                  ...candidate,
                  name: root.plugin
                    ? `${root.plugin}-${candidate.name}`
                    : candidate.name,
                  provider: 'codex-filesystem',
                  source: root.plugin ? 'codex-plugin' : 'codex-user',
                  rank: root.plugin ? 550 : 450,
                  locator: {
                    rootPath: root.path,
                    candidate,
                    plugin: root.plugin,
                  },
                })
              }
            } finally {
              await provider.dispose()
            }
          }
          return { candidates, complete }
        },
        async get(candidate: any, options: any) {
          const locator = candidate.locator
          const provider = new FileSystemSkillProvider(owner, control, {
            providerName: 'codex-get',
            includeDefaultRoots: false,
            customSkillDirs: [locator.rootPath],
            watch: false,
          })
          let result
          try {
            result = await provider.get(locator.candidate, options)
          } finally {
            await provider.dispose()
          }
          if (
            !result ||
            !(await skillEnabledWithFs(
              options.cwd
                ? (await scopedSnapshot(options.cwd, options.signal, snapshot))
                    .config
                : snapshot.config,
              result,
              locator.plugin,
              owner.get('fs'),
              options.signal,
            ))
          )
            return undefined
          return {
            ...result,
            name: candidate.name,
            provider: 'codex-filesystem',
            source: candidate.source,
          }
        },
      }
    })
    skillsKey = nextKey
  }

  const mountMcp = async (
    owner: AgentState,
    entry: CodexMcpConfig,
    attempts = 1,
  ) => {
    const { startupTimeoutMs } = entry
    const enabledTools = entry.enabledTools?.map((name) =>
      publicToolName(entry.serverName, name),
    )
    const disabledTools = entry.disabledTools.map((name) =>
      publicToolName(entry.serverName, name),
    )
    const state: CompatibilityItem = {
      name: entry.serverName,
      kind: 'mcp',
      state: 'loading',
    }
    const plugin = {
      name: `codex-mcp-${entry.serverName}`,
      inject: ['tools'],
      async apply(child: any) {
        const registry = child.tools
        const tools = new Proxy(registry, {
          get(target, key) {
            if (key === 'register')
              return (definition: any) => {
                if (
                  (enabledTools && !enabledTools.includes(definition.name)) ||
                  disabledTools.includes(definition.name)
                )
                  return () => {}
                return target.register(definition)
              }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const connection =
          entry.transport === 'stdio'
            ? {
                transport: 'stdio' as const,
                command: entry.command!,
                args: entry.args ?? [],
                cwd: entry.cwd ?? '',
                env: entry.env ?? {},
              }
            : {
                transport: 'streamable-http' as const,
                url: entry.url!,
                headers: entry.headers ?? {},
              }
        await McpClient.apply(
          child.extend({ tools }),
          McpClient.Config({
            ...connection,
            serverName: entry.serverName,
            toolCallTimeoutMs: entry.toolCallTimeoutMs,
            failOnStartupError: true,
            reconnect: { enabled: true },
          }),
        )
      },
    }
    const fiber = owner.agent.ctx.plugin(plugin)
    const client = {
      key: fingerprint(entry),
      fiber,
      state,
      attempts,
      retryAt: 0,
    }
    owner.clients.set(entry.serverName, client)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve(fiber),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('startup-timeout')),
            startupTimeoutMs,
          )
        }),
      ])
      state.state = 'loaded'
    } catch (error: any) {
      state.state = 'failed'
      state.reason =
        error.message === 'startup-timeout'
          ? 'startup-timeout'
          : 'connection-failed'
      await fiber.dispose()
      client.retryAt = Date.now() + Math.min(30000, 500 * 2 ** (attempts - 1))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const refreshAgent = (owner: AgentState, signal?: AbortSignal) => {
    owner.tail = owner.tail
      .catch(() => {})
      .then(async () => {
        if (closed || owner.disposed) return
        try {
          signal?.throwIfAborted()
          const cwd = await mcpContext.workingDirectory.ensure(
            owner.agent,
            signal,
          )
          if (owner.cwd !== undefined && owner.cwd !== cwd) {
            await Promise.all(
              [...owner.clients.values()].map((client) =>
                client.fiber.dispose(),
              ),
            )
            owner.clients.clear()
            delete owner.snapshot
          }
          owner.cwd = cwd
          const fs = owner.agent.ctx.get('fs')
          const snapshot = await discoverCodexSnapshot(home, config, {
            cwd,
            ...(fs ? { fs } : {}),
            ...(signal ? { signal } : {}),
            ...(owner.snapshot ? { previous: owner.snapshot } : {}),
          })
          signal?.throwIfAborted()
          if (closed || owner.disposed) return
          owner.snapshot = snapshot
          owner.items = snapshot.items
          const next = new Map(
            snapshot.mcp.map((entry) => [entry.serverName, entry]),
          )
          for (const [name, client] of owner.clients) {
            if (!next.has(name) || fingerprint(next.get(name)) !== client.key) {
              await client.fiber.dispose()
              owner.clients.delete(name)
            }
          }
          await Promise.all(
            [...next].map(async ([name, entry]) => {
              const client = owner.clients.get(name)
              if (
                client &&
                (client.state.state !== 'failed' ||
                  client.attempts >= 10 ||
                  Date.now() < client.retryAt)
              )
                return
              if (client) await client.fiber.dispose()
              await mountMcp(owner, entry, (client?.attempts ?? 0) + 1)
            }),
          )
        } catch {
          signal?.throwIfAborted()
          owner.items = [
            {
              name: 'config.toml',
              kind: 'config',
              state: 'failed',
              reason:
                'unreadable-or-invalid-config; previous snapshot retained',
            },
          ]
        }
      })
    return owner.tail
  }
  const ensureAgent = (agent: any, signal?: AbortSignal) => {
    let owner = agents.get(agent)
    if (!owner) {
      owner = {
        agent,
        clients: new Map(),
        items: [],
        tail: Promise.resolve(),
        disposed: false,
      }
      agents.set(agent, owner)
    }
    return refreshAgent(owner, signal)
  }
  const disposeAgent = async (agent: any) => {
    const owner = agents.get(agent)
    if (!owner) return
    owner.disposed = true
    agents.delete(agent)
    await owner.tail.catch(() => {})
    await Promise.all(
      [...owner.clients.values()].map((client) => client.fiber.dispose()),
    )
  }

  const reconcile = async () => {
    if (closed) return
    refreshing = true
    try {
      const snapshot = await discoverCodexSnapshot(
        home,
        config,
        latest ? { previous: latest } : {},
      )
      if (closed) return
      latest = snapshot
      items = snapshot.items
      if (config.importSkills && skillContext) {
        await mountSkills(snapshot)
        items = [
          ...items,
          { name: 'codex-filesystem', kind: 'skills', state: 'loaded' },
        ]
      }
      if (config.importMcpServers)
        await Promise.all(
          [...agents.values()].map((owner) => refreshAgent(owner)),
        )
    } catch {
      items = [
        {
          name: 'config.toml',
          kind: 'config',
          state: 'failed',
          reason: 'unreadable-or-invalid-config; previous snapshot retained',
        },
      ]
    } finally {
      refreshing = false
    }
  }
  const refresh = () => {
    if (refreshing || closed) return tail
    tail = tail.then(reconcile)
    return tail
  }
  let timer: ReturnType<typeof setInterval> | undefined
  if (config.watch) {
    timer = setInterval(() => {
      void refresh()
    }, config.pollIntervalMs)
    timer.unref()
  }
  const injections = [
    ctx.inject(['skills'], (child: any) => {
      if (closed) return
      if (config.importSkills) {
        skillContext = child
        child.effect(() => () => {
          if (skillContext === child) {
            skillContext = undefined
            skillsKey = ''
          }
        })
        installSkillPolicy(
          child,
          () => latest,
          home,
          async (options) =>
            (await scopedSnapshot(options.cwd, options.signal)).config,
        )
        void refresh()
      }
    }),
    ctx.inject(['agents', 'workingDirectory', 'fs'], (child: any) => {
      if (closed) return
      if (config.importInstructions) installCodexInstructions(child, home)
    }),
    ctx.inject(['agents', 'workingDirectory', 'tools', 'fs'], (child: any) => {
      if (closed) return
      if (!config.importMcpServers) return
      mcpContext = child
      child.on('agent/created', async ({ agent, signal }: any) => {
        await ensureAgent(agent, signal)
      })
      child.on('agent/pre-step', async ({ agent, signal }: any, next: any) => {
        await ensureAgent(agent, signal)
        return next()
      })
      child.on('agent/disposed', ({ agent }: any) => {
        void disposeAgent(agent)
      })
      for (const agent of child.agents.list()) void ensureAgent(agent)
    }),
  ]
  void refresh()
  let stopping: Promise<void> | undefined
  const dispose = () =>
    (stopping ??= (async () => {
      closed = true
      if (timer) clearInterval(timer)
      await Promise.all(injections.map((fiber) => fiber.dispose()))
      await tail
      await Promise.all([...agents.keys()].map(disposeAgent))
      skillDispose?.()
      await Promise.all(skills.map((s) => s.dispose()))
    })())
  ctx.effect(() => dispose, 'codex-compatibility')
  return {
    status: () => ({
      enabled: !closed,
      refreshing,
      items: (() => {
        const merged = new Map<string, CompatibilityItem>()
        const priority = {
          disabled: 0,
          loaded: 1,
          loading: 2,
          unsupported: 3,
          failed: 4,
        }
        const add = (item: CompatibilityItem) => {
          const key = `${item.kind}\0${item.name}`
          const previous = merged.get(key)
          if (!previous || priority[item.state] > priority[previous.state])
            merged.set(key, { ...item })
        }
        for (const item of items) add(item)
        for (const owner of agents.values()) {
          for (const item of owner.items) add(item)
          for (const client of owner.clients.values()) add(client.state)
        }
        return [...merged.values()]
      })(),
    }),
    refresh: async () => {
      await tail
      for (const owner of agents.values()) {
        await owner.tail
        for (const client of owner.clients.values())
          if (client.state.state === 'failed') {
            client.attempts = 0
            client.retryAt = 0
          }
      }
      await refresh()
    },
    dispose,
  }
}

export {
  discoverCodexSnapshot,
  normalizeCodexMcp,
  readCodexConfig,
  resolveCodexHome,
} from './codex-config.js'
export {
  loadCodexInstructions,
  renderCodexInstructions,
} from './codex-instructions.js'
