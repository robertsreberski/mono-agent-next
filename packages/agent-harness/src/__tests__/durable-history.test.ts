import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { afterEach, describe, expect, it } from "vitest";

import { createDurableHistoryStore } from "../durable-history.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

interface TestHistoryRecord {
  readonly version: number;
  readonly conversationId: string;
  readonly messages: readonly Record<string, unknown>[];
  readonly providerSession?: Record<string, unknown>;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "durable-history-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DurableConversationHistoryStore", () => {
  it("atomically resets one conversation and retires its provider epoch", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    const store = createDurableHistoryStore({
      root,
      retireProviderSession: async (providerSessionId) => {
        retired.push(providerSessionId);
      },
    });
    const turn = await store.beginProviderSessionTurn("telegram:42", "run-before-reset");
    const prepared = await turn.prepareCommit(
      [{ role: "user", content: "old context" }],
      { providerSessionSynced: true },
    );
    await prepared.commit();
    await store.append("telegram:99", [{ role: "assistant", content: "unrelated" }]);

    await store.reset("telegram:42");

    await expect(store.load("telegram:42")).resolves.toEqual([]);
    await expect(store.load("telegram:99")).resolves.toEqual([{ role: "assistant", content: "unrelated" }]);
    expect(retired).toContain(turn.providerSessionId);
  });

  it("persists normalized exact conversation ids across store recreation in owner-only files", async () => {
    const dir = await tempDir();
    const root = join(dir, ".mono-agent", "history");
    const first = createDurableHistoryStore({ root });

    await first.append("  slack:D123:1700.1#2026-07-14  ", [
      { role: "user", content: "Question", timestamp: "2026-07-14T20:00:00Z", runId: "run-1" },
      { role: "assistant", content: "Answer", timestamp: "2026-07-14T20:00:01Z", runId: "run-1" },
    ]);

    const restarted = createDurableHistoryStore({ root });
    await expect(restarted.load("slack:D123:1700.1#2026-07-14")).resolves.toEqual([
      { role: "user", content: "Question", timestamp: "2026-07-14T20:00:00Z", runId: "run-1" },
      { role: "assistant", content: "Answer", timestamp: "2026-07-14T20:00:01Z", runId: "run-1" },
    ]);

    const rootInfo = await lstat(root);
    expect(rootInfo.mode & 0o777).toBe(0o700);
    const files = (await readdir(root)).filter((name) => name.endsWith(".history.json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.history\.json$/u);
    expect(files[0]).not.toContain("D123");
    const filePath = join(root, files[0] as string);
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 2,
      conversationId: "slack:D123:1700.1#2026-07-14",
      providerSession: { epoch: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    const locksRoot = join(root, ".locks");
    expect((await lstat(locksRoot)).mode & 0o777).toBe(0o700);
    for (const lockName of await readdir(locksRoot)) {
      expect((await lstat(join(locksRoot, lockName))).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent appends and retains 64 messages independently of runtime turn limits", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    const reloadedStore = createDurableHistoryStore({ root });

    await Promise.all(Array.from({ length: 80 }, (_, index) => (index % 2 === 0 ? store : reloadedStore).append("conversation", [
      { role: index % 2 === 0 ? "user" : "assistant", content: `message-${index}` },
    ])));

    const restarted = createDurableHistoryStore({ root });
    const messages = await restarted.load("conversation");
    expect(messages).toHaveLength(64);
    expect(messages.map((message) => message.content)).toEqual(
      Array.from({ length: 64 }, (_, index) => `message-${index + 16}`),
    );
    await expect(createDurableHistoryStore({ root, maxMessages: 2 }).load("conversation"))
      .resolves.toMatchObject([{ content: "message-78" }, { content: "message-79" }]);
    await expect(createDurableHistoryStore({ root, maxMessages: 0 }).load("conversation"))
      .resolves.toEqual([]);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  }, 15_000);

  it("recovers cold from a stable truncated record and replaces it on the next append", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    await store.append("conversation", [{ role: "assistant", content: "committed before corruption" }]);
    const recordPath = (await historyRecords(root)).get("conversation") as string;
    const original = await readHistoryRecord(root, "conversation");
    const originalEpoch = original.providerSession?.epoch as string;

    await writeFile(recordPath, '{"version":2,"conversationId":"conversation","messages":[');

    const restarted = createDurableHistoryStore({ root });
    await expect(restarted.load("conversation")).resolves.toEqual([]);
    const coldTurn = await restarted.beginProviderSessionTurn("conversation", "run-after-truncation");
    expect(coldTurn.providerSessionId).not.toBe(originalEpoch);
    const prepared = await coldTurn.prepareCommit(
      [{ role: "user", content: "fresh after truncation" }],
      { providerSessionSynced: true },
    );
    await prepared.commit();

    await expect(createDurableHistoryStore({ root }).load("conversation"))
      .resolves.toEqual([{ role: "user", content: "fresh after truncation" }]);
    const recoveredRecord = JSON.parse(await readFile(recordPath, "utf8")) as TestHistoryRecord;
    expect(recoveredRecord).toMatchObject({
      version: 2,
      conversationId: "conversation",
      providerSession: { revision: 1 },
    });
    expect(recoveredRecord.providerSession?.epoch).not.toBe(originalEpoch);
  });

  it("rotates missing, legacy V1, and dirty provider epochs before use", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });

    const missing = await store.beginProviderSessionTurn("missing", "run-missing");
    expect(missing.providerSessionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(missing.providerSessionRevision).toBe(0);
    await missing.abort();
    await expect(store.load("missing")).resolves.toEqual([]);
    expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest("missing")]);
    const afterDirty = await store.beginProviderSessionTurn("missing", "run-after-dirty");
    expect(afterDirty.providerSessionId).not.toBe(missing.providerSessionId);
    expect(afterDirty.providerSessionRevision).toBe(0);
    await afterDirty.abort();

    const preparedAbort = await store.beginProviderSessionTurn("prepared-abort", "run-prepared-abort");
    const stagedClean = await preparedAbort.prepareCommit(
      [{ role: "assistant", content: "must remain unpublished" }],
      { providerSessionSynced: true },
    );
    await stagedClean.abort();
    await expect(store.load("prepared-abort")).resolves.toEqual([]);
    expect(await dirtyFenceKeys(root)).toContain(historyKeyForTest("prepared-abort"));

    await store.append("legacy", [{ role: "user", content: "legacy message" }]);
    const legacyPath = (await historyRecords(root)).get("legacy") as string;
    await writeFile(legacyPath, `${JSON.stringify({
      version: 1,
      conversationId: "legacy",
      messages: [{ role: "user", content: "legacy message" }],
    })}\n`);
    const legacy = await store.beginProviderSessionTurn("legacy", "run-legacy");
    const oldDeterministicId = createHash("sha256").update("legacy").digest("hex").slice(0, 32);
    expect(legacy.providerSessionId).not.toBe(oldDeterministicId);
    expect(legacy.providerSessionRevision).toBe(0);
    expect(await readHistoryRecord(root, "legacy")).toMatchObject({
      version: 1,
      messages: [{ content: "legacy message" }],
    });
    expect(await dirtyFenceKeys(root)).toContain(historyKeyForTest("legacy"));
    await legacy.abort();
  });

