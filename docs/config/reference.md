---
title: "Generated config reference"
description: "Complete generated reference for mono-agent.config.json fields, environment overrides, defaults, examples, and plugin-channel envelopes."
sidebar:
  order: 4
---

This page is generated from the same config field registries that power `mono-agent config`, recipe output, and the JSON Schema. Do not edit this table by hand; run `pnpm run generate:config-reference`.

Schema: `https://raw.githubusercontent.com/robertsreberski/mono-agent/main/packages/agent-app/schema/mono-agent.config.schema.json`

| JSON key | Type | Env override | Default | Example | Notes |
| --- | --- | --- | --- | --- | --- |
| `agent.name` | `string` | `MONO_AGENT_NAME` | unset | `Research Partner` | Public display identity used for trace labels and default A2A metadata; never used in paths or service ids. |
| `artifacts.dir` | `string` | `MONO_AGENT_ARTIFACT_DIR` | .mono-agent/artifacts | `.mono-agent/artifacts` | Configures dir for the artifacts section. |
| `artifacts.memoryRetention.dryRun` | `boolean` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN` | false | `true` | Configures memoryRetention.dryRun for the artifacts section. |
| `artifacts.memoryRetention.maxAgeDays` | `integer` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS` | 7 | `7` | Configures memoryRetention.maxAgeDays for the artifacts section. |
| `artifacts.memoryRetention.maxCount` | `integer` | `MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT` | 5000 | `5000` | Configures memoryRetention.maxCount for the artifacts section. |
| `artifacts.retention.dryRun` | `boolean` | `MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN` | false | `true` | Configures retention.dryRun for the artifacts section. |
| `artifacts.retention.maxAgeDays` | `integer` | `MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS` | 365 | `365` | Configures retention.maxAgeDays for the artifacts section. |
| `artifacts.retention.maxCount` | `integer` | `MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT` | 50000 | `50000` | Configures retention.maxCount for the artifacts section. |
| `channels.plugins` | `array` | `--` | [] | `[{"package":"@mono-agent/whatsapp-adapter","config":{"enabled":true}}]` | External channel plugin envelopes loaded by package name. |
| `concurrency.maxConcurrentRuns` | `integer` | `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS` | unset | `1` | Configures maxConcurrentRuns for the concurrency section. |
| `concurrency.maxPendingRuns` | `integer` | `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS` | unset | `1` | Configures maxPendingRuns for the concurrency section. |
| `context.identityPath` | `string` | `MONO_AGENT_IDENTITY_PATH` | required | `./IDENTITY.md` | Configures identityPath for the context section. |
| `context.selectedSkills` | `string[]` | `MONO_AGENT_SELECTED_SKILLS` | [] | `["example"]` | Configures selectedSkills for the context section. |
| `context.skillDisclosure` | `string` | `MONO_AGENT_SKILL_DISCLOSURE` | full | `full` | Configures skillDisclosure for the context section. |
| `context.skillMaxBytes` | `integer` | `MONO_AGENT_SKILL_MAX_BYTES` | 48000 | `48000` | Configures skillMaxBytes for the context section. |
| `context.skillsRoot` | `string` | `MONO_AGENT_SKILLS_ROOT` | unset | `example` | Configures skillsRoot for the context section. |
| `context.soulPath` | `string` | `MONO_AGENT_SOUL_PATH` | unset | `example` | Configures soulPath for the context section. |
| `continuations.detachedServices` | `array` | `--` | [] | `[{"name":"work-control","tokenEnv":"WORK_CONTROL_CONTINUATION_TOKEN"}]` | Detached service names and the environment variable holding each bearer; raw tokens never belong in config. |
| `continuations.enabled` | `boolean` | `--` | true | `true` | Enables the host-owned durable continuation service when the block is configured. |
| `continuations.host` | `string` | `--` | 127.0.0.1 | `127.0.0.1` | Loopback bind host; non-loopback values are rejected. |
| `continuations.limits.deliveryTimeoutMs` | `integer` | `--` | 120000 | `120000` | Hard native-delivery and history-only commit timeout; ambiguous sends are never replayed automatically. |
| `continuations.limits.maxActivePerOrigin` | `integer` | `--` | 500 | `500` | Admission ceiling for one immutable run or detached-route claim origin. |
| `continuations.limits.maxActiveRecords` | `integer` | `--` | 10000 | `10000` | Global admission ceiling for non-terminal durable continuations. |
| `continuations.limits.maxConcurrent` | `integer` | `--` | 16 | `16` | Maximum independently tracked continuation workers; one hung provider cannot occupy the whole service. |
| `continuations.limits.operatorPageSize` | `integer` | `--` | 100 | `100` | Maximum keyset-paginated records returned by one operator list request. |
| `continuations.limits.synthesisTimeoutMs` | `integer` | `--` | 600000 | `600000` | Hard synthesis timeout; an ambiguous timeout is dead-lettered and never synthesized twice. |
| `continuations.namedRoutes` | `object` | `--` | {} | `{"verification":{"mode":"capture","conversationId":"slack:D123"}}` | Host-owned detached delivery policies: notify_if_actionable, capture, or silent. |
| `continuations.port` | `integer` | `--` | 4319 | `4319` | Fixed loopback continuation service port (1-65535); persisted result/status URLs and the operator CLI remain valid across restarts. |
| `continuations.retention.capturedTextMaxAgeMs` | `integer` | `--` | 2592000000 | `2592000000` | Maximum age in milliseconds for retained captured synthesis text. |
| `continuations.retention.capturedTextMaxRecords` | `integer` | `--` | 1000 | `1000` | Maximum delivered capture continuations whose synthesized text remains retrievable. |
| `continuations.retention.terminalMaxAgeMs` | `integer` | `--` | 31536000000 | `31536000000` | Maximum age in milliseconds for terminal continuation tombstones. |
| `continuations.retention.terminalMaxRecords` | `integer` | `--` | 50000 | `50000` | Maximum retained terminal metadata/idempotency tombstones after payload compaction. |
| `continuations.stateDir` | `string` | `--` | .mono-agent/continuations | `.mono-agent/continuations` | Owner-only per-record continuation store and token-derivation secret. |
| `cron.conversationId` | `string` | `MONO_AGENT_CRON_CONVERSATION_ID` | unset | `example` | Configures conversationId for the cron section. |
| `cron.dir` | `string` | `MONO_AGENT_CRON_DIR` | cron | `cron` | Configures dir for the cron section. |
| `cron.effort` | `string` | `MONO_AGENT_CRON_EFFORT` | unset | `example` | Configures effort for the cron section. |
| `cron.enabled` | `boolean` | `MONO_AGENT_CRON_ENABLED` | false | `true` | Enables the cron capability. |
| `cron.expression` | `string` | `MONO_AGENT_CRON_EXPRESSION` | unset | `example` | Configures expression for the cron section. |
| `cron.jobs` | `array` | `MONO_AGENT_CRON_JOBS_JSON` | [] | `[{"id":"daily","expression":"0 8 * * *","prompt":"Summarize the overnight queue."}]` | Inline scheduled jobs. Folder-based cron jobs still merge from cron.dir. |
| `cron.model` | `string` | `MONO_AGENT_CRON_MODEL` | unset | `example` | Configures model for the cron section. |
| `cron.notify` | `boolean` | `MONO_AGENT_CRON_NOTIFY` | false | `false` | Configures notify for the cron section. |
| `cron.notifyConversationId` | `string` | `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID` | unset | `example` | Configures notifyConversationId for the cron section. |
| `cron.notifyFailureCooldownHours` | `integer` | `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` | 6 | `6` | Configures notifyFailureCooldownHours for the cron section. |
| `cron.prompt` | `string` | `MONO_AGENT_CRON_PROMPT` | unset | `example` | Configures prompt for the cron section. |
| `cron.timezone` | `string` | `MONO_AGENT_CRON_TIMEZONE` | UTC | `UTC` | Configures timezone for the cron section. |
| `interaction.askUser.timeoutMs` | `integer` | `MONO_AGENT_ASK_USER_TIMEOUT_MS` | 600000 | `600000` | Maximum wait for one AskUser interaction (one to five questions). |
| `interaction.bridge.host` | `string` | `MONO_AGENT_INTERACTION_BRIDGE_HOST` | 127.0.0.1 | `127.0.0.1` | Bind host for the app-owned AskUser/tool-progress bridge. Defaults to loopback; keep it local because non-loopback values are not rejected. |
| `interaction.bridge.port` | `integer` | `MONO_AGENT_INTERACTION_BRIDGE_PORT` | 0 | `0` | Bridge port. 0 chooses an ephemeral port. |
| `interaction.progress.enabled` | `boolean` | `MONO_AGENT_PROGRESS_ENABLED` | true | `true` | Whether tool progress posts are relayed to channel status messages. |
| `memory.backend` | `string` | `MONO_AGENT_MEMORY_BACKEND` | bujo | `bujo` | Configures backend for the memory section. |
| `memory.consolidation.cron` | `string` | `MONO_AGENT_MEMORY_CONSOLIDATION_CRON` | 0 */2 * * * | `0 */2 * * *` | Configures consolidation.cron for the memory section. |
| `memory.consolidation.enabled` | `boolean` | `MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED` | true | `true` | Enables the memory capability. |
| `memory.embeddings.apiKey` | `string` | `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY` | unset | `example` | Secret value for memory.embeddings.apiKey; prefer the env override. |
| `memory.embeddings.apiKeyEnv` | `string` | `MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV` | unset | `example` | Environment-variable name containing an optional provider bearer token; an explicitly declared name must resolve before memory starts. |
| `memory.embeddings.circuitBreaker.cooldownMs` | `integer` | `MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS` | 30000 | `30000` | Configures embeddings.circuitBreaker.cooldownMs for the memory section. |
| `memory.embeddings.circuitBreaker.failureThreshold` | `integer` | `MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 3 | `3` | Configures embeddings.circuitBreaker.failureThreshold for the memory section. |
| `memory.embeddings.dim` | `integer` | `MONO_AGENT_MEMORY_EMBEDDINGS_DIM` | unset | `1` | Configures embeddings.dim for the memory section. |
| `memory.embeddings.endpoint` | `string` | `MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT` | unset | `example` | Provider service root. LM Studio uses <root>/v1/embeddings and defaults to http://localhost:1234. |
| `memory.embeddings.model` | `string` | `MONO_AGENT_MEMORY_EMBEDDINGS_MODEL` | unset | `nomic-embed-text:v1.5` | Configures embeddings.model for the memory section. |
| `memory.embeddings.provider` | `string` | `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` | unset | `ollama` | Embedding service used by Journal/BuJo memory: ollama, lmstudio, or openai. |
| `memory.embeddings.timeoutMs` | `integer` | `MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS` | 10000 | `10000` | Configures embeddings.timeoutMs for the memory section. |
| `memory.llm.endpoint` | `string` | `MONO_AGENT_MEMORY_LLM_ENDPOINT` | unset | `example` | Configures llm.endpoint for the memory section. |
| `memory.llm.executionMode` | `string` | `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE` | unset | `example` | Configures llm.executionMode for the memory section. |
| `memory.llm.model` | `string` | `MONO_AGENT_MEMORY_LLM_MODEL` | unset | `pi:openai-codex:gpt-5.6-terra` | Configures llm.model for the memory section. |
| `memory.llm.provider` | `string` | `MONO_AGENT_MEMORY_LLM_PROVIDER` | unset | `agent-host` | Configures llm.provider for the memory section. |
| `memory.llm.timeoutMs` | `integer` | `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` | 60000 | `60000` | Configures llm.timeoutMs for the memory section. |
| `memory.llm.trace` | `boolean` | `MONO_AGENT_MEMORY_LLM_TRACE` | true | `true` | Configures llm.trace for the memory section. |
| `memory.maxBytes` | `integer` | `MONO_AGENT_MEMORY_MAX_BYTES` | 64000 | `64000` | Configures maxBytes for the memory section. |
| `memory.mode` | `string` | `MONO_AGENT_MEMORY_MODE` | lite | `journal` | Configures mode for the memory section. |
| `memory.path` | `string` | `MONO_AGENT_MEMORY_PATH` | unset | `./.mono-agent/memory` | Configures path for the memory section. |
| `memory.recallTool.enabled` | `boolean` | `MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED` | true | `true` | Enables the memory capability. |
| `memory.supermemory.apiKey` | `string` | `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY` | unset | `example` | Secret value for memory.supermemory.apiKey; prefer the env override. |
| `memory.supermemory.apiKeyEnv` | `string` | `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV` | unset | `example` | Secret value for memory.supermemory.apiKeyEnv; prefer the env override. |
| `memory.supermemory.baseUrl` | `string` | `MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL` | unset | `example` | Configures supermemory.baseUrl for the memory section. |
| `memory.supermemory.container` | `string` | `MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER` | unset | `example` | Configures supermemory.container for the memory section. |
| `memory.supermemory.exposeMcpServer` | `boolean` | `MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER` | false | `true` | Configures supermemory.exposeMcpServer for the memory section. |
| `memory.supermemory.timeoutMs` | `integer` | `MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS` | 10000 | `10000` | Configures supermemory.timeoutMs for the memory section. |
| `memory.writeMode` | `string` | `MONO_AGENT_MEMORY_WRITE_MODE` | disabled | `disabled` | Configures writeMode for the memory section. |
| `observability.exporters` | `array` | `MONO_AGENT_OBSERVABILITY_EXPORTERS` | unset | `[]` | Configures exporters for the observability section. |
| `openaiApi.allowNonLoopback` | `boolean` | `MONO_AGENT_OPENAI_API_ALLOW_NON_LOOPBACK` | false | `true` | Configures allowNonLoopback for the openaiApi section. |
| `openaiApi.apiKey` | `string` | `MONO_AGENT_OPENAI_API_KEY` | unset | `env:MONO_AGENT_OPENAI_API_KEY` | Secret value for openaiApi.apiKey; prefer the env override. |
| `openaiApi.basePath` | `string` | `MONO_AGENT_OPENAI_API_BASE_PATH` | /v1 | `/v1` | Configures basePath for the openaiApi section. |
| `openaiApi.enabled` | `boolean` | `MONO_AGENT_OPENAI_API_ENABLED` | false | `true` | Enables the openaiApi capability. |
| `openaiApi.host` | `string` | `MONO_AGENT_OPENAI_API_HOST` | 127.0.0.1 | `127.0.0.1` | Configures host for the openaiApi section. |
| `openaiApi.modelId` | `string` | `MONO_AGENT_OPENAI_API_MODEL_ID` | agent | `agent` | Configures modelId for the openaiApi section. |
| `openaiApi.port` | `integer` | `MONO_AGENT_OPENAI_API_PORT` | 0 | `0` | Configures port for the openaiApi section. |
| `providers.local` | `array` | `MONO_AGENT_LOCAL_PROVIDERS_JSON` | unset | `[]` | Configures local for the providers section. |
| `providers.piAuthPath` | `string` | `MONO_AGENT_PI_AUTH_PATH` | unset | `~/.pi/agent/auth.json` | Configures piAuthPath for the providers section. |
| `providers.piNative.maxRetryDelayMs` | `integer` | `MONO_AGENT_MAX_RETRY_DELAY_MS` | 60000 | `60000` | Configures piNative.maxRetryDelayMs for the providers section. |
| `providers.piNative.piMaxRetries` | `integer` | `MONO_AGENT_PI_MAX_RETRIES` | 2 | `2` | Configures piNative.piMaxRetries for the providers section. |
| `providers.piNative.piSessionsRoot` | `string` | `MONO_AGENT_PI_SESSIONS_ROOT` | unset | `example` | Configures piNative.piSessionsRoot for the providers section. |
| `providers.piNative.transport` | `string` | `MONO_AGENT_PI_TRANSPORT` | auto | `sse` | Preferred Pi provider transport: auto, sse, websocket, or websocket-cached. Providers without multiple transports ignore it. |
| `runtime.compaction.contextWindowOverride` | `integer` | `MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE` | auto-detected | `128000` | Persistent correction for inaccurate provider context-window metadata; learned overflow ceilings may lower it process-locally. |
| `runtime.compaction.enabled` | `boolean` | `MONO_AGENT_COMPACTION_ENABLED` | true | `true` | Enables adaptive proactive compaction and one-shot reactive overflow recovery. |
| `runtime.compaction.fixedOverheadEnabled` | `boolean` | `MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED` | true | `true` | Includes system instructions, tool schemas, and the current user turn in proactive request-size estimates. |
| `runtime.compaction.keepRecentTokens` | `integer` | `MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS` | adaptive by model | `12800` | Explicit recent-context retention override; omitted derives 10% of the effective context window, clamped to 4,000-20,000 tokens. |
| `runtime.compaction.minSavingsTokens` | `integer` | `MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS` | adaptive by model | `12800` | Minimum verified token reduction required for proactive compaction; omitted derives 10% of the effective window, clamped to 4,000-20,000. Reactive recovery accepts any positive reduction. |
| `runtime.compaction.summaryMaxTokens` | `integer` | `MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS` | adaptive by model | `5120` | Explicit combined summary-output budget override; omitted derives 4% of the effective context window, clamped to 2,000-12,000 tokens. |
| `runtime.compaction.triggerRatio` | `number` | `MONO_AGENT_COMPACTION_TRIGGER_RATIO` | 0.7 | `0.7` | Fraction of the effective model context window used for the proactive trigger, additionally capped by adaptive safety headroom. |
| `runtime.effort` | `string` | `MONO_AGENT_EFFORT` | unset | `medium` | Route-specific effort. Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF. Direct codex:* forwards ultra unchanged. Mono-agent rejects ultra on its Claude SDK route because the pinned SDK public contract ends at max (the SDK JavaScript itself forwards the value). The Claude CLI route passes --effort ultra, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above max only prevents keyword downgrade. |
| `runtime.executionMode` | `string` | `MONO_AGENT_EXECUTION_MODE` | inferred | `inferred` | Configures executionMode for the runtime section. |
| `runtime.fallbackModels` | `string[]` | `MONO_AGENT_FALLBACK_MODELS` | [] | `["pi:ollama:gemma4:31b"]` | Legacy fallback list whose routes inherit runtime.effort. Prefer runtime.fallbacks for new configs. |
| `runtime.fallbacks` | `array` | `MONO_AGENT_FALLBACKS_JSON` | [] | `[{"model":"codex:gpt-5.6-sol"},{"model":"pi:openai-codex:gpt-5.6-terra","effort":"high"}]` | Canonical ordered fallback routes. Omitted per-route effort means that provider's default. |
| `runtime.maxTurns` | `integer` | `MONO_AGENT_MAX_TURNS` | unset | `1` | Configures maxTurns for the runtime section. |
| `runtime.model` | `string` | `MONO_AGENT_MODEL` | required | `codex:gpt-5.6-terra` | Configures model for the runtime section. |
| `runtime.permissionMode` | `string` | `MONO_AGENT_PERMISSION_MODE` | unset | `default` | Configures permissionMode for the runtime section. |
| `runtime.routeSafety` | `string` | `MONO_AGENT_ROUTE_SAFETY` | uniform | `per-route-native` | Uniform preserves one shared safety contract; per-route-native uses and reports each provider's explicit contract. |
| `runtime.session.idleTimeoutMs` | `integer` | `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS` | 1800000 | `1800000` | Configures session.idleTimeoutMs for the runtime section. |
| `runtime.session.isolateProactive` | `boolean` | `MONO_AGENT_SESSION_ISOLATE_PROACTIVE` | false | `true` | Configures session.isolateProactive for the runtime section. |
| `runtime.session.mode` | `string` | `MONO_AGENT_SESSION_MODE` | continuous | `continuous` | Configures session.mode for the runtime section. |
| `runtime.session.rollover` | `string` | `MONO_AGENT_SESSION_ROLLOVER` | none | `none` | Configures session.rollover for the runtime section. |
| `runtime.session.rolloverNotice` | `boolean` | `MONO_AGENT_SESSION_ROLLOVER_NOTICE` | false | `true` | Configures session.rolloverNotice for the runtime section. |
| `runtime.session.rolloverTimezone` | `string` | `MONO_AGENT_SESSION_ROLLOVER_TIMEZONE` | unset | `example` | Configures session.rolloverTimezone for the runtime section. |
| `runtime.workspace` | `string` | `MONO_AGENT_WORKSPACE` | . | `.` | Configures workspace for the runtime section. |
| `sandbox.denyWrite` | `string[]` | `MONO_AGENT_SANDBOX_DENY_WRITE` | unset | `["example"]` | Configures denyWrite for the sandbox section. |
| `sandbox.fallback` | `string` | `MONO_AGENT_SANDBOX_FALLBACK` | fail-closed | `fail-closed` | Configures fallback for the sandbox section. |
| `sandbox.mode` | `string` | `MONO_AGENT_SANDBOX_MODE` | unset | `native` | Configures mode for the sandbox section. |
| `sandbox.network.allowlist` | `string[]` | `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` | unset | `["example"]` | Configures network.allowlist for the sandbox section. |
| `sandbox.network.mode` | `string` | `MONO_AGENT_SANDBOX_NETWORK` | none | `none` | Configures network.mode for the sandbox section. |
| `sandbox.readableRoots` | `string[]` | `MONO_AGENT_SANDBOX_READABLE_ROOTS` | unset | `["example"]` | Configures readableRoots for the sandbox section. |
| `sandbox.unsafeAllowHostProcess` | `boolean` | `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` | false | `true` | Configures unsafeAllowHostProcess for the sandbox section. |
| `sandbox.writableRoots` | `string[]` | `MONO_AGENT_SANDBOX_WRITABLE_ROOTS` | unset | `["example"]` | Configures writableRoots for the sandbox section. |
| `slack.allowAllChannels` | `boolean` | `MONO_AGENT_SLACK_ALLOW_ALL_CHANNELS` | false | `true` | Configures allowAllChannels for the slack section. |
| `slack.allowedChannelIds` | `string[]` | `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS` | unset | `["example"]` | Configures allowedChannelIds for the slack section. |
| `slack.appToken` | `string` | `MONO_AGENT_SLACK_APP_TOKEN` | unset | `env:MONO_AGENT_SLACK_APP_TOKEN` | Secret value for slack.appToken; prefer the env override. |
| `slack.botToken` | `string` | `MONO_AGENT_SLACK_BOT_TOKEN` | unset | `env:MONO_AGENT_SLACK_BOT_TOKEN` | Secret value for slack.botToken; prefer the env override. |
| `slack.botUserIds` | `string[]` | `MONO_AGENT_SLACK_BOT_USER_IDS` | unset | `["example"]` | Configures botUserIds for the slack section. |
| `slack.drainDeadlineMs` | `integer` | `MONO_AGENT_SLACK_DRAIN_DEADLINE_MS` | unset | `1` | Configures drainDeadlineMs for the slack section. |
| `slack.enabled` | `boolean` | `MONO_AGENT_SLACK_ENABLED` | false | `true` | Enables the slack capability. |
| `slack.heartbeatIntervalMs` | `integer` | `MONO_AGENT_SLACK_HEARTBEAT_INTERVAL_MS` | unset | `1` | Configures heartbeatIntervalMs for the slack section. |
| `slack.heartbeatTimeoutMs` | `integer` | `MONO_AGENT_SLACK_HEARTBEAT_TIMEOUT_MS` | unset | `1` | Configures heartbeatTimeoutMs for the slack section. |
| `slack.homeTab` | `object` | `--` | unset | `{"enabled":true,"headerText":"*Quick actions*","buttons":[{"actionId":"triage","label":"Triage","prompt":"Triage today's requests.","channelId":"C0123"}]}` | JSON-only Slack App Home configuration; enabled is optional (default false), buttons is optional (default []), and there is no environment-variable form. |
| `slack.mentionTextAliases` | `string[]` | `MONO_AGENT_SLACK_MENTION_TEXT_ALIASES` | unset | `["example"]` | Configures mentionTextAliases for the slack section. |
| `slack.reconnectInitialBackoffMs` | `integer` | `MONO_AGENT_SLACK_RECONNECT_INITIAL_BACKOFF_MS` | unset | `1` | Configures reconnectInitialBackoffMs for the slack section. |
| `slack.reconnectMaxBackoffMs` | `integer` | `MONO_AGENT_SLACK_RECONNECT_MAX_BACKOFF_MS` | unset | `1` | Configures reconnectMaxBackoffMs for the slack section. |
| `slack.reconnectStabilityMs` | `integer` | `MONO_AGENT_SLACK_RECONNECT_STABILITY_MS` | unset | `1` | Configures reconnectStabilityMs for the slack section. |
| `slack.reconnectStartupGraceMs` | `integer` | `MONO_AGENT_SLACK_RECONNECT_STARTUP_GRACE_MS` | unset | `1` | Configures reconnectStartupGraceMs for the slack section. |
| `slack.shortcuts` | `array` | `--` | [] | `[{"callbackId":"triage","prompt":"Prepare the daily support triage checklist.","channelId":"C0123"}]` | JSON-only global/message Slack shortcut bindings; there is no environment-variable form. |
| `slack.stripMentionText` | `boolean` | `MONO_AGENT_SLACK_STRIP_MENTION_TEXT` | conditional | `false` | When unset, defaults to `true` when `botUserIds` or `mentionTextAliases` is non-empty; otherwise `false`. |
| `telegram.allowAllChats` | `boolean` | `MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS` | false | `true` | Configures allowAllChats for the telegram section. |
| `telegram.allowedChatIds` | `string[]` | `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | unset | `["example"]` | Configures allowedChatIds for the telegram section. |
| `telegram.apiRoot` | `string` | `MONO_AGENT_TELEGRAM_API_ROOT` | unset | `example` | Configures apiRoot for the telegram section. |
| `telegram.attachments.downloadTimeoutMs` | `integer` | `MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | unset | `1` | Configures attachments.downloadTimeoutMs for the telegram section. |
| `telegram.attachments.maxBytes` | `integer` | `MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES` | unset | `1` | Configures attachments.maxBytes for the telegram section. |
| `telegram.attachments.maxUploadBytes` | `integer` | `MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES` | unset | `1` | Configures attachments.maxUploadBytes for the telegram section. |
| `telegram.botToken` | `string` | `MONO_AGENT_TELEGRAM_BOT_TOKEN` | unset | `env:MONO_AGENT_TELEGRAM_BOT_TOKEN` | Secret value for telegram.botToken; prefer the env override. |
| `telegram.commands` | `array` | `--` | [] | `[{"command":"status","prompt":"Report current status."}]` | Telegram command definitions handled by the Telegram adapter. |
| `telegram.enabled` | `boolean` | `MONO_AGENT_TELEGRAM_ENABLED` | false | `true` | Enables the telegram capability. |
| `telegram.pollWatchdogMs` | `integer` | `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | unset | `1` | Configures pollWatchdogMs for the telegram section. |
| `telegram.quietHours` | `object` | `--` | unset | `{"timezone":"Europe/Amsterdam","start":"22:00","end":"07:00"}` | Quiet-hours rules for Telegram notifications. |
| `telegram.reactions` | `object` | `MONO_AGENT_TELEGRAM_REACTIONS` | unset | `{"working":true,"done":true,"error":true}` | Telegram lifecycle reactions. The env override is boolean and toggles all states. |
| `telegram.sendTools.pathScope` | `string` | `--` | unset | `run-output` | Confine Telegram path uploads to the current run output directory. |
| `telegram.sendTools.scope` | `string` | `--` | unset | `producing-conversation` | Bind Telegram send tools to the chat that produced the current run. |
| `telegram.transcription.endpoint` | `string` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT` | unset | `example` | Configures transcription.endpoint for the telegram section. |
| `telegram.transcription.language` | `string` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE` | unset | `example` | Configures transcription.language for the telegram section. |
| `telegram.transcription.model` | `string` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL` | unset | `example` | Configures transcription.model for the telegram section. |
| `telegram.transcription.timeoutMs` | `integer` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS` | unset | `1` | Configures transcription.timeoutMs for the telegram section. |
| `telegram.transport.ipFamily` | `integer` | `MONO_AGENT_TELEGRAM_IP_FAMILY` | unset | `example` | Configures transport.ipFamily for the telegram section. |
| `tools.allowedTools` | `string[]` | `MONO_AGENT_ALLOWED_TOOLS` | ["*"] | `["Read","Grep"]` | Configures allowedTools for the tools section. |
| `tools.continuationServers` | `string[]` | `MONO_AGENT_CONTINUATION_SERVERS` | unset | `["example"]` | Configures continuationServers for the tools section. |
| `tools.disallowedTools` | `string[]` | `MONO_AGENT_DISALLOWED_TOOLS` | [] | `["Read","Grep"]` | Configures disallowedTools for the tools section. |
| `tools.mcpCallMaxTotalTimeoutMs` | `integer` | `MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS` | 2700000 | `2700000` | Configures mcpCallMaxTotalTimeoutMs for the tools section. |
| `tools.mcpCallTimeoutMs` | `integer` | `MONO_AGENT_MCP_CALL_TIMEOUT_MS` | 120000 | `120000` | Configures mcpCallTimeoutMs for the tools section. |
| `tools.mcpConfigPath` | `string` | `MONO_AGENT_MCP_CONFIG_PATH` | unset | `example` | Configures mcpConfigPath for the tools section. |
| `tools.mcpRequestContextServers` | `string[]` | `MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS` | [] | `["transcribe"]` | Configured stdio MCP server names that receive trusted per-request conversation, run, output-directory, and scoped progress context. |
| `traceability.globalDiscovery` | `boolean` | `MONO_AGENT_TRACE_GLOBAL_DISCOVERY` | true | `true` | Configures globalDiscovery for the traceability section. |
| `traceability.heartbeatMs` | `integer` | `MONO_AGENT_TRACE_HEARTBEAT_MS` | 10000 | `10000` | Configures heartbeatMs for the traceability section. |
| `traceability.registryDir` | `string` | `MONO_AGENT_TRACE_REGISTRY_DIR` | .mono-agent/trace-sources | `.mono-agent/trace-sources` | Configures registryDir for the traceability section. |
| `traceability.sourceId` | `string` | `MONO_AGENT_TRACE_SOURCE_ID` | unset | `my-agent` | Configures sourceId for the traceability section. |
| `traceability.sourceLabel` | `string` | `MONO_AGENT_TRACE_SOURCE_LABEL` | unset | `My Agent` | Configures sourceLabel for the traceability section. |
| `traceability.staleAfterMs` | `integer` | `MONO_AGENT_TRACE_STALE_AFTER_MS` | 30000 | `30000` | Configures staleAfterMs for the traceability section. |
| `tui.allowNonLoopback` | `boolean` | `MONO_AGENT_TUI_ALLOW_NON_LOOPBACK` | false | `true` | Configures allowNonLoopback for the tui section. |
| `tui.apiKey` | `string` | `MONO_AGENT_TUI_API_KEY` | unset | `example` | Secret value for tui.apiKey; prefer the env override. |
| `tui.basePath` | `string` | `MONO_AGENT_TUI_BASE_PATH` | /gui | `/gui` | Configures basePath for the tui section. |
| `tui.enabled` | `boolean` | `MONO_AGENT_TUI_ENABLED` | true | `true` | Enables the tui capability. |
| `tui.host` | `string` | `MONO_AGENT_TUI_HOST` | 127.0.0.1 | `127.0.0.1` | Configures host for the tui section. |
| `tui.port` | `integer` | `MONO_AGENT_TUI_PORT` | 0 | `0` | Configures port for the tui section. |
| `webhook.allowNonLoopback` | `boolean` | `MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK` | unset | `true` | Configures allowNonLoopback for the webhook section. |
| `webhook.apiKey` | `string` | `MONO_AGENT_WEBHOOK_API_KEY` | unset | `set-via-MONO_AGENT_WEBHOOK_API_KEY` | Secret value for webhook.apiKey; prefer the env override. |
| `webhook.defaultMode` | `string` | `MONO_AGENT_WEBHOOK_DEFAULT_MODE` | sync | `sync` | Configures defaultMode for the webhook section. |
| `webhook.dir` | `string` | `MONO_AGENT_WEBHOOK_DIR` | webhook | `webhook` | Configures dir for the webhook section. |
| `webhook.effort` | `string` | `MONO_AGENT_WEBHOOK_EFFORT` | unset | `example` | Configures effort for the webhook section. |
| `webhook.enabled` | `boolean` | `MONO_AGENT_WEBHOOK_ENABLED` | false | `true` | Enables the webhook capability. |
| `webhook.endpoints` | `array` | `MONO_AGENT_WEBHOOK_ENDPOINTS_JSON` | [] | `[{"name":"triage","path":"/webhook/triage","prompt":"Triage this payload."}]` | Named webhook endpoints with per-endpoint prompt, model/effort, and maxRunMs overrides. |
| `webhook.host` | `string` | `MONO_AGENT_WEBHOOK_HOST` | 127.0.0.1 | `127.0.0.1` | Configures host for the webhook section. |
| `webhook.maxRunMs` | `integer` | `MONO_AGENT_WEBHOOK_MAX_RUN_MS` | unset | `1` | Configures maxRunMs for the webhook section. |
| `webhook.maxStoredRequests` | `integer` | `MONO_AGENT_WEBHOOK_MAX_STORED_REQUESTS` | 100 | `100` | Configures maxStoredRequests for the webhook section. |
| `webhook.model` | `string` | `MONO_AGENT_WEBHOOK_MODEL` | unset | `example` | Configures model for the webhook section. |
| `webhook.notify` | `boolean` | `MONO_AGENT_WEBHOOK_NOTIFY` | unset | `example` | Configures notify for the webhook section. |
| `webhook.notifyConversationId` | `string` | `MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID` | unset | `example` | Configures notifyConversationId for the webhook section. |
| `webhook.path` | `string` | `MONO_AGENT_WEBHOOK_PATH` | /webhook/invoke | `/webhook/invoke` | Configures path for the webhook section. |
| `webhook.port` | `integer` | `MONO_AGENT_WEBHOOK_PORT` | 0 | `0` | Configures port for the webhook section. |
| `webhook.prompt` | `string` | `MONO_AGENT_WEBHOOK_PROMPT` | unset | `example` | Configures prompt for the webhook section. |
| `webhook.retentionMs` | `integer` | `MONO_AGENT_WEBHOOK_RETENTION_MS` | 300000 | `300000` | Configures retentionMs for the webhook section. |

## Plugin channels

`channels.plugins[]` entries are intentionally open at `config`: the plugin package owns that nested payload. The host validates the plugin envelope (`package`, optional `id`, optional `label`, and `config`) and each loaded plugin reports its own config warnings.
