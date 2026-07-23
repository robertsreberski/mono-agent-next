import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgentAdmissionError,
  RunExecutionError,
  type AgentAdmissionErrorCode,
  type AgentHost,
  type AgentInteractionEvidence,
  type AgentResponse,
  type AgentResponseMessage,
  type AgentRunEvent,
  type AgentRunHistoryPage,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentTranscriptEntry,
} from "../index.js";

describe("Core public execution contracts", () => {
  it("exposes bounded run and transcript inspection shapes", () => {
    expectTypeOf<AgentResponse["requestId"]>().toEqualTypeOf<string>();
    expectTypeOf<AgentResponse["runId"]>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<AgentResponse["message"]>>()
      .toEqualTypeOf<AgentResponseMessage>();
    expectTypeOf<AgentResponseMessage["role"]>().toEqualTypeOf<"assistant">();
    expectTypeOf<AgentResponseMessage["content"][number]["type"]>()
      .toEqualTypeOf<"text">();
    expectTypeOf<AgentRunStatus>().toEqualTypeOf<
      "running" | "completed" | "cancelled" | "max-turns" | "failed" | "uncertain"
    >();
    expectTypeOf<AgentHost["listRuns"]>().toEqualTypeOf<
      (cursor?: string) => Promise<AgentRunHistoryPage>
    >();
    expectTypeOf<AgentHost["readRun"]>().toEqualTypeOf<
      (runId: string) => Promise<AgentRunRecord | undefined>
    >();

    const interaction: AgentInteractionEvidence = {
      kind: "ask-user",
      interactionId: "ask-1",
      phase: "answered",
      requestedAt: "2026-07-23T00:00:00.000Z",
      settledAt: "2026-07-23T00:00:01.000Z",
      questionCount: 1,
      answeredQuestionCount: 1,
    };
    const transcript: AgentTranscriptEntry = {
      kind: "interaction",
      entryId: "entry-1",
      runId: "run-1",
      requestId: "request-1",
      conversationId: "conversation-1",
      recordedAt: "2026-07-23T00:00:01.000Z",
      evidence: interaction,
      content: [{ type: "text", text: "Question answered by the user." }],
    };
    const event: AgentRunEvent = {
      type: "interaction",
      runId: "run-1",
      sequence: 2,
      recordedAt: "2026-07-23T00:00:01.000Z",
      evidence: interaction,
    };

    expect(transcript.kind).toBe("interaction");
    expect(event.type).toBe("interaction");
    expect("answers" in interaction).toBe(false);
  });

  it.each<AgentAdmissionErrorCode>([
    "not_accepting",
    "capacity_exceeded",
    "request_conflict",
    "request_in_progress",
    "stale_admission",
    "uncertain_admission",
  ])("carries the stable %s admission code", (code) => {
    const error = new AgentAdmissionError(code, "Admission rejected.", {
      requestId: "request-1",
      runId: "run-1",
    });

    expect(error).toMatchObject({
      name: "AgentAdmissionError",
      code,
      requestId: "request-1",
      runId: "run-1",
      message: "Admission rejected.",
    });
  });

  it("exposes typed failure authority for safe submit retries", () => {
    const cause = new Error("provider details");
    const error = new RunExecutionError(
      "uncertain",
      "settlement-failed",
      "Settlement could not be proven.",
      {
        cause,
        requestId: "request-1",
        runId: "run-1",
      },
    );

    expect(error).toMatchObject({
      name: "RunExecutionError",
      status: "uncertain",
      failureCode: "settlement-failed",
      requestId: "request-1",
      runId: "run-1",
      cause,
    });
  });
});
