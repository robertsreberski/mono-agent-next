import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import {
  FileError,
  err,
  ok,
  type JsonlSessionMetadata,
  type Result,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createOwnerPrivateFile,
  ensureOwnerPrivateDirectory,
  inspectOwnerPrivateFile,
  readOwnerPrivateFile,
  type OwnerPrivatePathIdentity,
} from "@mono-agent/module-sdk";

export interface RuntimePiSessionAttempt {
  readonly id: string;
  readonly session: Session;
}

export interface RuntimePiSessionAttemptResult<T> {
  /** Retain a persistent session as a completed audit artifact. */
  readonly completed: boolean;
  readonly value: T;
}

export interface RuntimePiSessionAttemptOptions {
  readonly conversationId: string;
  readonly modelKey: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly resumeSessionId?: string;
}

interface OpenAttempt extends RuntimePiSessionAttempt {
  readonly commit: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

type ManagerState = "running" | "stopping" | "stopped";
type ReservationPhase = "reserved" | "committed";

const RESERVATION_OWNER = "@mono-agent/runtime-pi.session-reservation.v1";
const RESERVATION_DIRECTORY = ".mono-agent-runtime-pi-attempts";
const RESERVATION_MAX_BYTES = 16 * 1024;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_FILE_MAX_BYTES = 64 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface ReservationRecord {
  readonly version: 1;
  readonly owner: typeof RESERVATION_OWNER;
  readonly namespaceHash: string;
  readonly managerId: string;
  readonly pid: number;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly conversationHash: string;
  readonly modelHash: string;
  readonly turnHash: string;
  readonly phase: ReservationPhase;
  readonly createdAt: string;
  readonly committedAt?: string;
}

interface ReservationHandle {
  readonly path: string;
  readonly record: ReservationRecord;
  identity: OwnerPrivatePathIdentity;
  committed: boolean;
}

interface SessionReservationMetadata {
  readonly owner: typeof RESERVATION_OWNER;
  readonly namespaceHash: string;
  readonly managerId: string;
  readonly pid: number;
  readonly reservationId: string;
  readonly attemptId: string;
}

interface SessionFileIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly ancestors: readonly PathIdentity[];
}

function fileFailure(path: string, error: unknown): FileError {
  return new FileError(
    errorCode(error) === "ENOENT" ? "not_found" : "unknown",
    error instanceof Error ? error.message : "runtime-pi guarded session I/O failed",
    path,
    error instanceof Error ? error : undefined,
  );
}

function sessionPathInside(root: string, path: string): boolean {
  const remainder = relative(resolve(root), resolve(path));
  return remainder !== ""
    && !isAbsolute(remainder)
    && remainder !== ".."
    && !remainder.startsWith(`..${sep}`);
}

async function sessionAncestorIdentities(
  sessionsRoot: string,
  sessionPath: string,
): Promise<readonly PathIdentity[]> {
  const rootPath = resolve(sessionsRoot);
  const targetPath = resolve(sessionPath);
  if (!sessionPathInside(rootPath, targetPath)) {
    throw new Error("runtime-pi session path must remain within the sessions root");
  }
  const remainder = relative(rootPath, targetPath);
  const segments = remainder.split(sep).filter((segment) => segment.length > 0);
  const identities: PathIdentity[] = [];
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  let cursor = rootPath;
  for (const segment of ["", ...segments.slice(0, -1)]) {
    if (segment !== "") cursor = join(cursor, segment);
    const entry = await lstat(cursor, { bigint: true });
    if (entry.isSymbolicLink()
      || !entry.isDirectory()
      || (uid !== undefined && entry.uid !== uid)
      || (entry.mode & 0o7777n) !== 0o700n) {
      throw new Error("runtime-pi session path ancestors must be owner-private non-symlink directories");
    }
    identities.push({ path: cursor, device: entry.dev, inode: entry.ino });
  }
  return identities;
}

