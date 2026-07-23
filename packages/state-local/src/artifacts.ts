import { createHash, randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

import { parseArtifactRef, type ArtifactRef } from "@mono-agent/module-sdk";

import { StateLocalError, throwIfAborted } from "./errors.js";
import {
  acquireProcessLease,
  createSecureFile,
  ensureSecureDirectory,
  inspectSecureFile,
  inspectSecureFileDetails,
  readSecureFile,
  type FileIdentity,
  type ProcessLease,
  verifySecureDirectoryIdentity,
} from "./secure-fs.js";

const ARTIFACT_MARKER_FILE = ".mono-agent-artifacts";
const ARTIFACT_MARKER_CONTENT = '{"kind":"mono-agent-state-artifacts","schemaVersion":1}\n';
const ARTIFACT_LEASE_FILE = ".mono-agent-artifacts.lease.sqlite";
const ARTIFACT_INDEX_FILE = `${ARTIFACT_LEASE_FILE}.index`;
const ARTIFACT_INDEX_WITNESS_FILE = `${ARTIFACT_INDEX_FILE}.witness`;
const ARTIFACT_BLOB_PATTERN =
  /^artifact-(?<id>[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.blob$/u;
const ARTIFACT_INDEX_PREFIX = "artifact:";
const ARTIFACT_INDEX_VALUE_BYTES = 512;
const ARTIFACT_ID_PATTERN = /^artifact:sha256:(?<digest>[a-f0-9]{64})$/u;
const ARTIFACT_SHA256_PATTERN = /^sha256:(?<digest>[a-f0-9]{64})$/u;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

export const STATE_LOCAL_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const STATE_LOCAL_MAX_TOTAL_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const STATE_LOCAL_MAX_ARTIFACTS = 100_000;

export type StateArtifactRef = ArtifactRef;

export interface StatePutArtifactRequest {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly fileName?: string;
  readonly signal: AbortSignal;
}

export interface StateReadArtifactRequest {
  readonly ref: StateArtifactRef;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface StateDeleteArtifactRequest {
  readonly ref: StateArtifactRef;
  readonly signal: AbortSignal;
}

export interface StateListArtifactsRequest {
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface StateListArtifactsResult {
  readonly artifacts: readonly StateArtifactRef[];
  readonly cursor?: string;
}

interface StoredArtifact {
  readonly digest: string;
  readonly sizeBytes: number;
  readonly storageName: string;
}

interface ArtifactSnapshot {
  readonly artifacts: readonly StoredArtifact[];
  readonly generation: string;
  readonly totalBytes: number;
}

interface ScannedArtifactEntry {
  readonly name: string;
  readonly size: number;
}

export interface StateLocalArtifactHooks {
  /** Deterministic collision seam used by focused no-clobber tests. */
  readonly beforePublish?: (target: string) => void | Promise<void>;
  /** Crash seam after the blob is durable but before its transactional index commit. */
  readonly beforeIndexCommit?: (target: string) => void | Promise<void>;
  /** Crash seam after the transactional index commit but before caller success. */
  readonly afterIndexCommit?: (target: string) => void | Promise<void>;
}

export class StateLocalArtifacts {
  private constructor(
    private readonly directory: string,
    private readonly directoryIdentity: FileIdentity,
    private readonly lease: ProcessLease,
    private readonly hooks: StateLocalArtifactHooks,
  ) {}

  static async open(
    directory: string,
    forbiddenIdentity: FileIdentity,
    signal: AbortSignal,
    hooks: StateLocalArtifactHooks = {},
  ): Promise<StateLocalArtifacts> {
    throwIfAborted(signal);
    const secureDirectory = await ensureSecureDirectory(directory);
    if (
      secureDirectory.identity.device === forbiddenIdentity.device &&
      secureDirectory.identity.inode === forbiddenIdentity.inode
    ) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        "runs.artifactsDirectory must not be the state root.",
      );
    }
    await prepareArtifactMarker(secureDirectory.path, signal);
    const lease = await acquireProcessLease(join(secureDirectory.path, ARTIFACT_LEASE_FILE));
    const artifacts = new StateLocalArtifacts(
      secureDirectory.path,
      secureDirectory.identity,
      lease,
      hooks,
    );
    try {
      await artifacts.scan(signal);
      return artifacts;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async put(request: StatePutArtifactRequest): Promise<StateArtifactRef> {
    throwIfAborted(request.signal);
    if (!(request.data instanceof Uint8Array)) {
      throw new StateLocalError("STATE_CORRUPT", "Artifact data must be bytes.");
    }
    const data = Buffer.from(request.data);
    if (data.byteLength > STATE_LOCAL_MAX_ARTIFACT_BYTES) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        `Artifact exceeds the ${STATE_LOCAL_MAX_ARTIFACT_BYTES} byte package limit.`,
      );
    }
    const mediaType = validateMediaType(request.mediaType);
    const fileName = request.fileName === undefined
      ? undefined
      : validateFileName(request.fileName);
    const digest = sha256(data);
    const ref = createArtifactRef(digest, data.byteLength, mediaType, fileName);

    await this.guard();
    const snapshot = await this.scan(request.signal);
    const existing = snapshot.artifacts.find((artifact) => artifact.digest === digest);
    if (existing !== undefined) {
      const bytes = await this.readStoredAndVerify(existing, existing.sizeBytes, request.signal);
      if (bytes.byteLength !== data.byteLength) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Stored artifact ${ref.id} does not match its content address.`,
        );
      }
      await this.guard();
      return ref;
    }
    if (snapshot.artifacts.length >= STATE_LOCAL_MAX_ARTIFACTS) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        `Artifact storage has reached the ${STATE_LOCAL_MAX_ARTIFACTS} artifact package limit.`,
      );
    }
    if (snapshot.totalBytes + data.byteLength > STATE_LOCAL_MAX_TOTAL_ARTIFACT_BYTES) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        `Artifact storage has reached the ${STATE_LOCAL_MAX_TOTAL_ARTIFACT_BYTES} byte package limit.`,
      );
    }

    const storageName = `artifact-${randomUUID()}.blob`;
    const target = join(this.directory, storageName);
    await this.hooks.beforePublish?.(target);
    try {
      await createSecureFile(target, data);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // Re-observe and re-guard after validating any concurrently committed
      // winner. A random-path collision without a matching index is corruption,
      // never permission to overwrite the path.
      await this.guard();
      const winner = (await this.scan(request.signal)).artifacts
        .find((artifact) => artifact.digest === digest);
      if (winner !== undefined) {
        await this.readStoredAndVerify(winner, data.byteLength, request.signal);
        await this.guard();
        return ref;
      }
      throw new StateLocalError(
        "STATE_CORRUPT",
        `Artifact staging target ${storageName} appeared during publication; it was left untouched.`,
        error,
      );
    }
    await this.guard();
    const staged: StoredArtifact = { digest, sizeBytes: data.byteLength, storageName };
    await this.readStoredAndVerify(staged, data.byteLength, request.signal);
    await this.hooks.beforeIndexCommit?.(target);
    const inserted = this.lease.writeIndexIfAbsent(
      `${ARTIFACT_INDEX_PREFIX}${digest}`,
      encodeStoredArtifact(staged),
    );
    if (!inserted) {
      await this.guard();
      const winner = (await this.scan(request.signal)).artifacts
        .find((artifact) => artifact.digest === digest);
      if (winner === undefined) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact index collision for ${ref.id} has no verifiable winner.`,
        );
      }
      await this.readStoredAndVerify(winner, data.byteLength, request.signal);
      await this.guard();
      return ref;
    }
    await this.hooks.afterIndexCommit?.(target);
    await this.guard();
    const committed = (await this.scan(request.signal)).artifacts
      .find((artifact) => artifact.digest === digest);
    if (committed === undefined) {
      throw new StateLocalError("STATE_CORRUPT", `Committed artifact ${ref.id} is not indexed.`);
    }
    return ref;
  }

  async read(request: StateReadArtifactRequest): Promise<Uint8Array> {
    throwIfAborted(request.signal);
    const ref = validateArtifactRef(request.ref);
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 0 ||
      request.maxBytes > STATE_LOCAL_MAX_ARTIFACT_BYTES
    ) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        `Artifact read maxBytes must be an integer from 0 through ${STATE_LOCAL_MAX_ARTIFACT_BYTES}.`,
      );
    }
    if (ref.sizeBytes > request.maxBytes) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        `Artifact ${ref.id} exceeds the requested read bound.`,
      );
    }
    await this.guard();
    const digest = digestFromRef(ref);
    const stored = (await this.scan(request.signal)).artifacts
      .find((artifact) => artifact.digest === digest);
    if (stored === undefined) {
      throw new StateLocalError("STATE_ARTIFACT_NOT_FOUND", `Artifact ${ref.id} does not exist.`);
    }
    const bytes = await this.readStoredAndVerify(stored, request.maxBytes, request.signal);
    if (bytes.byteLength !== ref.sizeBytes) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `Stored artifact ${ref.id} does not match its declared size.`,
      );
    }
    return bytes;
  }

  async delete(request: StateDeleteArtifactRequest): Promise<boolean> {
    throwIfAborted(request.signal);
    const ref = validateArtifactRef(request.ref);
    await this.guard();
    const digest = digestFromRef(ref);
    const stored = (await this.scan(request.signal)).artifacts
      .find((artifact) => artifact.digest === digest);
    if (stored === undefined) return false;
    await this.readStoredAndVerify(stored, ref.sizeBytes, request.signal);
    await this.guard();
    // Multiple logical references collapse onto one content-addressed name.
    // Until durable reference accounting exists, unlinking here could destroy
    // bytes still referenced by another transcript or run. False truthfully
    // reports that no physical deletion occurred.
    return false;
  }

  async list(request: StateListArtifactsRequest): Promise<StateListArtifactsResult> {
    throwIfAborted(request.signal);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        "Artifact list limit must be from 1 through 1000.",
      );
    }
    await this.guard();
    const snapshot = await this.scan(request.signal);
    const afterDigest = decodeArtifactCursor(request.cursor, snapshot.generation);
    const matching = snapshot.artifacts.filter((artifact) =>
      afterDigest === undefined || artifact.digest > afterDigest);
    const selected = matching.slice(0, request.limit);
    const cursor = matching.length > selected.length
      ? encodeArtifactCursor(
          selected[selected.length - 1]?.digest,
          snapshot.generation,
        )
      : undefined;
    return {
      artifacts: selected.map((artifact) =>
        createArtifactRef(
          artifact.digest,
          artifact.sizeBytes,
          DEFAULT_MEDIA_TYPE,
        )),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  async close(): Promise<void> {
    await this.lease.release();
  }

  verify(): Promise<void> {
    return this.guard();
  }

  private async readStoredAndVerify(
    artifact: StoredArtifact,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const path = join(this.directory, artifact.storageName);
    if ((await inspectSecureFile(path)) === undefined) {
      throw new StateLocalError(
        "STATE_ARTIFACT_NOT_FOUND",
        `Artifact artifact:sha256:${artifact.digest} does not exist.`,
      );
    }
    const loaded = await readSecureFile(path, maximumBytes, signal);
    if (loaded.bytes.byteLength > STATE_LOCAL_MAX_ARTIFACT_BYTES) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `Stored artifact artifact:sha256:${artifact.digest} exceeds the package limit.`,
      );
    }
    if (loaded.bytes.byteLength !== artifact.sizeBytes || sha256(loaded.bytes) !== artifact.digest) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `Stored artifact artifact:sha256:${artifact.digest} does not match its content address.`,
      );
    }
    return Buffer.from(loaded.bytes);
  }

  private async scan(signal: AbortSignal): Promise<ArtifactSnapshot> {
    await this.guard();
    const keys = this.lease.listIndexKeys("", STATE_LOCAL_MAX_ARTIFACTS);
    if (keys.some((key) => !key.startsWith(ARTIFACT_INDEX_PREFIX))) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Artifact transactional index contains an unexpected entry.",
      );
    }
    const rows = this.lease.listIndex(ARTIFACT_INDEX_PREFIX, {
      maximumEntries: STATE_LOCAL_MAX_ARTIFACTS,
      maximumValueBytes: ARTIFACT_INDEX_VALUE_BYTES,
      maximumTotalBytes: STATE_LOCAL_MAX_ARTIFACTS * ARTIFACT_INDEX_VALUE_BYTES,
    });
    if (rows.length > STATE_LOCAL_MAX_ARTIFACTS) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Artifact index contains too many entries.");
    }
    const artifacts = rows.map(decodeStoredArtifact);
    const byStorageName = new Map<string, StoredArtifact>();
    for (const artifact of artifacts) {
      if (byStorageName.has(artifact.storageName)) {
        throw new StateLocalError("STATE_CORRUPT", "Artifact index aliases one physical blob.");
      }
      byStorageName.set(artifact.storageName, artifact);
    }
    let entries = 0;
    let totalBytes = 0;
    const observed = new Set<string>();
    const physicalEntries: ScannedArtifactEntry[] = [];
    for await (const entry of await opendir(this.directory)) {
      throwIfAborted(signal);
      entries += 1;
      if (entries > STATE_LOCAL_MAX_ARTIFACTS + 32) {
        throw new StateLocalError(
          "STATE_LIMIT_EXCEEDED",
          "Artifact directory contains too many entries.",
        );
      }
      if (isArtifactInternalFile(entry.name)) {
        if (
          entry.name !== ARTIFACT_MARKER_FILE &&
          entry.name !== ARTIFACT_LEASE_FILE
        ) {
          const details = await inspectSecureFileDetails(
            join(this.directory, entry.name),
            entry.name === ARTIFACT_INDEX_FILE ||
              entry.name === ARTIFACT_INDEX_WITNESS_FILE
              ? 2
              : 1,
          );
          if (details === undefined) {
            throw new StateLocalError(
              "STATE_PATH_CHANGED",
              `Artifact storage internal file ${entry.name} disappeared during inspection.`,
            );
          }
        }
        continue;
      }
      const details = await inspectSecureFileDetails(join(this.directory, entry.name));
      if (details === undefined) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          `Artifact storage entry ${entry.name} disappeared during inspection.`,
        );
      }
      physicalEntries.push({ name: entry.name, size: details.size });
    }
    // Inspect every non-internal entry before interpreting names. This makes a
    // symlink or hard-link attack deterministically fail as insecure even when
    // its companion pathname would otherwise be classified as unexpected
    // first by filesystem iteration order.
    for (const entry of physicalEntries) {
      if (!ARTIFACT_BLOB_PATTERN.test(entry.name)) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact directory contains unexpected entry ${entry.name}.`,
        );
      }
      if (entry.size > STATE_LOCAL_MAX_ARTIFACT_BYTES) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact ${entry.name} exceeds the package size limit.`,
        );
      }
      totalBytes += entry.size;
      if (totalBytes > STATE_LOCAL_MAX_TOTAL_ARTIFACT_BYTES) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Artifact storage exceeds the package total-size limit.",
        );
      }
      const indexed = byStorageName.get(entry.name);
      if (indexed === undefined) {
        // A crash before the SQLite index commit leaves a bounded private
        // orphan. It is never listed or addressable and is counted against both
        // physical entry and byte ceilings.
        continue;
      }
      observed.add(entry.name);
      if (entry.size !== indexed.sizeBytes) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Indexed artifact ${entry.name} does not match its declared size.`,
        );
      }
      await this.readStoredAndVerify(indexed, indexed.sizeBytes, signal);
    }
    if (observed.size !== artifacts.length) {
      throw new StateLocalError("STATE_CORRUPT", "Artifact index references a missing blob.");
    }
    artifacts.sort((left, right) =>
      left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0);
    await this.guard();
    return {
      artifacts,
      generation: sha256(Buffer.from(
        artifacts.map((artifact) => `${artifact.digest}:${artifact.sizeBytes}\n`).join(""),
        "utf8",
      )),
      totalBytes,
    };
  }

  private async guard(): Promise<void> {
    await verifySecureDirectoryIdentity(this.directory, this.directoryIdentity);
    await this.lease.verify();
  }

}

async function prepareArtifactMarker(directory: string, signal: AbortSignal): Promise<void> {
  const path = join(directory, ARTIFACT_MARKER_FILE);
  const existing = await inspectSecureFile(path);
  if (existing === undefined) {
    let entries = 0;
    for await (const _entry of await opendir(directory)) {
      throwIfAborted(signal);
      entries += 1;
      if (entries > 0) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Refusing to claim a non-empty directory as artifact storage.",
        );
      }
    }
    await createSecureFile(path, Buffer.from(ARTIFACT_MARKER_CONTENT, "utf8"));
    return;
  }
  const loaded = await readSecureFile(path, 1_024, signal);
  if (loaded.bytes.toString("utf8") !== ARTIFACT_MARKER_CONTENT) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "The local artifact ownership marker is invalid.",
    );
  }
}

function isArtifactInternalFile(name: string): boolean {
  return name === ARTIFACT_MARKER_FILE ||
    name === ARTIFACT_LEASE_FILE ||
    name === ARTIFACT_INDEX_FILE ||
    name === ARTIFACT_INDEX_WITNESS_FILE;
}

function validateArtifactRef(value: StateArtifactRef): StateArtifactRef {
  let parsed: ArtifactRef;
  try {
    parsed = parseArtifactRef(value);
  } catch (error) {
    throw new StateLocalError("STATE_CORRUPT", "Artifact reference is invalid.", error);
  }
  const idMatch = ARTIFACT_ID_PATTERN.exec(parsed.id);
  const shaMatch = ARTIFACT_SHA256_PATTERN.exec(parsed.sha256);
  const idDigest = idMatch?.groups?.digest;
  const shaDigest = shaMatch?.groups?.digest;
  if (idDigest === undefined || shaDigest === undefined || idDigest !== shaDigest) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Artifact reference id and sha256 must name the same canonical SHA-256 digest.",
    );
  }
  if (
    !Number.isSafeInteger(parsed.sizeBytes) ||
    parsed.sizeBytes < 0 ||
    parsed.sizeBytes > STATE_LOCAL_MAX_ARTIFACT_BYTES
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Artifact reference sizeBytes is invalid.");
  }
  const mediaType = validateMediaType(parsed.mediaType);
  const fileName = parsed.fileName === undefined
    ? undefined
    : validateFileName(parsed.fileName);
  return createArtifactRef(idDigest, parsed.sizeBytes, mediaType, fileName);
}

function createArtifactRef(
  digest: string,
  sizeBytes: number,
  mediaType: string,
  fileName?: string,
): StateArtifactRef {
  return Object.freeze({
    id: `artifact:sha256:${digest}`,
    sha256: `sha256:${digest}` as const,
    sizeBytes,
    mediaType,
    ...(fileName === undefined ? {} : { fileName }),
  });
}

function digestFromRef(ref: StateArtifactRef): string {
  const digest = ARTIFACT_ID_PATTERN.exec(ref.id)?.groups?.digest;
  if (digest === undefined) {
    throw new StateLocalError("STATE_CORRUPT", "Artifact reference id is invalid.");
  }
  return digest;
}

function validateMediaType(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(value)
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Artifact mediaType must be a bounded IANA media type.",
    );
  }
  return value;
}

function validateFileName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[/\\\u0000-\u001f\u007f]/u.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Artifact fileName must be a bounded path-free display name.",
    );
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeStoredArtifact(artifact: StoredArtifact): Buffer {
  return Buffer.from(`${JSON.stringify({
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    storageName: artifact.storageName,
  })}\n`, "utf8");
}

function decodeStoredArtifact(
  row: { readonly key: string; readonly value: Buffer },
): StoredArtifact {
  let value: unknown;
  try {
    value = JSON.parse(row.value.toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`, error);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "digest,sizeBytes,storageName"
  ) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`);
  }
  const candidate = value as {
    readonly digest?: unknown;
    readonly sizeBytes?: unknown;
    readonly storageName?: unknown;
  };
  const digest = row.key.slice(ARTIFACT_INDEX_PREFIX.length);
  if (
    !/^[a-f0-9]{64}$/u.test(digest) ||
    candidate.digest !== digest ||
    !Number.isSafeInteger(candidate.sizeBytes) ||
    (candidate.sizeBytes as number) < 0 ||
    (candidate.sizeBytes as number) > STATE_LOCAL_MAX_ARTIFACT_BYTES ||
    typeof candidate.storageName !== "string" ||
    !ARTIFACT_BLOB_PATTERN.test(candidate.storageName)
  ) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`);
  }
  return {
    digest,
    sizeBytes: candidate.sizeBytes as number,
    storageName: candidate.storageName,
  };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST";
}

function encodeArtifactCursor(
  digest: string | undefined,
  generation: string,
): string | undefined {
  if (digest === undefined) return undefined;
  return Buffer.from(JSON.stringify({ v: 1, g: generation, k: digest }), "utf8")
    .toString("base64url");
}

function decodeArtifactCursor(
  cursor: string | undefined,
  generation: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4_096) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "Artifact list cursor is invalid.");
  }
  let raw: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("Non-canonical cursor");
    raw = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "Artifact list cursor is invalid.", error);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Object.keys(raw).sort().join(",") !== "g,k,v" ||
    (raw as { v?: unknown }).v !== 1 ||
    (raw as { g?: unknown }).g !== generation ||
    typeof (raw as { k?: unknown }).k !== "string" ||
    !/^[a-f0-9]{64}$/u.test((raw as { k: string }).k)
  ) {
    throw new StateLocalError(
      "STATE_INVALID_CURSOR",
      "Artifact list cursor does not match this storage snapshot.",
    );
  }
  return (raw as { k: string }).k;
}
