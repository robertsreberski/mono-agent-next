// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";

import {
  SCAFFOLD_JOURNAL_MAX_BYTES,
  createScaffoldJournalHeader,
  parseScaffoldJournal,
  scaffoldParkedPath,
  scaffoldStagePath,
  type FileIdentity,
  type ScaffoldJournalFrame,
  type ScaffoldJournalState,
} from "./scaffold-journal.ts";

interface LockCandidate {
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

interface ExistingScaffoldLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly targetPath: string;
  readonly stagePath: string;
  readonly parkedPath: string;
  readonly candidatePath: string;
  readonly abandonedPath: string;
  readonly state: ScaffoldJournalState;
}

interface StaleScaffoldRecovery {
  readonly retainedRecoveryPaths: readonly string[];
  readonly publishedTargetRecovered: boolean;
}

class RetryScaffoldLockAcquisition extends Error {}

export interface ScaffoldLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  readonly nonce: string;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly targetPath: string;
  readonly stagePath: string;
  readonly parkedPath: string;
  readonly abandonedPath: string;
  readonly retainedRecoveryPaths: readonly string[];
  readonly publishedTargetRecovered: boolean;
}

export interface ScaffoldStage {
  readonly path: string;
  readonly identity: FileIdentity;
}

export interface ScaffoldLockRecoveryHooks {
  readonly beforeCanonicalJournalRemoval?: () => Promise<void>;
  readonly afterCanonicalJournalRemoval?: () => Promise<void>;
}

