import type { ConnectionState } from "./console-store";
import type { AgentSummary, ThreadSummary } from "./types";

export const canSendInConsole = (
  connection: ConnectionState,
  agent: AgentSummary | null,
  thread: ThreadSummary | null,
): boolean =>
  connection === "live" &&
  agent !== null &&
  agent.status !== "offline" &&
  !thread?.archivedAt &&
  (thread?.canSend ?? true);

export const canUploadInConsole = (
  connection: ConnectionState,
  agent: AgentSummary | null,
  thread: ThreadSummary | null,
): boolean =>
  connection === "live" &&
  agent !== null &&
  agent.status !== "offline" &&
  agent.supportsAttachments &&
  (thread?.canUpload ?? true);
