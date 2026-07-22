import { isChannelUserCancelReason } from "@mono-agent/agent-contracts";
import type {
  RunRecorder,
  RunSummary,
  RuntimeResultLike,
} from "@mono-agent/observability";
import type { RuntimeResult } from "@mono-agent/runtime-adapter";

import type { BuiltAgentContext } from "../context/index.js";
import type {
  AgentHarnessFailure,
  AgentHarnessRequest,
  AgentHarnessResponse,
} from "../types.js";
import { AgentHarnessError } from "./error.js";
import { externalResponseSummary } from "./external-summary.js";
import { errorToDetails, isRecord } from "./value-utils.js";

const SESSION_RESUME_RETRY_FAILURE_KINDS = new Set(["session_not_found", "session_busy"]);

export function shouldRetrySessionResumeError(error: unknown): boolean {
  return SESSION_RESUME_RETRY_FAILURE_KINDS.has(failureKindFromUnknown(error));
}

export function shouldRetryWithoutSession(result: RuntimeResult | undefined, aborted: boolean): boolean {
  if (result === undefined || aborted || result.cancelled === true) {
    return false;
  }
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return SESSION_RESUME_RETRY_FAILURE_KINDS.has(result.failureKind);
  }
  return false;
}

function failureKindFromUnknown(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const direct = value.failureKind;
  if (typeof direct === "string") {
    return direct.trim();
  }
  const details = value.details;
  if (isRecord(details) && typeof details.failureKind === "string") {
    return details.failureKind.trim();
  }
  return "";
}

export function failureFromRuntimeResult(result: RuntimeResult): AgentHarnessFailure | undefined {
  if (result.cancelled === true) {
    return {
      kind: "cancelled",
      message: "Agent runtime run was cancelled.",
      details: result,
    };
  }
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return {
      kind: result.failureKind,
      message: typeof result.error === "string" && result.error.trim().length > 0 ? result.error : "Agent runtime failed.",
      details: result.errorDetails ?? result,
    };
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return {
      kind: "runtime_error",
      message: result.error,
      details: result.errorDetails ?? result,
    };
  }
  return undefined;
}

export function failureFromThrownError(error: unknown, wasAborted: boolean): AgentHarnessFailure {
  if (wasAborted) {
    return { kind: "cancelled", message: "Agent request was cancelled.", details: errorToDetails(error) };
  }
  if (error instanceof AgentHarnessError) {
    return { kind: error.failureKind, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { kind: error.name || "exception", message: error.message, details: errorToDetails(error) };
  }
  return { kind: "exception", message: String(error), details: error };
}

export function cancellationFailureKind(signal: AbortSignal): "cancelled" | "cancelled_user" {
  return isChannelUserCancelReason(signal.reason) ? "cancelled_user" : "cancelled";
}

export async function safeRecorderCancel(
  recorder: RunRecorder,
  failureKind: "cancelled" | "cancelled_user",
): Promise<RunSummary | undefined> {
  try {
    return await recorder.finish({ cancelled: true, failureKind });
  } catch {
    return undefined;
  }
}

export async function safeRecorderFail(recorder: RunRecorder, error: unknown): Promise<RunSummary | undefined> {
  try {
    return await recorder.fail(error);
  } catch {
    return undefined;
  }
}

export async function commitRecorderFinish(recorder: RunRecorder, result: RuntimeResultLike): Promise<RunSummary> {
  return recorder.commitFinish === undefined
    ? await recorder.finish(result)
    : await recorder.commitFinish(result);
}

export async function safeRecorderCommitFinish(
  recorder: RunRecorder,
  result: RuntimeResultLike,
): Promise<RunSummary | undefined> {
  try {
    return await commitRecorderFinish(recorder, result);
  } catch {
    return undefined;
  }
}

export function normalizeAssistantText(text: unknown): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  return text.trim().length === 0 ? undefined : text;
}

export function responseMetadata(
  runId: string,
  request: AgentHarnessRequest,
  context: BuiltAgentContext | undefined,
  summary: RunSummary | undefined,
  runtimeResult?: RuntimeResult,
): AgentHarnessResponse["metadata"] {
  const externalSummary = summary === undefined ? undefined : externalResponseSummary(summary);
  return {
    runId,
    conversationId: request.conversationId,
    contextSources: context?.metadata.sources ?? [],
    contextSectionIds: context?.sections.map((section) => section.id) ?? [],
    ...(runtimeResult === undefined ? {} : { runtime: runtimeMetadata(runtimeResult) }),
    ...(externalSummary === undefined ? {} : { summary: externalSummary }),
  };
}

/**
 * Recorder summaries stay complete for local artifact readers, but a
 * harness response crosses a channel boundary. The compiled system prompt can
 * contain identity and context, so it is never returned to channel callers.
 */

function runtimeMetadata(result: RuntimeResult): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of ["model", "sdk", "effort", "numTurns", "durationMs", "usage", "cost", "providerSessionId", "runtimeWarnings", "diagnostics", "capabilitiesUsed"] as const) {
    if (result[key] !== undefined) {
      metadata[key] = result[key];
    }
  }
  return metadata;
}

export function failureResponse(input: {
  readonly runId: string;
  readonly request: AgentHarnessRequest;
  readonly summary: RunSummary;
  readonly kind: string;
  readonly message: string;
}): AgentHarnessResponse {
  return {
    metadata: responseMetadata(input.runId, input.request, undefined, input.summary),
    failure: {
      kind: input.kind,
      message: input.message,
    },
  };
}
