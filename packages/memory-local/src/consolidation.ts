import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { MemoryLocalError } from "./errors.js";
import {
  createSecureFile,
  inspectSecureFile,
  pathExists,
  readSecureFile,
  sameFileIdentity,
  syncDirectory,
  verifySecureRoot,
  type FileIdentity,
  type SecureRoot,
} from "./security.js";

export const MEMORY_LOCAL_INDEX_FILENAME = "index.md";
export const MEMORY_LOCAL_FUTURE_LOG_FILENAME = "future-log.md";

const MAX_DUPLICATE_SCAN = 100_000;
const MAX_ENTITY_SCAN = 10_000;
const TOP_MEMORY_LIMIT = 15;
const INDEX_ENTITY_LIMIT = 50;
const MAX_PROJECTED_TEXT_BYTES = 4_096;
const MAX_PROJECTED_LABEL_BYTES = 512;
const MAX_PROJECTION_BYTES = 256 * 1024;
const LOW_VALUE_ENTITY_TYPES = new Set([
  "date",
  "datetime",
  "day",
  "duration",
  "month",
  "quarter",
  "temporal",
  "time",
  "timestamp",
  "week",
  "weekday",
  "year",
]);

export interface MemoryLocalConsolidateResult {
  readonly duplicateGroups: number;
  readonly records: number;
  readonly entities: number;
  readonly indexBytes: number;
  readonly futureLogBytes: number;
}

export type MemoryLocalProjectionStatus = "ready" | "missing" | "unsafe" | "invalid";

export interface MemoryLocalProjectionAudit {
  readonly index: MemoryLocalProjectionStatus;
  readonly futureLog: MemoryLocalProjectionStatus;
  /** True only when both projections are safe and structurally valid. */
  readonly complete: boolean;
  /**
   * A never-consolidated pair (both missing) is coherent. One missing
   * companion, unsafe bytes, or invalid content is an incomplete publication.
   */
  readonly coherent: boolean;
}

interface ConsolidateOptions {
  readonly root: SecureRoot;
  readonly database: DatabaseSync;
  readonly signal: AbortSignal;
  readonly beforeCommit?: () => void | Promise<void>;
}

interface ProjectionTarget {
  readonly path: string;
  readonly expected?: FileIdentity;
}

