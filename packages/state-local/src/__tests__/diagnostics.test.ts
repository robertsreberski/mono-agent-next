// SPDX-License-Identifier: MIT
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { StateLocalStore } from "../store.js";

const roots: string[] = [];
const stores: StateLocalStore[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(async (store) => store.close()));
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })));
});

describe("state-local diagnostics", () => {
  it("verifies state and execution identity without starting, publishing, or mutating", async () => {
    const parent = await temporaryDirectory();
    const registryDirectory = join(parent, "registry");
    const store = await open({
      ...config(join(parent, "state")),
      discovery: {
        registryDirectory,
        sourceId: "diagnostic-agent",
        sourceLabel: "Diagnostic Agent",
        heartbeatMs: 60_000,
      },
    });
    await store.write({
      key: "retained/value",
      value: Buffer.from("unchanged", "utf8"),
      signal,
    });
    const snapshotBefore = await readFile(store.snapshotPath);

    await expect(store.diagnostics({ signal, verbose: true })).resolves.toEqual([{
      code: "state-local.integrity",
      severity: "info",
      message:
        "Owner-private local state identity, writer lease, and execution protocol v1 are verified.",
    }]);
    expect(await readFile(store.snapshotPath)).toEqual(snapshotBefore);
    await expect(lstat(registryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const retained = await store.read({ key: "retained/value", signal });
    expect(Buffer.from(retained?.value ?? []).toString("utf8")).toBe("unchanged");
  });

  it("reports incompatible execution identity without exposing the returned value", async () => {
    const parent = await temporaryDirectory();
    const store = await open(config(join(parent, "state")));
    Object.defineProperty(store.execution, "perform", {
      configurable: true,
      value: async () => ({
        protocol: `private-${parent}`,
        version: 999,
        operations: [],
      }),
    });

    const diagnostics = await store.diagnostics({ signal, verbose: false });
    expect(diagnostics).toEqual([{
      code: "state-local.execution-protocol",
      severity: "error",
      message: "The local state execution protocol identity is incompatible.",
      hint: "Keep the agent stopped and use matching lockstep @mono-agent package versions.",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain(parent);
  });

  it("turns an unsafe path into a bounded poisoned-state error without leaking paths", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "state");
    const store = await open(config(root));
    await chmod(root, 0o755);

    const diagnostics = await store.diagnostics({ signal, verbose: false });
    expect(diagnostics).toEqual([{
      code: "state-local.integrity",
      severity: "error",
      message: "Local state identity or integrity could not be proven.",
      hint:
        "Keep the agent stopped; preserve state and artifacts together, then inspect from a verified copy.",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain(parent);
    await expect(store.read({ key: "any", signal }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });

    await chmod(root, 0o700);
  });

  it("reports a closed store as unavailable without probing or reopening it", async () => {
    const parent = await temporaryDirectory();
    const store = await open(config(join(parent, "state")));
    await store.close();

    await expect(store.diagnostics({ signal, verbose: false })).resolves.toEqual([{
      code: "state-local.closed",
      severity: "error",
      message: "The selected local state store is closed and unavailable.",
      hint: "Create a fresh selected state instance before running diagnostics again.",
    }]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-state-diagnostics-"));
  roots.push(root);
  return root;
}

function config(root: string): ResolvedStateLocalConfig {
  return {
    root,
    maxRecordBytes: 1_024,
    maxRecords: 100,
    maxTotalBytes: 10_000,
  };
}

async function open(value: ResolvedStateLocalConfig): Promise<StateLocalStore> {
  const store = await StateLocalStore.open(value, {
    instanceId: "diagnostics-test",
    signal,
    clock: () => new Date("2026-07-23T12:00:00.000Z"),
  });
  stores.push(store);
  return store;
}
