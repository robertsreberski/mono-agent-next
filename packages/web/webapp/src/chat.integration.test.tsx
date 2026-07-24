// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { Chat } from "./chat";
import { OPEN_RUN_SETTINGS_EVENT } from "./components/Composer";
import type {
  Agent,
  Message,
  ModelOption,
  Thread,
  ThreadDetail,
} from "./types";

const consoleMock = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock("./console", () => ({
  useConsole: () => consoleMock.current,
}));

vi.mock("@assistant-ui/react", async () => {
  const { createElement } = await import("react");
  const container = (
    name: string,
  ) => ({
    children,
    className,
  }: {
    readonly children?: ReactNode;
    readonly className?: string;
  }) => createElement("div", { className, "data-thread-primitive": name }, children);

  return {
    ThreadPrimitive: {
      Empty: container("empty"),
      Messages: () => null,
      Root: container("root"),
      ScrollToBottom: ({
        children,
        className,
        ...props
      }: {
        readonly children?: ReactNode;
        readonly className?: string;
        readonly "aria-label"?: string;
      }) => createElement("button", { className, ...props }, children),
      Viewport: container("viewport"),
      ViewportFooter: container("footer"),
    },
  };
});

vi.mock("./components/Composer", async () => {
  const { createElement } = await import("react");
  return {
    Composer: () => createElement("div", { "data-testid": "composer" }),
    OPEN_RUN_SETTINGS_EVENT: "mono-agent:run-settings",
  };
});

vi.mock("./components/Messages", () => ({
  AssistantMessage: () => null,
  SelectionToolbar: () => null,
  UserMessage: () => null,
}));

