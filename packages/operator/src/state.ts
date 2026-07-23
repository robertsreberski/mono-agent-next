import type {
  OperatorAsk,
  OperatorCapabilities,
  OperatorFrame,
  OperatorMessage,
  OperatorUsage,
  OperatorWireError,
} from "./types.js";

export type OperatorConversationStatus =
  | "idle"
  | "streaming"
  | "awaiting_user"
  | "completed"
  | "cancelled"
  | "error";

export interface OperatorConversationState {
  readonly conversationId: string;
  readonly status: OperatorConversationStatus;
  readonly activeTurnId?: string;
  readonly assistantText: string;
  readonly thoughtText: string;
  readonly activities: readonly string[];
  readonly pendingAsk?: OperatorAsk;
  readonly usage?: OperatorUsage;
  readonly capabilities?: OperatorCapabilities;
  readonly finalMessage?: OperatorMessage & { role: "assistant" };
  readonly lastError?: OperatorWireError;
}

export type OperatorAction =
  | "start_turn"
  | "cancel_turn"
  | "offer_live_input"
  | "answer_ask"
  | "attach"
  | "quote"
  | "set_runtime"
  | "set_model"
  | "set_effort"
  | "view_config"
  | "view_replay"
  | "view_health";

export class OperatorStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorStateError";
  }
}

export function initialOperatorState(conversationId: string): OperatorConversationState {
  if (conversationId.length === 0) throw new OperatorStateError("conversationId must not be empty");
  return {
    conversationId,
    status: "idle",
    assistantText: "",
    thoughtText: "",
    activities: [],
  };
}

function requireTurn(state: OperatorConversationState, frame: Exclude<OperatorFrame, { type: "accepted" | "error" }>): void {
  if (state.activeTurnId === undefined) {
    throw new OperatorStateError(`${frame.type} frame arrived without an active turn`);
  }
  if (frame.turnId !== state.activeTurnId) {
    throw new OperatorStateError(`${frame.type} frame belongs to turn ${frame.turnId}, expected ${state.activeTurnId}`);
  }
}

export function reduceOperatorFrame(state: OperatorConversationState, frame: OperatorFrame): OperatorConversationState {
  switch (frame.type) {
    case "accepted":
      if (frame.conversationId !== state.conversationId) {
        throw new OperatorStateError(`accepted frame belongs to conversation ${frame.conversationId}, expected ${state.conversationId}`);
      }
      if (state.activeTurnId !== undefined) throw new OperatorStateError("accepted frame arrived while another turn is active");
      return {
        conversationId: state.conversationId,
        status: "streaming",
        activeTurnId: frame.turnId,
        assistantText: "",
        thoughtText: "",
        activities: [],
        ...(state.capabilities === undefined ? {} : { capabilities: state.capabilities }),
      };
    case "delta": {
      requireTurn(state, frame);
      const replace = frame.mode === "replace";
      return {
        ...state,
        status: state.pendingAsk === undefined ? "streaming" : "awaiting_user",
        ...(frame.target === "assistant"
          ? { assistantText: replace ? frame.text : state.assistantText + frame.text }
          : { thoughtText: replace ? frame.text : state.thoughtText + frame.text }),
      };
    }
    case "activity":
      requireTurn(state, frame);
      return { ...state, activities: [...state.activities, frame.text] };
    case "ask_user":
      requireTurn(state, frame);
      return { ...state, status: "awaiting_user", pendingAsk: frame.ask };
    case "capabilities":
      requireTurn(state, frame);
      return { ...state, capabilities: frame.capabilities };
    case "usage":
      requireTurn(state, frame);
      return { ...state, usage: mergeUsage(state.usage, frame.usage) };
    case "completed":
      requireTurn(state, frame);
      {
        const { activeTurnId: _activeTurnId, pendingAsk: _pendingAsk, lastError: _lastError, ...settled } = state;
      return {
        ...settled,
        status: "completed",
        assistantText: frame.finalMessage.text,
        finalMessage: frame.finalMessage,
      };
      }
    case "error":
      if (frame.turnId !== undefined && state.activeTurnId !== frame.turnId) {
        throw new OperatorStateError(`error frame belongs to turn ${frame.turnId}, expected ${state.activeTurnId ?? "none"}`);
      }
      {
        const { activeTurnId: _activeTurnId, pendingAsk: _pendingAsk, ...settled } = state;
      return {
        ...settled,
        status: frame.cancelled ? "cancelled" : "error",
        lastError: frame.error,
      };
      }
  }
}

function mergeUsage(
  previous: OperatorUsage | undefined,
  next: OperatorUsage,
): OperatorUsage {
  return {
    inputTokens: next.inputTokens,
    outputTokens: next.outputTokens,
    ...(next.contextWindow !== undefined
      ? { contextWindow: next.contextWindow }
      : previous?.contextWindow === undefined
        ? {}
        : { contextWindow: previous.contextWindow }),
    ...(next.contextUsed !== undefined
      ? { contextUsed: next.contextUsed }
      : previous?.contextUsed === undefined
        ? {}
        : { contextUsed: previous.contextUsed }),
    compacted: previous?.compacted === true || next.compacted,
    sessionEvicted: previous?.sessionEvicted === true || next.sessionEvicted,
  };
}

export function reduceOperatorFrames(
  initial: OperatorConversationState,
  frames: Iterable<OperatorFrame>,
): OperatorConversationState {
  let state = initial;
  for (const frame of frames) state = reduceOperatorFrame(state, frame);
  return state;
}

export function availableOperatorActions(
  state: OperatorConversationState,
  capabilities: OperatorCapabilities = state.capabilities ?? {
    attachments: false,
    liveInput: false,
    askUser: false,
    cancellation: false,
    quotes: false,
    runtimeOverrides: false,
    proactive: false,
    configView: false,
    replay: false,
    health: false,
  },
): readonly OperatorAction[] {
  const active = state.activeTurnId !== undefined;
  const actions: OperatorAction[] = [];
  if (!active) actions.push("start_turn");
  if (active && capabilities.cancellation) actions.push("cancel_turn");
  if (active && capabilities.liveInput) actions.push("offer_live_input");
  if (state.pendingAsk !== undefined && capabilities.askUser) actions.push("answer_ask");
  if (!active && capabilities.attachments) actions.push("attach");
  if (!active && capabilities.quotes) actions.push("quote");
  if (!active && capabilities.runtimeOverrides) actions.push("set_runtime", "set_model", "set_effort");
  if (capabilities.configView) actions.push("view_config");
  if (capabilities.replay) actions.push("view_replay");
  if (capabilities.health) actions.push("view_health");
  return actions;
}
