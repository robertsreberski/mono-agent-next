// SPDX-License-Identifier: MIT
import type { ApprovalRequest, AskUserRequest } from "@mono-agent/module-sdk";
import { describe, expect, it } from "vitest";

import { ActiveTurn } from "../host-turn.js";

const requestedAt = "2026-07-25T00:00:00.000Z";

describe("active turn interactions", () => {
  it("aborts AskUser without waiting for a hung emitter", async () => {
    const controller = new AbortController();
    const active = new ActiveTurn("turn", "request", requestedAt, controller);
    let entered!: () => void;
    const emitterEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = active.waitForAsk(askRequest(), controller.signal, async () => {
      entered();
      return new Promise<void>(() => undefined);
    });
    await emitterEntered;

    controller.abort(new Error("cancelled AskUser"));

    await expect(settleWithin(pending)).rejects.toThrow("cancelled AskUser");
    expect(active.answerAsk({
      interactionId: "ask-1",
      answers: { target: ["staging"] },
    })).toBe("expired");
  });

  it("rejects approval cleanup without waiting for a hung emitter or leaking its rejection", async () => {
    const active = new ActiveTurn(
      "turn", "request", requestedAt, new AbortController(),
    );
    let entered!: () => void;
    const emitterEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = active.waitForApproval(
      approvalRequest(),
      new AbortController().signal,
      async () => {
        entered();
        return new Promise<void>(() => undefined);
      },
    );
    await emitterEntered;

    active.rejectPendingInteractions();

    await expect(settleWithin(pending)).rejects.toThrow(
      "Runtime attempt settled before approval completed",
    );
    expect(active.answerApproval({
      interactionId: "approval-1",
      decision: "deny",
      decidedAt: "2026-07-25T00:00:01.000Z",
    })).toBe("expired");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

function askRequest(): AskUserRequest {
  return {
    interactionId: "ask-1",
    requestedAt,
    questions: [{
      id: "target",
      prompt: "Which target?",
      choices: [{ value: "staging", label: "Staging" }],
      allowFreeText: false,
      multiple: false,
    }],
  };
}

function approvalRequest(): ApprovalRequest {
  return {
    interactionId: "approval-1",
    callId: "call-1",
    toolId: "core__shell",
    displayName: "Run shell",
    effects: ["execute"],
    summary: "Run one command.",
    requestedAt,
  };
}

async function settleWithin<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setImmediate(() => reject(new Error("interaction did not settle promptly")));
    }),
  ]);
}
