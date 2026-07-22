---
title: "Sessions, concurrency & Pi-native tuning"
description: "Distinguish session boundaries, configure queueing and concurrency, and manage durable Pi transcripts."
sidebar:
  order: 5
---

This page covers how the runtime keeps provider sessions warm per conversation, how it bounds in-flight work with admission and execution limits, and the Pi-native transport knobs for transport selection, retries, and durable on-disk sessions. Every option here is `config` coverage with a matching `MONO_AGENT_*` env var unless noted.

## The five "session" meanings

Mono-agent uses "session" for five related but different boundaries:

| Meaning | What owns it | What it controls | What resets it |
| --- | --- | --- | --- |
| `runtime.session` config block | Agent config / env | Whether turns try to reuse a warm provider session and how long idle warmth lasts | Changing config, setting `mode: "per-message"`, or disabling resume support |
| Provider session | Runtime backend / provider bridge | Warm runtime continuity: provider-side context, provider session id, busy state, and idle eviction | Idle eviction, stale/busy resume retry, provider session rotation, cancelled successful turn, harness disposal, or process restart when only in-memory |
| Durable Pi transcript | Pi-native JSONL store plus the canonical history record's random provider epoch and transcript revision | Crash-safe cross-restart and cross-process resume for Pi-native provider sessions | `mono-agent restart --clear-sessions`, deleting either store, a dirty fence or legacy/missing history record, host-only history append, failed provider sync, or leaving `piSessionsRoot` unset |
| Web console thread | `mono-agent web` / `@mono-agent/web` | Persistent source-bound browser conversation, its messages/attachments/live follow-ups, and at most one active turn; different threads can run concurrently | Archive only hides it; `mono-agent web reset --all --yes` removes the entire stopped console store. Browser disconnect does not end its active turn; service restart marks that turn interrupted and requeues uncertain live input |

Boundary rules:

| Boundary | What ends | What survives | What is emitted |
| --- | --- | --- | --- |
| Daily rollover (`runtime.session.rollover: "daily"`) | The current day-bucket conversation id and its warm provider-session lineage | Durable memory, old run artifacts, durable Pi transcripts for other ids, and app process state | `session_boundary` with `kind: "rollover"` on the first turn of the new bucket |
| Isolated proactive turn (`runtime.session.isolateProactive: true`) | Nothing shared; the proactive turn intentionally skips the conversation's warm provider session | Existing interactive warm session, durable history, memory, and run artifacts | `session_boundary` with `kind: "isolated"` and `reason: "proactive"` |
| Isolated model override | Nothing shared; the override turn uses a one-shot provider session for the alternate model | Existing default-model warm session, durable history, memory, and run artifacts | `session_boundary` with `kind: "isolated"` and `reason: "model_override"` |
| Resume replay after stale/missing provider session | The stale provider session id | Durable history, memory, run artifacts, and the run itself, which retries once | `runtime_warning` `session_resume_retry` plus `session_boundary` with `kind: "resume_replay"` |
| Host-only history append / unsynchronized provider result | The prior durable provider epoch | Canonical history, memory, and run artifacts | The next provider turn receives a fresh epoch id and replays canonical history |
| Telegram `/new` | Current chat's warm provider session and canonical history | Other conversations, durable memory, run artifacts, and the chat's model/effort override | Telegram confirmation; the next message rebuilds startup context and reloads skills |
| Idle eviction / replaced / disposed provider session | Warm runtime continuity for that conversation id | Durable Pi transcripts, durable history, memory, and run artifacts | App log line and status metadata event (`evicted`) with reason |
| Detached status read | Nothing | All runtime/session state | No runtime event; status reads the latest published config + store snapshot |
| `mono-agent restart --clear-sessions` / explicit purge | Durable Pi transcripts under `piSessionsRoot` and canonical active conversation history beside `artifacts.dir` | Durable memory under `memory.path` and recorded run artifacts | Restart/status output only |
| Browser disconnect or reload | Only that SSE/browser connection | Web service turn, source-bound thread, messages, committed attachments, provider/harness work | Reconnect receives current state and subsequent events |
| Web service restart | Any web-owned active upstream connection | Terminal messages, archived/active threads, committed attachments, queued live follow-ups, agent memory/history, recorded runs | Active web turn is projected as `interrupted`; pending live offers become queued normal turns |
| `mono-agent web reset --all --yes` | Entire stopped web-console SQLite/settings/upload state | Agent configs, provider/harness history, memory, and recorded-run artifacts | CLI confirmation/result only |

## Provider sessions

