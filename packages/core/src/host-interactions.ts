// SPDX-License-Identifier: MIT
import {
  DEFAULT_APPROVAL_TIMEOUT_MS, parseApprovalDecision, parseApprovalRequest, parseAskUserAnswer,
  parseAskUserRequest,
  type ApprovalDecision, type ApprovalRequest, type AskUserAnswer, type AskUserRequest,
  type RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";
import {
  abortError, throwIfAborted, waitForValueWithAbort, withTimeoutSignal,
} from "./host-lifecycle.js";
import { renderAskUserAnswer, renderAskUserRequest } from "./host-transcript.js";
import { ActiveTurn, turnExecutionError } from "./host-turn.js";
import { normalizeLiveInput } from "./host-submit-input.js";
import { sameStringSet } from "./host-values.js";
import { nativeToolAllowed } from "./native-tool-policy.js";
import type {
  AgentApprovalAnswer, AgentApprovalAnswerStatus, AgentAskAnswer, AgentAskAnswerStatus,
  AgentInteractionEvidence, AgentLiveInput, AgentLiveInputStatus, AgentSubmitInput,
  LoadedAgentConfig, RuntimeRoute,
} from "./types.js";

const DEFAULT_LIVE_INPUT_ACK_TIMEOUT_MS = 5_000;

type AskEvidence = Extract<AgentInteractionEvidence, { readonly kind: "ask-user" }>;
type ApprovalEvidence = Extract<AgentInteractionEvidence, { readonly kind: "approval" }>;

interface InteractionContext {
  readonly config: LoadedAgentConfig;
  readonly lifecycleTimeoutMs: number;
  readonly hostSignal: AbortSignal;
  activeTurn(conversationId: string): ActiveTurn | undefined;
  appendEvidence(
    input: AgentSubmitInput,
    active: ActiveTurn,
    evidence: AgentInteractionEvidence,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Owns the model-visible interaction protocols: AskUser, approvals, and live
 * input. Every phase transition is recorded as interaction evidence before the
 * decision is returned, so an operator can reconstruct what was asked and when.
 */
export class HostInteractions {
  constructor(private readonly context: InteractionContext) {}

  async answerAsk(conversationId: string, answer: AgentAskAnswer): Promise<AgentAskAnswerStatus> {
    const active = this.context.activeTurn(conversationId);
    return active === undefined ? "expired" : active.answerAsk(answer);
  }

  async answerApproval(
    conversationId: string,
    decision: AgentApprovalAnswer,
  ): Promise<AgentApprovalAnswerStatus> {
    const active = this.context.activeTurn(conversationId);
    return active === undefined ? "expired" : active.answerApproval(decision);
  }

  async offerLiveInput(
    conversationId: string,
    input: AgentLiveInput,
    suppliedSignal?: AbortSignal,
  ): Promise<AgentLiveInputStatus> {
    const active = this.context.activeTurn(conversationId);
    if (active?.liveInput === undefined) return "unavailable";
    const handler = active.liveInput;
    const normalizedInput = normalizeLiveInput(input);
    const turnInput: AgentSubmitInput = {
      requestId: active.requestId, conversationId, text: "",
    };
    const requeue = async (
      failureCode: string,
      message: string,
      cause: unknown,
    ): Promise<"requeue"> => {
      const settledAt = new Date().toISOString();
      await this.context.appendEvidence(
        turnInput,
        active,
        {
          kind: "live-input", interactionId: normalizedInput.id, phase: "requeued",
          receivedAt: normalizedInput.receivedAt, settledAt,
        },
        normalizedInput.text,
        AbortSignal.timeout(this.context.lifecycleTimeoutMs),
      ).catch(() => undefined);
      active.controller.abort(turnExecutionError(
        "uncertain", failureCode, message, turnInput, active, cause,
      ));
      return "requeue";
    };
    const signal = AbortSignal.any([
      this.context.hostSignal,
      active.controller.signal,
      ...(suppliedSignal === undefined ? [] : [suppliedSignal]),
    ]);
    throwIfAborted(signal);
    let result: unknown;
    try {
      result = await withTimeoutSignal(
        (boundedSignal) => waitForValueWithAbort(
          Promise.resolve().then(() => handler(normalizedInput, boundedSignal)),
          boundedSignal,
        ),
        Math.min(this.context.lifecycleTimeoutMs, DEFAULT_LIVE_INPUT_ACK_TIMEOUT_MS),
        signal,
        "Runtime live-input acknowledgement",
      );
    } catch (error) {
      if (this.context.hostSignal.aborted || suppliedSignal?.aborted === true) {
        throw abortError("Runtime live-input acknowledgement was aborted");
      }
      return requeue(
        "live-input-acknowledgement-unknown",
        "Runtime live-input acknowledgement failed after dispatch",
        error,
      );
    }
    if (result !== "applied" && result !== "requeue" && result !== "discarded") {
      const invalid = new TypeError("Runtime live-input handler returned an invalid disposition");
      return requeue("live-input-disposition-invalid", invalid.message, invalid);
    }
    const settledAt = new Date().toISOString();
    const evidence: AgentInteractionEvidence = {
      kind: "live-input",
      interactionId: normalizedInput.id,
      phase: result === "requeue"
        ? "requeued"
        : result === "discarded"
          ? "discarded"
          : "applied",
      receivedAt: normalizedInput.receivedAt,
      settledAt,
    };
    try {
      await this.context.appendEvidence(turnInput, active, evidence, normalizedInput.text, signal);
    } catch (error) {
      active.controller.abort(
        error instanceof Error
          ? error
          : new Error("Live-input evidence could not be recorded"),
      );
      throw error;
    }
    return result;
  }

  async askUser(
    input: AgentSubmitInput,
    active: ActiveTurn,
    route: RuntimeRoute,
    request: AskUserRequest,
    signal: AbortSignal,
    emitAsk: ((request: AskUserRequest) => Promise<void>) | undefined,
  ): Promise<AskUserAnswer> {
    throwIfAborted(signal);
    const parsedRequest = parseAskUserRequest(request);
    await this.context.appendEvidence(
      input, active,
      askEvidence("requested", parsedRequest),
      renderAskUserRequest(parsedRequest), signal,
    );
    let parsedAnswer: AskUserAnswer;
    try {
      parsedAnswer = input.interactionHandler !== undefined
        ? parseAskUserAnswer(
            await waitForValueWithAbort(
              Promise.resolve().then(() => input.interactionHandler!.askUser(parsedRequest, {
                conversationId: input.conversationId,
                turnId: active.id,
                route: { runtimeInstanceId: route.runtime, model: route.model },
                signal,
              })),
              signal,
            ),
            parsedRequest,
          )
        : emitAsk === undefined
          ? (() => {
              throw new Error("AskUser interaction handler is unavailable");
            })()
          : await active.waitForAsk(parsedRequest, signal, emitAsk);
    } catch (error) {
      await this.context.appendEvidence(
        input, active,
        askEvidence(signal.aborted ? "cancelled" : "expired", parsedRequest, new Date().toISOString()),
        signal.aborted
          ? "AskUser interaction cancelled."
          : "AskUser interaction expired without an answer.",
        this.#settlementSignal(),
      );
      throw error;
    }
    await this.context.appendEvidence(
      input, active,
      askEvidence(
        "answered", parsedRequest, parsedAnswer.answeredAt,
        Object.keys(parsedAnswer.answers).length,
      ),
      renderAskUserAnswer(parsedRequest, parsedAnswer), signal,
    );
    return parsedAnswer;
  }

  async runtimeApproval(
    input: AgentSubmitInput,
    active: ActiveTurn,
    route: RuntimeRoute,
    nativeTools: readonly RuntimeNativeToolDescriptor[],
    request: ApprovalRequest,
    signal: AbortSignal,
    emitApproval: ((request: ApprovalRequest) => Promise<void>) | undefined,
  ): Promise<ApprovalDecision> {
    const parsedRequest = parseApprovalRequest(request);
    const descriptor = nativeTools.find((tool) => tool.id === parsedRequest.toolId);
    if (descriptor === undefined || descriptor.approval !== "core-callback") {
      throw new Error(
        `Runtime approval request ${parsedRequest.toolId} is not bound to a core-callback native tool`,
      );
    }
    if (
      parsedRequest.displayName !== descriptor.displayName
      || !sameStringSet(parsedRequest.effects, descriptor.effects)
    ) {
      throw new Error(
        `Runtime approval request ${parsedRequest.toolId} does not match its advertised authority`,
      );
    }
    let automatic:
      | { readonly decision: "allow_once" | "deny"; readonly reason: string }
      | undefined;
    if (!nativeToolAllowed(descriptor.id, this.context.config.raw, input.toolPolicy)) {
      automatic = { decision: "deny", reason: "denied by the effective Core tool policy" };
    } else if (this.context.config.raw.policy.approvals.default === "deny") {
      automatic = { decision: "deny", reason: "denied by the Core approval policy" };
    } else if (this.context.config.raw.policy.approvals.default === "allow") {
      automatic = { decision: "allow_once", reason: "allowed by the Core approval policy" };
    }
    return this.approval(input, active, route, parsedRequest, signal, emitApproval, automatic);
  }

  async approval(
    input: AgentSubmitInput,
    active: ActiveTurn,
    route: RuntimeRoute,
    request: ApprovalRequest,
    signal: AbortSignal,
    emitApproval: ((request: ApprovalRequest) => Promise<void>) | undefined,
    automatic?: {
      readonly decision: "allow_once" | "deny";
      readonly reason: string;
    },
  ): Promise<ApprovalDecision> {
    throwIfAborted(signal);
    const parsedRequest = parseApprovalRequest(request);
    await this.context.appendEvidence(
      input, active,
      approvalEvidence("requested", parsedRequest),
      `Approval requested for ${parsedRequest.displayName}: ${parsedRequest.summary}`, signal,
    );
    const timeoutMs = this.context.config.raw.policy.approvals.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    let parsedDecision: ApprovalDecision;
    try {
      const decision = automatic === undefined
        ? await withTimeoutSignal(
            async (boundedSignal) => {
              if (input.interactionHandler !== undefined) {
                return input.interactionHandler.requestApproval(parsedRequest, {
                  conversationId: input.conversationId,
                  turnId: active.id,
                  route: { runtimeInstanceId: route.runtime, model: route.model },
                  signal: boundedSignal,
                });
              }
              if (emitApproval === undefined) {
                throw new Error("Approval interaction handler is unavailable");
              }
              return active.waitForApproval(parsedRequest, boundedSignal, emitApproval);
            },
            timeoutMs,
            signal,
            `Approval ${parsedRequest.interactionId}`,
          )
        : {
            interactionId: parsedRequest.interactionId,
            decision: automatic.decision,
            decidedAt: new Date().toISOString(),
            reason: automatic.reason,
          };
      if (decision === undefined) throw new Error("Approval handler returned no decision");
      parsedDecision = parseApprovalDecision(decision, parsedRequest);
    } catch (error) {
      if (signal.aborted) {
        await this.context.appendEvidence(
          input, active,
          approvalEvidence("cancelled", parsedRequest, new Date().toISOString()),
          "Approval interaction cancelled.", this.#settlementSignal(),
        );
        throw abortError();
      }
      parsedDecision = parseApprovalDecision({
        interactionId: parsedRequest.interactionId,
        decision: "deny",
        decidedAt: new Date().toISOString(),
        reason: "approval failed closed",
      }, parsedRequest);
    }
    await this.context.appendEvidence(
      input, active,
      approvalEvidence(
        "answered", parsedRequest, parsedDecision.decidedAt, parsedDecision.decision,
      ),
      `Approval ${parsedDecision.decision === "allow_once" ? "allowed once" : "denied"}.${
        parsedDecision.reason === undefined ? "" : ` Reason: ${parsedDecision.reason}`
      }`, signal,
    );
    return parsedDecision;
  }

  #settlementSignal(): AbortSignal {
    return AbortSignal.timeout(this.context.lifecycleTimeoutMs);
  }
}

/** Builds ask-user evidence with a stable field order across every phase. */
function askEvidence(
  phase: AskEvidence["phase"],
  request: AskUserRequest,
  settledAt?: string,
  answeredQuestionCount?: number,
): AskEvidence {
  return {
    kind: "ask-user",
    interactionId: request.interactionId,
    phase,
    requestedAt: request.requestedAt,
    ...(settledAt === undefined ? {} : { settledAt }),
    questionCount: request.questions.length,
    ...(answeredQuestionCount === undefined ? {} : { answeredQuestionCount }),
  };
}

/** Builds approval evidence with a stable field order across every phase. */
function approvalEvidence(
  phase: ApprovalEvidence["phase"],
  request: ApprovalRequest,
  settledAt?: string,
  decision?: ApprovalDecision["decision"],
): ApprovalEvidence {
  return {
    kind: "approval",
    interactionId: request.interactionId,
    phase,
    requestedAt: request.requestedAt,
    ...(settledAt === undefined ? {} : { settledAt }),
    toolId: request.toolId,
    effects: request.effects,
    ...(decision === undefined ? {} : { decision }),
  };
}
