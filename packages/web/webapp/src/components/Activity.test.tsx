// @vitest-environment jsdom

import type {
  DataMessagePartProps,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVITY_GROUP_BY,
  ActivityDisclosure,
  CompactionActivity,
  OperatorActivityTimeline,
  OrphanResultActivity,
  ToolActivity,
} from "./Activity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.textContent = "";
});

describe("ActivityDisclosure", () => {
  it("stays open while work is running and collapses when the run settles", async () => {
    const view = mountActivity(true, <span>Reading the workspace</span>);

    expect(view.trigger().getAttribute("aria-expanded")).toBe("true");
    expect(view.panel().hidden).toBe(false);
    expect(view.panel().getAttribute("aria-busy")).toBe("true");

    await view.clickTrigger();

    expect(view.trigger().getAttribute("aria-expanded")).toBe("true");
    expect(view.panel().hidden).toBe(false);

    await view.render(
      true,
      <>
        <span>Reading the workspace</span>
        <span>Comparing changes</span>
      </>,
    );

    expect(view.panel().hidden).toBe(false);
    expect(view.panel().textContent).toContain("Comparing changes");

    await view.render(false, <span>Finished comparing changes</span>);

    expect(view.trigger().getAttribute("aria-expanded")).toBe("false");
    expect(view.panel().hidden).toBe(true);
    expect(view.panel().getAttribute("aria-busy")).toBe("false");

    await view.unmount();
  });

  it("allows a settled activity to be reopened and keeps appended children visible", async () => {
    const view = mountActivity(false, <span>First completed step</span>);

    expect(view.trigger().getAttribute("aria-expanded")).toBe("false");
    expect(view.panel().hidden).toBe(true);

    await view.clickTrigger();

    expect(view.trigger().getAttribute("aria-expanded")).toBe("true");
    expect(view.panel().hidden).toBe(false);

    await view.render(
      false,
      <>
        <span>First completed step</span>
        <span>Late-arriving tool result</span>
      </>,
    );

    expect(view.trigger().getAttribute("aria-expanded")).toBe("true");
    expect(view.panel().hidden).toBe(false);
    expect(view.panel().textContent).toContain("Late-arriving tool result");

    await view.clickTrigger();

    expect(view.trigger().getAttribute("aria-expanded")).toBe("false");
    expect(view.panel().hidden).toBe(true);

    await view.unmount();
  });
});

