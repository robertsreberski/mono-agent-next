---
title: "Environment variables"
description: "Find every supported mono-agent environment variable and understand dotenv loading, precedence, and JSON-only settings."
sidebar:
  order: 2
---

This page lists the environment variables mono-agent reads, grouped by domain. Each table names the JSON field the variable overrides; variables that configure only a CLI or runtime child process are marked separately.

Config fields may be JSON-only: only fields with a documented `MONO_AGENT_*` mapping accept one. In the [generated config reference](/config/reference/), `--` means none, as for `channels.plugins`. Use the [annotated blueprint](/config/blueprint/) to see structured JSON-only fields in context.

## Precedence and `.env` loading

For fields with a mapping, resolution is **passed environment > JSON > built-in default**.

The CLI builds that environment before config loading:

1. Variables already exported in the shell remain in place.
2. `./.env` fills variables that are still unset. Pass `--env-file <path>` to select another file.
3. The config loader receives the resulting environment and applies it over JSON and defaults.

The machine-wide `mono-agent web` console is the exception: it does not load an agent config or the invoking folder's `.env`. For `mono-agent validate --consumer <path>`, the default `.env` and relative `--env-file` paths resolve inside the consumer folder.

`loadMonoAgentConfigWithSources` is lower-level than the CLI. It does not read a dotenv file; a programmatic host must load one itself if desired and pass the prepared `env` record.

:::caution
Keep secrets in an untracked, owner-only `.env` or an exported environment—not in committed JSON. For local providers, store the variable name in `apiKeyEnv` instead of storing the key itself. In this source checkout, `pnpm run check:secrets` also scans ignored and untracked files, so keep real credentials outside the repository and pass an absolute `--env-file` path.

