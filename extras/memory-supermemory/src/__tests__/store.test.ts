import { describe, expect, it } from "vitest";

import type { SupermemoryAddParams, SupermemoryClient, SupermemoryHit, SupermemorySearchParams } from "../client.js";
import { SupermemoryMemoryStore } from "../store.js";

class FakeClient implements SupermemoryClient {
  readonly added: SupermemoryAddParams[] = [];
  readonly searches: SupermemorySearchParams[] = [];
  hits: SupermemoryHit[] = [];
  failAdd = false;
  failSearch = false;
  addGate: Promise<void> | undefined;
  readonly addGates: Array<Promise<void> | undefined> = [];

  async add(params: SupermemoryAddParams): Promise<void> {
    const callIndex = this.added.length;
    this.added.push(params);
    await (this.addGates[callIndex] ?? this.addGate);
    if (this.failAdd) {
      throw new Error("boom-add");
    }
  }

  async search(params: SupermemorySearchParams): Promise<SupermemoryHit[]> {
    this.searches.push(params);
    if (this.failSearch) {
      throw new Error("boom-search");
    }
    return this.hits;
  }
}

function makeStore(
  client: SupermemoryClient,
  options: { readonly maxBytes?: number; readonly completedTurnCacheMaxEntries?: number } = {},
) {
  const warnings: string[] = [];
  const store = new SupermemoryMemoryStore(client, {
    logger: { warn: (m) => warnings.push(m) },
    ...options,
  });
  return { store, warnings };
}

describe("SupermemoryMemoryStore.load", () => {
  it("formats search hits into a markdown block scoped by query", async () => {
    const client = new FakeClient();
    client.hits = [
      { id: "a", text: "user prefers dark mode", score: 0.91 },
      { id: "b", text: "ships on Fridays", score: 0.42 },
    ];
    const { store } = makeStore(client);

    const block = await store.load("conv-1", "preferences");

    expect(block?.kind).toBe("markdown");
    expect(block?.source).toBe("supermemory");
    expect(block?.truncated).toBe(false);
    expect(block?.content).toContain("user prefers dark mode");
    expect(block?.content).toContain("(0.910)");
    expect(client.searches[0]?.query).toBe("preferences");
  });

  it("falls back to the conversation id when no query is given", async () => {
    const client = new FakeClient();
    client.hits = [{ id: "a", text: "x", score: 1 }];
    const { store } = makeStore(client);

    await store.load("conv-7");

    expect(client.searches[0]?.query).toBe("conv-7");
  });

  it("returns undefined when there are no hits", async () => {
    const client = new FakeClient();
    client.hits = [];
    const { store } = makeStore(client);

    expect(await store.load("c", "q")).toBeUndefined();
  });

  it("degrades to undefined (never throws) when search fails", async () => {
    const client = new FakeClient();
    client.failSearch = true;
    const { store, warnings } = makeStore(client);

    expect(await store.load("c", "q")).toBeUndefined();
    expect(warnings.some((w) => w.includes("recall failed"))).toBe(true);
  });

  it("truncates the block to maxBytes", async () => {
    const client = new FakeClient();
    client.hits = Array.from({ length: 50 }, (_v, i) => ({ id: `h${i}`, text: "x".repeat(200), score: 0.5 }));
    const { store } = makeStore(client, { maxBytes: 256 });

    const block = await store.load("c", "q");

    expect(block?.truncated).toBe(true);
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(256);
  });
});

describe("SupermemoryMemoryStore.appendHostSummary", () => {
  it("adds a one-line document with an idempotent customId and returns bytesWritten", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    const result = await store.appendHostSummary("conv-1", "remembered a fact");

    expect(result).toEqual({ conversationId: "conv-1", source: "supermemory", bytesWritten: 17 });
    const added = client.added[0];
    expect(added?.content).toBe("remembered a fact");
    // Supermemory customIds allow only [A-Za-z0-9._-] — no colon.
    expect(added?.customId).toMatch(/^host-summary-[a-f0-9]+$/u);
    expect(added?.metadata).toMatchObject({ kind: "host-summary", conversationId: "conv-1" });
  });

  it("derives a stable customId for identical content", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    await store.appendHostSummary("conv-1", "same");
    await store.appendHostSummary("conv-1", "same");

    expect(client.added[0]?.customId).toBe(client.added[1]?.customId);
  });

  it("returns bytesWritten 0 and never throws when the add fails", async () => {
    const client = new FakeClient();
    client.failAdd = true;
    const { store, warnings } = makeStore(client);

    const result = await store.appendHostSummary("conv-1", "x");

    expect(result.bytesWritten).toBe(0);
    expect(warnings.some((w) => w.includes("appendHostSummary failed"))).toBe(true);
  });
});

