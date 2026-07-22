---
title: "Backfill Historical Runs to Phoenix"
description: "Export existing JSONL run artifacts to Phoenix with original timestamps and idempotent run identities."
sidebar:
  order: 11
---

This playbook retroactively exports run artifacts you already have on disk — `run-*.summary.json` + `run-*.events.jsonl` — into Phoenix, preserving each run's original timestamps and doing so idempotently so re-runs overwrite rather than duplicate.

## Who this is for

Operations engineers onboarding observability after the fact: the agent has been running and writing JSONL artifacts, but a Phoenix exporter was added later (or Phoenix was down), so historical runs never made it into the trace viewer.

## Goal

Retroactively export already-recorded JSONL run artifacts to Phoenix with their original timestamps, idempotently.

## Features used

- [`observability.backfill`](/observability/phoenix-and-backfill/) — `cli` (`mono-agent backfill`)
- [`observability.phoenix-exporter`](/observability/phoenix-and-backfill/) — `config`
- [`observability.jsonl-artifacts`](/observability/artifacts-and-traces/) — `config`

## Configuration

The backfill command reuses the same two settings the live runtime uses: `artifacts.dir` (where the JSONL/summary files already live) and an `observability.exporters[]` Phoenix entry (where they should be sent). No backfill-specific keys exist — backfill replays the existing artifacts through the live OTLP mapping.

```json
{
  "artifacts": { "dir": ".mono-agent/artifacts" },
  "observability": {
    "exporters": [
      {
        "type": "phoenix",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "my-project"
      }
    ]
  }
}
```

The matching env vars are `MONO_AGENT_ARTIFACT_DIR` (overrides `artifacts.dir`) and `MONO_AGENT_OBSERVABILITY_EXPORTERS` (a JSON array overriding `observability.exporters`).

:::note
Deterministic per-run span ids make re-export idempotent: exporting the same run twice overwrites the same spans instead of creating duplicates.
:::

## Steps

1. Ensure existing `run-*.summary.json` + `run-*.events.jsonl` files exist under `artifacts.dir` and that Phoenix is reachable at the configured `endpoint`.
2. Preview the matched runs and spans without sending anything: `mono-agent backfill --all --since 2026-01-01 --until 2026-02-01 --dry-run`.
3. Run the real export: `mono-agent backfill --all --since 2026-01-01` (transport retries up to 6 times on `5xx`/`429`/`408`).
4. Re-run the same backfill and confirm the deterministic ids overwrite the existing spans rather than duplicating them.
5. Open Phoenix and verify the historical timestamps are preserved on the imported runs.

## Smoke test

:::tip
Run `backfill --dry-run` first, then the real export; confirm in Phoenix that historical runs appear with their original timestamps, and that a second run does not create duplicate spans.
:::

## Related

- [Phoenix and backfill](/observability/phoenix-and-backfill/)
- [Artifacts and traces](/observability/artifacts-and-traces/)
- [Observability CLI reference](/observability/cli-reference/)
- [mono-agent composer skill](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)
