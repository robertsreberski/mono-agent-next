# Discovery Questions

Use this sequence to fill `mono-agent.config.json` before running anything. Ask one question at a time. Skip questions whose answer is already explicit in the user's request. Each answer maps to concrete config keys.

## 1. Runtime And Backup Models

Question:

```text
Which model should drive the agent, and should any backups take over when the provider fails?

1. `claude:<model>` through SDK or CLI mode
2. `codex:<model>` through CLI mode (the default direct Codex path)
3. `pi:openai-codex:<model>` through SDK mode (a selectable Pi alternative when Pi auth is configured)
4. `pi:<provider>:<model>` through SDK mode (OpenAI, Copilot, OpenRouter, OpenCode-through-Pi, local Ollama, LM Studio, ...)
5. A custom MonoRuntimeLike supplied programmatically (escape hatch)
```

Fills: `runtime.model`, canonical `runtime.fallbacks[]` (ordered backup routes tried on retryable provider failures, each with optional exact effort), `runtime.executionMode` (usually inferred), `runtime.effort`, `runtime.maxTurns`. Legacy `runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain supported with no removal deadline, but do not emit them for a new agent. Keep a direct `codex:*` chain all-direct. Pi, Claude, and direct OpenCode may mix only with `sandbox` omitted/off; if native mono-agent sandboxing is selected, every primary/fallback/trigger model must stay on Pi (`pi:opencode-go:*` is Pi). Direct `opencode:*` is advanced scaffold/config-only, requires exact allow-all plus an explicit native `permissionMode`, and must omit `runtime.effort` under SDK 1.x.

The interactive `mono-agent init` wizard discovers Pi OpenAI-Codex auth, OpenCode models, Ollama models, and LM Studio's local server best-effort. It defaults to direct `codex:gpt-5.6-terra` and presents both `pi:openai-codex:gpt-5.6-terra` and `pi:openai-codex:gpt-5.6-sol` as concrete selectable candidates. Direct `codex:gpt-5.6-sol` is also selectable; direct GPT-5.6 routes require Codex CLI 0.144.0 or newer. The wizard maps discovered OpenCode options to `pi:opencode-go:<model>` for setup/preflight, and auto-adds local provider modules when a primary or fallback model uses `pi:ollama:*` or `pi:lmstudio:*`. Recover missing Pi OAuth with `mono-agent auth login <provider>` (and `--pi-auth-path` when required). Direct `opencode:<provider>:<model>` refs are supported only as hand-authored runtime backend config; do not present them as a first-class composer or init wizard selection. For local models also fill `providers.local` (e.g. an Ollama or LM Studio base URL plus model capabilities). Follow-up only if needed: continuous provider session per conversation (`runtime.session.mode: "continuous"`, default) versus stateless per-message.

## 2. Channels Of Communication

Question:

```text
Where should people (or other agents) reach this agent? Pick every channel that applies:

1. Webhook (HTTP POST, zero credentials — good first smoke test)
2. OpenAI-compatible API (OpenWebUI and other API clients)
3. Telegram
4. Slack
5. WhatsApp
6. A2A (agent-to-agent provider/consumer)
7. Cron (scheduled prompts, no inbound channel)
```

Fills one config section per choice: built-in channels use `webhook`, `openaiApi`, `telegram`, `slack`, and `cron`; WhatsApp and A2A are external channel plugins under `channels.plugins[]` with package names `@mono-agent/whatsapp-adapter` and `@mono-agent/a2a-adapter`. Channels are independent: an unconfigured channel reports `waiting_for_config` and never blocks the others. For chat channels collect tokens and allowlists (chat IDs, channel IDs, JIDs). For HTTP channels collect host/port/path and whether non-loopback binding is allowed (default: loopback only); for webhook, offer an optional bearer key on loopback and require it whenever non-loopback is selected, storing it in `MONO_AGENT_WEBHOOK_API_KEY`. For paid or otherwise non-repeatable A2A dispatches, also collect a reviewed stable `provider.idempotency.namespace` (the authenticated-principal boundary), retention horizon, and lifetime unique-key capacity; callers must supply an existing stable logical key rather than a fresh key per attempt.

## 3. Identity And Existing Knowledge

Question:

```text
What exact text belongs in IDENTITY.md → ## Role, and does this folder already contain knowledge it must respect?
```

Fills: the `## Role` body in the one canonical identity file, `context.identityPath` (default `./IDENTITY.md`), optional `context.soulPath`, and `runtime.workspace`. `mono-agent init` detects `AGENTS.md`, `CLAUDE.md`, `README.md`, and `SOUL.md` and references them from a generated identity — keep those references rather than copying content. If `IDENTITY.md` already exists, preserve it unchanged, say the newly entered Role was not written, and tell the user to add or edit its `## Role` heading manually. Do not assume the heading already exists or store the unused answer elsewhere.

