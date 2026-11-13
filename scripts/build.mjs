import { build } from 'esbuild'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { compatibilitySource, menuSource } from './compat.mjs'
import { nativeContextSettingsSource } from './native-context-settings.mjs'
import { fileURLToPath } from 'node:url'

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
const nativeContextSettings = nativeContextSettingsSource()
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
    '@deepseek-ai/dsh-client-store',
  ],
  plugins: [
    {
      name: 'native-context-settings',
      setup(build) {
        build.onResolve(
          { filter: new RegExp('^dsh-gpt-adapter/native-context-settings$') },
          () => ({
            path: 'native-context-settings',
            namespace: 'gpt-context',
          }),
        )
        build.onLoad({ filter: /.*/, namespace: 'gpt-context' }, () => ({
          contents: `
            import * as React from 'react';
            import * as JSX from 'react/jsx-runtime';
            import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
            import * as Store from '@deepseek-ai/dsh-client-store';
            import { ContextWindowPreset } from ${JSON.stringify(fileURLToPath(new URL('../src/client/context-window-preset.tsx', import.meta.url)))};
            import { isGptModel } from ${JSON.stringify(fileURLToPath(new URL('../src/capabilities.ts', import.meta.url)))};
            import { validContextWindow } from ${JSON.stringify(fileURLToPath(new URL('../src/context-window.ts', import.meta.url)))};
            const native = ((require) => { ${nativeContextSettings.body} })((name) => {
              const modules = {'react': React, 'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-ui-primitives': Primitives, '@deepseek-ai/dsh-client-store': Store};
              if (!(name in modules)) throw new Error('Unsupported native Models dependency: ' + name);
              return modules[name];
            });
            export const NativeModelsSection = native.ModelsSection;
            export const expectedModelsSectionSource = ${JSON.stringify(nativeContextSettings.expectedModelsSectionSource)};
          `,
          loader: 'js',
          resolveDir: fileURLToPath(new URL('../', import.meta.url)),
        }))
      },
    },
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
