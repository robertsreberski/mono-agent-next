// SPDX-License-Identifier: MIT
import { backup as backupSqlite, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  Memory,
  MemoryCaptureRequest,
  MemoryForgetRequest,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRuntimeCaptureGrant,
  ModuleCommand,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStopContext,
} from "@mono-agent/module-sdk";

import {
  assertCaptureReceiptIntegrity,
  assertReadableMemoryRows,
  auditBujoDatabase,
  captureIntakeKey,
  captureReceiptKey,
  decodeMemoryRow,
  deleteMetadata,
  ensureVectorIntake,
  ftsMatchExpression,
  forgetMemoryRow,
  getMetadata,
  insertMemoryRows,
  listMetadata,
  parseCaptureReceipt,
  quickCheck,
  readMemoryRow,
  readMemoryRows,
  rebuildBujoIndexes,
  recordLimits,
  setMetadata,
  writeMemoryVector,
} from "./bujo-db.js";
import {
  createMemoryLocalCommands,
} from "./commands.js";
import {
  auditBujoProjections,
  consolidateBujoProjections,
  type MemoryLocalConsolidateResult,
  type MemoryLocalProjectionAudit,
} from "./consolidation.js";
import {
  DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS,
  DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS,
  MAX_MEMORY_LOCAL_INTAKE_RETRIES,
  parseMemoryLocalConfig,
  type MemoryLocalConfig,
} from "./config.js";
import {
  type MemoryEmbeddingProvider,
  toVectorBlob,
} from "./embeddings.js";
import { MemoryLocalError } from "./errors.js";
import {
  canonicalJson,
  validateMemoryRecord,
  type ValidatedMemoryRecord,
} from "./records.js";
import {
  createSecureFile,
  openPinnedSecureFile,
  openSecureRoot,
  readSecureFile,
  syncDirectory,
  verifySecureRoot,
  type FileIdentity,
  type PinnedSecureFile,
} from "./security.js";
import {
  embeddingIdentity,
  embeddingUnavailable,
  parseCaptureIntake,
  parseVectorIntake,
  resolveEmbeddings,
  resolveRuntimeCapture,
  runtimeCaptureUnavailable,
  runtimeCaptureResponseSchema,
  validateRecordId,
  validateRuntimeCaptureResult,
  vectorIdentityCompatible,
  type CaptureIntake,
} from "./store-capture.js";
import {
  assertInitializedMarkerBytes,
  readPinnedBytes,
} from "./store-marker.js";
import {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  closeDatabaseSafely,
  openStore,
  type MemoryLocalOpenHooks,
  type OpenMemoryLocalForTestingOptions,
  type OpenMemoryLocalOptions,
  type StoreState,
} from "./store-open.js";

export {
  MEMORY_LOCAL_DATABASE_FILENAME,
  MEMORY_LOCAL_MARKER_FILENAME,
  type OpenMemoryLocalOptions,
} from "./store-open.js";

const MARKER_MAX_BYTES = 128;
const MAX_RECALL_CANDIDATES = 256;
const CAPTURE_INTAKE_PREFIX = "memory-local:capture-intake:";
const VECTOR_INTAKE_PREFIX = "memory-local:vector-intake:";

export interface MemoryLocalAuditRequest {
  readonly signal: AbortSignal;
  readonly strict?: boolean;
}

export interface MemoryLocalAudit {
  readonly status: "healthy" | "degraded";
  readonly schema: "mono-agent.bujo.v1";
  readonly storeId: string;
  readonly database: {
    readonly device: string;
    readonly inode: string;
    readonly mode: 384;
    readonly links: 2;
  };
  readonly marker: {
    readonly device: string;
    readonly inode: string;
    readonly mode: 384;
    readonly links: 1;
  };
  readonly records: number;
  readonly recordBytes: number;
  readonly fts: {
    readonly indexed: number;
    readonly missing: number;
    readonly orphaned: number;
  };
  readonly vectors: {
    readonly indexed: number;
    readonly missing: number;
    readonly dimensions: number;
    readonly configured: boolean;
    readonly compatible: boolean;
  };
  readonly intake: {
    readonly captures: number;
    readonly vectors: number;
  };
  readonly projections: MemoryLocalProjectionAudit;
}

export interface MemoryLocalForgetPreview {
  readonly found: boolean;
  readonly record?: MemoryRecord;
  readonly vectorPresent: boolean;
}

export interface MemoryLocalBackupRequest {
  readonly destinationDirectory: string;
  readonly signal: AbortSignal;
}

