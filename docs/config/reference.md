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
node ./node_modules/@mono-agent/cli/dist/bin/mono-agent.js config schema --config ./mono-agent.config.json --write
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

## Executable schema inventory

This inventory is regenerated from the executable Core composition and the
executable schema exported by every publishable package whose manifest declares
a `mono-agent` module kind. The generator rebuilds those packages before
importing them, so a clean checkout does not rely on stale `dist/` output.
Adding, removing, or changing a typed module field makes
`pnpm run check:source-beta-docs` fail until this page is regenerated.

Required means required by the containing object. `conditional` means a field
is required only in a schema branch, `item` identifies an array item, and
`selected` identifies a module object after its `$use` selection is present.
Environment eligibility and secret handling come from the executable
`x-mono-agent-*` annotations, not field-name heuristics.

### Core composed envelope

The Core table is composed through the public `loadAgentConfig` and
`composeAgentConfigSchema` APIs using a hermetic reference config that selects
all shipped typed modules. Selected module subtrees are collapsed to canonical
slot placeholders and expanded in their owning package tables below. Route
runtime enums show the reference composition's deterministic instance ids
(`claude`, `codex`, `opencode`, and `pi`); an installed project's
composed schema instead locks those enums to that project's configured runtime
instance ids.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `$` | `object` | yes | — | `closed object` | no | no | — |
| `$schema` | `string` | no | — | `minLength 1` | no | no | — |
| `agent` | `object` | yes | — | `closed object` | no | no | — |
| `agent.id` | `string` | yes | — | `pattern "^[a-z0-9][a-z0-9._-]*$"` | no | no | — |
| `agent.instructions` | `string` | yes | — | `minLength 1` | no | no | — |
| `agent.name` | `string` | yes | — | `minLength 1` | no | no | — |
| `agent.workspace` | `string` | yes | — | `minLength 1` | no | no | — |
| `channels` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `configVersion` | `integer` | yes | — | `const 1` | no | no | — |
| `context` | `object` | no | — | `closed object` | no | no | — |
| `context.mcp` | `object` | no | — | `closed object` | no | no | — |
| `context.mcp.configPath` | `string` | yes | — | `minLength 1` | no | no | — |
| `context.mcp.requestContextServers` | `array` | no | — | `maxItems 32; unique items` | no | no | — |
| `context.mcp.requestContextServers[]` | `string` | item | — | `minLength 1` | no | no | — |
| `context.skills` | `object` | no | — | `closed object` | no | no | — |
| `context.skills.disclosure` | `string` | no | `"index"` | `enum ["full","index"]` | no | no | — |
| `context.skills.load` | `string` | no | `"all"` | `const "all"` | no | no | — |
| `context.skills.maxBytes` | `integer` | no | `1000000` | `maximum 1000000; minimum 1` | no | no | — |
| `context.skills.roots` | `array` | yes | — | — | no | no | — |
| `context.skills.roots[]` | `string` | item | — | `minLength 1` | no | no | — |
| `memory` | `object` | selected | — | `closed object` | no | no | — |
| `observability` | `object` | no | — | `closed object` | no | no | — |
| `observability.exporters` | `object` | no | — | `closed object` | no | no | — |
| `observability.exporters.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `policy` | `object` | yes | — | `closed object` | no | no | — |
| `policy.approvals` | `object` | yes | — | `closed object` | no | no | — |
| `policy.approvals.default` | `string` | yes | — | `enum ["allow","ask","deny"]` | no | no | — |
| `policy.approvals.timeoutMs` | `integer` | no | `60000` | `maximum 3600000; minimum 1` | no | no | — |
| `policy.sandbox` | `object` | selected | — | `oneOf 2 branches` | no | no | — |
| `policy.tools` | `object` | yes | — | `closed object; oneOf 2 branches` | no | no | — |
| `policy.tools.allow` | `array` | no | — | `unique items` | no | no | — |
| `policy.tools.allow[]` | `string` | item | — | `minLength 1` | no | no | — |
| `policy.tools.default` | `string` | yes | — | `const "allow"; const "deny"` | no | no | — |
| `policy.tools.deny` | `array` | no | — | `unique items` | no | no | — |
| `policy.tools.deny[]` | `string` | item | — | `minLength 1` | no | no | — |
| `routing` | `object` | yes | — | `closed object` | no | no | — |
| `routing.effort` | `string` | no | — | `minLength 1` | no | no | — |
| `routing.effortKeywords` | `object` | no | — | `closed object` | no | no | — |
| `routing.effortKeywords.extraThink` | `boolean` | no | `true` | — | no | no | — |
| `routing.effortKeywords.think` | `boolean` | no | `false` | — | no | no | — |
| `routing.effortKeywords.ultraThink` | `boolean` | no | `true` | — | no | no | — |
| `routing.fallbacks` | `array` | yes | — | — | no | no | — |
| `routing.fallbacks[]` | `object` | item | — | `closed object` | no | no | — |
| `routing.fallbacks[].model` | `string` | yes | — | `minLength 1` | no | no | — |
| `routing.fallbacks[].runtime` | `string` | yes | — | `enum ["claude","codex","opencode","pi"]` | no | no | — |
| `routing.primary` | `object` | yes | — | `closed object` | no | no | — |
| `routing.primary.model` | `string` | yes | — | `minLength 1` | no | no | — |
| `routing.primary.runtime` | `string` | yes | — | `enum ["claude","codex","opencode","pi"]` | no | no | — |
| `runtimes` | `object` | yes | — | `closed object` | no | no | — |
| `runtimes.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `session` | `object` | no | `{"isolateProactiveRuns":false,"mode":"continuous","rollover":"none","timezone":"UTC"}` | `closed object` | no | no | — |
| `session.idleTimeoutMs` | `integer` | no | — | `minimum 1` | no | no | — |
| `session.isolateProactiveRuns` | `boolean` | no | `false` | — | no | no | — |
| `session.mode` | `string` | yes | `"continuous"` | `enum ["continuous","per-message"]` | no | no | — |
| `session.rollover` | `string` | no | `"none"` | `enum ["none","daily"]` | no | no | — |
| `session.timezone` | `string` | no | `"UTC"` | `minLength 1` | no | no | — |
| `state` | `object` | selected | — | `closed object` | no | no | — |
| `triggers` | `object` | no | — | `closed object` | no | no | — |
| `triggers.{id}` | `object` | selected | — | `closed object` | no | no | — |

