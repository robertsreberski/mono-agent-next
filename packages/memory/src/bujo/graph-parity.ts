import type {
  CanonicalGraphSnapshot,
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
} from "../store/index.js";

import { hasPendingCaptureIntent } from "./capture-outbox.js";
import {
  CanonicalGraphValidationError,
  type CanonicalGraphIssueCode,
} from "./graph.js";
import { hasPendingMigrateDecision } from "./migrate.js";
import {
  readCanonicalGraphAuditSourceSnapshot,
  type CanonicalGraphAuditSourceSnapshot,
} from "./rebuild.js";
import { CanonicalFileRetiredError } from "./path-safety.js";
import type { BujoTier } from "./types.js";

const MAX_AUDIT_ATTEMPTS = 3;

/** Aggregate-only parity counters. No memory or entity content is returned. */
export interface CanonicalGraphParitySection {
  readonly canonical: number;
  readonly active: number;
  readonly matched: number;
  readonly missing: number;
  readonly extra: number;
  readonly mismatched: number;
  readonly payloadMismatches: number;
  readonly timestampMismatches: number;
  readonly provenanceMismatches: number;
}

export type CanonicalGraphParityStatus = "match" | "mismatch" | "in_progress" | "invalid";

export type CanonicalGraphParityIssueCode = CanonicalGraphIssueCode
  | "canonical-read-failed"
  | "durable-state-invalid"
  | "active-index-invalid"
  | "tier-conflict";

export interface CanonicalGraphParityIssue {
  readonly code: CanonicalGraphParityIssueCode;
  readonly line?: number;
}

export interface CanonicalGraphMutationState {
  readonly capturePending: boolean;
  readonly migrationPending: boolean;
  readonly sourceChanged: boolean;
}

export interface CanonicalGraphParityOptions {
  /** Explicit tier for an unmanaged index; managed metadata must agree when both are present. */
  readonly tier?: BujoTier;
}

/** Exact tier-aware canonical graph projection versus active SQLite parity. */
export interface CanonicalGraphParityResult {
  readonly status: CanonicalGraphParityStatus;
  readonly tier: BujoTier;
  readonly matches: boolean;
  readonly issues: readonly CanonicalGraphParityIssue[];
  readonly mutation: CanonicalGraphMutationState;
  readonly entities: CanonicalGraphParitySection;
  readonly relations: CanonicalGraphParitySection;
  readonly associations: CanonicalGraphParitySection;
  readonly supports: CanonicalGraphParitySection;
}

/**
 * Compare the active tier's canonical graph projection with an already-open index.
 *
 * The audit is provider-free and content-free. It fails closed on invalid
 * canonical graph records, distinguishes admitted durable mutation from stable
 * divergence, and retries one torn source/index observation before reporting.
 */
export function auditCanonicalGraphParity(
  root: string,
  db: MemoryDb,
  options: CanonicalGraphParityOptions = {},
): CanonicalGraphParityResult {
  let tier = options.tier ?? "bujo";

  for (let attempt = 1; attempt <= MAX_AUDIT_ATTEMPTS; attempt += 1) {
    const mutationBefore = inspectCanonicalGraphMutation(root);
    if (mutationBefore.issue !== undefined) return invalidResult(tier, mutationBefore.issue);
    if (mutationInProgress(mutationBefore.state)) return inProgressResult(tier, mutationBefore.state);

    let activeProbe: CanonicalGraphSnapshot;
    try {
      activeProbe = db.canonicalGraphSnapshot();
    } catch {
      return invalidResult(tier, { code: "active-index-invalid" });
    }

    const resolvedTier = resolveTier(activeProbe, options);
    tier = resolvedTier.tier;
    if (resolvedTier.issue !== undefined) {
      return invalidResult(tier, resolvedTier.issue);
    }

    let canonicalBefore: CanonicalGraphAuditSourceSnapshot;
    try {
      canonicalBefore = readCanonicalGraphAuditSourceSnapshot(root, tier);
    } catch (error) {
      const transient = inspectCanonicalGraphMutation(root);
      if (transient.issue !== undefined) return invalidResult(tier, transient.issue);
      if (mutationInProgress(transient.state)) return inProgressResult(tier, transient.state);
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return invalidResult(tier, issueFromCanonicalError(error));
    }

    let active: CanonicalGraphSnapshot;
    try {
      active = db.canonicalGraphSnapshot();
    } catch {
      return invalidResult(tier, { code: "active-index-invalid" });
    }
    const activeTier = resolveTier(active, options);
    if (activeTier.issue !== undefined) {
      return invalidResult(activeTier.tier, activeTier.issue);
    }
    if (activeTier.tier !== tier) {
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return inProgressResult(activeTier.tier, { ...noMutation(), sourceChanged: true });
    }

    let canonicalAfter: CanonicalGraphAuditSourceSnapshot;
    try {
      canonicalAfter = readCanonicalGraphAuditSourceSnapshot(root, tier);
    } catch (error) {
      const transient = inspectCanonicalGraphMutation(root);
      if (transient.issue !== undefined) return invalidResult(tier, transient.issue);
      if (mutationInProgress(transient.state)) return inProgressResult(tier, transient.state);
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return invalidResult(tier, issueFromCanonicalError(error));
    }

    const mutationAfter = inspectCanonicalGraphMutation(root);
    if (mutationAfter.issue !== undefined) return invalidResult(tier, mutationAfter.issue);
    if (mutationInProgress(mutationAfter.state)) return inProgressResult(tier, mutationAfter.state);
    if (canonicalBefore.fingerprint !== canonicalAfter.fingerprint) {
      if (attempt < MAX_AUDIT_ATTEMPTS) continue;
      return inProgressResult(tier, { ...mutationAfter.state, sourceChanged: true });
    }

    const expected = canonicalAfter.graph;

    const entities = compareEntities(expected.entities, active.entities);
    const relations = compareRelations(expected.relations, active.relations);
    const associations = compareAssociations(expected.associations, active.associations);
    const supports = compareSupports(expected.collectionSupports, active);
    const matches = sectionMatches(entities)
      && sectionMatches(relations)
      && sectionMatches(associations)
      && sectionMatches(supports);
    if (!matches && attempt < MAX_AUDIT_ATTEMPTS) continue;
    return {
      status: matches ? "match" : "mismatch",
      tier,
      matches,
      issues: [],
      mutation: noMutation(),
      entities,
      relations,
      associations,
      supports,
    };
  }

  return inProgressResult(tier, { ...noMutation(), sourceChanged: true });
}

