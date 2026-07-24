---
title: "Project MCP"
description: "Configure project-owned MCP servers and the narrow selected-stdio request-context grant without adding a typed module."
sidebar:
  order: 1
---

Model-callable project tools belong in `.mcp.json`, referenced from the agent's
context. An MCP server does not become a typed runtime, channel, memory, state,
trigger, exporter, or sandbox module.

The narrow exception is behavior inseparable from an already selected module's
own private data and lifecycle. That module may offer a bounded tool descriptor
without a new config key; this does not justify creating a module for an
ordinary project or domain tool.

```json
{
  "mcpServers": {
    "project-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/server.mjs"],
      "env": {
        "PROJECT_TOKEN": { "$env": "PROJECT_TOKEN" }
      }
    },
    "local-http": {
      "type": "http",
      "url": "http://127.0.0.1:4319/mcp",
      "headers": {
        "Authorization": { "$env": "LOCAL_MCP_AUTHORIZATION" }
      }
    }
  }
}
```

Secret-bearing environment values and headers use explicit environment
references. Remote servers own their process lifecycle. A configured stdio
server may be started and stopped by the MCP harness, but Core does not turn
MCP into a generic daemon manager.

Ordinary MCP servers receive only that configured stdio environment or HTTP
headers.

## Unified tool names and policy

Core builds one catalog across reserved Core/instruction tools,
selected-module contributions, MCP tools, and channel send tools. A unique
portable non-Core name remains usable as written. Collisions receive stable
kind-and-source-hashed canonical names, and a global or request-local policy
that names an ambiguous raw alias fails with the canonical alternatives. Load
order never selects a winner.

All governed sources pass through agent and request tool policy, Core result
normalization, redaction, and artifact handling. Module effects drive approval
and sandbox eligibility exactly as declared; an effect-free state-local
`RunHistory`, for example, does not require an approval. MCP and channel calls
retain their established external-effect authority.

## Request-context grant

The Personal transcription tool needs the current request's attachment without
accepting an arbitrary local path. This is the sole host-context exception.
Opt in by naming the existing direct stdio transport in agent config:

```json
{
  "context": {
    "mcp": {
      "configPath": "./.mcp.json",
      "requestContextServers": ["transcribe"]
    }
  }
}
```

The field is optional and defaults off. It accepts at most 32 unique names, and
each must resolve to a configured direct `type: "stdio"` transport. A missing
name, duplicate, or HTTP transport fails config validation. This is a transport
check, not a locality check: the configured command can proxy through SSH, a
container, or the network and can forward or exfiltrate everything it receives.

For each call to a selected server, Core supplies immutable
`_meta["com.mono-agent/request-context"]` data with `schemaVersion: 1`:

- current `conversationId` and `runId`;
- the owner-private `attachmentsRoot` and `runOutputDir` for that run;
- `allowedAttachmentPaths` and path/device/inode
  `allowedAttachmentIdentities`; and
- staged `attachments` containing the stable attachment `id`, display `name`,
  `mediaType`, path, device, and inode.

Every `dev` and `ino` value is a canonical unsigned-decimal string such as
`"12345"`, never a JSON number.

The tool selects one `attachments[].id` with the `attachment_id` argument. The
paths describe Core-staged current-request files, never inbound transport paths.
The Personal transcription tool rejects `file_path` by default. A legacy local
path is admitted only beneath one of the bounded, static absolute directories
listed in `TRANSCRIBE_LOCAL_PATH_ROOTS`; that allowlist cannot select Core's
managed attachments root. It is not a fallback for a missing or invalid
`attachment_id`.
Core creates `0700` directories and exclusive, no-follow, regular,
single-link `0600` files, and it removes only the exact device/inode identities
it created. A path-swapped replacement is never unlinked. The host overwrites
the reserved metadata at dispatch, so model tool arguments cannot spoof or
widen it.

Progress from that MCP call is capped at 256 events and 256 KiB of message text,
then request-context paths and configured secrets are redacted before control
characters, whitespace, and the 16 KiB activity limit are normalized. It is
emitted only as transient channel activity. Progress can reset the 120-second
idle timeout but not the 45-minute hard total deadline; a limit violation
cancels the underlying call, and progress is not canonical transcript content.

The grant is per-call metadata, not process-start environment. It provides no
arbitrary path access, channel destination, HTTP-transport MCP authority, durable
continuation, or child-run spawn/observe/cancel capability.

Selected tool results and errors pass through the same request-context path and
configured-secret redactor before model delivery, preview creation, or artifact
offload. Plain nested strings and object keys are covered. Binary, encoded, or
deliberately obfuscated data cannot be recognized reliably.

This contract limits the authority mono-agent supplies; it does not sandbox an
otherwise privileged stdio command. Select a trusted command or place the MCP
process under an independently verified sandbox. One persistent selected
process sees every selected call and can deliberately mix runs or race the
filesystem. Device/inode binding proves Core's routing and fails closed for
accidental or static replacement; it is not cryptographic provenance or
isolation from a malicious same-UID process.

## Current-run output delivery

A granted MCP may write beneath its supplied `runOutputDir` and return one safe
`outputName` basename. A model-visible channel send tool can accept that
basename rather than a path. The channel calls the host-owned
`ChannelSendToolContext.readCurrentRunOutput({ name, maxBytes })`, and Core
performs a stable no-follow read of one regular, single-link file from the
current run only. Core caps the requested read at 25,000,000 bytes and returns a
normalized attachment; it never gives the channel ambient filesystem access.
The tool result may also contain bounded identifiers and metadata, but it must
not contain an absolute-path field.

For example, `TelegramSendFile` accepts exactly one source: inline
`data` plus `filename`, or `output_name` with an optional display filename.
Traversal, absolute paths, symlinks, hard links, identity swaps, cross-run
names, and oversized outputs fail closed.

Cleanup moves a verified entry into a private random claim before deletion and
attempts a no-overwrite restoration if identity changes or deletion fails.
Unsafe or unprovable entries are retained and public host health becomes
degraded; the current public signal is status-only.
Against a malicious same-UID process, source-path relocation can still occur
when safe restoration cannot be proved; the checks are best-effort race
hardening, not an adversarial filesystem sandbox.

Normal completion, failure, and cancellation run this cleanup. `SIGKILL`,
power loss, or a host crash can leave owner-only `0700`/`0600` residue beneath
`.mono-agent/data/core/mcp-runs/<runId>`. Restart deliberately does not infer
staleness from age or PID and does not auto-delete it without a cross-process
lease. Until lease-backed recovery lands before GA, maintenance must first
prove every host for the project is stopped, select exact run ids (never a
root, glob, or age range), and reject any target that is not an owner-owned,
non-symlink directory before removing that explicit run only.

The Personal source-beta proof exercises its real `transcribe` server with a
staged audio attachment id, concurrent-call isolation, bounded progress, an
output basename, and host-bound delivery. It also exercises metadata spoofing,
link/swap/traversal, cleanup, cross-request, timeout, cancellation, and output
bound negatives. A static environment shim or arbitrary-path transcription
call is not equivalent.

The public Personal scaffold contains a sanitized `.mcp.json` and agent config
reference. Its harmless example uses the ordinary default-off path; consumer
migration must explicitly name and prove any request-context server.

For documentation lookup itself, register the separate
[documentation MCP companion](/tools/documentation-mcp/) in the coding client,
not in the running agent.