### Shipped typed module schemas

This build contains 14 typed modules. Paths use
`{id}` for a user-chosen instance id. The `$use` row is the Core-owned
selection discriminator; all remaining rows come from the package's executable
module schema.

#### `@mono-agent/channel-openai-api`

Kind: `channel`. Canonical selected path: `channels.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `channels.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `channels.{id}.$use` | `string` | yes | — | `const "@mono-agent/channel-openai-api"` | no | no | — |
| `channels.{id}.allowNonLoopback` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.apiKey` | `string` | yes | — | `maxLength 4096; minLength 20` | yes | yes | — |
| `channels.{id}.basePath` | `string` | no | `"/v1"` | — | no | no | — |
| `channels.{id}.listen` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.listen.host` | `string` | no | `"127.0.0.1"` | — | no | no | — |
| `channels.{id}.listen.port` | `integer` | no | `0` | `maximum 65535; minimum 0` | no | no | — |
| `channels.{id}.maxBodyBytes` | `integer` | no | `1048576` | `maximum 8388608; minimum 1` | no | no | — |
| `channels.{id}.maxImageBytes` | `integer` | no | `5242880` | `maximum 20971520; minimum 1` | no | no | — |
| `channels.{id}.maxResponseBytes` | `integer` | no | `8388608` | `maximum 33554432; minimum 4096` | no | no | — |
| `channels.{id}.maxRunMs` | `integer` | no | `1200000` | `maximum 86400000; minimum 1` | no | no | — |
| `channels.{id}.modelId` | `string` | no | `"mono-agent"` | — | no | no | — |

#### `@mono-agent/channel-operator`

