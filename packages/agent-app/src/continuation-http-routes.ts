import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DurableContinuationRecord } from "./continuation-store.js";
import { ContinuationOperatorApi } from "./continuation-operator-api.js";
import { ContinuationProtocolError } from "./continuation-service-errors.js";
import {
  asObject,
  authorizeRecordToken,
  expire,
  operatorContinuationPage,
  parseClaim,
  readJson,
  requireBearer,
  requireHeader,
  requireRecord,
  requiredStringField,
  safeReason,
  sendJson,
  statusOfRequired,
  type ParsedClaim,
} from "./continuation-service-helpers.js";
import {
  MAX_CLAIM_BODY_BYTES,
  type ClaimBinding,
} from "./continuation-service-types.js";
import {
  TERMINAL_CONTINUATION_STATES,
  canonicalContinuationJson,
  continuationDigest,
  continuationTokenMatches,
} from "./continuations.js";

export abstract class ContinuationHttpRoutes extends ContinuationOperatorApi {
  protected async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (this.stopped) {
      throw new ContinuationProtocolError(503, "service_stopping", "Continuation service is stopping.");
    }
    const url = new URL(request.url ?? "/", this.baseUrl);
    if (request.method === "POST" && url.pathname === "/v1/continuations/claim") {
      const token = requireBearer(request);
      const binding = this.claimBindings.get(token);
      if (binding === undefined) {
        throw new ContinuationProtocolError(401, "invalid_claim_capability", "Invalid or expired claim capability.");
      }
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      const finishClaim = this.beginClaim(binding);
      try {
        sendJson(response, 200, await this.claim(binding, body));
      } finally {
        finishClaim();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations/detached/claim") {
      const serviceName = requireHeader(request, "x-mono-agent-service-name");
      this.authorizeDetached(serviceName, requireBearer(request));
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      sendJson(response, 200, await this.claimDetached(serviceName, body));
      return;
    }
    const resultMatch = /^\/v1\/continuations\/([^/]+)\/result$/u.exec(url.pathname);
    if ((request.method === "PUT" || request.method === "POST") && resultMatch?.[1] !== undefined) {
      const body = await readJson(request, this.maxResultBytes);
      sendJson(response, 202, await this.acceptResult(resultMatch[1], requireBearer(request), body));
      return;
    }
    const statusMatch = /^\/v1\/continuations\/([^/]+)\/status$/u.exec(url.pathname);
    if (request.method === "GET" && statusMatch?.[1] !== undefined) {
      const record = await this.authorizedRecord(statusMatch[1], requireBearer(request));
      sendJson(response, 200, statusOfRequired(record));
      return;
    }
    if (url.pathname === "/v1/operator/continuations") {
      this.authorizeOperator(request);
      if (request.method !== "GET") {
        throw new ContinuationProtocolError(405, "method_not_allowed", "Method not allowed.");
      }
      sendJson(response, 200, operatorContinuationPage(await this.store.list(), url, this.limits.operatorPageSize));
      return;
    }
    if (url.pathname === "/v1/operator/health") {
      this.authorizeOperator(request);
      if (request.method !== "GET") {
        throw new ContinuationProtocolError(405, "method_not_allowed", "Method not allowed.");
      }
      sendJson(response, 200, await this.health());
      return;
    }
    const operatorMatch = /^\/v1\/operator\/continuations\/([^/]+)\/(retry|cancel|resolve)$/u.exec(url.pathname);
    if (request.method === "POST" && operatorMatch?.[1] !== undefined && operatorMatch[2] !== undefined) {
      this.authorizeOperator(request);
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      if (operatorMatch[2] === "retry") {
        sendJson(response, 200, await this.retry(operatorMatch[1], {
          allowUnknown: asObject(body).allowUnknown === true,
        }));
      } else if (operatorMatch[2] === "cancel") {
        sendJson(response, 200, await this.cancel(operatorMatch[1]));
      } else {
        const value = asObject(body);
        const kind = value.kind;
        if (kind !== "delivered" && kind !== "not_delivered" && kind !== "dead_lettered") {
          throw new ContinuationProtocolError(400, "invalid_resolution", "Resolution kind is invalid.");
        }
        sendJson(response, 200, await this.resolveUnknown(operatorMatch[1], {
          kind,
          ...(kind === "delivered" && typeof value.deliveryId === "string"
            ? { deliveryId: value.deliveryId }
            : {}),
        }));
      }
      return;
    }
    throw new ContinuationProtocolError(404, "not_found", "Continuation endpoint not found.");
  }

