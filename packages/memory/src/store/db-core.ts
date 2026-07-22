import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import { ftsQuery } from "./fts.js";
import { rrfFuse, reScore } from "./ranking.js";
import { migrations } from "./schema.js";
import { loadVec, toBlob } from "./vec.js";
import {
  DEFAULT_DECAY_GAMMA,
  DEFAULT_RRF_K,
  DEFAULT_VEC_DIM,
  DEFAULT_WEIGHTS,
  type ContentHashRecord,
  type EntityRecord,
  type MemoryDbOptions,
  type MemoryRecord,
  type RecallHit,
  type RecallOptions,
  type RecallWeights,
  type SimilarHit,
} from "./types.js";
import { lexicalEvidence, relevanceTokens } from "./db-relation-evidence.js";
import type { EmbeddingProvider } from "../search/index.js";

const MIN_SEMANTIC_SIMILARITY = 0.5;
const VECTOR_CANDIDATE_SCAN_CAP = 4_096;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

export class MemoryDbCore {
  protected readonly db: Database;
  protected readonly embeddings: EmbeddingProvider | undefined;
  protected readonly dim: number;
  protected readonly k: number;
  protected readonly weights: RecallWeights;
  protected readonly decayGamma: number;
  protected readonly clock: () => Date;

  constructor(options: MemoryDbOptions) {
    // Validate dim only when explicitly provided; absent → default 768 for the vec table DDL.
    if (options.dim !== undefined && (!Number.isInteger(options.dim) || options.dim <= 0)) {
      throw new Error("MemoryDb: dim must be a positive integer.");
    }
    const vecDim = options.dim ?? DEFAULT_VEC_DIM;
    if (options.readOnly !== true && options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new BetterSqlite3(options.path, options.readOnly === true
      ? { readonly: true, fileMustExist: true }
      : undefined);
    if (options.readOnly !== true) this.db.pragma("journal_mode = WAL");
    // WAL gives concurrent readers + a single writer. better-sqlite3 (v11) already defaults
    // busy_timeout to 5000ms, so a second connection (e.g. the bundled recall-tool child opening
    // the same db next to the live in-app store) retries on a locked db instead of throwing
    // SQLITE_BUSY. open.test.ts pins this
    // invariant — if an upgrade ever drops the default, the test fails and we set it explicitly here.
    loadVec(this.db);
    if (options.readOnly !== true) {
      for (const statement of migrations(vecDim)) this.db.exec(statement);
    }
    this.embeddings = options.embeddings;
    this.dim = vecDim;
    this.k = options.k ?? DEFAULT_RRF_K;
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.decayGamma = options.decayGamma ?? DEFAULT_DECAY_GAMMA;
    this.clock = options.clock ?? (() => new Date());
  }

  vecVersion(): string {
    const row = this.db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
    return row?.v ?? "";
  }

  /** Configured busy_timeout in ms — how long a blocked writer waits before SQLITE_BUSY. */
  busyTimeoutMs(): number {
    return Number(this.db.pragma("busy_timeout", { simple: true }));
  }

  /**
   * Guard that an embedding vector matches the configured `dim` before it reaches sqlite-vec.
   * Surfaces a clear error (e.g. when the embedding model changed but `dim` was left stale) instead
   * of the opaque sqlite-vec failure on INSERT/MATCH.
   */
  protected assertVectorDim(vector: readonly number[], context: string): void {
    if (vector.length !== this.dim) {
      throw new Error(
        `memory-store: embedding dimension mismatch in ${context} — expected ${this.dim}, got ${vector.length}. ` +
          "Ensure the embedding model matches the configured `dim`.",
      );
    }
    if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`memory-store: embedding vector in ${context} contains a non-finite value.`);
    }
  }

  async upsert(record: MemoryRecord): Promise<void> {
    await this.upsertMany([record]);
  }

  /**
   * Persist the lexical row immediately without calling an embedding service.
   * Journal uses this on the response path, then upgrades the row with a vector
   * from its bounded background queue.
   */
  upsertLexical(record: MemoryRecord, contentHash?: string): void {
    this.persistRecords([record], [undefined], true);
    if (contentHash !== undefined && record.source.file !== undefined) this.recordContentHash({
      contentHash,
      memoryId: record.id,
      sourceFile: record.source.file,
      createdAt: record.createdAt,
    });
  }

  /**
   * Normalize the one SQLite-only field mutated by historical decay releases.
   * The expected-current predicate is a compare-and-swap fence; this deliberately
   * leaves the lexical row, vector, telemetry, provenance, and lifecycle untouched.
   */
  repairLegacySalience(id: string, expectedCurrent: number, canonical: number): void {
    if (id.length === 0 || !Number.isFinite(expectedCurrent) || !Number.isFinite(canonical)
      || expectedCurrent === canonical) {
      throw new Error("memory-store: invalid legacy salience repair request.");
    }
    const result = this.db.prepare(
      `UPDATE memories SET salience = ? WHERE id = ? AND salience = ?`,
    ).run(canonical, id, expectedCurrent);
    if (result.changes !== 1) {
      throw new Error(`memory-store: legacy salience repair lost compare-and-swap for "${id}".`);
    }
  }

  /**
   * Atomically reserve a Journal content hash and make its lexical row visible.
   * The unique hash is the cross-process dedupe authority.
   */
  insertJournalLexical(record: MemoryRecord, contentHash: string): { inserted: boolean; memoryId: string } {
    if (record.source.file === undefined) {
      throw new Error("memory-store: journal content hashes require source.file provenance.");
    }
    const tx = this.db.transaction((): { inserted: boolean; memoryId: string } => {
      const existing = this.db.prepare(
        `SELECT memory_id FROM content_hashes WHERE content_hash = ?`,
      ).get(contentHash) as { memory_id: string } | undefined;
      if (existing !== undefined) return { inserted: false, memoryId: existing.memory_id };
      this.persistRecordsUnsafe([record], [undefined], true);
      this.db.prepare(
        `INSERT INTO content_hashes (content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)`,
      ).run(contentHash, record.id, record.source.file, record.createdAt);
      return { inserted: true, memoryId: record.id };
    });
    return tx();
  }

  /** Embed and persist records in provider-sized batches (default 32). */
  async upsertMany(
    records: readonly MemoryRecord[],
    options: { readonly batchSize?: number } = {},
  ): Promise<{ indexed: number; embeddingCalls: number }> {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, 256));
    let embeddingCalls = 0;
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const batch = records.slice(offset, offset + batchSize);
      let vectors: Array<readonly number[] | undefined>;
      if (this.embeddings === undefined) {
        vectors = batch.map(() => undefined);
      } else {
        const embedded = await this.embeddings.embed(batch.map((record) => `search_document: ${record.text}`));
        embeddingCalls += 1;
        if (embedded.length !== batch.length) {
          throw new Error(
            `memory-store: embedding provider returned ${embedded.length} vectors for ${batch.length} records.`,
          );
        }
        vectors = embedded.map((vector) => {
          this.assertVectorDim(vector, "upsertMany");
          return vector;
        });
      }
      this.persistRecords(batch, vectors, true);
    }
    return { indexed: records.length, embeddingCalls };
  }

  /**
   * Prepare one provider batch before a caller mutates canonical source files.
   * BuJo capture uses the returned vectors with commitPreparedUpserts so an
   * embedding outage cannot leave a newly edited source pretending success.
   */
  async prepareUpsertVectors(
    records: readonly MemoryRecord[],
  ): Promise<readonly (readonly number[] | undefined)[]> {
    if (this.embeddings === undefined) return records.map(() => undefined);
    if (records.length === 0) return [];
    const vectors = await this.embeddings.embed(records.map((record) => `search_document: ${record.text}`));
    if (vectors.length !== records.length) {
      throw new Error(`memory-store: embedding provider returned ${vectors.length} vectors for ${records.length} records.`);
    }
    vectors.forEach((vector) => this.assertVectorDim(vector, "prepareUpsertVectors"));
    return vectors;
  }

  /** Validate an already-prepared batch without changing SQLite. */
  assertPreparedUpserts(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
  ): void {
    if (records.length !== vectors.length) {
      throw new Error("memory-store: record/vector batch length mismatch.");
    }
    vectors.forEach((vector) => {
      if (vector !== undefined) this.assertVectorDim(vector, "commitPreparedUpserts");
    });
    if (this.embeddings === undefined && vectors.some((vector) => vector !== undefined)) {
      throw new Error(
        "memory-store: prepared embedding vectors require a configured embedding identity.",
      );
    }
    if (this.embeddings !== undefined && vectors.some((vector) => vector === undefined)) {
      throw new Error(
        "memory-store: configured embedding identity requires one prepared vector per record.",
      );
    }
  }

  /** Persist records with vectors prepared by this DB's configured provider. */
  commitPreparedUpserts(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
  ): void {
    this.assertPreparedUpserts(records, vectors);
    this.persistRecords(records, vectors, true);
  }

  /**
   * Add/refresh vectors without replaying a queued record snapshot over newer
   * status, source, or access telemetry.
   */
  async indexVectors(
    records: readonly Pick<MemoryRecord, "id" | "text">[],
    options: { readonly batchSize?: number; readonly abortSignal?: AbortSignal } = {},
  ): Promise<{ indexed: number; skipped: number; embeddingCalls: number }> {
    if (this.embeddings === undefined || records.length === 0) {
      return { indexed: 0, skipped: records.length, embeddingCalls: 0 };
    }
    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, 256));
    let indexed = 0;
    let skipped = 0;
    let embeddingCalls = 0;
    for (let offset = 0; offset < records.length; offset += batchSize) {
      const batch = records.slice(offset, offset + batchSize);
      const vectors = await this.embeddings.embed(batch.map((record) => `search_document: ${record.text}`));
      options.abortSignal?.throwIfAborted();
      embeddingCalls += 1;
      if (vectors.length !== batch.length) {
        throw new Error(`memory-store: embedding provider returned ${vectors.length} vectors for ${batch.length} records.`);
      }
      vectors.forEach((vector) => this.assertVectorDim(vector, "indexVectors"));
      const current = this.db.prepare(`SELECT seq, text FROM memories WHERE id = ?`);
      const deleteVec = this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`);
      const insertVec = this.db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`);
      const markIdentity = this.db.prepare(`UPDATE memories SET embedding_model = ?, dim = ? WHERE id = ?`);
      const tx = this.db.transaction(() => {
        for (const [index, record] of batch.entries()) {
          const row = current.get(record.id) as { seq: number; text: string } | undefined;
          if (row === undefined || row.text !== record.text) {
            skipped += 1;
            continue;
          }
          deleteVec.run(BigInt(row.seq));
          insertVec.run(BigInt(row.seq), toBlob(vectors[index]!));
          markIdentity.run(this.embeddings!.id, this.dim, record.id);
          indexed += 1;
        }
      });
      tx();
    }
    return { indexed, skipped, embeddingCalls };
  }

  private persistRecords(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
    clearMissingVector: boolean,
  ): void {
    if (records.length !== vectors.length) {
      throw new Error("memory-store: record/vector batch length mismatch.");
    }
    const tx = this.db.transaction(() => this.persistRecordsUnsafe(records, vectors, clearMissingVector));
    tx();
  }

  private persistRecordsUnsafe(
    records: readonly MemoryRecord[],
    vectors: readonly (readonly number[] | undefined)[],
    clearMissingVector: boolean,
  ): void {
    const upsertMemory = this.db.prepare(
        `INSERT INTO memories (
           id, seq, type, status, text, salience, is_insight, created_at, last_accessed_at,
           access_count, valid_from, valid_to, superseded_by, superseded_at, due_at, collection,
           source_session, source_file, source_line, embedding_model, dim, tags
         ) VALUES (
           @id, @seq, @type, @status, @text, @salience, @is_insight, @created_at, @last_accessed_at,
           @access_count, @valid_from, @valid_to, @superseded_by, @superseded_at, @due_at, @collection,
           @source_session, @source_file, @source_line, @embedding_model, @dim, @tags
         )
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, status=excluded.status, text=excluded.text, salience=excluded.salience,
           is_insight=excluded.is_insight, last_accessed_at=excluded.last_accessed_at,
           access_count=excluded.access_count, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
           superseded_by=excluded.superseded_by, superseded_at=excluded.superseded_at, due_at=excluded.due_at,
           collection=excluded.collection, source_session=excluded.source_session, source_file=excluded.source_file,
           source_line=excluded.source_line, embedding_model=excluded.embedding_model, dim=excluded.dim,
           tags=excluded.tags`,
    );
    const deleteFts = this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`);
    const insertFts = this.db.prepare(`INSERT INTO memories_fts (id, text) VALUES (?, ?)`);
    const deleteVec = this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`);
    const insertVec = this.db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`);
    for (const [index, record] of records.entries()) {
      const vector = vectors[index];
      // seq is computed inside the caller's tx so concurrent new ids cannot collide.
      const seq = this.nextSeq(record.id);
      upsertMemory.run(this.toRow(record, seq));
      deleteFts.run(record.id);
      insertFts.run(record.id, record.text);
      if (vector !== undefined || clearMissingVector) {
        deleteVec.run(BigInt(seq));
      }
      if (vector !== undefined) {
        insertVec.run(BigInt(seq), toBlob(vector));
      }
    }
  }

  hasVector(id: string): boolean {
    return this.db.prepare(
      `SELECT 1 AS present FROM memories m JOIN memories_vec v ON v.rowid = m.seq WHERE m.id = ? LIMIT 1`,
    ).get(id) !== undefined;
  }

  recordsMissingVectors(limit = 512, excludeIds: readonly string[] = []): MemoryRecord[] {
    const normalized = Math.max(0, Math.min(Math.trunc(limit), 4_096));
    const excluded = [...new Set(excludeIds)].slice(0, 256);
    const exclusion = excluded.length === 0
      ? ""
      : ` AND m.id NOT IN (${excluded.map(() => "?").join(",")})`;
    const rows = this.db.prepare(
      `SELECT m.* FROM memories m LEFT JOIN memories_vec v ON v.rowid = m.seq
       WHERE v.rowid IS NULL AND m.status NOT IN ('invalidated','dropped')${exclusion}
       ORDER BY m.seq ASC LIMIT ?`,
    ).all(...excluded, normalized) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  countMissingVectors(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM memories m LEFT JOIN memories_vec v ON v.rowid = m.seq
       WHERE v.rowid IS NULL AND m.status NOT IN ('invalidated','dropped')`,
    ).get() as { n: number }).n;
  }

  hasContentHash(contentHash: string): boolean {
    return this.db.prepare(`SELECT 1 AS present FROM content_hashes WHERE content_hash = ?`).get(contentHash) !== undefined;
  }

  contentHashRecord(contentHash: string): ContentHashRecord | undefined {
    const row = this.db.prepare(
      `SELECT content_hash, memory_id, source_file, created_at FROM content_hashes WHERE content_hash = ?`,
    ).get(contentHash) as {
      content_hash: string;
      memory_id: string;
      source_file: string;
      created_at: string;
    } | undefined;
    return row === undefined ? undefined : {
      contentHash: row.content_hash,
      memoryId: row.memory_id,
      sourceFile: row.source_file,
      createdAt: row.created_at,
    };
  }

  recordContentHash(record: ContentHashRecord): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO content_hashes (content_hash, memory_id, source_file, created_at) VALUES (?, ?, ?, ?)`,
    ).run(record.contentHash, record.memoryId, record.sourceFile, record.createdAt);
  }

  /**
   * Canonicalize one legacy Journal bullet onto its content-derived id without
   * rewriting the Markdown source. The lexicographically earliest source
   * location is the deterministic representative, independent of scan/process
   * ordering; any old source id is retained only as a dropped, non-recallable
   * row when it already existed in an older index.
   */
  recoverJournalLexical(record: MemoryRecord, contentHash: string, sourceId: string): void {
    if (record.source.file === undefined || record.source.line === undefined) {
      throw new Error("memory-store: Journal recovery requires source file and line provenance.");
    }
    const tx = this.db.transaction(() => {
      const existing = this.get(record.id);
      const sourceKey = journalSourceKey(record);
      const existingSourceKey = existing === undefined ? undefined : journalSourceKey(existing);
      const recordWins = (
        existing === undefined
        || existingSourceKey === undefined
        || sourceKey < existingSourceKey
        || (sourceKey === existingSourceKey && journalRecordChanged(existing, record))
      );
      if (recordWins) {
        this.persistRecordsUnsafe([record], [undefined], true);
      }
      const representative = recordWins ? record : existing;
      const priorAtSource = this.db.prepare(
        `SELECT id FROM memories WHERE source_file = ? AND source_line = ? AND id <> ?`,
      ).all(record.source.file, record.source.line, record.id) as { id: string }[];
      for (const prior of priorAtSource) {
        this.db.prepare(`UPDATE memories SET status = 'dropped' WHERE id = ?`).run(prior.id);
        this.db.prepare(`DELETE FROM content_hashes WHERE memory_id = ?`).run(prior.id);
      }
      this.db.prepare(
        `INSERT INTO content_hashes (content_hash, memory_id, source_file, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           memory_id = excluded.memory_id,
           source_file = excluded.source_file,
           created_at = excluded.created_at`,
      ).run(contentHash, representative.id, representative.source.file, representative.createdAt);
      if (sourceId !== record.id) {
        this.db.prepare(`UPDATE memories SET status = 'dropped' WHERE id = ?`).run(sourceId);
        this.db.prepare(`DELETE FROM content_hashes WHERE memory_id = ? AND content_hash <> ?`).run(sourceId, contentHash);
      }
    });
    tx();
  }

  deleteContentHashesForMemory(memoryId: string): void {
    this.db.prepare(`DELETE FROM content_hashes WHERE memory_id = ?`).run(memoryId);
  }

  countContentHashes(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM content_hashes`).get() as { n: number }).n;
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.fromRow(row);
  }

  /** Complete deterministic inventory for rebuild/parity validation. */
  allMemories(): MemoryRecord[] {
    const rows = this.db.prepare(`SELECT * FROM memories ORDER BY id`).all() as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
  }
  async recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    options.abortSignal?.throwIfAborted();
    const topK = options.topK ?? 8;
    const candidates = options.candidates ?? Math.max(topK * 4, 20);
    const now = options.now ?? this.clock();

    const ftsIds = this.keywordCandidates(query, candidates, options.includeInvalid === true, now);
    const vecCandidates = this.embeddings !== undefined
      ? await this.vectorCandidates(query, candidates, options.includeInvalid === true, now, options.abortSignal)
      : [];
    options.abortSignal?.throwIfAborted();
    const vecIds = vecCandidates.map((candidate) => candidate.id);
    const vectorSimilarity = new Map(vecCandidates.map((candidate) => [candidate.id, candidate.similarity]));
    const retrieverCount = Number(vecIds.length > 0) + Number(ftsIds.length > 0);
    // When embeddings are absent, fuse only the FTS list (RRF of one list still re-ranks correctly).
    const fused = rrfFuse([vecIds, ftsIds], this.k);
    if (fused.length === 0) return [];

    const byId = new Map(fused.map((f) => [f.id, f.rrfScore]));
    const placeholders = fused.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...fused.map((f) => f.id)) as Record<string, unknown>[];

    const scored: RecallHit[] = [];
    const queryTokens = relevanceTokens(query);
    for (const row of rows) {
      const record = this.fromRow(row);
      if (!options.includeInvalid && (record.status === "invalidated" || record.status === "dropped")) continue;
      if (!options.includeInvalid && record.validTo !== undefined && new Date(record.validTo) < now) continue;
      const lexical = lexicalEvidence(queryTokens, record.text);
      const semanticSimilarity = vectorSimilarity.get(record.id) ?? 0;
      const semantic = semanticSimilarity >= MIN_SEMANTIC_SIMILARITY ? semanticSimilarity : 0;
      const evidence = Math.min(1, Math.max(lexical, semantic) + (lexical > 0 && semantic > 0 ? 0.05 : 0));
      // Normalize the small RRF value into a bounded rank hint. It may break ties,
      // but cannot make a no-evidence vector neighbour look relevant.
      const fusedRank = Math.min(1, ((byId.get(record.id) ?? 0) * (this.k + 1)) / retrieverCount);
      const relevance = evidence === 0 ? fusedRank * 0.05 : evidence * 0.9 + fusedRank * 0.1;
      const score = reScore(
        {
          rrfScore: relevance,
          salience: record.salience,
          isInsight: record.isInsight,
        },
        this.weights,
        this.decayGamma,
        now,
      );
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
    const top = scored.slice(0, topK);
    if (options.trackAccess === false) {
      return top;
    }
    this.bumpAccess(top.map((h) => h.record.id), now);
    return top.map((h) => ({ ...h, record: { ...h.record, accessCount: h.record.accessCount + 1, lastAccessedAt: now.toISOString() } }));
  }

  protected async vectorCandidates(
    query: string,
    limit: number,
    includeInvalid = false,
    now = this.clock(),
    abortSignal?: AbortSignal,
  ): Promise<Array<{ id: string; similarity: number }>> {
    abortSignal?.throwIfAborted();
    if (this.embeddings === undefined) return [];
    const [vector] = await this.embeddings.embed([`search_query: ${query}`]);
    abortSignal?.throwIfAborted();
    if (vector === undefined) return [];
    this.assertVectorDim(vector, "recall");
    const validity = includeInvalid
      ? ""
      : " AND m.status NOT IN ('invalidated','dropped') AND (m.valid_to IS NULL OR m.valid_to >= ?)";
    const statement = this.db.prepare(
      `SELECT m.id AS id, v.distance AS distance
       FROM memories_vec v JOIN memories m ON m.seq = v.rowid
       WHERE v.embedding MATCH ? AND k = ?${validity}
       ORDER BY v.distance`,
    );
    const totalVectors = includeInvalid
      ? limit
      : (this.db.prepare(`SELECT COUNT(*) AS n FROM memories_vec`).get() as { n: number }).n;
    const maxScan = Math.min(totalVectors, Math.max(limit, VECTOR_CANDIDATE_SCAN_CAP));
    let scan = Math.min(totalVectors, Math.max(1, limit));
    let rows: Array<{ id: string; distance: number }> = [];
    do {
      rows = statement.all(toBlob(vector), scan, ...(includeInvalid ? [] : [now.toISOString()])) as Array<{
        id: string;
        distance: number;
      }>;
      if (rows.length >= limit || scan >= maxScan) break;
      scan = Math.min(maxScan, scan * 2);
    } while (scan > 0);
    return rows.slice(0, limit)
      .map((row) => ({ id: row.id, similarity: Math.max(-1, Math.min(1, 1 - row.distance)) }));
  }

  protected keywordCandidates(query: string, limit: number, includeInvalid = false, now = this.clock()): string[] {
    const match = ftsQuery(query);
    if (match.length === 0) return [];
    const rows = includeInvalid
      ? this.db
        .prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`)
        .all(match, limit) as { id: string }[]
      : this.db
        .prepare(
          `SELECT memories_fts.id AS id
           FROM memories_fts JOIN memories m ON m.id = memories_fts.id
           WHERE memories_fts MATCH ?
             AND m.status NOT IN ('invalidated','dropped')
             AND (m.valid_to IS NULL OR m.valid_to >= ?)
           ORDER BY bm25(memories_fts) LIMIT ?`,
        )
        .all(match, now.toISOString(), limit) as { id: string }[];
    return rows.map((r) => r.id);
  }
  async findSimilar(
    text: string,
    k = 5,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<SimilarHit[]> {
    return (await this.findSimilarMany([text], k, options))[0] ?? [];
  }

  /** One provider batch for all capture candidates, then bounded local KNN per candidate. */
  async findSimilarMany(
    texts: readonly string[],
    k = 5,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<SimilarHit[][]> {
    options.abortSignal?.throwIfAborted();
    if (this.embeddings === undefined || texts.length === 0) return texts.map(() => []);
    const vectors = await this.embeddings.embed(texts.map((text) => `search_document: ${text}`));
    options.abortSignal?.throwIfAborted();
    if (vectors.length !== texts.length) {
      throw new Error(`memory-store: embedding provider returned ${vectors.length} vectors for ${texts.length} similarity queries.`);
    }
    return vectors.map((vector) => this.findSimilarVector(vector, k));
  }

  private findSimilarVector(vector: readonly number[], k: number): SimilarHit[] {
    this.assertVectorDim(vector, "findSimilarMany");
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.distance AS distance FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
      )
      .all(toBlob(vector), k + 8) as { id: string; distance: number }[]; // over-fetch, filter, then trim
    const out: SimilarHit[] = [];
    for (const row of rows) {
      const record = this.get(row.id);
      if (record === undefined) continue;
      if (record.status === "invalidated" || record.status === "dropped") continue;
      out.push({ record, distance: row.distance });
      if (out.length >= k) break;
    }
    return out;
  }

  /**
   * Wipe the index and rebuild it from the supplied records (used by rebuild-from-files). No LLM.
   * Wipes ALL index tables — including entities/entity_relations — so the caller is responsible for
   * repopulating the entity graph afterwards (memory-bujo's rebuildFromMarkdown re-ingests graph.jsonl).
   * Not atomic across records: the wipe is transactional, but if a re-upsert throws mid-way the index
   * is left partially rebuilt. Since the index is rebuildable from canonical files, callers should
   * treat a thrown rebuild as "index dirty — re-run" rather than relying on all-or-nothing semantics.
   */
  async rebuild(records: readonly MemoryRecord[]): Promise<{ indexed: number }> {
    const tx = this.db.transaction(() => {
      this.db.exec(
        `DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM memories_vec; DELETE FROM edges;
         DELETE FROM memory_entities; DELETE FROM entities; DELETE FROM entity_relations;
         DELETE FROM content_hashes; DELETE FROM index_metadata;`,
      );
    });
    tx();
    return await this.upsertMany(records);
  }

  protected bumpAccess(ids: readonly string[], now: Date): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now.toISOString(), id);
    });
    tx();
  }

  /** Record served hits as telemetry. Access metadata never participates in ranking. */
  recordAccess(ids: readonly string[], now = this.clock()): void {
    this.bumpAccess(ids, now);
  }

  protected nextSeq(id: string): number {
    const existing = this.db.prepare(`SELECT seq FROM memories WHERE id = ?`).get(id) as { seq: number } | undefined;
    if (existing !== undefined) return existing.seq;
    const max = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM memories`).get() as { m: number };
    return max.m + 1;
  }

  protected toRow(record: MemoryRecord, seq: number): Record<string, unknown> {
    return {
      id: record.id,
      seq,
      type: record.type,
      status: record.status,
      text: record.text,
      salience: record.salience,
      is_insight: record.isInsight ? 1 : 0,
      created_at: record.createdAt,
      last_accessed_at: record.lastAccessedAt ?? null,
      access_count: record.accessCount,
      valid_from: record.validFrom ?? null,
      valid_to: record.validTo ?? null,
      superseded_by: record.supersededBy ?? null,
      superseded_at: record.supersededAt ?? null,
      due_at: record.dueAt ?? null,
      collection: record.collection ?? null,
      source_session: record.source.session ?? null,
      source_file: record.source.file ?? null,
      source_line: record.source.line ?? null,
      embedding_model: record.embeddingModel ?? this.embeddings?.id ?? null,
      dim: record.dim ?? this.dim,
      tags: JSON.stringify(record.tags),
    };
  }

  protected fromRow(row: Record<string, unknown>): MemoryRecord {
    const str = (v: unknown): string => String(v);
    return {
      id: str(row.id),
      type: row.type as MemoryRecord["type"],
      status: row.status as MemoryRecord["status"],
      text: str(row.text),
      salience: Number(row.salience),
      isInsight: Number(row.is_insight) === 1,
      createdAt: str(row.created_at),
      ...(row.last_accessed_at != null && { lastAccessedAt: str(row.last_accessed_at) }),
      accessCount: Number(row.access_count),
      ...(row.valid_from != null && { validFrom: str(row.valid_from) }),
      ...(row.valid_to != null && { validTo: str(row.valid_to) }),
      ...(row.superseded_by != null && { supersededBy: str(row.superseded_by) }),
      ...(row.superseded_at != null && { supersededAt: str(row.superseded_at) }),
      ...(row.due_at != null && { dueAt: str(row.due_at) }),
      ...(row.collection != null && { collection: str(row.collection) }),
      source: {
        ...(row.source_session != null && { session: str(row.source_session) }),
        ...(row.source_file != null && { file: str(row.source_file) }),
        ...(row.source_line != null && { line: Number(row.source_line) }),
      },
      ...(row.embedding_model != null && { embeddingModel: str(row.embedding_model) }),
      ...(row.dim != null && { dim: Number(row.dim) }),
      tags: JSON.parse(str(row.tags ?? "[]")) as string[],
    };
  }
  protected entityFromRow(row: Record<string, unknown>): EntityRecord {
    const str = (v: unknown): string => String(v);
    return {
      id: str(row.id),
      name: str(row.name),
      ...(row.type != null && { type: str(row.type) }),
      ...(row.summary != null && { summary: str(row.summary) }),
      createdAt: str(row.created_at),
      ...(row.updated_at != null && { updatedAt: str(row.updated_at) }),
    };
  }
}

function journalSourceKey(record: MemoryRecord): string {
  const file = record.source.file ?? "\uffff";
  const line = String(record.source.line ?? Number.MAX_SAFE_INTEGER).padStart(12, "0");
  return `${file}\u0000${line}`;
}

function journalRecordChanged(current: MemoryRecord, next: MemoryRecord): boolean {
  return current.text !== next.text
    || current.status !== next.status
    || current.type !== next.type
    || current.salience !== next.salience
    || current.isInsight !== next.isInsight
    || current.dueAt !== next.dueAt;
}
