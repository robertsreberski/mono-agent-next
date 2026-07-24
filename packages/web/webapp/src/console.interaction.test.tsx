// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleProvider, useConsole } from "./console";
import type { Bootstrap, StreamFrame, ThreadDetail } from "./types";

const apiMocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  thread: vi.fn(),
  liveInput: vi.fn(),
  streamTurn: vi.fn(),
  subscribeEvents: vi.fn(
    async (
      _revision: number | undefined,
      _onEvent: (event: unknown) => void,
      signal: AbortSignal,
    ) => await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    readToken: () => "authenticated-test-token",
    saveToken: vi.fn(),
    subscribeEvents: apiMocks.subscribeEvents,
    streamTurn: apiMocks.streamTurn,
    api: {
      ...actual.api,
      probeBootstrap: async () => {
        throw new actual.ApiError("Unauthorized.", 401, "unauthorized");
      },
      bootstrap: apiMocks.bootstrap,
      thread: apiMocks.thread,
      liveInput: apiMocks.liveInput,
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

beforeEach(() => {
  apiMocks.bootstrap.mockResolvedValue(bootstrap());
  apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
  apiMocks.liveInput.mockResolvedValue(undefined);
  apiMocks.streamTurn.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("console conversation isolation", () => {
  it("clears stale detail immediately and ignores an older detail response", async () => {
    const threadTwo = deferred<ThreadDetail>();
    apiMocks.thread.mockImplementation((threadId: string) =>
      threadId === "thread-2" ? threadTwo.promise : Promise.resolve(detail(threadId))
    );
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "select-thread-2");
    expect(text(view.host, "selected")).toBe("thread-2");
    expect(text(view.host, "detail")).toBe("none");

    await click(view.host, "send");
    expect(apiMocks.streamTurn).not.toHaveBeenCalled();
    expect(text(view.host, "error")).toBe("Wait for the selected conversation to finish loading.");

    await click(view.host, "select-thread-1");
    await waitFor(() => text(view.host, "detail") === "thread-1");
    await act(async () => threadTwo.resolve(detail("thread-2")));

    expect(text(view.host, "selected")).toBe("thread-1");
    expect(text(view.host, "detail")).toBe("thread-1");
    await view.unmount();
  });

  it("does not let an old turn stream overwrite the newly selected conversation", async () => {
    const stream = deferred<void>();
    let onFrame: ((frame: StreamFrame) => void) | undefined;
    apiMocks.streamTurn.mockImplementation(async (
      _threadId: string,
      _input: unknown,
      callback: (frame: StreamFrame) => void,
    ) => {
      onFrame = callback;
      await stream.promise;
    });
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "send");
    await waitFor(() => apiMocks.streamTurn.mock.calls.length === 1);
    await click(view.host, "select-thread-2");
    await waitFor(() => text(view.host, "detail") === "thread-2");

    await act(async () => {
      onFrame?.({
        type: "state",
        detail: {
          ...detail("thread-1"),
          messages: [{
            id: "stale-stream-message",
            threadId: "thread-1",
            role: "assistant",
            text: "This must not cross the selection boundary.",
            createdAt: timestamp,
            updatedAt: timestamp,
            status: "running",
          }],
        },
      });
    });

    expect(text(view.host, "selected")).toBe("thread-2");
    expect(text(view.host, "detail")).toBe("thread-2");
    expect(text(view.host, "messages")).toBe("Current thread-2");
    await act(async () => stream.resolve());
    await view.unmount();
  });

  it("does not surface a late transport failure in another conversation", async () => {
    const stream = deferred<void>();
    apiMocks.streamTurn.mockImplementation(async () => await stream.promise);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "send");
    await waitFor(() => text(view.host, "submitting") === "yes");
    await click(view.host, "select-thread-2");
    await waitFor(() => text(view.host, "detail") === "thread-2");
    await act(async () => stream.reject(new Error("Late thread-one transport failure.")));
    await waitFor(() => text(view.host, "submitting") === "no");

    expect(text(view.host, "selected")).toBe("thread-2");
    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("does not surface a late live-input failure in another conversation", async () => {
    const liveInput = deferred<void>();
    apiMocks.liveInput.mockImplementation(async () => await liveInput.promise);
    apiMocks.thread.mockImplementation(async (threadId: string) =>
      threadId === "thread-1"
        ? {
            ...detail(threadId),
            thread: { ...thread(threadId), status: "running", activeTurnId: "active-turn" },
          }
        : detail(threadId)
    );
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "send");
    await waitFor(() => text(view.host, "submitting") === "yes");
    await click(view.host, "select-thread-2");
    await waitFor(() => text(view.host, "detail") === "thread-2");
    await act(async () => liveInput.reject(new Error("Late steering failure.")));
    await waitFor(() => text(view.host, "submitting") === "no");

    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("keeps context pending until current-turn telemetry arrives", async () => {
    const stream = deferred<void>();
    let onFrame: ((frame: StreamFrame) => void) | undefined;
    apiMocks.thread.mockImplementation(async (threadId: string) =>
      threadId === "thread-1" ? contextDetail("previous-turn", true) : detail(threadId)
    );
    apiMocks.streamTurn.mockImplementation(async (
      _threadId: string,
      _input: unknown,
      callback: (frame: StreamFrame) => void,
    ) => {
      onFrame = callback;
      await stream.promise;
    });
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "send");
    await waitFor(() => text(view.host, "context-pending") === "yes");
    await act(async () => onFrame?.({
      type: "state",
      detail: contextDetail("current-turn", false, "running"),
    }));
    expect(text(view.host, "context-pending")).toBe("yes");

    await act(async () => onFrame?.({
      type: "state",
      detail: contextDetail("current-turn", true, "running"),
    }));
    await waitFor(() => text(view.host, "context-pending") === "no");
    await act(async () => stream.resolve());
    await view.unmount();
  });

  it("clears context pending when the current turn settles without telemetry", async () => {
    const stream = deferred<void>();
    let onFrame: ((frame: StreamFrame) => void) | undefined;
    apiMocks.thread.mockImplementation(async (threadId: string) =>
      threadId === "thread-1" ? contextDetail("previous-turn", true) : detail(threadId)
    );
    apiMocks.streamTurn.mockImplementation(async (
      _threadId: string,
      _input: unknown,
      callback: (frame: StreamFrame) => void,
    ) => {
      onFrame = callback;
      await stream.promise;
    });
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "send");
    await waitFor(() => text(view.host, "context-pending") === "yes");
    await act(async () => onFrame?.({
      type: "done",
      detail: contextDetail("current-turn", false, "failed"),
    }));
    await waitFor(() => text(view.host, "context-pending") === "no");
    await act(async () => stream.resolve());
    await view.unmount();
  });

  it("revalidates authored model routes and effort against same-agent refreshes", async () => {
    apiMocks.bootstrap.mockResolvedValue(modelBootstrap(["high", "max"], true));
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    await click(view.host, "set-overrides");
    expect(text(view.host, "runtime")).toBe("terra");
    expect(text(view.host, "model")).toBe("provider:model");
    expect(text(view.host, "effort")).toBe("high");

    apiMocks.bootstrap.mockResolvedValue(modelBootstrap(["max"], true));
    await click(view.host, "retry");
    await waitFor(() => text(view.host, "effort") === "");
    expect(text(view.host, "runtime")).toBe("terra");
    expect(text(view.host, "model")).toBe("provider:model");

    apiMocks.bootstrap.mockResolvedValue(modelBootstrap(["max"], false));
    await click(view.host, "retry");
    await waitFor(() => text(view.host, "runtime") === "");
    expect(text(view.host, "model")).toBe("");
    expect(text(view.host, "effort")).toBe("");
    await view.unmount();
  });
});

function Probe() {
  const consoleState = useConsole();
  return (
    <>
      <output data-testid="selected">{consoleState.selectedThreadId ?? "none"}</output>
      <output data-testid="detail">{consoleState.detail?.thread.id ?? "none"}</output>
      <output data-testid="messages">
        {consoleState.detail?.messages.map((message) => message.text).join("|") ?? ""}
      </output>
      <output data-testid="error">{consoleState.error ?? ""}</output>
      <output data-testid="submitting">{consoleState.submitting ? "yes" : "no"}</output>
      <output data-testid="context-pending">{consoleState.sending ? "yes" : "no"}</output>
      <output data-testid="runtime">{consoleState.runtime}</output>
      <output data-testid="model">{consoleState.model}</output>
      <output data-testid="effort">{consoleState.effort}</output>
      <button type="button" data-testid="select-thread-1" onClick={() => consoleState.selectThread("thread-1")}>
        One
      </button>
      <button type="button" data-testid="select-thread-2" onClick={() => consoleState.selectThread("thread-2")}>
        Two
      </button>
      <button
        type="button"
        data-testid="send"
        onClick={() => void consoleState.send({ text: "Hello" }, [])}
      >
        Send
      </button>
      <button
        type="button"
        data-testid="set-overrides"
        onClick={() => {
          consoleState.setRuntime("terra");
          consoleState.setModel("provider:model");
          consoleState.setEffort("high");
        }}
      >
        Overrides
      </button>
      <button type="button" data-testid="retry" onClick={() => void consoleState.retry()}>
        Retry
      </button>
    </>
  );
}

async function renderConsole(): Promise<{
  readonly host: HTMLDivElement;
  readonly unmount: () => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ConsoleProvider><Probe /></ConsoleProvider>);
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

async function click(host: HTMLElement, testId: string): Promise<void> {
  await act(async () => {
    requiredElement<HTMLButtonElement>(host, `[data-testid="${testId}"]`).click();
  });
}

function text(host: HTMLElement, testId: string): string {
  return requiredElement<HTMLOutputElement>(host, `[data-testid="${testId}"]`).textContent ?? "";
}

async function waitFor(read: () => boolean, attempts = 30): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (read()) return;
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for console state");
}

function requiredElement<ElementType extends Element>(
  host: ParentNode,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

function bootstrap(): Bootstrap {
  return {
    version: 1,
    revision: 1,
    agents: [{
      id: "agent-1",
      label: "Personal Agent",
      endpoint: "http://127.0.0.1:4110",
      online: true,
      pinned: true,
      capabilities: {},
    }],
    threads: [thread("thread-1"), thread("thread-2")],
    newProactiveThreadIds: [],
  };
}

function thread(id: string) {
  return {
    id,
    agentId: "agent-1",
    operatorConversationId: `operator-${id}`,
    title: id,
    titleManual: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle" as const,
  };
}

function detail(threadId: string): ThreadDetail {
  return {
    thread: thread(threadId),
    messages: [{
      id: `message-${threadId}`,
      threadId,
      role: "assistant",
      text: `Current ${threadId}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "complete",
    }],
  };
}

function contextDetail(
  turnId: string,
  withContext: boolean,
  status: "complete" | "running" | "failed" = "complete",
): ThreadDetail {
  return {
    thread: {
      ...thread("thread-1"),
      status,
      ...(status === "running" ? { activeTurnId: turnId } : { lastTurnId: turnId }),
    },
    messages: [{
      id: `assistant-${turnId}`,
      threadId: "thread-1",
      turnId,
      role: "assistant",
      text: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      status,
      telemetry: {
        inputTokens: 100,
        outputTokens: 20,
        ...(withContext ? { contextUsed: 120 } : {}),
        contextWindow: 1_000,
        compacted: false,
        sessionEvicted: false,
      },
    }],
  };
}

function modelBootstrap(
  efforts: readonly string[],
  includeAuthoredRoute: boolean,
): Bootstrap {
  const base = bootstrap();
  return {
    ...base,
    revision: base.revision + 1,
    agents: [{
      ...base.agents[0]!,
      capabilities: { runtimeOverrides: true },
      defaults: { runtime: "pi", model: "provider:default" },
      models: [
        { runtime: "pi", id: "provider:default", efforts: ["medium"] },
        ...(includeAuthoredRoute
          ? [{ runtime: "terra", id: "provider:model", efforts }]
          : []),
      ],
    }],
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolveValue!: (value: Value) => void;
  let rejectValue!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
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

const timestamp = "2026-07-24T08:00:00.000Z";
