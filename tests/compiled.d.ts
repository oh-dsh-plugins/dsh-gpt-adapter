declare module '*lib/index.js' {
  import type { Context } from '@deepseek-ai/cordis'
  export function apply(ctx: Context, config: unknown): Promise<void>
}
