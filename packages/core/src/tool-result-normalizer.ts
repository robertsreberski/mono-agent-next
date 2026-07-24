import { createHash } from "node:crypto";
import {
  parseArtifactRef,
  type ArtifactRef,
  type JsonValue,
  type RuntimeToolResultPart,
} from "@mono-agent/module-sdk";
export const TOOL_RESULT_INLINE_MAX_BYTES = 256 * 1024;
export const TOOL_RESULT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const TOOL_RESULT_PREVIEW_MAX_BYTES = 16 * 1024;
export const TOOL_RESULT_MAX_PARTS = 128;
export const TOOL_RESULT_MAX_JSON_DEPTH = 32;
export const TOOL_RESULT_MAX_JSON_ITEMS = 10_000;
export const TOOL_RESULT_ARTIFACT_MEDIA_TYPE =
  "application/vnd.mono-agent.tool-result+json";
export const TOOL_RESULT_ARTIFACT_FILE_NAME = "tool-result.json";
const JSON_STRING_CHUNK_CHARACTERS = 4_096;
const BINARY_CHUNK_BYTES = 12_288;
const FILE_NAME_MAX_BYTES = 255;
const MEDIA_TYPE_MAX_BYTES = 255;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu;
export interface ToolResultArtifactWrite {
  readonly data: Uint8Array;
  readonly mediaType: typeof TOOL_RESULT_ARTIFACT_MEDIA_TYPE;
  readonly fileName: typeof TOOL_RESULT_ARTIFACT_FILE_NAME;
  readonly signal: AbortSignal;
}
/**
 * The sink must not resolve until the complete artifact is atomically durable.
 * A rejected write must leave no visible partial artifact.
 */
export interface ToolResultArtifactSink {
  putArtifact(request: ToolResultArtifactWrite): Promise<ArtifactRef>;
}
export interface NormalizeToolResultOptions {
  readonly artifactSink?: ToolResultArtifactSink;
  readonly signal?: AbortSignal;
  readonly transformString?: (value: string) => string;
}
/**
 * A normalized tool envelope without the runtime-owned call id.
 */
export interface NormalizedToolResult {
  readonly isError: boolean;
  readonly content: readonly RuntimeToolResultPart[];
}
interface JsonNormalizationState {
  readonly active: Set<object>;
  items: number;
}
interface EncodedMeasurement {
  readonly complete: boolean;
  readonly preview: string;
  readonly sizeBytes: number;
}
class ToolResultBoundaryError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "ToolResultBoundaryError";
  }
}
/**
 * Normalize an arbitrary MCP result into the runtime-neutral tool-result
 * envelope. The canonical encoded envelope is kept inline only through
 * 256 KiB. Larger valid envelopes are offloaded atomically when a sink is
 * available; otherwise this function returns a bounded error and never falls
 * back to the unbounded result.
 */
