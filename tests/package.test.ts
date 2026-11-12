import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import YAML from 'yaml'

describe('plugin packaging and compatible composition', () => {
  it('preserves the named speed RPC arguments consumed by the source-mode gateway', async () => {
    // The gateway reflects bundled parameter names; esbuild must not rename
    // the public `tier` argument to avoid a colliding module-level helper.
    const host = await readFile('lib/index.js', 'utf8')
    const parameters = host
      .match(/async setSpeed\(([^)]*)\)/)![1]!
      .split(',')
      .map((name) => name.trim())
    expect(parameters).toEqual(['sessionId', 'provider', 'modelId', 'tier'])
    expect(
      host
        .match(/async setContextWindow\(([^)]*)\)/)![1]!
        .split(',')
        .map((name) => name.trim()),
    ).toEqual([
      'provider',
      'modelId',
      'mode',
      'customTokens',
      'expectedRevision',
    ])
  })
  it('exports every built entry and an additive valid bundle', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(manifest.dsh.client.platform).toBe('web')
    for (const entry of Object.values(manifest.exports) as Array<
      string | { default: string }
    >) {
      expect(
        existsSync(typeof entry === 'string' ? entry : entry.default),
      ).toBe(true)
    }
    const patches = YAML.parse(await readFile('cordis.patch.yml', 'utf8'))
    expect(patches).toHaveLength(1)
    expect(patches[0].insert[0].name).toBe(manifest.name)
  })
})
