import { parseArtifactRef, parseRouteIdentity, type ArtifactRef, type JsonObject, type RouteIdentity, type RuntimeSession } from "@mono-agent/module-sdk";
import type { StateExecution } from "@mono-agent/module-sdk/internal";

import { assertOwnKeys, snapshotBoundedValue } from "./bounded-value.js";
import type { AgentInteractionEvidence, AgentRunAttemptEvidence, AgentRunHistoryPage, AgentRunRecord, AgentRunStatus, AgentRunSummary, AgentTranscriptEntry } from "./types.js";

export type DurableFingerprint = `sha256:${string}`;
export interface CanonicalTranscript {
  readonly schemaVersion: 1; readonly kind: "mono-agent.canonical-transcript";
  readonly conversationId: string; readonly revision: number;
  readonly entries: readonly AgentTranscriptEntry[];
}
export interface ConversationView {
  readonly conversationId: string; readonly createdAt: string; readonly updatedAt: string;
  readonly transcript: CanonicalTranscript; readonly title?: string; readonly metadata?: JsonObject;
}
export interface ConversationPage {
  readonly conversations: readonly Omit<ConversationView, "transcript">[]; readonly nextCursor?: string;
}

type Signalled<T> = T & { readonly signal: AbortSignal };
type AdmissionInput = Signalled<{ readonly requestId: string; readonly conversationId: string; readonly fingerprint: DurableFingerprint; readonly runId?: string }>;
type SettlementInput = Signalled<{ readonly runId: string; readonly requestId: string; readonly status: Exclude<AgentRunStatus, "running">; readonly transcript?: CanonicalTranscript; readonly responseBytes?: Uint8Array; readonly session?: { readonly value: RuntimeSession; readonly updatedAt: string }; readonly sessionEviction?: RouteIdentity; readonly failureCode?: string }>;
type StagingInput = Signalled<{ readonly runId: string; readonly requestId: string; readonly artifacts: readonly { readonly slot: string; readonly data: Uint8Array; readonly mediaType: string; readonly fileName?: string }[] }>;
type DeliveryInput = Signalled<{ readonly idempotencyKey: string; readonly fingerprint: DurableFingerprint; readonly channelInstanceId: string; readonly runId?: string }>;
type DeliverySettlement = Signalled<{ readonly idempotencyKey: string; readonly fingerprint: DurableFingerprint; readonly attempt: number; readonly token: string; readonly status: "delivered" | "failed" | "unknown"; readonly messageId?: string; readonly code?: string }>;
type DeliveryWithHistoryInput = Signalled<{ readonly idempotencyKey: string; readonly fingerprint: DurableFingerprint; readonly attempt: number; readonly token: string; readonly messageId?: string; readonly conversationId: string; readonly entry:
  | Omit<Extract<AgentTranscriptEntry, { readonly kind: "message" }>, "recordedAt">
  | Omit<Extract<AgentTranscriptEntry, { readonly kind: "verbatim" }>, "recordedAt">;
readonly entryFingerprint: DurableFingerprint }>;
type Admission = { readonly status: "accepted"; readonly summary: AgentRunSummary }
  | { readonly status: "join" | "conflict" | "uncertain"; readonly runId: string }
  | { readonly status: "cached"; readonly summary: AgentRunSummary; readonly responseRef?: ArtifactRef };
type Delivery = { readonly status: "send"; readonly attempt: number; readonly token: string }
  | { readonly status: "join" } | { readonly status: "conflict" }
  | { readonly status: "duplicate"; readonly messageId?: string }
  | { readonly status: "unknown"; readonly code?: string };
type DeliveryWithHistory =
  | { readonly status: "conflict"; readonly conversationId: string; readonly entryId: string }
  | { readonly status: "appended" | "duplicate"; readonly conversationId: string; readonly entryId: string;
      readonly revision: number; readonly entryCount: number; readonly messageId?: string };
