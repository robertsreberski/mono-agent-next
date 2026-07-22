import { describe, expect, it } from "vitest";

import { isAgentResponseCancelledError } from "@mono-agent/agent-contracts";

import { createLiveSessionManager } from "../live-session.js";
import type { AgentHarnessRequest, AgentHarnessResponse } from "../index.js";

function req(
  conversationId: string,
  userMessage = "hi",
  abortSignal: AbortSignal = new AbortController().signal,
): AgentHarnessRequest {
  return { conversationId, userMessage, abortSignal };
}

function response(text: string, conversationId = "c"): AgentHarnessResponse {
  return {
    text,
    metadata: { runId: "r", conversationId, contextSources: [], contextSectionIds: [] },
  };
}

/** Yield long enough for queued microtasks + a macrotask to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createLiveSessionManager", () => {
  it("runs an enqueued request through the runner and resolves with its response", async () => {
    const manager = createLiveSessionManager({
      run: async (request) => response(`answer:${request.userMessage}`),
    });

    const res = await manager.enqueue("c1", req("c1", "hello"));

    expect(res.text).toBe("answer:hello");
  });

  it("runs same-conversation turns sequentially in FIFO order (queue-after-turn)", async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const manager = createLiveSessionManager({
      run: async (request) => {
        order.push(`start:${request.userMessage}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        order.push(`end:${request.userMessage}`);
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "one"));
    const p2 = manager.enqueue("c1", req("c1", "two"));
    await flush();

    // Only the first turn has started; the second is queued behind it.
    expect(order).toEqual(["start:one"]);

    gates[0]?.();
    await p1;
    await flush();
    expect(order).toEqual(["start:one", "end:one", "start:two"]);

    gates[1]?.();
    await p2;
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("runs different conversations concurrently (no cross-conversation serialization)", async () => {
    const started: string[] = [];
    const never = new Promise<void>(() => {});
    const manager = createLiveSessionManager({
      run: async (request) => {
        started.push(request.conversationId);
        await never;
        return response("x", request.conversationId);
      },
    });

    void manager.enqueue("a", req("a"));
    void manager.enqueue("b", req("b"));
    await flush();

    expect([...started].sort()).toEqual(["a", "b"]);
  });

  it("reports the count of queued-but-not-yet-started turns", async () => {
    const never = new Promise<void>(() => {});
    const manager = createLiveSessionManager({
      run: async () => {
        await never;
        return response("x");
      },
    });

    void manager.enqueue("c1", req("c1"));
    void manager.enqueue("c1", req("c1"));
    void manager.enqueue("c1", req("c1"));
    await flush();

    // One turn is active (draining); the other two are pending.
    expect(manager.pendingCount("c1")).toBe(2);
  });

  it("cancel aborts the active turn and rejects every queued turn", async () => {
    let activeSignal: AbortSignal | undefined;
    const manager = createLiveSessionManager({
      run: async (request) => {
        activeSignal = request.abortSignal;
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          metadata: { runId: "r", conversationId: request.conversationId, contextSources: [], contextSectionIds: [] },
          failure: { kind: "cancelled", message: "aborted" },
        };
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "one"));
    const p2 = manager.enqueue("c1", req("c1", "two"));
    await flush();

    manager.cancel("c1");

    expect(activeSignal?.aborted).toBe(true);
    await expect(p2).rejects.toSatisfy(isAgentResponseCancelledError);
    // An explicitly cancelled active turn now rejects rather than resolving
    // with a cancelled-failure response.
    await expect(p1).rejects.toSatisfy(isAgentResponseCancelledError);
    expect(manager.pendingCount("c1")).toBe(0);
  });

  it("rejects the active turn even when the runner ignores the abort and returns success", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createLiveSessionManager({
      // This runner ignores the abort signal entirely and returns a plain
      // success once the gate is released (after cancel() has fired).
      run: async () => {
        await gate;
        return response("done");
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "one"));
    await flush();

    manager.cancel("c1");
    release?.();

    // Despite the runner returning success, the explicit cancel converts the
    // active turn into a cancellation rejection.
    await expect(p1).rejects.toSatisfy(isAgentResponseCancelledError);
    expect(manager.pendingCount("c1")).toBe(0);
  });

  it("treats cancellation after markCommitted as too late while still dropping queued turns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committed!: () => void;
    const committedSignal = new Promise<void>((resolve) => { committed = resolve; });
    let activeSignal: AbortSignal | undefined;
    const manager = createLiveSessionManager({
      run: async (request, lifecycle) => {
        activeSignal = request.abortSignal;
        lifecycle.markCommitted();
        committed();
        await gate;
        return response("committed");
      },
    });

    const active = manager.enqueue("c1", req("c1", "one"));
    const queued = manager.enqueue("c1", req("c1", "two"));
    await committedSignal;

    manager.cancel("c1");
    expect(activeSignal?.aborted).toBe(false);
    await expect(queued).rejects.toSatisfy(isAgentResponseCancelledError);
    release();
    await expect(active).resolves.toMatchObject({ text: "committed" });
  });

  it("settles the active turn and unwedges the queue when the runner ignores the abort and never resolves", async () => {
    const never = new Promise<void>(() => {});
    let resolvingRan = false;
    const manager = createLiveSessionManager({
      // The first turn's runner ignores the abort signal AND never resolves
      // (permanently hung provider turn); the second turn's runner resolves.
      run: async (request) => {
        if (request.userMessage === "hung") {
          await never;
          return response("never");
        }
        resolvingRan = true;
        return response(`answer:${request.userMessage}`);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "hung"));
    await flush();

    manager.cancel("c1");

    // The active turn is settled despite the hung runner.
    await expect(p1).rejects.toSatisfy(isAgentResponseCancelledError);
    expect(manager.pendingCount("c1")).toBe(0);

    // A new turn for the SAME conversation is no longer wedged: it runs and
    // resolves (fails against pre-fix code because draining stayed true).
    const p2 = manager.enqueue("c1", req("c1", "fresh"));
    await expect(p2).resolves.toMatchObject({ text: "answer:fresh" });
    expect(resolvingRan).toBe(true);
    expect(manager.pendingCount("c1")).toBe(0);
  });

  it("rejects the active turn when its own request abortSignal aborts mid-run and the runner returns success", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestAbort = new AbortController();
    const manager = createLiveSessionManager({
      // Ignores the (linked) abort signal and returns a plain success.
      run: async () => {
        await gate;
        return response("done");
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "one", requestAbort.signal));
    await flush();

    // Abort via the request's own signal (not cancel()); the linkAbort path
    // propagates it to the active controller.
    requestAbort.abort(new Error("client disconnected"));
    release?.();

    await expect(p1).rejects.toSatisfy(isAgentResponseCancelledError);
    expect(manager.pendingCount("c1")).toBe(0);
  });

  it("a failing turn rejects only its own promise; the next queued turn still runs", async () => {
    const calls: string[] = [];
    const manager = createLiveSessionManager({
      run: async (request) => {
        calls.push(request.userMessage);
        if (request.userMessage === "boom") {
          throw new Error("kaboom");
        }
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "boom"));
    const p2 = manager.enqueue("c1", req("c1", "ok"));

    await expect(p1).rejects.toThrow("kaboom");
    await expect(p2).resolves.toMatchObject({ text: "ok" });
    expect(calls).toEqual(["boom", "ok"]);
  });

  it("rejects an already-aborted request up front without running it", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const manager = createLiveSessionManager({
      run: async () => {
        ran = true;
        return response("x");
      },
    });

    await expect(manager.enqueue("c1", req("c1", "hi", controller.signal))).rejects.toSatisfy(
      isAgentResponseCancelledError,
    );
    expect(ran).toBe(false);
  });

  it("rejects an already-aborted request queued behind active work without retaining it", async () => {
    const gates: Array<() => void> = [];
    const manager = createLiveSessionManager({
      run: async (request) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "active"));
    await flush();
    expect(manager.pendingCount("c1")).toBe(0); // active, nothing queued yet

    const aborted = new AbortController();
    aborted.abort();
    await expect(manager.enqueue("c1", req("c1", "stale", aborted.signal))).rejects.toSatisfy(
      isAgentResponseCancelledError,
    );
    // The pre-aborted turn never enters the pending queue.
    expect(manager.pendingCount("c1")).toBe(0);

    gates[0]?.();
    await expect(p1).resolves.toMatchObject({ text: "active" });
  });

  it("dispose rejects all in-flight and queued turns and stops accepting new ones", async () => {
    const never = new Promise<void>(() => {});
    const manager = createLiveSessionManager({
      run: async () => {
        await never;
        return response("x");
      },
    });

    const queued = manager.enqueue("c1", req("c1"));
    await flush();
    await manager.dispose();

    await expect(queued).rejects.toSatisfy(isAgentResponseCancelledError);
    await expect(manager.enqueue("c1", req("c1"))).rejects.toSatisfy(isAgentResponseCancelledError);
  });

  it("waits for an already-committed active turn to finish during disposal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committed!: () => void;
    const committedSignal = new Promise<void>((resolve) => { committed = resolve; });
    const manager = createLiveSessionManager({
      run: async (_request, lifecycle) => {
        lifecycle.markCommitted();
        committed();
        await gate;
        return response("published");
      },
    });

    const active = manager.enqueue("c1", req("c1"));
    await committedSignal;
    let disposed = false;
    const disposing = manager.dispose().then(() => { disposed = true; });
    await flush();

    expect(disposed).toBe(false);
    release();
    await expect(active).resolves.toMatchObject({ text: "published" });
    await disposing;
    expect(disposed).toBe(true);
  });

  it("unlinks and rejects a queued turn when its own signal aborts, leaving the active turn running", async () => {
    const gates: Array<() => void> = [];
    const manager = createLiveSessionManager({
      run: async (request) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "active"));
    const secondAbort = new AbortController();
    const p2 = manager.enqueue("c1", req("c1", "queued", secondAbort.signal));
    await flush();
    expect(manager.pendingCount("c1")).toBe(1); // queued behind the active turn

    secondAbort.abort(new Error("client disconnected"));
    await expect(p2).rejects.toSatisfy(isAgentResponseCancelledError);
    // The aborted turn is removed from the queue immediately, not retained.
    expect(manager.pendingCount("c1")).toBe(0);

    gates[0]?.();
    await expect(p1).resolves.toMatchObject({ text: "active" });
  });

  it("rejects enqueues beyond the per-conversation pending cap", async () => {
    const gates: Array<() => void> = [];
    const manager = createLiveSessionManager({
      maxPendingPerConversation: 2,
      run: async (request) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return response(request.userMessage);
      },
    });

    const p1 = manager.enqueue("c1", req("c1", "active")); // becomes active
    await flush();
    const p2 = manager.enqueue("c1", req("c1", "q1")); // pending 1
    const p3 = manager.enqueue("c1", req("c1", "q2")); // pending 2 (cap)
    expect(manager.pendingCount("c1")).toBe(2);

    // The next enqueue exceeds the cap and is rejected.
    await expect(manager.enqueue("c1", req("c1", "q3"))).rejects.toSatisfy(isAgentResponseCancelledError);
    expect(manager.pendingCount("c1")).toBe(2);

    // Drain everything so the accepted turns settle (each started turn pushes a
    // new gate, so release them in order).
    gates[0]?.();
    await p1;
    await flush();
    gates[1]?.();
    await p2;
    await flush();
    gates[2]?.();
    await p3;
  });
});
