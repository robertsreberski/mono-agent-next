---
title: "Instructions, skills, and MCP"
description: "Keep agent instructions, reusable know-how, and model-callable project tools in their explicit v1 authorities."
sidebar:
  order: 0
---

V1 separates four concerns:

| Concern | Authority |
| --- | --- |
| Agent identity and base instructions | The path named by `agent.instructions`. |
| Reusable know-how and workflows | Files under `skills/`, selected through agent context. |
| Project-specific model-callable tools | Standard `.mcp.json` entries. |
| Tool behavior inseparable from a selected module | That module's bounded contribution, governed by Core. |

The old second persona file is not part of v1. Consolidate identity and soul
content into the single reviewed instructions source. A skill supplies
instructions for an existing CLI, MCP server, or workflow; it does not gain
hidden host authority.

MCP is the normal extension boundary for project and domain tools. See
[Project MCP](/tools/mcp/) for configuration and the
[capability ladder](/reference/capability-ladder/) before adding a typed module.
The contribution seam is not discovery or a reason to create a module; it keeps
an already selected module's own tool beside its data and lifecycle.

Core loads only the explicitly named MCP config and selected skill paths. It
does not search global registries or install dependencies while loading agent
config.
