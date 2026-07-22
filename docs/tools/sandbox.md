---
title: "Sandbox"
description: "Constrain Pi-owned commands with filesystem and network policy and control unavailable-engine fallback behavior."
sidebar:
  order: 5
---

For Pi-native agents, the sandbox confines mono-agent-owned commands by wrapping them with `srt` (the native sandbox runtime) and a generated settings file: a filesystem scope (readable/writable roots, deny-write globs), a network policy, and a fallback for when the sandbox engine is unavailable. This includes both `Bash` commands and the child process behind `NodeRepl`. This page covers the `sandbox` config block, the matching `MONO_AGENT_SANDBOX_*` env vars, and the monotonic merge that lets request-scoped policies tighten — but never widen — the configured baseline.

The whole block is **config** coverage backed by `@mono-agent/runtime-adapter`. Under the default `runtime.routeSafety: "uniform"`, a non-Pi route that cannot represent the configured SRT policy fails closed. Explicit `per-route-native` allows a mixed chain only with route-local contracts: Pi keeps this exact policy, while Claude/Codex/OpenCode use their documented provider-native safety and do not pretend the SRT roots/network rules apply. Use Pi (including `pi:opencode-go:*`) whenever every attempted route must enforce the mono-agent policy.

## Quick reference

```json
{
  "sandbox": {
    "mode": "native",
    "network": { "mode": "none", "allowlist": [] },
    "readableRoots": ["."],
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"],
    "fallback": "fail-closed",
    "unsafeAllowHostProcess": false
  }
}
```

| Key | Type / values | Default | Env var |
| --- | --- | --- | --- |
| `sandbox.mode` | `native` (srt-wrapped) \| `off` | `native` | `MONO_AGENT_SANDBOX_MODE` |
| `sandbox.network.mode` | `none` \| `localhost` \| `allowlist` \| `all` | `none` | `MONO_AGENT_SANDBOX_NETWORK` |
| `sandbox.network.allowlist` | string[] of host suffixes (`*.suffix` wildcards) | `[]` | `MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST` |
| `sandbox.readableRoots` | string[] of paths | `["."]` (workspace) | `MONO_AGENT_SANDBOX_READABLE_ROOTS` |
| `sandbox.writableRoots` | string[] of paths | `["."]` (workspace) | `MONO_AGENT_SANDBOX_WRITABLE_ROOTS` |
| `sandbox.denyWrite` | string[] of globs | see defaults below | `MONO_AGENT_SANDBOX_DENY_WRITE` |
| `sandbox.fallback` | `fail-closed` \| `unsafe-host-process` | `fail-closed` | `MONO_AGENT_SANDBOX_FALLBACK` |
| `sandbox.unsafeAllowHostProcess` | boolean | `false` | `MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS` |

The engine id is `srt` (the only built-in engine). On macOS, mono-agent can install and own the pinned runtime itself; a global `srt` is not required.

Manage and prove it with:

```bash
mono-agent sandbox status
mono-agent sandbox setup   # macOS: private per-user cache, then full check
mono-agent sandbox check
mono-agent validate --preset code-sandbox
```

Managed setup installs exact `@anthropic-ai/sandbox-runtime` 0.0.64 dependencies from the checked-in lock into an owner-only version/hash directory under the user's cache. It does not modify `PATH`, global npm packages, system packages, or another user's files. Installation uses a private identity-bound lock, stages with scripts disabled, verifies the complete tree against an independently pinned digest, and atomically promotes it. The install marker records that trusted digest but cannot define it, so rewriting the tree and marker still fails closed. An unsafe/corrupt existing tree is quarantined and repaired only inside that managed cache.

The managed cache must be on a local filesystem with working BSD advisory file
locks. Network-mounted cache overrides such as NFS or CIFS are unsupported for
managed setup because their lock semantics can differ across clients.

:::caution[Managed-SRT 0.9 lock migration]
The first managed-SRT setup under 0.9 is an offline protocol migration when a
0.8-or-earlier process may still run for the same user. Stop all such agents
and setup commands first, and keep them stopped through the first 0.9 sandbox
setup. Older versions do not acquire 0.9's permanent OS-level guard, so
mixed-version setup or repair is unsupported.
:::

`v0.9.0` also began writing v2 directory install locks whose owner records carry
process incarnation identity. The bounded, fail-closed reader for owner-only v1
files is intentionally retained indefinitely: an upgrade can skip releases and
later encounter a file left by a crashed v0.8-or-earlier installer. New writes
never use the v1 format. This permanent compatibility decision is recorded in
the canonical [deprecation tracker](/reference/deprecations/).

Selecting managed SRT during guided init always runs this idempotent managed
setup and its functional postcondition, even when a compatible external `srt`
already exists on `PATH`. External SRT remains a status/check and runtime
compatibility path; it does not satisfy the guided managed-install choice.

