import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { supportedDshVersions } from './compat.mjs'

const [version, archivePath] = process.argv.slice(2)
if (!supportedDshVersions.includes(version) || !archivePath)
  throw new Error(
    'Usage: node scripts/test-host-compat.mjs <DSH version> <archive>',
  )
const archive = await realpath(archivePath)
const fixture = await mkdtemp(join(tmpdir(), 'dsh-gpt-host-'))
const env = {
  PATH: process.env.PATH,
  USER: process.env.USER,
  DSH_HOME: join(fixture, 'profile'),
  DSH_AGENTS_HOME: join(fixture, 'agents'),
  npm_config_cache: process.env.npm_config_cache ?? join(fixture, 'npm-cache'),
}
const run = (command, args, cwd = fixture) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    timeout: 300000,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.signal ?? result.status}`)
}
async function verifyModels(url) {
  const browser = await chromium.launch({
    executablePath: process.env.DSH_COMPAT_CHROMIUM,
  })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    page.setDefaultTimeout(12000)
    const response = await page.goto(url.href)
    assert.ok(
      response?.ok(),
      `Browser navigation returned ${response?.status()}`,
    )
    const preview = page.getByRole('dialog', { name: 'Preview Notice' })
    const welcome = page.getByRole('dialog', { name: 'Get started' })
    const account = page.getByRole('button', { name: 'Account menu' })
    // A fresh profile displays the two onboarding steps in order. The
    // launcher can render before the preview acknowledgement finishes loading.
    await preview.getByRole('button', { name: 'Continue' }).click()
    await welcome.getByRole('button', { name: 'Close' }).click()
    await welcome.waitFor({ state: 'hidden' })
    await account.press('Enter')
    const settingsItem = page.getByRole('menuitem', {
      name: 'Settings',
      exact: true,
    })
    try {
      await settingsItem.click()
    } catch (error) {
      const state = await page.evaluate(() => ({
        accountExpanded: document
          .querySelector('button[aria-label="Account menu"]')
          ?.getAttribute('aria-expanded'),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
          (node) =>
            node.getAttribute('aria-label') ??
            node.querySelector('h2')?.textContent,
        ),
        menus: [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
          node.textContent?.trim(),
        ),
      }))
      throw new Error(
        `${error.message}\nBrowser shell: ${JSON.stringify(state)}`,
      )
    }
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('button', { name: 'Add model provider' }).click()
    const picker = settings.getByRole('combobox', {
      name: 'Provider',
      exact: true,
    })
    await picker.selectOption('openai')
    let panel = picker.locator(
      'xpath=ancestor::*[contains(@class, "_addPanel")][1]',
    )
    const openCustomized = async () => {
      const summary = panel
        .locator('summary')
        .getByText('Customized settings', { exact: true })
      if (
        await panel
          .locator('details:not([open]) > summary')
          .filter({ hasText: 'Customized settings' })
          .count()
      )
        await summary.click()
    }
    await openCustomized()
    const preset = () =>
      panel.getByRole('combobox', { name: 'Context window 1' })
    const expand = async () => {
      const advanced = panel.getByRole('button', { name: 'Model options 1' })
      if ((await advanced.getAttribute('aria-expanded')) !== 'true')
        await advanced.click()
      await preset().waitFor({ state: 'visible' })
    }
    await panel.getByRole('button', { name: 'Add model', exact: true }).click()
    await panel.getByRole('textbox', { name: 'Model ID 1' }).fill('gpt-5.4')
    await panel
      .getByRole('textbox', { name: 'Display name 1' })
      .fill('GPT compatibility fixture')
    const testReasoning = version === '0.2.3-alpha.2'
    if (testReasoning) {
      await panel
        .getByRole('button', { name: 'Add model', exact: true })
        .click()
      await panel.getByRole('textbox', { name: 'Model ID 2' }).fill('gpt-5.5')
      await panel
        .getByRole('textbox', { name: 'Display name 2' })
        .fill('GPT reasoning fixture B')
      await panel
        .getByLabel('Base URL', { exact: true })
        .fill('http://127.0.0.1:1/v1')
      await panel
        .getByLabel('API key', { exact: true })
        .fill('fixture-only-not-a-real-credential')
    }
    await expand()
    assert.deepEqual(await preset().locator('option').allTextContents(), [
      'Default',
      '516K',
      '1M',
      'Custom',
    ])
    if (
      ['0.2.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.1', '0.2.3-alpha.2'].includes(
        version,
      )
    ) {
      await preset().selectOption('516k')
      await panel.getByRole('button', { name: 'Apply', exact: true }).click()
      await page
        .getByRole('status')
        .getByText(/^Saved openai\.$/i)
        .waitFor()
      const edit = settings.getByRole('button', { name: /^Edit openai$/i })
      await edit.click()
      panel = edit.locator('xpath=ancestor::li[1]')
      await openCustomized()
      await expand()
      assert.equal(await preset().inputValue(), '516k')
      if (testReasoning) {
        await page.keyboard.press('Escape')
        await settings.waitFor({ state: 'hidden' })
        const trigger = page.getByRole('button', {
          name: /^Select model(?:,|$)/,
        })
        if (!(await trigger.count()))
          await page
            .getByRole('button', { name: /^New (session|chat)/i })
            .first()
            .click()
        const choose = async (label) => {
          await trigger.click()
          const models = page.getByRole('menuitem', { name: /^Model(?:\s|$)/ })
          if (await models.count()) await models.click()
          await page.getByRole('menuitemradio', { name: label }).click()
        }
        const effort = async (label) => {
          await trigger.click()
          await page.getByRole('menuitem', { name: /^Effort(?:\s|$)/ }).click()
          await page.getByRole('menuitemradio', { name: label }).click()
        }
        await choose(/GPT compatibility fixture/)
        if (
          !(await trigger.getAttribute('aria-label'))?.includes(
            'GPT compatibility fixture',
          )
        )
          await page
            .getByRole('button', {
              name: /Select model, current GPT compatibility fixture/,
            })
            .waitFor()
        await effort(/^ultra(?:\s|$)/i)
        await page
          .getByRole('button', { name: /GPT compatibility fixture.*ultra/i })
          .waitFor()
        await choose(/GPT reasoning fixture B/)
        await page
          .getByRole('button', { name: /GPT reasoning fixture B.*ultra/i })
          .waitFor()
        await effort(/^low(?:\s|$)/i)
        await page
          .getByRole('button', { name: /GPT reasoning fixture B.*low/i })
          .waitFor()
        await choose(/GPT compatibility fixture/)
        await page
          .getByRole('button', { name: /GPT compatibility fixture.*low/i })
          .waitFor()
        return '516K persisted and latest effort followed both model switches'
      }
      return 'presets visible, saved and reopened at 516K'
    }
    return 'presets visible'
  } finally {
    await browser.close()
  }
}
let host
let exited
let output = ''
try {
  const hostRoot = version === '0.2.3-alpha.1' ? join(fixture, 'host') : fixture
  if (version === '0.2.3-alpha.1') {
    await mkdir(hostRoot)
    for (const name of [
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ])
      await cp(
        new URL(`./alpha1-host/${name}`, import.meta.url),
        join(hostRoot, name),
      )
    run(
      'pnpm',
      [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org/',
        '--prefer-offline',
        '--store-dir',
        join(fixture, 'store'),
      ],
      hostRoot,
    )
  } else {
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--prefer-offline',
      '--registry=https://registry.npmjs.org/',
      `@deepseek-ai/dsh@${version}`,
    ])
  }
  const dsh = join(hostRoot, 'node_modules', '.bin', 'dsh')
  run(dsh, ['--version'])
  run(dsh, [
    'plugin',
    '--profile',
    'web',
    'add',
    archive,
    '--store-dir',
    join(fixture, 'store'),
  ])
  const codexHome = join(fixture, 'codex')
  const patch = join(fixture, 'codex.patch.json')
  await mkdir(codexHome)
  await writeFile(
    patch,
    JSON.stringify([
      {
        id: 'gpt-adapter',
        config: {
          routes: {},
          codexCompatibility: { enabled: true, codexHome },
        },
      },
    ]),
  )
  host = spawn(
    dsh,
    [
      '--profile',
      'web',
      '--patch',
      patch,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  exited = once(host, 'exit')
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('DSH web did not announce a URL')),
      45000,
    )
    const capture = (chunk) => {
      output = (output + chunk).slice(-16000)
      const found = output.match(/dsh web:.*?(http:\/\/[^\s]+)/)
      if (found) {
        clearTimeout(timer)
        resolve(new URL(found[1]))
      }
    }
    host.stdout.on('data', capture)
    host.stderr.on('data', capture)
    host.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`DSH web exited with ${code}`))
    })
    host.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  if (url.hostname !== '127.0.0.1')
    throw new Error('Expected a loopback DSH listener')
  const login = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (login.status !== 303 || !cookie)
    throw new Error(`DSH browser login returned ${login.status}`)
  const page = await fetch(url.origin, {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  })
  if (!page.ok || !(await page.text()).includes('dsh-gpt-adapter'))
    throw new Error('DSH did not include the plugin in the web boot graph')
  const method = 'gptModels/codexStatus'
  const rpcId = randomUUID()
  const rpc = await fetch(new URL(`/api/${method}`, url), {
    method: 'POST',
    headers: { cookie, origin: url.origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: { args: {} },
    }),
    signal: AbortSignal.timeout(10000),
  })
  const response = rpc.ok ? await rpc.json() : undefined
  if (
    response?.rpcId !== rpcId ||
    response.result?.ok !== true ||
    response.result.value?.enabled !== true
  )
    throw new Error(`Installed plugin was not active (RPC HTTP ${rpc.status})`)
  const browserResult = await verifyModels(url)
  console.log(
    `DSH ${version}: installed candidate, verified plugin RPC, ${browserResult}`,
  )
} catch (error) {
  if (output) console.error(output.replace(/https?:\/\/[^\s]+/g, '<url>'))
  throw new Error(String(error.message).replace(/https?:\/\/[^\s]+/g, '<url>'))
} finally {
  if (host && host.exitCode === null && host.signalCode === null)
    host.kill('SIGKILL')
  if (exited) await exited
  await rm(fixture, { recursive: true, force: true })
}
