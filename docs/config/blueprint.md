---
title: "Annotated config blueprint"
description: "See the major mono-agent.config.json sections together in one annotated, cross-linked example."
sidebar:
  order: 1
---

A single `mono-agent.config.json` brings the agent's runtime, providers, context, memory, tools, sandbox, observability, and channels together. This page shows the major sections in one broad example. Use the [generated config reference](/config/reference/) for the exhaustive field list.

In normal CLI use, relative paths resolve from the agent folder. For fields with a documented environment mapping, precedence is **passed environment > JSON > default**. Config fields may be JSON-only; the generated reference marks fields without a mapping as `--`.

Only `runtime.model` and `context.identityPath` are required. Most other capabilities are opt-in, but `tui` defaults on at loopback and interaction can auto-start from the selected tool configuration.

This is a **config**-coverage reference. Capabilities that config cannot express need the [programmatic escape hatch](/programmatic/) — see the note at the end.

:::caution
The annotated block is JSONC so it can contain comments. `mono-agent.config.json` is strict JSON: remove comments and copy only the sections you need.
:::

## Folder layout

```text
my-agent/
  mono-agent.config.json   # the single declaration below
  IDENTITY.md              # role, boundaries, references to existing knowledge
  skills/                  # optional: <skill-name>/SKILL.md per selected skill
  cron/                    # optional: <job-id>.md scheduled prompts
  mcp.json                 # optional: MCP server definitions
  .env                     # optional: secrets; auto-loaded by the CLI, never committed
  .mono-agent/
    artifacts/             # JSONL run summaries + events
    history/               # bounded canonical conversation history
    workspace/             # runtime working directory (if not ".")
    memory/                # built-in memory root (framework-managed)
      daily/               # canonical dated memory notes
      graph.jsonl          # BuJo canonical entity graph
      .replay-projection-v1.json # BuJo exact metadata-only replay authority (0600)
      .index/              # managed generations + manifest/runtime metadata
    sessions/              # optional durable Pi transcripts when configured
    whatsapp-auth/         # Baileys auth state (WhatsApp channel only)
    trace-sources/         # traceability registry (if kept folder-local)
```

See [Folder layout](/config/folder-layout/) for the full directory contract.

## The full annotated config