  it("reuses and increments a clean synced revision, then rotates when the provider did not synchronize", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });

    const first = await store.beginProviderSessionTurn("conversation", "run-1");
    expect(first.providerSessionRevision).toBe(0);
    const firstCommit = await first.prepareCommit([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ], { providerSessionSynced: true });
    await firstCommit.commit();
    const cleanRecord = await readHistoryRecord(root, "conversation");
    expect(cleanRecord.providerSession).toEqual({
      epoch: expect.stringMatching(/^[a-f0-9]{64}$/u),
      revision: 1,
    });
    expect(await dirtyFenceKeys(root)).toEqual([]);

    const reused = await createDurableHistoryStore({ root }).beginProviderSessionTurn("conversation", "run-2");
    expect(reused.providerSessionId).toBe(first.providerSessionId);
    expect(reused.providerSessionRevision).toBe(1);
    const secondCommit = await reused.prepareCommit([
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "second answer" },
    ], { providerSessionSynced: true });
    await secondCommit.commit();
    expect((await readHistoryRecord(root, "conversation")).providerSession).toMatchObject({ revision: 2 });

    const unsynced = await createDurableHistoryStore({ root }).beginProviderSessionTurn("conversation", "run-3");
    expect(unsynced.providerSessionId).toBe(first.providerSessionId);
    expect(unsynced.providerSessionRevision).toBe(2);
    const unsyncedCommit = await unsynced.prepareCommit([
      { role: "assistant", content: "local-only answer" },
    ], { providerSessionSynced: false });
    await unsyncedCommit.commit();

    const rotated = await createDurableHistoryStore({ root }).beginProviderSessionTurn("conversation", "run-4");
    expect(rotated.providerSessionId).not.toBe(first.providerSessionId);
    expect(rotated.providerSessionRevision).toBe(0);
    await rotated.abort();
  });

  it("never reuses provider context when durable message retention is disabled", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root, maxMessages: 0 });

    const first = await store.beginProviderSessionTurn("conversation", "run-1");
    const committed = await first.prepareCommit([
      { role: "user", content: "private question" },
      { role: "assistant", content: "private answer" },
    ], { providerSessionSynced: true });
    await committed.commit();

    await expect(store.load("conversation")).resolves.toEqual([]);
    const next = await createDurableHistoryStore({ root, maxMessages: 0 })
      .beginProviderSessionTurn("conversation", "run-2");
    expect(next.providerSessionId).not.toBe(first.providerSessionId);
    await next.abort();
  });

  it("rotates a clean provider epoch after an ordinary host-only append", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    const first = await store.beginProviderSessionTurn("conversation", "run-1");
    const committed = await first.prepareCommit([], { providerSessionSynced: true });
    await committed.commit();

    await store.append("conversation", [{ role: "assistant", content: "verbatim host delivery" }]);
    const afterHostAppend = await store.beginProviderSessionTurn("conversation", "run-2");
    expect(afterHostAppend.providerSessionId).not.toBe(first.providerSessionId);
    await afterHostAppend.abort();
  });

  it("retires superseded provider epochs before host-only rotation and dirty recovery", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    const store = createDurableHistoryStore({
      root,
      retireProviderSession: async (providerSessionId) => {
        retired.push(providerSessionId);
      },
    });
    expect(store.providerSessionRetirement).toBe("fail-closed");

    const first = await store.beginProviderSessionTurn("conversation", "run-1");
    const firstCommit = await first.prepareCommit([
      { role: "assistant", content: "answer" },
    ], { providerSessionSynced: true });
    await firstCommit.commit();

    await store.append("conversation", [{ role: "assistant", content: "verbatim host delivery" }]);
    expect(retired).toEqual([first.providerSessionId]);

    const dirty = await store.beginProviderSessionTurn("dirty", "run-dirty");
    await dirty.abort();
    const recovered = await store.beginProviderSessionTurn("dirty", "run-recovered");
    expect(retired).toContain(dirty.providerSessionId);
    expect(recovered.providerSessionId).not.toBe(dirty.providerSessionId);
    await recovered.abort();
  });

  it("retires an unsynchronized epoch and reclaimed dirty-fence epochs by exact id", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    const store = createDurableHistoryStore({
      root,
      maxConversations: 1,
      retireProviderSession: async (providerSessionId) => {
        retired.push(providerSessionId);
      },
    });

    const unsynced = await store.beginProviderSessionTurn("unsynced", "run-unsynced");
    const unsyncedCommit = await unsynced.prepareCommit([], { providerSessionSynced: false });
    await unsyncedCommit.commit();
    expect(retired).toContain(unsynced.providerSessionId);

    const failedA = await store.beginProviderSessionTurn("failed-a", "run-failed-a");
    await failedA.abort();
    const failedB = await store.beginProviderSessionTurn("failed-b", "run-failed-b");
    expect(retired).toContain(failedA.providerSessionId);
    await failedB.abort();
  });

  it("leaves canonical history and its dirty fence reachable when retirement fails", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seeded = createDurableHistoryStore({ root, retireProviderSession: async () => undefined });
    const first = await seeded.beginProviderSessionTurn("conversation", "run-1");
    const committed = await first.prepareCommit([
      { role: "assistant", content: "canonical" },
    ], { providerSessionSynced: true });
    await committed.commit();
    const before = await readHistoryRecord(root, "conversation");

    const failing = createDurableHistoryStore({
      root,
      retireProviderSession: async () => {
        throw new Error("injected retirement failure");
      },
    });
    await expect(failing.prepareAppend("conversation", [
      { role: "assistant", content: "must not publish" },
    ])).rejects.toThrow("injected retirement failure");
    expect(await readHistoryRecord(root, "conversation")).toEqual(before);

    const dirty = await seeded.beginProviderSessionTurn("dirty", "run-dirty");
    await dirty.abort();
    const fencesBefore = await dirtyFenceKeys(root);
    await expect(failing.beginProviderSessionTurn("dirty", "run-recovery"))
      .rejects.toThrow("injected retirement failure");
    expect(await dirtyFenceKeys(root)).toEqual(fencesBefore);
  });

  it("derives a new provider epoch after retention removes a conversation record", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seed = createDurableHistoryStore({ root });
    const original = await seed.beginProviderSessionTurn("original", "run-original");
    const committed = await original.prepareCommit(
      [{ role: "assistant", content: "original answer" }],
      { providerSessionSynced: true },
    );
    await committed.commit();
    const originalPath = (await historyRecords(root)).get("original") as string;
    await utimes(originalPath, new Date(1_000), new Date(1_000));

    const bounded = createDurableHistoryStore({ root, maxConversations: 1 });
    await bounded.append("newer", [{ role: "assistant", content: "newer answer" }]);
    await expect(bounded.load("original")).resolves.toEqual([]);
    const afterRetention = await bounded.beginProviderSessionTurn("original", "run-after-retention");
    expect(afterRetention.providerSessionId).not.toBe(original.providerSessionId);
    await afterRetention.abort();
  });

  it("retires the provider epoch before retention removes its canonical record", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    const retireProviderSession = async (providerSessionId: string): Promise<void> => {
      retired.push(providerSessionId);
    };
    const seed = createDurableHistoryStore({ root, retireProviderSession });
    const original = await seed.beginProviderSessionTurn("original", "run-original");
    const committed = await original.prepareCommit([
      { role: "assistant", content: "original answer" },
    ], { providerSessionSynced: true });
    await committed.commit();
    const originalPath = (await historyRecords(root)).get("original") as string;
    await utimes(originalPath, new Date(1_000), new Date(1_000));

    const bounded = createDurableHistoryStore({ root, maxConversations: 1, retireProviderSession });
    await bounded.append("newer", [{ role: "assistant", content: "newer answer" }]);
    expect(retired).toContain(original.providerSessionId);
    await expect(bounded.load("original")).resolves.toEqual([]);
  });

  it("keeps a retirement fence when history unlink fails so a warm mapping cannot resume blank", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    let victimPath: string | undefined;
    let savedVictimPath: string | undefined;
    const retireProviderSession = async (providerSessionId: string): Promise<void> => {
      retired.push(providerSessionId);
      if (victimPath === undefined || savedVictimPath !== undefined) return;
      savedVictimPath = `${victimPath}.saved`;
      await rename(victimPath, savedVictimPath);
      await mkdir(victimPath);
      await writeFile(join(victimPath, "blocks-unlink"), "occupied", { mode: 0o600 });
    };
    const seed = createDurableHistoryStore({ root, retireProviderSession });
    const victim = await seed.beginProviderSessionTurn("victim", "run-victim");
    const victimCommit = await victim.prepareCommit([
      { role: "assistant", content: "context that must replay" },
    ], { providerSessionSynced: true });
    await victimCommit.commit();
    victimPath = (await historyRecords(root)).get("victim") as string;
    await utimes(victimPath, new Date(1_000), new Date(1_000));

    const bounded = createDurableHistoryStore({
      root,
      maxConversations: 1,
      retireProviderSession,
    });
    await bounded.append("newer", [{ role: "assistant", content: "newer" }]);

    expect(savedVictimPath).toBeDefined();
    await rm(victimPath, { recursive: true });
    await rename(savedVictimPath as string, victimPath);

    expect(retired).toContain(victim.providerSessionId);
    await expect(seed.load("victim")).resolves.toMatchObject([{ content: "context that must replay" }]);
    expect(await dirtyFenceKeys(root)).toContain(historyKeyForTest("victim"));
    const recovered = await seed.beginProviderSessionTurn("victim", "run-recovered");
    expect(recovered.providerSessionId).not.toBe(victim.providerSessionId);
    await recovered.abort();
  });

  it("protects an active provider conversation from root retention", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seed = createDurableHistoryStore({ root });
    await seed.append("protected", [{ role: "assistant", content: "protected history" }]);
    await seed.append("victim", [{ role: "assistant", content: "evictable history" }]);
    const records = await historyRecords(root);
    await utimes(records.get("victim") as string, new Date(1_000), new Date(1_000));
    const active = await seed.beginProviderSessionTurn("protected", "active-run");

    const bounded = createDurableHistoryStore({ root, maxConversations: 2 });
    await bounded.append("newcomer", [{ role: "assistant", content: "new history" }]);
    await expect(bounded.load("protected")).resolves.toMatchObject([{ content: "protected history" }]);
    await expect(bounded.load("victim")).resolves.toEqual([]);
    await expect(bounded.load("newcomer")).resolves.toMatchObject([{ content: "new history" }]);
    await active.abort();
  });

  it("keeps canonical history clean on abort and removes the sidecar only after a clean commit", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    await store.append("conversation", [{ role: "assistant", content: "kept canonical" }]);
    const before = await readHistoryRecord(root, "conversation");

    const aborted = await store.beginProviderSessionTurn("conversation", "run-aborted");
    await aborted.abort();
    expect(await readHistoryRecord(root, "conversation")).toEqual(before);
    expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest("conversation")]);

    const restarted = await createDurableHistoryStore({ root })
      .beginProviderSessionTurn("conversation", "run-restarted");
    expect(restarted.providerSessionId).not.toBe(aborted.providerSessionId);
    expect(restarted.providerSessionRevision).toBe(0);
    const committed = await restarted.prepareCommit(
      [{ role: "assistant", content: "cleanly committed" }],
      { providerSessionSynced: true },
    );
    await committed.commit();

    expect(await dirtyFenceKeys(root)).toEqual([]);
    expect(await readHistoryRecord(root, "conversation")).toMatchObject({
      version: 2,
      messages: [{ content: "kept canonical" }, { content: "cleanly committed" }],
      providerSession: { revision: 1 },
    });
  });

  it("bounds failed-new dirty sidecars without evicting canonical history", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seed = createDurableHistoryStore({ root });
    await seed.append("kept", [{ role: "assistant", content: "must survive" }]);
    const bounded = createDurableHistoryStore({ root, maxConversations: 1 });

    for (const conversationId of ["failed-a", "failed-b", "failed-c"]) {
      const turn = await bounded.beginProviderSessionTurn(conversationId, `run-${conversationId}`);
      await turn.abort();
      expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest(conversationId)]);
      await expect(bounded.load("kept")).resolves.toMatchObject([{ content: "must survive" }]);
      await expect(bounded.load(conversationId)).resolves.toEqual([]);
    }

    // A fence for a canonical conversation is never reclaimed merely to admit
    // another provider attempt.
    const protectedTurn = await bounded.beginProviderSessionTurn("kept", "run-protected");
    await protectedTurn.abort();
    expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest("kept")]);
    await expect(bounded.beginProviderSessionTurn("rejected", "run-rejected"))
      .rejects.toThrow(/dirty fences.*1-conversation quota/iu);
    expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest("kept")]);
    await expect(bounded.load("kept")).resolves.toMatchObject([{ content: "must survive" }]);
  });

  it("uses inactive dirty fences as retirement journals on the next unrelated mutation", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    const store = createDurableHistoryStore({
      root,
      retireProviderSession: async (providerSessionId) => {
        retired.push(providerSessionId);
      },
    });

    const crashed = await store.beginProviderSessionTurn("crashed", "run-crashed");
    await crashed.abort();
    expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest("crashed")]);

    await store.append("unrelated", [{ role: "assistant", content: "maintenance trigger" }]);
    expect(retired).toContain(crashed.providerSessionId);
    expect(await dirtyFenceKeys(root)).toEqual([]);
  });

  it("preserves a committed provider transcript when only dirty-fence cleanup crashed", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const retired: string[] = [];
    const store = createDurableHistoryStore({
      root,
      retireProviderSession: async (providerSessionId) => {
        retired.push(providerSessionId);
      },
    });

    const turn = await store.beginProviderSessionTurn("committed", "run-committed");
    const fencePath = join(root, ".locks", `${historyKeyForTest("committed")}.dirty.json`);
    const fenceBytes = await readFile(fencePath);
    const commit = await turn.prepareCommit([
      { role: "assistant", content: "durably committed" },
    ], { providerSessionSynced: true });
    await commit.commit();

    // Recreate the exact post-rename/pre-fence-cleanup crash state: canonical
    // history is at revision+1 while the old v2 fence is still visible.
    await writeFile(fencePath, fenceBytes);
    await chmod(fencePath, 0o600);
    await store.append("unrelated", [{ role: "assistant", content: "maintenance trigger" }]);

    expect(retired).not.toContain(turn.providerSessionId);
    expect(await dirtyFenceKeys(root)).toEqual([]);
    const resumed = await store.beginProviderSessionTurn("committed", "run-resumed");
    expect(resumed.providerSessionId).toBe(turn.providerSessionId);
    expect(resumed.providerSessionRevision).toBe(1);
    await resumed.abort();
  });

  it("rejects an impossible projected clean record before publishing a dirty sidecar", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root, maxStoreBytes: 1 });

    await expect(store.beginProviderSessionTurn("conversation", "run-impossible"))
      .rejects.toThrow(/aggregate quota/iu);
    expect(await dirtyFenceKeys(root)).toEqual([]);
    await expect(store.stats()).resolves.toMatchObject({ conversations: 0, activePreparedAppends: 0 });
  });

  it("rotates revision overflow to a fresh epoch at revision zero", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    const first = await store.beginProviderSessionTurn("conversation", "run-first");
    const firstCommit = await first.prepareCommit([], { providerSessionSynced: true });
    await firstCommit.commit();

    const path = (await historyRecords(root)).get("conversation") as string;
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const providerSession = record.providerSession as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({
      ...record,
      providerSession: { ...providerSession, revision: Number.MAX_SAFE_INTEGER },
    })}\n`);

    const overflow = await createDurableHistoryStore({ root })
      .beginProviderSessionTurn("conversation", "run-overflow");
    expect(overflow.providerSessionId).not.toBe(first.providerSessionId);
    expect(overflow.providerSessionRevision).toBe(0);
    const overflowCommit = await overflow.prepareCommit([], { providerSessionSynced: true });
    await overflowCommit.commit();
    expect((await readHistoryRecord(root, "conversation")).providerSession).toMatchObject({ revision: 1 });
  });

  it("serializes 30 independent Node processes appending one conversation", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const compiledPath = join(dir, "durable-history.mjs");
    const workerPath = join(dir, "worker.mjs");
    const source = await readFile(new URL("../durable-history.ts", import.meta.url), "utf8");
    await writeFile(compiledPath, transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText);
    await writeFile(workerPath, [
      'import { createDurableHistoryStore } from "./durable-history.mjs";',
      "const [root, index] = process.argv.slice(2);",
      "const store = createDurableHistoryStore({ root });",
      "await store.append('shared', [{ role: 'user', content: `worker-${index}` }]);",
    ].join("\n"));

    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      await execFileAsync(process.execPath, [workerPath, root, String(index)], {
        env: { ...process.env },
        maxBuffer: 1024 * 1024,
      });
    }));

    const messages = await createDurableHistoryStore({ root }).load("shared");
    expect(messages).toHaveLength(30);
    expect(messages.map((message) => message.content).sort()).toEqual(
      Array.from({ length: 30 }, (_, index) => `worker-${index}`).sort(),
    );
  }, 30_000);

  it("uses a fixed lock shard table instead of leaking one SQLite file per conversation", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root, maxConversations: 1 });

    const first = await store.beginProviderSessionTurn("aborted-0", "run-0");
    await first.abort();
    const locksRoot = join(root, ".locks");
    const initialSqliteLocks = (await readdir(locksRoot))
      .filter((name) => name.endsWith(".sqlite"))
      .sort();
    expect(initialSqliteLocks).toHaveLength(17);
    expect(initialSqliteLocks).toContain("root.sqlite");
    expect(initialSqliteLocks.filter((name) => /^conversation-shard-[a-f0-9]{2}\.sqlite$/u.test(name)))
      .toHaveLength(16);
    expect(initialSqliteLocks.some((name) => /^[a-f0-9]{64}\.sqlite$/u.test(name))).toBe(false);

    for (let index = 1; index < 25; index += 1) {
      const turn = await store.beginProviderSessionTurn(`aborted-${index}`, `run-${index}`);
      await turn.abort();
    }

    expect((await readdir(locksRoot)).filter((name) => name.endsWith(".sqlite")).sort())
      .toEqual(initialSqliteLocks);
    expect(await dirtyFenceKeys(root)).toHaveLength(1);
  });

  it("keeps and honors legacy per-conversation lock inodes during migration", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    await store.append("legacy-lock", [{ role: "assistant", content: "kept" }]);
    const legacyLockPath = join(root, ".locks", `${historyKeyForTest("legacy-lock")}.sqlite`);
    await writeFile(legacyLockPath, "");
    await chmod(legacyLockPath, 0o600);

    const turn = await store.beginProviderSessionTurn("legacy-lock", "run-legacy-lock");
    await turn.abort();

    expect((await lstat(legacyLockPath)).isFile()).toBe(true);
    expect((await lstat(legacyLockPath)).mode & 0o777).toBe(0o600);
  });

  it("waits for a live cross-process owner and recovers its dirty epoch after process death", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const compiledPath = join(dir, "durable-history.mjs");
    const workerPath = join(dir, "crash-worker.mjs");
    const source = await readFile(new URL("../durable-history.ts", import.meta.url), "utf8");
    await writeFile(compiledPath, transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText);
    await writeFile(workerPath, [
      'import { createDurableHistoryStore } from "./durable-history.mjs";',
      "const store = createDurableHistoryStore({ root: process.argv[2] });",
      "const turn = await store.beginProviderSessionTurn('shared', 'crashed-run');",
      "process.stdout.write(`${turn.providerSessionId}\\n`);",
      "setInterval(() => undefined, 60_000);",
    ].join("\n"));

    const child = spawn(process.execPath, [workerPath, root], { stdio: ["ignore", "pipe", "pipe"] });
    const [firstChunk] = await once(child.stdout, "data") as [Buffer];
    const crashedSessionId = firstChunk.toString("utf8").trim();
    let recovered = false;
    const recovery = createDurableHistoryStore({ root })
      .beginProviderSessionTurn("shared", "recovered-run")
      .then((turn) => {
        recovered = true;
        return turn;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recovered).toBe(false);

    child.kill();
    await once(child, "exit");
    const recoveredTurn = await recovery;
    expect(recoveredTurn.providerSessionId).not.toBe(crashedSessionId);
    expect(recoveredTurn.providerSessionRevision).toBe(0);
    await expect(createDurableHistoryStore({ root }).load("shared")).resolves.toEqual([]);
    expect(await dirtyFenceKeys(root)).toEqual([historyKeyForTest("shared")]);
    await recoveredTurn.abort();
  }, 20_000);

  it("keeps prepared history invisible until commit and supports abort, restart, and idempotent settlement", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    await store.append("conversation", [{ role: "user", content: "committed" }]);

    const aborted = await store.prepareAppend("conversation", [{ role: "assistant", content: "staged-abort" }]);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    await expect(createDurableHistoryStore({ root }).load("conversation"))
      .resolves.toMatchObject([{ content: "committed" }]);
    await expect(store.stats()).resolves.toMatchObject({ activePreparedAppends: 1, conversations: 1 });
    await aborted.abort();
    await aborted.abort();
    await expect(createDurableHistoryStore({ root }).load("conversation"))
      .resolves.toMatchObject([{ content: "committed" }]);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);

    const committed = await store.prepareAppend("conversation", [{ role: "assistant", content: "staged-commit" }]);
    await expect(createDurableHistoryStore({ root }).load("conversation"))
      .resolves.toMatchObject([{ content: "committed" }]);
    await committed.commit();
    await committed.commit();
    await committed.abort();
    await expect(createDurableHistoryStore({ root }).load("conversation")).resolves.toMatchObject([
      { content: "committed" },
      { content: "staged-commit" },
    ]);
    await expect(store.stats()).resolves.toMatchObject({
      activePreparedAppends: 0,
      conversations: 1,
      postCommitMaintenanceFailures: 0,
    });
  });

  it("bounds aggregate live staging bytes independently of committed-history retention", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({
      root,
      maxStoreBytes: 1024 * 1024,
      maxStagedBytes: 8 * 1024,
    });
    const payload = "x".repeat(5 * 1024);
    const first = await store.prepareAppend("first", [{ role: "assistant", content: payload }]);

    await expect(store.prepareAppend("second", [{ role: "assistant", content: payload }]))
      .rejects.toThrow(/staging quota/iu);
    await first.abort();

    const afterRelease = await store.prepareAppend("second", [{ role: "assistant", content: payload }]);
    await afterRelease.abort();
    await expect(store.stats()).resolves.toMatchObject({
      activePreparedAppends: 0,
      limits: { maxStagedBytes: 8 * 1024 },
    });
  });

  it("reaps a dead-owner stage immediately when no active marker protects it", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    await store.append("seed", [{ role: "assistant", content: "seed" }]);
    const orphan = join(
      root,
      `.${historyKeyForTest("orphan")}.2147483647.${"a".repeat(24)}.tmp`,
    );
    await writeFile(orphan, "recent crash stage");
    await chmod(orphan, 0o600);

    const prepared = await store.prepareAppend("trigger", [{ role: "assistant", content: "trigger" }]);
    expect((await readdir(root)).some((name) => name === orphan.split("/").at(-1))).toBe(false);
    await prepared.abort();
  });

  it("releases active capacity when abort cannot unlink its staged file", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root, maxStagedBytes: 16 * 1024 });
    const prepared = await store.prepareAppend("aborted", [{ role: "user", content: "staged" }]);
    const stagedName = (await readdir(root)).find((name) => name.endsWith(".tmp")) as string;
    const stagedPath = join(root, stagedName);
    const savedPath = `${stagedPath}.saved`;
    await rename(stagedPath, savedPath);
    await mkdir(stagedPath);
    await writeFile(join(stagedPath, "blocks-unlink"), "occupied", { mode: 0o600 });

    await expect(prepared.abort()).rejects.toThrow();

    await rm(stagedPath, { recursive: true });
    await rename(savedPath, stagedPath);
    await expect(store.stats()).resolves.toMatchObject({ activePreparedAppends: 0 });
    const admitted = await store.prepareAppend("later", [{ role: "assistant", content: "not wedged" }]);
    expect(await readdir(root)).not.toContain(stagedName);
    await admitted.abort();
  });

  it("does not evict committed retention victims when a prepared replacement is aborted", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seed = createDurableHistoryStore({ root });
    await seed.append("committed-a", [{ role: "assistant", content: "must survive" }]);

    const bounded = createDurableHistoryStore({ root, maxConversations: 1 });
    const prepared = await bounded.prepareAppend("staged-b", [{ role: "assistant", content: "never commit" }]);
    await expect(bounded.load("committed-a")).resolves.toMatchObject([{ content: "must survive" }]);
    await expect(bounded.load("staged-b")).resolves.toEqual([]);
    await prepared.abort();

    const restarted = createDurableHistoryStore({ root });
    await expect(restarted.load("committed-a")).resolves.toMatchObject([{ content: "must survive" }]);
    await expect(restarted.load("staged-b")).resolves.toEqual([]);
    await expect(restarted.stats()).resolves.toMatchObject({ conversations: 1, activePreparedAppends: 0 });
  });

  it("does not prune on behalf of another unpublished stage that later aborts", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const bounded = createDurableHistoryStore({ root, maxConversations: 2 });
    await bounded.append("a", [{ role: "assistant", content: "committed a" }]);

    const stagedB = await bounded.prepareAppend("b", [{ role: "assistant", content: "unpublished b" }]);
    await bounded.append("c", [{ role: "assistant", content: "committed c" }]);
    await expect(bounded.load("a")).resolves.toMatchObject([{ content: "committed a" }]);
    await expect(bounded.load("c")).resolves.toMatchObject([{ content: "committed c" }]);

    await stagedB.abort();
    const restarted = createDurableHistoryStore({ root, maxConversations: 2 });
    await expect(restarted.load("a")).resolves.toMatchObject([{ content: "committed a" }]);
    await expect(restarted.load("b")).resolves.toEqual([]);
    await expect(restarted.load("c")).resolves.toMatchObject([{ content: "committed c" }]);
    await expect(restarted.stats()).resolves.toMatchObject({ conversations: 2, activePreparedAppends: 0 });
  });

  it("returns committed success and exposes diagnostics when post-rename maintenance fails", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({
      root,
      now: () => {
        throw new Error("injected post-rename retention failure");
      },
    });

    const prepared = await store.prepareAppend("conversation", [{ role: "assistant", content: "published" }]);
    await expect(prepared.commit()).resolves.toBeUndefined();
    await expect(createDurableHistoryStore({ root }).load("conversation"))
      .resolves.toMatchObject([{ content: "published" }]);
    await expect(store.stats()).resolves.toMatchObject({
      activePreparedAppends: 0,
      postCommitMaintenanceFailures: 1,
      lastPostCommitMaintenanceError: "injected post-rename retention failure",
    });
  });

  it("accepts exactly 64 KiB of UTF-8 content while independently bounding metadata", async () => {
    const dir = await tempDir();
    const store = createDurableHistoryStore({ root: join(dir, "history") });
    const exact = "x".repeat(64 * 1024);

    await store.append("exact", [{ role: "user", content: exact }]);
    await expect(store.load("exact")).resolves.toEqual([{ role: "user", content: exact }]);
    await expect(store.append("too-large", [
      { role: "user", content: `${exact}x` },
    ])).rejects.toThrow(/content.*65536/iu);
    await expect(store.append("metadata", [
      { role: "user", content: "small", name: "n".repeat(17 * 1024) },
    ])).rejects.toThrow(/metadata.*16384/iu);
  });

  it("prunes deterministically by age, conversation count, and aggregate bytes", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seed = createDurableHistoryStore({ root });
    await seed.append("a", [{ role: "assistant", content: "same" }]);
    await seed.append("b", [{ role: "assistant", content: "same" }]);
    const records = await historyRecords(root);
    const a = records.get("a") as string;
    const b = records.get("b") as string;
    await utimes(a, new Date(1_000), new Date(1_000));
    await utimes(b, new Date(2_000), new Date(2_000));
    const oneRecordBytes = (await lstat(a)).size;

    const bounded = createDurableHistoryStore({
      root,
      maxStoreBytes: oneRecordBytes * 2,
      maxConversations: 2,
      maxAgeMs: 2_500,
      now: () => 4_000,
    });
    await bounded.append("c", [{ role: "assistant", content: "same" }]);
    await expect(bounded.load("a")).resolves.toEqual([]);
    await expect(bounded.load("b")).resolves.toMatchObject([{ content: "same" }]);
    await expect(bounded.load("c")).resolves.toMatchObject([{ content: "same" }]);
    await expect(bounded.stats()).resolves.toMatchObject({
      conversations: 2,
      bytes: oneRecordBytes * 2,
      limits: { maxStoreBytes: oneRecordBytes * 2, maxConversations: 2, maxAgeMs: 2_500 },
    });

    const countOnly = createDurableHistoryStore({ root, maxConversations: 2, now: () => 5_000 });
    await countOnly.append("d", [{ role: "assistant", content: "same" }]);
    await expect(countOnly.load("b")).resolves.toEqual([]);
    await expect(countOnly.load("c")).resolves.toMatchObject([{ content: "same" }]);
    await expect(countOnly.load("d")).resolves.toMatchObject([{ content: "same" }]);
  });

  it("protects every active staged conversation from retention and stale-temp cleanup", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const seed = createDurableHistoryStore({ root });
    await seed.append("protected", [{ role: "user", content: "old protected" }]);
    await seed.append("victim", [{ role: "user", content: "old victim" }]);

    const prepared = await seed.prepareAppend("protected", [{ role: "assistant", content: "not visible" }]);
    const stagedName = (await readdir(root)).find((name) => name.endsWith(".tmp")) as string;
    await utimes(join(root, stagedName), new Date(0), new Date(0));
    const pruningStore = createDurableHistoryStore({ root, maxConversations: 2, now: () => 2 * 86_400_000 });
    await pruningStore.append("newcomer", [{ role: "assistant", content: "new" }]);

    expect((await readdir(root)).some((name) => name === stagedName)).toBe(true);
    await expect(pruningStore.load("protected")).resolves.toMatchObject([{ content: "old protected" }]);
    await expect(pruningStore.load("victim")).resolves.toEqual([]);
    await expect(pruningStore.load("newcomer")).resolves.toMatchObject([{ content: "new" }]);
    await prepared.abort();
    await expect(pruningStore.load("protected")).resolves.toMatchObject([{ content: "old protected" }]);
  });

  it("rejects an unreservable prepared append without leaking stage bytes or locks", async () => {
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root, maxStoreBytes: 1 });

    await expect(store.prepareAppend("conversation", [{ role: "user", content: "too much" }]))
      .rejects.toThrow(/staging quota/iu);
    expect((await readdir(root)).filter((name) => name.endsWith(".history.json"))).toEqual([]);
    await expect(store.stats()).resolves.toMatchObject({ activePreparedAppends: 0, conversations: 0 });

    const roomy = createDurableHistoryStore({ root });
    await roomy.append("protected", [{ role: "user", content: "keep protected" }]);
    await roomy.append("victim", [{ role: "user", content: "keep victim" }]);
    const active = await roomy.prepareAppend("protected", [{ role: "assistant", content: "active" }]);
    const impossible = createDurableHistoryStore({ root, maxConversations: 1 });
    await expect(impossible.prepareAppend("newcomer", [{ role: "assistant", content: "cannot fit" }]))
      .rejects.toThrow(/conversation quota/iu);
    await expect(roomy.load("victim")).resolves.toMatchObject([{ content: "keep victim" }]);
    await active.abort();
  });

  it("keeps conversation ids path-opaque and collision-free", async () => {
    const dir = await tempDir();
    const store = createDurableHistoryStore({ root: join(dir, "history") });

    await store.append("../same", [{ role: "assistant", content: "one" }]);
    await store.append("..\\same", [{ role: "assistant", content: "two" }]);

    await expect(store.load("../same")).resolves.toMatchObject([{ content: "one" }]);
    await expect(store.load("..\\same")).resolves.toMatchObject([{ content: "two" }]);
    expect((await readdir(join(dir, "history"))).filter((name) => name.endsWith(".history.json"))).toHaveLength(2);
  });

  it("rejects relative roots, oversized inputs, and unsafe retained files", async () => {
    expect(() => createDurableHistoryStore({ root: "relative/history" })).toThrow(/absolute path/iu);
    const dir = await tempDir();
    const root = join(dir, "history");
    const store = createDurableHistoryStore({ root });
    await expect(store.append("conversation", [
      { role: "user", content: "x".repeat(64 * 1024 + 1) },
    ])).rejects.toThrow(/65536/iu);
    await expect(store.load("x".repeat(4097))).rejects.toThrow(/4096/iu);

    await store.append("conversation", [{ role: "assistant", content: "safe" }]);
    const fileName = (await readdir(root)).find((name) => name.endsWith(".history.json")) as string;
    await chmod(join(root, fileName as string), 0o644);
    await expect(store.load("conversation")).rejects.toThrow(/0600/iu);
    await chmod(join(root, fileName), 0o600);
    const conversationLock = (await readdir(join(root, ".locks")))
      .find((name) => /^conversation-shard-[a-f0-9]{2}\.sqlite$/u.test(name)) as string;
    await chmod(join(root, ".locks", conversationLock), 0o644);
    await expect(store.append("conversation", [{ role: "assistant", content: "unsafe lock" }]))
      .rejects.toThrow(/0600/iu);
  });

  it("fails closed for symlink roots and symlink conversation files", async () => {
    const dir = await tempDir();
    const realRoot = join(dir, "real-history");
    const linkedRoot = join(dir, "linked-history");
    const realStore = createDurableHistoryStore({ root: realRoot });
    await realStore.append("conversation", [{ role: "assistant", content: "safe" }]);
    await symlink(realRoot, linkedRoot, "dir");
    await expect(createDurableHistoryStore({ root: linkedRoot }).load("conversation")).rejects.toThrow(/symbolic link/iu);

    const fileName = (await readdir(realRoot)).find((name) => name.endsWith(".history.json")) as string;
    const filePath = join(realRoot, fileName as string);
    await rm(filePath);
    await symlink(join(dir, "outside.json"), filePath);
    await expect(realStore.load("conversation")).rejects.toThrow(/non-symlink regular file/iu);
  });
});

async function historyRecords(root: string): Promise<Map<string, string>> {
  const records = new Map<string, string>();
  for (const name of await readdir(root)) {
    if (!name.endsWith(".history.json")) continue;
    const path = join(root, name);
    const parsed = JSON.parse(await readFile(path, "utf8")) as { conversationId: string };
    records.set(parsed.conversationId, path);
  }
  return records;
}

async function readHistoryRecord(
  root: string,
  conversationId: string,
): Promise<TestHistoryRecord> {
  const path = (await historyRecords(root)).get(conversationId);
  if (path === undefined) throw new Error(`Missing history record for ${conversationId}.`);
  return JSON.parse(await readFile(path, "utf8")) as TestHistoryRecord;
}

function historyKeyForTest(conversationId: string): string {
  return createHash("sha256")
    .update("mono-agent-history-v1\0")
    .update(conversationId.trim(), "utf8")
    .digest("hex");
}

async function dirtyFenceKeys(root: string): Promise<string[]> {
  const locksRoot = join(root, ".locks");
  return (await readdir(locksRoot))
    .flatMap((name) => {
      const match = /^([a-f0-9]{64})\.dirty\.json$/u.exec(name);
      return match === null ? [] : [match[1] as string];
    })
    .sort();
}
