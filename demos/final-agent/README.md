# Final Agent Demo

This is the final agent demo. It is intentionally **not** an npm package: there is no `package.json`, no workspace entry, and no publishable export. The demo is just repo code that shows how the packages fit together.

## What it wires together

- `@mono-agent/config` loads adapter-neutral core JSON plus environment overrides.
- `@mono-agent/agent-app` turns the core config into a runtime-backed responder.
- `@mono-agent/observability` registers this host in the local trace source registry.
- `@mono-agent/telegram-adapter` owns Telegram settings, Bot API handling, and long polling.
- `@mono-agent/a2a-adapter` owns A2A Agent Card discovery, loopback provider hosting, bearer auth, and remote text-task calls.
- `@mono-agent/webhook-adapter` owns loopback HTTP invocation and per-request status.
- `@mono-agent/openai-api-adapter` owns OpenAI-compatible model discovery and Chat Completions for OpenWebUI-style clients.
- `@mono-agent/cron-adapter` owns scheduled invocation from five-field cron jobs.

The important package-composition code is deliberately small:

```ts
const coreConfig = await loadFinalAgentCoreConfig({ env, cwd, configPath });
const runtime = createConfiguredAgentRuntime(coreConfig);
const responder = createConfiguredAgentResponder({ config: coreConfig, runtime });
```

### Source map

- `src/configuration.ts` registers config field groups, loads and redacts the effective config, and resolves artifact paths.
- `src/final-demo.ts` owns adapter startup, independent channel status, responder wiring, and clean shutdown.
- `src/cli.ts` is the direct demo entrypoint; `src/deploy-cli.ts` owns the Ollama-backed deployment helper.
- `src/__tests__/` verifies configuration, lifecycle, CLI arguments, and deployment behavior with fixtures rather than product-runtime substitutes.

`src/configuration.ts` is the only demo-local place that registers field groups, loads core plus adapter config, redacts runtime status, and resolves the artifact directory. `src/final-demo.ts` handles lifecycle: start Telegram, A2A, webhook, OpenAI API, and cron independently when config is valid, build the responder, and stop cleanly.

## Run it

Prerequisites: Node.js 22.19.0 or newer and an existing pnpm 10 or newer install.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

The direct demo entrypoint does not load `.env`. When credentials or other env
overrides are needed, keep them in an owner-only file **outside this checkout**
because the repository secret gate deliberately scans ignored and untracked
files. Source that file only inside the short-lived launch subshell:

```bash
DEMO_ENV=/absolute/path/outside-this-checkout/final-agent.env
(
  set -a
  . "$DEMO_ENV" || exit
  set +a
  pnpm run demo:final
)
```

Set the external file mode to `0600`. The subshell prevents its values from
remaining exported in the interactive parent shell.

The demo starts headless and prints status to the terminal:

- the config file path,
- whether Telegram is `running`, `waiting_for_config`, or `failed`,
- whether A2A is `disabled`, `running`, `waiting_for_config`, or `failed`,
- whether webhook is `disabled`, `running`, `waiting_for_config`, or `failed`,
- whether OpenAI API is `disabled`, `running`, `waiting_for_config`, or `failed`,
- whether cron is `disabled`, `running`, `waiting_for_config`, or `failed`,
- whether traceability source registration is `running`, `disabled`, or `failed`.

Edit `mono-agent.config.json` directly (by hand or via an AI agent) to configure the demo. Telegram, A2A, webhook, OpenAI API, and cron start independently: missing Telegram credentials do not block the HTTP or scheduled adapters, and disabled adapters do not block the rest of the host. Config changes are applied on the next restart — there is no live in-process re-apply; stop the demo and start it again to pick up new runtime, tool policy, tokens, allowlists, Agent Card metadata, webhook settings, OpenAI API settings, cron jobs, artifact directory, and trace source settings.

