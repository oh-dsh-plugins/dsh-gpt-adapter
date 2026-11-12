import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { installCodexMcpMetadata } from '../src/codex-mcp-metadata.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  vi.restoreAllMocks()
})
function bridge() {
  const value = installCodexMcpMetadata()
  cleanup.push(() => value.dispose())
  return value
}
const metadata = { session_id: 'dsh-session', turn_id: 'dsh-session:12' }

describe('Codex MCP request context', () => {
  it('preserves ordinary calls, existing metadata, arguments and cancellation options', async () => {
    const original = vi
      .spyOn(Client.prototype, 'callTool')
      .mockResolvedValue({ content: [] })
    const value = bridge()
    const client = new Client({ name: 'fixture', version: '1' })
    const params = {
      name: 'js',
      arguments: { code: '1' },
      _meta: { trace: 'keep' },
    }
    const options = { signal: new AbortController().signal, timeout: 1234 }
    await client.callTool(params, options)
    expect(original).toHaveBeenLastCalledWith(params, options)
    await value.run(metadata, () => client.callTool(params, options))
    const sent = original.mock.calls.at(-1)!
    expect(sent[0]).toEqual({
      ...params,
      _meta: { trace: 'keep', 'x-codex-turn-metadata': metadata },
    })
    expect(sent[0].arguments).toBe(params.arguments)
    expect(sent[1]).toBe(options)
    expect(params._meta).toEqual({ trace: 'keep' })
    await client.callTool(params, options)
    expect(original.mock.calls.at(-1)![0]).toBe(params)
  })

  it('keeps overlapping runtime owners independent and restores the SDK on final unload', async () => {
    const original = Client.prototype.callTool
    const first = bridge(),
      second = bridge()
    const installed = Client.prototype.callTool
    first.dispose()
    first.dispose()
    expect(Client.prototype.callTool).toBe(installed)
    second.dispose()
    expect(Client.prototype.callTool).toBe(original)
  })

  it('does not reuse an outer turn in an agentless or disposed asynchronous execution', async () => {
    const original = vi
      .spyOn(Client.prototype, 'callTool')
      .mockResolvedValue({ content: [] })
    const first = bridge(),
      second = bridge()
    const client = new Client({ name: 'fixture', version: '1' })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const pending = first.run(metadata, async () => {
      await gate
      return client.callTool({ name: 'js' })
    })
    await second.run(metadata, () =>
      second.run(undefined, () => client.callTool({ name: 'js' })),
    )
    expect(original.mock.calls.at(-1)![0]._meta).toBeUndefined()
    first.dispose()
    resume()
    await pending
    expect(original.mock.calls.at(-1)![0]._meta).toBeUndefined()
  })

  it('preserves failures and clears scoped metadata after rejection', async () => {
    const failure = new Error('aborted')
    const original = vi
      .spyOn(Client.prototype, 'callTool')
      .mockRejectedValue(failure)
    const value = bridge()
    const client = new Client({ name: 'fixture', version: '1' })
    await expect(
      value.run(metadata, () => client.callTool({ name: 'js' })),
    ).rejects.toBe(failure)
    await expect(client.callTool({ name: 'js' })).rejects.toBe(failure)
    expect(original.mock.calls.at(-1)![0]._meta).toBeUndefined()
  })
})
