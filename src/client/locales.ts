import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'gpt-adapter'

const copy = {
  title: ['GPT model adaptation', 'GPT 模型适配'],
  autoAdapt: ['Automatic GPT adaptation', 'GPT 自动适配'],
  syncSettings: ['Sync settings', '同步设置'],
  catalogUrl: ['Capability catalog URL', '能力目录 URL'],
  interval: ['Sync interval (seconds)', '同步间隔（秒）'],
  overrides: ['Model capability overrides (JSON)', '模型能力覆盖（JSON）'],
  saveSync: ['Save sync settings', '保存同步设置'],
  reloadSync: ['Reload saved settings', '重新载入已保存设置'],
  syncing: ['Syncing…', '正在同步…'],
  syncNow: ['Sync now', '立即同步'],
  waiting: ['Waiting to sync', '等待同步'],
  synced: [
    'Models synced: {count} · GPT presets manage reasoning levels; disable adaptation to restore native reasoning controls',
    '已同步 {count} 个模型 · GPT 六档预设已接管原生等级；停用自动适配可恢复原生等级编辑',
  ],
  removeStale: [
    'Remove models no longer listed upstream ({count})',
    '移除上游未列出的模型（{count}）',
  ],
  contextHint: [
    'Choose a context window preset under Custom settings → Model catalog. Choose Custom to enter a value, or Default for automatic resolution.',
    '在「自定义设置 → 模型目录」的上下文窗口中选择预设；选择“自定义”后可输入数值，选择“默认”恢复自动解析。',
  ],
  contextDefault: ['Default', '默认'],
  contextCustom: ['Custom', '自定义'],
  contextInput: ['Enter context window', '输入上下文窗口'],
  contextCustomLabel: ['{label} custom value', '{label} 自定义数值'],
  speedLabel: ['GPT speed: {label}', 'GPT 速度：{label}'],
  actualSpeed: ['Actual service tier: {tier}', '实际速度：{tier}'],
  requestSpeed: ['GPT request speed', 'GPT 请求速度'],
  invalidOverrideModel: [
    'Overrides for model {model} must be a JSON object',
    '模型 {model} 的覆盖需要是 JSON 对象',
  ],
  invalidOverrideField: [
    'Invalid {field} format for model {model}',
    '模型 {model} 的 {field} 格式无效',
  ],
  modelHttp: [
    'Model list request failed with HTTP {status}',
    '模型列表请求失败，HTTP {status}',
  ],
  catalogHttp: [
    'Capability catalog request failed with HTTP {status}',
    '能力目录请求失败，HTTP {status}',
  ],
  responseLimit: [
    'Model data exceeds the {bytes}-byte limit',
    '模型数据超过 {bytes} 字节限制',
  ],
  serviceTiersUnsupported: [
    'Model {model} declares no supported service tiers',
    '模型 {model} 未声明支持的速度档位',
  ],
} as const