Recorded runs are inspected via the local JSONL artifacts: each source writes persisted `*.summary.json` / `*.events.jsonl` files under its artifact directory. These capture visible runtime/tool/message events and do not infer or expose private model chain-of-thought. When an OTLP exporter is configured, the same runs are also viewable in Phoenix.

## Deploy with Ollama Gemma 4

Use the deployment command when you want the final demo to start with a real local runtime and traceability already wired:

```bash
ollama list
ollama pull gemma4:31b
curl http://localhost:11434/api/tags
pnpm run deploy:final
```

The command builds the repo, verifies `gemma4:31b` is installed in Ollama, writes `.mono-agent/deploy/final-agent-gemma4.config.json`, and starts the headless demo plus loopback A2A provider. It does not write secrets. Generated deployment state is ignored by git:

```text
.mono-agent/deploy/final-agent-gemma4.config.json
.mono-agent/deploy/MEMORY.md
.mono-agent/deploy/workspace/
.mono-agent/deploy/artifacts/
.mono-agent/trace-sources/
```

Useful options:

```bash
pnpm run deploy:final -- --a2a-port 4317
pnpm run deploy:final -- --config ./.mono-agent/deploy/custom.config.json
pnpm run deploy:final -- --no-start
```

The CLI prints the trace source id `final-agent-gemma4`, trace registry, artifact directory, model reference `pi:ollama:gemma4:31b`, and the A2A Agent Card URL. Send a no-secret local smoke request to the printed Agent Card URL:

```bash
node --input-type=module - <<'EOF'
import { sendA2AMessage } from "@mono-agent/a2a-adapter";

const response = await sendA2AMessage({
  agentUrl: "http://127.0.0.1:4317/.well-known/agent-card.json",
  text: "Reply with one sentence from the deployed final demo."
});

console.log(response.text);
EOF
```

Then inspect the recorded run via the local JSONL artifacts under `.mono-agent/deploy/artifacts/`: source `final-agent-gemma4` should have a new A2A run with its `*.summary.json` / `*.events.jsonl` runtime events. When an OTLP exporter is configured, the same run is also viewable in Phoenix. Stop the deployment with `Ctrl-C`; the trace source is marked stopped during shutdown. Telegram remains optional and is not required for this deployment smoke.

## Minimal `mono-agent.config.json`

Put `MONO_AGENT_TELEGRAM_BOT_TOKEN` in the external owner-only `DEMO_ENV` file
loaded by the short-lived launch subshell when Telegram is enabled. Do not
commit bot tokens or provider credentials; the source-config example omits them.

This demo is a programmatic host that passes the A2A driver directly so it can inject test and deployment seams; its A2A settings therefore live in the driver-local top-level `a2a` section. The CLI-equivalent `@mono-agent/agent-app` host loads A2A through `channels.plugins[]` instead; see the main [A2A channel docs](../../docs/channels/a2a.md).

```json
{
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"]
  },
  "a2a": {
    "provider": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 0
    },
    "agent": {
      "name": "Local Agent",
      "description": "Local A2A provider.",
      "version": "0.1.0"
    },
    "skill": {
      "id": "local-agent",
      "name": "Local Agent",
      "description": "Runs the configured runtime over text.",
      "tags": ["agent", "a2a"]
    },
    "consumer": {
      "remoteAgentUrls": [],
      "timeoutMs": 30000
    }
  },
  "webhook": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 0,
    "path": "/webhook/invoke",
    "defaultMode": "sync"
  },
  "openaiApi": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "/v1",
    "modelId": "agent"
  },
  "cron": {
    "enabled": false,
    "expression": "0 * * * *",
    "timezone": "UTC",
    "prompt": "Run scheduled check."
  },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.5",
    "executionMode": "sdk",
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "selectedSkills": []
  },
  "memory": {
    "path": "./MEMORY.md",
    "maxBytes": 64000,
    "writeMode": "disabled"
  },
  "tools": {
    "allowedTools": [],
    "disallowedTools": [],
    "mcpConfigPath": "./mcp.json"
  },
  "artifacts": {
    "dir": "./.mono-agent/artifacts"
  },
  "traceability": {
    "registryDir": "~/.mono-agent/trace-sources",
    "sourceId": "final-agent",
    "sourceLabel": "Final Agent Demo",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000
  }
}
```