```jsonc
{
  // Public display metadata only. This does not influence filesystem paths,
  // service ids, sessions, or provider identity.
  "agent": { "name": "Research Companion" },

  // Runtime: primary model plus ordered backups tried on retryable provider
  // failures (failover is reported in run results, never silent).
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra", // pi:<provider>:<model> | claude:* | codex:* | opencode:*
    "fallbacks": [
      { "model": "claude:claude-sonnet-5", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" } // omitted effort = provider default
    ],
    "routeSafety": "per-route-native",     // uniform (default) | per-route-native
    "executionMode": "sdk",                // sdk | cli (default inferred from model)
    "effort": "medium",                    // none|minimal|low|medium|high|xhigh|max|ultra
                                           // Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF.
                                           // Direct codex:* forwards ultra unchanged. Mono-agent rejects ultra on its Claude SDK route
                                           // because the pinned SDK public contract ends at max (the SDK JavaScript itself forwards the value).
                                           // The Claude CLI route passes --effort ultra, but both tested Claude Code binaries
                                           // (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort.
                                           // Direct OpenCode rejects explicit effort.
                                           // Ranking above max only prevents keyword downgrade.
    "permissionMode": "default",           // default|plan|acceptEdits|bypassPermissions (CLI backends)
    "maxTurns": 0,                         // 0 or omitted means unlimited; 1-100 caps turns
    "compaction": {
      "enabled": true,                     // default true
      "triggerRatio": 0.70,                // default 0.70; adaptive safety headroom also applies
      // Omit these three to derive model-window-aware defaults.
      "keepRecentTokens": 12800,
      "summaryMaxTokens": 5120,
      "minSavingsTokens": 12800,
      "fixedOverheadEnabled": true,        // include system prompt, tool schemas, and current turn
      "contextWindowOverride": 128000      // optional persistent correction for bad provider metadata
    },
    "workspace": ".",
    "session": {
      "mode": "continuous",                // warm provider session per conversation; per-message starts cold
      "idleTimeoutMs": 1800000,             // warm-session eviction only; durable history is separate
      "rollover": "none",                  // none|daily; daily appends a date bucket to conversation ids
      "rolloverTimezone": "UTC",           // optional IANA timezone; system timezone when omitted
      "rolloverNotice": false,              // adapter-visible notice on a new daily bucket; default off
      "isolateProactive": false             // true makes scheduled cron turns one-shot; interactive turns unchanged
    }
  },

  // Harness limits are per enabled channel, not one app-wide pool.
  "concurrency": {
    "maxConcurrentRuns": 4,                 // provider calls executing at once
    "maxPendingRuns": 16                    // admitted runs waiting before provider execution
  },

  // Local/self-hosted providers for pi:<provider>:<model> references.
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json", // Pi credentials (OAuth/account + API-key providers)
    // Pi-native bridge tuning (all optional).
    "piNative": {
      "transport": "auto",                // auto | sse | websocket | websocket-cached
      "piMaxRetries": 2,                   // 0-8; transient provider-transport retries
      "maxRetryDelayMs": 60000,            // backoff cap between retries (ms)
      "piSessionsRoot": ".mono-agent/sessions" // durable JSONL sessions → resume across restarts (unset = in-memory)
    },
    "local": [
      {
        "id": "ollama",
        "type": "ollama",                  // ollama | lmstudio | openai_compat
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "trustPublicUrl": false,           // explicit opt-in for non-private URLs
        // Keep the key in .env; config stores only its variable name.
        // Inline "apiKey" remains schema-compatible for existing consumers.
        "apiKeyEnv": "MY_PROVIDER_KEY",
        "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }]
      }
    ]
  },

  // Identity, optional soul, and selected skills.
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["research"],        // exact names; no auto-selection
    "skillMaxBytes": 48000,                // per-skill byte cap (256-1,000,000)
    "skillDisclosure": "index"             // index = disclose on demand; full = inline selected skill bodies
  },

  // Memory strategy. Omit the section for no memory.
  // Three tiers over one substrate (@mono-agent/memory store + bujo subpaths):
  //   lite    — FTS keyword recall + rapid-log; no external deps.
  //   journal — hash-deduped lexical capture + bounded background semantic indexing; needs embeddings.
  //   bujo    — raw audit + bounded LLM curation + precise entity graph + auto-scheduled
  //             lightweight consolidation; strictly needs embeddings + an app-level memory.llm.
  "memory": {
    "backend": "bujo",                     // bujo (built in) | supermemory (external package + server)
    "mode": "bujo",                        // lite | journal | bujo
    "path": "./.mono-agent/memory",        // root directory for all tiers
    "writeMode": "capture",                // disabled | append-host-summary | capture (bujo only)
    "maxBytes": 64000,
    "embeddings": {                        // block required for journal/bujo; fields below have defaults
      "provider": "ollama",                // ollama | lmstudio | openai; default ollama
      "model": "nomic-embed-text:v1.5",   // provider default; use exact :v1.5 tag (pull first with ollama pull)
      "endpoint": "http://localhost:11434", // service root; LM Studio default is http://localhost:1234
      // "apiKeyEnv": "LM_STUDIO_API_KEY", // optional for authenticated LM Studio; required for openai
      "dim": 768                           // default 768; must match the model output dimension
    },
    "llm": {                               // required for strict bujo; rejected for lite/journal
      // Env: MONO_AGENT_MEMORY_LLM_PROVIDER / _MODEL / _EXECUTION_MODE / _ENDPOINT / _TIMEOUT_MS.
      "provider": "ollama",                // ollama | agent-host
      "model": "qwen3.6:latest",           // ollama: model string; agent-host: runtime ref, e.g. pi:openai-codex:gpt-5.6-terra
      "endpoint": "http://localhost:11434", // ollama only; invalid for agent-host
      "timeoutMs": 60000                   // in-app per-call timeout; 1000-600000, default 60000. Raise for slow local models.
      // For agent-host, use: "model": "pi:openai-codex:gpt-5.6-terra", "executionMode": "sdk"; omit endpoint.
    },
    "recallTool": { "enabled": true },      // read-only MemoryRecall tool; default on when memory is configured
    // Bujo auto-scheduler — override the default or disable it.
    // Consolidation runs in-app; no external cron or launchd needed.
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" } // default: every two hours
  },

  // Tool policy (allow-all by default) + MCP servers. Direct codex:* normal runs
  // require this exact allow-all shape; use an enforcing runtime for narrower lists.
  "tools": {
    "allowedTools": ["*"],                 // omit or ["*"] = all tools; ["Read","Bash"] = just those; [] = none (chat-only)
    "disallowedTools": [],                 // deny wins where supported; overlap is rejected
    "mcpConfigPath": "./mcp.json",         // stdio/sse/http servers; inlined for SDK runtimes
    "mcpRequestContextServers": ["transcribe"], // trusted stdio servers receiving scoped request/progress context
    "continuationServers": ["work-control"], // trusted stdio or loopback-HTTP async result owners
    "mcpCallTimeoutMs": 120000,            // inactivity cap per MCP call; tool progress resets it
    "mcpCallMaxTotalTimeoutMs": 2700000    // hard per-call wall clock (45 min); progress cannot extend it
  },

  // Host-owned durable async delivery. A model never receives the route or
  // capabilities. Detached bearers are read from the named environment vars.
  "continuations": {
    "enabled": true,
    "host": "127.0.0.1",                  // loopback only
    "port": 4319,                          // fixed loopback port; persisted callback/status URLs survive restarts
    "stateDir": ".mono-agent/continuations",
    "namedRoutes": {
      "daily-attention": { "mode": "notify_if_actionable", "conversationId": "slack:C_EXAMPLE:T_EXAMPLE" },
      "verification": { "mode": "capture" },
      "background-index": { "mode": "silent" }
    },
    "detachedServices": [
      { "name": "work-control", "tokenEnv": "WORK_CONTROL_CONTINUATION_TOKEN" }
    ]
  },

  // Human-in-the-loop bridge: structured blocking AskUser plus tool
  // progress → channel status messages. It auto-starts when either ask tool is
  // allowed, this block or an interaction env override is configured, or
  // interaction.progress.enabled resolves true while
  // tools.mcpRequestContextServers names at least one opted project MCP server.
  "interaction": {
    "bridge": { "host": "127.0.0.1", "port": 0 }, // keep loopback; 0 = ephemeral
    "askUser": { "timeoutMs": 600000 },           // max wait per interaction (10 min)
    "progress": { "enabled": true }
  },

  // Sandbox for Pi-owned runtime commands. Under uniform route safety, a route
  // that cannot enforce these scopes fails closed. Under per-route-native,
  // non-Pi routes use the explicit provider-native contract instead.
  "sandbox": {
    "mode": "native",                      // native (srt-wrapped) | off
    "network": { "mode": "none", "allowlist": [] }, // none|localhost|allowlist|all; *.suffix wildcards; all = open egress, filesystem still enforced
    "readableRoots": ["."],                // relative entries resolve against the workspace
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"], // these are the defaults
    "fallback": "fail-closed",             // fail-closed | unsafe-host-process
    "unsafeAllowHostProcess": false        // explicit opt-in required for the unsafe fallback
  },

  // Observability: the recorder writes empty events + a running summary at start,
  // buffers sensitive-key-redacted, credential-scanned, capped events in RAM,
  // then replaces both files at finish/fail.
  // A pre-terminal crash can lose buffered events. `mono-agent status` reads the
  // separate trace-source registry.
  "artifacts": {
    "dir": "./.mono-agent/artifacts",
    "retention": {
      "maxAgeDays": 365,
      "maxCount": 50000,
      "dryRun": false
    },
    "memoryRetention": {
      "maxAgeDays": 7,                    // memory-maintenance mem-* runs
      "maxCount": 5000,
      "dryRun": false                     // defaults to retention.dryRun when omitted
    }
  },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000,
    "globalDiscovery": true                // mirror into ~/.mono-agent/trace-sources too (default true)
  },

  // Optional trace viewer: add a best-effort, terminal-batched Phoenix (OTLP)
  // exporter. Omit it to keep only bounded local terminal JSONL snapshots; a
  // pre-terminal crash can lose buffered events.
  "observability": {
    "exporters": [
      { "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces", "contentPatternRedaction": false }
    ]
  },

  // ----- Channels: one section per channel; all independent. Most channels are
  // ----- opt-in; the `tui` operator surface defaults on and can opt out.
  // ----- A waiting/disabled channel never blocks the others.

  "tui": {
    "enabled": true,                       // default-on loopback operator console endpoint
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/gui",
    "allowNonLoopback": false              // set MONO_AGENT_TUI_API_KEY in .env when needed
  },

  "webhook": {
    // For bearer auth, put MONO_AGENT_WEBHOOK_API_KEY=<strong-random-secret> in
    // the owner-only .env file; JSON strings are literal and do not interpolate env: values.
    "enabled": true,
    "host": "127.0.0.1",                   // loopback-only unless allowNonLoopback
    "port": 0,                             // 0 picks a free port
    "path": "/webhook/invoke",
    "allowNonLoopback": false,             // a non-loopback bind also requires the .env key
    "defaultMode": "sync",                 // sync | async (202 + status URL polling)
    "retentionMs": 300000,                 // async status retention
    "maxStoredRequests": 100,
    "maxRunMs": 1200000                    // fallback; endpoints[].maxRunMs overrides, 0 disables
  },

  "openaiApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4040,
    "basePath": "/v1",                     // serves /v1/models + /v1/chat/completions (SSE)
    "allowNonLoopback": false,
    "modelId": "my-agent"                  // model id advertised to API clients
  },

  // Telegram & Slack deliver only the FINAL answer by default (no streamed
  // interim edits) while showing a working indicator — Telegram a "typing…"
  // action, Slack a 👀 "seen" reaction. If tools run, both post the final answer
  // separately and then best-effort delete their temporary activity message.
  // This is built-in behavior (not a JSON field); restoring live interim
  // streaming needs a custom channel driver with stream.finalOnly=false. The
  // OpenAI-compatible endpoint still streams tokens.
  "telegram": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    // Put MONO_AGENT_TELEGRAM_BOT_TOKEN in .env; do not inline botToken here.
    "allowedChatIds": ["123456789"],       // or "allowAllChats": true
    "allowAllChats": false
  },

  "slack": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    // Built-in @agent /model and /effort Block Kit controls expose the runtime
    // primary + fallbacks; DM choices span threads, shared-channel choices do not.
    // Put MONO_AGENT_SLACK_BOT_TOKEN and MONO_AGENT_SLACK_APP_TOKEN in .env.
    "allowedChannelIds": ["C0123"],        // or "allowAllChannels": true
    "allowAllChannels": false,
    "botUserIds": ["U0BOT"],               // optional supplemental ID; own ID is auto-discovered
    "mentionTextAliases": ["@agent"],
    "stripMentionText": true
  },

  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,                 // opt-in; defaults to false (off -> "disabled")
          "allowedChatJids": ["123@s.whatsapp.net"], // or "allowAllChats": true
          "allowAllChats": false,
          "groupMode": "mention",          // mention | any (group trigger rule)
          "botJids": ["456@s.whatsapp.net"],
          "mentionTextAliases": ["@agent"],
          "stripMentionText": true
          // Baileys auth state lives in .mono-agent/whatsapp-auth; the start log
          // prints a QR code to scan on first login.
        }
      },
      {
        "package": "@mono-agent/a2a-adapter",
        "id": "a2a",
        "config": {
          "enabled": true,
          "provider": {
            "host": "127.0.0.1",
            "port": 4201,
            "publicBaseUrl": "https://agent.example.com", // Agent Card URL when fronted by a proxy
            "allowNonLoopback": true,
            "requireBearer": false,
            // Put MONO_AGENT_A2A_BEARER_TOKEN in .env when bearer auth is required.
            "idempotency": {              // optional; namespace explicitly enables the v1 extension
              "namespace": "my-agent-production", // stable authenticated-principal boundary
              "stateDir": ".mono-agent/a2a-my-agent", // optional derived owner-only path when omitted
              "retentionMs": 2592000000,  // full result replay horizon
              "maxRecords": 10000         // permanent unique-key capacity
            }
          },
          "agent": { "name": "My Agent", "description": "What it does.", "version": "0.1.0" },
          "skill": { "id": "main", "name": "Main", "description": "Primary skill.", "tags": ["agent"] },
          "consumer": {                    // settings for calling remote A2A agents
            "remoteAgentUrls": ["http://127.0.0.1:4202"],
            "defaultRemoteAgentUrl": "http://127.0.0.1:4202",
            // Put MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN in .env when the remote requires auth.
            "timeoutMs": 30000
            // Consumed programmatically (createA2AConsumerResponder); the app's A2A
            // channel runs the provider side.
          }
        }
      }
    ]
  },

  "cron": {
    "dir": "cron",                         // optional: folder of *.md jobs (frontmatter + prompt body), default "cron"
    "jobs": [
      {
        "id": "daily",
        "enabled": true,
        "expression": "0 9 * * *",         // five-field cron
        "timezone": "UTC",                 // IANA timezone
        "prompt": "Post the morning summary.",
        "conversationId": "cron-daily"     // optional: share memory/history across ticks
      }
    ]
    // Jobs here merge with cron/*.md files (duplicate ids error).
    // Agent-app pins overlap to skip; config exposes no queue/replace controls.
    // Overlapping ticks of the same configured job are therefore skipped, never queued.
  }
}
```

