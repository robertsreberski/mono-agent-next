---
title: "Migrate a v0 project"
description: "Port request-context MCP servers, cron jobs, and webhook routes to the current source contracts."
sidebar:
  order: 4
---

The current source tree does not provide a v0 compatibility layer. Port project
configuration in a separate source copy and validate it before any later,
separately authorized consumer adoption. Building this repository does not
publish packages, migrate data, restart a service, or change a live agent.

## Request-context MCP servers

v0 supplied request context through process-start environment variables:

- `MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID`
- `MONO_AGENT_MCP_PRODUCING_RUN_ID`
- `MONO_AGENT_MCP_RUN_OUTPUT_DIR`
- `MONO_AGENT_MCP_ATTACHMENTS_ROOT`
- `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS`
- `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES`

The current host keeps a selected direct stdio server alive and supplies
request context on each tool call in
`_meta["com.mono-agent/request-context"]`. The namespaced object has
`schemaVersion: 1` and carries the current conversation/run identity, staged
attachments, exact path/device/inode allowlists, and the current run output
directory.

Port the MCP handler to read that reserved per-call metadata before selecting
the server:

```json
{
  "context": {
    "mcp": {
      "configPath": "./.mcp.json",
      "requestContextServers": ["project-context"]
    }
  }
}
```

Do not add an environment-dependent v0 server to `requestContextServers`. It
may fail during persistent-process startup and prevent the agent from starting.
There is no static environment shim because one long-lived process handles
multiple isolated requests. The complete metadata, output, cleanup, and
security contract is in [Project MCP](/tools/mcp/).

## Cron job frontmatter

Split the v0 combined model selector into the selected runtime instance and its
provider-native model. Replace boolean notification plus a separate
conversation id with one explicit delivery selection.

v0:

```markdown
---
enabled: true
conversationId: heartbeat
model: pi:openai-codex:gpt-5.6-sol
notify: true
notifyConversationId: telegram:42
---
Compose the morning briefing.
```

Current:

```markdown
---
id: heartbeat
enabled: true
expression: 30 7 * * *
runtime: pi
model: openai-codex:gpt-5.6-sol
notify:
  channel: telegram
  destination: telegram:42
---
Compose the morning briefing.
```

`enabled` defaults to `true`. An explicitly disabled job is still fully parsed
and validated, but it is not scheduled and cannot be invoked through
`trigger-cron:invoke`. A directory whose jobs are all disabled is valid.
Each enabled runtime/model pair must resolve to a configured Core route before
the scheduler starts. If one field is omitted, Core supplies that field from
the primary route.

`conversationId` is not cron frontmatter. Core derives the execution
conversation as `trigger:<trigger instance id>:<event id>` from the admitted
trigger event. `notify.destination` is the channel-owned delivery destination,
not that execution conversation. A `notify` channel-instance string may be used
instead when the selected channel owns a configured default destination.

The cron loader validates every Markdown file in stable filename order and
reports all rejected files together. Fix the complete report before retrying
module creation.

## Webhook route frontmatter

Webhook routes retain `enabled`, which defaults to `true`. Replace the v0
boolean notification and separate notification conversation with either an
explicit delivery object or a selected channel-instance string:

v0:

```markdown
---
name: triage
path: /hooks/triage
enabled: true
notify: true
notifyConversationId: telegram:42
---
Classify the incident.
```

Current:

```markdown
---
name: triage
path: /hooks/triage
enabled: true
runtime: pi
model: openai-codex:gpt-5.6-sol
notify:
  channel: telegram
  destination: telegram:42
---
Classify the incident.
```

`notify: telegram` is also valid when that channel instance owns its default
destination. A route file does not accept `notifyConversationId` or a
frontmatter `conversationId`; an inbound webhook request may still supply its
own bounded `conversationId`.

Like cron, the directory loader validates every route file and aggregates all
rejections before failing. Unlike cron, a configured webhook routes directory
must contain at least one enabled route before its listener starts.
During channel start, after route loading and before the listener binds, each
enabled runtime/model pair must resolve to a configured Core route. If one field
is omitted, Core supplies that field from the primary route.

## Validation boundary

Strict unknown-key validation is intentional. Remove retired keys rather than
keeping them beside their replacements. Both directory loaders report every
invalid Markdown file in one pass, so one cron module-creation attempt or
webhook channel-start attempt exposes the full rewrite set instead of requiring
one restart per file.
