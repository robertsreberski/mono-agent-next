import { createHash } from "node:crypto";

/**
 * Deterministic OTLP id source keyed on a run id.
 *
 * Trace/span ids are derived from `sha256(runId)` / `sha256(runId:<ordinal>)`
 * rather than random bytes so that re-exporting the same run (live retry, or a
 * `mono-agent backfill` re-run) produces byte-identical ids. Phoenix dedups on
 * trace/span id, so deterministic ids make export idempotent: a second export
 * overwrites the first instead of creating a duplicate trace.
 *
 * `ordinal` is assigned by the span builder: `0` is the root run span, `1..N`
 * are the per-event child spans in event order. Because `events.jsonl` order is
 * fixed, the ids are stable across runs.
 */
export interface DeterministicIdFactory {
  /** 16 raw bytes for the run's single trace id. */
  traceId(): Uint8Array;
  /** 8 raw bytes for the span at `ordinal` (0 = root, 1.. = children). */
  spanId(ordinal: number): Uint8Array;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

/**
 * OTLP forbids an all-zero trace/span id. A sha256 truncation is effectively
 * never all-zero, but guard trivially so a degenerate input can never emit an
 * invalid id.
 */
function nonZero(bytes: Uint8Array): Uint8Array {
  if (bytes.every((b) => b === 0)) {
    bytes[0] = 1;
  }
  return bytes;
}

export function createDeterministicIdFactory(runId: string): DeterministicIdFactory {
  return {
    traceId: () => nonZero(Uint8Array.prototype.slice.call(sha256(runId), 0, 16)),
    spanId: (ordinal: number) =>
      nonZero(Uint8Array.prototype.slice.call(sha256(`${runId}:${ordinal}`), 0, 8)),
  };
}

/** Lowercase-hex encode an id; the OTLP serializer hex-decodes span contexts. */
export function idToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
