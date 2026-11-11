# DSH GPT Adapter

[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2563eb)](https://github.com/deepseek-ai/deepseek-harness)
[![DSH compatibility](https://img.shields.io/badge/DSH-0.2.2--rc.1-0f766e)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Public source repository for a DeepSeek Harness (DSH) plugin that adapts GPT
models, reasoning levels, service tiers, and upstream model discovery.

DeepSeek Harness extension for GPT-focused model and capability synchronization.

This repository is a DSH plugin project. The `dsh` manifest in `package.json`
declares the Host bundle patch and Web client injection points used by DSH.
It is installed into a DSH profile as a local tarball; it is not an npm package
or a ChatGPT subscription authenticator.

The project intentionally keeps the existing DSH/`llm-pi-ai` request, tool-call,
streaming, and replay pipeline. Its first layer owns the GPT-specific facts that
the generic adapter does not know:

- upstream model discovery through `GET /models`;
- dynamic reasoning labels, including independent `max` and `ultra` choices;
- independent Standard/Fast/Ultrafast service tiers;
- user override precedence and bounded cache refresh behavior;
- non-secret cache identity isolation for endpoint/account changes.

The plugin supplies a six-level GPT preset: `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`, each sent unchanged by default. This is the configured gateway
policy, not a claim that every upstream API/model implements every level.
Explicit user overrides, upstream capabilities, and an external catalog take
precedence. Ordinary model-list responses can omit capability metadata; the
preset fills that gap.

## Current status

The package contains Host/client entries, a disposable synchronizer, persistence,
protocol-specific request controls, and contributions to the existing Models
page and conversation menu. Tests include actual official-adapter request
serialization with synthetic credentials and simulated upstream streams.
They do not prove real-account capability, latency, or reasoning quality.

## Compatibility and local installation

The generated integration targets DSH packages `0.2.2-rc.1`, Cordis `4.1.0`, and
Pi AI `1.3.0`. Source hashes are recorded in `lib/compatibility.json`.
Installed upstream package files are never modified.

Install the local tarball into the intended profile:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-gpt-adapter-0.1.6.tgz
```

Version `0.1.6` is a single additive plugin. It extends the pinned native Pi AI
adapter at runtime, restores its methods on disposal, and keeps the official
base/Web bundles and native model menu active. The existing Models page supplies
its controls and styles; speed selection uses the existing composer control slot.
The plugin projects the same effective reasoning into the native Models page,
its reasoning-level schema, and the conversation model menu. Recognized GPT/Codex
routes are adapted automatically; an explicit provider switch can disable this.
Existing and newly discovered models receive the preset, including configured
models absent from the latest upstream list.

Open **Settings → Models** and configure the endpoint, key, and protocol as
usual. **GPT 自动适配** on the original provider card controls the overlay, model
refresh, and optional catalog/JSON overrides. Preset fields belong to the plugin;
use its capability overrides to customize them, or turn adaptation off to edit
native reasoning directly. Other native model fields remain editable.

Preset reasoning fields are never written into the native profile. Saving other
model fields preserves the original native reasoning data. Disabling/unloading
the plugin restores the native schema and values while retaining other saved
edits. The native model menu shows the same levels; a native menu beside it
supplies independent speed choices. Per-session speed selections are persisted.

Responses uses `reasoning.effort`; Chat Completions uses `reasoning_effort`.
The selected protocol is preserved. GPT/Codex models offer Standard and Fast by
default even when `/models` omits speed metadata. Standard stays selected until
changed; preset Fast sends `service_tier: "priority"`. Explicit upstream/catalog
tier declarations and user overrides take precedence and preserve their wire
values. A default tier or a partial capability flag does not declare the complete
supported-tier list. Ultrafast remains an independent declared/overridden tier.
Reasoning and speed stay independent; the selected menu value requests a tier,
and the returned `service_tier` records what the upstream actually used.

On adapted GPT Responses requests, function tools with omitted `strict` receive
`strict: false` so the upstream does not implicitly require optional arguments.
Explicit strictness, parameter schemas, and non-function tools are preserved.
Chat Completions and routes with adaptation disabled keep their native behavior.

## Capability catalogs and retention

Capability precedence is user override, explicit upstream metadata, external
catalog, then the bundled baseline. Catalog requests never receive the provider
API key. A catalog has a nonempty `version` and a `models` object whose values use
optional gateway extensions such as `reasoning_supported_efforts`,
`reasoning_default_effort`, and `service_tiers`. These fields extend the standard
model-list schema; the official `/models` response need not contain them.

For example, a hypothetical `gpt-example` entry may declare
`{"reasoning_supported_efforts":["max","ultra"],"service_tiers":["default","priority","ultrafast"]}`.
This illustrates the schema rather than a real model's capabilities. An explicit
map such as `reasoning_efforts: {"off":"none","high":"high"}` preserves its wire
values. `can_disable_thinking` alone never invents a disabling request. Off with
an omitted parameter is rejected; `null` reasoning selection follows upstream
defaults, while omitted selection uses the configured default.

Refresh failures retain the last working snapshot. Absent models stay `stale`
until explicit cleanup; no automatic deletion TTL is imposed. Route runners
coalesce refreshes, bound network I/O, reject results from changed connections,
and cancel on disposal. Endpoint, protocol, and credential changes invalidate
conditional model-list caches. Plugin state is stored under
`$DSH_HOME/storages/gpt-adapter`; API keys and conversation contents are not stored
there. Remove the plugin through DSH to restore the original runtime behavior; credentials, model configuration, and session logs remain in the native host.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for reused source licensing.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
pnpm pack --pack-destination artifacts
```

The package does not implement ChatGPT subscription authentication. It expects an
API key resolved by the host credential service. Callers must also provide a
stable, non-secret `cacheIdentity` for the endpoint/account credential context so
an ETag from one account cannot be reused for another.
