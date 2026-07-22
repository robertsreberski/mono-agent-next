import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../styles.css";
import {
  ACTIVITY_GROUP_BY,
  ActivityGroup,
  REASONING_GROUP_BY,
  Reasoning,
  ReasoningGroup,
} from "./Reasoning";

describe("Reasoning", () => {
  it("renders plain reasoning paragraphs while preserving single line breaks", () => {
    const { container } = render(
      <Reasoning
        type="reasoning"
        text={"First line\nSecond line\n\nAnother paragraph"}
        status={{ type: "complete" }}
      />,
    );

    const paragraphs = container.querySelectorAll("[data-slot='reasoning-paragraph']");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveTextContent("First lineSecond line");
    expect(paragraphs[0]?.querySelector("br")).not.toBeNull();
    expect(paragraphs[1]).toHaveTextContent("Another paragraph");
  });

  it("provides a stable grouped-parts mapping for adjacent reasoning parts", () => {
    expect(REASONING_GROUP_BY({
      type: "reasoning",
      text: "thinking",
      status: { type: "running" },
    })).toEqual(["group-reasoning"]);
    expect(REASONING_GROUP_BY({
      type: "text",
      text: "answer",
      status: { type: "complete" },
    })).toEqual([]);
  });

  it("groups reasoning and routine tools into one activity while leaving standalone tools outside", () => {
    expect(ACTIVITY_GROUP_BY({
      type: "reasoning",
      text: "thinking",
      status: { type: "running" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "inspect",
      args: {},
      argsText: "{}",
      status: { type: "running" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({ type: "standalone-tool-call" } as never)).toEqual([]);
  });
});

describe("ActivityGroup", () => {
  it("shows all running activity without an inner scroll and restores the settled bound", () => {
    const { container, rerender } = render(
      <ActivityGroup streaming>
        <p>Live activity</p>
      </ActivityGroup>,
    );

    const runningText = container.querySelector<HTMLElement>("[data-slot='reasoning-text']");
    expect(runningText).not.toBeNull();
    const runningStyle = getComputedStyle(runningText!);
    expect(runningStyle.maxHeight).toBe("none");
    expect(runningStyle.overflowY).toBe("visible");
    expect(runningStyle.maskImage).toBe("none");

    rerender(
      <ActivityGroup streaming={false}>
        <p>Finished activity</p>
      </ActivityGroup>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));

    const settledText = container.querySelector<HTMLElement>("[data-slot='reasoning-text']");
    expect(settledText).not.toBeNull();
    const settledStyle = getComputedStyle(settledText!);
    expect(settledStyle.maxHeight).toBe("256px");
    expect(settledStyle.overflowY).toBe("auto");
  });

  it("stays open while running, force-collapses on settle, and can be reopened afterward", () => {
    const { container, rerender } = render(
      <ActivityGroup streaming>
        <p>Live activity</p>
      </ActivityGroup>,
    );

    expect(container.querySelector(".activity-trigger .reasoning-trigger-icon")).toBeNull();
    const activeTrigger = screen.getByRole("button", { name: "Activity in progress" });
    expect(activeTrigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(activeTrigger);
    expect(activeTrigger).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ActivityGroup streaming>
        <p>Live activity</p>
        <p>Another tool completed</p>
      </ActivityGroup>,
    );
    expect(screen.getByRole("button", { name: "Activity in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Another tool completed")).toBeVisible();

    rerender(
      <ActivityGroup streaming={false}>
        <p>Finished activity</p>
      </ActivityGroup>,
    );

    const settledTrigger = screen.getByRole("button", { name: "Activity" });
    expect(settledTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(settledTrigger);
    expect(settledTrigger).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ReasoningGroup", () => {
  it("auto-opens while streaming and auto-collapses when the stream settles", () => {
    const { rerender } = render(
      <ReasoningGroup streaming>
        <p>Live reasoning</p>
      </ReasoningGroup>,
    );

    const trigger = screen.getByRole("button", { name: "Reasoning in progress" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("[data-slot='reasoning-content']")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    rerender(
      <ReasoningGroup streaming={false}>
        <p>Finished reasoning</p>
      </ReasoningGroup>,
    );

    expect(screen.getByRole("button", { name: "Reasoning" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the first manual choice across later streaming transitions", () => {
    const { rerender } = render(
      <ReasoningGroup streaming>
        <p>Live reasoning</p>
      </ReasoningGroup>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reasoning in progress" }));
    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ReasoningGroup streaming={false}>
        <p>Finished reasoning</p>
      </ReasoningGroup>,
    );
    expect(screen.getByRole("button", { name: "Reasoning" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ReasoningGroup streaming>
        <p>More reasoning</p>
      </ReasoningGroup>,
    );
    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("derives streaming state from a GroupedParts group status", () => {
    render(
      <ReasoningGroup status={{ type: "running" }}>
        <p>Grouped reasoning</p>
      </ReasoningGroup>,
    );

    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
