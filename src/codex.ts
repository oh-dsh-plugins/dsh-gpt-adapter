import { symbols } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createHash } from 'node:crypto'
import {
  discoverCodexSnapshot,
  resolveCodexHome,
  skillEnabled,
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
) {
  const service = ctx.skills[symbols.original] ?? ctx.skills
  const original = {
    list: service.list,
    snapshot: service.snapshot,
    get: service.get,
  }
  const allowed = (s: any) => skillEnabled(snapshot()?.config ?? {}, s)
  async function list(this: any, ...args: any[]) {
    return (await original.list.apply(this, args)).filter(allowed)
  }
  async function catalog(this: any, ...args: any[]) {
    const result = await original.snapshot.apply(this, args)
    return { ...result, skills: result.skills.filter(allowed) }
  }
  async function get(this: any, ...args: any[]) {
    const result = await original.get.apply(this, args)
    return result && allowed(result) ? result : undefined
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
  const clients = new Map<
    string,
    { key: string; fiber: any; state: CompatibilityItem }
  >()
  let skillDispose: (() => void) | undefined
  let skills: FileSystemSkillProvider[] = []
  let skillContext: any
  let skillsKey = ''
  const home = resolveCodexHome(config.codexHome)
  if (!config.enabled)
    return {
      status: () => ({ enabled: false, refreshing: false, items: [] }),
      refresh: async () => {},
      dispose: async () => {},
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
          for (const [index, provider] of sources.entries()) {
            const result = await provider.list(options)
            const entries = Array.isArray(result) ? result : result.candidates
            if (!Array.isArray(result) && !result.complete) complete = false
            for (const candidate of entries) {
              const plugin = snapshot.skillRoots[index]?.plugin
              if (
                !skillEnabled(
                  latest?.config ?? snapshot.config,
                  candidate,
                  plugin,
                )
              )
                continue
              candidates.push({
                ...candidate,
                name: plugin ? `${plugin}-${candidate.name}` : candidate.name,
                provider: 'codex-filesystem',
                source: plugin ? 'codex-plugin' : 'codex-user',
                rank: plugin ? 550 : 450,
                locator: { index, candidate },
              })
            }
          }
          return { candidates, complete }
        },
        async get(candidate: any, options: any) {
          const locator = candidate.locator
          const result = await sources[locator.index]?.get(
            locator.candidate,
            options,
          )
          if (
            !result ||
            !skillEnabled(
              latest?.config ?? snapshot.config,
              result,
              snapshot.skillRoots[locator.index]?.plugin,
            )
          )
            return undefined
          return {
            ...result,
            name: candidate.name,
            provider: 'codex-filesystem',
          }
        },
      }
    })
    skillsKey = nextKey
  }

  const mountMcp = async (entry: CodexMcpConfig) => {
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
    const fiber = ctx.plugin(plugin)
    clients.set(entry.serverName, { key: fingerprint(entry), fiber, state })
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
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const reconcile = async () => {
    if (closed) return
    refreshing = true
    try {
      const snapshot = await discoverCodexSnapshot(home, config)
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
      if (config.importMcpServers && ctx.get('tools')) {
        const next = new Map(snapshot.mcp.map((s) => [s.serverName, s]))
        for (const [name, client] of clients) {
          if (!next.has(name) || fingerprint(next.get(name)) !== client.key) {
            await client.fiber.dispose()
            clients.delete(name)
          }
        }
        await Promise.all(
          [...next]
            .filter(([name]) => !clients.has(name))
            .map(([, entry]) => mountMcp(entry)),
        )
      }
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
        installSkillPolicy(child, () => latest)
        void refresh()
      }
    }),
    ctx.inject(['agents', 'workingDirectory'], (child: any) => {
      if (closed) return
      if (config.importInstructions) installCodexInstructions(child, home)
    }),
    ctx.inject(['tools'], () => {
      if (closed) return
      if (config.importMcpServers) void refresh()
    }),
  ]
  void refresh()
  let stopping: Promise<void> | undefined
  const dispose = () =>
    (stopping ??= (async () => {
      closed = true
      if (timer) clearInterval(timer)
      await Promise.all(injections.map((fiber) => fiber.dispose()))
      await Promise.all([...clients.values()].map((c) => c.fiber.dispose()))
      await tail
      skillDispose?.()
      await Promise.all(skills.map((s) => s.dispose()))
      clients.clear()
    })())
  ctx.effect(() => dispose, 'codex-compatibility')
  return {
    status: () => ({
      enabled: !closed,
      refreshing,
      items: [...items, ...[...clients.values()].map((c) => ({ ...c.state }))],
    }),
    refresh: async () => {
      await tail
      for (const [name, client] of clients) {
        if (client.state.state === 'failed') {
          await client.fiber.dispose()
          clients.delete(name)
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
