import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import type { EmbeddingProvider } from "../../search/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { auditBujoMemoryHealth } from "../audit.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { parseDailyFile } from "../grammar.js";
import { createIdFactory } from "../ids.js";
import { migrate } from "../migrate.js";
import { assertCanonicalGraphRepairBaseParity, safeRebuildMemoryIndex } from "../rebuild.js";
import { reconcile, reconcileBatch, type ReconcileDeps } from "../reconcile.js";
import { createBujoMemoryStore } from "../store.js";
import type { Bullet, CandidateMemory } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-15T12:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-reconcile-"));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

function openPersistenceGatedDb(root: string): {
  readonly db: MemoryDb;
  readonly entered: Promise<void>;
  readonly release: () => void;
} {
  const base = fakeEmbeddings(DIM);
  let calls = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const embeddings: EmbeddingProvider = {
    id: "legacy-reconcile-close-race:64",
    embed: async (texts) => {
      calls += 1;
      if (calls === 2) {
        enter();
        await gate; // deliberately ignore abortSignal
      }
      return await base.embed(texts);
    },
  };
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: DIM });
  openDbs.push(db);
  return { db, entered, release };
}

function closeTrackedDb(db: MemoryDb): void {
  const index = openDbs.indexOf(db);
  if (index >= 0) openDbs.splice(index, 1);
  db.close();
}

/** Seed an existing memory: append a bullet to the daily file AND upsert the index record. */
async function seed(
  db: MemoryDb,
  root: string,
  id: string,
  text: string,
  opts: { type?: Bullet["type"]; salience?: number; isInsight?: boolean } = {},
): Promise<void> {
  const type = opts.type ?? "note";
  const bullet: Bullet = {
    id,
    type,
    status: "open",
    text,
    salience: opts.salience ?? 0.5,
    isInsight: opts.isInsight ?? false,
    createdAt: FIXED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  const record: MemoryRecord = {
    id,
    type,
    status: "open",
    text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, FIXED)) },
  };
  await db.upsert(record);
}

function makeDeps(
  db: MemoryDb,
  root: string,
  llm: ReconcileDeps["llm"],
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  return {
    db,
    root,
    llm,
    nextId: createIdFactory({ clock: () => FIXED, random: () => 0 }),
    now: () => FIXED,
    canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    ...overrides,
  };
}

function dailyContent(root: string): string {
  return readFileSync(dailyFilePath(root, FIXED), "utf8");
}