Guided `mono-agent init` handles selected secrets through masked input and preserves existing non-empty dotenv assignments and comments. Its managed background worker cannot rely on launching-shell secrets, so readiness is proved from durable dotenv and provider-auth state. Automatic persistence is fail-closed on unsafe POSIX paths and is not attempted on Windows. See [CLI reference → Secret persistence](/observability/cli-reference/#secret-persistence) for the complete filesystem and race-safety contract.

`mono-agent config` and `mono-agent validate` issue a non-fatal warning when a secret-marked field came from JSON and name the environment variable to use. The aggregate `providers.local[]` view cannot lint an inline `apiKey` field-by-field, so follow the `apiKeyEnv` convention explicitly.
:::

:::note
Provider API keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are **provider-native** variables, not `MONO_AGENT_*` ones. Reference them from config via `apiKeyEnv` (for local providers) rather than inlining a key. See [local provider configuration](/runtime/local-providers/) and [runtime backend authentication](/runtime/backends/).
:::

## Agent and runtime

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_NAME` | `agent.name` | Public display name. It may seed human-facing trace/A2A labels but never paths, service ids, sessions, or provider identity. |
| `MONO_AGENT_MODEL` | `runtime.model` | Backend-prefixed model, e.g. `codex:gpt-5.6-terra`, `pi:openai-codex:gpt-5.6-terra`, `pi:opencode-go:kimi-k2.6`. Required. |
| `MONO_AGENT_EXECUTION_MODE` | `runtime.executionMode` | `sdk` vs `cli`; default inferred from model. |
| `MONO_AGENT_FALLBACKS_JSON` | `runtime.fallbacks` | Canonical JSON array of `{ "model": "...", "effort"?: "..." }`; ordered and uncapped. Omitted effort means that route's provider default. Mutually exclusive with the legacy CSV variable. |
| `MONO_AGENT_FALLBACK_MODELS` | `runtime.fallbackModels` | Legacy CSV compatibility surface. Entries inherit `runtime.effort`; prefer `MONO_AGENT_FALLBACKS_JSON`. See [runtime fallback configuration](/runtime/fallback/). |
| `MONO_AGENT_ROUTE_SAFETY` | `runtime.routeSafety` | `uniform` (default common monotonic contract) or explicit `per-route-native` mixed-provider contracts. |
| `MONO_AGENT_EFFORT` | `runtime.effort` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`; the selected model may support only a subset. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade. See [execution, effort, and permissions](/runtime/execution-effort-permissions/). |
| `MONO_AGENT_PERMISSION_MODE` | `runtime.permissionMode` | `default` / `plan` / `acceptEdits` / `bypassPermissions` (CLI backends). |
| `MONO_AGENT_MAX_TURNS` | `runtime.maxTurns` | Turn cap per run; omitted or `0` means unlimited. |
| `MONO_AGENT_COMPACTION_ENABLED` | `runtime.compaction.enabled` | Enables adaptive proactive compaction and one-shot reactive overflow recovery; default `true`. |
| `MONO_AGENT_COMPACTION_TRIGGER_RATIO` | `runtime.compaction.triggerRatio` | Proactive window ratio, `0.2`-`0.95`; default `0.70`, additionally capped by adaptive safety headroom. |
| `MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS` | `runtime.compaction.keepRecentTokens` | Explicit retained-context override (`4000`-`200000`); omitted derives 10% of the effective window, clamped to `4000`-`20000`. |
| `MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS` | `runtime.compaction.summaryMaxTokens` | Explicit combined summary-output budget (`1000`-`64000`); omitted derives 4% of the effective window, clamped to `2000`-`12000`. |
| `MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS` | `runtime.compaction.minSavingsTokens` | Explicit minimum proactive savings (`0`-`500000`); omitted derives 10% of the effective window, clamped to `4000`-`20000`. Reactive recovery accepts any positive reduction. |
| `MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED` | `runtime.compaction.fixedOverheadEnabled` | Includes the system prompt, tool schemas, and current user turn in request estimates; default `true`. |
| `MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE` | `runtime.compaction.contextWindowOverride` | Persistent context-window correction (`32000`-`10000000`) for inaccurate provider metadata; learned overflow evidence may lower it process-locally. |
| `MONO_AGENT_WORKSPACE` | `runtime.workspace` | Working directory for runtime tools. |
| `MONO_AGENT_SESSION_MODE` | `runtime.session.mode` | `continuous` (default) reuses a warm provider session and queues turns per conversation; `per-message` starts each provider turn cold. Durable history remains a separate replay layer in both modes. |
| `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS` | `runtime.session.idleTimeoutMs` | Idle eviction window for warm continuous sessions; default 30 minutes. It does not delete durable history. See [Sessions and concurrency](/runtime/sessions-concurrency/). |
| `MONO_AGENT_SESSION_ISOLATE_PROACTIVE` | `runtime.session.isolateProactive` | When `true`, scheduled requests carrying cron metadata run one-shot instead of acquiring or saving the conversation's warm session. Interactive turns are unchanged. |
| `MONO_AGENT_SESSION_ROLLOVER` | `runtime.session.rollover` | `none` or `daily`; daily adds a date bucket to each conversation id. |
| `MONO_AGENT_SESSION_ROLLOVER_TIMEZONE` | `runtime.session.rolloverTimezone` | IANA timezone for daily bucket boundaries; defaults to the system timezone. |
| `MONO_AGENT_SESSION_ROLLOVER_NOTICE` | `runtime.session.rolloverNotice` | When `true`, the first turn in a new daily bucket receives a one-line adapter-visible notice. Default off; it does not enable rollover by itself. |
| `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS` | `concurrency.maxConcurrentRuns` | Runs executing against the provider at once (**per-channel**). |
| `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | `concurrency.maxPendingRuns` | Runs admitted before the provider step (**per-channel**). |

```json
{
  "agent": { "name": "Research Companion" },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [{ "model": "pi:opencode-go:kimi-k2.6", "effort": "medium" }],
    "routeSafety": "uniform",
    "session": { "mode": "continuous", "idleTimeoutMs": 600000, "rollover": "daily", "rolloverTimezone": "UTC", "rolloverNotice": false }
  },
  "concurrency": { "maxConcurrentRuns": 4, "maxPendingRuns": 8 }
}
```

```bash
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.6-terra
MONO_AGENT_EFFORT=high
MONO_AGENT_FALLBACKS_JSON='[{"model":"pi:opencode-go:kimi-k2.6","effort":"medium"}]'
MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS=4
```

## Providers

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_LOCAL_PROVIDERS_JSON` | `providers.local[]` | Full JSON array of local providers (id, type, baseUrl, apiKey/apiKeyEnv, models). |
| `MONO_AGENT_LOCAL_PROVIDER_*` | `providers.local[]` | Single-provider field overrides. |
| `MONO_AGENT_PI_AUTH_PATH` | `providers.piAuthPath` | Pi credential file; a non-empty value wins over JSON and loses only to `auth login --pi-auth-path`. Default `~/.pi/agent/auth.json`; `~` expands to home and relative paths resolve from the agent/invocation working directory. |
| `MONO_AGENT_PI_TRANSPORT` | `providers.piNative.transport` | Preferred Pi transport: `auto` (default), `sse`, `websocket`, or `websocket-cached`; unsupported providers ignore it. |
| `MONO_AGENT_PI_MAX_RETRIES` | `providers.piNative.piMaxRetries` | Pi-native transport retries, 0-8, default 2. |
| `MONO_AGENT_MAX_RETRY_DELAY_MS` | `providers.piNative.maxRetryDelayMs` | Default 60000. |
| `MONO_AGENT_PI_SESSIONS_ROOT` | `providers.piNative.piSessionsRoot` | Durable JSONL session storage (e.g. `.mono-agent/sessions`); unset = in-memory. |

See [local provider configuration](/runtime/local-providers/) for the local provider shape and [runtime backends](/runtime/backends/) for Pi auth.

