// SPDX-License-Identifier: MIT

// Memory modules are third-party objects, so recall and capture are ordinary
// methods that may use `this`. Extracting either as a bare function reference
// drops the receiver, and because both paths swallow their failure into health
// the module simply stops recording while the agent reports "degraded" with no
// module attribution. These pin the receiver.

import { describe, expect, it } from "vitest";
import type { Memory, MemoryRecallResult, MemoryRecord, Runtime } from "@mono-agent/module-sdk";

import { HostMemory } from "../host-memory.js";
import type { AgentSubmitInput } from "../types.js";

class ReceiverBoundMemory {
  readonly captured: MemoryRecord[] = [];
  readonly #records: readonly MemoryRecord[];
  constructor(records: readonly MemoryRecord[]) {
    this.#records = records;
  }
  async recall(): Promise<MemoryRecallResult> {
    // Reading private state throws outright when the receiver is lost.
    return { records: this.#records };
  }
  async capture(request: { readonly record: MemoryRecord }): Promise<void> {
    this.captured.push(request.record);
  }
}

function hostMemory(memory: Memory | undefined, failures: string[]): HostMemory {
  return new HostMemory({
    hostSignal: new AbortController().signal,
    memory: () => memory,
    runtimes: () => new Map<string, Runtime>(),
    runtimeCapabilities: () => new Map<string, Readonly<Runtime["capabilities"]>>(),
    recordFailure: (message) => failures.push(message),
  });
}

const record: MemoryRecord = {
  id: "record-1",
  text: "the operator prefers short answers",
  createdAt: "2026-07-25T00:00:00.000Z",
};
const submit = { conversationId: "c", text: "what do I prefer?" } as AgentSubmitInput;

describe("host memory facet", () => {
  it("calls recall through its module so the receiver survives", async () => {
    const failures: string[] = [];
    const module = new ReceiverBoundMemory([record]);
    const facet = hostMemory(module as unknown as Memory, failures);

    const recalled = await facet.recall(submit, new AbortController().signal);

    expect(recalled).toEqual([record]);
    expect(failures).toEqual([]);
  });

  it("calls capture through its module so the receiver survives", async () => {
    const failures: string[] = [];
    const module = new ReceiverBoundMemory([]);
    const facet = hostMemory(module as unknown as Memory, failures);

    await facet.capture(record, new AbortController().signal);

    expect(module.captured).toEqual([record]);
    expect(failures).toEqual([]);
  });

  it("is inert without a selected memory module", async () => {
    const failures: string[] = [];
    const facet = hostMemory(undefined, failures);

    expect(await facet.recall(submit, new AbortController().signal)).toEqual([]);
    await expect(facet.capture(record, new AbortController().signal)).resolves.toBeUndefined();
    expect(failures).toEqual([]);
  });

  it("degrades rather than failing the turn when the module throws", async () => {
    const failures: string[] = [];
    const facet = hostMemory({
      async recall() { throw new Error("recall exploded"); },
      async capture() { throw new Error("capture exploded"); },
    } as unknown as Memory, failures);

    expect(await facet.recall(submit, new AbortController().signal)).toEqual([]);
    await expect(facet.capture(record, new AbortController().signal)).resolves.toBeUndefined();
    expect(failures).toEqual([
      "memory recall: recall exploded",
      "memory capture: capture exploded",
    ]);
  });
});
