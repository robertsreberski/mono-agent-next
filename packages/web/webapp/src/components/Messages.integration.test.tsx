import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

function MessageHarness({ message }: { readonly message: WebMessage }) {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [message],
    convertMessage: convertWebMessage,
    onNew: async () => undefined,
    adapters: {
      threadList: {
        threadId: "thread",
        isLoading: false,
        threads: [{ id: "thread", remoteId: "thread", status: "regular" }],
        archivedThreads: [],
        onSwitchToNewThread: async () => undefined,
        onSwitchToThread: () => undefined,
        onRename: async () => undefined,
        onArchive: async () => undefined,
        onUnarchive: async () => undefined,
      },
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

const assistantMessage = (
  status: WebMessage["status"],
): WebMessage => ({
  id: "assistant-message",
  threadId: "thread",
  role: "assistant",
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  status,
  attachments: [],
  parts: [
    { type: "reasoning", text: "Inspect the real state." },
    {
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "inspect_workspace",
      args: { depth: 2 },
      result: { ok: true },
      status: "complete",
    },
    {
      type: "telemetry",
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_compaction",
        data: {
          operationId: "compact-1",
          status: "succeeded",
          sdk: "pi",
          trigger: "proactive",
          tokensBefore: 80_000,
          tokensAfter: 20_000,
          tokenCountsExact: false,
        },
      },
    },
    {
      type: "telemetry",
      event: "usage_update",
      data: { tokens: { input: 120, output: 30 }, cumulativeUsd: 0.002 },
    },
    { type: "text", text: "The workspace is ready." },
  ],
});

const userMessage: WebMessage = {
  id: "user-message",
  threadId: "thread",
  role: "user",
  createdAt: "2026-07-17T09:59:00.000Z",
  updatedAt: "2026-07-17T09:59:00.000Z",
  status: "complete",
  attachments: [],
  parts: [{ type: "text", text: "Inspect this workspace." }],
};

describe("AssistantMessage grouped parts", () => {
  it("shows the delivery state for live follow-up user messages", () => {
    render(<MessageHarness message={{ ...userMessage, liveInputStatus: "applied" }} />);

    expect(screen.getByText("Applied to current run")).toBeVisible();
  });

  it("renders an applied live follow-up as a completed Steered tool activity", () => {
    render(<MessageHarness message={{
      ...assistantMessage("complete"),
      parts: [
        {
          type: "tool-call",
          toolCallId: "live-input:follow-up-1",
          toolName: "↪️ Steered: “Use the API instead”",
          result: "Applied to current run",
          status: "complete",
        },
        { type: "text", text: "Done." },
      ],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const toolName = screen.getByText("↪️ Steered: “Use the API instead”");
    expect(toolName).toBeVisible();
    expect(screen.getByText("done")).toBeVisible();
    fireEvent.click(toolName.closest("summary")!);
    expect(screen.getByText('"Applied to current run"')).toBeVisible();
  });

  it("preserves reasoning, tools, and answer order while keeping telemetry internal", () => {
    render(<MessageHarness message={assistantMessage("complete")} />);

    expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("Inspect the real state.")).toBeVisible();
    expect(screen.getByText("inspect_workspace")).toBeVisible();
    expect(screen.getByRole("status", {
      name: "Context compacted, proactive, ~80k → ~20k tokens",
    })).toBeVisible();
    expect(screen.queryByText("Telemetry")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token usage and cost")).not.toBeInTheDocument();
    expect(screen.getByText("The workspace is ready.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy response" }).parentElement).toHaveClass(
      "is-persistent",
    );
  });

  it("updates a live compaction row in place and marks a dangling row interrupted", async () => {
    const compaction = (status: "running" | "succeeded") => ({
      type: "telemetry" as const,
      event: "runtime_telemetry",
      data: {
        type: "runtime_telemetry",
        kind: "context_compaction",
        data: { operationId: "compact-live", status, sdk: "codex", trigger: "automatic" },
      },
    });
    const runningMessage: WebMessage = {
      ...assistantMessage("running"),
      parts: [compaction("running")],
    };
    const { rerender } = render(<MessageHarness message={runningMessage} />);

    expect(screen.getByRole("status", { name: "Compacting context" })).toBeVisible();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<MessageHarness message={{
      ...runningMessage,
      updatedAt: "2026-07-17T10:00:01.000Z",
      parts: [compaction("succeeded")],
    }} />);
    expect(await screen.findByRole("status", { name: "Context compacted" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "Compacting context" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<MessageHarness message={{
      ...runningMessage,
      status: "interrupted",
      updatedAt: "2026-07-17T10:00:02.000Z",
    }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
    expect(await screen.findByRole("status", { name: "Context compaction interrupted" })).toBeVisible();
  });

  it("keeps activity open while completed tool entries arrive in a running message", async () => {
    const runningMessage: WebMessage = {
      ...assistantMessage("running"),
      parts: [
        { type: "reasoning", text: "Still reasoning" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "first_completed_tool",
          args: {},
          result: { ok: true },
          status: "complete",
        },
      ],
    };
    const { rerender } = render(<MessageHarness message={runningMessage} />);

    const trigger = screen.getByRole("button", { name: "Activity in progress" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    rerender(
      <MessageHarness
        message={{
          ...runningMessage,
          updatedAt: "2026-07-17T10:00:01.000Z",
          parts: [
            ...runningMessage.parts,
            {
              type: "tool-call",
              toolCallId: "tool-2",
              toolName: "second_completed_tool",
              args: {},
              result: { ok: true },
              status: "complete",
            },
          ],
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Activity in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(await screen.findByText("second_completed_tool")).toBeVisible();
  });

  it.each(["complete", "failed", "cancelled", "interrupted"] as const)(
    "collapses activity when the parent message becomes %s and allows reopening",
    async (status) => {
      const runningMessage: WebMessage = {
        ...assistantMessage("running"),
        parts: [
          { type: "reasoning", text: "Still reasoning" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "completed_tool",
            args: {},
            result: { ok: true },
            status: "complete",
          },
        ],
      };
      const { rerender } = render(<MessageHarness message={runningMessage} />);

      expect(screen.getByRole("button", { name: "Activity in progress" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );

      rerender(
        <MessageHarness
          message={{
            ...runningMessage,
            status,
            updatedAt: "2026-07-17T10:00:01.000Z",
          }}
        />,
      );

      const settledTrigger = await screen.findByRole("button", { name: "Activity" });
      expect(settledTrigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(settledTrigger);
      expect(settledTrigger).toHaveAttribute("aria-expanded", "true");
    },
  );
});

describe("message actions", () => {
  it("keeps the copy action mounted before hover so revealing it cannot shift layout", () => {
    render(<MessageHarness message={userMessage} />);

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy).toBeInTheDocument();
    copy.focus();
    expect(copy).toHaveFocus();
  });

  it("renders a persisted quote separately from the authored message", () => {
    render(<MessageHarness message={{
      ...userMessage,
      quote: { text: "The earlier response", messageId: "assistant-source" },
    }} />);

    expect(screen.getByText("The earlier response")).toBeVisible();
    expect(screen.getByText("Inspect this workspace.")).toBeVisible();
  });
});
