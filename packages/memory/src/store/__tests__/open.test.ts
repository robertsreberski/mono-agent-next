import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings as vectorEmbeddings } from "./helpers.js";

const fakeEmbeddings = { id: "fake", embed: async () => [] };

describe("openMemoryDb", () => {
  it("opens an in-memory db, loads sqlite-vec, and creates tables", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 8 });
    expect(db.vecVersion()).toMatch(/\d+\.\d+/);
    db.close();
  });

  it("rejects a non-positive dimension", () => {
    expect(() => openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 0 })).toThrow(/positive integer/);
  });

  it("sets a busy_timeout so a second writer (e.g. the MCP) retries instead of throwing SQLITE_BUSY", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 8 });
    expect(db.busyTimeoutMs()).toBeGreaterThanOrEqual(5000);
    db.close();
  });

  it("creates the db's parent directory if it does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "memstore-"));
    const parent = join(root, "nested", "deep");
    const path = join(parent, "memory.db");
    expect(existsSync(parent)).toBe(false);
    const db = openMemoryDb({ path, embeddings: fakeEmbeddings, dim: 8 });
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(path)).toBe(true);
    db.close();
  });

  it("does not create a missing parent directory for a read-only open", () => {
    const root = mkdtempSync(join(tmpdir(), "memstore-readonly-"));
    const parent = join(root, "nested", "deep");
    const path = join(parent, "memory.db");
    expect(existsSync(parent)).toBe(false);

    expect(() => openMemoryDb({ path, readOnly: true, embeddings: fakeEmbeddings, dim: 8 }))
      .toThrow("Cannot open database because the directory does not exist");

    expect(existsSync(parent)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it.each([false, true])("rejects an empty legacy vector table whose DDL dimension drifts (readOnly=%s)", (readOnly) => {
    const root = mkdtempSync(join(tmpdir(), "memstore-empty-dim-"));
    const path = join(root, "memory.db");
    const initial = openMemoryDb({ path, embeddings: vectorEmbeddings(8), dim: 8 });
    initial.close();

    const reopened = openMemoryDb({ path, embeddings: vectorEmbeddings(4), dim: 4, ...(readOnly ? { readOnly: true } : {}) });
    try {
      expect(() => reopened.assertEmbeddingIdentity()).toThrow(/vector dimension 8.*configured 4.*safe memory rebuild/iu);
    } finally {
      reopened.close();
    }
  });

  it.each(["embedding_model", "dim"] as const)(
    "rejects live legacy vectors with missing %s identity",
    async (field) => {
      const root = mkdtempSync(join(tmpdir(), "memstore-null-identity-"));
      const path = join(root, "memory.db");
      const embeddings = vectorEmbeddings(8);
      const initial = openMemoryDb({ path, embeddings, dim: 8 });
      await initial.upsert({
        id: "M1",
        type: "note",
        status: "open",
        text: "Identity must remain explicit.",
        salience: 0.5,
        isInsight: false,
        createdAt: "2026-07-11T00:00:00.000Z",
        accessCount: 0,
        tags: [],
        source: {},
      });
      initial.close();
      const raw = new BetterSqlite3(path);
      raw.prepare(`UPDATE memories SET ${field} = NULL WHERE id = ?`).run("M1");
      raw.close();

      const reopened = openMemoryDb({ path, embeddings, dim: 8, readOnly: true });
      try {
        expect(() => reopened.assertEmbeddingIdentity()).toThrow(/without complete embedding model\/dimension identity.*safe memory rebuild/iu);
      } finally {
        reopened.close();
      }
    },
  );
});