export async function acquireScaffoldLock(
  parent: string,
  targetName: string,
  recoveryHooks: ScaffoldLockRecoveryHooks = {},
): Promise<ScaffoldLock> {
  const parentDetails = await lstat(parent);
  assertAuthorityDirectory(parentDetails, "scaffold parent");
  const parentIdentity = identityOf(parentDetails);
  const path = join(parent, `.${targetName}.mono-agent-scaffold.lock`);
  const targetPath = join(parent, targetName);
  const retainedRecoveryPaths: string[] = [];
  let publishedTargetRecovered = false;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertDirectoryIdentity(
      parent,
      parentIdentity,
      "scaffold parent",
      "authority",
    );
    await restoreAbandonedJournalCanonicalAlias(
      path,
      parent,
      parentIdentity,
    );
    const nonce = randomUUID().toLowerCase();
    const candidate = `${path}.candidate-${nonce}`;
    const lockCandidate = await createLockCandidate(
      candidate,
      createScaffoldJournalHeader(
        parent,
        parentIdentity,
        targetName,
        nonce,
      ),
      parent,
      parentIdentity,
    );
    try {
      await link(candidate, path);
    } catch (error) {
      try {
        await discardLockCandidate(
          candidate,
          lockCandidate,
          parent,
          parentIdentity,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Scaffold lock candidate cleanup failed",
        );
      }
      if (!hasCode(error, "EEXIST")) throw error;
      try {
        const recovered = await inspectExistingScaffoldLock(
          path,
          parent,
          parentIdentity,
          targetName,
          recoveryHooks,
        );
        retainedRecoveryPaths.push(...recovered.retainedRecoveryPaths);
        publishedTargetRecovered ||= recovered.publishedTargetRecovered;
      } catch (existingError) {
        if (
          hasCode(existingError, "ENOENT")
          || existingError instanceof RetryScaffoldLockAcquisition
        ) {
          continue;
        }
        throw existingError;
      }
      continue;
    }

    let candidateRemoved = false;
    try {
      const locked = await lstat(path);
      assertOwnerPrivateFile(locked, "scaffold lock");
      if (!sameFileIdentity(identityOf(locked), lockCandidate.identity)) {
        throw new Error("Scaffold lock changed identity while it was acquired.");
      }
      if (await lstatOrUndefined(scaffoldAbandonedPath(path)) !== undefined) {
        throw new Error(
          `An orphaned scaffold journal abandonment marker requires manual inspection: ${scaffoldAbandonedPath(path)}`,
        );
      }
      await removeExactFile(
        candidate,
        lockCandidate.identity,
        parent,
        parentIdentity,
        "scaffold lock candidate",
      );
      candidateRemoved = true;
      await syncDirectory(parent);
      return Object.freeze({
        path,
        handle: lockCandidate.handle,
        identity: lockCandidate.identity,
        nonce,
        parent,
        parentIdentity,
        targetPath,
        stagePath: scaffoldStagePath(parent, targetName, nonce),
        parkedPath: scaffoldParkedPath(parent, targetName, nonce),
        abandonedPath: scaffoldAbandonedPath(path),
        retainedRecoveryPaths: Object.freeze([...retainedRecoveryPaths]),
        publishedTargetRecovered,
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (!candidateRemoved) {
        try {
          await removeExactFile(
            candidate,
            lockCandidate.identity,
            parent,
            parentIdentity,
            "scaffold lock candidate",
          );
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await removeExactFile(
          path,
          lockCandidate.identity,
          parent,
          parentIdentity,
          "scaffold lock",
        );
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        await lockCandidate.handle.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      throw cleanupFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupFailures],
            "Scaffold lock acquisition cleanup failed",
          );
    }
  }
  throw new Error(`Scaffold lock acquisition did not converge: ${path}`);
}

export async function createScaffoldStage(
  lock: ScaffoldLock,
): Promise<ScaffoldStage> {
  await assertScaffoldLock(lock);
  await mkdir(lock.stagePath, { mode: 0o700 });
  const details = await lstat(lock.stagePath);
  assertOwnerPrivateDirectory(details, "scaffold stage");
  await syncDirectory(lock.parent);
  const stage = Object.freeze({
    path: lock.stagePath,
    identity: identityOf(details),
  });
  try {
    await appendScaffoldJournal(lock, Object.freeze({
      phase: "stage-created",
      identity: stage.identity,
    }));
  } catch (error) {
    try {
      await removeExactDirectory(
        stage.path,
        stage.identity,
        lock.parent,
        lock.parentIdentity,
        "scaffold stage",
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Scaffold stage journal cleanup failed",
      );
    }
    throw error;
  }
  return stage;
}

export async function prepareScaffoldTargetParking(
  lock: ScaffoldLock,
): Promise<FileIdentity> {
  const identity = await currentParkableTargetIdentity(lock);
  await appendScaffoldJournal(lock, Object.freeze({
    phase: "park-intent",
    identity,
  }));
  return identity;
}

export async function assertScaffoldTargetParkingReady(
  lock: ScaffoldLock,
  identity: FileIdentity,
): Promise<void> {
  const currentIdentity = await currentParkableTargetIdentity(lock);
  if (!sameFileIdentity(currentIdentity, identity)) {
    throw new Error("Existing scaffold target changed identity before parking.");
  }
}

export async function recordScaffoldTargetParked(
  lock: ScaffoldLock,
  identity: FileIdentity,
): Promise<void> {
  await assertScaffoldLock(lock);
  if (await lstatOrUndefined(lock.targetPath) !== undefined) {
    throw new Error("Scaffold target reappeared while its empty inode was parked.");
  }
  await assertEmptyDirectory(
    lock.parkedPath,
    identity,
    "parked scaffold target",
    "authority",
  );
  await syncDirectory(lock.parent);
  await appendScaffoldJournal(lock, Object.freeze({
    phase: "parked",
    identity,
  }));
}

export async function recordScaffoldPublished(
  lock: ScaffoldLock,
  stage: ScaffoldStage,
  beforeJournal?: () => Promise<void>,
): Promise<void> {
  await assertScaffoldLock(lock);
  if (await lstatOrUndefined(stage.path) !== undefined) {
    throw new Error("Scaffold stage still exists after publication.");
  }
  await assertScaffoldStage(lock, stage, lock.targetPath);
  await syncDirectory(lock.parent);
  await beforeJournal?.();
  await appendScaffoldJournal(lock, Object.freeze({
    phase: "published",
    identity: stage.identity,
  }));
}

export async function commitScaffoldJournal(
  lock: ScaffoldLock,
): Promise<void> {
  await appendScaffoldJournal(lock, Object.freeze({ phase: "committed" }));
}

export type ParkedDirectoryRemover = (path: string) => Promise<void>;

export async function removeOrRetainParkedScaffoldTarget(
  lock: ScaffoldLock,
  identity: FileIdentity,
  remover: ParkedDirectoryRemover = rmdir,
): Promise<readonly string[]> {
  await assertScaffoldLock(lock);
  await assertEmptyDirectory(
    lock.parkedPath,
    identity,
    "parked scaffold target",
    "authority",
  );
  try {
    await remover(lock.parkedPath);
  } catch (error) {
    const remaining = await lstatOrUndefined(lock.parkedPath);
    if (remaining === undefined) {
      await syncDirectory(lock.parent);
      return Object.freeze([]);
    }
    try {
      await assertEmptyDirectory(
        lock.parkedPath,
        identity,
        "retained parked scaffold target",
        "authority",
      );
    } catch (validationError) {
      throw new AggregateError(
        [error, validationError],
        `Parked scaffold target cleanup became unsafe: ${lock.parkedPath}`,
      );
    }
    return Object.freeze([lock.parkedPath]);
  }
  if (await lstatOrUndefined(lock.parkedPath) !== undefined) {
    throw new Error("Parked scaffold target cleanup did not remove its path.");
  }
  await syncDirectory(lock.parent);
  return Object.freeze([]);
}

export async function restoreParkedScaffoldTarget(
  lock: ScaffoldLock,
  identity: FileIdentity,
): Promise<void> {
  await assertScaffoldLock(lock);
  if (await lstatOrUndefined(lock.targetPath) !== undefined) {
    throw new Error("Scaffold target is occupied; exact parked target was retained.");
  }
  await assertEmptyDirectory(
    lock.parkedPath,
    identity,
    "parked scaffold target",
    "authority",
  );
  await rename(lock.parkedPath, lock.targetPath);
  await assertEmptyDirectory(
    lock.targetPath,
    identity,
    "restored scaffold target",
    "authority",
  );
  await syncDirectory(lock.parent);
}

async function currentParkableTargetIdentity(
  lock: ScaffoldLock,
): Promise<FileIdentity> {
  await assertScaffoldLock(lock);
  const details = await lstat(lock.targetPath);
  assertAuthorityDirectory(details, "existing scaffold target");
  const identity = identityOf(details);
  await assertEmptyDirectory(
    lock.targetPath,
    identity,
    "existing scaffold target",
    "authority",
  );
  if (await lstatOrUndefined(lock.parkedPath) !== undefined) {
    throw new Error(`Scaffold parked path already exists: ${lock.parkedPath}`);
  }
  return identity;
}

export async function removeScaffoldStage(
  lock: ScaffoldLock,
  stage: ScaffoldStage,
): Promise<void> {
  await assertScaffoldLock(lock);
  await removeExactDirectory(
    stage.path,
    stage.identity,
    lock.parent,
    lock.parentIdentity,
    "scaffold stage",
  );
}

export async function assertScaffoldLock(
  lock: ScaffoldLock,
): Promise<void> {
  await assertDirectoryIdentity(
    lock.parent,
    lock.parentIdentity,
    "scaffold parent",
    "authority",
  );
  await assertScaffoldLockHandle(lock);
  const details = await lstat(lock.path);
  assertOwnerPrivateFile(details, "scaffold lock");
  if (!sameFileIdentity(identityOf(details), lock.identity)) {
    throw new Error("Scaffold lock changed identity.");
  }
}

export async function assertScaffoldStage(
  lock: ScaffoldLock,
  stage: ScaffoldStage,
  path = stage.path,
): Promise<void> {
  await assertScaffoldLock(lock);
  const details = await lstat(path);
  assertOwnerPrivateDirectory(details, "scaffold stage");
  if (!sameFileIdentity(identityOf(details), stage.identity)) {
    throw new Error("Scaffold stage changed identity.");
  }
}

export async function releaseScaffoldLock(lock: ScaffoldLock): Promise<void> {
  await withClosedFileHandle(
    lock.handle,
    async () => {
      await assertScaffoldLockHandle(lock);
      await removeExactFile(
        lock.path,
        lock.identity,
        lock.parent,
        lock.parentIdentity,
        "scaffold lock",
      );
    },
    "Scaffold lock release failed",
  );
}

export async function retainScaffoldLockForRecovery(
  lock: ScaffoldLock,
): Promise<void> {
  await withClosedFileHandle(
    lock.handle,
    async () => {
      await assertScaffoldLock(lock);
      try {
        await link(lock.path, lock.abandonedPath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      const abandoned = await lstat(lock.abandonedPath);
      assertOwnerPrivateFile(abandoned, "abandoned scaffold journal");
      if (!sameFileIdentity(identityOf(abandoned), lock.identity)) {
        throw new Error("Abandoned scaffold journal changed identity.");
      }
      await syncDirectory(lock.parent);
    },
    "Scaffold journal abandonment failed",
  );
}

async function appendScaffoldJournal(
  lock: ScaffoldLock,
  frame: ScaffoldJournalFrame,
): Promise<void> {
  await assertScaffoldLock(lock);
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  const before = await lock.handle.stat();
  if (before.size + bytes.byteLength > SCAFFOLD_JOURNAL_MAX_BYTES) {
    throw new Error("Scaffold journal exceeds its byte bound.");
  }
  await writeFully(lock.handle, bytes);
  await lock.handle.sync();
  const after = await lock.handle.stat();
  const current = await lstat(lock.path);
  assertOwnerPrivateFile(after, "scaffold journal");
  assertOwnerPrivateFile(current, "scaffold journal");
  if (
    !sameIdentity(before, after)
    || !sameIdentity(after, current)
    || after.size !== before.size + bytes.byteLength
  ) {
    throw new Error("Scaffold journal changed while a phase was appended.");
  }
}

async function createLockCandidate(
  path: string,
  record: unknown,
  parent: string,
  parentIdentity: FileIdentity,
): Promise<LockCandidate> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let candidate: LockCandidate | undefined;
  try {
    const details = await handle.stat();
    candidate = Object.freeze({
      handle,
      identity: identityOf(details),
    });
    assertOwnerPrivateFile(details, "scaffold lock candidate");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > SCAFFOLD_JOURNAL_MAX_BYTES) {
      throw new Error("Scaffold journal header exceeds its byte bound.");
    }
    await writeFully(handle, bytes);
    await handle.sync();
    const after = await handle.stat();
    if (!sameFileIdentity(identityOf(after), candidate.identity)) {
      throw new Error("Scaffold lock candidate changed identity.");
    }
    return candidate;
  } catch (error) {
    if (candidate === undefined) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    try {
      await discardLockCandidate(
        path,
        candidate,
        parent,
        parentIdentity,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Scaffold lock candidate creation cleanup failed",
      );
    }
    throw error;
  }
}

async function discardLockCandidate(
  path: string,
  candidate: LockCandidate,
  parent: string,
  parentIdentity: FileIdentity,
): Promise<void> {
  await withClosedFileHandle(
    candidate.handle,
    () => removeExactFile(
      path,
      candidate.identity,
      parent,
      parentIdentity,
      "scaffold lock candidate",
    ),
    "Scaffold lock candidate disposal failed",
  );
}

async function assertScaffoldLockHandle(
  lock: ScaffoldLock,
): Promise<void> {
  const held = await lock.handle.stat();
  assertOwnerPrivateFile(held, "scaffold lock");
  if (!sameFileIdentity(identityOf(held), lock.identity)) {
    throw new Error("Scaffold lock handle changed identity.");
  }
}

async function inspectExistingScaffoldLock(
  path: string,
  parent: string,
  parentIdentity: FileIdentity,
  targetName: string,
  recoveryHooks: ScaffoldLockRecoveryHooks,
): Promise<StaleScaffoldRecovery> {
  const existing = await readScaffoldLock(
    path,
    parent,
    parentIdentity,
    targetName,
  );
  return withClosedFileHandle(
    existing.handle,
    async () => {
      const abandoned = await isScaffoldJournalAbandoned(existing);
      if (!abandoned && pidIsAlive(existing.state.header.ownerPid)) {
        throw new Error(
          `Another scaffold operation owns the target; lock: ${path}`,
        );
      }
      return recoverStaleScaffoldLock(existing, recoveryHooks);
    },
    "Existing scaffold lock inspection failed",
  );
}

async function readScaffoldLock(
  path: string,
  parent: string,
  parentIdentity: FileIdentity,
  targetName: string,
): Promise<ExistingScaffoldLock> {
  await assertDirectoryIdentity(
    parent,
    parentIdentity,
    "scaffold parent",
    "authority",
  );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    assertOwnerPrivateFile(before, `scaffold lock ${path}`);
    if (before.size < 1 || before.size > SCAFFOLD_JOURNAL_MAX_BYTES) {
      throw new Error(`Scaffold lock has an invalid size: ${path}`);
    }
    const bytes = await readBounded(handle, SCAFFOLD_JOURNAL_MAX_BYTES);
    const after = await handle.stat();
    const current = await lstat(path);
    assertOwnerPrivateFile(current, `scaffold lock ${path}`);
    if (
      !sameIdentity(before, after)
      || !sameIdentity(after, current)
      || after.size !== bytes.byteLength
    ) {
      throw new RetryScaffoldLockAcquisition(
        `Scaffold lock changed while it was read: ${path}`,
      );
    }
    const state = parseScaffoldJournal(
      bytes,
      parent,
      parentIdentity,
      targetName,
    );
    return Object.freeze({
      path,
      handle,
      identity: identityOf(after),
      parent,
      parentIdentity,
      targetPath: join(parent, targetName),
      stagePath: scaffoldStagePath(parent, targetName, state.header.nonce),
      parkedPath: scaffoldParkedPath(parent, targetName, state.header.nonce),
      candidatePath: `${path}.candidate-${state.header.nonce}`,
      abandonedPath: scaffoldAbandonedPath(path),
      state,
    });
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Scaffold lock read cleanup failed",
      );
    }
    throw error;
  }
}

