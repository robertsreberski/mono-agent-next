// SPDX-License-Identifier: MIT
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

import {
  OwnerPrivatePathError,
  atomicReplaceOwnerPrivateFile,
  createOwnerPrivateFile,
  ensureOwnerPrivateDirectory,
  inspectOwnerPrivateDirectory,
  inspectOwnerPrivateFile,
  type OwnerPrivatePathIdentity,
} from "@mono-agent/module-sdk";

import { inspectSlackInboxLeaseMetadata } from "./inbox-lease.js";
import {
  boundedString,
  cloneEvent,
  exactKeys,
  hasCode,
  record,
  sameIdentity,
  SLACK_INBOX_LEASE_FILE,
  throwIfAborted,
  validateEnvelopeId,
  validEnvelopeId,
  validTimestamp,
} from "./inbox-values.js";
import type { SlackRemoteFile, SlackSocketEvent } from "./socket.js";

export const SLACK_INBOX_SCHEMA_VERSION = 1;
export const MAX_SLACK_INBOX_ENTRIES = 256;
export const MAX_SLACK_INBOX_RECEIPTS = 4_096;
export const MAX_SLACK_INBOX_BYTES = 16 * 1024 * 1024;

const STATE_FILE = "inbox-v1.json";
const MARKER_FILE = ".mono-agent-slack-inbox";
const MARKER_CONTENT = '{"kind":"mono-agent-slack-inbox","schemaVersion":1}\n';

type SlackInboxEntryStatus = "pending" | "processing" | "failed";

interface SlackInboxEntry {
  readonly envelopeId: string;
  readonly status: SlackInboxEntryStatus;
  readonly lane?: "primary" | "control";
  readonly admittedAt: string;
  readonly event: SlackSocketEvent;
}

export interface SlackInboxEntrySummary {
  readonly envelopeId: string;
  readonly status: SlackInboxEntryStatus;
  readonly lane?: "primary" | "control";
  readonly admittedAt: string;
}

interface SlackInboxState {
  readonly schemaVersion: 1;
  readonly entries: readonly SlackInboxEntry[];
  readonly receipts: readonly string[];
}

interface OpenedSlackInbox {
  readonly directory: string;
  readonly state: SlackInboxState;
  readonly identity: OwnerPrivatePathIdentity;
  readonly directoryIdentity: OwnerPrivatePathIdentity;
}

export interface SlackInboxSnapshot {
  readonly pending: number;
  readonly processing: number;
  readonly failed: number;
  readonly completed: number;
  readonly blocked?: string;
}

export interface SlackInboxDirectory {
  readonly directory: string;
  readonly identity: OwnerPrivatePathIdentity;
  readonly markerIdentity?: OwnerPrivatePathIdentity;
  readonly stateIdentity?: OwnerPrivatePathIdentity;
  readonly leaseIdentity?: OwnerPrivatePathIdentity;
}

export type SlackInboxErrorCode =
  | "closed"
  | "blocked"
  | "full"
  | "corrupt"
  | "unsafe-path"
  | "commit-uncertain";

export class SlackInboxError extends Error {
  readonly code: SlackInboxErrorCode;

  constructor(code: SlackInboxErrorCode, message: string, cause?: unknown) {
    if (cause === undefined) super(message);
    else super(message, { cause });
    this.name = "SlackInboxError";
    this.code = code;
  }
}

export class SlackInbox {
  readonly directory: string;
  readonly statePath: string;
  private state: SlackInboxState;
  private identity: OwnerPrivatePathIdentity;
  private readonly directoryIdentity: OwnerPrivatePathIdentity;
  private readonly recoveryBlocked: string | undefined;
  private tail = Promise.resolve();
  private closing = false;
  private closed = false;
  private poisoned: SlackInboxError | undefined;

  private constructor(
    directory: string,
    state: SlackInboxState,
    identity: OwnerPrivatePathIdentity,
    directoryIdentity: OwnerPrivatePathIdentity,
  ) {
    this.directory = directory;
    this.statePath = join(directory, STATE_FILE);
    this.state = state;
    this.identity = identity;
    this.directoryIdentity = directoryIdentity;
    this.recoveryBlocked = blockedReason(state);
  }

