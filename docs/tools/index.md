---
title: "Tools, MCP, and sandbox"
description: "Use MCP for project tools, explicit policy for authority, and a selected sandbox for command execution."
sidebar:
  order: 0
---

Use the [capability ladder](/reference/capability-ladder/) before adding
runtime-visible behavior:

- [Project MCP](/tools/mcp/) is the normal boundary for model-callable project
  and domain tools.
- An already selected module may offer a bounded tool only when the behavior is
  inseparable from its own data and lifecycle; Core still governs it.
- Skills supply instructions for an existing MCP server, CLI, or workflow.
- `policy.tools` and `policy.approvals` narrow runtime-owned tool authority.
- [Sandbox](/tools/sandbox/) is either explicitly off or one selected
  implementation.
- [Documentation MCP](/tools/documentation-mcp/) is a coding-client companion,
  not a tool selected by the running agent.

Core is not a generic plugin registry or process supervisor. V1 has no
continuation host grants, hidden child-run host capabilities, or module-tool
configuration key.