async function recoverStaleScaffoldLock(
  lock: Awaited<ReturnType<typeof readScaffoldLock>>,
  recoveryHooks: ScaffoldLockRecoveryHooks,
): Promise<StaleScaffoldRecovery> {
  await assertDirectoryIdentity(
    lock.parent,
    lock.parentIdentity,
    "scaffold parent",
    "authority",
  );
  const retained: string[] = [];
  const stageDetails = await lstatOrUndefined(lock.stagePath);
  const targetDetails = await lstatOrUndefined(lock.targetPath);
  const parkedDetails = await lstatOrUndefined(lock.parkedPath);
  const stageIdentity = lock.state.stageIdentity;
  const physicallyPublished = (
    stageIdentity !== undefined
    && targetDetails !== undefined
    && sameFileIdentity(identityOf(targetDetails), stageIdentity)
  );
  if (lock.state.publishedIdentity !== undefined || physicallyPublished) {
    if (stageIdentity === undefined || !physicallyPublished) {
      throw journalRecoveryError(
        lock,
        "Published scaffold target does not match its journaled stage",
      );
    }
    await assertDirectoryIdentity(
      lock.targetPath,
      stageIdentity,
      "published scaffold target",
      "private",
    );
    if (stageDetails !== undefined) {
      throw journalRecoveryError(
        lock,
        "Published scaffold still has a stage path",
      );
    }
    if (lock.state.parkIntentIdentity === undefined) {
      if (parkedDetails !== undefined) {
        throw journalRecoveryError(
          lock,
          "Unexpected parked path accompanies an absent-target publication",
        );
      }
    } else if (parkedDetails !== undefined) {
      const retainedParked = await removeOrRetainRecoveredParkedTarget(
        lock,
        lock.state.parkIntentIdentity,
      );
      retained.push(...retainedParked);
    }
    await retireRecoveredScaffoldJournal(lock, recoveryHooks);
    return Object.freeze({
      retainedRecoveryPaths: Object.freeze(retained),
      publishedTargetRecovered: true,
    });
  }

  if (lock.state.parkIntentIdentity !== undefined) {
    const parkedIdentity = lock.state.parkIntentIdentity;
    if (parkedDetails !== undefined) {
      await assertEmptyDirectory(
        lock.parkedPath,
        parkedIdentity,
        "parked scaffold target",
        "authority",
      );
      if (targetDetails !== undefined) {
        throw journalRecoveryError(
          lock,
          "A target competitor prevents exact parked-target restoration",
        );
      }
      await rename(lock.parkedPath, lock.targetPath);
      await assertEmptyDirectory(
        lock.targetPath,
        parkedIdentity,
        "restored scaffold target",
        "authority",
      );
      await syncDirectory(lock.parent);
    } else {
      if (targetDetails === undefined) {
        throw journalRecoveryError(
          lock,
          "The journaled empty target is no longer recoverable",
        );
      }
      await assertEmptyDirectory(
        lock.targetPath,
        parkedIdentity,
        "unmoved scaffold target",
        "authority",
      );
    }
  } else {
    if (parkedDetails !== undefined) {
      throw journalRecoveryError(
        lock,
        "An unjournaled parked scaffold target exists",
      );
    }
    if (targetDetails !== undefined) {
      const targetIdentity = identityOf(targetDetails);
      await assertEmptyDirectory(
        lock.targetPath,
        targetIdentity,
        "existing scaffold target",
        "authority",
      );
    }
  }

  if (stageIdentity === undefined) {
    if (stageDetails !== undefined) {
      assertOwnerPrivateDirectory(stageDetails, "unjournaled scaffold stage");
      retained.push(lock.stagePath);
    }
  } else {
    if (stageDetails === undefined) {
      throw journalRecoveryError(
        lock,
        "Journaled scaffold stage disappeared before publication",
      );
    }
    await assertDirectoryIdentity(
      lock.stagePath,
      stageIdentity,
      "stale scaffold stage",
      "private",
    );
    retained.push(lock.stagePath);
  }
  await retireRecoveredScaffoldJournal(lock, recoveryHooks);
  return Object.freeze({
    retainedRecoveryPaths: Object.freeze(retained),
    publishedTargetRecovered: false,
  });
}

