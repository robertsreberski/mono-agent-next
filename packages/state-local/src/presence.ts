import { createHash } from "node:crypto";
import { join } from "node:path";

import type { JsonObject } from "@mono-agent/module-sdk";

import type { ResolvedStateLocalDiscoveryConfig } from "./config.js";
import { StateLocalError, throwIfAborted } from "./errors.js";
import {
  ensureSecureDirectory,
  inspectSecureFileDetails,
  openOrCreateSingleLinkPinnedSecureFile,
  type AtomicReplaceHooks,
  type FileIdentity,
  type PinnedSecureFile,
  type ProcessLease,
  verifySecureDirectoryIdentity,
} from "./secure-fs.js";

const PRESENCE_FILE_BYTES = 64 * 1024;
const PRESENCE_INDEX_BYTES = PRESENCE_FILE_BYTES + 4 * 1024;
const PRESENCE_INDEX_PREFIX = "presence:";
const PUBLICATION_METADATA_KEY = "_stateLocalPublication";

export type StatePresenceStatus = "starting" | "ready" | "degraded" | "stopping" | "stopped";

export interface StatePresenceUpdate {
  readonly status: StatePresenceStatus;
  readonly details?: JsonObject;
}

export interface StatePresenceDescriptor {
  readonly schema: "mono-agent.state-presence.v1";
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly stateRoot: string;
  readonly status: StatePresenceStatus;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly details?: JsonObject;
}

export interface PresencePublisherOptions {
  readonly config: ResolvedStateLocalDiscoveryConfig;
  readonly instanceId: string;
  readonly stateRoot: string;
  readonly startedAt: string;
  readonly clock: () => Date;
  readonly index: ProcessLease;
  readonly hooks?: AtomicReplaceHooks;
}

export class PresencePublisher {
  path: string;
  private readonly options: PresencePublisherOptions;
  private registryDirectory: string;
  private directoryIdentity: FileIdentity | undefined;
  private pinned: PinnedSecureFile | undefined;
  private publication: PresencePublication | undefined;

  constructor(options: PresencePublisherOptions) {
    this.options = options;
    this.registryDirectory = options.config.registryDirectory;
    this.path = join(this.registryDirectory, `${options.config.sourceId}.json`);
  }

