# DSH GPT Adapter

[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2563eb)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

English | [Simplified Chinese](README.zh-CN.md)

A third-party DeepSeek Harness (DSH) plugin for GPT models and existing Codex environments.
Install one plugin to reuse local Codex instructions, skills, enabled plugin resources, and MCP server configurations without moving or rewriting Codex files.

## Features

- Discover upstream models with `GET /models` and retain stale entries until explicit cleanup.
- Provide the GPT reasoning preset `low / medium / high / xhigh / max / ultra` through the native Models page and conversation menu.
- Reuse the native per-model context field for manual capacities and automatic resolution, with support for K/M input.
- Offer independent Standard and Fast speed choices. Fast sends `service_tier: "priority"`; Ultrafast requires an explicit upstream declaration or override.
- Preserve optional function arguments on GPT Responses requests by setting missing `strict` values to `false`.
- Read Codex instruction files and refresh them at the next model step without repeating unchanged baselines.
- Register Codex local skills and enabled plugin skills with their original resource paths.
- Mount enabled Codex MCP servers through the official DSH MCP client and reconcile changed connections automatically.

Reasoning and speed presets are requests to the configured gateway, not guarantees of upstream support. User overrides, explicit upstream capability metadata, and external catalogs take precedence over presets.

## Compatibility and installation

The native integration targets DSH `0.2.2-rc.1`, Cordis `4.1.0`, and the pinned adapter source hash. The development dependency uses Pi AI `1.3.0`. Installed third-party package files are never edited. The package version is `dsh-gpt-adapter@0.2.5`.

Requires Node.js `>=24.9.0` and DSH. Source builds also require pnpm.

Install the published package in the web profile:

```sh
dsh plugin --profile web add dsh-gpt-adapter@0.2.5
```

Restart the DSH host after installing or upgrading. Configure GPT connections under **Settings → Models**; Codex environment reuse is enabled by default. The plugin extends the existing native settings and conversation controls.

To install from source for development or verification:

```sh
git clone https://github.com/lxjmaster/dsh-gpt-adapter.git
cd dsh-gpt-adapter
pnpm install --frozen-lockfile
mkdir -p artifacts
pnpm pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/dsh-gpt-adapter-0.2.5.tgz
```

`pnpm pack` runs the production build.

## Automated releases

The `Release` workflow runs on pushes to `main` and manual dispatches. For a formal `X.Y.Z` version, it runs the test suite, creates `vX.Y.Z`, creates the matching GitHub Release, and publishes the package to npm. Prerelease versions are skipped, and existing tags or npm versions are reused safely.

Maintainers must provide the npm access token as the repository secret `NPM_TOKEN` for this workflow.

## Codex environment reuse

Codex compatibility is enabled by default. The root is the plugin's `codexHome` override, then `CODEX_HOME`, then `~/.codex`.