async function retireRecoveredScaffoldJournal(
  lock: ExistingScaffoldLock,
  recoveryHooks: ScaffoldLockRecoveryHooks,
): Promise<void> {
  await discardStaleCandidate(lock);
  await recoveryHooks.beforeCanonicalJournalRemoval?.();
  await removeExactFile(
    lock.path,
    lock.identity,
    lock.parent,
    lock.parentIdentity,
    "stale scaffold lock",
  );
  await recoveryHooks.afterCanonicalJournalRemoval?.();
  await discardAbandonedJournalAlias(lock);
}

async function discardStaleCandidate(
  lock: ExistingScaffoldLock,
): Promise<void> {
  const candidateDetails = await lstatOrUndefined(lock.candidatePath);
  if (candidateDetails !== undefined) {
    assertOwnerPrivateFile(candidateDetails, "stale scaffold lock candidate");
    if (!sameFileIdentity(identityOf(candidateDetails), lock.identity)) {
      throw new Error("Stale scaffold lock candidate has an unknown identity.");
    }
    await removeExactFile(
      lock.candidatePath,
      lock.identity,
      lock.parent,
      lock.parentIdentity,
      "stale scaffold lock candidate",
    );
  }
}

async function discardAbandonedJournalAlias(
  lock: ExistingScaffoldLock,
): Promise<void> {
  const abandonedDetails = await lstatOrUndefined(lock.abandonedPath);
  if (abandonedDetails !== undefined) {
    assertOwnerPrivateFile(
      abandonedDetails,
      "abandoned scaffold recovery journal",
    );
    if (!sameFileIdentity(identityOf(abandonedDetails), lock.identity)) {
      throw new Error(
        "Abandoned scaffold recovery journal has an unknown identity.",
      );
    }
    await removeExactFile(
      lock.abandonedPath,
      lock.identity,
      lock.parent,
      lock.parentIdentity,
      "abandoned scaffold recovery journal",
    );
  }
}

