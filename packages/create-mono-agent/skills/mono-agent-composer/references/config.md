# V1 configuration reference

Mono-agent v1 uses one strict JSON envelope:

- `configVersion`, `agent`, `runtimes`, `routing`, and `policy` are required.
- `session`, `context`, `channels`, `memory`, `state`, `triggers`, and
  `observability.exporters` are optional.
- Every selected runtime, channel, memory, state, trigger, exporter, or sandbox
  begins with a literal `$use` package name.
- Selected packages must be direct production dependencies and must match the
  root npm or pnpm lockfile.
- Unknown fields, package aliases, paths, Git/HTTP sources, undeclared
  environment interpolation, inline secrets, and invalid cross-slot references
  fail validation.
- A selected package may expose bounded module-owned tools after startup. Do
  not add a `plugins`, `tools`, or contribution config key; selection remains
  the existing `$use`, and ordinary project/domain tools remain `.mcp.json`
  entries.

The generated minimal shape is:

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "my-agent",
    "name": "My Agent",
    "instructions": "./AGENTS.md",
    "workspace": "."
  },
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": { "path": "./.secrets/pi/auth.json" }
    }
  },
  "routing": {
    "primary": {
      "runtime": "pi",
      "model": "openai-codex:gpt-5.6-sol"
    },
    "fallbacks": [],
    "effort": "high"
  },
  "session": { "mode": "continuous" },
  "channels": {
    "inbound": {
      "$use": "@mono-agent/channel-webhook",
      "listen": { "host": "127.0.0.1", "port": 3210 },
      "apiKey": { "$env": "WEBHOOK_API_KEY" }
    }
  },
  "policy": {
    "tools": { "default": "deny", "allow": [] },
    "approvals": { "default": "allow" },
    "sandbox": { "mode": "off" }
  }
}
```

Use `minimal` for the smallest Pi plus loopback-webhook closure, `personal` for
the sanitized durable Personal Agent-shaped closure, and `multi-runtime` for an
explicit Pi/Claude fallback example. Start from a template rather than copying
optional modules into the minimal closure.

Secrets belong in owner-private provider stores or explicitly named environment
variables. Never place credential values in config, `.env.example`, skill
files, or chat output.
