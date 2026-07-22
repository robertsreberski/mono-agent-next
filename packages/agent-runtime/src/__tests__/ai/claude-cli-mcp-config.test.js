// F13: the temp mcp.json that claude-cli writes carries full mcpServers env
// (including a resolved embedding apiKey) and lives under a shared /tmp dir.
// generateCliResponse must write it owner-only (mode 0o600) so the secret is
// not world-readable. We mock the spawned CLI child so the test is hermetic
// (no real `claude` binary) and capture the temp mcp.json's on-disk mode inside
// the writeFileSync spy — the temp dir is removed in generateCliResponse's
// finally, so the mode must be asserted at write time.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeFileSyncSpy = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    // Perform the real write so the file exists on disk, then record the call
    // (args + the actual resulting mode) for assertions.
    writeFileSync: (...args) => {
      actual.writeFileSync(...args);
      const [path] = args;
      let mode = null;
      try { mode = actual.statSync(path).mode & 0o777; } catch { /* best-effort */ }
      writeFileSyncSpy(...args, { observedMode: mode });
      return undefined;
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const { generateCliResponse } = await import("../../ai/providers/claude-cli.js");

// A fake CLI child that emits a clean, empty exit so generateCliResponse
// resolves immediately without a real subprocess. stdout/stderr are real
// readable streams so createInterface(readline) wiring works (a bare
// EventEmitter lacks the .pause/.resume the interface calls on "end").
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  // End the streams and close on the next tick so the readline wiring is set up.
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
  });
  return child;
}

beforeEach(() => {
  writeFileSyncSpy.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claude-cli mcp.json temp file permissions (F13)", () => {
  it("writes the temp mcp.json with owner-only mode 0o600 when mcpServers is non-empty", async () => {
    await generateCliResponse("system", {
      model: { sdk: "claude-code", model: "claude-sonnet-4-6" },
      messages: [{ role: "user", content: "hi" }],
      mcpServers: {
        MemoryRecall: {
          command: "node",
          args: ["recall-server.js"],
          env: { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-secret-value" },
        },
      },
    });

    const mcpWrite = writeFileSyncSpy.mock.calls.find(
      ([path]) => typeof path === "string" && path.endsWith("mcp.json"),
    );
    expect(mcpWrite).toBeDefined();

    // The call passed an explicit owner-only mode option...
    const optionsArg = mcpWrite[2];
    expect(optionsArg).toMatchObject({ mode: 0o600 });

    // ...and the file actually landed at 0o600 on disk (statSync, masked to perms).
    const observed = mcpWrite[mcpWrite.length - 1];
    expect(observed.observedMode).toBe(0o600);

    // Sanity: the secret was written into the temp file (so the mode matters).
    const written = mcpWrite[1];
    expect(written).toContain("sk-secret-value");

    // Hermetic: no real CLI binary was invoked beyond our mocked spawn.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
