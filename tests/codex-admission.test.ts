import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ToolsService from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installCodexCompatibility } from '../src/codex.js'

it('admits MCP tools in actual AgentLoop requests on first use and after idle reconnect', async () => {
  const require = createRequire(import.meta.url)
  const native = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
  const load = (name: string) =>
    import(pathToFileURL(native.resolve(name)).href)
  const [
    { default: Agents },
    { default: Sessions },
    { default: SystemPrompt },
    { default: Projections },
  ] = await Promise.all(
    [
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-session-projection',
    ].map(load),
  )
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-admission-'))
  const ctx = new Context()
  let runtime: ReturnType<typeof installCodexCompatibility> | undefined
  const requests: any[] = []
  let opened = 0,
    closed = 0
  try {
    await writeFile(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\n',
    )
    ctx.provide('llm', {
      prepareCall: async (config: any) => ({
        config,
        async *stream(request: any) {
          requests.push(request)
          // Capture the real assembled request without invoking a model.
          throw new Error('fixture request captured')
        },
      }),
    } as any)
    await ctx.plugin(Sessions)
    await ctx.plugin(Agents)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    })
    await ctx.plugin(ToolsService)
    const tools = ctx.get('tools') as ToolsService
    tools.setExecutor({
      describe: (definitions: any[]) => ({
        schemas: definitions.map((definition) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        })),
      }),
      execute: async () => ({ concluded: true, additionalContexts: [] }),
    } as any)
    const originalResolve = (tools as any)[symbols.original].resolve
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      stat: (path: string) =>
        stat(path).catch((error) => {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
          return undefined
        }),
      readText: (path: string) => readFile(path, 'utf8'),
    } as any)
    ctx.provide('workingDirectory', { ensure: async () => home } as any)
    runtime = installCodexCompatibility(ctx, {
      enabled: true,
      codexHome: home,
      importInstructions: false,
      importSkills: false,
      importMcpServers: true,
      importPluginResources: false,
      watch: false,
      pollIntervalMs: 250,
      mcpIdleTimeoutMs: 5,
      mcpAllowlist: [],
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    await runtime.refresh()
    const agent = await (ctx.get('agentLoop') as any).create(
      'fixture-native-agent',
      { provider: 'fixture', model: 'fixture' },
    )
    const owner = agent.ctx
    const plugin = owner.plugin.bind(owner)
    agent.ctx = owner.extend({
      plugin(entry: any, ...args: any[]) {
        if (!entry?.name?.startsWith('codex-mcp-'))
          return plugin(entry, ...args)
        opened++
        const unregister = owner.tools.register({
          name: 'mcp__fixture__read',
          description: 'Fixture',
          parameters: { type: 'object', properties: {} },
          output: {
            schema: { type: 'string' },
            render: () => [{ type: 'text', text: 'OK' }],
          },
          execute: async () => 'OK',
        })
        let disposed = false
        const fiber: any = Promise.resolve()
        fiber.dispose = async () => {
          if (!disposed) {
            disposed = true
            closed++
            unregister()
          }
        }
        return fiber
      },
    })
    expect(opened).toBe(0)
    const prompt = () =>
      createUserMessage({
        content: [{ type: 'text', text: 'Fixture' }],
        source: { kind: 'fixture' },
      } as any)
    agent.followup(prompt())
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].tools.map((tool: any) => tool.name)).toContain(
      'mcp__fixture__read',
    )
    await vi.waitFor(() => expect(closed).toBe(1))
    agent.followup(prompt())
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(opened).toBe(2)
    expect(requests[1].tools.map((tool: any) => tool.name)).toContain(
      'mcp__fixture__read',
    )
    await runtime.dispose()
    expect((tools as any)[symbols.original].resolve).toBe(originalResolve)
  } finally {
    await runtime?.dispose()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
