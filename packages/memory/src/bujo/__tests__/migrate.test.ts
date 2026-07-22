import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendBullet, dailyFilePath, rewriteBullet } from "../daily.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { auditCanonicalGraphParity, type CanonicalGraphParityResult } from "../graph-parity.js";
import { parseDailyFile } from "../grammar.js";
import { appendGraphBatch, readGraph } from "../graph.js";
import {
  assertNoPendingMigrateDecision,
  forgetExplicitMemories,
  hasPendingMigrateDecision,
  migrate,
  previewExplicitForgetMemories,
  recoverPendingMigrateDecision,
  type MigrateDeps,
} from "../migrate.js";
import { MemoryModelError } from "../model-error.js";
import {
  assertCanonicalGraphRepairBaseParity,
  auditCanonicalIndexHealth,
} from "../rebuild.js";
import {
  initializeReplayProjection,
  readBujoCanonicalSourceFingerprint,
  readReplayProjectionStrict,
} from "../replay-projection.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
// "now" — 60-day-old memories are aging candidates (createdAt = now - 60d)
const NOW = new Date("2026-06-15T12:00:00.000Z");
const SIXTY_DAYS_AGO = new Date(NOW.getTime() - 60 * 86_400_000);

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-migrate-"));
}

function openDb(root: string): MemoryDb {
  initializeReplayProjection(root);
  const db = openMemoryDb({
    path: join(root, "memory.db"),
    embeddings: fakeEmbeddings(DIM),
    dim: DIM,
  });
  openDbs.push(db);
  return db;
}

function closeDb(db: MemoryDb): void {
  const index = openDbs.indexOf(db);
  if (index >= 0) openDbs.splice(index, 1);
  db.close();
}

/** Seed an aging memory: append a bullet to the daily file and upsert with old createdAt + low salience. */
async function seedAging(
  db: MemoryDb,
  root: string,
  id: string,
  text: string,
  opts: { salience?: number } = {},
): Promise<void> {
  const bullet: Bullet = {
    id,
    type: "note",
    status: "open",
    text,
    salience: opts.salience ?? 0.2,
    isInsight: false,
    createdAt: SIXTY_DAYS_AGO.toISOString(),
    refs: [],
  };
  // Write to daily file dated at SIXTY_DAYS_AGO so we can locate it via source.file
  appendBullet(root, bullet, SIXTY_DAYS_AGO);
  const record: MemoryRecord = {
    id,
    type: "note",
    status: "open",
    text,
    salience: bullet.salience,
    isInsight: false,
    createdAt: SIXTY_DAYS_AGO.toISOString(),
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, SIXTY_DAYS_AGO)) },
  };
  await db.upsert(record);
}

function makeDeps(
  db: MemoryDb,
  root: string,
  overrides: Partial<MigrateDeps> = {},
): MigrateDeps {
  return {
    db,
    root,
    llm: fakeLlm([]),
    now: () => NOW,
    canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    ...overrides,
  };
}

function dailyContent(root: string, when: Date): string {
  return readFileSync(dailyFilePath(root, when), "utf8");
}

