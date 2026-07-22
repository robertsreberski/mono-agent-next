---
title: "Phoenix-Observed Agent with TUI"
description: "Capture agent traces in Phoenix while driving turns through the terminal operator console."
sidebar:
  order: 10
---

This playbook configures best-effort, terminal-batched export to a [Phoenix](https://phoenix.arize.com/) tracing dashboard as OpenInference semantic spans. After a successful terminal recorder boundary, a separate sensitive-key-redacted, credential-scanned, capped JSONL snapshot remains local. Neither path is crash-safe: process death before that boundary can omit the Phoenix batch and lose RAM-buffered JSONL events. You drive the agent from the terminal TUI and inspect successfully exported prompts as AGENT / LLM / TOOL spans.

## Who this is for

Agent builders evaluating runs in a tracing dashboard — you want to inspect prompts, model output, and tool calls visually instead of grepping logs.

## Goal

Run an agent locally with the TUI, attempt a best-effort terminal-batched Phoenix export as OpenInference semantic spans, and retain an independent bounded JSONL snapshot when terminal persistence succeeds.

## Features used

- [`observability.phoenix-exporter`](/observability/phoenix-and-backfill/) — additive, best-effort OTLP/HTTP protobuf export of each run as a semantic timeline (config).
- [`observability.jsonl-artifacts`](/observability/artifacts-and-traces/) — empty events plus a `running` summary at start, then redacted and capped `run-*.summary.json` + `run-*.events.jsonl` snapshots at finish/fail; non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes; a pre-terminal crash can lose buffered events (config).
- [`observability.trace-registry`](/observability/artifacts-and-traces/) — heartbeat manifests that `mono-agent status` reads (config).
- [`tui.chat`](/observability/tui/) — the operator console: live chat with thinking/tool/telemetry insight, run replay, and a config view (cli).

## Configuration

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6"
  },
  "artifacts": {
    "dir": ".mono-agent/artifacts"
  },
  "traceability": {
    "registryDir": ".mono-agent/trace-sources",
    "sourceId": "my-agent",
    "heartbeatMs": 10000
  },
  "observability": {
    "exporters": [
      {
        "type": "phoenix",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "my-project",
        "includeSensitiveData": false,
        "contentPatternRedaction": false,
        "timeoutMs": 5000
      }
    ]
  }
}
```

The exporters array can also be supplied via the `MONO_AGENT_OBSERVABILITY_EXPORTERS` env var (a JSON array of exporter objects). The local recorder is independent of Phoenix: it creates an empty-event start snapshot and replaces it with sensitive-key-redacted, credential-scanned, capped events at finish/fail. Phoenix adds a best-effort terminal batch; exporter failure does not change the run outcome, and process death before terminal persistence can leave neither terminal batch nor buffered JSONL events.

:::caution
With `includeSensitiveData: false`, exported spans are metadata-only and raw prompt/result payloads are withheld. Set it to `true` only against a trusted Phoenix; substantive payloads are exported and strings are capped. Non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free text is not content-scanned by default. `contentPatternRedaction: true` adds a closed high-confidence credential-shape scan over retained outbound text, but remains defense in depth. Independently, local JSONL artifacts always apply that closed scan before persistence while still retaining private content that does not match it.
:::

## Steps

1. Start Phoenix locally (listening on `6006`).
2. `mono-agent init --model claude:claude-sonnet-4-6`.
3. Add the `artifacts`, `traceability`, and `observability.exporters[]` phoenix entry to `mono-agent.config.json`.
4. `mono-agent validate` (it POSTs an empty protobuf to confirm export-compatibility, not just reachability), then `mono-agent start` (it prints the Phoenix endpoint as the trace source).
5. `mono-agent tui` (from any directory — it discovers the running agent) and complete a prompt.
6. Open Phoenix and confirm the run appears as AGENT / LLM / TOOL spans under `my-project`.

## Smoke test

:::tip
Complete one prompt in the TUI; confirm a JSONL artifact is written AND the trace appears in Phoenix with merged tool spans and the correct project name.
:::

## Related

- [Phoenix exporter and backfill](/observability/phoenix-and-backfill/)
- [Artifacts and traces](/observability/artifacts-and-traces/)
- [Observability CLI reference](/observability/cli-reference/)
- [TUI](/observability/tui/)
- [Backfill historical runs](/playbooks/backfill-historical-runs/)
- mono-agent composer skill: `packages/agent-app/skills/mono-agent-composer`