## Lifecycle

```bash
mono-agent init         # bare TTY wizard: every route checked + strict full Agent ready gate
mono-agent init --name "Research Companion" --model pi:openai-codex:gpt-5.6-terra \
  --fallback pi:opencode-go:kimi-k2.6 --fallback-effort medium \
  --fallback pi:ollama:gemma4:31b --fallback-effort provider-default [--memory lite|journal|bujo]
                        # any flag/non-TTY is scaffold-only and makes no readiness claim
mono-agent validate     # section report; exit 0 means structurally valid, not zero waiting dependencies
mono-agent validate --consumer ../local-agent-alpha  # read-only report for a downstream folder
mono-agent start        # traceability + every configured channel
mono-agent restart      # apply config edits (config is JSON-first; restart to re-apply)
mono-agent restart --clear-sessions  # restart AND clear provider sessions + active chat history (durable memory kept)
```

Edit `mono-agent.config.json` directly and run `mono-agent restart` to apply it through the CLI. The CLI does not watch the file. A programmatic host can explicitly call `app.applyConfigChange(reason)` instead. `start` prints the traceability source, exporter status, and one initial status per channel: `running`, `waiting_for_config`, `disabled`, or `failed`. A running self-recovering transport can later report `degraded`.

Agent-aware CLI commands load `.env` before config resolution; exported shell variables remain in precedence. Use `--env-file <path>` for an alternate file. `validate --consumer <path>` loads the consumer folder's `.env` by default and resolves relative `--config` and `--env-file` paths there. Keep secrets in an untracked, owner-only dotenv file or exported environment—never in committed config.