| Resource                       | Behavior                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.toml`                  | Read user configuration in place, then trusted project `.codex/config.toml` layers from repository root to cwd; connection secrets stay in memory |
| Global instructions            | First nonempty `AGENTS.override.md`, otherwise `AGENTS.md`                                                                                        |
| Project instructions           | Repository root to current DSH working directory; first nonempty override, base file, or configured fallback per directory                        |
| DSH/shared global instructions | Retained from `~/.dsh/AGENTS.md` and `~/.agents/AGENTS.md` (or their configured environment roots)                                                |
| Local overlays                 | Existing `AGENTS.local.md` and `CLAUDE.local.md` remain applicable                                                                                |
| Codex skills                   | Discover `skills/` and `skills/.system/`; bodies load on demand                                                                                   |
| Shared/project skills          | Retain native discovery and include `.agents/skills` at every directory from cwd to repository root; nearer project skills take precedence        |
| Skill enablement               | Honor ordered `skills.config` name/path selectors and `skills.bundled.enabled`                                                                    |
| Enabled plugins                | Support portable root `plugin.json` / `mcp.json` and legacy declarations; disabled plugins stay disabled                                          |

The compatibility layer reads project instructions through DSH's filesystem, selects candidates using Codex precedence, and replaces native messages only for covered scopes. Additional nested instruction updates remain applicable. It does not import Codex's built-in system prompt. Configured fallback filenames such as `CLAUDE.md` are used only when supplied in Codex configuration. Instructions are recorded as ordinary user context with a bounded byte budget, including an explicit zero budget; they do not override system, developer, or direct user instructions. Existing conversation history is retained when the plugin is removed.

Plugin resources are resolved from the configured local marketplace, or the newest locally cached version in the matching marketplace. Nothing is downloaded automatically. Plugin skills use `<plugin>-<skill>` names to fit DSH's skill-name format and avoid cross-plugin collisions. Original skill paths and relative resources remain intact.

Portable Agent Plugins use fixed `skills/` and `mcp.json` components, regardless of legacy `skills` or `mcpServers` declarations. OpenAI settings come from the root manifest's `extensions.com.openai` object, including an empty object; only when absent does `.codex-plugin/plugin.json` supply the overlay. Plugin identity always comes from the root manifest.

## MCP compatibility

The plugin automatically starts enabled MCP commands and connects configured HTTP endpoints for each Agent session. It imports `mcp_servers` and the MCP resources declared by enabled plugins. Trusted project overrides apply within that Agent's scope; concurrent sessions do not share imported tool registrations. Untrusted project configuration is skipped.

Supported configuration includes:

- stdio `command`, `args`, `cwd`, `env`, and `env_vars`;
- Streamable HTTP `url`, `http_headers`, `env_http_headers`, and `bearer_token_env_var`;
- `enabled`, startup/tool timeouts, `enabled_tools`, and `disabled_tools`;
- plugin-root substitutions in plugin server declarations.

Global server names are retained where DSH permits them. Plugin servers use a plugin prefix. Unchanged connections are preserved. Changed or removed connections are disposed before replacement. Invalid configuration retains the last working snapshot, including individually invalid server entries. With automatic refresh enabled, failed startup retries with exponential backoff for up to ten attempts; a manual refresh resets that budget. The default two-second refresh detects configuration and plugin-resource changes; native skill watchers detect skill file changes.

Plugin-scoped `plugins.<plugin>.mcp_servers.<server>` policies apply `enabled`, `enabled_tools`, `disabled_tools`, and per-tool disabling without overriding the plugin's executable, transport, or credentials. When plugin files are invalid, retained connections still receive current disabling and filtering restrictions; old restrictions are not relaxed until a valid declaration is available again.

Stdio servers default to their Agent's project working directory and reconnect when that directory changes. An explicit `cwd` takes precedence. Without an explicit `cwd`, relative executable paths still resolve from the config or plugin root, independently of the process working directory. Plugin paths support `${PLUGIN_ROOT}`, `${CODEX_PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_ROOT}`.

Imported MCP tools carry the current DSH session and turn in `tools/call` metadata under `_meta["x-codex-turn-metadata"]`. `session_id` is the Agent session ID; `turn_id` is `<session ID>:<turn/start event sequence>`. Calls in one turn share the same identity, new turns read a fresh boundary, and asynchronous sessions remain isolated. Diagnostic calls outside an active turn do not invent identities. These fields are transport metadata, never model-supplied tool arguments.

The path is DSH Agent → imported tool execution context → MCP `tools/call` metadata → `node_repl` → browser service. This bridge addresses `Missing required Codex turn metadata: session_id, turn_id`; the browser extension, authentication, and App-specific services must still be available on the host. Unloading the plugin removes the bridge, and ordinary DSH MCP calls do not receive these fields.

Credentials are not copied into DSH settings, plugin caches, or this repository. Status responses contain only resource names, states, and sanitized reason codes. Missing environment variables must exist in the DSH host environment to be inherited.

This is environment compatibility, not a replacement Codex runtime. Codex OAuth/keychain sessions, Codex App IPC services, hooks, app components, permission policies, and proprietary commands are not automatically reproduced. Standard MCPs using configured headers/environment can be reused; servers requiring unavailable runtime authentication or services report a connection failure. Plugin hooks/apps/commands are reported as unsupported rather than executed. DSH retains its own approval and sandbox behavior.

Inspect status through the authenticated host method `gptModels/codexStatus`; use `gptModels/refreshCodex` to request a configuration refresh. Resource states are `loading`, `loaded`, `disabled`, `unsupported`, or `failed`. A loaded MCP entry means its initial connection and tool discovery completed; subsequent reconnection is managed by DSH.

## Optional controls

No per-server reconfiguration is needed. The existing `gpt-adapter` plugin settings also expose:

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

An empty `mcpAllowlist` imports all enabled declared servers. A nonempty list filters by the original server key. Disabling or removing the plugin withdraws its runtime registrations and leaves Codex files untouched. Native DSH model configuration and other plugins remain in place.

## GPT model controls and storage

Capability precedence is user override, explicit upstream metadata, external catalog, then preset. Catalog requests never receive the provider API key. Model-list responses may omit capability metadata. Reasoning is sent as `reasoning.effort` for Responses and `reasoning_effort` for Chat Completions; the selected protocol is preserved.

### Context windows

Under **Settings → Models → Custom settings → Model catalog**, edit the native **Context window** field. The plugin reuses this field and adds no separate context editor. Enter a count, `516K` (`516000` tokens), or `1M` (`1000000` tokens); clear the field and save to restore automatic resolution.

Inherited model rows and provider defaults participate in edit detection and final budget validation. A failed legacy cleanup restores the previous native capacity while preserving unrelated edits.

An empty native field means automatic resolution. Automatic capacities stay in the effective model information; the editable draft contains manual values only, including existing legacy overrides. An explicit value equal to the current automatic capacity is still saved as a manual value.

Capacity suffixes use decimal units. Automatic resolution uses a distinguishable explicit provider default, upstream model metadata, the configured capability catalog, the shipped exact-model preset, then the native catalog/DSH fallback. Shipped presets are dated data, not a live fetch from OpenAI: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, and `gpt-5.4` use `1050000`; `gpt-4.1` uses `1047576`; `gpt-4o` uses `128000`. Only documented snapshot aliases share these presets. References and verification dates are in [the preset table](src/context-window.ts).

Existing native per-model values, including catalog `modelOverrides`, and legacy JSON context overrides remain effective until deliberately edited. Editing the native context field clears only that model's legacy context override; clearing the field removes its manual context values while retaining provider defaults and other settings. Saving unrelated settings or discovering models does not turn automatic values into manual overrides. Identical model IDs on different providers are independent.

Providers using native catalog `modelOverrides` keep their catalog configuration during synchronization. Discovery and stale cleanup update the plugin snapshot without creating an incompatible explicit `models` list or deleting native overrides.

Native forms reject stale drafts when their automatic capacities change; refresh the form before retrying. Context, output-limit, and relevant provider-default edits are checked against the saved draft's output budget and native compaction headroom. An omitted output limit uses the native model catalog or provider/schema default. Invalid saves leave the previous values in place.

Changes apply to the next prepared call; calls already prepared retain their captured capacity. Model information, the inference model, overflow detection, and native compaction use the same effective window. Maximum output tokens and DSH's compaction policy remain independent. A larger local window does not increase the gateway's accepted limit.

Preset reasoning fields are projected into the native UI rather than persisted into native model configuration. Disabling GPT adaptation restores the native model values and schema. Speed selections are persisted per session. Synchronization failures retain the previous snapshot; absent models remain stale until explicit cleanup.

GPT model snapshots and speed selections are stored under `$DSH_HOME/storages/gpt-adapter`. Codex source files and imported MCP credentials are not copied there. The DSH host owns normal session transcripts and logs.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Tests use temporary directories, synthetic credentials, simulated upstream streams, and a real local fixture MCP process. They do not establish real-account support, upstream reasoning quality, external MCP authentication, or Codex App runtime availability.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for reused DeepSeek Harness assets. This project is independently maintained and is not affiliated with DeepSeek or OpenAI.
