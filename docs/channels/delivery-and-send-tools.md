---
title: "Delivery, streaming & send tools"
description: "Compare per-channel delivery semantics and configure app-owned send tools and proactive notifications."
sidebar:
  order: 8
---

This page explains how mono-agent delivers answers across channels (final-only vs. token streaming), which delivery and message-text knobs are config vs. code-only, how the app-owned MCP send tools (`SlackSendMessage`, `TelegramSendMessage`) let the agent push messages back through an already-configured chat adapter, and how native proactive delivery works for cron/webhook turns.

## Delivery semantics per channel

Each channel decides how a turn's output reaches the user. The two chat adapters and the OpenAI-compatible endpoint behave differently by default:

| Channel | Default delivery | Working indicator | Coverage |
|---|---|---|---|
| Telegram | Final answer only (`stream.finalOnly: true`) | "typing…" chat action, then one transient tool-activity message when tools run | `code` |
| Slack | Final answer only (`stream.finalOnly: true`) | 👀/assistant status, then one transient tool-activity message when tools run | `code` |
| OpenAI-compatible (`/v1/chat/completions`) | One JSON completion by default; token SSE when the request sets `stream: true` | n/a | `config` |

Telegram and Slack default to delivering **only the final answer** — answer tokens are not streamed into the chat. An inbound turn starts with the channel's lightweight working indicator. If the agent starts a tool, one temporary message exposes a cumulative, user-safe activity ledger such as `🌐 Browsing https://example.com` or `🖥️ Running pnpm test`. Later tool starts edit that same message. Provider-applied live guidance adds `↪️ Steered: “<safe preview>”`. At completion, both adapters post the answer as a fresh message and then best-effort delete the ledger. Reasoning and answer deltas never overwrite the ledger while work is in progress. This is built-in adapter behavior, not a JSON field you set in `mono-agent.config.json`.

The OpenAI-compatible endpoint follows each request's `stream` field. `true`
returns token-by-token SSE deltas and `[DONE]`; `false` or omission waits for one
JSON completion. Clients such as Open WebUI can select the streaming form. See
[OpenAI-compatible endpoint](/channels/openai-api/).

### Transient tool activity

The shared formatter maps common tool families to stable copy: web search/browse, file read/search/write/edit, shell commands, code execution, image inspection, and memory access. `ReadSkill` renders the selected skill as `📚 Reading "<skill>"` without exposing its path, and read-only `MemoryRecall` uses preview-free `🧠 Recalling memory`; memory writes use `🧠 Updating memory`, and ordinary file reads use `📖 Reading`. Unknown or MCP-qualified tools use a humanized leaf name. Consecutive identical lines collapse in place as `(×N)`; a different tool starts a new line, so only adjacent duplicates are combined.

Previews use at most one allowlisted scalar argument and are truncated to 40 Unicode code points after control-character and whitespace normalization. File paths use middle truncation weighted toward the suffix so the filename remains visible; commands and scripts retain a balanced prefix and suffix; other previews retain their beginning. Credential assignments, authorization schemes, URL user information, sensitive query parameters, and known token shapes are redacted before truncation. Arbitrary tool arguments are never serialized, getters and proxies are not inspected, and memory content/text is deliberately excluded. Unsafe or missing input falls back to action-only copy.

Applied live input uses the same normalization and redaction boundary. Its
completed synthetic tool lifecycle contains only the safe preview and
`Applied to current run`; the full follow-up remains the human message and is
never copied into tool arguments or event metadata. Requeue, cancellation,
unsupported providers, and end-of-turn races do not emit a `Steered` activity.

The transient message is limited to interactive inbound Slack and Telegram turns. Native proactive notifications do not post it. Setting the code-only `stream.showHints: false` preserves final-answer-only delivery with the ordinary working indicator. When guidance is applied, the adapter best-effort deletes a confirmed ledger and reposts the same cumulative content after the human follow-up, making it the newest bot message. If deletion fails, it edits in place. On normal completion the answer lands first and progress deletion is best-effort, so a deletion failure cannot duplicate or lose the answer (but can leave the stale activity message behind). On an acknowledged `/cancel`, the adapter best-effort deletes a still-transient activity message and keeps the single `Cancelled.` acknowledgement; it never deletes a message that contains an answer.

## Switching Telegram/Slack to live interim streaming

Restoring live, interim-edit streaming on Telegram or Slack requires a **custom channel driver** that sets `stream.finalOnly: false` on the adapter. There is no `mono-agent.config.json` key for this — it is a code-only override.