describe("activity parts", () => {
  it("groups operator activity without swallowing answer text", () => {
    expect(ACTIVITY_GROUP_BY({
      type: "reasoning",
      text: "Inspecting",
      status: { type: "running" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY(toolPart())).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({
      type: "data",
      name: "operator-compaction",
      data: { compacted: true },
      status: { type: "complete" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({
      type: "data",
      name: "operator-result",
      data: { callId: "orphan" },
      status: { type: "complete" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({
      type: "text",
      text: "Final answer",
      status: { type: "complete" },
    })).toEqual([]);
  });

  it("renders policy-safe structured tool input and output", async () => {
    const view = mountNode(
      <ToolActivity
        {...toolPart({
          toolName: "private_lookup",
          args: { omitted: true, message: "Input omitted by policy" },
          result: {
            callId: "call-1",
            content: ["result text", { matches: 2 }],
            contentOmitted: false,
            isError: false,
          },
        })}
      />,
    );

    expect(view.host.querySelector(".tool-name")?.textContent).toBe("private_lookup");
    expect(view.host.querySelector(".tool-state")?.textContent).toBe("done");
    expect([...view.host.querySelectorAll("pre")].map((node) => node.textContent)).toEqual([
      "Input omitted by policy",
      "[\n  \"result text\",\n  {\n    \"matches\": 2\n  }\n]",
    ]);

    await view.unmount();
  });

  it("renders call, intervening activity, and matching result in occurrence order", async () => {
    const view = mountNode(
      <OperatorActivityTimeline
        streaming={false}
        activities={[
          {
            type: "tool_call",
            call: {
              id: "call-a",
              name: "lookup",
              input: { query: "A" },
              inputOmitted: false,
            },
          },
          { type: "activity", text: "Activity B" },
          {
            type: "tool_result",
            result: {
              callId: "call-a",
              content: [{ type: "json", value: { matches: 1 } }],
              contentOmitted: false,
            },
          },
        ]}
      />,
    );

    const occurrences = [
      ...view.host.querySelectorAll<HTMLElement>("[data-activity-occurrence]"),
    ];
    expect(occurrences.map((node) => node.dataset.activityOccurrence)).toEqual([
      "tool_call",
      "activity",
      "tool_result",
    ]);
    expect(occurrences.map((node) => node.textContent)).toEqual([
      expect.stringContaining("lookupcalled"),
      expect.stringContaining("Activity B"),
      expect.stringContaining("lookup resultdone"),
    ]);
    expect(occurrences[0]?.dataset.callId).toBe("call-a");
    expect(occurrences[2]?.dataset.callId).toBe("call-a");

    await view.unmount();
  });

  it("presents compaction metrics and unmatched result policy state", async () => {
    const view = mountNode(
      <>
        <CompactionActivity
          {...dataPart("operator-compaction", {
            compacted: true,
            tokensBefore: 9_000,
            tokensAfter: 3_000,
            summaryTokens: 420,
          })}
        />
        <OrphanResultActivity
          {...dataPart("operator-result", {
            callId: "missing-call",
            contentOmitted: true,
            isError: true,
          })}
        />
      </>,
    );

    const compaction = requiredElement<HTMLElement>(view.host, ".context-compaction-row");
    expect(compaction.classList.contains("is-succeeded")).toBe(true);
    expect(compaction.textContent).toContain("9k → 3k tokens · 420 summary tokens");
    expect(compaction.getAttribute("aria-label")).toBe(
      "Context compacted, 9k → 3k tokens, 420 summary tokens",
    );

    const orphan = requiredElement<HTMLDetailsElement>(view.host, ".tool-call.is-orphan");
    expect(orphan.classList.contains("is-error")).toBe(true);
    expect(orphan.textContent).toContain("Call missing-call");
    expect(orphan.textContent).toContain("Output omitted by policy");

    await view.unmount();
  });
});

function mountActivity(streaming: boolean, children: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  const render = async (nextStreaming: boolean, nextChildren: ReactNode) => {
    await act(async () => {
      root.render(
        <ActivityDisclosure streaming={nextStreaming}>
          {nextChildren}
        </ActivityDisclosure>,
      );
    });
  };

  act(() => {
    root.render(
      <ActivityDisclosure streaming={streaming}>
        {children}
      </ActivityDisclosure>,
    );
  });

  return {
    trigger: () => requiredElement<HTMLButtonElement>(host, ".activity-trigger"),
    panel: () => requiredElement<HTMLDivElement>(host, ".activity-panel"),
    clickTrigger: async () => {
      await act(async () => {
        requiredElement<HTMLButtonElement>(host, ".activity-trigger").click();
      });
    },
    render,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  } satisfies ActivityView;
}

function mountNode(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(node);
  });

  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function toolPart(
  overrides: Partial<ToolCallMessagePartProps> = {},
): ToolCallMessagePartProps {
  return {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "inspect",
    args: {},
    argsText: "{}",
    status: { type: "complete" },
    addResult: () => undefined,
    resume: () => undefined,
    respondToApproval: () => undefined,
    ...overrides,
  };
}

function dataPart(name: string, data: unknown): DataMessagePartProps {
  return {
    type: "data",
    name,
    data,
    status: { type: "complete" },
  };
}

interface ActivityView {
  readonly trigger: () => HTMLButtonElement;
  readonly panel: () => HTMLDivElement;
  readonly clickTrigger: () => Promise<void>;
  readonly render: (streaming: boolean, children: ReactNode) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

function requiredElement<ElementType extends Element>(
  host: HTMLElement,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}
