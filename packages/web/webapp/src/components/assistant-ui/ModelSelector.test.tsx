// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ModelOption } from "../../types";
import { PopoverProvider } from "../Popover";
import { ModelSelector, type ModelRoute } from "./ModelSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models: readonly ModelOption[] = [
  {
    runtime: "pi",
    id: "openai-codex/gpt-5.5",
    label: "GPT-5.5 Codex",
    efforts: ["low", "high"],
    contextWindow: 200_000,
  },
  {
    runtime: "claude",
    id: "anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    efforts: ["low"],
    contextWindow: 180_000,
  },
];

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.textContent = "";
});

describe("ModelSelector", () => {
  it("renders Automatic separately and searches the advertised catalog", async () => {
    const host = await renderSelector({});
    await openSelector(host);
    const panel = requiredPanel();

    expect(requiredOption(panel, "Automatic").getAttribute("aria-selected")).toBe("true");
    expect(requiredOption(panel, "GPT-5.5 Codex").textContent).toContain("200k context");

    const search = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    );
    if (search === null) throw new Error("Missing model search.");
    expect(document.activeElement).toBe(search);
    await setInput(search, "claude");

    expect(panel.textContent).toContain("Claude Sonnet 4.5");
    expect(panel.textContent).not.toContain("GPT-5.5 Codex");
    expect(panel.textContent).not.toContain("Automatic");
  });

  it("emits runtime and model as one route and clears the previous effort", async () => {
    const onRouteChange = vi.fn<(route: ModelRoute | undefined) => void>();
    const onEffortChange = vi.fn<(effort: string) => void>();
    const host = await renderSelector({ onRouteChange, onEffortChange, effort: "high" });

    await openSelector(host);
    await act(async () => requiredOption(requiredPanel(), "GPT-5.5 Codex").click());

    expect(onRouteChange).toHaveBeenCalledWith({
      runtime: "pi",
      id: "openai-codex/gpt-5.5",
    });
    expect(onEffortChange).toHaveBeenCalledWith("");
    expect(document.querySelector('[role="dialog"][aria-label="Model and reasoning effort"]'))
      .toBeNull();
  });

  it("supports searched ArrowDown and Enter selection", async () => {
    const onRouteChange = vi.fn<(route: ModelRoute | undefined) => void>();
    const host = await renderSelector({ onRouteChange });

    await openSelector(host);
    const search = requiredPanel().querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    );
    if (search === null) throw new Error("Missing model search.");
    await setInput(search, "GPT-5.5");
    await pressKey(search, "ArrowDown");
    await pressKey(search, "Enter");

    expect(onRouteChange).toHaveBeenCalledWith({
      runtime: "pi",
      id: "openai-codex/gpt-5.5",
    });
  });

  it("loops from Automatic to the last advertised model with ArrowUp", async () => {
    const onRouteChange = vi.fn<(route: ModelRoute | undefined) => void>();
    const host = await renderSelector({ onRouteChange });

    await openSelector(host);
    const search = requiredPanel().querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    );
    if (search === null) throw new Error("Missing model search.");
    await pressKey(search, "ArrowUp");
    await pressKey(search, "Enter");

    expect(onRouteChange).toHaveBeenCalledWith({
      runtime: "claude",
      id: "anthropic/claude-sonnet-4.5",
    });
  });

  it("offers only the selected model's effort allowlist plus Automatic", async () => {
    const onEffortChange = vi.fn<(effort: string) => void>();
    const host = await renderSelector({
      route: { runtime: "claude", id: "anthropic/claude-sonnet-4.5" },
      effort: "",
      onEffortChange,
    });

    await openSelector(host);
    const group = requiredPanel().querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Reasoning effort"]',
    );
    if (group === null) throw new Error("Missing effort group.");
    const labels = [...group.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(["Automatic", "Low"]);
    expect(group.textContent).not.toContain("High");

    const low = group.querySelector<HTMLInputElement>('input[value="low"]');
    if (low === null) throw new Error("Missing low effort.");
    await act(async () => low.click());
    expect(onEffortChange).toHaveBeenCalledWith("low");
  });

  it("uses the advertised default model effort allowlist in Automatic mode", async () => {
    const onRouteChange = vi.fn<(route: ModelRoute | undefined) => void>();
    const onEffortChange = vi.fn<(effort: string) => void>();
    const host = await renderSelector({
      defaultRoute: { runtime: "pi", id: "openai-codex/gpt-5.5" },
      onRouteChange,
      onEffortChange,
    });

    await openSelector(host);
    const group = requiredPanel().querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Reasoning effort"]',
    );
    if (group === null) throw new Error("Missing default model effort group.");
    expect([...group.querySelectorAll("label")].map((label) => label.textContent))
      .toEqual(["Automatic", "Low", "High"]);

    const high = group.querySelector<HTMLInputElement>('input[value="high"]');
    if (high === null) throw new Error("Missing high effort.");
    await act(async () => high.click());
    expect(onEffortChange).toHaveBeenCalledWith("high");
    expect(onRouteChange).not.toHaveBeenCalled();
  });

  it("keeps effort keyboard events out of the model command list", async () => {
    const onRouteChange = vi.fn<(route: ModelRoute | undefined) => void>();
    const host = await renderSelector({
      route: { runtime: "pi", id: "openai-codex/gpt-5.5" },
      effort: "low",
      onRouteChange,
    });

    await openSelector(host);
    const low = requiredPanel().querySelector<HTMLInputElement>('input[value="low"]');
    if (low === null) throw new Error("Missing low effort.");
    low.focus();
    await pressKey(low, "ArrowRight");
    await pressKey(low, "Enter");

    expect(onRouteChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][aria-label="Model and reasoning effort"]'))
      .not.toBeNull();
  });

  it("uses Automatic to omit the route and effort overrides", async () => {
    const onRouteChange = vi.fn<(route: ModelRoute | undefined) => void>();
    const onEffortChange = vi.fn<(effort: string) => void>();
    const host = await renderSelector({
      route: { runtime: "pi", id: "openai-codex/gpt-5.5" },
      effort: "high",
      onRouteChange,
      onEffortChange,
    });

    await openSelector(host);
    await act(async () => requiredOption(requiredPanel(), "Automatic").click());

    expect(onRouteChange).toHaveBeenCalledWith(undefined);
    expect(onEffortChange).toHaveBeenCalledWith("");
  });

  it("locks the trigger without requiring a popover provider interaction", async () => {
    const host = await renderSelector({ disabled: true });
    const trigger = requiredTrigger(host);

    expect(trigger.disabled).toBe(true);
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"][aria-label="Model and reasoning effort"]'))
      .toBeNull();
  });

  it("exposes a Run settings accessibility label for integration", async () => {
    const host = await renderSelector({ triggerLabel: "Run settings" });
    const trigger = requiredTrigger(host, "Run settings");

    expect(trigger.getAttribute("aria-label")).toBe("Run settings");
    await openSelector(host, "Run settings");
    expect(document.querySelector('[role="dialog"][aria-label="Run settings"]')).not.toBeNull();
  });
});