:::caution
For `memory.llm`, CLI-backed refs such as `codex:gpt-5.6-terra` are rejected; use `provider: "ollama"` with a local model string, or `provider: "agent-host"` with an SDK runtime ref like `pi:openai-codex:gpt-5.6-terra` and `executionMode: "sdk"` (omit `endpoint`). See [Capture & recall](/memory/capture-and-recall/).
:::

## Section reference

Every top-level section maps to a deep-dive page:

| Section | What it controls | Deep dive |
| --- | --- | --- |
| `agent` | Public display name (never path/service/session identity) | [Identity & soul](/context/identity-and-soul/) |
| `runtime` | Model, fallback chain, execution mode, effort, sessions | [Backends](/runtime/backends/), [Effort & permissions](/runtime/execution-effort-permissions/), [Fallback](/runtime/fallback/), [Sessions & concurrency](/runtime/sessions-concurrency/) |
| `concurrency` | Per-channel admission and provider-execution bounds | [Sessions & concurrency](/runtime/sessions-concurrency/) |
| `providers` | Pi auth, `piNative` bridge tuning, local/self-hosted providers | [Local providers](/runtime/local-providers/) |
| `context` | Identity, soul, skills selection | [Identity & soul](/context/identity-and-soul/), [Skills](/context/skills/), [Assembly](/context/assembly/) |
| `memory` | Backend, tier, recall, embeddings, capture LLM, consolidation | [Embeddings](/memory/embeddings/), [Capture & recall](/memory/capture-and-recall/), [Consolidation](/memory/rituals/) |
| `tools` | Allow/deny tool policy, MCP servers | [Tool policy](/tools/policy/), [MCP](/tools/mcp/) |
| `continuations` | Host-owned durable asynchronous result routing | [Durable continuations](/tools/durable-continuations/) |
| `interaction` | Ask-the-user and tool-progress bridge | [Delivery & send tools](/channels/delivery-and-send-tools/) |
| `sandbox` | Filesystem/network confinement for runtime commands | [Sandbox](/tools/sandbox/) |
| `artifacts`, `traceability` | JSONL run summaries + the trace-source registry | [Artifacts & traces](/observability/artifacts-and-traces/) |
| `observability` | Optional Phoenix (OTLP) exporter | [Phoenix & backfill](/observability/phoenix-and-backfill/) |
| `tui` | Default-on loopback operator endpoint | [Operator stream endpoint](/channels/tui/) |
| `webhook` | HTTP invoke endpoint (sync/async) | [Webhook](/channels/webhook/) |
| `openaiApi` | OpenAI-compatible `/v1` endpoint (streams tokens) | [OpenAI API](/channels/openai-api/) |
| `telegram` | Telegram bot channel | [Telegram](/channels/telegram/) |
| `slack` | Slack Socket Mode channel | [Slack](/channels/slack/) |
| `channels.plugins[]` | External channel packages such as WhatsApp and A2A | [Write your own channel adapter](/programmatic/custom-channels/), [WhatsApp](/channels/whatsapp/), [A2A](/channels/a2a/) |
| `cron` | Scheduled prompt jobs (inline + `cron/*.md`) | [Cron](/channels/cron/) |

For per-section env vars see [Environment variables](/config/env-vars/). When config cannot express what you need (custom runtime, request-scoped extensions, custom channels, tool-approval gates, structured-output schemas), use the [programmatic escape hatch](/programmatic/).