Concretely, build the driver yourself (e.g. `createTelegramChannelDriver` / `createSlackChannelDriver`) and pass `finalOnly: false` so the substrate's `ResilientMessageStream({ finalOnly })` edits an in-progress message as deltas arrive. See [Write your own channel adapter](/programmatic/custom-channels/) for the programmatic composition path.

:::caution
Live interim streaming on Telegram/Slack means frequent message edits, which can hit the platform's rate limits on busy chats. Tune the edit debounce (below) before enabling it broadly.
:::

## Stream & message-text tuning (code-only)

Status text, edit debounce, max message characters, and the welcome/help/error texts are **channel-driver overrides**, not config keys. Set them when you build a custom driver via `stream` / `messages` options:

| Knob | What it controls |
|---|---|
| `stream.finalOnly` | Final-answer delivery vs. live interim answer edits (default `true` for Telegram/Slack); tool activity may still use one transient message |
| `stream.showHints` | Whether interactive tool starts appear in the transient activity message (default `true`; proactive delivery forces `false`) |
| Status / working-indicator text | The activity hint shown while a turn runs |
| Edit debounce | How often an in-progress message is re-edited during streaming |
| Max message chars | Where long replies are split into multiple messages |
| Welcome / help / error texts | Per-channel canned message bodies |

Because these are code-only, they live in your driver wiring rather than `mono-agent.config.json`. See [Write your own channel adapter](/programmatic/custom-channels/).

Slack's built-in driver uses Slack's 40,000-character platform limit for final replies by default, so a final answer above the shared 3,800-character default but below Slack's limit is still delivered as one Slack message. Slack final replies and `SlackSendMessage` split into continuation posts only when text exceeds that platform limit. Telegram and custom channel streams keep their own defaults unless their driver overrides `stream.maxMessageChars`.

## App-owned send tools

mono-agent derives MCP **send tools** from already-enabled chat adapters so the agent can push a message back into a chat from inside a turn:

- `SlackSendMessage` — send through the configured Slack adapter
- `TelegramSendMessage` — send through the configured Telegram adapter, optionally with non-blocking `reply_options`
- `TelegramSendFile` — upload and send a file (`kind:"document"`) or an inline image (`kind:"photo"`) through the Telegram adapter
- `AskUser` — ask one to five structured questions on the active interaction destination and **block until the user answers** (one tool across web, Slack, and Telegram; see below)

Coverage: `config`. Three conditions must hold for a send tool to work:

1. The tool must be **permitted by the policy**. Under allow-all (the default) that is automatic once the channel is enabled — no allowlist entry needed. On runtimes that enforce specific lists, include the exact name or deny it normally. Direct `codex:*` rejects all restrictive normal-run policies before start; it never silently widens them.
2. The corresponding adapter must have **valid config** — `slack.*` for `SlackSendMessage`, `telegram.*` for the Telegram tools — which supplies the credentials and the destination bounds.
3. With `sandbox.mode: "native"`, the sandbox network policy must admit the tool's HTTP endpoint: `slack.com`, `api.telegram.org` (or the configured Telegram `apiRoot` host), and the configured interaction-bridge host used by send-history recording and `AskUser`. `mono-agent validate` names any missing host.

### Telegram interactive send tools

`TelegramSendMessage` and `TelegramSendFile` are gated by tool policy plus valid
`telegram.*` config, with `telegram.allowedChatIds` / `telegram.allowAllChats`
remaining the destination boundary.

- **`TelegramSendMessage.reply_options`** adds two to eight native buttons to a
  normal outbound message. The send returns immediately; a later tap removes the
  keyboard and starts a separate user turn that names the original message and
  selected label. Use `AskUser` instead when the current run must wait.
- **`TelegramSendFile`** uploads and sends a file (`kind:"document"`) or an inline image (`kind:"photo"`) to an allowed chat. It accepts the bytes as base64 `data` (with a `filename`) **or** a workspace `path` (filename derived from the path), plus an optional `caption`. Uploads are bounded by the adapter's attachment size cap (~20 MB).

The adapter's own allowlist (`slack.allowedChannelIds` / `slack.allowAllChannels`, `telegram.allowedChatIds` / `telegram.allowAllChats`) **remains the destination boundary**: allowing the tool does not widen where the agent may send. A send to a destination outside the adapter allowlist is refused.

For an agent shared by multiple Telegram chats, add a stricter per-run boundary:

```json
{
  "telegram": {
    "sendTools": {
      "scope": "producing-conversation",
      "pathScope": "run-output"
    }
  }
}
```

