import { randomUUID } from "node:crypto";

import type {
  ArtifactRef,
  JsonObject,
  RouteIdentity,
  RuntimeSession,
} from "@mono-agent/module-sdk";
import type {
  StateExecution,
  StateExecutionRequest,
  StateStore,
} from "@mono-agent/module-sdk/internal";

import type {
  AgentInteractionEvidence,
  AgentRunAttemptEvidence,
  AgentRunEvent,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSummary,
  AgentTranscriptEntry,
} from "../types.js";
import type {
  CanonicalTranscript,
  ConversationView,
} from "../state-execution-client.js";

const OPERATIONS = Object.freeze([
  "protocol.describe",
  "transcript.append",
  "conversation.open",
  "conversation.load",
  "conversation.list",
  "run.admit",
  "run.record-attempt",
  "run.record-interaction",
  "run.stage-artifacts",
  "run.settle",
  "run.read-cached-response",
  "run.read",
  "run.list",
  "session.load",
  "session.evict",
  "delivery.prepare",
  "delivery.settle",
] as const);

type HookedStore = StateStore & {
  beforeExecutionOperation?(operation: string, input: unknown): void | Promise<void>;
};

interface StoredRun {
  readonly fingerprint: string;
  readonly record: AgentRunRecord;
  readonly responseRef?: ArtifactRef;
}

interface StoredDelivery {
  readonly fingerprint: string;
  readonly status: "intent" | "delivered" | "failed" | "unknown";
  readonly attempt: number;
  readonly token: string;
  readonly messageId?: string;
  readonly code?: string;
}

export class InMemoryStateExecution implements StateExecution {
  readonly #runs = new Map<string, StoredRun>();
  readonly #requests = new Map<string, string>();
  readonly #conversations = new Map<string, ConversationView>();
  readonly #sessions = new Map<string, { readonly value: RuntimeSession; readonly updatedAt: string }>();
  readonly #deliveries = new Map<string, StoredDelivery>();
  readonly #state: HookedStore;
  #tail: Promise<void> = Promise.resolve();

  constructor(state: StateStore) {
    this.#state = state as HookedStore;
  }

