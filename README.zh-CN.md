# DSH GPT Adapter

[![DSH 插件](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2563eb)](https://github.com/deepseek-ai/deepseek-harness)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[英文版](README.md) | 简体中文

面向 DeepSeek Harness（DSH）的第三方 GPT 模型与 Codex 环境兼容插件。
安装一个插件，即可直接读取原有 Codex 指令、技能、已启用插件资源及 MCP 服务器配置，无需移动或改写 Codex 文件。

## 功能

- 通过 `GET /models` 发现上游模型；失效模型保留到用户主动清理。
- 在原生模型设置页和对话菜单中提供 `low / medium / high / xhigh / max / ultra` 六档思考预设。
- 为每个模型提供「默认、516K、1M、自定义」四档上下文窗口，展示实际容量与来源。
- 提供独立的 Standard 和 Fast 速度选择。Fast 发送 `service_tier: "priority"`；Ultrafast 由上游明确声明或用户覆盖提供。
- 为 GPT Responses 函数工具补齐缺失的 `strict: false`，保留可选参数。
- 读取 Codex 指令，在下一模型步骤更新；内容不变时不重复注入。
- 挂载 Codex 本地技能和已启用插件技能，保持原始资源路径。
- 通过 DSH 官方 MCP 客户端挂载 Codex 已启用服务器，并自动对账连接变化。

思考和速度预设代表发往网关的请求，不保证所有上游都支持。用户覆盖、上游明确的能力元数据和外部能力目录优先于预设。

## 兼容性与安装

原生集成面向 DSH `0.2.2-rc.1`、Cordis `4.1.0`，并校验适配器源码指纹。开发依赖固定 Pi AI `1.3.0`。插件不会修改已安装的第三方包文件。插件版本为 `dsh-gpt-adapter@0.2.4`。

需要 Node.js `>=24.9.0` 和 DSH。源码构建另外需要 pnpm。

在 `web` 配置档（profile）中安装已发布的 npm 包：

```sh
dsh plugin --profile web add dsh-gpt-adapter@0.2.4
```

安装或升级后重启 DSH 宿主。在「设置 → 模型」中配置 GPT 连接；Codex 环境复用默认开启。插件扩展现有原生设置与对话控件。

如需从源码安装进行开发或验证：

```sh
git clone https://github.com/lxjmaster/dsh-gpt-adapter.git
cd dsh-gpt-adapter
pnpm install --frozen-lockfile
mkdir -p artifacts
pnpm pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/dsh-gpt-adapter-0.2.4.tgz
```

`pnpm pack` 会自动执行生产构建。

## 自动发布

`Release` 工作流会在推送到 `main` 或手动运行时执行。版本号为正式的 `X.Y.Z` 时，工作流会运行测试、创建 `vX.Y.Z` 标签、创建对应的 GitHub Release，并将包发布到 npm。预发布版本会跳过；已有标签或 npm 版本会安全复用。

维护者需要在仓库 Secrets 中提供 npm 访问令牌 `NPM_TOKEN`，工作流才能发布。

## 复用 Codex 环境

默认启用 Codex 兼容。目录优先级为插件的 `codexHome` 覆盖、`CODEX_HOME` 环境变量、`~/.codex`。

| 资源               | 行为                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `config.toml`      | 原地读取用户配置，再从仓库根到当前目录叠加受信任项目的 `.codex/config.toml`；连接凭证只保存在内存中 |
| 全局指令           | 优先读取非空 `AGENTS.override.md`，否则读取 `AGENTS.md`                                             |
| 项目指令           | 从仓库根到 DSH 当前工作目录，逐级选择首个非空的覆盖文件、基础文件或已配置后备文件                   |
| DSH 与共享全局指令 | 保留 `~/.dsh/AGENTS.md` 与 `~/.agents/AGENTS.md`，也支持对应环境变量指定的目录                      |
| 本地覆盖文件       | 保留 `AGENTS.local.md` 与 `CLAUDE.local.md`                                                         |
| Codex 技能         | 发现 `skills/` 和 `skills/.system/`，正文按需加载                                                   |
| 共享与项目技能     | 保留原生发现机制，并补齐当前目录到仓库根每一级 `.agents/skills`；更近的项目技能优先                 |
| 技能开关           | 遵循有序的 `skills.config` 名称/路径选择器，以及 `skills.bundled.enabled`                           |
| 已启用插件         | 支持新版根目录 `plugin.json`、`mcp.json` 和旧版声明；禁用插件不加载                                 |

兼容层通过 DSH 文件系统读取项目指令，按 Codex 优先级选择候选文件，只替换已覆盖作用域内的原生指令消息；额外发现的子目录指令更新仍然保留。它不会导入 Codex 内置系统提示词。`CLAUDE.md` 等后备文件仅在 Codex 配置明确声明时使用。指令以有字节预算的普通用户上下文写入会话，明确配置的零预算也会生效；指令不覆盖系统、开发者或用户直接指令。移除插件不会删除已有会话历史。

插件资源优先来自已配置的本地市场目录，否则使用匹配市场中最新的本地缓存版本，不会自动下载。插件技能使用 `<插件名>-<技能名>`，以符合 DSH 命名格式并避免跨插件冲突。技能原始路径和相对资源引用保持不变。

新版 Agent Plugins 使用固定的 `skills/` 与 `mcp.json`，不受旧版 `skills`、`mcpServers` 声明改写。OpenAI 扩展优先使用根清单的 `extensions.com.openai` 对象（包括空对象），缺省时才使用 `.codex-plugin/plugin.json`；插件名称仍取自根清单。

## MCP 兼容

插件会为每个会话代理（Agent）自动启动已启用的 MCP 命令并连接已配置的 HTTP 端点。导入来源包括 `mcp_servers` 和已启用插件声明的 MCP 资源。受信任项目的覆盖配置只在该会话代理的作用域内生效，并行会话不会共用导入工具的注册；未受信任项目的配置会跳过。

支持的配置包括：

- 标准输入输出连接的 `command`、`args`、`cwd`、`env`、`env_vars`；
- 流式 HTTP 连接的 `url`、`http_headers`、`env_http_headers`、`bearer_token_env_var`；
- `enabled`、启动/工具超时、`enabled_tools`、`disabled_tools`；
- 插件服务器声明中的插件根目录变量替换。

全局服务器名称在 DSH 允许时原样保留，插件服务器增加插件名前缀。未变化的连接继续复用；变更或删除的连接先卸载再替换。配置损坏时保留上一份有效快照，单个服务器配置无效时也会保留其可用连接。开启自动刷新时，启动失败会按指数退避间隔重试，最多尝试十次；手动刷新会重置次数。默认每两秒检查配置与插件资源变化，技能文件变化由原生监视器处理。

插件级 `plugins.<插件>.mcp_servers.<服务器>` 的 `enabled`、`enabled_tools`、`disabled_tools` 和单工具禁用设置会覆盖声明中的策略，但不能改写插件的命令、传输或凭证。插件文件损坏时，保留的旧连接仍应用最新禁用和过滤限制；有效声明恢复前，不会放宽旧快照已有的限制。

stdio 服务器默认从所属 Agent 的项目工作目录启动，切换项目时重建连接；显式 `cwd` 配置优先。未显式配置 `cwd` 时，相对可执行文件路径仍按配置或插件根目录解析，避免与运行目录混淆。插件根目录替换同时支持 `${PLUGIN_ROOT}`、`${CODEX_PLUGIN_ROOT}` 和 `${CLAUDE_PLUGIN_ROOT}`。

导入的 MCP 工具会在 `tools/call` 的 `_meta["x-codex-turn-metadata"]` 中携带当前 DSH 会话和轮次信息。`session_id` 使用 Agent 的会话 ID，`turn_id` 使用 `<会话 ID>:<turn/start 事件序号>`；同一轮的调用保持一致，新轮次重新读取，异步并发会话相互隔离。没有活动轮次的诊断调用不生成虚假标识。这些字段不进入工具参数，也不要求模型填写。

调用链为：DSH Agent → 导入工具的异步调用上下文 → MCP `tools/call` 元数据 → `node_repl` → 浏览器服务。此桥接修复浏览器服务因缺少 `session_id`、`turn_id` 抛出的 `Missing required Codex turn metadata`；浏览器扩展、认证和 App 专属服务仍需在宿主可用。插件卸载时撤销桥接，普通 DSH MCP 调用不注入这些字段。

凭证不会复制到 DSH 设置、插件缓存或本仓库。状态接口只返回资源名、状态和经过脱敏的原因代码。需要继承的环境变量必须存在于 DSH 宿主环境中。

本插件提供环境兼容，不会重新实现 Codex 运行时。Codex 的 OAuth/钥匙串会话、App 专属进程通信服务、Hooks、应用组件、权限策略和专用命令不会自动重现。使用配置中的请求头或环境变量认证的标准 MCP 可以复用；依赖缺失认证或运行时服务的服务器会报告连接失败。插件的 Hooks、应用和命令明确标为不支持，不会自动执行。审批和沙箱仍由 DSH 自身管理。

通过已认证的宿主方法 `gptModels/codexStatus` 查看状态，使用 `gptModels/refreshCodex` 请求刷新。资源状态为 `loading`（加载中）、`loaded`（已加载）、`disabled`（已禁用）、`unsupported`（不支持）或 `failed`（失败）。MCP 的已加载状态表示首次连接和工具发现已完成，后续重连由 DSH 管理。

## 可选控制项

无需逐个服务器重复配置。现有 `gpt-adapter` 插件设置还提供以下控制项：

```yaml
codexCompatibility:
  enabled: true
  # codexHome: /path/to/existing/codex-home
  importInstructions: true
  importSkills: true
  importMcpServers: true
  importPluginResources: true
  watch: true
  pollIntervalMs: 2000
  mcpAllowlist: []
```

空 `mcpAllowlist` 表示导入所有已启用的声明服务器；非空列表按原始服务器名筛选。禁用或移除插件会撤销它拥有的运行时注册，不改动 Codex 文件。原生 DSH 模型配置与其他插件保留。

## GPT 模型控制与存储

能力优先级为用户覆盖、上游明确元数据、外部能力目录、预设。能力目录请求不携带提供商 API 密钥；模型列表可以不包含能力元数据。Responses 使用 `reasoning.effort`，Chat Completions 使用 `reasoning_effort`，保留用户选定的协议。

### 上下文窗口

在「设置 → 模型」中，展开提供商卡片的 GPT 自动适配区域内的「上下文窗口」，即可逐个模型设置：

| 选项 | 容量（词元数） |
| --- | --- |
| 默认 | 根据当前模型与提供商自动解析。 |
| 516K | `516000` |
| 1M | `1000000` |
| 自定义 | 用户输入的正安全整数。 |

固定档使用十进制单位。界面展示实际容量和来源。「默认」依次采用可辨识的显式提供商默认值、上游模型元数据、已配置的能力目录、插件内置的精确模型预设、原生目录或 DSH 后备值；后备值会如实标注来源。内置预设是带核验日期的数据，不会实时抓取 OpenAI 页面：`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-luna`、`gpt-5.4` 为 `1050000`，`gpt-4.1` 为 `1047576`，`gpt-4o` 为 `128000`；仅为有文档依据的快照别名复用预设。参考页面和核验日期见[预设表](src/context-window.ts)。

已有原生模型数值（包括目录模型的 `modelOverrides`）和旧版 JSON 上下文覆盖继续生效，直到用户主动编辑。保存预设会使用原生模型字段，并仅清除该模型的旧版上下文覆盖；选择「默认」会删除两处逐模型覆盖，保留提供商默认值和其他设置。保存无关设置或发现模型不会把自动值固化为手动覆盖。同名模型在不同提供商下独立设置。自定义数值若恰好等于固定档，保存或重新加载后会显示对应固定档。

使用原生目录 `modelOverrides` 的提供商在同步时保留目录配置。模型发现和失效清理只更新插件快照，不会生成不兼容的显式 `models` 列表，也不会删除原生覆盖。

原生表单的自动容量变化后，过期草稿会被拒绝，刷新表单再保存即可。预设控件会在其他模型保存后保留草稿并续用新版本；同一模型发生变化时，先核对当前值，再点击「保留草稿继续编辑」后重新保存。

修改对下一次准备的调用生效，已准备的调用继续使用原有容量。模型信息、推理模型、溢出判断和原生上下文压缩采用同一有效窗口；最大输出词元设置与 DSH 原生压缩策略保持独立。扩大本地窗口不会提高网关实际接受的上限。

思考预设只投影到原生界面，不写入原生模型配置。关闭 GPT 自动适配后恢复原生值和参数结构。速度选择按会话持久化。同步失败保留旧快照，失效模型保留到主动清理。

GPT 模型快照与速度选择保存在 `$DSH_HOME/storages/gpt-adapter`。Codex 源文件和导入的 MCP 凭证不会复制到该位置。正常会话记录和日志由 DSH 宿主管理。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

测试使用临时目录、合成凭证、模拟上游流，以及真实的本地测试 MCP 进程；不证明真实账户能力、上游思考质量、外部 MCP 认证或 Codex App 运行时可用性。

## 许可证

采用 [MIT 许可证](LICENSE)。复用的 DeepSeek Harness 资源见[第三方声明](THIRD_PARTY_NOTICES.md)。本项目独立维护，与 DeepSeek、OpenAI 无隶属关系。
