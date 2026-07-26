// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { WebProductError } from "./errors.js";

export const ACTIVE_TURN_DIRECTORY = ".active-turns";
export const ACTIVE_TURN_JOURNAL_LIMITS = Object.freeze({
  maxActiveTurns: 32,
  maxBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRecords: 131_072,
});

export interface ActiveTurnJournalLimits {
  readonly maxActiveTurns: number;
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRecords: number;
}

export interface ActiveTurnJournalHeader {
  readonly kind: "mono-agent-web-active-turn";
  readonly version: 1;
  readonly threadId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly baseRevision: number;
}

export interface RawActiveTurnJournal {
  readonly name: string;
  readonly content: Buffer;
}

interface JournalMetadata {
  readonly header: ActiveTurnJournalHeader;
  readonly name: string;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  bytes: number;
  records: number;
}

interface JournalFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

export class JournalCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super("Active-turn journal durability could not be proven.", { cause });
    this.name = "JournalCommitUncertainError";
  }
}

export class ActiveTurnJournalDirectory {
  readonly path: string;
  readonly limits: ActiveTurnJournalLimits;
  private readonly journals = new Map<string, JournalMetadata>();
  private readonly knownFiles = new Map<string, JournalFileIdentity>();
  private totalBytes = 0;

  private constructor(
    private readonly stateDirectory: string,
    limits: ActiveTurnJournalLimits,
    private readonly afterRecordWrite: (() => void | Promise<void>) | undefined,
  ) {
    this.path = join(stateDirectory, ACTIVE_TURN_DIRECTORY);
    this.limits = limits;
  }

  static async open(
    stateDirectory: string,
    limits: ActiveTurnJournalLimits = ACTIVE_TURN_JOURNAL_LIMITS,
    afterRecordWrite?: () => void | Promise<void>,
  ): Promise<ActiveTurnJournalDirectory> {
    const journal = new ActiveTurnJournalDirectory(
      stateDirectory,
      limits,
      afterRecordWrite,
    );
    await journal.prepare();
    return journal;
  }

  async readAll(): Promise<readonly RawActiveTurnJournal[]> {
    const names = await this.listNames();
    const journals: RawActiveTurnJournal[] = [];
    this.journals.clear();
    this.knownFiles.clear();
    this.totalBytes = 0;
    for (const name of names) {
      const path = join(this.path, name);
      const { content, identity } = await readBoundedOwnerFile(path, this.limits.maxBytes);
      if (this.totalBytes + content.byteLength > this.limits.maxTotalBytes) capacityExceeded();
      journals.push({ name, content });
      this.knownFiles.set(name, identity);
      this.totalBytes += content.byteLength;
    }
    return journals;
  }

  register(
    name: string,
    header: ActiveTurnJournalHeader,
    bytes: number,
    records: number,
  ): void {
    if (name !== journalName(header)) invalidJournal();
    const identity = this.knownFiles.get(name);
    if (identity === undefined || identity.size !== bytes) invalidJournalChanged();
    this.journals.set(journalKey(header), {
      header,
      name,
      path: join(this.path, name),
      dev: identity.dev,
      ino: identity.ino,
      bytes,
      records,
    });
  }

