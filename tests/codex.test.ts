import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import {
  discoverCodexSnapshot,
  normalizeCodexMcp,
  readCodexConfig,
  skillEnabled,
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
    await put(join(home, 'config.toml'), '')
    expect((await discoverCodexSnapshot(home, options)).mcp).toEqual([])
  })

  it('does not convert invalid config into a successful empty configuration', async () => {
    const home = await directory()
    expect(await readCodexConfig(home)).toEqual({})
    await put(join(home, 'config.toml'), 'broken = [')
    await expect(readCodexConfig(home)).rejects.toThrow()
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
      logger: { warn() {} },
    }
    installCodexInstructions(context, home)
    const events: any[] = [],
      user = { source: { kind: 'human' }, content: [] },
      native = { source: { kind: 'agent-instructions' } }
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
    await put(join(home, 'AGENTS.md'), 'global version 2')
    const updated = await handler(payload, next)
    expect(updated.messages[1].content[0].text).toContain('global version 2')
    expect(updated.messages[1].content[0].text).not.toContain(
      'global version 1',
    )
  })
})

describe('Codex runtime integration', () => {
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
    ctx.provide('tools', {
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
    await put(join(home, 'config.toml'), 'broken = [')
    await runtime.refresh()
    expect(tools.get('mcp__fixture__echo')).toBe(original)
    expect(runtime.status().items.some((i) => i.state === 'failed')).toBe(true)
    await put(join(home, 'config.toml'), '')
    await runtime.refresh()
    expect(tools.size).toBe(0)
    await runtime.dispose()
  })

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
    ctx.provide('tools', {
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
    ctx.provide('tools', { register: () => () => {} })
    const runtime = installCodexCompatibility(ctx, {
      ...options,
      codexHome: home,
      importSkills: false,
      importInstructions: false,
    })
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