  static async open(dataDirectory: string, signal?: AbortSignal): Promise<SlackInbox> {
    const prepared = await SlackInbox.prepareForServing(dataDirectory, signal);
    return await SlackInbox.openPrepared(prepared, signal);
  }

  static async prepareForServing(
    dataDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlackInboxDirectory> {
    try {
      const directory = await prepareDirectory(resolve(dataDirectory), signal);
      return await inspectDirectorySnapshot(directory, signal);
    } catch (error) {
      if (error instanceof SlackInboxError) throw error;
      if (error instanceof OwnerPrivatePathError) {
        throw new SlackInboxError("unsafe-path", "Slack durable inbox path validation failed.", error);
      }
      throw new SlackInboxError("corrupt", "Slack durable inbox could not be opened safely.", error);
    }
  }

  static async openPrepared(
    prepared: SlackInboxDirectory,
    signal?: AbortSignal,
  ): Promise<SlackInbox> {
    try {
      const opened = await openSnapshot(prepared, true, signal);
      if (opened === undefined) {
        throw new SlackInboxError("corrupt", "Slack durable inbox was not initialized.");
      }
      return SlackInbox.fromOpened(opened);
    } catch (error) {
      if (error instanceof SlackInboxError) throw error;
      if (error instanceof OwnerPrivatePathError) {
        throw new SlackInboxError("unsafe-path", "Slack durable inbox path validation failed.", error);
      }
      throw new SlackInboxError("corrupt", "Slack durable inbox could not be opened safely.", error);
    }
  }

  static async openExisting(
    dataDirectory: string,
    signal?: AbortSignal,
    expected?: SlackInboxDirectory,
  ): Promise<SlackInbox | undefined> {
    try {
      if (expected !== undefined) {
        if (resolve(dataDirectory) !== expected.directory) {
          throw new SlackInboxError(
            "unsafe-path",
            "Slack durable inbox discovery path changed before open.",
          );
        }
        const opened = await openSnapshot(expected, false, signal);
        return opened === undefined ? undefined : SlackInbox.fromOpened(opened);
      }
      const requested = resolve(dataDirectory);
      throwIfAborted(signal);
      const requestedInfo = await lstat(requested).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (requestedInfo === undefined) return undefined;
      if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
        throw new SlackInboxError(
          "unsafe-path",
          "Slack durable inbox must be an owner-private directory.",
        );
      }
      const directory = await canonicalizeParent(requested);
      const opened = await openSnapshot(
        await inspectDirectorySnapshot(directory, signal),
        false,
        signal,
      );
      return opened === undefined ? undefined : SlackInbox.fromOpened(opened);
    } catch (error) {
      if (error instanceof SlackInboxError) throw error;
      if (error instanceof OwnerPrivatePathError) {
        throw new SlackInboxError("unsafe-path", "Slack durable inbox path validation failed.", error);
      }
      throw new SlackInboxError("corrupt", "Slack durable inbox could not be opened safely.", error);
    }
  }