## Context

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_IDENTITY_PATH` | `context.identityPath` | Identity markdown loaded into every prompt. Required. See [identity and soul configuration](/context/identity-and-soul/). |
| `MONO_AGENT_SOUL_PATH` | `context.soulPath` | Optional secondary voice/guardrail doc. |
| `MONO_AGENT_SKILLS_ROOT` | `context.skillsRoot` | Root folder for `<name>/SKILL.md` skills. See [skill selection and loading](/context/skills/). |
| `MONO_AGENT_SELECTED_SKILLS` | `context.selectedSkills` | Explicitly selected skill names. |
| `MONO_AGENT_SKILL_MAX_BYTES` | `context.skillMaxBytes` | Per-skill instruction byte cap; default 48000. |
| `MONO_AGENT_SKILL_DISCLOSURE` | `context.skillDisclosure` | `index` (names only) or `full` (full bodies); default `full`. |

## Memory

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_MEMORY_BACKEND` | `memory.backend` | Memory engine: `bujo` (default, homegrown SQLite) or `supermemory` (external). External backends ignore `mode`/`embeddings`/`llm`. |
| `MONO_AGENT_MEMORY_MODE` | `memory.mode` | `lite` / `journal` / `bujo` (bujo backend only). |
| `MONO_AGENT_MEMORY_PATH` | `memory.path` | Storage root for built-in memory; relative paths resolve from the agent folder. Required when the built-in memory backend is configured. |
| `MONO_AGENT_MEMORY_MAX_BYTES` | `memory.maxBytes` | Maximum bytes returned in an automatic recalled-memory block; default `64000`. |
| `MONO_AGENT_MEMORY_WRITE_MODE` | `memory.writeMode` | `disabled` / `append-host-summary` / `capture` (`capture` requires `mode: bujo` for the bujo backend, or an external backend that extracts server-side). See [memory capture and recall](/memory/capture-and-recall/). |
| `MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL` | `memory.supermemory.baseUrl` | Required when `backend: supermemory`. REST base URL of the local OSS binary or hosted cloud. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY` | `memory.supermemory.apiKey` | Inline API key (optional for no-auth local). Prefer `_API_KEY_ENV`. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV` | `memory.supermemory.apiKeyEnv` | Name of the env var holding the key; only the name is persisted in resolved config. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER` | `memory.supermemory.container` | Container/namespace tag scoping this agent's memories. Defaults to the trace `sourceId`. |
| `MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS` | `memory.supermemory.timeoutMs` | Per-call HTTP timeout (`1`–`600000`, default `10000`). |
| `MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER` | `memory.supermemory.exposeMcpServer` | Also inject Supermemory's official MCP server alongside the in-app `MemoryRecall` tool. Default `false`. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | `memory.embeddings.provider` | `ollama`, `lmstudio`, or `openai`. The configured provider is exclusive; there is no cross-provider fallback. See [memory embeddings](/memory/embeddings/). |
| `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | `memory.embeddings.model` | Embedding model string. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | `memory.embeddings.dim` | Embedding dimension. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT` | `memory.embeddings.endpoint` | Service root: defaults to `http://localhost:11434` for Ollama, `http://localhost:1234` for LM Studio, or `https://api.openai.com/v1` for OpenAI. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV` | `memory.embeddings.apiKeyEnv` | Name of the variable holding the key. LM Studio is keyless when omitted; when declared, a missing/empty named variable reports `waiting` rather than silently retrying keyless. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY` | `memory.embeddings.apiKey` | Direct key override. Prefer `_API_KEY_ENV` so config stores only a variable name. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS` | `memory.embeddings.timeoutMs` | Per-request embedding timeout (`1`–`600000`); default `10000`. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `memory.embeddings.circuitBreaker.failureThreshold` | Consecutive embedding failures before the circuit opens (`1`–`100`); default `3`. |
| `MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS` | `memory.embeddings.circuitBreaker.cooldownMs` | Cooldown before an open embedding circuit permits a trial request (`1`–`3600000`); default `30000`. |
| `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | `memory.recallTool.enabled` | Auto-provisioned read-only `MemoryRecall`; default on for every configured tier, explicit false opts out. |
| `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | `memory.consolidation.enabled` | Scheduled BuJo consolidation; default on. |
| `MONO_AGENT_MEMORY_CONSOLIDATION_CRON` | `memory.consolidation.cron` | Default `0 */2 * * *`. See [memory rituals and scheduling](/memory/rituals/). |
| `MONO_AGENT_MEMORY_LLM_PROVIDER` | `memory.llm.provider` | `ollama` or `agent-host`. Strictly required for BuJo capture and tier selection; projection-only consolidation itself makes no model call. Missing prerequisites fail instead of downshifting tiers. |
| `MONO_AGENT_MEMORY_LLM_MODEL` | `memory.llm.model` | Chat model for the capture pipeline. |
| `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE` | `memory.llm.executionMode` | `sdk` for `agent-host` refs. |
| `MONO_AGENT_MEMORY_LLM_ENDPOINT` | `memory.llm.endpoint` | Ollama-only endpoint override. |
| `MONO_AGENT_MEMORY_LLM_TRACE` | `memory.llm.trace` | Enables trace recording for an `agent-host` memory LLM; default `true`. |
| `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | `memory.llm.timeoutMs` | In-app per-call memory-LLM timeout (`1000`–`600000`, **default `60000`**); see [the memory-LLM timeout](/memory/validation-and-cli/#the-memory-llm-timeout). |

:::note
The standalone `memory-bujo` maintenance CLI that read these `MONO_AGENT_MEMORY_*` variables directly against a memory root has been removed. All memory maintenance now runs config-aware through `mono-agent memory` from the agent folder, which reads these values from `mono-agent.config.json`. See [the removed standalone memory CLI](/memory/validation-and-cli/#memory-bujo-cli--removed).
:::

:::note
`MONO_AGENT_MEMORY_REFLECTION_ENABLED`, `MONO_AGENT_MEMORY_REFLECTION_CRON`,
`MONO_AGENT_MEMORY_MIGRATION_ENABLED`, and `MONO_AGENT_MEMORY_MIGRATION_CRON` are retired.
They are tolerated so stale environments do not break startup, but they are ignored and
`mono-agent validate` reports a warning.
:::

## Tools

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_ALLOWED_TOOLS` | `tools.allowedTools` | Allowlist. **Unset** keeps the allow-all default; `*` is allow-all; an empty value (`""`) is the explicit chat-only `[]`. See [tool policy](/tools/policy/). |
| `MONO_AGENT_DISALLOWED_TOOLS` | `tools.disallowedTools` | Denylist (deny wins; overlap rejected). |
| `MONO_AGENT_MCP_CONFIG_PATH` | `tools.mcpConfigPath` | Path to `mcp.json`. See [MCP configuration](/tools/mcp/). |
| `MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS` | `tools.mcpRequestContextServers` | Comma-separated stdio MCP server names that receive trusted request-scoped context and progress capabilities. |
| `MONO_AGENT_CONTINUATION_SERVERS` | `tools.continuationServers` | Comma-separated stdio or loopback-HTTP MCP server names that receive trusted request-bound continuation claim capabilities. See [durable continuations](/tools/durable-continuations/). |
| `MONO_AGENT_MCP_CALL_TIMEOUT_MS` | `tools.mcpCallTimeoutMs` | Inactivity timeout per MCP tool call; tool progress notifications reset it. Default 120000. |
| `MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS` | `tools.mcpCallMaxTotalTimeoutMs` | Hard wall clock per MCP tool call that progress cannot extend. Default 2700000 (45 min). |