  private async claim(binding: ClaimBinding, body: unknown): Promise<Record<string, unknown>> {
    const claim = parseClaim(body, this.now(), this.maxDeadlineMs);
    return await this.claimBound(binding, claim);
  }

  private async claimDetached(serviceName: string, body: unknown): Promise<Record<string, unknown>> {
    const object = asObject(body);
    const routeName = requiredStringField(object, "route");
    const route = this.namedRoutes[routeName];
    if (route === undefined) {
      throw new ContinuationProtocolError(403, "unknown_named_route", "Detached claim route is not configured.");
    }
    const claim = parseClaim(body, this.now(), this.maxDeadlineMs);
    const originConversationId = route.conversationId ?? `continuation-route:${routeName}`;
    const fingerprint = continuationDigest([
      "v1-detached",
      serviceName,
      routeName,
      route.mode,
      route.conversationId ?? "",
    ].join("\0"));
    return await this.claimBound({
      serverName: `detached:${serviceName}`,
      originRunId: `detached:${serviceName}:${claim.taskKey}`,
      originConversationId,
      ...(route.conversationId === undefined ? {} : { replyToConversationId: route.conversationId }),
      mode: route.mode,
      fingerprint,
      closed: false,
      settled: true,
      inFlightOperations: 0,
    }, claim, routeName);
  }

  private async claimBound(
    binding: ClaimBinding,
    claim: ParsedClaim,
    routeName?: string,
  ): Promise<Record<string, unknown>> {
    let created = false;
    const record = await this.store.mutate((records) => {
      const existing = [...records.values()].find((candidate) =>
        candidate.serverName === binding.serverName
        && candidate.originRunId === binding.originRunId
        && candidate.taskKey === claim.taskKey,
      );
      if (existing !== undefined) {
        if (existing.taskHash !== claim.taskHash
          || existing.claimFingerprint !== binding.fingerprint
          || existing.deadline !== claim.deadline) {
          throw new ContinuationProtocolError(
            409,
            "claim_conflict",
            "taskKey was already claimed with different immutable inputs.",
          );
        }
        return structuredClone(existing);
      }
      const active = [...records.values()].filter(
        (candidate) => !TERMINAL_CONTINUATION_STATES.has(candidate.state),
      );
      if (active.length >= this.limits.maxActiveRecords) {
        throw new ContinuationProtocolError(
          429,
          "active_continuation_limit",
          `The service already has its maximum ${String(this.limits.maxActiveRecords)} active continuations.`,
        );
      }
      const activeForOrigin = active.filter(
        (candidate) => candidate.claimFingerprint === binding.fingerprint,
      ).length;
      if (activeForOrigin >= this.limits.maxActivePerOrigin) {
        throw new ContinuationProtocolError(
          429,
          "active_origin_limit",
          `This claim origin already has its maximum ${String(this.limits.maxActivePerOrigin)} active continuations.`,
        );
      }
      const now = this.now().toISOString();
      const continuationId = randomUUID();
      const token = this.deriveResultToken(continuationId, claim.taskHash);
      const next: DurableContinuationRecord = {
        continuationId,
        serverName: binding.serverName,
        originRunId: binding.originRunId,
        originConversationId: binding.originConversationId,
        ...(binding.replyToConversationId === undefined
          ? {}
          : { replyToConversationId: binding.replyToConversationId }),
        ...(binding.historyBoundary === undefined ? {} : { historyBoundary: binding.historyBoundary }),
        originContextState: binding.historyBoundary === undefined ? "detached_latest" : "pending",
        mode: binding.mode,
        ...(routeName === undefined ? {} : { routeName }),
        taskKey: claim.taskKey,
        taskHash: claim.taskHash,
        claimFingerprint: binding.fingerprint,
        resultTokenHash: continuationDigest(token),
        createdAt: now,
        updatedAt: now,
        deadline: claim.deadline,
        state: "claimed",
        synthesisAttempts: 0,
        synthesisDeferrals: 0,
        deliveryAttempts: 0,
      };
      records.set(continuationId, next);
      created = true;
      return structuredClone(next);
    });
    const token = this.deriveResultToken(record.continuationId, record.taskHash);
    return {
      continuationId: record.continuationId,
      resultUrl: `${this.baseUrl}/v1/continuations/${encodeURIComponent(record.continuationId)}/result`,
      statusUrl: `${this.baseUrl}/v1/continuations/${encodeURIComponent(record.continuationId)}/status`,
      token,
      expiresAt: record.deadline,
      fingerprint: record.claimFingerprint,
      ...(created ? {} : { replayed: true }),
    };
  }

