---
title: "Observability and operator products"
description: "Select OTLP export inside the agent and run terminal or web operator products through their independent lifecycle."
sidebar:
  order: 0
---

Agent telemetry export is an explicitly selected module:

```json
{
  "observability": {
    "exporters": {
      "phoenix": {
        "$use": "@mono-agent/exporter-otlp",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "personal-agent",
        "includeSensitiveData": false
      }
    }
  }
}
```

`@mono-agent/exporter-otlp` owns bounded batching, redaction, endpoint policy,
flush, shutdown, and visible degradation. Core owns neither exporter transport
nor a historical-backfill command.

The TUI and web are products, not exporters or agent modules:

- [Terminal operator](/observability/tui/) connects through the shared operator
  client and owns terminal presentation only.
- [Standalone web operator](/observability/web-console/) owns its own config,
  listener, browser auth policy, process, and durable conversation store.

Neither product starts because it appears in agent config. The agent must
separately select `@mono-agent/channel-operator`, and products connect to that
authenticated endpoint directly or through owner-private discovery.
