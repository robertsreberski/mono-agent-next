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

Ordinary MCP servers receive only their configured stdio environment or HTTP
headers. `context.mcp.requestContextServers` is the one default-off exception
for the admitted Personal transcription consumer: every selected name must
resolve to a direct stdio transport, and only that transport receives immutable
`com.mono-agent/request-context` version 1 metadata for the current call.

Core stages current-request attachments as exclusive no-follow, owner-private,
single-link files and pins their path/device/inode identities. The grant also
names one per-run output directory and projects bounded, redacted progress as
transient channel activity. It is never sent to HTTP MCP, inherited as
process-start environment, or accepted from model arguments. Cleanup checks the
exact identity and never unlinks a replacement.
Grant `dev` and `ino` values are canonical unsigned-decimal strings, never JSON
numbers. Personal transcription selects a staged file by `attachment_id`;
`file_path` is default-deny. Legacy local paths require the bounded static
`TRANSCRIBE_LOCAL_PATH_ROOTS` absolute-directory allowlist, which cannot select
Core's managed attachments root.
This limits mono-agent-supplied context; it does not sandbox the configured
command. A stdio command may use SSH, containers, proxies, or its own network
access, so selection is not proof of locality. Treat it as trusted code.
Persistent selected processes can observe all selected calls and deliberately
mix runs or race paths. Device/inode checks and private cleanup claims provide
best-effort routing and replacement safety, not cryptographic provenance or
same-UID adversarial isolation; unprovable cleanup is retained and degrades host
health. Plain-string paths and configured secrets are redacted from results,
errors, progress, previews, and offloaded envelopes, but encoded or binary
exfiltration cannot be detected reliably.

Normal completion, failure, and cancellation clean staged runs. A `SIGKILL`,
power loss, or host crash may leave owner-only residue. Restart does not use
PID/age guesses and performs no automatic stale deletion without a
cross-process lease. Pre-GA lease-backed recovery remains required. Interim
maintenance is permitted only after all project hosts are proven stopped, for
explicit exact run ids whose targets are verified owner-owned non-symlink
directories; broad roots, globs, recursive discovery, and age selection are
outside this contract.

Current-run file delivery remains host-bound. A channel tool may request one
safe basename through `readCurrentRunOutput`; Core performs the stable bounded
read and returns normalized bytes. The channel never receives an arbitrary
path, directory handle, or ambient filesystem authority. A producer result may
include the safe basename plus bounded identifiers and metadata, but no
absolute-path field.

V1 still has no continuation or child-run spawn/observe/cancel grant. Independent
durable work belongs in an external service and re-enters through an explicit
channel or webhook.

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
service, adopting data, or running a production soak.

## Data adoption

Keep the source project and service definition read-only during rehearsal. Back
up durable data and rehearse on a complete copy. Do not automatically import
conversation history, run artifacts, provider-native sessions, web state, or
retired extension records. Treat duplicate consumption, memory loss,
unprovable process identity, hidden auth failure, false health, missed
schedules, crash loops, or secret exposure as immediate rollback triggers.
