---
title: "Migrate v0 to the v1 source beta"
description: "Field map, data decisions, rehearsal checklist, rollback triggers, and later cutover gates for moving a mono-agent consumer to v1."
sidebar:
  order: 1
---

The v1 source beta is a build and migration-rehearsal target. It proves the new
configuration, dependency closure, packed artifacts, first turn, and bounded
data checks in an isolated copy. It does not publish packages, restart a live
consumer, register or remove a live service, write the canonical BuJo root, run
a production soak, or retire v0.

There is no v0 config parser. Author the v1 project explicitly and review every
line against the old consumer.

## Surface map

| v0 concern | v1 authority | Migration action |
| --- | --- | --- |
| Runtime/provider/model block | `runtimes.<id>` plus `routing` in `mono-agent.config.json` | Install each selected runtime as a direct dependency. Give every instance a stable map key and its exact `$use` package. Keep models runtime-owned. |
| Channel configuration | `channels.<id>` | Select only required channel packages. Preserve allowlists, destinations, listener policy, and secrets as explicit environment references. |
| Memory mode/backend | Singleton `memory` slot | Adopt BuJo through `@mono-agent/memory-local` only after the copy rehearsal below. Lite and journal are not converted automatically. |
| Transcript, runs, delivery indexes, discovery | Singleton `state` slot | Start a new `@mono-agent/state-local` store. Do not import v0 conversation or run history. |
| Schedules and long prompts | `@mono-agent/trigger-cron` plus `cron/*.md` | Move schedules to selected trigger config and keep job prompts in Markdown. References use stable runtime and channel instance ids. |
| Tracing/export | `observability.exporters.<id>` | Select `@mono-agent/exporter-otlp` explicitly. Keep sensitive content export disabled unless separately reviewed. |
| Sandbox | `policy.sandbox` | Use `{"mode":"off"}` or select the sandbox package explicitly. Do not translate old implicit defaults. |
| Model-callable project tools | `.mcp.json` plus optional `context.mcp.requestContextServers` | Use standard MCP configuration. Leave request context off unless an audited direct stdio transport needs current-request staged attachments, per-run output, and transient progress; missing, duplicate, and HTTP-transport selections are invalid. A stdio command may proxy remotely, so selection is not proof of locality. There is no generic host-grant or plugin plane. |
| Instructions, identity, operational know-how | `agent.instructions` and `skills/` | Consolidate the old identity/soul pair into one instructions source. Keep reusable workflows as selected skills. |
| Agent foreground lifecycle | `@mono-agent/core` public API or `mono-agent start` | Validate the exact project before start. A service manager is optional. |
| Terminal and browser UI | Standalone TUI and web products | Configure, install, and start independently. Neither belongs in agent config. |
| macOS boot lifecycle | Separate service-macos config | Inspect and plan independently. Applying or removing a service always requires explicit mutation authority and a current plan fingerprint. |
| Documentation search | Coding-client `mcpServers` registration | Register docs-mcp independently. It is not an agent capability. |
| Independent collectors/watchdogs | Project or host operations | Keep their lifecycle outside Core and deliver work through an explicit configured channel or webhook. |

## Explicit cuts

Do not copy these v0 surfaces into a v1 project:

- A2A and its provider/consumer state;
- WhatsApp;
- Supermemory;
- the generic orchestrator extra;
- continuations, continuation host grants, generic MCP host grants, and every
  child-run spawn/observe/cancel capability;
- conversational self-configuration and `tui --configure`;
- historical backfill/resend;
- lite and journal memory modes;
- the second `context.soulPath` persona file;
- the `append-host-summary` memory write mode; and
- generic plugin registries, package self-registration, and path plugins.

Archive any needed evidence with the retained v0 copy. Absence from v1 is an
intentional product decision, not a migration omission.

## Data disposition

