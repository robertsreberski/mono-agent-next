import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

import {
  InMemorySessionRepo,
  JsonlSessionRepo,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

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
}

interface OpenAttempt extends RuntimePiSessionAttempt {
  readonly persistent: boolean;
  readonly discard: () => Promise<void>;
}

type ManagerState = "running" | "stopping" | "stopped";

function attemptId(options: {
  namespace: string;
  conversationId: string;
  modelKey: string;
  turnId: string;
}): string {
  // A retry of the same turn must never reopen or collide with an earlier
  // native session. Hashing also keeps route and conversation identifiers out
  // of filenames written by the persistent repository.
  const digest = createHash("sha256")
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
  return `pi-${digest}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

async function validateSessionsRoot(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error("Unable to create runtime-pi sessions root", { cause: error });
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("runtime-pi sessions root must be a directory, not a symbolic link");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("runtime-pi sessions root must be owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("runtime-pi sessions root must not grant group or other permissions");
  }
}

async function validateSessionFile(session: Session): Promise<void> {
  const metadata = await session.getMetadata();
  if (!("path" in metadata) || typeof metadata.path !== "string") return;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(metadata.path, constants.O_RDONLY | noFollow);
  try {
    await handle.chmod(0o600);
    const descriptorStat = await handle.stat();
    const pathStat = await lstat(metadata.path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !descriptorStat.isFile()
      || descriptorStat.nlink !== 1
      || pathStat.isSymbolicLink()
      || descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
      || (uid !== undefined && descriptorStat.uid !== uid)
      || (descriptorStat.mode & 0o077) !== 0
    ) {
      throw new Error("runtime-pi session file failed owner-private identity validation");
    }
  } finally {
    await handle.close();
  }
}

export class RuntimePiSessionManager {
  readonly env: NodeExecutionEnv;
  readonly #cwd: string;
  readonly #namespace: string;
  readonly #sessionsRoot: string | undefined;
  readonly #conversationTails = new Map<string, Promise<void>>();
  readonly #activeAttempts = new Set<Promise<unknown>>();
  readonly #memoryRepo = new InMemorySessionRepo();
  #jsonlRepo: JsonlSessionRepo | undefined;
  #state: ManagerState = "running";
  #stopPromise: Promise<void> | undefined;

  constructor(options: { cwd: string; namespace: string; sessionsRoot?: string }) {
    this.#cwd = resolve(options.cwd);
    this.#namespace = options.namespace;
    this.#sessionsRoot = options.sessionsRoot === undefined
      ? undefined
      : resolve(this.#cwd, options.sessionsRoot);
    this.env = new NodeExecutionEnv({ cwd: this.#cwd });
  }

  async #persistentRepository(): Promise<JsonlSessionRepo> {
    if (this.#jsonlRepo !== undefined) return this.#jsonlRepo;
    if (this.#sessionsRoot === undefined) {
      throw new Error("runtime-pi persistent sessions are not configured");
    }
    await validateSessionsRoot(this.#sessionsRoot);
    this.#jsonlRepo = new JsonlSessionRepo({ fs: this.env, sessionsRoot: this.#sessionsRoot });
    return this.#jsonlRepo;
  }

  async #openFreshAttempt(options: RuntimePiSessionAttemptOptions): Promise<OpenAttempt> {
    throwIfAborted(options.signal);
    const id = attemptId({
      namespace: this.#namespace,
      conversationId: options.conversationId,
      modelKey: options.modelKey,
      turnId: options.turnId,
    });

    if (this.#sessionsRoot === undefined) {
      const session = await this.#memoryRepo.create({ id });
      const metadata = await session.getMetadata();
      return {
        id,
        session,
        persistent: false,
        discard: async () => this.#memoryRepo.delete(metadata),
      };
    }

    const repo = await this.#persistentRepository();
    throwIfAborted(options.signal);
    const session = await repo.create({ id, cwd: this.#cwd });
    const metadata = await session.getMetadata();
    try {
      await validateSessionFile(session);
    } catch (error) {
      try {
        await repo.delete(metadata);
      } catch (cleanupError) {
        throw aggregate(error, cleanupError, "runtime-pi session validation and cleanup failed");
      }
      throw error;
    }
    return {
      id,
      session,
      persistent: true,
      discard: async () => repo.delete(metadata),
    };
  }

  async #executeAttempt<T>(
    options: RuntimePiSessionAttemptOptions,
    task: (attempt: RuntimePiSessionAttempt) => Promise<RuntimePiSessionAttemptResult<T>>,
  ): Promise<T> {
    throwIfAborted(options.signal);
    const attempt = await this.#openFreshAttempt(options);
    try {
      throwIfAborted(options.signal);
      const result = await task({ id: attempt.id, session: attempt.session });
      throwIfAborted(options.signal);
      if (!result.completed || !attempt.persistent) await attempt.discard();
      return result.value;
    } catch (error) {
      try {
        await attempt.discard();
      } catch (cleanupError) {
        throw aggregate(error, cleanupError, "runtime-pi attempt and cleanup both failed");
      }
      throw error;
    }
  }

  /**
   * Run one fresh native Pi attempt. Attempts for a conversation are serialized,
   * but a previous session is never reopened or supplied to a later attempt.
   */
  withAttempt<T>(
    options: RuntimePiSessionAttemptOptions,
    task: (attempt: RuntimePiSessionAttempt) => Promise<RuntimePiSessionAttemptResult<T>>,
  ): Promise<T> {
    if (this.#state !== "running") {
      return Promise.reject(new Error(`runtime-pi session manager is ${this.#state}`));
    }

    const previous = this.#conversationTails.get(options.conversationId) ?? Promise.resolve();
    const current = previous.then(() => this.#executeAttempt(options, task));
    // This handled tail exists only to let the next attempt enter after either
    // outcome. The original promise remains tracked so lifecycle callers see
    // every active rejection.
    const tail = current.then(() => undefined, () => undefined);
    this.#conversationTails.set(options.conversationId, tail);
    this.#activeAttempts.add(current);

    const remove = (): void => {
      this.#activeAttempts.delete(current);
      if (this.#conversationTails.get(options.conversationId) === tail) {
        this.#conversationTails.delete(options.conversationId);
      }
    };
    void current.then(remove, remove);
    return current;
  }

  async drain(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const failures: unknown[] = [];
    while (this.#activeAttempts.size > 0) {
      const active = [...this.#activeAttempts];
      const settled = await waitWithSignal(Promise.allSettled(active), signal);
      for (const result of settled) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    }
    throwIfAborted(signal);
    if (failures.length > 0) {
      throw new AggregateError(failures, "runtime-pi session attempts failed while draining");
    }
  }

  stop(signal?: AbortSignal): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#state = "stopping";
    this.#stopPromise = (async () => {
      const failures: unknown[] = [];
      try {
        await this.drain(signal);
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.env.cleanup();
      } catch (error) {
        failures.push(error);
      }
      this.#conversationTails.clear();
      this.#activeAttempts.clear();
      this.#state = "stopped";
      if (failures.length > 0) {
        throw new AggregateError(failures, "runtime-pi session manager failed to stop cleanly");
      }
    })();
    return this.#stopPromise;
  }
}