async function restoreAbandonedJournalCanonicalAlias(
  lockPath: string,
  parent: string,
  parentIdentity: FileIdentity,
): Promise<void> {
  const abandonedPath = scaffoldAbandonedPath(lockPath);
  const abandoned = await lstatOrUndefined(abandonedPath);
  if (abandoned === undefined) return;
  assertOwnerPrivateFile(abandoned, "abandoned scaffold recovery journal");
  if (await lstatOrUndefined(lockPath) !== undefined) return;
  await assertDirectoryIdentity(
    parent,
    parentIdentity,
    "scaffold parent",
    "authority",
  );
  try {
    await link(abandonedPath, lockPath);
  } catch (error) {
    if (hasCode(error, "EEXIST")) return;
    throw error;
  }
  const restored = await lstat(lockPath);
  assertOwnerPrivateFile(restored, "restored scaffold recovery journal");
  if (!sameIdentity(restored, abandoned)) {
    throw new Error("Restored scaffold recovery journal changed identity.");
  }
  await syncDirectory(parent);
}

async function isScaffoldJournalAbandoned(
  lock: ExistingScaffoldLock,
): Promise<boolean> {
  const details = await lstatOrUndefined(lock.abandonedPath);
  if (details === undefined) return false;
  assertOwnerPrivateFile(details, "abandoned scaffold recovery journal");
  if (!sameFileIdentity(identityOf(details), lock.identity)) {
    throw new Error(
      "Abandoned scaffold recovery journal has an unknown identity.",
    );
  }
  return true;
}

