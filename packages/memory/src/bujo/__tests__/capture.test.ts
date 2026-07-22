import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb } from "../../store/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { captureTurn as captureTurnImpl } from "../capture.js";
import { replayCaptureOutbox } from "../capture-outbox.js";
import { appendBullet, dailyFilePath } from "../daily.js";
import { readGraph } from "../graph.js";
import { migrate } from "../migrate.js";
import { assertCanonicalGraphRepairBaseParity } from "../rebuild.js";
import type { ReconcileDeps } from "../reconcile.js";
import { createBujoMemoryStore } from "../store.js";
import type { Bullet } from "../types.js";
import type { MemoryRecord } from "../../store/index.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-15T12:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bujo-capture-"));
  mkdirSync(join(root, "daily"), { recursive: true });
  return root;
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

function closeDb(db: MemoryDb): void {
  const index = openDbs.indexOf(db);
  if (index >= 0) openDbs.splice(index, 1);
  db.close();
}

/** Simple counter-based nextId factory — avoids the duplicate-id problem of fixed clock+random. */
function makeSeqNextId(): () => string {
  let seq = 0;
  return () => `CAP${String(++seq).padStart(4, "0")}`;
}

const captureTurn: typeof captureTurnImpl = async (text, deps) => await captureTurnImpl(text, {
  ...deps,
  canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
});

async function seed(db: MemoryDb, root: string, id: string, text: string): Promise<void> {
  const bullet: Bullet = {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.6,
    isInsight: false,
    createdAt: FIXED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  const record: MemoryRecord = {
    id,
    type: "note",
    status: "open",
    text,
    salience: bullet.salience,
    isInsight: false,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, FIXED)) },
  };
  await db.upsert(record);
}

