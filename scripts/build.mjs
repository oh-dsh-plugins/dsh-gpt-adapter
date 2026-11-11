import { build } from 'esbuild'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { compatibilitySource, menuSource } from './compat.mjs'

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })
await build({
  entryPoints: ['src/host.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
})
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/core.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
})
const menu = menuSource()
const require = createRequire(import.meta.url)
const settings = await readFile(
  require.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'),
  'utf8',
)
const styleNames = [
  'customized',
  'customizedSummary',
  'customizedBody',
  'rowHead',
  'rowName',
  'rowActions',
  'advancedHint',
  'field',
  'fieldLabel',
  'input',
  'editorActions',
  'error',
]
const settingsStyles = Object.fromEntries(
  styleNames.map((key) => {
    const match = settings.match(new RegExp('"' + key + '": "([^"]+)"'))
    if (!match) throw new Error('Unsupported native Models styles: ' + key)
    return [key, match[1]]
  }),
)
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  plugins: [
    {
      name: 'native-settings-styles',
      setup(build) {
        build.onResolve(
          { filter: /^dsh-gpt-adapter\/native-settings-styles$/ },
          () => ({
            path: 'native-settings-styles',
            namespace: 'gpt-native',
          }),
        )
        build.onLoad({ filter: /.*/, namespace: 'gpt-native' }, () => ({
          contents: 'export default ' + JSON.stringify(settingsStyles),
          loader: 'js',
        }))
      },
    },
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({id: "dsh-gpt-adapter", factory: (require) => { var module = {exports: {}}; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; }});' },
})
const { source, version } = compatibilitySource()
await writeFile(
  'lib/compatibility.json',
  JSON.stringify(
    {
      adapterVersion: version,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      menuVersion: menu.version,
      settingsSha256: createHash('sha256').update(settings).digest('hex'),
      menuSha256: createHash('sha256').update(menu.source).digest('hex'),
    },
    null,
    2,
  ),
)
