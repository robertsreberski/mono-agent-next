import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";

import type { AgentHarnessRequest } from "../types.js";

/**
 * Host-owned delivery guidance for the current turn. Physical channel and thread
 * identities deliberately stay out of model context: an opted-in MCP server gets
 * an opaque destination-bound claim capability instead. A model may promise a
 * later reply only after such a tool confirms that the continuation was registered.
 */
export function sessionContextBlock(
  request: Pick<AgentHarnessRequest, "metadata" | "replyTo">,
  hostManagedMemory = false,
): string {
  const deliverable = request.replyTo !== undefined && !hasRequestDrivenTrigger(request.metadata);
  const memoryGuidance = hostManagedMemory ? HOST_MANAGED_MEMORY_GUIDANCE : undefined;
  if (deliverable) {
    return [
      "You are handling an interactive push conversation. The host owns its exact channel and thread destination.",
      "Never copy, request, infer, or pass a conversation id, channel id, callback URL, or delivery token. You may promise a later reply only after a continuation-capable tool explicitly confirms that a destination-bound continuation was registered; otherwise finish synchronously or explain that background delivery was not scheduled.",
      memoryGuidance,
    ].filter((part) => part !== undefined).join("\n\n");
  }
  const base = "This is a request-driven run (scheduled, webhook, or API) with no interactive user attached to a deliverable push conversation. Do not invent or infer a callback destination.";
  const notifyGuidance = notifyDeliveryGuidance(request.metadata);
  return [base, notifyGuidance, memoryGuidance]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

function hasRequestDrivenTrigger(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.cron !== undefined || metadata?.webhook !== undefined;
}

const HOST_MANAGED_MEMORY_GUIDANCE = [
  "Long-term memory state is owned by the host; its configured memory pipeline decides whether and how qualifying successful turns are persisted.",
  "To remember something, acknowledge it in your reply and let the host handle capture; never edit memory Markdown, SQLite databases, indexes, manifests, or other internal memory state with file or shell tools.",
  "Use the available recall/search tools to read memory.",
].join(" ");

/**
 * Guidance for a notify-enabled cron/webhook turn (its trigger metadata carries
 * `nativeNotify.enabled`): the agent's final reply is delivered to the user
 * VERBATIM by the host, so it should read as the finished message and there is no
 * tool to call. Returns undefined for any non-notify turn.
 */
function notifyDeliveryGuidance(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined || !(nativeNotifyEnabled(metadata.cron) || nativeNotifyEnabled(metadata.webhook))) {
    return undefined;
  }
  return [
    "This run was triggered on a schedule or by a webhook, and your final reply is delivered to the user on their channel exactly as you write it.",
    "Write your final message as the finished notification: no preface, no meta-commentary, no narration of your steps, and do NOT call any tool to send it — delivery is automatic and posts your reply verbatim.",
    `If there is nothing worth telling the user, reply with exactly \`${NOTHING_TO_REPORT_SENTINEL}\` and nothing else; no notification is sent.`,
  ].join("\n\n");
}

function nativeNotifyEnabled(trigger: unknown): boolean {
  if (typeof trigger !== "object" || trigger === null) {
    return false;
  }
  const nativeNotify = (trigger as { nativeNotify?: unknown }).nativeNotify;
  return (
    typeof nativeNotify === "object" &&
    nativeNotify !== null &&
    (nativeNotify as { enabled?: unknown }).enabled === true
  );
}
