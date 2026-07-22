---
title: "Cron"
description: "Schedule timezone-aware agent turns, author jobs in config or Markdown, and deliver successful results without an external cron daemon."
sidebar:
  order: 7
---

The cron channel fires scheduled prompts at the agent's responder on a timezone-aware five-field schedule. Jobs run on an **in-app scheduler** — no system `cron`, `crontab`, or `launchd` is involved, so the agent just needs to be running. Jobs can be declared inline in config and/or as one `*.md` file per job in a folder; the two sources merge. Coverage: `config`.

## What a cron job is

Each tick invokes the responder with the job's `prompt` text, exactly as if a message arrived on a channel. The result is produced inside the agent process. If you want a scheduled message to reach the user, prefer native cron notification with `notify: true`: the agent writes the final answer once, and the app delivers it to Telegram, Slack, or a new web-console conversation after the run succeeds.

### Proactive delivery from a cron turn

Set `notify: true` on a job to deliver its successful, non-empty final answer to Telegram, Slack, or the web console. The agent's **final answer is posted verbatim** — no second LLM turn — and recorded into the destination's history, so a user's reply resumes with it in context. The operator just writes the prompt; on a notify turn the harness auto-injects guidance telling the agent that its final reply is delivered as-is and how to stay silent.

**Destination resolution.** If `notifyConversationId` is set, it is used (`telegram:42`, `slack:C123`, `slack:C123:1718.99` for a Slack thread, or the exact value `web:new`). `web:new` creates a separate assistant-only conversation for every distinct result, marked **CRON** in the sidebar and header. It is explicit-only and never participates in destination inference. If `notifyConversationId` is omitted, the app infers the destination **only when exactly one** Telegram/Slack notify-capable candidate exists (from seen conversations plus the adapter allowlist). With 0 or 2+ candidates, delivery is skipped with a warning — it never guesses. Artifact-derived candidates are cached for 30 seconds after each scan completes. An artifact committed under a Telegram/Slack conversation id invalidates the cache immediately; runs using the default synthetic `cron:`/`webhook:` ids do not. Other artifact changes are picked up after cache expiry and the next scan completes. Delivery is best-effort: a failed notification does not change the cron job result. Web delivery makes one attempt against the running local console and has no retry queue or outbox.

**Model-exhaustion failure notice.** For cron jobs only, `notify: true` also enables a short one-line error notice when the run fails because **all configured models failed** (`provider_unavailable_exhausted`). This notice is sent only when `notifyConversationId` is explicitly set; failure notices never infer a destination. They are delivered verbatim with no second LLM turn, best-effort, and rate-limited per job by `notifyFailureCooldownHours` (default `6`).

**Staying silent.** To send nothing for this tick, have the agent produce an **empty final answer** or reply with exactly the reserved sentinel `NOTHING_TO_REPORT` (matched trimmed, case-insensitive). In either case no notification is sent.

Notifying **multiple** or **other** conversations from one trigger is not a built-in: compose it from several cron jobs, each with its own `notifyConversationId`, or from a skill.

## Expression format

Cron expressions have exactly five positional fields:

```text
minute hour day-of-month month day-of-week
```

For example, `0 9 * * *` runs every day at 09:00. The default timezone is `UTC`; set an IANA timezone such as `Europe/Rome` when the schedule should follow local civil time. A seconds field and macros such as `@daily` are not supported. Hashed `H` fields are supported and stay stable across restarts and re-arms because each schedule is seeded from its job `id`; renaming the job intentionally changes that seed and can change its hashed slot.

When you select **Scheduled jobs (cron)** in the guided `mono-agent init` wizard, the expression is validated at the prompt. Its default is `0 8 * * *` at 08:00 UTC. The wizard scaffolds `cron/digest.md` only after the expression is accepted, then validates the effective folder—including any existing jobs that init will preserve—before making runtime model calls.

## Configuration

