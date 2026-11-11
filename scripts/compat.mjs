import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

export function menuSource() {
  const require = createRequire(import.meta.url)
  const pkg = require('@deepseek-ai/dsh-client-ui-model-selection/package.json')
  if (pkg.version !== '0.2.2-rc.1')
    throw new Error(`Unsupported model menu ${pkg.version}`)
  return {
    version: pkg.version,
    source: readFileSync(
      require.resolve('@deepseek-ai/dsh-client-ui-model-selection/client'),
      'utf8',
    ),
  }
}

export function compatibilitySource() {
  const require = createRequire(import.meta.url)
  const pkg = require('@deepseek-ai/dsh-llm-pi-ai/package.json')
  if (pkg.version !== '0.2.2-rc.1')
    throw new Error(
      `Unsupported DSH adapter ${pkg.version}; expected 0.2.2-rc.1`,
    )
  return {
    version: pkg.version,
    source: readFileSync(require.resolve('@deepseek-ai/dsh-llm-pi-ai'), 'utf8'),
  }
}
