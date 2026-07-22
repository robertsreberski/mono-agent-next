import type { ChannelAskSnapshot, ChannelInteractionSink } from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startInteractionBridge, type InteractionBridgeHandle } from "../interaction-bridge.js";

const handles: InteractionBridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => await handle.stop()));
});

function questions() {
  return [
    {
      header: "Delivery",
      question: "What should I do with the draft?",
      options: [
        { label: "Send", description: "Send the draft now." },
        { label: "Skip", description: "Leave it unsent." },
        { label: "Revise", description: "Keep working on the wording." },
      ],
    },
    {
      header: "Follow-up",
      question: "Which follow-ups should be included?",
      options: [
        { label: "Owner", description: "Identify the responsible owner." },
        { label: "Deadline", description: "Include the expected deadline." },
      ],
      multiSelect: true,
    },
  ];
}

async function createHarness(timeoutMs = 5_000): Promise<{
  handle: InteractionBridgeHandle;
  presented: ChannelAskSnapshot[];
  updated: ChannelAskSnapshot[];
}> {
  const presented: ChannelAskSnapshot[] = [];
  const updated: ChannelAskSnapshot[] = [];
  const handle = await startInteractionBridge({ askTimeoutMs: timeoutMs });
  handles.push(handle);
  const sink: ChannelInteractionSink = {
    presentAsk: async (_conversationId, snapshot) => { presented.push(snapshot); },
    updateAsk: async (_conversationId, snapshot) => { updated.push(snapshot); },
    postStatus: async () => undefined,
  };
  handle.registerSink("web", sink);
  return { handle, presented, updated };
}