## 4. Skills

Question:

```text
Should this agent load selected skills?

1. Yes, from a `skills/` directory in this folder
2. Yes, from an external skills directory
3. No selected skills for the first pass
```

Fills: `context.skillsRoot`, `context.selectedSkills`, optionally `context.skillMaxBytes` (per-skill byte cap, default 48000). Skill discovery loads immediate child directories only: `<skillsRoot>/<skill-name>/SKILL.md`. Skill files may carry YAML frontmatter (Claude Code style); the description is the first prose paragraph after it.

## 5. Tools And MCP Servers

Question:

```text
What tools does the agent need?

1. Allow all tools (recommended — the default: every built-in + enabled channels' send tools)
2. Allow all, but deny a few by name (tools.disallowedTools)
3. A specific allowlist of built-in / channel tools
4. Chat-only, no tools (explicit tools.allowedTools: [])

Plus, independently: MCP servers from an mcp.json config file?
```

Fills: `tools.allowedTools`, `tools.disallowedTools` (denylist wins, even under allow-all), `tools.mcpConfigPath`. The default is allow-all (`["*"]`) — write that unless the user asks to narrow. Under allow-all the adapter-derived send tools (`SlackSendMessage` / `TelegramSendMessage` / …) are auto-available once the channel is enabled; only a **specific** allowlist needs their exact names added. Valid enabled Slack/Telegram adapter config and destination allowlists are required either way. On the pi-native runtime `disallowedTools` does not filter external MCP-server tools — to withhold one, don't declare its server.

Offer the `NodeRepl` built-in when the user wants run-scoped JavaScript evaluation. It executes with the same sandbox authority as `Bash`.

## 6. Memory Strategy

Question:

```text
Should the agent remember anything between conversations?

1. No durable memory yet (recommended for first integration)
2. Lite memory — FTS keyword recall + rapid-log capture; zero external deps
3. Journal memory — hybrid recall (BM25+vector) + static salience; requires embeddings
4. BuJo memory — full tier: journal + LLM capture/reconcile + entity graph + auto-scheduled
   consolidation; requires embeddings AND a chat model
```

All tiers share the same `@mono-agent/memory/bujo` substrate. Fills: `memory.mode`
(`lite`/`journal`/`bujo`), `memory.path`, `memory.writeMode`
(`disabled`/`append-host-summary`/`capture`), and tier-specific blocks below.

**Tier 2 — lite (no external deps):**

Write:

```jsonc
"memory": {
  "mode": "lite",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary"
}
```

No prerequisites. No Ollama. SQLite is bundled.

**Tier 3 — journal (embeddings required):**

- Guided init asks for Ollama or LM Studio, service root, exact model, actual dimension,
  and optional auth-env name. Treat this as separate from runtime chat-model discovery.
  - Ollama default root `http://localhost:11434`: enumerate `/api/tags`, retain only
    `/api/show` capabilities containing `embedding`, then prove `/api/embed`.
  - LM Studio default root `http://localhost:1234`: retain exact `type: "embedding"`
    entries from `/api/v1/models`, use their `key`, then prove `/v1/embeddings`.
  - Hand-authored OpenAI remains supported but is not a guided local-memory choice.
- If typed discovery is inconclusive, ask for exact model + positive dimension, while
  explaining that real readiness still must pass. Never substitute another provider.
- LM Studio is keyless when `apiKeyEnv` is omitted. If named, the variable must already
  contain the token in the owner-only agent environment; missing declared auth is `waiting`.

Write:

```jsonc
"memory": {
  "mode": "journal",
  "path": "./.mono-agent/memory",
  "writeMode": "append-host-summary",
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text:v1.5",
    "endpoint": "http://localhost:11434",
    "dim": 768
  }
}
```

After writing, remind the user to run `mono-agent validate` (checks root writability,
managed provider/model/dimension identity, provider-native model typing, real finite-vector
response, and dimension). Changing any semantic identity field on an existing root requires
stopping the agent and running config-aware `mono-agent memory rebuild --json`.

**Tier 4 — bujo (embeddings + chat model + consolidation):**

Proactively explain what bujo does: capture → reconcile (ADD/UPDATE/SUPERSEDE/NOOP),
hybrid BM25+vector recall, entity graph, scheduled projection-only consolidation, living
`index.md`, and an empty retired `future-log.md` stub. Consolidation refreshes projections
and reports duplicate groups; it never decays salience or automatically supersedes or
rewrites canonical memory. It is **auto-scheduled in-app** — no external cron or launchd
setup needed.

- Ask: which embeddings provider/service-root/model/dimension/auth-env? Use the same
  exclusive choices and real-probe contract as journal.
