---
title: "Observability & operator products"
description: "Map mono-agent's local observability surfaces and the standalone terminal and web operators."
sidebar:
  order: 0
---

Every mono-agent run gets local JSONL artifacts and can optionally be exported to [Phoenix](/observability/phoenix-and-backfill/) for a semantic trace timeline. The artifacts are the on-disk record after successful recorder boundaries, not a crash-safe in-flight journal. The v1 terminal and web operators are separate products over one shared authenticated operator protocol; neither is a view embedded in the lifecycle CLI. This page maps those surfaces and links the detail pages.

## The surfaces

| Surface | What it is | Coverage | Page |
| --- | --- | --- | --- |
| JSONL run artifacts | Per-run `run-*.events.jsonl` + `run-*.summary.json`; non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes | config / auto | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| Trace-source registry | Heartbeat manifest so dashboards discover live agents | config | [Run artifacts & traces](/observability/artifacts-and-traces/) |
| Phoenix exporter + backfill | Best-effort OTLP/HTTP export of run lifecycles; retroactive backfill | config / cli | [Phoenix export & backfill](/observability/phoenix-and-backfill/) |
| `mono-agent` CLI | Agent lifecycle and diagnostics on the transitional host plane | cli | [CLI reference](/observability/cli-reference/) |
| Terminal operator | Standalone pi-tui text chat over the shared strict operator client | cli / code | [Terminal operator](/observability/tui/) |
| Web operator | Standalone authenticated service with durable source-bound text conversations | config / cli / code | [Web operator](/observability/web-console/) |

## JSONL run artifacts (always on)

Run artifacts are created for every run regardless of whether any exporter is configured. At `start()`, the recorder separately replaces an empty events file and a `running` summary. It applies a 4,096-byte default cap per string, then schedules best-effort `running` checkpoints after 25 new events or five seconds from the first uncheckpointed event. Non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free-text content is not scanned or scrubbed. Prompts, replies, tool prose, error text, and the compiled system prompt therefore remain private operator data. Terminal `finish()`/`fail()` queues behind any scheduled checkpoint and separately replaces the complete bounded events snapshot first and the summary second. These writes provide no append, fsync, power-loss, or cross-file transaction guarantee. A crash can retain the last successful prefix while losing the unscheduled or failed-write tail, and stale-run reconciliation can report only persisted data. The artifacts also carry the metrics other tools build on: per-run usage/cost/cache (`observability.cost-tracking`), per-turn `provider_bridge_latency`, per-tool `tool_timing` (`execution_ms`), and `mcp_call_duration_ms` on MCP results — letting you separate model-reasoning time from tool/MCP time.

```json
{
  "artifacts": { "dir": "./.mono-agent/artifacts" }
}
```

Override the directory with `MONO_AGENT_ARTIFACT_DIR`. The [tool bloat-guard](/runtime/tools-and-guards/) also persists truncated tool output here, so artifacts double as the overflow store for large results.

Each summary carries a final `status` (`succeeded` / `failed` / `cancelled` / `interrupted`). A run left at `running` by a crashed process is reconciled to `interrupted` at the next startup, so a dead process never leaves a run "running" forever. See [Run status and stale-run reconciliation](/observability/artifacts-and-traces/#run-status-and-stale-run-reconciliation).

See [Run artifacts & traces](/observability/artifacts-and-traces/) for the event schema and how to read a run.

## Trace-source registry

The host publishes a heartbeat manifest into a registry directory so external dashboards (and `mono-agent start`/`status`) can discover which agents are currently running and whether a source has gone stale.

```json
{
  "traceability": {
    "registryDir": "./.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000
  }
}
```

The matching env vars are `MONO_AGENT_TRACE_*` (e.g. `MONO_AGENT_TRACE_REGISTRY_DIR`, `MONO_AGENT_TRACE_SOURCE_ID`, `MONO_AGENT_TRACE_SOURCE_LABEL`). The Phoenix exporter reuses `sourceLabel`/`sourceId` as its default project name.

## Phoenix export + backfill

Adding a Phoenix exporter turns each run lifecycle into a semantic OpenInference timeline: streaming assistant deltas coalesce into one assistant span, and a tool's `tool_use` + `tool_timing` + `tool_result` events merge by `tool_use_id` into one TOOL span. Export is additive and best-effort — failures are bounded by a timeout and never change the run outcome or suppress the JSONL writes.

```json
{
  "observability": {
    "exporters": [
      { "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces" }
    ]
  }
}
```

Omitting the `observability.exporters` entry keeps only the local JSONL artifacts. The whole array can be supplied via `MONO_AGENT_OBSERVABILITY_EXPORTERS` (a JSON array). Already-recorded runs can be exported retroactively with `mono-agent backfill (--run <id> | --all)`, reusing the live OTLP mapping with historical timestamps; deterministic per-run ids make re-export overwrite rather than duplicate.

:::caution
Phoenix export is best-effort and metadata-only by default. Set `includeSensitiveData: true` on the exporter only if you intend span input/output values to carry prompt and tool payloads. With sensitive export enabled, non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free text is not content-scanned by default. The separate `contentPatternRedaction: true` opt-in replaces a closed set of high-confidence credential shapes in retained outbound text. Strings are capped, and the scan does not make an untrusted collector safe.
:::

See [Phoenix export & backfill](/observability/phoenix-and-backfill/) for the full exporter options, `validate` compatibility check, and backfill flags.

## The CLI

`mono-agent` drives the entire agent lifecycle from one config: `init` scaffolds non-destructively, `validate` prints a per-section report (including observability and every channel), `start` launches traceability plus every configured channel (a background launchd service on macOS by default), and `stop` / `logs` / `restart` operate the running instance. `backfill` exports historical runs to Phoenix, while `runs audit` scans local run summaries read-only and `runs report` ([artifact metrics](/observability/artifacts-and-traces/#artifact-metrics)) aggregates local latency, cost, and failure rates.

The full command and flag matrix is in the [CLI reference](/observability/cli-reference/).

## The terminal operator

`mono-agent-tui` connects directly to an authenticated loopback endpoint or discovers one through owner-private registry descriptors. Direct mode reads the bearer from `MONO_AGENT_OPERATOR_TOKEN` unless `--token-env` selects another environment variable.

```bash
mono-agent-tui --endpoint http://127.0.0.1:52341
mono-agent-tui --agent personal-agent
```

It has no embedded/local responder, replay/config pane, or self-configuration path. See the [terminal operator page](/observability/tui/) for its exact flags and current capability-gated controls.

## The web operator

`mono-agent-web` runs the independently configured authenticated browser product. It discovers registered agents and keeps text conversations and in-flight work in an owner-private service store, so a browser response disconnect or reload does not cancel a turn.

```bash
MONO_AGENT_WEB_AUTH_TOKEN="replace-with-a-long-random-token" \
  mono-agent-web ./web.config.json
```

The default bind is `127.0.0.1:5050` and every browser API request requires bearer auth. Non-loopback plaintext additionally requires a stronger token and explicit `allowInsecureHttp: true`; prefer loopback behind HTTPS. See the [web operator guide](/observability/web-console/) for product config, Host/origin defenses, durable state, and the deliberately limited first-slice feature set.

## Related

- [Configuration blueprint](/config/blueprint/) — every key in context, including `artifacts`, `traceability`, and `observability`.
- [Environment variables](/config/env-vars/) — the `MONO_AGENT_*` overrides for the keys above.
- [Sessions & concurrency](/runtime/sessions-concurrency/) — what a "run" is and how sessions roll over.
