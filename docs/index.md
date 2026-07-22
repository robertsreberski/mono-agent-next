---
title: "Home"
description: "Build and understand the private mono-agent v1 source target: strict selected modules, standalone operator products, and explicit delivery phases."
sidebar:
  order: 0
---

mono-agent v1 is a config-first agent framework. One strict
`mono-agent.config.json` selects typed runtime, channel, memory, state, trigger,
exporter, and sandbox modules; `@mono-agent/core` validates their installed
identity and runs them through neutral contracts.

This documentation describes the private `mono-agent-next` source target. The
repository is not yet a published release and is not the live source for
existing agents.

:::caution
Building or testing this source tree does not authorize package publication,
deployment, service changes, data migration, production soak, cutover, or
predecessor retirement. Those are a later, separately approved phase.
:::

## Start here

1. [Install the private source workspace](/getting-started/install/) and run its
   focused verification.
2. [Prove and inspect a first agent](/getting-started/quickstart/) through the
   packed minimal path.
3. [Learn the v1 concepts](/getting-started/concepts/) before changing config or
   adding a module.
4. Read the [exact v1 architecture](/reference/v1-architecture/) for the closed
   23-package roster and dependency rules.

## What v1 contains

- Four runtime modules: Pi, Claude, Codex, and OpenCode.
- Five channel modules: Telegram, Slack, webhook, OpenAI-compatible API, and the
  authenticated operator channel.
- Optional local memory, durable state, cron triggers, OTLP export, and SRT
  sandboxing.
- A shared operator protocol plus separate terminal and browser products.
- A thin CLI, a transactional three-template scaffolder, explicit macOS service
  management, and a version-matched documentation MCP companion.

The implementation is 23 publishable packages with narrow ownership. Installing
a package does not activate it: agent-process modules require an explicit
`$use`, a direct project dependency, and matching root lockfile evidence.

## Core execution path

```text
strict config + direct dependencies + lockfile
  -> @mono-agent/core
  -> selected modules
  -> normalized turn, delivery, persistence, telemetry, and lifecycle contracts
```

Provider and channel behavior stays in the selected implementation. Core
coordinates; it does not hide errors, install packages, discover arbitrary
paths, or silently substitute another capability.

## Operator boundary

An agent opts into operator access by selecting
`@mono-agent/channel-operator`, an authenticated loopback channel. The
standalone `@mono-agent/tui` and `@mono-agent/web` products connect through the
shared `@mono-agent/operator` protocol. They are not embedded in agent config,
and closing a renderer does not stop the agent.

Web has a separate config, process, listener, authentication boundary, and
owner-private durable conversation store. The TUI owns terminal presentation
only.

## Safety model

V1 rejects unknown config, implicit secrets, unsafe module locations, dependency
or lockfile drift, incompatible module metadata, unsafe local storage, corrupt
durable formats, unbounded transport inputs, and unverifiable sandbox or export
destinations. Failures remain observable; unsafe state is preserved for
inspection instead of being repaired or overwritten.
