import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { replayCaptureOutbox, writeCaptureIntent } from "../capture-outbox.js";
import { appendBullet } from "../daily.js";
import {
  auditCanonicalGraphParity,
  inspectCanonicalGraphMutation,
  type CanonicalGraphMutationProbes,
} from "../graph-parity.js";
import { appendEntity, appendGraphBatch, readGraph } from "../graph.js";
import { CanonicalFileRetiredError } from "../path-safety.js";
import { assertCanonicalGraphRepairBaseParity, readCanonicalGraphAuditSourceSnapshot } from "../rebuild.js";

const CANONICAL_AT = "2026-01-01T00:00:00.000Z";
const DRIFTED_AT = "2026-06-01T00:00:00.000Z";

describe("canonical graph parity", () => {
  it("reports aggregate payload, timestamp, provenance, missing, and extra drift without providers", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-"));
    appendCanonicalMemory(root, memory("M1"));
    appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: CANONICAL_AT },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: CANONICAL_AT },
        { id: "concept:memory", name: "Memory", type: "concept", createdAt: CANONICAL_AT },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: CANONICAL_AT,
      }],
      associations: [{
        memoryId: "M1",
        entityId: "person:morgan",
        provenance: "legacy-name-match",
        createdAt: CANONICAL_AT,
      }],
    });

    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1"));
    db.upsertEntity({ id: "person:morgan", name: "Morgan drifted", type: "person", createdAt: DRIFTED_AT });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: CANONICAL_AT });
    db.upsertEntity({ id: "org:extra", name: "Extra", type: "org", createdAt: CANONICAL_AT });
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains", DRIFTED_AT);
    db.associateMemory({
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: DRIFTED_AT,
    });

    let snapshots = 0;
    const inspected = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") {
          return () => {
            snapshots += 1;
            return target.canonicalGraphSnapshot();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(auditCanonicalGraphParity(root, inspected)).toEqual({
      status: "mismatch",
      tier: "bujo",
      matches: false,
      issues: [],
      mutation: {
        capturePending: false,
        migrationPending: false,
        sourceChanged: false,
      },
      entities: {
        canonical: 3,
        active: 3,
        matched: 1,
        missing: 1,
        extra: 1,
        mismatched: 1,
        payloadMismatches: 1,
        timestampMismatches: 1,
        provenanceMismatches: 0,
      },
      relations: {
        canonical: 1,
        active: 1,
        matched: 0,
        missing: 0,
        extra: 0,
        mismatched: 1,
        payloadMismatches: 0,
        timestampMismatches: 1,
        provenanceMismatches: 0,
      },
      associations: {
        canonical: 1,
        active: 1,
        matched: 0,
        missing: 0,
        extra: 0,
        mismatched: 1,
        payloadMismatches: 0,
        timestampMismatches: 1,
        provenanceMismatches: 1,
      },
      supports: emptySection(),
    });
    expect(snapshots).toBe(6);
    db.close();
  });

  it("reports exact parity after canonical projection mirroring", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-exact-"));
    appendCanonicalMemory(root, memory("M1"));
    const graph = appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: CANONICAL_AT },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: CANONICAL_AT },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: CANONICAL_AT,
      }],
      associations: [{
        memoryId: "M1",
        entityId: "person:morgan",
        provenance: "capture",
        createdAt: CANONICAL_AT,
      }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1"));
    for (const entity of graph.entities) db.mirrorCanonicalEntity(entity);
    for (const relation of graph.relations) db.mirrorCanonicalRelation(relation);
    for (const association of graph.associations) db.mirrorCanonicalAssociation(association);

    const parity = auditCanonicalGraphParity(root, db);
    expect(parity.matches).toBe(true);
    expect(parity.status).toBe("match");
    expect(parity.entities.matched).toBe(2);
    expect(parity.relations.matched).toBe(1);
    expect(parity.associations.matched).toBe(1);
    expect(parity.supports).toEqual(emptySection());
    db.close();
  });

  it.each([
    ["malformed-json" as const, "{not-json}\n"],
    ["unknown-kind" as const, `${JSON.stringify({ kind: "future-record", id: "x" })}\n`],
  ])("fails closed with %s while compatibility reads remain permissive", (code, graph) => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-invalid-"));
    writeFileSync(join(root, "graph.jsonl"), graph, "utf8");
    const db = openMemoryDb({ path: ":memory:" });

    expect(readGraph(root)).toEqual({ entities: [], relations: [], associations: [] });
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "invalid",
      matches: false,
      issues: [{ code, line: 1 }],
    });
    db.close();
  });

  it("rejects control characters even when the compatibility reader preserves them", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-control-"));
    writeFileSync(join(root, "graph.jsonl"), `${JSON.stringify({
      kind: "entity",
      id: "person:morgan\0collision",
      name: "Morgan",
      createdAt: CANONICAL_AT,
    })}\n`, "utf8");
    const db = openMemoryDb({ path: ":memory:" });

    expect(readGraph(root).entities).toHaveLength(1);
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "invalid",
      matches: false,
      issues: [{ code: "invalid-record", line: 1 }],
    });
    db.close();
  });

  it("returns in_progress for an admitted durable capture instead of divergence", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-pending-"));
    writeCaptureIntent(root, [], {}, CANONICAL_AT);
    const db = openMemoryDb({ path: ":memory:" });

    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "in_progress",
      matches: false,
      mutation: {
        capturePending: true,
        migrationPending: false,
        sourceChanged: false,
      },
    });
    db.close();
  });

  it.each(["capture", "monthly"] as const)(
    "classifies a typed %s marker retirement as transient source change",
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-retired-"));
      const retired = (): boolean => {
        throw new CanonicalFileRetiredError(kind === "capture" ? ".capture-outbox/intent.json" : "monthly/2026-01.md");
      };
      const probes: CanonicalGraphMutationProbes = {
        capturePending: kind === "capture" ? retired : () => false,
        migrationPending: kind === "monthly" ? retired : () => false,
      };

      expect(inspectCanonicalGraphMutation(root, probes)).toEqual({
        state: {
          capturePending: false,
          migrationPending: false,
          sourceChanged: true,
        },
      });
    },
  );

  it.each(["symlink", "hardlink"] as const)(
    "keeps stable %s capture-intent corruption invalid",
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-unsafe-intent-"));
      const handle = writeCaptureIntent(root, [], {}, CANONICAL_AT);
      const target = join(root, handle.file);
      const outside = join(mkdtempSync(join(tmpdir(), "bujo-graph-parity-unsafe-outside-")), "intent.json");
      writeFileSync(outside, readFileSync(target));
      unlinkSync(target);
      if (kind === "symlink") symlinkSync(outside, target);
      else linkSync(outside, target);
      const db = openMemoryDb({ path: ":memory:" });

      expect(auditCanonicalGraphParity(root, db)).toMatchObject({
        status: "invalid",
        matches: false,
        issues: [{ code: "durable-state-invalid" }],
      });
      db.close();
    },
  );

  it("reports a strict-invalid pending graph as durable corruption without appending it", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-invalid-intent-"));
    const handle = writeCaptureIntent(root, [], {
      entities: [{ id: "person:valid", name: "Valid", type: "person", createdAt: CANONICAL_AT }],
    }, CANONICAL_AT);
    const intentPath = join(root, handle.file);
    const intent = JSON.parse(readFileSync(intentPath, "utf8")) as {
      graph: { entities: Array<Record<string, unknown>> };
    };
    intent.graph.entities[0] = {
      ...intent.graph.entities[0],
      id: "person:bad\0id",
      type: 42,
    };
    writeFileSync(intentPath, `${JSON.stringify(intent)}\n`, "utf8");
    const db = openMemoryDb({ path: ":memory:" });

    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "invalid",
      matches: false,
      issues: [{ code: "durable-state-invalid" }],
    });
    expect(() => replayCaptureOutbox(root, db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    })).toThrow(/invalid|missing/iu);
    expect(existsSync(join(root, "graph.jsonl"))).toBe(false);
    db.close();
  });

  it("retries a completed source/index interleaving instead of false-failing", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-race-"));
    const db = openMemoryDb({ path: ":memory:" });
    const entity = { id: "person:morgan", name: "Morgan", createdAt: CANONICAL_AT };
    let inject = true;
    let snapshots = 0;
    const interleaved = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "canonicalGraphSnapshot") {
          return () => {
            snapshots += 1;
            const snapshot = target.canonicalGraphSnapshot();
            if (inject && snapshots === 2) {
              inject = false;
              appendEntity(root, entity);
              target.mirrorCanonicalEntity(entity);
            }
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(auditCanonicalGraphParity(root, interleaved)).toMatchObject({
      status: "match",
      matches: true,
      entities: { canonical: 1, active: 1, matched: 1 },
    });
    expect(snapshots).toBe(4);
    db.close();
  });

  it("derives legacy associations from canonical Markdown instead of stale SQLite text", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-canonical-memory-"));
    appendCanonicalMemory(root, { ...memory("M1"), text: "Alice maintains mono-agent." });
    const graph = appendGraphBatch(root, {
      entities: [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: CANONICAL_AT }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical(memory("M1"));
    db.mirrorCanonicalEntity(graph.entities[0]!);
    db.mirrorCanonicalAssociation({
      memoryId: "M1",
      entityId: "person:morgan",
      provenance: "legacy-name-match",
      createdAt: CANONICAL_AT,
    });

    expect(readCanonicalGraphAuditSourceSnapshot(root, "bujo").graph.associations).toEqual([]);
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "mismatch",
      matches: false,
      associations: { canonical: 0, active: 1, extra: 1 },
    });
    db.close();
  });

  it.each([
    ["missing edge", false, "projects"],
    ["missing collection", true, undefined],
  ] as const)("fails parity for migrated collection support with %s", (_label, addEdge, collection) => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-support-"));
    const canonical = { ...memory("M1"), status: "migrated" as const, text: "Project archive." };
    appendCanonicalMemory(root, canonical);
    const graph = appendGraphBatch(root, {
      entities: [{ id: "collection:projects", name: "Projects", type: "collection", createdAt: CANONICAL_AT }],
      associations: [{
        memoryId: "M1",
        entityId: "collection:projects",
        provenance: "capture",
        createdAt: CANONICAL_AT,
      }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical({ ...canonical, ...(collection === undefined ? {} : { collection }) });
    db.mirrorCanonicalEntity(graph.entities[0]!);
    db.mirrorCanonicalAssociation(graph.associations[0]!);
    if (addEdge) db.addEdge("M1", "collection:projects", "supports");

    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "mismatch",
      matches: false,
      supports: addEdge
        ? { canonical: 1, active: 1, mismatched: 1, payloadMismatches: 1 }
        : { canonical: 1, active: 1, missing: 1, extra: 1 },
    });
    db.close();
  });

  it("fails parity when a collection support edge has noncanonical weight", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-graph-parity-support-weight-"));
    const canonical = { ...memory("M1"), status: "migrated" as const, text: "Project archive." };
    appendCanonicalMemory(root, canonical);
    const graph = appendGraphBatch(root, {
      entities: [{ id: "collection:projects", name: "Projects", type: "collection", createdAt: CANONICAL_AT }],
      associations: [{
        memoryId: "M1",
        entityId: "collection:projects",
        provenance: "capture",
        createdAt: CANONICAL_AT,
      }],
    });
    const db = openMemoryDb({ path: ":memory:" });
    db.upsertLexical({ ...canonical, collection: "projects" });
    db.mirrorCanonicalEntity(graph.entities[0]!);
    db.mirrorCanonicalAssociation(graph.associations[0]!);
    db.addEdge("M1", "collection:projects", "supports", 0.25);

    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      status: "mismatch",
      matches: false,
      supports: {
        canonical: 1,
        active: 1,
        mismatched: 1,
        payloadMismatches: 1,
      },
    });
    db.close();
  });
});

function memory(id: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text: "Morgan maintains mono-agent.",
    salience: 0.7,
    isInsight: false,
    createdAt: CANONICAL_AT,
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-01-01.md", line: 3 },
  };
}

function appendCanonicalMemory(root: string, record: MemoryRecord): void {
  appendBullet(root, {
    id: record.id,
    type: record.type,
    status: record.status,
    text: record.text,
    salience: record.salience,
    isInsight: record.isInsight,
    createdAt: record.createdAt,
    refs: [],
  }, new Date(record.createdAt));
}

function emptySection() {
  return {
    canonical: 0,
    active: 0,
    matched: 0,
    missing: 0,
    extra: 0,
    mismatched: 0,
    payloadMismatches: 0,
    timestampMismatches: 0,
    provenanceMismatches: 0,
  };
}
