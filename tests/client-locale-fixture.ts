import React, { useSyncExternalStore } from 'react'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { NS } from '../src/client/locales.js'

const require = createRequire(import.meta.url)

/** Load the real browser locale service without booting an unrelated settings app. */
export function nativeLocale(modules: (name: string) => any): LocaleRuntime {
  let runtime: any
  new Function(
    'window',
    readFileSync(
      require.resolve('@deepseek-ai/dsh-client-locale/client'),
      'utf8',
    ),
  )({
    __ModuleLoader__: {
      load(entry: any) {
        runtime = entry.factory(modules)
      },
    },
  })
  const locale = new runtime.LocaleRuntime({ emit() {} })
  locale.setLocale('zh')
  return locale
}

/** Supply the native locale seat to legacy tests that intentionally stub slot mounting. */
export function localeContext(
  ctx: any,
  modules: (name: string) => any,
  cleanup: Array<() => void>,
) {
  if (ctx.locale) return ctx
  const locale = nativeLocale(modules)
  return {
    ...ctx,
    locale,
    effect:
      ctx.effect?.bind(ctx) ??
      ((action: () => () => void) => {
        const dispose = action()
        cleanup.push(dispose)
        return dispose
      }),
    slots: {
      ...ctx.slots,
      register(entry: any, Component: React.ComponentType<any>) {
        return ctx.slots.register(entry, function Localized(props: any) {
          useSyncExternalStore(
            (fn) => locale.subscribe(fn),
            () => locale.getSnapshot(),
          )
          return React.createElement(Component, {
            ...props,
            t: locale.bind(NS),
          })
        })
      },
    },
  }
}