| Data | Source-beta treatment |
| --- | --- |
| BuJo root, SQLite identity, embedding metadata, unresolved intake | Back up, then rehearse against a complete copy. BuJo is the only v0 application state intended for later adoption. |
| Lite or journal memory | Do not convert automatically. Migrate separately to BuJo or keep the consumer on frozen v0. |
| Conversation history and run artifacts | Do not import. Retain the v0 copy read-only through the future rollback window. |
| Pi/Claude/Codex/OpenCode native sessions | Do not import. Start new v1 runtime sessions. |
| Web conversations and browser product state | Do not import. The v1 web product owns a separate data directory. |
| A2A and continuation records | Archive with v0; never import. |
| Logs and transient caches | Do not import beyond the existing operations retention policy. |

New v1 transcript, run, discovery, exporter, and web paths must be distinct
from v0. Only a separately approved live cutover may point memory-local at the
audited canonical BuJo directory.

## Scaffold substitutions are not consumer identity

The public `personal` template is a safe, runnable migration fixture, not an
exact export of any live Personal Agent. Its generated `AGENTS.md`,
project-local Pi auth path, identity-derived agent/model/discovery/project ids,
and harmless `project-status` MCP server are deliberate generic substitutions.

Before any consumer cutover, replace those values with the audited consumer
instructions, credential location, stable ids, and real MCP definitions. In
particular, the scaffold's `project-status` tool is not evidence that a live
consumer's transcription, research, or other private tools were migrated.
Review the resulting `.mcp.json` and config as consumer-specific security
boundaries.

The Personal transcription consumer is the one admitted request-context case.
Its config explicitly lists the real direct stdio transport in
`context.mcp.requestContextServers`. The server accepts `attachment_id`
selecting one staged `attachments[].id`, not an arbitrary source path; reads
only an exact path/device/inode allowlist whose device and inode values are
canonical unsigned-decimal strings; writes beneath the supplied current-run
output directory; emits bounded transient progress; and returns an `outputName`
basename plus, at most, bounded identifiers and metadata for host-bound channel
delivery. The result contains no absolute-path field. `file_path` is
default-deny; legacy local paths require a bounded static
`TRANSCRIBE_LOCAL_PATH_ROOTS` absolute-directory allowlist that cannot select
the managed attachments root. Do not migrate the old process-start request
environment or an absolute-path send-tool input.

## Source rehearsal

Perform this work in a copy while v0 remains the unchanged live source.

1. Record the v0 version, config digest, installed dependency closure, process
   identity, service definition, ports, durable paths, and known-good rollback
   command.
2. Make a complete, restorable BuJo backup. Rehearse on a copy with owner-only
   directories and regular, single-link, owner-owned `0600` database files.
3. Scaffold the closest v1 template: `minimal`, `personal`, or
   `multi-runtime`.
4. Replace generated examples with explicitly reviewed consumer values. Keep
   TUI, web, service-macos, and docs-mcp out of the agent config. If
   `context.mcp.requestContextServers` is present, prove every name is a
   required direct stdio transport, audit whether its command proxies or uses
   the network, and prove that omitted, missing, duplicate, and HTTP-transport
   selections fail as designed.
5. Confirm every `$use` package is an exact direct production dependency and
   appears in the lockfile. Remove every unselected runtime, channel, trigger,
   memory, state, exporter, and sandbox dependency.
6. Validate the strict config and generated schema. Treat unknown fields,
   wrong-kind modules, missing references, incompatible API versions, inline
   secrets, and missing lockfile evidence as blockers.
7. Build and pack the complete 23-package source candidate. Clean-install the
   chosen project closure from those tarballs; do not substitute workspace
   links, an unpublished checkout, or a mutable dist-tag.
8. Execute a bounded first turn against a non-live endpoint and destination.
   Prove the selected runtime route, state append, delivery behavior, and clean
   stop. For Personal transcription, use a real staged audio attachment and
   prove attachment-id resolution, concurrent-call isolation, transient
   progress, current-run output basename delivery, and rejection of metadata
   spoofing, traversal, symlink/hard-link or identity swaps, cross-run access,
   replacement cleanup, oversize output/progress, timeout, and cancellation.
