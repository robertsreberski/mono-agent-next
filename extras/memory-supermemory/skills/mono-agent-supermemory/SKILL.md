---
name: mono-agent-supermemory
description: Configure an existing mono-agent to use the optional Supermemory memory plugin, with explicit service, privacy, credential, validation, and rollback checks.
---

# Configure Supermemory Memory

Use this skill only in an existing mono-agent folder whose operator explicitly
asked to install, enable, inspect, or remove the Supermemory plugin. Supermemory
is optional: never switch an agent from Lite, Journal, or BuJo implicitly.

## Rules

- Inspect `mono-agent.config.json`, `mono-agent config`, and `mono-agent validate`
  for current state. Recalled memory is not evidence of current configuration.
- Ask whether data should stay on a local `supermemory-server` or be sent to the
  hosted service. State that turns and recalled content leave mono-agent for the
  selected service.
- Keep credentials out of chat, config, skill files, and traces. A hosted key is
  collected by the host's masked secret flow as
  `MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY`; a keyless local service needs no key.
- Install the exact `@mono-agent/memory-supermemory` version matching
  `@mono-agent/agent-app`. Do not use `latest` when versions differ.
- Propose the smallest config change and preserve the previous memory root. Do
  not migrate or delete local memory automatically.
- Apply through the authenticated local configuration flow when available.
  Otherwise show the patch and commands without claiming they ran.

## Config

```json
{
  "memory": {
    "backend": "supermemory",
    "mode": "lite",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "supermemory": {
      "baseUrl": "http://127.0.0.1:6767"
    }
  }
}
```

The app derives the default container from the agent trace source. Set a
container only when the operator deliberately wants another namespace.
MemoryRecall is enabled by default for configured memory; an explicit false is
the opt-out.

## Verify

1. Confirm the exact plugin package resolves.
2. Run `mono-agent validate` and fix every memory error.
3. After the host reloads in a fresh turn, call MemoryRecall once. An empty
   result is a valid registration smoke for an empty container.
4. Report the config change ID and rollback command. Never use a same-turn tool
   call as proof of the newly applied backend because the active responder still
   owns the prior store until reload.
