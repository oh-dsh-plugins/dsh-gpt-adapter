# DSH GPT Adapter

[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2563eb)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

A third-party plugin for DeepSeek Harness (DSH) that adapts GPT models and reuses your existing Codex environment. Read Codex instructions, skills, enabled plugin resources, and MCP server configurations without moving or rewriting the original files.

## Features

- Discover upstream models automatically and manage them on the native Models page.
- Choose from six GPT reasoning levels: `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
- Set per-model context windows with Default, 516K, 1M, or Custom.
- Select Standard or Fast speed in the chat toolbar; declared or configured Ultrafast tiers are also supported.
- Reuse Codex instruction files, local and plugin skills, and MCP servers.
- Apply trusted project configuration to the corresponding Agent session.

Reasoning levels, speed tiers, and context limits depend on the configured model gateway. Local presets do not increase upstream capabilities.

## Installation

Requires Node.js `>=24.9.0` and DSH `0.2.2-rc.1` with Cordis `4.1.0`.

Install the npm package in your DSH web profile:

```sh
dsh plugin --profile web add dsh-gpt-adapter@0.2.8
```

Restart DSH after installing or upgrading. Replace `web` with your profile name when using a different profile.

To install a local build from source, you also need pnpm:

```sh
git clone https://github.com/oh-dsh-plugins/dsh-gpt-adapter.git
cd dsh-gpt-adapter
pnpm install --frozen-lockfile
mkdir -p artifacts
pnpm pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/dsh-gpt-adapter-0.2.8.tgz
```

## Using GPT models

1. Open **Settings → Models** and configure the provider's base URL, API key, and model list. OpenAI Responses and Chat Completions protocols are supported.
2. Check **GPT auto-adaptation** on the provider card. Eligible GPT providers are detected automatically; the switch lets you enable or disable adaptation.
3. Select the model and reasoning level in the conversation. Use the speed menu in the chat toolbar to choose Standard or Fast.

Fast requests the upstream priority tier. Ultrafast appears only when declared by the upstream or configured through a capability override. Speed selections are saved per session.

Use **Sync now** on the provider card to refresh the model list. Models no longer listed upstream are retained until you choose to remove them. You can also configure the sync interval, an optional capability catalog URL, and model capability overrides on that card. Explicit overrides take precedence over upstream metadata, external catalogs, and presets.

### Context windows

Open **Settings → Models → Custom settings → Model catalog** and use the model's **Context window** field:

| Choice  | Behavior                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| Default | Restore automatic resolution from provider defaults, model metadata, capability catalogs, and built-in presets. |
| 516K    | Set `516000` tokens.                                                                                            |
| 1M      | Set `1000000` tokens.                                                                                           |
| Custom  | Enter a token count or a decimal K/M value, such as `750K` or `1.2M`.                                           |

Only Custom shows an input. Apply changes with the native Save button. Existing explicit capacities remain effective until you change them. Settings for the same model ID on different providers are independent.

Context capacity must exceed the output-token budget plus DSH's compaction reserve. Maximum output and automatic compaction remain controlled by DSH. Changing the local window does not change the upstream limit; changes apply to the next prepared request.

## Reusing your Codex environment

Codex compatibility is enabled by default. The plugin uses `codexHome` when configured, otherwise `CODEX_HOME`, then `~/.codex`.

| Resource             | Supported behavior                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.toml`        | Read user configuration and trusted project `.codex/config.toml` layers.                                                                                         |
| Global instructions  | Use the first nonempty `AGENTS.override.md`, otherwise `AGENTS.md`.                                                                                              |
| Project instructions | Read from repository root to the current DSH working directory, including configured fallback filenames.                                                         |
| Shared instructions  | Retain DSH/shared instructions and applicable local instruction overlays.                                                                                        |
| Skills               | Load Codex `skills/`, `skills/.system/`, enabled plugin skills, and native shared/project skills. Honor configured skill enablement and original resource paths. |
| Enabled plugins      | Read supported local plugin manifests and their skill/MCP resources. Disabled plugins remain disabled.                                                           |
| MCP servers          | Import enabled `mcp_servers` and enabled plugin MCP declarations.                                                                                                |

Instruction changes apply at the next model step. The plugin reads instruction files; it does not import Codex's built-in system prompt. Existing conversation history remains when the plugin is removed.

Plugin resources must already exist in a configured local marketplace or the Codex plugin cache. The adapter does not download them. Plugin skills and servers receive a plugin prefix where needed to avoid name conflicts.

### MCP servers

Supported transports are stdio and Streamable HTTP. Existing server configuration can supply commands, arguments, working directories, environment variables, headers, bearer-token environment variables, timeouts, and enabled/disabled tool lists.

MCP connections start before an Agent's first model step. Each Agent owns its connections, and trusted project overrides apply within that Agent's scope. Stdio servers use the Agent's working directory unless an explicit `cwd` is configured. Idle Agents release their connections after one minute and reconnect before the next step. With watching enabled, active Agents update their connections automatically; idle Agents apply configuration changes when they resume.

Set `mcpIdleTimeoutMs` to change the idle retention period, or `0` to keep connections until the Agent is disposed. Reconnecting can reset server state held only in memory; use `0` for servers that need to preserve that state between turns.

Authentication variables must be available in the DSH host environment. Servers that depend on Codex App authentication, browser extensions, or other local services still require those services to be available. The adapter does not reproduce Codex OAuth/keychain sessions, App IPC services, hooks, proprietary commands, or permission policies. DSH retains its own approvals and sandbox behavior.

### Optional configuration

The existing `gpt-adapter` plugin settings expose these options:

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

An empty `mcpAllowlist` imports all enabled declared servers. A nonempty list filters by the original server name. Set individual import options to `false` to disable those resource types; set `enabled: false` to disable Codex compatibility.

## Data and removal

Model snapshots and saved speed choices are stored under `$DSH_HOME/storages/gpt-adapter`. Codex source files and imported MCP credentials are not copied there.

Disabling GPT adaptation restores native model controls. Disabling or removing the plugin withdraws its runtime registrations without changing Codex source files or deleting DSH conversation history.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md). This project is independently maintained and is not affiliated with DeepSeek or OpenAI.