9. For the Personal fixture, prove both memory first-run states on the copied
   root:
   - a successful initialization permanently leaves the canonical marker in
     the `initialized:<uuid>` state; and
   - an `initializing:<uuid>` marker fails closed and remains byte-for-byte
     unchanged for inspection.
10. Compare representative BuJo vector and full-text recall, capture,
    duplicate admission, forget preview, and rebuild results against v0. Any
    format mutation, integrity failure, missing behavior, or unresolved
    lite/journal dependency blocks migration.
    Historical v0 canonical rows can contain timezone-bearing ISO timestamps
    without milliseconds or with explicit offsets; v1 preserves those copied
    database bytes and canonicalizes them only in returned API records. New
    records remain strict, and malformed stored timestamps block adoption.
11. Exercise product boundaries independently: operator discovery, TUI/web
    connection, service-macos read-only inspect/plan, and docs-mcp client
    registration. Do not apply host mutations.
12. Save the exact source SHA, tarball digests, dependency closure, config
    digest, rehearsal paths, proof output, and rollback decision.

### Reproducible source proof

Run the complete proof only from a clean committed candidate on a supported
Node.js version. Public CI records the minimum Node.js 22.19.0 proof:

```bash
pnpm run verify:v1-system
```

The verifier refuses a dirty or moving source tree. It creates an owner-private
temporary clone at the exact source SHA, performs a frozen offline install,
builds and packs all 23 packages there, clean-installs the three scaffold
closures from those tarballs, and executes their bounded first-turn scenarios.
It never deletes caller-repository build output.

The final stdout line is machine-readable
`mono-agent.v1-system-proof.v1` evidence. Retain it with the source SHA, exact
Node result, ordered tarball SHA-256 and SHA-512 integrity records, artifact
set digest, installed closure digest, original rendered-config digests, and
combined closure/config digest. The verifier rehashes the artifacts after the
scenario, proves the source stayed clean at the same SHA, and removes its
branded temporary workspace before reporting success.

## First-run memory safety

The permanent memory marker is durable state, not a disposable lock file. A new
root creates the canonical marker exclusively and changes the same inode from
`initializing:<uuid>` to `initialized:<same-uuid>` only after durable
generation publication.

Do not rename, replace, unlink, chmod by path, or manually edit the marker.
Malformed, permissive, multi-link, swapped, missing-after-read, or in-flight
states fail closed. Remediation is an explicit backup/copy/permission operation
outside memory-local.

## Later live cutover

This section is a gate checklist, not authority to perform the work.

Before a consumer cutover:

- install the exact registry-verified beta associated with the reviewed source
  SHA;
- complete package publication, clean-install, security, provenance, and
  migration gates;
- repeat the BuJo audit, backup, copy rehearsal, recall comparison, capture,
  duplicate, forget-preview, and rebuild proofs;
- prepare a separately named shadow service with separate ports and delivery
  disabled;
- prepare distinct v1 state, discovery, exporter, and web directories;
- inspect and fingerprint the service plan without expanding secrets;
- prove the v0 rollback artifact can still start and identify itself; and
- obtain explicit authorization for that one consumer and lifecycle target.

Cut over at a session boundary. Stop and prove death of the old process before
enabling the replacement's external consumption. Prove exact version, config,
process identity, channels, schedules, memory, state, and bounded health before
starting the observation window. Personal Agent and the active A8C Assistant
are separate migrations with separate rollback proofs and 24-hour soaks.

## Rollback

Rollback immediately on:

- duplicate Telegram or Slack consumption;
- memory corruption, record loss, or an unproved format mutation;
- unprovable process or package identity;
- authentication failure hidden by fallback;
- a healthy status while the service is unavailable;
- a missed schedule without an explicit failure record;
- a crash loop; or
- secret exposure.

Stop and prove death of v1, audit memory, and restore the complete pre-cutover
backup only if the format or records require it. Then load retained v0 and
prove its version, config, process, channels, and health. Record the reason and
preserve the failed v1 evidence. Do not delete the old project, service
definition, config, or backups until the separately approved rollback window
has closed.