async function removeOrRetainRecoveredParkedTarget(
  lock: ExistingScaffoldLock,
  identity: FileIdentity,
): Promise<readonly string[]> {
  await assertEmptyDirectory(
    lock.parkedPath,
    identity,
    "parked scaffold target",
    "authority",
  );
  try {
    await rmdir(lock.parkedPath);
    await syncDirectory(lock.parent);
    return Object.freeze([]);
  } catch (error) {
    try {
      await assertEmptyDirectory(
        lock.parkedPath,
        identity,
        "retained parked scaffold target",
        "authority",
      );
    } catch (validationError) {
      throw new AggregateError(
        [error, validationError],
        `Recovered parked scaffold target cleanup became unsafe: ${lock.parkedPath}`,
      );
    }
    return Object.freeze([lock.parkedPath]);
  }
}

function journalRecoveryError(
  lock: ExistingScaffoldLock,
  message: string,
): Error {
  return new Error(
    `${message}; journal=${lock.path}; target=${lock.targetPath}; stage=${lock.stagePath}; parked=${lock.parkedPath}.`,
  );
}

function scaffoldAbandonedPath(lockPath: string): string {
  return `${lockPath}.abandoned`;
}

async function removeExactDirectory(
  path: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<void> {
  const quarantine = await quarantineExactDirectory(
    path,
    identity,
    parent,
    parentIdentity,
    label,
  );
  await rm(quarantine, { recursive: true, force: false });
  await syncDirectory(parent);
}

async function quarantineExactDirectory(
  path: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<string> {
  const details = await lstatOrUndefined(path);
  if (details === undefined) {
    throw new RetryScaffoldLockAcquisition(`${label} disappeared.`);
  }
  assertOwnerPrivateDirectory(details, label);
  if (!sameFileIdentity(identityOf(details), identity)) {
    throw new Error(`${label} changed identity.`);
  }
  await assertDirectoryIdentity(parent, parentIdentity, "scaffold parent");
  const quarantine = join(
    parent,
    `.${basename(path).replace(/^\./u, "")}.recovered-${randomUUID().toLowerCase()}`,
  );
  if (await lstatOrUndefined(quarantine) !== undefined) {
    throw new Error(`${label} recovery path already exists: ${quarantine}`);
  }
  await rename(path, quarantine);
  const moved = await lstat(quarantine);
  assertOwnerPrivateDirectory(moved, label);
  if (!sameFileIdentity(identityOf(moved), identity)) {
    throw new Error(`${label} changed identity during quarantine.`);
  }
  await syncDirectory(parent);
  return quarantine;
}

async function removeExactFile(
  path: string,
  identity: FileIdentity,
  parent: string,
  parentIdentity: FileIdentity,
  label: string,
): Promise<void> {
  const details = await lstatOrUndefined(path);
  if (details === undefined) {
    throw new RetryScaffoldLockAcquisition(`${label} disappeared.`);
  }
  assertOwnerPrivateFile(details, label);
  if (!sameFileIdentity(identityOf(details), identity)) {
    throw new Error(`${label} changed identity.`);
  }
  await assertDirectoryIdentity(parent, parentIdentity, "scaffold parent");
  const archive = `${path}.released-${randomUUID().toLowerCase()}`;
  if (await lstatOrUndefined(archive) !== undefined) {
    throw new Error(`${label} release path already exists: ${archive}`);
  }
  await rename(path, archive);
  const moved = await lstat(archive);
  assertOwnerPrivateFile(moved, label);
  if (!sameFileIdentity(identityOf(moved), identity)) {
    throw new Error(`${label} changed identity during release.`);
  }
  await unlink(archive);
  await syncDirectory(parent);
}

async function withClosedFileHandle<T>(
  handle: FileHandle,
  operation: () => Promise<T>,
  cleanupMessage: string,
): Promise<T> {
  let operationFailed = false;
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, closeError],
          cleanupMessage,
        );
      }
      throw closeError;
    }
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maximumBytes) {
    throw new Error("Scaffold lock exceeds its byte bound.");
  }
  return new Uint8Array(buffer.subarray(0, offset));
}