const REQUIRED_OPERATIONS = [
  "transcript.append", "conversation.open", "conversation.load", "conversation.list",
  "run.admit", "run.record-attempt", "run.record-interaction", "run.stage-artifacts",
  "run.settle", "run.read-cached-response", "run.read", "run.list",
  "session.load", "session.evict", "delivery.prepare", "delivery.settle",
  "delivery.settle-with-history",
] as const;
const OUTPUT_MAX_BYTES = 96 * 1024 * 1024;
const OUTPUT_MAX_ITEMS = 250_000;
const OUTPUT_MAX_DEPTH = 64;

/** Typed, fail-closed Core facade over the state module's opaque protocol. */
export class StateExecutionClient {
  constructor(private readonly execution: StateExecution) {}

  async assertCompatible(signal: AbortSignal): Promise<void> {
    const value = object(await this.call("protocol.describe", undefined, signal), "protocol");
    keys(value, ["protocol", "version", "operations"], "protocol");
    if (value.protocol !== "mono-agent.state-execution" || value.version !== 1
      || !Array.isArray(value.operations)) malformed("protocol");
    const operations = new Set(value.operations);
    if (operations.size !== value.operations.length
      || value.operations.some((operation) => typeof operation !== "string")
      || REQUIRED_OPERATIONS.some((operation) => !operations.has(operation))) {
      malformed("protocol");
    }
  }

