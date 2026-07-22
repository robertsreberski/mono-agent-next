import { createHmac } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type {
  ContinuationOriginContextReference,
  DurableContinuationRecord,
} from "./continuation-store.js";
import { ContinuationProtocolError } from "./continuation-service-errors.js";
import {
  MAX_OPERATOR_PAGE_SIZE,
  MAX_TASK_KEY_CHARS,
  type ResolvedOriginContext,
} from "./continuation-service-types.js";
import {
  DEFAULT_CONTINUATION_LIMITS,
  canonicalContinuationJson,
  continuationTokenMatches,
  type ContinuationLimits,
  type ContinuationStatusSnapshot,
  type ContinuationSynthesisInput,
  type NamedContinuationRoute,
} from "./continuations.js";

export function continuationOperatorToken(secret: Uint8Array): string {
  return createHmac("sha256", secret).update("mono-agent-continuation-operator-v1").digest("base64url");
}

export interface ParsedClaim {
  readonly taskKey: string;
  readonly taskHash: string;
  readonly deadline: string;
}

export function parseClaim(body: unknown, now: Date, maxDeadlineMs: number): ParsedClaim {
  const object = asObject(body);
  const taskKey = requiredStringField(object, "taskKey", MAX_TASK_KEY_CHARS);
  const taskHash = requiredStringField(object, "taskHash", 256);
  const deadline = requiredStringField(object, "deadline", 64);
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now.getTime()) {
    throw new ContinuationProtocolError(400, "invalid_deadline", "Claim deadline must be a future ISO timestamp.");
  }
  if (deadlineMs - now.getTime() > maxDeadlineMs) {
    throw new ContinuationProtocolError(400, "deadline_too_far", "Claim deadline exceeds the configured maximum.");
  }
  return { taskKey, taskHash, deadline: new Date(deadlineMs).toISOString() };
}

export function statusOf(record: DurableContinuationRecord | undefined): ContinuationStatusSnapshot | undefined {
  return record === undefined ? undefined : statusOfRequired(record);
}