### Durable continuations

The host service itself is configured through the `continuations` JSON block. `continuations.detachedServices[].tokenEnv` names an operator-chosen environment variable containing that service's bearer; there is deliberately no fixed environment variable that accepts a raw detached token. Selected MCP servers receive reserved run-scoped `MONO_AGENT_CONTINUATION_CLAIM_*` variables or `x-mono-agent-continuation-claim-*` headers from the host. Those values are runtime capabilities, not operator overrides, and configured spoof values are replaced.

See [Durable continuations](/tools/durable-continuations/) for the complete configuration and protocol.

## Interaction (AskUser + tool progress)

The interaction bridge starts automatically when `AskUser` is allowed (under the allow-all default, or listed in a specific `tools.allowedTools`), when the `interaction` block or any interaction env override is configured, or when `interaction.progress.enabled` resolves true and `tools.mcpRequestContextServers` names at least one opted project MCP server. `MONO_AGENT_INTERACTION_BRIDGE_URL` / `MONO_AGENT_INTERACTION_BRIDGE_TOKEN` are an app-owned master capability forwarded only to the trusted adapter-tool child; do not set or pass them to project tools. Only opted project stdio MCP children receive a separate run-scoped `MONO_AGENT_INTERACTION_PROGRESS_URL` / `MONO_AGENT_INTERACTION_PROGRESS_TOKEN` pair, and their master-capability env keys are overwritten with empty strings.

Opted project stdio MCPs also receive host-owned filesystem context after all MCP option layers are merged: `MONO_AGENT_MCP_RUN_OUTPUT_DIR`, `MONO_AGENT_MCP_ATTACHMENTS_ROOT`, `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS`, and `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES`. The path value is a JSON array containing only lexical paths saved successfully for the current request; the identity value contains matching `{ "path", "dev", "ino" }` objects captured from the writer descriptors. Empty arrays are authoritative and configured values cannot override them. These are runtime-injected context keys, not operator configuration variables.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_INTERACTION_BRIDGE_HOST` | `interaction.bridge.host` | Bind host. Default `127.0.0.1`; keep it loopback because non-loopback values are not rejected. |
| `MONO_AGENT_INTERACTION_BRIDGE_PORT` | `interaction.bridge.port` | Bridge port. Default `0` (ephemeral — consumers get the URL via env). |
| `MONO_AGENT_ASK_USER_TIMEOUT_MS` | `interaction.askUser.timeoutMs` | Max wait for one `AskUser` interaction (one to five questions). Default 600000 (10 min). |
| `MONO_AGENT_PROGRESS_ENABLED` | `interaction.progress.enabled` | Route tool progress posts to channel status messages. Default true. |

## Sandbox

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_SANDBOX_MODE` | `sandbox.mode` | `native` (srt-wrapped) vs `off`. See [sandbox configuration](/tools/sandbox/). |
| `MONO_AGENT_SANDBOX_NETWORK` | `sandbox.network.mode` | `none` / `localhost` / `allowlist` / `all`. `all` keeps filesystem enforcement while leaving egress open (SRT library-entry launch; managed or explicit node+cli only). |
| `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` | `sandbox.network.allowlist` | Domain allowlist. |
| `MONO_AGENT_SANDBOX_READABLE_ROOTS` | `sandbox.readableRoots` | Readable filesystem roots. |
| `MONO_AGENT_SANDBOX_WRITABLE_ROOTS` | `sandbox.writableRoots` | Writable filesystem roots. |
| `MONO_AGENT_SANDBOX_DENY_WRITE` | `sandbox.denyWrite` | Deny-write globs (`.env*`, `.git/config`, `.git/hooks/**` denied by default). |
| `MONO_AGENT_SANDBOX_FALLBACK` | `sandbox.fallback` | fail-closed vs unsafe-host-process when srt is unavailable. |
| `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` | `sandbox.unsafeAllowHostProcess` | Runs commands on the host without srt. |

