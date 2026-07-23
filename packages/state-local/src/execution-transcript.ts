import {
  parseArtifactRef,
  parseRouteIdentity,
} from "@mono-agent/module-sdk";

import type {
  AgentInteractionEvidence,
  AgentTranscriptContentPart,
  AgentTranscriptEntry,
} from "./execution-types.js";

const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 50_000;
const TRANSCRIPT_MAX_CONTENT_PARTS = 128;
const TRANSCRIPT_MAX_TEXT_BYTES = 1024 * 1024;
const TRANSCRIPT_MAX_IDENTIFIER_BYTES = 512;
const TRANSCRIPT_MAX_CONVERSATION_ID_BYTES = 4_096;
const TRANSCRIPT_MAX_SOURCE_BYTES = 4_096;

/**
 * Durable transcripts never retain attachment bytes. Every binary input is
 * published through the state artifact plane before settlement and represented
 * here only by its immutable, content-addressed reference.
 */
export type CanonicalTranscriptContentPart = AgentTranscriptContentPart;
export type CanonicalTranscriptEntry = AgentTranscriptEntry;

export interface CanonicalTranscript {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.canonical-transcript";
  readonly conversationId: string;
  readonly revision: number;
  readonly entries: readonly CanonicalTranscriptEntry[];
}

export function parseCanonicalTranscript(value: unknown): CanonicalTranscript {
  const input = ownDataRecord(
    value,
    "canonical transcript",
    ["schemaVersion", "kind", "conversationId", "revision", "entries"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.canonical-transcript") {
    throw new TypeError("canonical transcript has an unsupported schema");
  }
  const conversationId = boundedConversationId(
    input.conversationId,
    "canonical transcript.conversationId",
  );
  const revision = positiveSafeInteger(input.revision, "canonical transcript.revision");
  const rawEntries = denseOwnDataArray(
    input.entries,
    "canonical transcript.entries",
    TRANSCRIPT_MAX_ENTRIES,
  );
  const entries = rawEntries.map((entry, index) =>
    parseTranscriptEntry(
      entry,
      conversationId,
      `canonical transcript.entries.${String(index)}`,
    ));
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.canonical-transcript",
    conversationId,
    revision,
    entries: Object.freeze(entries),
  });
}

export function encodeCanonicalTranscript(value: CanonicalTranscript): Uint8Array {
  const transcript = parseCanonicalTranscript(value);
  const encoded = Buffer.from(JSON.stringify(transcript), "utf8");
  if (encoded.byteLength > TRANSCRIPT_MAX_BYTES) {
    throw new RangeError(`canonical transcript exceeds ${String(TRANSCRIPT_MAX_BYTES)} bytes`);
  }
  return new Uint8Array(encoded);
}

