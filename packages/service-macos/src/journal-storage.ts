import { ServiceMacosDriftError } from "./errors.js";
import { digest, isRecord } from "./internal-fs.js";
import {
  isDesiredDescriptor,
  isFileObservation,
  isJournalSuccessor,
  isTransactionPhase,
  journalFiles,
  requireJournalFile,
  sameExactFile,
  sameFileObject,
  type TransactionJournal,
} from "./journal-guards.js";
import { observeOwnerPrivatePlist } from "./plist-observation.js";
import type { ServiceMacosTarget } from "./plist.js";
import {
  fsyncDirectory,
  moveNoClobber,
  pathExists,
  readOwnerPrivateBounded,
  type TransactionGuard,
  type TransactionPaths,
  unlinkInternal,
  writeExclusiveFile,
} from "./transaction-fs.js";

const TRANSACTION_SCHEMA_VERSION = 1;
const TRANSACTION_MAX_BYTES = 65_536;

export async function updateJournal(
  paths: TransactionPaths,
  current: TransactionJournal,
  next: TransactionJournal,
  guard: TransactionGuard,
): Promise<TransactionJournal> {
  if (
    !isJournalSuccessor(current, next)
    || await pathExists(paths.previousJournal)
  ) {
    throw new ServiceMacosDriftError(
      `Refusing an invalid or unresolved journal update for ${next.serviceId}.`,
    );
  }
  const serialized = `${JSON.stringify(next)}\n`;
  await writeExclusiveFile(paths.nextJournal, serialized, guard);
  const staged = await observeOwnerPrivatePlist(
    paths.nextJournal,
    guard.expectedUid,
  );
  if (
    staged.digest !== digest(serialized)
    || staged.bytes !== Buffer.byteLength(serialized)
  ) {
    throw new ServiceMacosDriftError(
      `Staged journal bytes changed before publication for ${next.serviceId}.`,
    );
  }
  journalFiles.set(next, staged);
  await fsyncDirectory(paths.root);
  return await completeJournalUpdate(paths, current, next, guard);
}

async function completeJournalUpdate(
  paths: TransactionPaths,
  current: TransactionJournal,
  next: TransactionJournal,
  guard: TransactionGuard,
): Promise<TransactionJournal> {
  if (!isJournalSuccessor(current, next)) {
    throw new ServiceMacosDriftError(
      `Journal successor validation failed for ${next.serviceId}.`,
    );
  }
  const prior = await moveNoClobber(
    paths.journal,
    paths.previousJournal,
    requireJournalFile(current),
    guard,
  );
  if (prior === undefined) {
    throw new ServiceMacosDriftError(
      `Prior journal quarantine is occupied for ${next.serviceId}; `
      + "all files were retained.",
    );
  }
  const published = await moveNoClobber(
    paths.nextJournal,
    paths.journal,
    requireJournalFile(next),
    guard,
  );
  if (published === undefined) {
    throw new ServiceMacosDriftError(
      `Journal publication is occupied for ${next.serviceId}; `
      + "all files were retained.",
    );
  }
  journalFiles.set(next, published);
  const verified = await observeOwnerPrivatePlist(
    paths.journal,
    guard.expectedUid,
  );
  if (!sameExactFile(published, verified)) {
    throw new ServiceMacosDriftError(
      `Published journal changed before prior cleanup for ${next.serviceId}.`,
    );
  }
  await unlinkInternal(
    paths.previousJournal,
    prior,
    guard,
    false,
  );
  await fsyncDirectory(paths.root);
  return next;
}

