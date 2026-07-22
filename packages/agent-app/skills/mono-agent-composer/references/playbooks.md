# Playbooks

Condensed, offline copy of the end-to-end recipes. Each maps a persona/goal to a
concrete `mono-agent.config.json` shape and the `init → configure → validate →
start → smoke` flow. Mirrors the published Playbooks index
(<https://mono-agent-docs.vercel.app/playbooks/>); this file is the
self-contained in-skill version so the composer can offer a matching recipe
without fetching anything. Before hand-assembling a config in the Composition
Flow, check whether one of these fits and adapt it. Verify every key against
`references/config-blueprint.md`.

---

## 1. Personal Telegram assistant with BuJo memory
**For:** an individual wanting a private assistant that remembers.
**Goal:** a Telegram bot (long polling) that captures every turn into BuJo memory with scheduled consolidation and recalls past notes semantically.
**Features:** `telegram.long-polling`, `channel.final-only-delivery`, `channel.transient-tool-activity`, `memory.bujo`, `memory.per-turn-capture`, `memory.bujo-consolidation`, `memory.recall-tool`, `memory.embeddings`.

Put `MONO_AGENT_TELEGRAM_BOT_TOKEN=...` in `.env`; the source config omits the credential.

```json
{
  "runtime": { "model": "pi:openai-codex:gpt-5.6-terra" },
  "telegram": { "enabled": true, "allowedChatIds": ["123456789"] },
  "memory": {
    "mode": "bujo", "path": "./.mono-agent/memory", "writeMode": "capture",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "endpoint": "http://localhost:11434", "dim": 768 },
    "llm": { "provider": "ollama", "model": "qwen3.6:latest" },
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" }
  }
}
```
**Steps:** `ollama pull nomic-embed-text:v1.5 && ollama pull qwen3.6:latest` → `mono-agent init --model claude:claude-sonnet-4-6 --memory bujo` → add telegram + fill embeddings/llm + `writeMode: capture` → `mono-agent validate` (confirm memory liveness + consolidation cadence) → `mono-agent start`.
**Smoke:** send a fact from the allowed chat, then ask a paraphrased question later; confirm the final answer arrives separately and the temporary memory-tool activity disappears, `MemoryRecall` appears in the run JSONL, and the answer uses it.

## 2. Slack team bot with MCP tools
**For:** a DevOps engineer running a shared team bot.
**Goal:** a mention-triggered Slack Socket Mode bot with a custom MCP tool, Read/Grep, and `SlackSendMessage` for proactive posts.
**Features:** `slack.socket-mode`, `runtime.per-trigger-model`, `channel.transient-tool-activity`, `tool-policy.allowlist`, `tool-policy.mcp-servers`, `agent-app.adapter-send-tools`, `runtime.concurrency`.

Put `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN` in `.env`; the source config omits credentials.

```json
{
  "runtime": { "model": "pi:openai-codex:gpt-5.6-terra" },
  "slack": { "enabled": true, "allowedChannelIds": ["C012345"], "stripMentionText": true },
  "tools": { "allowedTools": ["Read", "Grep", "SlackSendMessage", "deployTool"], "mcpConfigPath": "./mcp.json" },
  "concurrency": { "maxConcurrentRuns": 4, "maxPendingRuns": 8 }
}
```
**Steps:** create a Slack app (Socket Mode app token + bot token, with Interactivity enabled and the `commands` bot scope) → register `/<bot-username>-model` and `/<bot-username>-effort` without a Request URL → `mono-agent init` (allow-all by default) → write `mcp.json` (the MCP tool becomes available from the server declaration — MCP tools aren't gated by `allowedTools`) → add Slack; the adapter discovers its own bot identity, and `SlackSendMessage` is auto-available under allow-all or named when using a specific allowlist → `validate` → `start`.
**Smoke:** mention the bot in an allowed channel; confirm the 👀/assistant status, a fresh final reply followed by removal of the temporary MCP-tool activity message, the tool firing in the artifact, and `SlackSendMessage` posting only to allowed channels. Run `/<bot-username>-model`, choose a configured option, and verify two threads inherit it; then use `@agent /model` in one thread and verify only that thread overrides the channel choice. Confirm colon-delimited references are literal rather than emoji-expanded.

## 3. Fully local Ollama agent (no cloud)
**For:** a privacy-focused user with no cloud budget.
**Goal:** runs entirely on local Ollama via the Pi SDK, journal memory with local embeddings, no outbound network.
**Features:** `runtime.local-providers`, `runtime.multi-backend`, `memory.journal`, `memory.embeddings`, `sandbox.network-policy`.

```json
{
  "runtime": { "model": "pi:ollama:gemma4:31b" },
  "providers": { "local": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "enabled": true, "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }] }] },
  "memory": { "mode": "journal", "path": "./.mono-agent/memory", "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "endpoint": "http://localhost:11434", "dim": 768 } },
  "sandbox": { "mode": "native", "network": { "mode": "localhost" } }
}
```
**Steps:** pull both models → `mono-agent init --model pi:ollama:gemma4:31b --memory journal` → add `providers.local` + embeddings + `sandbox.network.mode: localhost` → `validate` (Ollama reachable, models pulled) → `start`.
**Smoke:** `curl -X POST` the webhook path; confirm a local-model response and no outbound non-localhost network in the artifact.

## 4. OpenAI-compatible endpoint for Open WebUI
**For:** an AI-infra engineer fronting the agent with a chat UI.
**Goal:** expose `/v1` (SSE) so Open WebUI can stream and keep multi-turn state.
**Features:** `openai-api.chat-completions`, `runtime.provider-sessions`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "session": { "mode": "continuous", "idleTimeoutMs": 1800000 } },
  "openaiApi": { "enabled": true, "host": "0.0.0.0", "port": 4040, "basePath": "/v1", "allowNonLoopback": true, "modelId": "my-agent" }
}
```
**Steps:** `mono-agent init` → add `openaiApi` (set `allowNonLoopback`, `modelId`) + continuous session → put `MONO_AGENT_OPENAI_API_KEY` in an owner-only `.env` → `validate` → `start` → in Open WebUI add an OpenAI connection at `http://host:4040/v1` with the bearer.
**Smoke:** `curl /v1/models` returns `my-agent`; two calls with the same `X-OpenWebUI-Chat-Id` resume the session and stream via SSE.

