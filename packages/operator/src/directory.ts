import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { lstat, open, readdir } from "node:fs/promises";

import { normalizeOperatorEndpoint, OperatorClient, type OperatorClientOptions } from "./client.js";
import { parseRegistryDescriptor } from "./protocol.js";
import type { DiscoveredOperator, OperatorRegistryDescriptor } from "./types.js";

const DEFAULT_STALE_AFTER_MS = 45_000;
const MAX_REGISTRY_FILE_BYTES = 1_048_576;

export interface DiscoverOperatorsOptions {
  readonly registryDirectories?: readonly string[];
  readonly now?: number | Date;
  readonly staleAfterMs?: number;
}

export interface NormalizeDiscoveredOperatorOptions {
  readonly now?: number | Date;
  readonly staleAfterMs?: number;
}

export interface OperatorEntryClientOptions extends Omit<OperatorClientOptions, "endpoint" | "token"> {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class OperatorDirectoryError extends Error {
  readonly code: "UNSAFE_REGISTRY" | "INVALID_REGISTRY" | "AMBIGUOUS_SELECTION" | "NOT_FOUND" | "MISSING_TOKEN";

  constructor(code: OperatorDirectoryError["code"], message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OperatorDirectoryError";
    this.code = code;
  }
}

export function getDefaultOperatorRegistryDirectory(): string {
  return resolve(homedir(), ".mono-agent", "trace-sources");
}

function numericNow(value: number | Date | undefined): number {
  const parsed = value instanceof Date ? value.getTime() : value ?? Date.now();
  if (!Number.isFinite(parsed)) throw new OperatorDirectoryError("INVALID_REGISTRY", "discovery time must be finite");
  return parsed;
}

function staleWindow(value: number | undefined): number {
  const parsed = value ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OperatorDirectoryError("INVALID_REGISTRY", "staleAfterMs must be a non-negative safe integer");
  }
  return parsed;
}