describe("reconcile", () => {
  it("case 1 — novel candidate (no similar) → ADD", async () => {
    const root = newRoot();
    const db = openDb(root);
    // Seed one unrelated memory so the db is non-empty but dissimilar to the candidate.
    await seed(db, root, "SEED1", "the cat slept on the warm windowsill");

    // An LLM that would say "noop" if ever consulted — proves the ADD path skips the LLM.
    const llm = fakeLlm([["CLASSIFY", '{"action":"noop","targetId":"SEED1"}']]);
    const candidate: CandidateMemory = {
      type: "task",
      // Shares no tokens with the seed → nearest distance comfortably above dupThreshold → ADD, no LLM.
      text: "deploy quarterly revenue forecast spreadsheet",
      salience: 0.8,
      isInsight: false,
    };
    const before = db.count();
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("add");
    const newId = actions[0]?.kind === "add" ? actions[0].id : "";
    expect(newId).not.toBe("");
    expect(db.count()).toBe(before + 1);

    const added = db.get(newId);
    expect(added?.status).toBe("open");
    expect(added?.text).toBe(candidate.text);
    expect(added?.type).toBe("task");

    // Recallable.
    const hits = await db.recall("quarterly revenue forecast", { topK: 5 });
    expect(hits.some((h) => h.record.id === newId)).toBe(true);

    // Daily file contains the new bullet line.
    const parsed = parseDailyFile(dailyContent(root));
    expect(parsed.bullets.some((b) => b.id === newId && b.text === candidate.text)).toBe(true);
  });

  it("omits a zero-weight thread at the public threshold boundary", async () => {
    const root = newRoot();
    const provider = fakeEmbeddings(DIM);
    appendBullet(root, {
      id: "ORTHOGONAL",
      type: "note",
      status: "open",
      text: "An orthogonal indexed memory",
      salience: 0.5,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      refs: [],
    }, FIXED);
    const rebuilt = await safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: DIM,
    });
    const db = openMemoryDb({ path: rebuilt.active, embeddings: provider, dim: DIM });
    openDbs.push(db);
    db.findSimilar = async () => [{ record: db.get("ORTHOGONAL")!, distance: 1 }];
    const candidate: CandidateMemory = {
      type: "note",
      text: "A novel boundary memory",
      salience: 0.7,
      isInsight: false,
    };

    const actions = await reconcile(
      [candidate],
      makeDeps(db, root, fakeLlm([]), { threadThreshold: 1 }),
    );

    expect(actions).toEqual([{ kind: "add", id: expect.any(String) }]);
    const id = actions[0]?.kind === "add" ? actions[0].id : "";
    expect(db.edges(id).filter((edge) => edge.kind === "thread")).toEqual([]);
    expect(auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: DIM,
      now: FIXED,
    }).issues).not.toContain("canonical_mismatch");
  });

  it("case 2 — duplicate candidate + LLM says noop → no write", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "DUP1", "ship the phase two reconcile engine across markdown and index");

    const llm = fakeLlm([["CLASSIFY", '{"action":"noop","targetId":"DUP1"}']]);
    const candidate: CandidateMemory = {
      type: "task",
      // Shares most tokens with DUP1 → close under fakeEmbeddings → triggers LLM path.
      text: "ship the phase two reconcile engine across markdown and index now",
      salience: 0.6,
      isInsight: false,
    };
    const before = db.count();
    // Distance ~0.04 (shares nearly all tokens with DUP1) → well under the default dupThreshold → LLM path.
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toEqual([{ kind: "noop", id: "DUP1" }]);
    expect(db.count()).toBe(before); // no new memory
    // The seeded memory is untouched.
    expect(db.get("DUP1")?.status).toBe("open");
    // No second bullet was appended for this text.
    const parsed = parseDailyFile(dailyContent(root));
    expect(parsed.bullets).toHaveLength(1);
  });

  it("case 3 — contradicting candidate + LLM says supersede → old invalidated, new added", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "OLD1", "the launch date is scheduled for july fifteenth this year");

    const newText = "the launch date moved to august first this year";
    const llm = fakeLlm([["CLASSIFY", `{"action":"supersede","targetId":"OLD1","text":"${newText}"}`]]);
    const candidate: CandidateMemory = {
      type: "note",
      text: "the launch date is now august first this year not july",
      salience: 0.7,
      isInsight: false,
    };
    // Distance ~0.25 to OLD1 → under the default dupThreshold → LLM path.
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.kind).toBe("supersede");
    const newId = action?.kind === "supersede" ? action.newId : "";
    expect(action?.kind === "supersede" ? action.oldId : "").toBe("OLD1");

    // Old invalidated in the index.
    expect(db.get("OLD1")?.status).toBe("invalidated");
    expect(db.get("OLD1")?.supersededBy).toBe(newId);

    // New memory added & open.
    const added = db.get(newId);
    expect(added?.status).toBe("open");
    expect(added?.text).toBe(newText);

    // A supersedes edge exists (OLD1 -> newId).
    const edges = db.edges("OLD1");
    expect(edges.some((e) => e.kind === "supersedes" && e.dst === newId)).toBe(true);

    // Old's daily line re-parses as invalidated status.
    const parsed = parseDailyFile(dailyContent(root));
    const oldBullet = parsed.bullets.find((b) => b.id === "OLD1");
    expect(oldBullet?.status).toBe("invalidated");
    // New bullet present too.
    expect(parsed.bullets.some((b) => b.id === newId && b.text === newText)).toBe(true);
  });

  it("case 4 — refinement candidate + LLM says update → target text merged, count unchanged", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "UPD1", "morgan prefers opt in memory capture");

    const merged = "morgan prefers opt in memory capture with manual review";
    const llm = fakeLlm([["CLASSIFY", `{"action":"update","targetId":"UPD1","text":"${merged}"}`]]);
    const candidate: CandidateMemory = {
      type: "note",
      text: "morgan prefers opt in memory capture and manual review",
      salience: 0.6,
      isInsight: false,
    };
    const before = db.count();
    // Distance ~0.18 to UPD1 → under the default dupThreshold → LLM path.
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toEqual([{ kind: "update", id: "UPD1" }]);
    expect(db.count()).toBe(before); // no new memory
    expect(db.get("UPD1")?.text).toBe(merged);
    expect(db.get("UPD1")?.status).toBe("open"); // still open
    // Re-embedded: recall on the merged-only tokens finds it.
    const hits = await db.recall("manual review", { topK: 5 });
    expect(hits.some((h) => h.record.id === "UPD1")).toBe(true);

    // Target's daily line re-parses with merged text.
    const parsed = parseDailyFile(dailyContent(root));
    expect(parsed.bullets.find((b) => b.id === "UPD1")?.text).toBe(merged);
  });

  it("keeps the public legacy reconcile path at 280 well-formed Unicode code points", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "LEGACY", "Existing legacy reconciliation memory");
    db.findSimilar = async () => [{ record: db.get("LEGACY")!, distance: 0.1 }];
    const candidate: CandidateMemory = {
      type: "note",
      text: "Candidate requiring the legacy reconciliation classifier",
      salience: 0.8,
      isInsight: false,
    };
    const expected = `${"a".repeat(279)}🧠`;
    const escapedBoundary = `${"a".repeat(139)}\ud83d${"a".repeat(140)}🧠`;
    const reply = JSON.stringify({
      action: "update",
      targetId: "LEGACY",
      text: escapedBoundary,
    });
    expect(reply).toContain("\\ud83d");

    const actions = await reconcile(
      [candidate],
      makeDeps(db, root, fakeLlm([["CLASSIFY", reply]])),
    );

    expect(actions).toEqual([{ kind: "update", id: "LEGACY" }]);
    expect(db.get("LEGACY")?.text).toBe(expected);
    expect(Array.from(db.get("LEGACY")?.text ?? "")).toHaveLength(280);
    expect(db.get("LEGACY")?.text).toMatch(/🧠$/u);
    expect(db.get("LEGACY")?.text).not.toContain("�");
    expect(db.get("LEGACY")?.text).not.toMatch(/\p{Cs}/u);
    expect(parseDailyFile(dailyContent(root)).bullets.find((bullet) => bullet.id === "LEGACY")?.text)
      .toBe(expected);
  });

  it("case 5 — durable replay stops on pre-existing canonical/index divergence", async () => {
    const root = newRoot();
    const db = openDb(root);
    // Index record whose canonical daily file is MISSING (simulated index/markdown divergence).
    await db.upsert({
      id: "GHOST", type: "note", status: "open", text: "morgan prefers opt in memory capture",
      salience: 0.5, isInsight: false, createdAt: FIXED.toISOString(), accessCount: 0, tags: [],
      source: { file: "daily/2099-01-01.md" },
    });
    // First candidate is similar to GHOST; LLM says "update" → rewriteBullet reads the missing file → throws.
    // Second candidate is novel → must still be ADDed despite the first failing.
    const llm = fakeLlm([["CLASSIFY", '{"action":"update","targetId":"GHOST","text":"merged text here"}']]);
    const failing: CandidateMemory = { type: "note", text: "morgan prefers opt in memory capture and review", salience: 0.6, isInsight: false };
    const novel: CandidateMemory = { type: "task", text: "schedule the offsite logistics budget", salience: 0.7, isInsight: false };

    await expect(reconcile([failing, novel], makeDeps(db, root, llm)))
      .rejects.toThrow(/candidate memory payload validation failed/iu);

    // The source/index divergence is not silently blessed merely because the
    // other candidate was individually valid. Its durable intent remains for
    // recovery after the operator repairs the pre-existing GHOST row.
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);
    // GHOST was not partially mutated by the failed update (rewriteBullet threw before the index write).
    expect(db.get("GHOST")?.status).toBe("open");
  });

  it("case 6 — surfaces an embedding-model failure (findSimilar throws) instead of isolating it", async () => {
    const root = newRoot();
    const db = openDb(root);
    // Simulate the embedding model being down: findSimilar embeds the query, so it throws for EVERY
    // candidate. That is a systemic model outage, not a per-item data problem — it must surface, not
    // be swallowed by per-candidate isolation (which would make a dead embedder look like a no-op).
    db.findSimilar = async () => { throw new Error("ollama embeddings 500"); };
    const candidate: CandidateMemory = { type: "note", text: "anything worth remembering", salience: 0.5, isInsight: false };
    await expect(reconcile([candidate], makeDeps(db, root, fakeLlm([])))).rejects.toThrow(/embedding/i);
  });

  it("case 7 — surfaces an LLM failure from classify instead of silently falling back to ADD", async () => {
    const root = newRoot();
    const db = openDb(root);
    // A near-duplicate forces the LLM classify path; a thrown error there must surface, not degrade
    // to a silent ADD that hides a dead model.
    await seed(db, root, "DUP1", "ship the phase two reconcile engine across markdown and index");
    const throwingLlm = { id: "throws", complete: async () => { throw new Error("ollama 500"); } };
    const candidate: CandidateMemory = {
      type: "task",
      text: "ship the phase two reconcile engine across markdown and index now",
      salience: 0.6,
      isInsight: false,
    };
    await expect(reconcile([candidate], makeDeps(db, root, throwingLlm))).rejects.toThrow(/classif/i);
  });

  it.each(["add", "update", "supersede"] as const)(
    "preflights a legacy %s persistence vector before canonical mutation",
    async (action) => {
      const root = newRoot();
      const db = openDb(root);
      if (action !== "add") await seed(db, root, "TARGET", "Morgan prefers blue deployments");
      const before = action === "add" ? undefined : dailyContent(root);
      db.findSimilar = async () => action === "add"
        ? []
        : [{ record: db.get("TARGET")!, distance: 0.1 }];
      db.prepareUpsertVectors = async () => { throw new Error("persistence embedding offline"); };
      const decision = action === "add"
        ? fakeLlm([])
        : fakeLlm([["CLASSIFY", JSON.stringify({
          action,
          targetId: "TARGET",
          text: action === "update"
            ? "Morgan prefers reviewed blue deployments"
            : "Morgan now prefers green deployments",
        })]]);
      const candidate: CandidateMemory = {
        type: "note",
        text: action === "add" ? "A wholly novel durable fact" : "Morgan now prefers green deployments",
        salience: 0.7,
        isInsight: false,
      };

      await expect(reconcile([candidate], makeDeps(db, root, decision))).rejects.toThrow(
        /persist|persistence embedding offline/iu,
      );

      if (before === undefined) expect(existsSync(dailyFilePath(root, FIXED))).toBe(false);
      else expect(dailyContent(root)).toBe(before);
      expect(db.count()).toBe(action === "add" ? 0 : 1);
      if (action !== "add") {
        expect(db.get("TARGET")?.text).toBe("Morgan prefers blue deployments");
        expect(db.get("TARGET")?.status).toBe("open");
      }
    },
  );

  it("rejects an abort-ignoring legacy persistence reply before canonical or index mutation", async () => {
    const root = newRoot();
    const { db, entered, release } = openPersistenceGatedDb(root);
    const controller = new AbortController();
    const candidate: CandidateMemory = {
      type: "note",
      text: "ABORTED-RECONCILE must never persist",
      salience: 0.8,
      isInsight: false,
    };

    const pending = reconcile(
      [candidate],
      makeDeps(db, root, fakeLlm([]), { abortSignal: controller.signal }),
    );
    await entered;
    controller.abort(new Error("legacy reconcile aborted"));
    const rejected = expect(pending).rejects.toThrow(/legacy reconcile aborted/iu);
    release();
    await rejected;

    expect(db.count()).toBe(0);
    expect(existsSync(dailyFilePath(root, FIXED))).toBe(false);
  });

  it("does not touch canonical source or a database closed after legacy reconcile abort", async () => {
    const root = newRoot();
    const { db, entered, release } = openPersistenceGatedDb(root);
    const controller = new AbortController();
    const candidate: CandidateMemory = {
      type: "note",
      text: "ABORTED-RECONCILE must not survive close",
      salience: 0.8,
      isInsight: false,
    };

    const pending = reconcile(
      [candidate],
      makeDeps(db, root, fakeLlm([]), { abortSignal: controller.signal }),
    );
    await entered;
    controller.abort(new Error("operation drain deadline"));
    closeTrackedDb(db);
    const rejected = expect(pending).rejects.toThrow(/operation drain deadline/iu);
    release();
    await rejected;

    expect(existsSync(dailyFilePath(root, FIXED))).toBe(false);
    const inspected = openMemoryDb({ path: join(root, "memory.db"), dim: DIM, readOnly: true });
    expect(inspected.count()).toBe(0);
    inspected.close();
  });

  it("publishes a durable legacy intent before committing its prepared row", async () => {
    const root = newRoot();
    const db = openDb(root);
    let commits = 0;
    const durableDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "commitPreparedUpserts") {
          return (...args: Parameters<MemoryDb["commitPreparedUpserts"]>) => {
            commits += 1;
            const files = readdirSync(join(root, ".capture-outbox"));
            expect(files).toHaveLength(1);
            const intent = JSON.parse(readFileSync(join(root, ".capture-outbox", files[0]!), "utf8")) as {
              actions: Array<{ kind: string }>;
              state: string;
            };
            expect(intent).toMatchObject({ state: "pending", actions: [{ kind: "add" }] });
            return target.commitPreparedUpserts(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;

    const actions = await reconcile(
      [{ type: "note", text: "A durable legacy reconciliation fact", salience: 0.8, isInsight: false }],
      makeDeps(durableDb, root, fakeLlm([])),
    );

    expect(actions).toEqual([{ kind: "add", id: expect.any(String) }]);
    expect(commits).toBe(1);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });
});

