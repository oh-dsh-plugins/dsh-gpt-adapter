import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Build-time aliases keep the shipped bundle independent of dev dependencies.
export const compatibilityTargets = [
  {
    version: '0.2.2-rc.1',
    adapter: '@deepseek-ai/dsh-llm-pi-ai',
    menu: '@deepseek-ai/dsh-client-ui-model-selection',
    settings: '@deepseek-ai/dsh-client-ui-settings-models',
  },
  {
    version: '0.2.2-rc.2',
    adapter: 'dsh-rc2-pi-ai',
    menu: 'dsh-rc2-model-selection',
    settings: 'dsh-rc2-model-settings',
  },
  {
    version: '0.2.2-rc.3',
    adapter: 'dsh-rc3-pi-ai',
    menu: 'dsh-rc3-model-selection',
    settings: 'dsh-rc3-model-settings',
  },
]

export const supportedDshVersions = compatibilityTargets.map(
  ({ version }) => version,
)

export function menuSource(
  packageName = '@deepseek-ai/dsh-client-ui-model-selection',
) {
  const require = createRequire(import.meta.url)
  const pkg = require(packageName + '/package.json')
  if (!supportedDshVersions.includes(pkg.version))
    throw new Error(`Unsupported model menu ${pkg.version}`)
  return {
    version: pkg.version,
    source: readFileSync(require.resolve(packageName + '/client'), 'utf8'),
  }
}

export function compatibilitySource(
  packageName = '@deepseek-ai/dsh-llm-pi-ai',
) {
  const require = createRequire(import.meta.url)
  const pkg = require(packageName + '/package.json')
  if (!supportedDshVersions.includes(pkg.version))
    throw new Error(
      `Unsupported DSH adapter ${pkg.version}; expected ${supportedDshVersions.join(', ')}`,
    )
  return {
    version: pkg.version,
    source: readFileSync(require.resolve(packageName), 'utf8'),
  }
}
