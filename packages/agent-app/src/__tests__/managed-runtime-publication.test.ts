import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireManagedRuntimePublicationBarrier,
  managedRuntimePublicationBarrierPath,
  waitForManagedRuntimePublication,
} from "../managed-runtime-publication.js";
import type { ProcessIncarnation } from "../process-incarnation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed runtime publication barrier", () => {
  it("holds a respawning worker until the active controller releases publication", async () => {
    const managedRoot = await privateManagedRoot();
    const label = "com.mono-agent.demo-a1b2c3d4";
    const current = incarnation("current");
    const held = await acquireManagedRuntimePublicationBarrier({
      label,
      managedRoot,
      processIncarnation: current,
      isSameProcessIncarnation: () => true,
    });
    expect(held).toBeDefined();

    let finished = false;
    const waiting = waitForManagedRuntimePublication({
      label,
      managedRoot,
      processIncarnation: current,
      isSameProcessIncarnation: () => true,
    }).then(() => { finished = true; });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(finished).toBe(false);

    await held?.release();
    await waiting;
    expect(finished).toBe(true);
  });

  it("recovers a dead or PID-reused controller incarnation", async () => {
    const managedRoot = await privateManagedRoot();
    const label = "com.mono-agent.demo-deadbeef";
    const held = await acquireManagedRuntimePublicationBarrier({
      label,
      managedRoot,
      pid: 4321,
      processIncarnation: incarnation("old"),
      isSameProcessIncarnation: () => true,
    });
    expect(held).toBeDefined();

    await expect(waitForManagedRuntimePublication({
      label,
      managedRoot,
      pid: 4321,
      processIncarnation: incarnation("new"),
      isSameProcessIncarnation: (_pid, observed) => observed.processStartId === "new",
    })).resolves.toBeUndefined();
  });

  it("fails closed for malformed owner state", async () => {
    const managedRoot = await privateManagedRoot();
    const label = "com.mono-agent.demo-bad0bad0";
    const path = managedRuntimePublicationBarrierPath(label, managedRoot);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "owner.json"), "{}\n", { mode: 0o600 });

    await expect(waitForManagedRuntimePublication({ label, managedRoot }))
      .rejects.toThrow(/unexpected schema|malformed/u);
  });

  it("isolates barriers by exact launchd label", async () => {
    const managedRoot = await privateManagedRoot();
    const firstLabel = "com.mono-agent.first-11111111";
    const secondLabel = "com.mono-agent.second-22222222";
    const held = await acquireManagedRuntimePublicationBarrier({ label: firstLabel, managedRoot });
    expect(held).toBeDefined();
    await expect(waitForManagedRuntimePublication({ label: secondLabel, managedRoot }))
      .resolves.toBeUndefined();
    await held?.release();
  });
});

async function privateManagedRoot(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mono-agent-runtime-publication-"));
  roots.push(home);
  const managedRoot = join(home, ".mono-agent");
  await mkdir(managedRoot, { mode: 0o700 });
  await mkdir(join(managedRoot, "locks"), { mode: 0o700 });
  return managedRoot;
}

function incarnation(processStartId: string): ProcessIncarnation {
  return {
    schema: "mono-agent.process-incarnation.v1",
    bootSessionId: "boot-test",
    processStartId,
  };
}
