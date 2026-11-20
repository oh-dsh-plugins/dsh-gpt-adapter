import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { parse, stringify } from 'yaml'
import { compatibilityManifest, supportedDshVersions } from './compat.mjs'

const check = process.argv.includes('--check')
const root = new URL('../', import.meta.url)
const manifestPath = new URL('package.json', root)
const manifest = compatibilityManifest(
  JSON.parse(await readFile(manifestPath, 'utf8')),
)
const policy = parse(
  await readFile(new URL('pnpm-workspace.yaml', root), 'utf8'),
)
const buildPackages = [
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-util-values',
]
policy.minimumReleaseAgeExclude = [
  ...(policy.minimumReleaseAgeExclude ?? []).filter(
    (entry) => !buildPackages.some((name) => entry.startsWith(name + '@')),
  ),
  ...supportedDshVersions
    .slice(1)
    .flatMap((version) => buildPackages.map((name) => name + '@' + version)),
]
const derived = [
  ['package.json', JSON.stringify(manifest)],
  [
    'pnpm-workspace.yaml',
    '# Build inputs derived by pnpm compat:sync.\n' + stringify(policy),
  ],
]
const stale = []
for (const [name, source] of derived) {
  const path = new URL(name, root)
  const next = await format(source, {
    ...(await resolveConfig(path)),
    filepath: fileURLToPath(path),
  })
  const current = await readFile(path, 'utf8')
  // Ignore formatting/key order: the format gate owns those concerns.
  const parseSource = name.endsWith('.json') ? JSON.parse : parse
  if (isDeepStrictEqual(parseSource(current), parseSource(next))) continue
  if (check) stale.push(name)
  else await writeFile(path, next)
}
if (stale.length)
  throw new Error(
    'Compatibility declarations are stale: ' +
      stale.join(', ') +
      '; run pnpm compat:sync and pnpm install --no-frozen-lockfile',
  )
