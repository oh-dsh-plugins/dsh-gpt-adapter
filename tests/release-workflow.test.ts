import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-workflow-'))
  directories.push(root)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const git = (args: string[], cwd = work) =>
    execFileSync('git', args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
  git(['init', '--bare', origin], root)
  git(['init', work], root)
  git(['config', 'user.name', 'Release fixture'])
  git(['config', 'user.email', 'release-fixture@example.invalid'])
  git(['config', 'core.hooksPath', '/dev/null'])
  git(['remote', 'add', 'origin', origin])
  const commit = () => git(['commit', '--allow-empty', '-m', 'Fixture'])
  commit()
  const workflow = YAML.parse(
    await readFile('.github/workflows/release.yml', 'utf8'),
  )
  const step = workflow.jobs.release.steps.find(
    (step: any) => step.name === 'Create the version tag',
  )
  const run = () =>
    spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd: work,
      env: { ...environment, VERSION: '0.0.0-fixture' },
      encoding: 'utf8',
    })
  const tag = 'v0.0.0-fixture'
  const publishTag = () => {
    git(['tag', '-a', tag, '-m', 'Fixture tag'])
    git(['push', 'origin', `refs/tags/${tag}`])
  }
  return { git, origin, commit, run, tag, publishTag }
}

describe('release tag commit identity', () => {
  it('rejects an existing tag on a different commit without moving it', async () => {
    const f = await fixture()
    f.publishTag()
    const tagged = f.git(['rev-parse', `${f.tag}^{commit}`])
    f.commit()
    const head = f.git(['rev-parse', 'HEAD'])
    const result = f.run()
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('another commit')
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(f.git(['rev-parse', `${f.tag}^{commit}`])).toBe(tagged)
    expect(f.git(['rev-parse', `${f.tag}^{commit}`], f.origin)).toBe(tagged)
  })

  it('allows retrying a tag on the same commit', async () => {
    const f = await fixture()
    f.publishTag()
    expect(f.run().status).toBe(0)
    expect(f.git(['rev-parse', `${f.tag}^{commit}`])).toBe(
      f.git(['rev-parse', 'HEAD']),
    )
  })

  it('creates a missing tag at the current commit in the isolated origin', async () => {
    const f = await fixture()
    expect(f.run().status).toBe(0)
    const head = f.git(['rev-parse', 'HEAD'])
    expect(f.git(['rev-parse', `${f.tag}^{commit}`])).toBe(head)
    expect(f.git(['rev-parse', `${f.tag}^{commit}`], f.origin)).toBe(head)
  })
})