- Ask: which chat LLM provider/model for LLM pipelines?
  - Ollama: local model string such as `qwen3.6:latest`; pull it first with
    `ollama pull qwen3.6:latest`.
  - agent-host: SDK runtime model reference such as `pi:openai-codex:gpt-5.6-terra` with
    `executionMode: "sdk"`. Do not use CLI-backed refs such as `codex:gpt-5.6-terra`; they are
    rejected for memory LLMs until runtimes can enforce no external actions.
- Ask: should per-turn intelligent capture be enabled (`writeMode: "capture"`), or only
  deterministic rapid-log summaries (`append-host-summary`) plus scheduled consolidation?
- Ask: should we keep the default consolidation schedule (`0 */2 * * *`), customise the
  cron expression, or disable scheduled consolidation?

The embeddings service and capture LLM are independent. Choosing LM Studio embeddings does
not move capture there; guided config keeps an explicit `agent-host` LLM, while an authored
Ollama `memory.llm` remains valid. The in-app scheduler handles routine BuJo consolidation;
the standalone `memory-bujo` maintenance CLI was removed (run `mono-agent memory <subcommand>`
from the agent folder instead).

Write (embeddings + chat model):

```jsonc
"memory": {
  "mode": "bujo",
  "path": "./.mono-agent/memory",
  "writeMode": "capture",
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text:v1.5",
    "dim": 768
  },
  "llm": {
    "provider": "ollama",
    "model": "qwen3.6:latest"
  }
}
```

For an agent-host memory LLM, write the `llm` block as:

```jsonc
"llm": {
  "provider": "agent-host",
  "model": "pi:openai-codex:gpt-5.6-terra",
  "executionMode": "sdk"
}
```

If the user customises the consolidation schedule, add the `consolidation` block:

```jsonc
"consolidation": { "enabled": true, "cron": "0 */4 * * *" }
```

After writing, append a prerequisite note:

```
Before running mono-agent validate, pull the required models:
  ollama pull nomic-embed-text:v1.5
  ollama pull qwen3.6:latest          # only if using llm.provider: "ollama"
```

Then run `mono-agent validate` — the Memory section confirms the root is writable,
provider-specific liveness, and the consolidation cadence.
See `docs/memory/index.md` for the full tier table and config shapes. Memory maintenance
runs via `mono-agent memory <subcommand>` from the agent folder; the standalone `memory-bujo`
CLI was removed.

## 7. Sandbox

Question:

```text
Should Pi-owned runtime commands run inside the native mono-agent sandbox? Direct Codex uses its own native sandbox and rejects this block; Claude and direct OpenCode reject it because their provider-owned tools cannot enforce the exact `srt` scopes.

1. No sandbox for the first pass
2. Native sandbox, no network (fail closed)
3. Native sandbox with localhost or an explicit network allowlist
4. Native sandbox with open network (`all`: filesystem containment only — for agents whose tools need broad egress)
5. Native sandbox with custom filesystem scopes (extra readable/writable roots)
```

Fills: the `sandbox` section — `mode`, `network.mode` (`none`/`localhost`/`allowlist`/`all`), `network.allowlist`, `readableRoots`/`writableRoots` (relative entries resolve against the workspace; default: workspace only), `denyWrite` glob patterns (defaults already deny `.env*`, `.git/config`, `.git/hooks/**`), `fallback` (`fail-closed` recommended; `unsafe-host-process` only with explicit consent plus `unsafeAllowHostProcess: true`).

## 8. Observability

Question:

```text
Do you need a browsable trace viewer or just local artifacts?

1. JSONL artifacts plus Phoenix as the trace viewer (recommended; add an `observability.exporters` Phoenix entry)
2. JSONL artifacts only (bounded terminal snapshots; no external viewer)
```

Fills: `artifacts.dir`, `traceability.registryDir` / `sourceId` / `sourceLabel`, and — when Phoenix is wanted — an `observability.exporters` (phoenix) OTLP entry. The local recorder starts with empty events plus a `running` summary, applies sensitive-key redaction, scans retained free text for high-confidence credential shapes, and caps event strings at 4,096 bytes by default. It buffers events in RAM and replaces the artifacts at finish/fail; a pre-terminal crash can lose buffered events. Phoenix adds a best-effort terminal batch, not a crash-safe stream. Artifacts record runtime/tool/message events and summaries, not private chain-of-thought. For a terminal operator console, mention `mono-agent tui` (run from anywhere once the agent is started; live chat with thinking/tool insight, run replay, config view). Config is JSON-first — edit `mono-agent.config.json` directly and run `mono-agent restart` to apply changes.

## 9. Acceptance Smoke Test

Question:

```text
What proves this agent works?

1. A curl POST to the webhook invoke URL
2. A curl to /v1/models and /v1/chat/completions
3. A Telegram/Slack/WhatsApp message from an allowed sender
4. An A2A message to the Agent Card URL
5. A cron tick
```

The answer decides which smoke from `references/validation.md` must pass before the work is done.
