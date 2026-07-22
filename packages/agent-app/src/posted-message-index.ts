import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

/**
 * Maps a message the agent POSTED (`channelId` + Slack `ts`) back to the
 * conversation that produced it, so a later in-thread reply can be resolved to
 * that conversation and continue its history/session.
 *
 * Why this exists: a scheduled/proactive post (e.g. a daily digest) runs under a
 * synthetic conversationId (e.g. `scheduled-scan`) and posts via
 * `SlackSendMessage`, which registers no `slack:` conversation. When the user
 * replies, the Slack adapter derives `slack:<channel>:<posted-ts>` — an id with no
 * history. This index closes that gap: the producer records `(channel, ts) →
 * producing conversationId`; the consumer (inbound dispatch) looks it up and
 * aliases the reply onto the producing conversation.
 *
 * Storage is a JSONL file inside the run-artifact dir. Appenders, readers,
 * startup maintenance, recovery, and compaction serialize through one
 * owner-only SQLite coordinator. Compaction appends a durable recovery trailer
 * to the verified index inode, then rewrites that same inode through its pinned
 * descriptor; it never promotes or later reopens a source pathname. The index
 * and coordinator are opened no-follow and must remain current-owner, regular,
 * single-link files. These files are ignored by the `.summary.json` artifact
 * scanners (see `seen-conversations.ts`), so they never collide with run-artifact
 * tooling.
 */

export const POSTED_MESSAGE_INDEX_FILENAME = "posted-message-index.jsonl";

/** Daily-rollover bucket suffix the responder appends (`…#2026-06-22`). */
const ROLLOVER_BUCKET = /#\d{4}-\d{2}-\d{2}$/u;

const DEFAULT_COMPACT_MAX_ENTRIES = 5000;
const COMPACT_HEADROOM_DIVISOR = 10;
const INDEX_LOCK_WAIT_MS = 2000;
const MAX_LOCK_FILE_BYTES = 64 * 1024;
const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const COMPACTION_TRAILER_MARKER = "mono-agent-posted-index-compaction";
const COMPACTION_TRAILER_SCHEMA_VERSION = 1;
const COMPACTION_TRAILER_MAX_BYTES = 4096;
const COMPACTION_SEPARATOR = Buffer.from("\n", "utf8");
const inProcessIndexTails = new Map<string, Promise<void>>();
const inProcessIndexStates = new Map<string, LoadedPostedMessageIndexState>();

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DirectoryIdentity extends FileIdentity {}

interface PostedMessageIndexState {
  readonly count: number;
  readonly size: number;
}

