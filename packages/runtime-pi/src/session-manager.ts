// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  InMemorySessionRepo,
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  atomicReplaceOwnerPrivateFile,
  createOwnerPrivateFile,
  ensureOwnerPrivateDirectory,
} from "@mono-agent/module-sdk";

import {
  RESERVATION_DIRECTORY,
  RESERVATION_OWNER,
  RuntimePiSessionUnavailableError,
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
  type ManagerState,
  type OpenAttempt,
  type ReservationHandle,
  type ReservationRecord,
  type RuntimePiSessionAttempt,
  type RuntimePiSessionAttemptOptions,
  type RuntimePiSessionAttemptResult,
  type SessionBinding,
} from "./session-storage.js";

export class RuntimePiSessionManager {
  readonly env: GuardedSessionExecutionEnv;
  readonly #cwd: string;
  readonly #namespace: string;
  readonly #namespaceHash: string;
  readonly #sessionsRoot: string | undefined;
  readonly #managerId = randomUUID();
  readonly #reservationOwnerPid: number;
  readonly #conversationTails = new Map<string, Promise<void>>();
  readonly #activeAttempts = new Set<Promise<unknown>>();
  readonly #memoryRepo = new InMemorySessionRepo();
  readonly #memoryBindings = new Map<string, SessionBinding>();
  #jsonlRepo: JsonlSessionRepo | undefined;
  #repositoryPromise: Promise<JsonlSessionRepo> | undefined;
  #state: ManagerState = "running";
  #stopPromise: Promise<void> | undefined;

  constructor(options: {
    cwd: string;
    namespace: string;
    sessionsRoot?: string;
    /** Internal crash-recovery test seam. Product callers omit this. */
    reservationOwnerPid?: number;
  }) {
    this.#cwd = resolve(options.cwd);
    this.#namespace = options.namespace;
    this.#namespaceHash = digest(options.namespace);
    this.#sessionsRoot = options.sessionsRoot === undefined
      ? undefined
      : resolve(this.#cwd, options.sessionsRoot);
    this.#reservationOwnerPid = options.reservationOwnerPid ?? process.pid;
    this.env = new GuardedSessionExecutionEnv(this.#cwd, this.#sessionsRoot);
  }

  #reservationDirectory(): string {
    if (this.#sessionsRoot === undefined) {
      throw new Error("runtime-pi persistent sessions are not configured");
    }
    return join(this.#sessionsRoot, RESERVATION_DIRECTORY);
  }

  async #createReservation(
    id: string,
    options: RuntimePiSessionAttemptOptions,
  ): Promise<ReservationHandle> {
    const record: ReservationRecord = {
      version: 1,
      owner: RESERVATION_OWNER,
      namespaceHash: this.#namespaceHash,
      managerId: this.#managerId,
      pid: this.#reservationOwnerPid,
      reservationId: randomUUID(),
      attemptId: id,
      conversationHash: digest(options.conversationId),
      modelHash: digest(options.modelKey),
      turnHash: digest(options.turnId),
      phase: "reserved",
      createdAt: new Date().toISOString(),
    };
    const path = join(
      this.#reservationDirectory(),
      `${record.attemptId}.${record.reservationId}.json`,
    );
    const identity = await createOwnerPrivateFile(path, encodeReservation(record), {
      signal: options.signal,
    });
    return { path, identity, record, committed: false };
  }

  async #commitReservation(
    handle: ReservationHandle,
    metadata: JsonlSessionMetadata,
  ): Promise<void> {
    if (handle.record.phase !== "reserved") {
      throw new Error("runtime-pi session reservation is already committed");
    }
    const record: ReservationRecord = {
      ...handle.record,
      phase: "committed",
      committedAt: new Date().toISOString(),
    };
    try {
      const identity = await syncAndValidateCommittedSession(
        metadata,
        handle.record,
        this.#sessionsRoot!,
      );
      this.env.register(identity);
      handle.identity = await atomicReplaceOwnerPrivateFile(
        handle.path,
        encodeReservation(record),
        { expected: handle.identity },
      );
      (handle as { record: ReservationRecord }).record = record;
      handle.committed = true;
    } catch (error) {
      if (error !== null
        && typeof error === "object"
        && Object.getOwnPropertyDescriptor(error, "committed")?.value === true) {
        handle.committed = true;
      }
      throw error;
    }
  }

