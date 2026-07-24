// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Telemetry } from "../../types";
import { PopoverProvider } from "../Popover";
import { ContextDisplay, type ContextDisplayProps } from "./ContextDisplay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.textContent = "";
});

describe("ContextDisplay", () => {
  it("uses exact contextUsed with the advertised model window when needed", async () => {
    const telemetry: Telemetry = {
      inputTokens: 100,
      outputTokens: 25,
      contextUsed: 500,
      compacted: true,
      sessionEvicted: true,
    };
    const host = await renderDisplay({ telemetry, modelContextWindow: 2_000 });

    const trigger = requiredTrigger(host);
    expect(trigger.textContent).toContain("Context 500");
    expect(trigger.textContent).toContain("25%");
    await openDisplay(trigger);

    const panel = requiredPanel();
    expect(rowValue(panel, "Input")).toBe("100");
    expect(rowValue(panel, "Output")).toBe("25");
    expect(rowValue(panel, "Used")).toBe("500");
    expect(rowValue(panel, "Window (model)")).toBe("2,000");
    expect(rowValue(panel, "Compaction")).toBe("Applied");
    expect(rowValue(panel, "Session")).toBe("Renewed");
    expect(panel.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"))
      .toBe("25");
    expect(panel.textContent).not.toMatch(/cache|cost/iu);
  });

  it("does not leak a preceding context value while the current turn is pending", async () => {
    const host = await renderDisplay({
      pending: true,
      telemetry: telemetry({ contextUsed: 500, contextWindow: 1_000 }),
    });

    const trigger = requiredTrigger(host);
    expect(trigger.textContent).toContain("Context pending");
    expect(trigger.textContent).not.toContain("500");
    expect(trigger.textContent).not.toContain("50%");
    await openDisplay(trigger);

    const panel = requiredPanel();
    expect(panel.textContent).toContain(
      "Exact context telemetry is not available for the active response yet.",
    );
    expect(rowValue(panel, "Used")).toBe("Pending");
    expect(panel.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps missing context distinct from ordinary token counters", async () => {
    const host = await renderDisplay({
      telemetry: telemetry({ inputTokens: 20, outputTokens: 0, contextWindow: 1_000 }),
    });

    const trigger = requiredTrigger(host);
    expect(trigger.textContent).toContain("Context unavailable");
    expect(trigger.textContent).not.toContain("%");
    await openDisplay(trigger);

    const panel = requiredPanel();
    expect(rowValue(panel, "Input")).toBe("20");
    expect(rowValue(panel, "Output")).toBe("0");
    expect(rowValue(panel, "Used")).toBe("Unavailable");
    expect(panel.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("renders an exact zero instead of treating it as unavailable", async () => {
    const host = await renderDisplay({
      telemetry: telemetry({ contextUsed: 0, contextWindow: 1_000 }),
    });

    const trigger = requiredTrigger(host);
    expect(trigger.textContent).toContain("Context 0");
    expect(trigger.textContent).toContain("0%");
    expect(trigger.textContent).not.toContain("unavailable");
    await openDisplay(trigger);

    const panel = requiredPanel();
    expect(rowValue(panel, "Used")).toBe("0");
    expect(panel.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"))
      .toBe("0");
  });

  it("shows exact usage without inventing a percentage when the window is unknown", async () => {
    const host = await renderDisplay({
      telemetry: telemetry({ contextUsed: 20 }),
    });

    const trigger = requiredTrigger(host);
    expect(trigger.textContent).toContain("Context 20");
    expect(trigger.textContent).not.toContain("%");
    await openDisplay(trigger);

    const panel = requiredPanel();
    expect(rowValue(panel, "Window")).toBe("Unavailable");
    expect(panel.querySelector('[role="progressbar"]')).toBeNull();
  });
});

function telemetry(overrides: Partial<Telemetry>): Telemetry {
  return {
    inputTokens: 0,
    outputTokens: 0,
    compacted: false,
    sessionEvicted: false,
    ...overrides,
  };
}

async function renderDisplay(props: ContextDisplayProps): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <PopoverProvider>
        <ContextDisplay {...props} />
      </PopoverProvider>,
    );
  });
  return host;
}

async function openDisplay(trigger: HTMLButtonElement): Promise<void> {
  await act(async () => trigger.click());
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function requiredTrigger(host: HTMLElement): HTMLButtonElement {
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Context usage"]',
  );
  if (trigger === null) throw new Error("Missing context display trigger.");
  return trigger;
}

function requiredPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Context usage"]',
  );
  if (panel === null) throw new Error("Missing context display panel.");
  return panel;
}

function rowValue(panel: HTMLElement, label: string): string | undefined {
  const term = [...panel.querySelectorAll("dt")]
    .find((candidate) => candidate.textContent === label);
  return term?.nextElementSibling?.textContent ?? undefined;
}
