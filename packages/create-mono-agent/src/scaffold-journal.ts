// SPDX-License-Identifier: MIT
import { join } from "node:path";

export const SCAFFOLD_JOURNAL_KIND = "mono-agent.scaffold-journal";
export const SCAFFOLD_JOURNAL_MAX_BYTES = 16 * 1024;

const LEGACY_LOCK_KIND = "mono-agent.scaffold-lock";
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface ScaffoldJournalHeader {
  readonly schemaVersion: 2;
  readonly kind: typeof SCAFFOLD_JOURNAL_KIND;
  readonly nonce: string;
  readonly ownerPid: number;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly targetName: string;
}

export type ScaffoldJournalFrame =
  | {
    readonly phase: "stage-created";
    readonly identity: FileIdentity;
  }
  | {
    readonly phase: "park-intent";
    readonly identity: FileIdentity;
  }
  | {
    readonly phase: "parked";
    readonly identity: FileIdentity;
  }
  | {
    readonly phase: "published";
    readonly identity: FileIdentity;
  }
  | {
    readonly phase: "committed";
  };

export interface ScaffoldJournalState {
  readonly header: ScaffoldJournalHeader;
  readonly stageIdentity?: FileIdentity;
  readonly parkIntentIdentity?: FileIdentity;
  readonly parkedIdentity?: FileIdentity;
  readonly publishedIdentity?: FileIdentity;
  readonly committed: boolean;
}

export function createScaffoldJournalHeader(
  parent: string,
  parentIdentity: FileIdentity,
  targetName: string,
  nonce: string,
  ownerPid = process.pid,
): ScaffoldJournalHeader {
  return Object.freeze({
    schemaVersion: 2,
    kind: SCAFFOLD_JOURNAL_KIND,
    nonce,
    ownerPid,
    parent,
    parentIdentity,
    targetName,
  });
}

export function scaffoldStagePath(
  parent: string,
  targetName: string,
  nonce: string,
): string {
  return join(parent, `.${targetName}.mono-agent-stage-${nonce}`);
}

export function scaffoldParkedPath(
  parent: string,
  targetName: string,
  nonce: string,
): string {
  return join(parent, `.${targetName}.mono-agent-parked-${nonce}`);
}

