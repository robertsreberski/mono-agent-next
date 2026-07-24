---
title: "Programmatic API"
description: "Load, validate, inspect, start, and operate v1 through public package APIs without a human CLI subprocess."
sidebar:
  order: 0
---

The CLI is an optional frontend. Programmatic consumers use the same public
Core lifecycle:

<!-- doc-test:typescript -->
```ts
import { createAgentHost } from "@mono-agent/core";

const host = await createAgentHost("./mono-agent.config.json");
try {
  const result = await host.submit({
    requestId: "example-1",
    conversationId: "example",
    text: "Hello",
  });
  console.log(result.text);
} finally {
  await host.stop();
}
```

Use the exact signatures in the
[generated public API inventory](/reference/public-api/) and the linked package
READMEs; the example above illustrates ownership rather than replacing the
types.

Typed modules are created through the factories and compliance contracts in
`@mono-agent/module-sdk`. Operator renderers consume `@mono-agent/operator`.
Host integration such as launchd consumes the runner contract as a separate
product. Ordinary model-callable project tools remain MCP servers and do not
require a Core contract. An already selected module may expose bounded
`ModuleToolContribution` descriptors only for behavior inseparable from its own
data and lifecycle; Core still owns final naming, policy, execution, and
turn-level disposal.

This does not change the host's durable state API. `AgentHost.listRuns()` and
`AgentHost.readRun()` remain available whether or not the selected state module
also contributes a model-visible `RunHistory` tool.
