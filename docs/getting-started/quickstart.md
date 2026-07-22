---
title: "Your First Agent"
description: "Create, validate, start, and shape a first mono-agent through the guided setup flow."
sidebar:
  order: 2
---

This page walks the macOS happy path: complete the guided `mono-agent init` wizard, let it start the durable background agent, and use the dedicated SELF-CONFIG conversation to explore capabilities and shape the agent's workflow. A real model reply still requires provider credentials or a configured local provider.

## The shortest working path

If Node.js and a model provider are already ready, start here:

```bash
npm i -g create-mono-agent
mkdir my-agent && cd my-agent
mono-agent init
mono-agent status      # guided macOS init starts the agent
# Otherwise: mono-agent start --foreground
```

The wizard reviews the files before writing, proves each selected runtime route, validates the committed folder, and opens `[SELF-CONFIG]` on macOS. If you use flags, non-TTY input, Linux, or another platform, init creates the scaffold without claiming readiness; run `mono-agent validate`, then `mono-agent start --foreground` yourself. The rest of this page explains those branches and their safety contracts.

## Prerequisites

You need Node.js installed, the `mono-agent` CLI available, and credentials for whatever model you choose. The quickest path is the `npm create mono-agent@latest` installer (equivalently `npx create-mono-agent`) with no global install, or `npm i -g create-mono-agent` for the persistent command. The CLI itself ships in `@mono-agent/agent-app`, so installing or invoking that scoped package is equivalent.