  async append(header: ActiveTurnJournalHeader, record: unknown): Promise<void> {
    const key = journalKey(header);
    let metadata = this.journals.get(key);
    const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (metadata === undefined) {
      if (this.journals.size >= this.limits.maxActiveTurns) capacityExceeded();
      const headerBytes = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
      if (headerBytes.byteLength + recordBytes.byteLength > this.limits.maxBytes) capacityExceeded();
      if (
        this.totalBytes + headerBytes.byteLength + recordBytes.byteLength
        > this.limits.maxTotalBytes
      ) {
        capacityExceeded();
      }
      metadata = await this.create(header, headerBytes);
    } else if (!sameHeaderIdentity(metadata.header, header)) {
      invalidJournal();
    }
    if (metadata.records >= this.limits.maxRecords) capacityExceeded();
    if (metadata.bytes + recordBytes.byteLength > this.limits.maxBytes) capacityExceeded();
    if (this.totalBytes + recordBytes.byteLength > this.limits.maxTotalBytes) capacityExceeded();
    try {
      const before = await lstat(metadata.path);
      verifyOwnedFile(before, metadata.path);
      if (
        before.dev !== metadata.dev
        || before.ino !== metadata.ino
        || Number(before.size) !== metadata.bytes
      ) {
        invalidJournalChanged();
      }
      const handle = await openNoFollow(metadata.path, constants.O_WRONLY | constants.O_APPEND);
      try {
        const opened = await handle.stat();
        verifyOwnedFile(opened, metadata.path);
        if (opened.dev !== before.dev || opened.ino !== before.ino || Number(opened.size) !== metadata.bytes) {
          invalidJournalChanged();
        }
        await writeAll(handle, recordBytes);
        await this.afterRecordWrite?.();
        await handle.sync();
        const after = await handle.stat();
        verifyOwnedFile(after, metadata.path);
        if (
          after.dev !== opened.dev
          || after.ino !== opened.ino
          || Number(after.size) !== metadata.bytes + recordBytes.byteLength
        ) {
          invalidJournalChanged();
        }
        const linked = await lstat(metadata.path);
        verifyOwnedFile(linked, metadata.path);
        if (
          linked.dev !== after.dev
          || linked.ino !== after.ino
          || Number(linked.size) !== Number(after.size)
        ) {
          invalidJournalChanged();
        }
      } finally {
        await handle.close();
      }
      metadata.bytes += recordBytes.byteLength;
      metadata.records += 1;
      this.totalBytes += recordBytes.byteLength;
      this.knownFiles.set(metadata.name, {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.bytes,
      });
    } catch (error) {
      if (error instanceof WebProductError) throw error;
      throw new JournalCommitUncertainError(error);
    }
  }

  async clear(): Promise<void> {
    try {
      const names = await this.listNames();
      if (
        names.length !== this.knownFiles.size
        || names.some((name) => !this.knownFiles.has(name))
      ) {
        invalidJournalChanged();
      }
      if (names.length === 0) return;
      for (const name of names) {
        const path = join(this.path, name);
        const linked = await lstat(path);
        verifyOwnedFile(linked, path);
        const expected = this.knownFiles.get(name)!;
        if (
          linked.dev !== expected.dev
          || linked.ino !== expected.ino
          || Number(linked.size) !== expected.size
        ) {
          invalidJournalChanged();
        }
        await unlink(path);
      }
      await syncDirectory(this.path);
      this.journals.clear();
      this.knownFiles.clear();
      this.totalBytes = 0;
    } catch (error) {
      if (error instanceof WebProductError) throw error;
      throw new JournalCommitUncertainError(error);
    }
  }

  private async prepare(): Promise<void> {
    const existing = await lstat(this.path).catch(() => undefined);
    if (existing === undefined) {
      await mkdir(this.path, { mode: 0o700 });
      await chmod(this.path, 0o700);
      verifyOwnedDirectory(await lstat(this.path), this.path);
      await syncDirectory(this.stateDirectory);
      return;
    }
    verifyOwnedDirectory(existing, this.path);
  }

  private async create(
    header: ActiveTurnJournalHeader,
    headerBytes: Buffer,
  ): Promise<JournalMetadata> {
    const path = join(this.path, journalName(header));
    try {
      let linkedIdentity: JournalFileIdentity | undefined;
      const handle = await openNoFollow(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        const opened = await handle.stat();
        verifyOwnedFile(opened, path);
        await writeAll(handle, headerBytes);
        await handle.sync();
        const after = await handle.stat();
        verifyOwnedFile(after, path);
        if (
          after.dev !== opened.dev
          || after.ino !== opened.ino
          || Number(after.size) !== headerBytes.byteLength
        ) {
          invalidJournalChanged();
        }
        await syncDirectory(this.path);
        const linked = await lstat(path);
        verifyOwnedFile(linked, path);
        if (
          linked.dev !== after.dev
          || linked.ino !== after.ino
          || Number(linked.size) !== Number(after.size)
        ) {
          invalidJournalChanged();
        }
        linkedIdentity = {
          dev: linked.dev,
          ino: linked.ino,
          size: Number(linked.size),
        };
      } finally {
        await handle.close();
      }
      if (linkedIdentity === undefined) invalidJournalChanged();
      const metadata: JournalMetadata = {
        header,
        name: journalName(header),
        path,
        dev: linkedIdentity.dev,
        ino: linkedIdentity.ino,
        bytes: headerBytes.byteLength,
        records: 0,
      };
      this.journals.set(journalKey(header), metadata);
      this.knownFiles.set(journalName(header), {
        dev: linkedIdentity.dev,
        ino: linkedIdentity.ino,
        size: headerBytes.byteLength,
      });
      this.totalBytes += headerBytes.byteLength;
      return metadata;
    } catch (error) {
      if (error instanceof WebProductError) throw error;
      throw new JournalCommitUncertainError(error);
    }
  }

