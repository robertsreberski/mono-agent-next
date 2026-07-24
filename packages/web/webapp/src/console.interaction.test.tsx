// @vitest-environment jsdom

import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleProvider, useConsole } from "./console";
import type { Bootstrap, StreamFrame, ThreadDetail } from "./types";

const apiMocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  createThread: vi.fn(),
  deleteThread: vi.fn(),
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
const navigationMocks = vi.hoisted(() => ({
  discardDraft: vi.fn(),
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
      createThread: apiMocks.createThread,
      deleteThread: apiMocks.deleteThread,
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
  apiMocks.createThread.mockResolvedValue(thread("new-thread"));
  apiMocks.deleteThread.mockResolvedValue(undefined);
  apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
  apiMocks.liveInput.mockResolvedValue(undefined);
  apiMocks.streamTurn.mockResolvedValue(undefined);
  navigationMocks.discardDraft.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("console conversation isolation", () => {
  it("does not let an older delayed thread navigation replace the newer selection", async () => {
    const firstDiscard = deferred<void>();
    navigationMocks.discardDraft
      .mockImplementationOnce(async () => await firstDiscard.promise)
      .mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMocks.bootstrap.mockResolvedValue({
      ...bootstrap(),
      threads: [thread("thread-1"), thread("thread-2"), thread("thread-3")],
    });
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    await click(view.host, "compose-draft");

    await click(view.host, "select-thread-2");
    await waitFor(() => navigationMocks.discardDraft.mock.calls.length === 1);
    await click(view.host, "select-thread-3");
    await waitFor(() => text(view.host, "detail") === "thread-3");
    await act(async () => firstDiscard.resolve());

    expect(text(view.host, "selected")).toBe("thread-3");
    expect(text(view.host, "detail")).toBe("thread-3");
    await view.unmount();
  });

  it("does not let an older delayed agent navigation replace the newer selection", async () => {
    const firstDiscard = deferred<void>();
    navigationMocks.discardDraft
      .mockImplementationOnce(async () => await firstDiscard.promise)
      .mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const base = bootstrap();
    apiMocks.bootstrap.mockResolvedValue({
      ...base,
      agents: [
        ...base.agents,
        {
          id: "agent-2",
          label: "Other Agent",
          endpoint: "http://127.0.0.1:4220",
          online: true,
          pinned: false,
          capabilities: {},
        },
      ],
      threads: [
        thread("thread-1"),
        thread("thread-2"),
        thread("thread-3"),
        { ...thread("agent-2-thread"), agentId: "agent-2" },
      ],
    });
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    await click(view.host, "compose-draft");

    await click(view.host, "select-agent-2");
    await waitFor(() => navigationMocks.discardDraft.mock.calls.length === 1);
    await click(view.host, "select-thread-3");
    await waitFor(() => text(view.host, "detail") === "thread-3");
    await act(async () => firstDiscard.resolve());

    expect(text(view.host, "selected-agent")).toBe("agent-1");
    expect(text(view.host, "selected")).toBe("thread-3");
    expect(text(view.host, "detail")).toBe("thread-3");
    await view.unmount();
  });

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

  it("does not refresh or switch when create resolves after navigation", async () => {
    const created = deferred<ReturnType<typeof thread>>();
    apiMocks.createThread.mockImplementation(async () => await created.promise);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "create-thread");
    await waitFor(() => apiMocks.createThread.mock.calls.length === 1);
    await click(view.host, "select-thread-2");
    await waitFor(() => text(view.host, "detail") === "thread-2");
    await click(view.host, "compose-draft");

    await act(async () => {
      created.resolve(thread("new-thread"));
      await created.promise;
      await Promise.resolve();
    });

    expect(apiMocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(text(view.host, "selected")).toBe("thread-2");
    expect(text(view.host, "detail")).toBe("thread-2");
    expect(text(view.host, "draft")).toBe("pending");
    await view.unmount();
  });

  it("does not report a stale catalog error when navigation wins the create refresh", async () => {
    const refreshed = deferred<Bootstrap>();
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    apiMocks.bootstrap.mockImplementationOnce(async () => await refreshed.promise);

    await click(view.host, "create-thread");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 2);
    await click(view.host, "select-thread-2");
    await waitFor(() => text(view.host, "detail") === "thread-2");
    await click(view.host, "compose-draft");

    await act(async () => refreshed.resolve({ ...bootstrap(), revision: 2 }));

    expect(text(view.host, "selected")).toBe("thread-2");
    expect(text(view.host, "detail")).toBe("thread-2");
    expect(text(view.host, "draft")).toBe("pending");
    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("uses the winning refresh when a create-scoped load is superseded", async () => {
    const createRefresh = deferred<Bootstrap>();
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    const withCreatedThread = {
      ...bootstrap(),
      revision: 3,
      threads: [...bootstrap().threads, thread("new-thread")],
    };
    apiMocks.bootstrap
      .mockImplementationOnce(async () => await createRefresh.promise)
      .mockResolvedValue(withCreatedThread);

    await click(view.host, "create-thread");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 2);
    await click(view.host, "retry");
    await waitFor(() => text(view.host, "catalog").includes("new-thread"));

    await act(async () => createRefresh.resolve({ ...bootstrap(), revision: 2 }));
    await waitFor(() => text(view.host, "detail") === "new-thread");

    expect(apiMocks.createThread).toHaveBeenCalledOnce();
    expect(text(view.host, "selected")).toBe("new-thread");
    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("coalesces concurrent new-thread requests into one persistent creation", async () => {
    const created = deferred<ReturnType<typeof thread>>();
    apiMocks.createThread.mockImplementation(async () => await created.promise);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "create-thread");
    await waitFor(() => apiMocks.createThread.mock.calls.length === 1);
    await click(view.host, "create-thread-secondary");
    expect(apiMocks.createThread).toHaveBeenCalledOnce();
    apiMocks.bootstrap.mockResolvedValue({
      ...bootstrap(),
      revision: 2,
      threads: [...bootstrap().threads, thread("new-thread")],
    });
    await act(async () => created.resolve(thread("new-thread")));
    await waitFor(() => text(view.host, "detail") === "new-thread");

    expect(apiMocks.createThread).toHaveBeenCalledOnce();
    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("starts a distinct agent create without letting the older origin win", async () => {
    const createdFromAgentOne = deferred<ReturnType<typeof thread>>();
    const createdFromAgentTwo = deferred<ReturnType<typeof thread>>();
    const base = bootstrap();
    const agentTwoThread = (id: string) => ({ ...thread(id), agentId: "agent-2" });
    const twoAgentBootstrap: Bootstrap = {
      ...base,
      agents: [
        ...base.agents,
        {
          id: "agent-2",
          label: "Other Agent",
          endpoint: "http://127.0.0.1:4220",
          online: true,
          pinned: false,
          capabilities: {},
        },
      ],
      threads: [...base.threads, agentTwoThread("agent-2-thread")],
    };
    apiMocks.bootstrap.mockResolvedValue(twoAgentBootstrap);
    apiMocks.thread.mockImplementation(async (threadId: string) => {
      const next = detail(threadId);
      return threadId.startsWith("agent-2") || threadId === "new-thread-two"
        ? { ...next, thread: agentTwoThread(threadId) }
        : next;
    });
    apiMocks.createThread
      .mockImplementationOnce(async () => await createdFromAgentOne.promise)
      .mockImplementationOnce(async () => await createdFromAgentTwo.promise);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "create-thread");
    await waitFor(() => apiMocks.createThread.mock.calls.length === 1);
    await click(view.host, "select-agent-2");
    await waitFor(() => text(view.host, "detail") === "agent-2-thread");
    await click(view.host, "create-thread-secondary");
    await waitFor(() => apiMocks.createThread.mock.calls.length === 2);
    await click(view.host, "create-thread");
    expect(apiMocks.createThread).toHaveBeenCalledTimes(2);

    apiMocks.bootstrap.mockResolvedValue({
      ...twoAgentBootstrap,
      revision: 2,
      threads: [...twoAgentBootstrap.threads, agentTwoThread("new-thread-two")],
    });
    await act(async () => createdFromAgentTwo.resolve(agentTwoThread("new-thread-two")));
    await waitFor(() => text(view.host, "detail") === "new-thread-two");
    await act(async () => createdFromAgentOne.resolve(thread("new-thread-one")));

    expect(apiMocks.createThread).toHaveBeenCalledTimes(2);
    expect(apiMocks.createThread.mock.calls).toEqual([["agent-1"], ["agent-2"]]);
    expect(text(view.host, "selected-agent")).toBe("agent-2");
    expect(text(view.host, "selected")).toBe("new-thread-two");
    expect(text(view.host, "detail")).toBe("new-thread-two");
    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("keeps a no-thread origin and its new draft when create refresh finishes and discard is cancelled", async () => {
    const initial = bootstrapWithoutThreads();
    const refreshed = deferred<Bootstrap>();
    apiMocks.bootstrap.mockResolvedValue(initial);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "selected-agent") === "agent-1");
    apiMocks.bootstrap.mockImplementationOnce(async () => await refreshed.promise);

    await click(view.host, "create-thread");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 2);
    await click(view.host, "compose-draft");
    await act(async () => refreshed.resolve({
      ...initial,
      revision: 2,
      threads: [thread("new-thread")],
    }));
    await waitFor(() => text(view.host, "catalog") === "new-thread");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(text(view.host, "selected")).toBe("none");
    expect(text(view.host, "detail")).toBe("none");
    expect(text(view.host, "draft")).toBe("pending");
    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("enters a newly created thread from a no-thread origin when no draft appears", async () => {
    const initial = bootstrapWithoutThreads();
    apiMocks.bootstrap.mockResolvedValue(initial);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "selected-agent") === "agent-1");
    apiMocks.bootstrap.mockResolvedValue({
      ...initial,
      revision: 2,
      threads: [thread("new-thread")],
    });

    await click(view.host, "create-thread");
    await waitFor(() => text(view.host, "detail") === "new-thread");

    expect(text(view.host, "catalog")).toBe("new-thread");
    expect(text(view.host, "selected")).toBe("new-thread");
    expect(text(view.host, "draft")).toBe("empty");
    await view.unmount();
  });

  it("clears the previous error when an explicit retry succeeds", async () => {
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    await click(view.host, "report-error");
    expect(text(view.host, "error")).toBe("Previous request failed.");

    await click(view.host, "retry");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length >= 2);

    expect(text(view.host, "error")).toBe("");
    await view.unmount();
  });

  it("blocks background identity replacement until the current draft is discarded", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    await click(view.host, "compose-draft");
    const replacement = {
      ...bootstrap(),
      revision: 2,
      threads: [thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(replacement);

    await click(view.host, "retry");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(text(view.host, "selected")).toBe("thread-1");
    expect(text(view.host, "detail")).toBe("thread-1");
    expect(text(view.host, "draft")).toBe("pending");
    expect(text(view.host, "catalog")).toBe("thread-1|thread-2");

    confirm.mockReturnValue(true);
    await click(view.host, "retry");
    await waitFor(() => text(view.host, "detail") === "thread-2");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(text(view.host, "draft")).toBe("empty");
    expect(text(view.host, "catalog")).toBe("thread-2");
    await view.unmount();
  });

  it("reuses selected-deletion approval when an overlapping refresh wins", async () => {
    const deletion = deferred<void>();
    const heldDeleteRefresh = deferred<Bootstrap>();
    const pendingThread = threadWithAsk();
    const initial = {
      ...bootstrap(),
      threads: [pendingThread, thread("thread-2")],
    };
    const deleted = {
      ...initial,
      revision: 2,
      threads: [thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(initial);
    apiMocks.thread.mockImplementation(async (threadId: string) =>
      threadId === "thread-1"
        ? { ...detail(threadId), thread: pendingThread }
        : detail(threadId)
    );
    apiMocks.deleteThread.mockImplementation(async () => await deletion.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");

    await click(view.host, "delete-thread");
    await waitFor(() => apiMocks.deleteThread.mock.calls.length === 1);
    expect(confirm).toHaveBeenCalledOnce();
    apiMocks.bootstrap
      .mockImplementationOnce(async () => await heldDeleteRefresh.promise)
      .mockResolvedValue(deleted);
    await act(async () => deletion.resolve());
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 2);

    await click(view.host, "retry");
    await waitFor(() => text(view.host, "detail") === "thread-2");
    expect(confirm).toHaveBeenCalledOnce();
    expect(text(view.host, "catalog")).toBe("thread-2");
    expect(text(view.host, "error")).toBe("");

    await act(async () => heldDeleteRefresh.resolve(deleted));
    expect(text(view.host, "selected")).toBe("thread-2");
    expect(confirm).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it("reuses deletion approval for a refresh that started before deletion", async () => {
    const deletion = deferred<void>();
    const heldRefresh = deferred<Bootstrap>();
    const pendingThread = threadWithAsk();
    const initial = {
      ...bootstrap(),
      threads: [pendingThread, thread("thread-2")],
    };
    const deleted = {
      ...initial,
      revision: 2,
      threads: [thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(initial);
    apiMocks.thread.mockImplementation(async (threadId: string) =>
      threadId === "thread-1"
        ? { ...detail(threadId), thread: pendingThread }
        : detail(threadId)
    );
    apiMocks.deleteThread.mockImplementation(async () => await deletion.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderConsole();
    await waitFor(() => text(view.host, "detail") === "thread-1");
    apiMocks.bootstrap
      .mockImplementationOnce(async () => await heldRefresh.promise)
      .mockResolvedValue(deleted);

    await click(view.host, "retry");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 2);
    await click(view.host, "delete-thread");
    await waitFor(() => apiMocks.deleteThread.mock.calls.length === 1);
    expect(confirm).toHaveBeenCalledOnce();

    await act(async () => heldRefresh.resolve(deleted));
    await waitFor(() => text(view.host, "detail") === "thread-2");
    expect(confirm).toHaveBeenCalledOnce();
    expect(text(view.host, "catalog")).toBe("thread-2");

    await act(async () => deletion.resolve());
    await waitFor(() => apiMocks.bootstrap.mock.calls.length === 3);
    expect(text(view.host, "selected")).toBe("thread-2");
    expect(text(view.host, "error")).toBe("");
    expect(confirm).toHaveBeenCalledOnce();
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
  const [draftPending, setDraftPendingState] = useState(false);
  const draftPendingRef = useRef(false);
  const draftGenerationRef = useRef(0);
  const setDraftPending = (value: boolean) => {
    if (draftPendingRef.current !== value) draftGenerationRef.current += 1;
    draftPendingRef.current = value;
    setDraftPendingState(value);
  };
  useEffect(
    () => consoleState.registerNavigationBlocker({
      hasPending: () => draftPendingRef.current,
      pendingKey: () => String(draftGenerationRef.current),
      discard: async () => {
        await navigationMocks.discardDraft();
        setDraftPending(false);
      },
    }),
    [consoleState.registerNavigationBlocker],
  );
  return (
    <>
      <output data-testid="selected-agent">{consoleState.selectedAgentId ?? "none"}</output>
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
      <output data-testid="draft">{draftPending ? "pending" : "empty"}</output>
      <output data-testid="catalog">
        {consoleState.visibleThreads.map((thread) => thread.id).join("|")}
      </output>
      <button type="button" data-testid="select-thread-1" onClick={() => consoleState.selectThread("thread-1")}>
        One
      </button>
      <button type="button" data-testid="select-thread-2" onClick={() => consoleState.selectThread("thread-2")}>
        Two
      </button>
      <button type="button" data-testid="select-thread-3" onClick={() => consoleState.selectThread("thread-3")}>
        Three
      </button>
      <button type="button" data-testid="select-agent-2" onClick={() => consoleState.selectAgent("agent-2")}>
        Agent two
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
      <button type="button" data-testid="create-thread" onClick={() => void consoleState.createThread()}>
        New conversation
      </button>
      <button
        type="button"
        data-testid="create-thread-secondary"
        onClick={() => void consoleState.createThread()}
      >
        New conversation elsewhere
      </button>
      <button
        type="button"
        data-testid="delete-thread"
        onClick={() => {
          if (consoleState.selectedThreadId !== undefined) {
            void consoleState.deleteThread(consoleState.selectedThreadId);
          }
        }}
      >
        Delete conversation
      </button>
      <button type="button" data-testid="compose-draft" onClick={() => setDraftPending(true)}>
        Compose draft
      </button>
      <button
        type="button"
        data-testid="report-error"
        onClick={() => consoleState.reportError("Previous request failed.")}
      >
        Report error
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

function bootstrapWithoutThreads(): Bootstrap {
  return { ...bootstrap(), threads: [] };
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

function threadWithAsk() {
  return {
    ...thread("thread-1"),
    pendingAsk: {
      interactionId: "interaction-1",
      requestedAt: timestamp,
      questions: [{
        id: "approval",
        prompt: "Continue?",
        choices: [{ value: "continue", label: "Continue" }],
        allowFreeText: false,
        multiple: false,
      }],
    },
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
