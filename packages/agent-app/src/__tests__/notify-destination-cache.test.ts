import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listNotifyDestinations } from "../app-controller-maintenance.js";
import type { MonoAgentAppController } from "../app-controller.js";
import { isNotifyDestinationConversationId } from "../notify-destinations.js";
import { createSeenNotifyDestinationCache } from "../seen-conversations.js";
import type { SeenConversation } from "../seen-conversations.js";

const fsProbe = vi.hoisted(() => ({
  statCalls: 0,
  readFailureSuffix: undefined as string | undefined,
  readFailuresRemaining: 0,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    async stat(path: string) {
      fsProbe.statCalls += 1;
      return await actual.stat(path);
    },
    async readFile(path: string, encoding: BufferEncoding) {
      if (
        fsProbe.readFailuresRemaining > 0
        && fsProbe.readFailureSuffix !== undefined
        && path.endsWith(fsProbe.readFailureSuffix)
      ) {
        fsProbe.readFailuresRemaining -= 1;
        throw Object.assign(new Error("temporary artifact read failure"), { code: "EIO" });
      }
      return await actual.readFile(path, encoding);
    },
  };
});

let dir: string;

beforeEach(async () => {
  fsProbe.statCalls = 0;
  fsProbe.readFailureSuffix = undefined;
  fsProbe.readFailuresRemaining = 0;
  dir = await mkdtemp(join(tmpdir(), "mono-agent-notify-cache-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function summary(name: string, conversationId: string): Promise<void> {
  await writeFile(join(dir, `${name}.summary.json`), JSON.stringify({
    runId: name,
    conversationId,
    status: "succeeded",
    updatedAt: "2026-07-16T09:00:00.000Z",
  }));
}

describe("seen notify destination cache", () => {
  it("turns repeated host inference over a large artifact directory into one stat pass per TTL", async () => {
    const artifactCount = 256;
    for (let index = 0; index < artifactCount; index += 1) {
      await summary(`run-${index}`, `telegram:${index}`);
    }
    const controller = {
      cwd: dir,
      configReadPath: join(dir, "missing-config.json"),
      env: { MONO_AGENT_ARTIFACT_DIR: dir },
      running: new Map(),
      seenNotifyDestinations: createSeenNotifyDestinationCache(),
    } as unknown as MonoAgentAppController;

    for (let notification = 0; notification < 5; notification += 1) {
      // No channels are running in this focused host seam, so sightings are
      // filtered from the result after exercising the real inference wiring.
      expect(await listNotifyDestinations(controller)).toEqual([]);
    }

    expect(fsProbe.statCalls).toBe(artifactCount);
  });

  it("refreshes after the TTL and immediately after explicit invalidation", async () => {
    let now = 1_000;
    const cache = createSeenNotifyDestinationCache({ ttlMs: 30_000, now: () => now });
    await summary("run-a", "telegram:1");

    expect(await cache.list(dir)).toHaveLength(1);
    await summary("run-b", "slack:C1");
    expect(await cache.list(dir)).toHaveLength(1);

    cache.invalidate();
    expect(await cache.list(dir)).toHaveLength(2);

    await summary("run-c", "telegram:3");
    now += 30_000;
    expect(await cache.list(dir)).toHaveLength(3);
  });

  it("refreshes a cached missing directory after its first relevant artifact commit", async () => {
    const artifactDir = join(dir, "first-run-artifacts");
    const cache = createSeenNotifyDestinationCache();

    await expect(cache.list(artifactDir)).resolves.toEqual([]);
    await mkdir(artifactDir);
    await writeFile(join(artifactDir, "run-a.summary.json"), JSON.stringify({
      runId: "run-a",
      conversationId: "telegram:1",
      status: "running",
      updatedAt: "2026-07-16T09:00:00.000Z",
    }));

    await expect(cache.list(artifactDir)).resolves.toEqual([]);
    cache.invalidate();
    await expect(cache.list(artifactDir)).resolves.toEqual([
      { conversationId: "telegram:1", channelId: "telegram", lastSeen: "2026-07-16T09:00:00.000Z" },
    ]);
  });

  it("preserves corrupt-summary skipping and sees a corrected artifact after invalidation", async () => {
    await summary("run-a", "telegram:1");
    const corruptPath = join(dir, "run-b.summary.json");
    await writeFile(corruptPath, "{not-json");
    const cache = createSeenNotifyDestinationCache();

    await expect(cache.list(dir)).resolves.toEqual([
      { conversationId: "telegram:1", channelId: "telegram", lastSeen: "2026-07-16T09:00:00.000Z" },
    ]);
    await writeFile(corruptPath, JSON.stringify({
      runId: "run-b",
      conversationId: "slack:C1",
      status: "succeeded",
      updatedAt: "2026-07-16T10:00:00.000Z",
    }));

    await expect(cache.list(dir)).resolves.toHaveLength(1);
    cache.invalidate();
    await expect(cache.list(dir)).resolves.toEqual([
      { conversationId: "slack:C1", channelId: "slack", lastSeen: "2026-07-16T10:00:00.000Z" },
      { conversationId: "telegram:1", channelId: "telegram", lastSeen: "2026-07-16T09:00:00.000Z" },
    ]);
  });

  it("shares a same-generation scan and retries stale awaiters after invalidation", async () => {
    const oldDestinations: readonly SeenConversation[] = [{ conversationId: "telegram:old", channelId: "telegram" }];
    const newDestinations: readonly SeenConversation[] = [{ conversationId: "telegram:new", channelId: "telegram" }];
    let releaseOld!: (value: readonly SeenConversation[]) => void;
    const oldScan = new Promise<readonly SeenConversation[]>((resolve) => {
      releaseOld = resolve;
    });
    const scan = vi.fn()
      .mockImplementationOnce(async () => await oldScan)
      .mockResolvedValueOnce(newDestinations);
    const cache = createSeenNotifyDestinationCache({ scan });

    const first = cache.list(dir);
    const sharedFirst = cache.list(dir);
    expect(scan).toHaveBeenCalledTimes(1);

    cache.invalidate();
    await expect(cache.list(dir)).resolves.toEqual(newDestinations);
    expect(scan).toHaveBeenCalledTimes(2);

    releaseOld(oldDestinations);
    await expect(first).resolves.toEqual(newDestinations);
    await expect(sharedFirst).resolves.toEqual(newDestinations);
    await expect(cache.list(dir)).resolves.toEqual(newDestinations);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("does not let an older different-directory scan overwrite the newer directory cache", async () => {
    const destinationsA: readonly SeenConversation[] = [{ conversationId: "telegram:a", channelId: "telegram" }];
    const destinationsB: readonly SeenConversation[] = [{ conversationId: "telegram:b", channelId: "telegram" }];
    let releaseA!: (value: readonly SeenConversation[]) => void;
    const scanA = new Promise<readonly SeenConversation[]>((resolve) => {
      releaseA = resolve;
    });
    const scan = vi.fn(async (artifactDir: string) => artifactDir === "a" ? await scanA : destinationsB);
    const cache = createSeenNotifyDestinationCache({ scan });

    const pendingA = cache.list("a");
    await expect(cache.list("b")).resolves.toEqual(destinationsB);
    const sharedA = cache.list("a");
    expect(scan).toHaveBeenCalledTimes(2);
    releaseA(destinationsA);
    await expect(pendingA).resolves.toEqual(destinationsA);
    await expect(sharedA).resolves.toEqual(destinationsA);

    await expect(cache.list("b")).resolves.toEqual(destinationsB);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed scan and retries on the next call", async () => {
    const destinations: readonly SeenConversation[] = [
      { conversationId: "telegram:recovered", channelId: "telegram" },
    ];
    const scan = vi.fn()
      .mockRejectedValueOnce(new Error("temporary artifact read failure"))
      .mockResolvedValueOnce(destinations);
    const cache = createSeenNotifyDestinationCache({ scan });

    await expect(cache.list(dir)).rejects.toThrow("temporary artifact read failure");
    await expect(cache.list(dir)).resolves.toEqual(destinations);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("retries instead of surfacing a stale scan rejection after invalidation", async () => {
    const destinations: readonly SeenConversation[] = [
      { conversationId: "telegram:fresh", channelId: "telegram" },
    ];
    let rejectOld!: (error: Error) => void;
    const oldScan = new Promise<readonly SeenConversation[]>((_resolve, reject) => {
      rejectOld = reject;
    });
    const scan = vi.fn()
      .mockImplementationOnce(async () => await oldScan)
      .mockResolvedValueOnce(destinations);
    const cache = createSeenNotifyDestinationCache({ scan });

    const staleCaller = cache.list(dir);
    cache.invalidate();
    await expect(cache.list(dir)).resolves.toEqual(destinations);

    rejectOld(new Error("obsolete generation failed"));
    await expect(staleCaller).resolves.toEqual(destinations);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("bounds invalidation churn to two active scans per directory and coalesces the refresh", async () => {
    const oldDestinations: readonly SeenConversation[] = [
      { conversationId: "telegram:old", channelId: "telegram" },
    ];
    const freshDestinations: readonly SeenConversation[] = [
      { conversationId: "telegram:fresh", channelId: "telegram" },
    ];
    const releases: Array<(destinations: readonly SeenConversation[]) => void> = [];
    let active = 0;
    let maxActive = 0;
    const scan = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<readonly SeenConversation[]>((resolve) => {
        releases.push((destinations) => {
          active -= 1;
          resolve(destinations);
        });
      });
    });
    const cache = createSeenNotifyDestinationCache({ scan });

    const generationZero = cache.list(dir);
    cache.invalidate();
    const generationOne = cache.list(dir);
    cache.invalidate();
    const generationTwo = cache.list(dir);

    expect(scan).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);

    releases[1]!(oldDestinations);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(2);

    releases[2]!(freshDestinations);
    await expect(generationOne).resolves.toEqual(freshDestinations);
    await expect(generationTwo).resolves.toEqual(freshDestinations);

    releases[0]!(oldDestinations);
    await expect(generationZero).resolves.toEqual(freshDestinations);
    await expect(cache.list(dir)).resolves.toEqual(freshDestinations);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(2);
  });

  it("does not cache a false singleton after a transient summary read failure", async () => {
    await summary("run-a", "telegram:1");
    await summary("run-b", "telegram:2");
    fsProbe.readFailureSuffix = "run-b.summary.json";
    fsProbe.readFailuresRemaining = 1;
    const controller = {
      cwd: dir,
      configReadPath: join(dir, "missing-config.json"),
      env: { MONO_AGENT_ARTIFACT_DIR: dir },
      running: new Map([["telegram", {}]]),
      seenNotifyDestinations: createSeenNotifyDestinationCache(),
    } as unknown as MonoAgentAppController;

    await expect(listNotifyDestinations(controller)).rejects.toThrow("temporary artifact read failure");
    expect(fsProbe.readFailuresRemaining).toBe(0);

    const recovered = await listNotifyDestinations(controller);
    expect(recovered.map(({ conversationId }) => conversationId).sort()).toEqual([
      "telegram:1",
      "telegram:2",
    ]);
    await expect(listNotifyDestinations(controller)).resolves.toEqual(recovered);
  });
});

describe("notify destination cache invalidation policy", () => {
  it("selects only Telegram/Slack conversation artifacts, including rollover buckets", () => {
    expect(isNotifyDestinationConversationId("telegram:42#2026-07-16")).toBe(true);
    expect(isNotifyDestinationConversationId("slack:C1:thread")).toBe(true);
    expect(isNotifyDestinationConversationId("cron:daily")).toBe(false);
    expect(isNotifyDestinationConversationId("webhook:digest")).toBe(false);
    expect(isNotifyDestinationConversationId("whatsapp:123")).toBe(false);
    expect(isNotifyDestinationConversationId(undefined)).toBe(false);
  });
});
