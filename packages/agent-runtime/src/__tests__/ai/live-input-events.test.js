import { describe, expect, it, vi } from "vitest";

import { instrumentLiveInputAppliedEvents } from "../../ai/runtime/live-input-events.js";

function replayableLiveInput(message, hooks = {}) {
  return {
    [Symbol.asyncIterator]() {
      let delivered = false;
      return {
        async next() {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: message };
        },
        async return() {
          hooks.onReturn?.();
          return { done: true, value: undefined };
        },
        async throw(error) {
          hooks.onThrow?.(error);
          throw error;
        },
      };
    },
  };
}

describe("instrumentLiveInputAppliedEvents", () => {
  it("emits metadata only once after acknowledgement, including across replay iterators", async () => {
    const acknowledge = vi.fn();
    const onApplied = vi.fn();
    const source = replayableLiveInput({
      body: "full private guidance",
      id: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
      acknowledge,
    });
    const instrumented = instrumentLiveInputAppliedEvents(source, onApplied);

    const first = await instrumented[Symbol.asyncIterator]().next();
    first.value.acknowledge();
    first.value.acknowledge();
    const replay = await instrumented[Symbol.asyncIterator]().next();
    replay.value.acknowledge();

    expect(acknowledge).toHaveBeenCalledTimes(3);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith({
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    });
    expect(onApplied.mock.calls[0][0]).not.toHaveProperty("body");
    expect(onApplied.mock.calls[0][0]).not.toHaveProperty("text");
  });

  it("assigns a stable fallback id and delegates iterator teardown", async () => {
    const onReturn = vi.fn();
    const onApplied = vi.fn();
    const instrumented = instrumentLiveInputAppliedEvents(
      replayableLiveInput({ body: "guide", acknowledge: vi.fn() }, { onReturn }),
      onApplied,
    );
    const iterator = instrumented[Symbol.asyncIterator]();
    const next = await iterator.next();

    next.value.acknowledge();
    await iterator.return();

    expect(onApplied).toHaveBeenCalledWith({
      type: "live_input_applied",
      inputId: "anonymous:1",
    });
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("does not emit when guidance is rejected without acknowledgement", async () => {
    const onApplied = vi.fn();
    const reject = vi.fn();
    const instrumented = instrumentLiveInputAppliedEvents(
      replayableLiveInput({ body: "guide", id: "follow-up-2", reject }),
      onApplied,
    );
    const next = await instrumented[Symbol.asyncIterator]().next();

    next.value.reject(new Error("attempt failed"));

    expect(reject).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("does not replace an already-instrumented logical input stream", () => {
    const source = replayableLiveInput({ body: "guide" });
    const first = instrumentLiveInputAppliedEvents(source, vi.fn());

    expect(instrumentLiveInputAppliedEvents(first, vi.fn())).toBe(first);
  });
});
