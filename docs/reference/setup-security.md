---
title: "Setup and security"
description: "Security boundaries for v1 source setup, selected modules, local storage, network listeners, products, and migration rehearsal."
sidebar:
  order: 6
---

V1 is local-first and single-owner by default, but a configured agent can read
context, execute allowed tools, persist user data, and send through selected
channels. Treat every reachable operator or channel endpoint as carrying the
authority that its schema and policy allow.

## Installation and authority

Every selected `$use` package must be a direct production dependency with exact
root-lockfile evidence. Core refuses undeclared, wrong-kind, incompatible,
path-escaped, or unstable package resolution. Loading and validation never
install packages, authenticate a provider, start a product, or mutate the host.

Scaffolds contain names-only `.env.example` files. They never write credentials
or a lockfile. Review package versions and create the lockfile with lifecycle
scripts disabled when building an untrusted closure.

## Secrets

Schema-marked secret fields accept explicit `{"$env":"NAME"}` references only.
Mono-agent does not load `.env` implicitly. Missing and empty values fail
validation, and explain/inspection output reports the environment name while
redacting the resolved value.

Keep provider-native credential stores and any service environment file
owner-private. Do not put bearer values in command arguments, launchd plists,
generated schemas, logs, issues, screenshots, or debugging prompts.

## Network listeners

The operator channel accepts only literal loopback HTTP plus bearer
authentication. Webhook and OpenAI-compatible modules default to loopback and
require their explicit non-loopback and authentication policy when exposed.
The web product uses its own listener and bearer; direct non-loopback plaintext
requires a stronger token and explicit risk acknowledgement. Host and Origin
checks defend request integrity but do not provide TLS.

Prefer loopback behind a correctly configured HTTPS reverse proxy or Tailscale
Serve. Never expose an unauthenticated or plaintext owner-equivalent surface to
an untrusted network.

## Owner-private files

Durable modules and products validate regular-file type, current ownership,
mode, link count, descriptor/path device and inode identity, size, and bounded
contents where promised. POSIX owner-private directories are normally `0700`;
secret or durable control files are normally `0600`.

Symlinks, unexpected hard links, wrong owners, group/world-write access,
identity swaps, corruption, and unknown formats fail closed. A module never
uses a path-based chmod to repair pre-existing operator data. Remediation is an
explicit backup, copy, or permission operation outside the running module.

## Runtime and tool authority

Core intersects runtime-owned tools with global and request-local policy.
Fallback may advance only from a typed retryable failure that proves no side
effects, before text, tools, interactions, live input, or a result commit.
Provider/runtime failures remain visible; there is no fake success fallback.

MCP servers receive only their configured stdio environment or HTTP headers.
V1 has no continuation host grant or request-scoped child-run host capability.
Independent durable work belongs in an external service and re-enters through
an explicit channel or webhook.

## Sandbox

The sandbox is either explicitly off or a selected package. The first-party SRT
module requires canonical absolute executable and settings paths plus exact
SHA-256 digests. It revalidates identity and content around every shell-free
bounded spawn and has no unsafe host fallback. See [Sandbox](/tools/sandbox/).

## Products and host mutation

TUI, web, service-macos, and docs-mcp have independent lifecycle. Agent config
cannot start them. Service-macos inspect and plan are read-only; apply and
remove require explicit mutation authority and a current fingerprint. Removal
never deletes agent config, memory, state, logs, or web data.

The repository is public and CI may run on it. Public visibility does not
authorize publishing packages, deploying a consumer, restarting or removing a
service, migrating data, running a production soak, or retiring v0.

## Migration

Keep the v0 project and service definition read-only during source rehearsal.
Back up BuJo and rehearse on a complete copy. Do not import conversation
history, run artifacts, provider-native sessions, web state, A2A, or
continuation records. Follow the [migration guide](/migration/v0-to-v1-source-beta/)
and treat duplicate consumption, memory loss, unprovable process identity,
hidden auth failure, false health, missed schedules, crash loops, or secret
exposure as immediate rollback triggers.