export async function normalizeToolResult(
  output: unknown,
  options: NormalizeToolResultOptions = {},
): Promise<NormalizedToolResult> {
  const signal = options.signal ?? NEVER_ABORTED_SIGNAL;
  throwIfAborted(signal);
  let envelope: NormalizedToolResult;
  try {
    envelope = normalizeEnvelope(output, options.transformString ?? ((value) => value));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return boundedFailure(
      error instanceof ToolResultBoundaryError
        ? error.publicMessage
        : "Tool result could not be normalized within the safety boundary.",
    );
  }
  const measurement = measureEnvelope(envelope, signal);
  if (!measurement.complete) {
    return boundedFailure(
      `Tool result exceeds the ${String(TOOL_RESULT_ARTIFACT_MAX_BYTES)}-byte artifact limit.`,
    );
  }
  if (measurement.sizeBytes <= TOOL_RESULT_INLINE_MAX_BYTES) return envelope;
  const sink = options.artifactSink;
  if (sink === undefined) {
    return boundedFailure(
      `Tool result exceeds the ${String(TOOL_RESULT_INLINE_MAX_BYTES)}-byte inline limit and artifact persistence is unavailable.`,
    );
  }
  let data: Uint8Array;
  try {
    data = encodeEnvelope(envelope, measurement.sizeBytes, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return boundedFailure("Tool result could not be encoded within the safety boundary.");
  }
  const sha256 = `sha256:${createHash("sha256").update(data).digest("hex")}` as const;
  let ref: ArtifactRef;
  try {
    const candidate = await sink.putArtifact({
      data,
      mediaType: TOOL_RESULT_ARTIFACT_MEDIA_TYPE,
      fileName: TOOL_RESULT_ARTIFACT_FILE_NAME,
      signal,
    });
    throwIfAborted(signal);
    ref = parseArtifactRef(candidate);
    if (
      ref.sha256 !== sha256
      || ref.sizeBytes !== data.byteLength
      || ref.mediaType !== TOOL_RESULT_ARTIFACT_MEDIA_TYPE
    ) {
      throw new Error("Artifact sink returned a reference for different bytes.");
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw abortError();
    return boundedFailure(
      `Tool result exceeds the ${String(TOOL_RESULT_INLINE_MAX_BYTES)}-byte inline limit and could not be persisted.`,
    );
  }
  const summary =
    `Tool result exceeded the ${String(TOOL_RESULT_INLINE_MAX_BYTES)}-byte inline limit; `
    + `the complete ${String(data.byteLength)}-byte envelope was stored as ${sha256}.`;
  return {
    isError: envelope.isError,
    content: [
      { type: "text", text: summary },
      { type: "artifact", ref, preview: measurement.preview },
    ],
  };
}
function normalizeEnvelope(output: unknown, transform: (value: string) => string): NormalizedToolResult {
  const state: JsonNormalizationState = { active: new Set(), items: 0 };
  if (isRecord(output) && Array.isArray(output.content)) {
    if (output.isError !== undefined && typeof output.isError !== "boolean") {
      throw new ToolResultBoundaryError("Tool result isError must be boolean when present.");
    }
    if (output.content.length > TOOL_RESULT_MAX_PARTS) {
      throw new ToolResultBoundaryError(
        `Tool result exceeds the ${String(TOOL_RESULT_MAX_PARTS)}-part limit.`,
      );
    }
    return {
      isError: output.isError === true,
      content: output.content.map((part) => normalizePart(part, state, transform)),
    };
  }
  return {
    isError: false,
    content: [{ type: "json", value: normalizeJsonValue(output, state, 0, transform) }],
  };
}
function normalizePart(
  part: unknown,
  state: JsonNormalizationState,
  transform: (value: string) => string,
): RuntimeToolResultPart {
  if (!isRecord(part) || typeof part.type !== "string") {
    return { type: "json", value: normalizeJsonValue(part, state, 0, transform) };
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      throw new ToolResultBoundaryError("Tool result text parts require string text.");
    }
    return { type: "text", text: transform(part.text) };
  }
  if (part.type === "json") {
    if (!Object.hasOwn(part, "value")) {
      throw new ToolResultBoundaryError("Tool result JSON parts require a value.");
    }
    return { type: "json", value: normalizeJsonValue(part.value, state, 0, transform) };
  }
  if (part.type === "file" || part.type === "image") {
    const mediaType = part.type === "image" ? part.mimeType ?? part.mediaType : part.mediaType;
    if (typeof mediaType !== "string") {
      throw new ToolResultBoundaryError("Tool result file parts require a media type.");
    }
    const normalizedMediaType = normalizeMediaType(transform(mediaType));
    if (!(typeof part.data === "string" || part.data instanceof Uint8Array)) {
      throw new ToolResultBoundaryError("Tool result file parts require string or byte data.");
    }
    const data = part.data instanceof Uint8Array
      ? copyBoundedFileData(part.data)
      : transform(part.data);
    const name = part.name === undefined ? undefined
      : normalizeFileName(typeof part.name === "string" ? transform(part.name) : part.name);
    return {
      type: "file",
      mediaType: normalizedMediaType,
      data,
      ...(name === undefined ? {} : { name }),
    };
  }
  if (part.type === "artifact") {
    let ref: ArtifactRef;
    try {
      ref = parseArtifactRef(normalizeJsonValue(part.ref, state, 0, transform));
    } catch {
      throw new ToolResultBoundaryError("Tool result artifact parts require a valid artifact reference.");
    }
    const preview = typeof part.preview === "string" ? transform(part.preview) : part.preview;
    if (
      preview !== undefined
      && (
        typeof preview !== "string"
        || Buffer.byteLength(preview, "utf8") > TOOL_RESULT_PREVIEW_MAX_BYTES
      )
    ) {
      throw new ToolResultBoundaryError(
        `Tool result artifact previews must be at most ${String(TOOL_RESULT_PREVIEW_MAX_BYTES)} bytes.`,
      );
    }
    return {
      type: "artifact",
      ref,
      ...(preview === undefined ? {} : { preview }),
    };
  }
  return { type: "json", value: normalizeJsonValue(part, state, 0, transform) };
}
function normalizeJsonValue(
  value: unknown,
  state: JsonNormalizationState,
  depth: number,
  transform: (value: string) => string,
): JsonValue {
  if (typeof value === "string") return transform(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value === "function" || typeof value === "symbol") {
    throw new ToolResultBoundaryError("Tool result JSON contains an unsupported value.");
  }
  if (value instanceof Uint8Array) {
    throw new ToolResultBoundaryError("Tool result JSON bytes must be represented as a file part.");
  }
  if (typeof value !== "object") {
    throw new ToolResultBoundaryError("Tool result JSON contains an unsupported value.");
  }
  if (depth >= TOOL_RESULT_MAX_JSON_DEPTH) {
    throw new ToolResultBoundaryError(
      `Tool result JSON exceeds the depth limit of ${String(TOOL_RESULT_MAX_JSON_DEPTH)}.`,
    );
  }
  if (state.active.has(value)) {
    throw new ToolResultBoundaryError("Tool result JSON must not contain cycles.");
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      addJsonItems(state, value.length);
      return value.map((entry) => normalizeJsonValue(entry, state, depth + 1, transform));
    }
    const entries = Object.entries(value);
    addJsonItems(state, entries.length);
    const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of entries) {
      const transformedKey = transform(key);
      if (UNSAFE_JSON_KEYS.has(transformedKey) || Object.hasOwn(normalized, transformedKey)) {
        throw new ToolResultBoundaryError("Tool result JSON contains an unsafe object key.");
      }
      normalized[transformedKey] = normalizeJsonValue(entry, state, depth + 1, transform);
    }
    return normalized;
  } finally {
    state.active.delete(value);
  }
}
function addJsonItems(state: JsonNormalizationState, count: number): void {
  state.items += count;
  if (state.items > TOOL_RESULT_MAX_JSON_ITEMS) {
    throw new ToolResultBoundaryError(
      `Tool result JSON exceeds the ${String(TOOL_RESULT_MAX_JSON_ITEMS)}-item limit.`,
    );
  }
}
function copyBoundedFileData(data: Uint8Array): Uint8Array {
  const encodedBytes = Math.ceil(data.byteLength / 3) * 4;
  if (encodedBytes > TOOL_RESULT_ARTIFACT_MAX_BYTES) {
    throw new ToolResultBoundaryError(
      `Tool result file data exceeds the ${String(TOOL_RESULT_ARTIFACT_MAX_BYTES)}-byte artifact limit.`,
    );
  }
  return new Uint8Array(data);
}
function normalizeMediaType(value: string): string {
  const mediaType = value.trim().toLowerCase();
  if (
    mediaType.length === 0
    || Buffer.byteLength(mediaType, "utf8") > MEDIA_TYPE_MAX_BYTES
    || !MEDIA_TYPE_PATTERN.test(mediaType)
  ) {
    throw new ToolResultBoundaryError("Tool result file media type is invalid.");
  }
  return mediaType;
}
function normalizeFileName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > FILE_NAME_MAX_BYTES
  ) {
    throw new ToolResultBoundaryError("Tool result file names must be bounded base names.");
  }
  return value;
}
function measureEnvelope(
  envelope: NormalizedToolResult,
  signal: AbortSignal,
): EncodedMeasurement {
  let sizeBytes = 0;
  const previewChunks: Buffer[] = [];
  let previewBytes = 0;
  const previewPayloadLimit = TOOL_RESULT_PREVIEW_MAX_BYTES - 3;
  for (const chunk of encodeJsonChunks(envelope)) {
    throwIfAborted(signal);
    const bytes = Buffer.from(chunk, "utf8");
    sizeBytes += bytes.byteLength;
    if (previewBytes < previewPayloadLimit) {
      const selected = bytes.subarray(
        0,
        Math.min(bytes.byteLength, previewPayloadLimit - previewBytes),
      );
      previewChunks.push(selected);
      previewBytes += selected.byteLength;
    }
    if (sizeBytes > TOOL_RESULT_ARTIFACT_MAX_BYTES) {
      return {
        complete: false,
        preview: boundedPreview(previewChunks),
        sizeBytes,
      };
    }
  }
  return {
    complete: true,
    preview: boundedPreview(previewChunks, sizeBytes > previewBytes),
    sizeBytes,
  };
}
function encodeEnvelope(
  envelope: NormalizedToolResult,
  sizeBytes: number,
  signal: AbortSignal,
): Uint8Array {
  const encoded = Buffer.allocUnsafe(sizeBytes);
  let offset = 0;
  for (const chunk of encodeJsonChunks(envelope)) {
    throwIfAborted(signal);
    const bytes = Buffer.from(chunk, "utf8");
    bytes.copy(encoded, offset);
    offset += bytes.byteLength;
  }
  if (offset !== sizeBytes) {
    throw new Error("Tool result changed while it was encoded.");
  }
  return encoded;
}
function* encodeJsonChunks(value: unknown): Generator<string, void, undefined> {
  if (value instanceof Uint8Array) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    yield '"';
    for (let offset = 0; offset < buffer.byteLength; offset += BINARY_CHUNK_BYTES) {
      yield buffer.subarray(offset, offset + BINARY_CHUNK_BYTES).toString("base64");
    }
    yield '"';
    return;
  }
  if (typeof value === "string") {
    yield '"';
    for (let offset = 0; offset < value.length; offset += JSON_STRING_CHUNK_CHARACTERS) {
      const encoded = JSON.stringify(value.slice(offset, offset + JSON_STRING_CHUNK_CHARACTERS));
      yield encoded.slice(1, -1);
    }
    yield '"';
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    yield value === null ? "null" : String(value);
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ",";
      const entry = value[index];
      if (entry === undefined) throw new Error("Tool result JSON array changed while encoding.");
      yield* encodeJsonChunks(entry);
    }
    yield "]";
    return;
  }
  if (!isRecord(value)) throw new Error("Tool result changed while it was encoded.");
  yield "{";
  let index = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (index > 0) yield ",";
    yield* encodeJsonChunks(key);
    yield ":";
    yield* encodeJsonChunks(entry);
    index += 1;
  }
  yield "}";
}
function boundedPreview(chunks: readonly Buffer[], truncated = true): string {
  const suffix = truncated ? "..." : "";
  let preview = Buffer.concat(chunks).toString("utf8");
  while (
    preview.length > 0
    && Buffer.byteLength(`${preview}${suffix}`, "utf8") > TOOL_RESULT_PREVIEW_MAX_BYTES
  ) {
    preview = preview.slice(0, -1);
  }
  return `${preview}${suffix}`;
}
function boundedFailure(message: string): NormalizedToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
function abortError(): Error {
  const error = new Error("Tool result normalization aborted.");
  error.name = "AbortError";
  return error;
}
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