  async appendTranscript(current: CanonicalTranscript | undefined, conversationId: string, entries: readonly AgentTranscriptEntry[], signal: AbortSignal): Promise<CanonicalTranscript> { return transcript(await this.call("transcript.append", { current, conversationId, entries }, signal)); }
  async openConversation(input: { readonly title?: string; readonly initialText?: string; readonly metadata?: JsonObject }, signal: AbortSignal): Promise<ConversationView> { return conversation(await this.call("conversation.open", input, signal), false)!; }
  async loadConversation(id: string, signal: AbortSignal): Promise<ConversationView | undefined> { return conversation(await this.call("conversation.load", { conversationId: id }, signal), true, id); }
  async listConversations(cursor: string | undefined, signal: AbortSignal): Promise<ConversationPage> { return conversationPage(await this.call("conversation.list", { cursor }, signal)); }
  async admit(input: AdmissionInput): Promise<Admission> {
    const { signal, ...payload } = input;
    return admission(await this.call("run.admit", payload, signal));
  }
  async settle(input: SettlementInput): Promise<AgentRunSummary> {
    const { signal, ...payload } = input;
    return runSummary(await this.call("run.settle", payload, signal));
  }
  async recordAttempt(runId: string, attempt: AgentRunAttemptEvidence, signal: AbortSignal): Promise<AgentRunSummary> { return runSummary(await this.call("run.record-attempt", { runId, attempt }, signal)); }
  async recordInteraction(runId: string, evidence: AgentInteractionEvidence, signal: AbortSignal): Promise<AgentRunSummary> { return runSummary(await this.call("run.record-interaction", { runId, evidence }, signal)); }
  async stageRunArtifacts(input: StagingInput): Promise<readonly { readonly slot: string; readonly ref: ArtifactRef }[]> {
    const { signal, ...payload } = input;
    return staged(await this.call("run.stage-artifacts", payload, signal));
  }
  async readCachedResponse(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array> {
    const value = await this.call("run.read-cached-response", { ref }, signal);
    if (!(value instanceof Uint8Array)) malformed("cached response");
    return new Uint8Array(value);
  }
  async readRun(runId: string, signal: AbortSignal): Promise<AgentRunRecord | undefined> {
    const value = await this.call("run.read", { runId }, signal);
    return value === undefined ? undefined : runRecord(value);
  }
  async listRuns(cursor: string | undefined, signal: AbortSignal): Promise<AgentRunHistoryPage> { return runPage(await this.call("run.list", { cursor }, signal)); }
  async loadSession(conversationId: string, route: RouteIdentity, signal: AbortSignal): Promise<{ readonly value: RuntimeSession; readonly updatedAt: string } | undefined> {
    const value = await this.call("session.load", { conversationId, route }, signal);
    return value === undefined ? undefined : session(value);
  }
  async evictSession(conversationId: string, route: RouteIdentity, expected: { readonly sessionId: string; readonly updatedAt: string }, signal: AbortSignal): Promise<boolean> {
    const value = await this.call("session.evict", { conversationId, route, expected }, signal);
    if (typeof value !== "boolean") malformed("session eviction");
    return value;
  }
  async prepareDelivery(input: DeliveryInput): Promise<Delivery> {
    const { signal, ...payload } = input;
    return delivery(await this.call("delivery.prepare", payload, signal));
  }
  async settleDelivery(input: DeliverySettlement): Promise<Delivery> {
    const { signal, ...payload } = input;
    return delivery(await this.call("delivery.settle", payload, signal));
  }
  async settleDeliveryWithHistory(input: DeliveryWithHistoryInput): Promise<DeliveryWithHistory> {
    const { signal, ...payload } = input;
    return deliveryWithHistory(await this.call("delivery.settle-with-history", payload, signal));
  }

  private async call(operation: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const value = await this.execution.perform({ operation, input, signal });
    if (value === undefined) return undefined;
    try {
      return snapshotBoundedValue(value, {
        path: `state execution ${operation}`,
        maxBytes: OUTPUT_MAX_BYTES,
        maxItems: OUTPUT_MAX_ITEMS,
        maxDepth: OUTPUT_MAX_DEPTH,
        label: "state execution output",
        cloneBytes: true,
        requireOrdinaryArrays: true,
      }).value;
    } catch {
      return malformed(operation);
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed(label);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)) malformed(label);
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  try { assertOwnKeys(value, allowed, label); } catch { malformed(label); }
}
function text(value: unknown, label: string, maxBytes = 1_000_000, allowEmpty = false): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) malformed(label);
  return value;
}
function textFields(value: Record<string, unknown>, fields: readonly string[], label: string): void { for (const field of fields) text(value[field], `${label} ${field}`, 512); }
function array(value: unknown, label: string, maxItems: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maxItems) malformed(label); return value; }
function integer(value: unknown, label: string, minimum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) malformed(label); return value as number; }
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T { if (typeof value !== "string" || !choices.includes(value as T)) malformed(label); return value as T; }
function routeIdentity(value: unknown, label: string): RouteIdentity { try { return parseRouteIdentity(value); } catch { return malformed(label); } }
function artifactRef(value: unknown, label: string): ArtifactRef { try { return parseArtifactRef(value); } catch { return malformed(label); } }
function jsonObject(value: unknown, label: string): JsonObject {
  const out = object(value, label);
  for (const [key, child] of Object.entries(out)) jsonValue(child, `${label}.${key}`);
  return out as JsonObject;
}
function jsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const [index, child] of value.entries()) jsonValue(child, `${label}[${String(index)}]`); return; }
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) { jsonObject(value, label); return; }
  malformed(label);
}