export function statusOfRequired(record: DurableContinuationRecord): ContinuationStatusSnapshot {
  return {
    continuationId: record.continuationId,
    state: record.state,
    mode: record.mode,
    taskKey: record.taskKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadline: record.deadline,
    attempts: { synthesis: record.synthesisAttempts, delivery: record.deliveryAttempts },
    synthesisDeferrals: record.synthesisDeferrals,
    originContext: {
      state: record.originContextState,
      ...(record.originContextDigest === undefined ? {} : { digest: record.originContextDigest }),
      ...(record.originContextMessageCount === undefined ? {} : { messageCount: record.originContextMessageCount }),
    },
    ...(record.completionKind === undefined ? {} : { completionKind: record.completionKind }),
    ...(record.nextAttemptAt === undefined ? {} : { nextAttemptAt: record.nextAttemptAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
  };
}

export function requireRecord(
  records: Map<string, DurableContinuationRecord>,
  id: string,
): DurableContinuationRecord {
  const record = records.get(id);
  if (record === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
  return record;
}

export function synthesisInput(
  record: DurableContinuationRecord,
  originContext: Extract<ResolvedOriginContext, { readonly kind: "ready" }>,
): ContinuationSynthesisInput {
  const common = {
    continuationId: record.continuationId,
    originConversationId: record.originConversationId,
    originRunId: record.originRunId,
    ...(record.replyToConversationId === undefined ? {} : { replyToConversationId: record.replyToConversationId }),
    mode: record.mode,
    payload: record.resultPayload,
  };
  if (originContext.policy === "detached_latest") {
    return { ...common, originContextPolicy: "detached_latest" };
  }
  if (record.historyBoundary === undefined) {
    throw new Error(`Pinned continuation ${record.continuationId} is missing its history boundary.`);
  }
  return {
    ...common,
    historyBoundary: record.historyBoundary,
    originContextPolicy: "pinned",
    originContext: originContext.snapshot,
  };
}

export function originContextBindingMac(
  secret: Uint8Array,
  record: DurableContinuationRecord,
  reference: ContinuationOriginContextReference,
): string {
  return createHmac("sha256", secret).update(canonicalContinuationJson({
    version: 2,
    continuationId: record.continuationId,
    claimFingerprint: record.claimFingerprint,
    serverName: record.serverName,
    originRunId: record.originRunId,
    originConversationId: record.originConversationId,
    replyToConversationId: record.replyToConversationId ?? null,
    historyBoundary: record.historyBoundary ?? null,
    mode: record.mode,
    routeName: record.routeName ?? null,
    taskKey: record.taskKey,
    taskHash: record.taskHash,
    resultTokenHash: record.resultTokenHash,
    createdAt: record.createdAt,
    deadline: record.deadline,
    originContextDigest: reference.digest,
    originContextBytes: reference.bytes,
    originContextMessageCount: reference.messageCount,
  })).digest("hex");
}

export function requireLease(record: DurableContinuationRecord, owner: string): void {
  if (record.leaseOwner !== owner) {
    throw new ContinuationProtocolError(409, "lease_lost", "Continuation processing lease was lost.");
  }
}

export function clearLease(record: DurableContinuationRecord): void {
  delete record.leaseOwner;
  delete record.leaseUntil;
}

export function expire(record: DurableContinuationRecord, at: string): void {
  record.state = "expired";
  record.updatedAt = at;
  record.lastError = errorRecord("deadline_expired", "Continuation deadline passed before delivery completed.", at);
  clearLease(record);
}

export function errorRecord(
  code: string,
  reason: string,
  at: string,
): NonNullable<DurableContinuationRecord["lastError"]> {
  return { code: bounded(code, 128), reason: bounded(reason, 1_000), at };
}

export function authorizeRecordToken(record: DurableContinuationRecord, token: string): void {
  if (!continuationTokenMatches(token, record.resultTokenHash)) {
    throw new ContinuationProtocolError(401, "invalid_result_capability", "Invalid continuation result capability.");
  }
}

export function validateNamedRoutes(routes: Readonly<Record<string, NamedContinuationRoute>>): void {
  for (const [name, route] of Object.entries(routes)) {
    if (name.trim().length === 0 || name.length > 128) throw new Error("Continuation route names must be 1-128 characters.");
    if ((route.mode === "notify_if_actionable" || route.mode === "capture") && !route.conversationId?.trim()) {
      throw new Error(`Continuation route ${name} requires conversationId.`);
    }
    if (route.mode === "silent" && route.conversationId !== undefined) {
      throw new Error(`Continuation route ${name} cannot set conversationId for mode ${route.mode}.`);
    }
  }
}

export function resolveContinuationLimits(input: Partial<ContinuationLimits> | undefined): ContinuationLimits {
  const maxActiveRecords = input?.maxActiveRecords ?? DEFAULT_CONTINUATION_LIMITS.maxActiveRecords;
  const limits: ContinuationLimits = {
    ...DEFAULT_CONTINUATION_LIMITS,
    ...input,
    maxActiveRecords,
    maxActivePerOrigin: input?.maxActivePerOrigin
      ?? Math.min(DEFAULT_CONTINUATION_LIMITS.maxActivePerOrigin, maxActiveRecords),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Continuation limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxActiveRecords > 1_000_000) throw new Error("Continuation maxActiveRecords cannot exceed 1000000.");
  if (limits.maxActivePerOrigin > limits.maxActiveRecords) {
    throw new Error("Continuation maxActivePerOrigin cannot exceed maxActiveRecords.");
  }
  if (limits.maxConcurrent > 256) throw new Error("Continuation maxConcurrent cannot exceed 256.");
  if (limits.synthesisTimeoutMs > 24 * 60 * 60 * 1_000 || limits.deliveryTimeoutMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Continuation operation timeouts cannot exceed 24 hours.");
  }
  if (limits.operatorPageSize > MAX_OPERATOR_PAGE_SIZE) {
    throw new Error(`Continuation operatorPageSize cannot exceed ${String(MAX_OPERATOR_PAGE_SIZE)}.`);
  }
  return limits;
}

export function operatorContinuationPage(
  records: readonly DurableContinuationRecord[],
  url: URL,
  configuredPageSize: number,
): Record<string, unknown> {
  const rawLimit = url.searchParams.get("limit");
  let limit = configuredPageSize;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
      throw new ContinuationProtocolError(400, "invalid_page_limit", "Operator list limit must be a positive integer.");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > configuredPageSize || limit > MAX_OPERATOR_PAGE_SIZE) {
      throw new ContinuationProtocolError(
        400,
        "invalid_page_limit",
        `Operator list limit cannot exceed ${String(Math.min(configuredPageSize, MAX_OPERATOR_PAGE_SIZE))}.`,
      );
    }
  }
  const cursor = parseOperatorCursor(url.searchParams.get("cursor"));
  const ordered = [...records].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.continuationId.localeCompare(left.continuationId));
  const eligible = cursor === undefined
    ? ordered
    : ordered.filter((record) =>
      record.createdAt < cursor.createdAt
      || (record.createdAt === cursor.createdAt && record.continuationId < cursor.continuationId));
  const selected = eligible.slice(0, limit);
  const last = selected.at(-1);
  return {
    continuations: selected.map(statusOfRequired),
    pageSize: limit,
    ...(eligible.length <= limit || last === undefined ? {} : { nextCursor: encodeOperatorCursor(last) }),
  };
}