export interface MemoryLocalBackupResult {
  readonly directory: string;
  readonly databaseSha256: string;
  readonly markerSha256: string;
  readonly recordCount: number;
}

export interface MemoryLocalRebuildRequest {
  readonly signal: AbortSignal;
}

export interface MemoryLocalRebuildResult {
  readonly records: number;
  readonly ftsIndexed: number;
  readonly vectorsIndexed: number;
  readonly vectorDimensions: number;
}

export interface MemoryLocalRetryRequest {
  readonly signal: AbortSignal;
  readonly limit?: number;
}

export interface MemoryLocalRetryResult {
  readonly capturesRetried: number;
  readonly vectorsRetried: number;
  readonly failed: number;
  readonly remainingCaptures: number;
  readonly remainingVectors: number;
}

export interface MemoryLocalConsolidateRequest {
  readonly signal: AbortSignal;
}

let testingFactory: (
  options: OpenMemoryLocalForTestingOptions,
) => Promise<MemoryLocal> = async () => {
  throw new Error("Memory-local testing factory is unavailable.");
};

export class MemoryLocal implements Memory {
  readonly capabilities;
  readonly commands: readonly ModuleCommand[];
  readonly directory: string;
  readonly config: MemoryLocalConfig;

  readonly #state: StoreState;
  readonly #runtimeCapture: MemoryRuntimeCaptureGrant | undefined;
  readonly #embeddings: MemoryEmbeddingProvider | undefined;
  readonly #clock: () => Date;
  readonly #beforeConsolidationCommit: (() => void | Promise<void>) | undefined;
  readonly #beforeCaptureCommit: (() => void) | undefined;
  readonly #activeOperations = new Set<Promise<void>>();
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;
  #stopPromise: Promise<void> | undefined;
  #embeddingFailures = 0;
  #embeddingBreakerUntil = 0;
  #embeddingDegraded = false;
  #vectorDimensions: number;
  #vectorCompatible: boolean;

