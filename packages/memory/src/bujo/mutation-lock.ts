import { AsyncLocalStorage } from "node:async_hooks";

import type { MemoryDb } from "../store/index.js";
import type { CanonicalGraphRepairGuard } from "./graph.js";

import {
  hasMutablePendingCaptureIntent,
  hasPendingCaptureIntent,
  replayCaptureOutbox,
} from "./capture-outbox.js";
import { canonicalMemoryRoot, readManagedIndexManifest } from "./generations.js";
import {
  assertNoPendingMigrateDecision,
  hasPendingMigrateDecision,
  recoverPendingMigrateDecisionWithMetadata,
  type MigrateAction,
} from "./migrate.js";
import type { BujoTier } from "./types.js";
import {
  REPLAY_PROJECTION_FILE,
  assertReplayProjectionMatchesDb,
  initializeReplayProjection,
  readReplayProjectionStrict,
  replayProjectionDbSnapshot,
} from "./replay-projection.js";

interface MutationContext {
  readonly roots: ReadonlyMap<string, MutationLease>;
}

interface MutationLease {
  active: boolean;
  recovery: DurableMutationRecovery;
}

/** Provider-free durable work completed before a newly admitted mutation runs. */
export interface DurableMutationRecovery {
  readonly migrationAction?: MigrateAction;
  readonly captureReplayed: number;
}

export interface SerializedBujoMutation {
  readonly root: string;
  readonly db: MemoryDb;
  readonly tier?: BujoTier;
  readonly abortSignal?: AbortSignal;
  readonly canonicalGraphRepairGuard?: CanonicalGraphRepairGuard;
}

const MUTATION_CONTEXT = new AsyncLocalStorage<MutationContext>();
const MUTATION_CHAINS = new Map<string, Promise<void>>();

/**
 * Serialize every stateful operation for one canonical memory root. The lock
 * spans provider-backed planning and the complete durable replay boundary, so
 * a second caller can only plan against the first caller's committed result.
 *
 * Capture is intentionally nested (captureTurn -> reconcileBatch). An async
 * context token makes that nesting reentrant while callers from another turn,
 * store queue, or exported surface still wait in FIFO order.
 */
export async function withSerializedBujoMutation<T>(
  options: SerializedBujoMutation,
  run: (recovery: DurableMutationRecovery) => Promise<T>,
): Promise<T> {
  options.abortSignal?.throwIfAborted();
  const root = canonicalMemoryRoot(options.root, true);
  const active = MUTATION_CONTEXT.getStore();
  const activeLease = active?.roots.get(root);
  if (activeLease?.active === true) {
    options.abortSignal?.throwIfAborted();
    return await run(activeLease.recovery);
  }

  const predecessor = MUTATION_CHAINS.get(root) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.then(() => mine);
  MUTATION_CHAINS.set(root, tail);

  try {
    await waitForPredecessor(predecessor, options.abortSignal);
    options.abortSignal?.throwIfAborted();
    const lease: MutationLease = { active: true, recovery: { captureReplayed: 0 } };
    const roots = new Map(active?.roots ?? []);
    roots.set(root, lease);
    return await MUTATION_CONTEXT.run({ roots }, async () => {
      try {
        lease.recovery = recoverDurableMutationState(
          root,
          options.db,
          options.tier ?? "bujo",
          options.canonicalGraphRepairGuard,
        );
        options.abortSignal?.throwIfAborted();
        return await run(lease.recovery);
      } finally {
        // AsyncLocalStorage is inherited by detached queue timers. Expire the
        // token before releasing the root so those later jobs cannot mistake
        // ancestry for live, awaited reentrancy and bypass serialization.
        lease.active = false;
      }
    });
  } finally {
    release();
    void tail.then(() => {
      if (MUTATION_CHAINS.get(root) === tail) MUTATION_CHAINS.delete(root);
    });
  }
}

