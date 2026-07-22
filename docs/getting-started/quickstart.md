---
title: "Your First Agent"
description: "Run the packed minimal v1 proof, inspect a generated template, and learn the exact foreground CLI workflow."
sidebar:
  order: 2
---

The fastest honest first-agent result in the private repository is the packed
minimal verification. It exercises a clean installed consumer and one real HTTP
turn without requiring registry publication or live provider credentials.

## Run the end-to-end proof

From the installed repository:

```bash
pnpm run verify:v1-minimal
```

The verifier:

1. builds and packs the SDK, core, CLI, Pi runtime, webhook channel, and
   scaffolder;
2. installs the scaffolder into a temporary bootstrap project;
3. renders the default `minimal` template;
4. installs only the five selected agent-process packages into a clean consumer;
5. validates the untouched config and composes its selected-module schema;
6. starts a local OpenAI-compatible test provider and the foreground CLI;
7. proves unauthenticated webhook rejection, then completes one authenticated
   turn; and
8. sends `SIGTERM` and verifies a clean drain and stop.

Success ends with a single verification message. Temporary files and processes
are removed in the script's cleanup path.

## Inspect the minimal template

Render another copy without trying to install unreleased versions:

```bash
node packages/create-mono-agent/dist/bin/create-mono-agent.js \
  /tmp/my-first-agent \
  --template minimal

cd /tmp/my-first-agent
sed -n '1,240p' mono-agent.config.json
sed -n '1,200p' package.json
```

The minimal manifest has exactly these mono-agent dependencies:

```text
@mono-agent/module-sdk
@mono-agent/core
@mono-agent/cli
@mono-agent/runtime-pi
@mono-agent/channel-webhook
```

Its config selects one Pi instance and one authenticated loopback webhook. The
`$use` values and direct dependencies agree exactly. `.env.example` contains the
name `WEBHOOK_API_KEY=` with no value; the scaffolder does not write provider or
channel credentials.

## Understand the installed CLI workflow

Once an agent project has been installed from reviewed v1 artifacts and has a
root lockfile, use the following exact commands.

### Validate

```bash
mono-agent validate --config ./mono-agent.config.json
mono-agent validate --config ./mono-agent.config.json --json
```

Validation parses strict JSON, resolves every selected direct dependency from
the project, verifies lockfile and module metadata, resolves declared
environment references, parses each module schema, and checks routes and
cross-module references. It does not start module instances.

### Inspect

```bash
mono-agent inspect --config ./mono-agent.config.json
mono-agent inspect --config ./mono-agent.config.json --json
```

Inspection performs the same load/import validation and prints the agent,
resolved project paths, selected module identities and versions, routing, and
configured MCP server names. It does not create or start modules.

### Generate the exact schema

```bash
mono-agent config schema --config ./mono-agent.config.json --write
mono-agent config explain --config ./mono-agent.config.json channels.inbound.apiKey
```

The schema command replaces the scaffold seed schema with one composed from the
installed selections. Explain reports the owning package and environment
variable name while redacting the resolved secret value.

### Start in the foreground

Export the values named by the config and provide the selected runtime's native
authentication, then start:

```bash
export WEBHOOK_API_KEY='replace-with-a-long-random-token'
mono-agent start --config ./mono-agent.config.json
```

The first output line is one JSON `started` event with the actual channel
endpoints. Keep the command running. Stop it with `Ctrl-C` or `SIGTERM`; the CLI
drains then stops the host before exiting.

If the reported invoke URL is `http://127.0.0.1:3210/webhook/invoke`, submit an
authenticated request from another terminal:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $WEBHOOK_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"text":"Say hello.","conversationId":"first-turn"}' \
  http://127.0.0.1:3210/webhook/invoke
```

A provider failure remains a failure; mono-agent does not synthesize a reply.

### Run an explicit module command

Modules may expose named maintenance or authentication commands. The CLI does
not discover or list them. Supply the configured instance id, exact command
name, and schema-valid JSON input:

```bash
mono-agent module command --config ./mono-agent.config.json \
  --module cron \
  --name trigger-cron:invoke \
  --input-json '{"jobId":"heartbeat"}'
```

This example applies only when a `cron` trigger instance and a `heartbeat` job
exist. Run it only while another process is not already hosting the same config.
The command starts the selected host, invokes exactly one exposed module command,
prints JSON, and stops the host.

## Choose another scaffold

| Template | Use it for |
| --- | --- |
| `minimal` | Smallest Pi plus webhook agent; default. |
| `personal` | Local durable memory/state, multiple channels, cron, OTLP, and an operator endpoint. Terminal and web products remain separate. |
| `multi-runtime` | Pi primary with a native Claude fallback and a second Pi-family fallback. |

Templates are deterministic starting points, not proof that external
credentials, provider binaries, destinations, or operating-system services are
ready. Run `validate`, then the matching focused verification, before any later
live adoption.

## Phase boundary

Do not repoint an existing service or copy live memory/state into a generated
project during this source walkthrough. Registry installation, migration,
rollback rehearsal, live smoke, soak, observation, and cutover belong to the
separately authorized delivery phase.

Continue with [Core Concepts](/getting-started/concepts/).
