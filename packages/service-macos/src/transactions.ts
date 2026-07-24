import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  rename,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";

import { ServiceMacosDriftError } from "./errors.js";
import { isErrno } from "./internal-fs.js";
import {
  isKnownDesired,
  journalFiles,
  journalTargetLabel,
  matchesDesired,
  requireJournalFile,
  sameExactFile,
  sameFileObject,
  sameRenamedFile,
  type TransactionJournal,
} from "./journal-guards.js";
import {
  readRecoverableJournal,
  updateJournal,
} from "./journal-storage.js";
import { observeOwnerPrivatePlist } from "./plist-observation.js";
import type { ServiceMacosTarget } from "./plist.js";
import type { ServiceFileObservation } from "./service-types.js";
import {
  acquireTransactionLock,
  assertOwnedTransactionDirectory,
  assertTransactionParent,
  bindTransactionRoot,
  fsyncDirectory,
  mutateWithStableParent,
  pathExists,
  restoreNoClobber,
  transactionGuard,
  transactionPaths,
  type TransactionGuard,
  type TransactionPaths,
  unlinkInternal,
  writeExclusiveFile,
} from "./transaction-fs.js";
import {
  isSimulatedServiceMacosCrash,
  runServiceMacosTransactionTestHook,
} from "./transaction-test-hooks.js";

