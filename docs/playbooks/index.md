---
title: "Source-beta playbooks"
description: "Use the maintained v1 proofs and migration rehearsal instead of v0 configuration recipes."
sidebar:
  order: 0
---

The source beta keeps a small set of executable paths:

| Outcome | Guide or proof |
| --- | --- |
| Smallest clean installed agent turn | [Your first agent](/getting-started/quickstart/) and `pnpm run verify:v1-minimal` |
| Minimal, Personal, and multi-runtime packed closures | `pnpm run verify:v1-system` |
| Terminal and web product boundary | `pnpm run verify:v1-operator-products` |
| v0 consumer rehearsal without live mutation | [v0 to v1 source beta](/migration/v0-to-v1-source-beta/) |
| Exact package selection and options | [Generated config reference](/config/reference/) |
| Programmatic ownership and symbols | [Public API inventory](/reference/public-api/) |

Old A2A, WhatsApp, Supermemory, continuation, self-configuration, orchestration,
and backfill recipes were removed because those surfaces do not exist in v1.
Do not translate them into hidden Core behavior.

Package READMEs, linked from the [package directory](/reference/packages/),
contain the focused configuration and verification lane for each current
runtime, channel, trigger, durable module, and product.