## Observability and traceability

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_ARTIFACT_DIR` | `artifacts.dir` | Run event JSONL + summaries, independently replaced at recorder boundaries rather than appended in flight. See [artifacts and traces](/observability/artifacts-and-traces/). |
| `MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS` | `artifacts.retention.maxAgeDays` | Delete terminal run artifacts older than this many days (default `365`; bounds `1..3650`). |
| `MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT` | `artifacts.retention.maxCount` | Keep at most this many newest terminal run artifacts (default `50000`; bounds `1..1000000`). |
| `MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN` | `artifacts.retention.dryRun` | Log what retention would delete without unlinking files. |
| `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS` | `artifacts.memoryRetention.maxAgeDays` | Delete terminal memory-run artifacts older than this many days (default `7`; bounds `1..3650`). |
| `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT` | `artifacts.memoryRetention.maxCount` | Keep at most this many newest terminal memory runs (default `5000`; bounds `1..1000000`). |
| `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN` | `artifacts.memoryRetention.dryRun` | Log what memory retention would delete without unlinking files. Defaults to `artifacts.retention.dryRun` when unset. |
| `MONO_AGENT_TRACE_REGISTRY_DIR` | `traceability.registryDir` | Heartbeat-manifest registry for dashboard discovery; default `~/.mono-agent/trace-sources`. |
| `MONO_AGENT_TRACE_SOURCE_ID` | `traceability.sourceId` | Optional stable source identifier published in the heartbeat manifest. |
| `MONO_AGENT_TRACE_SOURCE_LABEL` | `traceability.sourceLabel` | Human-facing source label; defaults to `agent.name` when unset. |
| `MONO_AGENT_TRACE_HEARTBEAT_MS` | `traceability.heartbeatMs` | Heartbeat publication interval (`250`–`86400000`); default `10000`. |
| `MONO_AGENT_TRACE_STALE_AFTER_MS` | `traceability.staleAfterMs` | Age at which a heartbeat is treated as stale (`1000`–`604800000`); default `30000`. |
| `MONO_AGENT_TRACE_GLOBAL_DISCOVERY` | `traceability.globalDiscovery` | Publish to the shared discovery registry; default `true`. |
| `MONO_AGENT_OBSERVABILITY_EXPORTERS` | `observability.exporters[]` | JSON array; Phoenix OTLP exporter entries. See [Phoenix export and backfill](/observability/phoenix-and-backfill/). |

## Channels

Most channels are opt-in via their `enabled` flag (default off). The `tui` operator surface defaults on so the TUI/web console can chat without per-agent edits. The tables below enumerate every channel environment variable. Structured JSON-only fields have no invented environment form and are identified beside the relevant channel; consult the [annotated config blueprint](/config/blueprint/) for the complete per-channel shape.

### Telegram

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` | |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` | Bot token. |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` | Or `allowAllChats`. See [Telegram channel configuration](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS` | `telegram.allowAllChats` | Allow any chat instead of requiring `allowedChatIds`; default `false`. |
| `MONO_AGENT_TELEGRAM_REACTIONS` | `telegram.reactions` | All-on/all-off boolean override for the lifecycle status reactions (👀 working / 👍 done / 👎 error). Granular per-state control (`{ working, done, error }`) is JSON-only. |
| `MONO_AGENT_TELEGRAM_IP_FAMILY` | `telegram.transport.ipFamily` | Pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`); omit for dual-stack. Workaround for a broken IPv6 route to `api.telegram.org`. |
| `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | `telegram.pollWatchdogMs` | Poll-liveness watchdog window (ms); default `120000`, `0` disables. Force-restarts a runner that stops delivering updates without crashing. |
| `MONO_AGENT_TELEGRAM_API_ROOT` | `telegram.apiRoot` | Base URL of a self-hosted Bot API server (e.g. `http://127.0.0.1:8081`). Omit for `api.telegram.org`. See [Telegram channel configuration](/channels/telegram/). |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES` | `telegram.attachments.maxBytes` | Inbound attachment download cap (bytes). Default 20 MiB (the hosted API's hard limit); raise it only with a self-hosted server. |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `telegram.attachments.downloadTimeoutMs` | Per-file download timeout (ms) on the URL branch; default `30000`, `0` disables. |
| `MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES` | `telegram.attachments.maxUploadBytes` | Upload cap (bytes) for `TelegramSendFile`; default 20 MiB. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT` | `telegram.transcription.endpoint` | Full HTTP(S) URL of an OpenAI-compatible `POST /v1/audio/transcriptions` route. Unset disables transcription. The built-in transcriber has no credential field and sends no `Authorization` header, so the endpoint must accept unauthenticated requests (typically from a local server). |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL` | `telegram.transcription.model` | Model name sent with each transcription request; required when the endpoint is set. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE` | `telegram.transcription.language` | Optional ISO-639 language hint. |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS` | `telegram.transcription.timeoutMs` | Per-call timeout in milliseconds (`1`–`3600000`); default `120000`, independent of the attachment download timeout. |

