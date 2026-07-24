// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bootstrap } from "./types";

const apiMocks = vi.hoisted(() => {
  const agent = {
    id: "agent-1",
    label: "Fixture Agent",
    endpoint: "http://127.0.0.1:4110",
    online: true,
    pinned: true,
    capabilities: { runtimeOverrides: true },
    defaults: { runtime: "pi", model: "pi:default", effort: "medium" },
    models: [
      { runtime: "pi", id: "pi:default", efforts: ["low", "medium"] },
      { runtime: "pi-secondary", id: "pi:secondary", efforts: ["high"] },
    ],
  } as const;
  const bootstrap = (revision: number): Bootstrap => ({
    version: 1,
    revision,
    agents: [agent],
    threads: [{
      id: "thread-1",
      agentId: "agent-1",
      title: "Fixture conversation",
      titleManual: false,
      createdAt: "2026-07-24T08:00:00.000Z",
      updatedAt: "2026-07-24T08:01:00.000Z",
      status: "idle",
    }],
    newProactiveThreadIds: [],
  });
  return {
    bootstrap: vi.fn(async () => bootstrap(1)),
    thread: vi.fn(async (threadId: string) => ({
      thread: bootstrap(1).threads.find((candidate) => candidate.id === threadId)!,
      messages: [],
    })),
    subscribeEvents: vi.fn(async () => new Promise<void>(() => undefined)),
  };
});

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    readToken: () => "console-override-token-0123456789",
    saveToken: () => undefined,
    api: { ...original.api, bootstrap: apiMocks.bootstrap, thread: apiMocks.thread },
    subscribeEvents: apiMocks.subscribeEvents,
  };
});

const { ConsoleProvider, useConsole } = await import("./console");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, String(value)); },
  } as Storage;
}

Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

let captured: ReturnType<typeof useConsole> | undefined;

function Probe() {
  captured = useConsole();
  return null;
}

beforeEach(() => {
  apiMocks.bootstrap.mockClear();
  captured = undefined;
});

afterEach(() => {
  document.body.textContent = "";
  window.localStorage.clear();
});

describe("console run overrides", () => {
  it("preserves an authored runtime, model, effort, and staged files across a refresh", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ConsoleProvider><Probe /></ConsoleProvider>);
    });
    // The first load seats the agent defaults.
    expect(captured).toMatchObject({ runtime: "pi", model: "pi:default", effort: "medium" });

    // Author a full route away from the defaults, and stage a file with it.
    await act(async () => {
      captured!.setRuntime("pi-secondary");
      captured!.setModel("pi:secondary");
      captured!.setEffort("high");
      captured!.addFiles([new File(["staged"], "note.txt", { type: "text/plain" })]);
    });
    expect(captured).toMatchObject({
      runtime: "pi-secondary",
      model: "pi:secondary",
      effort: "high",
    });
    expect(captured!.pendingFiles).toHaveLength(1);

    // A background refresh runs on every debounced SSE delta, including deltas
    // from a turn in another thread. It must not quietly reseat the route the
    // operator typed, or the next send goes to the default with no error shown.
    const before = apiMocks.bootstrap.mock.calls.length;
    await act(async () => {
      await captured!.retry();
    });
    expect(apiMocks.bootstrap.mock.calls.length).toBeGreaterThan(before);

    expect(captured).toMatchObject({
      runtime: "pi-secondary",
      model: "pi:secondary",
      effort: "high",
    });
    expect(captured!.pendingFiles).toHaveLength(1);
    expect(captured!.pendingFiles[0]?.name).toBe("note.txt");
  });
});