  static async discoverExistingDirectory(
    dataDirectory: string,
    signal?: AbortSignal,
  ): Promise<SlackInboxDirectory | undefined> {
    try {
      const requested = resolve(dataDirectory);
      throwIfAborted(signal);
      const requestedInfo = await lstat(requested).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (requestedInfo === undefined) return undefined;
      if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
        throw new SlackInboxError(
          "unsafe-path",
          "Slack durable inbox must be an owner-private directory.",
        );
      }
      const directory = await canonicalizeParent(requested);
      const discovered = await inspectDirectorySnapshot(directory, signal);
      return discovered.markerIdentity !== undefined || discovered.stateIdentity !== undefined
        ? discovered
        : undefined;
    } catch (error) {
      if (error instanceof SlackInboxError) throw error;
      if (error instanceof OwnerPrivatePathError) {
        throw new SlackInboxError("unsafe-path", "Slack durable inbox path validation failed.", error);
      }
      throw new SlackInboxError("corrupt", "Slack durable inbox could not be discovered safely.", error);
    }
  }

  private static fromOpened(opened: OpenedSlackInbox): SlackInbox {
    return new SlackInbox(
      opened.directory,
      opened.state,
      opened.identity,
      opened.directoryIdentity,
    );
  }

  enqueue(event: SlackSocketEvent, signal?: AbortSignal): Promise<"enqueued" | "duplicate"> {
    const admitted = cloneEvent(event);
    validateEvent(admitted);
    return this.mutate((current) => {
      if (current.receipts.includes(admitted.envelopeId)
        || current.entries.some((entry) => entry.envelopeId === admitted.envelopeId)) {
        return { next: current, result: "duplicate" as const, write: false };
      }
      const blocked = failedReason(current) ?? this.recoveryBlocked;
      if (blocked !== undefined) throw new SlackInboxError("blocked", blocked);
      if (current.entries.length >= MAX_SLACK_INBOX_ENTRIES) {
        throw new SlackInboxError("full", "Slack durable inbox is full; the envelope was not acknowledged.");
      }
      const next: SlackInboxState = {
        schemaVersion: SLACK_INBOX_SCHEMA_VERSION,
        entries: [...current.entries, {
          envelopeId: admitted.envelopeId,
          status: "pending",
          admittedAt: new Date().toISOString(),
          event: admitted,
        }],
        receipts: current.receipts,
      };
      return { next, result: "enqueued" as const, write: true };
    }, signal);
  }

  claimNextPrimary(
    controlEligible: (event: SlackSocketEvent) => boolean,
    signal?: AbortSignal,
  ): Promise<SlackSocketEvent | undefined> {
    return this.claimNext(
      (event) => !controlEligible(event),
      "primary",
      signal,
    );
  }

  claimNextControl(
    eligible: (event: SlackSocketEvent) => boolean,
    signal?: AbortSignal,
  ): Promise<SlackSocketEvent | undefined> {
    return this.claimNext(eligible, "control", signal);
  }

  release(envelopeId: string, signal?: AbortSignal): Promise<void> {
    validateEnvelopeId(envelopeId);
    return this.mutate((current) => {
      const index = current.entries.findIndex((entry) => entry.envelopeId === envelopeId);
      if (index === -1 || current.entries[index]?.status !== "processing") {
        throw new SlackInboxError(
          "corrupt",
          "Slack durable inbox release did not match processing state.",
        );
      }
      const entry = current.entries[index]!;
      const entries = [...current.entries];
      const { lane: _lane, ...released } = entry;
      entries[index] = { ...released, status: "pending" };
      return { next: { ...current, entries }, result: undefined, write: true };
    }, signal);
  }

  requeueProcessingForShutdown(
    envelopeIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (envelopeIds.length > 2 || new Set(envelopeIds).size !== envelopeIds.length) {
      throw new TypeError(
        "Slack graceful shutdown recovery accepts at most two unique envelope ids.",
      );
    }
    for (const envelopeId of envelopeIds) validateEnvelopeId(envelopeId);
    const selected = new Set(envelopeIds);
    return this.mutate((current) => {
      const processing = current.entries.filter(
        (entry) => entry.status === "processing" && selected.has(entry.envelopeId),
      );
      if (processing.length === 0) {
        return { next: current, result: 0, write: false };
      }
      const entries = current.entries.map((entry) => {
        if (entry.status !== "processing" || !selected.has(entry.envelopeId)) return entry;
        const { lane: _lane, ...released } = entry;
        return { ...released, status: "pending" as const };
      });
      return {
        next: { ...current, entries },
        result: processing.length,
        write: true,
      };
    }, signal);
  }

  complete(envelopeId: string, signal?: AbortSignal): Promise<void> {
    validateEnvelopeId(envelopeId);
    return this.mutate((current) => {
      const index = current.entries.findIndex((entry) => entry.envelopeId === envelopeId);
      if (index === -1) {
        if (current.receipts.includes(envelopeId)) {
          return { next: current, result: undefined, write: false };
        }
        throw new SlackInboxError("corrupt", "Slack durable inbox completion did not match an admitted envelope.");
      }
      if (current.entries[index]?.status !== "processing") {
        throw new SlackInboxError("corrupt", "Slack durable inbox completion did not match processing state.");
      }
      const receipts = [...current.receipts.filter((value) => value !== envelopeId), envelopeId]
        .slice(-MAX_SLACK_INBOX_RECEIPTS);
      return {
        next: {
          schemaVersion: SLACK_INBOX_SCHEMA_VERSION,
          entries: current.entries.filter((_entry, entryIndex) => entryIndex !== index),
          receipts,
        },
        result: undefined,
        write: true,
      };
    }, signal);
  }

  fail(envelopeId: string, signal?: AbortSignal): Promise<void> {
    validateEnvelopeId(envelopeId);
    return this.mutate((current) => {
      const index = current.entries.findIndex((entry) => entry.envelopeId === envelopeId);
      if (index === -1) {
        if (current.receipts.includes(envelopeId)) {
          return { next: current, result: undefined, write: false };
        }
        throw new SlackInboxError("corrupt", "Slack durable inbox failure did not match an admitted envelope.");
      }
      const entry = current.entries[index]!;
      if (entry.status === "failed") return { next: current, result: undefined, write: false };
      if (entry.status !== "processing") {
        throw new SlackInboxError("corrupt", "Slack durable inbox failure did not match processing state.");
      }
      const entries = [...current.entries];
      const { lane: _lane, ...failed } = entry;
      entries[index] = { ...failed, status: "failed" };
      return { next: { ...current, entries }, result: undefined, write: true };
    }, signal);
  }

  snapshot(): SlackInboxSnapshot {
    const pending = this.state.entries.filter((entry) => entry.status === "pending").length;
    const processing = this.state.entries.filter((entry) => entry.status === "processing").length;
    const failed = this.state.entries.filter((entry) => entry.status === "failed").length;
    const blocked = failedReason(this.state) ?? this.recoveryBlocked;
    return Object.freeze({
      pending,
      processing,
      failed,
      completed: this.state.receipts.length,
      ...(blocked === undefined ? {} : { blocked }),
    });
  }

  inspectEntries(): readonly SlackInboxEntrySummary[] {
    return Object.freeze(this.state.entries.map((entry) => Object.freeze({
      envelopeId: entry.envelopeId,
      status: entry.status,
      ...(entry.lane === undefined ? {} : { lane: entry.lane }),
      admittedAt: entry.admittedAt,
    })));
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) {
      await this.tail;
      return;
    }
    this.closing = true;
    await this.tail;
    this.closed = true;
  }

  private claimNext(
    eligible: (event: SlackSocketEvent) => boolean,
    lane: "primary" | "control",
    signal?: AbortSignal,
  ): Promise<SlackSocketEvent | undefined> {
    return this.mutate((current) => {
      const processing = current.entries.filter((entry) => entry.status === "processing");
      const laneBlocked = lane === "primary"
        ? processing.length > 0
        : processing.some((entry) => entry.lane !== "primary");
      if (this.recoveryBlocked !== undefined
        || failedReason(current) !== undefined
        || laneBlocked) {
        return { next: current, result: undefined, write: false };
      }
      const firstPending = current.entries.findIndex(
        (entry) => entry.status === "pending",
      );
      const index = processing.length === 0
        ? firstPending !== -1 && eligible(current.entries[firstPending]!.event)
          ? firstPending
          : -1
        : current.entries.findIndex(
            (entry) => entry.status === "pending" && eligible(entry.event),
          );
      if (index === -1) return { next: current, result: undefined, write: false };
      const entry = current.entries[index]!;
      const entries = [...current.entries];
      entries[index] = { ...entry, status: "processing", lane };
      return {
        next: { ...current, entries },
        result: cloneEvent(entry.event),
        write: true,
      };
    }, signal);
  }

  private mutate<T>(
    operation: (state: SlackInboxState) => {
      readonly next: SlackInboxState;
      readonly result: T;
      readonly write: boolean;
    },
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new SlackInboxError("closed", "Slack durable inbox is closed."));
    }
    const result = this.tail.then(async () => {
      if (this.poisoned !== undefined) throw this.poisoned;
      throwIfAborted(signal);
      const change = operation(this.state);
      if (!change.write) return change.result;
      validateState(change.next);
      const encoded = serializeState(change.next);
      try {
        await verifyDirectoryIdentity(this.directory, this.directoryIdentity, signal);
        const identity = await atomicReplaceOwnerPrivateFile(
          this.statePath,
          encoded,
          {
            expected: this.identity,
            ...(signal === undefined ? {} : { signal }),
          },
        );
        await verifyDirectoryIdentity(this.directory, this.directoryIdentity, signal);
        this.state = freezeState(change.next);
        this.identity = identity;
        return change.result;
      } catch (error) {
        const uncertain = error instanceof OwnerPrivatePathError && error.committed;
        this.poisoned = new SlackInboxError(
          uncertain ? "commit-uncertain" : "unsafe-path",
          uncertain
            ? "Slack durable inbox commit became uncertain; operator recovery is required."
            : "Slack durable inbox persistence failed closed.",
          error,
        );
        throw this.poisoned;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function prepareDirectory(requested: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const requestedInfo = await lstat(requested).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (requestedInfo?.isSymbolicLink() === true) {
    throw new SlackInboxError("unsafe-path", "Slack durable inbox must not be a symbolic link.");
  }
  const directory = await canonicalizeParent(requested);
  const parent = dirname(directory);
  const root = parse(parent).root;
  const segments = parent.slice(root.length).split(/[/\\]+/u).filter(Boolean);
  let current = root;
  const createdDirectories: string[] = [];
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (info === undefined) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new SlackInboxError("unsafe-path", "Slack durable inbox path contains an unsafe component.");
      }
      createdDirectories.push(current);
    } else if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SlackInboxError("unsafe-path", "Slack durable inbox path contains an unsafe component.");
    }
    throwIfAborted(signal);
  }
  await ensureOwnerPrivateDirectory(directory, signal === undefined ? {} : { signal });
  if (requestedInfo === undefined) createdDirectories.push(directory);
  for (const created of createdDirectories.reverse()) {
    await syncDirectoryPath(dirname(created));
  }
  return directory;
}

