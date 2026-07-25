// SPDX-License-Identifier: MIT
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

async function filesWithSuffix(root: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true }))
      .filter((entry) => entry.endsWith(suffix))
      .map((entry) => join(root, entry));
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

  it("binds an in-memory resume source to its committed conversation and model", async () => {
    const manager = new RuntimePiSessionManager({ cwd: process.cwd(), namespace: "test" });
    let sourceId = "";
    await manager.withAttempt(
      {
        conversationId: "conversation-a",
        modelKey: "provider/model-a",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async ({ id }) => {
        sourceId = id;
        return { completed: true, value: undefined };
      },
    );
    const task = vi.fn(async () => ({ completed: true, value: undefined }));

    await expect(manager.withAttempt(
      {
        conversationId: "conversation-b",
        modelKey: "provider/model-a",
        turnId: "forged-resume",
        resumeSessionId: sourceId,
        signal: new AbortController().signal,
      },
      task,
    )).rejects.toThrow("conversation and model binding");

    expect(task).not.toHaveBeenCalled();
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
    const committedMarkers = await filesWithSuffix(sessionsRoot, ".json");
    expect(committedMarkers).toHaveLength(1);
    expect(JSON.parse(await readFile(committedMarkers[0]!, "utf8"))).toMatchObject({
      owner: "@mono-agent/runtime-pi.session-reservation.v1",
      phase: "committed",
    });
    expect((await stat(committedMarkers[0]!)).mode & 0o7777).toBe(0o600);
    expect((await stat((await filesWithSuffix(sessionsRoot, ".jsonl"))[0]!)).mode & 0o7777)
      .toBe(0o600);

    await manager.withAttempt(options("discarded"), async () => ({ completed: false, value: undefined }));
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    const failure = new Error("provider failed");
    await expect(manager.withAttempt(options("failed"), async () => { throw failure; })).rejects.toBe(failure);
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    const controller = new AbortController();
    await expect(manager.withAttempt(options("cancelled", controller.signal), async () => {
      controller.abort(new Error("turn cancelled"));
      return { completed: false, value: undefined };
    })).rejects.toThrow("turn cancelled");
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);

    await manager.stop();
  });

  it("commits and returns a completed attempt after a post-task abort", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const manager = new RuntimePiSessionManager({
      cwd: root,
      namespace: "completed-late-abort",
      sessionsRoot,
    });
    const controller = new AbortController();

    await expect(manager.withAttempt({
      conversationId: "conversation",
      modelKey: "provider/model",
      turnId: "completed",
      signal: controller.signal,
    }, async () => {
      queueMicrotask(() => controller.abort(new Error("late abort")));
      return { completed: true, value: "committed answer" };
    })).resolves.toBe("committed answer");

    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);
    const markers = await filesWithSuffix(sessionsRoot, ".json");
    expect(markers).toHaveLength(1);
    expect(JSON.parse(await readFile(markers[0]!, "utf8"))).toMatchObject({
      phase: "committed",
    });
    await manager.stop();
  });

  it("binds a persistent resume source to its committed conversation and model", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const manager = new RuntimePiSessionManager({
      cwd: root,
      namespace: "resume-binding",
      sessionsRoot,
    });
    let sourceId = "";
    await manager.withAttempt(
      {
        conversationId: "conversation-a",
        modelKey: "provider/model-a",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async ({ id, session }) => {
        sourceId = id;
        await session.appendMessage({
          role: "user",
          content: "conversation-a secret",
          timestamp: Date.now(),
        });
        return { completed: true, value: undefined };
      },
    );
    const task = vi.fn(async () => ({ completed: true, value: undefined }));

    for (const attemptedBinding of [
      { conversationId: "conversation-b", modelKey: "provider/model-a" },
      { conversationId: "conversation-a", modelKey: "provider/model-b" },
    ]) {
      await expect(manager.withAttempt(
        {
          ...attemptedBinding,
          turnId: "forged-resume",
          resumeSessionId: sourceId,
          signal: new AbortController().signal,
        },
        task,
      )).rejects.toThrow("conversation and model binding");
    }

    expect(task).not.toHaveBeenCalled();
    expect(await jsonlFiles(sessionsRoot)).toHaveLength(1);
    expect(await filesWithSuffix(sessionsRoot, ".json")).toHaveLength(1);
    await manager.stop();
  });

  it("rejects a source swap between validation and fork without reading the victim", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const manager = new RuntimePiSessionManager({
      cwd: root,
      namespace: "source-swap",
      sessionsRoot,
    });
    let sourceId = "";
    await manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async ({ id }) => {
        sourceId = id;
        return { completed: true, value: undefined };
      },
    );
    const sourcePath = (await filesWithSuffix(sessionsRoot, ".jsonl"))[0]!;
    const originalPath = `${sourcePath}.original`;
    const victimPath = join(root, "victim.jsonl");
    await writeFile(victimPath, "victim must remain unread and unchanged\n", { mode: 0o600 });
    await chmod(victimPath, 0o600);
    const readTextFile = manager.env.readTextFile.bind(manager.env);
    let reads = 0;
    vi.spyOn(manager.env, "readTextFile").mockImplementation(async (path, signal) => {
      reads += 1;
      if (reads === 2) {
        await rename(sourcePath, originalPath);
        await symlink(victimPath, sourcePath);
      }
      return readTextFile(path, signal);
    });

    await expect(manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "two",
        resumeSessionId: sourceId,
        signal: new AbortController().signal,
      },
      async () => ({ completed: true, value: undefined }),
    )).rejects.toThrow(/symbolic link|identity/u);

    expect(await readFile(victimPath, "utf8")).toBe("victim must remain unread and unchanged\n");
    await manager.stop();
  });

  it("guards every append and never follows a swapped attempt path", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const manager = new RuntimePiSessionManager({
      cwd: root,
      namespace: "append-swap",
      sessionsRoot,
    });
    const victimPath = join(root, "append-victim.jsonl");
    await writeFile(victimPath, "victim\n", { mode: 0o600 });
    await chmod(victimPath, 0o600);

    await expect(manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async ({ session }) => {
        const metadata = await session.getMetadata() as unknown as { readonly path: string };
        await rename(metadata.path, `${metadata.path}.original`);
        await symlink(victimPath, metadata.path);
        await session.appendMessage({
          role: "user",
          content: "must not reach victim",
          timestamp: Date.now(),
        });
        return { completed: true, value: undefined };
      },
    )).rejects.toThrow(/symbolic link|cleanup both failed/u);

    expect(await readFile(victimPath, "utf8")).toBe("victim\n");
    expect(await filesWithSuffix(sessionsRoot, ".json")).toHaveLength(1);
    await manager.stop();
  });

  it("does not publish a committed marker for truncated session data", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const manager = new RuntimePiSessionManager({
      cwd: root,
      namespace: "durable-commit",
      sessionsRoot,
    });

    await expect(manager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async ({ session }) => {
        await session.appendMessage({
          role: "user",
          content: "durable data",
          timestamp: Date.now(),
        });
        const metadata = await session.getMetadata() as unknown as { readonly path: string };
        const bytes = await readFile(metadata.path);
        await writeFile(metadata.path, bytes.subarray(0, bytes.byteLength - 1));
        return { completed: true, value: "must not escape before commit" };
      },
    )).rejects.toThrow("truncated before durable commit");

    expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(0);
    expect(await filesWithSuffix(sessionsRoot, ".json")).toHaveLength(0);
    await manager.stop();
  });

  it("reconciles only a proven dead-owner uncommitted reservation after a crash", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const crashed = new RuntimePiSessionManager({
      cwd: root,
      namespace: "crash-recovery",
      sessionsRoot,
      reservationOwnerPid: 99_999_999,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    let confirmAttemptOpen!: () => void;
    const attemptOpen = new Promise<void>((resolvePromise) => {
      confirmAttemptOpen = resolvePromise;
    });
    const active = crashed.withAttempt(
      {
        conversationId: "crashed-conversation",
        modelKey: "provider/model",
        turnId: "crashed-turn",
        signal: new AbortController().signal,
      },
      async () => {
        confirmAttemptOpen();
        await gate;
        return { completed: false, value: undefined };
      },
    );
    await vi.waitFor(async () => {
      expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(1);
      const markers = await filesWithSuffix(sessionsRoot, ".json");
      expect(markers).toHaveLength(1);
      expect(JSON.parse(await readFile(markers[0]!, "utf8"))).toMatchObject({
        phase: "reserved",
        pid: 99_999_999,
      });
    });
    await attemptOpen;

    const recovered = new RuntimePiSessionManager({
      cwd: root,
      namespace: "crash-recovery",
      sessionsRoot,
    });
    await recovered.withAttempt(
      {
        conversationId: "recovery-probe",
        modelKey: "provider/model",
        turnId: "probe",
        signal: new AbortController().signal,
      },
      async () => ({ completed: false, value: undefined }),
    );
    expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(0);
    expect(await filesWithSuffix(sessionsRoot, ".json")).toHaveLength(0);

    release();
    await active;
    await Promise.all([crashed.stop(), recovered.stop()]);
  });

  it("fails startup closed instead of orphaning an unverified crashed session", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const crashed = new RuntimePiSessionManager({
      cwd: root,
      namespace: "invalid-crash-recovery",
      sessionsRoot,
      reservationOwnerPid: 99_999_999,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const active = crashed.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "one",
        signal: new AbortController().signal,
      },
      async () => {
        await gate;
        return { completed: false, value: undefined };
      },
    );
    await vi.waitFor(async () =>
      expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(1));
    const sessionPath = (await filesWithSuffix(sessionsRoot, ".jsonl"))[0]!;
    await writeFile(sessionPath, "{\"type\":\"session\"", { mode: 0o600 });

    const recovered = new RuntimePiSessionManager({
      cwd: root,
      namespace: "invalid-crash-recovery",
      sessionsRoot,
    });
    await expect(recovered.initialize()).rejects.toThrow("unverified session file");
    expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(1);
    expect(await filesWithSuffix(sessionsRoot, ".json")).toHaveLength(1);

    release();
    await expect(active).rejects.toThrow();
    await Promise.all([crashed.stop(), recovered.stop()]);
  });

  it("does not reconcile a live owner reservation during a concurrent startup", async () => {
    const root = await temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const first = new RuntimePiSessionManager({
      cwd: root,
      namespace: "reservation-race",
      sessionsRoot,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const active = first.withAttempt(
      {
        conversationId: "active-conversation",
        modelKey: "provider/model",
        turnId: "active-turn",
        signal: new AbortController().signal,
      },
      async () => {
        await gate;
        return { completed: true, value: undefined };
      },
    );
    await vi.waitFor(async () =>
      expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(1));

    const concurrent = new RuntimePiSessionManager({
      cwd: root,
      namespace: "reservation-race",
      sessionsRoot,
    });
    await concurrent.withAttempt(
      {
        conversationId: "concurrent-probe",
        modelKey: "provider/model",
        turnId: "probe",
        signal: new AbortController().signal,
      },
      async () => ({ completed: false, value: undefined }),
    );
    expect(await filesWithSuffix(sessionsRoot, ".jsonl")).toHaveLength(1);
    expect(await filesWithSuffix(sessionsRoot, ".json")).toHaveLength(1);

    release();
    await active;
    const marker = JSON.parse(
      await readFile((await filesWithSuffix(sessionsRoot, ".json"))[0]!, "utf8"),
    ) as { phase: string };
    expect(marker.phase).toBe("committed");
    await Promise.all([first.stop(), concurrent.stop()]);
  });

  it("never chmods pre-existing wrong-mode, hard-linked, or symlinked sessions", async () => {
    async function completedFixture(label: string): Promise<{
      root: string;
      sessionsRoot: string;
      sessionId: string;
      sessionPath: string;
    }> {
      const root = await temporaryRoot();
      const sessionsRoot = join(root, "sessions");
      const manager = new RuntimePiSessionManager({
        cwd: root,
        namespace: label,
        sessionsRoot,
      });
      let sessionId = "";
      await manager.withAttempt(
        {
          conversationId: "conversation",
          modelKey: "provider/model",
          turnId: "one",
          signal: new AbortController().signal,
        },
        async ({ id }) => {
          sessionId = id;
          return { completed: true, value: undefined };
        },
      );
      await manager.stop();
      return {
        root,
        sessionsRoot,
        sessionId,
        sessionPath: (await filesWithSuffix(sessionsRoot, ".jsonl"))[0]!,
      };
    }

    const wrongMode = await completedFixture("wrong-mode");
    await chmod(wrongMode.sessionPath, 0o644);
    const wrongModeManager = new RuntimePiSessionManager({
      cwd: wrongMode.root,
      namespace: "wrong-mode",
      sessionsRoot: wrongMode.sessionsRoot,
    });
    await expect(wrongModeManager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "two",
        resumeSessionId: wrongMode.sessionId,
        signal: new AbortController().signal,
      },
      async () => ({ completed: true, value: undefined }),
    )).rejects.toThrow("mode must be exactly 0600");
    expect((await stat(wrongMode.sessionPath)).mode & 0o7777).toBe(0o644);
    await wrongModeManager.stop();

    const hardLinked = await completedFixture("hard-linked");
    const extraLink = join(hardLinked.root, "session-hard-link.jsonl");
    await link(hardLinked.sessionPath, extraLink);
    const hardLinkManager = new RuntimePiSessionManager({
      cwd: hardLinked.root,
      namespace: "hard-linked",
      sessionsRoot: hardLinked.sessionsRoot,
    });
    await expect(hardLinkManager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "two",
        resumeSessionId: hardLinked.sessionId,
        signal: new AbortController().signal,
      },
      async () => ({ completed: true, value: undefined }),
    )).rejects.toThrow("owner/type/link/identity");
    expect((await stat(hardLinked.sessionPath)).nlink).toBe(2);
    expect((await stat(hardLinked.sessionPath)).mode & 0o7777).toBe(0o600);
    await hardLinkManager.stop();

    const symlinked = await completedFixture("symlinked");
    const originalPath = `${symlinked.sessionPath}.original`;
    const victimPath = join(symlinked.root, "victim.jsonl");
    const originalBytes = await readFile(symlinked.sessionPath);
    await writeFile(victimPath, originalBytes, { mode: 0o644 });
    await chmod(victimPath, 0o644);
    await rename(symlinked.sessionPath, originalPath);
    await symlink(victimPath, symlinked.sessionPath);
    const symlinkManager = new RuntimePiSessionManager({
      cwd: symlinked.root,
      namespace: "symlinked",
      sessionsRoot: symlinked.sessionsRoot,
    });
    await expect(symlinkManager.withAttempt(
      {
        conversationId: "conversation",
        modelKey: "provider/model",
        turnId: "two",
        resumeSessionId: symlinked.sessionId,
        signal: new AbortController().signal,
      },
      async () => ({ completed: true, value: undefined }),
    )).rejects.toThrow(/symbolic link|missing its session file/u);
    expect(await readFile(victimPath)).toEqual(originalBytes);
    expect((await stat(victimPath)).mode & 0o7777).toBe(0o644);
    expect((await lstat(symlinked.sessionPath)).isSymbolicLink()).toBe(true);
    await symlinkManager.stop();
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