Environment variables override the JSON file. Keep provider credentials in the provider/runtime environment expected by `@mono-agent/agent-runtime`; the `mono-agent.config.json` file is not a secret manager.

## OpenWebUI Smoke

Enable the OpenAI API adapter with a real runtime configuration:

```json
{
  "openaiApi": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4311,
    "basePath": "/v1",
    "modelId": "agent"
  }
}
```

Put `MONO_AGENT_OPENAI_API_KEY=demo-key` in the external owner-only `DEMO_ENV`
file loaded by the short-lived launch subshell when client authentication is
desired. Start the demo and use the printed
OpenAI API base URL in OpenWebUI. If OpenWebUI runs in local Docker while the
demo runs on the host, keep the adapter bound to host loopback (`127.0.0.1`) and
use `http://host.docker.internal:4311/v1` from OpenWebUI instead of
`http://127.0.0.1:4311/v1`. Only bind a non-loopback/public host when
`allowNonLoopback` is explicitly enabled; that setup requires
`MONO_AGENT_OPENAI_API_KEY` and should sit behind appropriate network protection
such as a firewall, VPN, TLS-terminating reverse proxy, or private network. Set
OpenWebUI's API key to the same environment value only when one is configured;
otherwise leave the adapter key unset for loopback-only local use.

Authenticated terminal smoke:

```bash
DEMO_ENV=/absolute/path/outside-this-checkout/final-agent.env
(
  set -a
  . "$DEMO_ENV" || exit
  set +a
  : "${MONO_AGENT_OPENAI_API_KEY:?set MONO_AGENT_OPENAI_API_KEY in DEMO_ENV}"
  curl http://127.0.0.1:4311/v1/models \
    -H "Authorization: Bearer $MONO_AGENT_OPENAI_API_KEY"

  curl http://127.0.0.1:4311/v1/chat/completions \
    -H "Authorization: Bearer $MONO_AGENT_OPENAI_API_KEY" \
    -H 'Content-Type: application/json' \
    -d '{
      "model": "agent",
      "messages": [{ "role": "user", "content": "Reply with one sentence." }]
    }'
)
```

## A2A Local Smoke

Start Agent A with A2A provider enabled and a real runtime configuration:

```json
{
  "a2a": {
    "provider": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 4300
    },
    "agent": {
      "name": "Agent A",
      "description": "Local A2A provider.",
      "version": "0.1.0"
    },
    "skill": {
      "id": "agent-a",
      "name": "Agent A",
      "description": "Answers text prompts.",
      "tags": ["agent", "a2a"]
    }
  }
}
```

The CLI prints an Agent Card URL such as:

```text
a2a:       running - http://127.0.0.1:4300/.well-known/agent-card.json
```

From another local Mono host or a one-off package smoke, discover Agent A and send text:

```bash
DEMO_ENV=/absolute/path/outside-this-checkout/final-agent.env
(
  set -a
  . "$DEMO_ENV" || exit
  set +a
  node --input-type=module - <<'EOF'
import { sendA2AMessage } from "@mono-agent/a2a-adapter";

const bearerToken = process.env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN;
const response = await sendA2AMessage({
  agentUrl: "http://127.0.0.1:4300/.well-known/agent-card.json",
  text: "Say hello from Agent B.",
  ...(bearerToken ? { bearerToken } : {})
});

console.log(response.text);
EOF
)
```

For bearer authentication, put `MONO_AGENT_A2A_REQUIRE_BEARER=true`,
`MONO_AGENT_A2A_BEARER_TOKEN`, and
`MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN` in the external owner-only `DEMO_ENV`
file. The launch and consumer subshells source it only for their child
processes; the example above reads the consumer token from that environment.
The public Agent Card remains discoverable, but message/task endpoints require
`Authorization: Bearer`.