## 5. Webhook automation (sync + async)
**For:** a backend developer wiring the agent into a pipeline.
**Goal:** fast sync calls + long-running async jobs (202 + status polling) across multiple named endpoints.
**Features:** `webhook.http-invoke` (sync/async modes, multiple endpoints, per-endpoint prompt).

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "webhook": {
    "enabled": true, "host": "127.0.0.1", "port": 8080, "defaultMode": "sync",
    "endpoints": [
      { "name": "invoke", "path": "/webhook/invoke", "mode": "sync", "prompt": "Respond to this request:" },
      { "name": "jobs", "path": "/webhook/jobs", "mode": "async" }
    ],
    "retentionMs": 300000, "maxStoredRequests": 100
  }
}
```
**Steps:** `mono-agent init` (webhook already enabled) → add `endpoints[]` (or `webhook/*.md` files; unique names AND paths) → `validate` → `start`.
**Smoke:** `POST /webhook/invoke` for an immediate body; `POST /webhook/jobs` → 202 + status URL → poll until the result returns.

## 6. Cron digest with native notify
**For:** a data analyst wanting a scheduled briefing pushed to the team.
**Goal:** a timezone-aware cron job that builds a daily digest with shared history and delivers its final answer verbatim through native notification.
**Features:** `cron.scheduled-prompts`, `channel.native-notify`, `slack.socket-mode`, `memory.journal`.

**Destination resolution:** an explicit `notifyConversationId` wins; otherwise mono-agent infers only when exactly one notify-capable Telegram/Slack candidate exists. With 0 or 2+ candidates delivery is skipped with a warning. Artifact-derived candidates are cached for 30 seconds after each scan completes. An artifact committed under a Telegram/Slack conversation id invalidates the cache immediately; runs using the default synthetic `cron:`/`webhook:` ids do not. Other artifact changes are picked up after cache expiry and the next scan completes. Cron model-exhaustion notices require an explicit `notifyConversationId` and never infer a destination.

Put `MONO_AGENT_SLACK_BOT_TOKEN` and `MONO_AGENT_SLACK_APP_TOKEN` in `.env`; the source config omits credentials.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "slack": { "enabled": true, "allowedChannelIds": ["C012345"] },
  "cron": { "jobs": [{ "id": "morning-digest", "enabled": true, "expression": "0 9 * * *", "timezone": "America/New_York", "prompt": "Build the morning digest. Your final answer is the digest to notify.", "conversationId": "daily-digest", "notify": true, "notifyConversationId": "slack:C012345" }] }
}
```
**Steps:** `mono-agent init` → add the destination adapter and allowlist → add the cron job (or `cron/morning-digest.md`) with `conversationId`, IANA timezone, `notify: true`, and optional `notifyConversationId` → `validate` → `start`.
**Smoke:** trigger a one-off tick; confirm the final answer lands verbatim in the allowed destination with no tool call and `conversationId` shares context across ticks. Return `NOTHING_TO_REPORT` to test the silent path.

## 7. A2A provider + consumer pair
**For:** a platform integrator connecting two agents over A2A.
**Goal:** publish agent A as an A2A provider (Agent Card, bearer); configure agent B to discover and call it.
**Features:** `a2a.provider`, `a2a.consumer`.

```json
{
  "channels": {
    "plugins": [{
      "package": "@mono-agent/a2a-adapter",
      "id": "a2a",
      "config": {
        "enabled": true,
        "provider": { "host": "127.0.0.1", "port": 4201, "requireBearer": true, "idempotency": { "namespace": "research-production", "retentionMs": 2592000000, "maxRecords": 10000 } },
        "agent": { "name": "Research Agent", "description": "Does research.", "version": "0.1.0" },
        "skill": { "id": "research", "name": "Research", "description": "Web research", "tags": ["research"] },
        "consumer": { "remoteAgentUrls": ["http://127.0.0.1:4201"], "defaultRemoteAgentUrl": "http://127.0.0.1:4201", "timeoutMs": 30000 }
      }
    }]
  }
}
```
**Credentials:** put `MONO_AGENT_A2A_BEARER_TOKEN` in the provider's `.env` and `MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` in the consumer's `.env`; source config omits both tokens.
**Steps:** provider — `init`, add the `@mono-agent/a2a-adapter` plugin entry with `provider`/`agent`/`skill` + env-backed bearer; set `provider.maxRequestBytes` only when the caller's task envelope exceeds the 100 KiB SDK default; for paid/non-repeatable calls choose a reviewed stable `provider.idempotency.namespace`; `validate`, `start`, confirm the Agent Card is reachable. Consumer — set plugin `config.consumer` (or compose `createA2AConsumerResponder`), then pass the existing logical dispatch id through `idempotencyKey` / `idempotencyKeyForRequest` rather than generating one per attempt.
**Smoke:** repeat one keyed message to the provider's Agent Card URL with the bearer; confirm the same task/result is returned and the responder runs once.

## 8. Multi-agent orchestration (`AskCollaborator`) — code
**For:** a workflow designer composing specialist agents.
**Goal:** one orchestrator delegates to named collaborator responders via the loopback `AskCollaborator` MCP tool.
**Features:** `orchestrator.ask-collaborator`, `harness.request-runtime-options`, `runtime.custom`.

```ts
const orchestrator = await createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: async (input) => {
    const extension = await createCollaboratorToolRuntimeExtension({
      collaborators: [
        { id: "researcher", label: "Research", responder: researcher },
        { id: "writer", label: "Writer", responder: writer },
      ],
      conversationId: input.request.conversationId,
      originalUserMessage: input.request.userMessage,
      abortSignal: input.request.abortSignal,
      maxCalls: 10,
    });
    // The harness invokes cleanup after success, failure, or request abort.
    return { runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup };
  },
});
```
**Smoke:** give a compound task ("research X then write a summary"); confirm the artifact shows `AskCollaborator` delegating to both, and `cleanup()` closes the MCP port.

## 9. Sandboxed code agent (loopback only, deny .env)
**For:** a security team deploying an internal code assistant.
**Goal:** read repos + run Bash or run-scoped NodeRepl inside the native srt sandbox with loopback-only network access and protected secrets.
**Features:** `sandbox.mode`, `sandbox.network-policy`, `sandbox.filesystem-scopes`, `sandbox.fallback`, `tool-policy.allow-all`, `memory.journal`.

```json
{
  "runtime": { "model": "pi:openai-codex:gpt-5.6-terra" },
  "tools": { "allowedTools": ["*"] },
  "sandbox": { "mode": "native", "network": { "mode": "localhost" }, "readableRoots": ["."], "writableRoots": ["."], "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"], "fallback": "fail-closed" }
}
```
**Steps:** `mono-agent init --memory journal` → leave tools at the allow-all default (`["*"]`); the **sandbox**, not an allowlist, is what constrains the code tools → `sandbox.mode native` + `network localhost` + deny-write defaults → keep `fallback: fail-closed` (do NOT set `unsafe-host-process`) → `validate` → `start`.
**Smoke:** ask it to read a file, run Bash, then use NodeRepl twice to retain a variable and produce `42` (all work); next fetch an external URL or write `.env` (both blocked in the artifact). Keep every primary/fallback/trigger model on Pi; direct Codex, Claude, and direct OpenCode reject this mono-agent sandbox policy.

## 10. Phoenix-observed agent with the TUI
**For:** an agent builder evaluating runs in a tracing dashboard.
**Goal:** run locally with the TUI, attempt a best-effort terminal-batched Phoenix export, and retain a sensitive-key-redacted, credential-scanned, capped local JSONL snapshot after terminal persistence. A pre-terminal crash can omit the Phoenix batch and lose RAM-buffered JSONL events.
**Features:** `observability.phoenix-exporter`, `observability.jsonl-artifacts`, `observability.trace-registry`, `tui.chat`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "artifacts": { "dir": ".mono-agent/artifacts" },
  "traceability": { "registryDir": ".mono-agent/trace-sources", "sourceId": "my-agent", "heartbeatMs": 10000 },
  "observability": { "exporters": [{ "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces", "projectName": "my-project", "includeSensitiveData": false, "contentPatternRedaction": false, "timeoutMs": 5000 }] }
}
```
**Steps:** start Phoenix (6006) → `init` → add artifacts/traceability/exporter → `validate` (POSTs an empty protobuf) → `start` (prints the Phoenix endpoint) → `mono-agent tui`.
**Smoke:** complete a TUI prompt; confirm a JSONL artifact AND a Phoenix trace with merged tool spans under the project. Strings are capped. For local artifacts, non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes. Phoenix applies that scan only when `contentPatternRedaction` is true.

## 11. Backfill historical runs to Phoenix
**For:** an ops engineer onboarding observability after the fact.
**Goal:** retroactively export recorded JSONL runs to Phoenix with original timestamps, idempotently.
**Features:** `observability.backfill`, `observability.phoenix-exporter`, `observability.jsonl-artifacts`.

```json
{ "artifacts": { "dir": ".mono-agent/artifacts" }, "observability": { "exporters": [{ "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces", "projectName": "my-project" }] } }
```
**Steps:** ensure `run-*.summary.json` + `run-*.events.jsonl` exist and Phoenix is reachable → `mono-agent backfill --all --since <iso> --until <iso> --dry-run` → `mono-agent backfill --all --since <iso>`.
**Smoke:** dry-run then real export; historical timestamps preserved in Phoenix and a second run does not duplicate spans (deterministic ids).


## 12. Multi-model fallback chain with transcript resume
**For:** a reliability-minded builder who can't afford a single-provider outage.
**Goal:** a primary model with ordered backups the native failover router tries on retryable failures, resuming from the transcript tail — reported, never silent.
**Features:** `runtime.multi-backend`, `runtime.fallback-models`, `runtime.pi-native-tuning`, `runtime.provider-sessions`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "fallbacks": [{ "model": "pi:openai-codex:gpt-5.5" }, { "model": "pi:ollama:gemma4:31b" }], "session": { "mode": "continuous" } },
  "providers": { "local": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "enabled": true }], "piNative": { "transport": "auto", "piMaxRetries": 2, "maxRetryDelayMs": 60000, "piSessionsRoot": ".mono-agent/sessions" } }
}
```
Legacy `runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain supported
with no removal deadline, but this playbook intentionally emits the canonical
per-route form for a new agent.
**Steps:** `ollama pull gemma4:31b` → `mono-agent init --model claude:claude-sonnet-4-6 --fallback pi:openai-codex:gpt-5.5 --fallback pi:ollama:gemma4:31b` → add `providers.local` + `piNative.piSessionsRoot` → `validate` → `start`.
**Boundary:** this mixed Pi/Claude chain intentionally omits the native mono-agent sandbox. Keep direct Codex chains all-direct; keep every route on Pi (including `pi:opencode-go:*`, not direct `opencode:*`) when `sandbox.mode` is `native`.
**Smoke:** force a retryable primary failure; confirm the run result reports failover to the next model (not silent) and the conversation resumes from the transcript tail.

## 13. Personal Telegram assistant with Supermemory
**For:** a power user trying an external memory layer while keeping the agent local.
**Goal:** a Telegram bot captures turns into a local or hosted Supermemory instance and recalls through the same `MemoryRecall` tool.
**Features:** `telegram.long-polling`, `memory.backend-supermemory`, `memory.per-turn-capture`, `memory.recall-tool`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "telegram": { "enabled": true, "allowedChatIds": ["123456789"] },
  "memory": {
    "backend": "supermemory", "mode": "lite", "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "supermemory": { "baseUrl": "http://127.0.0.1:6767", "container": "my-telegram-agent" },
    "recallTool": { "enabled": true }
  }
}
```
**Steps:** install the exact `@mono-agent/memory-supermemory` version matching agent-app, run `supermemory-server`, save its `sm_...` key in `.env`, add the explicit memory block plus Telegram token/chat id, `validate`, `start`.
**Smoke:** send a fact, wait for ingestion, then ask a paraphrased question; confirm the run shows `MemoryRecall` returning Supermemory hits.

## 14. Fully local LM Studio agent
**For:** a privacy-focused user who prefers LM Studio's GUI local server.
**Goal:** a local LM Studio model answers through the webhook channel with lite memory and no cloud calls.
**Features:** `runtime.local-providers`, `runtime.multi-backend`, `memory.lite`, `webhook.http-invoke`.

```json
{
  "runtime": { "model": "pi:lmstudio:qwen3.6-32b" },
  "providers": { "local": [{ "id": "lmstudio", "type": "lmstudio", "baseUrl": "http://localhost:1234", "enabled": true }] },
  "memory": { "mode": "lite", "path": "./.mono-agent/memory", "writeMode": "append-host-summary" },
  "webhook": { "enabled": true }
}
```
**Steps:** start LM Studio's local server with the chosen model loaded → `mono-agent init --model pi:lmstudio:qwen3.6-32b --memory lite` (the `pi:lmstudio:*` model auto-adds the LM Studio provider block; there is no LM Studio preset — `local-private` is Ollama-based) → adjust `runtime.model` if the displayed model id differs → `validate` → `start`.
**Smoke:** `curl` the webhook invoke URL and confirm the response comes from the local LM Studio model.

## 15. Interactive agent with long jobs and large media
**For:** a builder whose Telegram agent needs to ask before acting, run multi-minute tools, and exchange large files.
**Goal:** one Telegram agent uses `AskUser`, long-running MCP tool progress, a self-hosted Bot API server, and `TelegramSendFile`.
**Features:** `telegram.long-polling`, `agent-app.adapter-send-tools`, `interaction.ask-user`, `interaction.progress`, `tool-policy.mcp-servers`.

**Bridge startup:** the interaction bridge defaults to loopback and auto-starts when `AskUser` is allowed, when the `interaction` block or an interaction env override is configured, or when `interaction.progress.enabled` resolves true and `tools.mcpRequestContextServers` names at least one opted project MCP server. Keep `interaction.bridge.host` on loopback because non-loopback values are not rejected. AskUser takes one to five structured questions with two or three described choices each; Telegram presents them sequentially with native buttons, Other/custom reply, and Done for multi-select.

```json
{
  "runtime": { "model": "pi:openai-codex:gpt-5.5", "executionMode": "sdk" },
  "tools": { "allowedTools": ["Read", "AskUser", "TelegramSendFile"], "mcpConfigPath": "./.mcp.json", "mcpCallMaxTotalTimeoutMs": 2700000 },
  "interaction": { "bridge": { "host": "127.0.0.1", "port": 4471 }, "askUser": { "timeoutMs": 600000 }, "progress": { "enabled": true } },
  "telegram": { "enabled": true, "allowedChatIds": ["123456789"], "apiRoot": "http://127.0.0.1:8081", "attachments": { "maxBytes": 268435456, "maxUploadBytes": 268435456 } }
}
```
**Steps:** run a loopback self-hosted Bot API server if files exceed 20 MB, wire a long-running MCP tool in `.mcp.json`, `validate`, `start`.
**Smoke:** send media with no caption, answer the `AskUser` question, watch progress update during the long job, and receive the generated file via `TelegramSendFile`.