interface EntityProjection {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

interface EntityGroup {
  representative: EntityProjection;
  type?: string;
  typeConflict: boolean;
}

/**
 * Refresh the human-readable BuJo projections without mutating canonical rows.
 *
 * This deliberately has no model, embedding, scheduler, or repair dependency.
 * The store owns admission and writer fencing around this function.
 */
export async function consolidateBujoProjections(
  options: ConsolidateOptions,
): Promise<MemoryLocalConsolidateResult> {
  throwIfAborted(options.signal);
  const snapshot = readSnapshot(options.database);
  const index = renderIndex(snapshot);
  const futureLog = "# Future Log\n";
  const indexBytes = Buffer.byteLength(index, "utf8");
  const futureLogBytes = Buffer.byteLength(futureLog, "utf8");
  if (indexBytes > MAX_PROJECTION_BYTES || futureLogBytes > MAX_PROJECTION_BYTES) {
    throw new MemoryLocalError(
      "maintenance_failed",
      "Memory consolidation projection exceeds its fixed byte bound.",
    );
  }

  await verifySecureRoot(options.root);
  const indexTarget = await observeTarget(
    join(options.root.path, MEMORY_LOCAL_INDEX_FILENAME),
  );
  const futureLogTarget = await observeTarget(
    join(options.root.path, MEMORY_LOCAL_FUTURE_LOG_FILENAME),
  );
  const stagedIndex = await stageProjection(options.root, "index", index);
  let stagedFutureLog: ProjectionTarget | undefined;
  try {
    stagedFutureLog = await stageProjection(options.root, "future-log", futureLog);
    throwIfAborted(options.signal);
    await verifyTarget(indexTarget);
    await verifyTarget(futureLogTarget);
    await rename(stagedFutureLog.path, futureLogTarget.path);
    await verifyPublishedTarget(futureLogTarget.path, stagedFutureLog.expected!);
    await syncDirectory(options.root.path);
    await options.beforeCommit?.();
    throwIfAborted(options.signal);
    await verifySecureRoot(options.root);
    await verifyTarget(indexTarget);

    // future-log.md is a deterministic constant. Publishing it first makes
    // index.md the semantic commit point: a pre-commit crash retains the prior
    // index, and retry can safely republish the companion before committing.
    await rename(stagedIndex.path, indexTarget.path);
    await verifyPublishedTarget(indexTarget.path, stagedIndex.expected!);
    await syncDirectory(options.root.path);
    await verifySecureRoot(options.root);
  } finally {
    await unlink(stagedIndex.path).catch(() => undefined);
    if (stagedFutureLog !== undefined) {
      await unlink(stagedFutureLog.path).catch(() => undefined);
    }
  }

  return Object.freeze({
    duplicateGroups: snapshot.duplicateGroups,
    records: snapshot.recordCount,
    entities: snapshot.entityCount,
    indexBytes,
    futureLogBytes,
  });
}

/** Inspect projection safety and pair coherence without creating or repairing files. */
export async function auditBujoProjections(
  root: SecureRoot,
): Promise<MemoryLocalProjectionAudit> {
  await verifySecureRoot(root);
  const index = await auditProjection(
    join(root.path, MEMORY_LOCAL_INDEX_FILENAME),
    (content) => content.startsWith("# Index\n"),
  );
  const futureLog = await auditProjection(
    join(root.path, MEMORY_LOCAL_FUTURE_LOG_FILENAME),
    (content) => content === "# Future Log\n",
  );
  await verifySecureRoot(root);
  return Object.freeze({
    index,
    futureLog,
    complete: index === "ready" && futureLog === "ready",
    coherent: (index === "ready" && futureLog === "ready")
      || (index === "missing" && futureLog === "missing"),
  });
}

function readSnapshot(database: DatabaseSync): {
  readonly recordCount: number;
  readonly entityCount: number;
  readonly duplicateGroups: number;
  readonly topMemories: readonly { readonly id: string; readonly text: string }[];
  readonly entities: readonly EntityProjection[];
} {
  const recordCount = safeCount(database, "memories");
  const entityCount = safeCount(database, "entities");
  const duplicateRows = database.prepare(`
    SELECT text
    FROM memories
    WHERE status NOT IN ('invalidated','dropped')
    ORDER BY seq ASC
    LIMIT ?
  `).all(MAX_DUPLICATE_SCAN + 1) as unknown as { text: unknown }[];
  if (duplicateRows.length > MAX_DUPLICATE_SCAN) {
    throw new MemoryLocalError(
      "maintenance_failed",
      "Memory consolidation input exceeds its fixed record scan bound.",
    );
  }
  const duplicateCounts = new Map<string, number>();
  for (const row of duplicateRows) {
    const text = storedString(row.text);
    const key = normalizeFactText(text);
    if (key.length > 0) duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }

  const topMemories = database.prepare(`
    SELECT id, text
    FROM memories
    WHERE status NOT IN ('invalidated','dropped')
    ORDER BY salience DESC, created_at DESC, id ASC
    LIMIT ?
  `).all(TOP_MEMORY_LIMIT) as unknown as { id: unknown; text: unknown }[];
  const entityRows = database.prepare(`
    SELECT id, name, type
    FROM entities
    ORDER BY name ASC, id ASC
    LIMIT ?
  `).all(MAX_ENTITY_SCAN) as unknown as {
    id: unknown;
    name: unknown;
    type: unknown;
  }[];

  return Object.freeze({
    recordCount,
    entityCount,
    duplicateGroups: [...duplicateCounts.values()].filter((count) => count > 1).length,
    topMemories: Object.freeze(topMemories.map((row) => Object.freeze({
      id: storedString(row.id),
      text: storedString(row.text),
    }))),
    entities: collectEntityPreview(entityRows),
  });
}

function renderIndex(snapshot: ReturnType<typeof readSnapshot>): string {
  const topMemories = snapshot.topMemories.map(({ id, text }) =>
    `- ${boundedInline(text, MAX_PROJECTED_TEXT_BYTES)}  ^${boundedInline(id, MAX_PROJECTED_LABEL_BYTES)}`);
  const entities = snapshot.entities.map((entity) => {
    const name = boundedInline(entity.name, MAX_PROJECTED_LABEL_BYTES);
    return entity.type === undefined
      ? `- ${name}`
      : `- ${name} (${boundedInline(entity.type, MAX_PROJECTED_LABEL_BYTES)})`;
  });
  return [
    "# Index",
    "",
    "## Overview",
    "",
    `- Memories: ${snapshot.recordCount}`,
    `- Entities: ${snapshot.entityCount}`,
    "",
    "## Top memories",
    "",
    ...topMemories,
    "",
    "## Entities",
    "",
    ...entities,
    "",
  ].join("\n");
}

function collectEntityPreview(
  rows: readonly { readonly id: unknown; readonly name: unknown; readonly type: unknown }[],
): readonly EntityProjection[] {
  const groups = new Map<string, EntityGroup>();
  for (const row of rows) {
    const entity = Object.freeze({
      id: storedString(row.id),
      name: storedString(row.name),
      ...(row.type === null ? {} : { type: storedString(row.type) }),
    });
    const type = normalizedEntityType(entity.type);
    if (type !== undefined && LOW_VALUE_ENTITY_TYPES.has(type)) continue;
    const key = normalizedReferent(entity.name);
    if (key.length === 0) continue;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        representative: entity,
        ...(type === undefined ? {} : { type }),
        typeConflict: false,
      });
      continue;
    }
    if (compareRepresentatives(entity, group.representative) < 0) {
      group.representative = entity;
    }
    if (type !== undefined) {
      if (group.type === undefined) group.type = type;
      else if (group.type !== type) group.typeConflict = true;
    }
  }
  return Object.freeze([...groups.values()]
    .map((group): EntityProjection => Object.freeze({
      id: group.representative.id,
      name: group.representative.name,
      ...(group.typeConflict ? {} : { type: group.type ?? "unknown" }),
    }))
    .sort((left, right) => compareStrings(left.name, right.name) || compareStrings(left.id, right.id))
    .slice(0, INDEX_ENTITY_LIMIT));
}