interface MutationInspection {
  readonly state: CanonicalGraphMutationState;
  readonly issue?: CanonicalGraphParityIssue;
}

/** Internal injection seam for deterministic retirement-race verification. */
export interface CanonicalGraphMutationProbes {
  readonly capturePending: (root: string) => boolean;
  readonly migrationPending: (root: string) => boolean;
}

const DEFAULT_MUTATION_PROBES: CanonicalGraphMutationProbes = {
  capturePending: hasPendingCaptureIntent,
  migrationPending: hasPendingMigrateDecision,
};

export function inspectCanonicalGraphMutation(
  root: string,
  probes: CanonicalGraphMutationProbes = DEFAULT_MUTATION_PROBES,
): MutationInspection {
  try {
    return {
      state: {
        capturePending: probes.capturePending(root),
        migrationPending: probes.migrationPending(root),
        sourceChanged: false,
      },
    };
  } catch (error) {
    if (isTransientMutationReadError(error)) {
      return { state: { ...noMutation(), sourceChanged: true } };
    }
    return { state: noMutation(), issue: { code: "durable-state-invalid" } };
  }
}

function resolveTier(
  active: CanonicalGraphSnapshot,
  options: CanonicalGraphParityOptions,
): { readonly tier: BujoTier; readonly issue?: CanonicalGraphParityIssue } {
  const managedTier = active.metadata?.tier;
  if (managedTier !== undefined && options.tier !== undefined && managedTier !== options.tier) {
    return { tier: managedTier, issue: { code: "tier-conflict" } };
  }
  return { tier: managedTier ?? options.tier ?? "bujo" };
}

function invalidResult(tier: BujoTier, issue: CanonicalGraphParityIssue): CanonicalGraphParityResult {
  return {
    status: "invalid",
    tier,
    matches: false,
    issues: [issue],
    mutation: noMutation(),
    entities: emptySection(),
    relations: emptySection(),
    associations: emptySection(),
    supports: emptySection(),
  };
}

function inProgressResult(tier: BujoTier, mutation: CanonicalGraphMutationState): CanonicalGraphParityResult {
  return {
    status: "in_progress",
    tier,
    matches: false,
    issues: [],
    mutation,
    entities: emptySection(),
    relations: emptySection(),
    associations: emptySection(),
    supports: emptySection(),
  };
}

function issueFromCanonicalError(error: unknown): CanonicalGraphParityIssue {
  if (error instanceof CanonicalGraphValidationError) {
    return {
      code: error.code,
      ...(error.line === undefined ? {} : { line: error.line }),
    };
  }
  return { code: "canonical-read-failed" };
}

function mutationInProgress(state: CanonicalGraphMutationState): boolean {
  return state.capturePending || state.migrationPending || state.sourceChanged;
}

function noMutation(): CanonicalGraphMutationState {
  return { capturePending: false, migrationPending: false, sourceChanged: false };
}