/** Recover already-paid state in its one valid order before new planning. */
export function recoverDurableMutationState(
  root: string,
  db: MemoryDb,
  tier: BujoTier,
  canonicalGraphRepairGuard?: CanonicalGraphRepairGuard,
): DurableMutationRecovery {
  const authorityBefore = tier === "bujo" ? readReplayProjectionStrict(root) : undefined;
  const managedBefore = tier === "bujo" ? readManagedIndexManifest(root) : undefined;
  const missingManagedAuthorityBefore = authorityBefore?.state.kind === "missing" && managedBefore !== undefined;
  const dbReplayBefore = authorityBefore?.state.kind === "missing" ? replayProjectionDbSnapshot(db) : undefined;
  // Older processes could publish these independent protocols concurrently.
  // Neither protocol carries a shared sequence, so mutating either one first
  // can make the other unreplayable. Detect the dual-pending state entirely
  // through bounded, non-mutating probes and require operator repair.
  const captureQueued = hasPendingCaptureIntent(root);
  const capturePending = hasMutablePendingCaptureIntent(root);
  const migrationPending = tier === "bujo" ? hasPendingMigrateDecision(root) : false;
  if (capturePending && migrationPending) {
    throw new Error(
      "memory-bujo: capture and migration durable state are both pending; "
      + "refusing unordered recovery before any mutation.",
    );
  }
  if (authorityBefore?.state.kind === "missing" && dbReplayBefore !== undefined
    && hasReplayProjectionState(dbReplayBefore) && !captureQueued && !migrationPending) {
    throw new Error(
      `memory-bujo: ${REPLAY_PROJECTION_FILE} is missing while SQLite contains historical replay state; `
      + "no durable mutation explains it. Run explicit stopped-store adoption.",
    );
  }
  if (authorityBefore?.state.kind === "missing" && managedBefore === undefined
    && !captureQueued && !migrationPending) {
    // A fresh/unmanaged empty DB has no historical replay state or manifest
    // source identity to bless. Establish the empty authority only after the
    // dual-protocol non-mutating probe; managed upgrades use safe rebuild.
    initializeReplayProjection(root);
  }
  const migration = tier === "bujo"
    ? recoverPendingMigrateDecisionWithMetadata(root, db, canonicalGraphRepairGuard)
    : (assertNoPendingMigrateDecision(root), undefined);
  // Lite and Journal never create capture intents. Avoid the empty-outbox
  // compatibility check, whose missing-sidecar guard materializes the full DB.
  const captureReplayed = tier !== "bujo" && !captureQueued
    ? 0
    : replayCaptureOutbox(root, db, {
      ...(canonicalGraphRepairGuard === undefined ? {} : { canonicalGraphRepairGuard }),
    }).length;
  if (missingManagedAuthorityBefore) {
    throw new Error(
      `memory-bujo: managed index was missing ${REPLAY_PROJECTION_FILE}; durable recovery completed but `
      + "the managed source fingerprint is stale. Stop the store and run safe rebuild before restart.",
    );
  }
  if (tier === "bujo") {
    const replay = readReplayProjectionStrict(root);
    if (replay.state.kind === "missing") {
      throw new Error(
        `memory-bujo: ${REPLAY_PROJECTION_FILE} is missing after durable recovery; `
        + "unattested replay-owned SQLite state is not accepted.",
      );
    }
    assertReplayProjectionMatchesDb(db, replay.projection);
  } else if (db.hasReplayProjectionState()) {
    throw new Error(`memory-bujo: ${tier} rejects BuJo replay-owned lifecycle and edges.`);
  }
  return {
    ...(migration === undefined ? {} : { migrationAction: migration.action }),
    captureReplayed,
  };
}

function hasReplayProjectionState(
  replay: ReturnType<typeof replayProjectionDbSnapshot>,
): boolean {
  return replay.terminals.length > 0 || replay.supersedes.length > 0 || replay.threads.length > 0;
}

async function waitForPredecessor(
  predecessor: Promise<void>,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (abortSignal === undefined) {
    await predecessor;
    return;
  }
  abortSignal.throwIfAborted();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(abortSignal.reason);
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([predecessor, aborted]);
    abortSignal.throwIfAborted();
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}