vi.mock("./components/NotificationBell", async () => {
  const { createElement } = await import("react");
  return {
    NotificationBell: ({ className }: { readonly className?: string }) =>
      createElement("button", {
        "aria-label": "Enable notifications",
        className,
        type: "button",
      }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-07-24T12:00:00.000Z";
const roots: Root[] = [];

const models: readonly ModelOption[] = [
  {
    runtime: "pi",
    id: "openai-codex/terra",
    label: "Terra",
    efforts: ["low", "high"],
    contextWindow: 200_000,
  },
  {
    runtime: "local",
    id: "deterministic/compact",
    label: "Compact Local",
    contextWindow: 32_000,
  },
];

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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
  delete document.body.dataset.consolePopover;
  vi.clearAllMocks();
});

describe("restored Chat header contract", () => {
  it("renames the conversation inline and keeps Escape non-mutating", async () => {
    const state = installState();
    const view = await renderChatView();
    const { host } = view;

    await act(async () => requiredButton(host, "Rename conversation").click());
    const input = requiredElement<HTMLInputElement>(
      host,
      'input[aria-label="Conversation title"]',
    );
    expect(input.maxLength).toBe(120);
    await setInput(input, "  Updated title  ");
    await act(async () => input.focus());
    await pressKey(input, "Enter");

    expect(state.renameThread).toHaveBeenCalledWith("thread-1", "Updated title");

    const renamed = thread({ title: "Updated title" });
    consoleMock.current = createState({
      detail: detail(renamed),
      selectedThread: renamed,
    });
    await act(async () => view.root.render(<Chat />));
    expect(requiredButton(host, "Rename conversation").textContent).toContain(
      "Updated title",
    );

    await act(async () => requiredButton(host, "Rename conversation").click());
    const cancelledInput = requiredElement<HTMLInputElement>(
      host,
      'input[aria-label="Conversation title"]',
    );
    await setInput(cancelledInput, "Do not persist");
    await pressKey(cancelledInput, "Escape");

    expect(state.renameThread).toHaveBeenCalledTimes(1);
    expect(requiredButton(host, "Rename conversation").textContent).toContain(
      "Updated title",
    );
  });

  it("restores the authoritative title when an inline rename rejects", async () => {
    const renameThread = vi.fn(async () => {
      throw new Error("rename rejected");
    });
    installState({ renameThread });
    const host = await renderChat();

    await act(async () => requiredButton(host, "Rename conversation").click());
    const input = requiredElement<HTMLInputElement>(
      host,
      'input[aria-label="Conversation title"]',
    );
    await setInput(input, "Unsaved title");
    await act(async () => input.focus());
    await pressKey(input, "Enter");

    expect(renameThread).toHaveBeenCalledWith("thread-1", "Unsaved title");
    expect(requiredButton(host, "Rename conversation").textContent).toContain(
      "Current conversation",
    );

    await act(async () => requiredButton(host, "Rename conversation").click());
    expect(requiredElement<HTMLInputElement>(
      host,
      'input[aria-label="Conversation title"]',
    ).value).toBe("Current conversation");
  });

  it("offers only the advertised default model efforts while Automatic is active", async () => {
    installState();
    const host = await renderChat();

    await openRunSettings(host);
    const effortGroup = requiredElement<HTMLElement>(
      document.body,
      '[role="radiogroup"][aria-label="Reasoning effort"]',
    );

    expect(
      [...effortGroup.querySelectorAll("label")].map((label) => label.textContent),
    ).toEqual(["Automatic", "Low", "High"]);
    expect(requiredButton(host, "Run settings").textContent).toContain("Automatic");
  });

  it("applies a model route in runtime-model order, clears effort, and never guesses efforts", async () => {
    const state = installState();
    const view = await renderChatView();

    await openRunSettings(view.host);
    const compact = requiredOption("Compact Local");
    await act(async () => compact.click());

    expect(state.setRuntime).toHaveBeenCalledWith("local");
    expect(state.setModel).toHaveBeenCalledWith("deterministic/compact");
    expect(state.setEffort).toHaveBeenCalledWith("");
    expect(state.setRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      state.setModel.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(state.setModel.mock.invocationCallOrder[0]).toBeLessThan(
      state.setEffort.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    consoleMock.current = createState({
      effort: "high",
      model: "deterministic/compact",
      runtime: "local",
    });
    await act(async () => view.root.render(<Chat />));
    await openRunSettings(view.host);

    expect(document.body.querySelector(
      '[role="radiogroup"][aria-label="Reasoning effort"]',
    )).toBeNull();
    expect(requiredButton(view.host, "Run settings").textContent).not.toContain("High");
  });

  it("opens the header model picker from the composer run-settings event", async () => {
    installState();
    const host = await renderChat();
    expect(requiredButton(host, "Run settings").getAttribute("aria-expanded")).toBe("false");

    await act(async () => window.dispatchEvent(new Event(OPEN_RUN_SETTINGS_EVENT)));
    await nextFrame();

    expect(requiredDialog("Run settings")).not.toBeNull();
    expect(requiredButton(host, "Run settings").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the running status visible and locks run settings at a mobile viewport", async () => {
    const running = thread({ status: "running" });
    installState({
      detail: detail(running, [assistantMessage({
        contextUsed: 80,
        contextWindow: 200_000,
      })]),
      selectedThread: running,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    const host = await renderChat();

    const status = requiredElement<HTMLElement>(
      host,
      '[role="status"][aria-label="Agent status: Working"]',
    );
    expect(status.textContent).toContain("Working");
    expect(status.classList.contains("is-working")).toBe(true);
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("aria-hidden")).toBeNull();
    expect(status.closest(".chat-header")).not.toBeNull();
    expect(requiredButton(host, "Run settings").disabled).toBe(true);
  });

  it("uses matching detail status while the thread summary is stale", async () => {
    const summary = thread({ status: "complete" });
    const authoritative = thread({ status: "running" });
    installState({
      detail: detail(authoritative),
      selectedThread: summary,
    });
    const host = await renderChat();

    expect(
      host.querySelector('[role="status"][aria-label="Agent status: Working"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[role="status"][aria-label="Agent status: Ready"]'),
    ).toBeNull();
    expect(requiredButton(host, "Run settings").disabled).toBe(true);
  });

  it("never presents Ready while the console stream or browser is unavailable", async () => {
    installState();
    const view = await renderChatView();
    expect(view.host.querySelector('[aria-label="Agent status: Ready"]')).not.toBeNull();

    consoleMock.current = createState({ connection: "reconnecting" });
    await act(async () => view.root.render(<Chat />));
    expect(view.host.querySelector('[aria-label="Agent status: Reconnecting"]')).not.toBeNull();
    expect(view.host.querySelector('[aria-label="Agent status: Ready"]')).toBeNull();

    consoleMock.current = createState({ connection: "offline" });
    await act(async () => view.root.render(<Chat />));
    expect(view.host.querySelector('[aria-label="Agent status: Browser offline"]')).not.toBeNull();
    expect(view.host.querySelector('[aria-label="Agent status: Ready"]')).toBeNull();

    const running = thread({ status: "running" });
    consoleMock.current = createState({
      connection: "offline",
      detail: detail(running),
      selectedThread: running,
    });
    await act(async () => view.root.render(<Chat />));
    expect(view.host.querySelector('[aria-label="Agent status: Working"]')).not.toBeNull();
  });

  it("replaces the composer with a restore action for archived conversations", async () => {
    const archived = thread({ archivedAt: timestamp });
    const state = installState({
      detail: detail(archived),
      selectedThread: archived,
    });
    const host = await renderChat();

    expect(host.textContent).toContain("This conversation is archived.");
    expect(host.querySelector('[data-testid="composer"]')).toBeNull();
    const restore = requiredButton(host, "Restore to continue");
    await act(async () => restore.click());

    expect(state.archiveThread).toHaveBeenCalledWith("thread-1", false);
  });
});

describe("restored Chat context states", () => {
  it("shows pending without leaking settled telemetry during a new send", async () => {
    installState({
      detail: detail(thread(), [assistantMessage({
        compacted: false,
        contextUsed: 60_000,
        contextWindow: 200_000,
        sessionEvicted: false,
      })]),
      sending: true,
    });
    const host = await renderChat();

    const trigger = requiredButton(host, "Context usage");
    expect(trigger.textContent).toContain("Context pending");
    expect(trigger.textContent).not.toContain("60k");
    await openPopover(trigger);

    const panel = requiredDialog("Context usage");
    expect(panel.textContent).toContain(
      "Exact context telemetry is not available for the active response yet.",
    );
    expect(rowValue(panel, "Used")).toBe("Pending");
  });

  it("keeps missing current-turn usage explicitly unavailable", async () => {
    installState({
      detail: detail(thread(), [assistantMessage({
        inputTokens: 42,
        outputTokens: 0,
      })]),
    });
    const host = await renderChat();

    const trigger = requiredButton(host, "Context usage");
    expect(trigger.textContent).toContain("Context unavailable");
    await openPopover(trigger);

    const panel = requiredDialog("Context usage");
    expect(rowValue(panel, "Input")).toBe("42");
    expect(rowValue(panel, "Output")).toBe("0");
    expect(rowValue(panel, "Used")).toBe("Unavailable");
  });

  it("preserves exact zero, compaction, and renewed-session telemetry", async () => {
    installState({
      detail: detail(thread(), [assistantMessage({
        compacted: true,
        contextUsed: 0,
        contextWindow: 200_000,
        sessionEvicted: true,
      })]),
    });
    const host = await renderChat();

    const trigger = requiredButton(host, "Context usage");
    expect(trigger.textContent).toContain("Context 0");
    expect(trigger.textContent).toContain("0%");
    await openPopover(trigger);

    const panel = requiredDialog("Context usage");
    expect(rowValue(panel, "Used")).toBe("0");
    expect(rowValue(panel, "Compaction")).toBe("Applied");
    expect(rowValue(panel, "Session")).toBe("Renewed");
  });
});

interface TestConsoleState {
  archiveThread: Mock<(threadId: string, archived: boolean) => Promise<void>>;
  connection: "connecting" | "connected" | "reconnecting" | "offline";
  createThread: Mock<() => Promise<void>>;
  deleteThread: Mock<(threadId: string) => Promise<void>>;
  detail: ThreadDetail;
  effort: string;
  error?: string;
  model: string;
  refreshing: boolean;
  renameThread: Mock<(threadId: string, title: string) => Promise<void>>;
  retry: Mock<() => Promise<void>>;
  runtime: string;
  selectedAgent: Agent;
  selectedThread: Thread;
  sending: boolean;
  setEffort: Mock<(value: string) => void>;
  setModel: Mock<(value: string) => void>;
  setRuntime: Mock<(value: string) => void>;
}

function createState(
  overrides: Partial<TestConsoleState> = {},
): TestConsoleState {
  const selectedThread = overrides.selectedThread ?? thread();
  const selectedAgent: Agent = overrides.selectedAgent ?? {
    id: "agent-1",
    label: "Personal Agent",
    endpoint: "http://127.0.0.1:4110",
    online: true,
    pinned: true,
    capabilities: { runtimeOverrides: true },
    defaults: {
      runtime: "pi",
      model: "openai-codex/terra",
    },
    models,
  };
  return {
    archiveThread: vi.fn(async () => undefined),
    connection: "connected",
    createThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    detail: overrides.detail ?? detail(selectedThread),
    effort: "",
    model: "",
    refreshing: false,
    renameThread: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    runtime: "",
    selectedAgent,
    selectedThread,
    sending: false,
    setEffort: vi.fn(),
    setModel: vi.fn(),
    setRuntime: vi.fn(),
    ...overrides,
  };
}

function installState(overrides: Partial<TestConsoleState> = {}): TestConsoleState {
  const state = createState(overrides);
  consoleMock.current = state;
  return state;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    agentId: "agent-1",
    title: "Current conversation",
    titleManual: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "complete",
    ...overrides,
  };
}

function detail(
  selectedThread: Thread,
  messages: readonly Message[] = [],
): ThreadDetail {
  return { thread: selectedThread, messages };
}

function assistantMessage(
  telemetryOverrides: Partial<NonNullable<Message["telemetry"]>>,
): Message {
  return {
    id: "assistant-1",
    threadId: "thread-1",
    role: "assistant",
    text: "Current response",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "complete",
    telemetry: {
      inputTokens: 10,
      outputTokens: 5,
      compacted: false,
      sessionEvicted: false,
      ...telemetryOverrides,
    },
  };
}

async function renderChat(): Promise<HTMLElement> {
  return (await renderChatView()).host;
}

async function renderChatView(): Promise<{
  readonly host: HTMLElement;
  readonly root: Root;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Chat />));
  return { host, root };
}

async function openRunSettings(host: HTMLElement): Promise<void> {
  await openPopover(requiredButton(host, "Run settings"));
  requiredDialog("Run settings");
}

async function openPopover(trigger: HTMLButtonElement): Promise<void> {
  await act(async () => trigger.click());
  await nextFrame();
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
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

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function requiredButton(host: ParentNode, label: string): HTMLButtonElement {
  const byLabel = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  const byTitle = host.querySelector<HTMLButtonElement>(
    `button[title="${label}"]`,
  );
  const button = byLabel ?? byTitle ?? [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (button === undefined || button === null) {
    throw new Error(`Missing ${label} button.`);
  }
  return button;
}

function requiredDialog(label: string): HTMLElement {
  return requiredElement(
    document.body,
    `[role="dialog"][aria-label="${label}"]`,
  );
}

function requiredOption(label: string): HTMLElement {
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.includes(label) === true);
  if (option === undefined) throw new Error(`Missing ${label} model option.`);
  return option;
}

function requiredElement<ElementType extends Element>(
  host: ParentNode,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing ${selector}.`);
  return element;
}

function rowValue(panel: HTMLElement, label: string): string | undefined {
  const term = [...panel.querySelectorAll("dt")]
    .find((candidate) => candidate.textContent === label);
  return term?.nextElementSibling?.textContent ?? undefined;
}
