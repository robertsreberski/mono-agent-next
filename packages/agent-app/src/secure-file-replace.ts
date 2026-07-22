import { randomUUID } from "node:crypto";
import { constants, linkSync, renameSync, type BigIntStats, unlinkSync } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

type Awaitable<T> = T | Promise<T>;
type SecureFileIdentity = { readonly dev: bigint; readonly ino: bigint };
type ClaimValidationPhase = "current" | "claimed" | "pre-publish" | "published";
type RecoveryMode = "preserve-current" | "restore-previous";

export interface VerifiedFileSnapshot { readonly contents: Buffer; readonly details: BigIntStats }

export interface VerifiedFileReadOptions {
  readonly validate: (details: BigIntStats, path: string) => void; readonly changedError: (path: string) => Error;
}
interface SecureReplaceFailure { readonly cause: unknown; readonly recoveryPaths: readonly string[] }

type ExpectedTarget =
  | { readonly kind: "missing" }
  | {
      readonly kind: "present"; readonly claimPath?: string;
      readonly validate: (path: string, moved: boolean) => Awaitable<boolean>;
      readonly invalidError: () => Error;
      readonly mismatchRecovery?: (phase: ClaimValidationPhase) => RecoveryMode;
    };

interface TargetPublicationOptions {
  readonly expected: ExpectedTarget; readonly recovery: RecoveryMode;
  readonly beforeClaim?: (targetPath: string, temporaryPath: string) => Awaitable<void>;
  readonly beforePublish?: (targetPath: string, temporaryPath: string) => Awaitable<void>;
  readonly afterPublish?: (targetPath: string, temporaryPath: string) => Awaitable<void>;
  readonly protectRecovery?: (path: string) => Awaitable<void>;
  readonly makeError?: (failure: SecureReplaceFailure) => Error;
}

interface SecureFileReplaceOptions {
  readonly path: string; readonly contents: string | Buffer; readonly mode: number;
  readonly temporaryPath?: string;
  readonly validateTemporary?: (details: BigIntStats, path: string) => void;
  readonly beforeCommit?: (temporaryPath: string) => Awaitable<void>;
  readonly target: TargetPublicationOptions;
}

/** Read one pathname through a nonblocking descriptor and prove its final identity. */
export async function readVerifiedFile(path: string, options: VerifiedFileReadOptions): Promise<VerifiedFileSnapshot | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    options.validate(before, path);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    let named: BigIntStats;
    try {
      named = await lstat(path, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw options.changedError(path);
      throw error;
    }
    options.validate(after, path);
    options.validate(named, path);
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, named)) throw options.changedError(path);
    return { contents, details: after };
  } finally {
    await handle.close();
  }
}

/** Stage, compare-and-swap, recover, and final-prove one owner-private file. */
export async function secureFileReplace(options: SecureFileReplaceOptions): Promise<void> {
  const temporaryPath = options.temporaryPath
    ?? join(dirname(options.path), `.${basename(options.path)}.mono-agent-${randomUUID()}.tmp`);
  const expectedContents = typeof options.contents === "string"
    ? Buffer.from(options.contents, "utf8") : Buffer.from(options.contents);
  let handle: FileHandle | undefined;
  let identity: SecureFileIdentity | undefined;
  let temporaryCleanupPending = false;
  try {
    handle = await open(temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), options.mode);
    identity = fileIdentity(await handle.stat({ bigint: true }));
    temporaryCleanupPending = true;
    await handle.writeFile(expectedContents);
    await handle.chmod(options.mode);
    const details = await handle.stat({ bigint: true });
    assertSecureFile(details, temporaryPath, options.mode, [1]);
    options.validateTemporary?.(details, temporaryPath);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await options.beforeCommit?.(temporaryPath);
    const prove = (path: string, links?: readonly number[]) =>
      assertExactFile(path, identity!, options.mode, expectedContents, links);
    await prove(temporaryPath);
    await publishTarget(options.path, temporaryPath, prove, options.target);
    await removeExactTemporary(temporaryPath, identity);
    temporaryCleanupPending = false;
    await prove(options.path);
  } catch (error) {
    const failures: unknown[] = [error];
    try { await handle?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try {
      if (identity !== undefined && temporaryCleanupPending) await removeExactTemporary(temporaryPath, identity);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures,
        `Secure replacement failed (${errorMessage(error)}) and its exact temporary cleanup also failed.`,
        { cause: error });
    }
    throw error;
  }
}