## Ollama Local Provider

To run the demo through a local Ollama model, start Ollama, pull a chat model, and point the Pi runtime reference at the local provider id:

```bash
ollama pull qwen3:8b
pnpm run demo:final
```

```json
{
  "runtime": {
    "model": "pi:ollama:qwen3:8b",
    "executionMode": "sdk",
    "workspace": "."
  },
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true,
        "models": [
          { "name": "qwen3:8b", "capabilities": { "context_window": 32768 } }
        ]
      }
    ]
  }
}
```

Standard local Ollama needs no API key. The demo validates local-provider URLs before Telegram starts: private/local HTTP(S) URLs are allowed, while public URLs must use `https://` and set `trustPublicUrl: true`.

For artifact lookup, `MONO_AGENT_ARTIFACT_DIR` wins, then `artifacts.dir` from `mono-agent.config.json`, then the built-in `./.mono-agent/artifacts` default. This lets the local JSONL artifacts capture existing default runs even while the rest of the demo config is incomplete.

For source discovery, `MONO_AGENT_TRACE_REGISTRY_DIR` wins, then `traceability.registryDir`, then `~/.mono-agent/trace-sources`. The default is intentionally host-shared so multiple agent processes from different working directories appear in one local dashboard. Source id and label can be set with `MONO_AGENT_TRACE_SOURCE_ID` / `MONO_AGENT_TRACE_SOURCE_LABEL` or `traceability.sourceId` / `traceability.sourceLabel`; otherwise the demo uses a deterministic path-derived id and the label `Final Agent Demo`. Heartbeat and stale intervals follow `MONO_AGENT_TRACE_HEARTBEAT_MS` / `MONO_AGENT_TRACE_STALE_AFTER_MS`, then `traceability.heartbeatMs` / `traceability.staleAfterMs`, then the built-in defaults.

Useful entries for the external owner-only `DEMO_ENV` file sourced by the
short-lived launch subshell:

```dotenv
MONO_AGENT_TELEGRAM_BOT_TOKEN=...
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=...
MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS=false
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.5
MONO_AGENT_IDENTITY_PATH=./IDENTITY.md
MONO_AGENT_LOCAL_PROVIDER_ID=ollama
MONO_AGENT_LOCAL_PROVIDER_TYPE=ollama
MONO_AGENT_LOCAL_PROVIDER_BASE_URL=http://localhost:11434
MONO_AGENT_A2A_PROVIDER_ENABLED=true
MONO_AGENT_A2A_HOST=127.0.0.1
MONO_AGENT_A2A_PORT=4300
MONO_AGENT_A2A_REQUIRE_BEARER=true
MONO_AGENT_A2A_BEARER_TOKEN=...
MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN=...
MONO_AGENT_A2A_AGENT_NAME="Local Agent"
MONO_AGENT_A2A_AGENT_DESCRIPTION="Local A2A provider."
MONO_AGENT_A2A_AGENT_VERSION=0.1.0
MONO_AGENT_A2A_SKILL_ID=mono-agent
MONO_AGENT_A2A_SKILL_NAME="Local Agent"
MONO_AGENT_A2A_SKILL_DESCRIPTION="Runs the configured runtime over text."
MONO_AGENT_A2A_REMOTE_AGENT_URLS=http://127.0.0.1:4300/.well-known/agent-card.json
MONO_AGENT_WEBHOOK_ENABLED=true
MONO_AGENT_WEBHOOK_HOST=127.0.0.1
MONO_AGENT_WEBHOOK_PORT=4310
MONO_AGENT_WEBHOOK_PATH=/webhook/invoke
MONO_AGENT_WEBHOOK_DEFAULT_MODE=sync
MONO_AGENT_OPENAI_API_ENABLED=true
MONO_AGENT_OPENAI_API_HOST=127.0.0.1
MONO_AGENT_OPENAI_API_PORT=4311
MONO_AGENT_OPENAI_API_BASE_PATH=/v1
MONO_AGENT_OPENAI_API_MODEL_ID=mono-agent
# Use a strong value outside demos; keep this file mode 0600.
MONO_AGENT_OPENAI_API_KEY=demo-key
MONO_AGENT_CRON_ENABLED=true
MONO_AGENT_CRON_EXPRESSION="0 * * * *"
MONO_AGENT_CRON_TIMEZONE=UTC
MONO_AGENT_CRON_PROMPT="Run scheduled check."
MONO_AGENT_TRACE_REGISTRY_DIR=~/.mono-agent/trace-sources
MONO_AGENT_TRACE_SOURCE_ID=final-agent
MONO_AGENT_TRACE_SOURCE_LABEL="Final Agent Demo"
```

