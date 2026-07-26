---
title: "Configuration"
description: "Understand the strict agent envelope, selected typed modules, environment references, and separate product scopes."
sidebar:
  order: 0
---

One `mono-agent.config.json` answers what one agent uses. It does not own TUI,
web, macOS service, documentation-client, or package-installation lifecycle.

Every replaceable capability is selected where it is used:

```json
{
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": { "path": "./.secrets/pi/auth.json" }
    }
  },
  "routing": {
    "primary": { "runtime": "pi", "model": "openai-codex:gpt-5.6-sol" },
    "fallbacks": [],
    "effort": "high"
  },
  "policy": {
    "tools": { "default": "deny", "allow": [] },
    "approvals": { "default": "ask" },
    "sandbox": { "mode": "off" }
  }
}
```

The map key is the stable instance id. `$use` is the exact implementation
package. Singleton memory, state, and sandbox slots use the slot itself as
identity.

Core requires each selection to be a direct production dependency with root
lockfile evidence, verifies the package's capability kind and API version, and
composes only the selected leaf schemas. Unknown fields, missing or cyclic
references, wrong-kind packages, and incompatible versions fail validation.

Secret fields accept only explicit `{"$env":"NAME"}` references. Mono-agent
does not load `.env` implicitly, and diagnostics report the variable name while
redacting its value.

Use the [generated config reference](/config/reference/) for the exact envelope,
current scaffold closure, selected environment names, and sanitized seed
configs. Generate the installed project's composed schema with:

```bash
node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js config schema --config ./mono-agent.config.json --write
node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js config explain --config ./mono-agent.config.json routing.primary
```
