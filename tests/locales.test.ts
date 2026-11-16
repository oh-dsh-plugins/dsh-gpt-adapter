// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { nativeLocale } from './client-locale-fixture.js'
import { NS, dictionaries, translateOwnedError } from '../src/client/locales.js'
import { Config } from '../src/host.js'
import z from '@deepseek-ai/schemastery'

const require = createRequire(import.meta.url)
const modules = (name: string) =>
  name === '@deepseek-ai/dsh-client-store' ||
  name === '@deepseek-ai/dsh-client-ui-primitives'
    ? {}
    : require(name)

describe('native bilingual integration', () => {
  it('translates the owned service-tier error while preserving the model identifier', () => {
    const locale = nativeLocale(modules)
    const release = locale.register(NS, dictionaries)
    const model = 'gpt-自定义/{request_id}'
    const message = `model ${model} declares no supported service tiers`
    const t = locale.bind(NS)
    try {
      expect(translateOwnedError(message, t)).toBe(
        `模型 ${model} 未声明支持的速度档位`,
      )
      locale.setLocale('en')
      expect(translateOwnedError(message, t)).toBe(
        `Model ${model} declares no supported service tiers`,
      )
      const upstream = `Gateway: ${message}`
      expect(translateOwnedError(upstream, t)).toBe(upstream)
    } finally {
      release()
    }
  })

  it('translates owned errors and preserves upstream text, identifiers, and placeholders', () => {
    const locale = nativeLocale(modules)
    const release = locale.register(NS, dictionaries)
    const t = locale.bind(NS)
    const upstream = 'Gateway Error: 模型 unavailable {request_id}'
    expect(translateOwnedError(upstream, t)).toBe(upstream)
    expect(
      translateOwnedError('model list request failed with HTTP 429', t),
    ).toContain('HTTP 429')
    locale.setLocale('en')
    expect(
      translateOwnedError('模型 gpt-自定义 的 serviceTiers 格式无效', t),
    ).toBe('Invalid serviceTiers format for model gpt-自定义')
    expect(translateOwnedError('上下文窗口必须是正的安全整数', t)).toBe(
      'Context window must be a positive safe integer',
    )
    expect(translateOwnedError(upstream, t)).toBe(upstream)
    expect(t('synced', { count: 1 })).toContain('Models synced: 1')
    locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    locale.setLocale('fr')
    expect(t('contextDefault')).toBe('Default')
    release()
    expect(t('contextDefault')).toBe('contextDefault')
  })

  it('provides native bilingual schema descriptions without changing config values', () => {
    const schema: any = new z(Config.toJSON() as any)
    expect(
      schema.dict.codexCompatibility.dict.importSkills.meta.description,
    ).toEqual({ en: 'Import skills', zh: '导入技能' })
    expect(
      schema.dict.routes.inner.dict.refreshIntervalMs.meta.description,
    ).toEqual({ en: 'Sync interval (milliseconds)', zh: '同步间隔（毫秒）' })
    const config = Config({ routes: {} })
    expect(config.codexCompatibility.enabled).toBe(true)
    expect(config.routes.get()).toEqual({})
  })
})