async function assertDirectoryIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
  privacy?: "authority" | "private",
): Promise<void> {
  const details = await lstat(path);
  assertRealDirectory(details, label);
  if (privacy === "authority") assertAuthorityDirectory(details, label);
  if (privacy === "private") assertOwnerPrivate(details, label);
  if (!sameFileIdentity(identityOf(details), expected)) {
    throw new Error(`${label} changed identity.`);
  }
}

async function assertEmptyDirectory(
  path: string,
  expected: FileIdentity,
  label: string,
  privacy: "authority" | "private",
): Promise<void> {
  await assertDirectoryIdentity(path, expected, label, privacy);
  if ((await readdir(path)).length !== 0) {
    throw new Error(`${label} is not empty.`);
  }
  await assertDirectoryIdentity(path, expected, label, privacy);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

function assertRealDirectory(details: Stats, label: string): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function assertAuthorityDirectory(details: Stats, label: string): void {
  assertRealDirectory(details, label);
  assertOwner(details, label, 0o022);
}

function assertOwnerPrivateDirectory(details: Stats, label: string): void {
  assertRealDirectory(details, label);
  assertOwnerPrivate(details, label);
}

function assertOwnerPrivateFile(details: Stats, label: string): void {
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  assertOwnerPrivate(details, label);
}

function assertOwnerPrivate(details: Stats, label: string): void {
  assertOwner(details, label, 0o077);
}

function assertOwner(
  details: Stats,
  label: string,
  forbiddenMode: number,
): void {
  if (typeof process.getuid !== "function") return;
  if (details.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  if ((details.mode & forbiddenMode) !== 0) {
    throw new Error(
      forbiddenMode === 0o077
        ? `${label} must not grant group or other permissions.`
        : `${label} must not grant group or other write permissions.`,
    );
  }
}

function identityOf(details: Stats): FileIdentity {
  return Object.freeze({ device: details.dev, inode: details.ino });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function writeFully(
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (result.bytesWritten < 1) {
      throw new Error("Scaffold journal write made no progress.");
    }
    offset += result.bytesWritten;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}
