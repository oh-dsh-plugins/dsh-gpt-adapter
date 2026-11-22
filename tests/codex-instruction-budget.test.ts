import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installCodexInstructions,
  loadCodexInstructions,
  renderCodexInstructions,
} from '../src/codex-instructions.js'

const { hostRead, hostOpen } = vi.hoisted(() => ({
  hostRead: vi.fn(),
  hostOpen: vi.fn(),
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: hostRead,
  open: hostOpen,
}))

beforeEach(() => {
  hostRead.mockReset()
  hostOpen.mockReset()
  hostRead.mockRejectedValue(
    Object.assign(new Error('fixture file absent'), { code: 'ENOENT' }),
  )
  hostOpen.mockRejectedValue(
    Object.assign(new Error('fixture file absent'), { code: 'ENOENT' }),
  )
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

describe('nonzero Codex instruction budget', () => {
  it.each([200, 201])(
    'respects the project budget with %i body bytes and a final newline',
    async (size) => {
      const root = '/project'
      const path = join(root, 'AGENTS.md')
      const budget = Buffer.byteLength(`Instructions from: ${path}\n\n`) + 200
      const bytes = Buffer.from('X'.repeat(size) + '\n')
      const files = await loadCodexInstructions(
        '/codex',
        root,
        { project_doc_max_bytes: budget },
        '/dsh',
        '/agents',
        {
          resolve: async (p) => p,
          stat: async (p) => (p === path ? {} : undefined),
          readText: vi.fn(),
          readByteRange: async (_, { length }) => bytes.subarray(0, length),
        },
        undefined,
        [root],
      )
      const output = renderCodexInstructions(files, budget)
      expect(output.includes('Instruction budget reached')).toBe(size > 200)
      if (size === 200) expect(output).toContain('X'.repeat(200))
    },
  )

  it.each([' '.repeat(2048) + 'OVERRIDE', '😀'.repeat(1024)])(
    'keeps a clipped override instead of falling back to its base',
    async (text) => {
      const home = '/__dsh_instruction_budget__/codex'
      const override = `${home}/AGENTS.override.md`
      const bytes = Buffer.from(text)
      let position = 0
      const close = vi.fn(async () => {})
      hostOpen.mockImplementation(async (path: string) => {
        if (path !== override)
          throw Object.assign(new Error('absent'), { code: 'ENOENT' })
        return {
          read: async (buffer: Buffer, offset: number, length: number) => {
            const count = Math.min(length, bytes.length - position)
            bytes.copy(buffer, offset, position, position + count)
            position += count
            return { bytesRead: count, buffer }
          },
          close,
        }
      })
      const loaded = await loadCodexInstructions(
        home,
        '/__dsh_instruction_budget__/project',
        { project_doc_max_bytes: 101 },
        '/__dsh_instruction_budget__/dsh',
        '/__dsh_instruction_budget__/agents',
      )
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.path).toBe(override)
      expect(loaded[0]?.content).not.toContain('�')
      expect(loaded[0]?.truncated).toBe(true)
      expect(renderCodexInstructions(loaded, 101)).toContain(
        'Instruction budget reached',
      )
      expect(
        hostOpen.mock.calls.some(([path]) => path === `${home}/AGENTS.md`),
      ).toBe(false)
      expect(position).toBeLessThanOrEqual(
        text.trimStart() === text ? 102 : 8294,
      )
      expect(close).toHaveBeenCalledTimes(1)
    },
  )

  it('ignores a whitespace-only override and skips non-adjacent duplicate instructions', async () => {
    const dirs = ['/project', '/project/child', '/project/child/nested']
    const duplicate = 'ROOT_POLICIES'.repeat(8)
    const files = new Map(
      Object.entries({
        '/project/AGENTS.override.md': ' '.repeat(9000),
        '/project/AGENTS.md': duplicate,
        '/project/child/AGENTS.md': 'CHILD_RULE',
        '/project/child/nested/AGENTS.md': duplicate,
        '/project/child/nested/AGENTS.local.md': 'LOCAL_RULE',
      }),
    )
    const readByteRange = vi.fn(
      async (
        path: string,
        { offset, length }: { offset: number; length: number },
      ) => Buffer.from(files.get(path)!).subarray(offset, offset + length),
    )
    const loaded = await loadCodexInstructions(
      '/codex',
      dirs[2]!,
      { project_doc_max_bytes: 360 },
      '/dsh',
      '/agents',
      {
        resolve: async (p) => p,
        stat: async (p) => (files.has(p) ? {} : undefined),
        readText: vi.fn(),
        readByteRange,
      },
      undefined,
      dirs,
    )
    expect(loaded.map(({ content }) => content)).toEqual([
      duplicate,
      'CHILD_RULE',
      'LOCAL_RULE',
    ])
    expect(readByteRange.mock.calls.some(([, range]) => range.offset > 0)).toBe(
      true,
    )
    expect(
      readByteRange.mock.calls.every(([, range]) => range.length <= 8192),
    ).toBe(true)
  })

  it('closes a host prefix when cancellation wins its read', async () => {
    const controller = new AbortController()
    const reason = new Error('prefix cancelled')
    const close = vi.fn(async () => {})
    hostOpen.mockResolvedValue({
      read: async (buffer: Buffer) => {
        controller.abort(reason)
        return { bytesRead: 0, buffer }
      },
      close,
    })
    await expect(
      loadCodexInstructions(
        '/__dsh_instruction_budget__/codex',
        '/__dsh_instruction_budget__/project',
        { project_doc_max_bytes: 1024 },
        '/__dsh_instruction_budget__/dsh',
        '/__dsh_instruction_budget__/agents',
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(close).toHaveBeenCalledTimes(1)
    expect(hostOpen).toHaveBeenCalledTimes(1)
  })

  it.each([1, 65536])(
    'reads a bounded UTF-8 host prefix and skips later sources with budget %s',
    async (budget) => {
      const files =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      const home = await files.mkdtemp(
        join(tmpdir(), 'dsh-instruction-budget-'),
      )
      cleanup.push(() => files.rm(home, { recursive: true, force: true }))
      const project = join(home, 'project')
      await files.mkdir(join(project, '.git'), { recursive: true })
      await files.writeFile(join(home, 'AGENTS.md'), '😀'.repeat(262144))
      await files.writeFile(join(project, 'AGENTS.md'), 'B'.repeat(1048576))
      let bytesRead = 0
      const closed: Array<ReturnType<typeof vi.fn>> = []
      hostRead.mockImplementation(async (path: string) => {
        const text = await files.readFile(path, 'utf8')
        bytesRead += Buffer.byteLength(text)
        return text
      })
      hostOpen.mockImplementation(async (path: string, flags: string) => {
        const file = await files.open(path, flags)
        const close = vi.fn(() => file.close())
        closed.push(close)
        return {
          read: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null,
          ) => {
            const result = await file.read(buffer, offset, length, position)
            bytesRead += result.bytesRead
            return result
          },
          close,
        }
      })
      const loaded = await loadCodexInstructions(
        home,
        project,
        { project_doc_max_bytes: budget },
        join(home, 'absent-dsh'),
        join(home, 'absent-agents'),
      )
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.path).toBe(join(home, 'AGENTS.md'))
      expect(loaded[0]?.content).not.toContain('�')
      expect(renderCodexInstructions(loaded, budget)).toContain(
        'Instruction budget reached',
      )
      expect(bytesRead).toBeGreaterThan(0)
      expect(bytesRead).toBeLessThanOrEqual(budget + 8)
      expect(hostRead).not.toHaveBeenCalled()
      expect(closed).toHaveLength(1)
      expect(closed[0]).toHaveBeenCalledTimes(1)
    },
  )

  it('stops scoped filesystem reads once the first source exhausts the budget', async () => {
    const f = fixture(1)
    f.filesystem.readByteRange.mockImplementation(async (_target, { length }) =>
      Buffer.from('😀'.repeat(16)).subarray(0, length),
    )
    const decision = await f.run([
      f.user,
      native('AGENTS.md', '.\0AGENTS.md', 'DROP_NATIVE_PROJECT'),
      native('AGENTS.md', 'user-global\0AGENTS.md', 'DROP_NATIVE_GLOBAL'),
    ])
    expect(f.filesystem.readByteRange).toHaveBeenCalledTimes(1)
    expect(f.filesystem.readByteRange.mock.calls[0]?.[1]).toEqual({
      offset: 0,
      length: 5, // four prefix bytes plus the EOF probe
    })
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(baseline(decision).content[0].text).toContain(
      'Instruction budget reached',
    )
    expect(f.warn).not.toHaveBeenCalled()
    expect(decision.messages).toEqual([f.user, baseline(decision)])
    expect(JSON.stringify(decision.messages)).not.toMatch(/DROP_NATIVE_/)
  })
})

function fixture(initialBudget: number | undefined = 0) {
  const project = '/__dsh_instruction_budget__/project'
  const cwd = `${project}/child`
  const filesystem = {
    resolve: vi.fn(async (path: string) => path),
    stat: vi.fn(async (path: string) =>
      path === `${project}/.git` || path.endsWith('/AGENTS.md')
        ? { type: 'file' }
        : undefined,
    ),
    readText: vi.fn(async () => 'PROJECT_INSTRUCTIONS'),
    readByteRange: vi.fn(
      async (_target: string, { length }: { length: number }) =>
        Buffer.from('PROJECT_INSTRUCTIONS').subarray(0, length),
    ),
  }
  let budget = initialBudget
  const readConfig = vi.fn(async () => ({
    ...(budget === undefined ? {} : { project_doc_max_bytes: budget }),
    project_doc_fallback_filenames: ['POLICY.md'],
  }))
  const ensure = vi.fn(async () => cwd)
  const warn = vi.fn()
  let handler: any
  installCodexInstructions(
    {
      on: (_name: string, callback: any) => (handler = callback),
      workingDirectory: { ensure },
      get: () => filesystem,
      logger: { warn },
    },
    '/__dsh_instruction_budget__/codex',
    readConfig,
  )
  const events: any[] = []
  const session = {
    surface: { nodes: [] as number[], replaceGeneration: 0 },
    eventAt: (index: number) => events[index],
  }
  const user = {
    source: { kind: 'human' },
    content: [{ type: 'text', text: 'Continue the task' }],
  }
  const run = (
    messages = [user] as any[],
    signal = new AbortController().signal,
    step = 2,
  ) =>
    handler(
      {
        agent: { session },
        messages: messages.includes(user) ? [user] : [],
        signal,
        step,
      },
      async () => ({ kind: 'enter', messages }),
    )
  return {
    filesystem,
    readConfig,
    ensure,
    warn,
    user,
    run,
    setBudget: (value: number) => (budget = value),
    commit(decision: any) {
      for (const message of decision.messages) {
        session.surface.nodes.push(events.length)
        events.push({ type: 'user/message', data: message })
      }
    },
  }
}

const native = (path: string, scope: string, text: string) => ({
  source: {
    kind: 'agent-instructions',
    changes: [{ action: 'set', path, scope }],
  },
  content: [{ type: 'text', text }],
})
const baseline = (decision: any) =>
  decision.messages.find(
    (message: any) => message.source.kind === 'codex-compat',
  )

describe('zero Codex instruction budget', () => {
  it('suppresses covered native instructions on first use without reading source contents', async () => {
    const f = fixture()
    const nested = native(
      'nested/AGENTS.md',
      'nested\0AGENTS.md',
      'KEEP_NESTED',
    )
    const result = await f.run([
      f.user,
      native('AGENTS.md', 'user-global\0AGENTS.md', 'DROP_GLOBAL'),
      native('AGENTS.md', '.\0AGENTS.md', 'DROP_PROJECT'),
      native('child/POLICY.md', 'child\0POLICY.md', 'DROP_FALLBACK'),
      nested,
    ])
    expect(result.messages).toEqual([f.user, baseline(result), nested])
    expect(baseline(result).content[0].text).toContain(
      'No workspace instructions are currently active.',
    )
    expect(JSON.stringify(result.messages)).not.toMatch(/DROP_/)
    expect(hostRead).not.toHaveBeenCalled()
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(f.filesystem.readByteRange).not.toHaveBeenCalled()
  })

  it('revokes an existing baseline when the budget becomes zero and does not repeat it', async () => {
    const f = fixture(1024)
    const first = await f.run()
    expect(baseline(first).content[0].text).toContain('PROJECT_INSTRUCTIONS')
    f.commit(first)
    f.setBudget(0)
    hostRead.mockClear()
    f.filesystem.readText.mockClear()
    f.filesystem.readByteRange.mockClear()
    const cleared = await f.run([
      f.user,
      native('AGENTS.md', '.\0AGENTS.md', 'DROP_PROJECT'),
    ])
    expect(baseline(cleared).source.identity).not.toBe(
      baseline(first).source.identity,
    )
    expect(baseline(cleared).content[0].text).toContain(
      'No workspace instructions are currently active.',
    )
    expect(JSON.stringify(cleared.messages)).not.toContain(
      'PROJECT_INSTRUCTIONS',
    )
    f.commit(cleared)
    expect((await f.run()).messages).toEqual([f.user])
    expect((await f.run([])).messages).toEqual([])
    expect(hostRead).not.toHaveBeenCalled()
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(f.filesystem.readByteRange).not.toHaveBeenCalled()
  })

  it('does not start an empty first step', async () => {
    const f = fixture()
    expect((await f.run([], undefined, 1)).messages).toEqual([])
    expect(f.ensure).not.toHaveBeenCalled()
    expect(f.readConfig).not.toHaveBeenCalled()
    expect(hostRead).not.toHaveBeenCalled()
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(f.filesystem.readByteRange).not.toHaveBeenCalled()
  })

  it('preserves cancellation before any instruction work', async () => {
    const f = fixture()
    const controller = new AbortController()
    const reason = new Error('fixture cancelled')
    controller.abort(reason)
    await expect(f.run([f.user], controller.signal)).rejects.toBe(reason)
    expect(f.ensure).not.toHaveBeenCalled()
    expect(hostRead).not.toHaveBeenCalled()
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(f.filesystem.readByteRange).not.toHaveBeenCalled()
  })

  it('propagates cancellation during directory discovery without publishing a baseline', async () => {
    const f = fixture()
    const controller = new AbortController()
    const reason = new Error('directory discovery cancelled')
    f.filesystem.resolve.mockImplementationOnce(async (path) => {
      controller.abort(reason)
      return path
    })
    await expect(f.run([f.user], controller.signal)).rejects.toBe(reason)
    expect(f.warn).not.toHaveBeenCalled()
    expect(hostRead).not.toHaveBeenCalled()
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(f.filesystem.readByteRange).not.toHaveBeenCalled()
  })

  it('propagates cancellation when the repository marker is found', async () => {
    const f = fixture()
    const controller = new AbortController()
    const reason = new Error('repository discovery cancelled')
    f.filesystem.stat.mockImplementation(async (path) => {
      if (path === '/__dsh_instruction_budget__/project/.git') {
        controller.abort(reason)
        return { type: 'file' }
      }
      return undefined
    })
    await expect(f.run([f.user], controller.signal)).rejects.toBe(reason)
    expect(f.warn).not.toHaveBeenCalled()
    expect(hostRead).not.toHaveBeenCalled()
    expect(f.filesystem.readText).not.toHaveBeenCalled()
    expect(f.filesystem.readByteRange).not.toHaveBeenCalled()
  })
})