export function decodeCanonicalTranscript(
  value: Uint8Array,
  expectedConversationId?: string,
): CanonicalTranscript {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("canonical transcript must be encoded as bytes");
  }
  if (value.byteLength > TRANSCRIPT_MAX_BYTES) {
    throw new RangeError(`canonical transcript exceeds ${String(TRANSCRIPT_MAX_BYTES)} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as unknown;
  } catch (error) {
    throw new TypeError("canonical transcript is not valid UTF-8 JSON", { cause: error });
  }
  const transcript = parseCanonicalTranscript(decoded);
  if (
    expectedConversationId !== undefined
    && transcript.conversationId !== expectedConversationId
  ) {
    throw new TypeError("canonical transcript conversation identity does not match");
  }
  return transcript;
}

export function appendCanonicalTranscript(
  current: CanonicalTranscript | undefined,
  conversationId: string,
  entries: readonly CanonicalTranscriptEntry[],
): CanonicalTranscript {
  const normalizedConversationId = boundedConversationId(
    conversationId,
    "conversationId",
  );
  const existing = current === undefined
    ? undefined
    : parseCanonicalTranscript(current);
  if (
    existing !== undefined
    && existing.conversationId !== normalizedConversationId
  ) {
    throw new TypeError("canonical transcript conversation identity does not match");
  }
  const candidate = {
    schemaVersion: 1,
    kind: "mono-agent.canonical-transcript",
    conversationId: normalizedConversationId,
    revision: (existing?.revision ?? 0) + 1,
    entries: [...(existing?.entries ?? []), ...entries],
  } as const;
  const parsed = parseCanonicalTranscript(candidate);
  if (existing !== undefined) {
    assertCanonicalTranscriptAppendOnly(existing, parsed);
  }
  // Enforce the durable artifact boundary before any state transaction is attempted.
  encodeCanonicalTranscript(parsed);
  return parsed;
}

/**
 * Prove that a candidate revision extends one exact canonical history.
 *
 * Revision numbers alone are insufficient authority: without the prefix check,
 * a caller could publish a numerically newer transcript that truncates or
 * rewrites already-settled conversation history.
 */
export function assertCanonicalTranscriptAppendOnly(
  previousValue: CanonicalTranscript,
  nextValue: CanonicalTranscript,
): void {
  const previous = parseCanonicalTranscript(previousValue);
  const next = parseCanonicalTranscript(nextValue);
  if (previous.conversationId !== next.conversationId) {
    throw new TypeError("canonical transcript conversation identity does not match");
  }
  if (
    previous.revision >= Number.MAX_SAFE_INTEGER
    || next.revision !== previous.revision + 1
  ) {
    throw new Error("canonical transcript revision is not the next canonical revision");
  }
  if (next.entries.length < previous.entries.length) {
    throw new Error("canonical transcript revision cannot truncate prior history");
  }
  for (let index = 0; index < previous.entries.length; index += 1) {
    if (
      JSON.stringify(previous.entries[index])
      !== JSON.stringify(next.entries[index])
    ) {
      throw new Error("canonical transcript revision cannot rewrite prior history");
    }
  }
}

function parseTranscriptEntry(
  value: unknown,
  conversationId: string,
  path: string,
): CanonicalTranscriptEntry {
  const base = ownDataRecord(
    value,
    path,
    valueKind(value) === "message"
      ? [
          "kind",
          "entryId",
          "runId",
          "requestId",
          "conversationId",
          "recordedAt",
          "role",
          "content",
          "route",
        ]
      : valueKind(value) === "interaction"
        ? [
            "kind",
            "entryId",
            "runId",
            "requestId",
            "conversationId",
            "recordedAt",
            "evidence",
            "content",
          ]
        : [
            "kind",
            "entryId",
            "runId",
            "requestId",
            "conversationId",
            "recordedAt",
            "role",
            "text",
          ],
  );
  if (
    base.kind !== "message"
    && base.kind !== "interaction"
    && base.kind !== "verbatim"
  ) {
    throw new TypeError(`${path}.kind is invalid`);
  }
  const entryConversationId = boundedConversationId(
    base.conversationId,
    `${path}.conversationId`,
  );
  if (entryConversationId !== conversationId) {
    throw new TypeError(`${path}.conversationId does not match its transcript`);
  }
  const common = {
    entryId: boundedIdentifier(base.entryId, `${path}.entryId`),
    runId: boundedIdentifier(base.runId, `${path}.runId`),
    requestId: boundedIdentifier(base.requestId, `${path}.requestId`),
    conversationId: entryConversationId,
    recordedAt: canonicalTimestamp(base.recordedAt, `${path}.recordedAt`),
  };
  if (base.kind === "message") {
    if (base.role !== "user" && base.role !== "assistant") {
      throw new TypeError(`${path}.role is invalid`);
    }
    const route = base.route === undefined ? undefined : parseRouteIdentity(base.route);
    if (base.role === "user" && route !== undefined) {
      throw new TypeError(`${path} user messages cannot claim a runtime route`);
    }
    return Object.freeze({
      kind: "message",
      ...common,
      role: base.role,
      content: parseContent(base.content, `${path}.content`),
      ...(route === undefined ? {} : { route }),
    });
  }
  if (base.kind === "interaction") {
    return Object.freeze({
      kind: "interaction",
      ...common,
      evidence: parseInteractionEvidence(base.evidence, `${path}.evidence`),
      content: parseContent(base.content, `${path}.content`),
    });
  }
  return Object.freeze({
    kind: "verbatim",
    ...common,
    role: stringEnum(base.role, ["user", "assistant"] as const, `${path}.role`),
    text: boundedText(base.text, `${path}.text`, TRANSCRIPT_MAX_TEXT_BYTES, true),
  });
}

function parseContent(
  value: unknown,
  path: string,
): readonly CanonicalTranscriptContentPart[] {
  const raw = denseOwnDataArray(value, path, TRANSCRIPT_MAX_CONTENT_PARTS);
  const parsed = raw.map((part, index): CanonicalTranscriptContentPart => {
    const partPath = `${path}.${String(index)}`;
    const kind = valueKind(part);
    const input = ownDataRecord(
      part,
      partPath,
      kind === "text" ? ["type", "text"] : ["type", "ref", "name"],
    );
    if (input.type === "text") {
      return Object.freeze({
        type: "text",
        text: boundedText(input.text, `${partPath}.text`, TRANSCRIPT_MAX_TEXT_BYTES, true),
      });
    }
    if (input.type === "artifact") {
      const name = input.name === undefined
        ? undefined
        : boundedText(input.name, `${partPath}.name`, 255, false);
      return Object.freeze({
        type: "artifact",
        ref: parseArtifactRef(input.ref),
        ...(name === undefined ? {} : { name }),
      });
    }
    throw new TypeError(`${partPath}.type is invalid`);
  });
  return Object.freeze(parsed);
}

export function parseInteractionEvidence(
  value: unknown,
  path: string,
): AgentInteractionEvidence {
  const kind = valueKind(value);
  const input = ownDataRecord(
    value,
    path,
    kind === "ask-user"
      ? [
          "kind",
          "interactionId",
          "phase",
          "requestedAt",
          "settledAt",
          "questionCount",
          "answeredQuestionCount",
        ]
      : kind === "approval"
        ? [
            "kind",
            "interactionId",
            "phase",
            "requestedAt",
            "settledAt",
            "toolId",
            "effects",
            "decision",
          ]
        : [
            "kind",
            "interactionId",
            "phase",
            "receivedAt",
            "settledAt",
          ],
  );
  const interactionId = boundedIdentifier(input.interactionId, `${path}.interactionId`);
  if (input.kind === "ask-user") {
    const phase = stringEnum(
      input.phase,
      ["requested", "answered", "expired", "cancelled"] as const,
      `${path}.phase`,
    );
    const settledAt = optionalSettledTimestamp(input.settledAt, phase, `${path}.settledAt`);
    const questionCount = boundedCount(input.questionCount, `${path}.questionCount`, 3);
    const answeredQuestionCount = input.answeredQuestionCount === undefined
      ? undefined
      : boundedCount(
        input.answeredQuestionCount,
        `${path}.answeredQuestionCount`,
        questionCount,
        true,
      );
    if (
      (phase === "answered") !== (answeredQuestionCount !== undefined)
    ) {
      throw new TypeError(`${path}.answeredQuestionCount must be present only for answered evidence`);
    }
    return Object.freeze({
      kind: "ask-user",
      interactionId,
      phase,
      requestedAt: canonicalTimestamp(input.requestedAt, `${path}.requestedAt`),
      ...(settledAt === undefined ? {} : { settledAt }),
      questionCount,
      ...(answeredQuestionCount === undefined ? {} : { answeredQuestionCount }),
    });
  }
  if (input.kind === "approval") {
    const phase = stringEnum(
      input.phase,
      ["requested", "answered", "expired", "cancelled"] as const,
      `${path}.phase`,
    );
    const settledAt = optionalSettledTimestamp(input.settledAt, phase, `${path}.settledAt`);
    const rawEffects = denseOwnDataArray(input.effects, `${path}.effects`, 4);
    const seenEffects = new Set<string>();
    const effects = rawEffects.map((effect, index) => {
      const parsed = stringEnum(
        effect,
        ["read", "write", "execute", "network"] as const,
        `${path}.effects.${String(index)}`,
      );
      if (seenEffects.has(parsed)) throw new TypeError(`${path}.effects contains a duplicate`);
      seenEffects.add(parsed);
      return parsed;
    });
    const decision = input.decision === undefined
      ? undefined
      : stringEnum(
        input.decision,
        ["allow_once", "deny"] as const,
        `${path}.decision`,
      );
    if ((phase === "answered") !== (decision !== undefined)) {
      throw new TypeError(`${path}.decision must be present only for answered evidence`);
    }
    return Object.freeze({
      kind: "approval",
      interactionId,
      phase,
      requestedAt: canonicalTimestamp(input.requestedAt, `${path}.requestedAt`),
      ...(settledAt === undefined ? {} : { settledAt }),
      toolId: boundedIdentifier(input.toolId, `${path}.toolId`),
      effects: Object.freeze(effects),
      ...(decision === undefined ? {} : { decision }),
    });
  }
  if (input.kind === "live-input") {
    return Object.freeze({
      kind: "live-input",
      interactionId,
      phase: stringEnum(
        input.phase,
        ["applied", "requeued", "discarded"] as const,
        `${path}.phase`,
      ),
      receivedAt: canonicalTimestamp(input.receivedAt, `${path}.receivedAt`),
      settledAt: canonicalTimestamp(input.settledAt, `${path}.settledAt`),
    });
  }
  throw new TypeError(`${path}.kind is invalid`);
}

function optionalSettledTimestamp(
  value: unknown,
  phase: "requested" | "answered" | "expired" | "cancelled",
  path: string,
): string | undefined {
  if (phase === "requested") {
    if (value !== undefined) throw new TypeError(`${path} is not valid for requested evidence`);
    return undefined;
  }
  if (value === undefined) throw new TypeError(`${path} is required for settled evidence`);
  return canonicalTimestamp(value, path);
}

function boundedCount(
  value: unknown,
  path: string,
  maximum: number,
  allowZero = false,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < (allowZero ? 0 : 1)
    || (value as number) > maximum
  ) {
    throw new TypeError(`${path} is outside its bound`);
  }
  return value as number;
}

function valueKind(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind")
    ?? Object.getOwnPropertyDescriptor(value, "type");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function boundedIdentifier(value: unknown, path: string): string {
  return boundedText(value, path, TRANSCRIPT_MAX_IDENTIFIER_BYTES, false);
}

function boundedConversationId(value: unknown, path: string): string {
  return boundedText(
    value,
    path,
    TRANSCRIPT_MAX_CONVERSATION_ID_BYTES,
    false,
  );
}

function boundedText(
  value: unknown,
  path: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${path} must be a bounded ${allowEmpty ? "" : "non-empty "}string`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length !== 24) {
    throw new TypeError(`${path} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${path} must be a canonical timestamp`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function stringEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value as T[number];
}

function ownDataRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseOwnDataArray(
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (!Number.isSafeInteger(value.length) || value.length > maximum) {
    throw new RangeError(`${path} exceeds its item limit`);
  }
  const allowed = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains an unknown array field`);
    }
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${String(index)} must be an own data property`);
    }
    output.push(descriptor.value);
  }
  return output;
}