### Slack

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_SLACK_ENABLED` | `slack.enabled` | |
| `MONO_AGENT_SLACK_BOT_TOKEN` | `slack.botToken` | `xoxb-...` |
| `MONO_AGENT_SLACK_APP_TOKEN` | `slack.appToken` | `xapp-...` (Socket Mode). |
| `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS` | `slack.allowedChannelIds` | Or `allowAllChannels`. See [Slack channel configuration](/channels/slack/). |
| `MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS` | `slack.allowAllChannels` | Allow any joined channel instead of requiring `allowedChannelIds`; default `false`. |
| `MONO_AGENT_SLACK_BOT_USER_IDS` | `slack.botUserIds` | Comma-separated bot user IDs used to recognize native mentions. |
| `MONO_AGENT_SLACK_MENTION_TEXT_ALIASES` | `slack.mentionTextAliases` | Comma-separated plain-text aliases that trigger the bot. |
| `MONO_AGENT_SLACK_STRIP_MENTION_TEXT` | `slack.stripMentionText` | Remove the matched mention or alias before the prompt reaches the agent. When unset, defaults to `true` when `botUserIds` or `mentionTextAliases` is non-empty; otherwise `false`. |
| `MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS` | `slack.heartbeatIntervalMs` | Socket Mode ping/silence probe interval (ms); default `30000`. |
| `MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS` | `slack.heartbeatTimeoutMs` | Silence budget before the watchdog force-recycles the socket (ms); default `90000`, `0` disables the watchdog. |
| `MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS` | `slack.reconnectInitialBackoffMs` | First reconnect backoff after a non-graceful drop (ms); default `500`. |
| `MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS` | `slack.reconnectMaxBackoffMs` | Backoff ceiling (ms); default `30000`. Jitter (ratio 0.2) is applied on by default. |
| `MONO_AGENT_SLACK_RECONNECT_STABILITY_MS` | `slack.reconnectStabilityMs` | A reconnect must stay open this long before the backoff resets (ms); default `30000` (not per-connect). |
| `MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS` | `slack.reconnectStartupGraceMs` | Window (ms) to quietly retry a lingering prior-process socket instead of flagging `degraded`; default `10000`. |
| `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS` | `slack.drainDeadlineMs` | Backstop (ms) to force a reconnect after a watchdog `terminate()` if the old socket emits no close; default `5000`. |

All Slack resilience vars are optional integers (`0`–`3600000`); omit to use the default. They tune the terminate-first, jittered, stability-gated reconnect loop and the silence watchdog. See [Slack channel configuration](/channels/slack/).

The structured Slack interaction fields are configured only in `mono-agent.config.json`:

- `slack.shortcuts` is JSON-only and has no environment-variable form.
- `slack.homeTab` is JSON-only and has no environment-variable form.

### WhatsApp

WhatsApp is loaded through `channels.plugins[]` with `package: "@mono-agent/whatsapp-adapter"`. These env vars override that plugin entry's `config` fields.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WHATSAPP_ENABLED` | plugin `config.enabled` | QR login; auth state in `.mono-agent/whatsapp-auth`. |
| `MONO_AGENT_WHATSAPP_ALLOWED_CHAT_JIDS` | plugin `config.allowedChatJids` | Or `allowAllChats`. |
| `MONO_AGENT_WHATSAPP_ALLOW_ALL_CHATS` | plugin `config.allowAllChats` | Allow any chat instead of requiring `allowedChatJids`; default `false`. |
| `MONO_AGENT_WHATSAPP_GROUP_MODE` | plugin `config.groupMode` | `mention` / `any`. See [WhatsApp channel configuration](/channels/whatsapp/). |
| `MONO_AGENT_WHATSAPP_BOT_JIDS` | plugin `config.botJids` | Comma-separated linked-account JIDs used to recognize native group mentions. |
| `MONO_AGENT_WHATSAPP_MENTION_TEXT_ALIASES` | plugin `config.mentionTextAliases` | Comma-separated text aliases that count as group mentions. |
| `MONO_AGENT_WHATSAPP_STRIP_MENTION_TEXT` | plugin `config.stripMentionText` | Remove the matched mention or alias before the prompt reaches the agent. When unset, defaults to `true` only when `mentionTextAliases` is non-empty; `botJids` alone does not enable stripping, so otherwise it defaults to `false`. |