describe("SupermemoryMemoryStore.persistCompletedTurn", () => {
  it.each([0, 1.5, 1_000_001, Number.NaN])(
    "rejects an invalid completed-turn cache bound (%s)",
    (completedTurnCacheMaxEntries) => {
      expect(() => makeStore(new FakeClient(), { completedTurnCacheMaxEntries })).toThrow(
        /completedTurnCacheMaxEntries/u,
      );
    },
  );

  it("awaits one clear remote document and returns its stable admission id", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    const result = await store.persistCompletedTurn({
      runId: "run-strong-1",
      conversationId: "telegram:private-conversation",
      summary: "Host-observed completed turn.",
      captureText: "User: Remember cobalt.\nAssistant: I will remember cobalt.",
    });

    expect(client.added).toHaveLength(1);
    expect(client.added[0]?.content).toBe([
      "Completed turn summary:",
      "Host-observed completed turn.",
      "",
      "Completed turn capture:",
      "User: Remember cobalt.",
      "Assistant: I will remember cobalt.",
    ].join("\n"));
    expect(client.added[0]?.customId).toMatch(/^completed-turn-[a-f0-9]{32}$/u);
    expect(client.added[0]?.metadata).toEqual({
      kind: "completed-turn",
      schemaVersion: 1,
      hasCapture: true,
    });
    expect(JSON.stringify(client.added[0]?.metadata)).not.toContain("private-conversation");
    expect(result).toMatchObject({
      id: client.added[0]?.customId,
      runId: "run-strong-1",
      conversationId: "telegram:private-conversation",
      source: "supermemory",
      admissionStatus: "admitted",
    });
    expect(result.bytesWritten).toBe(Buffer.byteLength(client.added[0]?.content ?? "", "utf8"));
  });

  it("returns an exact same-process retry as a duplicate without another request", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    const input = {
      runId: "run-retry",
      conversationId: "conversation-a",
      summary: "First deterministic summary.",
    };
    const admitted = await store.persistCompletedTurn(input);
    const duplicate = await store.persistCompletedTurn(input);

    expect(client.added).toHaveLength(1);
    expect(admitted.admissionStatus).toBe("admitted");
    expect(duplicate).toMatchObject({
      id: admitted.id,
      admissionStatus: "duplicate",
      bytesWritten: 0,
    });
  });

  it("evicts the least-recently-used completed turn while preserving recent duplicate detection", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client, { completedTurnCacheMaxEntries: 2 });
    const first = { runId: "run-first", conversationId: "conversation", summary: "First." };
    const second = { runId: "run-second", conversationId: "conversation", summary: "Second." };
    const third = { runId: "run-third", conversationId: "conversation", summary: "Third." };

    const firstAdmission = await store.persistCompletedTurn(first);
    const secondAdmission = await store.persistCompletedTurn(second);
    expect((await store.persistCompletedTurn(first)).admissionStatus).toBe("duplicate");
    await store.persistCompletedTurn(third);

    expect((await store.persistCompletedTurn(first)).admissionStatus).toBe("duplicate");
    const lateSecondRetry = await store.persistCompletedTurn(second);

    expect(client.added).toHaveLength(4);
    expect(lateSecondRetry).toMatchObject({
      id: secondAdmission.id,
      admissionStatus: "admitted",
    });
    expect(client.added[3]?.customId).toBe(secondAdmission.id);
    expect(client.added[3]?.customId).not.toBe(firstAdmission.id);
  });

  it("does not let a conflicting lookup refresh a completed turn's LRU position", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client, { completedTurnCacheMaxEntries: 2 });
    const first = { runId: "run-first", conversationId: "conversation", summary: "First." };
    const second = { runId: "run-second", conversationId: "conversation", summary: "Second." };

    const firstAdmission = await store.persistCompletedTurn(first);
    await store.persistCompletedTurn(second);
    await expect(store.persistCompletedTurn({ ...first, summary: "Conflict." }))
      .rejects.toThrow(/conflicts/iu);
    await store.persistCompletedTurn({
      runId: "run-third",
      conversationId: "conversation",
      summary: "Third.",
    });

    expect((await store.persistCompletedTurn(second)).admissionStatus).toBe("duplicate");
    expect((await store.persistCompletedTurn(first)).admissionStatus).toBe("admitted");
    expect(client.added).toHaveLength(4);
    expect(client.added[3]?.customId).toBe(firstAdmission.id);
  });

  it("treats the first post-eviction payload as a new stable-id upsert and coalesces its retries", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client, { completedTurnCacheMaxEntries: 1 });
    const original = { runId: "run-reused", conversationId: "conversation", summary: "Original." };
    const originalAdmission = await store.persistCompletedTurn(original);
    await store.persistCompletedTurn({
      runId: "run-evictor",
      conversationId: "conversation",
      summary: "Evicts the original fingerprint.",
    });
    let releaseReplacement!: () => void;
    client.addGates[2] = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const replacement = { ...original, summary: "Replacement after eviction." };

    const replacementAdmission = store.persistCompletedTurn(replacement);
    const replacementDuplicate = store.persistCompletedTurn(replacement);
    await expect(store.persistCompletedTurn({ ...replacement, summary: "Concurrent conflict." }))
      .rejects.toThrow(/conflicts/iu);
    expect(client.added).toHaveLength(3);
    releaseReplacement();
    const [admitted, duplicate] = await Promise.all([replacementAdmission, replacementDuplicate]);

    expect(admitted).toMatchObject({ id: originalAdmission.id, admissionStatus: "admitted" });
    expect(duplicate).toMatchObject({ id: originalAdmission.id, admissionStatus: "duplicate" });
    expect(client.added[2]?.customId).toBe(client.added[0]?.customId);
    expect(client.added[2]?.content).not.toBe(client.added[0]?.content);
  });

  it("does not let a failed completion evict a successful duplicate fingerprint", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client, { completedTurnCacheMaxEntries: 1 });
    const completed = { runId: "run-completed", conversationId: "conversation", summary: "Completed." };

    await store.persistCompletedTurn(completed);
    client.failAdd = true;
    await expect(store.persistCompletedTurn({
      runId: "run-failed",
      conversationId: "conversation",
      summary: "Failed.",
    })).rejects.toThrow("boom-add");
    client.failAdd = false;

    expect((await store.persistCompletedTurn(completed)).admissionStatus).toBe("duplicate");
    expect(client.added).toHaveLength(2);
  });

  it("orders the LRU by successful completion while in-flight exact retries remain coalesced", async () => {
    const client = new FakeClient();
    let releaseLate!: () => void;
    client.addGates[0] = new Promise<void>((resolve) => { releaseLate = resolve; });
    const { store } = makeStore(client, { completedTurnCacheMaxEntries: 1 });
    const late = { runId: "run-late", conversationId: "conversation", summary: "Late completion." };
    const early = { runId: "run-early", conversationId: "conversation", summary: "Early completion." };

    const lateAdmission = store.persistCompletedTurn(late);
    const lateDuplicate = store.persistCompletedTurn(late);
    await expect(store.persistCompletedTurn({ ...late, summary: "Conflicting in-flight payload." }))
      .rejects.toThrow(/conflicts/iu);
    const earlyAdmission = await store.persistCompletedTurn(early);
    releaseLate();
    const [admitted, duplicate] = await Promise.all([lateAdmission, lateDuplicate]);

    expect(admitted.admissionStatus).toBe("admitted");
    expect(duplicate).toMatchObject({ admissionStatus: "duplicate", bytesWritten: 0 });
    expect((await store.persistCompletedTurn(late)).admissionStatus).toBe("duplicate");
    const retriedEarly = await store.persistCompletedTurn(early);
    expect(retriedEarly).toMatchObject({ id: earlyAdmission.id, admissionStatus: "admitted" });
    expect(client.added).toHaveLength(3);
  });

  it("refreshes a coalesced retry that resumes after another completion evicted it", async () => {
    const client = new FakeClient();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    client.addGates[0] = new Promise<void>((resolve) => { releaseFirst = resolve; });
    client.addGates[1] = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const { store } = makeStore(client, { completedTurnCacheMaxEntries: 1 });
    const first = { runId: "run-first", conversationId: "conversation", summary: "First." };
    const second = { runId: "run-second", conversationId: "conversation", summary: "Second." };

    const firstAdmission = store.persistCompletedTurn(first);
    const firstDuplicate = store.persistCompletedTurn(first);
    const secondAdmission = store.persistCompletedTurn(second);
    releaseFirst();
    releaseSecond();
    const [admitted, duplicate] = await Promise.all([firstAdmission, firstDuplicate, secondAdmission]);

    expect(admitted.admissionStatus).toBe("admitted");
    expect(duplicate).toMatchObject({ admissionStatus: "duplicate", bytesWritten: 0 });
    expect((await store.persistCompletedTurn(first)).admissionStatus).toBe("duplicate");
    expect((await store.persistCompletedTurn(second)).admissionStatus).toBe("admitted");
    expect(client.added).toHaveLength(3);
  });

  it("rejects conflicting reuse of a run id before a second request", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    await store.persistCompletedTurn({
      runId: "run-retry",
      conversationId: "conversation-a",
      summary: "First deterministic summary.",
    });
    await expect(store.persistCompletedTurn({
      runId: "run-retry",
      conversationId: "conversation-b",
      summary: "Conflicting payload.",
    })).rejects.toThrow(/conflicts/iu);

    expect(client.added).toHaveLength(1);
  });

  it("coalesces concurrent exact retries and rejects an in-flight conflict", async () => {
    const client = new FakeClient();
    let release!: () => void;
    client.addGate = new Promise<void>((resolve) => { release = resolve; });
    const { store } = makeStore(client);
    const input = {
      runId: "run-concurrent",
      conversationId: "conversation",
      summary: "One exact payload.",
    };

    const first = store.persistCompletedTurn(input);
    const duplicate = store.persistCompletedTurn(input);
    await expect(store.persistCompletedTurn({ ...input, summary: "Different payload." })).rejects.toThrow(/conflicts/iu);
    expect(client.added).toHaveLength(1);
    release();
    const [admitted, repeated] = await Promise.all([first, duplicate]);

    expect(admitted.admissionStatus).toBe("admitted");
    expect(repeated).toMatchObject({ admissionStatus: "duplicate", bytesWritten: 0 });
    expect(client.added).toHaveLength(1);
  });

  it("logs and propagates remote admission failure", async () => {
    const client = new FakeClient();
    client.failAdd = true;
    const { store, warnings } = makeStore(client);

    await expect(store.persistCompletedTurn({
      runId: "run-failure",
      conversationId: "conversation",
      summary: "Deterministic summary.",
    })).rejects.toThrow("boom-add");

    expect(client.added).toHaveLength(1);
    expect(warnings).toEqual(["supermemory persistCompletedTurn failed; the provider response remains valid."]);
    expect(warnings.join(" ")).not.toContain("boom-add");
  });

  it("rejects an oversized turn instead of truncating its full capture", async () => {
    const client = new FakeClient();
    const { store, warnings } = makeStore(client);

    await expect(store.persistCompletedTurn({
      runId: "run-too-large",
      conversationId: "conversation",
      summary: "Deterministic summary.",
      captureText: "x".repeat(1_000_001),
    })).rejects.toThrow(/admission limit/u);

    expect(client.added).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("SupermemoryMemoryStore.scheduleCapture", () => {
  it("posts the full turn as a capture and drains via flush", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    store.scheduleCapture("conv-1", "the whole turn text");
    await store.flush();

    expect(client.added).toHaveLength(1);
    expect(client.added[0]?.content).toBe("the whole turn text");
    expect(client.added[0]?.metadata).toMatchObject({ kind: "turn-capture", conversationId: "conv-1" });
  });

  it("serializes captures and survives failures without breaking the chain", async () => {
    const client = new FakeClient();
    client.failAdd = true;
    const { store, warnings } = makeStore(client);

    store.scheduleCapture("c", "one");
    store.scheduleCapture("c", "two");
    await store.flush();

    expect(client.added).toHaveLength(2);
    expect(warnings.filter((w) => w.includes("capture failed"))).toHaveLength(2);

    // Chain still works after failures.
    client.failAdd = false;
    store.scheduleCapture("c", "three");
    await store.flush();
    expect(client.added).toHaveLength(3);
  });
});

describe("SupermemoryMemoryStore.recall", () => {
  it("maps hits into recall-tool-shaped records", async () => {
    const client = new FakeClient();
    client.hits = [{ id: "a", text: "fact", score: 0.8 }];
    const { store } = makeStore(client);

    const hits = await store.recall("q", { topK: 3 });

    expect(hits).toEqual([{ score: 0.8, record: { id: "a", text: "fact" } }]);
    expect(client.searches[0]?.limit).toBe(3);
  });
});
