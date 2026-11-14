import { symbols } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import {
  CodexSkillFileSystem,
  skillFilesystem,
} from './codex-skill-filesystem.js'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  discoverCodexSnapshot,
  CodexResourceCache,
  resolveCodexHome,
  readCodexConfig,
  projectDirectories,
  skillEnabled,
  skillEnabledWithFs,
  type CompatibilityItem,
  type CodexSnapshot,
  type CodexMcpConfig,
  type ProjectFileSystem,
} from './codex-config.js'
import { installCodexInstructions } from './codex-instructions.js'
import { installCodexMcpMetadata } from './codex-mcp-metadata.js'
import { McpStartupSlots } from './codex-mcp-startup.js'
import { installMcpPreparation } from './codex-mcp-preparation.js'

export type CodexCompatibilityConfig = {
  enabled: boolean
  codexHome?: string
  importInstructions: boolean
  importSkills: boolean
  importMcpServers: boolean
  importPluginResources: boolean
  watch: boolean
  pollIntervalMs: number
  mcpIdleTimeoutMs?: number
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
const skillRead = Symbol('codex skill read')
type SkillRead = { fs: ProjectFileSystem | undefined; current(): CodexSnapshot }
type PrepareSkills = <T>(
  options: any,
  action: (options: any) => Promise<T>,
) => Promise<T>
type McpClosure = { closeConfirmed: boolean; cleanupError?: string }
type McpStatus = { closure(): McpClosure }
// rc.2+ reports incomplete cleanup through a retained status handle.
const mcpStatusOf = (
  McpClient as unknown as {
    connectionStatusOf?: (fiber: any) => McpStatus | undefined
  }
).connectionStatusOf
const skillAllowed = (
  config: CodexSnapshot['config'],
  skill: any,
  plugin: string | undefined,
  fs: ProjectFileSystem | undefined,
  signal?: AbortSignal,
) =>
  fs
    ? skillEnabledWithFs(config, skill, plugin, fs, signal)
    : Promise.resolve(skillEnabled(config, skill, plugin))

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

function installSkillPolicy(ctx: any, prepare: PrepareSkills) {
  const service = ctx.skills[symbols.original] ?? ctx.skills
  const original = {
    list: service.list,
    snapshot: service.snapshot,
    get: service.get,
  }
  const allowed = (options: any, skill: any) => {
    const read = options[skillRead] as SkillRead
    const config = read.current().config
    const fs = read.fs
    return skillAllowed(config, skill, undefined, fs, options.signal)
  }
  async function list(this: any, ...args: any[]) {
    return prepare(args[0], async (options) => {
      const entries = await original.list.call(this, options, ...args.slice(1))
      return (
        await Promise.all(
          entries.map(async (skill: any) =>
            (await allowed(options, skill)) ? skill : undefined,
          ),
        )
      ).filter(Boolean)
    })
  }
  async function catalog(this: any, ...args: any[]) {
    return prepare(args[0], async (options) => {
      const result = await original.snapshot.call(
        this,
        options,
        ...args.slice(1),
      )
      const skills = (
        await Promise.all(
          result.skills.map(async (skill: any) =>
            (await allowed(options, skill)) ? skill : undefined,
          ),
        )
      ).filter(Boolean)
      return {
        ...result,
        skills,
      }
    })
  }
  async function get(this: any, ...args: any[]) {
    return prepare(args[1], async (options) => {
      const result = await original.get.call(
        this,
        args[0],
        options,
        ...args.slice(2),
      )
      return result && (await allowed(options, result)) ? result : undefined
    })
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
    closure(): McpClosure | undefined
    disposal?: Promise<void>
  }
  type AgentState = {
    agent: any
    clients: Map<string, Client>
    snapshot?: CodexSnapshot
    cwd?: string
    items: CompatibilityItem[]
    tail: Promise<void>
    queued?: Promise<void> | undefined
    abort: AbortController
    disposed: boolean
    disposal?: Promise<void>
    running: boolean
    freshConfig: boolean
    idleTimer?: ReturnType<typeof setTimeout> | undefined
  }
  const agents = new Map<any, AgentState>()
  let skillDispose: (() => void) | undefined
  let skills: FileSystemSkillProvider[] = []
  let skillContext: any
  let mcpContext: any
  let skillsKey = ''
  const scopedSnapshots = new Map<string, CodexSnapshot>()
  const scopeVersions = new Map<string, { issued: number; committed: number }>()
  const filesystemIds = new WeakMap<object, number>()
  const skillPolicies = new Map<string, string>()
  const hostWorld = {}
  let filesystemId = 0
  let invalidateSkills = () => {}
  const resources = new CodexResourceCache()
  let publicResources = resources.observe()
  const startupSlots = new McpStartupSlots()
  const home = resolveCodexHome(config.codexHome)
  if (!config.enabled)
    return {
      status: () => ({ enabled: false, refreshing: false, items: [] }),
      refresh: async () => {},
      dispose: async () => {},
    }

  const metadata = config.importMcpServers
    ? installCodexMcpMetadata()
    : undefined
  const skillLifetime = new AbortController()

  const withSkillSignal = async <T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
    providerSignal?: AbortSignal,
  ): Promise<T> => {
    const operation = new AbortController()
    // Explicitly remove forwarding listeners after every operation.
    const cleanup = [skillLifetime.signal, signal, providerSignal].flatMap(
      (parent) => {
        if (!parent) return []
        const abort = () => operation.abort(parent.reason)
        parent.addEventListener('abort', abort, { once: true })
        if (parent.aborted) abort()
        return [() => parent.removeEventListener('abort', abort)]
      },
    )
    try {
      operation.signal.throwIfAborted()
      const result = await action(operation.signal)
      operation.signal.throwIfAborted()
      return result
    } finally {
      for (const dispose of cleanup) dispose()
      operation.abort()
    }
  }

  const scopeWorld = (
    fs: ProjectFileSystem | undefined,
    world?: object,
  ): object => world ?? (fs as any)?.[symbols.original] ?? fs ?? hostWorld
  const scopeKey = (
    cwd: string | undefined,
    fs: ProjectFileSystem | undefined,
    world?: object,
  ) => {
    const identity = scopeWorld(fs, world)
    let id = filesystemIds.get(identity)
    if (id === undefined) filesystemIds.set(identity, (id = ++filesystemId))
    return `${id}:${cwd ? resolve(cwd) : ''}`
  }
  const observeSkillPolicy = (key: string, snapshot: CodexSnapshot) => {
    const policy = fingerprint([snapshot.skillRoots, snapshot.config.skills])
    const previous = skillPolicies.get(key)
    if (previous !== undefined && previous !== policy) invalidateSkills()
    if (!skillPolicies.has(key) && skillPolicies.size >= 256) {
      // Native catalogs must be cleared before forgetting their policy history.
      invalidateSkills()
      skillPolicies.clear()
    }
    skillPolicies.delete(key)
    skillPolicies.set(key, policy)
  }
  const scopedSnapshot = (
    cwd: string | undefined,
    signal: AbortSignal | undefined,
    fallback?: CodexSnapshot,
    fs?: ProjectFileSystem,
    world?: object,
  ): Promise<CodexSnapshot> =>
    withSkillSignal(signal, async (signal) => {
      const key = scopeKey(cwd, fs, world)
      const observation = publicResources
      let version = scopeVersions.get(key)
      if (!version) {
        version = { issued: 0, committed: 0 }
        scopeVersions.set(key, version)
      }
      const issued = ++version.issued
      const previous = scopedSnapshots.get(key) ?? fallback ?? latest
      try {
        const currentConfig = await readCodexConfig(
          home,
          cwd,
          fs,
          signal,
          resources,
        )
        signal.throwIfAborted()
        const current = await discoverCodexSnapshot(home, config, {
          config: currentConfig,
          resources: observation,
          ...(cwd ? { cwd } : {}),
          ...(fs ? { fs } : {}),
          ...(signal ? { signal } : {}),
          ...(previous ? { previous } : {}),
        })
        signal.throwIfAborted()
        if (issued < version.committed)
          return scopedSnapshots.get(key) ?? current
        if (scopeVersions.get(key) !== version) return current
        version.committed = issued
        observeSkillPolicy(key, current)
        scopedSnapshots.delete(key)
        scopedSnapshots.set(key, current)
        if (scopedSnapshots.size > 64) {
          const oldest = scopedSnapshots.keys().next().value!
          scopedSnapshots.delete(oldest)
          scopeVersions.delete(oldest)
        }
        return current
      } catch {
        signal.throwIfAborted()
        const retained = scopedSnapshots.get(key) ??
          previous ??
          fallback ?? { config: {}, mcp: [], skillRoots: [], items: [] }
        observeSkillPolicy(key, retained)
        return retained
      } finally {
        if (
          !version.committed &&
          version.issued === issued &&
          scopeVersions.get(key) === version
        )
          scopeVersions.delete(key)
      }
    })

  const prepareSkills: PrepareSkills = (options = {}, action) =>
    withSkillSignal(options.signal, async (signal) => {
      if (options[skillRead]) return action({ ...options, signal })
      const fs =
        options.scope?.ctx?.get('fs') ??
        skillContext?.get('fs') ??
        ctx.get?.('fs')
      const snapshot = await scopedSnapshot(
        options.cwd,
        signal,
        latest,
        fs,
        options.scope,
      )
      const key = scopeKey(options.cwd, fs, options.scope)
      const read: SkillRead = {
        fs,
        current: () => scopedSnapshots.get(key) ?? snapshot,
      }
      return action({
        ...options,
        signal,
        [skillRead]: read,
        [skillFilesystem]: fs,
      })
    })

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
      invalidateSkills = control.invalidate
      const temporary = (
        options: ConstructorParameters<typeof FileSystemSkillProvider>[2],
        signal: AbortSignal,
      ) => {
        const lifetime = new AbortController()
        const provider = new CodexSkillFileSystem(
          owner,
          {
            ...control,
            signal: lifetime.signal,
          },
          options,
        )
        const abort = () => lifetime.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        return {
          provider,
          async dispose() {
            signal.removeEventListener('abort', abort)
            lifetime.abort()
            await provider.dispose()
          },
        }
      }
      const sources = snapshot.skillRoots.map(
        (root, index) =>
          new CodexSkillFileSystem(owner, control, {
            providerName: `codex-source-${index}`,
            includeDefaultRoots: false,
            customSkillDirs: [root.path],
            watch: config.watch,
          }),
      )
      skills = sources
      const withOptions = <T>(
        options: any,
        action: (options: any) => Promise<T>,
      ) =>
        withSkillSignal(
          options.signal,
          (signal) => prepareSkills({ ...options, signal }, action),
          control.signal,
        )
      return {
        name: 'codex-filesystem',
        list: (options: any) =>
          withOptions(options, async (options) => {
            const fs = (options[skillRead] as SkillRead).fs
            const candidates: any[] = []
            let complete = true
            const activeSnapshot = (options[skillRead] as SkillRead).current()
            const activeConfig = activeSnapshot.config
            const rootKey = (root: any) =>
              `${root.path}\0${root.plugin ?? ''}\0${root.pluginId ?? ''}`
            const activeRoots = new Set(activeSnapshot.skillRoots.map(rootKey))
            if (options.cwd) {
              const roots = await projectDirectories(
                options.cwd,
                fs,
                options.signal,
              )
              const project = temporary(
                {
                  includeDefaultRoots: false,
                  customSkillDirs: roots
                    .reverse()
                    .map((path) => join(path, '.agents', 'skills')),
                  watch: false,
                },
                options.signal,
              )
              try {
                const result = await project.provider.list(options)
                const entries = Array.isArray(result)
                  ? result
                  : result.candidates
                if (!Array.isArray(result) && !result.complete) complete = false
                for (const candidate of entries) {
                  if (
                    !(await skillAllowed(
                      activeConfig,
                      candidate,
                      undefined,
                      fs,
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
                      rootPath:
                        (candidate.locator as any)?.directory ?? options.cwd,
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
                  !(await skillAllowed(
                    activeConfig,
                    candidate,
                    plugin,
                    fs,
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
                  locator: {
                    rootPath: root.path,
                    candidate,
                    plugin,
                    pluginId: root.pluginId,
                  },
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
              const scoped = temporary(
                {
                  providerName: `codex-scoped-${root.path}`,
                  includeDefaultRoots: false,
                  customSkillDirs: [root.path],
                  watch: false,
                },
                options.signal,
              )
              try {
                const result = await scoped.provider.list(options)
                const entries = Array.isArray(result)
                  ? result
                  : result.candidates
                if (!Array.isArray(result) && !result.complete) complete = false
                for (const candidate of entries) {
                  if (
                    !(await skillAllowed(
                      activeConfig,
                      candidate,
                      root.plugin,
                      fs,
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
                      pluginId: root.pluginId,
                    },
                  })
                }
              } finally {
                await scoped.dispose()
              }
            }
            return { candidates, complete }
          }),
        get: (candidate: any, options: any) =>
          withOptions(options, async (options) => {
            const locator = candidate.locator
            const active = () => (options[skillRead] as SkillRead).current()
            const member = () =>
              candidate.source === 'project-agents' ||
              active().skillRoots.some(
                (root) =>
                  root.path === locator.rootPath &&
                  root.plugin === locator.plugin &&
                  root.pluginId === locator.pluginId,
              )
            if (!member()) return undefined
            const resource = temporary(
              {
                providerName: 'codex-get',
                includeDefaultRoots: false,
                customSkillDirs: [locator.rootPath],
                watch: false,
              },
              options.signal,
            )
            let result
            try {
              result = await resource.provider.get(locator.candidate, options)
            } finally {
              await resource.dispose()
            }
            if (
              !result ||
              !member() ||
              !(await skillAllowed(
                active().config,
                result,
                locator.plugin,
                (options[skillRead] as SkillRead).fs,
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
          }),
      }
    })
    skillsKey = nextKey
  }

  const closeClient = (client: Client): Promise<void> =>
    (client.disposal ??= Promise.resolve()
      .then(async () => {
        await client.fiber.dispose()
        // Agent-scope teardown may already have claimed the raw disposer.
        while (client.fiber.inertia !== undefined) await client.fiber.inertia
        const closure = client.closure()
        if (
          closure &&
          (!closure.closeConfirmed || closure.cleanupError !== undefined)
        )
          throw new Error(
            'MCP connection cleanup is incomplete; restart the DSH host',
          )
      })
      .catch((error) => {
        client.state.state = 'failed'
        client.state.reason = 'cleanup-failed; replacement blocked'
        throw error
      }))

  const mountMcp = async (
    owner: AgentState,
    entry: CodexMcpConfig,
    attempts = 1,
  ) => {
    const signal = owner.abort.signal
    const release = await startupSlots.acquire(signal)
    try {
      signal.throwIfAborted()
      if (closed || owner.disposed) return
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
      let nativeStatus: McpStatus | undefined
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
                  return target.register({
                    ...definition,
                    execute(args: any, execution: any) {
                      const agent = execution.agent ?? owner.agent
                      const boundary = agent.session
                        ? child.agents.turnBoundaryOf?.(agent.session)
                        : undefined
                      const turn = boundary?.openTurnStartSeq
                      const turnMetadata =
                        typeof agent.id === 'string' && agent.id && turn != null
                          ? {
                              session_id: agent.id,
                              turn_id: `${agent.id}:${turn}`,
                            }
                          : undefined
                      return metadata!.run(turnMetadata, () =>
                        definition.execute(args, execution),
                      )
                    },
                  })
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
          const ready = McpClient.apply(
            child.extend({ tools }),
            McpClient.Config({
              ...connection,
              serverName: entry.serverName,
              toolCallTimeoutMs: entry.toolCallTimeoutMs,
              ...(mcpStatusOf ? { startupTimeoutMs } : {}),
              failOnStartupError: true,
              reconnect: { enabled: true },
            }),
          )
          nativeStatus = mcpStatusOf?.(child.fiber)
          await ready
        },
      }
      const fiber = owner.agent.ctx.plugin(plugin)
      const client = {
        key: fingerprint(entry),
        fiber,
        state,
        attempts,
        retryAt: 0,
        closure: () => nativeStatus?.closure(),
      }
      owner.clients.set(entry.serverName, client)
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancel = () => {}
      try {
        await Promise.race([
          Promise.resolve(fiber),
          new Promise((_, reject) => {
            cancel = () => {
              void closeClient(client).catch(() => {})
              reject(signal.reason)
            }
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('startup-timeout')),
              startupTimeoutMs,
            )
          }),
        ])
        signal.throwIfAborted()
        if (closed || owner.disposed) return
        state.state = 'loaded'
      } catch (error: any) {
        state.state = 'failed'
        state.reason =
          error.message === 'startup-timeout'
            ? 'startup-timeout'
            : 'connection-failed'
        await closeClient(client)
        signal.throwIfAborted()
        client.retryAt = Date.now() + Math.min(30000, 500 * 2 ** (attempts - 1))
      } finally {
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
      }
    } finally {
      release()
    }
  }

  const refreshAgentOnce = async (owner: AgentState) => {
    const signal = owner.abort.signal
    if (closed || owner.disposed) return
    signal.throwIfAborted()
    // Retained cleanup failures block every admission, including config fallbacks.
    for (const client of owner.clients.values())
      if (client.disposal) await client.disposal
    signal.throwIfAborted()
    const cwd = await mcpContext.workingDirectory.ensure(owner.agent, signal)
    if (owner.cwd !== undefined && owner.cwd !== cwd) {
      await Promise.all([...owner.clients.values()].map(closeClient))
      owner.clients.clear()
      delete owner.snapshot
    }
    owner.cwd = cwd
    let snapshot: CodexSnapshot
    try {
      const fs = owner.agent.ctx.get('fs')
      const observation = publicResources
      const configResources = owner.freshConfig ? resources : observation
      owner.freshConfig = false
      const currentConfig = await readCodexConfig(
        home,
        cwd,
        fs,
        signal,
        configResources,
      )
      signal.throwIfAborted()
      snapshot = await discoverCodexSnapshot(home, config, {
        config: currentConfig,
        resources: observation,
        cwd,
        ...(fs ? { fs } : {}),
        signal,
        ...(owner.snapshot ? { previous: owner.snapshot } : {}),
      })
    } catch {
      if (closed || owner.disposed) return
      signal.throwIfAborted()
      owner.items = [
        {
          name: 'config.toml',
          kind: 'config',
          state: 'failed',
          reason: 'unreadable-or-invalid-config; previous snapshot retained',
        },
      ]
      return
    }
    signal.throwIfAborted()
    if (closed || owner.disposed) return
    owner.snapshot = snapshot
    owner.items = snapshot.items
    const next = new Map(snapshot.mcp.map((entry) => [entry.serverName, entry]))
    for (const [name, client] of owner.clients) {
      if (!next.has(name) || fingerprint(next.get(name)) !== client.key) {
        await closeClient(client)
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
        if (client) await closeClient(client)
        await mountMcp(owner, entry, (client?.attempts ?? 0) + 1)
      }),
    )
  }
  const waitForAgentWork = (
    work: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted()
    if (!signal) return work
    // Cancel this caller's wait, preserving shared refresh and cleanup work.
    return new Promise<void>((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener('abort', aborted)
        reject(signal.reason)
      }
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      work.then(
        () => {
          signal.removeEventListener('abort', aborted)
          resolve()
        },
        (error) => {
          signal.removeEventListener('abort', aborted)
          reject(error)
        },
      )
    })
  }
  const refreshAgent = (
    owner: AgentState,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted()
    if (closed || owner.disposed) return Promise.resolve()
    if (!owner.queued) {
      owner.queued = owner.tail = owner.tail
        .catch(() => {})
        .then(async () => {
          // A caller waits for this round, never for future polling to drain.
          // Clearing at start permits at most one coalesced follow-up round.
          owner.queued = undefined
          try {
            await refreshAgentOnce(owner)
          } catch (error) {
            // Teardown joins client cleanup separately; contain stopped-owner work.
            if (!closed && !owner.disposed) throw error
          }
        })
    }
    return waitForAgentWork(owner.queued, signal)
  }
  const ensureAgent = (agent: any, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    if (closed) return Promise.resolve()
    let owner = agents.get(agent)
    if (owner?.disposed)
      return waitForAgentWork(owner.disposal!, signal).then(() =>
        ensureAgent(agent, signal),
      )
    if (!owner) {
      owner = {
        agent,
        clients: new Map(),
        items: [],
        tail: Promise.resolve(),
        abort: new AbortController(),
        disposed: false,
        running: true,
        freshConfig: true,
      }
      agents.set(agent, owner)
    }
    owner.running = true
    owner.freshConfig = true
    clearTimeout(owner.idleTimer)
    owner.idleTimer = undefined
    return refreshAgent(owner, signal)
  }
  const disposeAgent = (agent: any): Promise<void> => {
    const owner = agents.get(agent)
    if (!owner) return Promise.resolve()
    if (owner.disposal) return owner.disposal
    owner.disposed = true
    clearTimeout(owner.idleTimer)
    owner.abort.abort()
    owner.disposal = (async () => {
      const clients = [...owner.clients]
      const results = await Promise.allSettled(
        clients.map(([, client]) => closeClient(client)),
      )
      await owner.tail.catch(() => {})
      for (const [index, result] of results.entries()) {
        const [name, client] = clients[index]!
        if (result.status === 'fulfilled') owner.clients.delete(name)
        else {
          client.state.state = 'failed'
          client.state.reason = 'cleanup-failed; replacement blocked'
        }
      }
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length) {
        owner.items = [
          {
            name: 'codex-mcp',
            kind: 'mcp',
            state: 'failed',
            reason: 'cleanup-failed; replacement blocked',
          },
        ]
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'Codex MCP client cleanup failed')
      owner.clients.clear()
      if (agents.get(agent) === owner) agents.delete(agent)
    })()
    return owner.disposal
  }

  const reconcile = async () => {
    if (closed) return
    refreshing = true
    try {
      publicResources = resources.observe()
      const currentConfig = await readCodexConfig(
        home,
        undefined,
        undefined,
        undefined,
        publicResources,
      )
      const snapshot = await discoverCodexSnapshot(home, config, {
        config: currentConfig,
        resources: publicResources,
        ...(latest ? { previous: latest } : {}),
      })
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
        for (const owner of agents.values()) {
          if (!owner.running || owner.disposed) continue
          // Public observations must not wait for network startup. Agent tails
          // remain owned and are joined by manual refresh and disposal.
          void refreshAgent(owner).catch((error) => {
            if (!closed && !owner.disposed)
              ctx.logger?.warn('Codex MCP refresh failed', error)
          })
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
  let queued = false
  const refresh = () => {
    if (refreshing || queued || closed) return tail
    queued = true
    tail = tail.then(() => {
      queued = false
      return reconcile()
    })
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
        installSkillPolicy(child, prepareSkills)
        void refresh()
      }
    }),
    ctx.inject(['agents', 'workingDirectory', 'fs'], (child: any) => {
      if (closed) return
      if (config.importInstructions)
        installCodexInstructions(child, home, (cwd, fs, signal) =>
          readCodexConfig(home, cwd, fs, signal, resources),
        )
    }),
    ctx.inject(['agents', 'workingDirectory', 'tools', 'fs'], (child: any) => {
      if (closed) return
      if (!config.importMcpServers) return
      mcpContext = child
      child.effect(() => installMcpPreparation(child.tools, ensureAgent))
      child.on('agent/disposed', ({ agent }: any) => disposeAgent(agent))
      child.on('agent/status', ({ agent, status }: any) => {
        const owner = agents.get(agent)
        if (!owner) return
        owner.running = status === 'running'
        clearTimeout(owner.idleTimer)
        owner.idleTimer = undefined
        const idleTimeout = config.mcpIdleTimeoutMs ?? 60000
        if (!owner.running && idleTimeout > 0) {
          owner.idleTimer = setTimeout(() => {
            void disposeAgent(agent).catch((error) =>
              child.logger?.warn('Codex MCP idle cleanup failed', error),
            )
          }, idleTimeout)
          owner.idleTimer.unref()
        }
      })
    }),
  ]
  void refresh()
  let stopping: Promise<void> | undefined
  const dispose = () =>
    (stopping ??= (async () => {
      closed = true
      skillLifetime.abort(new Error('Codex compatibility disposed'))
      resources.dispose()
      publicResources.clear()
      latest = undefined
      if (timer) clearInterval(timer)
      for (const owner of agents.values()) owner.abort.abort()
      const errors: unknown[] = []
      const settle = async (actions: Array<() => unknown>) => {
        const results = await Promise.allSettled(
          actions.map(async (action) => action()),
        )
        for (const result of results)
          if (result.status === 'rejected') errors.push(result.reason)
      }
      await settle(injections.map((fiber) => () => fiber.dispose()))
      await settle([() => tail])
      await settle([...agents.keys()].map((agent) => () => disposeAgent(agent)))
      scopedSnapshots.clear()
      scopeVersions.clear()
      skillPolicies.clear()
      await settle([
        () => metadata?.dispose(),
        () => skillDispose?.(),
        ...skills.map((provider) => () => provider.dispose()),
      ])
      skills = []
      skillContext = undefined
      mcpContext = undefined
      skillDispose = undefined
      invalidateSkills = () => {}
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'Codex compatibility cleanup failed')
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
      await Promise.all(
        [...agents.values()]
          .filter((owner) => owner.running && !owner.disposed)
          .map((owner) => owner.tail),
      )
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