Kind: `channel`. Canonical selected path: `channels.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `channels.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `channels.{id}.$use` | `string` | yes | — | `const "@mono-agent/channel-operator"` | no | no | — |
| `channels.{id}.auth` | `object` | yes | — | `closed object` | no | no | — |
| `channels.{id}.auth.token` | `string` | yes | — | `maxLength 4096; minLength 32; pattern "^\\S+$"` | yes | yes | — |
| `channels.{id}.listen` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.listen.host` | `string` | no | `"127.0.0.1"` | — | no | no | — |
| `channels.{id}.listen.port` | `integer` | no | `0` | `maximum 65535; minimum 0` | no | no | — |

#### `@mono-agent/channel-slack`

Kind: `channel`. Canonical selected path: `channels.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `channels.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `channels.{id}.$use` | `string` | yes | — | `const "@mono-agent/channel-slack"` | no | no | — |
| `channels.{id}.allowAllChannels` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.allowedChannelIds` | `array` | no | — | `unique items` | no | no | — |
| `channels.{id}.allowedChannelIds[]` | `string` | item | — | `maxLength 128; minLength 1; pattern "^[^\\s:]+$"` | yes | no | — |
| `channels.{id}.allowedTeamIds` | `array` | yes | — | `unique items` | no | no | — |
| `channels.{id}.allowedTeamIds[]` | `string` | item | — | `maxLength 128; minLength 1; pattern "^[^\\s:]+$"` | yes | no | — |
| `channels.{id}.appToken` | `string` | yes | — | `maxLength 4096; minLength 20; pattern "^xapp-"` | yes | yes | — |
| `channels.{id}.botToken` | `string` | yes | — | `maxLength 4096; minLength 20; pattern "^xoxb-"` | yes | yes | — |
| `channels.{id}.defaultDestination` | `string` | no | — | `maxLength 257; minLength 1; pattern "^[^\\s:]+(?::[^\\s:]+)?$"` | yes | no | — |
| `channels.{id}.homeTab` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.homeTab.buttons` | `array` | no | `[]` | `maxItems 100` | no | no | — |
| `channels.{id}.homeTab.buttons[]` | `object` | item | — | `closed object` | no | no | — |
| `channels.{id}.homeTab.buttons[].ackText` | `string` | no | — | `maxLength 4000; minLength 1` | no | no | — |
| `channels.{id}.homeTab.buttons[].actionId` | `string` | yes | — | `maxLength 128; minLength 1` | no | no | — |
| `channels.{id}.homeTab.buttons[].channelId` | `string` | no | — | `maxLength 128; minLength 1; pattern "^[^\\s:]+$"` | yes | no | — |
| `channels.{id}.homeTab.buttons[].label` | `string` | yes | — | `maxLength 75; minLength 1` | no | no | — |
| `channels.{id}.homeTab.buttons[].prompt` | `string` | yes | — | `maxLength 16384; minLength 1` | no | no | — |
| `channels.{id}.homeTab.buttons[].threadReply` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.homeTab.enabled` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.homeTab.headerText` | `string` | no | — | `maxLength 3000; minLength 1` | no | no | — |
| `channels.{id}.maxAttachmentBytes` | `integer` | no | `10485760` | `maximum 20971520; minimum 1` | no | no | — |
| `channels.{id}.shortcuts` | `array` | no | `[]` | `maxItems 100` | no | no | — |
| `channels.{id}.shortcuts[]` | `object` | item | — | `closed object` | no | no | — |
| `channels.{id}.shortcuts[].ackText` | `string` | no | — | `maxLength 4000; minLength 1` | no | no | — |
| `channels.{id}.shortcuts[].callbackId` | `string` | yes | — | `maxLength 128; minLength 1` | no | no | — |
| `channels.{id}.shortcuts[].channelId` | `string` | no | — | `maxLength 128; minLength 1; pattern "^[^\\s:]+$"` | yes | no | — |
| `channels.{id}.shortcuts[].prompt` | `string` | yes | — | `maxLength 16384; minLength 1` | no | no | — |
| `channels.{id}.shortcuts[].threadReply` | `boolean` | no | `false` | — | no | no | — |

#### `@mono-agent/channel-telegram`

Kind: `channel`. Canonical selected path: `channels.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `channels.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `channels.{id}.$use` | `string` | yes | — | `const "@mono-agent/channel-telegram"` | no | no | — |
| `channels.{id}.allowAllChats` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.allowedChatIds` | `array` | no | — | `unique items` | no | no | — |
| `channels.{id}.allowedChatIds[]` | `string` | item | — | `maxLength 128; minLength 1; pattern "^[^:]+$"` | yes | no | — |
| `channels.{id}.botToken` | `string` | yes | — | `maxLength 4096; minLength 20` | yes | yes | — |
| `channels.{id}.defaultDestination` | `string` | no | — | `maxLength 128; minLength 1; pattern "^[^:]+$"` | yes | no | — |
| `channels.{id}.maxAttachmentBytes` | `integer` | no | `10485760` | `maximum 20971520; minimum 1` | no | no | — |
| `channels.{id}.pollSeconds` | `integer` | no | `20` | `maximum 50; minimum 1` | no | no | — |
| `channels.{id}.quietHours` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.quietHours.end` | `string` | yes | — | `pattern "^(?:[01][0-9]\|2[0-3]):[0-5][0-9]$"` | no | no | — |
| `channels.{id}.quietHours.start` | `string` | yes | — | `pattern "^(?:[01][0-9]\|2[0-3]):[0-5][0-9]$"` | no | no | — |
| `channels.{id}.quietHours.timezone` | `string` | yes | — | `maxLength 128; minLength 1` | no | no | — |
| `channels.{id}.reactions` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.reactions.done` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.reactions.error` | `boolean` | no | `true` | — | no | no | — |
| `channels.{id}.reactions.working` | `boolean` | no | `true` | — | no | no | — |
| `channels.{id}.transcription` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.transcription.endpoint` | `string` | yes | — | `maxLength 2048; minLength 1` | no | no | — |
| `channels.{id}.transcription.language` | `string` | no | — | `maxLength 64; minLength 1` | no | no | — |
| `channels.{id}.transcription.model` | `string` | yes | — | `maxLength 256; minLength 1` | no | no | — |
| `channels.{id}.transcription.timeoutMs` | `integer` | no | `120000` | `maximum 3600000; minimum 1` | no | no | — |
| `channels.{id}.transport` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.transport.ipFamily` | `integer` | no | — | `enum [4,6]` | no | no | — |

#### `@mono-agent/channel-webhook`

Kind: `channel`. Canonical selected path: `channels.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `channels.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `channels.{id}.$use` | `string` | yes | — | `const "@mono-agent/channel-webhook"` | no | no | — |
| `channels.{id}.allowNonLoopback` | `boolean` | no | `false` | — | no | no | — |
| `channels.{id}.apiKey` | `string` | yes | — | `maxLength 4096; minLength 1; pattern "^\\S+$"` | yes | yes | — |
| `channels.{id}.defaultMode` | `string` | no | `"sync"` | `enum ["sync","async"]` | no | no | — |
| `channels.{id}.listen` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.listen.host` | `string` | no | `"127.0.0.1"` | — | no | no | — |
| `channels.{id}.listen.port` | `integer` | no | `0` | `maximum 65535; minimum 0` | no | no | — |
| `channels.{id}.maxBodyBytes` | `integer` | no | `262144` | `maximum 1048576; minimum 1` | no | no | — |
| `channels.{id}.maxRunMs` | `integer` | no | `1200000` | `maximum 86400000; minimum 1` | no | no | — |
| `channels.{id}.maxStoredRequests` | `integer` | no | `100` | `maximum 10000; minimum 1` | no | no | — |
| `channels.{id}.mode` | `string` | no | `"sync"` | `enum ["sync","async"]` | no | no | — |
| `channels.{id}.outbound` | `object` | no | — | `closed object` | no | no | — |
| `channels.{id}.outbound.apiKey` | `string` | no | — | `maxLength 4096; minLength 1` | yes | yes | — |
| `channels.{id}.outbound.maxResponseBytes` | `integer` | no | `262144` | `maximum 1048576; minimum 1` | no | no | — |
| `channels.{id}.outbound.signatureSecret` | `string` | no | — | `maxLength 4096; minLength 20` | yes | yes | — |
| `channels.{id}.outbound.timeoutMs` | `integer` | no | `10000` | `maximum 60000; minimum 1` | no | no | — |
| `channels.{id}.outbound.url` | `string` | yes | — | `format uri` | no | no | — |
| `channels.{id}.path` | `string` | no | `"/webhook/invoke"` | — | no | no | — |
| `channels.{id}.retentionMs` | `integer` | no | `300000` | `maximum 86400000; minimum 1` | no | no | — |
| `channels.{id}.routesDirectory` | `string` | no | — | `maxLength 1024; minLength 1; pattern "^(?!/)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*[\\u0000-\\u001f\\u007f]).+$"` | no | no | — |
| `channels.{id}.signatureSecret` | `string` | no | — | `maxLength 4096; minLength 20` | yes | yes | — |