interface FileChangeToken {
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

interface FileVersion {
  readonly size: number;
  readonly changeToken: FileChangeToken;
}

interface LoadedPostedMessageIndexState extends PostedMessageIndexState {
  readonly identity: FileIdentity;
  readonly changeToken: FileChangeToken;
}

interface PostedMessageIndexSnapshot extends LoadedPostedMessageIndexState {
  readonly entries: readonly PostedMessageEntry[];
}

interface PostedMessageIndexLock {
  readonly directoryIdentity: DirectoryIdentity;
  readonly path: string;
  readonly identity: FileIdentity;
  release(): Promise<void>;
}

interface PostedMessageIndexCompactionHooks {
  readonly beforePrepare?: () => Promise<void>;
  /** Test-only boundary after recovery bytes but before the commit footer. */
  readonly afterPrepareBody?: () => Promise<void>;
  readonly beforeReplace?: () => Promise<void>;
  /** Test-only boundary after the final pathname checks and before pinned-FD rewrite. */
  readonly afterPromotionChecks?: (indexPath: string) => Promise<void>;
  /** Test-only boundary after the replacement prefix is durable but before truncate. */
  readonly afterRewriteSync?: () => Promise<void>;
}

interface CompactionTrailerRecord {
  readonly marker: typeof COMPACTION_TRAILER_MARKER;
  readonly schemaVersion: typeof COMPACTION_TRAILER_SCHEMA_VERSION;
  readonly targetDev: number;
  readonly targetIno: number;
  readonly lockDev: number;
  readonly lockIno: number;
  readonly originalSize: number;
  readonly bodyLength: number;
  readonly bodySha256: string;
  readonly entryCount: number;
}

interface PreparedCompaction {
  readonly record: CompactionTrailerRecord;
  readonly body: Buffer;
}

export interface PostedMessageEntry {
  /** Slack channel/DM id the message was posted to. */
  readonly channelId: string;
  /** Slack message timestamp returned by `chat.postMessage`. */
  readonly ts: string;
  /** Producing conversationId, de-bucketed to its base form. */
  readonly conversationId: string;
  /** ISO timestamp of when the entry was written. */
  readonly writtenAt: string;
}

/** The single index-file path both producer and consumer agree on. */
export function resolvePostedMessageIndexPath(artifactDir: string): string {
  return join(artifactDir, POSTED_MESSAGE_INDEX_FILENAME);
}

/** Strip a trailing daily-rollover bucket so the stored id is the base producing id. */
export function basePostedConversationId(conversationId: string): string {
  return conversationId.replace(ROLLOVER_BUCKET, "");
}

/**
 * Record that `conversationId` posted a message at `(channelId, ts)`. Appenders in
 * both the adapter and its stdio child share a filesystem lock with compaction, so
 * a rewrite cannot discard a completed concurrent append. Once the cap is reached,
 * compaction drops a batch of oldest entries before appending; this keeps the file
 * at or below the cap without a full rewrite on every later send.
 *
 * Best-effort: a failed index write or lock acquisition must never fail the Slack
 * post, so this function swallows errors. The stored conversationId is de-bucketed
 * so the consumer can let the responder re-bucket to the reply's own day
 * (consistent with daily session rollover).
 */
export async function appendPostedMessage(
  indexPath: string,
  entry: { channelId: string; ts: string; conversationId: string },
  now: () => Date = () => new Date(),
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
  compactionHooks: PostedMessageIndexCompactionHooks = {},
): Promise<void> {
  const channelId = entry.channelId.trim();
  const ts = entry.ts.trim();
  const conversationId = basePostedConversationId(entry.conversationId.trim());
  if (channelId.length === 0 || ts.length === 0 || conversationId.length === 0) {
    return;
  }
  const record: PostedMessageEntry = {
    channelId,
    ts,
    conversationId,
    writtenAt: now().toISOString(),
  };
  const line = `${JSON.stringify(record)}\n`;
  const cap = normalizedAppendCap(maxEntries);
  await withPostedMessageIndexLock(indexPath, async (lock) => {
    const { directoryIdentity } = lock;
    const identity = await ensureOwnerOnlyFile(indexPath, directoryIdentity, true);
    if (identity === undefined) {
      return;
    }
    let state = await loadPostedMessageIndexState(indexPath, directoryIdentity, identity);
    if (state === undefined) {
      return;
    }
    if (state.count >= cap) {
      const compacted = await compactPostedMessageIndexUnlocked(
        indexPath,
        amortizedCompactTarget(cap),
        lock,
        compactionHooks,
      );
      if (compacted === undefined) {
        // Preserve the existing bounded file rather than append past the cap when
        // its rewrite cannot be completed safely.
        return;
      }
      state = compacted;
      inProcessIndexStates.set(indexPath, compacted);
    }

    try {
      const appended = await appendSecureIndexLine(indexPath, line, state, directoryIdentity);
      inProcessIndexStates.set(indexPath, {
        count: state.count + 1,
        size: appended.size,
        identity: state.identity,
        changeToken: appended.changeToken,
      });
    } catch {
      // Best-effort. Discard any in-process hint so the next writer reconciles
      // count and size from a securely-opened JSONL snapshot.
      inProcessIndexStates.delete(indexPath);
    }
  });
}

/**
 * Resolve the producing conversationId for a posted message, newest write wins.
 * Returns `undefined` when the file is missing or has no matching entry, so the
 * caller falls back to the default (a fresh `slack:` conversation) — no regression.
 */
export async function lookupProducingConversation(
  indexPath: string,
  channelId: string,
  ts: string,
): Promise<string | undefined> {
  const wantChannel = channelId.trim();
  const wantTs = ts.trim();
  if (wantChannel.length === 0 || wantTs.length === 0) {
    return undefined;
  }
  return await withPostedMessageIndexLock(indexPath, async ({ directoryIdentity }) => {
    let match: PostedMessageEntry | undefined;
    const entries = (await tryReadIndexSnapshot(indexPath, directoryIdentity))?.entries ?? [];
    for (const entry of entries) {
      if (entry.channelId !== wantChannel || entry.ts !== wantTs) {
        continue;
      }
      if (match === undefined || entry.writtenAt >= match.writtenAt) {
        match = entry;
      }
    }
    return match?.conversationId;
  });
}

/**
 * Bound file growth by rewriting the index with only the newest `maxEntries`
 * (by write time, de-duped to the newest entry per `channel+ts`). Slack-driver
 * startup invokes this exact routine, and every appender also uses the same
 * unlocked implementation after taking this cross-process lock. Best-effort.
 */
export async function compactPostedMessageIndex(
  indexPath: string,
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
  hooks: PostedMessageIndexCompactionHooks = {},
): Promise<void> {
  await withPostedMessageIndexLock(indexPath, async (lock) => {
    const compacted = await compactPostedMessageIndexUnlocked(
      indexPath,
      normalizedCompactionCap(maxEntries),
      lock,
      hooks,
    );
    if (compacted !== undefined) {
      inProcessIndexStates.set(indexPath, compacted);
    }
  });
}

async function compactPostedMessageIndexUnlocked(
  indexPath: string,
  maxEntries: number,
  lock: PostedMessageIndexLock,
  hooks: PostedMessageIndexCompactionHooks = {},
): Promise<LoadedPostedMessageIndexState | undefined> {
  const { directoryIdentity } = lock;
  const snapshot = await tryReadIndexSnapshot(indexPath, directoryIdentity);
  if (snapshot === undefined) {
    return undefined;
  }
  if (snapshot.entries.length <= maxEntries) {
    return snapshot;
  }
  // Newest entry per (channel, ts), then newest-first, then cap.
  const latest = new Map<string, PostedMessageEntry>();
  for (const entry of snapshot.entries) {
    const key = `${entry.channelId} ${entry.ts}`;
    const prior = latest.get(key);
    if (prior === undefined || entry.writtenAt >= prior.writtenAt) {
      latest.set(key, entry);
    }
  }
  const kept = [...latest.values()]
    .sort((a, b) => (a.writtenAt < b.writtenAt ? 1 : a.writtenAt > b.writtenAt ? -1 : 0))
    .slice(0, maxEntries);
  const nextBytes = encodePostedMessageEntries(kept);
  let target: FileHandle | undefined;
  let appendTarget: FileHandle | undefined;

  try {
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    await hooks.beforeReplace?.();
    target = await openPinnedIndexForRewrite(
      indexPath,
      snapshot.identity,
      snapshot.size,
      directoryIdentity,
    );
    appendTarget = await openPinnedIndexForAppend(
      indexPath,
      snapshot.identity,
      snapshot.size,
      directoryIdentity,
    );
    await hooks.beforePrepare?.();
    const prepared = await prepareCompaction(
      target,
      appendTarget,
      indexPath,
      snapshot.identity,
      lock,
      snapshot.size,
      nextBytes,
      kept.length,
      hooks.afterPrepareBody,
    );

    await assertFileIdentity(indexPath, snapshot.identity);
    await assertLockFileIdentity(lock.path, lock.identity);
    await assertNoSqliteSidecars(lock.path, directoryIdentity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    await hooks.afterPromotionChecks?.(indexPath);

    // There is intentionally no pathname rename or sidecar source here. The
    // recovery bytes and destination are both pinned inside the verified index
    // inode. A later path swap cannot change the prepared bytes or redirect the
    // rewrite into the raced pathname. The footer also binds recovery to this
    // exact coordinator inode, so a replacement lock domain cannot append while
    // the transaction is prepared. The footer remains beyond the maximum rewrite
    // extent until the new prefix is durable, so process death at any rewrite
    // boundary is recoverable before the next locked reader or writer.
    const rewritten = await rewritePinnedIndex(
      target,
      indexPath,
      snapshot.identity,
      prepared.body,
      hooks.afterRewriteSync,
    );
    await assertFileIdentity(indexPath, snapshot.identity);
    await assertLockFileIdentity(lock.path, lock.identity);
    await assertNoSqliteSidecars(lock.path, directoryIdentity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    await fsyncDirectory(dirname(indexPath), directoryIdentity);
    return {
      count: kept.length,
      size: rewritten.size,
      identity: snapshot.identity,
      changeToken: rewritten.changeToken,
    };
  } catch {
    // Best-effort and fail-closed. No catch path unlinks or renames a pathname. A
    // complete trailer remains on the intended inode for locked recovery; an
    // interrupted prepare happens before any original byte is rewritten and is
    // treated as ordinary ignored JSONL tail data on the next operation.
    return undefined;
  } finally {
    await appendTarget?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
  }
}

async function recoverPreparedCompaction(
  indexPath: string,
  lock: PostedMessageIndexLock,
): Promise<boolean> {
  const { directoryIdentity } = lock;
  let target: FileHandle | undefined;
  try {
    const targetIdentity = await ensureOwnerOnlyFile(indexPath, directoryIdentity, false);
    if (targetIdentity === undefined) {
      return true;
    }
    target = await openPinnedIndexForRewrite(
      indexPath,
      targetIdentity,
      undefined,
      directoryIdentity,
    );
    const prepared = await readPreparedCompaction(
      target,
      indexPath,
      targetIdentity,
      lock.identity,
    );
    if (prepared === undefined) {
      if (await terminateIncompleteCompactionTail(target, indexPath, targetIdentity)) {
        inProcessIndexStates.delete(indexPath);
      }
      await assertFileIdentity(indexPath, targetIdentity);
      await assertLockFileIdentity(lock.path, lock.identity);
      await assertNoSqliteSidecars(lock.path, directoryIdentity);
      await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
      return true;
    }
    await assertFileIdentity(indexPath, targetIdentity);
    await assertLockFileIdentity(lock.path, lock.identity);
    await assertNoSqliteSidecars(lock.path, directoryIdentity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    const rewritten = await rewritePinnedIndex(target, indexPath, targetIdentity, prepared.body);
    await assertFileIdentity(indexPath, targetIdentity);
    await assertLockFileIdentity(lock.path, lock.identity);
    await assertNoSqliteSidecars(lock.path, directoryIdentity);
    await fsyncDirectory(dirname(indexPath), directoryIdentity);
    inProcessIndexStates.set(indexPath, {
      count: prepared.record.entryCount,
      size: rewritten.size,
      identity: targetIdentity,
      changeToken: rewritten.changeToken,
    });
    return true;
  } catch {
    inProcessIndexStates.delete(indexPath);
    return false;
  } finally {
    await target?.close().catch(() => undefined);
  }
}

async function prepareCompaction(
  handle: FileHandle,
  appendHandle: FileHandle,
  indexPath: string,
  targetIdentity: FileIdentity,
  lock: PostedMessageIndexLock,
  originalSize: number,
  body: Buffer,
  entryCount: number,
  afterBody?: () => Promise<void>,
): Promise<PreparedCompaction> {
  const before = await handle.stat();
  assertSecureFile(before, indexPath);
  assertSameIdentity(targetIdentity, before, indexPath);
  const appendBefore = await appendHandle.stat();
  assertSecureFile(appendBefore, indexPath);
  assertSameIdentity(targetIdentity, appendBefore, indexPath);
  if (before.size !== originalSize) {
    throw new Error(`Posted-message index ${indexPath} changed before compaction prepare.`);
  }
  if (appendBefore.size !== originalSize) {
    throw new Error(`Posted-message index ${indexPath} changed before compaction append.`);
  }
  const record: CompactionTrailerRecord = {
    marker: COMPACTION_TRAILER_MARKER,
    schemaVersion: COMPACTION_TRAILER_SCHEMA_VERSION,
    targetDev: targetIdentity.dev,
    targetIno: targetIdentity.ino,
    lockDev: lock.identity.dev,
    lockIno: lock.identity.ino,
    originalSize,
    bodyLength: body.byteLength,
    bodySha256: sha256(body),
    entryCount,
  };
  const footer = encodeCompactionTrailer(record);
  const bodyOffset = compactionRecoveryBodyOffset(originalSize, body.byteLength);
  const footerOffset = bodyOffset + body.byteLength;
  const preparedSize = footerOffset + footer.byteLength;
  if (
    !Number.isSafeInteger(bodyOffset)
    || !Number.isSafeInteger(footerOffset)
    || !Number.isSafeInteger(preparedSize)
  ) {
    throw new Error(`Posted-message index ${indexPath} compaction offsets are unsafe.`);
  }
  const padding = Buffer.alloc(bodyOffset - originalSize, 0x0a);
  const recoveryBytes = Buffer.concat([padding, body]);
  await assertLockFileIdentity(lock.path, lock.identity);
  await assertNoSqliteSidecars(lock.path, lock.directoryIdentity);
  await appendBuffer(appendHandle, recoveryBytes);
  // Recovery bytes must be durable before the footer commits them. If this sync
  // or the following hook is interrupted, the original prefix is untouched and
  // the uncommitted JSONL-compatible tail can be retried safely.
  await appendHandle.sync();
  const bodyWritten = await handle.stat();
  assertSecureFile(bodyWritten, indexPath);
  assertSameIdentity(targetIdentity, bodyWritten, indexPath);
  if (bodyWritten.size !== footerOffset) {
    throw new Error(`Posted-message index ${indexPath} compaction body was interleaved.`);
  }
  await afterBody?.();
  const beforeFooter = await handle.stat();
  assertSecureFile(beforeFooter, indexPath);
  assertSameIdentity(targetIdentity, beforeFooter, indexPath);
  if (beforeFooter.size !== footerOffset) {
    throw new Error(`Posted-message index ${indexPath} changed before compaction commit.`);
  }
  await assertLockFileIdentity(lock.path, lock.identity);
  await assertNoSqliteSidecars(lock.path, lock.directoryIdentity);
  await appendBuffer(appendHandle, footer);
  await appendHandle.sync();
  const committed = await handle.stat();
  assertSecureFile(committed, indexPath);
  assertSameIdentity(targetIdentity, committed, indexPath);
  if (committed.size !== preparedSize) {
    throw new Error(`Posted-message index ${indexPath} compaction footer was interleaved.`);
  }

  const prepared = await readPreparedCompaction(
    handle,
    indexPath,
    targetIdentity,
    lock.identity,
  );
  if (
    prepared === undefined
    || !sameCompactionTrailerRecord(prepared.record, record)
    || !prepared.body.equals(body)
  ) {
    throw new Error(`Posted-message index ${indexPath} did not durably prepare compaction.`);
  }
  return prepared;
}

async function openPinnedIndexForRewrite(
  indexPath: string,
  expectedIdentity: FileIdentity,
  expectedSize: number | undefined,
  directoryIdentity: DirectoryIdentity,
): Promise<FileHandle> {
  await assertFileIdentity(indexPath, expectedIdentity);
  const handle = await open(indexPath, fsConstants.O_RDWR | noFollowFlag() | nonBlockFlag());
  try {
    const info = await handle.stat();
    assertSecureFile(info, indexPath);
    assertSameIdentity(expectedIdentity, info, indexPath);
    if (expectedSize !== undefined && info.size !== expectedSize) {
      throw new Error(`Posted-message index ${indexPath} changed before compaction.`);
    }
    await assertFileIdentity(indexPath, expectedIdentity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openPinnedIndexForAppend(
  indexPath: string,
  expectedIdentity: FileIdentity,
  expectedSize: number,
  directoryIdentity: DirectoryIdentity,
): Promise<FileHandle> {
  await assertFileIdentity(indexPath, expectedIdentity);
  const handle = await open(
    indexPath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollowFlag() | nonBlockFlag(),
  );
  try {
    const info = await handle.stat();
    assertSecureFile(info, indexPath);
    assertSameIdentity(expectedIdentity, info, indexPath);
    if (info.size !== expectedSize) {
      throw new Error(`Posted-message index ${indexPath} changed before compaction append open.`);
    }
    await assertFileIdentity(indexPath, expectedIdentity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function rewritePinnedIndex(
  handle: FileHandle,
  indexPath: string,
  expectedIdentity: FileIdentity,
  body: Buffer,
  afterPrefixSync?: () => Promise<void>,
): Promise<FileVersion> {
  const before = await handle.stat();
  assertSecureFile(before, indexPath);
  assertSameIdentity(expectedIdentity, before, indexPath);
  // Keep the recovery footer intact until the complete replacement prefix is
  // durable. A crash before truncate is replayed; a crash after truncate sees
  // the already-synced replacement bytes at their final length.
  await writeBufferAt(handle, body, 0);
  await handle.sync();
  await afterPrefixSync?.();
  await handle.truncate(body.byteLength);
  await handle.sync();
  const after = await handle.stat();
  assertSecureFile(after, indexPath);
  assertSameIdentity(expectedIdentity, after, indexPath);
  if (after.size !== body.byteLength) {
    throw new Error(`Posted-message index ${indexPath} compaction rewrite was incomplete.`);
  }
  return {
    size: after.size,
    changeToken: await preciseFileChangeToken(handle, after, indexPath),
  };
}

async function readPreparedCompaction(
  handle: FileHandle,
  indexPath: string,
  expectedIdentity: FileIdentity,
  expectedLockIdentity: FileIdentity,
): Promise<PreparedCompaction | undefined> {
  const info = await handle.stat();
  assertSecureFile(info, indexPath);
  assertSameIdentity(expectedIdentity, info, indexPath);
  const located = await readLastCompactionTrailerLine(handle, info.size);
  if (located === undefined) {
    return undefined;
  }
  const record = decodeCompactionTrailer(located.line);
  if (record === undefined) {
    return undefined;
  }
  const footer = encodeCompactionTrailer(record);
  if (!footer.subarray(0, footer.byteLength - 1).equals(located.line)) {
    throw new Error(`Posted-message index ${indexPath} has a non-canonical compaction trailer.`);
  }
  const bodyOffset = compactionRecoveryBodyOffset(record.originalSize, record.bodyLength);
  const expectedFooterOffset = bodyOffset + record.bodyLength;
  const expectedPreparedSize = expectedFooterOffset + footer.byteLength;
  if (
    !Number.isSafeInteger(expectedFooterOffset)
    || !Number.isSafeInteger(expectedPreparedSize)
    || located.offset !== expectedFooterOffset
    || info.size !== expectedPreparedSize
    || record.targetDev !== expectedIdentity.dev
    || record.targetIno !== expectedIdentity.ino
    || record.lockDev !== expectedLockIdentity.dev
    || record.lockIno !== expectedLockIdentity.ino
  ) {
    throw new Error(`Posted-message index ${indexPath} has a mismatched compaction trailer.`);
  }
  const body = await readBufferAt(
    handle,
    record.bodyLength,
    bodyOffset,
  );
  if (body === undefined || sha256(body) !== record.bodySha256) {
    throw new Error(`Posted-message index ${indexPath} failed its compaction body digest.`);
  }
  const entries = parseEntries(body.toString("utf8"));
  if (entries.length !== record.entryCount || !encodePostedMessageEntries(entries).equals(body)) {
    throw new Error(`Posted-message index ${indexPath} has invalid compaction entries.`);
  }
  return { record, body };
}

async function readLastCompactionTrailerLine(
  handle: FileHandle,
  size: number,
): Promise<{ readonly line: Buffer; readonly offset: number } | undefined> {
  if (size === 0) {
    return undefined;
  }
  const readLength = Math.min(size, COMPACTION_TRAILER_MAX_BYTES + 1);
  const tail = await readBufferAt(handle, readLength, size - readLength);
  if (tail === undefined || tail[tail.byteLength - 1] !== 0x0a) {
    return undefined;
  }
  const lineEnd = tail.byteLength - 1;
  const precedingNewline = tail.lastIndexOf(0x0a, lineEnd - 1);
  if (precedingNewline < 0 && readLength < size) {
    return undefined;
  }
  const lineStart = precedingNewline + 1;
  const line = tail.subarray(lineStart, lineEnd);
  if (line.byteLength === 0 || line.byteLength > COMPACTION_TRAILER_MAX_BYTES) {
    return undefined;
  }
  return { line, offset: size - readLength + lineStart };
}

async function terminateIncompleteCompactionTail(
  handle: FileHandle,
  indexPath: string,
  expectedIdentity: FileIdentity,
): Promise<boolean> {
  const before = await handle.stat();
  assertSecureFile(before, indexPath);
  assertSameIdentity(expectedIdentity, before, indexPath);
  if (before.size === 0) {
    return false;
  }
  const last = await readBufferAt(handle, 1, before.size - 1);
  if (last === undefined || last[0] === 0x0a) {
    return false;
  }
  await writeBufferAt(handle, COMPACTION_SEPARATOR, before.size);
  await handle.sync();
  const after = await handle.stat();
  assertSecureFile(after, indexPath);
  assertSameIdentity(expectedIdentity, after, indexPath);
  if (after.size !== before.size + COMPACTION_SEPARATOR.byteLength) {
    throw new Error(`Posted-message index ${indexPath} tail repair was incomplete.`);
  }
  return true;
}

function encodeCompactionTrailer(record: CompactionTrailerRecord): Buffer {
  const encoded = Buffer.from(`${JSON.stringify({
    ...record,
    checksum: compactionTrailerChecksum(record),
  })}\n`, "utf8");
  if (encoded.byteLength > COMPACTION_TRAILER_MAX_BYTES) {
    throw new Error("Posted-message index compaction trailer is too large.");
  }
  return encoded;
}

function decodeCompactionTrailer(bytes: Buffer): CompactionTrailerRecord | undefined {
  const text = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.marker !== COMPACTION_TRAILER_MARKER) {
    return undefined;
  }
  const expectedKeys = [
    "bodyLength",
    "bodySha256",
    "checksum",
    "entryCount",
    "lockDev",
    "lockIno",
    "marker",
    "originalSize",
    "schemaVersion",
    "targetDev",
    "targetIno",
  ];
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("Posted-message index compaction trailer has unexpected fields.");
  }
  if (
    raw.schemaVersion !== COMPACTION_TRAILER_SCHEMA_VERSION
    || !isNonNegativeSafeInteger(raw.targetDev)
    || !isNonNegativeSafeInteger(raw.targetIno)
    || !isNonNegativeSafeInteger(raw.lockDev)
    || !isNonNegativeSafeInteger(raw.lockIno)
    || !isNonNegativeSafeInteger(raw.originalSize)
    || !isNonNegativeSafeInteger(raw.bodyLength)
    || typeof raw.bodySha256 !== "string"
    || !isNonNegativeSafeInteger(raw.entryCount)
    || typeof raw.checksum !== "string"
  ) {
    throw new Error("Posted-message index compaction trailer has invalid fields.");
  }
  const record: CompactionTrailerRecord = {
    marker: COMPACTION_TRAILER_MARKER,
    schemaVersion: COMPACTION_TRAILER_SCHEMA_VERSION,
    targetDev: raw.targetDev,
    targetIno: raw.targetIno,
    lockDev: raw.lockDev,
    lockIno: raw.lockIno,
    originalSize: raw.originalSize,
    bodyLength: raw.bodyLength,
    bodySha256: raw.bodySha256,
    entryCount: raw.entryCount,
  };
  if (
    !/^[0-9a-f]{64}$/u.test(record.bodySha256)
    || raw.checksum !== compactionTrailerChecksum(record)
  ) {
    throw new Error("Posted-message index compaction trailer failed its checksum.");
  }
  return record;
}

function compactionTrailerChecksum(record: CompactionTrailerRecord): string {
  return sha256(Buffer.from(JSON.stringify(record), "utf8"));
}

function sameCompactionTrailerRecord(
  left: CompactionTrailerRecord,
  right: CompactionTrailerRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compactionRecoveryBodyOffset(originalSize: number, bodyLength: number): number {
  const afterOriginal = originalSize + COMPACTION_SEPARATOR.byteLength;
  const offset = Math.max(afterOriginal, bodyLength);
  if (!Number.isSafeInteger(afterOriginal) || !Number.isSafeInteger(offset)) {
    throw new Error("Posted-message index compaction recovery offset is unsafe.");
  }
  return offset;
}

function encodePostedMessageEntries(entries: readonly PostedMessageEntry[]): Buffer {
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return Buffer.from(entries.length === 0 ? "" : `${body}\n`, "utf8");
}

async function appendBuffer(handle: FileHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      null,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("Posted-message index append made no progress.");
    }
    written += result.bytesWritten;
  }
}

async function writeBufferAt(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      position + written,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("Posted-message index write made no progress.");
    }
    written += result.bytesWritten;
  }
}

async function readBufferAt(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead <= 0) {
      return undefined;
    }
    read += result.bytesRead;
  }
  return buffer;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizedAppendCap(maxEntries: number): number {
  return Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : DEFAULT_COMPACT_MAX_ENTRIES;
}

function normalizedCompactionCap(maxEntries: number): number {
  return Number.isSafeInteger(maxEntries) && maxEntries >= 0
    ? maxEntries
    : DEFAULT_COMPACT_MAX_ENTRIES;
}

function amortizedCompactTarget(maxEntries: number): number {
  const headroom = Math.max(1, Math.ceil(maxEntries / COMPACT_HEADROOM_DIVISOR));
  return Math.max(0, maxEntries - headroom);
}

async function loadPostedMessageIndexState(
  indexPath: string,
  directoryIdentity: DirectoryIdentity,
  expectedIdentity: FileIdentity,
): Promise<LoadedPostedMessageIndexState | undefined> {
  const current = await secureFileVersion(indexPath, expectedIdentity, directoryIdentity);
  const cached = inProcessIndexStates.get(indexPath);
  // Size plus inode is not a freshness proof: another locked process can compact
  // the same inode back to the same byte length. Precise change metadata preserves
  // the O(1) hot path while forcing a secure recount after any such rewrite.
  if (
    cached !== undefined
    && cached.size === current.size
    && sameFileChangeToken(cached.changeToken, current.changeToken)
    && sameIdentity(cached.identity, expectedIdentity)
  ) {
    return cached;
  }
  const snapshot = await tryReadIndexSnapshot(indexPath, directoryIdentity);
  if (snapshot === undefined) {
    return undefined;
  }
  assertSameIdentity(expectedIdentity, snapshot.identity, indexPath);
  inProcessIndexStates.set(indexPath, snapshot);
  return snapshot;
}

async function withPostedMessageIndexLock<T>(
  indexPath: string,
  action: (lock: PostedMessageIndexLock) => Promise<T>,
): Promise<T | undefined> {
  // Avoid blocking this process's event loop on its own synchronous SQLite lock;
  // the OS-backed lock below then serializes the adapter against stdio children.
  const prior = inProcessIndexTails.get(indexPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queueSlot = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = prior.then(() => queueSlot);
  inProcessIndexTails.set(indexPath, tail);
  await prior;
  try {
    const lock = await acquirePostedMessageIndexLock(indexPath);
    if (lock === undefined) {
      return undefined;
    }
    try {
      if (!await recoverPreparedCompaction(indexPath, lock)) {
        return undefined;
      }
      return await action(lock);
    } finally {
      await lock.release();
    }
  } catch {
    // Best-effort; a posted-message index failure never fails the Slack post.
    return undefined;
  } finally {
    releaseQueue();
    if (inProcessIndexTails.get(indexPath) === tail) {
      inProcessIndexTails.delete(indexPath);
    }
  }
}

async function acquirePostedMessageIndexLock(
  indexPath: string,
): Promise<PostedMessageIndexLock | undefined> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  let directoryIdentity: DirectoryIdentity;
  try {
    directoryIdentity = await ensureIndexDirectory(indexPath);
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return undefined;
  }
  const lockPath = `${indexPath}.lock.sqlite`;
  let lockIdentity: FileIdentity;
  try {
    const ensured = await ensureOwnerOnlyFile(lockPath, directoryIdentity, true);
    if (ensured === undefined) {
      return undefined;
    }
    lockIdentity = ensured;
    await assertLockFileIdentity(lockPath, lockIdentity);
    await assertNoSqliteSidecars(lockPath, directoryIdentity);
  } catch {
    return undefined;
  }

  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  while (true) {
    let database: import("node:sqlite").DatabaseSync | undefined;
    try {
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
      database = new DatabaseSync(lockPath, { timeout: 0 });
      // MEMORY preserves SQLite's kernel-backed cross-process lock while avoiding
      // attacker-preparable, umask-dependent -journal/-wal/-shm filesystem paths.
      // This database is lock-only: no schema or count state is ever mutated, so
      // process death never relies on a MEMORY journal for data recovery.
      database.exec("PRAGMA journal_mode=MEMORY");
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
      // The kernel releases this transaction lock automatically on close or
      // process death; there is no stale-path cleanup race.
      database.exec("BEGIN IMMEDIATE");
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
      return postedMessageIndexLock(
        database,
        lockPath,
        lockIdentity,
        directoryIdentity,
      );
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Best-effort cleanup after a failed acquisition.
      }
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        return undefined;
      }
      await delay(8 + Math.floor(Math.random() * 8));
    }
  }
}

function postedMessageIndexLock(
  database: import("node:sqlite").DatabaseSync,
  lockPath: string,
  lockIdentity: FileIdentity,
  directoryIdentity: DirectoryIdentity,
): PostedMessageIndexLock {
  let released = false;
  return {
    directoryIdentity,
    path: lockPath,
    identity: lockIdentity,
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
      } catch {
        // close() is the authoritative kernel-lock release. SQLite is deliberately
        // lock-only, so there is no mutable coordinator state to recover.
      }
      try {
        database.close();
      } catch {
        // The connection is no longer reusable.
      }
      await assertLockFileIdentity(lockPath, lockIdentity);
      await assertNoSqliteSidecars(lockPath, directoryIdentity);
    },
  };
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy/iu.test(error.message);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function tryReadIndexSnapshot(
  indexPath: string,
  directoryIdentity: DirectoryIdentity,
): Promise<PostedMessageIndexSnapshot | undefined> {
  let handle: FileHandle | undefined;
  try {
    const identity = await ensureOwnerOnlyFile(indexPath, directoryIdentity, false);
    if (identity === undefined) {
      return undefined;
    }
    const before = await lstat(indexPath);
    assertSecureFile(before, indexPath);
    assertSameIdentity(identity, before, indexPath);
    handle = await open(indexPath, fsConstants.O_RDONLY | noFollowFlag() | nonBlockFlag());
    const opened = await handle.stat();
    assertSecureFile(opened, indexPath);
    assertSameIdentity(identity, opened, indexPath);
    const openedToken = await preciseFileChangeToken(handle, opened, indexPath);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSecureFile(after, indexPath);
    assertSameIdentity(opened, after, indexPath);
    const afterToken = await preciseFileChangeToken(handle, after, indexPath);
    if (
      opened.size !== after.size
      || !sameFileChangeToken(openedToken, afterToken)
      || bytes.byteLength !== after.size
    ) {
      throw new Error(`Posted-message index ${indexPath} changed while its snapshot was read.`);
    }
    await assertFileIdentity(indexPath, identity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    const entries = parseEntries(bytes.toString("utf8"));
    return {
      entries,
      count: entries.length,
      size: bytes.byteLength,
      identity,
      changeToken: afterToken,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseEntries(raw: string): readonly PostedMessageEntry[] {
  const out: PostedMessageEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseEntry(trimmed);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out;
}

async function appendSecureIndexLine(
  indexPath: string,
  line: string,
  expected: LoadedPostedMessageIndexState,
  directoryIdentity: DirectoryIdentity,
): Promise<FileVersion> {
  let handle: FileHandle | undefined;
  try {
    await assertFileIdentity(indexPath, expected.identity);
    handle = await open(
      indexPath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollowFlag() | nonBlockFlag(),
    );
    const opened = await handle.stat();
    assertSecureFile(opened, indexPath);
    assertSameIdentity(expected.identity, opened, indexPath);
    if (opened.size !== expected.size) {
      throw new Error(`Posted-message index ${indexPath} changed before append.`);
    }
    const result = await handle.write(line);
    const lineBytes = Buffer.byteLength(line);
    if (result.bytesWritten !== lineBytes) {
      throw new Error(`Posted-message index ${indexPath} append was incomplete.`);
    }
    const after = await handle.stat();
    assertSecureFile(after, indexPath);
    assertSameIdentity(opened, after, indexPath);
    if (after.size !== expected.size + lineBytes) {
      throw new Error(`Posted-message index ${indexPath} changed during append.`);
    }
    const changeToken = await preciseFileChangeToken(handle, after, indexPath);
    await assertFileIdentity(indexPath, expected.identity);
    await assertDirectoryIdentity(dirname(indexPath), directoryIdentity);
    return {
      size: after.size,
      changeToken,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secureFileVersion(
  path: string,
  expectedIdentity: FileIdentity,
  directoryIdentity: DirectoryIdentity,
): Promise<FileVersion> {
  let handle: FileHandle | undefined;
  try {
    await assertFileIdentity(path, expectedIdentity);
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | nonBlockFlag());
    const info = await handle.stat();
    assertSecureFile(info, path);
    assertSameIdentity(expectedIdentity, info, path);
    const changeToken = await preciseFileChangeToken(handle, info, path);
    await assertFileIdentity(path, expectedIdentity);
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    return {
      size: info.size,
      changeToken,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function preciseFileChangeToken(
  handle: FileHandle,
  expected: Stats,
  path: string,
): Promise<FileChangeToken> {
  const precise = await handle.stat({ bigint: true });
  if (
    precise.dev !== BigInt(expected.dev)
    || precise.ino !== BigInt(expected.ino)
    || precise.size !== BigInt(expected.size)
  ) {
    throw new Error(`Posted-message index ${path} changed while its metadata was read.`);
  }
  return { ctimeNs: precise.ctimeNs, mtimeNs: precise.mtimeNs };
}

function sameFileChangeToken(left: FileChangeToken, right: FileChangeToken): boolean {
  return left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

async function ensureOwnerOnlyFile(
  path: string,
  directoryIdentity: DirectoryIdentity,
  createIfMissing: boolean,
): Promise<FileIdentity | undefined> {
  const directory = dirname(path);
  await assertDirectoryIdentity(directory, directoryIdentity);
  let created = false;
  let createHandle: FileHandle | undefined;
  if (createIfMissing) {
    try {
      try {
        createHandle = await open(
          path,
          fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag() | nonBlockFlag(),
          0o600,
        );
        created = true;
        await createHandle.chmod(0o600);
        await createHandle.sync();
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw error;
        }
      }
    } finally {
      await createHandle?.close().catch(() => undefined);
    }
  }
  if (!created && !createIfMissing) {
    try {
      await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }

  const before = await lstat(path);
  assertSecureFileShape(before, path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDWR | noFollowFlag() | nonBlockFlag());
    const opened = await handle.stat();
    assertSecureFileShape(opened, path);
    assertSameIdentity(before, opened, path);
    if (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600);
      await handle.sync();
    }
    const secured = await handle.stat();
    assertSecureFile(secured, path);
    assertSameIdentity(opened, secured, path);
    const after = await lstat(path);
    assertSecureFile(after, path);
    assertSameIdentity(secured, after, path);
    await assertDirectoryIdentity(directory, directoryIdentity);
    if (created) {
      await fsyncDirectory(directory, directoryIdentity);
    }
    return identityOf(secured);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureIndexDirectory(indexPath: string): Promise<DirectoryIdentity> {
  const directory = dirname(indexPath);
  await createDirectoryPathWithoutSymlinks(directory);
  const identity = await existingIndexDirectoryIdentityRequired(indexPath);
  return await secureOwnerOnlyDirectory(directory, identity);
}

async function existingIndexDirectoryIdentity(
  indexPath: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    return await existingIndexDirectoryIdentityRequired(indexPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function existingIndexDirectoryIdentityRequired(
  indexPath: string,
): Promise<DirectoryIdentity> {
  const directory = dirname(indexPath);
  const info = await lstat(directory);
  assertSecureDirectory(info, directory);
  return identityOf(info);
}

async function createDirectoryPathWithoutSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) {
          throw mkdirError;
        }
      }
      info = await lstat(current);
    }
    // macOS exposes root-owned compatibility links such as /var -> /private/var.
    // User-controlled links anywhere in the configured path remain fail-closed.
    if (info.isSymbolicLink()) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== 0 || uid === 0) {
        throw new Error(`Posted-message index path component ${current} must not be a user-controlled symbolic link.`);
      }
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(`Posted-message index path component ${current} must be a directory.`);
    }
    assertSafeDirectoryComponent(info, current);
  }
}

async function secureOwnerOnlyDirectory(
  path: string,
  expected: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  if (process.platform === "win32") {
    await assertDirectoryIdentity(path, expected);
    return expected;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag(),
    );
    const opened = await handle.stat();
    assertSecureDirectory(opened, path);
    assertSameIdentity(expected, opened, path);
    if ((opened.mode & 0o777) !== 0o700) {
      await handle.chmod(0o700);
      await handle.sync();
    }
    const secured = await handle.stat();
    assertSecureDirectory(secured, path);
    if ((secured.mode & 0o777) !== 0o700) {
      throw new Error(`Posted-message index directory ${path} must have owner-only mode 0700.`);
    }
    assertSameIdentity(opened, secured, path);
    const after = await lstat(path);
    assertSecureDirectory(after, path);
    assertSameIdentity(secured, after, path);
    return identityOf(secured);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertNoSqliteSidecars(
  lockPath: string,
  directoryIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(dirname(lockPath), directoryIdentity);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const path = `${lockPath}${suffix}`;
    try {
      await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new Error(`Posted-message index SQLite sidecar path ${path} must not exist.`);
  }
}

function assertSecureDirectory(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Posted-message index directory ${path} must be a non-symlink directory.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (process.platform !== "win32" && (info.mode & 0o022) !== 0) {
    throw new Error(`Posted-message index directory ${path} must not be group/world writable.`);
  }
}

function assertSafeDirectoryComponent(info: Stats, path: string): void {
  if (process.platform === "win32" || (info.mode & 0o022) === 0) {
    return;
  }
  const uid = process.getuid?.();
  const rootOwnedSticky = uid !== undefined && info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (!rootOwnedSticky) {
    throw new Error(`Posted-message index path component ${path} must not be group/world writable.`);
  }
}

function assertSecureFileShape(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Posted-message index path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (info.nlink !== 1) {
    throw new Error(`Posted-message index file ${path} must have exactly one hard link.`);
  }
}

function assertSecureFile(info: Stats, path: string): void {
  assertSecureFileShape(info, path);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`Posted-message index file ${path} must have owner-only mode 0600.`);
  }
}

function assertOwnedByCurrentUser(info: Stats, path: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`Posted-message index path ${path} must be owned by the current user.`);
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const info = await lstat(path);
  assertSecureDirectory(info, path);
  assertSameIdentity(expected, info, path);
}

async function assertFileIdentity(path: string, expected: FileIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureFile(info, path);
  assertSameIdentity(expected, info, path);
}

async function assertLockFileIdentity(path: string, expected: FileIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureFile(info, path);
  assertSameIdentity(expected, info, path);
  if (info.size > MAX_LOCK_FILE_BYTES) {
    throw new Error(`Posted-message index lock ${path} is unexpectedly large.`);
  }
}

function assertSameIdentity(before: FileIdentity, after: FileIdentity, path: string): void {
  if (!sameIdentity(before, after)) {
    throw new Error(`Posted-message index path ${path} changed while it was in use.`);
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(info: FileIdentity): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function fsyncDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
  if (process.platform === "win32") {
    await assertDirectoryIdentity(path, expected);
    return;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag(),
    );
    const info = await handle.stat();
    assertSecureDirectory(info, path);
    assertSameIdentity(expected, info, path);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function nonBlockFlag(): number {
  return fsConstants.O_NONBLOCK ?? 0;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function parseEntry(line: string): PostedMessageEntry | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined; // tolerate a torn/partial line
  }
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const channelId = stringField(record.channelId);
  const ts = stringField(record.ts);
  const conversationId = stringField(record.conversationId);
  if (channelId === undefined || ts === undefined || conversationId === undefined) {
    return undefined;
  }
  return {
    channelId,
    ts,
    conversationId,
    writtenAt: stringField(record.writtenAt) ?? "",
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
