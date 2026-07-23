import { createHash, randomUUID } from "node:crypto";
import {
  link,
  opendir,
  rename,
  unlink,
} from "node:fs/promises";
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
  syncSecureDirectory,
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
const ARTIFACT_INDEX_VALUE_BYTES = 1_024;
const ARTIFACT_ID_PATTERN = /^artifact:sha256:(?<digest>[a-f0-9]{64})$/u;
const ARTIFACT_SHA256_PATTERN = /^sha256:(?<digest>[a-f0-9]{64})$/u;
const ARTIFACT_REMOVAL_CLAIM_PATTERN =
  /^\.retention-(?<id>[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.claim$/u;
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

type StoredArtifactState =
  | "reserved"
  | "staged"
  | "published"
  | "removing"
  | "releasing"
  | "removed";

interface StoredArtifact {
  readonly digest: string;
  readonly sizeBytes: number;
  readonly storageName: string;
  readonly state: StoredArtifactState;
  readonly createdAt?: string;
  readonly identity?: FileIdentity;
  readonly removalClaim?: string;
}

interface ArtifactSnapshot {
  readonly artifacts: readonly StoredArtifact[];
  readonly records: readonly StoredArtifact[];
  readonly generation: string;
  readonly totalBytes: number;
}

interface ScannedArtifactEntry {
  readonly name: string;
  readonly size: number;
  readonly identity: FileIdentity;
}

export interface StateLocalArtifactMaintenanceResult {
  readonly candidates: number;
  readonly removed: number;
  readonly reclaimedBytes: number;
  readonly truncated: boolean;
}

export interface StateLocalArtifactHooks {
  /** Deterministic collision seam used by focused no-clobber tests. */
  readonly beforePublish?: (target: string) => void | Promise<void>;
  /** Crash seam after the blob is durable but before its transactional index commit. */
  readonly beforeIndexCommit?: (target: string) => void | Promise<void>;
  /** Crash seam after the transactional index commit but before caller success. */
  readonly afterIndexCommit?: (target: string) => void | Promise<void>;
  /** Adversarial seam before an indexed unpublished artifact is claimed for removal. */
  readonly beforeOrphanDelete?: (target: string) => void | Promise<void>;
  /** Crash seam after a removal claim is durable but before its blob is unlinked. */
  readonly afterOrphanClaim?: (claim: string) => void | Promise<void>;
}

export class StateLocalArtifacts {
  private constructor(
    private readonly directory: string,
    private readonly directoryIdentity: FileIdentity,
    private readonly lease: ProcessLease,
    private readonly hooks: StateLocalArtifactHooks,
    private readonly clock: () => Date,
  ) {}

  static async open(
    directory: string,
    forbiddenIdentity: FileIdentity,
    signal: AbortSignal,
    hooks: StateLocalArtifactHooks = {},
    clock: () => Date = () => new Date(),
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
      clock,
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
    let snapshot = await this.scan(request.signal);
    let existing = snapshot.records.find((artifact) => artifact.digest === digest);
    if (existing?.state === "published") {
      const bytes = await this.readStoredAndVerify(
        existing,
        existing.sizeBytes,
        request.signal,
      );
      if (bytes.byteLength !== data.byteLength) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Stored artifact ${ref.id} does not match its content address.`,
        );
      }
      await this.guard();
      return ref;
    }
    if (existing?.state === "removing" || existing?.state === "releasing") {
      await this.finishArtifactRemoval(existing, request.signal);
      snapshot = await this.scan(request.signal);
      existing = snapshot.records.find((artifact) => artifact.digest === digest);
    }
    const activeRecords = snapshot.records.filter((artifact) =>
      artifact.state !== "removed").length;
    if (
      (existing === undefined || existing.state === "removed") &&
      activeRecords >= STATE_LOCAL_MAX_ARTIFACTS
    ) {
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

    let reserved: StoredArtifact;
    if (
      existing === undefined ||
      existing.state === "removed"
    ) {
      reserved = {
        digest,
        sizeBytes: data.byteLength,
        storageName: `artifact-${randomUUID()}.blob`,
        state: "reserved",
        createdAt: canonicalArtifactNow(this.clock),
      };
      const key = `${ARTIFACT_INDEX_PREFIX}${digest}`;
      if (existing === undefined) {
        const inserted = this.lease.writeIndexIfAbsent(
          key,
          encodeStoredArtifact(reserved),
        );
        if (!inserted) {
          throw new StateLocalError(
            "STATE_CORRUPT",
            `Artifact reservation for ${ref.id} collided unexpectedly.`,
          );
        }
      } else {
        this.lease.writeIndex(key, encodeStoredArtifact(reserved));
      }
      await this.guard();
    } else {
      reserved = existing;
      if (
        reserved.state !== "reserved" &&
        reserved.state !== "staged"
      ) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact ${ref.id} has an invalid publication state.`,
        );
      }
      if (reserved.sizeBytes !== data.byteLength) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact reservation ${ref.id} has a mismatched size.`,
        );
      }
    }

    const target = join(this.directory, reserved.storageName);
    let identity = (await inspectSecureFileDetails(target))?.identity;
    if (identity === undefined) {
      await this.hooks.beforePublish?.(target);
      try {
        identity = await createSecureFile(target, data);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact staging target ${reserved.storageName} appeared during publication; it was left untouched.`,
          error,
        );
      }
    }
    const staged: StoredArtifact = {
      digest,
      sizeBytes: data.byteLength,
      storageName: reserved.storageName,
      state: "staged",
      createdAt: reserved.createdAt ?? canonicalArtifactNow(this.clock),
      identity,
    };
    await this.readStoredAndVerify(staged, data.byteLength, request.signal);
    this.lease.writeIndex(
      `${ARTIFACT_INDEX_PREFIX}${digest}`,
      encodeStoredArtifact(staged),
    );
    await this.guard();
    await this.hooks.beforeIndexCommit?.(target);
    const published: StoredArtifact = {
      ...staged,
      state: "published",
    };
    this.lease.writeIndex(
      `${ARTIFACT_INDEX_PREFIX}${digest}`,
      encodeStoredArtifact(published),
    );
    await this.guard();
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

  /**
   * Private state-owner release. The execution recorder calls this only after
   * every durable reference it can authorize has been retired. Generic
   * StateStore deletion deliberately remains conservative and always false.
   *
   * Only schema-v2 rows carry the creation time and inode witness needed to
   * authorize removal. Legacy published rows are immutable.
   */
  async releasePublished(request: StateDeleteArtifactRequest): Promise<boolean> {
    throwIfAborted(request.signal);
    const ref = validateArtifactRef(request.ref);
    await this.guard();
    const digest = digestFromRef(ref);
    let stored = (await this.scan(request.signal)).records
      .find((artifact) => artifact.digest === digest);
    if (stored === undefined || stored.state === "removed") return false;
    if (stored.state === "releasing") {
      await this.finishArtifactRemoval(stored, request.signal);
      return true;
    }
    if (stored.state !== "published" || stored.createdAt === undefined) {
      return false;
    }
    if (stored.sizeBytes !== ref.sizeBytes) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `Published artifact ${ref.id} does not match its release authority.`,
      );
    }
    await this.readStoredAndVerify(stored, ref.sizeBytes, request.signal);
    const removalClaim = `.retention-${randomUUID()}.claim`;
    stored = {
      ...stored,
      state: "releasing",
      removalClaim,
    };
    this.lease.writeIndex(
      `${ARTIFACT_INDEX_PREFIX}${digest}`,
      encodeStoredArtifact(stored),
    );
    await this.guard();
    await this.finishArtifactRemoval(stored, request.signal);
    return true;
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

  async maintain(input: {
    readonly cutoffAt: string;
    readonly dryRun: boolean;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<StateLocalArtifactMaintenanceResult> {
    throwIfAborted(input.signal);
    const cutoff = Date.parse(input.cutoffAt);
    if (
      !Number.isFinite(cutoff) ||
      new Date(cutoff).toISOString() !== input.cutoffAt
    ) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        "Artifact maintenance cutoffAt must be a canonical timestamp.",
      );
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        "Artifact maintenance limit must be from 1 through 10000.",
      );
    }
    await this.guard();
    const snapshot = await this.scan(input.signal);
    const candidates = snapshot.records
      .filter((artifact) =>
        artifact.state === "removing" ||
        artifact.state === "releasing" ||
        (
          (artifact.state === "reserved" || artifact.state === "staged") &&
          artifact.createdAt !== undefined &&
          Date.parse(artifact.createdAt) <= cutoff
        ))
      .sort(compareArtifactMaintenanceCandidates);
    const selected = candidates.slice(0, input.limit);
    if (input.dryRun) {
      return {
        candidates: candidates.length,
        removed: 0,
        reclaimedBytes: 0,
        truncated: candidates.length > selected.length,
      };
    }
    let removed = 0;
    let reclaimedBytes = 0;
    for (const artifact of selected) {
      throwIfAborted(input.signal);
      reclaimedBytes += await this.finishArtifactRemoval(artifact, input.signal);
      removed += 1;
    }
    return {
      candidates: candidates.length,
      removed,
      reclaimedBytes,
      truncated: candidates.length > selected.length,
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
    path = join(this.directory, artifact.storageName),
  ): Promise<Buffer> {
    const identity = await inspectSecureFile(path);
    if (identity === undefined) {
      throw new StateLocalError(
        "STATE_ARTIFACT_NOT_FOUND",
        `Artifact artifact:sha256:${artifact.digest} does not exist.`,
      );
    }
    if (
      artifact.identity !== undefined &&
      !sameFileIdentity(identity, artifact.identity)
    ) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Artifact artifact:sha256:${artifact.digest} changed identity.`,
      );
    }
    const loaded = await readSecureFile(path, maximumBytes, signal);
    if (
      artifact.identity !== undefined &&
      !sameFileIdentity(loaded.identity, artifact.identity)
    ) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Artifact artifact:sha256:${artifact.digest} changed identity.`,
      );
    }
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

  private async finishArtifactRemoval(
    initial: StoredArtifact,
    signal: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal);
    if (
      initial.state !== "reserved" &&
      initial.state !== "staged" &&
      initial.state !== "removing" &&
      initial.state !== "releasing"
    ) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Only owner-authorized artifact states can be removed.",
      );
    }
    let artifact = initial;
    const key = `${ARTIFACT_INDEX_PREFIX}${artifact.digest}`;
    const target = join(this.directory, artifact.storageName);

    if (artifact.state === "reserved") {
      const targetDetails = await inspectSecureFileDetails(target);
      if (targetDetails === undefined) {
        this.lease.writeIndex(
          key,
          encodeStoredArtifact({
            ...artifact,
            state: "removed",
          }),
        );
        await this.guard();
        return 0;
      }
      artifact = {
        ...artifact,
        state: "staged",
        identity: targetDetails.identity,
      };
      await this.readStoredAndVerify(artifact, artifact.sizeBytes, signal);
      this.lease.writeIndex(key, encodeStoredArtifact(artifact));
      await this.guard();
    }

    if (artifact.state === "staged") {
      await this.hooks.beforeOrphanDelete?.(target);
      await this.readStoredAndVerify(artifact, artifact.sizeBytes, signal);
      const removalClaim = `.retention-${randomUUID()}.claim`;
      artifact = {
        ...artifact,
        state: "removing",
        removalClaim,
      };
      this.lease.writeIndex(key, encodeStoredArtifact(artifact));
      await this.guard();
    }

    const claimName = artifact.removalClaim;
    if (
      (artifact.state !== "removing" && artifact.state !== "releasing")
      || claimName === undefined
    ) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Artifact removal state is incomplete.",
      );
    }
    const claim = join(this.directory, claimName);
    let reclaimedBytes = 0;
    let targetDetails = await inspectSecureFileDetails(target);
    let claimDetails = await inspectSecureFileDetails(claim);
    if (targetDetails !== undefined && claimDetails !== undefined) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        "Artifact removal has both a source and a claim.",
      );
    }
    if (targetDetails !== undefined) {
      if (
        artifact.identity === undefined ||
        !sameFileIdentity(targetDetails.identity, artifact.identity)
      ) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          "Artifact changed identity before its retention claim.",
        );
      }
      await this.readStoredAndVerify(artifact, artifact.sizeBytes, signal);
      if ((await inspectSecureFileDetails(claim)) !== undefined) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          "Artifact retention claim appeared before publication.",
        );
      }
      await rename(target, claim);
      await syncSecureDirectory(this.directory);
      claimDetails = await inspectSecureFileDetails(claim);
      targetDetails = await inspectSecureFileDetails(target);
      if (targetDetails !== undefined) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          "Artifact source reappeared during its retention claim.",
        );
      }
    }
    if (claimDetails !== undefined) {
      if (
        artifact.identity === undefined ||
        !sameFileIdentity(claimDetails.identity, artifact.identity)
      ) {
        await restoreUnexpectedClaim(claim, target, this.directory);
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          "Artifact retention claimed a different file; the claimed path was restored.",
        );
      }
      await this.readStoredAndVerify(
        artifact,
        artifact.sizeBytes,
        signal,
        claim,
      );
      await this.hooks.afterOrphanClaim?.(claim);
      await unlink(claim);
      await syncSecureDirectory(this.directory);
      reclaimedBytes = artifact.sizeBytes;
    }
    if (
      (await inspectSecureFileDetails(target)) !== undefined ||
      (await inspectSecureFileDetails(claim)) !== undefined
    ) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        "Artifact removal paths changed after cleanup.",
      );
    }
    this.lease.writeIndex(
      key,
      encodeStoredArtifact({
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        storageName: artifact.storageName,
        state: "removed",
        ...(artifact.createdAt === undefined ? {} : { createdAt: artifact.createdAt }),
      }),
    );
    await this.guard();
    return reclaimedBytes;
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
    const records = rows.map(decodeStoredArtifact);
    const byStorageName = new Map<string, StoredArtifact>();
    const byRemovalClaim = new Map<string, StoredArtifact>();
    for (const artifact of records) {
      if (byStorageName.has(artifact.storageName)) {
        throw new StateLocalError("STATE_CORRUPT", "Artifact index aliases one physical blob.");
      }
      byStorageName.set(artifact.storageName, artifact);
      if (artifact.removalClaim !== undefined) {
        if (byRemovalClaim.has(artifact.removalClaim)) {
          throw new StateLocalError("STATE_CORRUPT", "Artifact index aliases one removal claim.");
        }
        byRemovalClaim.set(artifact.removalClaim, artifact);
      }
    }
    let entries = 0;
    let totalBytes = 0;
    const observedTargets = new Set<string>();
    const observedClaims = new Set<string>();
    const physicalEntries: ScannedArtifactEntry[] = [];
    const removalClaims: ScannedArtifactEntry[] = [];
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
      const scanned = {
        name: entry.name,
        size: details.size,
        identity: details.identity,
      };
      if (ARTIFACT_REMOVAL_CLAIM_PATTERN.test(entry.name)) {
        removalClaims.push(scanned);
      } else {
        physicalEntries.push(scanned);
      }
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
        // Legacy stores can contain a blob created before durable reservation
        // was introduced. Its ownership is not provable, so maintenance never
        // deletes it. It remains invisible and counts against all bounds.
        continue;
      }
      if (indexed.state === "removed") {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Removed artifact ${entry.name} still has a physical blob.`,
        );
      }
      observedTargets.add(entry.name);
      if (entry.size !== indexed.sizeBytes) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Indexed artifact ${entry.name} does not match its declared size.`,
        );
      }
      if (
        indexed.identity !== undefined &&
        !sameFileIdentity(entry.identity, indexed.identity)
      ) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          `Indexed artifact ${entry.name} changed identity.`,
        );
      }
      await this.readStoredAndVerify(indexed, indexed.sizeBytes, signal);
    }
    for (const entry of removalClaims) {
      totalBytes += entry.size;
      if (entry.size > STATE_LOCAL_MAX_ARTIFACT_BYTES) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact removal claim ${entry.name} exceeds the package size limit.`,
        );
      }
      if (totalBytes > STATE_LOCAL_MAX_TOTAL_ARTIFACT_BYTES) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Artifact storage exceeds the package total-size limit.",
        );
      }
      const indexed = byRemovalClaim.get(entry.name);
      if (
        indexed === undefined ||
        (indexed.state !== "removing" && indexed.state !== "releasing") ||
        indexed.identity === undefined
      ) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact removal claim ${entry.name} has no matching transaction.`,
        );
      }
      if (
        entry.size !== indexed.sizeBytes ||
        !sameFileIdentity(entry.identity, indexed.identity)
      ) {
        throw new StateLocalError(
          "STATE_PATH_CHANGED",
          `Artifact removal claim ${entry.name} changed identity.`,
        );
      }
      observedClaims.add(entry.name);
      await this.readStoredAndVerify(
        indexed,
        indexed.sizeBytes,
        signal,
        join(this.directory, entry.name),
      );
    }
    for (const artifact of records) {
      const targetPresent = observedTargets.has(artifact.storageName);
      const claimPresent = artifact.removalClaim === undefined
        ? false
        : observedClaims.has(artifact.removalClaim);
      if (targetPresent && claimPresent) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Artifact removal has both a source and a claim.",
        );
      }
      if (
        (artifact.state === "published" || artifact.state === "staged") &&
        !targetPresent
      ) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          `Artifact index references missing ${artifact.state} bytes.`,
        );
      }
      if (
        (artifact.state === "removing" || artifact.state === "releasing") &&
        artifact.removalClaim === undefined
      ) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Artifact removal index is missing its claim name.",
        );
      }
      if (
        artifact.state === "removed" &&
        (targetPresent || claimPresent)
      ) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "Removed artifact state still has physical bytes.",
        );
      }
    }
    const artifacts = records
      .filter((artifact) => artifact.state === "published")
      .sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0);
    await this.guard();
    return {
      artifacts,
      records,
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
  const value = {
    schemaVersion: 2,
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    storageName: artifact.storageName,
    state: artifact.state,
    createdAt: artifact.createdAt,
    ...(artifact.identity === undefined
      ? {}
      : {
          device: artifact.identity.device,
          inode: artifact.identity.inode,
        }),
    ...(artifact.removalClaim === undefined
      ? {}
      : { removalClaim: artifact.removalClaim }),
  };
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
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
  if (!isPlainRecord(value)) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`);
  }
  const candidate = value;
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
  if (hasExactKeys(candidate, ["digest", "sizeBytes", "storageName"])) {
    // Pre-maintenance source-beta rows are immutable published artifacts.
    // They remain readable but have no deletion provenance or retention age.
    return {
      digest,
      sizeBytes: candidate.sizeBytes as number,
      storageName: candidate.storageName,
      state: "published",
    };
  }
  const state = candidate.state;
  if (
    candidate.schemaVersion !== 2 ||
    typeof state !== "string" ||
    !["reserved", "staged", "published", "removing", "releasing", "removed"].includes(state)
  ) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`);
  }
  const expectedKeys = [
    "createdAt",
    "digest",
    "schemaVersion",
    "sizeBytes",
    "state",
    "storageName",
    ...(state === "staged" || state === "published" || state === "removing" || state === "releasing"
      ? ["device", "inode"]
      : []),
    ...(state === "removing" || state === "releasing" ? ["removalClaim"] : []),
  ];
  if (
    !hasExactKeys(candidate, expectedKeys) ||
    typeof candidate.createdAt !== "string" ||
    !isCanonicalTimestamp(candidate.createdAt)
  ) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`);
  }
  const identityRequired =
    state === "staged" || state === "published" || state === "removing" || state === "releasing";
  const identity = identityRequired
    ? readStoredIdentity(candidate, row.key)
    : undefined;
  const removalClaim = state === "removing" || state === "releasing"
    ? candidate.removalClaim
    : undefined;
  if (
    (state === "removing" || state === "releasing") &&
    (
      typeof removalClaim !== "string" ||
      !ARTIFACT_REMOVAL_CLAIM_PATTERN.test(removalClaim)
    )
  ) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${row.key} is invalid.`);
  }
  return {
    digest,
    sizeBytes: candidate.sizeBytes as number,
    storageName: candidate.storageName,
    state: state as StoredArtifactState,
    createdAt: candidate.createdAt,
    ...(identity === undefined ? {} : { identity }),
    ...(typeof removalClaim === "string" ? { removalClaim } : {}),
  };
}