function runAttempt(value: unknown): void {
  const attempt = object(value, "run attempt");
  keys(attempt, ["attempt", "route", "status", "startedAt", "endedAt", "code", "retryability", "sideEffects"], "run attempt");
  integer(attempt.attempt, "run attempt number", 1);
  routeIdentity(attempt.route, "run attempt route");
  oneOf(attempt.status, ["started", "ineligible", "failed", "completed"], "run attempt status");
  text(attempt.startedAt, "run attempt startedAt", 512);
  if (attempt.endedAt !== undefined) text(attempt.endedAt, "run attempt endedAt", 512);
  if (attempt.code !== undefined) text(attempt.code, "run attempt code", 512);
  if (attempt.retryability !== undefined) oneOf(attempt.retryability, ["retryable", "not-retryable", "unknown"], "run attempt retryability");
  if (attempt.sideEffects !== undefined) oneOf(attempt.sideEffects, ["none", "committed", "unknown"], "run attempt sideEffects");
}
function transcriptEntry(value: unknown): void {
  const entry = object(value, "transcript entry");
  const common = ["kind", "entryId", "runId", "requestId", "conversationId", "recordedAt"];
  if (entry.kind === "message") {
    keys(entry, [...common, "role", "content", "route"], "transcript entry");
    oneOf(entry.role, ["user", "assistant"], "transcript message role");
    transcriptContent(entry.content);
    if (entry.route !== undefined) routeIdentity(entry.route, "transcript message route");
  } else if (entry.kind === "interaction") {
    keys(entry, [...common, "evidence", "content"], "transcript entry");
    interactionEvidence(entry.evidence);
    transcriptContent(entry.content);
  } else if (entry.kind === "verbatim") {
    keys(entry, [...common, "role", "text"], "transcript entry");
    oneOf(entry.role, ["user", "assistant"], "verbatim role");
    text(entry.text, "verbatim text", 1_000_000, true);
  } else malformed("transcript entry");
  textFields(entry, ["entryId", "runId", "requestId", "recordedAt"], "transcript entry"); text(entry.conversationId, "transcript entry conversationId", 4_096);
}
function transcriptContent(value: unknown): void {
  for (const partValue of array(value, "transcript entry content", 100_000)) {
    const part = object(partValue, "transcript content part");
    if (part.type === "text") {
      keys(part, ["type", "text"], "transcript content part");
      text(part.text, "transcript text", 1_000_000, true);
    } else if (part.type === "artifact") {
      keys(part, ["type", "ref", "name"], "transcript content part");
      artifactRef(part.ref, "transcript artifact ref");
      if (part.name !== undefined) text(part.name, "transcript artifact name", 512);
    } else malformed("transcript content part");
  }
}
function interactionEvidence(value: unknown): void {
  const evidence = object(value, "interaction evidence");
  if (evidence.kind === "ask-user") {
    keys(evidence, ["kind", "interactionId", "phase", "requestedAt", "settledAt", "questionCount", "answeredQuestionCount"], "interaction evidence");
    oneOf(evidence.phase, ["requested", "answered", "expired", "cancelled"], "ask-user phase");
    integer(evidence.questionCount, "ask-user questionCount", 0);
    if (evidence.answeredQuestionCount !== undefined) integer(evidence.answeredQuestionCount, "ask-user answeredQuestionCount", 0);
  } else if (evidence.kind === "approval") {
    keys(evidence, ["kind", "interactionId", "phase", "requestedAt", "settledAt", "toolId", "effects", "decision"], "interaction evidence");
    oneOf(evidence.phase, ["requested", "answered", "expired", "cancelled"], "approval phase");
    text(evidence.toolId, "approval toolId", 512);
    for (const effect of array(evidence.effects, "approval effects", 4)) oneOf(effect, ["read", "write", "execute", "network"], "approval effect");
    if (evidence.decision !== undefined) oneOf(evidence.decision, ["allow_once", "deny"], "approval decision");
  } else if (evidence.kind === "live-input") {
    keys(evidence, ["kind", "interactionId", "phase", "receivedAt", "settledAt"], "interaction evidence");
    oneOf(evidence.phase, ["applied", "requeued", "discarded"], "live-input phase");
  } else malformed("interaction evidence");
  text(evidence.interactionId, "interaction id", 512);
  if (evidence.kind === "live-input") textFields(evidence, ["receivedAt", "settledAt"], "live-input");
  else {
    text(evidence.requestedAt, `${evidence.kind} requestedAt`, 512);
    if (evidence.settledAt !== undefined) text(evidence.settledAt, `${evidence.kind} settledAt`, 512);
  }
}
function transcript(value: unknown): CanonicalTranscript {
  const out = object(value, "transcript");
  keys(out, ["schemaVersion", "kind", "conversationId", "revision", "entries"], "transcript");
  if (out.schemaVersion !== 1 || out.kind !== "mono-agent.canonical-transcript") malformed("transcript");
  text(out.conversationId, "transcript conversationId", 4_096);
  integer(out.revision, "transcript revision", 1);
  for (const entry of array(out.entries, "transcript entries", 100_000)) transcriptEntry(entry);
  return value as CanonicalTranscript;
}
function conversation(value: unknown, optional: boolean, expectedId?: string): ConversationView | undefined {
  if (value === undefined && optional) return undefined;
  const out = object(value, "conversation");
  keys(out, ["conversationId", "createdAt", "updatedAt", "transcript", "title", "metadata"], "conversation");
  textFields(out, ["createdAt", "updatedAt"], "conversation"); text(out.conversationId, "conversation conversationId", 4_096);
  const history = transcript(out.transcript);
  if (history.conversationId !== out.conversationId
    || (expectedId !== undefined && out.conversationId !== expectedId)
    || history.entries.some((entry) => entry.conversationId !== out.conversationId))
    malformed("conversation identity");
  if (out.title !== undefined) text(out.title, "conversation title", 1_000_000);
  if (out.metadata !== undefined) jsonObject(out.metadata, "conversation metadata");
  return value as ConversationView;
}
function conversationPage(value: unknown): ConversationPage {
  const out = object(value, "conversation page");
  keys(out, ["conversations", "nextCursor"], "conversation page");
  for (const value of array(out.conversations, "conversation page conversations", 1_000)) {
    const item = object(value, "conversation summary");
    keys(item, ["conversationId", "createdAt", "updatedAt", "title", "metadata"], "conversation summary");
    textFields(item, ["createdAt", "updatedAt"], "conversation"); text(item.conversationId, "conversation conversationId", 4_096);
    if (item.title !== undefined) text(item.title, "conversation title", 1_000_000);
    if (item.metadata !== undefined) jsonObject(item.metadata, "conversation metadata");
  }
  if (out.nextCursor !== undefined) text(out.nextCursor, "conversation cursor", 16_384);
  return value as ConversationPage;
}
function runSummary(value: unknown): AgentRunSummary {
  const out = object(value, "run summary");
  keys(out, ["runId", "requestId", "conversationId", "status", "startedAt", "updatedAt", "endedAt", "attempts", "transcriptRevision", "failureCode"], "run summary");
  textFields(out, ["runId", "requestId", "startedAt", "updatedAt"], "run"); text(out.conversationId, "run conversationId", 4_096);
  oneOf(out.status, ["running", "completed", "cancelled", "max-turns", "failed", "uncertain"], "run status");
  for (const key of ["endedAt", "transcriptRevision", "failureCode"]) if (out[key] !== undefined) text(out[key], `run ${key}`, 512);
  for (const value of array(out.attempts, "run attempts", 1_000)) runAttempt(value);
  return value as unknown as AgentRunSummary;
}

