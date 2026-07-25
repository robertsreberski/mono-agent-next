// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import {
  atomicReplaceOwnerPrivateFile,
  inspectOwnerPrivateDirectory,
  inspectOwnerPrivateFile,
  type OwnerPrivatePathIdentity,
} from "@mono-agent/module-sdk/secure-fs";

export function resolveRuntimePiPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential === undefined ? undefined : structuredClone(credential);
}

function credentialAt(value: unknown, providerId: string): Credential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pi auth store has an invalid credential for provider ${JSON.stringify(providerId)}`);
  }
  const record = value as Record<string, unknown>;
  if (record.type === "api_key") {
    if (record.key !== undefined && typeof record.key !== "string") {
      throw new Error(`Pi auth store has an invalid API-key credential for provider ${JSON.stringify(providerId)}`);
    }
    if (record.env !== undefined) {
      if (record.env === null || typeof record.env !== "object" || Array.isArray(record.env)
        || Object.values(record.env).some((entry) => typeof entry !== "string")) {
        throw new Error(`Pi auth store has an invalid API-key environment for provider ${JSON.stringify(providerId)}`);
      }
    }
    return structuredClone(record) as unknown as Credential;
  }
  if (record.type === "oauth") {
    if (typeof record.access !== "string" || typeof record.refresh !== "string"
      || !Number.isFinite(record.expires) || Number(record.expires) < 0) {
      throw new Error(`Pi auth store has an invalid OAuth credential for provider ${JSON.stringify(providerId)}`);
    }
    return structuredClone(record) as unknown as Credential;
  }
  throw new Error(`Pi auth store has an unsupported credential type for provider ${JSON.stringify(providerId)}`);
}

const MAX_AUTH_STORE_BYTES = 1_048_576;
const MAX_AUTH_LOCK_BYTES = 1_024;
const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const AUTH_LOCK_OWNER = "@mono-agent/runtime-pi.auth-lock.v1";
const AUTH_LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SecureAuthSnapshot {
  readonly credentials: Map<string, Credential>;
  readonly identity: OwnerPrivatePathIdentity | null;
}

interface AuthLockRecord {
  readonly owner: typeof AUTH_LOCK_OWNER;
  readonly pid: number;
  readonly token: string;
}

function noFollowFlag(): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Pi auth store requires O_NOFOLLOW support");
  }
  return constants.O_NOFOLLOW;
}

function directoryNoFollowFlags(): number {
  if (typeof constants.O_DIRECTORY !== "number") {
    throw new Error("Pi auth store requires O_DIRECTORY support");
  }
  return constants.O_RDONLY | noFollowFlag() | constants.O_DIRECTORY;
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Pi auth store owner validation requires process.getuid()");
  }
  return process.getuid();
}

function identityFromStat(path: string, stat: Stats): OwnerPrivatePathIdentity {
  return Object.freeze({
    path: resolve(path),
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
    links: stat.nlink,
    size: stat.size,
  });
}

function sameIdentity(
  left: OwnerPrivatePathIdentity,
  right: OwnerPrivatePathIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameSecureSnapshot(
  left: OwnerPrivatePathIdentity,
  right: OwnerPrivatePathIdentity,
): boolean {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.mode === right.mode
    && left.links === right.links
    && left.size === right.size;
}

function validateOwnerPrivateFileStat(path: string, stat: Stats, label: string): OwnerPrivatePathIdentity {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  if (stat.uid !== currentUid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o777) !== AUTH_FILE_MODE) {
    throw new Error(`${label} mode must be exactly 0600`);
  }
  return identityFromStat(path, stat);
}

async function assertPathMatches(
  expected: OwnerPrivatePathIdentity,
  label: string,
): Promise<void> {
  let pathStat: Stats;
  try {
    pathStat = await lstat(expected.path);
  } catch (error) {
    throw new Error(`${label} changed identity`, { cause: error });
  }
  if (pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.dev !== expected.device
    || pathStat.ino !== expected.inode) {
    throw new Error(`${label} changed identity`);
  }
  const actual = validateOwnerPrivateFileStat(expected.path, pathStat, label);
  if (!sameSecureSnapshot(expected, actual)) {
    throw new Error(`${label} changed identity`);
  }
}

async function readBoundedFile(
  handle: FileHandle,
  maxBytes = MAX_AUTH_STORE_BYTES,
  label = "Pi auth store",
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const capacity = Math.min(64 * 1024, maxBytes - total + 1);
    const chunk = Buffer.allocUnsafe(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new Error(`${label} exceeds ${String(maxBytes)} bytes`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function validateOwnerPrivateDirectoryStat(
  path: string,
  stat: Stats,
  label: string,
): OwnerPrivatePathIdentity {
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  if (stat.uid !== currentUid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o777) !== AUTH_DIRECTORY_MODE) {
    throw new Error(`${label} mode must be exactly 0700`);
  }
  return identityFromStat(path, stat);
}

async function syncOwnerPrivateDirectory(
  expected: OwnerPrivatePathIdentity,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(expected.path, directoryNoFollowFlags());
    const current = validateOwnerPrivateDirectoryStat(
      expected.path,
      await handle.stat(),
      "Pi auth store directory",
    );
    if (!sameIdentity(expected, current)) {
      throw new Error("Pi auth store directory changed identity");
    }
    await handle.sync();
    const verified = await inspectOwnerPrivateDirectory(expected.path);
    if (!sameIdentity(expected, verified)) {
      throw new Error("Pi auth store directory changed identity");
    }
  } finally {
    await handle?.close();
  }
}

async function readSecureAuthFile(path: string): Promise<SecureAuthSnapshot> {
  const absolutePath = resolve(path);
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { credentials: new Map(), identity: null };
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Pi auth store must not be a symbolic link");
    }
    throw new Error("Unable to open Pi auth store", { cause: error });
  }

  try {
    const before = validateOwnerPrivateFileStat(
      absolutePath,
      await handle.stat(),
      "Pi auth store",
    );
    await assertPathMatches(before, "Pi auth store");
    if (before.size > MAX_AUTH_STORE_BYTES) {
      throw new Error(`Pi auth store exceeds ${String(MAX_AUTH_STORE_BYTES)} bytes`);
    }
    const raw = await readBoundedFile(handle);
    const after = validateOwnerPrivateFileStat(
      absolutePath,
      await handle.stat(),
      "Pi auth store",
    );
    if (!sameSecureSnapshot(before, after)) {
      throw new Error("Pi auth store changed identity while reading");
    }
    await assertPathMatches(after, "Pi auth store");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Pi auth store contains invalid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pi auth store must contain a JSON object");
    }
    const credentials = new Map<string, Credential>();
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      credentials.set(providerId, credentialAt(value, providerId));
    }
    return { credentials, identity: after };
  } finally {
    await handle.close();
  }
}

function authLockRecord(raw: string): AuthLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3
    || keys[0] !== "owner"
    || keys[1] !== "pid"
    || keys[2] !== "token"
    || record.owner !== AUTH_LOCK_OWNER
    || !Number.isSafeInteger(record.pid)
    || Number(record.pid) <= 0
    || typeof record.token !== "string"
    || !AUTH_LOCK_TOKEN.test(record.token)) {
    return undefined;
  }
  return {
    owner: AUTH_LOCK_OWNER,
    pid: Number(record.pid),
    token: record.token,
  };
}

function processIsDurablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      return descriptor !== undefined
        && "value" in descriptor
        && descriptor.value === "ESRCH";
    } catch {
      return false;
    }
  }
}

async function recoverDeadAuthLock(
  lockPath: string,
  directory: OwnerPrivatePathIdentity,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(lockPath, constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    const before = validateOwnerPrivateFileStat(
      lockPath,
      await handle.stat(),
      "Pi auth store lock",
    );
    if (before.size > MAX_AUTH_LOCK_BYTES) return false;
    await assertPathMatches(before, "Pi auth store lock");
    const firstRaw = await readBoundedFile(handle, MAX_AUTH_LOCK_BYTES, "Pi auth store lock");
    const secondRaw = await readBoundedFile(handle, MAX_AUTH_LOCK_BYTES, "Pi auth store lock");
    if (firstRaw !== secondRaw) return false;
    const record = authLockRecord(firstRaw);
    if (record === undefined || !processIsDurablyDead(record.pid)) return false;

    const after = validateOwnerPrivateFileStat(
      lockPath,
      await handle.stat(),
      "Pi auth store lock",
    );
    if (!sameSecureSnapshot(before, after)) return false;
    await assertPathMatches(after, "Pi auth store lock");
    const finalRaw = await readBoundedFile(handle, MAX_AUTH_LOCK_BYTES, "Pi auth store lock");
    if (finalRaw !== firstRaw) return false;
    await handle.close();
    handle = undefined;

    const current = validateOwnerPrivateFileStat(
      lockPath,
      await lstat(lockPath),
      "Pi auth store lock",
    );
    if (!sameSecureSnapshot(after, current)) return false;
    await assertPathMatches(current, "Pi auth store lock");
    await unlink(lockPath);
    await syncOwnerPrivateDirectory(directory);
    return true;
  } catch {
    // Existing locks are fail-closed unless every owner/identity/death check
    // succeeds. Never remove a malformed, unsafe, or changing lock.
    return false;
  } finally {
    await handle?.close();
  }
}

async function withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const lockPath = `${absolutePath}.lock`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryIdentity = await inspectOwnerPrivateDirectory(directory);
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2 && handle === undefined; attempt += 1) {
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(),
        AUTH_FILE_MODE,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("Unable to lock Pi auth store", { cause: error });
      }
      if (attempt === 0 && await recoverDeadAuthLock(lockPath, directoryIdentity)) {
        continue;
      }
      throw new Error("Pi auth store is locked by another process");
    }
  }
  if (handle === undefined) throw new Error("Unable to lock Pi auth store");

  let result: T | undefined;
  let failure: unknown;
  let lockIdentity: OwnerPrivatePathIdentity | undefined;
  let lockContents: string | undefined;
  try {
    // This descriptor names the lock we just exclusively created. Descriptor
    // chmod is safe here and only compensates for a more restrictive umask.
    await handle.chmod(AUTH_FILE_MODE);
    lockIdentity = validateOwnerPrivateFileStat(
      lockPath,
      await handle.stat(),
      "Pi auth store lock",
    );
    await assertPathMatches(lockIdentity, "Pi auth store lock");
    lockContents = `${JSON.stringify({
      owner: AUTH_LOCK_OWNER,
      pid: process.pid,
      token: randomUUID(),
    } satisfies AuthLockRecord)}\n`;
    await handle.writeFile(lockContents, "utf8");
    await handle.sync();
    const writtenIdentity = validateOwnerPrivateFileStat(
      lockPath,
      await handle.stat(),
      "Pi auth store lock",
    );
    if (!sameIdentity(lockIdentity, writtenIdentity)) {
      throw new Error("Pi auth store lock changed identity while writing");
    }
    await assertPathMatches(writtenIdentity, "Pi auth store lock");
    lockIdentity = writtenIdentity;
    await syncOwnerPrivateDirectory(directoryIdentity);
    result = await task();
  } catch (error) {
    failure = error;
  }

  let cleanupFailure: unknown;
  try {
    if (lockIdentity !== undefined && lockContents !== undefined) {
      const finalContents = await readBoundedFile(
        handle,
        MAX_AUTH_LOCK_BYTES,
        "Pi auth store lock",
      );
      if (finalContents !== lockContents) {
        throw new Error("Pi auth store lock changed contents before cleanup");
      }
      const descriptorIdentity = validateOwnerPrivateFileStat(
        lockPath,
        await handle.stat(),
        "Pi auth store lock",
      );
      if (!sameSecureSnapshot(lockIdentity, descriptorIdentity)) {
        throw new Error("Pi auth store lock changed identity before cleanup");
      }
      await assertPathMatches(descriptorIdentity, "Pi auth store lock");
      lockIdentity = descriptorIdentity;
    }
    await handle.close();
    handle = undefined;
    if (lockIdentity === undefined) {
      cleanupFailure = new Error("Pi auth store lock identity was not established");
    } else {
      const current = validateOwnerPrivateFileStat(
        lockPath,
        await lstat(lockPath),
        "Pi auth store lock",
      );
      if (!sameSecureSnapshot(lockIdentity, current)) {
        throw new Error("Pi auth store lock changed identity before cleanup");
      }
      await assertPathMatches(current, "Pi auth store lock");
      await unlink(lockPath);
      await syncOwnerPrivateDirectory(directoryIdentity);
    }
  } catch (error) {
    cleanupFailure = error;
    await handle?.close().catch(() => undefined);
  }

  if (failure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([failure, cleanupFailure], "Pi auth operation and lock cleanup both failed");
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result as T;
}

function serializeCredentials(credentials: ReadonlyMap<string, Credential>): string {
  const serialized = Object.fromEntries(
    [...credentials.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  let json: string;
  try {
    json = JSON.stringify(serialized, null, 2);
  } catch (error) {
    throw new Error("Pi auth store contains a credential that cannot be serialized", { cause: error });
  }
  const persisted = `${json}\n`;
  if (Buffer.byteLength(persisted, "utf8") > MAX_AUTH_STORE_BYTES) {
    throw new Error(`Pi auth store exceeds ${String(MAX_AUTH_STORE_BYTES)} bytes`);
  }

  // Re-parse the exact bytes that will be committed so JSON coercion cannot
  // turn a callback result into a different or malformed stored credential.
  const reparsed = JSON.parse(json) as Record<string, unknown>;
  for (const [providerId, credential] of Object.entries(reparsed)) {
    credentialAt(credential, providerId);
  }
  return persisted;
}

async function writeSecureAuthFile(
  path: string,
  credentials: ReadonlyMap<string, Credential>,
  expected: OwnerPrivatePathIdentity | null,
): Promise<void> {
  const serialized = serializeCredentials(credentials);
  const persisted = await atomicReplaceOwnerPrivateFile(
    resolve(path),
    serialized,
    { expected },
  );
  const verified = await inspectOwnerPrivateFile(resolve(path));
  if (!sameSecureSnapshot(persisted, verified)) {
    throw new Error("Pi auth store changed identity after atomic persistence");
  }
}

/** Owner-private Pi credential storage with atomic OAuth refresh rotation. */
export class PiCredentialStore implements CredentialStore {
  readonly #path: string;
  #chain = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    await this.#chain;
    return cloneCredential((await readSecureAuthFile(this.#path)).credentials.get(providerId));
  }

  async list(): Promise<readonly CredentialInfo[]> {
    await this.#chain;
    const snapshot = await readSecureAuthFile(this.#path);
    return [...snapshot.credentials.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    let result: Credential | undefined;
    const current = this.#chain.catch(() => undefined).then(async () => {
      result = await withFileLock(this.#path, async () => {
        const snapshot = await readSecureAuthFile(this.#path);
        const before = cloneCredential(snapshot.credentials.get(providerId));
        const next = await fn(before);
        if (next === undefined) return before;
        const validated = credentialAt(next, providerId);
        snapshot.credentials.set(providerId, validated);
        await writeSecureAuthFile(this.#path, snapshot.credentials, snapshot.identity);
        return validated;
      });
    });
    this.#chain = current.then(() => undefined, () => undefined);
    await current;
    return cloneCredential(result);
  }

  async delete(providerId: string): Promise<void> {
    const current = this.#chain.catch(() => undefined).then(async () => {
      await withFileLock(this.#path, async () => {
        const snapshot = await readSecureAuthFile(this.#path);
        if (!snapshot.credentials.delete(providerId)) return;
        await writeSecureAuthFile(this.#path, snapshot.credentials, snapshot.identity);
      });
    });
    this.#chain = current.then(() => undefined, () => undefined);
    await current;
  }

  async redactionValues(): Promise<readonly string[]> {
    const values = new Set<string>();
    for (const { providerId } of await this.list()) {
      const credential = await this.read(providerId);
      if (credential?.type === "api_key") {
        if (credential.key) values.add(credential.key);
        for (const value of Object.values(credential.env ?? {})) if (value) values.add(value);
      } else if (credential?.type === "oauth") {
        if (credential.access) values.add(credential.access);
        if (credential.refresh) values.add(credential.refresh);
      }
    }
    return [...values];
  }
}

const MAX_RUNTIME_PI_ERROR_BYTES = 4_096;

function ownDataString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null
    || value === undefined
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "boolean"
    || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return "Runtime failure";
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    if (descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string") {
      return descriptor.value;
    }
  } catch {
    // Proxies and accessor-backed failures are not trusted as text sources.
  }
  return "Runtime failure";
}

function boundedUtf8ErrorText(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_RUNTIME_PI_ERROR_BYTES) return value;
  let end = MAX_RUNTIME_PI_ERROR_BYTES;
  while (end > 0
    && (((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000)) {
    end -= 1;
  }
  return `${bytes.subarray(0, end).toString("utf8")}…[truncated]`;
}

export function redactRuntimePiText(value: unknown, secrets: readonly string[]): string {
  let text = ownDataString(value);
  for (const secret of [...new Set(secrets)].filter((entry) => entry.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\b(token|api[_ -]?key|refresh[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return boundedUtf8ErrorText(text);
}
