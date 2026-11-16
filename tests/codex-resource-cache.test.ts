import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CodexResourceCache,
  discoverCodexSnapshot,
} from '../src/codex-config.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.unstubAllEnvs()
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  )
})
const options = { importPluginResources: true, mcpAllowlist: [] }
async function put(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}

describe('Codex Host resource reuse', () => {
  it('keeps admission bounded and reclaims a working set after it stops being read', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-resources-'))
    directories.push(home)
    const paths = Array.from({ length: 257 }, (_, index) =>
      join(home, `${index}.json`),
    )
    await Promise.all(paths.map((path) => put(path, {})))
    const resources = new CodexResourceCache()
    const load = vi.fn(async () => ({}))
    try {
      for (let round = 0; round < 2; round++) {
        const observation = resources.observe()
        for (const path of paths) await observation.read(path, 'fixture', load)
      }
      // The overflow resource is read twice; the retained 256 are loaded once.
      expect(load).toHaveBeenCalledTimes(258)
      const overflow = paths.at(-1)!
      await resources.observe().read(overflow, 'fixture', load)
      await resources.observe().read(overflow, 'fixture', load)
      await resources.observe().read(overflow, 'fixture', load)
      const admitted = load.mock.calls.length
      await resources.observe().read(overflow, 'fixture', load)
      expect(load).toHaveBeenCalledTimes(admitted)
      await resources.read(paths[0]!, 'fixture', load)
      expect(load).toHaveBeenCalledTimes(admitted + 1)
    } finally {
      resources.dispose()
    }
  })

  it('preserves in-flight observations while new observations evict and reload resources', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-resources-'))
    directories.push(home)
    const path = join(home, 'fixture.json')
    await put(path, {})
    const resources = new CodexResourceCache()
    const previous = resources.observe()
    let release!: (value: string) => void
    const load = vi.fn(
      () => new Promise<string>((resolve) => (release = resolve)),
    )
    const oldRead = previous.read(path, 'fixture', load)
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
      resources.observe()
      const current = resources.observe()
      await expect(
        current.read(path, 'fixture', async () => 'current'),
      ).resolves.toBe('current')
      release('previous')
      await expect(oldRead).resolves.toBe('previous')
      await expect(
        previous.read(path, 'fixture', async () => 'unexpected'),
      ).resolves.toBe('previous')

      const failed = resources.observe()
      await expect(
        failed.read(path, 'failed', async () => {
          throw new Error('temporary read failure')
        }),
      ).rejects.toThrow('temporary read failure')
      await expect(
        failed.read(path, 'failed', async () => 'retried'),
      ).resolves.toBe('retried')
      await fs.rm(path)
      const missingLoad = vi.fn(async () => 'unexpected')
      await expect(
        resources.observe().read(path, 'fixture', missingLoad),
      ).resolves.toBeUndefined()
      expect(missingLoad).not.toHaveBeenCalled()
      await put(path, {})
      await expect(
        resources.observe().read(path, 'fixture', async () => 'recreated'),
      ).resolves.toBe('recreated')
    } finally {
      release?.('previous')
      await oldRead.catch(() => {})
      resources.dispose()
    }
  })

  it('reuses its bounded working set when a scan contains 90 plugins', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-resources-'))
    directories.push(home)
    await put(
      join(home, 'config.toml'),
      Array.from(
        { length: 90 },
        (_, index) => `[plugins."plugin${index}@fixture"]\nenabled=true\n`,
      ).join(''),
    )
    for (let index = 0; index < 90; index++) {
      const root = join(home, `plugins/cache/fixture/plugin${index}/1.0.0`)
      await put(join(root, '.codex-plugin/plugin.json'), {
        name: `plugin${index}`,
        mcpServers: './.mcp.json',
      })
      await put(join(root, '.mcp.json'), {})
    }
    const resources = new CodexResourceCache()
    const read = vi.spyOn(fs, 'readFile')
    const listing = vi.spyOn(fs, 'readdir')
    syncBuiltinESMExports()
    try {
      const scan = () =>
        discoverCodexSnapshot(home, options, {
          resources: resources.observe(),
        })
      expect((await scan()).skillRoots).toHaveLength(92)
      read.mockClear()
      listing.mockClear()
      expect((await scan()).skillRoots).toHaveLength(92)
      expect(read.mock.calls.length).toBeLessThan(20)
      expect(listing.mock.calls.length).toBeLessThan(10)
      const changed = join(
        home,
        'plugins/cache/fixture/plugin0/1.0.0/.mcp.json',
      )
      await put(changed, { fixture: { command: 'updated-fixture' } })
      expect((await scan()).mcp[0]?.command).toBe('updated-fixture')
    } finally {
      resources.dispose()
    }
  })

  it('rejects closed reads, including loads and metadata checks already in flight', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-resources-'))
    directories.push(home)
    const path = join(home, 'fixture.json')
    await put(path, {})
    const resources = new CodexResourceCache()
    let release!: (value: unknown) => void
    const value = new Promise((resolve) => (release = resolve))
    const load = vi.fn(() => value)
    const first = resources.read(path, 'fixture', load)
    const second = resources.read(path, 'fixture', load)
    const settled = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    resources.dispose()
    release({})
    expect(
      (await settled).every((result) => result.status === 'rejected'),
    ).toBe(true)
    const lateLoad = vi.fn(async () => ({}))
    await expect(resources.read(path, 'fixture', lateLoad)).rejects.toThrow(
      'disposed',
    )
    expect(lateLoad).not.toHaveBeenCalled()

    const pendingStat = new CodexResourceCache()
    const result = pendingStat.read(path, 'fixture', lateLoad)
    pendingStat.dispose()
    await expect(result).rejects.toThrow('disposed')
    expect(lateLoad).not.toHaveBeenCalled()
  })

  it('avoids unchanged reads and observes atomic edits, new plugin versions, and disablement', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-resources-'))
    directories.push(home)
    const base = join(home, 'plugins/cache/sample/active')
    const first = join(base, '1.0.0')
    const declaration = (url: string) => ({ mcpServers: { fixture: { url } } })
    await put(
      join(home, 'config.toml'),
      '[plugins."active@sample"]\nenabled=true\n',
    )
    await put(join(first, '.codex-plugin/plugin.json'), {
      name: 'active',
      skills: './skills',
    })
    await put(
      join(first, '.mcp.json'),
      declaration('https://fixture.invalid/first'),
    )
    const resources = new CodexResourceCache()
    const read = vi.spyOn(fs, 'readFile')
    const listing = vi.spyOn(fs, 'readdir')
    syncBuiltinESMExports()
    try {
      const [initial] = await Promise.all([
        discoverCodexSnapshot(home, options, { resources }),
        discoverCodexSnapshot(home, options, { resources }),
      ])
      expect(initial!.mcp[0]!.url).toBe('https://fixture.invalid/first')
      expect(
        read.mock.calls.filter(
          ([path]) => String(path) === join(home, 'config.toml'),
        ),
      ).toHaveLength(1)
      read.mockClear()
      listing.mockClear()
      await discoverCodexSnapshot(home, options, {
        resources,
        previous: initial!,
      })
      expect(read).not.toHaveBeenCalled()
      expect(listing).not.toHaveBeenCalled()
      await put(
        join(first, '.mcp.json.next'),
        declaration('https://fixture.invalid/edited'),
      )
      await fs.rename(join(first, '.mcp.json.next'), join(first, '.mcp.json'))
      read.mockClear()
      listing.mockClear()
      const edited = await discoverCodexSnapshot(home, options, { resources })
      expect(edited.mcp[0]!.url).toBe('https://fixture.invalid/edited')
      expect(read).toHaveBeenCalledTimes(1)
      expect(listing).not.toHaveBeenCalled()
      const next = join(base, '2.0.0')
      await put(join(next, '.codex-plugin/plugin.json'), {
        name: 'active',
        skills: './new-skills',
      })
      await put(
        join(next, '.mcp.json'),
        declaration('https://fixture.invalid/next'),
      )
      read.mockClear()
      listing.mockClear()
      const upgraded = await discoverCodexSnapshot(home, options, { resources })
      expect(upgraded.mcp[0]!.url).toBe('https://fixture.invalid/next')
      expect(
        upgraded.skillRoots.some(
          (root) => root.path === join(next, 'new-skills'),
        ),
      ).toBe(true)
      expect(listing).toHaveBeenCalledTimes(1)
      await put(
        join(home, 'config.toml.next'),
        '[plugins."active@sample"]\nenabled=false\n',
      )
      await fs.rename(join(home, 'config.toml.next'), join(home, 'config.toml'))
      const disabled = await discoverCodexSnapshot(home, options, {
        resources,
        previous: upgraded,
      })
      expect(disabled.mcp).toEqual([])
      expect(disabled.items).toContainEqual({
        name: 'active@sample',
        kind: 'plugin',
        state: 'disabled',
      })
      expect(initial!.config.plugins['active@sample'].enabled).toBe(true)
    } finally {
      resources.dispose()
    }
  })

  it('resolves current environment values even when source files are unchanged', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'dsh-codex-resources-'))
    directories.push(home)
    await put(
      join(home, 'config.toml'),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid/mcp"\nbearer_token_env_var="CODEX_FIXTURE_TOKEN"\n',
    )
    const resources = new CodexResourceCache()
    try {
      vi.stubEnv('CODEX_FIXTURE_TOKEN', 'first-fixture-token')
      const first = await discoverCodexSnapshot(home, options, { resources })
      vi.stubEnv('CODEX_FIXTURE_TOKEN', 'rotated-fixture-token')
      const next = await discoverCodexSnapshot(home, options, {
        resources,
        previous: first,
      })
      expect(first.mcp[0]!.headers!.Authorization).toBe(
        'Bearer first-fixture-token',
      )
      expect(next.mcp[0]!.headers!.Authorization).toBe(
        'Bearer rotated-fixture-token',
      )
    } finally {
      resources.dispose()
    }
  })
})