async function canonicalizeParent(target: string): Promise<string> {
  const finalName = basename(target);
  let probe = dirname(target);
  const missing: string[] = [];
  while (true) {
    const info = await lstat(probe).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (info !== undefined) break;
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  const canonical = await realpath(probe);
  return join(canonical, ...missing, finalName);
}

async function syncDirectoryPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectDirectorySnapshot(
  directory: string,
  signal?: AbortSignal,
): Promise<SlackInboxDirectory> {
  const identity = await inspectOwnerPrivateDirectory(
    directory,
    signal === undefined ? {} : { signal },
  );
  const markerIdentity = await inspectOptionalFile(join(directory, MARKER_FILE), signal);
  const stateIdentity = await inspectOptionalFile(join(directory, STATE_FILE), signal);
  const leaseIdentity = await inspectSlackInboxLeaseMetadata(
    join(directory, SLACK_INBOX_LEASE_FILE),
    signal,
  );
  await verifyDirectoryIdentity(directory, identity, signal);
  return Object.freeze({
    directory,
    identity,
    ...(markerIdentity === undefined ? {} : { markerIdentity }),
    ...(stateIdentity === undefined ? {} : { stateIdentity }),
    ...(leaseIdentity === undefined ? {} : { leaseIdentity }),
  });
}

async function inspectOptionalFile(
  path: string,
  signal?: AbortSignal,
): Promise<OwnerPrivatePathIdentity | undefined> {
  try {
    return await inspectOwnerPrivateFile(path, signal === undefined ? {} : { signal });
  } catch (error) {
    if (error instanceof OwnerPrivatePathError && error.code === "missing") return undefined;
    throw error;
  }
}

async function openSnapshot(
  snapshot: SlackInboxDirectory,
  createMissing: boolean,
  signal?: AbortSignal,
): Promise<OpenedSlackInbox | undefined> {
  const { directory, identity: directoryIdentity } = snapshot;
  await verifyDirectoryIdentity(directory, directoryIdentity, signal);
  const markerPath = join(directory, MARKER_FILE);
  const statePath = join(directory, STATE_FILE);
  const markerIdentity = snapshot.markerIdentity;
  const stateIdentity = snapshot.stateIdentity;

  if (markerIdentity === undefined) {
    await assertStillMissing(markerPath, signal);
    if (!createMissing) {
      if (stateIdentity === undefined) {
        await assertStillMissing(statePath, signal);
        await verifyDirectoryIdentity(directory, directoryIdentity, signal);
        return undefined;
      }
      throw new SlackInboxError(
        "corrupt",
        "Slack durable inbox ownership marker is missing.",
      );
    }
    await createOwnerPrivateFile(
      markerPath,
      MARKER_CONTENT,
      signal === undefined ? {} : { signal },
    );
  } else {
    const marker = new TextDecoder().decode(await readExactOwnerPrivateFile(
      markerIdentity,
      256,
      signal,
    ));
    if (marker !== MARKER_CONTENT) {
      throw new SlackInboxError("corrupt", "Slack durable inbox ownership marker is invalid.");
    }
  }
  await verifyDirectoryIdentity(directory, directoryIdentity, signal);

  let loaded: { readonly state: SlackInboxState; readonly identity: OwnerPrivatePathIdentity };
  if (stateIdentity === undefined) {
    await assertStillMissing(statePath, signal);
    if (!createMissing) {
      throw new SlackInboxError("corrupt", "Slack durable inbox state file is missing.");
    }
    const identity = await createOwnerPrivateFile(
      statePath,
      serializeState(emptyState()),
      signal === undefined ? {} : { signal },
    );
    loaded = { state: emptyState(), identity };
  } else {
    loaded = await loadExactState(stateIdentity, signal);
  }
  await verifyDirectoryIdentity(directory, directoryIdentity, signal);
  return Object.freeze({
    directory,
    state: loaded.state,
    identity: loaded.identity,
    directoryIdentity,
  });
}

async function loadExactState(
  identity: OwnerPrivatePathIdentity,
  signal?: AbortSignal,
): Promise<{ readonly state: SlackInboxState; readonly identity: OwnerPrivatePathIdentity }> {
  const bytes = await readExactOwnerPrivateFile(identity, MAX_SLACK_INBOX_BYTES, signal);
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new SlackInboxError("corrupt", "Slack durable inbox state is not valid JSON.", error);
  }
  validateState(candidate);
  return { state: freezeState(candidate), identity };
}