describe("reconcileBatch", () => {
  it("publishes ADD/UPDATE/SUPERSEDE/NOOP together and commits prepared rows once", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "UPDATE", "Morgan prefers blue deployments");
    await seed(db, root, "OLD", "Atlas launches in July");
    await seed(db, root, "NOOP", "Paola prefers quiet mornings");
    const candidates: CandidateMemory[] = [
      { type: "note", text: "Aster uses quarterly red-team reviews", salience: 0.7, isInsight: false },
      { type: "note", text: "Morgan prefers reviewed blue deployments", salience: 0.8, isInsight: false },
      { type: "note", text: "Atlas launches in August", salience: 0.8, isInsight: false },
      { type: "note", text: "Paola prefers quiet mornings", salience: 0.7, isInsight: false },
    ];
    let searchBatches = 0;
    db.findSimilarMany = async () => {
      searchBatches += 1;
      return [
        [],
        [{ record: db.get("UPDATE")!, distance: 0.1 }],
        [{ record: db.get("OLD")!, distance: 0.1 }],
        [{ record: db.get("NOOP")!, distance: 0.1 }],
      ];
    };
    let persistenceBatches = 0;
    let commits = 0;
    let committedRows = 0;
    let durableKinds: string[] = [];
    const durableDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepareUpsertVectors") {
          return async (...args: Parameters<MemoryDb["prepareUpsertVectors"]>) => {
            persistenceBatches += 1;
            return await target.prepareUpsertVectors(...args);
          };
        }
        if (prop === "commitPreparedUpserts") {
          return (...args: Parameters<MemoryDb["commitPreparedUpserts"]>) => {
            commits += 1;
            committedRows += args[0].length;
            const files = readdirSync(join(root, ".capture-outbox"));
            expect(files).toHaveLength(1);
            const intent = JSON.parse(readFileSync(join(root, ".capture-outbox", files[0]!), "utf8")) as {
              actions: Array<{ kind: string }>;
              state: string;
            };
            expect(intent.state).toBe("pending");
            durableKinds = intent.actions.map((action) => action.kind);
            return target.commitPreparedUpserts(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MemoryDb;
    let llmCalls = 0;
    const llm: ReconcileDeps["llm"] = {
      id: "ordinary-batch",
      complete: async () => {
        llmCalls += 1;
        return JSON.stringify([
          { index: 1, action: "update", targetId: "UPDATE", text: candidates[1]!.text },
          { index: 2, action: "supersede", targetId: "OLD", text: candidates[2]!.text },
          { index: 3, action: "noop", targetId: "NOOP" },
        ]);
      },
    };

    let nextId = 0;
    const actions = await reconcileBatch(candidates, makeDeps(durableDb, root, llm, {
      nextId: () => `BATCH${String(++nextId).padStart(4, "0")}`,
    }));

    expect(actions.map((action) => action?.kind)).toEqual(["add", "update", "supersede", "noop"]);
    expect(searchBatches).toBe(1);
    expect(llmCalls).toBe(1);
    expect(persistenceBatches).toBe(1);
    expect(commits).toBe(1);
    expect(committedRows).toBe(3);
    expect(durableKinds).toEqual(["add", "update", "supersede", "noop"]);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });

  it("leaves a supersede intent recoverable when its target disappears after vector preparation", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "OLD", "Atlas launches in July");
    const originalCanonical = dailyContent(root);
    const candidate: CandidateMemory = {
      type: "note",
      text: "Atlas launches in August",
      salience: 0.8,
      isInsight: false,
    };
    db.findSimilarMany = async () => [[{ record: db.get("OLD")!, distance: 0.1 }]];
    const reply = JSON.stringify([{
      index: 0,
      action: "supersede",
      targetId: "OLD",
      text: candidate.text,
    }]);

    await expect(reconcileBatch(
      [candidate],
      makeDeps(db, root, fakeLlm([["Classify each candidate", reply]]), {
        beforeBatchCommit: (actions) => {
          expect(actions).toHaveLength(1);
          expect(actions[0]).toMatchObject({ kind: "supersede", oldId: "OLD", vector: expect.any(Array) });
          unlinkSync(dailyFilePath(root, FIXED));
        },
      }),
    )).rejects.toThrow(/pending intent.*conflicts/iu);

    const pendingFiles = readdirSync(join(root, ".capture-outbox"));
    expect(pendingFiles).toHaveLength(1);
    const pending = JSON.parse(readFileSync(join(root, ".capture-outbox", pendingFiles[0]!), "utf8")) as {
      actions: Array<{ kind: string; oldId: string; newId: string }>;
    };
    expect(pending.actions).toEqual([
      expect.objectContaining({ kind: "supersede", oldId: "OLD", newId: expect.any(String) }),
    ]);
    const newId = pending.actions[0]!.newId;
    expect(db.get("OLD")?.status).toBe("open");
    expect(db.get(newId)).toBeUndefined();
    expect(existsSync(dailyFilePath(root, FIXED))).toBe(false);

    let followupSearches = 0;
    db.findSimilarMany = async () => {
      followupSearches += 1;
      return [[]];
    };
    await expect(reconcileBatch(
      [{ type: "note", text: "A later fact must not stack", salience: 0.6, isInsight: false }],
      makeDeps(db, root, fakeLlm([])),
    )).rejects.toThrow(/pending intent.*conflicts/iu);
    expect(followupSearches).toBe(0);
    expect(readdirSync(join(root, ".capture-outbox"))).toHaveLength(1);

    writeFileSync(dailyFilePath(root, FIXED), originalCanonical, "utf8");
    closeTrackedDb(db);
    const base = fakeEmbeddings(DIM);
    let startupEmbeddingCalls = 0;
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: {
        id: base.id,
        embed: async (texts) => {
          startupEmbeddingCalls += 1;
          return await base.embed(texts);
        },
      },
      dim: DIM,
      llm: { id: "no-call-recovery", complete: async () => { throw new Error("recovery must not call the LLM"); } },
      clock: () => FIXED,
    });
    expect(startupEmbeddingCalls).toBe(0);
    await store.close();

    const inspected = openMemoryDb({ path: join(root, "memory.db"), dim: DIM, readOnly: true });
    openDbs.push(inspected);
    expect(inspected.get("OLD")).toMatchObject({ status: "invalidated", supersededBy: newId });
    expect(inspected.get(newId)).toMatchObject({ status: "open", text: candidate.text });
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
  });

  it("preflights persistence embeddings for add/update/supersede before any canonical mutation", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "UPDATE", "Morgan prefers blue deployments");
    await seed(db, root, "OLD", "Atlas launches in July");
    const before = dailyContent(root);
    const candidates: CandidateMemory[] = [
      { type: "note", text: "A wholly novel durable fact", salience: 0.6, isInsight: false },
      { type: "note", text: "Morgan prefers blue deployments with review", salience: 0.7, isInsight: false },
      { type: "note", text: "Atlas launches in August", salience: 0.8, isInsight: false },
    ];
    db.findSimilarMany = async () => [
      [],
      [{ record: db.get("UPDATE")!, distance: 0.1 }],
      [{ record: db.get("OLD")!, distance: 0.1 }],
    ];
    db.prepareUpsertVectors = async () => { throw new Error("persistence embedding offline"); };
    const reply = JSON.stringify([
      { index: 1, action: "update", targetId: "UPDATE", text: "Morgan prefers reviewed blue deployments" },
      { index: 2, action: "supersede", targetId: "OLD", text: "Atlas launches in August" },
    ]);

    await expect(reconcileBatch(
      candidates,
      makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
    )).rejects.toThrow(/persistBatch|persistence embedding offline/iu);

    expect(dailyContent(root)).toBe(before);
    expect(db.count()).toBe(2);
    expect(db.get("UPDATE")?.text).toBe("Morgan prefers blue deployments");
    expect(db.get("OLD")?.status).toBe("open");
  });

  it("skips a close candidate on malformed output while a novel candidate still adds", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "NEAR", "ship the phase two reconcile engine across markdown and index");
    const close: CandidateMemory = {
      type: "task", text: "ship the phase two reconcile engine across markdown and index now", salience: 0.6, isInsight: false,
    };
    const novel: CandidateMemory = {
      type: "task", text: "schedule offsite catering and travel logistics", salience: 0.7, isInsight: false,
    };

    const actions = await reconcileBatch(
      [close, novel],
      makeDeps(db, root, fakeLlm([["Classify each candidate", "not-json"]])),
    );

    expect(actions[0]).toBeUndefined();
    expect(actions[1]?.kind).toBe("add");
    expect(db.count()).toBe(2);
    expect(db.get("NEAR")?.status).toBe("open");
    expect(parseDailyFile(dailyContent(root)).bullets).toHaveLength(2);
  });

  it("fails closed for duplicate indexes and cross-candidate targets without corrupting other slots", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "A", "alpha deployment uses a cobalt release train");
    await seed(db, root, "B", "beta deployment uses a green release train");
    await seed(db, root, "C", "gamma deployment uses a silver release train");
    const candidates: CandidateMemory[] = [
      { type: "note", text: "alpha deployment uses cobalt releases", salience: 0.5, isInsight: false },
      { type: "note", text: "beta deployment uses green releases", salience: 0.5, isInsight: false },
      { type: "note", text: "gamma deployment uses silver releases", salience: 0.5, isInsight: false },
    ];
    db.findSimilarMany = async () => [
      [{ record: db.get("A")!, distance: 0.1 }],
      [{ record: db.get("B")!, distance: 0.1 }],
      [{ record: db.get("C")!, distance: 0.1 }],
    ];
    const reply = JSON.stringify([
      { index: 0, action: "noop", targetId: "A" },
      { index: 0, action: "noop", targetId: "A" },
      { index: 1, action: "noop", targetId: "A" },
      { index: 2, action: "noop", targetId: "C" },
    ]);

    const actions = await reconcileBatch(
      candidates,
      makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
    );

    expect(actions).toEqual([undefined, undefined, { kind: "noop", id: "C" }]);
    expect(db.count()).toBe(3);
    expect(parseDailyFile(dailyContent(root)).bullets).toHaveLength(3);
  });

  it.each(["update", "supersede"] as const)(
    "fails every colliding %s decision closed before canonical or index mutation",
    async (action) => {
      const root = newRoot();
      const db = openDb(root);
      await seed(db, root, "ONE", "Morgan prefers blue-green deployments");
      const before = dailyContent(root);
      const candidates: CandidateMemory[] = [
        { type: "note", text: "Morgan prefers blue-green deployments with review", salience: 0.7, isInsight: false },
        { type: "note", text: "Morgan prefers blue-green deployments with canaries", salience: 0.8, isInsight: false },
      ];
      db.findSimilarMany = async () => candidates.map(() => [{ record: db.get("ONE")!, distance: 0.1 }]);
      let persistencePreflights = 0;
      db.prepareUpsertVectors = async (records) => {
        persistencePreflights += records.length;
        return records.map(() => undefined);
      };
      const reply = JSON.stringify(candidates.map((candidate, index) => ({
        index,
        action,
        targetId: "ONE",
        text: candidate.text,
      })));

      const actions = await reconcileBatch(
        candidates,
        makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
      );

      expect(actions).toEqual([undefined, undefined]);
      expect(persistencePreflights).toBe(0);
      expect(db.count()).toBe(1);
      expect(db.get("ONE")).toMatchObject({
        text: "Morgan prefers blue-green deployments",
        status: "open",
      });
      expect(dailyContent(root)).toBe(before);
    },
  );

  it.each(["update", "supersede"] as const)(
    "fails a mixed %s/noop collision closed before canonical or index mutation",
    async (action) => {
      const root = newRoot();
      const db = openDb(root);
      await seed(db, root, "ONE", "Morgan prefers blue-green deployments");
      const before = dailyContent(root);
      const candidates: CandidateMemory[] = [
        { type: "note", text: "Morgan prefers reviewed blue-green deployments", salience: 0.7, isInsight: false },
        { type: "note", text: "Morgan prefers canary blue-green deployments", salience: 0.8, isInsight: false },
      ];
      db.findSimilarMany = async () => candidates.map(() => [{ record: db.get("ONE")!, distance: 0.1 }]);
      let persistencePreflights = 0;
      db.prepareUpsertVectors = async (records) => {
        persistencePreflights += records.length;
        return records.map(() => undefined);
      };
      const reply = JSON.stringify([
        { index: 0, action, targetId: "ONE", text: candidates[0]!.text },
        { index: 1, action: "noop", targetId: "ONE" },
      ]);

      const actions = await reconcileBatch(
        candidates,
        makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
      );

      expect(actions).toEqual([undefined, undefined]);
      expect(persistencePreflights).toBe(0);
      expect(db.get("ONE")).toMatchObject({
        text: "Morgan prefers blue-green deployments",
        status: "open",
      });
      expect(dailyContent(root)).toBe(before);
    },
  );

  it.each(["update", "supersede"] as const)(
    "rejects %s when the existing daily file no longer contains the target id",
    async (action) => {
      const root = newRoot();
      const db = openDb(root);
      await seed(db, root, "PRESENT", "A different canonical memory");
      const sourceFile = relative(root, dailyFilePath(root, FIXED));
      await db.upsert({
        id: "MISSING",
        type: "note",
        status: "open",
        text: "Morgan prefers blue-green deployments",
        salience: 0.5,
        isInsight: false,
        createdAt: FIXED.toISOString(),
        accessCount: 0,
        tags: [],
        source: { file: sourceFile },
      });
      const before = dailyContent(root);
      const candidate: CandidateMemory = {
        type: "note",
        text: "Morgan prefers reviewed blue-green deployments",
        salience: 0.8,
        isInsight: false,
      };
      db.findSimilarMany = async () => [[{ record: db.get("MISSING")!, distance: 0.1 }]];
      const reply = JSON.stringify([{
        index: 0,
        action,
        targetId: "MISSING",
        text: candidate.text,
      }]);

      const actions = await reconcileBatch(
        [candidate],
        makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
      );

      expect(actions).toEqual([undefined]);
      expect(db.get("MISSING")).toMatchObject({
        text: "Morgan prefers blue-green deployments",
        status: "open",
      });
      expect(dailyContent(root)).toBe(before);
    },
  );

  it("normalizes model-authored update and supersede text before canonical mutation", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "UPDATE", "Morgan prefers blue green deployments");
    await seed(db, root, "OLD", "Atlas launches in July this year");
    const candidates: CandidateMemory[] = [
      { type: "note", text: "Morgan prefers blue green deployments with review", salience: 0.7, isInsight: false },
      { type: "note", text: "Atlas launches in August this year", salience: 0.8, isInsight: false },
    ];
    db.findSimilarMany = async () => [
      [{ record: db.get("UPDATE")!, distance: 0.1 }],
      [{ record: db.get("OLD")!, distance: 0.1 }],
    ];
    const unsafe = `  Morgan\n prefers <!--mem blue green deployments ${"with review ".repeat(40)}`;
    const reply = JSON.stringify([
      { index: 0, action: "update", targetId: "UPDATE", text: unsafe },
      { index: 1, action: "supersede", targetId: "OLD", text: " \n <!--mem " },
    ]);

    const actions = await reconcileBatch(
      candidates,
      makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
    );

    expect(actions[0]).toEqual({ kind: "update", id: "UPDATE" });
    expect(actions[1]?.kind).toBe("supersede");
    expect(db.get("UPDATE")?.text).not.toMatch(/[\n\r]|<!--mem/u);
    expect(db.get("UPDATE")?.text.length).toBeLessThanOrEqual(280);
    const replacementId = actions[1]?.kind === "supersede" ? actions[1].newId : "";
    expect(db.get(replacementId)?.text).toBe(candidates[1]?.text);
    expect(db.get("OLD")?.status).toBe("invalidated");
  });

  it("keeps the lenient reconciliation path at 280 complete Unicode code points", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "EXACT", "Existing exact-boundary memory");
    await seed(db, root, "OVER", "Existing over-boundary memory");
    const candidates: CandidateMemory[] = [
      { type: "note", text: "Exact-boundary candidate", salience: 0.7, isInsight: false },
      { type: "note", text: "Over-boundary candidate", salience: 0.8, isInsight: false },
    ];
    db.findSimilarMany = async () => [
      [{ record: db.get("EXACT")!, distance: 0.1 }],
      [{ record: db.get("OVER")!, distance: 0.1 }],
    ];
    const exactBoundary = `${"a".repeat(279)}🧠`;
    const escapedOverBoundary = `${"a".repeat(139)}\ud83d${"a".repeat(140)}🧠tail`;
    const reply = JSON.stringify([
      { index: 0, action: "update", targetId: "EXACT", text: exactBoundary },
      { index: 1, action: "update", targetId: "OVER", text: escapedOverBoundary },
    ]);
    expect(reply).toContain("\\ud83d");

    const actions = await reconcileBatch(
      candidates,
      makeDeps(db, root, fakeLlm([["Classify each candidate", reply]])),
    );

    expect(actions).toEqual([
      { kind: "update", id: "EXACT" },
      { kind: "update", id: "OVER" },
    ]);
    expect(db.get("EXACT")?.text).toBe(exactBoundary);
    expect(db.get("OVER")?.text).toBe(exactBoundary);
    expect(Array.from(db.get("OVER")?.text ?? "")).toHaveLength(280);
    expect(db.get("OVER")?.text).not.toContain("�");
    expect(db.get("OVER")?.text).not.toMatch(/\p{Cs}/u);
  });

  it("allows an explicit valid add decision for a close candidate", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "NEAR", "Morgan reviewed the Atlas release budget");
    const candidate: CandidateMemory = {
      type: "note", text: "Morgan reviewed the Atlas release budget today", salience: 0.6, isInsight: false,
    };
    db.findSimilarMany = async () => [[{ record: db.get("NEAR")!, distance: 0.1 }]];
    const actions = await reconcileBatch(
      [candidate],
      makeDeps(db, root, fakeLlm([["Classify each candidate", '[{"index":0,"action":"add"}]']])),
    );
    expect(actions[0]?.kind).toBe("add");
    expect(db.count()).toBe(2);
  });

  it("serializes concurrent batches through replay so the second replans against the first", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "SERIAL", "Morgan prefers blue green deployments");
    const firstText = "Morgan prefers reviewed blue green deployments";
    const secondText = "Morgan prefers canary blue green deployments";
    let searches = 0;
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const observedTargets: string[] = [];
    db.findSimilarMany = async () => {
      searches += 1;
      observedTargets.push(db.get("SERIAL")!.text);
      if (searches === 1) {
        enterFirst();
        await firstGate;
      }
      return [[{ record: db.get("SERIAL")!, distance: 0.1 }]];
    };
    const llm: ReconcileDeps["llm"] = {
      id: "serialized-batches",
      complete: async (prompt) => {
        const text = prompt.includes(secondText) ? secondText : firstText;
        return JSON.stringify([{ index: 0, action: "update", targetId: "SERIAL", text }]);
      },
    };
    const completionOrder: string[] = [];
    const first = reconcileBatch(
      [{ type: "note", text: firstText, salience: 0.7, isInsight: false }],
      makeDeps(db, root, llm),
    ).then((result) => {
      completionOrder.push("first");
      return result;
    });
    await firstEntered;
    const second = reconcileBatch(
      [{ type: "note", text: secondText, salience: 0.8, isInsight: false }],
      makeDeps(db, root, llm),
    ).then((result) => {
      completionOrder.push("second");
      return result;
    });
    await Promise.resolve();
    expect(searches).toBe(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ kind: "update", id: "SERIAL" }],
      [{ kind: "update", id: "SERIAL" }],
    ]);

    expect(completionOrder).toEqual(["first", "second"]);
    expect(observedTargets).toEqual([
      "Morgan prefers blue green deployments",
      firstText,
    ]);
    expect(db.get("SERIAL")?.text).toBe(secondText);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);

    closeTrackedDb(db);
    const restarted = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: fakeEmbeddings(DIM),
      dim: DIM,
      llm: fakeLlm([]),
      clock: () => FIXED,
    });
    await restarted.close();
  });

  it("recovers a paid migration before exported reconcile performs provider planning", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "PAID-MIGRATION", "Aging migration state must settle before capture", { salience: 0.2 });
    const migrationNow = new Date("2026-08-20T12:00:00.000Z");
    await expect(migrate({
      db,
      root,
      llm: { id: "paid-migration", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => migrationNow,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-paid-migration-pending"); } },
    })).rejects.toThrow("leave-paid-migration-pending");
    const monthly = join(root, "monthly", "2026-08.md");
    expect(readFileSync(monthly, "utf8")).toContain("mono-agent-migrate:");

    let searches = 0;
    db.findSimilarMany = async () => {
      searches += 1;
      expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
      expect(db.get("PAID-MIGRATION")?.salience).toBe(0.5);
      return [[]];
    };
    const actions = await reconcileBatch(
      [{ type: "note", text: "A novel fact after recovered migration", salience: 0.7, isInsight: false }],
      makeDeps(db, root, fakeLlm([])),
    );

    expect(searches).toBe(1);
    expect(actions[0]?.kind).toBe("add");
    expect(readFileSync(monthly, "utf8")).not.toContain("mono-agent-migrate:");
  });

  it("fails dual pending migration and capture state before mutating either protocol", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "DUAL-PENDING", "Dual pending protocols have no shared sequence", { salience: 0.2 });
    const migrationNow = new Date("2026-08-20T12:00:00.000Z");
    await expect(migrate({
      db,
      root,
      llm: { id: "paid-migration", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => migrationNow,
      hooks: { afterDecisionDurable: () => { throw new Error("leave-dual-migration-pending"); } },
    })).rejects.toThrow("leave-dual-migration-pending");
    const file = relative(root, dailyFilePath(root, FIXED));
    const bullet = parseDailyFile(dailyContent(root)).bullets.find((candidate) => candidate.id === "DUAL-PENDING")!;
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: bullet.id,
      expected: { file, bullet },
    }], { entities: [], relations: [], associations: [] }, migrationNow.toISOString());
    const monthly = join(root, "monthly", "2026-08.md");
    const monthlyBefore = readFileSync(monthly, "utf8");
    const outboxBefore = readdirSync(join(root, ".capture-outbox"));
    let searches = 0;
    db.findSimilarMany = async () => {
      searches += 1;
      return [[]];
    };

    await expect(reconcileBatch(
      [{ type: "note", text: "Must not plan behind ambiguous recovery", salience: 0.7, isInsight: false }],
      makeDeps(db, root, fakeLlm([])),
    )).rejects.toThrow(/capture and migration durable state are both pending.*before any mutation/iu);

    expect(searches).toBe(0);
    expect(db.get("DUAL-PENDING")?.salience).toBe(0.2);
    expect(readFileSync(monthly, "utf8")).toBe(monthlyBefore);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual(outboxBefore);
  });

  it("lets an aborted waiter leave the root queue without entering provider planning", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "WAIT-ABORT", "Morgan prefers serialized memory mutations");
    let searches = 0;
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    db.findSimilarMany = async () => {
      searches += 1;
      if (searches === 1) {
        enterFirst();
        await firstGate;
      }
      return [[{ record: db.get("WAIT-ABORT")!, distance: 0.1 }]];
    };
    const llm: ReconcileDeps["llm"] = {
      id: "wait-abort",
      complete: async (prompt) => JSON.stringify([{
        index: 0,
        action: "update",
        targetId: "WAIT-ABORT",
        text: prompt.includes("third") ? "third serialized update" : "first serialized update",
      }]),
    };
    const first = reconcileBatch(
      [{ type: "note", text: "first serialized update", salience: 0.7, isInsight: false }],
      makeDeps(db, root, llm),
    );
    await firstEntered;
    const controller = new AbortController();
    const waiting = reconcileBatch(
      [{ type: "note", text: "aborted serialized update", salience: 0.7, isInsight: false }],
      makeDeps(db, root, llm, { abortSignal: controller.signal }),
    );
    controller.abort(new Error("cancel queued reconcile"));

    await expect(waiting).rejects.toThrow("cancel queued reconcile");
    expect(searches).toBe(1);
    releaseFirst();
    await expect(first).resolves.toEqual([{ kind: "update", id: "WAIT-ABORT" }]);
    await expect(reconcileBatch(
      [{ type: "note", text: "third serialized update", salience: 0.8, isInsight: false }],
      makeDeps(db, root, llm),
    )).resolves.toEqual([{ kind: "update", id: "WAIT-ABORT" }]);
    expect(searches).toBe(2);
    expect(db.get("WAIT-ABORT")?.text).toBe("third serialized update");
  });
});
