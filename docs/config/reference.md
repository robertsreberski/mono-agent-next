---
title: "Generated config reference"
description: "Exact v1 agent envelope, selected-module rules, scaffold dependency closures, environment references, and generated seed configurations."
sidebar:
  order: 2
---

Mono-agent v1 intentionally has no global mega-schema. Core owns one strict
agent envelope; each literal `$use` selection contributes its own schema.
Generate the exact installed project schema with:

```bash
mono-agent config schema --config ./mono-agent.config.json --write
```

That command first proves every selection is a matching direct production
dependency in the root lockfile. It then composes only the selected module
schemas. Package presence alone never activates a capability.

## Fixed envelope

Required top-level fields are `configVersion`, `agent`, `runtimes`,
`routing`, and `policy`. Optional fields are `session`, `context`,
`channels`, `memory`, `state`, `triggers`, and
`observability.exporters`.

Runtime, channel, trigger, and exporter slots are instance maps. Memory and
state are singletons. `policy.sandbox` is either `{"mode":"off"}` or one
selected sandbox object. Every selected object begins with an exact package
name in `$use`.

## Generated scaffold matrix

| Template | Exact direct dependencies | Selected modules | Referenced environment names |
| --- | --- | --- | --- |
| `minimal` | `@mono-agent/channel-webhook`, `@mono-agent/cli`, `@mono-agent/core`, `@mono-agent/module-sdk`, `@mono-agent/runtime-pi` | `@mono-agent/channel-webhook`, `@mono-agent/runtime-pi` | `WEBHOOK_API_KEY` |
| `personal` | `@mono-agent/channel-openai-api`, `@mono-agent/channel-operator`, `@mono-agent/channel-telegram`, `@mono-agent/channel-webhook`, `@mono-agent/cli`, `@mono-agent/core`, `@mono-agent/exporter-otlp`, `@mono-agent/memory-local`, `@mono-agent/module-sdk`, `@mono-agent/runtime-pi`, `@mono-agent/state-local`, `@mono-agent/trigger-cron` | `@mono-agent/channel-openai-api`, `@mono-agent/channel-operator`, `@mono-agent/channel-telegram`, `@mono-agent/channel-webhook`, `@mono-agent/exporter-otlp`, `@mono-agent/memory-local`, `@mono-agent/runtime-pi`, `@mono-agent/state-local`, `@mono-agent/trigger-cron` | `MONO_AGENT_OPENAI_API_KEY`, `MONO_AGENT_OPERATOR_TOKEN`, `MONO_AGENT_TELEGRAM_BOT_TOKEN`, `MONO_AGENT_WEBHOOK_API_KEY`, `PERSONAL_AGENT_TELEGRAM_CHAT_ID` |
| `multi-runtime` | `@mono-agent/channel-webhook`, `@mono-agent/cli`, `@mono-agent/core`, `@mono-agent/module-sdk`, `@mono-agent/runtime-claude`, `@mono-agent/runtime-pi` | `@mono-agent/channel-webhook`, `@mono-agent/runtime-claude`, `@mono-agent/runtime-pi` | `CLAUDE_CODE_OAUTH_TOKEN`, `WEBHOOK_API_KEY` |

The three core packages are direct dependencies but are not selected modules:
`@mono-agent/module-sdk`, `@mono-agent/core`, and `@mono-agent/cli`.
Separate products such as TUI, web, service-macos, and docs-mcp never enter an
agent template because their lifecycle is independent.

## Seed config path inventory

This table is generated from the three current scaffolder outputs. Module
options not selected by a template remain discoverable through that module's
README and the exact composed schema.

