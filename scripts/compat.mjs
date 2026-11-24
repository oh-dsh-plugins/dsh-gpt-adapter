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
  {
    version: '0.2.2-rc.4',
    adapter: 'dsh-rc4-pi-ai',
    menu: 'dsh-rc4-model-selection',
    settings: 'dsh-rc4-model-settings',
  },
  {
    version: '0.2.2-rc.5',
    adapter: 'dsh-rc5-pi-ai',
    menu: 'dsh-rc5-model-selection',
    settings: 'dsh-rc5-model-settings',
  },
  {
    version: '0.2.3-alpha.1',
    adapter: 'dsh-alpha1-pi-ai',
    menu: 'dsh-alpha1-model-selection',
    settings: 'dsh-alpha1-model-settings',
    peers: {
      '@deepseek-ai/cordis': '4.2.0-alpha.1',
      '@deepseek-ai/schemastery': '3.20.0-alpha.1',
    },
  },
  {
    version: '0.2.3-alpha.2',
    adapter: 'dsh-alpha2-pi-ai',
    menu: 'dsh-alpha2-model-selection',
    settings: 'dsh-alpha2-model-settings',
    node: '24.22.3',
    nodeRange: '^24.22.3 || >=26.13.1',
    peers: {
      '@deepseek-ai/cordis': '4.2.0-alpha.1',
      '@deepseek-ai/schemastery': '3.20.0-alpha.1',
    },
  },
].map((target) => ({
  node: '24.22.3',
  nodeRange: '>=24.9.0',
  peers: {
    '@deepseek-ai/cordis': '4.1.0',
    '@deepseek-ai/schemastery': '3.19.0',
  },
  ...target,
}))

export const supportedDshVersions = compatibilityTargets.map(
  ({ version }) => version,
)

export const supportedDshRange = supportedDshVersions.join(' || ')

export const nativePackages = {
  adapter: '@deepseek-ai/dsh-llm-pi-ai',
  menu: '@deepseek-ai/dsh-client-ui-model-selection',
  settings: '@deepseek-ai/dsh-client-ui-settings-models',
}
export const sourceAliases = compatibilityTargets.flatMap((target) =>
  Object.keys(nativePackages)
    .map((key) => target[key])
    .filter((name) => name.startsWith('dsh-')),
)

/** npm needs literal ranges; derive those declarations from the verified targets. */
export function compatibilityManifest(
  manifest,
  targets = compatibilityTargets,
) {
  const versions = targets.map(({ version }) => version)
  const range = versions.join(' || ')
  const devDependencies = Object.fromEntries(
    Object.entries(manifest.devDependencies).filter(
      ([name]) => !name.startsWith('dsh-'),
    ),
  )
  for (const name of Object.keys(devDependencies))
    if (name.startsWith('@deepseek-ai/dsh-'))
      devDependencies[name] = versions[0]
  for (const target of targets)
    for (const [key, name] of Object.entries(nativePackages))
      if (target[key] !== name)
        devDependencies[target[key]] = 'npm:' + name + '@' + target.version
  return {
    ...manifest,
    engines: { ...manifest.engines, dsh: range },
    devDependencies,
    peerDependencies: Object.fromEntries(
      Object.entries(manifest.peerDependencies).map(([name, value]) => [
        name,
        name.startsWith('@deepseek-ai/dsh-')
          ? range
          : [
              ...new Set(
                targets.map((target) => target.peers?.[name] ?? value),
              ),
            ].join(' || '),
      ]),
    ),
  }
}

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
