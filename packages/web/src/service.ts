import type {
  OperatorAskAnswerResponse,
  OperatorConfigView,
  OperatorConversationState,
  OperatorHealth,
  OperatorLiveInputResponse,
  OperatorReplayResponse,
} from "@mono-agent/operator";

import type {
  AnswerWebAskInput,
  StartWebTurnInput,
  WebAgent,
  WebBootstrap,
  WebThread,
  WebThreadDetail,
} from "./contracts.js";
import { WEB_API_VERSION } from "./contracts.js";
import { errorMessage, WebProductError } from "./errors.js";
import { DurableWebStore } from "./store.js";

export interface WebOperatorTurnInput extends StartWebTurnInput {
  readonly agentId: string;
  readonly conversationId: string;
  readonly signal: AbortSignal;
  readonly onText: (text: string) => void | Promise<void>;
  readonly onState?: (state: OperatorConversationState) => void | Promise<void>;
}

export interface WebProactiveConversation {
  readonly agentId: string;
  readonly conversationId: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly messages: OperatorReplayResponse["messages"];
}

/** Internal product seam. The production implementation is wholly backed by `@mono-agent/operator`. */
export interface WebOperatorGateway {
  listAgents(): Promise<readonly WebAgent[]>;
  runTurn(input: WebOperatorTurnInput): Promise<void>;
  cancel(agentId: string, conversationId: string): Promise<void>;
  discoverProactiveConversations?(): Promise<readonly WebProactiveConversation[]>;
  answerAsk?(
    agentId: string,
    conversationId: string,
    input: AnswerWebAskInput,
  ): Promise<OperatorAskAnswerResponse>;
  offerLiveInput?(
    agentId: string,
    conversationId: string,
    text: string,
  ): Promise<OperatorLiveInputResponse>;
  readReplay?(agentId: string, conversationId: string): Promise<OperatorReplayResponse>;
  readConfig?(agentId: string): Promise<OperatorConfigView>;
  readHealth?(agentId: string): Promise<OperatorHealth>;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly controller: AbortController;
  readonly completion: Promise<WebThreadDetail>;
  readonly resolve: (detail: WebThreadDetail) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  forced: boolean;
}

export interface WebServiceOptions {
  readonly shutdownTimeoutMs?: number;
}

export class WebService {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly shutdownTimeoutMs: number;
  private stopped = false;