Guided init searches every bundled model for Pi Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go; the live Codex account catalog when available; the Claude SDK catalog; and discovered local models. Other hand-authored Pi refs and `providers.local[]` remain runtime-compatible but are outside guided cloud-provider setup. The provider-declared Codex default leads when discovery succeeds; curated `codex:gpt-5.6-terra` is the offline fallback. The offline entry does not guess effort support and therefore offers only **Provider default** until live `model/list` metadata is available. The wizard keeps catalog availability, credential detection, and live verification separate. It does not install Codex silently; use only the [official Codex CLI instructions](https://developers.openai.com/codex/cli/). Browser login runs `codex login`; a remote/headless machine can select `codex login --device-auth`. GPT-5.6 Sol is available as `codex:gpt-5.6-sol` or `pi:openai-codex:gpt-5.6-sol`. See [Install](/getting-started/install/) and [Environment Variables](/config/env-vars/) for other backends.

If you are testing unreleased source from a clone, replace `mono-agent` in the commands below with the built CLI entry:

```bash
node /absolute/path/to/mono-agent/packages/agent-app/dist/cli.js
```

## 1. Scaffold the folder (`cli`)

Run bare `init` inside an empty folder on a TTY. This guided path is the only init mode that proves readiness:

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

The wizard starts from a [preset](/reference/presets/) or custom answers, asks what the agent should be called, and labels the next answer as the exact Role text for `IDENTITY.md` → `## Role`. Creation review repeats both the destination and the exact text. If `IDENTITY.md` already exists, the wizard says it will remain unchanged and that the entered Role will not be written. It then walks through the same model, channel, memory, runtime-appropriate tool/safety, and observability decisions either way. Type to search the primary and fallback catalogs; add as many fallbacks as you need and choose each route's supported effort or **Provider default**. Escape moves back one logical step. Ctrl-C asks before exiting.

Journal and BuJo add a dedicated local-embeddings step. Choose Ollama or LM Studio,
confirm its service root, select a model from provider-native typed discovery, and let the
wizard prove and record the actual vector dimension. Ollama discovery checks `/api/show`
for the `embedding` capability; LM Studio accepts only `/api/v1/models` entries whose type
is `embedding`. If discovery is unavailable you may enter the model and a positive dimension
manually, but guided readiness still requires a real `/api/embed` or `/v1/embeddings` probe.
The selected provider never falls back to the other one. LM Studio is keyless by default;
when its server uses authentication, name the populated owner-only `.env` variable through
`apiKeyEnv` rather than putting a token in config.

**Allow all tools** is the default and includes shell, file, web, and enabled channel-send tools. `runtime.routeSafety: "uniform"` keeps one common fail-closed contract. A mixed Pi/Claude/Codex/OpenCode chain requires explicit `per-route-native` acceptance after the wizard displays the concrete route matrix. Pi keeps mono-agent tools and optional managed SRT; provider-owned routes use their documented native contract. Unsupported capabilities are never silently dropped.

After the explicit **Creation review**, the wizard makes one disposable no-tool call for every selected route, sequentially, with a 90-second cloud or 240-second local deadline per route. A detected Codex/Claude sign-in or Pi auth-store entry skips redundant authentication, but it is not called verified until the exact route succeeds. Escape or Ctrl-C interrupts safely. Recovery can resume routes already verified under the same non-secret plan fingerprint, restart all checks, edit choices, or cancel without writing. Choosing authentication repair clears all prior route proofs before the checks rerun. Provider failure, timeout, empty output, or any tool action fails that route. On macOS, **Agent ready** additionally requires the committed config and every selected credential, channel, sandbox, memory, and observability expectation to be ready. The managed background process must then prove its live identity, exact committed snapshot, durable environment, and reachable TUI endpoint before the wizard opens the TUI. See [Setup security and managed runtime](/reference/setup-security/) for the closure-integrity, single-instance, frozen-input, and snapshot-commitment contracts behind that proof.

Passing any flag or running without a TTY skips the wizard and writes a scaffold only. It never runs the readiness proof, starts a process, or labels the result ready. These flags remain useful for automation:

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--name <display-name>` | Public agent name. Display metadata only; never used for paths/service/session ids. |
| `--model <ref>` | Primary runtime model. Format: `pi:<provider>:<model>`, `claude:*`, `codex:*`, or `opencode:*`. Defaults to `codex:gpt-5.6-terra`; selectable Sol refs are `codex:gpt-5.6-sol` and `pi:openai-codex:gpt-5.6-sol`. |
| `--fallback <ref>` | Repeatable canonical fallback route. Follow immediately with `--fallback-effort <provider-default\|level>` when needed. |
| `--route-safety uniform\|per-route-native` | Common monotonic contract (default) or explicit isolated provider-native route contracts. |
| `--codex-auth browser\|device` | Direct Codex login mode when `--auth` runs; `device` is for headless hosts. |
| `--memory lite\|journal\|bujo` | Adds a `memory` section with the chosen tier. Omit it and no memory is configured. See [Capture and Recall](/memory/capture-and-recall/). |

A fuller example:

```bash
mono-agent init \
  --name "Research Companion" \
  --model pi:openai-codex:gpt-5.6-terra \
  --fallback claude:claude-sonnet-5 --fallback-effort xhigh \
  --fallback pi:ollama:gemma4:31b --fallback-effort provider-default \
  --route-safety per-route-native \
  --memory bujo
```

### What `init` scaffolds

`init` is non-destructive for scaffold/config files (`app.cli-init`): existing config, identity, and capability files are reported as unchanged. Guided secret setup is the explicit exception and may securely harden/update `.env` plus `.gitignore`. In a clean folder it creates:

- **`mono-agent.config.json`** — the single config file that declares the whole agent. It enables the **webhook channel** (`webhook.enabled: true`) as the zero-credential smoke channel so you can get a response immediately, and wires `artifacts`, `traceability`, and `context.identityPath` to the scaffolded paths.
- **`IDENTITY.md`** — the reviewed Role is stored only as the body of `## Role`, alongside boundaries and a Knowledge section that references any `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` already present in the folder. An existing file is preserved byte-for-byte; in that case the entered Role is not written, and you add or edit its `## Role` section later. See [Identity and Soul](/context/identity-and-soul/).
- **`skills/mono-agent-configure` and `skills/mono-agent-memory`** — versioned project-local skills selected with index disclosure. `ReadSkill` loads their bodies only when needed. `skills/.mono-agent-managed.json` records their hashes for safe drift checks and updates.
- **`.mono-agent/`** — working directories: `.mono-agent/artifacts` (run output) and `.mono-agent/workspace`.

When a fresh init selects built-in Journal or BuJo memory, init also creates one empty managed generation without indexing content. Guided setup has already made its separate fixed, non-user readiness probe; flag/non-TTY scaffolding makes no provider call and no readiness claim. Init never adopts or changes a pre-existing memory root; stop the agent and use the explicit `mono-agent memory rebuild` path for an existing root. Fresh managed init rejects environment overrides for memory backend, mode, path, and embedding provider/model/dimension; put that identity in the generated config. Credential and endpoint environment values remain valid inputs.

The generated config (with canonical `--fallback` routes and `--memory bujo`) looks like this — note that `tools.allowedTools` defaults to allow-all (`["*"]`), and the `bujo` tier scaffolds its embeddings, capture LLM, and recall tool:

```json
{
  "agent": { "name": "Research Companion" },
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra",
    "fallbacks": [
      { "model": "claude:claude-sonnet-5", "effort": "xhigh" },
      { "model": "pi:ollama:gemma4:31b" }
    ],
    "routeSafety": "per-route-native",
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["mono-agent-configure", "mono-agent-memory"],
    "skillDisclosure": "index"
  },
  "tools": {
    "allowedTools": ["*"],
    "disallowedTools": []
  },
  "artifacts": {
    "dir": "./.mono-agent/artifacts"
  },
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceLabel": "Research Companion"
  },
  "webhook": {
    "enabled": true
  },
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.6-terra" },
    "recallTool": { "enabled": true }
  }
}
```

Every field has a `MONO_AGENT_*` env override (env > JSON > defaults) — for example `MONO_AGENT_NAME`, `MONO_AGENT_MODEL`, and `MONO_AGENT_FALLBACKS_JSON`. See [Configuration](/config/) for the annotated blueprint. The scaffolder also adds an `artifacts.retention` block and a `$schema` reference, omitted here for brevity.

For selected channel secrets, the guided wizard never shows values in config, examples, review output, or logs. Existing non-empty dotenv assignments and comments are preserved, and a shell-only value cannot make a later background start appear durable. Automatic persistence fails closed when the agent folder, dotenv, ignore rules, or a concurrent update cannot be verified safely; unsupported platforms receive manual instructions. The complete ownership, locking, promotion, race-recovery, and provider-auth-store rules live in [Setup security and managed runtime](/reference/setup-security/). Never copy `.env.example` over an already populated `.env`.

## 2. Build the workflow in SELF-CONFIG (`cli`)

After a successful guided readiness proof on macOS, init starts the background agent, waits for its ready trace source, and opens this remote mode automatically:

```bash
mono-agent tui --configure
```

The console carries a persistent `[SELF-CONFIG]` marker and exit hint. The opening guide maps identity/knowledge, runtime/models, skills/tools/MCP/plugins, memory, channels/APIs/A2A, automation, security, observability/operations, and acceptance criteria once, then lets you choose where to start. It helps build the workflow from trigger → context/data → tools/actions → delivery → memory → safety/operations → success checks, one focused question at a time. Do not enter secrets. The agent may prepare one minimal RFC 6902 proposal for a decision-complete checkpoint, but it cannot apply anything. The local host validates the candidate, shows a separate approve/reject review, and writes only after your confirmation.

Approval, rejection, proposal-free turns, `done`, and `no changes` all keep SELF-CONFIG active with the same conversation id and a freshly rotated proposal capability. A fixed host-outcome summary tells the next turn what actually happened. Every non-command message remains configuration-marked; `/configure` simply reports that the session is already active. Only `/quit`, `/exit`, or `ctrl+c` twice exits self-configuration, and quitting does not stop the background agent.

The conversational patch surface is intentionally small: public name; effort, turn/session UX; selected project skills and disclosure; memory size or MemoryRecall enablement; semantic tool-policy tightening; and the separately validated `## Role` body in the identity file resolved from `context.identityPath`. Paths, memory tier/capture behavior, secrets, model/provider or runtime-permission changes, external MCP servers/plugins, channels and cron/proactive jobs, exporters or embeddings/LLM endpoints, sandbox/network policy, and unknown future fields are refused for direct application and handed to an explicit guided flow. During the configuration conversation, ordinary action tools and configured MCP servers are replaced by `ReadSkill`, `MemoryRecall`, and the inert proposal server. Pure direct-Codex chains use native read-only plan mode; mixed chains retain the finite proposal surface. Because direct OpenCode cannot receive the proposal MCP capability, a direct-OpenCode primary uses a configured capable fallback and a direct-OpenCode fallback makes self-configuration refuse explicitly.

After approval, the host commits the files, restarts the launchd agent, waits for its new ready trace source, swaps the TUI endpoint, and continues SELF-CONFIG against the verified agent. If the new configuration cannot start, it restores the prior files, restarts the previous agent, reports the recovery, and continues without assuming the rejected change is active. Text submitted while a turn or host transaction is settling remains in the editor until you explicitly submit it after readiness; it is never sent as ordinary chat. If rollback or recovery restart fails, the marker remains visible, the unverified endpoint disconnects, and the console reports manual recovery instead of claiming success. Use `mono-agent status`, `mono-agent logs --follow`, `mono-agent restart`, and `mono-agent stop` to inspect or recover the managed instance, then quit and reopen SELF-CONFIG.

Existing agents may have managed skill version `1.1.0`, whose instructions describe the old one-shot exchange. Startup does not rewrite project skills. Check and explicitly refresh an unchanged managed copy with `mono-agent install-skill --project --check` and `mono-agent install-skill --project --update`; modified copies require manual reconciliation.

Conversational configuration is unavailable off macOS because it depends on managed restart, readiness, and rollback. The wizard preserves the files without a readiness claim. Edit `mono-agent.config.json` and `IDENTITY.md` manually, run `mono-agent validate`, then run `mono-agent start --foreground` in Terminal 1 and ordinary `mono-agent tui` in Terminal 2.

## 3. Validate (`cli`)

Check the config section by section before starting:

```bash
mono-agent validate
```

`validate` (`app.cli-validate`) prints a per-section report — core, runtime,
provenance and routes, provider credentials, context, memory, tools, sandbox,
observability, runs health, managed launchd logs, secret placement, and every
channel — each tagged with a status. The launchd-log section reports active,
retained, and total bytes for every safely inspected stream, reports unsafe or
unreadable inventory as unavailable, and never rotates or changes permissions:

| Status | Meaning | Action |
| --- | --- | --- |
| `[ok]` | Section is healthy. | None. |
| `[waiting]` | Enabled but missing a credential, process, or live dependency. | Resolve it before calling the selected capability ready. |
| `[disabled]` | Capability is off (not enabled in config). | None. |
| `[error]` | A real misconfiguration. | Fix before starting. |

Fix every `[error]` section. Standalone `validate` keeps `waiting` non-fatal for operators intentionally starting partial configurations, so exit `0` means structurally valid, not that every selected capability is live. The guided wizard's **Agent ready** gate is stricter: no selected expectation may be waiting, and every selected runtime route must have succeeded in its exact live check. Read-only `codex login status` / `claude auth status --json` is credential detection, not a model-turn claim. Hidden memory and static-trigger dependencies are also validated.

:::tip
Source-build validation from a separate clean folder should use the worktree CLI explicitly:

```bash
repo=/absolute/path/to/mono-agent
agent_dir=$(mktemp -d)
cd "$agent_dir"
node "$repo/packages/agent-app/dist/cli.js" init --model codex:gpt-5.6-terra
node "$repo/packages/agent-app/dist/cli.js" validate
```
:::
Point validate at a non-default config or env file with `mono-agent validate --config ./other.config.json --env-file ./.env`. To check a downstream agent folder from elsewhere, use `mono-agent validate --consumer ../local-agent-alpha`; the consumer `.env` loads by default and relative `--config` / `--env-file` paths resolve inside that folder.

## 4. Start or inspect the service (`cli`)

```bash
mono-agent start
```

Guided macOS init has already started this service before configuration mode. Run `mono-agent status` to inspect it; use `mono-agent start` when continuing from a scaffold or manually recovered setup. This boots the runtime and every enabled channel. The webhook channel listens on loopback (`127.0.0.1`) and, because the default `port` is `0`, picks a free port. `start` prints the resolved webhook **invoke URL** — copy it for the smoke test below.

On macOS, `mono-agent start` backgrounds the agent with launchd and returns. On other platforms, use `mono-agent start --foreground`.

## 5. Smoke-test with curl

Send a request to the printed webhook path. The default endpoint path is `/webhook/invoke` and the default mode is `sync`, so the HTTP response carries the agent's reply directly:

```bash
PORT=3000 # Replace 3000 with the printed port.
curl -s "http://127.0.0.1:${PORT}/webhook/invoke" \
  -H 'content-type: application/json' \
  -d '{"text": "Say hello and tell me what you are."}'
```

Replace `3000` with the port from the `start` output. A response means the runtime, model, identity, and webhook channel are all wired correctly — you have a working agent. Without valid provider credentials or a reachable local provider, the webhook request should fail honestly rather than returning a fake model reply.

:::note
Time-to-first-validated-folder is usually under a minute when Node is installed and the CLI package or source build is already available: `mkdir`, `init`, and `validate` are local filesystem/config checks. Time-to-first-reply is not a fixed promise; it depends on provider auth, network latency, model availability, and whether dependencies need to be installed or built first.
:::
The webhook channel binds to loopback by default. To accept non-loopback requests you must set both `webhook.allowNonLoopback: true` and `MONO_AGENT_WEBHOOK_API_KEY` (plus, ideally, a non-zero `port`); callers send the key as a bearer on invocation and status requests. A key is optional on loopback and leaving it unset preserves the zero-credential smoke flow above. For async invocation, status polling, multiple named endpoints, and per-endpoint prompts, see [Webhook](/channels/webhook/).

## Where to next

- Turn this into a real assistant: add a credentialed channel like [Telegram](/channels/telegram/) or [Slack](/channels/slack/).
- Understand the moving parts: [Core Concepts](/getting-started/concepts/).
- See the full config surface: [Configuration](/config/) and the [Config Blueprint](/config/blueprint/).
- Build something end to end: the [Playbooks](/playbooks/) — e.g. [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) or [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/).
- Embed the agent in your own code instead of the CLI: [Programmatic](/programmatic/).