function encodeOperatorCursor(record: DurableContinuationRecord): string {
  return Buffer.from(JSON.stringify([record.createdAt, record.continuationId]), "utf8").toString("base64url");
}

function parseOperatorCursor(value: string | null): {
  readonly createdAt: string;
  readonly continuationId: string;
} | undefined {
  if (value === null) return undefined;
  try {
    if (value.length === 0 || value.length > 512) throw new Error("invalid");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== "string"
      || !Number.isFinite(Date.parse(decoded[0]))
      || typeof decoded[1] !== "string"
      || decoded[1].length === 0
      || decoded[1].length > 128) {
      throw new Error("invalid");
    }
    return { createdAt: decoded[0], continuationId: decoded[1] };
  } catch {
    throw new ContinuationProtocolError(400, "invalid_page_cursor", "Operator list cursor is invalid.");
  }
}

export async function closeContinuationServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    let forced: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (forced !== undefined) clearTimeout(forced);
      if (error === undefined) resolveClose();
      else reject(error);
    };
    server.close((error) => finish(error));
    server.closeIdleConnections?.();
    forced = setTimeout(() => { server.closeAllConnections?.(); }, 5_000);
  });
}

export function requireBearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new ContinuationProtocolError(401, "missing_capability", "Bearer capability is required.");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length === 0 || token.length > 512) {
    throw new ContinuationProtocolError(401, "invalid_capability", "Bearer capability is invalid.");
  }
  return token;
}

export function requireHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new ContinuationProtocolError(400, "missing_service_name", "Detached service name header is required.");
  }
  return value;
}

export async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new ContinuationProtocolError(413, "payload_too_large", "Request body exceeds the configured limit.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ContinuationProtocolError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContinuationProtocolError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function requiredStringField(object: Record<string, unknown>, key: string, max = 512): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ContinuationProtocolError(400, `invalid_${key}`, `${key} must be a non-empty string up to ${String(max)} characters.`);
  }
  return value;
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(encoded));
  response.end(encoded);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function backoffMs(attempt: number, base: number, cap: number): number {
  const exponential = Math.min(cap, base * (2 ** Math.max(0, attempt - 1)));
  const deterministicJitter = 0.75 + ((attempt * 1103515245 + 12345) % 500) / 1_000;
  return Math.max(base, Math.floor(exponential * deterministicJitter));
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function safeReason(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1_000);
}

export function boundedHistoryErrorCode(value: string): string {
  const normalized = value.trim().slice(0, 128);
  return normalized.length === 0 ? "history_record_failed" : normalized;
}
