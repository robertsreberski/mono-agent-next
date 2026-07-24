// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityDisclosure } from "./Activity";

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
