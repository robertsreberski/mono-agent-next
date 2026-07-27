---
title: "Setup and security"
description: "Security boundaries for source setup, selected modules, local storage, network listeners, products, and migration rehearsal."
sidebar:
  order: 6
---

Mono-agent is local-first and single-owner by default, but a configured agent can read
context, execute allowed tools, persist user data, and send through selected
channels. Treat every reachable operator or channel endpoint as carrying the
authority that its schema and policy allow.

## Installation and authority

Every selected `$use` package must be a direct production dependency with exact
root-lockfile evidence. Core refuses undeclared, wrong-kind, incompatible,
path-escaped, or unstable package resolution. Loading and validation never
install packages, authenticate a provider, start a product, or mutate the host.

The source-preview exception accepts only a lexically project-relative,
lowercase `file:*.tgz` locator installed through npm. `package-lock.json` must
record the same locator, installed version, and syntactically valid canonical
SHA-512 SRI. Core validates the installed package root as a real contained npm
directory; it does not reopen or attest the retained archive bytes at startup.
The documented `npm ci` and `verify:minimal` proof check those bytes. Pnpm
remains supported for registry dependencies, not this source-preview exception.
Selected modules are trusted executable code; reject unreviewed archives just
as you would reject unreviewed registry packages.

Scaffolds contain names-only `.env.example` files. They never write credentials
or a lockfile. Review package versions and create the lockfile with lifecycle
scripts disabled when building an untrusted closure. A retained local-tarball
consumer keeps its archives, manifest, and lockfile together so a frozen
install can reproduce the selected closure.

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
The web product uses its own listener and explicitly selects bearer-token
authentication or owner-trusted no-auth mode. Every direct non-loopback
plaintext listener requires explicit risk acknowledgement; token mode also
requires a stronger token. Exact additional direct-listener names belong in
`allowedHosts`, while exact HTTPS proxy origins belong in `externalOrigins`.
Host and Origin checks defend request integrity but are not user
authentication and do not provide TLS.

Prefer loopback behind a correctly configured HTTPS reverse proxy or Tailscale
Serve. No-auth mode makes every client admitted by the bind, network controls,
and request-boundary checks owner-equivalent. Never expose no-auth or plaintext
owner-equivalent access to an untrusted network.

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
power loss, or host crash may leave owner-only residue. With at least one
`requestContextServers` selection on macOS or Linux, startup first acquires the owner-private
4 KiB SQLite lease
`.mono-agent/data/core/mcp-runs/.mono-agent-current-run.lease.sqlite`. Its
descriptor-anchored exclusive transaction admits one live owner per project
root and is released by the OS on process death.

While holding that lease, startup discovers the complete known run and cleanup
claim layouts before deletion, revalidates every pathname identity, and removes
verified residue bottom-up. Discovery stops at 4,096 root entries, 65,536 total
entries, or depth 8. Unknown shapes, symlinks, hard links, identity changes,
SQLite sidecars, and limit violations fail closed without recovery deletion.
PID and age are not staleness evidence.

Lease-free residue predates this ownership contract and is left untouched.
Before first adoption, stop all older hosts for that project and remove only
exact run directories after owner, type, and no-symlink verification. Clean
shutdown waits for active cleanup and removes an otherwise solitary lease;
residue retains it for the next recovery. An omitted or empty selection does
not create or mutate the workspace. If permanently disabling the feature,
remove the exact lease only after all project hosts are stopped and all residue
is gone. `diagnose` checks configured module diagnostics, not dormant
current-run storage; no broad Core purge command is provided.

Current-run file delivery remains host-bound. A channel tool may request one
safe basename through `readCurrentRunOutput`; Core performs the stable bounded
read and returns normalized bytes. The channel never receives an arbitrary
path, directory handle, or ambient filesystem authority. A producer result may
include the safe basename plus bounded identifiers and metadata, but no
absolute-path field.

The repository still has no continuation or child-run spawn/observe/cancel grant. Independent
durable work belongs in an external service and re-enters through an explicit
channel or webhook.

### The agent's own configuration file is in its workspace

`mono-agent.config.json` is an ordinary file. When `agent.workspace` contains the
directory holding it, the agent's own file-reading tools can read it like any
other file in the workspace, and Core has no path-scoped deny: policy selects
whole tools by name, and the runtime's own read tool performs the access.

The `personal` template ships `agent.workspace: "."` with
`policy.tools.default: "allow"`, `policy.approvals.default: "allow"`, and
`policy.sandbox.mode: "off"`, so on that template the read is reachable and
auto-approved. What it exposes is operator configuration, not credentials: the
routing topology, the full fallback chain, and the **names** of the environment
variables holding secrets. Secret values are never inlined -- schema paths marked
secret reject literals and only accept `$env` references -- so no secret value is
in the file to read.

An agent has no need to read it. Core injects the resolved `{runtime, model,
effort}` for each attempt as ground truth (see [Runtimes and routing](/runtime/)),
so questions about which model is serving a turn are answerable without it.

If that exposure is not acceptable for your deployment, any of these closes it
today, in increasing order of cost:

- Keep the config outside the workspace. `--config` and `agent.workspace` are
  independent, so the file can live in a parent or sibling directory.
- Set `policy.approvals.default: "ask"` so reads are mediated rather than
  auto-approved.
- Name the runtime's read tool in `policy.tools.deny`, or switch
  `policy.tools.default` to `"deny"` and allow explicitly.
- Select a sandbox, which bounds command execution independently of tool policy.

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
