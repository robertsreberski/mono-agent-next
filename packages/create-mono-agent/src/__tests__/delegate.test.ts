import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { delegatedCliArgs, delegateSignals } from "../delegate.js";
import type { DelegatorProcess } from "../delegate.js";

/** Minimal fake of the spawned child: records `.on` listeners and `.kill` calls. */
class FakeChild {
  readonly killed: NodeJS.Signals[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "error") {
      this.errorListeners.push(listener as (error: Error) => void);
    } else if (event === "exit") {
      this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    }
    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }

  asChild(): Pick<ChildProcess, "on" | "kill"> {
    return this as unknown as Pick<ChildProcess, "on" | "kill">;
  }
}

/** Minimal fake of `process` capturing signal wiring and exit/kill decisions. */
class FakeProcess implements DelegatorProcess {
  readonly pid = 4242;
  exitCode: number | null | undefined = undefined;
  readonly killed: { pid: number; signal: NodeJS.Signals }[] = [];
  readonly removed: NodeJS.Signals[] = [];
  readonly exited: number[] = [];
  readonly stderrChunks: string[] = [];
  readonly stderr = { write: (chunk: string) => this.stderrChunks.push(chunk) };
  private readonly handlers = new Map<NodeJS.Signals, (() => void)[]>();

  on(event: NodeJS.Signals, listener: () => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  removeAllListeners(event: NodeJS.Signals): this {
    this.removed.push(event);
    this.handlers.delete(event);
    return this;
  }

  kill(pid: number, signal: NodeJS.Signals): true {
    this.killed.push({ pid, signal });
    return true;
  }

  exit(code?: number): never {
    this.exited.push(code ?? 0);
    // Tests treat exit as terminal but must keep running, so throw a sentinel the
    // caller swallows rather than actually exiting the test process.
    throw new ExitSignal();
  }

  emitSignal(signal: NodeJS.Signals): void {
    for (const listener of this.handlers.get(signal) ?? []) {
      listener();
    }
  }
}

class ExitSignal extends Error {}

function wire(): { child: FakeChild; proc: FakeProcess } {
  const child = new FakeChild();
  const proc = new FakeProcess();
  delegateSignals(child.asChild(), proc);
  return { child, proc };
}

describe("delegateSignals", () => {
  it("does NOT re-forward group-delivered SIGINT/SIGHUP to the child", () => {
    const { child, proc } = wire();
    proc.emitSignal("SIGINT");
    proc.emitSignal("SIGHUP");
    expect(child.killed).toEqual([]);
  });

  it("forwards a targeted SIGTERM to the child exactly once", () => {
    const { child, proc } = wire();
    proc.emitSignal("SIGTERM");
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("mirrors the child's exit code when it exits normally", () => {
    const { child, proc } = wire();
    expect(() => child.emitExit(3, null)).toThrow();
    expect(proc.exited).toEqual([3]);
    expect(proc.killed).toEqual([]);
    expect(proc.removed).toEqual([]);
  });

  it("mirrors code 0 for a graceful (Ctrl-C) shutdown that resolves to 0", () => {
    const { child, proc } = wire();
    // Ctrl-C: the child received SIGINT from the group, shut down, and exited 0.
    expect(() => child.emitExit(0, null)).toThrow();
    expect(proc.exited).toEqual([0]);
  });

  it("re-raises a signal death AFTER removing its own handler (so 128+signum, not 0)", () => {
    const { proc, child } = wire();
    child.emitExit(null, "SIGKILL");
    // Must remove the handler BEFORE re-raising, else the keep-alive handler would
    // swallow it and the shim would exit 0.
    expect(proc.removed).toEqual(["SIGKILL"]);
    expect(proc.killed).toEqual([{ pid: proc.pid, signal: "SIGKILL" }]);
    expect(proc.exited).toEqual([]);
  });

  it("reports a spawn error to stderr and sets exitCode=1", () => {
    const { child, proc } = wire();
    child.emitError(new Error("ENOENT"));
    expect(proc.exitCode).toBe(1);
    expect(proc.stderrChunks.join("")).toContain("failed to launch the @mono-agent/agent-app CLI: ENOENT");
  });

  it("keeps the SIGINT handler installed until an exit removes nothing on a clean code exit", () => {
    const { proc } = wire();
    const spy = vi.spyOn(proc, "removeAllListeners");
    proc.emitSignal("SIGINT"); // inert, no throw
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("delegatedCliArgs", () => {
  it("starts init for the create bin, including direct init flags", () => {
    expect(delegatedCliArgs("/tmp/node_modules/.bin/create-mono-agent", [])).toEqual(["init"]);
    expect(delegatedCliArgs("/tmp/node_modules/.bin/create-mono-agent", ["--preset", "starter", "--yes"]))
      .toEqual(["init", "--preset", "starter", "--yes"]);
  });

  it("preserves the mono-agent bin and explicit create subcommands", () => {
    expect(delegatedCliArgs("/tmp/node_modules/.bin/mono-agent", [])).toEqual([]);
    expect(delegatedCliArgs("/tmp/node_modules/.bin/create-mono-agent", ["validate", "--json"]))
      .toEqual(["validate", "--json"]);
  });
});
