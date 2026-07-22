import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import type { AskSnapshot } from "../types";
import { ToolFallback } from "./Messages";

vi.mock("../console-store", () => ({
  useConsoleStore: () => ({ selectedThread: { id: "thread-1" } }),
}));

const snapshot: AskSnapshot = {
  interactionId: "ask-test",
  message: "Morning briefing and reply draft",
  questions: [
    {
      id: "q0",
      header: "Delivery",
      question: "What should I do with the draft?",
      options: [
        { id: "q0o0", label: "Send", description: "Send it now." },
        { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        { id: "q0o2", label: "Revise", description: "Keep editing it." },
      ],
      multiSelect: false,
    },
    {
      id: "q1",
      header: "Follow-up",
      question: "Which follow-ups should be included?",
      options: [
        { id: "q1o0", label: "Owner", description: "Name the owner." },
        { id: "q1o1", label: "Deadline", description: "Include the deadline." },
      ],
      multiSelect: true,
    },
  ],
  answers: [],
  activeQuestionIndex: 0,
  status: "pending",
  createdAt: "2026-07-21T09:00:00.000Z",
  expiresAt: "2026-07-21T09:10:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AskUser web form", () => {
  it("renders all questions together and submits option plus custom answers atomically", async () => {
    const toolArgs = JSON.parse(JSON.stringify({
      message: snapshot.message,
      questions: snapshot.questions,
    })) as ToolCallMessagePartProps["args"];
    vi.spyOn(api, "pendingAsk").mockResolvedValue(snapshot);
    const submitAsk = vi.spyOn(api, "submitAsk").mockResolvedValue({
      accepted: true,
      snapshot: { ...snapshot, status: "answered" },
    });

    render(<ToolFallback
      type="tool-call"
      toolName="AskUser"
      toolCallId="tool-1"
      args={toolArgs}
      argsText={JSON.stringify(toolArgs)}
      result={undefined}
      isError={false}
      status={{ type: "running" }}
      addResult={vi.fn()}
      resume={vi.fn()}
      respondToApproval={vi.fn()}
    />);

    expect(await screen.findByText("What should I do with the draft?")).toBeVisible();
    expect(screen.getByText("Which follow-ups should be included?")).toBeVisible();
    expect(screen.getByText("Morning briefing and reply draft")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: /Send/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Deadline/u }));
    fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "Also mention risk" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => expect(submitAsk).toHaveBeenCalledWith("thread-1", "ask-test", [
      { questionId: "q0", selectedOptionIds: ["q0o0"] },
      { questionId: "q1", selectedOptionIds: ["q1o1"], customReply: "Also mention risk" },
    ]));
    expect(await screen.findByText("Answers submitted.")).toBeVisible();
  });
});
