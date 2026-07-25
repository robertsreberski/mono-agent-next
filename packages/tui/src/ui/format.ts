// SPDX-License-Identifier: MIT
import { extname } from "node:path";

import type {
  OperatorAttachment,
  OperatorConversationState,
  OperatorQuote,
  OperatorToolResult,
  OperatorTurnRequest,
} from "@mono-agent/operator";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedView(value: string): string {
  return value.length <= 32_768 ? value : `${value.slice(0, 32_760)}\n[truncated]`;
}

export function boundedStatus(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

export function latestActivity(state: OperatorConversationState, fallback: string): string {
  const latest = state.activities.at(-1);
  if (latest === undefined) return fallback;
  switch (latest.type) {
    case "activity": return latest.text;
    case "tool_call": return `calling ${latest.call.name}…`;
    case "tool_result": return `tool ${latest.result.callId} ${latest.result.isError === true ? "failed" : "completed"}`;
    case "compaction": return latest.compaction.compacted ? "context compacted" : "context compaction skipped";
  }
}

export function toolResultText(result: OperatorToolResult): string {
  if (result.contentOmitted) return "[content omitted by operator boundary]";
  return result.content?.map((part) =>
    part.type === "text" ? part.text : JSON.stringify(part.value, null, 2)
  ).join("\n") ?? "";
}

export function attachmentMediaType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".json": return "application/json";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

export function buildTurnRequest(
  text: string,
  attachments: readonly OperatorAttachment[],
  quote: OperatorQuote | undefined,
  base: Omit<OperatorTurnRequest, "input">,
): OperatorTurnRequest {
  return {
    ...base,
    input: {
      ...(text.length === 0 ? {} : { text }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(quote === undefined ? {} : { quote }),
    },
  };
}