  async #reconcilePersistentAttempts(repo: JsonlSessionRepo): Promise<void> {
    const handles: ReservationHandle[] = [];
    for (const entry of await readdir(this.#reservationDirectory(), {
      withFileTypes: true,
    })) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile()) {
        throw new Error("runtime-pi session reservation entry must be a regular file");
      }
      const handle = await readReservation(join(this.#reservationDirectory(), entry.name));
      if (handle.record.namespaceHash === this.#namespaceHash) handles.push(handle);
    }
    const byReservation = new Map(handles.map((handle) => [
      handle.record.reservationId,
      handle,
    ]));
    const sessions = await repo.list({ cwd: this.#cwd });
    const ownedSessions = sessions.filter((metadata) => {
      const reservation = sessionReservation(metadata);
      return reservation?.namespaceHash === this.#namespaceHash;
    });

    for (const metadata of ownedSessions) {
      const reservation = sessionReservation(metadata);
      if (reservation === undefined) continue;
      const handle = byReservation.get(reservation.reservationId);
      if (handle !== undefined) {
        if (!sameReservation(reservation, handle.record)) {
          throw new Error("runtime-pi session reservation identity is inconsistent");
        }
        continue;
      }
      // The session header proves ownership but not whether a now-missing
      // external marker had reached "committed". Never guess and delete.
      throw new Error("runtime-pi session is missing its reservation marker");
    }

    for (const handle of handles) {
      const matches = ownedSessions.filter((metadata) =>
        sessionReservation(metadata)?.reservationId === handle.record.reservationId);
      if (matches.length > 1) {
        throw new Error("runtime-pi reservation names multiple session files");
      }
      if (handle.record.phase === "committed") {
        if (matches.length !== 1) {
          throw new Error("runtime-pi committed reservation is missing its session file");
        }
        const identity = await validateSessionMetadataFile(matches[0]!, {
          expectedReservation: handle.record,
          sessionsRoot: this.#sessionsRoot!,
        });
        this.env.register(identity);
        continue;
      }
      if (processIsAlive(handle.record.pid)) continue;
      if (matches[0] !== undefined) {
        await deleteSessionFile(
          matches[0],
          handle.record,
          this.#sessionsRoot!,
        );
        this.env.unregister(matches[0].path);
      } else if ((await rawAttemptSessionPaths(
        this.#sessionsRoot!,
        handle.record.attemptId,
      )).length > 0) {
        throw new Error(
          "runtime-pi uncommitted reservation has an unverified session file",
        );
      }
      await deleteReservation(handle);
    }
  }

  async #persistentRepository(): Promise<JsonlSessionRepo> {
    if (this.#jsonlRepo !== undefined) return this.#jsonlRepo;
    if (this.#repositoryPromise !== undefined) return this.#repositoryPromise;
    if (this.#sessionsRoot === undefined) {
      throw new Error("runtime-pi persistent sessions are not configured");
    }
    this.#repositoryPromise = (async () => {
      await validateSessionsRoot(this.#sessionsRoot!);
      await ensureOwnerPrivateDirectory(this.#reservationDirectory());
      const repo = new JsonlSessionRepo({
        fs: this.env,
        sessionsRoot: this.#sessionsRoot!,
      });
      await this.#reconcilePersistentAttempts(repo);
      this.#jsonlRepo = repo;
      return repo;
    })();
    try {
      return await this.#repositoryPromise;
    } catch (error) {
      this.#repositoryPromise = undefined;
      throw error;
    }
  }

  async initialize(): Promise<void> {
    if (this.#state !== "running") {
      throw new Error(`runtime-pi session manager is ${this.#state}`);
    }
    if (this.#sessionsRoot !== undefined) await this.#persistentRepository();
  }

  async #assertCommittedSource(
    metadata: JsonlSessionMetadata,
    options: Pick<RuntimePiSessionAttemptOptions, "conversationId" | "modelKey">,
  ): Promise<void> {
    const reservation = sessionReservation(metadata);
    if (reservation === undefined
      || reservation.namespaceHash !== this.#namespaceHash) {
      throw new Error("runtime-pi native session lacks a valid owned reservation");
    }
    const markerPath = join(
      this.#reservationDirectory(),
      `${reservation.attemptId}.${reservation.reservationId}.json`,
    );
    let marker: ReservationHandle;
    try {
      marker = await readReservation(markerPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "missing") {
        throw new RuntimePiSessionUnavailableError();
      }
      throw error;
    }
    if (marker.record.phase !== "committed"
      || !sameReservation(reservation, marker.record)) {
      throw new Error("runtime-pi native session is not durably committed");
    }
    if (marker.record.conversationHash !== digest(options.conversationId)
      || marker.record.modelHash !== digest(options.modelKey)) {
      throw new Error(
        "runtime-pi native session does not match the requested conversation and model binding",
      );
    }
    const identity = await validateSessionMetadataFile(metadata, {
      expectedReservation: marker.record,
      sessionsRoot: this.#sessionsRoot!,
    });
    this.env.register(identity);
  }

  async #openAttempt(options: RuntimePiSessionAttemptOptions): Promise<OpenAttempt> {
    throwIfAborted(options.signal);
    const id = attemptId({
      namespace: this.#namespace,
      conversationId: options.conversationId,
      modelKey: options.modelKey,
      turnId: options.turnId,
    });

    if (this.#sessionsRoot === undefined) {
      const binding = {
        conversationHash: digest(options.conversationId),
        modelHash: digest(options.modelKey),
      };
      let session: Session;
      if (options.resumeSessionId === undefined) {
        session = await this.#memoryRepo.create({ id });
      } else {
        const source = (await this.#memoryRepo.list())
          .find((metadata) => metadata.id === options.resumeSessionId);
        if (source === undefined) throw new RuntimePiSessionUnavailableError();
        const sourceBinding = this.#memoryBindings.get(options.resumeSessionId);
        if (sourceBinding === undefined
          || sourceBinding.conversationHash !== binding.conversationHash
          || sourceBinding.modelHash !== binding.modelHash) {
          throw new Error(
            "runtime-pi native session does not match the requested conversation and model binding",
          );
        }
        session = await this.#memoryRepo.fork(source, { id });
      }
      const metadata = await session.getMetadata();
      return {
        id,
        session,
        commit: async () => {
          this.#memoryBindings.set(id, binding);
        },
        discard: async () => {
          this.#memoryBindings.delete(id);
          await this.#memoryRepo.delete(metadata);
        },
      };
    }

    const repo = await this.#persistentRepository();
    throwIfAborted(options.signal);
    const reservation = await this.#createReservation(id, options);
    let session: Session<JsonlSessionMetadata> | undefined;
    let metadata: JsonlSessionMetadata | undefined;
    try {
      if (options.resumeSessionId === undefined) {
        session = await repo.create({
          id,
          cwd: this.#cwd,
          metadata: reservationMetadata(reservation.record),
        });
      } else {
        const source = (await repo.list({ cwd: this.#cwd }))
          .find((entry) => entry.id === options.resumeSessionId);
        if (source === undefined) throw new RuntimePiSessionUnavailableError();
        await this.#assertCommittedSource(source, options);
        session = await repo.fork(source, {
          id,
          cwd: this.#cwd,
          metadata: reservationMetadata(reservation.record),
        });
      }
      metadata = await session.getMetadata();
      const identity = await validateSessionMetadataFile(metadata, {
        expectedReservation: reservation.record,
        hardenOwnedCreation: true,
        sessionsRoot: this.#sessionsRoot,
      });
      this.env.register(identity);
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      let markerMayBeDeleted = true;
      if (metadata !== undefined) {
        try {
          await deleteSessionFile(
            metadata,
            reservation.record,
            this.#sessionsRoot,
          );
          this.env.unregister(metadata.path);
        } catch (cleanupError) {
          markerMayBeDeleted = false;
          cleanupFailures.push(cleanupError);
        }
      } else {
        try {
          if ((await rawAttemptSessionPaths(
            this.#sessionsRoot,
            reservation.record.attemptId,
          )).length > 0) {
            markerMayBeDeleted = false;
            cleanupFailures.push(new Error(
              "runtime-pi refuses to remove a reservation with an unverified session file",
            ));
          }
        } catch (cleanupError) {
          markerMayBeDeleted = false;
          cleanupFailures.push(cleanupError);
        }
      }
      if (markerMayBeDeleted) {
        try {
          await deleteReservation(reservation);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "runtime-pi session creation and cleanup failed",
        );
      }
      throw error;
    }
    return {
      id,
      session,
      commit: async () => this.#commitReservation(reservation, metadata!),
      discard: async () => {
        if (reservation.committed) {
          throw new Error("runtime-pi refuses to discard a committed session reservation");
        }
        await deleteSessionFile(
          metadata!,
          reservation.record,
          this.#sessionsRoot!,
        );
        this.env.unregister(metadata!.path);
        await deleteReservation(reservation);
      },
    };
  }

  async #executeAttempt<T>(
    options: RuntimePiSessionAttemptOptions,
    task: (
      attempt: RuntimePiSessionAttempt,
    ) => Promise<RuntimePiSessionAttemptResult<T>>,
  ): Promise<T> {
    throwIfAborted(options.signal);
    const attempt = await this.#openAttempt(options);
    try {
      throwIfAborted(options.signal);
      const result = await task({ id: attempt.id, session: attempt.session });
      if (result.completed) {
        await attempt.commit();
      } else {
        throwIfAborted(options.signal);
        await attempt.discard();
      }
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
   * Run an isolated Pi attempt. Resume forks the prior native session and only
   * commits its owner-private reservation after successful settlement.
   */
  withAttempt<T>(
    options: RuntimePiSessionAttemptOptions,
    task: (
      attempt: RuntimePiSessionAttempt,
    ) => Promise<RuntimePiSessionAttemptResult<T>>,
  ): Promise<T> {
    if (this.#state !== "running") {
      return Promise.reject(new Error(`runtime-pi session manager is ${this.#state}`));
    }
    const previous = this.#conversationTails.get(options.conversationId)
      ?? Promise.resolve();
    const current = previous.then(() => this.#executeAttempt(options, task));
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
      const settled = await waitWithSignal(
        Promise.allSettled([...this.#activeAttempts]),
        signal,
      );
      for (const result of settled) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    }
    throwIfAborted(signal);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "runtime-pi session attempts failed while draining",
      );
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
      this.#memoryBindings.clear();
      this.#state = "stopped";
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "runtime-pi session manager failed to stop cleanly",
        );
      }
    })();
    return this.#stopPromise;
  }
}
