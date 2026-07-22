---
title: "Presets & capability modules"
description: "Understand guided setup capability modules, built-in presets, creation review, and validation commands."
sidebar:
  order: 6
---

`mono-agent init` builds an agent by composing **capability modules** — a channel here, a memory tier there, an optional sandbox — and walking you through the settings that matter. On a TTY, bare `init` asks for the public agent name, provides searchable Pi/Codex/Claude primary and fallback catalogs, and proves every selected route before it calls the agent ready. Escape goes back; Ctrl-C asks before exiting. With `--yes` or any flag (or without a TTY) it writes a scaffold only and never makes a readiness claim.

Tools default to **allow-all** (`["*"]`), so a fresh agent can act out of the box. For Pi and Claude, the wizard discloses that this includes shell/file/web and enabled channel-send tools and requires an additional confirmation when no enforceable sandbox will constrain them. Direct Codex fixes the policy to exact allow-all and reports its own network-off workspace sandbox instead of asking the mono-agent tool/sandbox questions. Other runtimes can narrow the surface where they enforce allowlists, and `disallowedTools` subtracts individual tools where supported.

**Presets** are saved answer-sets for common shapes. In the interactive wizard they seed, rather than lock, the model, channels, memory, tools, sandbox, and observability choices; the same questions still run before a write. Final **Creation review** lists the named agent, exact routes/efforts, safety contracts, provider/SRT actions, files, secret destinations, and real/potentially billed call counts. `Create “<name>”?` then offers setup-and-create, edit, or cancel without writing.

## Commands

```bash
mono-agent init                              # interactive wizard (preset or custom), then validate
mono-agent init --preset <id> --yes          # scaffold from a preset, non-interactively
mono-agent presets list                      # the built-in presets with risk levels
mono-agent presets show <id>                 # generated config + .env.example + checklist
mono-agent validate --preset <id>            # completeness report against the preset's promises
```

The wizard first asks whether to start from a preset or go fully custom, then prompts for public name, searchable model/fallback routes and per-model effort, channels, memory, tools, route safety/SRT, observability, and a concrete creation review. Before any real or potentially billed model call, it stages the complete selected-capability configuration against the effective files init will create or preserve; only a `waiting` credential that the live route can prove is deferred. Configuration failures name the capability and open the existing seeded answers at the implicated section when unambiguous, rather than offering unrelated authentication/model recovery. Once configuration passes, the wizard runs one strict no-tool call per selected route (90 seconds cloud, 240 seconds local each). Escape/Ctrl-C interrupts safely before the next route, then offers resume/restart/edit/cancel; unchanged verified routes can resume, while changing any route or effort invalidates the route-plan proofs and credential changes do the same. Any selected `waiting` expectation keeps the scaffold explicitly incomplete. `--dry-run` is scaffold-only and previews files without writing them.

## Presets

Each preset maps to a copy-paste [playbook](/playbooks/) that walks the same setup end-to-end with credentials and a smoke test.

| Preset | What you get | Risk | Playbook |
| --- | --- | --- | --- |
| `starter` | Webhook loopback, no credentials, no memory — the lowest-friction smoke agent. | low | [Webhook automation](/playbooks/webhook-automation-sync-async/) |
| `telegram-assistant` | A Telegram bot with daily-log capture + semantic recall (BuJo memory). | medium | [Telegram personal assistant](/playbooks/telegram-personal-assistant-bujo/) |
| `slack-bot` | A Socket-Mode Slack bot scoped to a channel allowlist, with the send tool. | medium | [Slack team bot](/playbooks/slack-team-bot-mcp-tools/) |
| `local-private` | Runs entirely on a local Ollama provider with journal memory — no remote calls. Light 8B default for a fast first turn. | low | [Local-only Ollama agent](/playbooks/local-only-ollama-agent/) |
| `code-sandbox` | Native `srt` sandbox with workspace-only filesystem and code tools; fails closed without `srt`. | medium | [Sandboxed code agent](/playbooks/sandboxed-code-agent/) |

Risk levels reflect blast radius, not difficulty: `low` presets expose nothing beyond loopback and need at most a model key; `medium` presets talk to external services, hold channel credentials, or run shell/file tools you should read before running.

Supermemory is no longer a core preset. Install the exact matching
`@mono-agent/memory-supermemory` plugin, then use its bundled
`mono-agent-supermemory` skill or the [Telegram + Supermemory
playbook](/playbooks/telegram-supermemory-memory/) to apply the explicit config.

## Capability modules

The wizard composes an agent from these modules. Selecting one auto-checks its recommended tools in the tools step (see below), so the agent can actually use the capability. Module ids are what `--with`, presets, and the composer reference internally.

