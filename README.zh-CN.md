# DSH GPT Adapter

[![DSH 插件](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2563eb)](https://github.com/deepseek-ai/deepseek-harness)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[英文版](README.md) | 简体中文

面向 DeepSeek Harness（DSH）的第三方 GPT 模型与 Codex 环境兼容插件。
安装一个插件，即可直接读取原有 Codex 指令、技能、已启用插件资源及 MCP 服务器配置，无需移动或改写 Codex 文件。

## 功能

- 通过 `GET /models` 发现上游模型；失效模型保留到用户主动清理。
- 在原生模型设置页和对话菜单中提供 `low / medium / high / xhigh / max / ultra` 六档思考预设。
- 提供独立的 Standard 和 Fast 速度选择。Fast 发送 `service_tier: "priority"`；Ultrafast 由上游明确声明或用户覆盖提供。
- 为 GPT Responses 函数工具补齐缺失的 `strict: false`，保留可选参数。
- 读取 Codex 指令，在下一模型步骤更新；内容不变时不重复注入。
- 挂载 Codex 本地技能和已启用插件技能，保持原始资源路径。
- 通过 DSH 官方 MCP 客户端挂载 Codex 已启用服务器，并自动对账连接变化。

思考和速度预设代表发往网关的请求，不保证所有上游都支持。用户覆盖、上游明确的能力元数据和外部能力目录优先于预设。

## 兼容性与安装

原生集成面向 DSH `0.2.2-rc.1`、Cordis `4.1.0`，并校验适配器源码指纹。开发依赖固定 Pi AI `1.3.0`。插件不会修改已安装的第三方包文件，目前未发布到 npm。

需要 Node.js `>=24.9.0` 和 pnpm。

```sh
git clone https://github.com/lxjmaster/dsh-gpt-adapter.git
cd dsh-gpt-adapter
pnpm install --frozen-lockfile
mkdir -p artifacts
pnpm pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/dsh-gpt-adapter-0.2.2.tgz
```

`pnpm pack` 会自动执行生产构建。升级安装包后重启 DSH 宿主。

## 自动发布

`Release` 工作流会在推送到 `main` 或手动运行时执行。版本号为正式的 `X.Y.Z` 时，工作流会运行测试、创建 `vX.Y.Z` 标签、创建对应的 GitHub Release，并将包发布到 npm。预发布版本会跳过；已有标签或 npm 版本会安全复用。

首次发布前，请在仓库 Secrets 中添加 npm 访问令牌 `NPM_TOKEN`。
在「设置 → 模型」中照常配置 GPT 连接；插件扩展现有原生设置与对话控件。

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
| 已启用插件         | 读取声明的技能目录和内联或文件引用形式的 `mcpServers`；禁用插件不加载                               |

兼容层通过 DSH 文件系统读取项目指令，按 Codex 优先级选择候选文件，只替换已覆盖作用域内的原生指令消息；额外发现的子目录指令更新仍然保留。它不会导入 Codex 内置系统提示词。`CLAUDE.md` 等后备文件仅在 Codex 配置明确声明时使用。指令以有字节预算的普通用户上下文写入会话，明确配置的零预算也会生效；指令不覆盖系统、开发者或用户直接指令。移除插件不会删除已有会话历史。

插件资源优先来自已配置的本地市场目录，否则使用匹配市场中最新的本地缓存版本，不会自动下载。插件技能使用 `<插件名>-<技能名>`，以符合 DSH 命名格式并避免跨插件冲突。技能原始路径和相对资源引用保持不变。

## MCP 兼容

插件会为每个会话代理（Agent）自动启动已启用的 MCP 命令并连接已配置的 HTTP 端点。导入来源包括 `mcp_servers` 和已启用插件声明的 MCP 资源。受信任项目的覆盖配置只在该会话代理的作用域内生效，并行会话不会共用导入工具的注册；未受信任项目的配置会跳过。

支持的配置包括：

- 标准输入输出连接的 `command`、`args`、`cwd`、`env`、`env_vars`；
- 流式 HTTP 连接的 `url`、`http_headers`、`env_http_headers`、`bearer_token_env_var`；
- `enabled`、启动/工具超时、`enabled_tools`、`disabled_tools`；
- 插件服务器声明中的插件根目录变量替换。

全局服务器名称在 DSH 允许时原样保留，插件服务器增加插件名前缀。未变化的连接继续复用；变更或删除的连接先卸载再替换。配置损坏时保留上一份有效快照，单个服务器配置无效时也会保留其可用连接。开启自动刷新时，启动失败会按指数退避间隔重试，最多尝试十次；手动刷新会重置次数。默认每两秒检查配置与插件资源变化，技能文件变化由原生监视器处理。

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