#### `@mono-agent/exporter-otlp`

Kind: `exporter`. Canonical selected path: `observability.exporters.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `observability.exporters.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `observability.exporters.{id}.$use` | `string` | yes | — | `const "@mono-agent/exporter-otlp"` | no | no | — |
| `observability.exporters.{id}.contentPatternRedaction` | `boolean` | no | `false` | — | no | no | — |
| `observability.exporters.{id}.endpoint` | `string` | yes | — | `maxLength 4096; minLength 1` | no | no | — |
| `observability.exporters.{id}.flushIntervalMs` | `integer` | no | `1000` | `maximum 60000; minimum 10` | no | no | — |
| `observability.exporters.{id}.flushTimeoutMs` | `integer` | no | `15000` | `maximum 300000; minimum 1` | no | no | — |
| `observability.exporters.{id}.headers` | `object` | no | — | `maxProperties 64` | no | no | — |
| `observability.exporters.{id}.headers.{key}` | `string` | conditional | — | `maxLength 8192; minLength 1` | yes | yes | — |
| `observability.exporters.{id}.includeSensitiveData` | `boolean` | no | `false` | — | no | no | — |
| `observability.exporters.{id}.maxBatchBytes` | `integer` | no | `1048576` | `maximum 16777216; minimum 1` | no | no | — |
| `observability.exporters.{id}.maxBatchRecords` | `integer` | no | `128` | `maximum 1000; minimum 1` | no | no | — |
| `observability.exporters.{id}.maxQueueBytes` | `integer` | no | `8388608` | `maximum 268435456; minimum 1` | no | no | — |
| `observability.exporters.{id}.maxQueueRecords` | `integer` | no | `2048` | `maximum 100000; minimum 1` | no | no | — |
| `observability.exporters.{id}.maxRecordBytes` | `integer` | no | `262144` | `maximum 4194304; minimum 1` | no | no | — |
| `observability.exporters.{id}.maxRedirects` | `integer` | no | `3` | `maximum 5; minimum 0` | no | no | — |
| `observability.exporters.{id}.projectName` | `string` | yes | — | `maxLength 256; minLength 1; pattern "^[ -~]+$"` | no | no | — |
| `observability.exporters.{id}.requestTimeoutMs` | `integer` | no | `10000` | `maximum 300000; minimum 1` | no | no | — |
| `observability.exporters.{id}.stopTimeoutMs` | `integer` | no | `10000` | `maximum 300000; minimum 1` | no | no | — |

