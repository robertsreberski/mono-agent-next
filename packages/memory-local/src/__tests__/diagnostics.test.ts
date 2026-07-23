import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
  type MemoryHost,
  type MemoryRecord,
  type MemoryRuntimeCaptureGrant,
} from "@mono-agent/module-sdk";

import {
  MEMORY_LOCAL_INDEX_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  openMemoryLocal,
} from "../index.js";

const signal = new AbortController().signal;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("memory-local non-serving diagnostics", () => {
  it("is silent and byte-read-only for a healthy store", async () => {
    const fixture = await createFixture();
    const memory = await openMemoryLocal(options(fixture, { capture: { enabled: false } }));
    try {
      const before = await digestTree(fixture.directory);
      await expect(memory.diagnostics({ signal, verbose: false })).resolves.toEqual([]);
      expect(await digestTree(fixture.directory)).toBe(before);
    } finally {
      await memory.stop();
    }
  });

  it("reports bounded degraded intake without retrying capture or changing durable bytes", async () => {
    const fixture = await createFixture();
    let modelCalls = 0;
    const grant: MemoryRuntimeCaptureGrant = {
      async complete() {
        modelCalls += 1;
        throw new Error("provider bearer sk-private-diagnostic");
      },
    };
    const memory = await openMemoryLocal({
      ...options(fixture, captureConfig()),
      host: runtimeHost(grant),
    });
    try {
      await expect(memory.capture?.({
        record: record("diagnostic-intake", "Remember diagnostic intake.", "2026-07-23T10:00:00.000Z"),
        signal,
      })).rejects.toMatchObject({ code: "runtime_capture_invalid" });
      expect(modelCalls).toBe(1);
      const before = await digestTree(fixture.directory);
      const diagnostics = await memory.diagnostics({ signal, verbose: true });
      expect(diagnostics).toEqual([{
        code: "memory-local.intake",
        severity: "warning",
        message: "Memory has pending bounded intake (captures 1, vectors 0).",
        hint: "Correct the provider boundary, then run bounded intake retry explicitly.",
      }]);
      expect(JSON.stringify(diagnostics).length).toBeLessThan(512);
      expect(modelCalls).toBe(1);
      expect(await digestTree(fixture.directory)).toBe(before);
    } finally {
      await memory.stop();
    }
  });

  it("returns sanitized errors for in-flight identity and unsafe derived projection state", async () => {
    const inFlight = await createFixture();
    const first = await openMemoryLocal(options(inFlight, { capture: { enabled: false } }));
    try {
      const markerPath = join(inFlight.directory, MEMORY_LOCAL_MARKER_FILENAME);
      const initialized = await readFile(markerPath, "utf8");
      await writeFile(markerPath, initialized.replace(/^initialized:/u, "initializing:"), {
        mode: 0o600,
      });
      const before = await digestTree(inFlight.directory);
      const diagnostics = await first.diagnostics({ signal, verbose: false });
      expect(diagnostics).toEqual([{
        code: "memory-local.integrity",
        severity: "error",
        message: "Memory identity or integrity could not be proven.",
        hint: "Keep the agent stopped; preserve the root and investigate from a verified copy.",
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain("initializing:");
      expect(await digestTree(inFlight.directory)).toBe(before);
    } finally {
      await first.stop();
    }

    const unsafe = await createFixture();
    const second = await openMemoryLocal(options(unsafe, { capture: { enabled: false } }));
    try {
      const outside = join(unsafe.root, "outside-index.md");
      const outsideBytes = Buffer.from("operator bytes remain untouched\n");
      await writeFile(outside, outsideBytes, { mode: 0o600 });
      await symlink(outside, join(unsafe.directory, MEMORY_LOCAL_INDEX_FILENAME));
      const before = await digestTree(unsafe.directory);
      await expect(second.diagnostics({ signal, verbose: false })).resolves.toEqual([{
        code: "memory-local.projections",
        severity: "error",
        message: "Memory projections are incomplete or unsafe (index unsafe, future-log missing).",
        hint: "Preserve canonical rows, inspect the derived targets, then retry explicit consolidation.",
      }]);
      expect(await readFile(outside)).toEqual(outsideBytes);
      expect(await digestTree(unsafe.directory)).toBe(before);
    } finally {
      await second.stop();
    }
  });
});

async function createFixture(): Promise<{ readonly root: string; readonly directory: string }> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-memory-diagnostics-"));
  const root = await realpath(authored);
  roots.push(root);
  const directory = join(root, "memory");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory };
}

function options(
  fixture: { readonly root: string; readonly directory: string },
  config: unknown,
): { readonly config: unknown; readonly configDirectory: string; readonly dataDirectory: string } {
  return {
    config,
    configDirectory: fixture.root,
    dataDirectory: fixture.directory,
  };
}

function captureConfig(): unknown {
  return {
    capture: {
      enabled: true,
      model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
      timeoutMs: 5_000,
    },
  };
}

function runtimeHost(grant: MemoryRuntimeCaptureGrant): MemoryHost {
  return {
    grantedCapabilities: new Set([HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE]),
    getCapability<T = unknown>(_name: string): T | undefined { return undefined; },
    runtimeCapture: grant,
  };
}

function record(id: string, text: string, createdAt: string): MemoryRecord {
  return { id, text, createdAt };
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    const identity = await lstat(path);
    hash.update(entry.name);
    hash.update("\0");
    hash.update(String(identity.mode & 0o777));
    hash.update("\0");
    if (entry.isSymbolicLink()) {
      hash.update("symlink");
    } else if (entry.isFile()) {
      hash.update(await readFile(path));
    }
  }
  return hash.digest("hex");
}
