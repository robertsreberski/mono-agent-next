---
title: "Terminal UI (mono-agent tui)"
description: "Use the terminal console for structured live chat, recorded-run replay, config inspection, and host-approved self-configuration."
sidebar:
  order: 4
---

`mono-agent tui` is the operator console: a live chat with structured insight into the agent's thinking process — streamed reasoning, tool calls with arguments/progress/results/timing, token usage, cost, provider lifecycle and failover — plus a recorded-run replay browser and a read-only, source-annotated view of the resolved config. It normally connects to the authoritative running agent; `--local` remains an ordinary in-process chat escape hatch, never a configuration host. It ships in `@mono-agent/tui`, built on pi-tui differential rendering. Coverage: `cli` (+ the `tui` config section for remote endpoints).

## How it connects

Remote mode is a **separate process** from the agent. `mono-agent start` runs the agent in the background as usual; every running agent serves a loopback NDJSON stream endpoint (the [`tui` channel](/channels/tui/), on by default) and registers itself in the machine-wide trace-source registry (`~/.mono-agent/trace-sources`). `mono-agent tui` reads that registry from **any directory**:

- **No agents running** — prints a hint to `mono-agent start` and exits.
- **One agent running** — connects directly.
- **Several** — opens an in-TUI picker (health, pid, transports per instance).
- `--agent <label|sourceId>` — connects to a specific instance without the picker.

```bash
mono-agent tui                        # discover + connect from anywhere
mono-agent tui --agent personal-agent # pick a specific instance
mono-agent tui --conversation ops     # chat under a stable conversation id
mono-agent tui --configure            # managed macOS configuration conversation
mono-agent tui --local                # ordinary current-folder chat, no daemon
```

:::note
It requires an interactive TTY. Piped or non-interactive stdin exits with an error.

Agents whose config sets a custom `traceability.registryDir` (as `mono-agent init` scaffolds — `./.mono-agent/trace-sources`) register in **that** directory AND, by default, also mirror an identical manifest into the global `~/.mono-agent/trace-sources` registry — so `mono-agent tui` run from anywhere on the machine finds them. Set `traceability.globalDiscovery: false` to opt an agent out of the mirror (it stays visible only from its own folder, or with `--config` pointing at it). Running `mono-agent tui` from an agent's own folder additionally consults the global registry (when different), so both that agent and every other machine-wide agent show up together.
:::

Chat runs under its own `conversationId` (default `tui-<sourceId>`), so it never blocks or interleaves with Telegram/Slack/cron conversations — the harness serializes per conversation and runs different conversations concurrently. Closing the TUI mid-turn (or pressing `esc`) aborts the in-flight turn server-side.

## What you see during a turn

| Element | Content |
| --- | --- |
| Thinking cells | The model's reasoning, streamed live. Collapsed to a one-line summary by default; `ctrl+t` expands/collapses all. |
| Tool panels | One per tool call: name + argument preview while pending, a live tail of partial output as the tool runs, then the result preview and execution time (green success / red error). Applied live guidance appears as a completed `↪️ Steered` panel with `Applied to current run`. |
| Answer | The assistant's reply as streamed markdown. |
| Notices | Runtime warnings and provider failover (`failover gpt-5.6-terra → kimi`) inline in the transcript. |
| Status bar | Instance label · model · live token usage (`↑input ↓output (cache …)`) · cumulative cost · provider state · hints. |

Remote event frames are capped at 256 KiB after UTF-8 NDJSON serialization, including the newline. Above that cap, assistant-thought and tool-call payload fields are reduced, marked truncated, and remeasured. Another oversized variant (including runtime warnings/telemetry), or a reducible event whose minimal form still does not fit because of metadata or invariant fields, becomes a small `oversized_event` marker. Other frame kinds do not use this cap. Replay is independently bounded: the recorder applies sensitive-key redaction, scans retained free text for high-confidence credential shapes, and caps each event string at 4,096 bytes by default. It keeps events in RAM until terminal persistence and may leave an empty event trail after a crash. A separately saved `tool-output/` file can preserve an oversized tool-result block when best-effort persistence succeeds, but it is not JSONL replay and does not cover arbitrary stream events. See [Artifacts & traces](/observability/artifacts-and-traces/).

## Views

