import { join } from "node:path";

import type { JsonObject } from "@mono-agent/module-sdk";

import type { ResolvedStateLocalDiscoveryConfig } from "./config.js";
import { StateLocalError, throwIfAborted } from "./errors.js";
import {
  ensureSecureDirectory,
  inspectSecureFile,
  readSecureFile,
  replaceSecureFileAtomic,
  type AtomicReplaceHooks,
  type FileIdentity,
  verifySecureDirectoryIdentity,
} from "./secure-fs.js";

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
  readonly hooks?: AtomicReplaceHooks;
}

export class PresencePublisher {
  path: string;
  private readonly options: PresencePublisherOptions;
  private registryDirectory: string;
  private directoryIdentity: FileIdentity | undefined;

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
    await validateExistingDescriptor(this.path, this.options.config.sourceId);
  }

  async publish(update: StatePresenceUpdate, signal: AbortSignal): Promise<StatePresenceDescriptor> {
    throwIfAborted(signal);
    const identity = this.directoryIdentity;
    if (identity === undefined) {
      throw new StateLocalError("STATE_CLOSED", "Presence publication has not been prepared.");
    }
    await verifySecureDirectoryIdentity(this.registryDirectory, identity);
    validateUpdate(update);
    await validateExistingDescriptor(this.path, this.options.config.sourceId);
    const now = this.options.clock().toISOString();
    const descriptor: StatePresenceDescriptor = {
      schema: "mono-agent.state-presence.v1",
      sourceId: this.options.config.sourceId,
      sourceLabel: this.options.config.sourceLabel,
      instanceId: this.options.instanceId,
      pid: process.pid,
      stateRoot: this.options.stateRoot,
      status: update.status,
      startedAt: this.options.startedAt,
      heartbeatAt: now,
      ...(update.details === undefined ? {} : { details: update.details }),
    };
    const encoded = Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8");
    if (encoded.byteLength > 64 * 1024) {
      throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Presence descriptor exceeds 64 KiB.");
    }
    await replaceSecureFileAtomic(
      this.path,
      encoded,
      this.options.hooks,
    );
    return descriptor;
  }
}

async function validateExistingDescriptor(path: string, sourceId: string): Promise<void> {
  const identity = await inspectSecureFile(path);
  if (identity === undefined) return;
  let value: unknown;
  try {
    const loaded = await readSecureFile(path, 64 * 1024);
    value = JSON.parse(loaded.bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof StateLocalError) throw error;
    throw new StateLocalError(
      "STATE_CORRUPT",
      `Presence target ${path} is not a recognized descriptor; refusing to overwrite it.`,
      error,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== "mono-agent.state-presence.v1" ||
    (value as { sourceId?: unknown }).sourceId !== sourceId
  ) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      `Presence target ${path} is not owned by this source; refusing to overwrite it.`,
    );
  }
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
