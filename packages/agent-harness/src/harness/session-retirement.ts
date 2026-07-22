import type { RuntimeSessionRecord, RuntimeSessionStore } from "../sessions.js";
import type { AgentHarnessOptions } from "../types.js";

/**
 * Invalidates provider sessions attached to a turn that canonical host history
 * will not commit, then removes the confirmed warm mapping.
 */
export async function retireRunResultSession(
  options: AgentHarnessOptions,
  sessionStore: RuntimeSessionStore | undefined,
  sessionsEnabled: boolean,
  conversationId: string,
  sessionRecord: RuntimeSessionRecord | undefined,
  ...providerSessionIds: readonly unknown[]
): Promise<void> {
  if (!sessionsEnabled) return;
  const ids = new Set<string>();
  if (sessionRecord !== undefined) ids.add(sessionRecord.providerSessionId);
  for (const providerSessionId of providerSessionIds) {
    if (typeof providerSessionId === "string" && providerSessionId.trim().length > 0) {
      ids.add(providerSessionId);
    }
  }
  for (const id of ids) {
    try {
      if (options.runtime.invalidateSession !== undefined) {
        await options.runtime.invalidateSession(id);
      } else {
        await options.runtime.disposeSession?.(id);
      }
    } catch {
      // Cleanup is best-effort; the host mapping is still evicted below.
    }
  }
  if (sessionRecord !== undefined) {
    await sessionStore?.evict(conversationId, "stale", sessionRecord.providerSessionId);
  }
}
