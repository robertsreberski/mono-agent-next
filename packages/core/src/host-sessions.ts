// SPDX-License-Identifier: MIT
import type { RuntimeSession } from "@mono-agent/module-sdk";
import { immutableClone, isRecord } from "./host-values.js";
import type { SessionDisposition } from "./host-types.js";
import type { StateExecutionClient } from "./state-execution-client.js";
import type { AgentSubmitInput, LoadedAgentConfig, RuntimeRoute } from "./types.js";

interface SessionContext {
  readonly config: LoadedAgentConfig;
  execution(): StateExecutionClient | undefined;
}

/**
 * Owns runtime-native session retention for one host: which route/conversation
 * pairs may reuse a provider session, and the durable load/evict handshake.
 */
export class HostSessions {
  readonly #sessions = new Map<string, RuntimeSession>();
  readonly #updatedAt = new Map<string, string>();
  constructor(private readonly context: SessionContext) {}

  disposition(input: AgentSubmitInput, sessionsSupported: boolean): SessionDisposition {
    const session = this.context.config.raw.session;
    if (!sessionsSupported || session?.mode === "per-message") return "evict";
    if (
      session?.isolateProactiveRuns === true
      && (input.conversationId.startsWith("trigger:")
        || input.conversationId.startsWith("proactive:")
        || (isRecord(input.metadata) && typeof input.metadata.triggerId === "string"))
    ) {
      return "isolate";
    }
    return "retain";
  }

  async forRequest(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    sessionKey: string,
    sessionsSupported: boolean,
    signal: AbortSignal,
  ): Promise<RuntimeSession | undefined> {
    const disposition = this.disposition(input, sessionsSupported);
    if (disposition === "isolate") return undefined;
    await this.#load(input, route, sessionKey, signal);
    if (disposition === "evict") {
      await this.evict(input, route, sessionKey, signal);
      return undefined;
    }
    if (this.#reusable(sessionKey, new Date().toISOString())) return this.#sessions.get(sessionKey);
    await this.evict(input, route, sessionKey, signal);
    return undefined;
  }

  async evict(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    await this.#load(input, route, sessionKey, signal);
    const staleSession = this.#sessions.get(sessionKey);
    const staleUpdatedAt = this.#updatedAt.get(sessionKey);
    this.#sessions.delete(sessionKey);
    this.#updatedAt.delete(sessionKey);
    const execution = this.context.execution();
    if (execution !== undefined && staleSession !== undefined && staleUpdatedAt !== undefined) {
      await execution.evictSession(
        input.conversationId,
        routeIdentity(route),
        { sessionId: staleSession.id, updatedAt: staleUpdatedAt },
        signal,
      );
    }
    return staleSession !== undefined;
  }

  /** Applies the post-turn retention decision for one settled route. */
  commit(
    sessionKey: string,
    disposition: SessionDisposition,
    session: RuntimeSession | undefined,
    sessionEvicted: boolean,
    updatedAt: string,
  ): void {
    if (disposition === "evict" || (disposition === "retain" && sessionEvicted)) {
      this.#sessions.delete(sessionKey);
      this.#updatedAt.delete(sessionKey);
      return;
    }
    if (disposition === "retain" && session !== undefined) {
      this.#sessions.set(sessionKey, immutableClone(session));
      this.#updatedAt.set(sessionKey, updatedAt);
    }
  }

  clear(): void {
    this.#sessions.clear();
    this.#updatedAt.clear();
  }

  async #load(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    const execution = this.context.execution();
    if (this.#sessions.has(sessionKey) || execution === undefined) return;
    const durable = await execution.loadSession(input.conversationId, routeIdentity(route), signal);
    if (durable === undefined) return;
    this.#sessions.set(sessionKey, immutableClone(durable.value));
    this.#updatedAt.set(sessionKey, durable.updatedAt);
  }

  #reusable(sessionKey: string, now: string): boolean {
    const retained = this.#sessions.get(sessionKey);
    if (retained === undefined) return false;
    if (retained.expiresAt !== undefined && Date.parse(retained.expiresAt) <= Date.parse(now)) return false;
    const updatedAt = this.#updatedAt.get(sessionKey);
    if (updatedAt === undefined) return false;
    const session = this.context.config.raw.session;
    if (session?.idleTimeoutMs !== undefined) {
      const elapsed = Date.parse(now) - Date.parse(updatedAt);
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= session.idleTimeoutMs) return false;
    }
    if (session?.rollover === "daily") {
      const timezone = session.timezone ?? "UTC";
      if (calendarDateKey(updatedAt, timezone) !== calendarDateKey(now, timezone)) return false;
    }
    return true;
  }
}

export function routeIdentity(route: RuntimeRoute): { readonly runtimeInstanceId: string; readonly model: string } {
  return { runtimeInstanceId: route.runtime, model: route.model };
}

export function calendarDateKey(timestamp: string, timeZone: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf())) return "invalid";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year ?? ""}-${values.month ?? ""}-${values.day ?? ""}`;
}