| JSON path | Generated templates |
| --- | --- |
| `$schema` | `minimal`, `personal`, `multi-runtime` |
| `agent.id` | `minimal`, `personal`, `multi-runtime` |
| `agent.instructions` | `minimal`, `personal`, `multi-runtime` |
| `agent.name` | `minimal`, `personal`, `multi-runtime` |
| `agent.workspace` | `minimal`, `personal`, `multi-runtime` |
| `channels.inbound.$use` | `minimal`, `multi-runtime` |
| `channels.inbound.apiKey.$env` | `minimal`, `multi-runtime` |
| `channels.inbound.listen.host` | `minimal`, `multi-runtime` |
| `channels.inbound.listen.port` | `minimal`, `multi-runtime` |
| `channels.openai-api.$use` | `personal` |
| `channels.openai-api.apiKey.$env` | `personal` |
| `channels.openai-api.basePath` | `personal` |
| `channels.openai-api.listen.host` | `personal` |
| `channels.openai-api.listen.port` | `personal` |
| `channels.openai-api.modelId` | `personal` |
| `channels.operator.$use` | `personal` |
| `channels.operator.auth.token.$env` | `personal` |
| `channels.operator.listen.host` | `personal` |
| `channels.operator.listen.port` | `personal` |
| `channels.telegram.$use` | `personal` |
| `channels.telegram.allowAllChats` | `personal` |
| `channels.telegram.allowedChatIds[]` | `personal` |
| `channels.telegram.allowedChatIds[].$env` | `personal` |
| `channels.telegram.botToken.$env` | `personal` |
| `channels.telegram.defaultDestination.$env` | `personal` |
| `channels.telegram.reactions.done` | `personal` |
| `channels.telegram.reactions.error` | `personal` |
| `channels.telegram.reactions.working` | `personal` |
| `channels.webhook.$use` | `personal` |
| `channels.webhook.apiKey.$env` | `personal` |
| `channels.webhook.listen.host` | `personal` |
| `channels.webhook.listen.port` | `personal` |
| `channels.webhook.maxStoredRequests` | `personal` |
| `channels.webhook.mode` | `personal` |
| `channels.webhook.path` | `personal` |
| `channels.webhook.retentionMs` | `personal` |
| `configVersion` | `minimal`, `personal`, `multi-runtime` |
| `context.mcp.configPath` | `personal` |
| `context.skills.disclosure` | `personal` |
| `context.skills.load` | `personal` |
| `context.skills.maxBytes` | `personal` |
| `context.skills.roots[]` | `personal` |
| `memory.$use` | `personal` |
| `memory.capture.mode` | `personal` |
| `memory.directory` | `personal` |
| `observability.exporters.phoenix.$use` | `personal` |
| `observability.exporters.phoenix.endpoint` | `personal` |
| `observability.exporters.phoenix.includeSensitiveData` | `personal` |
| `observability.exporters.phoenix.projectName` | `personal` |
| `policy.approvals.default` | `minimal`, `personal`, `multi-runtime` |
| `policy.sandbox.mode` | `minimal`, `personal`, `multi-runtime` |
| `policy.tools.allow[]` | `minimal`, `multi-runtime` |
| `policy.tools.default` | `minimal`, `personal`, `multi-runtime` |
| `policy.tools.deny[]` | `personal` |
| `routing.effort` | `minimal`, `personal`, `multi-runtime` |
| `routing.fallbacks[]` | `minimal`, `personal`, `multi-runtime` |
| `routing.fallbacks[].model` | `personal`, `multi-runtime` |
| `routing.fallbacks[].runtime` | `personal`, `multi-runtime` |
| `routing.primary.model` | `minimal`, `personal`, `multi-runtime` |
| `routing.primary.runtime` | `minimal`, `personal`, `multi-runtime` |
| `runtimes.claude-sdk.$use` | `multi-runtime` |
| `runtimes.claude-sdk.auth.method` | `multi-runtime` |
| `runtimes.claude-sdk.auth.token.$env` | `multi-runtime` |
| `runtimes.claude-sdk.mode` | `multi-runtime` |
| `runtimes.pi.$use` | `minimal`, `personal`, `multi-runtime` |
| `runtimes.pi.auth.path` | `minimal`, `personal`, `multi-runtime` |
| `runtimes.pi.localProviders[]` | `personal` |
| `runtimes.pi.localProviders[].baseUrl` | `personal` |
| `runtimes.pi.localProviders[].id` | `personal` |
| `runtimes.pi.retry.maxDelayMs` | `personal` |
| `runtimes.pi.sessions.root` | `personal` |
| `session.idleTimeoutMs` | `personal` |
| `session.isolateProactiveRuns` | `personal` |
| `session.mode` | `minimal`, `personal`, `multi-runtime` |
| `session.rollover` | `personal` |
| `session.timezone` | `personal` |
| `state.$use` | `personal` |
| `state.discovery.registryDirectory` | `personal` |
| `state.discovery.sourceId` | `personal` |
| `state.discovery.sourceLabel` | `personal` |
| `state.root` | `personal` |
| `triggers.cron.$use` | `personal` |
| `triggers.cron.jobsDirectory` | `personal` |
| `triggers.cron.timezone` | `personal` |

## Generated seed configurations