async function readGuardedSessionBytes(
  path: string,
  sessionsRoot: string,
  expected?: SessionFileIdentity,
): Promise<{ readonly bytes: Uint8Array; readonly identity: SessionFileIdentity }> {
  const ancestors = await sessionAncestorIdentities(sessionsRoot, path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | requireNoFollow());
    const before = await handle.stat({ bigint: true });
    const pathEntry = await lstat(path, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    if ((before.mode & 0o7777n) !== 0o600n) {
      throw new Error("runtime-pi pre-existing session file mode must be exactly 0600");
    }
    if (!before.isFile()
      || before.nlink !== 1n
      || (uid !== undefined && before.uid !== uid)
      || pathEntry.isSymbolicLink()
      || pathEntry.dev !== before.dev
      || pathEntry.ino !== before.ino
      || (expected !== undefined
        && (before.dev !== expected.device || before.ino !== expected.inode))) {
      throw new Error("runtime-pi session file failed owner/type/link/identity validation");
    }
    if (before.size > BigInt(SESSION_FILE_MAX_BYTES)) {
      throw new Error(`runtime-pi session exceeds ${String(SESSION_FILE_MAX_BYTES)} bytes`);
    }
    const bytes = await readBoundedSessionFile(handle, SESSION_FILE_MAX_BYTES);
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== before.nlink
      || after.uid !== before.uid
      || after.mode !== before.mode
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || finalPath.isSymbolicLink()
      || finalPath.dev !== after.dev
      || finalPath.ino !== after.ino) {
      throw new Error("runtime-pi guarded session file changed while being read");
    }
    await assertAncestorIdentities(ancestors);
    return {
      bytes,
      identity: fileIdentity(path, after, ancestors),
    };
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error("runtime-pi session file must not be a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readBoundedSessionFile(
  handle: FileHandle,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const capacity = Math.min(64 * 1024, maxBytes - length + 1);
    const chunk = new Uint8Array(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity, length);
    if (bytesRead === 0) break;
    length += bytesRead;
    if (length > maxBytes) throw new Error(`runtime-pi session exceeds ${String(maxBytes)} bytes`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class GuardedSessionExecutionEnv extends NodeExecutionEnv {
  readonly #sessionsRoot: string | undefined;
  readonly #guards = new Map<string, SessionFileIdentity>();

  constructor(cwd: string, sessionsRoot: string | undefined) {
    super({ cwd });
    this.#sessionsRoot = sessionsRoot;
  }

  #sessionPath(path: string): string | undefined {
    if (this.#sessionsRoot === undefined) return undefined;
    const absolute = resolve(this.cwd, path);
    return absolute.endsWith(".jsonl")
      && sessionPathInside(this.#sessionsRoot, absolute)
      ? absolute
      : undefined;
  }

  register(identity: SessionFileIdentity): void {
    this.#guards.set(resolve(identity.path), identity);
  }

  unregister(path: string): void {
    this.#guards.delete(resolve(path));
  }

  override async createDir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<Result<void, FileError>> {
    const absolute = resolve(this.cwd, path);
    if (this.#sessionsRoot === undefined
      || !sessionPathInside(this.#sessionsRoot, join(absolute, "session.jsonl"))) {
      return super.createDir(path, options);
    }
    try {
      await ensureOwnerPrivateDirectory(absolute);
      return ok(undefined);
    } catch (error) {
      return err(fileFailure(absolute, error));
    }
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const absolute = this.#sessionPath(path);
    if (absolute === undefined || this.#sessionsRoot === undefined) {
      return super.writeFile(path, content, abortSignal);
    }
    try {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      if (bytes.byteLength > SESSION_FILE_MAX_BYTES) {
        throw new Error(`runtime-pi session exceeds ${String(SESSION_FILE_MAX_BYTES)} bytes`);
      }
      await ensureOwnerPrivateDirectory(dirname(absolute), {
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
      });
      await createOwnerPrivateFile(absolute, bytes, {
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
      });
      const guarded = await readGuardedSessionBytes(
        absolute,
        this.#sessionsRoot,
      );
      this.register(guarded.identity);
      return ok(undefined);
    } catch (error) {
      return err(fileFailure(absolute, error));
    }
  }

  override async appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const absolute = this.#sessionPath(path);
    if (absolute === undefined || this.#sessionsRoot === undefined) {
      return super.appendFile(path, content);
    }
    const expected = this.#guards.get(absolute);
    if (expected === undefined) {
      return err(new FileError(
        "permission_denied",
        "runtime-pi refuses to append to an unguarded session",
        absolute,
      ));
    }
    let handle: FileHandle | undefined;
    try {
      if (abortSignal?.aborted === true) throw abortSignal.reason;
      await assertAncestorIdentities(expected.ancestors);
      handle = await open(
        absolute,
        constants.O_WRONLY | constants.O_APPEND | requireNoFollow(),
      );
      const before = await handle.stat({ bigint: true });
      const pathEntry = await lstat(absolute, { bigint: true });
      const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
      if (!before.isFile()
        || before.dev !== expected.device
        || before.ino !== expected.inode
        || before.nlink !== 1n
        || (before.mode & 0o7777n) !== 0o600n
        || (uid !== undefined && before.uid !== uid)
        || pathEntry.isSymbolicLink()
        || pathEntry.dev !== before.dev
        || pathEntry.ino !== before.ino) {
        throw new Error("runtime-pi guarded session changed before append");
      }
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      if (before.size + BigInt(bytes.byteLength) > BigInt(SESSION_FILE_MAX_BYTES)) {
        throw new Error(`runtime-pi session exceeds ${String(SESSION_FILE_MAX_BYTES)} bytes`);
      }
      await handle.writeFile(bytes);
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      const finalPath = await lstat(absolute, { bigint: true });
      if (after.dev !== before.dev
        || after.ino !== before.ino
        || after.nlink !== 1n
        || after.uid !== before.uid
        || after.mode !== before.mode
        || after.size !== before.size + BigInt(bytes.byteLength)
        || finalPath.isSymbolicLink()
        || finalPath.dev !== after.dev
        || finalPath.ino !== after.ino) {
        throw new Error("runtime-pi guarded session changed during append");
      }
      await assertAncestorIdentities(expected.ancestors);
      this.register(fileIdentity(absolute, after, expected.ancestors));
      return ok(undefined);
    } catch (error) {
      return err(fileFailure(absolute, error));
    } finally {
      await handle?.close();
    }
  }

  override async readTextFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const absolute = this.#sessionPath(path);
    if (absolute === undefined || this.#sessionsRoot === undefined) {
      return super.readTextFile(path, abortSignal);
    }
    try {
      if (abortSignal?.aborted === true) throw abortSignal.reason;
      const read = await readGuardedSessionBytes(
        absolute,
        this.#sessionsRoot,
        this.#guards.get(absolute),
      );
      this.register(read.identity);
      return ok(UTF8_DECODER.decode(read.bytes));
    } catch (error) {
      return err(fileFailure(absolute, error));
    }
  }

  override async readTextLines(
    path: string,
    options?: { readonly maxLines?: number; readonly abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const absolute = this.#sessionPath(path);
    if (absolute === undefined || this.#sessionsRoot === undefined) {
      return super.readTextLines(path, options);
    }
    const result = await this.readTextFile(absolute, options?.abortSignal);
    if (!result.ok) return result;
    const lines = result.value.split(/\r?\n/u);
    if (lines.at(-1) === "") lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  override async cleanup(): Promise<void> {
    this.#guards.clear();
    await super.cleanup();
  }
}

interface PathIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface SessionBinding {
  readonly conversationHash: string;
  readonly modelHash: string;
}

export class RuntimePiSessionUnavailableError extends Error {
  constructor(message = "runtime-pi native session was not found") {
    super(message);
    this.name = "RuntimePiSessionUnavailableError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attemptId(options: {
  namespace: string;
  conversationId: string;
  modelKey: string;
  turnId: string;
}): string {
  const value = createHash("sha256")
    .update(options.namespace)
    .update("\0")
    .update(options.conversationId)
    .update("\0")
    .update(options.modelKey)
    .update("\0")
    .update(options.turnId)
    .update("\0")
    .update(randomUUID())
    .digest("hex")
    .slice(0, 32);
  return `pi-${value}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

async function waitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function aggregate(primary: unknown, cleanup: unknown, message: string): AggregateError {
  return new AggregateError([primary, cleanup], message);
}

function errorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "code");
  return descriptor !== undefined
    && "value" in descriptor
    && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function requireNoFollow(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("runtime-pi persistent sessions require O_NOFOLLOW support");
  }
  return constants.O_NOFOLLOW;
}

async function validateSessionsRoot(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error("Unable to create runtime-pi sessions root", { cause: error });
  }
  const stat = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("runtime-pi sessions root must be a directory, not a symbolic link");
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("runtime-pi sessions root must be owned by the current user");
  }
  if ((stat.mode & 0o7777) !== 0o700) {
    throw new Error("runtime-pi sessions root mode must be exactly 0700");
  }
}

function reservationMetadata(
  record: ReservationRecord,
): Record<string, unknown> {
  return {
    monoAgentRuntimePi: {
      owner: record.owner,
      namespaceHash: record.namespaceHash,
      managerId: record.managerId,
      pid: record.pid,
      reservationId: record.reservationId,
      attemptId: record.attemptId,
    },
  };
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sessionReservation(
  metadata: JsonlSessionMetadata,
): SessionReservationMetadata | undefined {
  const root = ownRecord(metadata.metadata);
  const value = ownRecord(root?.monoAgentRuntimePi);
  if (value === undefined
    || value.owner !== RESERVATION_OWNER
    || typeof value.namespaceHash !== "string"
    || typeof value.managerId !== "string"
    || !Number.isSafeInteger(value.pid)
    || typeof value.reservationId !== "string"
    || typeof value.attemptId !== "string") {
    return undefined;
  }
  return {
    owner: RESERVATION_OWNER,
    namespaceHash: value.namespaceHash,
    managerId: value.managerId,
    pid: value.pid as number,
    reservationId: value.reservationId,
    attemptId: value.attemptId,
  };
}

function sameReservation(
  left: SessionReservationMetadata,
  right: ReservationRecord,
): boolean {
  return left.owner === right.owner
    && left.namespaceHash === right.namespaceHash
    && left.managerId === right.managerId
    && left.pid === right.pid
    && left.reservationId === right.reservationId
    && left.attemptId === right.attemptId;
}

function safeReservationRecord(value: unknown): ReservationRecord {
  const record = ownRecord(value);
  if (record === undefined
    || record.version !== 1
    || record.owner !== RESERVATION_OWNER
    || typeof record.namespaceHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.namespaceHash)
    || typeof record.managerId !== "string"
    || typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.reservationId !== "string"
    || !/^[0-9a-f-]{36}$/u.test(record.reservationId)
    || typeof record.attemptId !== "string"
    || !/^pi-[0-9a-f]{32}$/u.test(record.attemptId)
    || typeof record.conversationHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.conversationHash)
    || typeof record.modelHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.modelHash)
    || typeof record.turnHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.turnHash)
    || (record.phase !== "reserved" && record.phase !== "committed")
    || typeof record.createdAt !== "string"
    || (record.committedAt !== undefined && typeof record.committedAt !== "string")
    || (record.phase === "reserved" && record.committedAt !== undefined)
    || (record.phase === "committed" && record.committedAt === undefined)) {
    throw new Error("runtime-pi session reservation is malformed");
  }
  return record as unknown as ReservationRecord;
}

function encodeReservation(record: ReservationRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function readReservation(path: string): Promise<ReservationHandle> {
  const identity = await inspectOwnerPrivateFile(path);
  const bytes = await readOwnerPrivateFile(path, { maxBytes: RESERVATION_MAX_BYTES });
  const latest = await inspectOwnerPrivateFile(path);
  if (latest.device !== identity.device || latest.inode !== identity.inode) {
    throw new Error("runtime-pi session reservation changed while being read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (error) {
    throw new Error("runtime-pi session reservation is not valid UTF-8 JSON", { cause: error });
  }
  const record = safeReservationRecord(parsed);
  return {
    path,
    identity,
    record,
    committed: record.phase === "committed",
  };
}

async function deleteReservation(handle: ReservationHandle): Promise<void> {
  try {
    const latest = await lstat(handle.path);
    if (latest.isSymbolicLink()
      || latest.dev !== handle.identity.device
      || latest.ino !== handle.identity.inode) {
      throw new Error("runtime-pi session reservation changed before deletion");
    }
    await unlink(handle.path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function headerReservation(
  header: Record<string, unknown>,
): SessionReservationMetadata | undefined {
  const metadata = ownRecord(header.metadata);
  return sessionReservation({
    id: typeof header.id === "string" ? header.id : "",
    createdAt: typeof header.timestamp === "string" ? header.timestamp : "",
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    path: "",
    ...(metadata === undefined ? {} : { metadata }),
  });
}

async function readSessionHeader(
  handle: FileHandle,
  path: string,
): Promise<Record<string, unknown>> {
  const bytes = Buffer.alloc(SESSION_HEADER_MAX_BYTES + 1);
  let total = 0;
  let lineEnd = -1;
  while (total < bytes.byteLength && lineEnd < 0) {
    const { bytesRead } = await handle.read(
      bytes,
      total,
      bytes.byteLength - total,
      total,
    );
    if (bytesRead === 0) break;
    const localEnd = bytes.subarray(total, total + bytesRead).indexOf(0x0a);
    if (localEnd >= 0) lineEnd = total + localEnd;
    total += bytesRead;
  }
  if (lineEnd < 0 || lineEnd > SESSION_HEADER_MAX_BYTES) {
    throw new Error(`runtime-pi session header is absent or exceeds ${String(SESSION_HEADER_MAX_BYTES)} bytes`);
  }
  try {
    const parsed = JSON.parse(UTF8_DECODER.decode(bytes.subarray(0, lineEnd)));
    const record = ownRecord(parsed);
    if (record === undefined) throw new Error("header is not an object");
    return record;
  } catch (error) {
    throw new Error(`runtime-pi session ${path} has an invalid header`, { cause: error });
  }
}

function fileIdentity(
  path: string,
  stat: BigIntStats,
  ancestors: readonly PathIdentity[],
): SessionFileIdentity {
  return { path, device: stat.dev, inode: stat.ino, ancestors };
}

async function assertAncestorIdentities(
  expected: readonly PathIdentity[],
): Promise<void> {
  for (const identity of expected) {
    const current = await lstat(identity.path, { bigint: true });
    if (current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== identity.device
      || current.ino !== identity.inode) {
      throw new Error("runtime-pi session path ancestor changed identity");
    }
  }
}

async function validateSessionMetadataFile(
  metadata: JsonlSessionMetadata,
  options: {
    readonly expectedReservation?: ReservationRecord;
    readonly hardenOwnedCreation?: boolean;
    readonly sessionsRoot: string;
  },
): Promise<SessionFileIdentity> {
  const authoredRoot = resolve(options.sessionsRoot);
  const authoredPath = resolve(metadata.path);
  const remainder = relative(authoredRoot, authoredPath);
  if (remainder === ""
    || isAbsolute(remainder)
    || remainder === ".."
    || remainder.startsWith(`..${sep}`)) {
    throw new Error("runtime-pi session path must remain within the sessions root");
  }
  const ancestors = await sessionAncestorIdentities(authoredRoot, authoredPath);
  const expected = options.expectedReservation;
  const declaredReservation = sessionReservation(metadata);
  if (expected !== undefined
    && (declaredReservation === undefined
      || !sameReservation(declaredReservation, expected))) {
    throw new Error("runtime-pi session does not carry the owned reservation");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      metadata.path,
      (options.hardenOwnedCreation === true ? constants.O_RDWR : constants.O_RDONLY)
        | requireNoFollow(),
    );
    const before = await handle.stat({ bigint: true });
    const pathStat = await lstat(metadata.path, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || before.dev !== pathStat.dev
      || before.ino !== pathStat.ino
      || (uid !== undefined && before.uid !== uid)) {
      throw new Error("runtime-pi session file failed owner/type/link/identity validation");
    }
    const header = await readSessionHeader(handle, metadata.path);
    const fromHeader = headerReservation(header);
    if (header.type !== "session"
      || header.version !== 3
      || header.id !== metadata.id
      || header.cwd !== metadata.cwd
      || fromHeader === undefined
      || declaredReservation === undefined
      || fromHeader.reservationId !== declaredReservation.reservationId
      || fromHeader.attemptId !== declaredReservation.attemptId
      || fromHeader.managerId !== declaredReservation.managerId
      || fromHeader.namespaceHash !== declaredReservation.namespaceHash
      || fromHeader.pid !== declaredReservation.pid) {
      throw new Error("runtime-pi session header does not match its reserved identity");
    }
    const beforeMutation = await handle.stat({ bigint: true });
    if (beforeMutation.dev !== before.dev
      || beforeMutation.ino !== before.ino
      || beforeMutation.nlink !== before.nlink
      || beforeMutation.uid !== before.uid
      || beforeMutation.mode !== before.mode
      || beforeMutation.size !== before.size
      || beforeMutation.mtimeNs !== before.mtimeNs
      || beforeMutation.ctimeNs !== before.ctimeNs) {
      throw new Error("runtime-pi session file changed while validating its header");
    }
    let hardened = false;
    if ((before.mode & 0o7777n) !== 0o600n) {
      if (options.hardenOwnedCreation !== true || expected === undefined) {
        throw new Error("runtime-pi pre-existing session file mode must be exactly 0600");
      }
      await assertAncestorIdentities(ancestors);
      // This descriptor was returned by the just-created, token-bound session.
      // All owner/type/link/path/header checks above precede the only mutation.
      await handle.chmod(0o600);
      hardened = true;
    }
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(metadata.path, { bigint: true });
    if (!after.isFile()
      || after.nlink !== 1n
      || (after.mode & 0o7777n) !== 0o600n
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.uid !== before.uid
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || (!hardened && after.ctimeNs !== before.ctimeNs)
      || finalPath.isSymbolicLink()
      || finalPath.dev !== after.dev
      || finalPath.ino !== after.ino) {
      throw new Error("runtime-pi session file changed during validation");
    }
    await assertAncestorIdentities(ancestors);
    return fileIdentity(metadata.path, after, ancestors);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error("runtime-pi session file must not be a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function deleteSessionFile(
  metadata: JsonlSessionMetadata,
  expectedReservation: ReservationRecord,
  sessionsRoot: string,
): Promise<void> {
  let identity: SessionFileIdentity;
  try {
    identity = await validateSessionMetadataFile(metadata, {
      expectedReservation,
      sessionsRoot,
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const latest = await lstat(identity.path, { bigint: true });
  await assertAncestorIdentities(identity.ancestors);
  if (latest.isSymbolicLink()
    || latest.dev !== identity.device
    || latest.ino !== identity.inode) {
    throw new Error("runtime-pi session file changed before deletion");
  }
  await unlink(identity.path);
}

async function syncAndValidateCommittedSession(
  metadata: JsonlSessionMetadata,
  expectedReservation: ReservationRecord,
  sessionsRoot: string,
): Promise<SessionFileIdentity> {
  const identity = await validateSessionMetadataFile(metadata, {
    expectedReservation,
    sessionsRoot,
  });
  let handle: FileHandle | undefined;
  try {
    handle = await open(metadata.path, constants.O_RDWR | requireNoFollow());
    const current = await handle.stat({ bigint: true });
    if (!current.isFile()
      || current.dev !== identity.device
      || current.ino !== identity.inode
      || current.nlink !== 1n
      || (current.mode & 0o7777n) !== 0o600n) {
      throw new Error("runtime-pi session changed before durable commit");
    }
    await assertAncestorIdentities(identity.ancestors);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const read = await readGuardedSessionBytes(
    metadata.path,
    sessionsRoot,
    identity,
  );
  if (read.bytes.at(-1) !== 0x0a) {
    throw new Error("runtime-pi session is truncated before durable commit");
  }
  let decoded: string;
  try {
    decoded = UTF8_DECODER.decode(read.bytes);
  } catch (error) {
    throw new Error("runtime-pi session is not valid UTF-8 before durable commit", {
      cause: error,
    });
  }
  for (const [index, line] of decoded.split("\n").entries()) {
    if (line === "") continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (ownRecord(entry) === undefined || typeof ownRecord(entry)?.type !== "string") {
        throw new Error("entry is not an object with a type");
      }
    } catch (error) {
      throw new Error(
        `runtime-pi session line ${String(index + 1)} is invalid before durable commit`,
        { cause: error },
      );
    }
  }
  return read.identity;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function rawAttemptSessionPaths(
  sessionsRoot: string,
  attemptIdValue: string,
): Promise<readonly string[]> {
  const entries = await readdir(sessionsRoot, { recursive: true });
  return entries
    .filter((entry) =>
      entry.endsWith(".jsonl")
      && basename(entry).endsWith(`_${attemptIdValue}.jsonl`))
    .map((entry) => resolve(sessionsRoot, entry))
    .filter((path) => sessionPathInside(sessionsRoot, path));
}

export {
  RESERVATION_DIRECTORY,
  RESERVATION_OWNER,
  GuardedSessionExecutionEnv,
  aggregate,
  attemptId,
  deleteReservation,
  deleteSessionFile,
  digest,
  encodeReservation,
  errorCode,
  processIsAlive,
  rawAttemptSessionPaths,
  readReservation,
  reservationMetadata,
  sameReservation,
  sessionReservation,
  syncAndValidateCommittedSession,
  throwIfAborted,
  validateSessionMetadataFile,
  validateSessionsRoot,
  waitWithSignal,
};
export type {
  ManagerState,
  OpenAttempt,
  ReservationHandle,
  ReservationRecord,
  SessionBinding,
};
