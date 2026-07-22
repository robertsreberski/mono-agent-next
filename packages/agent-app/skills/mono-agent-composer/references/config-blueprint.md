# Config Blueprint

> A prose, per-domain version of this reference (runtime, channels, memory, …)
> lives on the published docs site:
> <https://mono-agent-docs.vercel.app/config/>. This annotated JSON
> stays the offline canonical shape.

One `mono-agent.config.json` declares the whole agent. Paths are relative to the folder; config fields may be JSON-only. Environment-variable overrides are optional: only fields with a documented `MONO_AGENT_*` mapping accept one (env > JSON > defaults), so consult the generated config reference's `Env override` column (`--` means none, as for `channels.plugins`) instead of inferring one. Omit a section to leave that capability off — every section except `runtime.model` and `context.identityPath` is optional. `references/feature-coverage.md` maps every framework feature to its config key; if a capability is not listed there, it needs the programmatic escape hatch.

## Folder Layout

```text
my-agent/
  mono-agent.config.json   # the single declaration below
  IDENTITY.md              # canonical ## Role body, boundaries, references to existing knowledge
  skills/                  # optional: <skill-name>/SKILL.md per selected skill
  cron/                    # optional: <job-id>.md scheduled prompts
  mcp.json                 # optional: MCP server definitions
  .env                     # optional: secrets; auto-loaded by the CLI, never committed
  .mono-agent/
    artifacts/             # JSONL run summaries + events
    workspace/             # runtime working directory (if not ".")
    memory/                # journal memory root (daily notes, graph.jsonl, index/)
    whatsapp-auth/         # Baileys auth state (WhatsApp channel only)
    trace-sources/         # traceability registry (if kept folder-local)
```

## Annotated Config

