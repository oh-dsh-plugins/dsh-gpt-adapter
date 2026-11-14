import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
  stat,
  symlink,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { getEventListeners } from 'node:events'
import { Client } from '@modelcontextprotocol/client'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  CodexResourceCache,
  discoverCodexSnapshot,
  normalizeCodexMcp,
  readCodexConfig,
  skillEnabled,
  skillEnabledWithFs,
} from '../src/codex-config.js'
import {
  installCodexInstructions,
  loadCodexInstructions,
  renderCodexInstructions,
} from '../src/codex-instructions.js'
import {
  installCodexCompatibility,
  type CodexCompatibilityConfig,
} from '../src/codex.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
})
async function directory() {
  const d = await mkdtemp(join(tmpdir(), 'dsh-codex-test-'))
  cleanup.push(() => rm(d, { recursive: true, force: true }))
  return d
}
async function put(p: string, content: string) {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, content)
}
const fixtureFs = {
  resolve: async (path: string) => path,
  stat: async (path: string) =>
    stat(path).catch((error) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      return undefined
    }),
  readText: (path: string) => readFile(path, 'utf8'),
}
const skillFs = {
  resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
  processPath: (target: any) => target.displayPath,
  stat: async (target: any) => {
    const info: any = await fixtureFs.stat(target.displayPath ?? target)
    return info
      ? {
          type: info.isFile()
            ? 'file'
            : info.isDirectory()
              ? 'directory'
              : 'other',
        }
      : undefined
  },
  readText: (target: any) => fixtureFs.readText(target.displayPath ?? target),
  listDir: async (target: any) =>
    (await readdir(target.displayPath, { withFileTypes: true })).map(
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
function mcpHost(ctx: Context) {
  ctx.provide('fs', fixtureFs as any)
  ctx.provide('workingDirectory', {
    ensure: async (agent: any) => agent.cwd,
  } as any)
  ctx.provide('agents', { list: () => [] } as any)
}
async function attachAgent(ctx: Context, cwd: string) {
  // Cordis starts injected plugins asynchronously, as the Host does before session creation.
  await new Promise<void>((done) => setImmediate(done))
  const agent: any = { cwd }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  await ctx.serial('agent/created', { agent, source: 'create' } as any)
  await preStep(ctx, agent)
  return agent
}
async function preStep(ctx: Context, agent: any, signal?: AbortSignal) {
  const admitted = await ctx.get('tools')!.resolve({
    agent,
    modelSelection: { provider: 'fixture', model: 'fixture' },
    signal: signal ?? new AbortController().signal,
  })
  admitted?.dispose()
}
async function httpMcp() {
  const fixture = {
    healthy: true,
    calls: [] as number[],
    messages: [] as any[],
  }
  const server = createServer(async (request, response) => {
    fixture.calls.push(Date.now())
    if (!fixture.healthy) {
      response.writeHead(503).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    fixture.messages.push(message)
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'OK' }] }
          : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  )
  return Object.assign(fixture, {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
  })
}
const options: CodexCompatibilityConfig = {
  enabled: true,
  importInstructions: true,
  importSkills: true,
  importMcpServers: true,
  importPluginResources: true,
  watch: false,
  pollIntervalMs: 250,
  mcpAllowlist: [],
}

describe('Codex config and plugin resources', () => {
  it('findings: honors plugin server policies even when retaining a broken plugin snapshot', async () => {
    const home = await directory()
    const plugin = join(home, 'plugins/cache/sample/active/1.0.0')
    const config =
      '[plugins."active@sample"]\nenabled=true\n' +
      '[plugins."active@sample".mcp_servers.off]\nenabled=false\n' +
      '[plugins."active@sample".mcp_servers.backend]\nenabled_tools=["read"]\ndisabled_tools=["write"]\ncommand="ignored"\n' +
      '[plugins."active@sample".mcp_servers.backend.tools.remove]\nenabled=false\n'
    await put(join(home, 'config.toml'), config)
    await put(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({
        name: 'actual-name',
        mcpServers: './.mcp.json',
      }),
    )
    await put(
      join(plugin, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          backend: { command: 'fixture', tools: { other: { enabled: false } } },
          off: { command: 'fixture' },
        },
      }),
    )
    const snapshot = await discoverCodexSnapshot(home, options)
    expect(snapshot.mcp).toHaveLength(1)
    expect(snapshot.mcp[0]).toMatchObject({
      serverName: 'actual-name-backend',
      command: 'fixture',
      enabledTools: ['read'],
      disabledTools: ['write', 'other', 'remove'],
    })
    expect(snapshot.items).toContainEqual({
      name: 'actual-name-off',
      kind: 'mcp',
      state: 'disabled',
    })
    await put(join(plugin, '.mcp.json'), 'broken-json')
    await put(
      join(home, 'config.toml'),
      config.replace(
        'enabled_tools=["read"]',
        'enabled=false\nenabled_tools=["read"]',
      ),
    )
    const disabled = await discoverCodexSnapshot(home, options, {
      previous: snapshot,
    })
    expect(disabled.mcp).toEqual([])
    await put(
      join(home, 'config.toml'),
      config.replace('disabled_tools=["write"]', 'disabled_tools=["read"]'),
    )
    const narrowed = await discoverCodexSnapshot(home, options, {
      previous: snapshot,
    })
    expect(narrowed.mcp[0]?.disabledTools).toContain('read')
    expect(narrowed.mcp[0]?.disabledTools).toContain('write')
  })

  it.each([false, true])(
    'findings: loads portable components with inline OpenAI overlay=%s',
    async (inline) => {
      const home = await directory(),
        project = join(home, 'project')
      await mkdir(project)
      const plugin = join(home, 'plugins/cache/sample/portable/1.0.0')
      await put(
        join(home, 'config.toml'),
        '[plugins."portable@sample"]\nenabled=true\n',
      )
      await put(
        join(plugin, 'plugin.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: 'portable',
          skills: './wrong-skills',
          mcpServers: './wrong.json',
          ...(inline ? { extensions: { 'com.openai': {} } } : {}),
        }),
      )
      await put(
        join(plugin, '.codex-plugin/plugin.json'),
        JSON.stringify({
          name: 'wrong-name',
          skills: './wrong-skills',
          mcpServers: './wrong.json',
          apps: './.app.json',
        }),
      )
      await put(
        join(plugin, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            backend: { type: 'stdio', command: '${PLUGIN_ROOT}/server' },
          },
        }),
      )
      const snapshot = await discoverCodexSnapshot(home, options, {
        cwd: project,
      })
      expect(snapshot.mcp).toHaveLength(1)
      expect(snapshot.mcp[0]).toMatchObject({
        serverName: 'portable-backend',
        command: join(plugin, 'server'),
        cwd: project,
      })
      expect(snapshot.skillRoots).toContainEqual({
        path: join(plugin, 'skills'),
        plugin: 'portable',
        pluginId: 'portable@sample',
      })
      expect(
        snapshot.skillRoots.some((root) => root.path.includes('wrong-skills')),
      ).toBe(false)
      expect(
        snapshot.items.some((item) => item.name === 'portable@sample/apps'),
      ).toBe(!inline)
    },
  )

  it('maps HTTP authentication, inherited stdio env, filters, cwd and timeouts without persisting credentials', () => {
    const http = normalizeCodexMcp(
      'remote',
      {
        url: 'https://fixture.invalid/mcp',
        env_http_headers: { 'X-Test': 'HEADER' },
        bearer_token_env_var: 'TOKEN',
        tool_timeout_sec: 12,
        disabled_tools: ['write'],
      },
      'test',
      '/tmp',
      { HEADER: 'header-value', TOKEN: 'token-value' },
    )!
    expect(http.headers).toEqual({
      'X-Test': 'header-value',
      Authorization: 'Bearer token-value',
    })
    expect(http.toolCallTimeoutMs).toBe(12000)
    const local = normalizeCodexMcp(
      'local',
      {
        command: './server',
        cwd: 'work',
        args: ['--read-only'],
        env: { A: 'explicit' },
        env_vars: ['A', 'B'],
        enabled_tools: ['read'],
        startup_timeout_sec: 3,
      },
      'test',
      '/tmp',
      { A: 'ambient', B: 'inherited' },
    )!
    expect(local).toMatchObject({
      command: '/tmp/work/server',
      cwd: '/tmp/work',
      env: { A: 'explicit', B: 'inherited' },
      enabledTools: ['read'],
      startupTimeoutMs: 3000,
    })
    expect(
      normalizeCodexMcp('off', { enabled: false }, 'test', '/tmp'),
    ).toBeUndefined()
    expect(() =>
      normalizeCodexMcp(
        'auth',
        { url: 'https://fixture.invalid', bearer_token_env_var: 'MISSING' },
        'test',
        '/tmp',
        {},
      ),
    ).toThrow('missing-environment')
  })

  it('loads only enabled plugins from their selected marketplace, including referenced MCP files', async () => {
    const home = await directory()
    const plugin = join(home, 'plugins/cache/sample/active/1.0.0')
    await put(
      join(home, 'config.toml'),
      '[plugins."active@sample"]\nenabled=true\n[plugins."off@sample"]\nenabled=false\n[mcp_servers.disabled]\nenabled=false\n',
    )
    await put(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({
        name: 'active',
        skills: './skills',
        mcpServers: './.mcp.json',
        hooks: { Stop: [] },
      }),
    )
    await put(
      join(plugin, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            command: '${CODEX_PLUGIN_ROOT}/server',
            cwd: '${CODEX_PLUGIN_ROOT}',
          },
        },
      }),
    )
    await put(
      join(home, 'plugins/cache/other/active/99.0.0/.codex-plugin/plugin.json'),
      JSON.stringify({
        name: 'active',
        mcpServers: { wrong: { command: 'wrong' } },
      }),
    )
    const snapshot = await discoverCodexSnapshot(home, options)
    expect(snapshot.mcp).toHaveLength(1)
    expect(snapshot.mcp[0]).toMatchObject({
      serverName: 'active-local',
      command: join(plugin, 'server'),
      cwd: plugin,
    })
    expect(snapshot.skillRoots).toContainEqual({
      path: join(plugin, 'skills'),
      plugin: 'active',
      pluginId: 'active@sample',
    })
    expect(snapshot.items).toContainEqual({
      name: 'off@sample',
      kind: 'plugin',
      state: 'disabled',
    })
    expect(snapshot.items).toContainEqual({
      name: 'active@sample/hooks',
      kind: 'plugin',
      state: 'unsupported',
      reason: 'codex-runtime-required',
    })
    await put(join(plugin, '.mcp.json'), 'invalid-json')
    const invalid = await discoverCodexSnapshot(home, options, {
      previous: snapshot,
    })
    expect(invalid.mcp).toEqual(snapshot.mcp)
    expect(invalid.skillRoots).toEqual(snapshot.skillRoots)
    expect(invalid.items).toContainEqual({
      name: 'active@sample',
      kind: 'plugin',
      state: 'failed',
      reason: 'invalid-plugin-resources',
    })
    await put(join(home, 'config.toml'), '')
    expect((await discoverCodexSnapshot(home, options)).mcp).toEqual([])
  })

  it('does not convert invalid config into a successful empty configuration', async () => {
    const home = await directory()
    expect(await readCodexConfig(home)).toEqual({})
    await put(join(home, 'config.toml'), 'broken = [')
    await expect(readCodexConfig(home)).rejects.toThrow()
  })

  it('merges trusted project layers in order and skips untrusted layers', async () => {
    const home = await directory(),
      project = join(home, 'project'),
      cwd = join(project, 'child')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(cwd)
    const config = `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n[mcp_servers.fixture]\ncommand="fixture"\n`
    await put(join(home, 'config.toml'), config)
    await put(
      join(project, '.codex/config.toml'),
      '[mcp_servers.fixture]\nenabled=false\nproject_doc_max_bytes=12\n',
    )
    await put(join(cwd, '.codex/config.toml'), 'project_doc_max_bytes=0\n')
    const result = await discoverCodexSnapshot(home, options, {
      cwd,
      fs: fixtureFs,
    })
    expect(result.mcp).toEqual([])
    expect(result.config.project_doc_max_bytes).toBe(0)
    expect(result.config.mcp_servers.fixture.command).toBe('fixture')
    await put(join(home, 'config.toml'), config.replace('trusted', 'untrusted'))
    expect(
      (await discoverCodexSnapshot(home, options, { cwd, fs: fixtureFs })).mcp,
    ).toHaveLength(1)
  })

  it('matches disabled skill selectors through symlink aliases', async () => {
    const home = await realpath(await directory()),
      target = join(home, 'target/SKILL.md'),
      alias = join(home, 'skills/alias')
    await put(target, 'fixture')
    await mkdir(dirname(alias), { recursive: true })
    await symlink(dirname(target), alias)
    const fs = {
      resolve: async (path: string) => ({ targetKey: await realpath(path) }),
    }
    await expect(
      skillEnabledWithFs(
        {
          skills: {
            config: [{ path: join(alias, 'SKILL.md'), enabled: false }],
          },
        },
        { name: 'alias', path: target },
        undefined,
        fs as any,
      ),
    ).resolves.toBe(false)
  })

  it('honors ordered disabled skill selectors and bundled policy', () => {
    const skill = { name: 'example', path: '/tmp/skills/example/SKILL.md' }
    expect(
      skillEnabled(
        {
          skills: {
            config: [
              { name: 'example', enabled: false },
              { path: skill.path, enabled: true },
            ],
          },
        },
        skill,
      ),
    ).toBe(true)
    expect(
      skillEnabled(
        { skills: { config: [{ path: skill.path, enabled: false }] } },
        skill,
      ),
    ).toBe(false)
    expect(
      skillEnabled(
        { skills: { config: [{ name: 'plugin:example', enabled: false }] } },
        skill,
        'plugin',
      ),
    ).toBe(false)
    expect(
      skillEnabled(
        { skills: { bundled: { enabled: false } } },
        { name: 'system', path: '/tmp/skills/.system/system/SKILL.md' },
      ),
    ).toBe(false)
  })
})

