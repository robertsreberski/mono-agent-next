---
title: "Context assembly"
description: "See how mono-agent orders identity, session guidance, history, skills, memory recall, and the current request."
sidebar:
  order: 3
---

For a fresh/stateless turn, mono-agent builds one prompt from several ordered sections — core guardrails, identity, a session block, conversation history, the skill index, selected skill instructions, and finally the current user message. Warm or durable provider resumes use the history placement described below. Recalled long-term memory is **not** one of these system-prompt sections; it is appended to the current user message instead (see [Memory recall](#memory-recall) below). This page documents that order, how history is sized, and the truncation/bloat guards that keep prompts bounded. Assembly is mostly `auto`: you configure the inputs (identity, soul, skills, memory) and the framework assembles them.

## Section order

The context builder in `@mono-agent/agent-harness` concatenates sections in a fixed order. Empty optional sections are skipped, but present sections always appear in this sequence:

| # | Section | Source | Always present? |
|---|---------|--------|-----------------|
| 1 | Core Guardrails | `context.soulPath`, else the built-in default soul | Yes |
| 2 | Identity | `context.identityPath` | Yes (identity is required) |
| 3 | Session | host-owned delivery and callback-safety guidance | Yes |
| 4 | Conversation History | owner-only durable history store | Optional (empty on first turn) |
| 5 | Skill Index | name/description of selected skills | Optional |
| 6 | Selected Skill Instructions | full `SKILL.md` bodies of selected skills | Optional |
| 7 | Current User Message | the inbound request text, with any recalled memory appended | Yes |

The user message is always last, so the model reads its guardrails, identity, and history before the task it must act on — and any recalled memory travels **with** that user message. See [Identity and soul](/context/identity-and-soul/) for sections 1–2, [Session](#session) for section 3, and [Skills](/context/skills/) for sections 5–6.

Conversation History is a system-prompt section on fresh/stateless runs and on the one session-resume retry. A confirmed warm provider session already carries its transcript, so the section is omitted and only the current user message is sent. A cold history-coordinated Pi reopen loads the same canonical history but supplies it as structured leading runtime messages outside the system prompt: Pi seeds those messages when the epoch's JSONL is missing (create-on-miss), or skips the leading messages when an existing JSONL is truly resumed. In both cases the provider sees each prior turn exactly once and the current user message remains last.

:::note
`context.identityPath` is one of only two required config fields (the other is `runtime.model`); omit `context.soulPath` to fall back to the built-in core guardrails.
:::

:::note
Recalled long-term memory used to be section 3 of this prompt. It is no longer assembled into the system-prompt sections above — it now rides the user message each turn (see [Memory recall](#memory-recall)). The `@mono-agent/agent-harness` context API still exposes a `memory` section for custom/programmatic callers that pass `memory` directly, but the standard agent appends recall to the user message.
:::

## Configuring the inputs

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "maxTurns": 0 },
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["research"],
    "skillMaxBytes": 48000
  }
}
```

Matching env vars (env > JSON > defaults): `MONO_AGENT_IDENTITY_PATH`, `MONO_AGENT_SOUL_PATH`, `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS`, `MONO_AGENT_SKILL_MAX_BYTES`, and `MONO_AGENT_MAX_TURNS`.

Skills are loaded from `<skillsRoot>/<name>/SKILL.md`, one per entry in `selectedSkills` — there is no auto-selection. Each skill's instruction body is capped at `context.skillMaxBytes` (default 48000, range 256–1,000,000). See [Skills](/context/skills/).

## Session

The **Session** block (section 3) is auto-generated each turn (coverage `auto`, no config). It tells the agent whether this is an interactive push conversation or a request-driven scheduled/webhook/API turn, but it deliberately does not reveal the physical channel, thread, callback URL, or delivery token.

- For a deliverable push destination (`telegram:` / `slack:`), the host separately retains an `AgentReplyTarget` containing the physical channel/thread. That target is not added to the prompt, tool arguments, or run artifacts. The Session block explicitly forbids copying, requesting, inferring, or passing a conversation/channel ID, callback URL, or delivery token. A selected trusted MCP service can claim a [durable continuation](/tools/durable-continuations/) without the model seeing the route.
- For non-push conversations (cron / webhook / openai-api / a2a), it instead clarifies that this conversation cannot itself receive a proactive follow-up. Cron jobs and webhook endpoints with `notify: true` deliver their successful final answer to the resolved Telegram/Slack destination or explicit `web:new` — the harness injects guidance on those turns that the final reply is delivered verbatim and how to stay silent. See [Delivery and send tools](/channels/delivery-and-send-tools/).
- When memory is configured, it also states that persistence is host-owned: the agent acknowledges memory requests and lets post-turn capture write them, without editing memory Markdown, SQLite, manifests, generations, or indexes through tools.

## Memory recall

Recalled long-term memory is **not** part of the system-prompt sections above. When `memory` is configured and a recall returns hits, the harness appends the recalled block to the **user message** each turn — after the user's text and any attachment block — clearly delimited so the model reads it as injected background context rather than the user's words:

```text
[Recalled long-term memory — background context for this turn, not the user's words:]
…recalled entries…
```

This injection happens on **every** turn, including the resume-retry path, because the user message is the one field every runtime re-sends verbatim. So memory survives a session resume even on runtimes that drop the system prompt on a resumed turn (e.g. codex-app sends developer instructions only on a fresh thread start). Keeping memory off the system prompt also leaves that prompt stable across a session, which is better for provider prompt caching.

A few specifics:

- **Not persisted.** Injected memory is added only to the provider-facing message, never written back to history or capture, so it cannot compound into future prompts.
- **Skipped when empty.** A recall that returns no hits injects nothing — no delimiter, no header.
- **Still traced.** A lightweight `memory_recalled` diagnostic (source + byte size, not the content) keeps the fact that recall fired visible in the run record even though memory no longer appears in the prompt sections.

Every configured memory tier also exposes the read-only `MemoryRecall` tool by default (`config.memory.recallTool.enabled`; explicit false opts out). Lite uses FTS; Journal/BuJo combine keyword and semantic search. Automatic context recall is score- and answer-evidence-gated to five hits / 8 KB and shares a per-turn lookup cache with the tool. See [Capture and recall](/memory/capture-and-recall/) and [Embeddings](/memory/embeddings/).

## Conversation history

Coverage: `auto`. History is kept in an **owner-only, disk-backed store**. The default retains the latest 64 messages for each exact conversation id, with aggregate retention bounded to 256 MiB, 10,000 conversations, and 365 days of inactivity. Live unpublished stages have a separate 256 MiB aggregate cap, so many prepared or crash-abandoned turns cannot grow the store without bound. A completed turn is staged before commit and atomically published; cancelled preparations do not evict committed history. Oldest inactive conversation files are pruned only after a successful publication. These bounds are independent of the provider's turn limit: changing `runtime.maxTurns` does not change the history window. When history uses the prompt path, the history section renders prior `system`/`user`/`assistant`/`tool` messages for the conversation in order; cold durable Pi reopens use the structured-message path described above.

- `runtime.maxTurns` (`MONO_AGENT_MAX_TURNS`) is `0` or omitted for an **unlimited provider run**; set `1`–`100` to cap turns per run. It neither disables nor resizes the bounded 64-message history.
- History is keyed per conversation. Channels reuse a stable conversation id; for cron, share one with `cron.jobs[].conversationId` so ticks accumulate the same history (see [Cron](/channels/cron/)).

The configured app stores history under an owner-only `history/` directory next to the configured artifact directory (normally `.mono-agent/history`). Conversation ids are retained inside the records but never used as path components; filenames are SHA-256-derived. The directory is mode `0700`, files are mode `0600`, each serialized message is capped at 64 KiB, and replacements are written atomically and fsynced. Owner-only SQLite lock files serialize same-conversation updates and root-wide retention across processes; dead owners and markerless stages are recovered immediately without an elapsed-time lease. A cold process therefore replays the same bounded history after restart even when no provider session can be resumed.

Answered or expired blocking `AskUser` interactions are also preserved in the
logical producer's assistant-side history copy; cancelled interactions are not
journaled. The compact transcript records the structured questions, outcome,
selected labels, and custom replies before the final assistant text, with
described options when the bound permits. It is explicitly labelled untrusted
historical data and normalizes structural line separators. Retention keeps the
newest whole interactions; if the newest valid entry is oversized, only its
option descriptions are omitted so its questions, outcome, and answers remain
whole. A later cold/stateless provider call can therefore replay what happened
instead of seeing only the trigger and final response—even when the physical
Slack thread, Telegram chat, or web conversation differed from the producer
conversation.

This history-only copy does not change the message delivered to the user, and it
is not added to long-term memory capture. Non-blocking
`TelegramSendMessage.reply_options` returns immediately; a later tap becomes a
separate user turn rather than part of the in-turn interaction transcript.

Use active conversation history first for the current exchange. Use `MemoryRecall` for durable facts that were intentionally captured, and use the read-only [`RunHistory`](/tools/mcp/#runhistory-prior-run-evidence) tool when the exact tool calls, results, warnings, or final output from a prior run are needed.

An ordinary service restart keeps active conversation history. The explicit `mono-agent restart --clear-sessions` reset clears that history together with provider transcripts, but does not delete `MemoryRecall`'s long-term-memory store or recorded run artifacts.

History records publish by atomic replacement. If a stable record is truncated into invalid JSON, the responder starts that conversation cold and replaces the unreadable record on the next successful turn; unsafe paths and unsupported record shapes still fail closed.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "maxTurns": 24 }
}
```

:::note
Durable conversation history remains canonical when provider-side session resume is enabled. With the default store and `providers.piNative.piSessionsRoot`, each conversation record owns a random provider epoch and transcript revision. The store fsyncs a separate bounded dirty fence before provider execution, fsyncs the completed Pi JSONL transcript, then commits the new history and incremented clean revision before clearing the fence. A crash, missing/legacy record, host-only history append, or failed provider sync rotates the epoch before another resume; a cross-process revision mismatch cold-reopens stale process memory. See [Sessions and concurrency](/runtime/sessions-concurrency/).
:::

### Custom history store (code only)

Replacing the default durable history store is a `code` capability: pass `historyStore` to `createConfiguredAgentResponder`. A custom store keeps process-local warm sessions. To opt into durable Pi JSONL resume it must also implement the crash-safe `beginProviderSessionTurn` transaction; otherwise the harness intentionally withholds `piSessionsRoot`. See [Composition](/programmatic/composition/).

## Truncation and bloat guards

Two independent guards keep assembled prompts and tool traffic bounded:

| Guard | Coverage | Behavior |
|-------|----------|----------|
| Per-skill byte cap | `config` | Each skill instruction body truncated to `context.skillMaxBytes` (default 48000) |
| Tool-output bloat guard | `auto` | Tool outputs over 256KB are truncated; each oversized block is offered to a separate best-effort artifact sink under `artifacts.dir` (`MONO_AGENT_ARTIFACT_DIR`) |

The tool-bloat guard is always on. When a large tool result is truncated in-context, it attempts to save each original block under `tool-output/`. The compact summary lists only paths the sink successfully returned; when the sink is absent or a write fails, the omitted bytes are not recoverable. These separate files are not the run's JSONL event stream or replay guarantee — see [Artifacts and traces](/observability/artifacts-and-traces/).

## Context compaction

Assembly produces the prompt; **compaction** keeps it within the model's context window over long conversations. On the pi-native bridge, the runtime drives `AgentHarness.compact()` proactively (before a turn at the adaptive trigger) and reactively (one compaction and one re-prompt only after a rebuilt-context preview proves positive reduction). Rejected previews are not persisted. Defaults derive from the active model window; configure overrides with `runtime.compaction.*` or `MONO_AGENT_COMPACTION_*`. Numeric provider limits and generic overflow estimates lower a process-local learned ceiling, while `contextWindowOverride` supplies a persistent metadata correction. Runs report `context_compaction_applied` as `true`/`false`/`null` (fired / enabled-but-not-needed / disabled), the complete proactive request estimate, and before/after effectiveness. A persistent overflow becomes `context_limit`, allowing the configured fallback chain to try a model with a different usable window. API and Telegram conversations remain independent because compaction operates on the exact channel conversation's own session history. See [Sessions and concurrency](/runtime/sessions-concurrency/).

## Related

- [Identity and soul](/context/identity-and-soul/) — sections 1–2
- [Skills](/context/skills/) — sections 5–6 and the skill index
- [Capture and recall](/memory/capture-and-recall/) — the user-message memory injection and `MemoryRecall`
- [Delivery and send tools](/channels/delivery-and-send-tools/) — native cron/webhook notify the Session block references
- [Durable continuations](/tools/durable-continuations/) — host-only reply targets and later asynchronous delivery
- [Tools and guards](/runtime/tools-and-guards/) — the bloat guard in context
- [Composition](/programmatic/composition/) — custom history store and per-request runtime options