`status` distinguishes managed, compatible external, absent, corrupt, and unsupported states. `check` proves real enforcement rather than trusting `--version`: allowed workspace read/write, sibling-secret read denial, `.env` and out-of-root write denial, localhost access, and denial of a non-allowlisted hostname mapped to that same local server. `validate` reports the `Sandbox` section as `ok` only after the effective engine passes its functional proof. Missing or corrupt fail-closed SRT reports `waiting`/`sandbox_unavailable`, never host execution.

## Mode

- **`native`** — every sandboxed command is rewritten to `srt --settings <generated-file> <command> ...`. The generated settings file encodes the network and filesystem policy below. The run-scoped `NodeRepl` child is prepared through this same path, so evaluated JavaScript does not bypass the policy. Under `network.mode: "all"` the rewrite instead drives SRT through its library entry (see below) because the SRT CLI always starts domain filtering.
- **`off`** — commands run unwrapped on the host. Equivalent to omitting the `sandbox` block.

## Network policy

`sandbox.network.mode` controls egress from inside the sandbox:

| `network.mode` | Behavior |
| --- | --- |
| `none` | No network access (default). |
| `localhost` | Loopback only. |
| `allowlist` | Only hosts matching `network.allowlist`. |
| `all` | Unrestricted egress; filesystem scopes and deny-write globs stay fully enforced. |

:::note[How `all` is enforced]
The pinned SRT CLI requires a network block in its settings schema and always
starts its filtering proxy when one is present, so `all` launches SRT through
its library entry instead: a small runner shipped with mono-agent imports the
identity-verified SRT tree and initializes it without a domain filter — SRT's
documented unrestricted-network mode, with every filesystem rule intact and no
proxy started. This needs a launch that can host the library (the managed macOS
install or an explicit `node`+`cli.js` pair); a bare external `srt` binary
fails closed. Before the first `all` command runs, mono-agent proves the embed
path enforces the filesystem policy *and* that loopback egress genuinely
succeeds, and pins the library entry's identity like the CLI launch.

macOS system DNS is reopened explicitly: the runner adds the mDNSResponder
socket and `/etc`+`/var` symlink-metadata rules to the profile, and the
settings allow reading `resolv.conf` — the enforcement proof asserts both, so
name resolution working inside the sandbox is a proven property, not a hope.
:::

Allowlist entries are matched as host suffixes. A leading `*.` is a wildcard suffix — `*.example.com` matches `api.example.com`. There is **no CIDR and no port syntax**; entries are hostnames/suffixes only. Bare `*`, IPv6 literals (including `::1`), whitespace, paths, and port-bearing entries are rejected. Localhost policy uses the enforceable `localhost`/IPv4 loopback representation.

Loopback is never implicit in `allowlist` mode. Enabled app-owned ask tools need `127.0.0.1` or `localhost` for their interaction bridge, in addition to `slack.com` for `SlackSendMessage` and `api.telegram.org` (or the configured `apiRoot`) for Telegram tools. Mono-agent scopes SRT's coarse loopback connect/bind capability to the trusted adapter-send child; ordinary Bash and project MCP commands do not gain loopback binding from that entry. Use network mode `localhost` only when every sandboxed command intentionally needs local networking (including SRT's loopback binding capability). The adapter destination allowlist still applies independently. `mono-agent validate` reports a `waiting` Tools & MCP section with the missing host before a run.

```json
{
  "sandbox": {
    "mode": "native",
    "network": { "mode": "allowlist", "allowlist": ["*.githubusercontent.com", "registry.npmjs.org"] }
  }
}
```

```bash
MONO_AGENT_SANDBOX_NETWORK=allowlist
MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST=*.githubusercontent.com,registry.npmjs.org
```

## Filesystem scopes

- **`readableRoots`** / **`writableRoots`** — directories the sandboxed process may read from / write to. Relative entries (like `"."`) resolve against the workspace root. Both default to the workspace. SRT starts from a global read denial, then reopens these roots plus a reviewed immutable OS/runtime set and narrowly derived executable dependencies; user-managed toolchain data outside those roots must be declared explicitly.
- **`denyWrite`** — write-deny globs applied on top of `writableRoots`. Relative globs always resolve against the policy workspace root, even when a command runs from a nested `cwd`. The defaults protect secrets and git internals:

```json
{
  "sandbox": {
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"]
  }
}
```

:::note
If you set `denyWrite` yourself, you replace the defaults — include the four entries above (or merge them in) if you still want that protection.
:::

## Fallback when the engine is unavailable

If `mode: "native"` but no SRT engine passes its functional proof, the `fallback` decides what happens:

- **`fail-closed`** (default) — the command is rejected with a `sandbox_unavailable` error. Nothing runs unsandboxed.
- **`unsafe-host-process`** — the command runs **unwrapped on the host**. This requires **both** `fallback: "unsafe-host-process"` **and** `unsafeAllowHostProcess: true`. Setting `fallback` to `unsafe-host-process` without the explicit `unsafeAllowHostProcess: true` is a config error.