async function readExactOwnerPrivateFile(
  expected: OwnerPrivatePathIdentity,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new SlackInboxError("unsafe-path", "Slack durable inbox requires O_NOFOLLOW.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = identityFromStat(expected.path, await handle.stat());
    assertExactFileSnapshot(before, expected);
    if (before.size > maxBytes) {
      throw new SlackInboxError("corrupt", "Slack durable inbox file exceeds its byte limit.");
    }
    const bytes = await readAtMost(handle, expected.path, maxBytes, signal);
    const after = identityFromStat(expected.path, await handle.stat());
    if (!sameFileSnapshot(before, after)) {
      throw new SlackInboxError(
        "unsafe-path",
        "Slack durable inbox file changed while it was being read.",
      );
    }
    assertExactFileSnapshot(
      identityFromStat(expected.path, await lstat(expected.path)),
      expected,
    );
    throwIfAborted(signal);
    return bytes;
  } catch (error) {
    if (error instanceof SlackInboxError) throw error;
    throw new SlackInboxError(
      "unsafe-path",
      "Slack durable inbox file identity changed before it could be read.",
      error,
    );
  } finally {
    await handle?.close();
  }
}

async function readAtMost(
  handle: FileHandle,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    throwIfAborted(signal);
    const capacity = Math.min(64 * 1024, maxBytes - total + 1);
    const chunk = new Uint8Array(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new SlackInboxError("corrupt", `${path} exceeds its byte limit.`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function assertStillMissing(path: string, signal?: AbortSignal): Promise<void> {
  const current = await inspectOptionalFile(path, signal);
  if (current !== undefined) {
    throw new SlackInboxError(
      "unsafe-path",
      "Slack durable inbox file identity changed after discovery.",
    );
  }
}

function assertExactFileSnapshot(
  actual: OwnerPrivatePathIdentity,
  expected: OwnerPrivatePathIdentity,
): void {
  if (!sameFileSnapshot(actual, expected)) {
    throw new SlackInboxError(
      "unsafe-path",
      "Slack durable inbox file identity changed after discovery.",
    );
  }
}

function identityFromStat(path: string, stat: Stats): OwnerPrivatePathIdentity {
  if (!stat.isFile()) {
    throw new SlackInboxError("unsafe-path", "Slack durable inbox entry is not a regular file.");
  }
  return Object.freeze({
    path,
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
    links: stat.nlink,
    size: stat.size,
  });
}

function sameFileSnapshot(
  left: OwnerPrivatePathIdentity,
  right: OwnerPrivatePathIdentity,
): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode
    && left.links === right.links
    && left.size === right.size;
}

function assertDirectoryIdentity(
  actual: OwnerPrivatePathIdentity,
  expected: OwnerPrivatePathIdentity | undefined,
): void {
  if (expected !== undefined && !sameIdentity(actual, expected)) {
    throw new SlackInboxError(
      "unsafe-path",
      "Slack durable inbox directory identity changed.",
    );
  }
}

async function verifyDirectoryIdentity(
  directory: string,
  expected: OwnerPrivatePathIdentity,
  signal?: AbortSignal,
): Promise<void> {
  const actual = await inspectOwnerPrivateDirectory(
    directory,
    signal === undefined ? {} : { signal },
  );
  assertDirectoryIdentity(actual, expected);
}

function validateState(value: unknown): asserts value is SlackInboxState {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "entries", "receipts"])
    || value.schemaVersion !== SLACK_INBOX_SCHEMA_VERSION
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_SLACK_INBOX_ENTRIES
    || !Array.isArray(value.receipts)
    || value.receipts.length > MAX_SLACK_INBOX_RECEIPTS) {
    throw new SlackInboxError("corrupt", "Slack durable inbox state has an invalid schema.");
  }
  const seen = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!record(rawEntry)
      || !exactKeys(
        rawEntry,
        ["envelopeId", "status", "admittedAt", "event"],
        ["lane"],
      )
      || !validEnvelopeId(rawEntry.envelopeId)
      || (rawEntry.status !== "pending" && rawEntry.status !== "processing" && rawEntry.status !== "failed")
      || (rawEntry.lane !== undefined
        && (rawEntry.status !== "processing"
          || (rawEntry.lane !== "primary" && rawEntry.lane !== "control")))
      || !validTimestamp(rawEntry.admittedAt)) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid entry.");
    }
    validateEvent(rawEntry.event);
    if (rawEntry.event.envelopeId !== rawEntry.envelopeId || seen.has(rawEntry.envelopeId)) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains duplicate or mismatched entries.");
    }
    seen.add(rawEntry.envelopeId);
  }
  for (const receipt of value.receipts) {
    if (!validEnvelopeId(receipt) || seen.has(receipt)) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains invalid deduplication receipts.");
    }
    seen.add(receipt);
  }
  const processing = value.entries.filter((entry) => entry.status === "processing");
  if (processing.length > 2
    || processing.filter((entry) => entry.lane === "primary").length > 1
    || processing.filter((entry) => entry.lane === "control").length > 1
    || (processing.length === 2
      && (!processing.some((entry) => entry.lane === "primary")
        || !processing.some((entry) => entry.lane === "control")))) {
    throw new SlackInboxError("corrupt", "Slack durable inbox contains too many processing entries.");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SLACK_INBOX_BYTES) {
    throw new SlackInboxError("corrupt", "Slack durable inbox exceeds its byte limit.");
  }
}