function admission(value: unknown): Admission {
  const out = object(value, "run admission");
  if (out.status === "accepted" || out.status === "cached") {
    keys(out, out.status === "cached" ? ["status", "summary", "responseRef"] : ["status", "summary"], "run admission");
    runSummary(out.summary);
    if (out.status === "cached" && out.responseRef !== undefined) artifactRef(out.responseRef, "cached response ref");
  } else if (out.status === "join" || out.status === "conflict" || out.status === "uncertain") {
    keys(out, ["status", "runId"], "run admission");
    text(out.runId, "runId", 512);
  }
  else malformed("run admission");
  return value as Admission;
}
function staged(value: unknown): readonly { readonly slot: string; readonly ref: ArtifactRef }[] {
  for (const entry of array(value, "staged artifacts", 1_000)) {
    const item = object(entry, "staged artifact");
    keys(item, ["slot", "ref"], "staged artifact");
    text(item.slot, "staged artifact slot", 512);
    artifactRef(item.ref, "staged artifact ref");
  }
  return value as readonly { readonly slot: string; readonly ref: ArtifactRef }[];
}
function runPage(value: unknown): AgentRunHistoryPage {
  const out = object(value, "run page");
  keys(out, ["runs", "nextCursor"], "run page");
  for (const value of array(out.runs, "run page runs", 1_000)) runSummary(value);
  if (out.nextCursor !== undefined) text(out.nextCursor, "run cursor", 16_384);
  return value as AgentRunHistoryPage;
}
function runRecord(value: unknown): AgentRunRecord {
  const out = object(value, "run record");
  keys(out, ["summary", "events", "transcript"], "run record");
  const summary = runSummary(out.summary);
  for (const value of array(out.events, "run events", 100_000)) {
    const event = object(value, "run event");
    const common = ["type", "runId", "sequence", "recordedAt"];
    if (event.type === "admitted") keys(event, common, "run event");
    else if (event.type === "attempt") {
      keys(event, [...common, "attempt"], "run event");
      runAttempt(event.attempt);
    } else if (event.type === "interaction") {
      keys(event, [...common, "evidence"], "run event");
      interactionEvidence(event.evidence);
    } else if (event.type === "settled") {
      keys(event, [...common, "status", "transcriptRevision", "failureCode"], "run event");
      oneOf(event.status, ["completed", "cancelled", "max-turns", "failed", "uncertain"], "run settlement status");
      if (event.transcriptRevision !== undefined) text(event.transcriptRevision, "run event transcriptRevision", 512);
      if (event.failureCode !== undefined) text(event.failureCode, "run event failureCode", 512);
    } else malformed("run event");
    textFields(event, ["runId", "recordedAt"], "run event");
    integer(event.sequence, "run event sequence", 0);
  }
  for (const entry of array(out.transcript, "run transcript", 100_000)) transcriptEntry(entry);
  if (summary.conversationId.length === 0) malformed("run record");
  return value as AgentRunRecord;
}
function session(value: unknown): { readonly value: RuntimeSession; readonly updatedAt: string } {
  const out = object(value, "session");
  keys(out, ["value", "updatedAt"], "session");
  const runtime = object(out.value, "runtime session");
  keys(runtime, ["id", "conversationId", "route", "createdAt", "expiresAt", "metadata"], "runtime session");
  textFields(runtime, ["id"], "runtime session"); text(runtime.conversationId, "runtime session conversationId", 4_096);
  routeIdentity(runtime.route, "runtime session route");
  if (runtime.createdAt !== undefined) text(runtime.createdAt, "runtime session createdAt", 512);
  if (runtime.expiresAt !== undefined) text(runtime.expiresAt, "runtime session expiresAt", 512);
  if (runtime.metadata !== undefined) jsonObject(runtime.metadata, "runtime session metadata");
  text(out.updatedAt, "session updatedAt", 512);
  return value as { readonly value: RuntimeSession; readonly updatedAt: string };
}
function delivery(value: unknown): Delivery {
  const out = object(value, "delivery");
  if (out.status === "send") {
    keys(out, ["status", "attempt", "token"], "delivery");
    integer(out.attempt, "delivery attempt", 1);
    text(out.token, "delivery token", 512);
  } else if (out.status === "duplicate") {
    keys(out, ["status", "messageId"], "delivery");
    if (out.messageId !== undefined) text(out.messageId, "delivery messageId", 512);
  } else if (out.status === "unknown") {
    keys(out, ["status", "code"], "delivery");
    if (out.code !== undefined) text(out.code, "delivery code", 512);
  } else if (out.status === "join" || out.status === "conflict") keys(out, ["status"], "delivery");
  else malformed("delivery");
  return value as Delivery;
}
function deliveryWithHistory(value: unknown): DeliveryWithHistory {
  const out = object(value, "delivery with history");
  const status = oneOf(out.status, ["appended", "duplicate", "conflict"], "delivery with history status");
  keys(out, status === "conflict"
    ? ["status", "conversationId", "entryId"]
    : ["status", "conversationId", "entryId", "revision", "entryCount", "messageId"], "delivery with history");
  text(out.conversationId, "delivery with history conversationId", 4_096); textFields(out, ["entryId"], "delivery with history");
  if (status !== "conflict") { integer(out.revision, "delivery history revision", 1); integer(out.entryCount, "delivery history entryCount", 1); if (out.messageId !== undefined) text(out.messageId, "delivery history messageId", 512); }
  return value as DeliveryWithHistory;
}
function malformed(label: string): never { throw new TypeError(`state execution returned malformed ${label}`); }