async function observeTarget(path: string): Promise<ProjectionTarget> {
  if (!(await pathExists(path))) return Object.freeze({ path });
  return Object.freeze({ path, expected: await inspectSecureFile(path) });
}

async function auditProjection(
  path: string,
  validate: (content: string) => boolean,
): Promise<MemoryLocalProjectionStatus> {
  try {
    if (!(await pathExists(path))) return "missing";
    const identity = await inspectSecureFile(path);
    if (identity.size > MAX_PROJECTION_BYTES) return "invalid";
    const read = await readSecureFile(path, MAX_PROJECTION_BYTES);
    if (!sameFileIdentity(identity, read.identity)) return "unsafe";
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return "invalid";
    }
    return validate(content) ? "ready" : "invalid";
  } catch {
    return "unsafe";
  }
}

async function verifyTarget(target: ProjectionTarget): Promise<void> {
  if (target.expected === undefined) {
    if (await pathExists(target.path)) {
      throw new MemoryLocalError(
        "unsafe_store",
        "A memory consolidation projection target appeared before publication.",
      );
    }
    return;
  }
  const current = await inspectSecureFile(target.path);
  if (!sameFileIdentity(target.expected, current)) {
    throw new MemoryLocalError(
      "unsafe_store",
      "A memory consolidation projection target changed before publication.",
    );
  }
}

async function stageProjection(
  root: SecureRoot,
  label: string,
  content: string,
): Promise<ProjectionTarget> {
  const path = join(root.path, `.memory-local-${label}-${randomUUID()}.tmp`);
  const handle = await createSecureFile(path);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    return Object.freeze({ path, expected: await inspectSecureFile(path) });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function verifyPublishedTarget(path: string, expected: FileIdentity): Promise<void> {
  const current = await inspectSecureFile(path);
  if (!sameFileIdentity(expected, current)) {
    throw new MemoryLocalError(
      "unsafe_store",
      "A memory consolidation projection changed during publication.",
    );
  }
}

function safeCount(database: DatabaseSync, table: "memories" | "entities"): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as {
    count: unknown;
  };
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new MemoryLocalError("corrupt_store", "Memory consolidation found an invalid row count.");
  }
  return count;
}

function storedString(value: unknown): string {
  if (typeof value !== "string") {
    throw new MemoryLocalError("corrupt_store", "Memory consolidation found an invalid stored string.");
  }
  return value;
}

function normalizeFactText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function normalizedReferent(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{Z}\p{Dash_Punctuation}_]+/gu, " ")
    .trim();
}

function normalizedEntityType(type: string | undefined): string | undefined {
  const normalized = type?.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function compareRepresentatives(left: EntityProjection, right: EntityProjection): number {
  const byLength = [...left.name].length - [...right.name].length;
  return byLength || compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInline(value: string, maxBytes: number): string {
  const inline = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const bytes = Buffer.from(inline, "utf8");
  if (bytes.byteLength <= maxBytes) return inline;
  const clipped = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes - 3))
    .replace(/\uFFFD$/u, "");
  return `${clipped}…`;
}

/** @internal Test-only seam; not exported by the package entrypoint. */
export function boundedInlineForTesting(value: string, maxBytes: number): string {
  return boundedInline(value, maxBytes);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