New configs use `runtime.fallbacks[]`, where each route owns its optional exact
effort. Legacy `runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain
supported compatibility inputs with no removal deadline; do not emit them for a
new agent.

```jsonc
{
  // Runtime: primary model plus ordered backups tried on retryable provider
  // failures (failover is reported in run results, never silent).
  "runtime": {
    "model": "claude:claude-sonnet-4-6",   // claude:* | codex:* | pi:<provider>:<model>
    "fallbacks": [{ "model": "pi:ollama:gemma4:31b" }],
    "routeSafety": "uniform",              // uniform | per-route-native
    "executionMode": "sdk",                // sdk | cli (default inferred from model)
    "effort": "medium",                    // none|minimal|low|medium|high|xhigh|max|ultra; omit for direct opencode:*
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
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 } // or "per-message"
  },

  // Per-channel admission/execution bounds. Each enabled channel owns one limiter.
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 100
  },

  // Local/self-hosted providers for pi:<provider>:<model> references.
  "providers": {
    "piAuthPath": "~/.pi/agent/auth.json", // Pi OAuth credentials (openai-codex, ...)
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
    "skillMaxBytes": 48000                 // per-skill byte cap (256-1,000,000)
  },

  // Memory strategy. Omit the section for no memory. The built-in "bujo"
  // backend owns the three local tiers below; "supermemory" selects the
  // separately installed, lockstep @mono-agent/memory-supermemory plugin.
  // Three tiers over one substrate (@mono-agent/memory store + bujo subpaths):
  //   lite    — FTS keyword recall + rapid-log; no external deps.
  //   journal — + hybrid recall (BM25+vector) + static, non-decaying salience; needs embeddings.
  //   bujo    — + LLM capture/reconcile + entity graph + auto-scheduled
  //             lightweight consolidation; needs embeddings + an app-level memory.llm for capture/tier selection.
  "memory": {
    "backend": "bujo",                    // bujo (default) | supermemory
    "mode": "bujo",                        // lite | journal | bujo
    "path": "./.mono-agent/memory",        // root directory for all tiers
    "writeMode": "capture",                // disabled | append-host-summary | capture (bujo tier or external backend)
    "maxBytes": 64000,
    "embeddings": {                        // required for journal and bujo
      "provider": "ollama",                // ollama | lmstudio | openai; exclusive, no fallback
      "model": "nomic-embed-text:v1.5",   // use exact :v1.5 tag (pull first with ollama pull)
      "endpoint": "http://localhost:11434", // service root; LM Studio default http://localhost:1234
      // "apiKeyEnv": "LM_STUDIO_API_KEY", // optional authenticated LM Studio; required for openai
      "dim": 768                           // nomic-embed-text:v1.5 output dimension
    },
    "llm": {                               // enables bujo capture and the effective bujo tier; omit for lite/journal
      // Env: MONO_AGENT_MEMORY_LLM_PROVIDER / _MODEL / _EXECUTION_MODE / _ENDPOINT.
      "provider": "ollama",                // ollama | agent-host
      "model": "qwen3.6:latest",           // ollama: model string; agent-host: runtime ref, e.g. pi:openai-codex:gpt-5.5
      "endpoint": "http://localhost:11434" // ollama only; invalid for agent-host
      // For agent-host, use: "model": "pi:openai-codex:gpt-5.5", "executionMode": "sdk"; omit endpoint.
    },
    // Bujo auto-scheduler — override the default or disable it.
    // Consolidation runs in-app; no external cron or launchd needed.
    "consolidation": { "enabled": true, "cron": "0 */2 * * *" }, // default: every two hours
    // For backend: "supermemory", omit path/mode/embeddings/llm/consolidation
    // and configure the external service instead. Keep API keys in env.
    // "supermemory": {
    //   "baseUrl": "http://127.0.0.1:6767",
    //   Inline "apiKey" remains schema-compatible; source configs use apiKeyEnv.
    //   "apiKeyEnv": "SUPERMEMORY_API_KEY",
    //   "container": "my-agent",
    //   "timeoutMs": 10000,
    //   "exposeMcpServer": false
    // }
  },

  // Tool policy (allow-all by default) + MCP servers. Deny wins; overlap is rejected.
  "tools": {
    "allowedTools": ["*"],                 // omit or ["*"] = all tools; ["Read","Bash"] = just those; [] = none (chat-only)
    "disallowedTools": ["Bash"],           // deny wins even under allow-all; the escape hatch to subtract one tool
    "mcpConfigPath": "./mcp.json"          // stdio/sse/http servers; inlined for SDK runtimes
  },

  // NodeRepl shares state only inside one run and uses the same sandbox policy
  // as Bash.

  // Human-in-the-loop bridge: structured blocking AskUser plus
  // run-scoped project-MCP progress. It auto-starts when either ask tool is
  // allowed, this block or an interaction env override is configured, or
  // interaction.progress.enabled resolves true while
  // tools.mcpRequestContextServers names at least one opted project MCP server.
  "interaction": {
    "bridge": { "host": "127.0.0.1", "port": 0 },
    "askUser": { "timeoutMs": 600000 },
    "progress": { "enabled": true }
  },

  // Sandbox for Pi-owned runtime commands. Direct Codex uses its own sandbox;
  // Claude/direct OpenCode cannot enforce these exact srt scopes. All reject
  // this block (pi:opencode-go:* remains a Pi route).
  "sandbox": {
    "mode": "native",                      // native (srt-wrapped) | off
    "network": { "mode": "none", "allowlist": [] }, // none|localhost|allowlist|all; *.suffix wildcards; all = open egress with filesystem still enforced (managed/explicit node+cli SRT launch only)
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
    "retention": { "maxAgeDays": 365, "maxCount": 50000, "dryRun": false },
    "memoryRetention": { "maxAgeDays": 7, "maxCount": 5000, "dryRun": false }
  },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000,
    // Also mirror this agent's manifest into the global ~/.mono-agent/trace-sources
    // registry so `mono-agent tui` discovers it from any directory. Default true;
    // set false to keep the agent visible only via its own registryDir.
    "globalDiscovery": true
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
    "endpoints": [
      {
        "name": "invoke",
        "path": "/webhook/invoke",
        "mode": "sync",
        "prompt": "Respond to this request:",
        "model": "claude:claude-sonnet-4-6", // optional per-trigger override
        "effort": "high",                  // same eight-level effort enum as runtime
        "maxRunMs": 3600000,               // endpoint override; 0 disables only this watchdog
        "notify": true,                     // deliver the successful final answer verbatim
        // Explicit destination; if omitted, infer only with exactly one candidate.
        // Zero or multiple candidates skip with a warning.
        "notifyConversationId": "slack:C0123"
      }
    ],
    "retentionMs": 300000,                 // async status retention
    "maxStoredRequests": 100,
    "maxRunMs": 1200000                    // fallback when an endpoint omits maxRunMs
  },

  "openaiApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4040,
    "basePath": "/v1",                     // serves /v1/models + /v1/chat/completions (SSE)
    "allowNonLoopback": false,
    "modelId": "my-agent"                  // model id advertised to API clients
  },

  // Telegram & Slack do not stream ANSWER tokens by default. They first show a
  // working indicator; inbound tool starts then edit one temporary, redacted
  // activity ledger. Both post the final separately and then best-effort delete
  // their ledger. Proactive turns suppress the ledger. This is built-in behavior
  // (not a JSON field); a custom channel
  // driver can set stream.showHints=false or stream.finalOnly=false. The
  // OpenAI-compatible endpoint still streams tokens.
  // Telegram also exposes built-in per-chat /model and /effort menus over the
  // configured runtime primary + fallbacks. This has no telegram JSON field;
  // selections reset with the matching `default` command or process restart.
  "telegram": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    // Put MONO_AGENT_TELEGRAM_BOT_TOKEN in .env; do not inline botToken here.
    "allowedChatIds": ["123456789"],       // or "allowAllChats": true
    "allowAllChats": false
  },

  "slack": {
    "enabled": true,                       // opt-in; defaults to false (off → "disabled")
    // Built-in @agent /model and /effort Block Kit controls use the same runtime
    // primary + fallbacks and stay thread-local in shared channels. Register
    // /<bot-username>-model and /<bot-username>-effort in Slack for channel-wide
    // picker commands; the adapter derives those names from auth.test.user.
    // Put MONO_AGENT_SLACK_BOT_TOKEN and MONO_AGENT_SLACK_APP_TOKEN in .env.
    "allowedChannelIds": ["C0123"],        // or "allowAllChannels": true
    "allowAllChannels": false,
    "botUserIds": ["U0BOT"],               // optional supplemental ID; own ID is auto-discovered
    "mentionTextAliases": ["@agent"],
    "stripMentionText": true,
    "shortcuts": [                         // slack.shortcuts: JSON-only; callbackId matches the Slack app
      {
        "callbackId": "triage_request",
        "prompt": "Prepare the daily support triage checklist.",
        "channelId": "C0123",
        "ackText": "Triage started…",
        "threadReply": true
      }
    ],
    "homeTab": {                           // slack.homeTab: JSON-only; enable App Home + app_home_opened
      "enabled": true,
      "headerText": "*Quick actions*",
      "buttons": [
        {
          "actionId": "build_digest",
          "label": "Build digest",
          "prompt": "Build today's team digest.",
          "channelId": "C0123"
        }
      ]
    }
  },

  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "config": {
          "enabled": true,                 // opt-in; defaults to false (off → "disabled")
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
            "publicBaseUrl": "https://agent.example.com",
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
        "conversationId": "cron-daily",    // optional: share memory/history across ticks
        "model": "claude:claude-sonnet-4-6", // optional per-trigger override
        "effort": "high",
        "notify": true,                     // successful non-empty final answer is delivered verbatim
        // Explicit destination; if omitted, infer only with exactly one candidate.
        // Zero or multiple candidates skip with a warning.
        "notifyConversationId": "slack:C0123",
        // Model-exhaustion notices require this explicit destination; never infer.
        "notifyFailureCooldownHours": 6
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
mono-agent presets list                 # saved answer-sets (id, risk, description)
mono-agent presets show <id>            # generated config + .env.example + follow-up checklist
mono-agent init --preset <id> --yes [--with slack,cron] [--dry-run]   # scaffold from a preset (non-interactive)
mono-agent init --model claude:claude-sonnet-4-6 --fallback pi:ollama:gemma4:31b [--memory lite|journal|bujo]
mono-agent config       # resolved config field-by-field, each value tagged env/json/default
mono-agent validate [--preset <id>] [--consumer <path>]     # per-section report; --preset also checks the preset's capabilities
mono-agent start        # traceability + every configured channel
mono-agent restart      # apply config edits (config is JSON-first; restart to re-apply)
mono-agent restart --clear-sessions  # restart AND purge persisted pi sessions (fresh start; durable memory kept)
```

A `.env` file in the folder is loaded automatically (exported shell variables win); use `--env-file <path>` for an alternate file. `validate --consumer <path>` loads the consumer folder's `.env` by default and resolves relative `--config` / `--env-file` paths there. `start` prints the traceability source (Phoenix when an `observability.exporters` Phoenix entry is configured, otherwise the local JSONL artifacts) and one status line per channel: `running` with its endpoint facts, `waiting_for_config` with the exact missing setting, `disabled`, or `failed` with the reason. Config is JSON-first: edit `mono-agent.config.json` directly (agents can edit it) and run `mono-agent restart` to apply — there is no live browser re-apply.

For BuJo capture and the effective `bujo` tier that runs scheduled consolidation, configure `memory.llm`. Use `provider: "ollama"` with a local Ollama chat model string and optional `endpoint`, or `provider: "agent-host"` with `model` as a normal SDK runtime model reference such as `pi:openai-codex:gpt-5.5` and `executionMode: "sdk"`. `endpoint` is Ollama-only, and CLI-backed refs such as `codex:gpt-5.5` are rejected for memory LLMs until runtimes can enforce no external actions. The same values can be supplied via `MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE`, and `MONO_AGENT_MEMORY_LLM_ENDPOINT`. Routine BuJo consolidation runs via the in-app scheduler; the standalone `memory-bujo` maintenance CLI was removed (use `mono-agent memory <subcommand>` from the agent folder). `agent-host` LLM capture is an in-app composition path that injects the `LlmComplete` implementation into the BuJo store.

For operator views, run `mono-agent tui` or `mono-agent web` from any directory once the agent is started. Both discover running agents via the trace-source registry. The TUI and assistant-ui web console chat over the default-on `tui` stream endpoint (`"tui": {"enabled": false}` opts out); on macOS, `mono-agent tui --configure` opens a persistent, visibly marked proposal-only SELF-CONFIG conversation against the managed background agent and must not be combined with `--local`. Approval, rejection, and no-change turns continue that session; only quitting exits it. `mono-agent web` is an always-on service namespace, binds `0.0.0.0:5050` by default, and has no app login; use `--loopback` to narrow it. The former read-only recorder command, package, and relay were removed; use `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console). The low-level `mono-agent-tui` bin also supports `--responder <file>` (embedded, an ESM module default-exporting an `AgentResponderLike` or exporting `createResponder(env, cwd, configJson)`) and `--url <baseUrl>` (direct connect).

## Programmatic Escape Hatch

When config cannot express the host (custom runtime, request-scoped runtime extensions, custom channels, tool approval gates, structured output schemas), compose on the same package the CLI uses:

```ts
import { startMonoAgentApp, defaultChannelDrivers } from "@mono-agent/agent-app";

const app = await startMonoAgentApp({
  cwd: process.cwd(),
  runtime: myCustomRuntime,            // any MonoRuntimeLike
  drivers: [...defaultChannelDrivers(), myCustomDriver],
});
```

For a bare responder without channels, use `@mono-agent/config` + `@mono-agent/agent-app` (`createConfiguredAgentResponder` — also takes `memory`, `historyStore`, `runtimeOptions`, `runtimeOptionsForRequest`). For multi-agent orchestration, add `@mono-agent/agent-orchestrator` (`createCollaboratorToolRuntimeExtension`) — see `references/package-map.md`. Channel message texts and stream tuning (welcome/help/error texts, edit debounce) are channel-driver overrides, not config keys.