#### `@mono-agent/memory-local`

Kind: `memory`. Canonical selected path: `memory`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `memory` | `object` | selected | — | `closed object` | no | no | — |
| `memory.$use` | `string` | yes | — | `const "@mono-agent/memory-local"` | no | no | — |
| `memory.capture` | `object` | no | — | `closed object` | no | no | — |
| `memory.capture.enabled` | `boolean` | no | `false` | — | no | no | — |
| `memory.capture.model` | `object` | no | — | `closed object` | no | no | — |
| `memory.capture.model.model` | `string` | yes | — | `maxLength 512; minLength 1` | no | no | — |
| `memory.capture.model.runtime` | `string` | yes | — | `maxLength 256; minLength 1` | no | no | — |
| `memory.capture.timeoutMs` | `integer` | no | `360000` | `maximum 3600000; minimum 1` | no | no | — |
| `memory.embeddings` | `object` | no | — | `closed object` | no | no | — |
| `memory.embeddings.breakerFailures` | `integer` | no | `3` | `maximum 100; minimum 1` | no | no | — |
| `memory.embeddings.breakerResetMs` | `integer` | no | `30000` | `maximum 3600000; minimum 1` | no | no | — |
| `memory.embeddings.dimensions` | `integer` | yes | — | `maximum 16384; minimum 1` | no | no | — |
| `memory.embeddings.endpoint` | `string` | yes | — | `maxLength 4096; minLength 1` | no | no | — |
| `memory.embeddings.model` | `string` | yes | — | `maxLength 512; minLength 1` | no | no | — |
| `memory.embeddings.provider` | `string` | yes | — | `const "ollama"` | no | no | — |
| `memory.embeddings.timeoutMs` | `integer` | no | `30000` | `maximum 600000; minimum 1` | no | no | — |
| `memory.maxBytes` | `integer` | no | `96000` | `maximum 4194304; minimum 1024` | no | no | — |
| `memory.recallTool` | `object` | no | — | `closed object` | no | no | — |
| `memory.recallTool.enabled` | `boolean` | no | `true` | — | no | no | — |
| `memory.root` | `string` | no | — | `minLength 1` | no | no | — |

#### `@mono-agent/runtime-claude`

Kind: `runtime`. Canonical selected path: `runtimes.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `runtimes.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `runtimes.{id}.$use` | `string` | yes | — | `const "@mono-agent/runtime-claude"` | no | no | — |
| `runtimes.{id}.auth` | `object` | no | — | `closed object; oneOf 2 branches` | no | no | — |
| `runtimes.{id}.auth.method` | `string` | yes | — | `const "api-key"; const "oauth-token"` | no | no | — |
| `runtimes.{id}.auth.token` | `string` | yes | — | `minLength 1` | yes | yes | — |
| `runtimes.{id}.binary` | `string` | no | `"claude"` | `minLength 1` | no | no | — |
| `runtimes.{id}.maxLineBytes` | `integer` | no | `1048576` | `maximum 16777216; minimum 1024` | no | no | — |
| `runtimes.{id}.maxStderrBytes` | `integer` | no | `65536` | `maximum 1048576; minimum 1024` | no | no | — |
| `runtimes.{id}.mode` | `string` | no | `"sdk"` | `enum ["sdk","cli"]` | no | no | — |
| `runtimes.{id}.timeoutMs` | `integer` | no | `600000` | `maximum 3600000; minimum 1000` | no | no | — |

#### `@mono-agent/runtime-codex`

Kind: `runtime`. Canonical selected path: `runtimes.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `runtimes.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `runtimes.{id}.$use` | `string` | yes | — | `const "@mono-agent/runtime-codex"` | no | no | — |
| `runtimes.{id}.auth` | `object` | no | — | `closed object` | no | no | — |
| `runtimes.{id}.auth.apiKey` | `string` | yes | — | `minLength 1` | yes | yes | — |
| `runtimes.{id}.binary` | `string` | no | — | `minLength 1` | no | no | — |
| `runtimes.{id}.maxLineBytes` | `integer` | no | `1048576` | `maximum 16777216; minimum 1024` | no | no | — |
| `runtimes.{id}.maxStderrBytes` | `integer` | no | `65536` | `maximum 1048576; minimum 1024` | no | no | — |
| `runtimes.{id}.requestTimeoutMs` | `integer` | no | `600000` | `maximum 3600000; minimum 1000` | no | no | — |

#### `@mono-agent/runtime-opencode`

