import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  readBujoRuntimeSnapshot,
  writeBujoRuntimeSnapshot,
  type BujoRuntimeSnapshot,
} from "../runtime-snapshot.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "bujo-runtime-snapshot-"));
}

function snapshot(): BujoRuntimeSnapshot {
  return {
    schemaVersion: BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    pid: process.pid,
    tier: "bujo",
    state: "running",
    startedAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:01.000Z",
    queues: {
      shutdown: { drainTimeoutMs: 10_000, discarded: 0, timedOut: false },
    },
    counters: { embeddingCalls: 1, embeddingTexts: 2, llmCalls: 1, llmInputChars: 100 },
  };
}

describe("BuJo runtime snapshot path safety", () => {
  it("publishes an owner-only atomic snapshot that remains readable", () => {
    const memoryRoot = root();
    writeBujoRuntimeSnapshot(memoryRoot, snapshot());
    const path = join(memoryRoot, ".index/runtime.json");

    expect(lstatSync(path).mode & 0o077).toBe(0);
    expect(readBujoRuntimeSnapshot(memoryRoot, new Date("2026-07-11T00:00:02.000Z"))).toMatchObject({
      available: true,
      stale: false,
      snapshot: { tier: "bujo" },
    });
  });

  it("refuses symlinked managed directories", () => {
    const memoryRoot = root();
    const outside = root();
    symlinkSync(outside, join(memoryRoot, ".index"), "dir");

    expect(() => writeBujoRuntimeSnapshot(memoryRoot, snapshot())).toThrow(/directory.*symlink/iu);
    expect(existsSync(join(outside, "runtime.json"))).toBe(false);
  });

  it("refuses a symlinked runtime target and reports it invalid without reading the referent", () => {
    const memoryRoot = root();
    const outside = join(root(), "outside.json");
    mkdirSync(join(memoryRoot, ".index"));
    writeFileSync(outside, `${JSON.stringify(snapshot())}\n`, "utf8");
    symlinkSync(outside, join(memoryRoot, ".index/runtime.json"));

    expect(() => writeBujoRuntimeSnapshot(memoryRoot, snapshot())).toThrow(/symlink|regular/iu);
    expect(readBujoRuntimeSnapshot(memoryRoot)).toMatchObject({ available: false, stale: true, reason: "invalid" });
    expect(readFileSync(outside, "utf8")).toContain('"tier":"bujo"');
  });
});