const TRANSACTION_SCHEMA_VERSION = 1;
export interface ServiceMacosTransactionLifecycle {
  readonly preflight: () => Promise<void>;
  readonly inspectLoaded: () => Promise<boolean>; readonly bootoutRequired: () => Promise<void>;
  readonly bootoutIfPresent: () => Promise<void>; readonly bootstrap: () => Promise<void>;
  readonly bootstrapRestored: () => Promise<void>;
  readonly proveReady: (readinessToken: string) => Promise<void>; readonly proveInstalledReady: () => Promise<void>;
}
export interface ReplaceServicePlistTransaction {
  readonly target: ServiceMacosTarget; readonly expectedUid: number; readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean; readonly desiredPlist: string; readonly desiredDigest: string;
  readonly readinessToken: string; readonly expectedParentIdentity: string;
  readonly lifecycle: ServiceMacosTransactionLifecycle;
}
export interface RemoveServicePlistTransaction {
  readonly target: ServiceMacosTarget; readonly expectedUid: number; readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean; readonly expectedParentIdentity: string;
  readonly lifecycle: ServiceMacosTransactionLifecycle;
}
class NoClobberOccupiedError extends ServiceMacosDriftError {}
export async function assertNoPendingServiceMacosTransaction(
  target: ServiceMacosTarget, expectedUid: number, expectedParentIdentity: string,
): Promise<void> {
  const paths = transactionPaths(target);
  const guard = transactionGuard(paths, expectedUid, expectedParentIdentity);
  await assertTransactionParent(guard);
  if (await pathExists(paths.root) || await pathExists(paths.lock)) {
    if (await pathExists(paths.root)) await assertOwnedTransactionDirectory(paths.root, expectedUid);
    if (await pathExists(paths.lock)) await observeOwnerPrivatePlist(paths.lock, expectedUid, { allowTwoLinks: true });
    throw new ServiceMacosDriftError(`Unresolved service transaction exists for ${target.serviceId}; rerun apply or remove with explicit mutation authorization to recover it.`);
  }
  await assertTransactionParent(guard);
}
export async function recoverPendingServiceMacosTransaction(
  target: ServiceMacosTarget, expectedUid: number, expectedParentIdentity: string,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const paths = transactionPaths(target);
  const guard = transactionGuard(paths, expectedUid, expectedParentIdentity);
  await assertTransactionParent(guard);
  if (!await pathExists(paths.root) && !await pathExists(paths.lock)) {
    await assertTransactionParent(guard);
    return;
  }
  const release = await acquireTransactionLock(paths, guard);
  try {
    if (!await pathExists(paths.root)) return;
    await assertOwnedTransactionDirectory(paths.root, expectedUid);
    await bindTransactionRoot(guard, paths.root);
    if ((await readdir(paths.root)).length === 0) {
      await mutateWithStableParent(guard, async () => await rmdir(paths.root), true);
      await fsyncDirectory(paths.parent);
      return;
    }
    const journal = await readRecoverableJournal(paths, target, guard);
    if (journal.phase === "committed") {
      try {
        await finishCommittedTransaction(paths, journal, guard, lifecycle);
      } catch (error) {
        try {
          await rollbackTransaction(paths, journal, target, guard, lifecycle);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Committed transaction cleanup and rollback both failed for ${target.serviceId}.`,
          );
        }
        throw error;
      }
      return;
    }
    await rollbackTransaction(paths, journal, target, guard, lifecycle);
  } finally {
    await release();
  }
}
export async function replaceServicePlistTransaction(input: ReplaceServicePlistTransaction): Promise<void> {
  const paths = transactionPaths(input.target);
  const guard = transactionGuard(paths, input.expectedUid, input.expectedParentIdentity);
  const release = await acquireTransactionLock(paths, guard);
  let journal: TransactionJournal | undefined;
  try {
    if (await pathExists(paths.root)) {
      throw new ServiceMacosDriftError(`Unresolved service transaction exists for ${input.target.serviceId}.`);
    }
    journal = await createTransaction(paths, {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      transactionId: randomUUID(),
      serviceId: input.target.serviceId,
      operation: "apply",
      phase: "prepared",
      expectedFile: input.expectedFile,
      expectedLoaded: input.expectedLoaded,
      desired: Object.freeze({
        digest: input.desiredDigest,
        bytes: Buffer.byteLength(input.desiredPlist),
        readinessToken: input.readinessToken,
      }),
    }, guard);
    await runServiceMacosTransactionTestHook("after-journal-prepared");
    await writeDesiredStage(paths, input.desiredPlist, journal.desired!, guard);
    if (input.expectedFile.exists) {
      journal = await quarantineExpectedPrior(paths, journal, input.target, guard);
    }
    journal = await publishDesired(paths, journal, input.target, guard);
    if (input.expectedLoaded) await input.lifecycle.bootoutRequired();
    await input.lifecycle.bootstrap();
    const activated = await observeOwnerPrivatePlist(input.target.plistPath, input.expectedUid);
    if (!isKnownDesired(journal, activated, Object.freeze({ exists: false }))) {
      throw new ServiceMacosDriftError(
        `Activation did not retain the published plist for ${input.target.serviceId}.`,
      );
    }
    await input.lifecycle.proveReady(input.readinessToken);
    journal = await updateJournal(paths, journal, Object.freeze({ ...journal, phase: "committed" }), guard);
    await runServiceMacosTransactionTestHook("after-transaction-committed");
    await finishCommittedTransaction(paths, journal, guard, input.lifecycle);
  } catch (error) {
    if (isSimulatedServiceMacosCrash(error)) throw error;
    const rollbackFailures: unknown[] = [];
    if (journal !== undefined && await pathExists(paths.root)) {
      try {
        await runServiceMacosTransactionTestHook("before-rollback");
        await rollbackTransaction(
          paths,
          await readRecoverableJournal(paths, input.target, guard),
          input.target,
          guard,
          input.lifecycle,
        );
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `Activation and transaction rollback both failed for ${input.target.serviceId}.`,
      );
    }
    throw error;
  } finally {
    await release();
  }
}
export async function removeServicePlistTransaction(input: RemoveServicePlistTransaction): Promise<void> {
  const paths = transactionPaths(input.target);
  const guard = transactionGuard(paths, input.expectedUid, input.expectedParentIdentity);
  const release = await acquireTransactionLock(paths, guard);
  let journal: TransactionJournal | undefined;
  try {
    if (await pathExists(paths.root)) {
      throw new ServiceMacosDriftError(`Unresolved service transaction exists for ${input.target.serviceId}.`);
    }
    journal = await createTransaction(paths, {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      transactionId: randomUUID(),
      serviceId: input.target.serviceId,
      operation: "remove",
      phase: "prepared",
      expectedFile: input.expectedFile,
      expectedLoaded: input.expectedLoaded,
    }, guard);
    await runServiceMacosTransactionTestHook("after-journal-prepared");
    if (input.expectedFile.exists) {
      journal = await quarantineExpectedPrior(paths, journal, input.target, guard);
    }
    if (input.expectedLoaded) await input.lifecycle.bootoutRequired();
    if (await input.lifecycle.inspectLoaded()) {
      throw new ServiceMacosDriftError(`launchd still reports ${input.target.serviceId} loaded after bootout.`);
    }
    const canonical = await observeOwnerPrivatePlist(input.target.plistPath, input.expectedUid);
    if (canonical.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared while removing ${input.target.serviceId}; it was preserved.`,
      );
    }
    journal = await updateJournal(paths, journal, Object.freeze({ ...journal, phase: "committed" }), guard);
    await runServiceMacosTransactionTestHook("after-transaction-committed");
    await finishCommittedTransaction(paths, journal, guard, input.lifecycle);
  } catch (error) {
    if (isSimulatedServiceMacosCrash(error)) throw error;
    const rollbackFailures: unknown[] = [];
    if (journal !== undefined && await pathExists(paths.root)) {
      try {
        await runServiceMacosTransactionTestHook("before-rollback");
        await rollbackTransaction(
          paths,
          await readRecoverableJournal(paths, input.target, guard),
          input.target,
          guard,
          input.lifecycle,
        );
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `Removal and transaction rollback both failed for ${input.target.serviceId}.`,
      );
    }
    throw error;
  } finally {
    await release();
  }
}
async function createTransaction(
  paths: TransactionPaths, journal: TransactionJournal, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  await mutateWithStableParent(guard, async () => await mkdir(paths.root, { mode: 0o700 }));
  await assertOwnedTransactionDirectory(paths.root, expectedUid);
  await bindTransactionRoot(guard, paths.root);
  await fsyncDirectory(paths.parent);
  await writeExclusiveFile(paths.journal, `${JSON.stringify(journal)}\n`, guard);
  await fsyncDirectory(paths.root);
  journalFiles.set(journal, await observeOwnerPrivatePlist(paths.journal, expectedUid));
  return Object.freeze(journal);
}
async function writeDesiredStage(
  paths: TransactionPaths, value: string, expected: NonNullable<TransactionJournal["desired"]>, guard: TransactionGuard,
): Promise<void> {
  await writeExclusiveFile(paths.desired, value, guard);
  const observed = await observeOwnerPrivatePlist(paths.desired, guard.expectedUid);
  if (!matchesDesired(expected, observed)) {
    throw new ServiceMacosDriftError("The staged service plist did not match its journaled digest.");
  }
  await fsyncDirectory(paths.root);
}
async function quarantineExpectedPrior(
  paths: TransactionPaths, journal: TransactionJournal, target: ServiceMacosTarget, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  try {
    await mutateWithStableParent(guard, async () => await rename(target.plistPath, paths.prior));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new ServiceMacosDriftError(`Managed plist disappeared before mutation for ${target.serviceId}.`);
    }
    throw error;
  }
  await fsyncDirectory(paths.parent);
  await fsyncDirectory(paths.root);
  const quarantined = await observeOwnerPrivatePlist(paths.prior, expectedUid);
  if (!sameRenamedFile(journal.expectedFile, quarantined)) {
    const restored = await restoreNoClobber(paths.prior, target.plistPath, quarantined, guard);
    if (restored) {
      await discardPreparedTransaction(paths, journal, guard);
    }
    throw new ServiceMacosDriftError(
      `The plist moved to quarantine was not the fingerprinted inode for ${target.serviceId}; concurrent bytes were preserved.`,
    );
  }
  const next = await updateJournal(
    paths, journal, Object.freeze({ ...journal, phase: "prior-quarantined" }), guard,
  );
  await runServiceMacosTransactionTestHook("after-prior-quarantined");
  return next;
}
async function publishDesired(
  paths: TransactionPaths, journal: TransactionJournal, target: ServiceMacosTarget, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  const stagedBefore = await observeOwnerPrivatePlist(paths.desired, expectedUid);
  if (journal.desired === undefined || !matchesDesired(journal.desired, stagedBefore)) {
    throw new ServiceMacosDriftError(`Desired transaction artifact changed for ${target.serviceId}.`);
  }
  try {
    await mutateWithStableParent(guard, async () => await link(paths.desired, target.plistPath));
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      if (!journal.expectedFile.exists && journal.phase === "prepared") {
        await discardPreparedTransaction(paths, journal, guard);
      }
      throw new NoClobberOccupiedError(
        `A concurrent plist appeared before publishing ${target.serviceId}; it was not overwritten.`,
      );
    }
    throw error;
  }
  await fsyncDirectory(paths.parent);
  const stagedLinked = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  const canonicalLinked = await observeOwnerPrivatePlist(target.plistPath, expectedUid, { allowTwoLinks: true });
  if (
    !matchesDesired(journal.desired, stagedLinked)
    || !sameFileObject(stagedLinked, canonicalLinked)
    || stagedLinked.identity?.links !== 2
    || canonicalLinked.identity?.links !== 2
  ) {
    throw new ServiceMacosDriftError(`Desired plist publication identity changed for ${target.serviceId}.`);
  }
  let next = await updateJournal(paths, journal, Object.freeze({
    ...journal,
    phase: "desired-linked",
    published: canonicalLinked,
  }), guard);
  await runServiceMacosTransactionTestHook("after-desired-linked");
  await unlinkInternal(paths.desired, stagedLinked, guard, true);
  await fsyncDirectory(paths.root);
  await fsyncDirectory(paths.parent);
  const canonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
  if (!matchesDesired(journal.desired, canonical) || !sameFileObject(canonicalLinked, canonical)) {
    throw new ServiceMacosDriftError(`Published plist changed before activation for ${target.serviceId}.`);
  }
  next = await updateJournal(paths, next, Object.freeze({
    ...next,
    phase: "desired-published",
    published: canonical,
  }), guard);
  await runServiceMacosTransactionTestHook("after-desired-published");
  return next;
}
async function rollbackTransaction(
  paths: TransactionPaths, journal: TransactionJournal, target: ServiceMacosTarget,
  guard: TransactionGuard, lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
  const desiredStage = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  let canonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid, { allowTwoLinks: true });
  let displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
  const priorIsPartiallyRestored = prior.exists
    && canonical.exists
    && prior.identity?.links === 2
    && canonical.identity?.links === 2
    && sameFileObject(journal.expectedFile, prior)
    && sameFileObject(prior, canonical);
  if (prior.exists && !sameRenamedFile(journal.expectedFile, prior) && !priorIsPartiallyRestored) {
    throw new ServiceMacosDriftError(
      `Quarantined prior plist for ${target.serviceId} no longer matches the fingerprinted inode; all artifacts were retained.`,
    );
  }
  if (displaced.exists && !isKnownDesired(journal, displaced, desiredStage)) {
    throw new ServiceMacosDriftError(
      `Rollback quarantine for ${target.serviceId} contains unknown bytes; all artifacts were retained.`,
    );
  }
  const priorWasMoved = prior.exists;
  const canonicalIsPrior = journal.expectedFile.exists
    && canonical.exists
    && sameFileObject(journal.expectedFile, canonical);
  const canonicalIsDesired = canonical.exists && isKnownDesired(journal, canonical, desiredStage);
  if (!priorWasMoved) {
    if (journal.expectedFile.exists) {
      if (!canonicalIsPrior) {
        throw new ServiceMacosDriftError(
          `The fingerprinted prior plist for ${target.serviceId} cannot be recovered; unknown bytes were retained.`,
        );
      }
      await cleanupTransactionDirectory(paths, journal, guard);
      return;
    }
    if (!canonical.exists) {
      await cleanupTransactionDirectory(paths, journal, guard);
      return;
    }
    if (!canonicalIsDesired) {
      if (journal.phase === "prepared" && desiredStage.exists && desiredStage.identity?.links === 1) {
        await cleanupTransactionDirectory(paths, journal, guard);
        return;
      }
      throw new ServiceMacosDriftError(
        `Canonical plist for ${target.serviceId} is not the transaction-published inode; it was retained.`,
      );
    }
  }
  await lifecycle.bootoutIfPresent();

  if (canonical.exists && !canonicalIsPrior) {
    if (!canonicalIsDesired) {
      throw new ServiceMacosDriftError(
        `Canonical plist for ${target.serviceId} changed during rollback; it and the prior quarantine were retained.`,
      );
    }
    if (displaced.exists) {
      if (!sameFileObject(displaced, canonical)) {
        throw new ServiceMacosDriftError(
          `Rollback quarantine for ${target.serviceId} is occupied; all artifacts were retained.`,
        );
      }
    } else {
      await mutateWithStableParent(guard, async () => await rename(target.plistPath, paths.displaced));
      await fsyncDirectory(paths.parent);
      await fsyncDirectory(paths.root);
      displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
      if (!sameRenamedFile(canonical, displaced)) {
        const restored = await restoreNoClobber(paths.displaced, target.plistPath, displaced, guard);
        throw new ServiceMacosDriftError(
          `A concurrent plist raced rollback for ${target.serviceId}; moved bytes were ${restored ? "restored" : "retained in quarantine"}.`,
        );
      }
      canonical = Object.freeze({ exists: false });
    }
  }
  if (journal.expectedFile.exists) {
    const refreshedPrior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
    if (!refreshedPrior.exists || !sameFileObject(journal.expectedFile, refreshedPrior)) {
      throw new ServiceMacosDriftError(`Prior plist recovery artifact changed for ${target.serviceId}.`);
    }
    const current = await observeOwnerPrivatePlist(target.plistPath, expectedUid, { allowTwoLinks: true });
    if (!current.exists) {
      const restored = await restoreNoClobber(paths.prior, target.plistPath, refreshedPrior, guard);
      if (!restored) {
        throw new ServiceMacosDriftError(
          `Canonical plist for ${target.serviceId} became occupied during restore; both files were preserved.`,
        );
      }
    } else if (!sameFileObject(journal.expectedFile, current)) {
      throw new ServiceMacosDriftError(
        `Canonical plist for ${target.serviceId} is occupied during restore; both files were preserved.`,
      );
    } else if (refreshedPrior.exists) {
      await unlinkInternal(paths.prior, refreshedPrior, guard, true);
    }
    const restoredCanonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (!sameFileObject(journal.expectedFile, restoredCanonical)) {
      throw new ServiceMacosDriftError(`Restored plist identity proof failed for ${target.serviceId}.`);
    }
    if (journal.expectedLoaded) {
      await lifecycle.bootstrapRestored();
      await lifecycle.proveInstalledReady();
    }
    const verifiedCanonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (!sameExactFile(restoredCanonical, verifiedCanonical)) {
      throw new ServiceMacosDriftError(
        `Restored plist changed before rollback cleanup for ${target.serviceId}; recovery artifacts were retained.`,
      );
    }
  } else {
    const verifiedAbsent = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (verifiedAbsent.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared before rollback cleanup for ${target.serviceId}; recovery artifacts were retained.`,
      );
    }
  }
  await cleanupTransactionDirectory(paths, journal, guard);
}
async function finishCommittedTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  guard: TransactionGuard,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const targetPath = join(paths.parent, `${journalTargetLabel(journal)}.plist`);
  const canonical = await observeOwnerPrivatePlist(targetPath, expectedUid, { allowTwoLinks: true });
  if (journal.operation === "apply") {
    const desiredStage = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
    if (
      !canonical.exists
      || !isKnownDesired(journal, canonical, desiredStage)
      || journal.desired === undefined
    ) {
      throw new ServiceMacosDriftError(
        `Committed service ${journal.serviceId} changed or unloaded before transaction cleanup; recovery artifacts were retained.`,
      );
    }
    await lifecycle.proveReady(journal.desired.readinessToken);
    const verifiedCanonical = await observeOwnerPrivatePlist(targetPath, expectedUid, { allowTwoLinks: true });
    if (!sameExactFile(canonical, verifiedCanonical)) {
      throw new ServiceMacosDriftError(
        `Committed service ${journal.serviceId} changed during readiness proof; recovery artifacts were retained.`,
      );
    }
  } else {
    if (canonical.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared after removing ${journal.serviceId}; it and the planned quarantine were retained.`,
      );
    }
    if (await lifecycle.inspectLoaded()) {
      await lifecycle.bootoutIfPresent();
      if (await lifecycle.inspectLoaded()) {
        throw new ServiceMacosDriftError(`launchd resurrected ${journal.serviceId} during committed removal cleanup.`);
      }
    }
    const verifiedAbsent = await observeOwnerPrivatePlist(targetPath, expectedUid);
    if (verifiedAbsent.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared before committed removal cleanup for ${journal.serviceId}; recovery artifacts were retained.`,
      );
    }
  }
  await cleanupTransactionDirectory(paths, journal, guard);
}
async function discardPreparedTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  guard: TransactionGuard,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid);
  const displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid);
  if (prior.exists || displaced.exists) {
    throw new ServiceMacosDriftError(`Cannot discard a service transaction that owns quarantined files.`);
  }
  await cleanupTransactionDirectory(paths, journal, guard);
}
async function cleanupTransactionDirectory(
  paths: TransactionPaths, journal: TransactionJournal, guard: TransactionGuard,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
  const desired = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  const displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
  const journalFile = await observeOwnerPrivatePlist(paths.journal, expectedUid);
  const names = (await readdir(paths.root)).sort();
  const expectedNames = [
    "journal.json",
    ...(prior.exists ? ["prior.plist"] : []),
    ...(desired.exists ? ["desired.plist"] : []),
    ...(displaced.exists ? ["displaced.plist"] : []),
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new ServiceMacosDriftError(
      `Transaction directory for ${journal.serviceId} contains missing or unknown artifacts: ${names.join(", ")}.`,
    );
  }
  if (prior.exists && !sameRenamedFile(journal.expectedFile, prior)) {
    throw new ServiceMacosDriftError(`Refusing to delete an unknown prior transaction artifact for ${journal.serviceId}.`);
  }
  if (desired.exists && (journal.desired === undefined || !matchesDesired(journal.desired, desired))) {
    throw new ServiceMacosDriftError(`Refusing to delete an unknown desired transaction artifact for ${journal.serviceId}.`);
  }
  if (displaced.exists && !isKnownDesired(journal, displaced, desired)) {
    throw new ServiceMacosDriftError(`Refusing to delete an unknown rollback artifact for ${journal.serviceId}.`);
  }
  if (!sameExactFile(requireJournalFile(journal), journalFile)) {
    throw new ServiceMacosDriftError(`Refusing cleanup after journal identity drift for ${journal.serviceId}.`);
  }
  if (desired.exists) await unlinkInternal(paths.desired, desired, guard, true);
  if (displaced.exists) {
    const refreshed = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
    if (!sameFileObject(displaced, refreshed)) {
      throw new ServiceMacosDriftError(`Rollback artifact changed during cleanup for ${journal.serviceId}.`);
    }
    await unlinkInternal(paths.displaced, refreshed, guard, true);
  }
  if (prior.exists) await unlinkInternal(paths.prior, prior, guard, true);
  await unlinkInternal(paths.journal, journalFile, guard, false);
  await fsyncDirectory(paths.root);
  await mutateWithStableParent(guard, async () => await rmdir(paths.root), true);
  await fsyncDirectory(paths.parent);
}
