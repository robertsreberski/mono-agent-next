import { existsSync } from "node:fs";

import BetterSqlite3 from "better-sqlite3";

import { DEFAULT_VEC_DIM } from "../store/index.js";

export interface SqliteWriterFence {
  release(): void;
}

/** Hold BEGIN IMMEDIATE on every activation input so WAL writers cannot cross validation + rename. */
export function acquireSqliteWriterFences(paths: readonly string[]): SqliteWriterFence {
  const databases: BetterSqlite3.Database[] = [];
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const errors: unknown[] = [];
    for (const db of databases.reverse()) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch (error) {
        errors.push(error);
      }
      try {
        db.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "memory-rebuild: SQLite writer fence release failed.");
  };
  try {
    for (const path of [...new Set(paths)].sort()) {
      const db = new BetterSqlite3(path, { fileMustExist: true, timeout: 0 });
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        db.close();
        throw error;
      }
      databases.push(db);
    }
  } catch (error) {
    try {
      release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "memory-rebuild: SQLite writer fence acquisition failed.");
    }
    throw new Error(
      `memory-rebuild: a SQLite writer owns an activation database; stop it and retry. ${reasonOf(error)}`,
    );
  }
  return { release };
}

export function assertNoActiveSqliteWriter(path: string): void {
  if (!existsSync(path)) return;
  const db = new BetterSqlite3(path, { fileMustExist: true, timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw new Error(`memory-rebuild: active legacy SQLite writer detected; stop the configured agent first. ${reasonOf(error)}`);
  } finally {
    db.close();
  }
}

export async function backupRawSqlite(sourcePath: string, destinationPath: string): Promise<number> {
  const db = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_vec'`,
    ).get() as { sql: string } | undefined;
    const dimension = Number(row?.sql.match(/embedding\s+float\[(\d+)\]/iu)?.[1] ?? DEFAULT_VEC_DIM);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("memory-rebuild: legacy vector table has an invalid dimension.");
    }
    await db.backup(destinationPath);
    return dimension;
  } finally {
    db.close();
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