function emptySection(): CanonicalGraphParitySection {
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

function compareEntities(
  canonical: readonly EntityRecord[],
  active: readonly EntityRecord[],
): CanonicalGraphParitySection {
  return compareByKey(canonical, active, (record) => record.id, (left, right) => ({
    payload: left.name !== right.name || left.type !== right.type || left.summary !== right.summary,
    timestamp: left.createdAt !== right.createdAt || left.updatedAt !== right.updatedAt,
    provenance: false,
  }));
}

function compareRelations(
  canonical: readonly EntityRelationRecord[],
  active: readonly EntityRelationRecord[],
): CanonicalGraphParitySection {
  return compareByKey(canonical, active, relationKey, (left, right) => ({
    payload: left.src !== right.src || left.dst !== right.dst || left.relation !== right.relation,
    timestamp: left.createdAt !== right.createdAt,
    provenance: false,
  }));
}

function compareAssociations(
  canonical: readonly MemoryEntityAssociation[],
  active: readonly MemoryEntityAssociation[],
): CanonicalGraphParitySection {
  return compareByKey(canonical, active, associationKey, (left, right) => ({
    payload: left.memoryId !== right.memoryId || left.entityId !== right.entityId,
    timestamp: left.createdAt !== right.createdAt,
    provenance: left.provenance !== right.provenance,
  }));
}

interface CollectionSupportRecord {
  readonly memoryId: string;
  readonly entityId: string;
  readonly collection?: string;
  readonly weight?: number;
  readonly collectionOnly?: boolean;
}

function compareSupports(
  canonical: readonly { readonly memoryId: string; readonly entityId: string; readonly collection: string }[],
  active: CanonicalGraphSnapshot,
): CanonicalGraphParitySection {
  const memories = new Map(active.memories.map((memory) => [memory.id, memory]));
  const canonicalRecords: CollectionSupportRecord[] = canonical.map((record) => ({
    ...record,
    weight: 1,
  }));
  const activeRecords: CollectionSupportRecord[] = active.supports.map((edge) => ({
    memoryId: edge.src,
    entityId: edge.dst,
    weight: edge.weight,
    ...(memories.get(edge.src)?.collection === undefined
      ? {}
      : { collection: memories.get(edge.src)!.collection }),
  }));
  const memoriesWithSupportEdges = new Set(active.supports.map((edge) => edge.src));
  for (const memory of active.memories) {
    if (memory.collection !== undefined && !memoriesWithSupportEdges.has(memory.id)) {
      activeRecords.push({
        memoryId: memory.id,
        entityId: "",
        collection: memory.collection,
        collectionOnly: true,
      });
    }
  }
  return compareByKey<CollectionSupportRecord>(
    canonicalRecords,
    activeRecords,
    supportKey,
    (left, right) => ({
      payload: left.memoryId !== right.memoryId
        || left.entityId !== right.entityId
        || left.collection !== right.collection
        || left.weight !== right.weight,
      timestamp: false,
      provenance: false,
    }),
  );
}

interface RecordMismatch {
  readonly payload: boolean;
  readonly timestamp: boolean;
  readonly provenance: boolean;
}

function compareByKey<T>(
  canonicalRecords: readonly T[],
  activeRecords: readonly T[],
  keyOf: (record: T) => string,
  mismatchOf: (canonical: T, active: T) => RecordMismatch,
): CanonicalGraphParitySection {
  const canonical = new Map(canonicalRecords.map((record) => [keyOf(record), record]));
  const active = new Map(activeRecords.map((record) => [keyOf(record), record]));
  let matched = 0;
  let missing = 0;
  let mismatched = 0;
  let payloadMismatches = 0;
  let timestampMismatches = 0;
  let provenanceMismatches = 0;
  for (const [key, expected] of canonical) {
    const actual = active.get(key);
    if (actual === undefined) {
      missing += 1;
      continue;
    }
    const mismatch = mismatchOf(expected, actual);
    if (!mismatch.payload && !mismatch.timestamp && !mismatch.provenance) {
      matched += 1;
      continue;
    }
    mismatched += 1;
    if (mismatch.payload) payloadMismatches += 1;
    if (mismatch.timestamp) timestampMismatches += 1;
    if (mismatch.provenance) provenanceMismatches += 1;
  }
  let extra = 0;
  for (const key of active.keys()) {
    if (!canonical.has(key)) extra += 1;
  }
  return {
    canonical: canonical.size,
    active: active.size,
    matched,
    missing,
    extra,
    mismatched,
    payloadMismatches,
    timestampMismatches,
    provenanceMismatches,
  };
}

function sectionMatches(section: CanonicalGraphParitySection): boolean {
  return section.missing === 0 && section.extra === 0 && section.mismatched === 0;
}

function relationKey(record: EntityRelationRecord): string {
  return JSON.stringify([record.src, record.dst, record.relation]);
}

function associationKey(record: MemoryEntityAssociation): string {
  return JSON.stringify([record.memoryId, record.entityId]);
}

function supportKey(record: CollectionSupportRecord): string {
  return record.collectionOnly === true
    ? JSON.stringify(["collection-only", record.memoryId])
    : JSON.stringify(["support", record.memoryId, record.entityId]);
}

function isTransientMutationReadError(error: unknown): boolean {
  if (error instanceof CanonicalFileRetiredError) return true;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : "";
  return /(?:disappeared|changed while it was read|changed during file access|was replaced during access)/iu.test(message);
}
