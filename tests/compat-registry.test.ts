import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'

const { compatibilityTargets, compatibilityManifest, supportedDshVersions } =
  await import(pathToFileURL(resolve('scripts/compat.mjs')).href)

describe('verified DSH version registry', () => {
  it('adds declarations and source aliases for a newly verified version', () => {
    const manifest = {
      engines: { node: '>=24.9.0', dsh: 'old' },
      devDependencies: {
        '@deepseek-ai/dsh-llm': 'old',
        '@deepseek-ai/cordis': '4.1.0',
        'dsh-old-pi-ai': 'obsolete',
      },
      peerDependencies: {
        '@deepseek-ai/dsh-llm': 'old',
        '@deepseek-ai/cordis': '4.1.0',
      },
    }
    const future = {
      version: '0.2.2-rc.6',
      adapter: 'dsh-rc6-pi-ai',
      menu: 'dsh-rc6-model-selection',
      settings: 'dsh-rc6-model-settings',
    }
    const next = compatibilityManifest(manifest, [
      ...compatibilityTargets,
      future,
    ])
    const range = [...supportedDshVersions, future.version].join(' || ')
    expect(next.engines).toEqual({ node: '>=24.9.0', dsh: range })
    expect(next.peerDependencies).toEqual({
      '@deepseek-ai/dsh-llm': range,
      '@deepseek-ai/cordis': '4.1.0',
    })
    expect(next.devDependencies).toMatchObject({
      '@deepseek-ai/dsh-llm': supportedDshVersions[0],
      '@deepseek-ai/cordis': '4.1.0',
      'dsh-rc6-pi-ai': 'npm:@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.6',
      'dsh-rc6-model-selection':
        'npm:@deepseek-ai/dsh-client-ui-model-selection@0.2.2-rc.6',
      'dsh-rc6-model-settings':
        'npm:@deepseek-ai/dsh-client-ui-settings-models@0.2.2-rc.6',
    })
    expect(next.devDependencies).not.toHaveProperty('dsh-old-pi-ai')
    expect(manifest.engines.dsh).toBe('old')
  })

  it('feeds every non-baseline runtime to the CI matrix without a separate list', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/compat-matrix.mjs'],
      {
        encoding: 'utf8',
      },
    ).trim()
    expect(JSON.parse(output.slice('dsh='.length))).toEqual(
      supportedDshVersions.slice(1),
    )
    const workflow = YAML.parse(
      readFileSync('.github/workflows/ci.yml', 'utf8'),
    )
    expect(workflow.jobs.compatibility.needs).toBe('versions')
    expect(workflow.jobs.compatibility.strategy.matrix.dsh).toBe(
      '${{ fromJSON(needs.versions.outputs.dsh) }}',
    )
    expect(workflow.jobs.versions.outputs.dsh).toBe(
      '${{ steps.matrix.outputs.dsh }}',
    )
  })
})