export function parseScaffoldJournal(
  bytes: Uint8Array,
  expectedParent: string,
  expectedParentIdentity: FileIdentity,
  expectedTargetName: string,
): ScaffoldJournalState {
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    throw new Error("Scaffold journal has no durable header.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(0, lastNewline + 1),
    );
  } catch (error) {
    throw new Error("Scaffold journal is not valid UTF-8.", { cause: error });
  }
  const durableLines = text.slice(0, -1).split("\n");
  if (durableLines.length < 1 || durableLines[0]?.length === 0) {
    throw new Error("Scaffold journal has no durable header.");
  }
  let values: unknown[];
  try {
    values = durableLines.map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    throw new Error("Scaffold journal contains invalid JSON.", { cause: error });
  }
  const header = parseHeader(
    values[0],
    expectedParent,
    expectedParentIdentity,
    expectedTargetName,
  );
  let stageIdentity: FileIdentity | undefined;
  let parkIntentIdentity: FileIdentity | undefined;
  let parkedIdentity: FileIdentity | undefined;
  let publishedIdentity: FileIdentity | undefined;
  let committed = false;

  for (const value of values.slice(1)) {
    if (!isRecord(value) || typeof value.phase !== "string" || committed) {
      throw new Error("Scaffold journal contains an invalid phase frame.");
    }
    if (value.phase === "stage-created") {
      if (
        stageIdentity !== undefined
        || !hasExactKeys(value, ["phase", "identity"])
      ) {
        throw new Error("Scaffold journal contains an invalid stage-created frame.");
      }
      stageIdentity = parseIdentity(value.identity, "stage-created identity");
      continue;
    }
    if (value.phase === "park-intent") {
      if (
        stageIdentity === undefined
        || parkIntentIdentity !== undefined
        || publishedIdentity !== undefined
        || !hasExactKeys(value, ["phase", "identity"])
      ) {
        throw new Error("Scaffold journal contains an invalid park-intent frame.");
      }
      parkIntentIdentity = parseIdentity(value.identity, "park-intent identity");
      continue;
    }
    if (value.phase === "parked") {
      if (
        parkIntentIdentity === undefined
        || parkedIdentity !== undefined
        || publishedIdentity !== undefined
        || !hasExactKeys(value, ["phase", "identity"])
      ) {
        throw new Error("Scaffold journal contains an invalid parked frame.");
      }
      parkedIdentity = parseIdentity(value.identity, "parked identity");
      if (!sameFileIdentity(parkedIdentity, parkIntentIdentity)) {
        throw new Error("Scaffold journal parked identity does not match its intent.");
      }
      continue;
    }
    if (value.phase === "published") {
      if (
        stageIdentity === undefined
        || publishedIdentity !== undefined
        || (parkIntentIdentity !== undefined && parkedIdentity === undefined)
        || !hasExactKeys(value, ["phase", "identity"])
      ) {
        throw new Error("Scaffold journal contains an invalid published frame.");
      }
      publishedIdentity = parseIdentity(value.identity, "published identity");
      if (!sameFileIdentity(publishedIdentity, stageIdentity)) {
        throw new Error("Scaffold journal published identity does not match its stage.");
      }
      continue;
    }
    if (value.phase === "committed") {
      if (
        publishedIdentity === undefined
        || !hasExactKeys(value, ["phase"])
      ) {
        throw new Error("Scaffold journal contains an invalid committed frame.");
      }
      committed = true;
      continue;
    }
    throw new Error("Scaffold journal contains an unsupported phase.");
  }

  return Object.freeze({
    header,
    ...(stageIdentity === undefined ? {} : { stageIdentity }),
    ...(parkIntentIdentity === undefined ? {} : { parkIntentIdentity }),
    ...(parkedIdentity === undefined ? {} : { parkedIdentity }),
    ...(publishedIdentity === undefined ? {} : { publishedIdentity }),
    committed,
  });
}

function parseHeader(
  value: unknown,
  expectedParent: string,
  expectedParentIdentity: FileIdentity,
  expectedTargetName: string,
): ScaffoldJournalHeader {
  if (
    isRecord(value)
    && value.schemaVersion === 1
    && value.kind === LEGACY_LOCK_KIND
  ) {
    throw new Error(
      "Stale scaffold lock schema version 1 cannot be recovered safely; remove it only after inspecting its stage.",
    );
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "nonce",
      "ownerPid",
      "parent",
      "parentIdentity",
      "targetName",
    ])
    || value.schemaVersion !== 2
    || value.kind !== SCAFFOLD_JOURNAL_KIND
    || typeof value.nonce !== "string"
    || !UUID_PATTERN.test(value.nonce)
    || !Number.isSafeInteger(value.ownerPid)
    || (value.ownerPid as number) < 1
    || value.parent !== expectedParent
    || value.targetName !== expectedTargetName
  ) {
    throw new Error("Scaffold journal has an invalid header.");
  }
  const parentIdentity = parseIdentity(
    value.parentIdentity,
    "journal parent identity",
  );
  if (!sameFileIdentity(parentIdentity, expectedParentIdentity)) {
    throw new Error("Scaffold journal parent authority does not match.");
  }
  return Object.freeze({
    schemaVersion: 2,
    kind: SCAFFOLD_JOURNAL_KIND,
    nonce: value.nonce,
    ownerPid: value.ownerPid as number,
    parent: expectedParent,
    parentIdentity,
    targetName: expectedTargetName,
  });
}

function parseIdentity(value: unknown, label: string): FileIdentity {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["device", "inode"])
    || !Number.isSafeInteger(value.device)
    || (value.device as number) < 0
    || !Number.isSafeInteger(value.inode)
    || (value.inode as number) < 1
  ) {
    throw new Error(`Scaffold journal ${label} is invalid.`);
  }
  return Object.freeze({
    device: value.device as number,
    inode: value.inode as number,
  });
}

function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}