function validateEvent(value: unknown): asserts value is SlackSocketEvent {
  if (!record(value) || !validEnvelopeId(value.envelopeId)
    || !boundedString(value.teamId, 512)
    || !boundedString(value.userId, 512)
    || !validTimestamp(value.receivedAt)) {
    throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid event.");
  }
  if (value.kind === "message") {
    if (!exactKeys(value, ["kind", "envelopeId", "teamId", "channelId", "messageId", "threadId", "userId", "text", "files", "receivedAt"])
      || !boundedString(value.channelId, 512)
      || !boundedString(value.messageId, 512)
      || !boundedString(value.threadId, 512)
      || typeof value.text !== "string"
      || value.text.length > 2 * 1024 * 1024
      || !Array.isArray(value.files)
      || value.files.length > 100) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid message event.");
    }
    for (const file of value.files) validateRemoteFile(file);
    return;
  }
  if (value.kind === "action") {
    if (!exactKeys(value, ["kind", "envelopeId", "teamId", "channelId", "messageId", "threadId", "userId", "actionId", "value", "receivedAt"])
      || !boundedString(value.channelId, 512)
      || !boundedString(value.messageId, 512)
      || !boundedString(value.threadId, 512)
      || !boundedString(value.actionId, 512)
      || !boundedString(value.value, 4_096)) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid action event.");
    }
    return;
  }
  if (value.kind === "shortcut") {
    if (!exactKeys(
      value,
      ["kind", "envelopeId", "teamId", "userId", "callbackId", "receivedAt"],
      ["sourceChannelId", "sourceMessageId", "sourceThreadId"],
    )
      || !boundedString(value.callbackId, 512)
      || (value.sourceChannelId !== undefined && !boundedString(value.sourceChannelId, 512))
      || (value.sourceMessageId !== undefined && !boundedString(value.sourceMessageId, 512))
      || (value.sourceThreadId !== undefined && !boundedString(value.sourceThreadId, 512))) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid shortcut event.");
    }
    return;
  }
  if (value.kind === "home-opened") {
    if (!exactKeys(value, ["kind", "envelopeId", "teamId", "userId", "receivedAt"])) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid App Home event.");
    }
    return;
  }
  if (value.kind === "home-action") {
    if (!exactKeys(value, ["kind", "envelopeId", "teamId", "userId", "actionId", "receivedAt"])
      || !boundedString(value.actionId, 512)) {
      throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid App Home action.");
    }
    return;
  }
  throw new SlackInboxError("corrupt", "Slack durable inbox contains an unsupported event kind.");
}

