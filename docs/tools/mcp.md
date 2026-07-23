---
title: "Project MCP"
description: "Configure standard project-owned MCP servers without adding a mono-agent package or Core contract."
sidebar:
  order: 1
---

Model-callable project tools belong in `.mcp.json`, referenced from the agent's
context. An MCP server does not become a typed runtime, channel, memory, state,
trigger, exporter, or sandbox module.

```json
{
  "mcpServers": {
    "project-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/server.mjs"],
      "env": {
        "PROJECT_TOKEN": { "$env": "PROJECT_TOKEN" }
      }
    },
    "local-http": {
      "type": "http",
      "url": "http://127.0.0.1:4319/mcp",
      "headers": {
        "Authorization": { "$env": "LOCAL_MCP_AUTHORIZATION" }
      }
    }
  }
}
```

Secret-bearing environment values and headers use explicit environment
references. Remote servers own their process lifecycle. A configured stdio
server may be started and stopped by the MCP harness, but Core does not turn
MCP into a generic daemon manager.

The Personal scaffold contains a sanitized `.mcp.json` and agent config
reference. The packed system proof loads that standard file without a Core or
first-party catalog edit.

For documentation lookup itself, register the separate
[documentation MCP companion](/tools/documentation-mcp/) in the coding client,
not in the running agent.