## Persistent memory (tiered bujo memory)

The agent supports three memory tiers, all sharing a single global brain across every channel. The tier is selected by `memory.mode` in `mono-agent.config.json`. See [`docs/memory/index.md`](../../docs/memory/index.md) for the full reference.

| Tier (`memory.mode`) | Description | What it needs |
|---|---|---|
| `lite` | FTS-only recall, no deps | Just a writable path |
| `journal` | Hybrid FTS + vector recall with daily rolling notes | Ollama `nomic-embed-text:v1.5` |
| `bujo` | `journal` + LLM-driven entity capture, reflection, migration, and auto-scheduled rituals | Ollama embeddings + a local chat LLM |

**Minimal bujo config** (Ollama-backed, auto-scheduled rituals):

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5" },
    "llm": { "provider": "ollama", "model": "qwen3:6b" }
  }
}
```

`writeMode: "append-host-summary"` appends a concise turn summary to today's daily note after every completed turn. The `llm` block enables nightly reflection (entity extraction + graph update, default `0 3 * * *`) and monthly migration (archive compaction, default `0 4 1 * *`) — both auto-scheduled as internal cron jobs, no external MCP server needed.

`IDENTITY.example.md` includes a *Memory discipline* section covering host-driven capture and the single read-only `MemoryRecall` tool; copy it into your `IDENTITY.md`.

## CLI options

```bash
pnpm run demo:final -- --config ./mono-agent.config.json
pnpm run deploy:final -- --model gemma4:31b --ollama-url http://localhost:11434 --a2a-port 4300
```

- `--config <path>` changes the config file path.
- `deploy:final` also accepts `--model <ollama-tag>`, `--ollama-url <url>`, `--a2a-port <port>`, and `--no-start`.

## Safety notes

- Traceability is local-only. The registry stores source manifests; run details stay in each source's local artifact directory.
- Telegram bot tokens are redacted in status output and demo diagnostics.
- Telegram chat ids are redacted in demo diagnostics.
- The A2A provider binds to loopback by default. Non-loopback bind or advertised public URLs require explicit opt-in and should be deployed only behind HTTPS plus bearer auth.
- A2A bearer tokens are redacted from status output.
- The webhook adapter binds to loopback by default and does not implement built-in authentication. Public exposure must be protected by the host or reverse proxy.
- The OpenAI API adapter binds to loopback by default. Its API key is optional for local loopback use, redacted in status output, and required on every request when configured.
- Cron jobs schedule future ticks only. Missed ticks are not persisted or replayed after restart, and overlapping ticks for the same job are skipped.
- Trace event payloads are bounded and sensitive keys such as tokens, authorization headers, passwords, cookies, and API keys are redacted. Redaction is defensive, not a guarantee for arbitrary user-provided secret text.
- The demo uses fake runtime/Telegram only in tests. The CLI path uses the real adapters, poller/server, and runtime adapter.
- Trace export to Phoenix is via an optional OTLP exporter. When unconfigured, runs stay local-only in the JSONL artifacts; configuring an exporter adds an OTLP endpoint without storing external secrets in `mono-agent.config.json`.