async function createAsk(handle: InteractionBridgeHandle, body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${handle.url}/v1/asks`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function pollAsk(handle: InteractionBridgeHandle, interactionId: string): Promise<ChannelAskSnapshot> {
  const response = await fetch(`${handle.url}/v1/asks/${encodeURIComponent(interactionId)}`, {
    headers: { authorization: `Bearer ${handle.token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as ChannelAskSnapshot;
}

describe("structured AskUser interaction bridge", () => {
  it("presents 1-5 structured questions and atomically accepts all remaining web answers", async () => {
    const { handle, presented, updated } = await createHarness();
    const created = await createAsk(handle, {
      conversationId: "web:thread-1",
      producerConversationId: "producer:daily#2026-07-21",
      runId: "run-1",
      message: "Morning briefing and reply draft",
      questions: questions(),
    });
    expect(created.status).toBe(201);
    const interactionId = created.body.interactionId as string;
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({
      interactionId,
      message: "Morning briefing and reply draft",
      activeQuestionIndex: 0,
      status: "pending",
    });
    expect(presented[0]?.questions).toHaveLength(2);
    expect(presented[0]?.questions[0]?.options).toHaveLength(3);

    const snapshot = handle.getPendingAsk("web:thread-1");
    const first = snapshot!.questions[0]!;
    const second = snapshot!.questions[1]!;
    const submitted = await handle.submitAskAnswers({
      conversationId: "web:thread-1",
      interactionId,
      answers: [
        { questionId: first.id, selectedOptionIds: [first.options[0]!.id] },
        {
          questionId: second.id,
          selectedOptionIds: [second.options[0]!.id, second.options[1]!.id],
          customReply: "Also mention risk",
        },
      ],
    });
    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot?.status).toBe("answered");
    expect(handle.getPendingAsk("web:thread-1")).toBeUndefined();
    expect(updated.at(-1)?.status).toBe("answered");
    expect((await pollAsk(handle, interactionId)).answers).toHaveLength(2);

    const history = handle.enrichAssistantHistory({
      runId: "run-1",
      conversationId: "producer:daily#2026-07-21",
      assistantText: "Done.",
    });
    expect(history).toContain("Tool: AskUser");
    expect(history).toContain("Send");
    expect(history).toContain("Also mention risk");
  });

  it("advances native channels one question at a time and rejects non-contiguous answers", async () => {
    const { handle, updated } = await createHarness();
    const created = await createAsk(handle, {
      conversationId: "web:thread-2",
      producerConversationId: "web:thread-2",
      questions: questions(),
    });
    const interactionId = created.body.interactionId as string;
    const initial = handle.getPendingAsk("web:thread-2")!;
    const invalid = await handle.submitAskAnswers({
      conversationId: "web:thread-2",
      interactionId,
      answers: [{ questionId: initial.questions[1]!.id, selectedOptionIds: [initial.questions[1]!.options[0]!.id] }],
    });
    expect(invalid).toMatchObject({ accepted: false, code: "invalid_answer" });

    const first = await handle.submitAskAnswers({
      conversationId: "web:thread-2",
      interactionId,
      answers: [{ questionId: initial.questions[0]!.id, selectedOptionIds: [initial.questions[0]!.options[1]!.id] }],
    });
    expect(first.snapshot).toMatchObject({ status: "pending", activeQuestionIndex: 1 });
    expect(updated.at(-1)?.activeQuestionIndex).toBe(1);

    const secondQuestion = first.snapshot!.questions[1]!;
    const second = await handle.submitAskAnswers({
      conversationId: "web:thread-2",
      interactionId,
      answers: [{ questionId: secondQuestion.id, selectedOptionIds: [], customReply: "No follow-up" }],
    });
    expect(second.snapshot?.status).toBe("answered");
  });

  it("rejects the removed free-text contract and all out-of-bound structured shapes", async () => {
    const { handle, presented } = await createHarness();
    const legacy = await createAsk(handle, { conversationId: "web:legacy", question: "Proceed?" });
    expect(legacy.status).toBe(400);

    const invalidShapes = [
      [],
      Array.from({ length: 6 }, () => questions()[0]),
      [{ ...questions()[0], header: "thirteen chars" }],
      [{ ...questions()[0], options: [{ label: "Only", description: "One option" }] }],
      [{ ...questions()[0], options: questions()[0]!.options.map((option) => ({ ...option, description: "" })) }],
    ];
    for (const [index, invalidQuestions] of invalidShapes.entries()) {
      const response = await createAsk(handle, {
        conversationId: `web:invalid-${String(index)}`,
        questions: invalidQuestions,
      });
      expect(response.status).toBe(400);
    }
    expect(presented).toHaveLength(0);
  });

  it("validates selections atomically and rejects stale interaction ids", async () => {
    const { handle } = await createHarness();
    const created = await createAsk(handle, {
      conversationId: "web:thread-3",
      questions: [questions()[0]],
    });
    const snapshot = handle.getPendingAsk("web:thread-3")!;
    const question = snapshot.questions[0]!;
    expect(await handle.submitAskAnswers({
      conversationId: "web:thread-3",
      interactionId: "ask-stale",
      answers: [{ questionId: question.id, selectedOptionIds: [question.options[0]!.id] }],
    })).toMatchObject({ accepted: false, code: "stale" });
    expect(await handle.submitAskAnswers({
      conversationId: "web:thread-3",
      interactionId: created.body.interactionId as string,
      answers: [{ questionId: question.id, selectedOptionIds: [question.options[0]!.id, question.options[1]!.id] }],
    })).toMatchObject({ accepted: false, code: "invalid_answer" });
    expect(handle.getPendingAsk("web:thread-3")?.answers).toEqual([]);
  });

  it("expires pending interactions and returns partial answers to the waiting tool", async () => {
    const { handle, updated } = await createHarness(1_000);
    const created = await createAsk(handle, { conversationId: "web:timeout", questions: questions() });
    const interactionId = created.body.interactionId as string;
    const snapshot = handle.getPendingAsk("web:timeout")!;
    await handle.submitAskAnswers({
      conversationId: "web:timeout",
      interactionId,
      answers: [{ questionId: snapshot.questions[0]!.id, selectedOptionIds: [snapshot.questions[0]!.options[0]!.id] }],
    });
    await vi.waitFor(() => expect(updated.at(-1)?.status).toBe("expired"), { timeout: 3_000, interval: 10 });
    const terminal = await pollAsk(handle, interactionId);
    expect(terminal.status).toBe("expired");
    expect(terminal.answers).toHaveLength(1);
  });
});
