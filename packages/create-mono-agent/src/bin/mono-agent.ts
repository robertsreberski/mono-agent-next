#!/usr/bin/env node
import { spawn } from "node:child_process";

import { delegatedCliArgs, delegateSignals } from "../delegate.js";
import { resolveAgentAppCliEntry } from "../resolve-agent-app-cli.js";

/**
 * Delegating bin for the `create-mono-agent` installer. Both of its bin names
 * (`create-mono-agent` and `mono-agent`) point here. It owns no CLI logic of its
 * own: it locates `@mono-agent/agent-app`'s `mono-agent` CLI entry and runs it in a
 * child process with the same args and inherited stdio, so behaviour — output,
 * interactive shutdown, and exit status — is byte-identical to calling
 * `@mono-agent/agent-app`'s own bin directly.
 *
 * Why a child process instead of importing `runCli` in-process: agent-app's
 * `dist/cli.js` auto-runs the CLI when it detects it is the entry module (by
 * `argv[1]` basename), which is exactly what a bin symlink named `mono-agent`
 * looks like under an npm/npx global install. Importing it here would risk a
 * double-run (the auto-run guard AND an explicit call) on some install layouts,
 * and avoiding that would require agent-app to grow a side-effect-free entry —
 * widening its surface. Spawning agent-app's real bin keeps this package pure
 * delegation with zero agent-app changes and one deterministic execution path.
 *
 * Signal/exit fidelity is delegated to `delegateSignals` (see there): the child
 * shares this process group, so Ctrl-C already reaches it; the shim must NOT
 * re-forward group-delivered signals (that would hard-kill a child mid-shutdown),
 * only relay a targeted SIGTERM, and mirror the child's exit code/signal exactly.
 */
const cliEntry = resolveAgentAppCliEntry();
const args = delegatedCliArgs(process.argv[1], process.argv.slice(2));
const child = spawn(process.execPath, [cliEntry, ...args], { stdio: "inherit" });
delegateSignals(child, process);
