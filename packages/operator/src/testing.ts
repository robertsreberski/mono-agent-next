import { reduceOperatorFrames, initialOperatorState, type OperatorConversationState } from "./state.js";
import {
  OPERATOR_PROTOCOL,
  type OperatorAskAnswerRequest,
  type OperatorFrame,
  type OperatorInfo,
  type OperatorTurnRequest,
} from "./types.js";

export const FIXTURE_CAPABILITIES = Object.freeze({
  attachments: true,
  liveInput: true,
  askUser: true,
  cancellation: true,
  quotes: true,
  runtimeOverrides: true,
  proactive: true,
  configView: true,
  replay: true,
  health: true,
});

export const VALID_OPERATOR_INFO: OperatorInfo = Object.freeze({
  protocol: OPERATOR_PROTOCOL,
  agent: { id: "fixture-agent", label: "Fixture Agent" },
  process: { pid: 42, startedAt: "2026-01-02T03:04:05.000Z" },
  capabilities: FIXTURE_CAPABILITIES,
  defaults: { runtime: "pi", model: "fixture:model", effort: "medium" },
  models: [{ id: "fixture:model", efforts: ["low", "medium", "high"], contextWindow: 128_000 }],
});

export const VALID_TURN_REQUEST: OperatorTurnRequest = Object.freeze({
  conversationId: "fixture-conversation",
  input: { text: "Hello from the operator fixture." },
});

export const VALID_TURN_FRAMES: readonly OperatorFrame[] = Object.freeze([
  { type: "accepted", turnId: "fixture-turn", conversationId: "fixture-conversation", startedAt: "2026-01-02T03:04:06.000Z" },
  { type: "capabilities", turnId: "fixture-turn", capabilities: FIXTURE_CAPABILITIES },
  { type: "activity", turnId: "fixture-turn", text: "Calling a fixture tool" },
  { type: "delta", turnId: "fixture-turn", target: "thought", text: "Checking " },
  { type: "delta", turnId: "fixture-turn", target: "thought", text: "the fixture." },
  { type: "delta", turnId: "fixture-turn", target: "assistant", text: "Hello" },
  { type: "delta", turnId: "fixture-turn", target: "assistant", text: "Hello fixture", mode: "replace" },
  { type: "usage", turnId: "fixture-turn", usage: { inputTokens: 12, outputTokens: 3, contextWindow: 128_000, contextUsed: 15, compacted: false, sessionEvicted: false } },
  { type: "completed", turnId: "fixture-turn", finalMessage: { id: "fixture-message", role: "assistant", text: "Hello fixture", createdAt: "2026-01-02T03:04:07.000Z" }, finishedAt: "2026-01-02T03:04:07.000Z", stopReason: "completed" },
]);

export const ASK_USER_TURN_FRAMES: readonly OperatorFrame[] = Object.freeze([
  { type: "accepted", turnId: "ask-turn", conversationId: "fixture-conversation", startedAt: "2026-01-02T03:04:06.000Z" },
  { type: "ask_user", turnId: "ask-turn", ask: { interactionId: "interaction-1", requestedAt: "2026-01-02T03:04:06.500Z", questions: [{ id: "choice", prompt: "Choose one", choices: [{ value: "one", label: "One" }], allowFreeText: true, multiple: false }] } },
  { type: "completed", turnId: "ask-turn", finalMessage: { role: "assistant", text: "Choice recorded." }, finishedAt: "2026-01-02T03:04:07.000Z", stopReason: "completed" },
]);

/** Shared product-parity fixture for a bounded, multi-question AskUser turn. */
export const MULTI_QUESTION_ASK_USER_TURN_FRAMES: readonly OperatorFrame[] = Object.freeze([
  { type: "accepted", turnId: "multi-ask-turn", conversationId: "fixture-conversation", startedAt: "2026-01-02T03:04:06.000Z" },
  { type: "capabilities", turnId: "multi-ask-turn", capabilities: FIXTURE_CAPABILITIES },
  {
    type: "ask_user",
    turnId: "multi-ask-turn",
    ask: {
      interactionId: "interaction-multi",
      requestedAt: "2026-01-02T03:04:06.500Z",
      questions: [
        {
          id: "constructor",
          prompt: "Choose a priority",
          choices: [
            { value: "speed", label: "Speed" },
            { value: "quality,first;path\\strict", label: "Quality" },
          ],
          allowFreeText: false,
          multiple: false,
        },
        {
          id: "checks",
          prompt: "Choose checks",
          choices: [
            { value: "tests", label: "Tests" },
            { value: "types", label: "Types" },
          ],
          allowFreeText: true,
          multiple: true,
        },
      ],
    },
  },
  { type: "completed", turnId: "multi-ask-turn", finalMessage: { role: "assistant", text: "Answers recorded." }, finishedAt: "2026-01-02T03:04:07.000Z", stopReason: "completed" },
]);

/** One lossless answer shared by the TUI and web product parity proofs. */
export const MULTI_QUESTION_ASK_USER_ANSWER: OperatorAskAnswerRequest = Object.freeze({
  interactionId: "interaction-multi",
  answers: Object.freeze({
    constructor: Object.freeze(["quality,first;path\\strict"]),
    checks: Object.freeze(["tests", "custom, review; C:\\tmp"]),
  }),
});

export const MALFORMED_OPERATOR_FRAMES: readonly unknown[] = Object.freeze([
  { type: "unknown", turnId: "fixture-turn" },
  { type: "delta", turnId: "fixture-turn", target: "assistant", text: "ok", extra: true },
  { type: "completed", turnId: "fixture-turn", finalMessage: { role: "user", text: "wrong role" }, finishedAt: "not-a-date", stopReason: "completed" },
]);

export function reduceFixture(
  frames: Iterable<OperatorFrame> = VALID_TURN_FRAMES,
  conversationId = "fixture-conversation",
): OperatorConversationState {
  return reduceOperatorFrames(initialOperatorState(conversationId), frames);
}
