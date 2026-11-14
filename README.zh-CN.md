# DSH GPT Adapter

[![DSH 插件](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2563eb)](https://github.com/deepseek-ai/deepseek-harness)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](README.md) | 简体中文

面向 DeepSeek Harness（DSH）的第三方插件，提供 GPT 模型适配，并复用已有 Codex 环境。无需移动或改写原文件，即可读取 Codex 指令、技能、已启用插件资源和 MCP 服务器配置。

## 功能

- 自动发现上游模型，在原生模型设置页中管理。
- 提供 `low`、`medium`、`high`、`xhigh`、`max`、`ultra` 六档 GPT 思考等级。
- 为每个模型选择「默认」「516K」「1M」或「自定义」上下文窗口。
- 在聊天栏选择 Standard 或 Fast 速度，也支持上游声明或自行配置的 Ultrafast 档位。
- 复用 Codex 指令文件、本地及插件技能、MCP 服务器。
- 将受信任项目的配置应用到对应会话代理（Agent）。

思考等级、速度档位和上下文上限取决于所连接的模型网关。本地预设不会提高上游实际能力。

## 安装

需要 Node.js `>=24.9.0`、Cordis `4.1.0`，以及 DSH `0.2.2-rc.1`、`0.2.2-rc.2` 或 `0.2.2-rc.3`。

在 DSH 的 `web` 配置档（profile）中安装 npm 包：

```sh
dsh plugin --profile web add dsh-gpt-adapter@0.2.9
```

安装或升级后重启 DSH。使用其他配置档时，将 `web` 替换为对应名称。

如需从源码安装本地构建，还需要 pnpm：

```sh
git clone https://github.com/oh-dsh-plugins/dsh-gpt-adapter.git
cd dsh-gpt-adapter
pnpm install --frozen-lockfile
mkdir -p artifacts
pnpm pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/dsh-gpt-adapter-0.2.9.tgz
```

## 使用 GPT 模型

1. 打开「设置 → 模型」，配置提供商的服务地址、API 密钥和模型列表。支持 OpenAI Responses 和 Chat Completions 协议。
2. 查看提供商卡片上的「GPT 自动适配」。插件会自动识别符合条件的 GPT 提供商，也可使用开关启用或停用适配。
3. 在对话中选择模型和思考等级，通过聊天栏的速度菜单选择 Standard 或 Fast。

Fast 会请求上游优先档位。只有上游明确声明或通过能力覆盖配置时，才会显示 Ultrafast。速度选择按会话保存。

使用提供商卡片上的「立即同步」刷新模型列表。上游不再列出的模型会保留到主动移除。卡片还可配置同步间隔、可选的能力目录地址和模型能力覆盖。显式覆盖优先于上游元数据、外部能力目录和预设。

### 上下文窗口

打开「设置 → 模型 → 自定义设置 → 模型目录」，使用模型的「上下文窗口」字段：

| 选项   | 行为                                                       |
| ------ | ---------------------------------------------------------- |
| 默认   | 根据提供商默认值、模型元数据、能力目录和内置预设自动解析。 |
| 516K   | 设置为 `516000` 个词元（token）。                          |
| 1M     | 设置为 `1000000` 个词元。                                  |
| 自定义 | 输入词元数，或十进制 K/M 数值，例如 `750K`、`1.2M`。       |

仅「自定义」显示输入框，修改后使用原生「保存」按钮提交。已有明确容量在主动修改前继续生效；不同提供商下的同名模型独立设置。

上下文容量需要大于最大输出预算与 DSH 压缩预留之和。最大输出和自动压缩仍由 DSH 控制。修改本地窗口不会改变上游实际限制，修改对下一次准备的请求生效。

## 复用 Codex 环境

Codex 兼容默认开启。目录优先采用插件配置中的 `codexHome`，其次为 `CODEX_HOME`，最后为 `~/.codex`。

| 资源          | 支持行为                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `config.toml` | 读取用户配置和受信任项目的 `.codex/config.toml` 配置层。                                                                 |
| 全局指令      | 优先使用非空的 `AGENTS.override.md`，否则使用 `AGENTS.md`。                                                              |
| 项目指令      | 从仓库根目录读取到 DSH 当前工作目录，支持配置中指定的后备文件名。                                                        |
| 共享指令      | 保留 DSH、共享指令和适用的本地指令覆盖。                                                                                 |
| 技能          | 加载 Codex 的 `skills/`、`skills/.system/`、已启用插件技能，以及原生共享和项目技能；遵循技能启用配置，保留原始资源路径。 |
| 已启用插件    | 读取支持的本地插件声明及其技能、MCP 资源；禁用插件保持禁用。                                                             |
| MCP 服务器    | 导入已启用的 `mcp_servers` 和已启用插件声明的 MCP。                                                                      |

指令变化在下一模型步骤生效。插件读取指令文件，不会导入 Codex 内置系统提示词。移除插件后，已有对话历史继续保留。

插件资源需要已存在于配置的本地市场或 Codex 插件缓存中，适配器不会下载资源。插件技能和服务器会在需要时添加插件名前缀，避免名称冲突。

### MCP 服务器

支持标准输入输出（stdio）和流式 HTTP（Streamable HTTP）两种传输方式。可以复用已有配置中的命令、参数、工作目录、环境变量、请求头、令牌环境变量、超时，以及工具启用和禁用列表。

MCP 连接在代理首次执行模型步骤前建立。每个代理独立持有连接，受信任项目的覆盖配置只在对应代理内生效。未显式配置 `cwd` 时，stdio 服务器使用代理的工作目录。代理空闲一分钟后释放连接，在下一步骤前重新连接。启用配置监听时，正在执行的代理自动更新连接；空闲代理在恢复执行时应用配置变化。

可通过 `mcpIdleTimeoutMs` 调整空闲保留时间，设为 `0` 则保留连接直到代理销毁。重新连接可能重置服务器仅保存在内存中的状态；需要跨轮次保留这些状态的服务器应设为 `0`。

认证所需环境变量需要存在于 DSH 宿主环境。依赖 Codex App 认证、浏览器扩展或其他本地服务的服务器，仍需要这些服务可用。适配器不会复现 Codex 的 OAuth、钥匙串会话、App 进程间通信服务、Hooks、专用命令和权限策略。审批与沙箱仍由 DSH 管理。

### 可选配置

现有 `gpt-adapter` 插件设置提供以下选项：

```yaml
codexCompatibility:
  enabled: true
  # codexHome: /path/to/existing/codex-home
  importInstructions: true
  importSkills: true
  importMcpServers: true
  importPluginResources: true
  watch: true
  mcpIdleTimeoutMs: 60000
  pollIntervalMs: 2000
  mcpAllowlist: []
```

`mcpAllowlist` 为空时导入所有已启用的声明服务器；非空时按原始服务器名筛选。将单项导入选项设为 `false` 可关闭对应资源类型；将 `enabled` 设为 `false` 可关闭 Codex 兼容。

## 数据与移除

模型快照和已保存的速度选择位于 `$DSH_HOME/storages/gpt-adapter`，Codex 源文件和导入的 MCP 凭证不会复制到该目录。

停用 GPT 自动适配后恢复原生模型控件。禁用或移除插件会撤销其运行时注册，不改动 Codex 源文件，也不删除 DSH 对话历史。

## 许可证

采用 [MIT 许可证](LICENSE)，另见[第三方声明](THIRD_PARTY_NOTICES.md)。本项目独立维护，与 DeepSeek、OpenAI 无隶属关系。
