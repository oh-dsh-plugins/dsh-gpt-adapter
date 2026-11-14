import { build } from 'esbuild'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  compatibilitySource,
  compatibilityTargets,
  menuSource,
} from './compat.mjs'
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
const runtimes = compatibilityTargets.map((target) => {
  const adapter = compatibilitySource(target.adapter)
  const menu = menuSource(target.menu)
  const settings = nativeContextSettingsSource(target.settings)
  if (
    [adapter.version, menu.version, settings.version].some(
      (version) => version !== target.version,
    )
  )
    throw new Error(
      'Mismatched native build dependencies for ' + target.version,
    )
  return { adapter, menu, settings }
})
const settingsStyles = runtimes[0].settings.settingsStyles
const nativeContextSettings = []
for (const { settings } of runtimes) {
  if (
    JSON.stringify(settings.settingsStyles) !== JSON.stringify(settingsStyles)
  )
    throw new Error('Unsupported native Models styles for ' + settings.version)
  const existing = nativeContextSettings.find(
    (candidate) =>
      candidate.expectedModelsSectionSource ===
      settings.expectedModelsSectionSource,
  )
  if (existing && existing.body !== settings.body)
    throw new Error('Ambiguous native Models renderer for ' + settings.version)
  if (!existing) nativeContextSettings.push(settings)
}
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
            function nativeRequire(name) {
              const modules = {'react': React, 'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-ui-primitives': Primitives, '@deepseek-ai/dsh-client-store': Store};
              if (!(name in modules)) throw new Error('Unsupported native Models dependency: ' + name);
              return modules[name];
            }
            export const nativeModelsRuntimes = [${nativeContextSettings
              .map(
                (settings) => `(() => {
              let component;
              return {
                expectedModelsSectionSource: ${JSON.stringify(settings.expectedModelsSectionSource)},
                getComponent() {
                  if (!component) component = ((require) => { ${settings.body} })(nativeRequire).ModelsSection;
                  return component;
                },
              };
            })()`,
              )
              .join(',')}];
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
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
await writeFile(
  'lib/compatibility.json',
  JSON.stringify(
    {
      runtimes: runtimes.map(({ adapter, menu, settings }) => ({
        adapterVersion: adapter.version,
        sourceSha256: sha256(adapter.source),
        menuVersion: menu.version,
        settingsSha256: sha256(settings.source),
        menuSha256: sha256(menu.source),
      })),
    },
    null,
    2,
  ),
)