  private async acceptResult(id: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    const object = asObject(body);
    const idempotencyKey = requiredStringField(object, "idempotencyKey", 256);
    if (!("payload" in object)) {
      throw new ContinuationProtocolError(400, "missing_payload", "Result payload is required.");
    }
    const serialized = canonicalContinuationJson(object.payload);
    const payloadHash = continuationDigest(serialized);
    const providedHash = typeof object.payloadHash === "string" ? object.payloadHash : undefined;
    if (providedHash !== undefined && providedHash !== payloadHash) {
      throw new ContinuationProtocolError(
        400,
        "payload_hash_mismatch",
        "Result payload hash does not match the payload.",
      );
    }
    const now = this.now();
    const record = await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      authorizeRecordToken(current, token);
      if (current.resultIdempotencyKey !== undefined) {
        if (current.resultIdempotencyKey !== idempotencyKey || current.resultPayloadHash !== payloadHash) {
          throw new ContinuationProtocolError(
            409,
            "result_conflict",
            "Continuation already has a different immutable result.",
          );
        }
        return structuredClone(current);
      }
      if (current.state !== "claimed") {
        throw new ContinuationProtocolError(409, "result_not_accepted", `Continuation is ${current.state}.`);
      }
      if (Date.parse(current.deadline) <= now.getTime()) {
        expire(current, now.toISOString());
        throw new ContinuationProtocolError(410, "continuation_expired", "Continuation deadline has passed.");
      }
      current.resultIdempotencyKey = idempotencyKey;
      current.resultPayloadHash = payloadHash;
      current.resultPayload = structuredClone(object.payload);
      current.state = "result_received";
      current.updatedAt = now.toISOString();
      return structuredClone(current);
    });
    if (this.autoProcess) void this.processDue().catch(() => undefined);
    return { continuationId: id, state: record.state, accepted: true };
  }

  private async authorizedRecord(id: string, token: string): Promise<DurableContinuationRecord> {
    const record = await this.store.get(id);
    if (record === undefined) {
      throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
    }
    authorizeRecordToken(record, token);
    return record;
  }

  private authorizeDetached(serviceName: string, token: string): void {
    const expected = this.detachedServiceTokenHashes.get(serviceName);
    if (expected === undefined || !continuationTokenMatches(token, expected)) {
      throw new ContinuationProtocolError(401, "invalid_service_capability", "Invalid detached-service capability.");
    }
  }

  private authorizeOperator(request: IncomingMessage): void {
    if (!continuationTokenMatches(requireBearer(request), continuationDigest(this.operatorToken))) {
      throw new ContinuationProtocolError(401, "invalid_operator_capability", "Invalid operator capability.");
    }
  }

  private deriveResultToken(id: string, taskHash: string): string {
    return createHmac("sha256", this.secret).update(`continuation-result\0${id}\0${taskHash}`).digest("base64url");
  }

  protected handleRequestError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    const protocol = error instanceof ContinuationProtocolError
      ? error
      : new ContinuationProtocolError(500, "internal_error", "Continuation request failed.");
    if (!(error instanceof ContinuationProtocolError)) {
      this.logger?.error?.("Continuation request failed.", { reason: safeReason(error) });
    }
    sendJson(response, protocol.status, { error: { code: protocol.code, message: protocol.message } });
  }
}