`scope` binds message, button, and file delivery to the Telegram chat that
produced the current request, even if another chat is globally allowed.
For `TelegramSendFile`, that binding is entirely host-owned: strict mode removes
`chat_id` from the model-facing schema, derives the chat from trusted request
context, rechecks the adapter allowlist, and omits the raw chat id from the tool
result. Missing or non-Telegram request context fails closed, and unexpected
destination input cannot redirect a file.
`pathScope` binds path uploads to the exact app-created
`artifacts/outbound/<run-id>` directory object, including rejection of root
replacement and symlink escapes. The child opens the candidate with no-follow,
verifies the file and directory identities, and uploads bytes read from that
pinned descriptor; the self-hosted `file://` fast path is disabled in this mode.
All rejected strict paths return the same generic error, so the tool does not
become a filesystem-existence oracle. The scratch directory is deleted after the
run and its tool clients settle. Missing trusted request context fails closed.
Omitting this block preserves the legacy allowlist-only behavior.

The native sandbox's network allowlist is a separate egress boundary. App-owned send tools run in a sandboxed child and use SRT's authenticated proxy automatically; no `NODE_USE_ENV_PROXY` setting is needed. A `localhost`-only policy cannot reach Slack or Telegram. In `allowlist` mode, include the exact external API hosts plus an explicit loopback host (normally `127.0.0.1`) when a message-send or blocking ask tool is enabled. Mono-agent grants SRT's coarse loopback capability only to this trusted app-owned child; it does not let Bash or project MCP servers bind arbitrary loopback ports:

```json
{
  "sandbox": {
    "mode": "native",
    "network": {
      "mode": "allowlist",
      "allowlist": ["slack.com", "api.telegram.org", "127.0.0.1"]
    }
  }
}
```

`SlackSendMessage` accepts standard Markdown by default, renders it to Slack `mrkdwn`, and preserves Slack thread/formatting options on every chunk. Set its `mrkdwn` argument to `false` only when you need plain text sent unchanged. Text below Slack's 40,000-character platform limit is one post; text above the limit is split and each posted chunk is indexed so replies in those threads can resume the producing conversation.

After Slack or Telegram confirms a send-tool post, mono-agent records the exact
delivered text into that destination's assistant history: the Telegram chat, or
the Slack thread selected by `thread_ts` (a new top-level post uses its confirmed
message timestamp). The history key comes from the platform receipt, so replaying
the same confirmed receipt is idempotent. A retry that creates a second platform
message has a different receipt and therefore a second history entry, matching
what the user actually received. Failed platform sends record nothing. If the
best-effort history path is unavailable after a successful post, the tool result
includes a warning but remains a successful delivery. Cross-conversation sends
write only the destination history. For a new top-level Slack post, the history
attempt settles before the producer reply alias is published; an accepted
cross-conversation append is therefore durable first. A failed or timed-out
history attempt stays visible in the successful tool result, while the existing
producer alias is still published so routing does not regress. A warm producer
session already owns the tool call in its provider transcript; after a successful
history append, cold replay supplements the aliased producer context with the one
receipt-matched destination entry, without copying it into producer history.

### `AskUser` — blocking structured questions (interaction bridge)

`AskUser` is the single blocking human-input tool. Its strict input is an
optional `message` (long context or a draft) plus `questions`: one to five
objects with `header` (at most 12 characters), `question`, two or three
`options` (`label` plus `description`), and optional `multiSelect`. It waits for
answers and resumes the same model run with structured selections and custom
replies. The app-owned bridge defaults to loopback and starts automatically when a configured
Slack/Telegram send tool or `AskUser` is allowed, when the `interaction` block or
an interaction env override is configured, or when `interaction.progress.enabled`
resolves true and `tools.mcpRequestContextServers` names an opted project MCP
server.

Keep `interaction.bridge.host` on `127.0.0.1` or another loopback address. The
runtime currently accepts non-loopback values, which can expose the
bearer-protected internal bridge off-host; the bearer is a capability, not a
substitute for a local bind boundary.

- The web console renders every question in one form and submits all remaining
  answers atomically. Slack and Telegram render one question at a time with
  native option buttons, **Other** for a typed reply, and **Done** for
  multi-select.
- The interaction destination is host-owned and may differ from the logical
  producer conversation. This lets an interactive scheduled run show its context
  and buttons in the Slack thread or Telegram chat that triggered it while its
  history remains attached to the producing run.
