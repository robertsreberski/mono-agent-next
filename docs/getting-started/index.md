---
title: "Getting Started"
description: "Build the public workspace, run the packed minimal proof, and learn the strict config-first model."
sidebar:
  order: 0
---

The current getting-started path is source-first. `mono-agent-next` is public
and unreleased, so these pages prove the implementation without publishing
packages or changing a live agent.

## The path

1. [Install and build](/getting-started/install/) the pinned workspace.
2. [Run the first-agent proof](/getting-started/quickstart/) and inspect the
   generated minimal template.
3. [Read the core concepts](/getting-started/concepts/) before selecting another
   runtime, channel, durable capability, or operator product.
4. If you have a predecessor project, follow
   [Migrate a v0 project](/getting-started/migrate-from-v0/) before selecting
   its MCP servers, cron jobs, or webhook routes.

## What you will prove

The packed minimal verification builds the relevant packages, packs them,
creates a clean consumer outside the workspace, installs an exact lockfile
closure, validates its config, starts an authenticated loopback webhook, runs a
deterministic Pi-native turn against a local test provider, and performs a clean
signal-driven shutdown.

The operator verification separately exercises the authenticated shared
protocol, durable browser-product restart behavior, and a standalone terminal
connection. Neither proof deploys or restarts an existing agent.

## What remains later

Registry publication, clean installation from the real registry, provider
credential setup, consumer data adoption, service reconciliation, live smoke,
soak, observation, and cutover are intentionally outside this phase.
