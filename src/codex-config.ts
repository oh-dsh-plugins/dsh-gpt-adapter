import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import { parse } from 'smol-toml'

export type JsonObject = Record<string, any>
export type CompatibilityItem = {
  name: string
  kind: 'config' | 'plugin' | 'mcp' | 'instructions' | 'skills'
  state: 'loading' | 'loaded' | 'disabled' | 'unsupported' | 'failed'
  reason?: string
}
export type CodexMcpConfig = {
  serverName: string
  source: string
  originalName?: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  startupTimeoutMs: number
  toolCallTimeoutMs: number
  enabledTools?: string[]
  disabledTools: string[]
}
export type SkillRoot = { path: string; plugin?: string; pluginId?: string }
export type CodexSnapshot = {
  config: JsonObject
  mcp: CodexMcpConfig[]
  skillRoots: SkillRoot[]
  items: CompatibilityItem[]
}

export const object = (v: unknown): JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const record = (v: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(object(v)).filter((e) => typeof e[1] === 'string'),
  )

export function resolveCodexHome(configured?: string): string {
  const value =
    configured || process.env.CODEX_HOME || join(homedir(), '.codex')
  return resolve(value.replace(/^~(?=$|[\\/])/, homedir()))
}

export async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Minimal execution-world filesystem used by project readers. */
export type ProjectFileSystem = {
  resolve(path: string, options?: { signal?: AbortSignal }): Promise<any>
  stat(target: any, signal?: AbortSignal): Promise<unknown>
  readText(target: any, signal?: AbortSignal): Promise<string>
}

export async function projectText(
  path: string,
  fs?: ProjectFileSystem,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (!fs) return optionalText(path)
  const target = await fs.resolve(path, signal ? { signal } : {})
  if (!(await fs.stat(target, signal))) return undefined
  return fs.readText(target, signal)
}

/** Repository root to cwd; without a repository only cwd participates. */
export async function projectDirectories(
  cwd: string,
  fs?: ProjectFileSystem,
  signal?: AbortSignal,
): Promise<string[]> {
  const directories: string[] = []
  let current = resolve(cwd)
  while (true) {
    signal?.throwIfAborted()
    directories.unshift(current)
    const marker = join(current, '.git')
    const exists = fs
      ? await fs.stat(
          await fs.resolve(marker, signal ? { signal } : {}),
          signal,
        )
      : await stat(marker).catch((error) => {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
          return undefined
        })
    if (exists) return directories
    if (dirname(current) === current) return [resolve(cwd)]
    current = dirname(current)
  }
}

function mergeConfig(base: JsonObject, layer: JsonObject): JsonObject {
  const result = { ...base }
  for (const [key, value] of Object.entries(layer))
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergeConfig(object(base[key]), value)
        : value
  return result
}