- While an ask is pending, an eligible plain-text reply on that destination is
  consumed as the active question's custom answer and never runs as a separate
  turn. Slash commands remain commands, and `/cancel` cancels the pending ask.
- One pending ask per physical conversation. A second concurrent ask returns an
  "already pending" result; consolidate related decisions into one call of up to
  five questions.
- One timeout covers the whole interaction (default 10 min,
  `interaction.askUser.timeoutMs`). The tool returns any answers already
  submitted, identifies the remaining questions as unanswered, and treats a
  later reply as a normal next turn. With no submitted answers, it reports that
  the user did not answer. On an app restart pending asks degrade the same way.
- The wait keeps the MCP call alive via progress notifications (see `tools.mcpCallTimeoutMs` / `tools.mcpCallMaxTotalTimeoutMs`).
- Opted project MCP children can POST `{key, message, state}` to `/v1/progress` using `MONO_AGENT_INTERACTION_PROGRESS_URL` / `MONO_AGENT_INTERACTION_PROGRESS_TOKEN`. The run-scoped bearer selects the producing conversation server-side, is revalidated after the body is read, and is revoked at cleanup. The bridge master bearer remains app-owned and is blanked in opted project MCP environments.

When a blocking `AskUser` call is answered or expires, mono-agent stores its
questions, outcome, and submitted answers in the assistant history copy
committed for that turn; cancelled asks are not journaled. Described options are
included when the transcript bound permits. For an oversized newest valid
entry, option descriptions may be omitted so its questions, outcome, and
answers remain whole. This makes the interaction available to a later
cold/stateless replay even though the transport presented it out of band. The
final outward message and long-term memory capture remain unchanged.
Non-blocking `TelegramSendMessage.reply_options` selections remain separate
next turns.