  async prepare(): Promise<void> {
    const directory = await ensureSecureDirectory(this.options.config.registryDirectory);
    this.directoryIdentity = directory.identity;
    this.registryDirectory = directory.path;
    this.path = join(this.registryDirectory, `${this.options.config.sourceId}.json`);
    const indexed = readPublication(
      this.options.index.readIndex(
        `${PRESENCE_INDEX_PREFIX}${this.options.config.sourceId}`,
        PRESENCE_INDEX_BYTES,
      ),
      this.options.config.sourceId,
    );
    const targetBefore = await inspectSecureFileDetails(this.path);
    if (indexed === undefined && targetBefore !== undefined) {
      throw new StateLocalError(
        "STATE_PATH_INSECURE",
        `Presence target ${this.path} exists without its transactional ownership record.`,
      );
    }
    if (indexed !== undefined && targetBefore === undefined) {
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Presence target ${this.path} disappeared after its transactional publication.`,
      );
    }
    const initial = indexed?.descriptor ?? this.descriptor({ status: "starting" }, 1);
    const pinned = await openOrCreateSingleLinkPinnedSecureFile(
      this.path,
      encodeDescriptor(initial),
    );
    if (
      indexed !== undefined &&
      (
        indexed.device !== pinned.identity.device ||
        indexed.inode !== pinned.identity.inode
      )
    ) {
      await pinned.close();
      throw new StateLocalError(
        "STATE_PATH_CHANGED",
        `Presence target ${this.path} no longer has its published identity.`,
      );
    }
    this.pinned = pinned;
    if (indexed === undefined) {
      const publication = publicationFor(initial, pinned.identity);
      this.options.index.writeIndex(
        `${PRESENCE_INDEX_PREFIX}${this.options.config.sourceId}`,
        encodePublication(publication),
      );
      await this.options.index.verify();
      this.publication = publication;
    } else {
      this.publication = indexed;
      // The descriptor index record is authoritative. Replaying it through the pinned
      // descriptor repairs a torn cache write without selecting partial bytes.
      await pinned.replace(encodeDescriptor(indexed.descriptor));
    }
  }

  async publish(update: StatePresenceUpdate, signal: AbortSignal): Promise<StatePresenceDescriptor> {
    throwIfAborted(signal);
    const identity = this.directoryIdentity;
    if (identity === undefined) {
      throw new StateLocalError("STATE_CLOSED", "Presence publication has not been prepared.");
    }
    await verifySecureDirectoryIdentity(this.registryDirectory, identity);
    const pinned = this.pinned;
    const publication = this.publication;
    if (pinned === undefined || publication === undefined) {
      throw new StateLocalError("STATE_CLOSED", "Presence publication has not been prepared.");
    }
    validateUpdate(update);
    const descriptor = this.descriptor(update, publication.generation + 1);
    const next = publicationFor(descriptor, pinned.identity);
    await pinned.replace(
      encodeDescriptor(descriptor),
      this.options.hooks,
    );
    await this.options.index.verify();
    this.options.index.writeIndex(
      `${PRESENCE_INDEX_PREFIX}${this.options.config.sourceId}`,
      encodePublication(next),
    );
    await this.options.index.verify();
    await this.options.hooks?.afterCommit?.(this.path);
    await pinned.verify();
    await verifySecureDirectoryIdentity(this.registryDirectory, identity);
    await this.options.index.verify();
    this.publication = next;
    return descriptor;
  }

  async close(): Promise<void> {
    const pinned = this.pinned;
    this.pinned = undefined;
    if (pinned !== undefined) await pinned.close();
  }

  private descriptor(
    update: StatePresenceUpdate,
    generation: number,
  ): StatePresenceDescriptor {
    const now = this.options.clock().toISOString();
    const baseDetails = update.details === undefined ? {} : { ...update.details };
    if (Object.hasOwn(baseDetails, PUBLICATION_METADATA_KEY)) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        `Presence details key ${PUBLICATION_METADATA_KEY} is reserved.`,
      );
    }
    const checksumInput = {
      schema: "mono-agent.state-presence.v1" as const,
      sourceId: this.options.config.sourceId,
      sourceLabel: this.options.config.sourceLabel,
      instanceId: this.options.instanceId,
      pid: process.pid,
      stateRoot: this.options.stateRoot,
      status: update.status,
      startedAt: this.options.startedAt,
      heartbeatAt: now,
      ...(update.details === undefined ? {} : { details: baseDetails }),
    };
    const checksum = sha256(Buffer.from(JSON.stringify({ generation, descriptor: checksumInput }), "utf8"));
    return {
      ...checksumInput,
      details: {
        ...baseDetails,
        [PUBLICATION_METADATA_KEY]: { generation, checksum },
      },
    };
  }
}

interface PresencePublication {
  readonly generation: number;
  readonly checksum: string;
  readonly device: number;
  readonly inode: number;
  readonly descriptor: StatePresenceDescriptor;
}

function publicationFor(
  descriptor: StatePresenceDescriptor,
  identity: FileIdentity,
): PresencePublication {
  const metadata = publicationMetadata(descriptor);
  return {
    generation: metadata.generation,
    checksum: metadata.checksum,
    device: identity.device,
    inode: identity.inode,
    descriptor,
  };
}

function publicationMetadata(
  descriptor: StatePresenceDescriptor,
): { readonly generation: number; readonly checksum: string } {
  const value = descriptor.details?.[PUBLICATION_METADATA_KEY];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Number.isSafeInteger((value as { generation?: unknown }).generation) ||
    ((value as { generation: number }).generation < 1) ||
    typeof (value as { checksum?: unknown }).checksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test((value as { checksum: string }).checksum)
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Presence publication metadata is invalid.");
  }
  return {
    generation: (value as { generation: number }).generation,
    checksum: (value as { checksum: string }).checksum,
  };
}

function encodeDescriptor(descriptor: StatePresenceDescriptor): Buffer {
  const json = Buffer.from(JSON.stringify(descriptor), "utf8");
  if (json.byteLength > PRESENCE_FILE_BYTES) {
    throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Presence descriptor exceeds 64 KiB.");
  }
  const encoded = Buffer.alloc(PRESENCE_FILE_BYTES, 0x20);
  json.copy(encoded);
  return encoded;
}

function encodePublication(publication: PresencePublication): Buffer {
  return Buffer.from(`${JSON.stringify(publication)}\n`, "utf8");
}

function readPublication(
  bytes: Buffer | undefined,
  sourceId: string,
): PresencePublication | undefined {
  if (bytes === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "Presence transactional record is invalid.",
      error,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "checksum,descriptor,device,generation,inode"
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Presence transactional record is invalid.");
  }
  const record = value as Partial<PresencePublication>;
  if (
    !Number.isSafeInteger(record.generation) ||
    (record.generation ?? 0) < 1 ||
    typeof record.checksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.checksum) ||
    !Number.isSafeInteger(record.device) ||
    !Number.isSafeInteger(record.inode) ||
    typeof record.descriptor !== "object" ||
    record.descriptor === null ||
    record.descriptor.sourceId !== sourceId
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Presence transactional record is invalid.");
  }
  const publication = record as PresencePublication;
  const metadata = publicationMetadata(publication.descriptor);
  if (
    metadata.generation !== publication.generation ||
    metadata.checksum !== publication.checksum ||
    checksumDescriptor(publication.descriptor, publication.generation) !== publication.checksum
  ) {
    throw new StateLocalError("STATE_CORRUPT", "Presence transactional checksum is invalid.");
  }
  return publication;
}

function checksumDescriptor(descriptor: StatePresenceDescriptor, generation: number): string {
  const details = { ...(descriptor.details ?? {}) };
  delete details[PUBLICATION_METADATA_KEY];
  const base = {
    ...descriptor,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
  if (Object.keys(details).length === 0) delete (base as { details?: JsonObject }).details;
  return sha256(Buffer.from(JSON.stringify({ generation, descriptor: base }), "utf8"));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateUpdate(update: StatePresenceUpdate): void {
  if (!["starting", "ready", "degraded", "stopping", "stopped"].includes(update.status)) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence status is invalid.");
  }
  if (update.details !== undefined) {
    if (
      typeof update.details !== "object" ||
      update.details === null ||
      Array.isArray(update.details)
    ) {
      throw new StateLocalError("STATE_INVALID_CONFIG", "Presence details must be a plain JSON object.");
    }
    validateJson(update.details, 0);
  }
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 16) {
    throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Presence details exceed the nesting limit.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StateLocalError("STATE_INVALID_CONFIG", "Presence details must be finite JSON.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence details must contain only JSON values.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "Presence details must be plain JSON objects.");
  }
  for (const nested of Object.values(value)) validateJson(nested, depth + 1);
}
