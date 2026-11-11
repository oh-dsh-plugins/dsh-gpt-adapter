import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
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
export type SkillRoot = { path: string; plugin?: string }
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

export async function readCodexConfig(home: string): Promise<JsonObject> {
  const text = await optionalText(join(home, 'config.toml'))
  return text === undefined ? {} : object(parse(text))
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
  const cwd = typeof raw.cwd === 'string' ? resolve(base, raw.cwd) : base
  const command =
    raw.command.includes('/') && !isAbsolute(raw.command)
      ? resolve(cwd, raw.command)
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
): Promise<{ root: string; manifest: JsonObject } | undefined> {
  for (const name of ['.codex-plugin', '.claude-plugin']) {
    const text = await optionalText(join(root, name, 'plugin.json'))
    if (text !== undefined) return { root, manifest: object(JSON.parse(text)) }
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

export async function discoverCodexSnapshot(
  home: string,
  options: { importPluginResources: boolean; mcpAllowlist: string[] },
): Promise<CodexSnapshot> {
  const config = await readCodexConfig(home)
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
  ) => {
    for (const [name, raw] of Object.entries(servers)) {
      const publicName = plugin ? `${plugin}-${name}` : name
      if (
        object(raw).enabled === false ||
        (options.mcpAllowlist.length && !options.mcpAllowlist.includes(name))
      ) {
        result.items.push({ name: publicName, kind: 'mcp', state: 'disabled' })
        continue
      }
      try {
        const value = normalizeCodexMcp(publicName, raw, source, base)
        if (!value) continue
        if (names.has(value.serverName)) throw new Error('namespace-conflict')
        names.add(value.serverName)
        result.mcp.push(value)
      } catch (error: any) {
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
        const { root, manifest } = plugin
        const name = String(manifest.name ?? id.split('@')[0])
        const declared = manifest.skills ?? './skills'
        for (const entry of Array.isArray(declared) ? declared : [declared]) {
          if (typeof entry === 'string')
            result.skillRoots.push({ path: resolve(root, entry), plugin: name })
        }
        let servers = manifest.mcpServers
        if (typeof servers === 'string') {
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
        addServers(object(expanded), `plugin:${id}`, root, name)
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
