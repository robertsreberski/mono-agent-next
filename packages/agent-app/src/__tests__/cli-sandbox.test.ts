import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSandboxCommand, type SandboxCommandDependencies } from "../cli.js";

const READY_STATUS = {
  state: "ready" as const,
  source: "managed" as const,
  version: "0.0.64" as const,
  installRoot: "/Users/example/Library/Caches/mono-agent/tools/srt/0.0.64/hash",
  nodePath: "/usr/local/bin/node",
  cliPath: "/cache/srt/dist/cli.js",
  message: "Managed SRT 0.0.64 is integrity-verified.",
};

const CHECK = {
  status: READY_STATUS,
  checks: [
    { id: "engine" as const, ok: true, detail: "SRT initialized." },
    { id: "outside-write-denied" as const, ok: true, detail: "Outside write denied." },
  ],
};

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dependencies(overrides: Partial<SandboxCommandDependencies> = {}): SandboxCommandDependencies {
  return {
    status: vi.fn(async () => READY_STATUS),
    setup: vi.fn(async () => ({ installed: true, repaired: false, status: READY_STATUS, check: CHECK })),
    check: vi.fn(async () => CHECK),
    ...overrides,
  };
}

describe("mono-agent sandbox", () => {
  it("reports read-only managed status with source, cache, and detail", async () => {
    const deps = dependencies();
    await expect(runSandboxCommand({ positionals: ["status"] }, deps)).resolves.toBe(0);
    expect(deps.status).toHaveBeenCalledOnce();
    expect(deps.setup).not.toHaveBeenCalled();
    expect(stdout).toContain("State: ready");
    expect(stdout).toContain("Source: managed");
    expect(stdout).toContain(READY_STATUS.installRoot);
    expect(stdout).toContain(READY_STATUS.message);
  });

  it("sets up only the pinned cache copy and prints every functional check", async () => {
    const deps = dependencies();
    await expect(runSandboxCommand({ positionals: ["setup"] }, deps)).resolves.toBe(0);
    expect(deps.setup).toHaveBeenCalledWith(expect.objectContaining({ verify: true, signal: expect.any(AbortSignal) }));
    expect(stdout).toContain("no PATH, global npm, or system-package changes");
    expect(stdout).toContain("outside-write-denied");
  });

  it("returns a stable failure heading for a failed functional check", async () => {
    const deps = dependencies({
      check: vi.fn(async () => { throw new Error("deny proof failed"); }),
    });
    await expect(runSandboxCommand({ positionals: ["check"] }, deps)).resolves.toBe(1);
    expect(stderr).toContain("[sandbox_check_failed]");
    expect(stderr).toContain("mono-agent sandbox check");
  });

  it("aborts cleanly on SIGINT and never claims partial success", async () => {
    const deps = dependencies({
      setup: vi.fn(async ({ signal } = {}) => await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
        queueMicrotask(() => process.emit("SIGINT"));
      })),
    });
    await expect(runSandboxCommand({ positionals: ["setup"] }, deps)).resolves.toBe(130);
    expect(stderr).toContain("[sandbox_interrupted]");
    expect(stderr).toContain("no partial success was claimed");
    expect(stdout).not.toContain("integrity verification passed");
  });

  it("rejects missing or extra subcommands with exit 2", async () => {
    const deps = dependencies();
    await expect(runSandboxCommand({ positionals: [] }, deps)).resolves.toBe(2);
    expect(stderr).toContain("[sandbox_usage]");
  });

  it("emits a flat JSON status envelope with no ANSI in --json mode", async () => {
    const deps = dependencies();
    await expect(runSandboxCommand({ positionals: ["status"], json: true }, deps)).resolves.toBe(0);
    expect(stdout).not.toContain(String.fromCharCode(27));
    const parsed = JSON.parse(stdout) as { readonly ok: boolean; readonly sandbox: typeof READY_STATUS };
    expect(parsed.ok).toBe(true);
    expect(parsed.sandbox.state).toBe("ready");
    expect(parsed.sandbox.source).toBe("managed");
    expect(parsed.sandbox.installRoot).toBe(READY_STATUS.installRoot);
    expect(stderr).toBe("");
  });

  it("emits an ok:false error envelope on a status probe failure in --json mode", async () => {
    const deps = dependencies({ status: vi.fn(async () => { throw new Error("srt cache unreadable"); }) });
    await expect(runSandboxCommand({ positionals: ["status"], json: true }, deps)).resolves.toBe(1);
    const parsed = JSON.parse(stdout) as { readonly ok: boolean; readonly error: { readonly code: string; readonly message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("sandbox_status_failed");
    expect(parsed.error.message).toContain("srt cache unreadable");
  });
});
