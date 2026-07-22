import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

const DELETED = Symbol("deleted");

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
    throw new Error(
      `Pi OAuth credential for provider ${JSON.stringify(providerId)} requires atomic writable persistence and is not supported yet`,
    );
  }
  throw new Error(`Pi auth store has an unsupported credential type for provider ${JSON.stringify(providerId)}`);
}

async function readSecureAuthFile(path: string): Promise<Map<string, Credential>> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Pi auth store must not be a symbolic link");
    }
    throw new Error("Unable to open Pi auth store", { cause: error });
  }

  try {
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) {
      throw new Error("Pi auth store must be a single-link regular file");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && descriptorStat.uid !== uid) {
      throw new Error("Pi auth store must be owned by the current user");
    }
    if ((descriptorStat.mode & 0o077) !== 0) {
      throw new Error("Pi auth store must not grant group or other permissions");
    }
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
      throw new Error("Pi auth store changed identity while opening");
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const finalStat = await handle.stat();
    if (finalStat.dev !== descriptorStat.dev || finalStat.ino !== descriptorStat.ino) {
      throw new Error("Pi auth store changed identity while reading");
    }
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
    return credentials;
  } finally {
    await handle.close();
  }
}

/**
 * Reads an owner-private Pi auth file but never mutates it. OAuth credentials
 * are rejected until refresh-token rotation can be committed atomically.
 */
export class ReadOnlyPiCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #overlays = new Map<string, Credential | typeof DELETED>();
  readonly #chains = new Map<string, Promise<void>>();
  #snapshot: Promise<Map<string, Credential>> | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  #load(): Promise<Map<string, Credential>> {
    this.#snapshot ??= readSecureAuthFile(this.#path);
    return this.#snapshot;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const overlay = this.#overlays.get(providerId);
    if (overlay === DELETED) return undefined;
    if (overlay !== undefined) return cloneCredential(overlay);
    return cloneCredential((await this.#load()).get(providerId));
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const ids = new Set((await this.#load()).keys());
    for (const [providerId, credential] of this.#overlays) {
      if (credential === DELETED) ids.delete(providerId);
      else ids.add(providerId);
    }
    const result: CredentialInfo[] = [];
    for (const providerId of [...ids].sort()) {
      const credential = await this.read(providerId);
      if (credential !== undefined) result.push({ providerId, type: credential.type });
    }
    return result;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    let result: Credential | undefined;
    const current = previous.catch(() => undefined).then(async () => {
      const before = await this.read(providerId);
      const next = await fn(cloneCredential(before));
      if (next !== undefined) this.#overlays.set(providerId, cloneCredential(next) as Credential);
      result = next === undefined ? before : next;
    });
    this.#chains.set(providerId, current.then(() => undefined, () => undefined));
    await current;
    return cloneCredential(result);
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      this.#overlays.set(providerId, DELETED);
    });
    this.#chains.set(providerId, current);
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

export function redactRuntimePiText(value: unknown, secrets: readonly string[]): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of [...new Set(secrets)].filter((entry) => entry.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\b(token|api[_ -]?key|refresh[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return text;
}