The example assumes `MONO_AGENT_SLACK_BOT_TOKEN`, `MONO_AGENT_SLACK_APP_TOKEN`, and `MONO_AGENT_TELEGRAM_BOT_TOKEN` are set in `.env`; credentials are intentionally absent from the source config.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep", "SlackSendMessage", "TelegramSendMessage", "AskUser"]
  },
  "slack": {
    "enabled": true,
    "allowedChannelIds": ["C0123"]
  },
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"]
  }
}
```

The allowlist also accepts `MONO_AGENT_ALLOWED_TOOLS` (and `MONO_AGENT_DISALLOWED_TOOLS` for denials, where deny wins). See [Tool policy](/tools/policy/) for allow/deny precedence and how MCP tool names are matched.

:::note
Allowing a send tool but leaving the adapter disabled or unconfigured means the tool is present in name but has no working destination — the send fails. Enable and configure the adapter (Slack / Telegram) as well.
:::

## Native proactive notification (cron/webhook turns)

For scheduled cron jobs and webhook endpoints, set `notify: true` (optionally `notifyConversationId`) on the job or endpoint. When the run succeeds with non-empty final text, the agent's **final answer is delivered verbatim** to Telegram, Slack, or the web console — posted as-is with **no second LLM turn** — and recorded into that destination's history, so a user's reply resumes with it in context.

This is AI-native: the operator just writes the cron/webhook prompt, and its final answer reaches the user. On a notify turn the harness **auto-injects guidance** telling the agent that its final reply is delivered verbatim and how to stay silent. The operator and the agent never configure or call an internal notify tool — there is no agent-facing notify tool.

Cron has one failure-side notification path as well: if a `notify: true` cron job fails because **all configured models failed** (`provider_unavailable_exhausted`), the app can send a short one-line error notice to the job's explicit `notifyConversationId`. This notice is verbatim, never starts another model turn, never infers a destination, and is rate-limited per job by `notifyFailureCooldownHours` (default `6` hours).

`conversationId` / `notifyConversationId` is a channel-scoped id such as `telegram:42`, `slack:C123`, or `slack:C123:1718.99` (a Slack thread). The special notify-only destination `web:new` means “create a new web-console conversation”; other `web:*` values are rejected.

### Destination resolution

- If `notifyConversationId` is set, it is the destination. Exact `web:new` creates one new assistant-only web conversation per distinct cron result or successful webhook invocation.
- Otherwise the app infers it **only when exactly one** notify-capable (Telegram/Slack) candidate exists — drawn from seen conversations plus the adapter allowlist.
- With **0 or 2+** candidates the app skips delivery with a warning rather than guessing.
- Cron model-exhaustion failure notices are stricter: they require explicit `notifyConversationId` and never use inference.

Inference is evaluated for each cron firing or webhook invocation, immediately before the agent run. That one route snapshot binds both host-only continuation `replyTo` and the run's final native delivery; webhook keeps the delivery route as a private scalar and reconstructs a separate completion request, so a structurally typed responder cannot redirect, delete, or inject it by mutating its request. If the candidate set becomes ambiguous before a later run, that later run has no reply target and its delivery is skipped rather than retaining a destination chosen at process start. Resolver promises are raced against the run's abort signal, so replacement, client disconnect, or stop can reclaim resolver-held slots without waiting for `maxRunMs`.

Artifact-derived candidates are cached in-process for 30 seconds after a scan
completes, so repeated notifications do not repeatedly `stat` a busy artifact
directory. An artifact committed under a Telegram/Slack conversation id
invalidates the cache at each local lifecycle commit: when its running summary
appears and again when its terminal summary is written. Runs using the default
synthetic `cron:`/`webhook:` ids do not invalidate it; a trigger configured with a
Telegram/Slack conversation id does. Other artifact-directory changes are picked
up after cache expiry and the next scan completes.

The owning channel's allowlist is the destination boundary for Telegram/Slack: a delivery outside `telegram.allowedChatIds` / `slack.allowedChannelIds` (or `allowAllChats` / `allowAllChannels`) is refused. WhatsApp is not notify-capable. `web:new` is explicit-only and talks to the active local web service through an owner-private loopback ingress. The service records the delivered answer into the generated thread's agent history before exposing the completed thread, marks it **CRON** or **WEBHOOK**, and leaves the currently selected thread unchanged. Duplicate delivery keys return the existing thread; conflicting reuse fails. If the web service is unavailable, delivery is skipped after one five-second attempt—there is no retry or outbox. Delivery remains best-effort: a skipped or failed notification does not change the cron job result or the webhook's HTTP response / async stored status.

When the web console's existing header bell is enabled, a new marked conversation also uses the same response-arrival browser notification path. As with ordinary web responses, the page/PWA must still be alive and hidden or unfocused; this is not background Web Push.

### Staying silent ("nothing to report")

To send nothing for a tick or request, the agent either produces an **empty final answer** or replies with exactly the reserved sentinel `NOTHING_TO_REPORT` (matched trimmed, case-insensitive). In either case no notification is posted.

### How native notification differs from send tools

| | **Native notify** (`notify: true`) | **Send tools** (`SlackSendMessage` / `TelegramSendMessage`) |
|---|---|---|
| Effect | Posts the final answer **verbatim** and records it as a remembered turn | Posts exact tool text into a **channel** and records each confirmed post in destination history |
| Available on | **cron / webhook turns** (opt-in per job/endpoint) | any turn |
| Agent involvement | None — the app delivers the final answer; no tool call | Agent calls the tool explicitly |
| Allowlist entry | **Not** a `tools.allowedTools` entry (config-level toggle) | Available under allow-all (the default); a specific `tools.allowedTools` needs the exact tool name |
| Destination bound | The owning channel's allowlist | The owning channel's allowlist |
| Channels | Telegram + Slack + web console (`web:new`) | Telegram + Slack |

### Fan-out and multi-destination

Notifying **multiple** or **other** conversations from one trigger is not a built-in. Compose it from several cron jobs (each with its own `notifyConversationId`) or from a skill that calls the send tools explicitly.

For a live chat that delegates work and needs one later reply in the same channel/thread, use a [durable continuation](/tools/durable-continuations/). The host binds the physical reply target and gives only a selected trusted MCP server a claim capability. Do not ask the model to copy a `conversationId` into a webhook payload: model-supplied routing is neither an authorization boundary nor a reliable thread binding.

## Related pages

- [Telegram](/channels/telegram/) and [Slack](/channels/slack/) — adapter config and allowlists.
- [Web console](/observability/web-console/) — persistent conversations and browser notification behavior.
- [OpenAI-compatible endpoint](/channels/openai-api/) — token streaming over SSE.
- [Cron](/channels/cron/) and [Webhook](/channels/webhook/) — the proactive turns that support native `notify: true` delivery.
- [Tool policy](/tools/policy/) — `allowedTools` / `disallowedTools` precedence.
- [MCP tools](/tools/mcp/) — external MCP policy and the app-owned tool exceptions.
- [Durable continuations](/tools/durable-continuations/) — origin-bound asynchronous results and native delivery receipts.
- [Write your own channel adapter](/programmatic/custom-channels/) — building a driver to override `stream.finalOnly`, debounce, and message texts.
