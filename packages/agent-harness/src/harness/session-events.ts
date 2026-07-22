import type { RuntimeEventLike } from "@mono-agent/observability";

import type { RuntimeSessionRecord, RuntimeSessionSnapshot } from "../sessions.js";
import type { AgentHarnessSessionBoundary, AgentHarnessSessionEvent } from "../types.js";

export function withSessionBoundaryTimestamp(event: AgentHarnessSessionBoundary, timestamp: string): RuntimeEventLike {
  return event.timestamp === undefined ? { ...event, timestamp } : { ...event };
}

export function sessionEventFromRecord(
  kind: AgentHarnessSessionEvent["kind"],
  record: RuntimeSessionRecord | RuntimeSessionSnapshot,
  reason: string | undefined,
  snapshot: AgentHarnessSessionEvent["snapshot"],
): AgentHarnessSessionEvent {
  return {
    kind,
    conversationId: record.conversationId,
    providerSessionId: record.providerSessionId,
    ...(record.providerSessionRevision === undefined
      ? {}
      : { providerSessionRevision: record.providerSessionRevision }),
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    busy: record.busy,
    ...(reason === undefined ? {} : { reason }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}