export async function readRecoverableJournal(
  paths: TransactionPaths,
  target: ServiceMacosTarget,
  guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  const hasPrevious = await pathExists(paths.previousJournal);
  const hasNext = await pathExists(paths.nextJournal);
  const hasCurrent = await pathExists(paths.journal);
  if (!hasPrevious && !hasNext) {
    return await readJournalFile(paths.journal, target, expectedUid);
  }
  if (!hasPrevious) {
    if (!hasCurrent || !hasNext) {
      throw new ServiceMacosDriftError(
        `Incomplete journal update for ${target.serviceId}; `
        + "all files were retained.",
      );
    }
    const current = await readJournalFile(
      paths.journal,
      target,
      expectedUid,
      true,
    );
    const next = await readJournalFile(
      paths.nextJournal,
      target,
      expectedUid,
      true,
    );
    return await completeJournalUpdate(paths, current, next, guard);
  }
  let previous = await readJournalFile(
    paths.previousJournal,
    target,
    expectedUid,
    true,
  );
  let current = hasCurrent
    ? await readJournalFile(paths.journal, target, expectedUid, true)
    : undefined;
  const next = hasNext
    ? await readJournalFile(paths.nextJournal, target, expectedUid, true)
    : undefined;
  if (
    current !== undefined
    && sameFileObject(
      requireJournalFile(previous),
      requireJournalFile(current),
    )
  ) {
    if (
      requireJournalFile(previous).identity?.links !== 2
      || requireJournalFile(current).identity?.links !== 2
    ) {
      throw new ServiceMacosDriftError(
        `Partially quarantined journal link count changed `
        + `for ${target.serviceId}.`,
      );
    }
    if (next === undefined) {
      await unlinkInternal(
        paths.previousJournal,
        requireJournalFile(previous),
        guard,
        true,
      );
      return await readJournalFile(
        paths.journal,
        target,
        expectedUid,
      );
    }
    if (!isJournalSuccessor(previous, next)) {
      throw new ServiceMacosDriftError(
        `Pending journal is not a valid successor for ${target.serviceId}.`,
      );
    }
    await unlinkInternal(
      paths.journal,
      requireJournalFile(current),
      guard,
      true,
    );
    previous = await readJournalFile(
      paths.previousJournal,
      target,
      expectedUid,
    );
    current = undefined;
  }
  if (current !== undefined) {
    if (!isJournalSuccessor(previous, current)) {
      throw new ServiceMacosDriftError(
        `Published journal is not a valid successor for ${target.serviceId}.`,
      );
    }
    if (next !== undefined) {
      const currentFile = requireJournalFile(current);
      const nextFile = requireJournalFile(next);
      if (
        !sameFileObject(currentFile, nextFile)
        || currentFile.identity?.links !== 2
        || nextFile.identity?.links !== 2
      ) {
        throw new ServiceMacosDriftError(
          `Partially published journal identity changed `
          + `for ${target.serviceId}.`,
        );
      }
      await unlinkInternal(
        paths.nextJournal,
        nextFile,
        guard,
        true,
      );
      current = await readJournalFile(
        paths.journal,
        target,
        expectedUid,
      );
    }
    const verified = await observeOwnerPrivatePlist(
      paths.journal,
      expectedUid,
    );
    if (!sameExactFile(requireJournalFile(current), verified)) {
      throw new ServiceMacosDriftError(
        `Recovered journal changed before prior cleanup `
        + `for ${target.serviceId}.`,
      );
    }
    await unlinkInternal(
      paths.previousJournal,
      requireJournalFile(previous),
      guard,
      false,
    );
    return current;
  }
  if (next !== undefined) {
    if (!isJournalSuccessor(previous, next)) {
      throw new ServiceMacosDriftError(
        `Pending journal is not a valid successor for ${target.serviceId}.`,
      );
    }
    const published = await moveNoClobber(
      paths.nextJournal,
      paths.journal,
      requireJournalFile(next),
      guard,
    );
    if (published === undefined) {
      throw new ServiceMacosDriftError(
        `Journal recovery destination is occupied for ${target.serviceId}.`,
      );
    }
    journalFiles.set(next, published);
    const verified = await observeOwnerPrivatePlist(
      paths.journal,
      expectedUid,
    );
    if (!sameExactFile(published, verified)) {
      throw new ServiceMacosDriftError(
        `Recovered journal changed before prior cleanup `
        + `for ${target.serviceId}.`,
      );
    }
    await unlinkInternal(
      paths.previousJournal,
      requireJournalFile(previous),
      guard,
      false,
    );
    return next;
  }
  const restored = await moveNoClobber(
    paths.previousJournal,
    paths.journal,
    requireJournalFile(previous),
    guard,
  );
  if (restored === undefined) {
    throw new ServiceMacosDriftError(
      `Journal rollback destination is occupied for ${target.serviceId}.`,
    );
  }
  journalFiles.set(previous, restored);
  return previous;
}

async function readJournalFile(
  path: string,
  target: ServiceMacosTarget,
  expectedUid: number,
  allowTwoLinks = false,
): Promise<TransactionJournal> {
  const options = allowTwoLinks ? { allowTwoLinks: true } : {};
  const before = await observeOwnerPrivatePlist(path, expectedUid, options);
  if (!before.exists) {
    throw new ServiceMacosDriftError(
      `Service transaction journal disappeared for ${target.serviceId}.`,
    );
  }
  const source = await readOwnerPrivateBounded(
    path,
    TRANSACTION_MAX_BYTES,
    expectedUid,
    allowTwoLinks,
  );
  const after = await observeOwnerPrivatePlist(path, expectedUid, options);
  if (!sameExactFile(before, after) || digest(source) !== before.digest) {
    throw new ServiceMacosDriftError(
      `Service transaction journal changed while read `
      + `for ${target.serviceId}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new ServiceMacosDriftError(
      `Service transaction journal is corrupt for ${target.serviceId}; `
      + "artifacts were retained.",
    );
  }
  if (!isRecord(value)) {
    throw new ServiceMacosDriftError(
      `Invalid service transaction journal for ${target.serviceId}.`,
    );
  }
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
    throw new ServiceMacosDriftError(
      `Service transaction journal contains unknown fields `
      + `for ${target.serviceId}.`,
    );
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
    || (
      value.desired !== undefined
      && !isDesiredDescriptor(value.desired)
    )
    || (
      value.published !== undefined
      && !isFileObservation(value.published)
    )
    || (
      value.operation === "apply"
      && !isDesiredDescriptor(value.desired)
    )
    || (
      value.operation === "remove"
      && (value.desired !== undefined || value.published !== undefined)
    )
  ) {
    throw new ServiceMacosDriftError(
      `Service transaction journal failed validation `
      + `for ${target.serviceId}.`,
    );
  }
  const journal = Object.freeze(
    value as unknown as TransactionJournal,
  );
  journalFiles.set(journal, after);
  return journal;
}