export async function readCodexConfig(
  home: string,
  cwd?: string,
  fs?: ProjectFileSystem,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const text = await optionalText(join(home, 'config.toml'))
  let config = text === undefined ? {} : object(parse(text))
  if (!cwd) return config
  const trust = Object.entries(object(config.projects))
    .filter(([path]) => {
      const child = relative(resolve(path), resolve(cwd))
      return (
        child === '' ||
        (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
      )
    })
    .sort(([a], [b]) => b.length - a.length)[0]
  if (object(trust?.[1]).trust_level !== 'trusted') return config
  for (const directory of await projectDirectories(cwd, fs, signal)) {
    const layer = await projectText(
      join(directory, '.codex', 'config.toml'),
      fs,
      signal,
    )
    if (layer !== undefined) config = mergeConfig(config, object(parse(layer)))
  }
  return config
}

function serverName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name)) return name
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 23)}-${hash}`
}

export function normalizeCodexMcp(
  name: string,
  value: unknown,
  source: string,
  base: string,
  environment: NodeJS.ProcessEnv = process.env,
  defaultCwd = base,
): CodexMcpConfig | undefined {
  const raw = object(value)
  if (raw.enabled === false) return undefined
  const headers = record(raw.http_headers ?? raw.headers)
  for (const [header, variable] of Object.entries(
    record(raw.env_http_headers),
  )) {
    if (!environment[variable]) throw new Error('missing-environment')
    headers[header] = environment[variable]!
  }
  if (typeof raw.bearer_token_env_var === 'string') {
    const token = environment[raw.bearer_token_env_var]
    if (!token) throw new Error('missing-environment')
    headers.Authorization = `Bearer ${token}`
  }
  if (raw.type && !['stdio', 'http', 'streamable-http'].includes(raw.type))
    throw new Error('unsupported-transport')
  const seconds = (value: unknown, fallback: number) => {
    const number = value === undefined ? fallback : Number(value)
    if (!Number.isFinite(number) || number <= 0 || number > 2147483)
      throw new Error('invalid-timeout')
    return Math.max(1, number * 1000)
  }
  const common = {
    serverName: serverName(name),
    source,
    startupTimeoutMs: seconds(raw.startup_timeout_sec, 10),
    toolCallTimeoutMs: seconds(raw.tool_timeout_sec, 60),
    ...(Array.isArray(raw.enabled_tools)
      ? { enabledTools: strings(raw.enabled_tools) }
      : {}),
    disabledTools: [
      ...new Set([
        ...strings(raw.disabled_tools),
        ...Object.entries(object(raw.tools))
          .filter(([, policy]) => object(policy).enabled === false)
          .map(([name]) => name),
      ]),
    ],
  }
  if (typeof raw.url === 'string') {
    const url = new URL(raw.url)
    if (!['https:', 'http:'].includes(url.protocol))
      throw new Error('unsupported-transport')
    return { ...common, transport: 'streamable-http', url: raw.url, headers }
  }
  if (typeof raw.command !== 'string' || !raw.command)
    throw new Error('missing-command')
  const env = record(raw.env)
  for (const variable of strings(raw.env_vars)) {
    if (environment[variable] !== undefined && env[variable] === undefined)
      env[variable] = environment[variable]!
  }
  const cwd = typeof raw.cwd === 'string' ? resolve(base, raw.cwd) : defaultCwd
  const command =
    raw.command.includes('/') && !isAbsolute(raw.command)
      ? resolve(typeof raw.cwd === 'string' ? cwd : base, raw.command)
      : raw.command
  return {
    ...common,
    transport: 'stdio',
    command,
    args: strings(raw.args),
    env,
    cwd,
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(path, e.name))
  } catch (error: any) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function manifestAt(
  root: string,
): Promise<
  { root: string; manifest: JsonObject; portable: boolean } | undefined
> {
  const text = await optionalText(join(root, 'plugin.json'))
  if (text !== undefined) {
    const manifest = object(JSON.parse(text))
    if (
      manifest.$schema ===
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    ) {
      const inline = manifest.extensions?.['com.openai']
      const overlay =
        inline !== null && typeof inline === 'object' && !Array.isArray(inline)
          ? inline
          : object(
              JSON.parse(
                (await optionalText(
                  join(root, '.codex-plugin', 'plugin.json'),
                )) ?? '{}',
              ),
            )
      return {
        root,
        manifest: { ...manifest, ...overlay, name: manifest.name },
        portable: true,
      }
    }
  }
  for (const name of ['.codex-plugin', '.claude-plugin']) {
    const text = await optionalText(join(root, name, 'plugin.json'))
    if (text !== undefined)
      return { root, manifest: object(JSON.parse(text)), portable: false }
  }
  return undefined
}

async function resolvePlugin(home: string, id: string, config: JsonObject) {
  const at = id.lastIndexOf('@')
  const name = at < 0 ? id : id.slice(0, at)
  const marketplace = at < 0 ? '' : id.slice(at + 1)
  const source = object(config.marketplaces?.[marketplace]).source
  if (typeof source === 'string' && !/^https?:/.test(source)) {
    for (const p of [join(source, 'plugins', name), join(source, name)]) {
      const found = await manifestAt(p)
      if (found) return found
    }
  }
  const cache = join(home, 'plugins', 'cache', marketplace, name)
  const versions = (await directories(cache)).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  )
  for (const version of versions) {
    for (const p of [version, join(version, 'plugins', name)]) {
      const found = await manifestAt(p)
      if (found) return found
    }
  }
  return undefined
}

function expandPlugin(value: unknown, root: string, home: string): any {
  if (typeof value === 'string')
    return value
      .replaceAll('${PLUGIN_ROOT}', root)
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
      .replaceAll('${CODEX_PLUGIN_ROOT}', root)
      .replaceAll('${CODEX_HOME}', home)
  if (Array.isArray(value)) return value.map((v) => expandPlugin(v, root, home))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandPlugin(v, root, home)]),
    )
  return value
}

/** Retained connections may only gain restrictions until their declaration is readable again. */
function restrictMcpFallback(entry: CodexMcpConfig, policy: JsonObject) {
  if (policy.enabled === false) return undefined
  const requested = Array.isArray(policy.enabled_tools)
    ? strings(policy.enabled_tools)
    : undefined
  const enabledTools =
    requested && entry.enabledTools
      ? entry.enabledTools.filter((name) => requested.includes(name))
      : (requested ?? entry.enabledTools)
  return {
    ...entry,
    ...(enabledTools ? { enabledTools } : {}),
    disabledTools: [
      ...new Set([
        ...entry.disabledTools,
        ...strings(policy.disabled_tools),
        ...Object.entries(object(policy.tools))
          .filter(([, tool]) => object(tool).enabled === false)
          .map(([name]) => name),
      ]),
    ],
  }
}

export async function discoverCodexSnapshot(
  home: string,
  options: { importPluginResources: boolean; mcpAllowlist: string[] },
  context: {
    cwd?: string
    fs?: ProjectFileSystem
    signal?: AbortSignal
    previous?: CodexSnapshot
  } = {},
): Promise<CodexSnapshot> {
  const config = await readCodexConfig(
    home,
    context.cwd,
    context.fs,
    context.signal,
  )
  const result: CodexSnapshot = {
    config,
    mcp: [],
    skillRoots: [
      { path: join(home, 'skills') },
      { path: join(home, 'skills', '.system') },
    ],
    items: [],
  }
  const names = new Set<string>()
  const addServers = (
    servers: JsonObject,
    source: string,
    base: string,
    plugin = '',
    policies: JsonObject = {},
  ) => {
    for (const [name, declaration] of Object.entries(servers)) {
      // Plugin policy cannot replace its transport, executable or credentials.
      const policy = Object.fromEntries(
        Object.entries(object(policies[name])).filter(([key]) =>
          ['enabled', 'enabled_tools', 'disabled_tools', 'tools'].includes(key),
        ),
      )
      const raw = mergeConfig(object(declaration), policy)
      const publicName = plugin ? `${plugin}-${name}` : name
      if (
        object(raw).enabled === false ||
        (options.mcpAllowlist.length && !options.mcpAllowlist.includes(name))
      ) {
        result.items.push({ name: publicName, kind: 'mcp', state: 'disabled' })
        continue
      }
      try {
        const value = normalizeCodexMcp(
          publicName,
          raw,
          source,
          base,
          process.env,
          context.cwd ?? base,
        )
        if (!value) continue
        if (names.has(value.serverName)) throw new Error('namespace-conflict')
        names.add(value.serverName)
        result.mcp.push({ ...value, originalName: name })
      } catch (error: any) {
        const previous = context.previous?.mcp.find(
          (entry) => entry.serverName === serverName(publicName),
        )
        const retained = previous && restrictMcpFallback(previous, raw)
        if (retained) result.mcp.push(retained)
        const reason = [
          'missing-environment',
          'unsupported-transport',
          'namespace-conflict',
          'missing-command',
        ].includes(error.message)
          ? error.message
          : 'invalid-mcp-config'
        result.items.push({
          name: publicName,
          kind: 'mcp',
          state: 'unsupported',
          reason,
        })
      }
    }
  }
  addServers(object(config.mcp_servers), 'config.toml', home)
  if (options.importPluginResources) {
    for (const [id, setting] of Object.entries(object(config.plugins))) {
      if (object(setting).enabled === false) {
        result.items.push({ name: id, kind: 'plugin', state: 'disabled' })
        continue
      }
      try {
        const plugin = await resolvePlugin(home, id, config)
        if (!plugin) {
          result.items.push({
            name: id,
            kind: 'plugin',
            state: 'unsupported',
            reason: 'plugin-files-missing',
          })
          continue
        }
        const { root, manifest, portable } = plugin
        const name = String(manifest.name ?? id.split('@')[0])
        const declared = portable ? './skills' : (manifest.skills ?? './skills')
        const skillRoots: SkillRoot[] = []
        for (const entry of Array.isArray(declared) ? declared : [declared]) {
          if (typeof entry === 'string')
            skillRoots.push({
              path: resolve(root, entry),
              plugin: name,
              pluginId: id,
            })
        }
        let servers = manifest.mcpServers
        if (portable) {
          const text = await optionalText(join(root, 'mcp.json'))
          servers = text === undefined ? undefined : JSON.parse(text)
        } else if (typeof servers === 'string') {
          const text = await optionalText(resolve(root, servers))
          if (text === undefined) throw new Error('missing-plugin-mcp-file')
          servers = JSON.parse(text)
        } else if (!servers) {
          const text = await optionalText(join(root, '.mcp.json'))
          if (text) servers = JSON.parse(text)
        }
        const expanded = expandPlugin(
          object(servers).mcpServers ?? servers,
          root,
          home,
        )
        result.skillRoots.push(...skillRoots)
        addServers(
          object(expanded),
          `plugin:${id}`,
          root,
          name,
          object(object(setting).mcp_servers),
        )
        result.items.push({ name: id, kind: 'plugin', state: 'loaded' })
        for (const field of ['hooks', 'apps', 'commands']) {
          if (manifest[field])
            result.items.push({
              name: `${id}/${field}`,
              kind: 'plugin',
              state: 'unsupported',
              reason: 'codex-runtime-required',
            })
        }
      } catch {
        const policies = object(object(setting).mcp_servers)
        for (const entry of context.previous?.mcp ?? []) {
          if (entry.source !== `plugin:${id}`) continue
          if (!entry.originalName && Object.keys(policies).length) continue
          const retained = restrictMcpFallback(
            entry,
            object(policies[entry.originalName ?? '']),
          )
          if (retained) result.mcp.push(retained)
        }
        result.skillRoots.push(
          ...(context.previous?.skillRoots.filter(
            (entry) => entry.pluginId === id,
          ) ?? []),
        )
        result.items.push({
          name: id,
          kind: 'plugin',
          state: 'failed',
          reason: 'invalid-plugin-resources',
        })
      }
    }
  }
  return result
}

export function skillEnabled(
  config: JsonObject,
  skill: { name: string; path?: string },
  plugin?: string,
): boolean {
  let enabled = true
  for (const selector of Array.isArray(config.skills?.config)
    ? config.skills.config
    : []) {
    if (
      (typeof selector.path === 'string' &&
        skill.path &&
        resolve(selector.path) === resolve(skill.path)) ||
      selector.name === skill.name ||
      (plugin !== undefined && selector.name === `${plugin}:${skill.name}`)
    )
      enabled = selector.enabled !== false
  }
  if (
    config.skills?.bundled?.enabled === false &&
    skill.path?.includes(`${join('skills', '.system')}/`)
  )
    return false
  return enabled
}
export async function skillEnabledWithFs(
  config: JsonObject,
  skill: { name: string; path?: string },
  plugin: string | undefined,
  fs: ProjectFileSystem,
  signal?: AbortSignal,
): Promise<boolean> {
  const targets = new Map<string, unknown>()
  const targetKey = async (path: string) => {
    if (!targets.has(path)) {
      const target = await fs.resolve(path, signal ? { signal } : {})
      targets.set(
        path,
        target?.targetKey ?? target?.displayPath ?? resolve(path),
      )
    }
    return targets.get(path)
  }
  let enabled = true
  for (const selector of Array.isArray(config.skills?.config)
    ? config.skills.config
    : []) {
    let pathMatch = false
    if (typeof selector.path === 'string' && skill.path) {
      try {
        pathMatch =
          (await targetKey(selector.path)) === (await targetKey(skill.path))
      } catch {
        pathMatch = false
      }
    }
    if (
      pathMatch ||
      selector.name === skill.name ||
      (plugin !== undefined && selector.name === `${plugin}:${skill.name}`)
    )
      enabled = selector.enabled !== false
  }
  if (
    config.skills?.bundled?.enabled === false &&
    skill.path?.includes(`${join('skills', '.system')}/`)
  )
    return false
  return enabled
}