| View | Key | Content |
| --- | --- | --- |
| chat | `f2` | The live conversation described above. |
| replay | `f3` | Recorded runs read straight from the agent's artifact dir — runs from any channel (telegram, cron, webhook, …) expand into the sensitive-key-redacted, credential-scanned, bounded events that reached their JSONL files: thinking, tools, telemetry, failover history, error detail, plus usage and cost from the summary. Payload tails capped before persistence and RAM-buffered events lost in a crash are not recoverable here. |
| config | `f4` | Redacted, source-annotated resolved config — the same builder as `mono-agent config`, each field tagged `env`/`json`/`default`. Read-only; `r` reloads. The env layer shown is your shell's, not the agent process's (the pane says so). |
| agents | `f5` | The running-instance picker; `r` refreshes, `enter` connects. |

## Keyboard & slash commands

| Key | Action |
| --- | --- |
| `f2`–`f5` | Jump to chat / replay / config / agents. |
| `tab` / `shift+tab` | Cycle views (`tab` belongs to the editor's autocomplete inside chat). |
| `esc` | Cancel the in-flight turn (chat) · back out of a replay detail · return to chat. |
| `ctrl+t` | Expand/collapse thinking cells. |
| `enter` | Submit message · open selection. |
| `ctrl+c` twice | Quit. |

The input editor autocompletes slash commands:

- `/model [ref|default]` applies or clears a session-scoped model override. Bare
  `/model` opens the agent's advertised model list. A different model starts
  each turn with a fresh provider session.
- `/effort [level|default]` applies or clears a session-scoped effort override.
  Bare `/effort` opens options supported by the effective model.
- `/new [label]` inserts a visual break in the transcript. It does not change
  the conversation id or clear durable agent history.
- `/exit` is an alias of `/quit`: both close only this console and leave the
  background agent running.
- `/help`, `/agents`, `/replay`, `/config`, `/configure`, `/cancel`, and
  `/thinking` expose the remaining navigation and turn controls.

In a configured console, `/configure` reports that SELF-CONFIG is already
active; it does not restart the guide.

## Managed conversational configuration

`mono-agent tui --configure` attaches to the authoritative macOS background instance and opens a dedicated **SELF-CONFIG** session. Do not combine it with `--local`. A persistent `[SELF-CONFIG]` header and bottom exit hint make the boundary visible. The host makes the purpose and stop condition explicit:

> Dedicated self-configuration session: map the agent's identity/knowledge, runtime/models, skills/tools/MCP/plugins, memory, channels/APIs/A2A, automation, security, observability/operations, and acceptance criteria. Build the chosen workflow by conversation. Do not enter secrets. Nothing changes until the host shows a separate approval. Approval, rejection, done, and no changes keep SELF-CONFIG active. Only /quit, /exit, or ctrl+c twice exits this session; the background agent keeps running.

The configuration conversation id stays stable for the life of the console, including across verified restarts. A proposal-free turn, `done`, or `no changes` reports that no files changed and rearms SELF-CONFIG with a fresh opaque proposal capability. Rejection reports **Proposal rejected; no files changed. Self-configuration remains active.** Every non-command message stays configuration-marked. `/quit` closes only the console, while the background process and its channels continue running.

The ownership boundary is intentionally narrow: `@mono-agent/tui` renders the
marked conversation, review card, and controller state, but
`@mono-agent/agent-app` supplies that controller and owns attestation,
validation, approval consequences, atomic writes, restart/readiness, and
rollback. The terminal package cannot grant those powers to an embedded
responder or an ordinary `--local` session.

Before granting configuration authority, the host matches the registry record to one live launchd PID, the exact config/dotenv/Identity/Soul/MCP-authority/operational-environment snapshot, and a reachable TUI endpoint. The request-scoped `ProposeAgentConfiguration` tool exists only in that marked conversation. The background responder replaces ordinary action tools and configured MCP servers with `ReadSkill`, `MemoryRecall`, and the inert proposal server. Pure direct-Codex chains use native read-only plan mode; mixed chains retain the finite proposal surface so an incompatible route cannot widen it. Direct OpenCode cannot receive this MCP capability: a direct-OpenCode primary uses a configured proposal-capable fallback, while a direct-OpenCode fallback makes the mode refuse with remediation. The proposal records one RFC 6902 config patch and optional replacement for the `## Role` body in the identity file resolved from `context.identityPath`; the model cannot write files. The host accepts only public name, effort/turn/session UX, selected project skills/disclosure, memory size/MemoryRecall enablement, and semantic tool-policy tightening. It rejects stale, secret-bearing, environment-shadowed (including JSON Patch source paths), path-bearing, authority/network/provider, unknown-field, terminal-control, and bidi-control candidates before validation and a separate approve/reject card. Long Role bodies are paged while the decision controls remain visible. Memory tiers/capture, secrets, runtime/model/provider posture, external MCP/plugins, channels or proactive jobs, exporters/endpoints, and sandbox/network policy are handed to explicit guided flows.

Approval commits the candidate under an owner-only transaction, restarts the managed background agent, waits for a fresh ready trace source, swaps the console endpoint, and reports **Configuration applied and the background agent restarted successfully. Self-configuration remains active.** If the candidate cannot start, the host restores the approved files, restarts the previous background agent, swaps to the recovered endpoint, and keeps SELF-CONFIG active without assuming the rejected change landed. The next turn receives a fixed, non-secret host-outcome summary. A fast follow-up submitted while the model, review, restart, or recovery is settling remains in the editor and must be submitted again after readiness; it never becomes ordinary chat or reaches a stale endpoint. A failed rollback or recovery restart is never hidden: the `[SELF-CONFIG]` marker remains visible, the unverified endpoint is disconnected, and the draft stays retained while manual recovery is required. If the fresh endpoint is already proven but proposal-capability rotation fails afterward, the endpoint swap and applied result are preserved while continuation is disabled for that console. Inspect or recover with `mono-agent status`, `mono-agent logs --follow`, `mono-agent restart`, and `mono-agent stop` (add the same `--config` when using a non-default config), then quit and reopen SELF-CONFIG.

Conversational configuration is unavailable off macOS because safe apply depends on managed restart, readiness, and rollback. Edit `mono-agent.config.json` and `IDENTITY.md` manually, run `mono-agent validate`, start `mono-agent start --foreground` in one terminal, and open ordinary `mono-agent tui` in another.

## Embedded mode (custom hosts)

The remote and ordinary local modes use the same TUI, which also runs **in-process** against any `AgentResponder`. The same rendering drives both; remote mode transports the callbacks through the NDJSON protocol and event-frame cap described above. Custom hosts can embed it programmatically:

```ts
import { startMonoAgentTui } from "@mono-agent/tui";

const handle = startMonoAgentTui({
  responder,                       // AgentResponderLike, e.g. createAgentResponder({ harness })
  title: "Local Agent",
  conversationId: "local-agent",
  config: { path: configPath, cwd, env: { ...process.env } },
});
await handle.waitUntilExit();
```

or via the low-level bin, which also supports direct URLs:

```bash
mono-agent-tui --responder ./tui-responder.mjs --config ./mono-agent.config.json
mono-agent-tui --url http://127.0.0.1:52341/gui [--api-key <key>]
mono-agent-tui                        # discovery mode, like `mono-agent tui`
```

`--responder` modules default-export an `AgentResponderLike` or export `createResponder(env, cwd, configPath)` — see [Programmatic Composition](/programmatic/composition/).

### `mono-agent-tui` flags

| Flag | Description |
| --- | --- |
| `--responder <file>` | In-process mode: ESM module exporting a responder. Mutually exclusive with `--url`. |
| `--url <baseUrl>` | Remote mode: a running agent's `tui` endpoint. |
| `--api-key <key>` | Bearer key for `--url` when the agent sets `tui.apiKey`. |
| `--registry-dir <dir>` | Discovery registry override (default `~/.mono-agent/trace-sources`). |
| `--config <path>` | Enables the config view; forwarded to `createResponder()`. |
| `--conversation <id>` | Conversation id (default `tui-local`). |
| `--title <text>` | Header title. |

## Related

- [TUI channel](/channels/tui/) — the endpoint inside each agent this console connects to (`tui` config section, on by default).
- [CLI Reference](/observability/cli-reference/) — the `mono-agent` host CLI, including `mono-agent tui`.
- [Artifacts & Traces](/observability/artifacts-and-traces/) — the recorded runs the replay view reads.
- [Programmatic Composition](/programmatic/composition/) — building responders for embedded mode.