describe("migrate", () => {
  it("forgets an explicit validated id set through the durable migration boundary", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "EXPLICIT-A", "first explicit forget sentinel");
    await seedAging(db, root, "EXPLICIT-B", "second explicit forget sentinel");
    const prepareVectors = vi.spyOn(db, "prepareUpsertVectors");
    const expectedSourceFingerprint = readBujoCanonicalSourceFingerprint(root);

    expect(previewExplicitForgetMemories(root, db, ["EXPLICIT-A", "EXPLICIT-B"])).toEqual({ eligible: 2 });
    const result = await forgetExplicitMemories({
      root,
      db,
      ids: ["EXPLICIT-A", "EXPLICIT-B"],
      now: () => NOW,
      expectedSourceFingerprint,
    });

    expect(result).toMatchObject({ forgotten: 2, recoveredPendingDecision: false });
    expect(result.sourceFingerprint).not.toBe(expectedSourceFingerprint);
    expect(prepareVectors).toHaveBeenCalledTimes(1);
    expect(prepareVectors.mock.calls[0]?.[0]).toHaveLength(2);
    expect(db.get("EXPLICIT-A")).toMatchObject({ status: "dropped", validTo: NOW.toISOString() });
    expect(db.get("EXPLICIT-B")).toMatchObject({ status: "dropped", validTo: NOW.toISOString() });
    expect(readReplayProjectionStrict(root).projection.terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "EXPLICIT-A", at: NOW.toISOString(), authorityKind: "migration" }),
      expect.objectContaining({ id: "EXPLICIT-B", at: NOW.toISOString(), authorityKind: "migration" }),
    ]));
    expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
  });

  it("rejects unknown, terminal, duplicate, and stale explicit forget plans before provider work", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "EXPLICIT-LIVE", "explicit rejection sentinel");
    const sourceFingerprint = readBujoCanonicalSourceFingerprint(root);
    const prepareVectors = vi.spyOn(db, "prepareUpsertVectors");

    expect(() => previewExplicitForgetMemories(root, db, ["UNKNOWN"])).toThrow(/unknown memory id/iu);
    expect(() => previewExplicitForgetMemories(root, db, ["EXPLICIT-LIVE", "EXPLICIT-LIVE"])).toThrow(/duplicates/iu);
    await expect(forgetExplicitMemories({
      root,
      db,
      ids: ["EXPLICIT-LIVE"],
      now: () => NOW,
      expectedSourceFingerprint: "0".repeat(64),
    })).rejects.toThrow(/source changed/iu);
    expect(prepareVectors).not.toHaveBeenCalled();

    await forgetExplicitMemories({
      root,
      db,
      ids: ["EXPLICIT-LIVE"],
      now: () => NOW,
      expectedSourceFingerprint: sourceFingerprint,
    });
    expect(() => previewExplicitForgetMemories(root, db, ["EXPLICIT-LIVE"])).toThrow(/already terminal/iu);
  });

  it("applies all four actions (promote / reschedule / cluster / forget) and writes monthly record", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed 4 aging low-salience memories
    await seedAging(db, root, "MIG-PROMOTE", "learn more about type theory fundamentals");
    await seedAging(db, root, "MIG-RESCHEDULE", "review quarterly goals and OKRs");
    await seedAging(db, root, "MIG-CLUSTER", "read book on stoicism and resilience");
    await seedAging(db, root, "MIG-FORGET", "buy milk from the corner store");
    const legacyEntity = {
      id: "concept:stoicism",
      name: "stoicism",
      type: "concept",
      createdAt: SIXTY_DAYS_AGO.toISOString(),
    } as const;
    appendGraphBatch(root, { entities: [legacyEntity] });
    db.mirrorCanonicalEntity(legacyEntity);
    db.mirrorCanonicalAssociation({
      memoryId: "MIG-CLUSTER",
      entityId: legacyEntity.id,
      provenance: "legacy-name-match",
      createdAt: SIXTY_DAYS_AGO.toISOString(),
    });

    // Script the fake LLM: key on each item's unique text fragment
    const dueAt = "2026-07-01T00:00:00.000Z";
    const llm = fakeLlm([
      ["type theory", JSON.stringify({ action: "promote" })],
      ["quarterly goals", JSON.stringify({ action: "reschedule", dueAt })],
      ["stoicism", JSON.stringify({ action: "cluster", collection: "books" })],
      ["buy milk", JSON.stringify({ action: "forget" })],
    ]);

    const result = await migrate(makeDeps(db, root, { llm }));

    // Counts
    expect(result.promoted).toBe(1);
    expect(result.rescheduled).toBe(1);
    expect(result.clustered).toBe(1);
    expect(result.forgotten).toBe(1);
    expect(result.reviewed).toBe(4);

    // --- promote: salience raised in db + in the daily file ---
    const promoted = db.get("MIG-PROMOTE");
    expect(promoted).toBeDefined();
    expect(promoted!.salience).toBeCloseTo(0.2 + 0.3, 5);

    const promotedFile = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO));
    const promotedBullet = promotedFile.bullets.find((b) => b.id === "MIG-PROMOTE");
    expect(promotedBullet).toBeDefined();
    expect(promotedBullet!.salience).toBeCloseTo(0.2 + 0.3, 5);

    // --- reschedule: status scheduled + dueAt in db + in the daily file ---
    const rescheduled = db.get("MIG-RESCHEDULE");
    expect(rescheduled).toBeDefined();
    expect(rescheduled!.status).toBe("scheduled");
    expect(rescheduled!.dueAt).toBe(dueAt);

    const rescheduledBullet = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-RESCHEDULE",
    );
    expect(rescheduledBullet).toBeDefined();
    expect(rescheduledBullet!.status).toBe("scheduled");
    expect(rescheduledBullet!.dueAt).toBe(dueAt);

    // --- cluster: collection set in db + collection entity + supports edge ---
    const clustered = db.get("MIG-CLUSTER");
    expect(clustered).toBeDefined();
    expect(clustered!.status).toBe("migrated");
    expect(clustered!.collection).toBe("books");
    expect(parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-CLUSTER",
    )?.status).toBe("migrated");

    const collectionEntity = db.getEntity("collection:books");
    expect(collectionEntity).toBeDefined();
    expect(collectionEntity!.id).toBe("collection:books");
    expect(collectionEntity!.type).toBe("collection");

    const clusterEdges = db.edges("MIG-CLUSTER");
    expect(clusterEdges.some((e) => e.kind === "supports" && e.dst === "collection:books")).toBe(true);
    expect(db.associationsForMemory("MIG-CLUSTER")).toEqual([
      expect.objectContaining({
        memoryId: "MIG-CLUSTER",
        entityId: "collection:books",
        provenance: "capture",
      }),
    ]);
    const canonicalGraph = readGraph(root);
    expect(canonicalGraph.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "collection:books", name: "books", type: "collection" }),
    ]));
    expect(canonicalGraph.associations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memoryId: "MIG-CLUSTER",
        entityId: "collection:books",
        provenance: "capture",
      }),
    ]));

    // --- forget: status dropped + validTo in db + daily line struck ---
    const forgotten = db.get("MIG-FORGET");
    expect(forgotten).toBeDefined();
    expect(forgotten!.status).toBe("dropped");
    expect(forgotten!.validTo).toBe(NOW.toISOString());
    expect(readReplayProjectionStrict(root).projection.terminals).toEqual([
      expect.objectContaining({ id: "MIG-FORGET", at: NOW.toISOString(), authorityKind: "migration" }),
    ]);

    const forgottenBullet = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-FORGET",
    );
    expect(forgottenBullet).toBeDefined();
    expect(forgottenBullet!.status).toBe("dropped");
    expect(auditCanonicalGraphParity(root, db).matches).toBe(true);
    expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });

    // --- monthly/<YYYY-MM>.md exists and lists the actions ---
    const monthlyPath = join(root, "monthly", "2026-06.md");
    expect(existsSync(monthlyPath)).toBe(true);
    const monthlyContent = readFileSync(monthlyPath, "utf8");
    expect(monthlyContent).toContain("promote");
    expect(monthlyContent).toContain("MIG-PROMOTE");
    expect(monthlyContent).toContain("reschedule");
    expect(monthlyContent).toContain("MIG-RESCHEDULE");
    expect(monthlyContent).toContain("cluster");
    expect(monthlyContent).toContain("MIG-CLUSTER");
    expect(monthlyContent).toContain("forget");
    expect(monthlyContent).toContain("MIG-FORGET");
    expect(monthlyContent).not.toContain("mono-agent-migrate:");
  });

  it("refuses a symlinked monthly directory without writing outside the memory root", async () => {
    const root = newRoot();
    const outside = mkdtempSync(join(tmpdir(), "bujo-migrate-outside-"));
    const db = openDb(root);
    await seedAging(db, root, "MIG-LINK", "monthly path confinement sentinel");
    symlinkSync(outside, join(root, "monthly"), "dir");
    const llm = fakeLlm([["path confinement", JSON.stringify({ action: "promote" })]]);

    await expect(migrate(makeDeps(db, root, { llm }))).rejects.toThrow(/directory.*symlink/iu);
    expect(existsSync(join(outside, "2026-06.md"))).toBe(false);
    expect(db.get("MIG-LINK")?.salience).toBe(0.2);
  });

  it("normalizes a bounded ASCII collection slug before durable publication", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-SLUG", "normalized collection migration sentinel");

    const result = await migrate(makeDeps(db, root, {
      llm: { id: "slug", complete: async () => JSON.stringify({ action: "cluster", collection: " Project_Notes " }) },
    }));

    expect(result).toMatchObject({ clustered: 1, reviewed: 1 });
    expect(db.get("MIG-SLUG")).toMatchObject({ status: "migrated", collection: "project-notes" });
    expect(readGraph(root)).toMatchObject({
      entities: [expect.objectContaining({ id: "collection:project-notes", name: "project-notes" })],
      associations: [expect.objectContaining({
        memoryId: "MIG-SLUG",
        entityId: "collection:project-notes",
      })],
    });
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({ status: "match", matches: true });
  });

  it.each([
    ["C0", "bad\0collection"],
    ["format", "bad\u202Ecollection"],
    ["surrogate", "bad\uD800collection"],
  ])("rejects %s controls in collection output before embedding or publication", async (_label, collection) => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, `MIG-CONTROL-${_label}`, "invalid collection migration sentinel");
    const provider = vi.spyOn(db, "prepareUpsertVectors");

    const result = await migrate(makeDeps(db, root, {
      llm: { id: "invalid-collection", complete: async () => JSON.stringify({ action: "cluster", collection }) },
    }));

    expect(result).toEqual({ promoted: 0, rescheduled: 0, clustered: 0, forgotten: 0, reviewed: 1 });
    expect(provider).not.toHaveBeenCalled();
    expect(db.get(`MIG-CONTROL-${_label}`)).toMatchObject({ status: "open" });
    expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
    expect(existsSync(join(root, "monthly", "2026-06.md"))).toBe(false);
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({ status: "match", matches: true });
  });

  it("rejects a rebound durable cluster decision whose collection is not canonical", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-SLUG-MARKER", "durable collection marker sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: { id: "slug-marker", complete: async () => JSON.stringify({ action: "cluster", collection: "projects" }) },
      hooks: { afterDecisionDurable: () => { throw new Error("leave-cluster-marker"); } },
    }))).rejects.toThrow("leave-cluster-marker");
    const monthlyPath = join(root, "monthly", "2026-06.md");
    const monthly = readFileSync(monthlyPath, "utf8");
    const marker = /<!-- mono-agent-migrate:([^\n ]+) -->/u.exec(monthly);
    expect(marker).not.toBeNull();
    const decision = JSON.parse(Buffer.from(marker![1]!, "base64url").toString("utf8")) as {
      decisionId: string;
      collection: string;
      updated: { collection: string };
      [key: string]: unknown;
    };
    decision.collection = "Project Notes";
    decision.updated.collection = "Project Notes";
    const { decisionId: _decisionId, ...payload } = decision;
    decision.decisionId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const rebound = Buffer.from(JSON.stringify(decision), "utf8").toString("base64url");
    writeFileSync(monthlyPath, monthly.replace(marker![0], `<!-- mono-agent-migrate:${rebound} -->`), "utf8");

    expect(() => hasPendingMigrateDecision(root)).toThrow(/binding.*invalid/iu);
  });

  it.each(["after-decision", "after-action"] as const)(
    "replays a durable pending decision after restart without another model call (%s)",
    async (fault) => {
      const root = newRoot();
      let db = openDb(root);
      await seedAging(db, root, "MIG-RETRY", "retry-safe monthly migration sentinel");
      const firstLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));

      await expect(migrate(makeDeps(db, root, {
        llm: { id: "first", complete: firstLlm },
        hooks: fault === "after-decision"
          ? { afterDecisionDurable: () => { throw new Error("fault-after-decision"); } }
          : { afterActionCommitted: () => { throw new Error("fault-after-action"); } },
      }))).rejects.toThrow(`fault-${fault}`);

      expect(firstLlm).toHaveBeenCalledTimes(1);
      expect(db.get("MIG-RETRY")?.salience).toBe(fault === "after-decision" ? 0.2 : 0.5);
      const monthly = readFileSync(join(root, "monthly", "2026-06.md"), "utf8");
      expect(monthly).toContain("mono-agent-migrate:");
      expect(monthly).not.toContain("mono-agent-migrate:complete:");
      expect(() => assertNoPendingMigrateDecision(root)).toThrow(/durable decision.*pending/iu);

      closeDb(db);
      db = openDb(root);
      const retryLlm = vi.fn(async () => { throw new Error("retry must not call the LLM"); });
      const retried = await migrate(makeDeps(db, root, { llm: { id: "retry", complete: retryLlm } }));

      expect(retryLlm).not.toHaveBeenCalled();
      expect(retried).toMatchObject({ promoted: 1, reviewed: 1 });
      expect(db.get("MIG-RETRY")?.salience).toBe(0.5);
      expect(parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets[0]?.salience).toBe(0.5);
      const recoveredMonthly = readFileSync(join(root, "monthly", "2026-06.md"), "utf8");
      expect(recoveredMonthly).toContain("- promote MIG-RETRY");
      expect(recoveredMonthly).not.toContain("mono-agent-migrate:");
      expect(() => assertNoPendingMigrateDecision(root)).not.toThrow();
    },
  );

  it("converges a crashed forget after sidecar and SQLite commit without another provider call", async () => {
    const root = newRoot();
    let db = openDb(root);
    await seedAging(db, root, "MIG-FORGET-RETRY", "forget crash convergence sentinel");
    const firstLlm = vi.fn(async () => JSON.stringify({ action: "forget" }));

    await expect(migrate(makeDeps(db, root, {
      llm: { id: "first-forget", complete: firstLlm },
      hooks: { afterActionCommitted: () => { throw new Error("fault-after-forget-commit"); } },
    }))).rejects.toThrow("fault-after-forget-commit");

    expect(db.get("MIG-FORGET-RETRY")).toMatchObject({ status: "dropped", validTo: NOW.toISOString() });
    expect(readReplayProjectionStrict(root).projection.terminals).toEqual([
      expect.objectContaining({ id: "MIG-FORGET-RETRY", at: NOW.toISOString() }),
    ]);
    expect(hasPendingMigrateDecision(root)).toBe(true);
    rmSync(join(root, ".replay-projection-v1.json"));

    closeDb(db);
    db = openMemoryDb({
      path: join(root, "memory.db"),
      embeddings: fakeEmbeddings(DIM),
      dim: DIM,
    });
    openDbs.push(db);
    const retryLlm = vi.fn(async () => { throw new Error("retry must not call the LLM"); });
    const result = await migrate(makeDeps(db, root, { llm: { id: "retry-forget", complete: retryLlm } }));

    expect(retryLlm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ forgotten: 1, reviewed: 1 });
    expect(hasPendingMigrateDecision(root)).toBe(false);
    expect(auditCanonicalIndexHealth(root, "bujo", db)).toEqual({ status: "match" });
  });

  it("reports an admitted durable migration as in_progress instead of graph divergence", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-PARITY", "migration parity transaction sentinel");
    let observed: CanonicalGraphParityResult | undefined;

    await expect(migrate(makeDeps(db, root, {
      llm: { id: "migration-parity", complete: async () => JSON.stringify({ action: "promote" }) },
      hooks: {
        afterDecisionDurable: () => {
          observed = auditCanonicalGraphParity(root, db);
          throw new Error("leave-parity-migration-pending");
        },
      },
    }))).rejects.toThrow("leave-parity-migration-pending");

    expect(observed).toMatchObject({
      status: "in_progress",
      matches: false,
      mutation: {
        capturePending: false,
        migrationPending: true,
        sourceChanged: false,
      },
    });
  });

  it("recovers a paid decision without providers while preserving newer access telemetry", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-TELEMETRY", "preserve live migration access telemetry");
    const firstLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));
    await expect(migrate(makeDeps(db, root, {
      llm: { id: "first", complete: firstLlm },
      hooks: { afterDecisionDurable: () => { throw new Error("fault-after-paid-decision"); } },
    }))).rejects.toThrow("fault-after-paid-decision");

    const accessedAt = new Date("2026-06-15T12:30:00.000Z");
    db.recordAccess(["MIG-TELEMETRY"], accessedAt);
    const provider = vi.spyOn(db, "prepareUpsertVectors");

    expect(recoverPendingMigrateDecision(root, db, assertCanonicalGraphRepairBaseParity)).toBe(true);

    expect(firstLlm).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
    expect(db.get("MIG-TELEMETRY")).toMatchObject({
      salience: 0.5,
      accessCount: 1,
      lastAccessedAt: accessedAt.toISOString(),
    });
    expect(readFileSync(join(root, "monthly", "2026-06.md"), "utf8")).not.toContain("mono-agent-migrate:");
    expect(recoverPendingMigrateDecision(root, db, assertCanonicalGraphRepairBaseParity)).toBe(false);
  });

  it("rejects duplicate canonical ids before paying providers or publishing a decision", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-DUPLICATE", "duplicate canonical migration sentinel");
    const canonical = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets[0]!;
    appendBullet(root, canonical, SIXTY_DAYS_AGO);
    const before = dailyContent(root, SIXTY_DAYS_AGO);
    const llm = vi.fn(async () => JSON.stringify({ action: "promote" }));
    const provider = vi.spyOn(db, "prepareUpsertVectors");

    await expect(migrate(makeDeps(db, root, { llm: { id: "must-not-run", complete: llm } })))
      .rejects.toThrow(/contains 2 bullets.*exactly one/iu);

    expect(llm).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(db.get("MIG-DUPLICATE")?.salience).toBe(0.2);
    expect(dailyContent(root, SIXTY_DAYS_AGO)).toBe(before);
    expect(existsSync(join(root, "monthly", "2026-06.md"))).toBe(false);
  });

  it("keeps a paid decision pending when its canonical id becomes duplicated", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-DUPLICATE-RETRY", "duplicate recovery migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: { id: "first", complete: async () => JSON.stringify({ action: "promote" }) },
      hooks: { afterDecisionDurable: () => { throw new Error("fault-after-paid-decision"); } },
    }))).rejects.toThrow("fault-after-paid-decision");
    const canonical = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets[0]!;
    appendBullet(root, canonical, SIXTY_DAYS_AGO);
    const before = dailyContent(root, SIXTY_DAYS_AGO);

    expect(() => recoverPendingMigrateDecision(root, db, assertCanonicalGraphRepairBaseParity))
      .toThrow(/contains 2 bullets.*exactly one/iu);

    expect(db.get("MIG-DUPLICATE-RETRY")?.salience).toBe(0.2);
    expect(dailyContent(root, SIXTY_DAYS_AGO)).toBe(before);
    expect(readFileSync(join(root, "monthly", "2026-06.md"), "utf8")).toContain("mono-agent-migrate:");
  });

  it("promotes very-low-salience memories out of the aging pool", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-LOW", "very low salience promotion sentinel", { salience: 0 });
    const firstLlm = vi.fn(async () => JSON.stringify({ action: "promote" }));

    const first = await migrate(makeDeps(db, root, { llm: { id: "first", complete: firstLlm } }));
    expect(first.promoted).toBe(1);
    expect(db.get("MIG-LOW")?.salience).toBe(0.5);

    const retryLlm = vi.fn(async () => { throw new Error("promoted item must leave aging pool"); });
    const retry = await migrate(makeDeps(db, root, { llm: { id: "retry", complete: retryLlm } }));
    expect(retry.reviewed).toBe(0);
    expect(retryLlm).not.toHaveBeenCalled();
  });

  it("recovers a clustered decision into a terminal state without a second LLM call", async () => {
    const root = newRoot();
    let db = openDb(root);
    await seedAging(db, root, "MIG-CLUSTER-RETRY", "cluster retry migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: fakeLlm([["cluster retry", JSON.stringify({ action: "cluster", collection: "retries" })]]),
      hooks: { afterDecisionDurable: () => { throw new Error("crash-after-cluster-decision"); } },
    }))).rejects.toThrow("crash-after-cluster-decision");
    closeDb(db);
    db = openDb(root);
    const retryLlm = vi.fn(async () => { throw new Error("cluster recovery must not call LLM"); });

    const recovered = await migrate(makeDeps(db, root, { llm: { id: "retry", complete: retryLlm } }));

    expect(retryLlm).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({ clustered: 1, reviewed: 1 });
    expect(db.get("MIG-CLUSTER-RETRY")).toMatchObject({ status: "migrated", collection: "retries" });
    expect(parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (b) => b.id === "MIG-CLUSTER-RETRY",
    )?.status).toBe("migrated");
    expect(readGraph(root).associations).toEqual([
      expect.objectContaining({
        memoryId: "MIG-CLUSTER-RETRY",
        entityId: "collection:retries",
        provenance: "capture",
      }),
    ]);
  });

  it("fails closed when canonical source changes after a pending decision is durable", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-CONFLICT", "canonical conflict migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: fakeLlm([["canonical conflict", JSON.stringify({ action: "promote" })]]),
      hooks: { afterDecisionDurable: () => { throw new Error("crash-after-decision"); } },
    }))).rejects.toThrow("crash-after-decision");
    const source = relative(root, dailyFilePath(root, SIXTY_DAYS_AGO));
    expect(rewriteBullet(root, source, "MIG-CONFLICT", { text: "An intervening canonical edit." })).toBe(true);
    const retryLlm = vi.fn(async () => { throw new Error("must not call model on conflict"); });

    await expect(migrate(makeDeps(db, root, {
      llm: { id: "retry", complete: retryLlm },
    }))).rejects.toThrow(/no longer matches|canonical/iu);

    expect(retryLlm).not.toHaveBeenCalled();
    expect(db.get("MIG-CONFLICT")?.salience).toBe(0.2);
    expect(readFileSync(join(root, "monthly", "2026-06.md"), "utf8")).toContain("mono-agent-migrate:");
  });

  it("fails closed on a corrupted pending marker instead of silently paying for another decision", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-CORRUPT", "corrupted marker migration sentinel");
    await expect(migrate(makeDeps(db, root, {
      llm: fakeLlm([["corrupted marker", JSON.stringify({ action: "promote" })]]),
      hooks: { afterDecisionDurable: () => { throw new Error("crash-after-decision"); } },
    }))).rejects.toThrow("crash-after-decision");
    const monthlyPath = join(root, "monthly", "2026-06.md");
    const corrupted = readFileSync(monthlyPath, "utf8").replace(
      /<!-- mono-agent-migrate:[^\n]+ -->/u,
      "<!-- mono-agent-migrate:not-valid-base64 -->",
    );
    writeFileSync(monthlyPath, corrupted, "utf8");
    const retryLlm = vi.fn(async () => { throw new Error("must not call model on corrupt marker"); });

    await expect(migrate(makeDeps(db, root, {
      llm: { id: "retry", complete: retryLlm },
    }))).rejects.toThrow(/malformed durable pending decision/iu);

    expect(retryLlm).not.toHaveBeenCalled();
    expect(db.get("MIG-CORRUPT")?.salience).toBe(0.2);
  });

  it("surfaces (rethrows) a model failure during migration instead of swallowing it per-item", async () => {
    const root = newRoot();
    const db = openDb(root);

    await seedAging(db, root, "MIG-A", "this item will be reviewed by the migrator");
    await seedAging(db, root, "MIG-B", "stoic philosophy reading list for the weekend");

    // A real model outage fails every call (not per-content). It must surface so the ritual
    // scheduler logs it — not look like a migration that found nothing to do.
    const throwingLlm = {
      id: "throwing-llm",
      complete: async (): Promise<string> => { throw new Error("ollama unavailable"); },
    };

    const err = await migrate(makeDeps(db, root, { llm: throwingLlm })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryModelError);
    expect((err as MemoryModelError).kind).toBe("llm");
    expect((err as MemoryModelError).stage).toBe("migrate");
    expect((err as Error).message).toMatch(/ollama unavailable/);
    // A migration failure must NOT read as a "capture" failure.
    expect((err as Error).message).not.toMatch(/capture/i);
  });

  it("surfaces an embedding outage after one paid decision instead of repeating the LLM across the batch", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-EMBED-A", "first embedding outage sentinel");
    await seedAging(db, root, "MIG-EMBED-B", "second embedding outage sentinel");
    vi.spyOn(db, "prepareUpsertVectors").mockRejectedValue(new Error("embedding provider unavailable"));
    const complete = vi.fn(async () => JSON.stringify({ action: "promote" }));

    const err = await migrate(makeDeps(db, root, {
      llm: { id: "paid-decision", complete },
    })).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(MemoryModelError);
    expect((err as MemoryModelError).kind).toBe("embedding");
    expect((err as MemoryModelError).stage).toBe("migrate");
    expect((err as Error).message).toMatch(/embedding provider unavailable/iu);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(db.get("MIG-EMBED-A")?.salience).toBe(0.2);
    expect(db.get("MIG-EMBED-B")?.salience).toBe(0.2);
    expect(existsSync(join(root, "monthly", "2026-06.md"))).toBe(false);
  });

  it("isolates a genuine per-item data error (missing daily file) without aborting the batch", async () => {
    const root = newRoot();
    const db = openDb(root);

    // A good aging item with a real daily file...
    await seedAging(db, root, "MIG-GOOD", "good item that the migrator forgets");
    // ...and an aging index record whose canonical daily file is MISSING (index/markdown divergence).
    // A "promote" decision will try to rewrite the missing file → a DATA error, isolated per-item.
    await db.upsert({
      id: "MIG-GHOST", type: "note", status: "open", text: "ghost item that the migrator promotes",
      salience: 0.2, isInsight: false, createdAt: SIXTY_DAYS_AGO.toISOString(), accessCount: 0, tags: [],
      source: { file: "daily/2099-01-01.md" },
    });

    const llm = fakeLlm([
      ["ghost item that the migrator promotes", JSON.stringify({ action: "promote" })],
      ["good item that the migrator forgets", JSON.stringify({ action: "forget" })],
    ]);

    // The data error on MIG-GHOST is isolated; the batch is not aborted and does not reject.
    const result = await migrate(makeDeps(db, root, { llm }));

    expect(result.forgotten).toBe(1);
    expect(db.get("MIG-GHOST")!.status).toBe("open"); // unchanged — its write failed and was skipped
    expect(db.get("MIG-GOOD")!.status).toBe("dropped");
  });

  it("skips an index-only item before paying the model when no canonical bullet exists", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Upsert a record directly without a source.file (no corresponding disk bullet)
    await db.upsert({
      id: "MIG-NOFILE",
      type: "note",
      status: "open",
      text: "orphaned index record with no file",
      salience: 0.2,
      isInsight: false,
      createdAt: SIXTY_DAYS_AGO.toISOString(),
      accessCount: 0,
      tags: [],
      source: {}, // no file
    });

    const complete = vi.fn(async () => JSON.stringify({ action: "promote" }));

    const result = await migrate(makeDeps(db, root, { llm: { id: "must-not-run", complete } }));

    expect(result).toMatchObject({ promoted: 0, reviewed: 1 });
    expect(complete).not.toHaveBeenCalled();

    const record = db.get("MIG-NOFILE");
    expect(record!.salience).toBe(0.2);
    expect(existsSync(join(root, "monthly", "2026-06.md"))).toBe(false);
  });

  it("skips items with invalid/unrecognized action from LLM", async () => {
    const root = newRoot();
    const db = openDb(root);

    await seedAging(db, root, "MIG-INVALID", "item that gets invalid action from llm");

    const llm = fakeLlm([["invalid action", JSON.stringify({ action: "teleport" })]]);

    const result = await migrate(makeDeps(db, root, { llm }));

    // Reviewed but no action taken
    expect(result.reviewed).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.rescheduled).toBe(0);
    expect(result.clustered).toBe(0);
    expect(result.forgotten).toBe(0);

    // Record unchanged
    expect(db.get("MIG-INVALID")!.status).toBe("open");
  });

  it("returns all-zero counts when no aging items exist", async () => {
    const root = newRoot();
    const db = openDb(root);

    // Seed a fresh high-salience memory (not an aging candidate)
    await db.upsert({
      id: "FRESH",
      type: "note",
      status: "open",
      text: "just captured this moment",
      salience: 0.8,
      isInsight: false,
      createdAt: NOW.toISOString(),
      accessCount: 0,
      tags: [],
      source: {},
    });

    const llm = fakeLlm([["just captured", JSON.stringify({ action: "forget" })]]);

    const result = await migrate(makeDeps(db, root, { llm }));

    expect(result.reviewed).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.forgotten).toBe(0);
  });

  it("replays a pending capture before migration scans for new provider work", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seedAging(db, root, "MIG-CAPTURE-FENCE", "capture must settle before migration", { salience: 0.8 });
    const file = relative(root, dailyFilePath(root, SIXTY_DAYS_AGO));
    const bullet = parseDailyFile(dailyContent(root, SIXTY_DAYS_AGO)).bullets.find(
      (candidate) => candidate.id === "MIG-CAPTURE-FENCE",
    )!;
    const handle = writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: bullet.id,
      expected: { file, bullet },
    }], { entities: [], relations: [], associations: [] }, NOW.toISOString());
    const originalAgingOpen = db.agingOpen.bind(db);
    const scan = vi.spyOn(db, "agingOpen").mockImplementation((now, options) => {
      expect(existsSync(join(root, handle.file))).toBe(false);
      return originalAgingOpen(now, options);
    });
    const embeddings = vi.spyOn(db, "prepareUpsertVectors");
    const complete = vi.fn(async () => { throw new Error("fresh migration must not call the model"); });

    const result = await migrate(makeDeps(db, root, { llm: { id: "must-not-run", complete } }));

    expect(result).toEqual({ promoted: 0, rescheduled: 0, clustered: 0, forgotten: 0, reviewed: 0 });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(embeddings).not.toHaveBeenCalled();
    expect(existsSync(join(root, handle.file))).toBe(false);
  });
});
