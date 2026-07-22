import type { AssistantRuntime } from "@assistant-ui/react";
import { useAssistantRuntime } from "@assistant-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartTurnInput } from "./types";
import { agent, attachment, thread, uploadLimits } from "./test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("./console-store", () => ({
  useConsoleStore: () => storeMock.current,
  useUploadLimits: () => uploadLimits,
}));
vi.mock("./api", () => ({
  api: {
    createUpload: vi.fn(),
    deleteUpload: vi.fn(),
  },
  uploadContent: vi.fn(),
}));

import { api, uploadContent } from "./api";
import { Composer } from "./components/Composer";
import { WebRuntimeProvider } from "./runtime";

const onlineAgent = agent("agent");
const idleThread = thread("thread", "agent");

type SendTurn = (
  input: StartTurnInput,
  onThreadResolved?: (threadId: string) => void,
) => Promise<void>;

const createStore = (
  sendTurn: SendTurn,
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  bootstrap: null,
  agents: [onlineAgent],
  threads: [idleThread],
  visibleThreads: [idleThread],
  selectedAgent: onlineAgent,
  selectedThread: idleThread,
  detail: null,
  selectedAgentId: onlineAgent.sourceId,
  selectedThreadId: idleThread.id,
  loading: false,
  detailLoading: false,
  error: null,
  actionError: null,
  connection: "live",
  showArchived: false,
  model: "",
  effort: "",
  modelOptions: [],
  effortOptions: [],
  selectAgent: vi.fn(),
  selectThread: vi.fn(),
  createThread: vi.fn(),
  renameThread: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  sendTurn,
  sendLiveInput: vi.fn().mockResolvedValue(undefined),
  cancelTurn: vi.fn(),
  setShowArchived: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  retry: vi.fn(),
  clearActionError: vi.fn(),
  ...overrides,
});

function RuntimeCapture({ onReady }: { readonly onReady: (runtime: AssistantRuntime) => void }) {
  const runtime = useAssistantRuntime();
  useEffect(() => onReady(runtime), [onReady, runtime]);
  return null;
}

const runtimeTree = (onReady: (runtime: AssistantRuntime) => void) => (
  <WebRuntimeProvider>
    <RuntimeCapture onReady={onReady} />
  </WebRuntimeProvider>
);

const renderRuntime = async () => {
  let runtime: AssistantRuntime | undefined;
  const onReady = (value: AssistantRuntime) => { runtime = value; };
  const view = render(runtimeTree(onReady));
  await waitFor(() => expect(runtime).toBeDefined());
  return {
    get runtime() {
      if (!runtime) throw new Error("Runtime is not ready.");
      return runtime;
    },
    rerender: () => view.rerender(runtimeTree(onReady)),
  };
};

const renderComposerRuntime = async () => {
  let runtime: AssistantRuntime | undefined;
  const onReady = (value: AssistantRuntime) => { runtime = value; };
  render(
    <WebRuntimeProvider>
      <RuntimeCapture onReady={onReady} />
      <Composer />
    </WebRuntimeProvider>,
  );
  await waitFor(() => expect(runtime).toBeDefined());
  return {
    get runtime() {
      if (!runtime) throw new Error("Runtime is not ready.");
      return runtime;
    },
  };
};

