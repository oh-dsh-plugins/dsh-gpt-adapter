import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  compatibilityTargets,
  sourceAliases,
  supportedDshVersions,
} from './compat.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const versions = process.argv.slice(2)
const archive =
  versions[0] === '--archive'
    ? await realpath(versions.splice(0, 2)[1])
    : undefined
if (!versions.length) versions.push(...supportedDshVersions.slice(1))
for (const version of versions)
  if (!supportedDshVersions.includes(version))
    throw new Error('Unsupported compatibility test runtime: ' + version)

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed: ${signal ?? code}`)),
    )
  })

await mkdir(join(root, '.generated'), { recursive: true })
for (const version of versions) {
  const fixture = await mkdtemp(join(root, '.generated', 'compat-'))
  try {
    console.log(`Testing the existing build with DSH ${version}`)
    const target = compatibilityTargets.find(
      (target) => target.version === version,
    )
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...target.peers,
    }
    for (const name of sourceAliases) delete dependencies[name]
    for (const name of Object.keys(dependencies))
      if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = version
    if (archive)
      await run('tar', ['-xzf', archive, '--strip-components=1'], fixture)
    const builtManifest = archive
      ? JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'))
      : manifest
    if (builtManifest.engines.dsh !== manifest.engines.dsh)
      throw new Error('The archive and source declare different DSH targets')
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({
        ...builtManifest,
        private: true,
        devDependencies: {},
        dependencies,
      }),
    )
    for (const name of [
      'src',
      'scripts',
      'tests',
      'lib',
      'dist',
      '.github',
      'tsconfig.json',
      'vitest.config.ts',
      'cordis.patch.yml',
    ]) {
      if (archive && (name === 'lib' || name === 'dist')) continue
      await cp(join(root, name), join(fixture, name), { recursive: true })
    }
    if (version === '0.2.3-alpha.1') {
      await cp(
        join(root, 'scripts', 'alpha1-host', 'pnpm-workspace.yaml'),
        join(fixture, 'pnpm-workspace.yaml'),
      )
      await run(
        'pnpm',
        [
          'install',
          '--ignore-scripts',
          '--registry=https://registry.npmjs.org/',
        ],
        fixture,
      )
    } else {
      await run(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--registry=https://registry.npmjs.org/',
        ],
        fixture,
      )
    }
    // Source-only fixtures must not introduce another runtime's peer graph.
    for (const name of sourceAliases)
      await symlink(
        join(root, 'node_modules', name),
        join(fixture, 'node_modules', name),
        'junction',
      )
    await run(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--noEmit'],
      fixture,
    )
    await run(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run'],
      fixture,
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}