Kind: `runtime`. Canonical selected path: `runtimes.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `runtimes.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `runtimes.{id}.$use` | `string` | yes | — | `const "@mono-agent/runtime-opencode"` | no | no | — |
| `runtimes.{id}.binary` | `string` | no | — | `minLength 1` | no | no | — |
| `runtimes.{id}.environment` | `object` | no | — | `key pattern "^[A-Z_][A-Z0-9_]{0,127}$"; maxProperties 64` | no | no | — |
| `runtimes.{id}.environment.{key}` | `string` | conditional | — | — | yes | yes | — |
| `runtimes.{id}.maxLineBytes` | `integer` | no | `1048576` | `maximum 16777216; minimum 1024` | no | no | — |
| `runtimes.{id}.maxStderrBytes` | `integer` | no | `65536` | `maximum 1048576; minimum 1024` | no | no | — |
| `runtimes.{id}.minimumVersion` | `string` | no | `"1.15.13"` | `pattern "^(0\|[1-9]\\d*)\\.(0\|[1-9]\\d*)\\.(0\|[1-9]\\d*)$"` | no | no | — |
| `runtimes.{id}.pure` | `boolean` | no | `true` | `const true` | no | no | — |
| `runtimes.{id}.timeoutMs` | `integer` | no | `600000` | `maximum 3600000; minimum 1000` | no | no | — |

#### `@mono-agent/runtime-pi`

Kind: `runtime`. Canonical selected path: `runtimes.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `runtimes.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `runtimes.{id}.$use` | `string` | yes | — | `const "@mono-agent/runtime-pi"` | no | no | — |
| `runtimes.{id}.auth` | `object` | no | — | `closed object` | no | no | — |
| `runtimes.{id}.auth.path` | `string` | no | — | `minLength 1` | yes | no | — |
| `runtimes.{id}.localProviders` | `array` | no | — | `maxItems 64` | no | no | — |
| `runtimes.{id}.localProviders[]` | `object` | item | — | `closed object` | no | no | — |
| `runtimes.{id}.localProviders[].baseUrl` | `string` | yes | — | `format uri; minLength 1` | no | no | — |
| `runtimes.{id}.localProviders[].id` | `string` | yes | — | `pattern "^[a-z][a-z0-9-]{0,63}$"` | no | no | — |
| `runtimes.{id}.localProviders[].models` | `array` | no | — | `maxItems 10000; minItems 1` | no | no | — |
| `runtimes.{id}.localProviders[].models[]` | `object` | item | — | `closed object` | no | no | — |
| `runtimes.{id}.localProviders[].models[].contextWindow` | `integer` | no | — | `maximum 10000000; minimum 1` | no | no | — |
| `runtimes.{id}.localProviders[].models[].id` | `string` | yes | — | `maxLength 256; minLength 1` | no | no | — |
| `runtimes.{id}.localProviders[].models[].input` | `array` | no | `["text"]` | `minItems 1; unique items` | no | no | — |
| `runtimes.{id}.localProviders[].models[].input[]` | `string` | item | — | `enum ["text","image"]` | no | no | — |
| `runtimes.{id}.localProviders[].models[].maxTokens` | `integer` | no | — | `maximum 1000000; minimum 1` | no | no | — |
| `runtimes.{id}.localProviders[].models[].name` | `string` | no | — | `maxLength 256; minLength 1` | no | no | — |
| `runtimes.{id}.localProviders[].models[].reasoning` | `boolean` | no | `false` | — | no | no | — |
| `runtimes.{id}.retry` | `object` | no | — | `closed object` | no | no | — |
| `runtimes.{id}.retry.maxDelayMs` | `integer` | no | `60000` | `maximum 60000; minimum 0` | no | no | — |
| `runtimes.{id}.retry.maxRetries` | `integer` | no | `2` | `maximum 10; minimum 0` | no | no | — |
| `runtimes.{id}.retry.timeoutMs` | `integer` | no | `600000` | `maximum 3600000; minimum 1000` | no | no | — |
| `runtimes.{id}.sessions` | `object` | no | — | `closed object` | no | no | — |
| `runtimes.{id}.sessions.root` | `string` | no | — | `minLength 1` | yes | no | — |

#### `@mono-agent/sandbox-srt`

