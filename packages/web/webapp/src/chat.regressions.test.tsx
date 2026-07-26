// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { useAui } from "@assistant-ui/react";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Chat, currentAssistantContext, OPEN_RUN_SETTINGS_EVENT } from "./chat";
import { WebRuntimeProvider } from "./runtime";
import type { Agent, Bootstrap, Message, Thread, ThreadDetail } from "./types";

const consoleMock = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock("./console", () => ({
  useConsole: () => consoleMock.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-07-26T10:00:00.000Z";
const roots: Root[] = [];

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> =>
    FakeNotification.permission,
  );
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: FakeNotification,
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ active: null }) },
  });
  FakeNotification.permission = "default";
  FakeNotification.requestPermission.mockClear();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.textContent = "";
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "Notification");
  Reflect.deleteProperty(window, "isSecureContext");
  Reflect.deleteProperty(navigator, "serviceWorker");
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
});

describe("restored web-console presentation", () => {
  it("renders context, run settings, notification opt-in, and retry in the header", async () => {
    const state = createState();
    consoleMock.current = state;
    const host = await renderChat();
    const header = requiredElement<HTMLElement>(host, ".chat-header-actions");
    const composer = requiredElement<HTMLElement>(host, ".composer-root");

    const context = requiredButton(header, "Context usage");
    expect(context.textContent).toContain("64k");
    expect(context.textContent).toContain("50%");
    expect(requiredButton(header, "Run settings")).toBeDefined();
    expect(requiredButton(header, "Enable notifications")).toBeDefined();
    expect(composer.querySelector('button[aria-label="Run settings"]')).toBeNull();

    await act(async () => context.click());
    await nextFrame();
    expect(document.body.textContent).toContain("64k of 128k tokens");

    await act(async () => window.dispatchEvent(new Event(OPEN_RUN_SETTINGS_EVENT)));
    await nextFrame();
    expect(requiredButton(header, "Run settings").getAttribute("aria-expanded")).toBe("true");

    const retry = requiredButton(host, "Retry");
    await act(async () => retry.click());
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("renders styled actions, quote controls, attachment metadata, and an icon-only send control", async () => {
    const state = createState({
      pendingFiles: [new File(["draft"], "draft.txt", { type: "text/plain" })],
    });
    consoleMock.current = state;
    const host = await renderChat(true);
    const composer = requiredElement<HTMLElement>(host, ".composer-root");

    expect(host.textContent).toContain("text/plain · 1 KB");
    expect(host.querySelector("button.message-action")).not.toBeNull();

    const attach = requiredButton(composer, "Attach files");
    expect(attach.classList.contains("composer-tool")).toBe(true);
    expect(attach.querySelector("svg")).not.toBeNull();

    const remove = requiredButton(composer, "Remove draft.txt");
    expect(remove.classList.contains("attachment-remove")).toBe(true);
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(composer.textContent).toContain("text/plain · 5 B");

    const send = requiredButton(composer, "Send message");
    expect(send.classList.contains("composer-send")).toBe(true);
    expect(send.querySelector("svg")).not.toBeNull();
    expect(send.textContent?.trim()).toBe("");

    expect(composer.querySelector(".composer-quote > svg")).not.toBeNull();
    expect(composer.querySelector(".composer-quote-text")?.textContent).toContain("Quoted response");
    expect(composer.querySelector(".composer-quote-dismiss svg")).not.toBeNull();
  });
});

describe("currentAssistantContext", () => {
  it("does not leak settled telemetry into a newly running turn", () => {
    const settled = assistantMessage({ status: "complete" });
    expect(currentAssistantContext([settled], true)).toEqual({ pending: true });

    const running = assistantMessage({
      id: "assistant-running",
      status: "running",
      telemetry: {
        inputTokens: 10,
        outputTokens: 0,
        contextWindow: 128_000,
        compacted: false,
        sessionEvicted: false,
      },
    });
    expect(currentAssistantContext([settled, running], true)).toEqual({
      pending: true,
      telemetry: running.telemetry,
    });
  });
});

function QuoteSeed() {
  const aui = useAui();
  useEffect(() => {
    aui.composer().setQuote({
      messageId: "assistant-1",
      text: "Quoted response",
    });
  }, [aui]);
  return null;
}

async function renderChat(seedQuote = false): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <WebRuntimeProvider>
        {seedQuote && <QuoteSeed />}
        <Chat onOpenAgents={() => undefined} onOpenThreads={() => undefined} />
      </WebRuntimeProvider>,
    );
  });
  return host;
}