async function publishTarget(targetPath: string, temporaryPath: string,
  prove: (path: string, allowedLinkCounts?: readonly number[]) => Promise<void>,
  options: TargetPublicationOptions): Promise<void> {
  const present = options.expected.kind === "present" ? options.expected : undefined;
  const artifactStem = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.mono-agent`);
  const claimPath = present?.claimPath ?? `${artifactStem}-previous`;
  const failedPath = `${artifactStem}-failed`;
  let claimActive = false;
  let published = false;
  let publishConflict = false;
  let mismatchPhase: ClaimValidationPhase | undefined;
  const invalid = (nextPhase: ClaimValidationPhase, error: () => Error): never => {
    mismatchPhase = nextPhase; throw error();
  };
  try {
    if (present !== undefined) {
      if (!await present.validate(targetPath, false)) invalid("current", present.invalidError);
    }
    await options.beforeClaim?.(targetPath, temporaryPath);
    if (present !== undefined) {
      renameSync(targetPath, claimPath);
      claimActive = true;
      if (!await present.validate(claimPath, true)) invalid("claimed", present.invalidError);
    }

    await prove(temporaryPath);
    await options.beforePublish?.(targetPath, temporaryPath);
    if (present !== undefined) {
      if (!await present.validate(claimPath, true)) invalid("pre-publish", present.invalidError);
    }
    await prove(temporaryPath);
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      publishConflict = isErrno(error, "EEXIST");
      throw error;
    }
    published = true;
    await options.afterPublish?.(targetPath, temporaryPath);
    await prove(temporaryPath, [2]);
    await prove(targetPath, [2]);
    if (present !== undefined) {
      const claimed = present.validate(claimPath, true);
      if (!(typeof claimed === "boolean" ? claimed : await claimed)) invalid("published", present.invalidError);
      unlinkSync(claimPath);
      claimActive = false;
    }
  } catch (cause) {
    const recoveryPaths: string[] = [];
    const recoveryFailures: unknown[] = [];
    const mode = mismatchPhase === undefined
      ? options.recovery
      : present?.mismatchRecovery?.(mismatchPhase) ?? options.recovery;

    if (mode === "preserve-current" && publishConflict && claimActive && present !== undefined) {
      let claimStillExpected = false;
      try {
        const stillExpected = present.validate(claimPath, true);
        claimStillExpected = typeof stillExpected === "boolean" ? stillExpected : await stillExpected;
      } catch {
        // An unprovable claim is retained as recovery evidence.
      }
      if (claimStillExpected) {
        try {
          unlinkSync(claimPath);
          claimActive = false;
        } catch (recoveryError) {
          if (isErrno(recoveryError, "ENOENT")) claimActive = false;
          else recoveryFailures.push(recoveryError);
        }
      }
    }
    if (mode === "restore-previous" && published) {
      try {
        renameSync(targetPath, failedPath);
        recoveryPaths.push(failedPath);
        published = false;
      } catch (recoveryError) {
        if (!isErrno(recoveryError, "ENOENT")) recoveryFailures.push(recoveryError);
        else published = false;
      }
    }
    if (mode === "restore-previous" && claimActive && present !== undefined) {
      try {
        linkSync(claimPath, targetPath);
        unlinkSync(claimPath);
        claimActive = false;
      } catch (recoveryError) {
        if (!isErrno(recoveryError, "EEXIST")) recoveryFailures.push(recoveryError);
      }
    }
    if (claimActive && present !== undefined) recoveryPaths.push(claimPath);
    for (const path of [...new Set(recoveryPaths)]) {
      try { await options.protectRecovery?.(path); } catch (recoveryError) { recoveryFailures.push(recoveryError); }
    }

    const uniqueRecoveryPaths = [...new Set(recoveryPaths)];
    const failure = { cause, recoveryPaths: uniqueRecoveryPaths } as const;
    const domainError = options.makeError?.(failure)
      ?? (cause instanceof Error ? cause : new Error(String(cause)));
    if (recoveryFailures.length > 0) {
      throw new AggregateError([domainError, ...recoveryFailures],
        `${domainError.message} Automatic publication recovery was incomplete.`, { cause: domainError });
    }
    throw domainError;
  }
}

async function assertExactFile(path: string, identity: SecureFileIdentity, mode: number,
  expectedContents: Buffer, allowedLinkCounts: readonly number[] = [1]): Promise<void> {
  const snapshot = await readVerifiedFile(path, {
    validate: (details) => assertSecureFile(details, path, mode, allowedLinkCounts),
    changedError: changedFile,
  });
  if (snapshot === undefined || !sameFileIdentity(snapshot.details, identity)) throw changedFile(path);
  if (!snapshot.contents.equals(expectedContents)) {
    throw new Error(`Secure replacement file ${path} contents changed during publication and was left untouched.`);
  }
}

function assertSecureFile(details: BigIntStats, path: string, mode: number,
  allowedLinkCounts: readonly number[]): void {
  if (!details.isFile() || details.isSymbolicLink()
    || !allowedLinkCounts.some((linkCount) => details.nlink === BigInt(linkCount))) {
    throw new Error(`Secure replacement file ${path} has an unexpected type or link count.`);
  }
  if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
    throw new Error(`Secure replacement file ${path} is not owned by the current user.`);
  }
  if ((details.mode & 0o777n) !== BigInt(mode)) {
    throw new Error(`Secure replacement file ${path} has mode ${(details.mode & 0o777n).toString(8)}; expected ${mode.toString(8)}.`);
  }
}

function fileIdentity(details: { readonly dev: bigint; readonly ino: bigint }): SecureFileIdentity {
  return { dev: details.dev, ino: details.ino };
}
function sameFileIdentity(details: SecureFileIdentity, identity: SecureFileIdentity): boolean {
  return details.dev === identity.dev && details.ino === identity.ino;
}
function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.uid === right.uid && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function changedFile(path: string): Error {
  return new Error(`Secure replacement file ${path} changed during publication and was left untouched.`);
}
async function removeExactTemporary(path: string, identity: SecureFileIdentity): Promise<void> {
  let details: BigIntStats;
  try {
    details = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!sameFileIdentity(details, identity)) {
    throw new Error(`Secure replacement temporary ${path} changed unexpectedly and was left untouched.`);
  }
  await unlink(path);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