Kind: `sandbox`. Canonical selected path: `policy.sandbox`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `policy.sandbox` | `object` | selected | — | `closed object` | no | no | — |
| `policy.sandbox.$use` | `string` | yes | — | `const "@mono-agent/sandbox-srt"` | no | no | — |
| `policy.sandbox.environment` | `object` | no | — | `closed object` | no | no | — |
| `policy.sandbox.environment.allow` | `array` | no | — | `maxItems 256; unique items` | no | no | — |
| `policy.sandbox.environment.allow[]` | `string` | item | — | `allOf 3 branches; not {"enum":["NODE_OPTIONS","NODE_PATH"]}; not {"pattern":"^(?:LD_\|DYLD_)"}; pattern "^[A-Za-z_][A-Za-z0-9_]*$"` | no | no | — |
| `policy.sandbox.environment.inherit` | `array` | no | — | `maxItems 256; unique items` | no | no | — |
| `policy.sandbox.environment.inherit[]` | `string` | item | — | `allOf 3 branches; not {"enum":["NODE_OPTIONS","NODE_PATH"]}; not {"pattern":"^(?:LD_\|DYLD_)"}; pattern "^[A-Za-z_][A-Za-z0-9_]*$"` | no | no | — |
| `policy.sandbox.executable` | `object` | yes | — | `closed object` | no | no | — |
| `policy.sandbox.executable.path` | `string` | yes | — | `minLength 1` | no | no | — |
| `policy.sandbox.executable.sha256` | `string` | yes | — | `pattern "^[a-f0-9]{64}$"` | no | no | — |
| `policy.sandbox.limits` | `object` | no | — | `closed object` | no | no | — |
| `policy.sandbox.limits.defaultTimeoutMs` | `integer` | no | `120000` | `maximum 3600000; minimum 1` | no | no | — |
| `policy.sandbox.limits.maxArgumentBytes` | `integer` | no | `262144` | `maximum 1048576; minimum 0` | no | no | — |
| `policy.sandbox.limits.maxArguments` | `integer` | no | `1024` | `maximum 4096; minimum 0` | no | no | — |
| `policy.sandbox.limits.maxEnvironmentBytes` | `integer` | no | `65536` | `maximum 1048576; minimum 0` | no | no | — |
| `policy.sandbox.limits.maxEnvironmentVariables` | `integer` | no | `64` | `maximum 256; minimum 0` | no | no | — |
| `policy.sandbox.limits.maxInputBytes` | `integer` | no | `1048576` | `maximum 16777216; minimum 0` | no | no | — |
| `policy.sandbox.limits.maxOutputBytes` | `integer` | no | `4194304` | `maximum 67108864; minimum 1` | no | no | — |
| `policy.sandbox.limits.maxTimeoutMs` | `integer` | no | `600000` | `maximum 3600000; minimum 1` | no | no | — |
| `policy.sandbox.settings` | `object` | yes | — | `closed object` | no | no | — |
| `policy.sandbox.settings.path` | `string` | yes | — | `minLength 1` | no | no | — |
| `policy.sandbox.settings.sha256` | `string` | yes | — | `pattern "^[a-f0-9]{64}$"` | no | no | — |

#### `@mono-agent/state-local`

Kind: `state`. Canonical selected path: `state`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `state` | `object` | selected | — | `closed object` | no | no | — |
| `state.$use` | `string` | yes | — | `const "@mono-agent/state-local"` | no | no | — |
| `state.discovery` | `object` | no | — | `closed object` | no | no | — |
| `state.discovery.heartbeatMs` | `integer` | no | `15000` | `maximum 300000; minimum 1000` | no | no | — |
| `state.discovery.registryDirectory` | `string` | yes | — | `maxLength 4096; minLength 1` | no | no | — |
| `state.discovery.sourceId` | `string` | yes | — | `maxLength 128; minLength 1` | no | no | — |
| `state.discovery.sourceLabel` | `string` | yes | — | `maxLength 256; minLength 1` | no | no | — |
| `state.maxRecordBytes` | `integer` | no | `1048576` | `maximum 16777216; minimum 1` | no | no | — |
| `state.maxRecords` | `integer` | no | `100000` | `maximum 1000000; minimum 1` | no | no | — |
| `state.maxTotalBytes` | `integer` | no | `67108864` | `maximum 1073741824; minimum 1` | no | no | — |
| `state.root` | `string` | no | `"./.mono-agent/state"` | `maxLength 4096; minLength 1` | no | no | — |
| `state.runs` | `object` | no | — | `closed object` | no | no | — |
| `state.runs.artifactsDirectory` | `string` | no | — | `maxLength 4096; minLength 1` | no | no | — |
| `state.runs.retentionDays` | `integer` | no | `30` | `maximum 3650; minimum 1` | no | no | — |

#### `@mono-agent/trigger-cron`

Kind: `trigger`. Canonical selected path: `triggers.{id}`.

| Path | Type | Required | Default | Constraints | Env eligible | Secret | Cross-slot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `triggers.{id}` | `object` | selected | — | `closed object` | no | no | — |
| `triggers.{id}.$use` | `string` | yes | — | `const "@mono-agent/trigger-cron"` | no | no | — |
| `triggers.{id}.jobsDirectory` | `string` | yes | — | `maxLength 1024; minLength 1; pattern "^(?!/)(?!.*(?:^\|/)\\.\\.(?:/\|$))(?!.*[\\u0000-\\u001f\\u007f]).+$"` | no | no | — |
| `triggers.{id}.timezone` | `string` | no | `"UTC"` | `maxLength 128; minLength 1` | no | no | — |

## Generated scaffold matrix

