export type ContextWindowMode = 'default' | '516k' | '1m' | 'custom'
export type ContextWindowSource =
  | 'legacy-override'
  | 'native-user'
  | 'provider-default'
  | 'upstream'
  | 'capability-catalog'
  | 'official-preset'
  | 'native-default'

export type ContextWindowResolution = {
  mode: ContextWindowMode
  effectiveTokens: number
  defaultTokens: number
  source: ContextWindowSource
}

// Exact model IDs verified against OpenAI model pages on 2026-11-13.
// Each key is also the model-page slug unless a documented snapshot is listed.
const officialModels: Array<[string, number, string?]> = [
  ['gpt-6-astra', 1050000],
  ['gpt-6.1-sol', 1050000],
  ['gpt-6.1-terra', 1050000],
  ['gpt-6-luna', 1050000],
  ['gpt-5.4', 1050000],
  ['gpt-4.1', 1047576],
  ['gpt-4o', 128000],
  ['gpt-5.4-2026-03-05', 1050000, 'gpt-5.4'],
  ['gpt-4.1-2025-04-14', 1047576, 'gpt-4.1'],
  ['gpt-4o-2024-08-06', 128000, 'gpt-4o'],
]
export const OFFICIAL_CONTEXT_WINDOWS: Record<
  string,
  {
    tokens: number
    url: string
    verifiedAt: string
  }
> = Object.fromEntries(
  officialModels.map(([id, tokens, page]) => [
    id,
    {
      tokens,
      url: `https://developers.openai.com/api/docs/models/${page ?? id}`,
      verifiedAt: '2026-11-13',
    },
  ]),
)

export function validContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function contextWindowMode(tokens: number): ContextWindowMode {
  return tokens === 516000 ? '516k' : tokens === 1000000 ? '1m' : 'custom'
}

export function contextWindowTokens(
  mode: ContextWindowMode,
  customTokens?: number,
): number | undefined {
  if (!['default', '516k', '1m', 'custom'].includes(mode))
    throw new Error('请选择有效的上下文预设')
  if (mode !== 'custom' && customTokens !== undefined)
    throw new Error('只有自定义预设接受窗口数值')
  if (mode === 'custom') {
    if (!validContextWindow(customTokens))
      throw new Error('上下文窗口必须是正的安全整数')
    return customTokens
  }
  return mode === '516k' ? 516000 : mode === '1m' ? 1000000 : undefined
}

export function resolveContextWindow(options: {
  modelId: string
  legacy?: unknown
  native?: unknown
  providerDefault?: unknown
  upstream?: unknown
  catalog?: unknown
  nativeDefault?: unknown
}): ContextWindowResolution {
  const fallback: [unknown, ContextWindowSource][] = [
    [options.providerDefault, 'provider-default'],
    [options.upstream, 'upstream'],
    [options.catalog, 'capability-catalog'],
    [
      Object.hasOwn(OFFICIAL_CONTEXT_WINDOWS, options.modelId)
        ? OFFICIAL_CONTEXT_WINDOWS[options.modelId]?.tokens
        : undefined,
      'official-preset',
    ],
    [options.nativeDefault, 'native-default'],
    [1000000, 'native-default'],
  ]
  const [defaultTokens, source] = fallback.find(([tokens]) =>
    validContextWindow(tokens),
  )! as [number, ContextWindowSource]
  for (const [tokens, manualSource] of [
    [options.legacy, 'legacy-override'],
    [options.native, 'native-user'],
  ] as const) {
    if (tokens === undefined) continue
    if (!validContextWindow(tokens))
      throw new Error('上下文窗口必须是正的安全整数')
    return {
      mode: contextWindowMode(tokens),
      effectiveTokens: tokens,
      defaultTokens,
      source: manualSource,
    }
  }
  return {
    mode: 'default',
    effectiveTokens: defaultTokens,
    defaultTokens,
    source,
  }
}