```json
{
  "cron": {
    "dir": "cron",
    "jobs": [
      {
        "id": "daily",
        "enabled": true,
        "expression": "0 9 * * *",
        "timezone": "UTC",
        "prompt": "Post the morning summary.",
        "conversationId": "cron-daily",
        "notify": true,
        "notifyConversationId": "telegram:42",
        "notifyFailureCooldownHours": 6
      }
    ]
  }
}
```

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `cron.dir` | string | no | `cron` | Folder of per-job `*.md` files (frontmatter metadata + prompt body). |
| `cron.jobs[]` | array | no | `[]` | Inline job definitions. Merges with `*.md` files in `cron.dir`. |
| `jobs[].id` | string | yes | — | Unique job id. Duplicate ids (across config and folder) are an error. |
| `jobs[].enabled` | boolean | no | `true` | Set `false` to keep a job defined but unscheduled. |
| `jobs[].expression` | string | yes | — | Five fields: `minute hour day-of-month month day-of-week`; no seconds field or macros. `H` fields use the stable job `id` as their hash seed. |
| `jobs[].timezone` | string | no | `UTC` | IANA timezone (e.g. `Europe/Rome`) the expression is evaluated in. |
| `jobs[].prompt` | string | yes | — | Text sent to the responder on each tick. |
| `jobs[].conversationId` | string | no | per-tick | Share memory/history across ticks (see below). |
| `jobs[].maxRunMs` | number | no | `1200000` | Per-job watchdog in milliseconds. |
| `jobs[].notify` | boolean | no | `false` | Deliver the successful final answer via native cron notification. |
| `jobs[].notifyConversationId` | string | no | inferred if exactly one destination | Destination conversation id for native notification. Use exact `web:new` to create a new CRON-marked web conversation; web is never inferred. |
| `jobs[].notifyFailureCooldownHours` | number | no | `6` | Per-job cooldown, in hours, for all-models-failed error notices on `notify: true` jobs. |
| `jobs[].model` | string | no | `runtime.model` | Per-job model override. Becomes this turn's primary, keeping canonical `runtime.fallbacks` (or legacy backups). See [Per-trigger model & effort](#per-trigger-model--effort). |
| `jobs[].effort` | string | no | `runtime.effort` | Per-job reasoning effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`), subject to model support. Reasoning-capable `pi:*` maps `ultra` to LOW; Pi without reasoning uses OFF. Direct `codex:*` forwards `ultra` unchanged. Mono-agent rejects `ultra` on its Claude SDK route because the pinned SDK public contract ends at `max` (the SDK JavaScript itself forwards the value). The Claude CLI route passes `--effort ultra`, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort. Direct OpenCode rejects explicit effort. Ranking above `max` only prevents keyword downgrade. |

## Per-trigger model & effort

A job can run on a different model or reasoning effort than the agent's default — useful for a nightly deep-research job that should run on a more powerful (and pricier) model than the interactive default. Set `model` and/or `effort` on the job:

```json
{ "id": "deep-research", "expression": "0 3 * * *", "prompt": "…", "model": "claude:claude-opus-4-8", "effort": "high" }
```

The override becomes that turn's **primary** model; configured canonical/legacy fallbacks remain. Under `runtime.routeSafety: "uniform"`, crossing into an incompatible safety family is rejected. Explicit `per-route-native` allows the override only with the route's documented native contract; unsupported capabilities still reject/skip rather than being silently removed. Static violations fail `mono-agent validate`; dynamic invalid values are warned and ignored, so the job stays on its safe default. Only the overridden turn is affected.

A model-override tick runs **ephemerally**: it does not resume or persist a shared continuous session (so a different model never mixes into the conversation's session lineage), though it still sees the job's run history. Overrides to configured local providers are supported: mono-agent recomputes the target provider's endpoint and capabilities. An unconfigured or invalid local target clears the inherited endpoint block and is rejected rather than accidentally using the host provider. An `effort`-only override keeps the same model chain and therefore must still be compatible with every retained fallback.

## Environment variables

| Variable | Maps to | Notes |
| --- | --- | --- |
| `MONO_AGENT_CRON_ENABLED` | `cron.enabled` | Enables the legacy single-job form; default `false`. |
| `MONO_AGENT_CRON_DIR` | `cron.dir` | Folder of per-job `*.md` files; default `cron/`. |
| `MONO_AGENT_CRON_JOBS_JSON` | `cron.jobs[]` | Full JSON array of jobs. |
| `MONO_AGENT_CRON_EXPRESSION` | `cron.expression` | Single-job five-field expression. |
| `MONO_AGENT_CRON_TIMEZONE` | `cron.timezone` | Single-job timezone; default `UTC`. |
| `MONO_AGENT_CRON_PROMPT` | `cron.prompt` | Single-job prompt. |
| `MONO_AGENT_CRON_CONVERSATION_ID` | `cron.conversationId` | Optional stable history/session key. |
| `MONO_AGENT_CRON_NOTIFY` | `cron.notify` | Enables native delivery for the single job. |
| `MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID` | `cron.notifyConversationId` | Explicit single-job delivery destination. |
| `MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS` | `cron.notifyFailureCooldownHours` | Single-job cooldown, in hours, for model-exhaustion failure notices; default `6`. |
| `MONO_AGENT_CRON_MODEL` | `cron.model` | Optional single-job model override. |
| `MONO_AGENT_CRON_EFFORT` | `cron.effort` | Optional single-job reasoning-effort override. |

The single-job environment form always uses the job id `default`; there is no
`MONO_AGENT_CRON_ID`. Use `cron.jobs[]`, `MONO_AGENT_CRON_JOBS_JSON`, or a
Markdown job filename/frontmatter `id` when the id must be chosen explicitly.
See [Environment variables](/config/env-vars/) for the full precedence rules.

## Markdown job files

Instead of (or alongside) inline `jobs`, drop one Markdown file per job in `cron.dir` (default `cron/`). Frontmatter holds the metadata; the body is the prompt:

```markdown
---
id: morning-digest
enabled: true
expression: "0 7 * * *"
timezone: "Europe/Rome"
conversationId: cron-digest
notify: true
notifyConversationId: telegram:42
notifyFailureCooldownHours: 6
---
Summarize yesterday's unread items. Your final answer is delivered verbatim; reply NOTHING_TO_REPORT if there is nothing new.
```

:::caution
Folder jobs and inline `jobs[]` are **merged** into one job set. A job id that appears in both — or twice in the folder — is a configuration error, not a silent override.
:::

This mirrors how the webhook channel authors per-endpoint prompts; see [Webhook](/channels/webhook/).

## Configured overlap: ticks are skipped, never queued

The `@mono-agent/agent-app` cron driver pins the scheduler to `overlap: "skip"`. If a tick fires while the previous run of the **same configured job** is still in flight, the new tick is **skipped** — it is not queued and does not run later. The in-flight run continues uninterrupted. Scheduler overlap state is tracked per job, so one job's active run does not itself make a different job's tick overlap. After scheduler admission, however, shared agent-app harness admission and execution limits can serialize work across different jobs or reject a run when shared capacity is exhausted.

The config schema intentionally has no `overlap`, `maxQueueDepth`, or `overflow` key. Direct embedders of `@mono-agent/cron-adapter` can select queue or replace behavior through the programmatic `startCronAdapter` API; those adapter options are outside this config-focused channel surface.

:::note
Pick an `expression` whose interval comfortably exceeds the job's typical runtime; otherwise the agent will quietly drop overlapping firings.
:::

## Run watchdog: a wedged run is aborted, not left to starve

Skip-on-overlap protects against a *still-running* prior tick. A separate watchdog protects against a *wedged* one. If a run never settles (a hung destination resolver, responder, or provider call), it would otherwise hold the job's slot forever and skip **every** future firing as "a prior run is still active." To prevent that, the cron channel runs each job under a **20-minute watchdog** (`maxRunMs`, default `1200000`): a run that does not finish in time is aborted and its slot reclaimed, so the next tick can fire.

The watchdog and the scheduler slot it reclaims are **per job**: a wedged run does not occupy a sibling job's cron overlap/watchdog slot. That isolation stops at scheduler admission; shared agent-app harness admission and execution limits may still delay sibling provider work or reject it when shared capacity is exhausted. Set `jobs[].maxRunMs` (or `maxRunMs` frontmatter) to override the default for a specific job. Programmatic callers can still set `maxRunMs` on `startCronAdapter` as the adapter-level fallback. An aborted run is recorded with an `interrupted` status — see [Run artifacts & traces](/observability/artifacts-and-traces/).

Programmatic destination resolvers receive the run's `AbortSignal`, and their promise is raced against it independently of the watchdog. Consequently, overlap replacement or adapter stop reclaims a firing that is still resolving even when `maxRunMs` is unset and the resolver ignores the signal; later settlement is discarded.

## Sharing memory and history with `conversationId`

Each tick defaults to its own ephemeral context. Set a stable `conversationId` to make every tick of a job land in the same run-history thread, so the job accumulates history and shares memory across runs — useful for digests that should not repeat themselves or jobs that build on prior state. This is not the notification destination; use `notifyConversationId` for that. Two jobs that set the same `conversationId` will share that thread.

See [Sessions & concurrency](/runtime/sessions-concurrency/) for how conversations map to provider sessions.

## Related

- [Cron digest + proactive notify](/playbooks/cron-digest-proactive-notify/) — end-to-end scheduled-digest playbook.
- [Delivery & send tools](/channels/delivery-and-send-tools/) — push a tick's output to a channel.
- [Channels overview](/channels/).