  constructor(
    readonly store: DurableWebStore,
    private readonly gateway: WebOperatorGateway,
    options: WebServiceOptions = {},
  ) {
    this.shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs ?? 1_000);
  }

  async bootstrap(): Promise<WebBootstrap> {
    const newProactiveThreadIds: string[] = [];
    for (const conversation of await this.gateway.discoverProactiveConversations?.() ?? []) {
      if (this.store.findThreadByOperatorConversation(conversation.agentId, conversation.conversationId) !== undefined) {
        continue;
      }
      const imported = await this.store.importProactiveConversation(conversation);
      if (imported.created) newProactiveThreadIds.push(imported.thread.id);
    }
    return {
      version: WEB_API_VERSION,
      agents: await this.gateway.listAgents(),
      threads: this.store.listThreads(),
      newProactiveThreadIds,
    };
  }

  async createThread(agentId: string, title?: string): Promise<WebThread> {
    const agent = (await this.gateway.listAgents()).find((candidate) => candidate.id === agentId);
    if (agent === undefined) throw new WebProductError("agent_not_found", "Agent not found.", 404);
    if (!agent.online) throw new WebProductError("agent_offline", "Agent is offline.", 409);
    return this.store.createThread(agentId, title);
  }

  thread(id: string): WebThreadDetail {
    const detail = this.store.getThreadDetail(id);
    if (detail === undefined) throw new WebProductError("thread_not_found", "Conversation not found.", 404);
    return detail;
  }

  async deleteThread(id: string): Promise<void> {
    this.thread(id);
    if (this.active.has(id)) {
      throw new WebProductError("turn_active", "Cancel the active turn before deleting this conversation.", 409);
    }
    await this.store.deleteThread(id);
  }

  async answerAsk(threadId: string, input: AnswerWebAskInput): Promise<OperatorAskAnswerResponse> {
    const detail = this.thread(threadId);
    const ask = detail.thread.pendingAsk;
    if (ask === undefined) throw new WebProductError("ask_unavailable", "This conversation has no pending AskUser interaction.", 409);
    if (ask.interactionId !== input.interactionId) {
      throw new WebProductError("ask_mismatch", "The AskUser interaction no longer matches this conversation.", 409);
    }
    if (this.gateway.answerAsk === undefined) {
      throw new WebProductError("ask_unsupported", "This operator does not support AskUser answers.", 409);
    }
    const result = await this.gateway.answerAsk(
      detail.thread.agentId,
      operatorConversationId(detail.thread),
      input,
    );
    if (result.status === "accepted") await this.store.clearPendingAsk(threadId);
    return result;
  }

  async offerLiveInput(threadId: string, text: string): Promise<OperatorLiveInputResponse> {
    const detail = this.thread(threadId);
    if (!this.active.has(threadId)) {
      throw new WebProductError("turn_not_active", "This conversation has no active web-owned turn.", 409);
    }
    if (this.gateway.offerLiveInput === undefined) {
      throw new WebProductError("live_input_unsupported", "This operator does not support live input.", 409);
    }
    return this.gateway.offerLiveInput(
      detail.thread.agentId,
      operatorConversationId(detail.thread),
      text,
    );
  }

  async replay(threadId: string): Promise<OperatorReplayResponse> {
    const detail = this.thread(threadId);
    if (this.gateway.readReplay === undefined) {
      throw new WebProductError("replay_unsupported", "This operator does not expose replay.", 409);
    }
    return this.gateway.readReplay(detail.thread.agentId, operatorConversationId(detail.thread));
  }

  async config(agentId: string): Promise<OperatorConfigView> {
    if (this.gateway.readConfig === undefined) {
      throw new WebProductError("config_unsupported", "This operator does not expose a redacted config view.", 409);
    }
    return this.gateway.readConfig(agentId);
  }

  async health(agentId: string): Promise<OperatorHealth> {
    if (this.gateway.readHealth === undefined) {
      throw new WebProductError("health_unsupported", "This operator does not expose health.", 409);
    }
    return this.gateway.readHealth(agentId);
  }

  async runTurn(
    threadId: string,
    input: StartWebTurnInput,
    onUpdate: (detail: WebThreadDetail) => void | Promise<void>,
  ): Promise<WebThreadDetail> {
    if (this.stopped) throw new WebProductError("web_stopping", "The web product is stopping.", 409);
    validateTurnInput(input);
    if (this.active.has(threadId)) throw new WebProductError("turn_active", "This conversation already has an active turn.", 409);
    const before = this.thread(threadId);
    const started = await this.store.startTurn(threadId, input);
    const turnId = started.assistant.turnId!;
    const conversationId = operatorConversationId(before.thread);
    const controller = new AbortController();
    const deferred = createDeferred<WebThreadDetail>();
    const active: ActiveTurn = {
      threadId,
      agentId: before.thread.agentId,
      conversationId,
      turnId,
      controller,
      completion: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      settled: false,
      forced: false,
    };
    // Registration is synchronous immediately after the durable running
    // commit. Cancel and stop can now see the turn even if renderer delivery
    // blocks forever.
    this.active.set(threadId, active);

    const worker = async (): Promise<WebThreadDetail> => {
      try {
        await notify(onUpdate, this.thread(threadId));
        throwIfAborted(controller.signal);
        await this.gateway.runTurn({
          agentId: before.thread.agentId,
          conversationId,
          text: input.text,
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          ...(input.quote === undefined ? {} : { quote: input.quote }),
          ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          signal: controller.signal,
          onText: async (text) => {
            if (active.settled) return;
            await this.store.updateAssistant(threadId, turnId, text, undefined);
            await notify(onUpdate, this.thread(threadId));
          },
          onState: async (state) => {
            if (active.settled) return;
            await this.store.updateAssistant(
              threadId,
              turnId,
              state.assistantText,
              state.pendingAsk,
              state.finalMessage?.id,
              state.usage,
            );
            await notify(onUpdate, this.thread(threadId));
          },
        });
        await this.settle(active, "complete");
      } catch (error) {
        const cancelled = controller.signal.aborted;
        await this.settle(
          active,
          cancelled ? "cancelled" : "failed",
          cancelled ? undefined : { code: errorCode(error), message: errorMessage(error) },
        );
        if (!cancelled && !active.forced) throw error;
      } finally {
        if (this.active.get(threadId) === active) this.active.delete(threadId);
      }
      const detail = this.thread(threadId);
      await notify(onUpdate, detail);
      return detail;
    };
    void worker().then(active.resolve, active.reject);
    return active.completion;
  }

  async cancel(threadId: string): Promise<WebThreadDetail> {
    this.thread(threadId);
    const active = this.active.get(threadId);
    if (active === undefined) return this.thread(threadId);
    active.controller.abort(new Error("Turn cancelled by operator."));
    void this.gateway.cancel(active.agentId, active.conversationId).catch(() => undefined);
    const completed = await within(active.completion, this.shutdownTimeoutMs);
    if (completed !== undefined) return completed;
    return this.forceSettle(active, "cancelled", {
      code: "cancel_timeout",
      message: "Operator cancellation did not settle before the product deadline.",
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const turns = [...this.active.values()];
    for (const turn of turns) turn.controller.abort(new Error("Web product stopped."));
    const draining = turns.map((turn) => {
      void this.gateway.cancel(turn.agentId, turn.conversationId).catch(() => undefined);
      return turn.completion;
    });
    try {
      await within(Promise.allSettled(draining), this.shutdownTimeoutMs);
      for (const turn of turns) {
        if (!turn.settled) {
          await this.forceSettle(turn, "interrupted", {
            code: "shutdown_timeout",
            message: "Operator turn ignored shutdown past the product deadline.",
          });
        }
      }
    } finally {
      await this.store.close();
    }
  }

  private async settle(
    active: ActiveTurn,
    status: "complete" | "failed" | "cancelled" | "interrupted",
    error?: { readonly code: string; readonly message: string },
  ): Promise<void> {
    if (active.settled) return;
    active.settled = true;
    try {
      await this.store.finishTurn(active.threadId, active.turnId, status, error);
    } catch (settleError) {
      active.settled = false;
      throw settleError;
    }
  }

  private async forceSettle(
    active: ActiveTurn,
    status: "cancelled" | "interrupted",
    error: { readonly code: string; readonly message: string },
  ): Promise<WebThreadDetail> {
    active.forced = true;
    await this.settle(active, status, error);
    if (this.active.get(active.threadId) === active) this.active.delete(active.threadId);
    const detail = this.thread(active.threadId);
    active.resolve(detail);
    return detail;
  }
}

function validateTurnInput(input: StartWebTurnInput): void {
  if (
    typeof input.text !== "string"
    || (input.text.trim().length === 0 && (input.attachments?.length ?? 0) === 0)
  ) {
    throw new WebProductError("invalid_turn", "Turn input requires text or an attachment.");
  }
  if (input.text.length > 200_000) throw new WebProductError("invalid_turn", "Turn text exceeds 200,000 characters.", 413);
  if (input.runtime !== undefined && (typeof input.runtime !== "string" || input.runtime.length === 0 || input.runtime.length > 256)) {
    throw new WebProductError("invalid_turn", "Runtime override is invalid.");
  }
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length === 0 || input.model.length > 256)) {
    throw new WebProductError("invalid_turn", "Model override is invalid.");
  }
  if (input.effort !== undefined && (typeof input.effort !== "string" || input.effort.length === 0 || input.effort.length > 64)) {
    throw new WebProductError("invalid_turn", "Effort override is invalid.");
  }
}

function operatorConversationId(thread: WebThread): string {
  return thread.operatorConversationId ?? `web:${thread.id}`;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "operator_turn_failed";
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 30_000) {
    throw new WebProductError("invalid_shutdown_timeout", "shutdownTimeoutMs must be an integer from 10 through 30000.");
  }
  return value;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function notify(
  callback: (detail: WebThreadDetail) => void | Promise<void>,
  detail: WebThreadDetail,
): Promise<void> {
  try {
    await callback(detail);
  } catch {
    // Renderer delivery is best-effort and never owns the service turn.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Turn aborted.");
}