  private async listNames(): Promise<readonly string[]> {
    verifyOwnedDirectory(await lstat(this.path), this.path);
    const directory = await opendir(this.path);
    const names: string[] = [];
    try {
      for await (const entry of directory) {
        if (names.length >= this.limits.maxActiveTurns) capacityExceeded();
        if (!JOURNAL_NAME.test(entry.name)) invalidJournal();
        names.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return names.sort((left, right) => left.localeCompare(right));
  }
}

const JOURNAL_NAME = /^[0-9a-f]{64}\.jsonl$/u;

export function journalName(header: ActiveTurnJournalHeader): string {
  const identity = JSON.stringify([
    header.threadId,
    header.turnId,
    header.assistantMessageId,
  ]);
  return `${createHash("sha256").update(identity).digest("hex")}.jsonl`;
}

function journalKey(header: ActiveTurnJournalHeader): string {
  return JSON.stringify([header.threadId, header.turnId]);
}

function sameHeaderIdentity(
  left: ActiveTurnJournalHeader,
  right: ActiveTurnJournalHeader,
): boolean {
  return left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.assistantMessageId === right.assistantMessageId;
}

async function readBoundedOwnerFile(
  path: string,
  maxBytes: number,
): Promise<{ readonly content: Buffer; readonly identity: JournalFileIdentity }> {
  const before = await lstat(path);
  verifyOwnedFile(before, path);
  if (Number(before.size) > maxBytes) capacityExceeded();
  const handle = await openNoFollow(path, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    verifyOwnedFile(opened, path);
    if (opened.dev !== before.dev || opened.ino !== before.ino || Number(opened.size) !== Number(before.size)) {
      invalidJournalChanged();
    }
    const content = await handle.readFile();
    if (content.byteLength > maxBytes) capacityExceeded();
    const after = await handle.stat();
    verifyOwnedFile(after, path);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || Number(after.size) !== Number(opened.size)
    ) {
      invalidJournalChanged();
    }
    const linked = await lstat(path);
    verifyOwnedFile(linked, path);
    if (
      linked.dev !== after.dev
      || linked.ino !== after.ino
      || Number(linked.size) !== Number(after.size)
    ) {
      invalidJournalChanged();
    }
    return {
      content,
      identity: {
        dev: linked.dev,
        ino: linked.ino,
        size: Number(linked.size),
      },
    };
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  content: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    const result = await handle.write(content, offset, content.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("Journal write made no progress.");
    offset += result.bytesWritten;
  }
}

function openNoFollow(path: string, flags: number, mode = 0o600) {
  return open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function verifyOwnedDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
  path: string,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WebProductError("invalid_state_directory", `${path} must be a directory, not a link.`, 409);
  }
  verifyOwnerAndMode(info.uid, info.mode, 0o700, path);
}

function verifyOwnedFile(
  info: Awaited<ReturnType<typeof lstat>>,
  path: string,
): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new WebProductError("invalid_state_file", `${path} must be a single-link regular file.`, 409);
  }
  verifyOwnerAndMode(info.uid, info.mode, 0o600, path);
}

function verifyOwnerAndMode(
  uid: number | bigint,
  mode: number | bigint,
  expected: number,
  path: string,
): void {
  if (typeof process.geteuid === "function" && Number(uid) !== process.geteuid()) {
    throw new WebProductError("invalid_state_owner", `${path} is not owned by the current user.`, 409);
  }
  if ((Number(mode) & 0o777) !== expected) {
    throw new WebProductError("invalid_state_mode", `${path} must have mode ${expected.toString(8)}.`, 409);
  }
}

function capacityExceeded(): never {
  throw new WebProductError(
    "capacity_exceeded",
    "Active-turn journal capacity was exceeded.",
    409,
  );
}

function invalidJournal(): never {
  throw new WebProductError(
    "state_corrupt",
    "An active-turn journal is malformed; refusing to overwrite it.",
    409,
  );
}

function invalidJournalChanged(): never {
  throw new WebProductError(
    "state_changed",
    "An active-turn journal changed while it was being accessed.",
    409,
  );
}