### `minimal`

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "minimal-source-beta",
    "name": "Minimal Source Beta",
    "instructions": "./AGENTS.md",
    "workspace": "."
  },
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": {
        "path": "./.secrets/pi/auth.json"
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
  "channels": {
    "inbound": {
      "$use": "@mono-agent/channel-webhook",
      "listen": {
        "host": "127.0.0.1",
        "port": 3210
      },
      "apiKey": {
        "$env": "WEBHOOK_API_KEY"
      }
    }
  },
  "policy": {
    "tools": {
      "default": "deny",
      "allow": []
    },
    "approvals": {
      "default": "allow"
    },
    "sandbox": {
      "mode": "off"
    }
  }
}
```

### `personal`

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "personal-source-beta",
    "name": "Personal Source Beta",
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
      },
      "retry": {
        "maxDelayMs": 30000
      },
      "localProviders": [
        {
          "id": "ollama",
          "baseUrl": "http://127.0.0.1:11434"
        }
      ]
    }
  },
  "routing": {
    "primary": {
      "runtime": "pi",
      "model": "openai-codex:gpt-5.6-sol"
    },
    "fallbacks": [
      {
        "runtime": "pi",
        "model": "github-copilot:gemini-3.1-pro-preview"
      },
      {
        "runtime": "pi",
        "model": "github-copilot:gemini-3.5-flash"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:kimi-k2.7-code"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:glm-5.2"
      },
      {
        "runtime": "pi",
        "model": "anthropic:claude-opus-4-8"
      },
      {
        "runtime": "pi",
        "model": "anthropic:claude-fable-5"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:kimi-k2.6"
      },
      {
        "runtime": "pi",
        "model": "opencode-go:glm-5.1"
      },
      {
        "runtime": "pi",
        "model": "openai-codex:gpt-5.6-terra"
      }
    ],
    "effort": "high"
  },
  "session": {
    "mode": "continuous",
    "idleTimeoutMs": 1800000,
    "rollover": "daily",
    "timezone": "Europe/Rome",
    "isolateProactiveRuns": true
  },
  "context": {
    "skills": {
      "roots": [
        "./skills"
      ],
      "load": "all",
      "disclosure": "index",
      "maxBytes": 96000
    },
    "mcp": {
      "configPath": "./.mcp.json"
    }
  },
  "memory": {
    "$use": "@mono-agent/memory-local",
    "directory": "./.mono-agent/memory",
    "capture": {
      "mode": "direct"
    }
  },
  "state": {
    "$use": "@mono-agent/state-local",
    "root": "./.mono-agent/state",
    "discovery": {
      "registryDirectory": "./.mono-agent/trace-sources",
      "sourceId": "personal-source-beta",
      "sourceLabel": "Personal Source Beta"
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
      },
      "reactions": {
        "working": true,
        "done": false,
        "error": true
      }
    },
    "webhook": {
      "$use": "@mono-agent/channel-webhook",
      "listen": {
        "host": "127.0.0.1",
        "port": 4313
      },
      "apiKey": {
        "$env": "MONO_AGENT_WEBHOOK_API_KEY"
      },
      "path": "/webhook/invoke",
      "mode": "async",
      "retentionMs": 300000,
      "maxStoredRequests": 100
    },
    "openai-api": {
      "$use": "@mono-agent/channel-openai-api",
      "listen": {
        "host": "127.0.0.1",
        "port": 4312
      },
      "basePath": "/v1",
      "apiKey": {
        "$env": "MONO_AGENT_OPENAI_API_KEY"
      },
      "modelId": "personal-source-beta"
    },
    "operator": {
      "$use": "@mono-agent/channel-operator",
      "listen": {
        "host": "127.0.0.1",
        "port": 0
      },
      "auth": {
        "token": {
          "$env": "MONO_AGENT_OPERATOR_TOKEN"
        }
      }
    }
  },
  "triggers": {
    "cron": {
      "$use": "@mono-agent/trigger-cron",
      "jobsDirectory": "./cron",
      "timezone": "Europe/Rome"
    }
  },
  "observability": {
    "exporters": {
      "phoenix": {
        "$use": "@mono-agent/exporter-otlp",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "projectName": "personal-source-beta",
        "includeSensitiveData": false
      }
    }
  }
}
```

### `multi-runtime`

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "multi-runtime-source-beta",
    "name": "Multi Runtime Source Beta",
    "instructions": "./AGENTS.md",
    "workspace": "."
  },
  "runtimes": {
    "pi": {
      "$use": "@mono-agent/runtime-pi",
      "auth": {
        "path": "./.secrets/pi/auth.json"
      }
    },
    "claude-sdk": {
      "$use": "@mono-agent/runtime-claude",
      "mode": "sdk",
      "auth": {
        "method": "oauth-token",
        "token": {
          "$env": "CLAUDE_CODE_OAUTH_TOKEN"
        }
      }
    }
  },
  "routing": {
    "primary": {
      "runtime": "pi",
      "model": "openai-codex:gpt-5.6-sol"
    },
    "fallbacks": [
      {
        "runtime": "claude-sdk",
        "model": "claude-opus-4-8"
      },
      {
        "runtime": "pi",
        "model": "anthropic:claude-opus-4-8"
      }
    ],
    "effort": "high"
  },
  "session": {
    "mode": "continuous"
  },
  "channels": {
    "inbound": {
      "$use": "@mono-agent/channel-webhook",
      "listen": {
        "host": "127.0.0.1",
        "port": 3210
      },
      "apiKey": {
        "$env": "WEBHOOK_API_KEY"
      }
    }
  },
  "policy": {
    "tools": {
      "default": "deny",
      "allow": []
    },
    "approvals": {
      "default": "allow"
    },
    "sandbox": {
      "mode": "off"
    }
  }
}
```

## Environment and secret rules

Mono-agent does not implicitly load `.env` or `.env.example`. Only explicit
`{"$env":"NAME"}` references at schema-declared environment-eligible paths
are resolved. Secret-marked module fields reject inline values; missing or
empty values fail validation; explain and inspection output report the variable
name while redacting its value.

The scaffolder writes names-only `.env.example` files and never writes
credentials. Service-macos may read a separately protected environment file,
but it passes only the path to the runner and never expands secret values into a
LaunchAgent plist or plan.
