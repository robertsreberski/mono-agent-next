import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { ServiceMacosDriftError } from "./errors.js";
import type { ServiceMacosTarget } from "./plist.js";
import type { ServiceFileObservation } from "./reconciler.js";
import {
  isSimulatedServiceMacosCrash,
  runServiceMacosTransactionTestHook,
} from "./transaction-test-hooks.js";

const TRANSACTION_SCHEMA_VERSION = 1;
const TRANSACTION_DIRECTORY_SUFFIX = ".mono-agent-transaction";
const TRANSACTION_MAX_BYTES = 65_536;

type TransactionOperation = "apply" | "remove";
type TransactionPhase =
  | "prepared"
  | "prior-quarantined"
  | "desired-linked"
  | "desired-published"
  | "committed";

interface TransactionJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly serviceId: string;
  readonly operation: TransactionOperation;
  readonly phase: TransactionPhase;
  readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean;
  readonly desired?: {
    readonly digest: string;
    readonly bytes: number;
  };
  readonly published?: ServiceFileObservation;
}

interface TransactionPaths {
  readonly root: string;
  readonly lock: string;
  readonly journal: string;
  readonly nextJournal: string;
  readonly prior: string;
  readonly desired: string;
  readonly displaced: string;
  readonly parent: string;
}

export interface ServiceMacosTransactionLifecycle {
  readonly inspectLoaded: () => Promise<boolean>;
  readonly bootoutRequired: () => Promise<void>;
  readonly bootoutIfPresent: () => Promise<void>;
  readonly bootstrap: () => Promise<void>;
}

export interface ReplaceServicePlistTransaction {
  readonly target: ServiceMacosTarget;
  readonly expectedUid: number;
  readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean;
  readonly desiredPlist: string;
  readonly desiredDigest: string;
  readonly lifecycle: ServiceMacosTransactionLifecycle;
}

export interface RemoveServicePlistTransaction {
  readonly target: ServiceMacosTarget;
  readonly expectedUid: number;
  readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean;
  readonly lifecycle: ServiceMacosTransactionLifecycle;
}

class NoClobberOccupiedError extends ServiceMacosDriftError {}

export async function observeOwnerPrivatePlist(
  path: string,
  expectedUid: number,
  options: { readonly allowTwoLinks?: boolean } = {},
): Promise<ServiceFileObservation> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return Object.freeze({ exists: false });
    throw error;
  }
  const maximumLinks = options.allowTwoLinks === true ? 2n : 1n;
  assertOwnerPrivateStats(path, before, expectedUid, maximumLinks);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertOwnerPrivateStats(path, opened, expectedUid, maximumLinks);
    assertSameIdentity(path, before, opened);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertOwnerPrivateStats(path, after, expectedUid, maximumLinks);
    assertSameIdentity(path, opened, after);
    if (after.size !== BigInt(bytes.byteLength)) {
      throw new Error(`${path} changed size while it was read.`);
    }
    return Object.freeze({
      exists: true,
      digest: digest(bytes),
      bytes: bytes.byteLength,
      identity: Object.freeze({
        device: after.dev.toString(),
        inode: after.ino.toString(),
        ctimeNanoseconds: after.ctimeNs.toString(),
        uid: Number(after.uid),
        mode: Number(after.mode & 0o777n),
        links: Number(after.nlink),
        size: Number(after.size),
      }),
    });
  } finally {
    await handle.close();
  }
}

export async function assertNoPendingServiceMacosTransaction(
  target: ServiceMacosTarget,
  expectedUid: number,
): Promise<void> {
  const paths = transactionPaths(target);
  if (await pathExists(paths.root) || await pathExists(paths.lock)) {
    if (await pathExists(paths.root)) await assertOwnedTransactionDirectory(paths.root, expectedUid);
    if (await pathExists(paths.lock)) {
      await observeOwnerPrivatePlist(paths.lock, expectedUid, { allowTwoLinks: true });
    }
    throw new ServiceMacosDriftError(
      `Unresolved service transaction exists for ${target.serviceId}; rerun apply or remove with explicit mutation authorization to recover it.`,
    );
  }
}

