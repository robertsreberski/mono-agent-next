---
title: "Products and companion lifecycle"
description: "Generated lifecycle and configuration boundaries for the mono-agent CLI, scaffolder, operator renderers, macOS service integration, and documentation companion."
sidebar:
  order: 0
---

These products are installed and operated independently. None is activated by
package presence, and none belongs in an agent's selected-module graph unless
the row explicitly names the agent config.

| Package | Lifecycle | Configuration authority | Normal entrypoint |
| --- | --- | --- | --- |
| `@mono-agent/cli` | Foreground agent frontend | mono-agent.config.json | `mono-agent start --config <file>` |
| `create-mono-agent` | Pre-runtime project scaffolder | Template arguments; writes a new project | `create-mono-agent <directory>` |
| `@mono-agent/service-macos` | Optional macOS boot integration | Separate service-macos.json | `inspect / plan / explicit apply or remove` |
| `@mono-agent/tui` | Standalone terminal renderer | Endpoint or owner-private discovery entry | `mono-agent-tui` |
| `@mono-agent/web` | Standalone browser product | Separate web.config.json | `mono-agent-web` |
| `@mono-agent/docs-mcp` | Coding-client companion MCP | Client mcpServers registration | `mono-agent-docs-mcp over stdio` |

## Boundary rules

- Core remains foreground-runnable without service-macos, TUI, web, or docs-mcp.
- TUI and web consume the shared operator protocol; they do not load runtimes
  or own the agent process.
- Service-macos reads only its separate desired-state file. Inspect and plan
  are read-only. Apply and remove require an exact fingerprint plus explicit
  mutation authorization; drift fails before mutation, and bounded failures
  restore the prior plist and loaded state when that state can be proven.
- Removing service-macos disables the LaunchAgent and removes its managed plist;
  it does not rewrite agent config, remove data, or delete logs.
- Docs-mcp is registered in a coding client's `mcpServers` map and has no
  runtime dependency on Core.
- The scaffolder writes exact selected dependencies before the agent exists. It
  never authenticates a provider or initializes memory's permanent first-run
  marker.

## Source-beta phase

The source-beta proof builds, packs, clean-installs, imports, validates, and
executes bounded fixtures. It does not publish packages, change a live service,
migrate user data, deploy a consumer, run a soak, or retire the predecessor.
