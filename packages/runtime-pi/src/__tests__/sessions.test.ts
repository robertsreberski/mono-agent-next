import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimePiSessionManager } from "../sessions.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runtime-pi-sessions-"));
  temporaryRoots.push(root);
  return root;
}

async function jsonlFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimePiSessionManager", () => {
  it("uses a fresh native session for every attempt", async () => {
    const manager = new RuntimePiSessionManager({ cwd: process.cwd(), namespace: "test" });
    const ids: string[] = [];

    for (let index = 0; index < 2; index += 1) {
      await manager.withAttempt(
        {
          conversationId: "conversation",
          modelKey: "provider/model",
          turnId: "same-turn",
          signal: new AbortController().signal,
        },
        async ({ id, session }) => {
          ids.push(id);
          expect((await session.getMetadata()).id).toBe(id);
          return { completed: true, value: undefined };
        },
      );
    }

    expect(new Set(ids).size).toBe(2);
    await manager.stop();
  });

  it("forks a completed native session for atomic resume", async () => {
    const manager = new RuntimePiSessionManager({ cwd: process.cwd(), namespace: "test" });
    let firstId = "";
    await manager.withAttempt(
      { conversationId: "conversation", modelKey: "provider/model", turnId: "one", signal: new AbortController().signal },
      async ({ id, session }) => {
        firstId = id;
        await session.appendMessage({ role: "user", content: "remember me", timestamp: Date.now() });
        return { completed: true, value: undefined };
      },
    );
    await manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "two",
        signal: new AbortController().signal,
        resumeSessionId: firstId,
      },
      async ({ id, session }) => {
        expect(id).not.toBe(firstId);
        expect((await session.getEntries()).some((entry) => entry.type === "message")).toBe(true);
        return { completed: true, value: undefined };
      },
    );
    await manager.stop();
  });

  it("serializes attempts for one conversation", async () => {
    const manager = new RuntimePiSessionManager({ cwd: process.cwd(), namespace: "test" });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
    const entered: string[] = [];

    const first = manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async () => {
        entered.push("first");
        await firstGate;
        return { completed: true, value: undefined };
      },
    );
    const second = manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "two",
        signal: new AbortController().signal,
      },
      async () => {
        entered.push("second");
        return { completed: true, value: undefined };
      },
    );

    await vi.waitFor(() => expect(entered).toEqual(["first"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "second"]);
    await manager.stop();
  });

  it("retains only completed persistent attempts", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const manager = new RuntimePiSessionManager({ cwd: root, namespace: "test", sessionsRoot });
    const options = (turnId: string, signal = new AbortController().signal) => ({
      conversationId: "conversation",
      modelKey: "provider/model",
      turnId,
      signal,
    });

    await manager.withAttempt(options("completed"), async () => ({ completed: true, value: undefined }));
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    await manager.withAttempt(options("discarded"), async () => ({ completed: false, value: undefined }));
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    const failure = new Error("provider failed");
    await expect(manager.withAttempt(options("failed"), async () => { throw failure; })).rejects.toBe(failure);
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    const controller = new AbortController();
    await expect(manager.withAttempt(options("cancelled", controller.signal), async () => {
      controller.abort(new Error("turn cancelled"));
      return { completed: true, value: undefined };
    })).rejects.toThrow("turn cancelled");
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    await manager.stop();
  });

  it("surfaces active attempt failures from stop instead of swallowing them", async () => {
    const manager = new RuntimePiSessionManager({ cwd: process.cwd(), namespace: "test" });
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const failure = new Error("active attempt failed");
    const attempt = manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "turn",
        signal: new AbortController().signal,
      },
      async () => {
        await gate;
        throw failure;
      },
    );
    const stopped = manager.stop();
    release();

    await expect(attempt).rejects.toBe(failure);
    await expect(stopped).rejects.toMatchObject({
      name: "AggregateError",
      message: "runtime-pi session manager failed to stop cleanly",
    });
  });

  it("respects an aborted lifecycle signal while still closing the manager", async () => {
    const manager = new RuntimePiSessionManager({ cwd: process.cwd(), namespace: "test" });
    const controller = new AbortController();
    controller.abort(new Error("lifecycle cancelled"));

    await expect(manager.stop(controller.signal)).rejects.toMatchObject({
      name: "AggregateError",
      message: "runtime-pi session manager failed to stop cleanly",
    });
    await expect(manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "turn",
        signal: new AbortController().signal,
      },
      async () => ({ completed: true, value: undefined }),
    )).rejects.toThrow("runtime-pi session manager is stopped");
  });
});