| Module | What it adds | Recommends tools |
| --- | --- | --- |
| `channel:webhook` | HTTP loopback endpoint — the zero-credential smoke channel. | — |
| `channel:telegram` | Chat with your agent via a Telegram bot (chat-id allowlist). | `TelegramSendMessage` |
| `channel:slack` | Socket-Mode Slack bot scoped to a channel allowlist. | `SlackSendMessage` |
| `channel:openai-api` | Expose the runtime as an OpenAI-compatible loopback endpoint. | — |
| `channel:cron` | Run on a five-field schedule (`minute hour day-of-month month day-of-week`, UTC by default). Guided init validates it inline, then scaffolds `cron/digest.md`; seconds and macros such as `@daily` are unsupported. Hashed `H` fields use the stable job `id` as their seed. | — |
| `channel:a2a` | Expose the agent over A2A (Agent Card + provider endpoint). | — |
| `memory:lite` | SQLite full-text recall, zero external dependencies. | — |
| `memory:journal` | Semantic recall via a guided Ollama or LM Studio embeddings service. | — |
| `memory:bujo` | Daily-log capture plus semantic recall via guided Ollama or LM Studio embeddings; capture LLM remains explicit. | — |
| `memory:supermemory` | External Supermemory instance for server-side extraction + recall. | — |
| `sandbox` | Native `srt` sandbox: workspace-only FS, localhost network, fails closed. | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` |
| `observability:phoenix` | Best-effort Phoenix OTLP export, sensitive data excluded. | — |

### The tools step and the no-tools guardrail

The tools step first frames the three tool families so you know what the decision covers:

- **Always on** — auto-provisioned and **not** gated by this choice: `MemoryRecall` (when the memory tier enables recall), plus `ReadSkill` and MCP-server tools (`mcp__…`, owned by their servers). These are shown dimmed for clarity, never as a checkbox.
- **Built-ins** — files (`Read`/`Write`/`Edit`/`Glob`/`Grep`), shell (`Bash`), JavaScript (`NodeRepl`), and web (`WebFetch`/`WebSearch`).
- **Channel tools** — the send tools that came with the channels you enabled (for example `TelegramSendMessage` and `SlackSendMessage`), plus `AskUser` (structured human input on web, Slack, or Telegram).

For Pi and Claude it then asks a single **"Allow all tools? [Yes]"** — the default. Accepting writes `tools.allowedTools: ["*"]` (every built-in available on each route and every enabled channel's send tools; the "Always on" family is unaffected). The wizard spells out that this includes shell/JavaScript execution, file, web, and channel-side effects. If no enforceable sandbox constrains that runtime, it requires a second explicit confirmation before accepting the unsandboxed allow-all surface. Direct `codex:*` skips these questions: normal runs require exact allow-all and use the Codex-native network-off workspace sandbox with unattended escalation denied. Guided readiness rejects manually entered direct `opencode:*` because it cannot prove that advanced backend's credential/permission posture; choose `pi:opencode-go:*`, or use a flagged/non-TTY scaffold and configure OpenCode's native `permissionMode` explicitly.

Declining drops into a specific-tool multiselect, pre-checked with a safe read-only default (`Read`, `Glob`, `Grep`) plus every selected module's recommended tools. Direct Codex/OpenCode cannot enforce this narrower surface in normal runs; direct Codex never offers it, while direct OpenCode is outside guided readiness entirely. Validation rejects a hand-written restrictive combination instead of silently widening permissions. Turning individual tools **off** is otherwise a config-level concern (`tools.disallowedTools`), not a wizard prompt.

The default scaffold therefore writes `"allowedTools": ["*"]`, and [`validate`/`doctor`](/observability/cli-reference/#validate) reports `All tools allowed.` (or `All tools allowed (except: …)` when a `disallowedTools` list is present).

The no-tools guardrail still catches the deliberate chat-only case on runtimes that can enforce it. Decline "Allow all" and then deselect everything and the wizard warns loudly — "⚠ Zero tools selected — the agent will be chat-only" — and makes you confirm before continuing. The same guardrail runs after the fact: an **explicit empty** `tools.allowedTools: []` reports `waiting` on Pi/Claude SDK (never a silent `ok`). Direct Codex/OpenCode and Claude Code CLI reject the unenforceable empty policy as an error before provider startup. The supported warning reads:

```text
No tools allowed — the agent can chat but cannot read files, run commands, or send
proactive messages. Add names to tools.allowedTools (e.g. Read, Glob, Grep), or re-run
`mono-agent init` in an empty folder to pick tools interactively.
```

For a **specific** allowlist, `validate`/`doctor` also flag an **unknown tool name** with a "did you mean" hint (e.g. `read` → `Read`; pi silently drops unknown names), and cross-check adapter **send tools against channels** — a `TelegramSendMessage` in the allowlist with Telegram disabled downgrades the tools section to `waiting` with a note; the reverse — a channel enabled with no matching send tool — is a non-fatal hint (the section stays `ok`: replies still work, but the agent can't send proactively). Under allow-all these per-name checks don't apply.

## Sandbox

The `sandbox` module (and the Pi-backed `code-sandbox` preset) generate `"sandbox": { "mode": "native" }`. On macOS, mono-agent installs the pinned SRT dependency tree into a private per-user cache; no global `srt` is required. Under uniform route safety, routes that cannot enforce the common SRT contract fail closed. Explicit per-route-native chains may include provider-owned routes only after reviewing that SRT remains Pi-only. Check the engine before trusting the sandbox:

```bash
mono-agent sandbox status
mono-agent sandbox setup
mono-agent sandbox check
mono-agent validate --preset code-sandbox
```

The composed sandbox sets `fallback: "fail-closed"`. Setup/check proves filesystem and localhost/domain enforcement, not just a version command. If SRT is absent, corrupt, or fails the proof, sandboxed commands stop with `sandbox_unavailable`; a corrupt managed install never falls back to `PATH`.

`mono-agent start` and `mono-agent status` surface the effective sandbox state (`native`, `blocked`, `unsafe-host-process`, or `off`), the engine availability, the fallback, and whether the fallback is active. The intentionally-unsafe `unsafe-host-process` fallback (roots/denyWrite inert, commands run unsandboxed when `srt` is missing) is not a wizard choice — set `sandbox.fallback` explicitly in the JSON if you accept that consequence for a trusted local operator profile. Existing configs are never rewritten.

## How presets relate to the config

A preset is not a separate format — `mono-agent presets show <id>` prints the exact `mono-agent.config.json` it would write, plus the `.env.example` and follow-up checklist. Everything a preset (or the wizard) configures can be edited afterwards like any hand-written config, and [`mono-agent config`](/observability/cli-reference/#config) shows the resolved result field-by-field with provenance. The preset catalog lives in `packages/agent-app/src/wizard/presets.ts` and the module catalog in `packages/agent-app/src/modules/catalog.ts`; a parity test (`presets-docs-parity.test.ts`) keeps this page in sync with them.

## Back-compat: legacy tool names

Most tools were renamed to PascalCase (`SlackSendMessage`,
`TelegramSendMessage`, and others). Existing hand-written policy entries for the
remaining send/file/skill aliases continue to validate so an old deny-list does
not silently broaden access. Canonical names are the only ones registered,
emitted, or recommended. See the canonical
[deprecation tracker](/reference/deprecations/) for the rationale.

One collapse to know about: the two former Telegram file tools (`telegram_send_document` and `telegram_send_photo`) are now a single `TelegramSendFile` (it takes a `kind` param). Both legacy names still map to it, so a `disallowedTools` entry for **either** old name denies the whole file tool. Most operators never touched these lists — under allow-all there is nothing to migrate — but if you deny-list by name, re-check it against the [built-in and adapter tool names](/tools/policy/#built-in-tool-names).

## Deprecations

The old recipe surface was **removed** from the CLI. The commands and flags below
now error with a pointer to their replacement instead of mapping forward:

- `mono-agent recipes list | show <id>` → **removed**; use `mono-agent presets list | show <id>`.
- `mono-agent init --recipe <id>` and `mono-agent validate --recipe <id>` → **removed**; use `--preset <id>`.

For reference, the recipes that had a replacement preset mapped as follows (this
table is now static documentation — the mapping no longer exists in code):

| Retired recipe | Replacement preset |
| --- | --- |
| `minimal-webhook` | `starter` |
| `personal-telegram-bujo` | `telegram-assistant` |
| `slack-team-bot` | `slack-bot` |
| `local-ollama-private` | `local-private` |
| `sandboxed-code-agent` | `code-sandbox` |

`personal-telegram-supermemory` was retired from core because its backend is now an explicitly installed plugin; use the plugin skill/playbook. The `local-lmstudio-private` recipe was also retired (mapping it onto the Ollama-based `local-private` preset would silently swap the runtime engine); reach LM Studio via `mono-agent init --model pi:lmstudio:<id>` or the wizard's "Other…" model choice, then choose LM Studio explicitly when Journal/BuJo asks for its embeddings service.

The fully-retired blueprints — `full-safe`, `full-local-power`, `openai-api-gateway`, `cron-digest`, `a2a-provider`, and `phoenix-observed` — never had a replacement preset. Each is now either a single wizard choice (enable the `channel:openai-api`, `channel:cron`, `channel:a2a`, or `observability:phoenix` module) or a hand-assembled config the [composer skill](/context/skills/) builds from the capability modules and [playbooks](/playbooks/).

`mono-agent setup` remains a separate alias of `mono-agent init`; it has no
scheduled removal.

The canonical removal tracker and permanent legacy-reader decisions live in
[Deprecations & compatibility decisions](/reference/deprecations/).
