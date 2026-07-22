import { escapeTerminalControls } from "./terminal-text.js";

const SESSION_BOUNDARY = "session_boundary";

/**
 * Human-readable label shared by live runtime telemetry and persisted replay
 * events. Recorded artifacts can carry either the direct `session_boundary`
 * shape or the nested `runtime_telemetry` shape used by the live stream.
 */
export function sessionBoundaryNotice(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const type = stringField(event, "type");
  const data = isRecord(event.data) ? event.data : undefined;
  const dataKind = stringField(data, "kind");
  const telemetryBoundary = type === "runtime_telemetry" && (
    stringField(event, "kind") === SESSION_BOUNDARY
    || stringField(data, "type") === SESSION_BOUNDARY
    || dataKind === SESSION_BOUNDARY
  );
  const directBoundary = type === SESSION_BOUNDARY;
  if (!directBoundary && !telemetryBoundary) {
    return undefined;
  }

  const source = directBoundary ? event : data;
  const sourceKind = directBoundary ? stringField(event, "kind") : dataKind;
  const boundaryKind = sourceKind === SESSION_BOUNDARY ? undefined : sourceKind;
  const parts = [
    boundaryKind === undefined
      ? "session boundary"
      : `session boundary: ${formatTelemetryLabel(boundaryKind)}`,
  ];
  const reason = stringField(source, "reason");
  if (reason !== undefined) {
    parts.push(formatTelemetryLabel(reason));
  }

  const transition = sessionBoundaryTransition(source);
  if (transition !== undefined) {
    parts.push(transition);
  }

  const providerSessionId = stringField(source, "providerSessionId");
  if (providerSessionId !== undefined && boundaryKind === "resume_replay") {
    parts.push(`provider ${escapeTerminalControls(providerSessionId)}`);
  }

  return parts.join(" · ");
}

function sessionBoundaryTransition(data: Record<string, unknown> | undefined): string | undefined {
  const previous = stringField(data, "previousConversationId");
  const current = stringField(data, "conversationId");
  if (previous !== undefined && current !== undefined && previous !== current) {
    return `${escapeTerminalControls(previous)} -> ${escapeTerminalControls(current)}`;
  }

  const base = stringField(data, "baseConversationId");
  if (base !== undefined && current !== undefined && base !== current) {
    return `${escapeTerminalControls(base)} -> ${escapeTerminalControls(current)}`;
  }
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formatTelemetryLabel(value: string): string {
  return escapeTerminalControls(value).replace(/[_-]+/gu, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