function assertOwnerPrivate(stat: { uid: number; mode: number; nlink: number }, path: string, kind: "directory" | "file"): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new OperatorDirectoryError("UNSAFE_REGISTRY", `${kind} ${path} is not owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new OperatorDirectoryError("UNSAFE_REGISTRY", `${kind} ${path} must not grant group or other permissions`);
  }
  if (kind === "file" && stat.nlink !== 1) {
    throw new OperatorDirectoryError("UNSAFE_REGISTRY", `file ${path} must have exactly one hard link`);
  }
}

function sameIdentity(a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function readOwnerPrivateRegistryFile(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new OperatorDirectoryError("UNSAFE_REGISTRY", `registry entry ${path} must be a regular file, not a symlink`);
  }
  assertOwnerPrivate(before, path, "file");
  if (before.size > MAX_REGISTRY_FILE_BYTES) {
    throw new OperatorDirectoryError("INVALID_REGISTRY", `registry entry ${path} exceeds ${MAX_REGISTRY_FILE_BYTES} bytes`);
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new OperatorDirectoryError("UNSAFE_REGISTRY", `registry entry ${path} changed while opening`);
    }
    assertOwnerPrivate(opened, path, "file");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_REGISTRY_FILE_BYTES) {
      throw new OperatorDirectoryError("INVALID_REGISTRY", `registry entry ${path} exceeds ${MAX_REGISTRY_FILE_BYTES} bytes`);
    }
    const after = await lstat(path);
    if (!after.isFile() || !sameIdentity(opened, after)) {
      throw new OperatorDirectoryError("UNSAFE_REGISTRY", `registry entry ${path} changed while reading`);
    }
    assertOwnerPrivate(after, path, "file");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new OperatorDirectoryError("INVALID_REGISTRY", `registry entry ${path} contains invalid JSON`, { cause });
    }
  } finally {
    await handle?.close();
  }
}

export function normalizeDiscoveredOperator(
  value: unknown,
  sourcePath: string,
  options: NormalizeDiscoveredOperatorOptions = {},
): DiscoveredOperator {
  let descriptor: OperatorRegistryDescriptor;
  try {
    descriptor = parseRegistryDescriptor(value);
  } catch (cause) {
    throw new OperatorDirectoryError("INVALID_REGISTRY", `registry entry ${sourcePath} has an invalid descriptor`, { cause });
  }
  const now = numericNow(options.now);
  const staleAfterMs = staleWindow(options.staleAfterMs);
  const heartbeat = Date.parse(descriptor.heartbeatAt);
  return {
    id: descriptor.agent.id,
    label: descriptor.agent.label,
    endpoint: normalizeOperatorEndpoint(descriptor.operator.endpoint),
    ...(descriptor.operator.tokenEnvironment === undefined ? {} : { tokenEnvironment: descriptor.operator.tokenEnvironment }),
    pid: descriptor.pid,
    startedAt: descriptor.startedAt,
    heartbeatAt: descriptor.heartbeatAt,
    stale: now - heartbeat > staleAfterMs,
    sourcePath,
    ...(descriptor.capabilities === undefined ? {} : { capabilities: descriptor.capabilities }),
  };
}

async function readRegistryDirectory(
  authoredDirectory: string,
  options: NormalizeDiscoveredOperatorOptions,
): Promise<DiscoveredOperator[]> {
  const directory = resolve(authoredDirectory);
  let before;
  try {
    before = await lstat(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new OperatorDirectoryError("UNSAFE_REGISTRY", `registry ${directory} must be a directory, not a symlink`);
  }
  assertOwnerPrivate(before, directory, "directory");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const entries: DiscoveredOperator[] = [];
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new OperatorDirectoryError("UNSAFE_REGISTRY", `registry contains an unsafe entry name ${JSON.stringify(name)}`);
    }
    const path = resolve(directory, name);
    entries.push(normalizeDiscoveredOperator(await readOwnerPrivateRegistryFile(path), path, options));
  }
  const after = await lstat(directory);
  if (!after.isDirectory() || !sameIdentity(before, after)) {
    throw new OperatorDirectoryError("UNSAFE_REGISTRY", `registry ${directory} changed while reading`);
  }
  assertOwnerPrivate(after, directory, "directory");
  return entries;
}

function dedupe(entries: readonly DiscoveredOperator[]): DiscoveredOperator[] {
  const selected = new Map<string, DiscoveredOperator>();
  for (const entry of entries) {
    const existing = selected.get(entry.id);
    if (existing === undefined
      || Date.parse(entry.heartbeatAt) > Date.parse(existing.heartbeatAt)
      || (entry.heartbeatAt === existing.heartbeatAt && entry.sourcePath < existing.sourcePath)) {
      selected.set(entry.id, entry);
    }
  }
  return [...selected.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export async function discoverOperators(options: DiscoverOperatorsOptions = {}): Promise<readonly DiscoveredOperator[]> {
  const registryDirectories = options.registryDirectories ?? [getDefaultOperatorRegistryDirectory()];
  const paths = [...new Set(registryDirectories.map((directory) => resolve(directory)))].sort();
  const entries: DiscoveredOperator[] = [];
  for (const directory of paths) {
    entries.push(...await readRegistryDirectory(directory, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    }));
  }
  return dedupe(entries);
}

export class OperatorDirectory {
  readonly entries: readonly DiscoveredOperator[];
  #pinnedId: string | undefined;

  constructor(entries: readonly DiscoveredOperator[], pinnedId?: string) {
    this.entries = dedupe(entries);
    this.#pinnedId = pinnedId;
    if (pinnedId !== undefined && !this.entries.some((entry) => entry.id === pinnedId)) {
      throw new OperatorDirectoryError("NOT_FOUND", `cannot pin unknown operator ${JSON.stringify(pinnedId)}`);
    }
  }

  get pinnedId(): string | undefined {
    return this.#pinnedId;
  }

  pin(id?: string): void {
    if (id !== undefined && !this.entries.some((entry) => entry.id === id)) {
      throw new OperatorDirectoryError("NOT_FOUND", `cannot pin unknown operator ${JSON.stringify(id)}`);
    }
    this.#pinnedId = id;
  }

  select(selector?: string): DiscoveredOperator {
    const effective = selector ?? this.#pinnedId;
    if (effective === undefined) {
      const live = this.entries.filter((entry) => !entry.stale);
      if (live.length === 1) return live[0]!;
      if (live.length === 0) throw new OperatorDirectoryError("NOT_FOUND", "no live operator was discovered");
      throw new OperatorDirectoryError("AMBIGUOUS_SELECTION", "multiple live operators were discovered; select one by id or label");
    }
    const matches = this.entries.filter((entry) => entry.id === effective || entry.label === effective);
    if (matches.length === 0) throw new OperatorDirectoryError("NOT_FOUND", `operator ${JSON.stringify(effective)} was not discovered`);
    if (matches.length > 1) throw new OperatorDirectoryError("AMBIGUOUS_SELECTION", `operator label ${JSON.stringify(effective)} is ambiguous; select by id`);
    return matches[0]!;
  }
}

export function createOperatorClientForEntry(
  entry: DiscoveredOperator,
  options: OperatorEntryClientOptions = {},
): OperatorClient {
  const { env = process.env, ...clientOptions } = options;
  let token: string | undefined;
  if (entry.tokenEnvironment !== undefined) {
    token = env[entry.tokenEnvironment];
    if (token === undefined || token.length === 0) {
      throw new OperatorDirectoryError("MISSING_TOKEN", `operator ${JSON.stringify(entry.id)} requires environment variable ${entry.tokenEnvironment}`);
    }
  }
  return new OperatorClient({ ...clientOptions, endpoint: normalizeOperatorEndpoint(entry.endpoint), ...(token === undefined ? {} : { token }) });
}
