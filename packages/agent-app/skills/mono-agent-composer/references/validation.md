# Validation

Use validation that matches the chosen composition path. Do not claim the host works from a typecheck alone.

## Config Validation (default path)

In the user's agent folder:

```bash
mono-agent validate
```

The report covers core config, runtime support for the primary and every
fallback model, identity/skills/memory/MCP paths, the sandbox policy,
observability (artifacts, traceability, and configured exporters), runs health,
managed launchd logs, secret placement, and every channel (`ok` / `waiting` /
`disabled` / `error`). Its Runtime provenance section identifies the CLI
producing the report by a full managed closure id only after validating its
private marker, freshly recomputed installed closure, and coherent current
closure manifest, or reports `dev (unmanaged)`; under `--consumer`, that is
still the validator CLI rather than a separately running daemon. The launchd-log
section reports active, retained, and total bytes for safely inspected streams,
marks unsafe or unreadable byte inventory unavailable, and never rotates or
changes permissions. Exit 0 means the folder is structurally valid; fix every
`[error]`, and treat `[waiting]` as an unresolved selected dependency rather
than a readiness claim.

All read/status commands accept `--json` for scriptable checks (`validate`, `config`, `presets`, `status`, `sandbox status`, `install-skill --project --check`, `runs report`, `runs audit`, `memory`, `continuations`): each writes exactly one stdout JSON object with a top-level `ok: boolean` — exit `0` when ok, `1` when it ran but failed, `2` for a usage error.

From a separate orchestration folder, validate a downstream consumer without changing cwd:

```bash
mono-agent validate --consumer <agent-folder>
```

The consumer folder's `.env` loads by default, relative `--config` and `--env-file` paths resolve inside that folder, and missing memory roots warn read-only instead of being created.

Then start and confirm the status lines:

```bash
mono-agent start
```

Every channel the user asked for must report `running` with its endpoint facts; anything `failed` is a blocker, not a footnote.

On macOS, managed start also installs a no-`KeepAlive` recovery helper that runs
at login and every five minutes. It safely reconciles an inactive worker, a
changed keyed snapshot, or a different available controller CLI closure without
executing mutable source bytes. The existing worker stays live during runtime
installation; failed recovery preserves the helper and both definitions for the
next scheduled retry. `mono-agent stop` removes that authority, so an explicitly
stopped agent is not resurrected.

Confirm the authoritative process boundary with:

```bash
mono-agent status --json
```

Treat `ok: true` as proof only because the status command now requires the trace
PID to be alive and equal launchd's current PID. When launchd has no matching
live process, cached `running` channels are rendered `stopped`, live endpoint
facts are omitted, `pid` is `null`, and the command exits 1. Do not interpret an
old trace manifest by itself as a running consumer.

## Documentation Validation

To confirm a skills folder is indexable (replace `<skillsRoot>` with the
agent's configured skills root, e.g. `./skills`):

```bash
node --input-type=module - <<'EOF'
import { loadSkillIndexFromDirectory } from '@mono-agent/agent-harness';

const skills = await loadSkillIndexFromDirectory('<skillsRoot>');
console.log(JSON.stringify(skills, null, 2));
EOF
```

Expected:

- Every selected skill appears in the index.
- The description is the first plain paragraph from its `SKILL.md`.
- The `mainFile` points at `<skillsRoot>/<skill-name>/SKILL.md`.

## Repo Validation

Run the narrow checks for doc-only changes:

```bash
pnpm run check:architecture
pnpm run typecheck
git diff --check
```

If code or config behavior changes, add the relevant package tests:

```bash
pnpm --filter @mono-agent/<package> run test
pnpm --filter @mono-agent/<package> run build
pnpm --filter @mono-agent/<package> run typecheck
```

For broad host or demo changes, run the full workspace gate:

```bash
pnpm run build
pnpm test
pnpm run build:demo
pnpm run typecheck:demo
pnpm run test:demo
```

## Smoke Tests By Surface

| Surface | Smoke |
| --- | --- |
| TUI | Start the host, connect with ordinary `mono-agent tui`, and complete one real prompt against the running responder. |
| Telegram | Send one allowed chat message that uses a tool; verify the final reply arrives as a new message and the transient activity ledger is deleted. |
| Slack | Send one allowed DM or channel message that uses a tool; verify formatting, a fresh final reply, and deletion of the transient activity ledger. Open `@agent /model`, choose a configured option, and verify DM-wide or shared-channel-thread-local scope as appropriate. |
| Adapter send tools | When `SlackSendMessage` / `TelegramSendMessage` are available (allow-all, or an explicit `tools.allowedTools` entry) with the channel enabled, call them from a non-Slack/Telegram surface such as TUI, cron, or OpenAI API to an allowed destination; verify delivery, then reply at the destination and verify the exact sent text appears in replayed history. |
| WhatsApp | Send one allowed sender/group trigger and verify the reply. |
| OpenAI API | `curl /v1/models` and `/v1/chat/completions`. |
| A2A | Send text to the Agent Card URL with `sendA2AMessage()`. |
| Webhook | `curl` the invocation path and inspect the response body/status. |
| Cron | Run a one-off scheduled invocation or wait for one tick. |
| Observability | Confirm a run writes a JSONL artifact with strings capped: non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes. If an `observability.exporters` Phoenix entry is set, confirm the trace appears in Phoenix. |
| Memory recall tool | With any memory tier configured (`memory.recallTool.enabled` defaults on), ask the agent to recall an old note and confirm `MemoryRecall` appears separately from action-tool allowlists and returns it. |
| Semantic memory search | With `memory.embeddings` set, first prove the configured provider only: Ollama model advertises `embedding` through `/api/show` and answers `/api/embed`, or LM Studio model has exact `type: "embedding"` in `/api/v1/models` and answers `/v1/embeddings`. Verify the finite vector dimension matches config, then ask a paraphrased question about an old note and confirm `MemoryRecall` returns it. Never accept a cross-provider fallback as proof. |

## Failure Handling

Report failures as explicit blockers or follow-up work. Do not present:

- a missing runtime as a successful fallback
- disabled tools as a successful MCP integration
- a fake adapter request as a product-runtime smoke
- a redacted or skipped secret as proof that the live adapter works