export async function recoverPendingServiceMacosTransaction(
  target: ServiceMacosTarget,
  expectedUid: number,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const paths = transactionPaths(target);
  if (!await pathExists(paths.root) && !await pathExists(paths.lock)) return;
  const release = await acquireTransactionLock(paths, expectedUid);
  try {
    if (!await pathExists(paths.root)) return;
    await assertOwnedTransactionDirectory(paths.root, expectedUid);
    if ((await readdir(paths.root)).length === 0) {
      await rmdir(paths.root);
      await fsyncDirectory(paths.parent);
      return;
    }
    const journal = await readRecoverableJournal(paths, target);
    if (journal.phase === "committed") {
      try {
        await finishCommittedTransaction(paths, journal, expectedUid, lifecycle);
      } catch (error) {
        try {
          await rollbackTransaction(paths, journal, target, expectedUid, lifecycle);
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
    await rollbackTransaction(paths, journal, target, expectedUid, lifecycle);
  } finally {
    await release();
  }
}

export async function replaceServicePlistTransaction(
  input: ReplaceServicePlistTransaction,
): Promise<void> {
  const paths = transactionPaths(input.target);
  const release = await acquireTransactionLock(paths, input.expectedUid);
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
      }),
    }, input.expectedUid);
    await runServiceMacosTransactionTestHook("after-journal-prepared");
    await writeDesiredStage(paths, input.desiredPlist, journal.desired!, input.expectedUid);
    if (input.expectedFile.exists) {
      journal = await quarantineExpectedPrior(paths, journal, input.target, input.expectedUid);
    }
    journal = await publishDesired(paths, journal, input.target, input.expectedUid);
    if (input.expectedLoaded) await input.lifecycle.bootoutRequired();
    await input.lifecycle.bootstrap();
    const activated = await observeOwnerPrivatePlist(input.target.plistPath, input.expectedUid);
    if (
      !isKnownDesired(journal, activated, Object.freeze({ exists: false }))
      || !await input.lifecycle.inspectLoaded()
    ) {
      throw new ServiceMacosDriftError(
        `Activation did not retain the published plist and loaded state for ${input.target.serviceId}.`,
      );
    }
    journal = await updateJournal(paths, Object.freeze({ ...journal, phase: "committed" }));
    await runServiceMacosTransactionTestHook("after-transaction-committed");
    await finishCommittedTransaction(paths, journal, input.expectedUid, input.lifecycle);
  } catch (error) {
    if (isSimulatedServiceMacosCrash(error)) throw error;
    const rollbackFailures: unknown[] = [];
    if (journal !== undefined && await pathExists(paths.root)) {
      try {
        await runServiceMacosTransactionTestHook("before-rollback");
        await rollbackTransaction(
          paths,
          await readRecoverableJournal(paths, input.target),
          input.target,
          input.expectedUid,
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

export async function removeServicePlistTransaction(
  input: RemoveServicePlistTransaction,
): Promise<void> {
  const paths = transactionPaths(input.target);
  const release = await acquireTransactionLock(paths, input.expectedUid);
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
    }, input.expectedUid);
    await runServiceMacosTransactionTestHook("after-journal-prepared");
    if (input.expectedFile.exists) {
      journal = await quarantineExpectedPrior(paths, journal, input.target, input.expectedUid);
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
    journal = await updateJournal(paths, Object.freeze({ ...journal, phase: "committed" }));
    await runServiceMacosTransactionTestHook("after-transaction-committed");
    await finishCommittedTransaction(paths, journal, input.expectedUid, input.lifecycle);
  } catch (error) {
    if (isSimulatedServiceMacosCrash(error)) throw error;
    const rollbackFailures: unknown[] = [];
    if (journal !== undefined && await pathExists(paths.root)) {
      try {
        await runServiceMacosTransactionTestHook("before-rollback");
        await rollbackTransaction(
          paths,
          await readRecoverableJournal(paths, input.target),
          input.target,
          input.expectedUid,
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
  paths: TransactionPaths,
  journal: TransactionJournal,
  expectedUid: number,
): Promise<TransactionJournal> {
  await mkdir(paths.root, { mode: 0o700 });
  await assertOwnedTransactionDirectory(paths.root, expectedUid);
  await fsyncDirectory(paths.parent);
  await writeExclusiveFile(paths.journal, `${JSON.stringify(journal)}\n`);
  await fsyncDirectory(paths.root);
  return Object.freeze(journal);
}

async function writeDesiredStage(
  paths: TransactionPaths,
  value: string,
  expected: NonNullable<TransactionJournal["desired"]>,
  expectedUid: number,
): Promise<void> {
  await writeExclusiveFile(paths.desired, value);
  const observed = await observeOwnerPrivatePlist(paths.desired, expectedUid);
  if (!matchesDesired(expected, observed)) {
    throw new ServiceMacosDriftError("The staged service plist did not match its journaled digest.");
  }
  await fsyncDirectory(paths.root);
}

async function quarantineExpectedPrior(
  paths: TransactionPaths,
  journal: TransactionJournal,
  target: ServiceMacosTarget,
  expectedUid: number,
): Promise<TransactionJournal> {
  try {
    await rename(target.plistPath, paths.prior);
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
    const restored = await restoreNoClobber(paths.prior, target.plistPath, quarantined, expectedUid);
    if (restored) {
      await discardPreparedTransaction(paths, journal, expectedUid);
    }
    throw new ServiceMacosDriftError(
      `The plist moved to quarantine was not the fingerprinted inode for ${target.serviceId}; concurrent bytes were preserved.`,
    );
  }
  const next = await updateJournal(paths, Object.freeze({ ...journal, phase: "prior-quarantined" }));
  await runServiceMacosTransactionTestHook("after-prior-quarantined");
  return next;
}

async function publishDesired(
  paths: TransactionPaths,
  journal: TransactionJournal,
  target: ServiceMacosTarget,
  expectedUid: number,
): Promise<TransactionJournal> {
  const stagedBefore = await observeOwnerPrivatePlist(paths.desired, expectedUid);
  if (journal.desired === undefined || !matchesDesired(journal.desired, stagedBefore)) {
    throw new ServiceMacosDriftError(`Desired transaction artifact changed for ${target.serviceId}.`);
  }
  try {
    await link(paths.desired, target.plistPath);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      if (!journal.expectedFile.exists && journal.phase === "prepared") {
        await discardPreparedTransaction(paths, journal, expectedUid);
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
  let next = await updateJournal(paths, Object.freeze({
    ...journal,
    phase: "desired-linked",
    published: canonicalLinked,
  }));
  await runServiceMacosTransactionTestHook("after-desired-linked");
  await unlinkInternal(paths.desired, stagedLinked, expectedUid, true);
  await fsyncDirectory(paths.root);
  await fsyncDirectory(paths.parent);
  const canonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
  if (!matchesDesired(journal.desired, canonical) || !sameFileObject(canonicalLinked, canonical)) {
    throw new ServiceMacosDriftError(`Published plist changed before activation for ${target.serviceId}.`);
  }
  next = await updateJournal(paths, Object.freeze({
    ...next,
    phase: "desired-published",
    published: canonical,
  }));
  await runServiceMacosTransactionTestHook("after-desired-published");
  return next;
}

async function rollbackTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  target: ServiceMacosTarget,
  expectedUid: number,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
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
      await cleanupTransactionDirectory(paths, journal, expectedUid);
      return;
    }
    if (!canonical.exists) {
      await cleanupTransactionDirectory(paths, journal, expectedUid);
      return;
    }
    if (!canonicalIsDesired) {
      if (journal.phase === "prepared" && desiredStage.exists && desiredStage.identity?.links === 1) {
        await cleanupTransactionDirectory(paths, journal, expectedUid);
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
      await rename(target.plistPath, paths.displaced);
      await fsyncDirectory(paths.parent);
      await fsyncDirectory(paths.root);
      displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
      if (!sameRenamedFile(canonical, displaced)) {
        const restored = await restoreNoClobber(paths.displaced, target.plistPath, displaced, expectedUid);
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
      const restored = await restoreNoClobber(paths.prior, target.plistPath, refreshedPrior, expectedUid);
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
      await unlinkInternal(paths.prior, refreshedPrior, expectedUid, true);
    }
    const restoredCanonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (!sameFileObject(journal.expectedFile, restoredCanonical)) {
      throw new ServiceMacosDriftError(`Restored plist identity proof failed for ${target.serviceId}.`);
    }
    if (journal.expectedLoaded) {
      await lifecycle.bootstrap();
      if (!await lifecycle.inspectLoaded()) {
        throw new ServiceMacosDriftError(`Restored service ${target.serviceId} did not remain loaded.`);
      }
    }
  }

  await cleanupTransactionDirectory(paths, journal, expectedUid);
}

async function finishCommittedTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  expectedUid: number,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const targetPath = join(paths.parent, `${journalTargetLabel(journal)}.plist`);
  const canonical = await observeOwnerPrivatePlist(targetPath, expectedUid, { allowTwoLinks: true });
  if (journal.operation === "apply") {
    const desiredStage = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
    if (
      !canonical.exists
      || !isKnownDesired(journal, canonical, desiredStage)
      || !await lifecycle.inspectLoaded()
    ) {
      throw new ServiceMacosDriftError(
        `Committed service ${journal.serviceId} changed or unloaded before transaction cleanup; recovery artifacts were retained.`,
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
  }
  await cleanupTransactionDirectory(paths, journal, expectedUid);
}

async function discardPreparedTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  expectedUid: number,
): Promise<void> {
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid);
  const displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid);
  if (prior.exists || displaced.exists) {
    throw new ServiceMacosDriftError(`Cannot discard a service transaction that owns quarantined files.`);
  }
  await cleanupTransactionDirectory(paths, journal, expectedUid);
}

async function cleanupTransactionDirectory(
  paths: TransactionPaths,
  journal: TransactionJournal,
  expectedUid: number,
): Promise<void> {
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
  if (prior.exists) {
    if (!sameRenamedFile(journal.expectedFile, prior)) {
      throw new ServiceMacosDriftError(`Refusing to delete an unknown prior transaction artifact for ${journal.serviceId}.`);
    }
    await unlinkInternal(paths.prior, prior, expectedUid, true);
  }
  const desired = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  if (desired.exists) {
    if (journal.desired === undefined || !matchesDesired(journal.desired, desired)) {
      throw new ServiceMacosDriftError(`Refusing to delete an unknown desired transaction artifact for ${journal.serviceId}.`);
    }
    await unlinkInternal(paths.desired, desired, expectedUid, true);
  }
  const displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
  if (displaced.exists) {
    const desiredStage = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
    if (!isKnownDesired(journal, displaced, desiredStage)) {
      throw new ServiceMacosDriftError(`Refusing to delete an unknown rollback artifact for ${journal.serviceId}.`);
    }
    await unlinkInternal(paths.displaced, displaced, expectedUid, true);
  }
  if (await pathExists(paths.nextJournal)) {
    throw new ServiceMacosDriftError(`A pending journal update for ${journal.serviceId} must be recovered before cleanup.`);
  }
  const names = (await readdir(paths.root)).sort();
  if (names.length !== 1 || names[0] !== "journal.json") {
    throw new ServiceMacosDriftError(
      `Transaction directory for ${journal.serviceId} contains unknown artifacts: ${names.join(", ")}.`,
    );
  }
  await unlink(paths.journal);
  await fsyncDirectory(paths.root);
  await rmdir(paths.root);
  await fsyncDirectory(paths.parent);
}

async function restoreNoClobber(
  source: string,
  target: string,
  sourceObservation: ServiceFileObservation,
  expectedUid: number,
): Promise<boolean> {
  try {
    await link(source, target);
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
  await fsyncDirectory(dirname(target));
  const sourceLinked = await observeOwnerPrivatePlist(source, expectedUid, { allowTwoLinks: true });
  const targetLinked = await observeOwnerPrivatePlist(target, expectedUid, { allowTwoLinks: true });
  if (
    !sameFileObject(sourceObservation, sourceLinked)
    || !sameFileObject(sourceLinked, targetLinked)
    || sourceLinked.identity?.links !== 2
  ) {
    throw new ServiceMacosDriftError(`No-clobber restore identity proof failed for ${target}.`);
  }
  await runServiceMacosTransactionTestHook("after-restore-linked");
  await unlinkInternal(source, sourceLinked, expectedUid, true);
  await fsyncDirectory(dirname(source));
  await fsyncDirectory(dirname(target));
  const restored = await observeOwnerPrivatePlist(target, expectedUid);
  if (!sameFileObject(sourceObservation, restored)) {
    throw new ServiceMacosDriftError(`Restored file identity proof failed for ${target}.`);
  }
  return true;
}

async function unlinkInternal(
  path: string,
  expected: ServiceFileObservation,
  expectedUid: number,
  allowTwoLinks: boolean,
): Promise<void> {
  const current = await observeOwnerPrivatePlist(
    path,
    expectedUid,
    allowTwoLinks ? { allowTwoLinks: true } : {},
  );
  if (!sameExactFile(expected, current)) {
    throw new ServiceMacosDriftError(`Refusing to delete transaction artifact whose identity changed: ${path}.`);
  }
  await unlink(path);
}

async function updateJournal(
  paths: TransactionPaths,
  journal: TransactionJournal,
): Promise<TransactionJournal> {
  await writeExclusiveFile(paths.nextJournal, `${JSON.stringify(journal)}\n`);
  await fsyncDirectory(paths.root);
  await rename(paths.nextJournal, paths.journal);
  await fsyncDirectory(paths.root);
  return Object.freeze(journal);
}

async function readRecoverableJournal(
  paths: TransactionPaths,
  target: ServiceMacosTarget,
): Promise<TransactionJournal> {
  if (await pathExists(paths.nextJournal)) {
    const next = await readJournalFile(paths.nextJournal, target);
    await rename(paths.nextJournal, paths.journal);
    await fsyncDirectory(paths.root);
    return next;
  }
  return await readJournalFile(paths.journal, target);
}

async function readJournalFile(path: string, target: ServiceMacosTarget): Promise<TransactionJournal> {
  const source = await readOwnerPrivateBounded(path, TRANSACTION_MAX_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new ServiceMacosDriftError(`Service transaction journal is corrupt for ${target.serviceId}; artifacts were retained.`);
  }
  if (!isRecord(value)) throw new ServiceMacosDriftError(`Invalid service transaction journal for ${target.serviceId}.`);
  const allowed = new Set([
    "schemaVersion",
    "transactionId",
    "serviceId",
    "operation",
    "phase",
    "expectedFile",
    "expectedLoaded",
    "desired",
    "published",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ServiceMacosDriftError(`Service transaction journal contains unknown fields for ${target.serviceId}.`);
  }
  if (
    value.schemaVersion !== TRANSACTION_SCHEMA_VERSION
    || typeof value.transactionId !== "string"
    || !/^[a-f0-9-]{36}$/u.test(value.transactionId)
    || value.serviceId !== target.serviceId
    || (value.operation !== "apply" && value.operation !== "remove")
    || !isTransactionPhase(value.phase)
    || typeof value.expectedLoaded !== "boolean"
    || !isFileObservation(value.expectedFile)
    || (value.desired !== undefined && !isDesiredDescriptor(value.desired))
    || (value.published !== undefined && !isFileObservation(value.published))
    || (value.operation === "apply" && !isDesiredDescriptor(value.desired))
    || (value.operation === "remove" && (value.desired !== undefined || value.published !== undefined))
  ) {
    throw new ServiceMacosDriftError(`Service transaction journal failed validation for ${target.serviceId}.`);
  }
  return Object.freeze(value as unknown as TransactionJournal);
}

async function acquireTransactionLock(
  paths: TransactionPaths,
  expectedUid: number,
): Promise<() => Promise<void>> {
  for (;;) {
    const owner = Object.freeze({ schemaVersion: 1, pid: process.pid, token: randomUUID() });
    const temporary = `${paths.lock}.${owner.token}.tmp`;
    await writeExclusiveFile(temporary, `${JSON.stringify(owner)}\n`);
    const temporaryObservation = await observeOwnerPrivatePlist(temporary, expectedUid);
    try {
      await link(temporary, paths.lock);
      await fsyncDirectory(paths.parent);
      const linkedTemporary = await observeOwnerPrivatePlist(temporary, expectedUid, { allowTwoLinks: true });
      const linkedLock = await observeOwnerPrivatePlist(paths.lock, expectedUid, { allowTwoLinks: true });
      if (!sameFileObject(temporaryObservation, linkedTemporary) || !sameFileObject(linkedTemporary, linkedLock)) {
        throw new ServiceMacosDriftError(`Service transaction lock publication changed identity for ${paths.root}.`);
      }
      await unlinkInternal(temporary, linkedTemporary, expectedUid, true);
      await fsyncDirectory(paths.parent);
      const acquiredLock = await observeOwnerPrivatePlist(paths.lock, expectedUid);
      return async () => {
        const current = await readLockOwner(paths.lock, expectedUid);
        if (current.pid !== process.pid || current.token !== owner.token) {
          throw new ServiceMacosDriftError(`Service transaction lock ownership changed for ${paths.root}.`);
        }
        const released = `${paths.lock}.released-${owner.token}`;
        await rename(paths.lock, released);
        await fsyncDirectory(paths.parent);
        const releasedObservation = await observeOwnerPrivatePlist(released, expectedUid, { allowTwoLinks: true });
        if (!sameRenamedFile(acquiredLock, releasedObservation)) {
          await restoreNoClobber(released, paths.lock, releasedObservation, expectedUid);
          throw new ServiceMacosDriftError(`Service transaction lock changed before release for ${paths.root}.`);
        }
        await unlinkInternal(released, releasedObservation, expectedUid, true);
        await fsyncDirectory(paths.parent);
      };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readLockOwner(paths.lock, expectedUid);
      if (processIsAlive(existing.pid)) {
        throw new ServiceMacosDriftError(`Another service-macos mutation is active for ${paths.root}.`);
      }
      await runServiceMacosTransactionTestHook("before-stale-lock-quarantine");
      const stale = `${paths.lock}.stale-${randomUUID()}`;
      await rename(paths.lock, stale);
      await fsyncDirectory(paths.parent);
      const moved = await observeOwnerPrivatePlist(stale, expectedUid, { allowTwoLinks: true });
      if (!sameRenamedFile(existing.observation, moved)) {
        await restoreNoClobber(stale, paths.lock, moved, expectedUid);
        throw new ServiceMacosDriftError(
          `Service transaction lock changed during stale-lock recovery for ${paths.root}.`,
        );
      }
      await unlinkInternal(stale, moved, expectedUid, true);
      await fsyncDirectory(paths.parent);
    }
  }
}

async function readLockOwner(
  path: string,
  expectedUid: number,
): Promise<{
  readonly pid: number;
  readonly token: string;
  readonly observation: ServiceFileObservation;
}> {
  const before = await observeOwnerPrivatePlist(path, expectedUid, { allowTwoLinks: true });
  const source = await readOwnerPrivateBounded(path, 4_096, expectedUid, true);
  const after = await observeOwnerPrivatePlist(path, expectedUid, { allowTwoLinks: true });
  if (!sameExactFile(before, after) || digest(source) !== before.digest) {
    throw new ServiceMacosDriftError(`Transaction lock changed while it was read: ${path}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new ServiceMacosDriftError(`Transaction lock owner record is corrupt: ${path}.`);
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.token !== "string"
    || !/^[a-f0-9-]{36}$/u.test(value.token)
  ) {
    throw new ServiceMacosDriftError(`Transaction lock owner record is invalid: ${path}.`);
  }
  return { pid: value.pid as number, token: value.token, observation: after };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function writeExclusiveFile(path: string, value: string | Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(value);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function readOwnerPrivateBounded(
  path: string,
  maximumBytes: number,
  expectedUid = process.getuid?.() ?? -1,
  allowTwoLinks = false,
): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== BigInt(expectedUid)
    || (before.mode & 0o777n) !== 0o600n
    || before.nlink < 1n
    || before.nlink > (allowTwoLinks ? 2n : 1n)
    || before.size > BigInt(maximumBytes)
  ) {
    throw new ServiceMacosDriftError(`${path} must be an owner-private single-linked bounded file.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameIdentity(path, before, opened);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSameIdentity(path, opened, after);
    if (source.byteLength > maximumBytes || after.size !== BigInt(source.byteLength)) {
      throw new ServiceMacosDriftError(`${path} changed or exceeded its byte limit while read.`);
    }
    return source;
  } finally {
    await handle.close();
  }
}

async function assertOwnedTransactionDirectory(path: string, expectedUid: number): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(expectedUid)
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw new ServiceMacosDriftError(`${path} must be an owner-private transaction directory (mode 0700).`);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function transactionPaths(target: ServiceMacosTarget): TransactionPaths {
  const parent = dirname(target.plistPath);
  const root = join(parent, `.${target.label}${TRANSACTION_DIRECTORY_SUFFIX}`);
  const lock = `${root}.lock`;
  return Object.freeze({
    root,
    lock,
    journal: join(root, "journal.json"),
    nextJournal: join(root, "journal.next"),
    prior: join(root, "prior.plist"),
    desired: join(root, "desired.plist"),
    displaced: join(root, "displaced.plist"),
    parent,
  });
}

function journalTargetLabel(journal: TransactionJournal): string {
  return `ai.mono-agent.${journal.serviceId}`;
}

function sameExactFile(left: ServiceFileObservation, right: ServiceFileObservation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRenamedFile(left: ServiceFileObservation, right: ServiceFileObservation): boolean {
  return sameFileObject(left, right)
    && left.identity?.links === right.identity?.links;
}

function sameFileObject(left: ServiceFileObservation, right: ServiceFileObservation): boolean {
  return left.exists
    && right.exists
    && left.digest === right.digest
    && left.bytes === right.bytes
    && left.identity !== undefined
    && right.identity !== undefined
    && left.identity.device === right.identity.device
    && left.identity.inode === right.identity.inode
    && left.identity.uid === right.identity.uid
    && left.identity.mode === right.identity.mode
    && left.identity.size === right.identity.size;
}

function matchesDesired(
  desired: NonNullable<TransactionJournal["desired"]>,
  observation: ServiceFileObservation,
): boolean {
  return observation.exists
    && observation.digest === desired.digest
    && observation.bytes === desired.bytes
    && observation.identity !== undefined;
}

function isKnownDesired(
  journal: TransactionJournal,
  observation: ServiceFileObservation,
  stage: ServiceFileObservation,
): boolean {
  if (journal.desired === undefined || !matchesDesired(journal.desired, observation)) return false;
  if (journal.published !== undefined && sameFileObject(journal.published, observation)) return true;
  return stage.exists && sameFileObject(stage, observation);
}

function assertOwnerPrivateStats(
  path: string,
  stats: BigIntStats,
  expectedUid: number,
  maximumLinks: bigint,
): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(expectedUid)
    || (stats.mode & 0o777n) !== 0o600n
    || stats.nlink < 1n
    || stats.nlink > maximumLinks
    || stats.size > 1_048_576n
  ) {
    throw new Error(
      `${path} must be an owner-private regular plist (mode 0600, uid ${String(expectedUid)}, bounded links and size).`,
    );
  }
}

function assertSameIdentity(
  path: string,
  left: BigIntStats,
  right: BigIntStats,
): void {
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.ctimeNs !== right.ctimeNs
    || left.uid !== right.uid
    || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.size !== right.size
  ) {
    throw new Error(`${path} changed identity or metadata while it was opened.`);
  }
}

function isFileObservation(value: unknown): value is ServiceFileObservation {
  if (!isRecord(value) || typeof value.exists !== "boolean") return false;
  const keys = Object.keys(value);
  if (!value.exists) return keys.length === 1;
  if (
    keys.some((key) => !["exists", "digest", "bytes", "identity"].includes(key))
    || typeof value.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.digest)
    || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) < 0
    || !isRecord(value.identity)
  ) return false;
  const identity = value.identity;
  return Object.keys(identity).every((key) =>
    ["device", "inode", "ctimeNanoseconds", "uid", "mode", "links", "size"].includes(key))
    && typeof identity.device === "string"
    && /^\d+$/u.test(identity.device)
    && typeof identity.inode === "string"
    && /^\d+$/u.test(identity.inode)
    && typeof identity.ctimeNanoseconds === "string"
    && /^\d+$/u.test(identity.ctimeNanoseconds)
    && Number.isSafeInteger(identity.uid)
    && Number.isSafeInteger(identity.mode)
    && Number.isSafeInteger(identity.links)
    && Number.isSafeInteger(identity.size);
}

function isDesiredDescriptor(value: unknown): value is NonNullable<TransactionJournal["desired"]> {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "digest" || key === "bytes")
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/u.test(value.digest)
    && Number.isSafeInteger(value.bytes)
    && (value.bytes as number) >= 0;
}

function isTransactionPhase(value: unknown): value is TransactionPhase {
  return value === "prepared"
    || value === "prior-quarantined"
    || value === "desired-linked"
    || value === "desired-published"
    || value === "committed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
