---
title: "Always-on web console"
description: "Run and secure the persistent assistant-ui console for local-agent discovery, threads, attachments, notifications, and live turns."
sidebar:
  order: 5
---

`mono-agent web` is the browser operator console for every running agent discovered on this computer. It is a separate `@mono-agent/web` application built on assistant-ui's External Store Runtime and native Thread, ThreadList, Message, Composer, Attachment, GroupedParts, and ToolFallback primitives, with the assistant-ui Reasoning disclosure adapted for structured runtime parts. The service owns conversations and in-flight turns, so refreshing or closing a browser tab does not abort work.

This is the chat-first companion to [`mono-agent tui`](/observability/tui/). The former `mono-agent sessions` read-only run browser [was removed](#session-recorder-removed); recorded-run replay now lives in `mono-agent tui`.

The web service does not run the terminal UI. Both consoles discover and connect to each agent's `metadata.channels.tui.baseUrl`, whose default path is `/gui`; they merely share the same bidirectional operator protocol.

## Start it once

On macOS, install and start the managed service:

```bash
mono-agent web start
mono-agent web
```

Bare `mono-agent web` is read-only: it prints service status, the usable URLs, and lifecycle help. It does not start, stop, or rewrite the service. The default listener is `0.0.0.0:5050`, so the same process is directly reachable from localhost, the trusted local network, and the machine's Tailscale address.

```bash
mono-agent web start       # install/start the managed service
mono-agent web stop
mono-agent web restart
mono-agent web status
mono-agent web logs
mono-agent web run         # foreground service, including non-macOS hosts
```

Use `--loopback` with `start` or `run` to bind `127.0.0.1` instead. Advanced `--host` and `--port` overrides are available when `0.0.0.0:5050` is not appropriate. The lifecycle status records the effective bind and any owned Tailscale route so later commands operate on the same service rather than guessing.

## Security boundary: trusted network, no login

The console intentionally has no application authentication or multi-user accounts. Anyone who can reach its HTTP listener can read retained conversations, upload files, cancel turns, and send instructions to every discovered agent. Treat the listener as an owner-equivalent operator surface:

- run it only on a trusted LAN or tailnet;
- use `--loopback` when other devices must not reach it;
- do not publish port `5050` through a public router, tunnel, or unrestricted reverse proxy;
- keep operating-system and Tailscale network admission controls as the access boundary.

The server rejects unexpected Host/Origin combinations and does not enable cross-origin API access, but those checks are browser request-integrity controls, not authentication. Plain LAN HTTP is not encrypted. Tailscale transport protects direct tailnet traffic, while Tailscale Serve provides browser-trusted HTTPS when available.

At startup, mono-agent inspects the existing Tailscale Serve configuration. It prefers HTTPS `:443` only when free; otherwise it chooses the first free port in `8443`–`8499`. It never resets or replaces another Serve handler. Ownership is recorded locally, and `web stop` removes only the route this console created. If the first route cannot be created, the local/LAN service stays healthy and status prints the direct URLs plus remediation. If a restart cannot migrate an existing owned route to a changed app port, mono-agent restores the prior worker and exact route and exits nonzero.

## How the service is structured

| Layer | What it owns |
| --- | --- |
| Service | Agent discovery, thread/turn lifecycle, attachment admission, notification ingestion, and the upstream operator connection. |
| SQLite store | Authoritative agents, pins, threads, messages, structured parts, revisions, turns, live-input fallback state, uploads, and notification idempotency. |
| `/api/v1` HTTP/SSE | Browser commands and projections. Mutations publish invalidations; browsers refetch current state instead of owning the turn. |
| Assistant-ui PWA | Responsive thread/message/composer presentation, upload progress, response notifications, and browser-origin preferences. |
| Notification ingress | Owner-private loopback endpoint recorded under `~/.mono-agent/web/`; `deliverWebNotification` uses its bearer for one bounded cron/webhook delivery. |

The browser never talks directly to a running agent. It talks to this persistent
service, which keeps the operator stream alive through page reloads and maps
agent events into durable message parts. The PWA consumes service invalidations
and reloads authoritative projections, so multiple tabs converge on the same
SQLite-backed state.

## Agents, threads, and turns

The left rail lists auto-discovered trace sources and their current health. On desktop, its explicit toggle switches between a fixed compact rail and a fixed expanded rail with full agent names. The chosen state is a browser-local presentation preference, so different browser profiles can keep different layouts without a drag-resize target.

Use the star beside an agent to add or remove it from favorites. The same pin control is available in the mobile agent picker. Pin state is persisted in the web service's SQLite settings rather than in browser storage, so favorites stay consistent when the same console is opened through localhost, a LAN address, or Tailscale. Pinned agents sort first and remain visible while offline.

Selecting an agent filters its conversations; each conversation is permanently bound to that source id so a label change or a different agent cannot inherit its history. Unpinned offline agents are hidden by default behind a subtle **Show N offline** control shared by the desktop rail, mobile picker, and command palette. Pinned agents and the currently selected agent always remain visible. The filter resets to hidden on a full page load; sending stays disabled until that exact source returns.

Threads use the first prompt as their initial title and can be renamed. They are archived rather than individually deleted, and archived threads can be restored. The console permits one active turn per thread while different threads and agents can run concurrently.

Cron jobs and webhook endpoints can explicitly target `notifyConversationId: "web:new"` with `notify: true`. Every distinct successful, non-empty result becomes a new assistant-only thread titled **Cron notification** or **Webhook notification** and marked **CRON** or **WEBHOOK** in the sidebar and header. The service appends the verbatim result to the generated thread's agent history before atomically exposing the completed thread, so a later reply continues with that notification in context. The current conversation is not changed and the new result does not steal focus. Cron's rate-limited all-models-failed notice uses the same CRON-marked path.

`web:new` is exact and explicit-only: other `web:*` values are rejected, and the web console never joins Telegram/Slack destination inference. Delivery uses an owner-private `~/.mono-agent/web/notify-ingress.json` record pointing to a bearer-authenticated ephemeral loopback endpoint. Duplicate event keys return the existing thread and conflicting reuse fails. If the web service is stopped or unavailable, the trigger makes one attempt bounded to five seconds and then skips delivery; there is no retry queue or outbox, and the cron/webhook result is unchanged.

The service, not the browser tab, owns the upstream operator connection. A browser disconnect or reload can therefore reconnect through the event stream while the turn continues. Brief event-stream reconnects do not raise the full reconnect banner; it appears after five seconds, while a browser-offline event is shown immediately. If the web service itself restarts, any turn that was still active is marked interrupted instead of being shown as permanently running.

During a turn the transcript shows streamed markdown, reasoning, tool calls and results, context-compaction lifecycle rows, user-facing errors, and the final outcome. Other raw runtime, provider, and usage telemetry remains internal; measured token and cost data appears only through the context control. The composer exposes the selected agent's available model and effort controls. Copy, cancel, archive, unarchive, and steering a running turn are supported; edit/regenerate/branch and browser-defined client tools are deliberately not enabled.

### Steer a running turn

The composer remains sendable while a response is running. A text-only send is
persisted immediately and offered to the active provider as live guidance. The
message displays one of four delivery states:

- **Steering current run…** while the provider settlement is pending;
- **Applied to current run** after the provider accepts it;
- **Queued as next turn** when the provider is unsupported, delivery fails, or
  the active turn finishes first;
- **Cancelled** when the active turn is explicitly cancelled before settlement.

After the provider accepts the follow-up, the assistant's Activity disclosure
also shows one completed `↪️ Steered: “<safe preview>”` tool row with result
`Applied to current run`. This synthetic row carries only a one-line,
secret-redacted, path-collapsed preview capped at 40 Unicode code points; the
full follow-up stays in its human message. Queued, unavailable, and cancelled
guidance does not create the row.

Queued guidance starts automatically as a normal turn after the current turn
settles. Pending delivery and queue state live in the service's owner-private
SQLite store rather than the browser tab. A web-service restart converts any
uncertain pending offer to queued and drains it after agent discovery, so it is
not silently lost. Each live follow-up is limited to 8,000 characters, with at
most 100 unsettled entries per thread. Attachments keep the ordinary turn path.
If a quote is present, the browser flattens its Markdown blockquote context into
the live guidance before persistence and delivery.
## Structured AskUser forms

When an agent calls the channel-agnostic `AskUser` tool, the web console keeps
the current turn open and renders every remaining question together in one
form. Each question shows its short header, prompt, two or three described
choices, and an **Other** field for a custom reply. Single-select questions use
radio controls; multi-select questions use checkboxes and may combine proposed
choices with a custom reply. Submitting the complete form resumes the same
model run rather than creating a new user turn.

An `AskUser` call may contain one to five questions. The form remains attached
to the running assistant message across ordinary state refreshes. Cancelling
the turn cancels its pending question set, and an expired or already-completed
form cannot submit stale answers. Older agents that do not advertise the
`askUser` operator capability remain usable, but the console does not poll them
for pending forms.

## Quote message text

Select text rendered in a user or assistant markdown message and choose **Quote** from the floating toolbar. Reasoning, tool payloads, errors, attachments, and an already-rendered quote are not selection targets. The composer keeps one quote at a time, shows a dismissible preview, and clears it when you switch agents or threads.

The quote is persisted with the new user message as `{ text, messageId }`, so it survives reloads and is rendered separately from the authored message. The operator receives a Markdown blockquote followed by the authored text, while the transcript and automatic title keep the exact text the user typed. The service rejects a source message from another thread. A quote alone is not sendable, and the formatted quote plus message must fit the existing 200,000-character turn-text boundary.

Programmatic callers can use the optional `StartWebTurnInput.quote` field:

```ts
import type { StartWebTurnInput } from "@mono-agent/web";

const input: StartWebTurnInput = {
  text: "Please expand on this.",
  quote: { text: "The selected response text", messageId: sourceMessageId },
};

await fetch(`/api/v1/threads/${threadId}/turns`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input),
});
```

## Response notifications

Use the header bell to opt into a notification when a successful response arrives while the console is hidden or its window is unfocused. The permission prompt is triggered only by that click. Each notification contains a short response-text preview, is deduplicated by turn, and focuses or opens the exact conversation when selected. Cron/webhook-created threads use this same bell preference and show **CRON** or **WEBHOOK** in the notification title. Failed, cancelled, and interrupted turns do not notify.

The opt-in is stored per browser origin, so localhost, a LAN hostname, and a Tailscale HTTPS hostname have independent preferences and permissions. Notifications require a secure browser context and an active page or installed PWA. This release does not register Web Push: after the page/PWA is fully closed, there is no background server-to-browser notification delivery.

## Run controls and context

The run-settings control uses a searchable model picker with the selected model's supported reasoning-effort choices in the same popover. On narrow screens it becomes a full-width bottom sheet so every effort level remains reachable without overflowing the viewport. Choosing **Automatic model** or **Automatic** effort delegates that setting to the agent.

The context control uses exact per-request measurements reported by Pi, Codex app-server, and OpenCode app-server. Pi reports every successful assistant request, Codex uses `tokenUsage.last` rather than the thread's cumulative total, and OpenCode is accepted only when its completed assistant message includes native `tokens.total`. A percentage appears only when that same exact event carries the serving model's context window. Direct Claude currently exposes no equivalent exact measurement, so the console says that usage is unavailable instead of estimating it from aggregate work.

The header never calls an in-flight measurement current. A running turn is labeled **Updating**; failed, cancelled, and interrupted turns ignore their own snapshots and retain only the prior successful **Last measured** value. Changing the selected model also labels the previous model's value **Last measured** and names that measured model. A running or successful compaction invalidates every older value immediately, showing **Context — · Awaiting** until a newer exact provider measurement arrives. A skipped or failed compaction does not invalidate the prior measurement. This is why an exact value may legitimately decrease after compaction.

The popover keeps aggregate last-turn processed tokens and accumulated conversation cost separate from context occupancy. Older conversations without exact telemetry show **Context —** and may still show their processed-token breakdown and cost; no aggregate number is converted into a context percentage.

Assistant reasoning, routine tool calls, and context compactions share one compact **Activity** disclosure without changing their order. Each compaction is one row that updates from running to succeeded, skipped, failed, or interrupted instead of producing duplicate start/end rows. Pi's before/after token counts are estimates and carry a `~` prefix; provider summary text is never displayed. Activity opens while the message is running and force-collapses when the message completes, fails, is cancelled, or is interrupted; it can be reopened afterward, and individual tool payloads remain collapsed inside it. Standalone interactive tools remain outside the group. Type `/` in an empty composer to open the keyboard-friendly command popover for available actions such as run settings, starting a new conversation, or stopping an active response.

## Attachments use the browser device picker

The attachment button opens the native file picker on the device running the browser. It does not expose or browse the web-service host's filesystem.

Web uploads use the same transport-neutral `AgentAttachment` contract and harness path as Telegram:

- the same MIME allowlist;
- a 20 MiB per-file default limit;
- the same image versus document classification;
- UTF-8 decoding for supported text files;
- the same owner-private harness attachment persistence and model-facing attachment description.

A web turn additionally permits at most 10 files and 64 MiB in aggregate. Attachment-only turns are valid. The browser streams bytes to a staged upload with progress; it does not retain base64 copies in React state. Removing an unattached upload removes its stage, and abandoned stages are purged after 24 hours. Committed attachments remain with their conversation, including after archival.

Telegram's optional audio transcription is adapter-specific and is not reused here. Browser-selected audio and video retain their ordinary attachment MIME and document classification unless a future transport-neutral capability changes that contract.

Older running agents that do not advertise attachment support remain usable for text chat, but the upload control is disabled for them rather than sending a request they cannot interpret.

## Local state and reset

The service keeps its owner-private SQLite store, settings, notification idempotency ledger, upload stages, logs, and live notification-ingress record under `~/.mono-agent/web/`. Stored messages, quote metadata, attachment metadata, revisions, run state, and pinned agents are local to this computer; they are independent from browser storage and from the agents' provider-side sessions. The desktop agent-rail expansion state and notification opt-in are intentionally browser-origin-local preferences and are removed when that origin's site data is cleared.

There is no per-message or per-thread destructive delete. To intentionally erase the whole console store, stop the service and use the explicit two-part confirmation:

```bash
mono-agent web reset --all --yes
```

Reset removes the web console's conversations, notification ledger and stale ingress record, committed uploads, staged uploads, and server settings, including agent pins. It does not clear browser-local preferences such as rail expansion or notification opt-in, and it does not remove an agent's config, durable conversation history, memory, or recorded run artifacts.

## Current scope

The web console covers discovery, persistent multi-conversation chat, marked cron/webhook notification conversations, structured `AskUser` forms, quoting, response notifications while the page/PWA is alive, model/effort selection, streamed reasoning and tools, internal telemetry-backed context usage, cancellation, and attachments. It is responsive down to narrow phone widths and installable as a PWA when served from a secure browser context.

Recorded-run replay, source-annotated config inspection, and managed conversational configuration remain in the TUI for now. Use:

```bash
mono-agent tui
mono-agent tui --configure
```

## Session Recorder removed

The `mono-agent sessions` command that launched the read-only Session Recorder was removed. Use `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console) for operator run inspection.

`@mono-agent/session-web`, the read-only `live` event relay, and their config/env surface have also been removed. `MONO_AGENT_WEB_AUTH_TOKEN` is no longer read by any code. See the [deprecation tracker](/reference/deprecations/#removed-surfaces).

## Related

- [CLI command reference](/observability/cli-reference/#web) — lifecycle and flags.
- [Terminal UI](/observability/tui/) — replay, config view, and managed configuration.
- [TUI stream endpoint](/channels/tui/) — the default-on agent endpoint used for web chat.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how web threads map to harness conversations and provider sessions.