interface TestConsoleState {
  readonly retry: ReturnType<typeof vi.fn>;
  readonly [key: string]: unknown;
}

function createState(overrides: Readonly<Record<string, unknown>> = {}): TestConsoleState {
  const selectedAgent = agent();
  const selectedThread = thread();
  const messages = [
    {
      id: "user-1",
      threadId: selectedThread.id,
      role: "user" as const,
      text: "Please inspect this.",
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "complete" as const,
    },
    assistantMessage(),
  ];
  const detail: ThreadDetail = { thread: selectedThread, messages };
  const bootstrap: Bootstrap = {
    version: 1,
    revision: 1,
    agents: [selectedAgent],
    threads: [selectedThread],
    newProactiveThreadIds: [],
  };
  return {
    authenticated: true,
    loading: false,
    refreshing: false,
    connection: "live",
    error: "The console could not refresh.",
    bootstrap,
    detail,
    selectedAgentId: selectedAgent.id,
    selectedThreadId: selectedThread.id,
    selectedAgent,
    selectedThread,
    visibleAgents: [selectedAgent],
    visibleThreads: [selectedThread],
    hiddenOfflineCount: 0,
    showOffline: false,
    showArchived: false,
    railExpanded: true,
    pendingFiles: [],
    runtime: "pi",
    model: "openai/gpt-5",
    effort: "high",
    login: vi.fn(async () => undefined),
    logout: vi.fn(),
    retry: vi.fn(async () => undefined),
    selectAgent: vi.fn(),
    selectThread: vi.fn(),
    createThread: vi.fn(async () => undefined),
    patchAgent: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    answerAsk: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    setShowOffline: vi.fn(),
    setShowArchived: vi.fn(),
    setRailExpanded: vi.fn(),
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    setRuntime: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    ...overrides,
  };
}

function agent(): Agent {
  return {
    id: "agent-1",
    label: "Personal Agent",
    endpoint: "http://127.0.0.1:4110",
    online: true,
    pinned: true,
    capabilities: {
      attachments: true,
      cancellation: true,
      quotes: true,
      runtimeOverrides: true,
    },
    defaults: {
      runtime: "pi",
      model: "openai/gpt-5",
      effort: "high",
    },
    models: [{
      runtime: "pi",
      id: "openai/gpt-5",
      label: "GPT-5",
      efforts: ["low", "high"],
      contextWindow: 128_000,
    }],
  };
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

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "assistant-1",
    threadId: "thread-1",
    role: "assistant",
    text: "Completed response",
    attachments: [{
      id: "notes",
      name: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: 1_024,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "complete",
    telemetry: {
      inputTokens: 63_900,
      outputTokens: 100,
      contextWindow: 128_000,
      contextUsed: 64_000,
      compacted: false,
      sessionEvicted: false,
    },
    ...overrides,
  };
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function requiredButton(host: ParentNode, label: string): HTMLButtonElement {
  const byLabel = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  const byTitle = host.querySelector<HTMLButtonElement>(
    `button[title="${label}"]`,
  );
  const byText = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  const button = byLabel ?? byTitle ?? byText;
  if (button === undefined || button === null) throw new Error(`Missing ${label} button.`);
  return button;
}

function requiredElement<ElementType extends Element>(
  host: ParentNode,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing ${selector}.`);
  return element;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