async function renderSelector({
  route,
  defaultRoute,
  effort = "",
  onRouteChange = () => undefined,
  onEffortChange = () => undefined,
  disabled = false,
  triggerLabel,
}: {
  readonly route?: ModelRoute;
  readonly defaultRoute?: ModelRoute;
  readonly effort?: string;
  readonly onRouteChange?: (route: ModelRoute | undefined) => void;
  readonly onEffortChange?: (effort: string) => void;
  readonly disabled?: boolean;
  readonly triggerLabel?: string;
}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <PopoverProvider>
        <ModelSelector
          models={models}
          {...(route === undefined ? {} : { route })}
          {...(defaultRoute === undefined ? {} : { defaultRoute })}
          effort={effort}
          onRouteChange={onRouteChange}
          onEffortChange={onEffortChange}
          disabled={disabled}
          {...(triggerLabel === undefined ? {} : { triggerLabel })}
        />
      </PopoverProvider>,
    );
  });
  return host;
}

async function openSelector(
  host: HTMLElement,
  triggerLabel = "Model and reasoning effort",
): Promise<void> {
  await act(async () => requiredTrigger(host, triggerLabel).click());
  await nextFrame();
}

function requiredTrigger(
  host: HTMLElement,
  triggerLabel = "Model and reasoning effort",
): HTMLButtonElement {
  const trigger = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${triggerLabel}"]`,
  );
  if (trigger === null) throw new Error("Missing model selector trigger.");
  return trigger;
}

function requiredPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Model and reasoning effort"]',
  );
  if (panel === null) throw new Error("Missing model selector panel.");
  return panel;
}

function requiredOption(panel: HTMLElement, label: string): HTMLElement {
  const option = [...panel.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.includes(label) === true);
  if (option === undefined) throw new Error(`Missing ${label} option.`);
  return option;
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
