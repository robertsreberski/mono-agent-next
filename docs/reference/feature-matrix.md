---
title: "Feature matrix"
description: "Scan mono-agent capabilities by coverage type, config key, environment variable, guide, and playbook."
sidebar:
  order: 2
---

A scannable projection of every mono-agent capability for non-linear readers: each feature id mapped to its coverage type, the config key(s) and env var(s) that reach it, the prose page that explains it, and any playbook that puts it to work.

[`docs/reference/feature-registry.md`](/reference/feature-registry/) is the canonical long-form source of truth — when this matrix and the registry disagree, the registry wins. This page projects the same rows into a grid for quick lookup.

## Coverage legend

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json`; an env override exists only where one is listed (`--` means JSON-only / no env form) |
| `cli` | Reached through a `mono-agent` CLI flag/command |
| `auto` | Always active when the app runs; needs no declaration |
| `code` | Programmatic escape hatch only — see [Programmatic API](/programmatic/) |
| `dev` | Development/test-time tooling, not part of a running agent |

Env precedence everywhere: process env > `mono-agent.config.json` > built-in defaults.

## Runtime

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `runtime.multi-backend` | config | `runtime.model` | `MONO_AGENT_MODEL` | [Backends](/runtime/backends/) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.execution-modes` | config | `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | [Backends](/runtime/backends/) | — |
| `runtime.fallback-models` | config | `runtime.fallbacks[].{model,effort?}`; legacy `runtime.fallbackModels`; CLI uses repeated `--fallback` (legacy `--fallback-models` flag removed) | `MONO_AGENT_FALLBACKS_JSON`; legacy `MONO_AGENT_FALLBACK_MODELS` remains supported | [Fallback](/runtime/fallback/) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.route-safety` | config | `runtime.routeSafety` | `MONO_AGENT_ROUTE_SAFETY` | [Fallback](/runtime/fallback/#route-safety) | [Multi-model fallback](/playbooks/multi-model-fallback-chain/) |
| `runtime.effort` | config | `runtime.effort`, `runtime.fallbacks[].effort` | `MONO_AGENT_EFFORT`, `MONO_AGENT_FALLBACKS_JSON` | [Execution, effort, permissions](/runtime/execution-effort-permissions/) | — |
| `runtime.per-trigger-model` | config + code | `cron.jobs[].{model,effort}`; `webhook.endpoints[].{model,effort}` + request body `{model,effort}`; Telegram built-ins `/model` and `/effort`; Slack Block Kit selectors through thread-local `@agent /model` / `@agent /effort` and channel-wide workspace commands `/<bot>-model` / `/<bot>-effort`, all over configured primary/fallback models | `MONO_AGENT_CRON_MODEL` / `MONO_AGENT_CRON_EFFORT`, `MONO_AGENT_WEBHOOK_MODEL` / `MONO_AGENT_WEBHOOK_EFFORT`; Telegram/Slack controls have no env key | [Cron](/channels/cron/#per-trigger-model--effort) · [Webhook](/channels/webhook/#per-trigger-model--effort) · [Telegram](/channels/telegram/#runtime-model-and-effort-controls-built-in) · [Slack](/channels/slack/#runtime-model-and-effort-controls-built-in) | — |
| `runtime.permission-mode` | config | `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | [Execution, effort, permissions](/runtime/execution-effort-permissions/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `runtime.max-turns` | config | `runtime.maxTurns` (direct OpenCode rejects positive values because it has no enforceable hard cap) | `MONO_AGENT_MAX_TURNS` | [Backends](/runtime/backends/) | — |
| `runtime.workspace` | config | `runtime.workspace` | `MONO_AGENT_WORKSPACE` | [Backends](/runtime/backends/) | — |
| `runtime.provider-sessions` | config | `runtime.session.mode`, `runtime.session.idleTimeoutMs`, `runtime.session.rollover`, `runtime.session.rolloverTimezone`, `runtime.session.rolloverNotice` | `MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`, `MONO_AGENT_SESSION_ROLLOVER`, `MONO_AGENT_SESSION_ROLLOVER_TIMEZONE`, `MONO_AGENT_SESSION_ROLLOVER_NOTICE` | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.concurrency` | config | `concurrency.maxConcurrentRuns`, `concurrency.maxPendingRuns` | `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`, `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.local-providers` | config | `providers.local[]` | `MONO_AGENT_LOCAL_PROVIDERS_JSON`, `MONO_AGENT_LOCAL_PROVIDER_*` | [Local providers](/runtime/local-providers/) | [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) |
| `runtime.pi-credentials` | config | `providers.piAuthPath` (OAuth/account and API-key credentials such as OpenCode-Go) | `MONO_AGENT_PI_AUTH_PATH` | [Local providers](/runtime/local-providers/) | — |
| `runtime.pi-native-tuning` | config | `providers.piNative.transport`, `providers.piNative.piMaxRetries`, `providers.piNative.maxRetryDelayMs`, `providers.piNative.piSessionsRoot` | `MONO_AGENT_PI_TRANSPORT`, `MONO_AGENT_PI_MAX_RETRIES`, `MONO_AGENT_MAX_RETRY_DELAY_MS`, `MONO_AGENT_PI_SESSIONS_ROOT` | [Sessions & concurrency](/runtime/sessions-concurrency/) | — |
| `runtime.tool-parallelism` | code | `runtimeOptions.piToolParallelismMode` | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.webfetch-retry` | auto | (built into WebFetch) | — | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.context-compaction` | config + provider | `runtime.compaction.*` | `MONO_AGENT_COMPACTION_*` | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.tool-bloat-guard` | auto | (artifacts land in `artifacts.dir`) | `MONO_AGENT_ARTIFACT_DIR` | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.cost-tracking` | auto | (recorded in JSONL artifacts) | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `runtime.builtin-tools` | config | `tools.allowedTools`, `tools.disallowedTools` | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Tools & guards](/runtime/tools-and-guards/) | — |
| `runtime.structured-output` | code | `runtimeOptions.outputSchema` (capable backends; direct OpenCode rejects) | — | [Approval & structured output](/programmatic/approval-and-structured-output/) | — |
| `runtime.live-input` | auto + code | Slack/Telegram/web active-turn steering plus completed safe-preview `Steered` activity after provider acknowledgement; custom `runtimeOptions.liveInput` (capable backends; direct OpenCode and Claude CLI fall back or reject) | — | [Approval & structured output](/programmatic/approval-and-structured-output/#live-input-steering) | — |
| `runtime.approval-gates` | code | `createMonoRuntime({ onToolApprovalRequest, ... })` (config posture: `runtime.permissionMode`) | `MONO_AGENT_PERMISSION_MODE` | [Approval & structured output](/programmatic/approval-and-structured-output/) | — |
| `runtime.custom` | code | `startMonoAgentApp({ runtime })` | — | [Composition](/programmatic/composition/) | — |

## Sandbox

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `sandbox.mode` | config | `sandbox.mode` | `MONO_AGENT_SANDBOX_MODE` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.network-policy` | config | `sandbox.network.mode`, `sandbox.network.allowlist` | `MONO_AGENT_SANDBOX_NETWORK`, `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.filesystem-scopes` | config | `sandbox.readableRoots`, `sandbox.writableRoots`, `sandbox.denyWrite` | `MONO_AGENT_SANDBOX_READABLE_ROOTS`, `MONO_AGENT_SANDBOX_WRITABLE_ROOTS`, `MONO_AGENT_SANDBOX_DENY_WRITE` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.fallback` | config | `sandbox.fallback`, `sandbox.unsafeAllowHostProcess` | `MONO_AGENT_SANDBOX_FALLBACK`, `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |
| `sandbox.monotonic-merge` | auto | (harness merges configured + request policies) | — | [Sandbox](/tools/sandbox/) | — |
| `sandbox.managed-srt` | cli + auto | `mono-agent sandbox status\|setup\|check`; automatic managed runtime resolution | — | [Sandbox](/tools/sandbox/) | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |

## Memory

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `memory.lite` | config | `memory.mode: "lite"`, `memory.path`, `memory.maxBytes`, `memory.writeMode` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_WRITE_MODE` | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.journal` | config | `memory.mode: "journal"`, `memory.path`, `memory.embeddings.{provider,model,dim}` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_EMBEDDINGS_*` | [Embeddings](/memory/embeddings/) | — |
| `memory.bujo` | config | `memory.mode: "bujo"`, `memory.path`, `memory.embeddings.{provider,model,dim}`, `memory.llm.{provider,model,executionMode,endpoint}` | `MONO_AGENT_MEMORY_MODE`, `MONO_AGENT_MEMORY_EMBEDDINGS_*`, `MONO_AGENT_MEMORY_LLM_*` | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.backend-supermemory` | config | `memory.backend: "supermemory"`, `memory.writeMode`, `memory.supermemory.{baseUrl,apiKey,apiKeyEnv,container,timeoutMs,exposeMcpServer}`; exact matching `@mono-agent/memory-supermemory` plugin required | `MONO_AGENT_MEMORY_BACKEND`, `MONO_AGENT_MEMORY_SUPERMEMORY_*` | [Backends comparison](/memory/backends-comparison/) | [Telegram + Supermemory](/playbooks/telegram-supermemory-memory/) |
| `memory.bujo-consolidation` | config | `memory.consolidation.{enabled,cron}` | `MONO_AGENT_MEMORY_CONSOLIDATION_CRON`, `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | [Consolidation](/memory/rituals/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.bujo-cli` | cli | **Removed** — use config-aware `mono-agent memory <subcommand>` from the agent folder | — | [Validation & CLI](/memory/validation-and-cli/#memory-bujo-cli--removed) | — |
| `memory.preview-cli` | cli | `mono-agent memory stats\|today\|show <date>\|search <query>\|top\|audit\|rebuild\|rollback [--limit <n>] [--json]`; owner-only `forget prepare\|apply\|restore` | — | [Validation & CLI](/memory/validation-and-cli/) | — |
| `memory.validate` | cli | `mono-agent validate [--consumer] [--config]` | — | [Validation & CLI](/memory/validation-and-cli/) | — |
| `memory.write-mode` | config | `memory.writeMode` | `MONO_AGENT_MEMORY_WRITE_MODE` | [Capture & recall](/memory/capture-and-recall/) | — |
| `memory.per-turn-capture` | config | `memory.writeMode: "capture"` (requires `memory.mode: "bujo"`) | `MONO_AGENT_MEMORY_WRITE_MODE=capture`, `MONO_AGENT_MEMORY_MODE=bujo` | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.recall-tool` | config | `memory.recallTool.enabled` | `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | [Capture & recall](/memory/capture-and-recall/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `memory.llm-timeout` | config | `memory.llm.timeoutMs` (in-app; 1000–600000, default 60000) | `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | [Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout) | — |
| `memory.custom-store` | code | `createConfiguredAgentResponder({ memory })` | — | [Composition](/programmatic/composition/) | — |

:::note
The entity graph that BuJo capture maintains is part of the BuJo capture pipeline; see [Capture & recall](/memory/capture-and-recall/#entity-graph-bujo-auto).
:::

## Context & skills

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `agent.public-name` | config | `agent.name` | `MONO_AGENT_NAME` | [Identity & soul](/context/identity-and-soul/#public-agent-name) | — |
| `context.identity` | config | `context.identityPath` | `MONO_AGENT_IDENTITY_PATH` | [Identity & soul](/context/identity-and-soul/) | — |
| `context.soul` | config | `context.soulPath` | `MONO_AGENT_SOUL_PATH` | [Identity & soul](/context/identity-and-soul/) | — |
| `context.history` | auto | (owner-only disk-backed store; 64 messages per exact conversation id independent of `runtime.maxTurns`; aggregate committed defaults 256 MiB / 10,000 conversations / 365 inactive days plus an independent 256 MiB live-stage cap; staged atomic publication, immediate markerless-stage recovery, fixed-shard cross-process locking, bounded pre-provider dirty-fence retirement journals, provider epoch/revision coordination, exact-id durable transcript retirement, and post-commit pruning; custom store via `code`; completed blocking asks retain a bounded interaction transcript) | — | [Assembly](/context/assembly/) | — |
| `skills.selected-activation` | config | `context.skillsRoot`, `context.selectedSkills` | `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS` | [Skills](/context/skills/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `skills.byte-capping` | config | `context.skillMaxBytes` | `MONO_AGENT_SKILL_MAX_BYTES` | [Skills](/context/skills/) | — |

## Tools & MCP

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `tool-policy.allow-all` | config | omitted / `["*"]` = all tools (default; risk disclosed and reconfirmed unsandboxed in guided init) | `MONO_AGENT_ALLOWED_TOOLS` | [Tool policy](/tools/policy/) | — |
| `tool-policy.allowlist` / `tool-policy.denylist` | config | runtime-specific enforcement; direct Codex/OpenCode require exact allow-all; Claude Code CLI rejects explicit empty | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Tool policy](/tools/policy/) | — |
| `tool-policy.mcp-servers` | config | `tools.mcpConfigPath` | `MONO_AGENT_MCP_CONFIG_PATH` | [MCP](/tools/mcp/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `agent-app.durable-continuations` | config + code | `tools.continuationServers`, `continuations.{enabled,host,port,stateDir,namedRoutes,detachedServices}` | `MONO_AGENT_CONTINUATION_SERVERS`; detached bearer env names are operator-selected | [Durable continuations](/tools/durable-continuations/) | — |
| `agent-app.run-history-tool` | auto | Guided list/search plus compact, cursor-paged inspect over one logical conversation; daily rollover-independent. `RunHistory` under allow-all; restrictive policy explicitly lists `RunHistory` (legacy policy alias `run_history`); no new config key | `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `agent-app.adapter-send-tools` | config | auto-available under allow-all once the channel is enabled; a specific `tools.allowedTools` needs the exact names (`SlackSendMessage`, `TelegramSendMessage`) + valid `slack.*` / `telegram.*` config; confirmed posts are idempotently recorded in destination history | `MONO_AGENT_ALLOWED_TOOLS` | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `interaction.bridge` | config + auto | `interaction.bridge.{host,port}`, `interaction.askUser.timeoutMs`, `interaction.progress.enabled`, `tools.mcpRequestContextServers`; auto-starts for configured send tools, allowed structured `AskUser`, configured interaction JSON/env, or enabled opted project-MCP progress | `MONO_AGENT_INTERACTION_BRIDGE_HOST`, `MONO_AGENT_INTERACTION_BRIDGE_PORT`, `MONO_AGENT_ASK_USER_TIMEOUT_MS`, `MONO_AGENT_PROGRESS_ENABLED`, `MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS` | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Interactive transcription](/playbooks/interactive-transcription-large-media/) |

## Channels

Built-in channels are independent JSON sections: `telegram`, `slack`, `webhook`, `openaiApi`, `cron`, `tui`, and `live`. External channel packages are declared under `channels.plugins[]` and return the same `ChannelDriver` shape; the current cataloged channel extras are `@mono-agent/a2a-adapter` and `@mono-agent/whatsapp-adapter`. Most are opt-in via an `enabled` flag (default off); `tui` and `live` are default-on loopback operator surfaces. An off channel reports `disabled`; an enabled channel with incomplete config reports `waiting_for_config`. Adapter fields can also have `MONO_AGENT_<CHANNEL>_*` env vars.

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `telegram.long-polling` | config | `telegram.enabled`, `telegram.botToken`, `telegram.allowedChatIds` / `telegram.allowAllChats`, `telegram.pollWatchdogMs`, `telegram.transport.ipFamily` (+ built-in self-healing restart) | `MONO_AGENT_TELEGRAM_BOT_TOKEN`, `MONO_AGENT_TELEGRAM_*` | [Telegram](/channels/telegram/) | [Telegram BuJo assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `telegram.interactive` | config + code | built-in `/new`, plus `/model` and `/effort` via adapter `runtimeControls`; `telegram.commands[]`, `telegram.reactions`, `telegram.quietHours`; structured `AskUser` buttons/custom replies, non-blocking `TelegramSendMessage.reply_options`, and `TelegramSendFile` | `MONO_AGENT_TELEGRAM_REACTIONS`; runtime controls have no env key | [Telegram](/channels/telegram/) | — |
| `slack.ask-user` | auto + code | structured `AskUser` renders one Block Kit question at a time with option buttons, Other/custom thread reply, and multi-select Done; no Slack-specific config | — | [Slack](/channels/slack/#askuser-buttons-and-custom-replies) | — |
| `slack.socket-mode` | config | `slack.enabled`, `slack.botToken`, `slack.appToken`, `slack.allowedChannelIds` / `slack.allowAllChannels`, `slack.botUserIds`, `slack.mentionTextAliases`, `slack.stripMentionText`. When unset, defaults to `true` when `botUserIds` or `mentionTextAliases` is non-empty; otherwise `false`. Resilience tuning (all optional, on by default): `slack.heartbeatIntervalMs`, `slack.heartbeatTimeoutMs`, `slack.reconnectInitialBackoffMs`, `slack.reconnectMaxBackoffMs`, `slack.reconnectStabilityMs`, `slack.reconnectStartupGraceMs`, `slack.drainDeadlineMs` | `MONO_AGENT_SLACK_*` (incl. `MONO_AGENT_SLACK_HEARTBEAT_*`, `MONO_AGENT_SLACK_RECONNECT_*`, `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS`) | [Slack](/channels/slack/) | [Slack team bot + MCP tools](/playbooks/slack-team-bot-mcp-tools/) |
| `slack.shortcuts` | config | `slack.shortcuts[]: {callbackId, prompt, channelId?, ackText?, threadReply?}` | — (JSON-only; no environment-variable form) | [Slack shortcuts](/channels/slack/#shortcuts) | — |
| `slack.app-home` | config | `slack.homeTab: {enabled?, headerText?, buttons?:[{actionId, label, prompt, channelId?, ackText?, threadReply?}]}`; `enabled` defaults `false`, `buttons` defaults `[]` | — (JSON-only; no environment-variable form) | [Slack App Home](/channels/slack/#app-home) | — |
| `channel.plugins` | config | `channels.plugins[]: { package, id?, label?, config? }` | — | [Write your own channel adapter](/programmatic/custom-channels/) | — |
| `whatsapp.baileys` | config | `channels.plugins[].package: "@mono-agent/whatsapp-adapter"` plus plugin `config.{enabled,allowedChatJids,allowAllChats,groupMode,botJids,mentionTextAliases,stripMentionText}`. When unset, defaults to `true` only when `mentionTextAliases` is non-empty; `botJids` alone does not enable stripping, so otherwise it defaults to `false`. | `MONO_AGENT_WHATSAPP_*` | [WhatsApp](/channels/whatsapp/) | — |
| `webhook.http-invoke` | config | `webhook.enabled`, `host`, `port`, `path`, `prompt`, `notify`, `notifyConversationId`, `defaultMode`, `allowNonLoopback`, `apiKey`, `retentionMs`, `maxStoredRequests`, `maxRunMs`, `webhook.endpoints[]` (incl. per-endpoint `model`/`effort`/`maxRunMs`; a request body may set `model`/`effort`, request winning over endpoint config; endpoint `maxRunMs` wins over the adapter fallback), `webhook.dir`; a non-loopback bind requires opt-in + bearer key | `MONO_AGENT_WEBHOOK_*` (incl. `MONO_AGENT_WEBHOOK_API_KEY`, `MONO_AGENT_WEBHOOK_MODEL`, `MONO_AGENT_WEBHOOK_EFFORT`, `MONO_AGENT_WEBHOOK_MAX_RUN_MS`), `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON`, `MONO_AGENT_WEBHOOK_DIR` | [Webhook](/channels/webhook/) | [Webhook automation (sync/async)](/playbooks/webhook-automation-sync-async/) |
| `openai-api.chat-completions` | config | `openaiApi.enabled`, `host`, `port`, `basePath`, `allowNonLoopback`, `apiKey`, `modelId`; non-loopback requires opt-in + key and wildcard binds report concrete client URLs | `MONO_AGENT_OPENAI_API_{ENABLED,HOST,PORT,BASE_PATH,ALLOW_NON_LOOPBACK,KEY,MODEL_ID}` | [OpenAI-compatible API](/channels/openai-api/) | [OpenAI endpoint + Open WebUI](/playbooks/openai-endpoint-open-webui/) |
| `a2a.provider` | config | `channels.plugins[].package: "@mono-agent/a2a-adapter"` plus plugin `config.provider.*` (including `maxRequestBytes`; durable identity: `provider.idempotency.{namespace,stateDir,retentionMs,maxRecords}`), `config.agent.*`, `config.skill.*` | `MONO_AGENT_A2A_*` | [A2A](/channels/a2a/) | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `a2a.consumer` | config + code | plugin `config.consumer.{remoteAgentUrls,defaultRemoteAgentUrl,bearerToken,timeoutMs}`; `sendA2AMessage({idempotencyKey})` or `createA2AConsumerResponder({idempotencyKeyForRequest})` | `MONO_AGENT_A2A_*` | [A2A consumer](/programmatic/a2a-consumer/) | [A2A provider & consumer](/playbooks/a2a-provider-and-consumer/) |
| `tui.stream-endpoint` | config | `tui.{enabled,host,port,basePath,allowNonLoopback,apiKey}` — **on by default** (loopback TUI/web operator surface; `/v1/info` advertises additive attachment, verbatim-history, and structured AskUser capabilities) | `MONO_AGENT_TUI_*` | [Operator stream endpoint](/channels/tui/) | — |
| `cron.scheduled-prompts` | config | `cron.jobs[]: {id, enabled, expression, timezone, prompt, conversationId, maxRunMs, notify, notifyConversationId, notifyFailureCooldownHours, model, effort}`, `cron.dir` | `MONO_AGENT_CRON_JOBS_JSON`, `MONO_AGENT_CRON_*` (incl. `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS`, `MONO_AGENT_CRON_MODEL`, `MONO_AGENT_CRON_EFFORT`), `MONO_AGENT_CRON_DIR` | [Cron](/channels/cron/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `cron.run-watchdog` | config + code | `jobs[].maxRunMs` or `maxRunMs` frontmatter; programmatic fallback via `startCronAdapter` | — | [Cron](/channels/cron/#run-watchdog-a-wedged-run-is-aborted-not-left-to-starve) | — |
| `channel.native-notify` | config | per cron job / webhook endpoint `notify`; explicit `notifyConversationId` wins, including exact `web:new` for one new marked web thread per result; web is never inferred and other `web:*` values reject; otherwise infer only with exactly one notify-capable Telegram/Slack candidate; 0 or 2+ candidates skip with a warning; cron model-exhaustion notices require explicit `notifyConversationId`, never infer, and may set `notifyFailureCooldownHours`; Telegram/Slack stay bounded by channel allowlists, while web requires the running local console and is one-attempt/no-outbox | `MONO_AGENT_CRON_NOTIFY`, `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID`, `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` (+ webhook equivalents except cooldown) | [Delivery & send tools](/channels/delivery-and-send-tools/) | [Cron digest + native notify](/playbooks/cron-digest-proactive-notify/) |
| `channel.final-only-delivery` | code | Adapter `stream.finalOnly` (default `true` for telegram/slack; answer deltas stay hidden while a transient tool ledger may be visible) | — | [Delivery & send tools](/channels/delivery-and-send-tools/) | — |
| `channel.transient-tool-activity` | code | `ResilientMessageStream({ finalOnly: true, showHints: true })`; proactive delivery forces `showHints: false`; Telegram and Slack post the answer separately then best-effort delete progress; optional transport deletion also supports `/cancel` cleanup | — | [Delivery & send tools](/channels/delivery-and-send-tools/) | — |
| `channel.stream-tuning` | code | Adapter `stream` / `messages` options (`createTelegramChannelDriver` etc.) | — | [Write your own channel adapter](/programmatic/custom-channels/) | — |
| `channel.custom` | config + code | `channels.plugins[]` package loading or `startMonoAgentApp({ drivers })` (implement `ChannelDriver`) | — | [Write your own channel adapter](/programmatic/custom-channels/) | — |

## Observability

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `observability.jsonl-artifacts` | config | `artifacts.dir`, `artifacts.retention.{maxAgeDays,maxCount,dryRun}`, `artifacts.memoryRetention.{maxAgeDays,maxCount,dryRun}` | `MONO_AGENT_ARTIFACT_*` | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.latency-attribution` | auto | (emitted into run JSONL artifacts) | — | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.trace-registry` | config | `traceability.{registryDir,sourceId,sourceLabel,heartbeatMs,staleAfterMs}` | `MONO_AGENT_TRACE_*` | [Artifacts & traces](/observability/artifacts-and-traces/) | — |
| `observability.phoenix-exporter` | config | `observability.exporters[]: {type:"phoenix", endpoint, projectName, includeSensitiveData, contentPatternRedaction, headers, timeoutMs}` | `MONO_AGENT_OBSERVABILITY_EXPORTERS` | [Phoenix & backfill](/observability/phoenix-and-backfill/) | [Phoenix-observed agent](/playbooks/phoenix-observed-agent/) |
| `observability.backfill` | cli | `mono-agent backfill (--run <id> \| --all) [--since] [--until] [--dry-run]` | — | [Phoenix & backfill](/observability/phoenix-and-backfill/) | [Backfill historical runs](/playbooks/backfill-historical-runs/) |
| `observability.artifact-audit` | cli / code | `auditRecordedRuns(artifactDir, { staleAfterMs })`; `mono-agent runs audit [--artifacts <path> \| --consumer <path>] [--json]` | — | [Artifacts & traces](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation) | — |
| `observability.artifact-metrics` | cli / code | `summarizeRecordedRunMetrics({ artifactDir, since, until, groupBy })`; `mono-agent runs report [--artifacts] [--since] [--until] [--by] [--json]` | — | [Artifacts & traces](/observability/artifacts-and-traces/#artifact-metrics) | — |
| `observability.rich-traces` | auto | (model / token counts / cost / duration on every span; system prompt gated by `includeSensitiveData`; memory runs get `span.kind=memory` + `memory.operation`) | — | [Phoenix & backfill](/observability/phoenix-and-backfill/#per-run-attributes) | — |
| `observability.stale-run-reconciliation` | auto | (`reconcileStaleRunArtifacts()` at startup over `artifacts.dir`; rewrites orphaned `running` → `interrupted`) | — | [Artifacts & traces](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation) | — |
| `tui.chat` | cli | `mono-agent tui [--agent <label\|sourceId>] [--conversation <id>]`; low-level `mono-agent-tui [--responder \| --url]` | `MONO_AGENT_TUI_API_KEY` (connect key) | [TUI](/observability/tui/) | — |
| `web.console` | cli | `mono-agent web [start|restart|stop|status|logs|run|reset]`; default `0.0.0.0:5050`; `--loopback`; persistent source-bound threads, streamed turns, atomic structured AskUser forms, archive/reset, browser-device attachments, conflict-safe Tailscale Serve HTTPS | — (no application auth; trusted LAN/tailnet boundary) | [Web console](/observability/web-console/) | — |

## Execution & composition

| Feature id | Coverage | Config key(s) | Env var(s) | Prose page | Playbook(s) |
| --- | --- | --- | --- | --- | --- |
| `app.cli-init` | cli | `--name`, exact `IDENTITY.md` → `## Role` prompt/outcome, managed project skills, `--preset` (legacy `--recipe` removed), canonical repeated `--fallback`/`--fallback-effort` (legacy `--fallback-models` removed), `--route-safety`, `--codex-auth`; any flag/non-TTY remains scaffold-only | — | [Quickstart](/getting-started/quickstart/) | — |
| `app.cli-setup` | cli | bare TTY `mono-agent init`: searchable catalogs, Escape-back, concrete review, all-route proof, interrupt resume/restart; macOS starts the background agent before remote persistent SELF-CONFIG, unsupported platforms stay manual | — | [CLI reference](/observability/cli-reference/#init) | — |
| `app.secure-secret-persistence` | cli | fail-closed owner-only `.env` merge + external lock + pathname no-clobber/recovery checks; Windows manual only | channel/provider-native secret vars | [Env vars](/config/env-vars/) | — |
| `app.provider-auth` | cli | `mono-agent auth login <provider\|codex> [--pi-auth-path] [--api-key-stdin] [--codex-auth browser\|device]` | `MONO_AGENT_PI_AUTH_PATH` | [CLI reference](/observability/cli-reference/#auth-login) | — |
| `app.cli-presets` | cli | `mono-agent presets list \| show <id>` (old `recipes` alias removed) | — | [Presets & modules](/reference/presets/) | — |
| `app.cli-no-tools-guardrail` | cli | part of `mono-agent validate` / `doctor`; the tools step of `mono-agent init` | — | [Presets & modules](/reference/presets/#the-tools-step-and-the-no-tools-guardrail) | — |
| `app.cli-validate` | cli | `mono-agent validate [--consumer] [--config] [--env-file]` | — | [Blueprint](/config/blueprint/) | — |
| `app.provider-credentials-check` | cli | part of `mono-agent validate`; primary/fallback/memory/enabled static trigger refs; exact Pi built-in model + `providers.piAuthPath`, or custom model/key contract through `providers.local[]` | `MONO_AGENT_PI_AUTH_PATH`, `MONO_AGENT_LOCAL_PROVIDERS_JSON` | [CLI reference](/observability/cli-reference/#provider-credentials) | — |
| `app.cli-start` | cli | `mono-agent start [--config] [--env-file] [--foreground]` | — | [Install](/getting-started/install/) | — |
| `app.cli-stop` | cli | `mono-agent stop [--config]` | — | [Install](/getting-started/install/) | — |
| `app.cli-logs` | cli | `mono-agent logs [--config] [--follow\|-f] [--lines <n>]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.cli-restart-clean` | cli | `mono-agent restart [--config] [--clear-sessions]` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.local-conversational-config` | cli + tool | macOS `mono-agent tui --configure` against the managed background agent; persistent marked session and capability map; stable configuration conversation with rotated proposal capability; request-scoped `ProposeAgentConfiguration`; incremental host approval/restart/ready-source swap or rollback/recovery; only quitting exits; `--local` is ordinary chat only | — | [CLI reference](/observability/cli-reference/#tui) | — |
| `app.managed-project-skills` | cli + config | generated selected skills; `mono-agent install-skill --project --check\|--update` | `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS`, `MONO_AGENT_SKILL_DISCLOSURE` | [Skills](/context/skills/) | — |
| `app.docs-mcp-companion` | cli + code | `mono_agent_docs({action: "search", query, limit?, scope?})`; `mono_agent_docs({action: "read", target})`; expanded `mono-agent-docs://chunk/{chunkId}` resources | — | [Documentation MCP companion](/tools/documentation-mcp/) | — |
| `app.cli-install-skill` | cli | `mono-agent install-skill [--target claude\|codex\|both] [--force] [--no-docs-mcp]`; `--project (--check\|--update)` | — | [CLI reference](/observability/cli-reference/) | — |
| `app.cli-web` | cli | bare read-only status/help; `web start\|restart\|stop\|status\|logs\|run\|reset`; `--host <addr> \| --loopback`, `--port <n>`; reset requires `--all --yes` | — | [Web console](/observability/web-console/) | — |
| `app.env-file` | cli | automatic; `--env-file <path>` to override | — | [Env vars](/config/env-vars/) | — |
| `harness.failure-handling` | auto | (built into every run) | — | [Composition](/programmatic/composition/) | — |
| `harness.external-summary-safety` | auto | public harness/webhook summaries exclude `systemPrompt`; private artifacts retain it | — | [Artifacts & traces](/observability/artifacts-and-traces/) | [Webhook automation](/playbooks/webhook-automation-sync-async/) |
| `agent-app.blocking-ask-history` | auto | app interaction journal + configured harness history commit; no config key | — | [Assembly](/context/assembly/#conversation-history) | [Interactive long jobs](/playbooks/interactive-transcription-large-media/) |
| `harness.request-runtime-options` | code | `createConfiguredAgentResponder({ runtimeOptionsForRequest })` | — | [Composition](/programmatic/composition/) | — |
| `orchestrator.ask-collaborator` | code | `createCollaboratorToolRuntimeExtension` + `runtimeOptionsForRequest` | — | [Multi-agent](/programmatic/multi-agent/) | [Multi-agent orchestration](/playbooks/multi-agent-orchestration/) |
## Notes on coverage types

A `code`-only feature has no `mono-agent.config.json` key — you reach it through `startMonoAgentApp` options or lower-level packages. See [Programmatic API](/programmatic/) for the entry points referenced above (`createConfiguredAgentResponder`, `createMonoRuntime`, `createCollaboratorToolRuntimeExtension`, custom `ChannelDriver`/`runtime`/`memory`/`historyStore` injection).

:::note
Two registry rows carry a non-standard coverage label: `runtime.context-compaction` is `config + provider` (configured through `runtime.compaction.*`, executed by the pi bridge) and `a2a.consumer` is `config + code` (settings live in plugin config, but invoking remote agents is programmatic).
:::