describe("WebRuntimeProvider assistant-ui submission integration", () => {
  beforeEach(() => {
    storeMock.current = null;
    vi.clearAllMocks();
    vi.mocked(api.createUpload).mockImplementation(async (file) =>
      attachment("upload-1", {
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      }),
    );
    vi.mocked(api.deleteUpload).mockResolvedValue(undefined);
    vi.mocked(uploadContent).mockImplementation(async (upload) => ({
      ...upload,
      uploaded: true,
    }));
  });

  it("restores a rejected turn as a retryable composer draft without an unhandled rejection", async () => {
    let rejectTurn!: (reason: Error) => void;
    const sendTurn = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => { rejectTurn = reject; }),
      )
      .mockResolvedValueOnce(undefined);
    storeMock.current = createStore(sendTurn);
    const { runtime } = await renderRuntime();
    const composer = runtime.thread.composer;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    act(() => {
      composer.setText("keep this draft");
      composer.setQuote({ text: "quoted context", messageId: "source-message" });
      composer.send();
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(composer.getState().text).toBe("");
    act(() => composer.setText("newer work"));

    await act(async () => {
      rejectTurn(new Error("start failed"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(composer.getState().text).toBe("keep this draft\n\nnewer work"),
    );
    expect(composer.getState().quote).toEqual({
      text: "quoted context",
      messageId: "source-message",
    });
    await waitFor(() => expect(composer.getState().canSend).toBe(true));
    act(() => composer.send());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("submits one quote with the authored text and clears it on a thread switch", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    storeMock.current = createStore(sendTurn);
    const view = await renderRuntime();
    const composer = view.runtime.thread.composer;

    act(() => {
      composer.setQuote({ text: "selected response", messageId: "source-message" });
      composer.setText("Follow up");
      composer.send();
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Follow up",
        quote: { text: "selected response", messageId: "source-message" },
      }),
      expect.any(Function),
    ));

    const otherThread = thread("other", "agent");
    act(() => composer.setQuote({ text: "do not carry", messageId: "source-message" }));
    storeMock.current = createStore(sendTurn, {
      threads: [idleThread, otherThread],
      visibleThreads: [idleThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await waitFor(() => expect(view.runtime.thread.composer.getState().quote).toBeUndefined());
  });

  it("admits only one rapid turn start and preserves the second submission as a draft", async () => {
    let resolveTurn!: () => void;
    const sendTurn = vi.fn(
      () => new Promise<void>((resolve) => { resolveTurn = resolve; }),
    );
    storeMock.current = createStore(sendTurn);
    const { runtime } = await renderRuntime();
    const composer = runtime.thread.composer;

    act(() => {
      composer.setText("first");
      composer.send();
      composer.setText("second");
      composer.send();
    });

    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(composer.getState().text).toBe("");

    await act(async () => {
      resolveTurn();
      await Promise.resolve();
    });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(composer.getState().text).toBe("second"));
  });

  it("routes text submitted during a running turn to live input instead of starting another turn", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const sendLiveInput = vi.fn().mockResolvedValue(undefined);
    const runningThread = thread("thread", "agent", {
      runState: { id: "turn-running", status: "running" },
    });
    storeMock.current = createStore(sendTurn, {
      threads: [runningThread],
      visibleThreads: [runningThread],
      selectedThread: runningThread,
      sendLiveInput,
    });
    const { runtime } = await renderRuntime();
    const composer = runtime.thread.composer;

    act(() => {
      composer.setText("Use the smaller scope");
      composer.send();
    });

    await waitFor(() => expect(sendLiveInput).toHaveBeenCalledWith("Use the smaller scope"));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(composer.getState().text).toBe("");
  });

  it("keeps the rendered send button active for a live follow-up", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const sendLiveInput = vi.fn().mockResolvedValue(undefined);
    const runningThread = thread("thread", "agent", {
      runState: { id: "turn-running", status: "running" },
    });
    storeMock.current = createStore(sendTurn, {
      threads: [runningThread],
      visibleThreads: [runningThread],
      selectedThread: runningThread,
      sendLiveInput,
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("textbox", { name: "Message" });
    const send = screen.getByRole("button", { name: "Send live follow-up" });

    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: "Use the actual button" } });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(sendLiveInput).toHaveBeenCalledWith("Use the actual button"));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(runtime.thread.composer.getState().text).toBe("");
  });

  it("submits a live follow-up from Enter while preserving Shift+Enter", async () => {
    const sendTurn = vi.fn<SendTurn>().mockResolvedValue(undefined);
    const sendLiveInput = vi.fn().mockResolvedValue(undefined);
    const runningThread = thread("thread", "agent", {
      runState: { id: "turn-running", status: "running" },
    });
    storeMock.current = createStore(sendTurn, {
      threads: [runningThread],
      visibleThreads: [runningThread],
      selectedThread: runningThread,
      sendLiveInput,
    });
    const { runtime } = await renderComposerRuntime();
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(input, { target: { value: "Use Enter" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    expect(sendLiveInput).not.toHaveBeenCalled();
    expect(runtime.thread.composer.getState().text).toBe("Use Enter");

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sendLiveInput).toHaveBeenCalledWith("Use Enter"));
    expect(sendTurn).not.toHaveBeenCalled();
    expect(runtime.thread.composer.getState().text).toBe("");
  });

  it("restores an attachment-only rejected turn into its exact created thread without re-uploading", async () => {
    let rejectTurn!: (reason: Error) => void;
    const createdThread = thread("created", "agent");
    const sendTurn = vi
      .fn<SendTurn>()
      .mockImplementationOnce(
        (_input, onThreadResolved) => {
          onThreadResolved?.(createdThread.id);
          return new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
        },
      )
      .mockResolvedValueOnce(undefined);
    storeMock.current = createStore(sendTurn, {
      threads: [],
      visibleThreads: [],
      selectedThread: null,
      selectedThreadId: null,
    });
    const view = await renderRuntime();
    const composer = view.runtime.thread.composer;

    await act(async () => {
      await composer.addAttachment(new File(["retry"], "retry.md", { type: "text/markdown" }));
    });
    expect(composer.getState().attachments).toHaveLength(1);
    act(() => composer.send());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({ attachmentIds: ["upload-1"] });

    storeMock.current = createStore(sendTurn, {
      threads: [createdThread],
      visibleThreads: [createdThread],
      selectedThread: createdThread,
      selectedThreadId: createdThread.id,
      connection: "reconnecting",
    });
    view.rerender();
    await act(async () => {
      rejectTurn(new Error("start failed"));
      await Promise.resolve();
    });

    await waitFor(() => expect(view.runtime.thread.composer.getState().canSend).toBe(false));
    expect(view.runtime.thread.composer.getState().attachments).toHaveLength(0);
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();

    storeMock.current = createStore(sendTurn, {
      threads: [createdThread],
      visibleThreads: [createdThread],
      selectedThread: createdThread,
      selectedThreadId: createdThread.id,
      connection: "live",
    });
    view.rerender();

    await waitFor(() =>
      expect(view.runtime.thread.composer.getState().attachments).toMatchObject([
        { id: "upload-1", name: "retry.md" },
      ]),
    );
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();

    act(() => view.runtime.thread.composer.send());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    expect(sendTurn.mock.calls[1]?.[0]).toMatchObject({ attachmentIds: ["upload-1"] });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.deleteUpload).not.toHaveBeenCalled();
  });

  it("does not restore a new-thread submission into another same-agent thread", async () => {
    let rejectTurn!: (reason: Error) => void;
    const createdThread = thread("created", "agent");
    const otherThread = thread("other", "agent");
    const sendTurn = vi.fn<SendTurn>(
      (_input, onThreadResolved) => {
        onThreadResolved?.(createdThread.id);
        return new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
      },
    );
    storeMock.current = createStore(sendTurn, {
      threads: [],
      visibleThreads: [],
      selectedThread: null,
      selectedThreadId: null,
    });
    const view = await renderRuntime();

    act(() => {
      view.runtime.thread.composer.setText("belongs to created");
      view.runtime.thread.composer.send();
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));

    storeMock.current = createStore(sendTurn, {
      threads: [createdThread, otherThread],
      visibleThreads: [createdThread, otherThread],
      selectedThread: otherThread,
      selectedThreadId: otherThread.id,
    });
    view.rerender();
    await act(async () => {
      rejectTurn(new Error("start failed"));
      await Promise.resolve();
    });

    await waitFor(() => expect(view.runtime.thread.composer.getState().canSend).toBe(false));
    expect(view.runtime.thread.composer.getState().text).toBe("");
  });
});
