// @vitest-environment jsdom

import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
} from "@assistant-ui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleProvider, useConsole } from "../console";
import { WebRuntimeProvider } from "../runtime";
import type { Bootstrap, StartTurnInput, ThreadDetail } from "../types";
import { Composer } from "./Composer";
import { PopoverProvider } from "./Popover";

const apiMocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  thread: vi.fn(),
  createThread: vi.fn(),
  deleteThread: vi.fn(),
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

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
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
      createThread: apiMocks.createThread,
      deleteThread: apiMocks.deleteThread,
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
  apiMocks.thread.mockResolvedValue(detail());
  apiMocks.createThread.mockResolvedValue(thread("new-thread"));
  apiMocks.deleteThread.mockResolvedValue(undefined);
  apiMocks.streamTurn.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("assistant-ui composer delivery", () => {
  it("sends an attachment-only turn from assistant-ui's native composer state", async () => {
    const view = await renderComposer();
    const input = await waitFor(() => view.host.querySelector<HTMLInputElement>('input[type="file"]'));
    await attach(input, new File(["hello"], "notes.txt", { type: "text/plain" }));
    await waitFor(() => view.host.textContent?.includes("notes.txt"));

    const send = requiredElement<HTMLButtonElement>(view.host, 'button[aria-label="Send message"]');
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    await waitFor(() => apiMocks.streamTurn.mock.calls.length === 1);

    const [threadId, payload] = apiMocks.streamTurn.mock.calls[0] as [
      string,
      StartTurnInput,
    ];
    expect(threadId).toBe("thread-1");
    expect(payload).toMatchObject({
      text: "",
      attachments: [{
        name: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 5,
        url: "data:text/plain;base64,aGVsbG8=",
      }],
    });
    await waitFor(() => !view.host.textContent?.includes("notes.txt"));
    await view.unmount();
  });

  it("surfaces a failed send and restores text, quote, and attachments for retry", async () => {
    apiMocks.streamTurn.mockRejectedValue(new Error("Connection dropped."));
    const view = await renderComposer();
    const textarea = await waitFor(
      () => view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'),
    );
    await inputText(textarea, "Retry this exact draft");
    await act(async () => {
      requiredElement<HTMLButtonElement>(view.host, '[data-testid="set-quote"]').click();
    });
    const input = requiredElement<HTMLInputElement>(view.host, 'input[type="file"]');
    await attach(input, new File(["draft"], "draft.txt", { type: "text/plain" }));
    await waitFor(() => view.host.textContent?.includes("draft.txt"));

    await act(async () => {
      requiredElement<HTMLButtonElement>(view.host, 'button[aria-label="Send message"]').click();
    });
    await waitFor(() => requiredElement<HTMLOutputElement>(
      view.host,
      '[data-testid="error"]',
    ).textContent === "Connection dropped.");
    await waitFor(() => textarea.value === "Retry this exact draft");

    expect(view.host.textContent).toContain("draft.txt");
    expect(view.host.textContent).toContain("selected fragment");
    expect(
      requiredElement<HTMLButtonElement>(view.host, 'button[aria-label="Send message"]').disabled,
    ).toBe(false);
    await view.unmount();
  });

  it("keeps defaults implicit and selects runtime/model as one catalog route", async () => {
    const base = bootstrap();
    apiMocks.bootstrap.mockResolvedValue({
      ...base,
      agents: [{
        ...base.agents[0]!,
        capabilities: {
          ...base.agents[0]!.capabilities,
          runtimeOverrides: true,
        },
        defaults: {
          runtime: "pi",
          model: "provider:default",
          effort: "medium",
        },
        models: [
          {
            runtime: "pi",
            id: "provider:default",
            label: "Default model",
            efforts: ["low", "medium", "high"],
          },
          {
            runtime: "terra",
            id: "provider:shared-id",
            label: "Shared model",
            efforts: ["high", "max"],
          },
        ],
      }],
    });
    const view = await renderComposer();

    expect(output(view.host, "runtime")).toBe("");
    expect(output(view.host, "model")).toBe("");
    expect(output(view.host, "effort")).toBe("");
    await act(async () => {
      requiredElement<HTMLButtonElement>(view.host, 'button[aria-label="Run settings"]').click();
    });
    const model = await waitFor(() =>
      document.querySelector<HTMLSelectElement>('.composer-settings-panel label:first-child select')
    );
    expect([...model.options].map((option) => option.textContent)).toContain(
      "Shared model — terra",
    );
    expect(document.querySelector(".composer-settings-panel input")).toBeNull();

    await changeSelect(model, JSON.stringify(["terra", "provider:shared-id"]));
    expect(output(view.host, "runtime")).toBe("terra");
    expect(output(view.host, "model")).toBe("provider:shared-id");
    expect(output(view.host, "effort")).toBe("");
    expect(document.querySelector(".composer-settings-panel")).not.toBeNull();
    const effort = requiredElement<HTMLSelectElement>(
      document,
      ".composer-settings-panel label:nth-child(2) select",
    );
    expect([...effort.options].map((option) => option.value)).toEqual(["", "high", "max"]);
    await changeSelect(effort, "high");
    expect(output(view.host, "effort")).toBe("high");

    await changeSelect(model, "");
    expect(output(view.host, "runtime")).toBe("");
    expect(output(view.host, "model")).toBe("");
    expect(output(view.host, "effort")).toBe("");
    await view.unmount();
  });

  it("guards native thread navigation and releases discarded attachment quota", async () => {
    const base = bootstrap();
    apiMocks.bootstrap.mockResolvedValue({
      ...base,
      threads: [thread("thread-1"), thread("thread-2")],
    });
    apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await renderComposer();
    const textarea = await waitFor(
      () => view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'),
    );
    await inputText(textarea, "Keep this draft");
    await click(view.host, "set-quote");
    const input = requiredElement<HTMLInputElement>(view.host, 'input[type="file"]');
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await attach(input, new File([name], name, { type: "text/plain" }));
    }
    await waitFor(() => view.host.querySelectorAll(".pending-files li").length === 3);

    await click(view.host, "retry-console");
    await waitFor(() => apiMocks.bootstrap.mock.calls.length >= 2);
    expect(confirm).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Keep this draft");
    expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(3);

    await click(view.host, "open-thread-2");
    await waitFor(() => confirm.mock.calls.length === 1);
    expect(output(view.host, "selected-thread")).toBe("thread-1");
    expect(textarea.value).toBe("Keep this draft");
    expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(3);
    expect(view.host.textContent).toContain("selected fragment");

    confirm.mockReturnValue(true);
    await click(view.host, "open-thread-2");
    await waitFor(() => output(view.host, "selected-thread") === "thread-2");
    await waitFor(() => textarea.value === "");
    expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(0);
    expect(view.host.textContent).not.toContain("selected fragment");

    await click(view.host, "open-thread-1");
    await waitFor(() => output(view.host, "selected-thread") === "thread-1");
    for (const name of ["four.txt", "five.txt", "six.txt"]) {
      await attach(input, new File([name], name, { type: "text/plain" }));
    }
    await waitFor(() => view.host.querySelectorAll(".pending-files li").length === 3);
    expect(output(view.host, "error")).not.toContain("at most 3 files");
    await view.unmount();
  });

  it("confirms selected-thread deletion and releases its draft attachment quota", async () => {
    const base = bootstrap();
    const withTwoThreads = {
      ...base,
      threads: [thread("thread-1"), thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(withTwoThreads);
    apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
    apiMocks.deleteThread.mockImplementation(async () => {
      apiMocks.bootstrap.mockResolvedValue({
        ...withTwoThreads,
        revision: 2,
        threads: [thread("thread-2")],
      });
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await renderComposer();
    const textarea = await waitFor(
      () => view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'),
    );
    await inputText(textarea, "Delete only after discarding this draft");
    const input = requiredElement<HTMLInputElement>(view.host, 'input[type="file"]');
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      await attach(input, new File([name], name, { type: "text/plain" }));
    }
    await waitFor(() => view.host.querySelectorAll(".pending-files li").length === 3);

    await click(view.host, "delete-selected");
    await waitFor(() => confirm.mock.calls.length === 1);
    expect(apiMocks.deleteThread).not.toHaveBeenCalled();
    expect(output(view.host, "selected-thread")).toBe("thread-1");
    expect(textarea.value).toBe("Delete only after discarding this draft");
    expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(3);

    confirm.mockReturnValue(true);
    await click(view.host, "delete-selected");
    await waitFor(() => output(view.host, "selected-thread") === "thread-2");
    await waitFor(() => textarea.value === "");
    expect(apiMocks.deleteThread).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(0);

    const nextInput = requiredElement<HTMLInputElement>(view.host, 'input[type="file"]');
    for (const name of ["four.txt", "five.txt", "six.txt"]) {
      await attach(nextInput, new File([name], name, { type: "text/plain" }));
    }
    await waitFor(() => view.host.querySelectorAll(".pending-files li").length === 3);
    expect(output(view.host, "error")).not.toContain("at most 3 files");
    await view.unmount();
  });

  it("requires a new deletion-refresh approval after identical text is retyped", async () => {
    const deletion = deferred<void>();
    const base = bootstrap();
    const withTwoThreads = {
      ...base,
      threads: [thread("thread-1"), thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(withTwoThreads);
    apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
    apiMocks.deleteThread.mockImplementation(async () => await deletion.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderComposer();
    const textarea = requiredElement<HTMLTextAreaElement>(
      view.host,
      'textarea[aria-label="Message"]',
    );

    await inputText(textarea, "same draft");
    await click(view.host, "delete-selected");
    await waitFor(() => apiMocks.deleteThread.mock.calls.length === 1);
    await waitFor(() => textarea.value === "");
    expect(confirm).toHaveBeenCalledOnce();

    await inputText(textarea, "same draft");
    apiMocks.bootstrap.mockResolvedValue({
      ...withTwoThreads,
      revision: 2,
      threads: [thread("thread-2")],
    });
    await act(async () => deletion.resolve(undefined));

    await waitFor(() => output(view.host, "selected-thread") === "thread-2");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(textarea.value).toBe("");
    await view.unmount();
  });

  it("requires a new deletion-refresh approval for a repeated AskUser answer", async () => {
    const deletion = deferred<void>();
    const base = bootstrap();
    const pending = threadWithAsk();
    const withTwoThreads = {
      ...base,
      threads: [pending, thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(withTwoThreads);
    apiMocks.thread.mockImplementation(async (threadId: string) =>
      threadId === "thread-1"
        ? { ...detail(threadId), thread: pending }
        : detail(threadId)
    );
    apiMocks.deleteThread.mockImplementation(async () => await deletion.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderComposer();
    const choice = await waitFor(() =>
      view.host.querySelector<HTMLInputElement>('.ask-card input[name="approval"]')
    );

    await act(async () => choice.click());
    expect(choice.checked).toBe(true);
    await click(view.host, "delete-selected");
    await waitFor(() => apiMocks.deleteThread.mock.calls.length === 1);
    await waitFor(() => choice.checked === false);
    expect(confirm).toHaveBeenCalledOnce();

    await act(async () => choice.click());
    expect(choice.checked).toBe(true);
    apiMocks.bootstrap.mockResolvedValue({
      ...withTwoThreads,
      revision: 2,
      threads: [thread("thread-2")],
    });
    await act(async () => deletion.resolve(undefined));

    await waitFor(() => output(view.host, "selected-thread") === "thread-2");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(view.host.querySelector(".ask-card")).toBeNull();
    await view.unmount();
  });

  it("requires a new deletion-refresh approval for a later attachment preparation", async () => {
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementation(() => undefined);
    const abortSpy = vi.spyOn(FileReader.prototype, "abort")
      .mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deletion = deferred<void>();
    const base = bootstrap();
    const withTwoThreads = {
      ...base,
      threads: [thread("thread-1"), thread("thread-2")],
    };
    apiMocks.bootstrap.mockResolvedValue(withTwoThreads);
    apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
    apiMocks.deleteThread.mockImplementation(async () => await deletion.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderComposer();
    try {
      const textarea = requiredElement<HTMLTextAreaElement>(
        view.host,
        'textarea[aria-label="Message"]',
      );
      await paste(textarea, new File(["first"], "first.txt", { type: "text/plain" }));
      await waitFor(() => readSpy.mock.calls.length === 1);

      await click(view.host, "delete-selected");
      await waitFor(() => apiMocks.deleteThread.mock.calls.length === 1);
      await waitFor(() => abortSpy.mock.calls.length === 1);
      expect(confirm).toHaveBeenCalledOnce();
      expect(output(view.host, "selected-thread")).toBe("thread-1");

      await paste(textarea, new File(["second"], "second.txt", { type: "text/plain" }));
      await waitFor(() => readSpy.mock.calls.length === 2);
      apiMocks.bootstrap.mockResolvedValue({
        ...withTwoThreads,
        revision: 2,
        threads: [thread("thread-2")],
      });
      await act(async () => deletion.resolve(undefined));

      await waitFor(() => output(view.host, "selected-thread") === "thread-2");
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(abortSpy).toHaveBeenCalledTimes(2);
      expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(0);
      expect(output(view.host, "error")).toBe("");
    } finally {
      consoleError.mockRestore();
      abortSpy.mockRestore();
      readSpy.mockRestore();
      await view.unmount();
    }
  });

  it("aborts a pasted file read before navigating away from its originating composer", async () => {
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementation(() => undefined);
    const abortSpy = vi.spyOn(FileReader.prototype, "abort")
      .mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = bootstrap();
    apiMocks.bootstrap.mockResolvedValue({
      ...base,
      threads: [thread("thread-1"), thread("thread-2")],
    });
    apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderComposer();
    try {
      const input = requiredElement<HTMLTextAreaElement>(
        view.host,
        'textarea[aria-label="Message"]',
      );
      await paste(input, new File(["delayed"], "pasted.txt", { type: "text/plain" }));
      await waitFor(() => readSpy.mock.calls.length === 1);

      await click(view.host, "open-thread-2");
      await waitFor(() => output(view.host, "selected-thread") === "thread-2");
      expect(confirm).toHaveBeenCalledOnce();
      expect(abortSpy).toHaveBeenCalledOnce();
      expect(view.host.querySelectorAll(".pending-files li")).toHaveLength(0);
      expect(output(view.host, "error")).toBe("");
    } finally {
      consoleError.mockRestore();
      abortSpy.mockRestore();
      readSpy.mockRestore();
      await view.unmount();
    }
  });

  it("guards direct agent and new-thread navigation for quote-only drafts", async () => {
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
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await renderComposer();
    await click(view.host, "set-quote");

    await click(view.host, "select-agent-2");
    await waitFor(() => confirm.mock.calls.length === 1);
    expect(output(view.host, "selected-agent")).toBe("agent-1");
    expect(view.host.textContent).toContain("selected fragment");

    await click(view.host, "create-thread");
    await waitFor(() => confirm.mock.calls.length === 2);
    expect(apiMocks.createThread).not.toHaveBeenCalled();
    expect(output(view.host, "selected-thread")).toBe("thread-1");
    await view.unmount();
  });

  it("restores consecutive failed drafts in FIFO order", async () => {
    apiMocks.streamTurn.mockRejectedValue(new Error("Transport unavailable."));
    const view = await renderComposer();
    const textarea = await waitFor(
      () => view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'),
    );

    await click(view.host, "append-two");
    await waitFor(() => textarea.value === "older draft");
    await waitFor(() => view.host.querySelector(".composer-recovery"));
    expect(view.host.textContent).toContain("The failed message is saved.");

    await click(view.host, "reset-composer");
    await waitFor(() => textarea.value === "newer draft");
    await waitFor(() => !view.host.querySelector(".composer-recovery"));
    await view.unmount();
  });

  it("keeps a late failed draft with its originating thread", async () => {
    const stream = deferred<void>();
    apiMocks.streamTurn.mockImplementation(async () => await stream.promise);
    const base = bootstrap();
    apiMocks.bootstrap.mockResolvedValue({
      ...base,
      threads: [thread("thread-1"), thread("thread-2")],
    });
    apiMocks.thread.mockImplementation(async (threadId: string) => detail(threadId));
    const view = await renderComposer();
    const textarea = await waitFor(
      () => view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'),
    );
    await inputText(textarea, "belongs to thread one");
    await act(async () => {
      requiredElement<HTMLButtonElement>(view.host, 'button[aria-label="Send message"]').click();
    });
    await waitFor(() => apiMocks.streamTurn.mock.calls.length === 1);
    await click(view.host, "open-thread-2");
    await waitFor(() => output(view.host, "selected-thread") === "thread-2");

    await act(async () => stream.reject(new Error("Late thread-one failure.")));
    expect(output(view.host, "error")).toBe("");
    expect(textarea.value).toBe("");

    await click(view.host, "open-thread-1");
    await waitFor(() => output(view.host, "selected-thread") === "thread-1");
    await waitFor(() => textarea.value === "belongs to thread one");
    await view.unmount();
  });
});

function TestControls() {
  const aui = useAui();
  const consoleState = useConsole();
  return (
    <>
      <button
        type="button"
        data-testid="set-quote"
        onClick={() => aui.composer().setQuote({
          messageId: "assistant-source",
          text: "selected fragment",
        })}
      >
        Quote
      </button>
      <button
        type="button"
        data-testid="append-two"
        onClick={() => {
          void aui.thread().append({
            role: "user",
            content: [{ type: "text", text: "older draft" }],
          });
          void aui.thread().append({
            role: "user",
            content: [{ type: "text", text: "newer draft" }],
          });
        }}
      >
        Append two
      </button>
      <button
        type="button"
        data-testid="reset-composer"
        onClick={() => void aui.composer().reset()}
      >
        Reset
      </button>
      <output data-testid="error" role="alert">{consoleState.error ?? ""}</output>
      <output data-testid="runtime">{consoleState.runtime}</output>
      <output data-testid="model">{consoleState.model}</output>
      <output data-testid="effort">{consoleState.effort}</output>
      <output data-testid="selected-thread">{consoleState.selectedThreadId ?? ""}</output>
      <output data-testid="selected-agent">{consoleState.selectedAgentId ?? ""}</output>
      <button
        type="button"
        data-testid="select-agent-2"
        onClick={() => void consoleState.selectAgent("agent-2")}
      >
        Select agent two
      </button>
      <button
        type="button"
        data-testid="create-thread"
        onClick={() => void consoleState.createThread()}
      >
        Create
      </button>
      <button
        type="button"
        data-testid="retry-console"
        onClick={() => void consoleState.retry()}
      >
        Refresh
      </button>
      <button
        type="button"
        data-testid="delete-selected"
        onClick={() => {
          if (consoleState.selectedThreadId !== undefined) {
            void consoleState.deleteThread(consoleState.selectedThreadId);
          }
        }}
      >
        Delete
      </button>
      <ThreadListPrimitive.Root>
        <ThreadListPrimitive.Items>
          {({ threadListItem }) => (
            <ThreadListItemPrimitive.Root>
              <ThreadListItemPrimitive.Trigger data-testid={`open-${threadListItem.id}`}>
                {threadListItem.id}
              </ThreadListItemPrimitive.Trigger>
            </ThreadListItemPrimitive.Root>
          )}
        </ThreadListPrimitive.Items>
      </ThreadListPrimitive.Root>
    </>
  );
}

async function renderComposer(): Promise<{
  readonly host: HTMLDivElement;
  readonly unmount: () => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ConsoleProvider>
        <WebRuntimeProvider>
          <PopoverProvider>
            <Composer />
            <TestControls />
          </PopoverProvider>
        </WebRuntimeProvider>
      </ConsoleProvider>,
    );
  });
  await waitFor(() => host.querySelector('textarea[aria-label="Message"]'));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

async function attach(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function paste(input: HTMLTextAreaElement, file: File): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { files: [file] },
  });
  await act(async () => {
    input.dispatchEvent(event);
  });
}

async function click(host: ParentNode, testId: string): Promise<void> {
  await act(async () => {
    requiredElement<HTMLButtonElement>(host, `[data-testid="${testId}"]`).click();
  });
}

async function inputText(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function output(host: HTMLElement, testId: string): string {
  return requiredElement<HTMLOutputElement>(
    host,
    `[data-testid="${testId}"]`,
  ).textContent ?? "";
}

async function waitFor<Value>(
  read: () => Value | null | undefined | false,
  attempts = 40,
): Promise<Value> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for composer state");
}

function requiredElement<ElementType extends Element>(
  host: ParentNode,
  selector: string,
): ElementType {
  const element = host.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
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
      capabilities: {
        attachments: true,
        quotes: true,
      },
    }],
    threads: [thread()],
    newProactiveThreadIds: [],
  };
}

function detail(threadId = "thread-1"): ThreadDetail {
  return {
    thread: thread(threadId),
    messages: [{
      id: "assistant-source",
      operatorMessageId: "operator-message-1",
      threadId,
      role: "assistant",
      text: "Authoritative full response",
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "complete",
    }],
  };
}

function thread(id = "thread-1") {
  return {
    id,
    agentId: "agent-1",
    operatorConversationId: `operator-${id}`,
    title: "Test conversation",
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
