---
title: "Sandboxed Code Agent (Loopback Only, Deny .env)"
description: "Constrain a local code agent to loopback networking and protect dotenv secrets from writes."
sidebar:
  order: 9
---

This playbook builds a code-reading assistant that can run `Bash` and `NodeRepl` inside the native `srt` sandbox with loopback-only network access and protected secrets, while recalling prior context from local journal memory. Every capability here is `config`-driven — no code required.

On macOS, mono-agent can install the exact pinned SRT runtime into its private user cache; no global `srt` or `PATH` mutation is required. This recipe uses `fallback: "fail-closed"`, so an absent, corrupt, or non-enforcing engine yields `sandbox_unavailable` instead of host execution.

## Who this is for

Security team deploying an internal code assistant.

## Goal

An agent that can read repos and run shell commands or run-scoped JavaScript inside the native `srt` sandbox with loopback-only network access and protected secrets, recalling context from local memory.

## Features used

- [`sandbox.mode`](/tools/sandbox/) — native (`srt`-wrapped commands) vs off
- [`sandbox.network-policy`](/tools/sandbox/) — enforced `none` / `localhost` / `allowlist` / `all`
- [`sandbox.filesystem-scopes`](/tools/sandbox/) — readable/writable roots + deny-write globs
- [`sandbox.fallback`](/tools/sandbox/) — `fail-closed` vs `unsafe-host-process` when `srt` is unavailable
- [`tool-policy.allow-all`](/tools/policy/) — allow-all tools (`["*"]`); the sandbox, not an allowlist, is what constrains the code tools
- [`memory.journal`](/memory/capture-and-recall/) — local journal recall for prior context

## Configuration

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-terra"
  },
  "tools": {
    "allowedTools": ["*"]
  },
  "sandbox": {
    "mode": "native",
    "network": {
      "mode": "localhost"
    },
    "readableRoots": ["."],
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"],
    "fallback": "fail-closed"
  }
}
```

The `denyWrite` globs above are the built-in defaults — listed explicitly here to make the secret-protection contract obvious. Relative `readableRoots`/`writableRoots` entries resolve against the workspace. The matching env vars are `MONO_AGENT_SANDBOX_MODE`, `MONO_AGENT_SANDBOX_NETWORK`, `MONO_AGENT_SANDBOX_READABLE_ROOTS`, `MONO_AGENT_SANDBOX_WRITABLE_ROOTS`, `MONO_AGENT_SANDBOX_DENY_WRITE`, and `MONO_AGENT_SANDBOX_FALLBACK`.

:::caution
Keep `fallback` at `fail-closed`. Setting `fallback: "unsafe-host-process"` plus `unsafeAllowHostProcess: true` lets commands run unsandboxed on the host when `srt` is unavailable. When that fallback is active, mono-agent reports `WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.` Never use that fallback for a security-sensitive deployment.
:::

## Steps

1. `mono-agent init --model pi:openai-codex:gpt-5.6-terra --memory journal`
2. Run `mono-agent sandbox status`, then `mono-agent sandbox setup` on macOS. Setup installs in the private cache and runs the full functional check. Use `mono-agent sandbox check` to re-prove it later.
3. Leave `tools.allowedTools` at the allow-all default (`["*"]`) — under allow-all the code tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash`/`NodeRepl`) are already available, and the **sandbox**, not an allowlist, is what constrains them. Configure `sandbox.mode` native + `network.mode` localhost + the deny-write defaults. (To harden further you *can* still narrow `allowedTools` to a specific set, but it is not what makes this agent safe.)
4. Keep `fallback` at `fail-closed` (do NOT set `unsafe-host-process`).
5. `mono-agent validate --preset code-sandbox`; the `Sandbox` section should be `ok`. If it is `waiting` with `sandbox_unavailable`, `start` will not silently relax the policy. A corrupt managed install never falls back to a `PATH` command.
6. `mono-agent start`, then `mono-agent status`; confirm the sandbox line reports `effective: native`, the `srt` engine present, and `fallback active: no`.
7. Ask the agent to inspect the repo, run a Bash command, and evaluate `const n = 40` followed by `n + 2` through `NodeRepl`; confirm REPL state persists for the run, external network calls are blocked while loopback still works, and it cannot write `.env`.
8. Keep the default `runtime.routeSafety: "uniform"` and every route on Pi when this exact SRT contract must hold everywhere. Explicit `per-route-native` can include provider-owned routes only after acknowledging that the mono-agent roots/network policy does not apply to them.

## Smoke test

:::tip
Ask the agent to read a file, run a Bash command, and use `NodeRepl` twice to produce `42`; confirm success, then ask it to fetch an external URL or write `.env` and confirm both are blocked by the sandbox policy in the run artifact.
:::

## Related

- [Sandbox](/tools/sandbox/)
- [Tool Policy](/tools/policy/)
- [Memory: Capture and Recall](/memory/capture-and-recall/)
- [Runtime: Tools and Guards](/runtime/tools-and-guards/)
- [Observability: Artifacts and Traces](/observability/artifacts-and-traces/)
- [Composer skill](/context/skills/)