  markAdmissionUncertain(requestId: string): void {
    const runId = this.#requests.get(requestId);
    if (runId === undefined) throw new Error(`fixture request ${requestId} is missing`);
    const stored = this.#requiredRun(runId);
    const now = new Date().toISOString();
    this.#replaceRun(runId, stored, {
      ...stored.record,
      summary: {
        ...stored.record.summary,
        status: "uncertain",
        updatedAt: now,
        endedAt: now,
        failureCode: "stale-running-admission",
      },
      events: [...stored.record.events, {
        type: "settled",
        runId,
        sequence: stored.record.events.length,
        recordedAt: now,
        status: "uncertain",
        failureCode: "stale-running-admission",
      }],
    });
  }

  perform(request: StateExecutionRequest): Promise<unknown> {
    const execute = (): Promise<unknown> => this.#perform(request);
    const pending = this.#tail.then(execute, execute);
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #perform(request: StateExecutionRequest): Promise<unknown> {
    request.signal.throwIfAborted();
    const input = (request.input ?? {}) as Record<string, unknown>;
    switch (request.operation) {
      case "protocol.describe":
        return { protocol: "mono-agent.state-execution", version: 1, operations: OPERATIONS };
      case "transcript.append": {
        await this.#before(request);
        const current = input.current as CanonicalTranscript | undefined;
        const conversationId = input.conversationId as string;
        return {
          schemaVersion: 1,
          kind: "mono-agent.canonical-transcript",
          conversationId,
          revision: (current?.revision ?? 0) + 1,
          entries: [...(current?.entries ?? []), ...(input.entries as readonly AgentTranscriptEntry[])],
        } satisfies CanonicalTranscript;
      }
      case "conversation.open": {
        await this.#before(request);
        const conversationId = `proactive:${randomUUID()}`;
        const now = new Date().toISOString();
        const initialText = input.initialText as string | undefined;
        const transcript: CanonicalTranscript = {
          schemaVersion: 1,
          kind: "mono-agent.canonical-transcript",
          conversationId,
          revision: 1,
          entries: initialText === undefined || initialText.length === 0
            ? []
            : [{
                kind: "verbatim",
                entryId: `${conversationId}:initial`,
                runId: `${conversationId}:open`,
                requestId: `${conversationId}:open`,
                conversationId,
                recordedAt: now,
                role: "assistant",
                text: initialText,
              }],
        };
        const conversation: ConversationView = {
          conversationId,
          createdAt: now,
          updatedAt: now,
          transcript,
          ...(input.title === undefined ? {} : { title: input.title as string }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata as JsonObject }),
        };
        this.#conversations.set(conversationId, conversation);
        return conversation;
      }
      case "conversation.load":
        return clone(this.#conversations.get(input.conversationId as string));
      case "conversation.list": {
        const values = [...this.#conversations.values()]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
            || left.conversationId.localeCompare(right.conversationId));
        return page(values.map(({ transcript: _transcript, ...value }) => value), input.cursor);
      }
      case "run.admit":
        await this.#before(request);
        return this.#admit(input);
      case "run.record-attempt":
        await this.#before(request);
        return this.#recordAttempt(input.runId as string, input.attempt as AgentRunAttemptEvidence);
      case "run.record-interaction":
        await this.#before(request);
        return this.#recordInteraction(input.runId as string, input.evidence as AgentInteractionEvidence);
      case "run.stage-artifacts":
        await this.#before(request);
        return Promise.all((input.artifacts as readonly {
          readonly slot: string;
          readonly data: Uint8Array;
          readonly mediaType: string;
          readonly fileName?: string;
        }[]).map(async (artifact) => ({
          slot: artifact.slot,
          ref: await this.#putArtifact(
            artifact.data,
            artifact.mediaType,
            artifact.fileName,
            request.signal,
          ),
        })));
      case "run.settle":
        await this.#before(request);
        return this.#settle(input, request.signal);
      case "run.read-cached-response":
        return this.#readArtifact(input.ref as ArtifactRef, request.signal);
      case "run.read":
        return clone(this.#runs.get(input.runId as string)?.record);
      case "run.list": {
        const values = [...this.#runs.values()]
          .map(({ record }) => record.summary)
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt)
            || right.runId.localeCompare(left.runId));
        const result = page(values, input.cursor);
        return { runs: result.conversations, ...cursorOnly(result) };
      }
      case "session.load":
        return clone(this.#sessions.get(sessionKey(
          input.conversationId as string,
          input.route as RouteIdentity,
        )));
      case "session.evict": {
        await this.#before(request);
        const key = sessionKey(input.conversationId as string, input.route as RouteIdentity);
        const current = this.#sessions.get(key);
        const expected = input.expected as { readonly sessionId: string; readonly updatedAt: string };
        if (current?.value.id !== expected.sessionId || current.updatedAt !== expected.updatedAt) return false;
        return this.#sessions.delete(key);
      }
      case "delivery.prepare":
        await this.#before(request);
        return this.#prepareDelivery(input);
      case "delivery.settle":
        await this.#before(request);
        return this.#settleDelivery(input);
      default:
        throw new Error(`unsupported fixture execution operation ${request.operation}`);
    }
  }

  #admit(input: Record<string, unknown>): unknown {
    const requestId = input.requestId as string;
    const fingerprint = input.fingerprint as string;
    const existingId = this.#requests.get(requestId);
    if (existingId !== undefined) {
      const existing = this.#runs.get(existingId)!;
      if (existing.fingerprint !== fingerprint) return { status: "conflict", runId: existingId };
      if (existing.record.summary.status === "running") return { status: "join", runId: existingId };
      if (existing.record.summary.status === "uncertain") {
        return { status: "uncertain", runId: existingId };
      }
      return {
        status: "cached",
        summary: existing.record.summary,
        ...(existing.responseRef === undefined ? {} : { responseRef: existing.responseRef }),
      };
    }
    const now = new Date().toISOString();
    const runId = typeof input.runId === "string" ? input.runId : randomUUID();
    const summary: AgentRunSummary = {
      runId,
      requestId,
      conversationId: input.conversationId as string,
      status: "running",
      startedAt: now,
      updatedAt: now,
      attempts: [],
    };
    this.#requests.set(requestId, runId);
    this.#runs.set(runId, {
      fingerprint,
      record: {
        summary,
        events: [{ type: "admitted", runId, sequence: 0, recordedAt: now }],
        transcript: [],
      },
    });
    return { status: "accepted", summary };
  }

  #recordAttempt(runId: string, attempt: AgentRunAttemptEvidence): AgentRunSummary {
    const stored = this.#requiredRun(runId);
    const now = new Date().toISOString();
    const attempts = [...stored.record.summary.attempts];
    const index = attempts.findIndex((candidate) => candidate.attempt === attempt.attempt);
    if (index < 0) attempts.push(attempt);
    else attempts[index] = attempt;
    return this.#replaceRun(runId, stored, {
      summary: { ...stored.record.summary, attempts, updatedAt: now },
      events: [...stored.record.events, {
        type: "attempt",
        runId,
        sequence: stored.record.events.length,
        recordedAt: now,
        attempt,
      }],
      transcript: stored.record.transcript,
    }).record.summary;
  }

  #recordInteraction(runId: string, evidence: AgentInteractionEvidence): AgentRunSummary {
    const stored = this.#requiredRun(runId);
    const now = new Date().toISOString();
    return this.#replaceRun(runId, stored, {
      summary: { ...stored.record.summary, updatedAt: now },
      events: [...stored.record.events, {
        type: "interaction",
        runId,
        sequence: stored.record.events.length,
        recordedAt: now,
        evidence,
      }],
      transcript: stored.record.transcript,
    }).record.summary;
  }

  async #settle(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentRunSummary> {
    const runId = input.runId as string;
    const stored = this.#requiredRun(runId);
    const now = new Date().toISOString();
    const status = input.status as Exclude<AgentRunStatus, "running">;
    const transcript = input.transcript as CanonicalTranscript | undefined;
    const summary: AgentRunSummary = {
      ...stored.record.summary,
      status,
      updatedAt: now,
      endedAt: now,
      ...(transcript === undefined ? {} : { transcriptRevision: String(transcript.revision) }),
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode as string }),
    };
    let responseRef: ArtifactRef | undefined;
    if (input.responseBytes instanceof Uint8Array) {
      responseRef = await this.#putArtifact(
        input.responseBytes,
        "application/vnd.mono-agent.cached-agent-response+json",
        "response.json",
        signal,
      );
    }
    const record: AgentRunRecord = {
      summary,
      events: [...stored.record.events, {
        type: "settled",
        runId,
        sequence: stored.record.events.length,
        recordedAt: now,
        status,
        ...(transcript === undefined ? {} : { transcriptRevision: String(transcript.revision) }),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode as string }),
      }],
      transcript: transcript?.entries.filter((entry) => entry.runId === runId) ?? stored.record.transcript,
    };
    this.#runs.set(runId, {
      fingerprint: stored.fingerprint,
      record,
      ...(responseRef === undefined ? {} : { responseRef }),
    });
    if (transcript !== undefined) {
      const prior = this.#conversations.get(summary.conversationId);
      this.#conversations.set(summary.conversationId, {
        conversationId: summary.conversationId,
        createdAt: prior?.createdAt ?? summary.startedAt,
        updatedAt: now,
        transcript,
        ...(prior?.title === undefined ? {} : { title: prior.title }),
        ...(prior?.metadata === undefined ? {} : { metadata: prior.metadata }),
      });
    }
    const session = input.session as { readonly value: RuntimeSession; readonly updatedAt: string } | undefined;
    if (session !== undefined) {
      this.#sessions.set(sessionKey(summary.conversationId, session.value.route), clone(session)!);
    }
    const eviction = input.sessionEviction as RouteIdentity | undefined;
    if (eviction !== undefined) this.#sessions.delete(sessionKey(summary.conversationId, eviction));
    return summary;
  }

  #prepareDelivery(input: Record<string, unknown>): unknown {
    const key = input.idempotencyKey as string;
    const fingerprint = input.fingerprint as string;
    const existing = this.#deliveries.get(key);
    if (existing === undefined) {
      const delivery = {
        fingerprint,
        status: "intent" as const,
        attempt: 1,
        token: randomUUID(),
      };
      this.#deliveries.set(key, delivery);
      return { status: "send", attempt: delivery.attempt, token: delivery.token };
    }
    if (existing.fingerprint !== fingerprint) return { status: "conflict" };
    if (existing.status === "intent") return { status: "join" };
    if (existing.status === "delivered") {
      return { status: "duplicate", ...(existing.messageId === undefined ? {} : { messageId: existing.messageId }) };
    }
    if (existing.status === "unknown") {
      return { status: "unknown", ...(existing.code === undefined ? {} : { code: existing.code }) };
    }
    const retry = { ...existing, status: "intent" as const, attempt: existing.attempt + 1, token: randomUUID() };
    this.#deliveries.set(key, retry);
    return { status: "send", attempt: retry.attempt, token: retry.token };
  }

  #settleDelivery(input: Record<string, unknown>): unknown {
    const key = input.idempotencyKey as string;
    const existing = this.#deliveries.get(key);
    if (existing === undefined
      || existing.fingerprint !== input.fingerprint
      || existing.attempt !== input.attempt
      || existing.token !== input.token) return { status: "conflict" };
    const status = input.status as "delivered" | "failed" | "unknown";
    this.#deliveries.set(key, {
      ...existing,
      status,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId as string }),
      ...(input.code === undefined ? {} : { code: input.code as string }),
    });
    if (status === "delivered") {
      return { status: "duplicate", ...(input.messageId === undefined ? {} : { messageId: input.messageId }) };
    }
    if (status === "unknown") return { status: "unknown", ...(input.code === undefined ? {} : { code: input.code }) };
    return { status: "join" };
  }

  #requiredRun(runId: string): StoredRun {
    const stored = this.#runs.get(runId);
    if (stored === undefined) throw new Error(`fixture run ${runId} is missing`);
    return stored;
  }

  #replaceRun(runId: string, prior: StoredRun, record: AgentRunRecord): StoredRun {
    const next = {
      fingerprint: prior.fingerprint,
      record,
      ...(prior.responseRef === undefined ? {} : { responseRef: prior.responseRef }),
    };
    this.#runs.set(runId, next);
    return next;
  }

  async #putArtifact(
    data: Uint8Array,
    mediaType: string,
    fileName: string | undefined,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    if (this.#state.putArtifact === undefined) throw new Error("fixture state has no artifact store");
    return this.#state.putArtifact({
      data,
      mediaType,
      ...(fileName === undefined ? {} : { fileName }),
      signal,
    });
  }

  async #readArtifact(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#state.readArtifact === undefined) throw new Error("fixture state has no artifact store");
    return this.#state.readArtifact({ ref, maxBytes: 96 * 1024 * 1024, signal });
  }

  async #before(request: StateExecutionRequest): Promise<void> {
    await this.#state.beforeExecutionOperation?.(request.operation, request.input);
  }
}

function sessionKey(conversationId: string, route: RouteIdentity): string {
  return `${conversationId}\0${route.runtimeInstanceId}\0${route.model}`;
}

function page<T>(
  values: readonly T[],
  rawCursor: unknown,
): { readonly conversations: readonly T[]; readonly nextCursor?: string } {
  const offset = typeof rawCursor === "string"
    ? Number(Buffer.from(rawCursor, "base64url").toString("utf8"))
    : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) {
    throw new Error("fixture cursor is invalid");
  }
  const conversations = values.slice(offset, offset + 50);
  const next = offset + conversations.length;
  return {
    conversations,
    ...(next < values.length ? { nextCursor: Buffer.from(String(next), "utf8").toString("base64url") } : {}),
  };
}

function cursorOnly(value: { readonly nextCursor?: string }): { readonly nextCursor?: string } {
  return value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor };
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
