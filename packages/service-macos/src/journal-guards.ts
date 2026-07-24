import type { BigIntStats } from "node:fs";

import { ServiceMacosDriftError } from "./errors.js";
import { isRecord } from "./internal-fs.js";
import type { ServiceFileObservation } from "./service-types.js";

export type TransactionOperation = "apply" | "remove";
export type TransactionPhase =
  | "prepared"
  | "prior-quarantined"
  | "desired-linked"
  | "desired-published"
  | "committed";

export interface TransactionJournal {
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
    readonly readinessToken: string;
  };
  readonly published?: ServiceFileObservation;
}

export const journalFiles =
  new WeakMap<TransactionJournal, ServiceFileObservation>();

export function journalTargetLabel(journal: TransactionJournal): string {
  return `ai.mono-agent.${journal.serviceId}`;
}

export function sameExactFile(
  left: ServiceFileObservation,
  right: ServiceFileObservation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameRenamedFile(
  left: ServiceFileObservation,
  right: ServiceFileObservation,
): boolean {
  return sameFileObject(left, right)
    && left.identity?.links === right.identity?.links;
}

export function sameFileObject(
  left: ServiceFileObservation,
  right: ServiceFileObservation,
): boolean {
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

export function requireJournalFile(
  journal: TransactionJournal,
): ServiceFileObservation {
  const file = journalFiles.get(journal);
  if (file === undefined) {
    throw new ServiceMacosDriftError(
      `Journal identity is unavailable for ${journal.serviceId}.`,
    );
  }
  return file;
}

export function isJournalSuccessor(
  current: TransactionJournal,
  next: TransactionJournal,
): boolean {
  const validPhase =
    (
      current.phase === "prepared"
      && (
        next.phase === "prior-quarantined"
        || next.phase === "desired-linked"
        || next.phase === "committed"
      )
    )
    || (
      current.phase === "prior-quarantined"
      && (next.phase === "desired-linked" || next.phase === "committed")
    )
    || (
      current.phase === "desired-linked"
      && next.phase === "desired-published"
    )
    || (
      current.phase === "desired-published"
      && next.phase === "committed"
    );
  return validPhase
    && current.schemaVersion === next.schemaVersion
    && current.transactionId === next.transactionId
    && current.serviceId === next.serviceId
    && current.operation === next.operation
    && current.expectedLoaded === next.expectedLoaded
    && sameExactFile(current.expectedFile, next.expectedFile)
    && JSON.stringify(current.desired) === JSON.stringify(next.desired);
}

export function matchesDesired(
  desired: NonNullable<TransactionJournal["desired"]>,
  observation: ServiceFileObservation,
): boolean {
  return observation.exists
    && observation.digest === desired.digest
    && observation.bytes === desired.bytes
    && observation.identity !== undefined;
}

export function isKnownDesired(
  journal: TransactionJournal,
  observation: ServiceFileObservation,
  stage: ServiceFileObservation,
): boolean {
  if (
    journal.desired === undefined
    || !matchesDesired(journal.desired, observation)
  ) {
    return false;
  }
  if (
    journal.published !== undefined
    && sameFileObject(journal.published, observation)
  ) {
    return true;
  }
  return stage.exists && sameFileObject(stage, observation);
}

export function assertOwnerPrivatePlistStats(
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
      `${path} must be an owner-private regular plist `
      + `(mode 0600, uid ${String(expectedUid)}, bounded links and size).`,
    );
  }
}

export function assertUnchangedJournalFileIdentity(
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
    throw new Error(
      `${path} changed identity or metadata while it was opened.`,
    );
  }
}

export function isFileObservation(
  value: unknown,
): value is ServiceFileObservation {
  if (!isRecord(value) || typeof value.exists !== "boolean") return false;
  const keys = Object.keys(value);
  if (!value.exists) return keys.length === 1;
  if (
    keys.some(
      (key) => !["exists", "digest", "bytes", "identity"].includes(key),
    )
    || typeof value.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.digest)
    || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) < 0
    || !isRecord(value.identity)
  ) {
    return false;
  }
  const identity = value.identity;
  return Object.keys(identity).every(
    (key) => [
      "device",
      "inode",
      "ctimeNanoseconds",
      "uid",
      "mode",
      "links",
      "size",
    ].includes(key),
  )
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

export function isDesiredDescriptor(
  value: unknown,
): value is NonNullable<TransactionJournal["desired"]> {
  return isRecord(value)
    && Object.keys(value).every(
      (key) =>
        key === "digest"
        || key === "bytes"
        || key === "readinessToken",
    )
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/u.test(value.digest)
    && Number.isSafeInteger(value.bytes)
    && (value.bytes as number) >= 0
    && typeof value.readinessToken === "string"
    && /^[a-f0-9]{64}$/u.test(value.readinessToken);
}

export function isTransactionPhase(
  value: unknown,
): value is TransactionPhase {
  return value === "prepared"
    || value === "prior-quarantined"
    || value === "desired-linked"
    || value === "desired-published"
    || value === "committed";
}
