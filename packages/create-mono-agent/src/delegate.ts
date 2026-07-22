import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";

/**
 * npm's `create-*` convention treats arguments as init options. Keep the
 * separately exposed `mono-agent` bin byte-for-byte compatible, while a bare
 * `create-mono-agent` (or one followed directly by flags) enters init.
 */
export function delegatedCliArgs(invocationPath: string | undefined, args: readonly string[]): readonly string[] {
  const invocation = invocationPath === undefined ? "" : basename(invocationPath);
  if (invocation === "create-mono-agent" && (args.length === 0 || args[0]?.startsWith("-") === true)) {
    return ["init", ...args];
  }
  return args;
}

/**
 * The subset of `NodeJS.Process` the delegator touches, named so the wiring is
 * unit-testable with a fake process.
 */
export interface DelegatorProcess {
  readonly pid: number;
  exitCode?: string | number | null | undefined;
  on(event: NodeJS.Signals, listener: () => void): unknown;
  removeAllListeners(event: NodeJS.Signals): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  exit(code?: number): never;
  readonly stderr: { write(chunk: string): unknown };
}

/**
 * Signals the terminal delivers to the ENTIRE foreground process group. Because
 * the delegated child is spawned into this same group (inherited stdio, not
 * detached), it already receives these directly — so the shim must NOT forward a
 * second copy, which would land on a child that has already removed its own
 * handler and started an async shutdown, hard-killing it mid-teardown (no channel
 * teardown, no trace flush, no memory-DB close). The shim installs inert handlers
 * only, to stay alive until the child's own graceful shutdown drives our exit.
 */
const GROUP_DELIVERED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGHUP"];

/**
 * Wires a spawned agent-app CLI child to the shim process so exit status and
 * shutdown are byte-identical to invoking agent-app's bin directly:
 *
 * - SIGINT/SIGHUP: inert keep-alive handlers (the group already delivered them to
 *   the child); we wait for the child's graceful exit rather than re-signalling.
 * - SIGTERM: forwarded once — a targeted `kill <shim-pid>` reaches only the shim,
 *   so the child needs it relayed to shut down gracefully.
 * - child exit by code: mirror the code.
 * - child exit by signal: mirror it by re-raising on ourselves, first removing our
 *   own handler for that signal so the re-raise actually terminates us (otherwise
 *   our keep-alive handler catches it and we'd exit 0 instead of 128+signum).
 */
export function delegateSignals(child: Pick<ChildProcess, "on" | "kill">, proc: DelegatorProcess): void {
  for (const signal of GROUP_DELIVERED_SIGNALS) {
    proc.on(signal, () => {
      // Intentionally inert: the child owns the shutdown; we await its exit.
    });
  }
  proc.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  child.on("error", (error: Error) => {
    proc.stderr.write(`mono-agent: failed to launch the @mono-agent/agent-app CLI: ${error.message}\n`);
    proc.exitCode = 1;
  });

  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal !== null) {
      proc.removeAllListeners(signal);
      proc.kill(proc.pid, signal);
      return;
    }
    proc.exit(code ?? 0);
  });
}