`runtime.session` decides whether the runtime keeps a warm provider session per conversation or starts fresh on every message.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `runtime.session.mode` | `"continuous"` \| `"per-message"` | `continuous` | `continuous` keeps a warm provider session per conversation; `per-message` rebuilds context each turn |
| `runtime.session.idleTimeoutMs` | number (ms) | `1800000` (30 min) | How long a warm session lingers before idle eviction |
| `runtime.session.rollover` | `"none"` \| `"daily"` | `none` | Whether the responder buckets conversation ids by local day |
| `runtime.session.rolloverTimezone` | IANA timezone string | system local timezone | Timezone used to compute the daily rollover bucket |
| `runtime.session.rolloverNotice` | boolean | unset / off | When true, the first turn of a new daily bucket gets a one-line adapter-visible notice before the model answer |

In `continuous` mode the runtime holds one warm provider session per conversation. Same-conversation follow-ups **queue and resume warm** rather than rebuilding the provider session from scratch. A queued warm-session follow-up holds **no concurrency slot** while it waits (see below). After `idleTimeoutMs` with no activity, the session is evicted and the next message starts cold.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000, "rollover": "daily", "rolloverTimezone": "UTC", "rolloverNotice": false }
  }
}
```

Env vars: `MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`, `MONO_AGENT_SESSION_ROLLOVER`, `MONO_AGENT_SESSION_ROLLOVER_TIMEZONE`, `MONO_AGENT_SESSION_ROLLOVER_NOTICE`.

Warm in-memory sessions are lost on restart. To resume across restarts, use the default durable history store together with `providers.piNative.piSessionsRoot` (Pi-native backends only — see [Pi-native tuning](#pi-native-tuning) below). The history store, not a conversation-id hash, owns the resumable provider epoch.

`rolloverNotice` is adapter-local and default-off. It does not enable rollover by itself and does not add a new IPC channel or change provider resume behavior. When daily rollover is already enabled and a base conversation crosses into a new day bucket, the responder streams `New session bucket started: <bucket>.` before the model answer and includes the same prelude in the returned final text for final-only transports.

Daily rollover partitions active conversation/provider history, but it does not
partition recorded-run exploration: the app-owned `RunHistory` tool strips the
daily bucket only for its request-scoped authorization match, so completed runs
from earlier buckets of the same logical conversation remain searchable. Other
conversations and threads remain inaccessible.

## Concurrency: admission and execution bounds

`concurrency` bounds how much work is in flight. There are two separate limits, applied at different points in a run:

| Key | Default-bearing | Caps | Applied |
| --- | --- | --- | --- |
| `concurrency.maxConcurrentRuns` | yes | How many runs **execute** against the provider at once (execution width) | At the provider step |
| `concurrency.maxPendingRuns` | yes | How many runs may be **admitted** and wait before the provider step | Before the expensive provider step |

`maxConcurrentRuns` is the execution width — the number of runs that may be calling the provider simultaneously. `maxPendingRuns` is the admission bound — it caps how many runs can be queued waiting for an execution slot before new work is rejected, protecting you from unbounded backlog ahead of the expensive provider call. Queued follow-ups on a warm session hold no slot against either limit.

```json
{
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16
  }
}
```

Env vars: `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`, `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS`.

These bounds cover the harness run path (which begins at `responder.respond`). Channel adapters (Slack/Telegram) do per-conversation admission and attachment downloads *before* that boundary, so cross-conversation transport download IO is not covered here — per-file byte caps and timeouts apply to that instead. A plain-text same-conversation follow-up can be applied inside the active provider run; its reserved adapter queue slot is released after acknowledgement or becomes the next normal turn on an unsupported/failed/end-of-turn race. Adapter queues are drained and aborted on `/cancel` and stop.

The web console separately admits only one active turn per thread. Text-only
submissions during that turn use live provider steering when supported and a
durable next-turn queue otherwise; they never create parallel responses in the
same thread. Because each thread has its own permanent conversation id, distinct
web threads and distinct agents can execute concurrently subject to the selected
agent's ordinary harness limits. Closing the browser does not free a harness
slot or cancel that turn; use the visible cancel action when cancellation is
intended.

### Per-channel scope gotcha

These values are **not a single global cap.** The app builds one harness — and therefore one limiter — per enabled channel. Each channel's limiter bounds *that channel independently*. With N enabled channels, the effective ceiling is **N × the configured value**.

:::caution
For example, `maxConcurrentRuns: 4` with three enabled channels (Telegram, Slack, webhook) allows up to **12** simultaneous provider runs across the app, not 4.
:::

Size the value as a *per-channel* budget. If you need a hard app-wide ceiling, divide your target by the number of enabled channels. See [Channels](/channels/) for which channels are active.

## Pi-native tuning

`providers.piNative` tunes the Pi-native provider path: transport selection, retry behavior on transient provider failures, and optional durable session storage. These apply to `pi:<provider>:<model>` backends. All fields are optional.

| Key | Range / Default | Meaning |
| --- | --- | --- |
| `providers.piNative.transport` | `auto` (default), `sse`, `websocket`, `websocket-cached` | Preferred provider transport; providers without multiple transports ignore it |
| `providers.piNative.piMaxRetries` | `0`–`8`, default `2` | Transient provider-transport retries |
| `providers.piNative.maxRetryDelayMs` | default `60000` | Backoff cap between retries (ms) |
| `providers.piNative.piSessionsRoot` | path; unset = in-memory | Durable JSONL session store enabling resume across restarts |

```json
{
  "providers": {
    "piNative": {
      "transport": "sse",
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000,
      "piSessionsRoot": ".mono-agent/sessions"
    }
  }
}
```

Env vars: `MONO_AGENT_PI_TRANSPORT`, `MONO_AGENT_PI_MAX_RETRIES`, `MONO_AGENT_MAX_RETRY_DELAY_MS`, `MONO_AGENT_PI_SESSIONS_ROOT`.

`auto` preserves Pi's provider-specific default and fallback behavior. An explicit mode is host-authoritative for configured agents: request-scoped runtime extensions cannot replace it. Every Pi result records the normalized choice as `diagnostics.pi_transport_requested`; this is the requested mode, not a claim that a provider with only one transport changed its wire protocol.

### Durable sessions and restart

With the configured app's default history store, setting `piSessionsRoot` persists Pi sessions to JSONL and enables history-coordinated resume after restart. Before provider execution, the store publishes and fsyncs a separate owner-only dirty fence while holding a cross-process conversation lock from a fixed 16-shard table. The fixed table bounds lock files while safely serializing shard collisions; legacy per-conversation lock files are honored in place during migration. The fence does not replace, count as, or prune canonical history. A successful provider result is eligible for reuse only when it returns the exact epoch-derived id and the runtime affirmatively fsyncs both its JSONL file and parent directory. The history messages, clean provider epoch, and incremented transcript revision then publish in one atomic replacement before the fence is cleared.

If the process dies after provider mutation but before that clean commit, the fence remains. The next same-conversation run retires the exact fenced JSONL, rotates to a new random epoch, and replays canonical history. An unrelated mutation also reclaims inactive fences as retirement journals: provider deletion and directory fsync complete before the fence is removed. If canonical epoch/revision proves that history commit succeeded and only fence cleanup crashed, maintenance preserves the valid transcript and removes only the stale fence. Beginning and aborting a fresh conversation cannot evict an older successful conversation because fences are bounded separately. Missing/v1 records, failed sync, retention that removes a record, and `appendVerbatimTurn` host-only deliveries retire and rotate provider state for the same reason.

Each clean record also carries the durable provider transcript revision. A process saves that revision with its warm handle. If another process commits the same epoch first, the revision mismatch forces the stale process-local handle to close and reopen the current JSONL (or rebuild from canonical history) before it can omit history. The same strict refresh runs for an unconfirmed durable resume when a newly constructed harness has no local mapping, preventing a module-global provider registry from reviving older process memory. Cross-process serialization therefore protects both disk writes and in-memory provider state.

On every cold durable Pi reopen, the harness loads canonical history and passes it as structured leading runtime messages, with the current user message last; it does not duplicate those turns inside the system prompt. Pi appends the leading messages only when the requested durable epoch has no JSONL and must be created on miss. When the JSONL exists, Pi resumes it and skips the supplied leading history, so a true resume also sees each prior turn exactly once. Confirmed warm turns send only the current user message. Stateless/non-resumable turns and the one explicit resume-retry continue to replay history through the ordinary prompt path.

When `piSessionsRoot` is unset, sessions are in-memory only. A programmatic custom `historyStore` also stays process-local unless it both implements `beginProviderSessionTurn` and advertises `providerSessionRetirement: "fail-closed"`; the harness withholds the durable path because fencing alone cannot reclaim cold JSONL after rotation or retention. Advertise that capability only when the store can durably fence before the provider, serialize the conversation across processes, expose a monotonic provider transcript revision, atomically publish the next revision or rotate the epoch with history commit, and prove exact-id provider transcript retirement before making an epoch unreachable.

:::caution
`mono-agent restart --clear-sessions` purges both `piSessionsRoot` and canonical active conversation history, so the agent neither resumes a provider transcript nor replays an earlier chat turn — a fresh start. Durable memory under `memory.path` and recorded run artifacts remain untouched. A missing sessions or history store is a no-op.
:::

For retry behavior across *different* models (provider failover, not transport retries), see [Fallback models](/runtime/fallback/). Transport retries here are within a single model; fallback moves to the next model in the chain.

## Related

- [Backends & models](/runtime/backends/) — choosing `runtime.model` and execution mode
- [Local providers](/runtime/local-providers/) — `pi:<provider>:<model>` for Ollama / LM Studio / OpenAI-compatible
- [Fallback models](/runtime/fallback/) — ordered backups on retryable provider failure
- [Tool parallelism](/runtime/tools-and-guards/) — concurrent tool calls within a model step (code-only)