  private constructor(
    config: MemoryLocalConfig,
    state: StoreState,
    runtimeCapture: MemoryRuntimeCaptureGrant | undefined,
    embeddings: MemoryEmbeddingProvider | undefined,
    clock: () => Date,
    beforeConsolidationCommit: (() => void | Promise<void>) | undefined,
    beforeCaptureCommit: (() => void) | undefined,
  ) {
    this.config = config;
    this.capabilities = Object.freeze({ capture: true, forget: true, recallTool: config.recallTool.enabled });
    this.directory = state.root.path;
    this.#state = state;
    this.#runtimeCapture = runtimeCapture;
    this.#embeddings = embeddings;
    this.#clock = clock;
    this.#beforeConsolidationCommit = beforeConsolidationCommit;
    this.#beforeCaptureCommit = beforeCaptureCommit;
    this.#vectorDimensions = state.vectorDimensions;
    this.#vectorCompatible = vectorIdentityCompatible(
      state.database,
      embeddings,
      state.vectorDimensions,
    );
    this.commands = createMemoryLocalCommands(this);
  }

  static async open(options: OpenMemoryLocalOptions): Promise<MemoryLocal> {
    return await MemoryLocal.#open(options, {});
  }

  static async #open(
    options: OpenMemoryLocalOptions,
    hooks: MemoryLocalOpenHooks,
  ): Promise<MemoryLocal> {
    const config = parseMemoryLocalConfig(options.config);
    const directory = config.root === undefined
      ? resolve(options.dataDirectory)
      : isAbsolute(config.root)
        ? resolve(config.root)
        : resolve(options.configDirectory, config.root);
    const runtimeCapture = resolveRuntimeCapture(config, options.host);
    const embeddings = resolveEmbeddings(config, options.embeddingProvider);
    const state = await openStore(directory, config, hooks);
    return new MemoryLocal(
      config,
      state,
      runtimeCapture,
      embeddings,
      options.clock ?? (() => new Date()),
      hooks.beforeConsolidationCommit,
      hooks.beforeCaptureCommit,
    );
  }

  static {
    testingFactory = async (options) => await MemoryLocal.#open(
      options,
      options.hooks ?? {},
    );
  }

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      const query = request.query.normalize("NFKC").trim();
      if (query.length === 0 || Buffer.byteLength(query, "utf8") > 64 * 1024) {
        throw new MemoryLocalError("invalid_record", "Memory recall query is empty or exceeds its byte bound.");
      }
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50) {
        throw new MemoryLocalError("invalid_record", "Memory recall limit must be from 1 through 50.");
      }
      await this.#verifyStore();
      const ftsIds = this.#ftsCandidates(query);
      const vectorIds = await this.#vectorCandidates(query, request.signal);
      const ranks = new Map<string, number>();
      ftsIds.forEach((id, index) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + index + 1)));
      vectorIds.forEach((id, index) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + index + 1)));
      const scored = [...ranks].flatMap(([id, score]) => {
        const row = readMemoryRow(this.#state.database, id);
        if (row === undefined || row.status === "invalidated" || row.status === "dropped") return [];
        const record = decodeMemoryRow(row, this.config);
        const conversationBonus = request.conversationId !== undefined
          && record.metadata?.conversationId === request.conversationId
          ? 0.1
          : 0;
        return [{ record, score: score + conversationBonus }];
      });
      scored.sort((left, right) =>
        right.score - left.score
        || right.record.createdAt.localeCompare(left.record.createdAt)
        || left.record.id.localeCompare(right.record.id));
      const records: MemoryRecord[] = [];
      let bytes = 0;
      for (const { record } of scored) {
        const next = Buffer.byteLength(record.text, "utf8");
        if (bytes + next > this.config.maxBytes) continue;
        records.push(record);
        bytes += next;
        if (records.length >= request.limit) break;
      }
      throwIfAborted(request.signal);
      await this.#verifyStore();
      return Object.freeze({ records: Object.freeze(records) });
    } finally {
      complete();
    }
  }

  async capture(request: MemoryCaptureRequest): Promise<void> {
    const complete = this.#beginOperation();
    try {
      if (!this.config.capture.enabled) return;
      throwIfAborted(request.signal);
      const source = validateMemoryRecord(request.record, recordLimits(this.config));
      await this.#enqueueWrite(async () => {
        await this.#completeCapture(source, request.signal);
      });
    } finally {
      complete();
    }
  }

  async forget(request: MemoryForgetRequest): Promise<boolean> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      validateRecordId(request.recordId);
      return await this.#enqueueWrite(async () => {
        await this.#verifyStore();
        const forgotten = forgetMemoryRow(this.#state.database, request.recordId);
        checkpoint(this.#state.database);
        await this.#verifyStore();
        return forgotten;
      });
    } finally {
      complete();
    }
  }

  async previewForget(
    recordId: string,
    signal: AbortSignal,
  ): Promise<MemoryLocalForgetPreview> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(signal);
      validateRecordId(recordId);
      await this.#verifyStore();
      const row = readMemoryRow(this.#state.database, recordId);
      if (row === undefined) return Object.freeze({ found: false, vectorPresent: false });
      const vector = this.#state.database.prepare(
        "SELECT 1 AS present FROM memories_vec WHERE rowid = ?",
      ).get(BigInt(row.seq)) as unknown as { present: number } | undefined;
      return Object.freeze({
        found: true,
        record: decodeMemoryRow(row, this.config),
        vectorPresent: vector?.present === 1,
      });
    } finally {
      complete();
    }
  }

  async audit(request: MemoryLocalAuditRequest): Promise<MemoryLocalAudit> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      await this.#verifyStore();
      const snapshot = auditBujoDatabase(this.#state.database);
      if (request.strict === true) {
        assertReadableMemoryRows(this.#state.database, this.config, snapshot);
        assertCaptureReceiptIntegrity(this.#state.database);
      }
      const projections = await auditBujoProjections(this.#state.root);
      const compatible = vectorIdentityCompatible(
        this.#state.database,
        this.#embeddings,
        this.#vectorDimensions,
      );
      const missingExpectedVectors = this.#embeddings === undefined
        ? snapshot.missingDeclaredVectorRows
        : snapshot.missingVectorRows;
      const degraded = snapshot.missingFtsRows > 0
        || snapshot.orphanFtsRows > 0
        || snapshot.pendingCaptureCount > 0
        || snapshot.pendingVectorCount > 0
        || missingExpectedVectors > 0
        || !compatible
        || this.#embeddingDegraded
        || !projections.coherent;
      const audit: MemoryLocalAudit = Object.freeze({
        status: degraded ? "degraded" : "healthy",
        schema: "mono-agent.bujo.v1",
        storeId: this.#state.marker.storeId,
        database: databaseIdentitySummary(this.#state.databaseFile.identity),
        marker: identitySummary(this.#state.markerFile.identity),
        records: snapshot.recordCount,
        recordBytes: snapshot.recordBytes,
        fts: Object.freeze({
          indexed: snapshot.ftsCount,
          missing: snapshot.missingFtsRows,
          orphaned: snapshot.orphanFtsRows,
        }),
        vectors: Object.freeze({
          indexed: snapshot.vectorCount,
          missing: missingExpectedVectors,
          dimensions: this.#vectorDimensions,
          configured: this.#embeddings !== undefined,
          compatible,
        }),
        intake: Object.freeze({
          captures: snapshot.pendingCaptureCount,
          vectors: snapshot.pendingVectorCount,
        }),
        projections,
      });
      if (request.strict === true && audit.status !== "healthy") {
        throw new MemoryLocalError("maintenance_failed", "Strict memory audit found degraded durable state.");
      }
      return audit;
    } finally {
      complete();
    }
  }

  async backup(request: MemoryLocalBackupRequest): Promise<MemoryLocalBackupResult> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      return await this.#enqueueWrite(async () => {
        await this.#verifyStore();
        const destination = resolve(request.destinationDirectory);
        if (destination === this.directory) {
          throw new MemoryLocalError("maintenance_failed", "Memory backup destination must differ from the live root.");
        }
        const backupRoot = await openSecureRoot(destination);
        try {
          if ((await readdir(backupRoot.path)).length !== 0) {
            throw new MemoryLocalError("maintenance_failed", "Memory backup destination must be empty.");
          }
          const databasePath = join(backupRoot.path, MEMORY_LOCAL_DATABASE_FILENAME);
          const databaseHandle = await createSecureFile(databasePath);
          try {
            await databaseHandle.sync();
          } finally {
            await databaseHandle.close();
          }
          const backupFile = await openPinnedSecureFile(databasePath);
          try {
            await backupFile.verify();
            await backupSqlite(this.#state.database, databasePath);
            await backupFile.verify();
          } finally {
            await backupFile.close();
          }
          const databaseFile = await openPinnedSecureFile(databasePath);
          let databaseSha256: string;
          try {
            databaseSha256 = await hashPinnedFile(databaseFile, request.signal);
          } finally {
            await databaseFile.close();
          }
          const markerPath = join(backupRoot.path, MEMORY_LOCAL_MARKER_FILENAME);
          const markerHandle = await createSecureFile(markerPath);
          try {
            await markerHandle.writeFile(this.#state.markerBytes);
            await markerHandle.sync();
          } finally {
            await markerHandle.close();
          }
          await syncDirectory(backupRoot.path);
          await verifySecureRoot(backupRoot);
          const marker = await readSecureFile(markerPath, MARKER_MAX_BYTES);
          assertInitializedMarkerBytes(marker.bytes, this.#state.marker);
          const snapshot = auditBujoDatabase(this.#state.database);
          return Object.freeze({
            directory: backupRoot.path,
            databaseSha256,
            markerSha256: createHash("sha256").update(marker.bytes).digest("hex"),
            recordCount: snapshot.recordCount,
          });
        } finally {
          await backupRoot.handle.close();
        }
      });
    } finally {
      complete();
    }
  }

  async consolidate(
    request: MemoryLocalConsolidateRequest,
  ): Promise<MemoryLocalConsolidateResult> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      return await this.#enqueueWrite(async () => {
        try {
          await this.#verifyStore();
          const result = await consolidateBujoProjections({
            root: this.#state.root,
            database: this.#state.database,
            signal: request.signal,
            ...(this.#beforeConsolidationCommit === undefined
              ? {}
              : { beforeCommit: this.#beforeConsolidationCommit }),
          });
          await this.#verifyStore();
          return result;
        } catch (error) {
          if (request.signal.aborted) throwIfAborted(request.signal);
          throw sanitizedConsolidationError(error);
        }
      });
    } finally {
      complete();
    }
  }

  async rebuild(request: MemoryLocalRebuildRequest): Promise<MemoryLocalRebuildResult> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      return await this.#enqueueWrite(async () => {
        await this.#verifyStore();
        const rows = readMemoryRows(this.#state.database, 100_000);
        const vectors = new Map<string, readonly number[]>();
        if (this.#embeddings !== undefined) {
          for (let offset = 0; offset < rows.length; offset += 32) {
            throwIfAborted(request.signal);
            const batch = rows.slice(offset, offset + 32);
            const embedded = await this.#embed(
              batch.map(({ text }) => `search_document: ${text}`),
              request.signal,
              true,
            );
            if (embedded === undefined) throw embeddingUnavailable();
            batch.forEach((row, index) => vectors.set(row.id, embedded[index]!));
          }
        }
        const rebuilt = rebuildBujoIndexes(
          this.#state.database,
          rows,
          vectors,
          embeddingIdentity(this.#embeddings),
          this.#vectorDimensions,
        );
        checkpoint(this.#state.database);
        this.#vectorDimensions = rebuilt.vectorDimensions;
        this.#vectorCompatible = true;
        for (const item of listMetadata(this.#state.database, VECTOR_INTAKE_PREFIX, 100_000)) {
          deleteMetadata(this.#state.database, item.key);
        }
        await this.#verifyStore();
        return Object.freeze({
          records: rows.length,
          ...rebuilt,
        });
      });
    } finally {
      complete();
    }
  }

  async retryIntake(request: MemoryLocalRetryRequest): Promise<MemoryLocalRetryResult> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      const limit = request.limit ?? 32;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_MEMORY_LOCAL_INTAKE_RETRIES
      ) {
        throw new MemoryLocalError(
          "maintenance_failed",
          `Memory intake retry limit must be from 1 through ${MAX_MEMORY_LOCAL_INTAKE_RETRIES}.`,
        );
      }
      return await this.#enqueueWrite(async () => {
        await this.#verifyStore();
        let capturesRetried = 0;
        let vectorsRetried = 0;
        let failed = 0;
        let remaining = limit;
        for (const item of listMetadata(this.#state.database, CAPTURE_INTAKE_PREFIX, remaining)) {
          throwIfAborted(request.signal);
          try {
            const intake = parseCaptureIntake(item.value, this.config);
            await this.#completeCapture(validateMemoryRecord(intake.source, recordLimits(this.config)), request.signal);
            capturesRetried += 1;
          } catch (error) {
            if (request.signal.aborted) throw error;
            failed += 1;
          }
          remaining -= 1;
          if (remaining === 0) break;
        }
        if (remaining > 0 && this.#embeddings !== undefined) {
          for (const item of listMetadata(this.#state.database, VECTOR_INTAKE_PREFIX, remaining)) {
            throwIfAborted(request.signal);
            try {
              const recordId = parseVectorIntake(item.value);
              const row = readMemoryRow(this.#state.database, recordId);
              if (row === undefined) {
                deleteMetadata(this.#state.database, item.key);
                continue;
              }
              const embedded = await this.#embed([`search_document: ${row.text}`], request.signal, true);
              if (embedded === undefined) throw embeddingUnavailable();
              writeMemoryVector(
                this.#state.database,
                row,
                embedded[0]!,
                embeddingIdentity(this.#embeddings)!,
              );
              vectorsRetried += 1;
            } catch (error) {
              if (request.signal.aborted) throw error;
              failed += 1;
            }
            remaining -= 1;
            if (remaining === 0) break;
          }
        }
        checkpoint(this.#state.database);
        const audit = auditBujoDatabase(this.#state.database);
        this.#vectorCompatible = vectorIdentityCompatible(
          this.#state.database,
          this.#embeddings,
          this.#vectorDimensions,
        );
        await this.#verifyStore();
        return Object.freeze({
          capturesRetried,
          vectorsRetried,
          failed,
          remainingCaptures: audit.pendingCaptureCount,
          remainingVectors: audit.pendingVectorCount,
        });
      });
    } finally {
      complete();
    }
  }

  async health(context: ModuleHealthContext): Promise<ModuleHealth> {
    if (this.#closed) return health("unhealthy", "Memory store is closed.");
    try {
      const audit = await this.audit({ signal: context.signal });
      return audit.status === "healthy"
        ? health("healthy", "Owner-private BuJo memory store is ready.")
        : health("degraded", "BuJo memory is readable but maintenance or provider intake is pending.");
    } catch {
      return health("unhealthy", "Memory store integrity could not be proven.");
    }
  }

  async diagnostics(context: ModuleDiagnosticsContext): Promise<readonly ModuleDiagnostic[]> {
    try {
      const audit = await this.audit({ signal: context.signal });
      const diagnostics: ModuleDiagnostic[] = [];
      if (audit.fts.missing > 0 || audit.fts.orphaned > 0) {
        diagnostics.push(memoryDiagnostic(
          "memory-local.fts",
          "warning",
          `Memory FTS coverage is incomplete (missing ${audit.fts.missing}, orphaned ${audit.fts.orphaned}).`,
          "Keep the agent stopped and run an explicitly confirmed memory-local:rebuild.",
        ));
      }
      if (!audit.vectors.compatible) {
        diagnostics.push(memoryDiagnostic(
          "memory-local.vectors",
          "warning",
          "Memory vector identity is incompatible with the configured provider.",
          "Verify the configured model and dimensions before an explicitly confirmed rebuild.",
        ));
      }
      if (audit.vectors.missing > 0) {
        diagnostics.push(memoryDiagnostic(
          "memory-local.vector-coverage",
          "warning",
          `Memory vector coverage is incomplete (missing ${audit.vectors.missing}).`,
          "Correct the embedding boundary, then retry intake or run an explicitly confirmed rebuild.",
        ));
      }
      if (audit.intake.captures > 0 || audit.intake.vectors > 0) {
        diagnostics.push(memoryDiagnostic(
          "memory-local.intake",
          "warning",
          `Memory has pending bounded intake (captures ${audit.intake.captures}, vectors ${audit.intake.vectors}).`,
          "Correct the provider boundary, then run bounded intake retry explicitly.",
        ));
      }
      if (!audit.projections.coherent) {
        const unsafe = audit.projections.index === "unsafe"
          || audit.projections.index === "invalid"
          || audit.projections.futureLog === "unsafe"
          || audit.projections.futureLog === "invalid";
        diagnostics.push(memoryDiagnostic(
          "memory-local.projections",
          unsafe ? "error" : "warning",
          `Memory projections are incomplete or unsafe (index ${audit.projections.index}, future-log ${audit.projections.futureLog}).`,
          "Preserve canonical rows, inspect the derived targets, then retry explicit consolidation.",
        ));
      }
      if (audit.status === "degraded" && diagnostics.length === 0) {
        diagnostics.push(memoryDiagnostic(
          "memory-local.degraded",
          "warning",
          "Memory is readable but reports degraded provider or maintenance state.",
          "Run the bounded memory audit and resolve the reported local dependency.",
        ));
      }
      return Object.freeze(diagnostics);
    } catch {
      if (context.signal.aborted) throwIfAborted(context.signal);
      return Object.freeze([memoryDiagnostic(
        "memory-local.integrity",
        "error",
        "Memory identity or integrity could not be proven.",
        "Keep the agent stopped; preserve the root and investigate from a verified copy.",
      )]);
    }
  }

  async stop(_context?: ModuleStopContext): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    await this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#activeOperations]);
    await this.#writeTail;
    let failure: unknown;
    try {
      await this.#state.sidecars.verify();
      checkpoint(this.#state.database);
      await this.#state.sidecars.captureNew();
      await this.#state.sidecars.verify();
    } catch (error) {
      failure = error;
    }
    const closeFailure = await closeDatabaseSafely(
      this.#state.database,
      this.#state.sidecars,
    );
    failure ??= closeFailure;
    for (const cleanup of [
      async () => await this.#state.markerFile.close(),
      async () => await this.#state.databaseFile.close(),
      async () => await this.#state.lease.release(),
      async () => await this.#state.root.handle.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async #completeCapture(
    source: ValidatedMemoryRecord,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await this.#verifyStore();
    const receiptKey = captureReceiptKey(source.record.id);
    const receipt = getMetadata(this.#state.database, receiptKey);
    if (receipt !== undefined) {
      const parsed = parseCaptureReceipt(receipt);
      if (parsed.sourceHash !== source.contentHash) {
        throw new MemoryLocalError(
          "duplicate_record",
          `Capture id ${JSON.stringify(source.record.id)} already has different completed-turn content.`,
        );
      }
      if (
        this.#embeddings !== undefined
        && ensureVectorIntake(this.#state.database, parsed.recordIds) > 0
      ) {
        checkpoint(this.#state.database);
      }
      await this.#verifyStore();
      return;
    }
    const intakeKey = captureIntakeKey(source.record.id);
    const current = getMetadata(this.#state.database, intakeKey);
    let intake: CaptureIntake;
    if (current === undefined) {
      intake = Object.freeze({
        version: 1,
        source: source.record,
        sourceHash: source.contentHash,
        attempts: 0,
      });
      setMetadata(this.#state.database, intakeKey, canonicalJson(intake as never));
      checkpoint(this.#state.database);
    } else {
      intake = parseCaptureIntake(current, this.config);
      if (intake.sourceHash !== source.contentHash) {
        throw new MemoryLocalError(
          "duplicate_record",
          `Capture id ${JSON.stringify(source.record.id)} already has different in-flight content.`,
        );
      }
    }

    let records: readonly MemoryRecord[];
    try {
      records = await this.#runtimeCaptureRecords(source.record, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const failed: CaptureIntake = Object.freeze({
        ...intake,
        attempts: intake.attempts + 1,
        lastFailureAt: canonicalNow(this.#clock),
      });
      setMetadata(this.#state.database, intakeKey, canonicalJson(failed as never));
      checkpoint(this.#state.database);
      throw new MemoryLocalError(
        "runtime_capture_invalid",
        "Runtime-backed memory capture failed; the bounded intake remains retryable.",
      );
    }

    const validated = records.map((record) => validateMemoryRecord(record, recordLimits(this.config)));
    const vectors = new Map<string, readonly number[]>();
    if (this.#embeddings !== undefined && validated.length > 0) {
      const embedded = await this.#embed(
        validated.map(({ record }) => `search_document: ${record.text}`),
        signal,
        false,
      );
      if (embedded !== undefined) {
        validated.forEach((item, index) => vectors.set(item.record.id, embedded[index]!));
      }
    }
    insertMemoryRows(
      this.#state.database,
      validated,
      vectors,
      embeddingIdentity(this.#embeddings),
      this.config,
      {
        intakeKey,
        receiptKey,
        receiptValue: canonicalJson({
          version: 1,
          sourceHash: source.contentHash,
          recordIds: validated.map(({ record }) => record.id),
        } as never),
        ...(this.#beforeCaptureCommit === undefined
          ? {}
          : { beforeCommit: this.#beforeCaptureCommit }),
      },
    );
    checkpoint(this.#state.database);
    this.#vectorCompatible = vectorIdentityCompatible(
      this.#state.database,
      this.#embeddings,
      this.#vectorDimensions,
    );
    await this.#verifyStore();
  }

  async #runtimeCaptureRecords(
    source: MemoryRecord,
    signal: AbortSignal,
  ): Promise<readonly MemoryRecord[]> {
    const grant = this.#runtimeCapture;
    const route = this.config.capture.model;
    if (grant === undefined || route === undefined) throw runtimeCaptureUnavailable();
    const timeout = AbortSignal.timeout(this.config.capture.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let result;
    try {
      result = await grant.complete({
        instructions: "Extract durable standalone BuJo memory facts from the completed turn. Do not invent facts. Return only the requested structured object.",
        input: source.text,
        responseSchema: runtimeCaptureResponseSchema(DEFAULT_RUNTIME_CAPTURE_MAX_RECORDS),
        maxOutputTokens: DEFAULT_RUNTIME_CAPTURE_MAX_OUTPUT_TOKENS,
        signal: combined,
        runtime: route.runtime,
        model: route.model,
        timeoutMs: this.config.capture.timeoutMs,
      });
    } catch {
      if (signal.aborted) throwIfAborted(signal);
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime-backed memory capture failed.");
    }
    return validateRuntimeCaptureResult(result, source);
  }

  #ftsCandidates(query: string): readonly string[] {
    const match = ftsMatchExpression(query);
    if (match.length === 0) return [];
    const rows = this.#state.database.prepare(`
      SELECT f.id AS id
      FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ?
        AND m.status NOT IN ('invalidated','dropped')
      ORDER BY bm25(memories_fts), m.created_at DESC, m.id ASC
      LIMIT ?
    `).all(match, MAX_RECALL_CANDIDATES) as unknown as { id: string }[];
    return rows.map(({ id }) => id);
  }

  async #vectorCandidates(query: string, signal: AbortSignal): Promise<readonly string[]> {
    if (this.#embeddings === undefined || !this.#vectorCompatible) return [];
    const vectors = await this.#embed([`search_query: ${query}`], signal, false);
    if (vectors === undefined) return [];
    try {
      const rows = this.#state.database.prepare(`
        SELECT m.id AS id, v.distance AS distance
        FROM memories_vec v
        JOIN memories m ON m.seq = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
          AND m.status NOT IN ('invalidated','dropped')
        ORDER BY v.distance, m.id ASC
      `).all(toVectorBlob(vectors[0]!), MAX_RECALL_CANDIDATES) as unknown as
        { id: string; distance: number }[];
      return rows.map(({ id }) => id);
    } catch {
      this.#embeddingDegraded = true;
      return [];
    }
  }

  async #embed(
    texts: readonly string[],
    signal: AbortSignal,
    required: boolean,
  ): Promise<readonly (readonly number[])[] | undefined> {
    const provider = this.#embeddings;
    if (provider === undefined) return undefined;
    const now = this.#clock().valueOf();
    if (!Number.isFinite(now)) throw new MemoryLocalError("maintenance_failed", "Memory clock is invalid.");
    if (now < this.#embeddingBreakerUntil) {
      if (required) throw embeddingUnavailable();
      return undefined;
    }
    try {
      const vectors = await provider.embed(texts, signal);
      if (
        vectors.length !== texts.length
        || vectors.some((vector) =>
          vector.length !== provider.dimensions
          || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))
      ) {
        throw embeddingUnavailable();
      }
      this.#embeddingFailures = 0;
      this.#embeddingBreakerUntil = 0;
      this.#embeddingDegraded = false;
      return vectors;
    } catch (error) {
      if (signal.aborted) throw error;
      this.#embeddingFailures += 1;
      this.#embeddingDegraded = true;
      const configured = this.config.embeddings;
      if (configured !== undefined && this.#embeddingFailures >= configured.breakerFailures) {
        this.#embeddingBreakerUntil = now + configured.breakerResetMs;
      }
      if (required) throw embeddingUnavailable();
      return undefined;
    }
  }

  async #verifyStore(): Promise<void> {
    await verifySecureRoot(this.#state.root);
    await this.#state.lease.verify();
    await this.#state.databaseFile.verify();
    await this.#state.sidecars.verify();
    await this.#state.markerFile.verify();
    const markerBytes = await readPinnedBytes(this.#state.markerFile, MARKER_MAX_BYTES);
    if (!Buffer.from(markerBytes).equals(Buffer.from(this.#state.markerBytes))) {
      throw new MemoryLocalError("unsafe_store", "Permanent memory marker content changed after opening.");
    }
    assertInitializedMarkerBytes(markerBytes, this.#state.marker);
    quickCheck(this.#state.database);
  }

  #assertOpen(): void {
    if (this.#closed) throw new MemoryLocalError("closed", "Memory store is closed.");
  }

  #beginOperation(): () => void {
    this.#assertOpen();
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    this.#activeOperations.add(done);
    return () => {
      this.#activeOperations.delete(done);
      resolveDone?.();
    };
  }

  #enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation);
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function openMemoryLocal(options: OpenMemoryLocalOptions): Promise<MemoryLocal> {
  return await MemoryLocal.open(options);
}

/** Package-internal fault-injection entrypoint; not exported by the package root. */
export async function openMemoryLocalForTesting(
  options: OpenMemoryLocalForTestingOptions,
): Promise<MemoryLocal> {
  return await testingFactory(options);
}

async function hashPinnedFile(
  file: PinnedSecureFile,
  signal: AbortSignal,
): Promise<string> {
  await file.verify();
  const stat = await file.handle.stat();
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < stat.size) {
    throwIfAborted(signal);
    const length = Math.min(chunk.byteLength, stat.size - offset);
    const { bytesRead } = await file.handle.read(chunk, 0, length, offset);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== stat.size) throw new MemoryLocalError("maintenance_failed", "Memory backup changed while hashing.");
  await file.verify();
  return hash.digest("hex");
}

function checkpoint(database: DatabaseSync): void {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

function identitySummary(identity: FileIdentity): {
  readonly device: string;
  readonly inode: string;
  readonly mode: 384;
  readonly links: 1;
} {
  if (identity.mode !== 0o600 || identity.links !== 1) {
    throw new MemoryLocalError("unsafe_store", "Memory store identity is not owner-private and single-linked.");
  }
  return Object.freeze({
    device: identity.device,
    inode: identity.inode,
    mode: 0o600,
    links: 1,
  });
}

function databaseIdentitySummary(identity: FileIdentity): {
  readonly device: string;
  readonly inode: string;
  readonly mode: 384;
  readonly links: 2;
} {
  if (identity.mode !== 0o600 || identity.links !== 2) {
    throw new MemoryLocalError("unsafe_store", "Memory database binding is not owner-private and exact.");
  }
  return Object.freeze({
    device: identity.device,
    inode: identity.inode,
    mode: 0o600,
    links: 2,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function canonicalNow(clock: () => Date): string {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw new MemoryLocalError("maintenance_failed", "Memory clock returned an invalid date.");
  }
  return now.toISOString();
}

function sanitizedConsolidationError(error: unknown): MemoryLocalError {
  const code = error instanceof MemoryLocalError
    && (error.code === "unsafe_store" || error.code === "corrupt_store")
    ? error.code
    : "maintenance_failed";
  const rawCode = typeof error === "object" && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;
  return new MemoryLocalError(
    code,
    "Memory consolidation failed; canonical rows were not modified and projection publication may be retried.",
    {
      cause: new Error(
        typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/u.test(rawCode)
          ? `Projection publication failed with ${rawCode}`
          : "Projection publication failed",
      ),
    },
  );
}

function health(
  status: "healthy" | "degraded" | "unhealthy",
  summary: string,
): ModuleHealth {
  return Object.freeze({ status, checkedAt: new Date().toISOString(), summary });
}

function memoryDiagnostic(
  code: string,
  severity: ModuleDiagnostic["severity"],
  message: string,
  hint: string,
): ModuleDiagnostic {
  return Object.freeze({ code, severity, message, hint });
}