| Template | Exact direct dependencies | Selected modules | Referenced environment names |
| --- | --- | --- | --- |
| `minimal` | `@mono-agent/channel-webhook`, `@mono-agent/cli`, `@mono-agent/core`, `@mono-agent/module-sdk`, `@mono-agent/runtime-pi` | `@mono-agent/channel-webhook`, `@mono-agent/runtime-pi` | `WEBHOOK_API_KEY` |
| `personal` | `@mono-agent/channel-openai-api`, `@mono-agent/channel-operator`, `@mono-agent/channel-telegram`, `@mono-agent/channel-webhook`, `@mono-agent/cli`, `@mono-agent/core`, `@mono-agent/exporter-otlp`, `@mono-agent/memory-local`, `@mono-agent/module-sdk`, `@mono-agent/runtime-pi`, `@mono-agent/state-local`, `@mono-agent/trigger-cron` | `@mono-agent/channel-openai-api`, `@mono-agent/channel-operator`, `@mono-agent/channel-telegram`, `@mono-agent/channel-webhook`, `@mono-agent/exporter-otlp`, `@mono-agent/memory-local`, `@mono-agent/runtime-pi`, `@mono-agent/state-local`, `@mono-agent/trigger-cron` | `MONO_AGENT_OPENAI_API_KEY`, `MONO_AGENT_OPERATOR_TOKEN`, `MONO_AGENT_TELEGRAM_BOT_TOKEN`, `MONO_AGENT_WEBHOOK_API_KEY`, `MONO_AGENT_WEBHOOK_SIGNATURE_SECRET`, `PERSONAL_AGENT_TELEGRAM_CHAT_ID` |
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
| `channels.openai-api.allowNonLoopback` | `personal` |
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
| `channels.telegram.quietHours.end` | `personal` |
| `channels.telegram.quietHours.start` | `personal` |
| `channels.telegram.quietHours.timezone` | `personal` |
| `channels.telegram.reactions.done` | `personal` |
| `channels.telegram.reactions.error` | `personal` |
| `channels.telegram.reactions.working` | `personal` |
| `channels.telegram.transcription.endpoint` | `personal` |
| `channels.telegram.transcription.model` | `personal` |
| `channels.telegram.transport.ipFamily` | `personal` |
| `channels.webhook.$use` | `personal` |
| `channels.webhook.allowNonLoopback` | `personal` |
| `channels.webhook.apiKey.$env` | `personal` |
| `channels.webhook.defaultMode` | `personal` |
| `channels.webhook.listen.host` | `personal` |
| `channels.webhook.listen.port` | `personal` |
| `channels.webhook.maxStoredRequests` | `personal` |
| `channels.webhook.retentionMs` | `personal` |
| `channels.webhook.routesDirectory` | `personal` |
| `channels.webhook.signatureSecret.$env` | `personal` |
| `configVersion` | `minimal`, `personal`, `multi-runtime` |
| `context.mcp.configPath` | `personal` |
| `context.skills.disclosure` | `personal` |
| `context.skills.load` | `personal` |
| `context.skills.maxBytes` | `personal` |
| `context.skills.roots[]` | `personal` |
| `memory.$use` | `personal` |
| `memory.capture.enabled` | `personal` |
| `memory.capture.model.model` | `personal` |
| `memory.capture.model.runtime` | `personal` |
| `memory.capture.timeoutMs` | `personal` |
| `memory.embeddings.dimensions` | `personal` |
| `memory.embeddings.endpoint` | `personal` |
| `memory.embeddings.model` | `personal` |
| `memory.embeddings.provider` | `personal` |
| `memory.maxBytes` | `personal` |
| `memory.recallTool.enabled` | `personal` |
| `memory.root` | `personal` |
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
| `state.runs.artifactsDirectory` | `personal` |
| `state.runs.retentionDays` | `personal` |
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
      "default": "ask"
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
    },
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
      },
      "quietHours": {
        "start": "23:00",
        "end": "07:00",
        "timezone": "Europe/Rome"
      },
      "transport": {
        "ipFamily": 4
      },
      "transcription": {
        "endpoint": "http://127.0.0.1:50060/v1/audio/transcriptions",
        "model": "large-v3-v20240930"
      }
    },
    "webhook": {
      "$use": "@mono-agent/channel-webhook",
      "listen": {
        "host": "100.64.0.10",
        "port": 4313
      },
      "allowNonLoopback": true,
      "apiKey": {
        "$env": "MONO_AGENT_WEBHOOK_API_KEY"
      },
      "signatureSecret": {
        "$env": "MONO_AGENT_WEBHOOK_SIGNATURE_SECRET"
      },
      "routesDirectory": "./webhook",
      "defaultMode": "async",
      "retentionMs": 300000,
      "maxStoredRequests": 100
    },
    "openai-api": {
      "$use": "@mono-agent/channel-openai-api",
      "listen": {
        "host": "0.0.0.0",
        "port": 4312
      },
      "allowNonLoopback": true,
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
      "default": "ask"
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