### Webhook

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEBHOOK_ENABLED` | `webhook.enabled` | |
| `MONO_AGENT_WEBHOOK_HOST` | `webhook.host` | Bind host; default `127.0.0.1`. |
| `MONO_AGENT_WEBHOOK_PORT` | `webhook.port` | Bind port; default `0` selects a free port. |
| `MONO_AGENT_WEBHOOK_PATH` | `webhook.path` | Default single-endpoint path; default `/webhook/invoke`. |
| `MONO_AGENT_WEBHOOK_PROMPT` | `webhook.prompt` | Pre-instructions for the default single endpoint. |
| `MONO_AGENT_WEBHOOK_DEFAULT_MODE` | `webhook.defaultMode` | `sync` or `async`; default `sync`. |
| `MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK` | `webhook.allowNonLoopback` | Must be `true` for a non-loopback bind. |
| `MONO_AGENT_WEBHOOK_API_KEY` | `webhook.apiKey` | Optional on loopback; required for any enabled non-loopback bind. Clients send it as a bearer. |
| `MONO_AGENT_WEBHOOK_RETENTION_MS` | `webhook.retentionMs` | Async status retention in milliseconds; default `300000`. |
| `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS` | `webhook.maxStoredRequests` | Maximum retained async statuses; default `100`. |
| `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | `webhook.endpoints[]` | JSON array of named endpoints. |
| `MONO_AGENT_WEBHOOK_NOTIFY` | `webhook.notify` | Single-endpoint native notification toggle. |
| `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | `webhook.notifyConversationId` | Single-endpoint native notification destination. |
| `MONO_AGENT_WEBHOOK_MODEL` | `webhook.model` | Single-endpoint model override (e.g. `claude:claude-opus-4-8`). A request body `model` wins. |
| `MONO_AGENT_WEBHOOK_EFFORT` | `webhook.effort` | Single-endpoint reasoning-effort override (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`), subject to model support. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade. A request body `effort` wins. |
| `MONO_AGENT_WEBHOOK_DIR` | `webhook.dir` | Folder of `*.md` endpoint files. See [webhook channel configuration](/channels/webhook/). |
| `MONO_AGENT_WEBHOOK_MAX_RUN_MS` | `webhook.maxRunMs` | Wall-clock bound (ms) per webhook run; default 20 min, `0` disables. Reclaims a hung run's slot (esp. async, which has no client disconnect). |

### OpenAI-compatible API

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_OPENAI_API_ENABLED` | `openaiApi.enabled` | |
| `MONO_AGENT_OPENAI_API_HOST` | `openaiApi.host` | Bind host; default `127.0.0.1`. |
| `MONO_AGENT_OPENAI_API_PORT` | `openaiApi.port` | Bind port; default `0` selects a free port. |
| `MONO_AGENT_OPENAI_API_BASE_PATH` | `openaiApi.basePath` | API prefix; default `/v1`. |
| `MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK` | `openaiApi.allowNonLoopback` | Must be `true` for an enabled non-loopback bind. |
| `MONO_AGENT_OPENAI_API_KEY` | `openaiApi.apiKey` | Optional on loopback; required for any enabled non-loopback bind. Clients send it as a bearer (`sk-...`). |
| `MONO_AGENT_OPENAI_API_MODEL_ID` | `openaiApi.modelId` | Advertised model id. See [OpenAI-compatible API configuration](/channels/openai-api/). |

### Always-on web console CLI

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_WEB_ALLOWED_HOSTS` | — (CLI-only) | Comma-separated additional exact DNS names accepted by `mono-agent web`; suffix wildcards are rejected. Managed `start`/`restart` preserves these names and adds this node's exact Tailscale DNS name when available. This changes Host admission only; it does not add authentication or make an untrusted network safe. |

