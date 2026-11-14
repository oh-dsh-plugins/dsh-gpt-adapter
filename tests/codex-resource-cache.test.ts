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
