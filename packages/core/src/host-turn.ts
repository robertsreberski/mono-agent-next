import {
  parseApprovalDecision,
  parseAskUserAnswer,
  type ApprovalDecision,
  type ApprovalRequest,
  type AskUserAnswer,
  type AskUserRequest,
  type RuntimeLiveInputHandler,
} from "@mono-agent/module-sdk";

import type { CurrentRunFiles } from "./current-run-output.js";
import { throwIfAborted, waitForValueWithAbort } from "./host-lifecycle.js";
import type {
  AgentApprovalAnswer,
  AgentApprovalAnswerStatus,
  AgentAskAnswer,
  AgentAskAnswerStatus,
  AgentTranscriptEntry,
  RuntimeRoute,
} from "./types.js";

interface PendingInteraction<Request, Answer> {
  readonly request: Request;
  readonly resolve: (answer: Answer) => void;
  readonly reject: (error: Error) => void;
}

class InteractionSlot<Request extends { readonly interactionId: string }, Answer> {
  #pending: PendingInteraction<Request, Answer> | undefined;

  answer(interactionId: string, parse: (request: Request) => Answer):
  "accepted" | "mismatch" | "expired" {
    const pending = this.#pending;
    if (pending === undefined) return "expired";
    if (pending.request.interactionId !== interactionId) return "mismatch";
    let answer: Answer;
    try { answer = parse(pending.request); } catch { return "mismatch"; }
    this.#pending = undefined;
    pending.resolve(answer);
    return "accepted";
  }

  async wait(
    request: Request,
    signal: AbortSignal,
    emit: (request: Request) => Promise<void>,
    duplicateMessage: string,
  ): Promise<Answer> {
    if (this.#pending !== undefined) throw new Error(duplicateMessage);
    throwIfAborted(signal);
    let pending!: PendingInteraction<Request, Answer>;
    const reply = new Promise<Answer>((resolve, reject) => {
      pending = { request, resolve, reject };
      this.#pending = pending;
    });
    try {
      const [answer] = await waitForValueWithAbort(Promise.all([
        reply,
        Promise.resolve().then(() => emit(request)),
      ]), signal);
      return answer;
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  reject(message: string): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(new Error(message));
  }
}

export class ActiveTurn {
  readonly transcriptEntries: AgentTranscriptEntry[] = [];
  readonly pendingChannelHistory = new Set<string>();
  currentRunFiles: CurrentRunFiles | undefined;
  route?: RuntimeRoute;
  sessionsSupported?: boolean;
  liveInput: RuntimeLiveInputHandler | undefined;
  readonly #ask = new InteractionSlot<AskUserRequest, AskUserAnswer>();
  readonly #approval = new InteractionSlot<ApprovalRequest, ApprovalDecision>();

  constructor(
    readonly id: string,
    readonly requestId: string,
    readonly startedAt: string,
    readonly controller: AbortController,
  ) {}

  answerAsk(answer: AgentAskAnswer): AgentAskAnswerStatus {
    return this.#ask.answer(answer.interactionId, (request) =>
      parseAskUserAnswer({ ...answer, answeredAt: new Date().toISOString() }, request));
  }

  answerApproval(decision: AgentApprovalAnswer): AgentApprovalAnswerStatus {
    return this.#approval.answer(decision.interactionId, (request) =>
      parseApprovalDecision(decision, request));
  }

  waitForAsk(
    request: AskUserRequest,
    signal: AbortSignal,
    emit: (request: AskUserRequest) => Promise<void>,
  ): Promise<AskUserAnswer> {
    return this.#ask.wait(
      request, signal, emit, "Only one AskUser interaction may be pending per turn",
    );
  }

  waitForApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
    emit: (request: ApprovalRequest) => Promise<void>,
  ): Promise<ApprovalDecision> {
    return this.#approval.wait(
      request, signal, emit, "Only one approval interaction may be pending per turn",
    );
  }

  rejectPendingInteractions(): void {
    this.#ask.reject("Runtime attempt settled before AskUser completed");
    this.#approval.reject("Runtime attempt settled before approval completed");
  }
}