function validateRemoteFile(value: unknown): asserts value is SlackRemoteFile {
  if (!record(value)
    || !exactKeys(value, ["id", "name", "mediaType", "privateUrl"], ["sizeBytes"])
    || !boundedString(value.id, 512)
    || !boundedString(value.name, 255)
    || !boundedString(value.mediaType, 512)
    || !boundedString(value.privateUrl, 8_192)
    || (value.sizeBytes !== undefined && (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0))) {
    throw new SlackInboxError("corrupt", "Slack durable inbox contains an invalid attachment reference.");
  }
}

function emptyState(): SlackInboxState {
  return Object.freeze({ schemaVersion: SLACK_INBOX_SCHEMA_VERSION, entries: Object.freeze([]), receipts: Object.freeze([]) });
}

function serializeState(state: SlackInboxState): string {
  const value = `${JSON.stringify(state)}\n`;
  if (new TextEncoder().encode(value).byteLength > MAX_SLACK_INBOX_BYTES) {
    throw new SlackInboxError("full", "Slack durable inbox reached its byte limit; the envelope was not acknowledged.");
  }
  return value;
}

function freezeState(state: SlackInboxState): SlackInboxState {
  return Object.freeze({
    schemaVersion: SLACK_INBOX_SCHEMA_VERSION,
    entries: Object.freeze(state.entries.map((entry) => Object.freeze({
      ...entry,
      event: cloneEvent(entry.event),
    }))),
    receipts: Object.freeze([...state.receipts]),
  });
}

function blockedReason(state: SlackInboxState): string | undefined {
  const failed = failedReason(state);
  if (failed !== undefined) return failed;
  if (state.entries.some((entry) => entry.status === "processing")) {
    return "Slack durable inbox contains an uncertain processing record; operator recovery is required.";
  }
  return undefined;
}

function failedReason(state: SlackInboxState): string | undefined {
  return state.entries.some((entry) => entry.status === "failed")
    ? "Slack durable inbox contains failed work; operator recovery is required."
    : undefined;
}