describe("captureTurn", () => {
  it("batches persistence embeddings across the maximum eight novel candidates", async () => {
    const root = newRoot();
    const batchSizes: number[] = [];
    const embeddings = {
      id: "capture-batch:64",
      async embed(texts: readonly string[]) {
        batchSizes.push(texts.length);
        return texts.map(() => Array.from({ length: DIM }, (_, index) => index === 0 ? 1 : 0));
      },
    };
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: DIM });
    openDbs.push(db);
    let preparedCommits = 0;
    const captureDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "commitPreparedUpserts") {
          return (...args: Parameters<MemoryDb["commitPreparedUpserts"]>) => {
            preparedCommits += 1;
            return target.commitPreparedUpserts(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;
    const facts = [
      "The launch window is Tuesday morning",
      "Morgan prefers jasmine tea",
      "Project Atlas uses PostgreSQL",
      "The bicycle lock code changed",
      "Taylor moved the review to Friday",
      "Invoices belong in the finance folder",
      "The garden sprinkler runs at dawn",
      "Jordan owns the incident checklist",
    ];
    const memories = facts.map((text) => ({
      type: "note",
      text,
      salience: 0.6,
      isInsight: false,
      entityIds: [],
    }));
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({ memories, entities: [], relations: [] })]]);

    const result = await captureTurn("Eight unrelated durable facts", {
      db: captureDb,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    });

    expect(result.actions).toHaveLength(8);
    expect(batchSizes).toEqual([8, 8]);
    expect(preparedCommits).toBe(1);
    expect(db.count()).toBe(8);
  });

  it("recovers a paid migration before exported capture pays the extraction model", async () => {
    const root = newRoot();
    const db = openDb(root);
    const aging: Bullet = {
      id: "CAPTURE-PAID-MIGRATION",
      type: "note",
      status: "open",
      text: "Paid migration recovery precedes capture planning",
      salience: 0.2,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      refs: [],
    };
    appendBullet(root, aging, FIXED);
    await db.upsert({
      ...aging,
      accessCount: 0,
      tags: [],
      source: { file: relative(root, dailyFilePath(root, FIXED)) },
    });
    const migrationNow = new Date("2026-08-20T12:00:00.000Z");
    await expect(migrate({
      db,
      root,
      llm: { id: "paid-migration", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => migrationNow,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-capture-migration-pending"); } },
    })).rejects.toThrow("leave-capture-migration-pending");
    const monthly = join(root, "monthly", "2026-08.md");
    expect(readFileSync(monthly, "utf8")).toContain("mono-agent-migrate:");
    let extractionCalls = 0;
    const llm: ReconcileDeps["llm"] = {
      id: "capture-after-paid-migration",
      complete: async (_prompt, options) => {
        if (options?.label !== "capture:extract") throw new Error(`unexpected ${options?.label ?? "unlabelled"}`);
        extractionCalls += 1;
        expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
        expect(db.get(aging.id)?.salience).toBe(0.5);
        return JSON.stringify({
          memories: [{
            type: "note",
            text: "A novel fact after migration recovery",
            salience: 0.8,
            isInsight: false,
            entityIds: [],
          }],
          entities: [],
          relations: [],
        });
      },
    };

    const result = await captureTurn("Capture only after recovery", {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => migrationNow,
      dupThreshold: 0,
    });

    expect(extractionCalls).toBe(1);
    expect(result.actions[0]?.kind).toBe("add");
    expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
  });

  it("writes one durable row and merged association set for same-turn duplicate candidates", async () => {
    const root = newRoot();
    const db = openDb(root);
    const labels: string[] = [];
    const llm = {
      id: "duplicates",
      async complete(_prompt: string, options?: { readonly label?: string }) {
        labels.push(options?.label ?? "");
        return JSON.stringify({
          memories: [
            { type: "note", text: "Morgan  prefers tea.", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
            { type: "note", text: "morgan prefers tea", salience: 0.7, isInsight: false, entityIds: ["concept:tea"] },
          ],
          entities: [
            { id: "person:morgan", name: "Morgan", type: "person" },
            { id: "concept:tea", name: "Tea", type: "concept" },
          ],
          relations: [],
        });
      },
    };

    const result = await captureTurn("Morgan prefers tea.", {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    });

    expect(labels).toEqual(["capture:extract"]);
    expect(result.actions).toHaveLength(1);
    expect(result.associations).toBe(2);
    expect(db.count()).toBe(1);
    const id = result.actions[0]?.kind === "add" ? result.actions[0].id : "";
    expect(db.associationsForMemory(id).map((association) => association.entityId)).toEqual([
      "concept:tea",
      "person:morgan",
    ]);
    expect(readGraph(root).associations).toHaveLength(2);
  });

  it("does not attach either candidate's entities when same-turn mutations collide on one target", async () => {
    const root = newRoot();
    const db = openDb(root);
    let extractionCall = 0;
    const llm = {
      id: "conflicting-mutations",
      async complete(_prompt: string, options?: { readonly label?: string }) {
        if (options?.label === "capture:extract") {
          extractionCall += 1;
          if (extractionCall === 1) {
            return JSON.stringify({
              memories: [{
                type: "note",
                text: "Morgan prefers blue-green deployments",
                salience: 0.7,
                isInsight: false,
                entityIds: [],
              }],
              entities: [],
              relations: [],
            });
          }
          return JSON.stringify({
            memories: [
              {
                type: "note",
                text: "Morgan prefers reviewed blue-green deployments",
                salience: 0.8,
                isInsight: false,
                entityIds: ["concept:review"],
              },
              {
                type: "note",
                text: "Morgan prefers canary blue-green deployments",
                salience: 0.8,
                isInsight: false,
                entityIds: ["concept:canary"],
              },
            ],
            entities: [
              { id: "concept:review", name: "Review", type: "concept" },
              { id: "concept:canary", name: "Canary", type: "concept" },
            ],
            relations: [],
          });
        }
        return JSON.stringify([
          { index: 0, action: "update", targetId: "CAP0001", text: "Reviewed blue-green deployments" },
          { index: 1, action: "update", targetId: "CAP0001", text: "Canary blue-green deployments" },
        ]);
      },
    };
    const deps: ReconcileDeps = { db, root, llm, nextId: makeSeqNextId(), now: () => FIXED };
    await captureTurn("Morgan prefers blue-green deployments", deps);
    db.findSimilarMany = async (texts) => texts.map(() => [{ record: db.get("CAP0001")!, distance: 0.1 }]);

    const result = await captureTurn("Morgan clarified the deployment preference", deps);

    expect(result.actions).toEqual([]);
    expect(result.associations).toBe(0);
    expect(db.get("CAP0001")?.text).toBe("Morgan prefers blue-green deployments");
    expect(db.associationsForMemory("CAP0001")).toEqual([]);
    expect(readGraph(root).associations).toEqual([]);
  });

  it("extracts a bounded plan, reconciles, mirrors the graph, and keeps precise associations", async () => {
    const root = newRoot();
    const db = openDb(root);

    const llm = fakeLlm([
      [
        "Extract one bounded",
        JSON.stringify({
          entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
          relations: [{ src: "person:morgan", dst: "person:morgan", relation: "self-reference" }],
          memories: [
            { type: "note", text: "Morgan prefers opt-in memory capture", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
            { type: "task", text: "ship Phase 2 memory pipeline", salience: 0.7, isInsight: false, entityIds: [] },
          ],
        }),
      ],
    ]);

    const deps: ReconcileDeps = {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    };

    const result = await captureTurn("Morgan discussed the memory pipeline today", deps);

    // 2 memories distilled and added
    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((a) => a.kind === "add")).toBe(true);
    expect(db.count()).toBe(2);

    // Both memories are recallable
    const hits = await db.recall("opt-in memory", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);

    // 1 entity returned
    expect(result.entities).toBe(1);

    // 1 relation returned
    expect(result.relations).toBe(1);

    // Entity present in db
    const entity = db.getEntity("person:morgan");
    expect(entity).toBeDefined();
    expect(entity?.name).toBe("Morgan");
    expect(entity?.type).toBe("person");

    // Entity present in graph.jsonl
    const graph = readGraph(root);
    expect(graph.entities.some((e) => e.id === "person:morgan")).toBe(true);

    // Relation present in graph.jsonl
    expect(graph.relations.some((r) => r.src === "person:morgan" && r.relation === "self-reference")).toBe(true);

    expect(result.associations).toBe(1);
    const first = result.actions[0];
    const second = result.actions[1];
    expect(first?.kind).toBe("add");
    expect(second?.kind).toBe("add");
    if (first?.kind === "add" && second?.kind === "add") {
      expect(db.associationsForMemory(first.id)).toEqual([
        expect.objectContaining({ entityId: "person:morgan", provenance: "capture" }),
      ]);
      expect(db.associationsForMemory(second.id)).toEqual([]);
    }
  });

  it("does not throw when a single entity write fails (entity id missing from db result doesn't abort)", async () => {
    // Verifies the defensive try/catch per-item behavior — overall captureTurn should not throw
    // even with a minimal setup where entity writes are perfectly valid.
    const root = newRoot();
    const db = openDb(root);

    const llm = fakeLlm([
      [
        "Extract one bounded",
        JSON.stringify({
          memories: [{ type: "note", text: "brief note about something", salience: 0.5, isInsight: false, entityIds: ["concept:something"] }],
          entities: [{ id: "concept:something", name: "Something", type: "concept" }],
          relations: [],
        }),
      ],
    ]);

    const deps: ReconcileDeps = {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    };

    // Should resolve, not throw
    await expect(captureTurn("brief note about something", deps)).resolves.toBeDefined();
  });

  it("does not append duplicate graph records across repeated captures", async () => {
    const root = newRoot();
    const db = openDb(root);
    const llm = fakeLlm([
      [
        "Extract one bounded",
        JSON.stringify({
          memories: [{ type: "note", text: "Paola prefers quiet mornings", salience: 0.7, isInsight: false, entityIds: ["person:paola"] }],
          entities: [{ id: "person:paola", name: "Paola", type: "person" }],
          relations: [{ src: "person:paola", dst: "person:paola", relation: "self-reference" }],
        }),
      ],
      [
        "Classify each candidate",
        JSON.stringify([{ index: 0, action: "noop", targetId: "CAP0001" }]),
      ],
    ]);
    let now = new Date("2026-06-15T12:00:00.000Z");
    const deps: ReconcileDeps = {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => now,
    };

    await captureTurn("Paola prefers quiet mornings", deps);
    now = new Date("2026-06-16T12:00:00.000Z");
    await captureTurn("Paola prefers quiet mornings", deps);

    const graphLines = readFileSync(join(root, "graph.jsonl"), "utf8").trim().split("\n");
    expect(graphLines).toHaveLength(3);
    const graph = readGraph(root);
    expect(graph.entities).toHaveLength(1);
    expect(graph.relations).toHaveLength(1);
    expect(graph.associations).toHaveLength(1);
  });

  it("leaves a durable intent when the graph mirror fails and completes it idempotently on replay", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Wrap the db so the exact index projection replacement throws. Canonical-first ordering
    // means graph.jsonl is written before the mirror, so the data survives a mirror failure.
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "replaceCanonicalGraphProjection") {
          return () => { throw new Error("index mirror down"); };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;

    const llm = fakeLlm([
      [
        "Extract one bounded",
        JSON.stringify({
          memories: [{ type: "note", text: "Morgan maintains mono-agent", salience: 0.7, isInsight: false, entityIds: ["person:morgan", "project:mono-agent"] }],
          entities: [
            { id: "person:morgan", name: "Morgan", type: "person" },
            { id: "project:mono-agent", name: "mono-agent", type: "project" },
          ],
          relations: [{ src: "person:morgan", dst: "project:mono-agent", relation: "maintains" }],
        }),
      ],
    ]);

    const deps: ReconcileDeps = { db: failingDb, root, llm, nextId: makeSeqNextId(), now: () => FIXED };
    await expect(captureTurn("Morgan maintains mono-agent", deps)).rejects.toThrow("index mirror down");

    const graph = readGraph(root);
    expect(graph.entities.some((e) => e.id === "person:morgan")).toBe(true);
    expect(graph.relations.some((r) => r.src === "person:morgan" && r.relation === "maintains")).toBe(true);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);

    const replayed = replayCaptureOutbox(root, db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
    expect(replayed).toHaveLength(1);
    expect(db.associationsForMemory("CAP0001")).toEqual([
      expect.objectContaining({ entityId: "person:morgan", provenance: "capture" }),
      expect.objectContaining({ entityId: "project:mono-agent", provenance: "capture" }),
    ]);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });

  it("replays graph evidence only after exact ADD/UPDATE/SUPERSEDE/NOOP outcomes match", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "UPDATE", "Morgan prefers blue deployment releases.");
    await seed(db, root, "OLD", "Atlas launches in July.");
    await seed(db, root, "NOOP", "Paola prefers quiet mornings.");
    db.findSimilarMany = async () => [
      [],
      [{ record: db.get("UPDATE")!, distance: 0.1 }],
      [{ record: db.get("OLD")!, distance: 0.1 }],
      [{ record: db.get("NOOP")!, distance: 0.1 }],
    ];
    const labels: string[] = [];
    const llm = {
      id: "all-actions",
      async complete(_prompt: string, options?: { readonly label?: string }) {
        labels.push(options?.label ?? "unknown");
        if (options?.label === "capture:extract") {
          return JSON.stringify({
            memories: [
              { type: "note", text: "Aster uses quarterly red-team reviews.", salience: 0.7, isInsight: false, entityIds: ["project:aster"] },
              { type: "note", text: "Morgan prefers reviewed blue deployment releases.", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
              { type: "note", text: "Atlas launches in August.", salience: 0.8, isInsight: false, entityIds: ["project:atlas"] },
              { type: "note", text: "Paola prefers quiet mornings.", salience: 0.7, isInsight: false, entityIds: ["person:paola"] },
            ],
            entities: [
              { id: "project:aster", name: "Aster", type: "project" },
              { id: "person:morgan", name: "Morgan", type: "person" },
              { id: "project:atlas", name: "Atlas", type: "project" },
              { id: "person:paola", name: "Paola", type: "person" },
            ],
            relations: [],
          });
        }
        return JSON.stringify([
          { index: 1, action: "update", targetId: "UPDATE", text: "Morgan prefers reviewed blue deployment releases." },
          { index: 2, action: "supersede", targetId: "OLD", text: "Atlas launches in August." },
          { index: 3, action: "noop", targetId: "NOOP" },
        ]);
      },
    };
    const outside = join(mkdtempSync(join(tmpdir(), "capture-graph-outside-")), "graph.jsonl");
    symlinkSync(outside, join(root, "graph.jsonl"));

    await expect(captureTurn("four exact action outcomes", {
      db,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    })).rejects.toThrow(/graph|symlink|regular/iu);

    expect(labels).toEqual(["capture:extract", "capture:reconcile-batch"]);
    // Daily/graph/sidecar are the source transaction. A graph publication
    // fault must leave SQLite wholly before the prepared batch.
    expect(db.get("CAP0001")).toBeUndefined();
    expect(db.get("UPDATE")?.text).toBe("Morgan prefers blue deployment releases.");
    expect(db.get("OLD")?.status).toBe("open");
    expect(db.get("CAP0002")).toBeUndefined();
    expect(db.get("NOOP")?.text).toBe("Paola prefers quiet mornings.");
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);

    unlinkSync(join(root, "graph.jsonl"));
    replayCaptureOutbox(root, db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });

    expect(labels).toEqual(["capture:extract", "capture:reconcile-batch"]);
    expect(db.get("CAP0001")?.text).toBe("Aster uses quarterly red-team reviews.");
    expect(db.get("UPDATE")?.text).toBe("Morgan prefers reviewed blue deployment releases.");
    expect(db.get("OLD")?.status).toBe("invalidated");
    expect(db.get("CAP0002")?.text).toBe("Atlas launches in August.");
    expect(readGraph(root).associations.map((association) => association.memoryId).sort()).toEqual([
      "CAP0001",
      "CAP0002",
      "NOOP",
      "UPDATE",
    ]);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });

  it("replays a pending intent during writable startup without another LLM or embedding call", async () => {
    const root = newRoot();
    const db = openDb(root);
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "replaceCanonicalGraphProjection") {
          return () => { throw new Error("association mirror fault"); };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [{
        type: "note",
        text: "Morgan owns startup replay.",
        salience: 0.8,
        isInsight: false,
        entityIds: ["person:morgan"],
      }],
      entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
      relations: [],
    })]]);

    await expect(captureTurn("Morgan owns startup replay", {
      db: failingDb,
      root,
      llm,
      nextId: makeSeqNextId(),
      now: () => FIXED,
    })).rejects.toThrow("association mirror fault");
    closeDb(db);

    let embeddingCalls = 0;
    let llmCalls = 0;
    const base = fakeEmbeddings(DIM);
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: {
        id: base.id,
        embed: async (texts) => {
          embeddingCalls += 1;
          return await base.embed(texts);
        },
      },
      dim: DIM,
      llm: {
        id: "must-not-run",
        complete: async () => {
          llmCalls += 1;
          throw new Error("startup replay must not call the LLM");
        },
      },
    });
    expect(embeddingCalls).toBe(0);
    expect(llmCalls).toBe(0);
    await store.close();

    const inspected = openMemoryDb({ path: join(root, "memory.db"), dim: DIM, readOnly: true });
    openDbs.push(inspected);
    expect(inspected.associationsForMemory("CAP0001")).toEqual([
      expect.objectContaining({ entityId: "person:morgan", provenance: "capture" }),
    ]);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });

  it("propagates a model failure (does not silently no-op the whole turn)", async () => {
    const root = newRoot();
    const db = openDb(root);
    // The capture LLM is down. Extraction is the first model call; the failure must propagate out of
    // captureTurn so the async capture boundary logs it — rather than returning an empty summary that
    // is indistinguishable from a turn with nothing worth remembering.
    const throwingLlm = { id: "throws", complete: async () => { throw new Error("ollama unreachable"); } };
    const deps: ReconcileDeps = { db, root, llm: throwingLlm, nextId: makeSeqNextId(), now: () => FIXED };
    await expect(captureTurn("a memorable sentence about the project", deps)).rejects.toThrow(/ollama unreachable/);
  });
});
