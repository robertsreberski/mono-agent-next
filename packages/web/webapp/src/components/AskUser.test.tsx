// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleProvider, useConsole } from "../console";
import { WebRuntimeProvider } from "../runtime";
import { Composer } from "./Composer";

const apiMocks = vi.hoisted(() => {
  const state = { interactionId: "interaction-one" };
  const thread = (id = "thread-1") => ({
    id,
    agentId: "agent-1",
    operatorConversationId: `operator-${id}`,
    title: id === "thread-1" ? "Needs input" : "Other conversation",
    titleManual: false,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:01:00.000Z",
    status: "idle" as const,
    ...(id === "thread-1" ? { pendingAsk: {
      interactionId: state.interactionId,
      requestedAt: "2026-07-24T08:01:00.000Z",
      questions: [
        {
          id: "approval",
          prompt: "Continue with this change?",
          choices: [{ value: "continue", label: "Continue" }],
          allowFreeText: false,
          multiple: false,
        },
      ],
    } } : {}),
  });
  return {
    state,
    bootstrap: vi.fn(async () => ({
      version: 1 as const,
      revision: 1,
      agents: [
        {
          id: "agent-1",
          label: "Personal Agent",
          endpoint: "http://127.0.0.1:4110",
          online: true,
          pinned: true,
          capabilities: {},
        },
      ],
      threads: [thread(), thread("thread-2")],
      newProactiveThreadIds: [],
    })),
    thread: vi.fn(async (threadId: string) => ({ thread: thread(threadId), messages: [] })),
    answerAsk: vi.fn(async () => ({ status: "accepted" })),
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
  };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    readToken: () => "authenticated-test-token",
    saveToken: vi.fn(),
    subscribeEvents: apiMocks.subscribeEvents,
    api: {
      ...actual.api,
      probeBootstrap: async () => {
        throw new actual.ApiError("Unauthorized.", 401, "unauthorized");
      },
      bootstrap: apiMocks.bootstrap,
      thread: apiMocks.thread,
      answerAsk: apiMocks.answerAsk,
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  apiMocks.state.interactionId = "interaction-one";
  vi.clearAllMocks();
});

describe("AskUser interaction identity", () => {
  it("drops a prior selection when a new interaction reuses question and choice ids", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ConsoleProvider>
          <WebRuntimeProvider>
            <Composer />
            <RefreshProbe />
          </WebRuntimeProvider>
        </ConsoleProvider>,
      );
    });
    const firstForm = await waitFor(() => host.querySelector<HTMLFormElement>(".ask-card"));
    const firstChoice = requiredElement<HTMLInputElement>(firstForm, 'input[name="approval"]');
    const firstSubmit = requiredElement<HTMLButtonElement>(firstForm, 'button[type="submit"]');

    expect(firstChoice.checked).toBe(false);
    expect(firstSubmit.disabled).toBe(true);

    await act(async () => firstChoice.click());

    expect(firstChoice.checked).toBe(true);
    expect(firstSubmit.disabled).toBe(false);

    apiMocks.state.interactionId = "interaction-two";
    await act(async () => {
      requiredElement<HTMLButtonElement>(host, 'button[aria-label="Refresh test state"]').click();
    });
    const secondForm = await waitFor(() => {
      const candidate = host.querySelector<HTMLFormElement>(".ask-card");
      return candidate !== firstForm ? candidate : null;
    });
    const reusedChoice = requiredElement<HTMLInputElement>(secondForm, 'input[name="approval"]');
    const secondSubmit = requiredElement<HTMLButtonElement>(secondForm, 'button[type="submit"]');

    expect(reusedChoice.checked).toBe(false);
    expect(secondSubmit.disabled).toBe(true);

    await act(async () => root.unmount());
  });

  it("keeps selected answers retryable when submission fails", async () => {
    apiMocks.answerAsk.mockRejectedValueOnce(new Error("AskUser delivery failed."));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ConsoleProvider>
          <WebRuntimeProvider>
            <Composer />
            <RefreshProbe />
          </WebRuntimeProvider>
        </ConsoleProvider>,
      );
    });
    const form = await waitFor(() => host.querySelector<HTMLFormElement>(".ask-card"));
    const choice = requiredElement<HTMLInputElement>(form, 'input[name="approval"]');
    const submit = requiredElement<HTMLButtonElement>(form, 'button[type="submit"]');
    await act(async () => choice.click());
    await act(async () => submit.click());
    await waitFor(() =>
      host.querySelector('[role="alert"]')?.textContent === "AskUser delivery failed."
    );

    expect(choice.checked).toBe(true);
    expect(submit.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("guards selected and in-flight answers and hides a late failure after switching", async () => {
    const answer = deferred<{ status: string }>();
    apiMocks.answerAsk.mockImplementationOnce(async () => await answer.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ConsoleProvider>
          <WebRuntimeProvider>
            <Composer />
            <RefreshProbe />
          </WebRuntimeProvider>
        </ConsoleProvider>,
      );
    });
    const form = await waitFor(() => host.querySelector<HTMLFormElement>(".ask-card"));
    const choice = requiredElement<HTMLInputElement>(form, 'input[name="approval"]');
    const submit = requiredElement<HTMLButtonElement>(form, 'button[type="submit"]');
    await act(async () => choice.click());
    await act(async () => submit.click());
    await waitFor(() => submit.textContent === "Submitting…");

    await act(async () => {
      requiredElement<HTMLButtonElement>(host, 'button[aria-label="Select other thread"]').click();
    });
    await waitFor(() => confirm.mock.calls.length === 1);
    expect(requiredElement<HTMLOutputElement>(host, '[data-testid="selected-thread"]').textContent)
      .toBe("thread-1");
    expect(choice.checked).toBe(true);

    confirm.mockReturnValue(true);
    await act(async () => {
      requiredElement<HTMLButtonElement>(host, 'button[aria-label="Select other thread"]').click();
    });
    await waitFor(() =>
      requiredElement<HTMLOutputElement>(host, '[data-testid="selected-thread"]').textContent
        === "thread-2"
    );
    await act(async () => answer.reject(new Error("Late AskUser delivery failed.")));
    await waitFor(() => apiMocks.answerAsk.mock.results[0]?.type === "return");
    expect(requiredElement<HTMLOutputElement>(host, '[data-testid="console-error"]').textContent)
      .toBe("");

    await act(async () => root.unmount());
  });
});

function RefreshProbe() {
  const consoleState = useConsole();
  return (
    <>
      <button type="button" aria-label="Refresh test state" onClick={() => void consoleState.retry()}>
        Refresh
      </button>
      <button
        type="button"
        aria-label="Select other thread"
        onClick={() => void consoleState.selectThread("thread-2")}
      >
        Other
      </button>
      <output data-testid="selected-thread">{consoleState.selectedThreadId ?? ""}</output>
      <output data-testid="console-error" role="alert">{consoleState.error ?? ""}</output>
    </>
  );
}

async function waitFor<Value>(
  read: () => Value | null | undefined | false,
  attempts = 20,
): Promise<Value> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for AskUser state");
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
  readonly reject: (cause: unknown) => void;
} {
  let rejectPromise!: (cause: unknown) => void;
  const promise = new Promise<Value>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise };
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
