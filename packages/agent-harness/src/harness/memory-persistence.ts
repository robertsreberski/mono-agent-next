import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";
import type { RuntimeEventLike } from "@mono-agent/observability";

import type { HistoryMessage } from "../context/index.js";
import type { AgentHarnessOptions } from "../types.js";
import type { AppliedLiveInput } from "../live-input.js";
import { compactOneLine } from "./value-utils.js";

const MEMORY_PERSISTENCE_WARNING = "Memory persistence was not confirmed after the provider answer; the provider response was preserved.";

export async function buildSuccessfulTurn(
  options: AgentHarnessOptions,
  conversationId: string,
  userMessage: string,
  liveInputs: readonly AppliedLiveInput[],
  assistantText: string,
  runId: string,
): Promise<{
  readonly capturedAt: string;
  readonly messages: readonly HistoryMessage[];
  readonly userMemoryText: string;
}> {
    const capturedAt = options.now?.().toISOString() ?? new Date().toISOString();
    let assistantHistoryText = assistantText;
    try {
      assistantHistoryText = await options.turnHistoryEnricher?.enrichAssistantHistory({
        runId,
        conversationId,
        assistantText,
      }) ?? assistantText;
    } catch {
      // Enrichment is additive. A successful provider answer still commits its
      // original bytes when the optional app-owned enrichment fails.
    }
    return {
      capturedAt,
      userMemoryText: composeUserMemoryText(userMessage, liveInputs),
      messages: [
        { role: "user", content: userMessage, timestamp: capturedAt, runId },
        ...liveInputs.map((input) => ({
          role: "user" as const,
          content: input.text,
          timestamp: input.receivedAt,
          runId,
        })),
        { role: "assistant", content: assistantHistoryText, timestamp: capturedAt, runId },
      ],
    };
}

function composeUserMemoryText(initial: string, liveInputs: readonly AppliedLiveInput[]): string {
  if (liveInputs.length === 0) return initial;
  return [
    initial,
    ...liveInputs.map((input, index) => `Live follow-up ${index + 1}:\n${input.text}`),
  ].join("\n\n");
}

/**
 * Persists additive memory after durable conversation history commits.
 * userMessage is the redacted persistence text, never the provider-expanded
 * attachment prompt.
 */
export async function persistSuccessfulMemory(
  harnessOptions: AgentHarnessOptions,
  conversationId: string,
  userMessage: string,
  assistantText: string,
  persistenceOptions: {
    readonly runId: string;
    readonly source?: string;
    readonly emit?: (event: RuntimeEventLike) => void;
  },
): Promise<void> {
    const mode = harnessOptions.memoryWriteMode;
    if (harnessOptions.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      if (shouldSkipMemoryPersistence(userMessage, assistantText, persistenceOptions)) {
        return;
      }
      const memory = harnessOptions.memory;
      const summary = deterministicHostSummary(userMessage, assistantText, persistenceOptions);
      try {
        const persistCompletedTurn = memory.persistCompletedTurn;
        if (persistCompletedTurn !== undefined) {
          // A strong store owns the entire write. Its stable run id makes a
          // retry idempotent, and awaiting it keeps successful completion behind
          // the store's admission boundary without replaying either legacy call.
          await persistCompletedTurn.call(memory, {
            runId: persistenceOptions.runId,
            conversationId,
            summary,
            ...(mode === "capture"
              ? { captureText: captureTurnText(userMessage, assistantText, persistenceOptions) }
              : {}),
          });
        } else {
          // Legacy stores retain the deterministic rapid log plus optional
          // best-effort curation queue exactly as before.
          await memory.appendHostSummary(conversationId, summary);
          if (mode === "capture") {
            memory.scheduleCapture?.(conversationId, captureTurnText(userMessage, assistantText, persistenceOptions));
          }
        }
      } catch {
        // The provider answer already succeeded. Memory is additive and must
        // never retroactively turn that answer into a failed turn. Keep this
        // diagnostic constant: backend errors can contain secrets, paths,
        // model content, hostile accessors, or control characters.
        const message = MEMORY_PERSISTENCE_WARNING;
        try {
          persistenceOptions.emit?.({
            type: "runtime_warning",
            warning_kind: "memory_persistence_degraded",
            message,
          });
        } catch {
          // User event callbacks are untrusted and cannot fail the turn.
        }
        try {
          harnessOptions.onMemoryWarning?.(message);
        } catch {
          // Host diagnostics are best-effort.
        }
      }
    }
}

function deterministicHostSummary(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): string {
  if (isTriggerSource(options.source)) {
    return [
      "Host-observed completed trigger turn.",
      `Assistant: ${compactOneLine(assistantText, 240)}`,
    ].join("\n");
  }
  return [
    "Host-observed completed turn.",
    `User: ${compactOneLine(userMessage, 240)}`,
    `Assistant: ${compactOneLine(assistantText, 240)}`,
  ].join("\n");
}

function captureTurnText(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): string {
  // Richer than the compacted host summary: the distiller wants the real turn content.
  if (isTriggerSource(options.source)) {
    return `Assistant: ${assistantText}`;
  }
  return `User: ${userMessage}\nAssistant: ${assistantText}`;
}

function isTriggerSource(source: string | undefined): boolean {
  return source === "cron" || source === "webhook";
}

const MAX_TRIVIAL_MEMORY_TURN_CHARS = 48;
const TRIVIAL_MEMORY_ANCHOR_TOKENS = new Set([
  "ping",
  "pong",
  "test",
  "testing",
]);
const TRIVIAL_MEMORY_FILLER_TOKENS = new Set([
  "ok",
  "okay",
  "works",
]);

function shouldSkipMemoryPersistence(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): boolean {
  return isNothingToReportSentinel(assistantText) || isTrivialMemoryTurn(userMessage, assistantText, options);
}

function isNothingToReportSentinel(assistantText: string): boolean {
  return assistantText.trim().toUpperCase() === NOTHING_TO_REPORT_SENTINEL;
}

function isTrivialMemoryTurn(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): boolean {
  const candidate = isTriggerSource(options.source) ? assistantText : `${userMessage} ${assistantText}`;
  const compact = candidate.replace(/\s+/gu, " ").trim();
  if (compact.length === 0 || compact.length > MAX_TRIVIAL_MEMORY_TURN_CHARS) {
    return false;
  }
  const tokens = compact
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  return (
    tokens.some((token) => TRIVIAL_MEMORY_ANCHOR_TOKENS.has(token)) &&
    tokens.every((token) => TRIVIAL_MEMORY_ANCHOR_TOKENS.has(token) || TRIVIAL_MEMORY_FILLER_TOKENS.has(token))
  );
}