// Only exact plugin-owned messages are translated; arbitrary upstream text is preserved.
const errors = {
  readTimeout: [
    'Timed out reading GPT settings; please retry',
    '读取 GPT 设置超时，请重试',
  ],
  readFailed: ['Unable to read GPT settings', '无法读取 GPT 设置'],
  actionFailed: ['Operation failed; please retry', '操作失败，请重试'],
  speedFailed: ['Unable to save speed', '设置速度失败'],
  contextPositive: [
    'Context window must be a positive safe integer',
    '上下文窗口必须是正的安全整数',
  ],
  contextBudget: [
    'Context window must exceed the maximum output and compaction reserve combined',
    '上下文窗口必须大于当前最大输出和压缩预留的总和',
  ],
  contextUnavailable: [
    'Context settings are temporarily unavailable',
    '上下文设置暂不可用',
  ],
  modelUnavailable: [
    'Model settings are temporarily unavailable',
    '模型设置暂不可用',
  ],
  modelChanged: [
    'The model has changed; refresh and try again',
    '模型已变更，请刷新后重试',
  ],
  contextPreset: ['Choose a valid context preset', '请选择有效的上下文预设'],
  contextCustomOnly: [
    'Only the Custom preset accepts a window value',
    '只有自定义预设接受窗口数值',
  ],
  contextEnable: [
    'Enable automatic adaptation for this GPT model first',
    '请先启用该 GPT 模型的自动适配',
  ],
  contextConcurrent: [
    'Another save changed the context window; rollback was skipped',
    '上下文已被其他保存修改，未执行恢复',
  ],
  contextRollback: [
    'Context save and rollback failed; refresh to check the current settings',
    '上下文保存未完成，恢复失败；请刷新查看当前设置',
  ],
  reasoningManaged: [
    'GPT reasoning levels are managed by the plugin. Refresh and retry, edit capability overrides, or disable adaptation to restore native editing.',
    'GPT 思考等级由插件预设管理；请刷新后重试，或在模型能力覆盖中修改，停用自动适配可恢复原生编辑。',
  ],
  overridesObject: [
    'Model overrides must be an object',
    '模型覆盖需要是 JSON 对象',
  ],
  overridesJson: [
    'Model overrides must be valid JSON',
    '模型覆盖需要是有效的 JSON',
  ],
  intervalInvalid: [
    'Sync interval must be between 1 second and 2147483647 milliseconds',
    '同步间隔必须在 1 秒到 2147483647 毫秒之间',
  ],
  urlInvalid: [
    'The catalog URL must be a valid HTTP or HTTPS URL',
    '能力目录地址需要使用 HTTP 或 HTTPS',
  ],
  configureProvider: [
    'Configure this provider in Settings → Models first',
    '请先在「设置 → 模型」中配置此提供商',
  ],
  disabled: ['GPT adaptation is disabled', 'GPT 自动适配已停用'],
  protocol: [
    'GPT adaptation requires an OpenAI protocol',
    'GPT 自动适配需要 OpenAI 协议',
  ],
  apiKey: [
    'Save an API key on the existing provider card first',
    '请先在提供商卡片上保存 API 密钥',
  ],
  credential: ['Provider API key is unavailable', '提供商的 API 密钥不可用'],
  baseUrl: ['Set the provider base URL', '请设置提供商的服务地址'],
  settingsUnavailable: [
    'GPT plugin settings unavailable',
    'GPT 插件设置不可用',
  ],
  enable: ['Enable GPT adaptation first', '请先启用 GPT 自动适配'],
  speedUnavailable: [
    'This speed is unavailable for the selected model',
    '所选模型不支持此速度',
  ],
  stopped: ['synchronizer stopped', '同步已停止'],
  refreshFailed: ['refresh failed', '同步失败'],
  refreshInterval: [
    'refresh interval must be between 1000 and 2147483647 ms',
    '同步间隔必须在 1000 到 2147483647 毫秒之间',
  ],
  configChanged: [
    'configuration changed during refresh; retry with the current provider settings',
    '同步期间配置已变更，请使用当前提供商设置重试',
  ],
  publicationChanged: [
    'configuration changed during publication',
    '保存模型列表时配置已变更，请重新同步',
  ],
  cleanupChanged: [
    'configuration changed during cleanup',
    '清理期间配置已变更，请重试',
  ],
  cleanupRefresh: [
    'configuration changed during cleanup; refresh first',
    '清理期间配置已变更，请先重新同步',
  ],
  modelListChanged: [
    'model list changed during cleanup',
    '清理期间模型列表已变更，请重试',
  ],
  noSnapshot: ['no model snapshot available', '尚无模型快照，请先同步'],
  modelResponse: [
    'upstream model response must contain a data array',
    '上游模型响应必须包含 data 数组',
  ],
  cacheMissing: [
    'upstream returned 304 without a matching cache',
    '上游返回 304，但没有匹配的缓存',
  ],
  catalogInvalid: [
    'invalid capability catalog: expected version and models',
    '能力目录无效，需要 version 和 models 字段',
  ],
  catalogModelInvalid: [
    'invalid capability catalog model',
    '能力目录中的模型声明无效',
  ],
  nativeMismatch: [
    'Native model settings differ from the verified version; context presets cannot be installed',
    '原生模型设置组件与已核验版本不一致，无法安装上下文预设',
  ],
} as const

const messages = { ...copy, ...errors }
export type LocaleKey = keyof typeof messages
export type Translator = TranslateNS<typeof NS>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'gpt-adapter': LocaleKey
  }
}

const dictionary = (index: 0 | 1) =>
  Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [key, values[index]]),
  ) as Record<LocaleKey, string>
export const dictionaries = { en: dictionary(0), zh: dictionary(1) }
const ownedErrors = new Map<string, LocaleKey>(
  Object.entries(errors).flatMap(([key, values]) =>
    values.map((value) => [value, key as LocaleKey] as const),
  ),
)

export function translateOwnedError(
  message: string | undefined,
  t: Translator,
): string {
  if (!message) return ''
  const key = ownedErrors.get(message)
  if (key) return t(key)
  let match = /^模型 (.+) 的覆盖需要是 JSON 对象$/s.exec(message)
  if (match) return t('invalidOverrideModel', { model: match[1] })
  match = /^模型 (.+) 的 (\w+) 格式无效$/s.exec(message)
  if (match)
    return t('invalidOverrideField', { model: match[1], field: match[2] })
  match = /^model list request failed with HTTP (\d{3})$/.exec(message)
  if (match) return t('modelHttp', { status: match[1] })
  match = /^capability catalog request failed with HTTP (\d{3})$/.exec(message)
  if (match) return t('catalogHttp', { status: match[1] })
  match = /^model (.+) declares no supported service tiers$/s.exec(message)
  if (match) return t('serviceTiersUnsupported', { model: match[1] })
  match = /^model list exceeds (\d+) bytes$/.exec(message)
  return match ? t('responseLimit', { bytes: match[1] }) : message
}