### Operator stream endpoint

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_TUI_ENABLED` | `tui.enabled` | **Default `true`** — default-on loopback operator surface for `mono-agent tui` and `mono-agent web`. |
| `MONO_AGENT_TUI_HOST` | `tui.host` | Default `127.0.0.1`. |
| `MONO_AGENT_TUI_PORT` | `tui.port` | Default `0` (ephemeral; published to the trace-source registry). |
| `MONO_AGENT_TUI_BASE_PATH` | `tui.basePath` | Default `/gui`. |
| `MONO_AGENT_TUI_ALLOW_NON_LOOPBACK` | `tui.allowNonLoopback` | Required to bind a non-loopback host. |
| `MONO_AGENT_TUI_API_KEY` | `tui.apiKey` | Optional bearer the console must present. Put the value in `.env`; inline `tui.apiKey` remains accepted for compatibility but is not the documented source-config convention. See [operator stream configuration](/channels/tui/). |

### A2A

The A2A provider is loaded through `channels.plugins[]` with `package: "@mono-agent/a2a-adapter"`. These env vars override that plugin entry's `config` fields.

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_A2A_ENABLED` | plugin `config.enabled` | Canonical enable flag for the A2A provider, matching other channels. Wins over the legacy form below when both are set. |
| `MONO_AGENT_A2A_PROVIDER_ENABLED` | plugin `config.provider.enabled` | Legacy enable flag (still honored). Prefer `MONO_AGENT_A2A_ENABLED`. |
| `MONO_AGENT_A2A_HOST` | plugin `config.provider.host` | Provider bind host. Non-loopback values require `allowNonLoopback`. |
| `MONO_AGENT_A2A_PORT` | plugin `config.provider.port` | Provider listen port. |
| `MONO_AGENT_A2A_PUBLIC_BASE_URL` | plugin `config.provider.publicBaseUrl` | Public base URL advertised in the Agent Card when fronted by a proxy. |
| `MONO_AGENT_A2A_ALLOW_NON_LOOPBACK` | plugin `config.provider.allowNonLoopback` | Explicit opt-in for a non-loopback bind or public base URL. |
| `MONO_AGENT_A2A_REQUIRE_BEARER` | plugin `config.provider.requireBearer` | Requires bearer authentication on message/task endpoints. |
| `MONO_AGENT_A2A_BEARER_TOKEN` | plugin `config.provider.bearerToken` | Used when `requireBearer` is set. See [A2A channel configuration](/channels/a2a/). |
| `MONO_AGENT_A2A_MAX_REQUEST_BYTES` | plugin `config.provider.maxRequestBytes` | Optional JSON request-body ceiling for JSON-RPC and REST; 1024–100000000 bytes. |
| `MONO_AGENT_A2A_IDEMPOTENCY_NAMESPACE` | plugin `config.provider.idempotency.namespace` | Explicitly enables durable keyed dispatch and defines its stable authenticated-principal boundary. |
| `MONO_AGENT_A2A_IDEMPOTENCY_STATE_DIR` | plugin `config.provider.idempotency.stateDir` | Optional durable receipt directory; a namespace-derived owner-only path is used when omitted. |
| `MONO_AGENT_A2A_IDEMPOTENCY_RETENTION_MS` | plugin `config.provider.idempotency.retentionMs` | Full terminal-result replay horizon; defaults to 30 days. |
| `MONO_AGENT_A2A_IDEMPOTENCY_MAX_RECORDS` | plugin `config.provider.idempotency.maxRecords` | Hard lifetime unique-key capacity; existing bindings are never evicted. |
| `MONO_AGENT_A2A_AGENT_NAME` | plugin `config.agent.name` | Public Agent Card name; wins over the root agent name. |
| `MONO_AGENT_A2A_AGENT_DESCRIPTION` | plugin `config.agent.description` | Agent Card description. |
| `MONO_AGENT_A2A_AGENT_VERSION` | plugin `config.agent.version` | Agent Card version string. |
| `MONO_AGENT_A2A_PROVIDER_ORGANIZATION` | plugin `config.agent.providerOrganization` | Provider organization advertised only when `providerUrl` is also set. |
| `MONO_AGENT_A2A_PROVIDER_URL` | plugin `config.agent.providerUrl` | Provider organization URL advertised only when `providerOrganization` is also set. |
| `MONO_AGENT_A2A_SKILL_ID` | plugin `config.skill.id` | Advertised skill identifier. |
| `MONO_AGENT_A2A_SKILL_NAME` | plugin `config.skill.name` | Advertised skill name. |
| `MONO_AGENT_A2A_SKILL_DESCRIPTION` | plugin `config.skill.description` | Advertised skill description. |
| `MONO_AGENT_A2A_SKILL_TAGS` | plugin `config.skill.tags` | Comma-separated advertised skill tags. |
| `MONO_AGENT_A2A_REMOTE_AGENT_URLS` | plugin `config.consumer.remoteAgentUrls` | Comma-separated allowlist of remote A2A agent base URLs. |
| `MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL` | plugin `config.consumer.defaultRemoteAgentUrl` | Default remote A2A agent base URL. |
| `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` | plugin `config.consumer.bearerToken` | Bearer token sent by the programmatic consumer. Keep it in `.env`. |
| `MONO_AGENT_A2A_TIMEOUT_MS` | plugin `config.consumer.timeoutMs` | Per-request consumer timeout in milliseconds. |

### Cron

| Env var | JSON key it overrides | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_ENABLED` | `cron.enabled` | Enable the legacy/default single-job form; default `false`. |
| `MONO_AGENT_CRON_EXPRESSION` | `cron.expression` | Five-field expression for the default single job. |
| `MONO_AGENT_CRON_TIMEZONE` | `cron.timezone` | IANA timezone for the default single job; default `UTC`. |
| `MONO_AGENT_CRON_PROMPT` | `cron.prompt` | Prompt for the default single job. |
| `MONO_AGENT_CRON_CONVERSATION_ID` | `cron.conversationId` | Optional stable conversation id for the default single job. |
| `MONO_AGENT_CRON_NOTIFY` | `cron.notify` | Deliver the default job's successful result natively; default `false`. |
| `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID` | `cron.notifyConversationId` | Explicit native-notification destination for the default job. |
| `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` | `cron.notifyFailureCooldownHours` | Single-job cooldown, in hours, for all-models-failed error notices on `notify: true` cron jobs; default `6`. |
| `MONO_AGENT_CRON_MODEL` | `cron.model` | Runtime model override for the default single job. |
| `MONO_AGENT_CRON_EFFORT` | `cron.effort` | Reasoning-effort override for the default single job, subject to model support. |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. Folder and config jobs merge; duplicate ids error. See [cron channel configuration](/channels/cron/). |