function readStoredIdentity(
  candidate: Record<string, unknown>,
  key: string,
): FileIdentity {
  if (
    !Number.isSafeInteger(candidate.device) ||
    (candidate.device as number) < 0 ||
    !Number.isSafeInteger(candidate.inode) ||
    (candidate.inode as number) < 1
  ) {
    throw new StateLocalError("STATE_CORRUPT", `Artifact index entry ${key} is invalid.`);
  }
  return {
    device: candidate.device as number,
    inode: candidate.inode as number,
  };
}

function compareArtifactMaintenanceCandidates(
  left: StoredArtifact,
  right: StoredArtifact,
): number {
  const leftTime = left.createdAt ?? "";
  const rightTime = right.createdAt ?? "";
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

async function restoreUnexpectedClaim(
  claim: string,
  target: string,
  directory: string,
): Promise<void> {
  try {
    await link(claim, target);
  } catch (error) {
    throw new StateLocalError(
      "STATE_PATH_CHANGED",
      "Artifact retention could not restore a mismatched claim without clobbering another path.",
      error,
    );
  }
  await syncSecureDirectory(directory);
  await unlink(claim);
  await syncSecureDirectory(directory);
}

function canonicalArtifactNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      "The local artifact clock returned an invalid date.",
    );
  }
  return value.toISOString();
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
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