describe('Codex instruction context', () => {
  it('serializes the fresh-session instruction baseline through the official DSH Responses adapter', async () => {
    const home = await directory(),
      project = join(home, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    await put(join(home, 'AGENTS.md'), 'Fresh Codex instruction fixture')
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    let gate: any, adapter: any, request: any
    installCodexInstructions(
      {
        on: (_name: string, fn: any) => {
          gate = fn
        },
        workingDirectory: { ensure: async () => project },
        get: () => fixtureFs,
        logger: { warn() {} },
      },
      home,
    )
    const user = {
      role: 'user',
      source: { kind: 'human' },
      content: [{ type: 'text', text: 'Inspect the project' }],
    }
    const decision = await gate(
      {
        agent: { session: { surface: { nodes: [] } } },
        messages: [user],
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'accept', messages: [user] }),
    )
    const native = await import('@deepseek-ai/dsh-llm-pi-ai')
    ctx.provide('settings', { configure: () => () => {} })
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'fixture-key' }),
    })
    ctx.provide('llm', {
      registerAdapter: (_routes: any, value: any) => {
        adapter = value
        return Object.assign(() => {}, { replace() {} })
      },
      registerConfigurableProviders: () =>
        Object.assign(() => {}, { replace() {} }),
      registerModelDiscovery: () => () => {},
    })
    vi.stubGlobal('fetch', async (_url: any, init: any) => {
      request = JSON.parse(String(init.body))
      const response = {
        id: 'resp_fixture',
        model: 'gpt-fixture',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      }
      return new Response(
        `data: ${JSON.stringify({ type: 'response.created', response })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    native.apply(
      ctx,
      native.Config({
        providers: {
          fixture: {
            api: 'openai-responses',
            baseURL: 'https://fixture.invalid/v1',
            apiKeyEnv: 'FIXTURE',
            models: [{ id: 'gpt-fixture' }],
          },
        },
      }),
    )
    const call = await adapter.prepareCall('fixture', 'gpt-fixture')
    for await (const _chunk of call.stream({
      provider: 'fixture',
      model: 'gpt-fixture',
      system: 'DSH system fixture',
      messages: decision.messages,
    })) {
    }
    expect(JSON.stringify(request.input)).toContain(
      'Fresh Codex instruction fixture',
    )
    expect(JSON.stringify(request.input)).toContain('DSH system fixture')
    expect(JSON.stringify(request.input)).toContain('Inspect the project')
  })
  it('uses nonempty overrides, configured fallback names, project order, native globals and content deduplication', async () => {
    const home = await directory(),
      project = join(home, 'project'),
      cwd = join(project, 'child')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(cwd)
    await put(join(home, 'AGENTS.override.md'), '')
    await put(join(home, 'AGENTS.md'), 'global')
    await put(join(project, 'AGENTS.md'), 'ignored project base')
    await put(join(project, 'AGENTS.override.md'), 'project override')
    await put(join(cwd, 'CLAUDE.md'), 'child fallback')
    await put(join(home, 'native/AGENTS.md'), 'native global')
    const files = await loadCodexInstructions(
      home,
      cwd,
      { project_doc_fallback_filenames: ['CLAUDE.md'] },
      join(home, 'native'),
      join(home, 'absent'),
    )
    expect(files.map((x) => x.content)).toEqual([
      'native global',
      'global',
      'project override',
      'child fallback',
    ])
    expect(renderCodexInstructions(files)).not.toContain('ignored project base')
    expect(
      renderCodexInstructions([{ path: 'x', content: '</system-reminder>' }]),
    ).toContain('<\\/system-reminder>')
  })

  it('logs a baseline once, replaces native project candidates, refreshes changes and preserves user messages', async () => {
    const home = await directory(),
      project = join(home, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    await put(join(home, 'AGENTS.md'), 'global version 1')
    let handler: any
    const context = {
      on: (_name: string, fn: any) => {
        handler = fn
      },
      workingDirectory: { ensure: async () => project },
      get: () => fixtureFs,
      logger: { warn() {} },
    }
    installCodexInstructions(context, home)
    const events: any[] = [],
      user = { source: { kind: 'human' }, content: [] },
      native = {
        source: {
          kind: 'agent-instructions',
          changes: [
            { action: 'set', scope: '.\0AGENTS.md', path: 'AGENTS.md' },
          ],
        },
      }
    const session = {
      surface: {
        get nodes() {
          return events.map((_, index) => index)
        },
      },
      eventAt: (index: number) => events[index],
    }
    const payload = {
      agent: { session },
      messages: [user],
      signal: new AbortController().signal,
    }
    const next = async () => ({ kind: 'accept', messages: [user, native] })
    const first = await handler(payload, next)
    expect(first.messages[0]).toBe(user)
    expect(first.messages).toHaveLength(2)
    events.push({ type: 'user/message', data: first.messages[1] })
    expect((await handler(payload, next)).messages).toEqual([user])
    for (const action of ['set', 'replace', 'remove']) {
      const nested = {
        source: {
          kind: 'agent-instructions',
          changes: [
            { action, scope: 'nested\0AGENTS.md', path: 'nested/AGENTS.md' },
          ],
        },
        content: [{ type: 'text', text: 'NESTED_ONLY' }],
      }
      const result = await handler(payload, async () => ({
        kind: 'accept',
        messages: [user, native, nested],
      }))
      expect(result.messages).toEqual([user, nested])
      const mixed = {
        ...nested,
        source: {
          ...nested.source,
          changes: [...native.source.changes, ...nested.source.changes],
        },
      }
      expect(
        (
          await handler(payload, async () => ({
            kind: 'accept',
            messages: [user, mixed],
          }))
        ).messages,
      ).toEqual([user, mixed])
      const renderedMixed = {
        ...mixed,
        content: [
          {
            type: 'text',
            text: `<system-reminder>\nAdditional instructions from: AGENTS.md\n\nCOVERED\n\n${action === 'set' ? 'Additional instructions from' : action === 'replace' ? 'Updated instructions from' : 'Instructions removed'}: nested/AGENTS.md\n\nNESTED_ONLY\n</system-reminder>`,
          },
        ],
      }
      const retained = (
        await handler(payload, async () => ({
          kind: 'accept',
          messages: [user, renderedMixed],
        }))
      ).messages[1]
      expect(retained.content[0].text).toContain('NESTED_ONLY')
      expect(retained.content[0].text).not.toContain('COVERED')
    }
    await put(join(home, 'AGENTS.md'), 'global version 2')
    const updated = await handler(payload, next)
    expect(updated.messages[1].content[0].text).toContain('global version 2')
    expect(updated.messages[1].content[0].text).not.toContain(
      'global version 1',
    )
    await put(join(home, 'config.toml'), 'project_doc_max_bytes=0\n')
    await put(join(project, 'AGENTS.md'), 'PROJECT_BUDGET_FIXTURE')
    const zero = await handler(payload, next)
    expect(JSON.stringify(zero.messages)).not.toContain(
      'PROJECT_BUDGET_FIXTURE',
    )
  })

  it('uses the DSH filesystem and cancellation for project instruction reads without a host fallback', async () => {
    const home = await directory(),
      project = join(home, 'project'),
      outside = join(home, 'outside.txt')
    await mkdir(join(project, '.git'), { recursive: true })
    await put(outside, 'PRIVATE_FIXTURE')
    await symlink(outside, join(project, 'AGENTS.override.md'))
    const readText = vi.fn(async () => {
      throw new Error('denied-by-filesystem')
    })
    const signal = new AbortController().signal
    let gate: any
    installCodexInstructions(
      {
        on: (_: string, fn: any) => {
          gate = fn
        },
        workingDirectory: { ensure: async () => project },
        get: () => ({ ...fixtureFs, readText }),
        logger: { warn() {} },
      },
      home,
    )
    const native = { source: { kind: 'agent-instructions' } },
      decision = { kind: 'accept', messages: [native] }
    const result = await gate(
      { agent: { session: { surface: { nodes: [] } } }, messages: [], signal },
      async () => decision,
    )
    expect(result).toBe(decision)
    expect(readText).toHaveBeenCalledWith(
      join(project, 'AGENTS.override.md'),
      signal,
    )
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE')
  })
})

describe('Codex runtime integration', () => {
  it.each([true, false])(
    'cancels an in-flight skill read and contains late results on disposal (cooperative=%s)',
    async (cooperative) => {
      const home = await directory()
      const path = join(home, 'skills/example/SKILL.md')
      const content =
        '---\nname: example\ndescription: Fixture\n---\nSkill body'
      await put(path, content)
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      let reading = false
      let readSignal: AbortSignal | undefined
      let release = () => {}
      let entered!: () => void
      const started = new Promise<void>((resolve) => (entered = resolve))
      ctx.provide('fs', {
        ...skillFs,
        readText(target: any, signal?: AbortSignal) {
          if (!reading || target.displayPath !== path)
            return skillFs.readText(target)
          readSignal = signal
          entered()
          return new Promise<string>((resolve, reject) => {
            const abort = () => reject(signal!.reason)
            release = () => {
              signal?.removeEventListener('abort', abort)
              resolve(content)
            }
            if (cooperative) {
              signal?.addEventListener('abort', abort, { once: true })
              if (signal?.aborted) abort()
            }
          })
        },
      } as any)
      await ctx.plugin(SkillRegistry)
      const registry = ctx.get('skills') as SkillRegistry
      const runtime = installCodexCompatibility(ctx, {
        ...options,
        codexHome: home,
        importInstructions: false,
        importMcpServers: false,
      })
      cleanup.push(() => runtime.dispose())
      await new Promise<void>((done) => setImmediate(done))
      await runtime.refresh()
      await registry.list({ cwd: home })
      const caller = new AbortController()
      const listeners = getEventListeners(caller.signal, 'abort').length
      const reads = vi.spyOn(CodexResourceCache.prototype, 'read')
      try {
        reading = true
        const result = registry
          .get('example', { cwd: home, signal: caller.signal })
          .then(
            (value) => ({ value, error: undefined }),
            (error) => ({ value: undefined, error }),
          )
        await started
        await runtime.dispose()
        const callsAfterDispose = reads.mock.calls.length
        expect(readSignal?.aborted).toBe(true)
        expect(caller.signal.aborted).toBe(false)
        release()
        const settled = await result
        expect(settled.value).toBeUndefined()
        expect(settled.error).toBeInstanceOf(Error)
        expect(reads).toHaveBeenCalledTimes(callsAfterDispose)
        expect(getEventListeners(caller.signal, 'abort')).toHaveLength(
          listeners,
        )
      } finally {
        release()
        reads.mockRestore()
      }
    },
  )

  it('does not repopulate a scoped snapshot when disposal wins a project read', async () => {
    const home = await directory(),
      project = join(home, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    )
    const path = join(project, '.codex/config.toml')
    await put(path, '[skills.bundled]\nenabled=false\n')
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    let reading = false
    let readSignal: AbortSignal | undefined
    let release = () => {}
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    ctx.provide('fs', {
      ...skillFs,
      readText(target: any, signal?: AbortSignal) {
        if (!reading || target.displayPath !== path)
          return skillFs.readText(target)
        readSignal = signal
        entered()
        return new Promise<string>((resolve) => {
          release = () => resolve('[skills.bundled]\nenabled=false\n')
        })
      },
    } as any)
    await ctx.plugin(SkillRegistry)
    const registry = ctx.get('skills') as SkillRegistry
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importMcpServers: false,
    })
    cleanup.push(() => runtime.dispose())
    await new Promise<void>((done) => setImmediate(done))
    await runtime.refresh()
    let snapshots: Map<string, unknown> | undefined
    const originalSet = Map.prototype.set
    const observer = vi
      .spyOn(Map.prototype, 'set')
      .mockImplementation(function (this: Map<any, any>, key: any, value: any) {
        if (
          String(key).endsWith(`:${project}`) &&
          value?.skillRoots &&
          value?.config &&
          value?.items
        )
          snapshots = this
        return originalSet.call(this, key, value)
      })
    try {
      await registry.list({ cwd: project })
      expect(snapshots?.size).toBe(1)
      reading = true
      const result = registry.list({ cwd: project }).then(
        () => undefined,
        (error) => error,
      )
      await started
      await runtime.dispose()
      expect(readSignal?.aborted).toBe(true)
      expect(snapshots?.size).toBe(0)
      release()
      expect(await result).toBeInstanceOf(Error)
      expect(snapshots?.size).toBe(0)
    } finally {
      release()
      observer.mockRestore()
    }
  })

  it('releases temporary skill-provider listeners across project lists and reads', async () => {
    const home = await directory(),
      project = join(home, 'project')
    const plugin = join(home, 'plugins/cache/sample/active/1.0.0')
    await mkdir(join(project, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[plugins."active@sample"]\nenabled=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    )
    await put(
      join(project, '.codex/config.toml'),
      '[plugins."active@sample"]\nenabled=true\n',
    )
    await put(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'active', skills: './skills' }),
    )
    await put(
      join(plugin, 'skills/example/SKILL.md'),
      '---\nname: example\ndescription: Fixture\n---\nScoped skill',
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    ctx.provide('fs', skillFs as any)
    const lifetime = new AbortController()
    let provider: any
    ctx.provide('skills', {
      registerProvider(factory: any) {
        provider = factory({ signal: lifetime.signal, invalidate() {} })
        return () => lifetime.abort()
      },
      async list() {
        return []
      },
      async snapshot() {
        return { skills: [] }
      },
      async get() {
        return undefined
      },
    } as any)
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importMcpServers: false,
    })
    await new Promise<void>((done) => setImmediate(done))
    await runtime.refresh()
    const before = getEventListeners(lifetime.signal, 'abort').length
    expect(before).toBeGreaterThan(0)
    let candidate: any
    for (let index = 0; index < 25; index++) {
      const call = { cwd: project, signal: new AbortController().signal }
      const listed = await provider.list(call)
      candidate = listed.candidates.find(
        (skill: any) => skill.name === 'active-example',
      )
      expect((await provider.get(candidate, call)).content).toContain(
        'Scoped skill',
      )
      expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(before)
    }
    const failure = vi
      .spyOn(skillFs, 'readText')
      .mockRejectedValueOnce(new Error('fixture read failed'))
    try {
      await provider.get(candidate, { cwd: project }).catch(() => undefined)
      expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(before)
    } finally {
      failure.mockRestore()
    }
    await runtime.dispose()
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0)
  })

  it('findings: starts stdio MCPs in each Agent project and updates cwd on a project switch', async () => {
    const home = await directory(),
      aDir = join(home, 'a'),
      bDir = join(home, 'b')
    await mkdir(aDir)
    await mkdir(bDir)
    const server = join(home, 'cwd-server.mjs')
    await put(
      server,
      `import readline from 'node:readline';
const r=readline.createInterface({input:process.stdin});
r.on('line',s=>{const q=JSON.parse(s);if(q.id===undefined)return;
let result={};
if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'cwd',version:'1'}};
if(q.method==='tools/list')result={tools:[{name:'cwd',inputSchema:{type:'object'}}]};
if(q.method==='tools/call')result={content:[{type:'text',text:process.cwd()}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`,
    )
    await put(
      join(home, 'config.toml'),
      `[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(server)}]\n`,
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    mcpHost(ctx)
    ctx.provide('systemPrompt', {
      tools() {},
      section() {},
      getSectionOrder() {
        return 1
      },
    } as any)
    await ctx.plugin(ToolsService)
    const tools = ctx.get('tools') as ToolsService
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importSkills: false,
    })
    const a = await attachAgent(ctx, aDir),
      b = await attachAgent(ctx, bDir)
    const invoke = (agent: any) =>
      tools
        .definitions(agent)[0]!
        .execute({}, { agent, signal: new AbortController().signal } as any)
    expect(JSON.stringify(await invoke(a))).toContain(aDir)
    expect(JSON.stringify(await invoke(b))).toContain(bDir)
    a.cwd = bDir
    await runtime.refresh()
    expect(JSON.stringify(await invoke(a))).toContain(bDir)
    const snapshot = await discoverCodexSnapshot(home, options, { cwd: aDir })
    expect(snapshot.mcp[0]?.cwd).toBe(aDir)
    expect(
      normalizeCodexMcp(
        'relative',
        { command: './server' },
        'plugin',
        home,
        {},
        aDir,
      )?.command,
    ).toBe(join(home, 'server'))
    expect(
      normalizeCodexMcp(
        'explicit',
        { command: 'node', cwd: 'work' },
        'plugin',
        home,
        {},
        aDir,
      )?.cwd,
    ).toBe(join(home, 'work'))
    await runtime.dispose()
  })

  it.each([false, true])(
    'waits for agent-triggered cleanup during plugin disposal (failure=%s)',
    async (fails) => {
      const home = await directory()
      await put(
        join(home, 'config.toml'),
        '[mcp_servers.fixture]\ncommand="fixture"\n',
      )
      const handlers = new Map<string, (...args: any[]) => any>()
      const original = Client.prototype.callTool
      const failure = new Error('transport close failed')
      let release!: () => void, started!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const closing = new Promise<void>((resolve) => {
        started = resolve
      })
      const dispose = vi.fn(async () => {
        started()
        await gate
        if (fails) throw failure
      })
      const child: any = {
        tools: { resolve: async () => ({ dispose() {} }) },
        effect: (setup: any) => setup(),
        agents: { list: () => [] },
        workingDirectory: { ensure: async () => home },
        get: () => fixtureFs,
        on: (name: string, fn: (...args: any[]) => any) =>
          handlers.set(name, fn),
      }
      const ctx: any = {
        inject(_deps: string[], apply: (child: any) => void) {
          apply(child)
          return { dispose: async () => {} }
        },
        effect() {},
      }
      const agent = {
        ctx: { get: () => fixtureFs, plugin: () => ({ dispose }) },
      }
      const runtime = installCodexCompatibility(ctx, {
        ...options,
        codexHome: home,
        importSkills: false,
        importInstructions: false,
        importPluginResources: false,
      })
      let shutdown: Promise<unknown> | undefined
      try {
        await child.tools.resolve({ agent })
        await runtime.refresh()
        const cleanup = handlers.get('agent/disposed')!({
          agent,
        }) as Promise<void>
        const result = cleanup.then(
          () => undefined,
          (error) => error,
        )
        expect(handlers.get('agent/disposed')!({ agent })).toBe(cleanup)
        await closing
        let finished = false
        shutdown = runtime.dispose().then(
          () => undefined,
          (error) => error,
        )
        void shutdown.then(() => {
          finished = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        expect(finished).toBe(false)
        expect(Client.prototype.callTool).not.toBe(original)
        expect(dispose).toHaveBeenCalledTimes(1)
        release()
        expect(await result).toBe(fails ? failure : undefined)
        expect(await shutdown).toBe(fails ? failure : undefined)
        expect(Client.prototype.callTool).toBe(original)
      } finally {
        release()
        await shutdown
        await runtime.dispose().catch(() => {})
      }
    },
  )

  it.each(['sync', 'async', 'single'])(
    'waits for every MCP client when the first disposer fails (%s)',
    async (mode) => {
      const home = await directory()
      await put(
        join(home, 'config.toml'),
        ['first', 'second', 'third']
          .map((name) => `[mcp_servers.${name}]\ncommand="fixture"\n`)
          .join('\n'),
      )
      const handlers = new Map<string, (...args: any[]) => any>()
      const firstFailure = new Error('first transport close failed')
      const secondFailure = new Error('second transport close failed')
      const original = Client.prototype.callTool
      const started: number[] = [],
        finished: number[] = []
      let index = 0,
        release!: () => void,
        settled = false
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const child: any = {
        tools: { resolve: async () => ({ dispose() {} }) },
        effect: (setup: any) => setup(),
        agents: { list: () => [] },
        workingDirectory: { ensure: async (agent: any) => agent.cwd },
        get: (name: string) => (name === 'fs' ? fixtureFs : undefined),
        on: (name: string, listener: (...args: any[]) => any) =>
          handlers.set(name, listener),
      }
      const ctx: any = {
        inject(_dependencies: string[], apply: (ctx: any) => void) {
          apply(child)
          return { dispose: async () => {} }
        },
        effect() {},
      }
      const agent: any = {
        cwd: home,
        ctx: {
          get: () => fixtureFs,
          plugin() {
            const id = index++
            return {
              dispose() {
                started.push(id)
                if (id === 0) {
                  if (mode === 'sync') throw firstFailure
                  return Promise.reject(firstFailure)
                }
                return gate.then(() => {
                  finished.push(id)
                  if (id === 1 && mode !== 'single') throw secondFailure
                })
              },
            }
          },
        },
      }
      const runtime = installCodexCompatibility(ctx, {
        ...options,
        codexHome: home,
        importInstructions: false,
        importSkills: false,
        importPluginResources: false,
      })
      let completion: Promise<unknown> | undefined
      try {
        await child.tools.resolve({ agent })
        await runtime.refresh()
        expect(index).toBe(3)
        completion = runtime.dispose().then(
          () => undefined,
          (error) => error,
        )
        void completion.then(() => {
          settled = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(started).toEqual([0, 1, 2])
        expect(settled).toBe(false)
        expect(Client.prototype.callTool).not.toBe(original)
        release()
        const error = await completion
        expect(finished).toEqual([1, 2])
        if (mode === 'single') expect(error).toBe(firstFailure)
        else {
          expect(error).toBeInstanceOf(AggregateError)
          expect((error as AggregateError).errors).toEqual([
            firstFailure,
            secondFailure,
          ])
        }
        expect(Client.prototype.callTool).toBe(original)
      } finally {
        release()
        await completion
        await runtime.dispose().catch(() => {})
      }
    },
  )

  it('findings: restores MCP metadata and completes sibling cleanup when a scope disposer rejects', async () => {
    const home = await directory()
    const original = Client.prototype.callTool
    const failure = new Error('scope disposal failed')
    const disposed: number[] = []
    let index = 0
    const ctx: any = {
      inject() {
        const id = index++
        return {
          async dispose() {
            disposed.push(id)
            if (id === 0) throw failure
          },
        }
      },
      effect() {},
    }
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importSkills: false,
    })
    try {
      await expect(runtime.dispose()).rejects.toBe(failure)
      expect(disposed.sort()).toEqual([0, 1, 2])
      expect(Client.prototype.callTool).toBe(original)
      await expect(runtime.dispose()).rejects.toBe(failure)
      expect(disposed).toHaveLength(3)
    } finally {
      Client.prototype.callTool = original
    }
  })

  it('sends per-turn Codex metadata on concurrent imported MCP calls without changing arguments', async () => {
    const home = await directory(),
      server = await httpMcp()
    await put(
      join(home, 'config.toml'),
      `[mcp_servers.fixture]\nurl=${JSON.stringify(server.url)}\n`,
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    mcpHost(ctx)
    ctx.provide('systemPrompt', {
      tools() {},
      section() {},
      getSectionOrder() {
        return 1
      },
    } as any)
    await ctx.plugin(ToolsService)
    const tools = ctx.get('tools') as ToolsService
    const boundaries = new Map<any, number | null>()
    ;(ctx.get('agents') as any).turnBoundaryOf = (session: any) => ({
      openTurnStartSeq: boundaries.get(session) ?? null,
    })
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importInstructions: false,
    })
    const a = await attachAgent(ctx, home),
      b = await attachAgent(ctx, home)
    a.id = 'session-a'
    a.session = {}
    b.id = 'session-b'
    b.session = {}
    boundaries.set(a.session, 10)
    boundaries.set(b.session, 20)
    const invoke = (agent: any) =>
      tools
        .definitions(agent)[0]!
        .execute({ code: 'example()', title: 'unchanged' }, {
          agent,
          signal: new AbortController().signal,
        } as any)
    await Promise.all([invoke(a), invoke(b)])
    boundaries.set(a.session, 30)
    await invoke(a)
    const calls = server.messages.filter((m) => m.method === 'tools/call')
    expect(
      calls
        .map((m) => m.params._meta?.['x-codex-turn-metadata'])
        .sort((x, y) => x?.turn_id.localeCompare(y?.turn_id)),
    ).toEqual([
      { session_id: 'session-a', turn_id: 'session-a:10' },
      { session_id: 'session-a', turn_id: 'session-a:30' },
      { session_id: 'session-b', turn_id: 'session-b:20' },
    ])
    expect(
      calls.every(
        (m) =>
          JSON.stringify(m.params.arguments) ===
          JSON.stringify({ code: 'example()', title: 'unchanged' }),
      ),
    ).toBe(true)
    boundaries.set(a.session, null)
    await invoke(a)
    expect(
      server.messages.at(-1).params._meta?.['x-codex-turn-metadata'],
    ).toBeUndefined()
    await runtime.dispose()
  })

  it('applies trusted project MCP overrides in separate Agent scopes and cleans up on unload', async () => {
    const home = await directory(),
      first = join(home, 'first'),
      second = join(home, 'second'),
      server = await httpMcp()
    for (const path of [first, second])
      await mkdir(join(path, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[mcp_servers.fixture]\nurl=${JSON.stringify(server.url)}\n[projects.${JSON.stringify(first)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(second)}]\ntrust_level="trusted"\n`,
    )
    await put(
      join(first, '.codex/config.toml'),
      `[mcp_servers.fixture]\nenabled=false\n[mcp_servers.only_a]\nurl=${JSON.stringify(server.url)}\n`,
    )
    await put(
      join(second, '.codex/config.toml'),
      `[mcp_servers.only_b]\nurl=${JSON.stringify(server.url)}\n`,
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    mcpHost(ctx)
    ctx.provide('systemPrompt', {
      tools() {},
      section() {},
      getSectionOrder() {
        return 1
      },
    } as any)
    await ctx.plugin(ToolsService)
    const tools = ctx.get('tools') as ToolsService
    let runtime!: ReturnType<typeof installCodexCompatibility>
    await ctx.plugin({
      name: 'fixture-owner',
      apply(owner: Context) {
        runtime = installCodexCompatibility(owner, {
          ...options,
          codexHome: home,
          importSkills: false,
          importInstructions: false,
        })
      },
    })
    const a = await attachAgent(ctx, first),
      b = await attachAgent(ctx, second)
    expect(tools.definitions()).toEqual([])
    expect(tools.definitions(a).map((tool) => tool.name)).toEqual([
      'mcp__only_a__read',
    ])
    expect(
      tools
        .definitions(b)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['mcp__fixture__read', 'mcp__only_b__read'])
    a.cwd = second
    await runtime.refresh()
    expect(
      tools
        .definitions(a)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['mcp__fixture__read', 'mcp__only_b__read'])
    await put(join(first, '.codex/config.toml'), 'broken = [')
    a.cwd = first
    await runtime.refresh()
    expect(tools.definitions(a)).toEqual([])
    expect(
      tools
        .definitions(b)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['mcp__fixture__read', 'mcp__only_b__read'])
    await runtime.dispose()
    expect(tools.definitions(a)).toEqual([])
    expect(tools.definitions(b)).toEqual([])
  })

  it('coalesces repeated agent refreshes and lets a canceled caller stop waiting independently', async () => {
    const home = await directory()
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const ensure = vi.fn(
      async (_agent?: unknown, _signal?: AbortSignal) => home,
    )
    ctx.provide('fs', fixtureFs as any)
    ctx.provide('workingDirectory', { ensure } as any)
    ctx.provide('agents', { list: () => [] } as any)
    ctx.provide('tools', {
      register: () => () => {},
      resolve: async () => ({ dispose() {} }),
    } as any)
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importSkills: false,
    })
    const agent = await attachAgent(ctx, home)
    ensure.mockClear()
    let release!: (cwd: string) => void
    ensure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const abort = new AbortController()
    const first = preStep(ctx, agent, abort.signal)
    const canceled = expect(first).rejects.toThrow('caller canceled')
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1))
    const queued = Array.from({ length: 20 }, () => preStep(ctx, agent))
    await Promise.resolve()
    expect(ensure).toHaveBeenCalledTimes(1)
    abort.abort(new Error('caller canceled'))
    await canceled
    release(home)
    await Promise.all(queued)
    expect(ensure).toHaveBeenCalledTimes(2)
    ensure.mockImplementationOnce(
      (_agent, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), {
            once: true,
          })
        }),
    )
    const refreshing = runtime.refresh()
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(3))
    await runtime.dispose()
    await refreshing
  })

  it('bounds directory fallback snapshots and releases them on disposal', async () => {
    const home = await directory()
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    const registry = ctx.get('skills') as SkillRegistry
    let runtime!: ReturnType<typeof installCodexCompatibility>
    await ctx.plugin({
      name: 'bounded-codex',
      apply(owner: Context) {
        runtime = installCodexCompatibility(owner, {
          ...options,
          codexHome: home,
          importMcpServers: false,
          importInstructions: false,
        })
      },
    })
    await runtime.refresh()
    const first = join(home, 'scope-0')
    let snapshots: Map<string, unknown> | undefined
    const originalSet = Map.prototype.set
    const observer = vi
      .spyOn(Map.prototype, 'set')
      .mockImplementation(function (this: Map<any, any>, key: any, value: any) {
        if (
          String(key).endsWith(`:${first}`) &&
          value?.skillRoots &&
          value?.config &&
          value?.items
        )
          snapshots = this
        return originalSet.call(this, key, value)
      })
    cleanup.push(async () => {
      observer.mockRestore()
    })
    for (let index = 0; index < 65; index++)
      await registry.list({ cwd: join(home, `scope-${index}`) } as any)
    expect(snapshots?.size).toBe(64)
    expect(
      [...snapshots!.keys()].some((key) => key.endsWith(`:${first}`)),
    ).toBe(false)
    await runtime.dispose()
    expect(snapshots?.size).toBe(0)
  })

  it('automatically retries a transient initial MCP failure with backoff', async () => {
    const home = await directory(),
      server = await httpMcp()
    server.healthy = false
    await put(
      join(home, 'config.toml'),
      `[mcp_servers.fixture]\nurl=${JSON.stringify(server.url)}\n`,
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    mcpHost(ctx)
    const tools = new Map<string, any>()
    ctx.provide('tools', {
      resolve: async () => ({ dispose() {} }),
      register(tool: any) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    } as any)
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      watch: true,
      importInstructions: false,
      importSkills: false,
    })
    await attachAgent(ctx, home)
    expect(
      runtime.status().items.some((entry) => entry.state === 'failed'),
    ).toBe(true)
    const failedCalls = server.calls.length,
      recoveredAt = Date.now()
    server.healthy = true
    await vi.waitFor(() => expect(tools.size).toBe(1), {
      timeout: 3000,
      interval: 50,
    })
    expect(server.calls.length).toBeGreaterThan(failedCalls)
    expect(server.calls[failedCalls]! - recoveredAt).toBeGreaterThanOrEqual(400)
    expect(runtime.status().items).toContainEqual({
      name: 'fixture',
      kind: 'mcp',
      state: 'loaded',
    })
    const statusKeys = runtime
      .status()
      .items.map((item) => `${item.kind}\0${item.name}`)
    expect(new Set(statusKeys).size).toBe(statusKeys.length)
  })

  it('automatically detects configuration changes and stops polling on disposal', async () => {
    const home = await directory()
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      watch: true,
      importMcpServers: false,
      importSkills: false,
      importInstructions: false,
    })
    await runtime.refresh()
    await put(
      join(home, 'config.toml'),
      '[plugins."off@fixture"]\nenabled=false\n',
    )
    await vi.waitFor(
      () =>
        expect(runtime.status().items).toContainEqual({
          name: 'off@fixture',
          kind: 'plugin',
          state: 'disabled',
        }),
      { timeout: 2000, interval: 50 },
    )
    await runtime.dispose()
    expect(runtime.status().enabled).toBe(false)
  })
  it('loads official filesystem skills with original resource paths and restores native disabled-skill policy on unload', async () => {
    const home = await directory()
    await put(
      join(home, 'skills/example/SKILL.md'),
      '---\nname: example\ndescription: Example skill\n---\nRead ./references/file.md',
    )
    await put(
      join(home, 'config.toml'),
      '[[skills.config]]\nname="native"\nenabled=false\n',
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    const registry = ctx.get('skills') as SkillRegistry
    registry.register({
      name: 'native',
      description: 'Native fixture',
      source: 'runtime',
      content: 'body',
    })
    let runtime!: ReturnType<typeof installCodexCompatibility>
    await ctx.plugin({
      name: 'codex-test-owner',
      apply(owner: Context) {
        runtime = installCodexCompatibility(owner, {
          ...options,
          codexHome: home,
          importMcpServers: false,
          importInstructions: false,
        })
      },
    })
    await runtime.refresh()
    const entries = await registry.list()
    expect(entries.map((s) => s.name)).toContain('example')
    expect(entries.map((s) => s.name)).not.toContain('native')
    const skill = await registry.get('example')
    expect(skill?.resourceBase).toEqual({
      kind: 'directory',
      path: join(home, 'skills/example'),
    })
    expect(skill?.content).toContain('./references/file.md')
    await runtime.dispose()
    expect((await registry.list()).map((s) => s.name)).toContain('native')
    expect((await registry.list()).map((s) => s.name)).not.toContain('example')
  })

  it('discovers nested project skills with nearer-directory precedence through the official registry', async () => {
    const home = await directory(),
      project = join(home, 'project'),
      cwd = join(project, 'child')
    await mkdir(join(project, '.git'), { recursive: true })
    for (const [base, body] of [
      [project, 'ROOT'],
      [cwd, 'CHILD'],
    ])
      await put(
        join(base!, '.agents/skills/shared/SKILL.md'),
        `---\nname: shared\ndescription: Fixture\n---\n${body}`,
      )
    await put(
      join(cwd, '.agents/skills/child-only/SKILL.md'),
      '---\nname: child-only\ndescription: Child\n---\nChild body',
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    const registry = ctx.get('skills') as SkillRegistry
    let native!: FileSystemSkillProvider
    registry.registerProvider(
      (control) =>
        (native = new FileSystemSkillProvider(ctx, control, {
          watch: false,
          dshHome: join(home, 'dsh'),
          agentsHome: join(home, 'agents'),
        })),
    )
    cleanup.push(() => native.dispose())
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importMcpServers: false,
    })
    await new Promise<void>((done) => setImmediate(done))
    await runtime.refresh()
    expect((await registry.list({ cwd })).map((s) => s.name)).toContain(
      'child-only',
    )
    expect((await registry.get('shared', { cwd }))?.content).toContain('CHILD')
    expect(
      (await registry.list({ cwd: project })).map((s) => s.name),
    ).not.toContain('child-only')
  })

  it('applies trusted project plugin skill roots and retains the last-good scope on a broken layer', async () => {
    const home = await directory(),
      project = join(home, 'project'),
      plugin = join(home, 'plugins/cache/sample/active/1.0.0')
    await mkdir(join(project, '.git'), { recursive: true })
    await put(
      join(home, 'config.toml'),
      `[plugins."active@sample"]\nenabled=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    )
    await put(
      join(project, '.codex/config.toml'),
      '[plugins."active@sample"]\nenabled=true\n',
    )
    await put(
      join(plugin, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'active', skills: './skills' }),
    )
    await put(
      join(plugin, 'skills/example/SKILL.md'),
      '---\nname: example\ndescription: Example\n---\nProject plugin skill',
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    ctx.provide('fs', skillFs as any)
    await ctx.plugin(SkillRegistry)
    const registry = ctx.get('skills') as SkillRegistry
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importInstructions: false,
      importMcpServers: false,
    })
    await new Promise<void>((done) => setImmediate(done))
    await runtime.refresh()
    expect(
      (await registry.list({ cwd: project })).map((s) => s.name),
    ).toContain('active-example')
    await put(join(project, '.codex/config.toml'), 'broken = [')
    expect(
      (await registry.list({ cwd: project })).map((s) => s.name),
    ).toContain('active-example')
    await runtime.dispose()
  })

  it('connects a real stdio MCP, filters tools, preserves unchanged connections and removes deleted servers', async () => {
    const home = await directory(),
      server = join(home, 'mcp.mjs')
    await put(
      server,
      `import readline from 'node:readline';\nconst r=readline.createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);if(q.id===undefined)return;let result={};if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{}}},{name:'hidden',description:'Hidden',inputSchema:{type:'object',properties:{}}}]};if(q.method==='tools/call')result={content:[{type:'text',text:'OK'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`,
    )
    await put(
      join(home, 'config.toml'),
      `[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(server)}]\nenabled_tools=["echo"]\n`,
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const tools = new Map<string, any>()
    mcpHost(ctx)
    ctx.provide('tools', {
      resolve: async () => ({ dispose() {} }),
      register: (tool: any) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    })
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importInstructions: false,
    })
    const agent = await attachAgent(ctx, home)
    await runtime.refresh()
    expect(runtime.status().items).toContainEqual({
      name: 'fixture',
      kind: 'mcp',
      state: 'loaded',
    })
    expect([...tools.keys()]).toEqual(['mcp__fixture__echo'])
    const original = tools.get('mcp__fixture__echo')
    const response = await original.execute(
      {},
      { signal: new AbortController().signal },
    )
    expect(JSON.stringify(response)).toContain('OK')
    await runtime.refresh()
    expect(tools.get('mcp__fixture__echo')).toBe(original)
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="invalid-url"\n',
    )
    await runtime.refresh()
    expect(tools.get('mcp__fixture__echo')).toBe(original)
    expect(runtime.status().items).toContainEqual({
      name: 'fixture',
      kind: 'mcp',
      state: 'unsupported',
      reason: 'invalid-mcp-config',
    })
    await put(join(home, 'config.toml'), 'broken = [')
    await runtime.refresh()
    await expect(preStep(ctx, agent)).resolves.toBeUndefined()
    expect(tools.get('mcp__fixture__echo')).toBe(original)
    expect(runtime.status().items.some((i) => i.state === 'failed')).toBe(true)
    await put(join(home, 'config.toml'), '')
    await runtime.refresh()
    expect(tools.size).toBe(0)
    await runtime.dispose()
  })

  it
    .runIf('connectionStatusOf' in McpClient)
    .each(['idle', 'replace', 'remove'] as const)(
    'blocks admission when native MCP disposal reports incomplete cleanup after %s',
    async (change) => {
      const home = await directory()
      const upstream = await httpMcp()
      await put(
        join(home, 'config.toml'),
        `[mcp_servers.fixture]\nurl=${JSON.stringify(upstream.url)}\n`,
      )
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      mcpHost(ctx)
      const register = vi.fn(() => () => {
        throw new Error('fixture tool cleanup failed')
      })
      const admitted = vi.fn(async () => ({ dispose() {} }))
      ctx.provide('tools', {
        resolve: admitted,
        register,
      } as any)
      const runtime = installCodexCompatibility(ctx, {
        ...options,
        codexHome: home,
        importInstructions: false,
        importSkills: false,
        mcpIdleTimeoutMs: 1,
      })
      const agent = await attachAgent(ctx, home)
      expect(register).toHaveBeenCalledTimes(1)
      if (change === 'idle') {
        ctx.emit('agent/status', { agent, status: 'idle' } as any)
        await vi.waitFor(() =>
          expect(runtime.status().items).toContainEqual({
            name: 'codex-mcp',
            kind: 'mcp',
            state: 'failed',
            reason: 'cleanup-failed; replacement blocked',
          }),
        )
      } else {
        await put(
          join(home, 'config.toml'),
          change === 'remove'
            ? ''
            : `[mcp_servers.fixture]\nurl=${JSON.stringify(upstream.url + '/replacement')}\n`,
        )
      }
      await expect(preStep(ctx, agent)).rejects.toThrow(
        'MCP connection cleanup is incomplete',
      )
      expect(admitted).toHaveBeenCalledTimes(1)
      expect(runtime.status().items).toContainEqual({
        name: 'fixture',
        kind: 'mcp',
        state: 'failed',
        reason: 'cleanup-failed; replacement blocked',
      })
      await put(join(home, 'config.toml'), 'broken = [')
      await expect(preStep(ctx, agent)).rejects.toThrow(
        'MCP connection cleanup is incomplete',
      )
      expect(admitted).toHaveBeenCalledTimes(1)
      expect(register).toHaveBeenCalledTimes(1)
      expect(
        upstream.messages.filter((message) => message.method === 'initialize'),
      ).toHaveLength(1)
      await expect(runtime.dispose()).rejects.toThrow(
        'MCP connection cleanup is incomplete',
      )
    },
  )

  it('connects a real HTTP MCP with imported headers and refreshes a disabled server without exposing credentials in status', async () => {
    const home = await directory(),
      seen: Array<string | undefined> = []
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      let text = ''
      for await (const chunk of request) text += chunk
      const message = JSON.parse(text)
      seen.push(request.headers.authorization)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'http-fixture', version: '1' },
            }
          : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        }),
    )
    const address = server.address() as { port: number }
    await put(
      join(home, 'config.toml'),
      `[mcp_servers.web]\nurl="http://127.0.0.1:${address.port}/mcp"\n[mcp_servers.web.http_headers]\nAuthorization="Bearer fixture-token"\n`,
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const tools = new Map<string, any>()
    mcpHost(ctx)
    ctx.provide('tools', {
      resolve: async () => ({ dispose() {} }),
      register: (tool: any) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    })
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importInstructions: false,
    })
    await attachAgent(ctx, home)
    await runtime.refresh()
    expect([...tools.keys()]).toEqual(['mcp__web__read'])
    expect(seen.every((value) => value === 'Bearer fixture-token')).toBe(true)
    expect(JSON.stringify(runtime.status())).not.toContain('fixture-token')
    await put(join(home, 'config.toml'), '[mcp_servers.web]\nenabled=false\n')
    await runtime.refresh()
    expect(tools.size).toBe(0)
    expect(runtime.status().items).toContainEqual({
      name: 'web',
      kind: 'mcp',
      state: 'disabled',
    })
    await runtime.dispose()
  })

  it('keeps a failed MCP isolated while the rest of the environment loads', async () => {
    const home = await directory()
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.bad]\ncommand="/missing/dsh-codex-fixture"\n',
    )
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    mcpHost(ctx)
    ctx.provide('tools', {
      register: () => () => {},
      resolve: async () => ({ dispose() {} }),
    })
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importInstructions: false,
    })
    await attachAgent(ctx, home)
    await runtime.refresh()
    expect(runtime.status().items).toContainEqual({
      name: 'bad',
      kind: 'mcp',
      state: 'failed',
      reason: 'connection-failed',
    })
    await runtime.dispose()
  })
})
