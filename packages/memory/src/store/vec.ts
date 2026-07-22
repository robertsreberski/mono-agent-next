import type { Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/** Load the sqlite-vec extension into an open better-sqlite3 connection. */
export function loadVec(db: Database): void {
  sqliteVec.load(db);
}

/**
 * Encode a numeric vector as a little-endian float32 BLOB for vec0.
 *
 * sqlite-vec interprets float32 vectors as little-endian, so we write the bytes explicitly with
 * `writeFloatLE` rather than relying on `Float32Array`'s platform-native byte order — that keeps the
 * BLOB correct on a (rare) big-endian runtime.
 */
export function toBlob(vector: readonly number[]): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) {
    buf.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  return buf;
}