```json
{
  "sandbox": {
    "mode": "native",
    "fallback": "unsafe-host-process",
    "unsafeAllowHostProcess": true
  }
}
```

:::caution
The `unsafe-host-process` fallback runs tool commands directly on the host with no isolation if the sandbox engine is missing. When it is active, mono-agent reports: `WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.` Use it only in trusted, controlled environments (e.g. CI you own end to end). Prefer `fail-closed` for anything handling untrusted input or running untrusted code.
:::

`mono-agent start` does not silently relax a fail-closed policy. It records the effective sandbox state at startup; `mono-agent status` prints `effective`, `engine`, `fallback`, and whether the fallback is active. For a fail-closed missing engine, sandboxed commands fail with `sandbox_unavailable`. For an unsafe fallback, `start`/`status` include the unsafe warning above so the operator can see that filesystem roots and `denyWrite` entries are not protecting the host process.

Runtime resolution prefers the managed macOS install and re-hashes its complete
tree against the independent release digest before each command. A
present-but-corrupt managed install fails closed and never downgrades to a
`PATH` command. A compatible external `srt` is considered only when the managed
path is absent: it is resolved to a trusted canonical absolute file, functionally
proved, and pinned by path, filesystem identity, size, and SHA-256. Any later
PATH shadow or same-path replacement fails closed. SRT executables and managed
install roots may not overlap a configured writable root. Negative availability
checks are retried, so `sandbox setup`/repair can take effect without restarting
the agent.

### Pre-sandbox Node launcher threat model

The managed SRT CLI is itself launched by Node before SRT can enforce the
configured filesystem policy. Managed setup and status therefore require the
selected Node path to be a current-user- or root-owned, non-symbolic regular file
that is executable, has no setuid/setgid privilege bits, is not
group/world-writable, and has exactly one hard link. The single-link rule is
deliberate even though a hard link does not, by itself, grant another OS principal
write access.

SRT confines the later workload by pathname while that workload still runs as
the same user. For a user-owned Node executable, an otherwise invisible second
hard link could name the same owner-writable inode from inside a configured
writable root. The workload could then modify the launcher through that alias
even though mono-agent proved that the selected canonical path was outside every
writable root. There is no portable API to enumerate every hard-link alias.
Path/device/inode/hash revalidation detects an earlier byte change, but it cannot
prove alias placement or eliminate the final revalidation-to-execution window.
Ownership and mode checks alone are therefore insufficient for this path-based
sandbox boundary.

The rule is installation-manager agnostic: NVM, Homebrew Cellar, system Node,
and hosted toolcache layouts are all compatible when the selected executable is
single-link and passes the owner/mode checks. If setup or status reports multiple
hard links, select or reinstall a single-link Node installation rather than
copying or relinking the binary ad hoc. The private managed SRT marker, lockfile,
CLI, package manifest, and dependency tree remain owner-only and single-link as
a separate cache-integrity invariant. Node+CLI resolution fails closed on Windows
or another platform without POSIX uid ownership checks; managed setup remains a
macOS-only capability.

## Monotonic merge

When a request supplies its own sandbox policy, it is merged with the configured baseline so the result is **never more permissive** than the configured policy. A request-scoped policy can only tighten — it can never widen filesystem access or re-enable host execution:

- `readableRoots` / `writableRoots` are **intersected** (the request can shrink, not extend, the roots).
- `denyWrite` globs are **unioned** (more denials, never fewer).
- `network` access can only narrow.
- `fallback` collapses to `fail-closed` if either side is `fail-closed`.
- `unsafeAllowHostProcess` stays on only if **both** sides have it on.

This merge is **auto** (the harness performs it). Constructing request-scoped policies is a **code** path — see [Programmatic](/programmatic/).

## Runtime boundary

:::caution
Provider-owned tool loops do not silently bypass this policy. In `uniform` mode,
validation/runtime reject a route that cannot represent the common contract. In
explicit `per-route-native` mode, doctor prints every route contract and warns
that mono-agent readable/writable roots, deny-write globs, and network rules do
not project onto non-Pi routes. Pi retains SRT; Claude uses provider-native
controls with representable tool restrictions; direct Codex/OpenCode use native
safety plus exact allow-all. Unsupported capabilities skip the route instead of
being removed silently. Static trigger routes and dynamic overrides are checked
at the same boundary.
:::

## Related

- [Tool policy](/tools/policy/) — allow/deny which tools the agent can call at all.
- [MCP](/tools/mcp/) — external tool servers.
- [Playbook: sandboxed code agent](/playbooks/sandboxed-code-agent/) — an end-to-end config for an agent that runs untrusted code.
- [Environment variables](/config/env-vars/) — full `MONO_AGENT_*` reference.
