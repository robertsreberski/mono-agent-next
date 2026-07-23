---
title: "Personal Telegram Assistant with BuJo Memory"
description: "Build a private v1 Telegram assistant with owner-private BuJo memory, optional Ollama vectors, and retained local run state."
sidebar:
  order: 1
---

This playbook selects the v1 Telegram channel, Pi runtime,
`memory-local`, and `state-local`. It captures completed turns through a
dedicated runtime/model route, recalls them with FTS plus optional Ollama
vectors, and retains terminal run evidence for 30 days.

## Who this is for

An individual running one owner-private Telegram assistant with an exact chat
allowlist and local durable state.

## Features used

- [`memory.local-bujo`](/memory/) — the only first-party v1 memory implementation.
- [`memory.per-turn-capture`](/memory/capture-and-recall/) — runtime-backed schema-constrained capture.
- [`memory.embeddings-config`](/memory/capture-and-recall/#fts-and-optional-vector-recall) — optional Ollama vectors with FTS fallback.
- [`memory.recall-tool`](/memory/capture-and-recall/#model-visible-recall) — request-scoped read-only recall.
- [`memory.bujo-consolidation`](/memory/capture-and-recall/#projection-only-consolidation) — explicit deterministic projection refresh with no provider call.
- [`state.local-runs`](/reference/feature-registry/#durable-state-mono-agentstate-local) — transcript, run, idempotency, and artifact retention.

## Configuration

Keep both Telegram values outside JSON and refer to their environment names
explicitly:

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=
PERSONAL_AGENT_TELEGRAM_CHAT_ID=
```

The corresponding v1 config is:

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "personal-assistant",
    "name": "Personal Assistant",
    "instructions": "./AGENTS.md",
    "workspace": "."
  },
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": {
        "path": "./.secrets/pi/auth.json"
      },
      "sessions": {
        "root": "./.mono-agent/sessions"
      }
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
  "session": {
    "mode": "continuous"
  },
  "memory": {
    "$use": "@mono-agent/memory-local",
    "root": "./.mono-agent/memory",
    "maxBytes": 96000,
    "capture": {
      "enabled": true,
      "model": {
        "runtime": "pi",
        "model": "openai-codex:gpt-5.4-mini"
      },
      "timeoutMs": 360000
    },
    "embeddings": {
      "provider": "ollama",
      "endpoint": "http://127.0.0.1:11434",
      "model": "nomic-embed-text:v1.5",
      "dimensions": 768
    },
    "recallTool": {
      "enabled": true
    }
  },
  "state": {
    "$use": "@mono-agent/state-local",
    "root": "./.mono-agent/state",
    "runs": {
      "artifactsDirectory": "./.mono-agent/artifacts",
      "retentionDays": 30
    }
  },
  "policy": {
    "tools": {
      "default": "allow",
      "deny": []
    },
    "approvals": {
      "default": "allow"
    },
    "sandbox": {
      "mode": "off"
    }
  },
  "channels": {
    "telegram": {
      "$use": "@mono-agent/channel-telegram",
      "botToken": {
        "$env": "MONO_AGENT_TELEGRAM_BOT_TOKEN"
      },
      "allowedChatIds": [
        {
          "$env": "PERSONAL_AGENT_TELEGRAM_CHAT_ID"
        }
      ],
      "allowAllChats": false,
      "defaultDestination": {
        "$env": "PERSONAL_AGENT_TELEGRAM_CHAT_ID"
      }
    }
  }
}
```

The capture route is deliberately separate from the primary route. On Pi,
schema-constrained capture removes the runtime-owned native tools and their
approval requirement for that internal turn. The main Telegram turn keeps the
ordinary configured tool and approval policy.

Omit the entire `embeddings` block for FTS-only recall. To keep an existing
store read-only, set `capture.enabled` to `false` and omit `capture.model`.

## Steps

1. Render the tested Personal template:

   ```bash
   create-mono-agent ./personal-assistant --template personal
   ```

2. Install its exact dependencies, provide Pi authentication in the configured
   owner-private auth file, and set the two environment values above.
3. Pull the exact vector model:

   ```bash
   ollama pull nomic-embed-text:v1.5
   ```

4. Generate the installed-selection schema and validate without starting the
   agent:

   ```bash
   mono-agent config schema --config ./mono-agent.config.json --write
   mono-agent validate --config ./mono-agent.config.json
   ```

5. If `memory.root` contains v0 BuJo data, stop here and complete the copied-data
   rehearsal below. Do not test the beta against the only live copy.
6. Start in the foreground:

   ```bash
   mono-agent start --config ./mono-agent.config.json
   ```

7. From the exact allowed Telegram chat, state a durable fact. After capture
   settles, ask a paraphrased question in a later turn and confirm the answer
   uses local recall.

## Maintenance and migration gate

Before adopting an existing BuJo root:

1. stop every writer;
2. run strict audit and create a verified backup;
3. rehearse against a separate copy;
4. compare representative FTS and vector recall;
5. prove capture, exact duplicate admission, forget preview, intake retry, and
   rebuild;
6. run `memory-local:consolidate` twice and compare byte-identical projections
   plus duplicate-group counts;
7. prove both frozen-v0 and v1 readers;
8. run a final strict audit; and
9. retain the backup through the rollback window.

Use `MemoryLocal.audit`, `backup`, `previewForget`, `retryIntake`, and `rebuild`
through the explicit `openMemoryLocal` maintenance boundary, and use
`MemoryLocal.consolidate` for provider-free index/future-log projection.
Configured agents expose the same bounded operations as namespaced
`memory-local:*` commands. Rebuild requires `confirm: true`; forget previews by
default and requires both `dryRun: false` and `confirm: true` to mutate.
Identity, permission, integrity, incomplete projection, format, or
unresolved-intake failures block cutover; `memory-local` will not path-chmod or
silently repair the source.

Run `state-local` maintenance separately with a dry run first. Its
`runs.retentionDays` applies only to eligible terminal state and artifacts; it
does not authorize deleting running or delivery-intent state.

Release, live cutover, soak, and predecessor retirement are separate from this
source-level recipe.

## Smoke test

Send one message from the allowed chat and confirm one final reply. Send a
message from a different chat and confirm rejection. Then recall a previously
captured fact and inspect the retained run through the configured local state,
without opening raw paths to the model.

## Related

- [Memory](/memory/)
- [Capture and recall](/memory/capture-and-recall/)
- [Feature registry](/reference/feature-registry/)
- [Your first agent](/getting-started/quickstart/)
