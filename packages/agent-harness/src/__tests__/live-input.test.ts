import { describe, expect, it } from "vitest";

import { AGENT_LIVE_INPUT_MAX_CHARACTERS } from "@mono-agent/agent-contracts";

import { createLiveInputMailbox } from "../live-input.js";

const request = (id: string, text = id) => ({
  conversationId: "conversation",
  id,
  text,
  receivedAt: "2026-07-21T10:00:00.000Z",
});

describe("live input mailbox", () => {
  it("delivers FIFO input, settles on provider acknowledgement, and records applied text", async () => {
    const mailbox = createLiveInputMailbox("run-1");
    const first = mailbox.offer(request("one", "First"));
    const second = mailbox.offer(request("two", "Second"));
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    if (first.status !== "accepted" || second.status !== "accepted") return;

    const iterator = mailbox[Symbol.asyncIterator]();
    const firstMessage = await iterator.next();
    const secondMessage = await iterator.next();
    expect([firstMessage.value?.body, secondMessage.value?.body]).toEqual(["First", "Second"]);
    firstMessage.value?.acknowledge?.();
    secondMessage.value?.acknowledge?.();

    await expect(first.settled).resolves.toEqual({ status: "applied", runId: "run-1" });
    await expect(second.settled).resolves.toEqual({ status: "applied", runId: "run-1" });
    expect(mailbox.applied()).toEqual([
      { id: "one", text: "First", receivedAt: "2026-07-21T10:00:00.000Z" },
      { id: "two", text: "Second", receivedAt: "2026-07-21T10:00:00.000Z" },
    ]);
  });

  it("replays every message to a replacement provider iterator without duplicating settlement", async () => {
    const mailbox = createLiveInputMailbox("run-2");
    const offered = mailbox.offer(request("same", "Steer this"));
    expect(offered.status).toBe("accepted");
    if (offered.status !== "accepted") return;

    const attemptOne = mailbox[Symbol.asyncIterator]();
    expect((await attemptOne.next()).value?.body).toBe("Steer this");
    await attemptOne.return?.();

    const attemptTwo = mailbox[Symbol.asyncIterator]();
    const replay = await attemptTwo.next();
    replay.value?.acknowledge?.();
    replay.value?.acknowledge?.();
    await expect(offered.settled).resolves.toEqual({ status: "applied", runId: "run-2" });

    const duplicate = mailbox.offer(request("same", "Ignored duplicate body"));
    expect(duplicate.status).toBe("accepted");
    if (duplicate.status === "accepted") {
      await expect(duplicate.settled).resolves.toEqual({ status: "applied", runId: "run-2" });
    }
    expect(mailbox.applied()).toHaveLength(1);
  });

  it("requeues unacknowledged messages on close and discards them on explicit cancellation", async () => {
    const closedMailbox = createLiveInputMailbox("run-3");
    const closed = closedMailbox.offer(request("closed"));
    closedMailbox.close();
    expect(closed.status).toBe("accepted");
    if (closed.status === "accepted") {
      await expect(closed.settled).resolves.toEqual({ status: "requeue", reason: "closed" });
    }

    const cancelledMailbox = createLiveInputMailbox("run-4");
    const cancelled = cancelledMailbox.offer(request("cancelled"));
    cancelledMailbox.cancel();
    expect(cancelled.status).toBe("accepted");
    if (cancelled.status === "accepted") {
      await expect(cancelled.settled).resolves.toEqual({ status: "discarded", reason: "cancelled" });
    }
  });

  it("rejects malformed and oversized offers before admission", () => {
    const mailbox = createLiveInputMailbox("run-5");
    expect(mailbox.offer(request("blank", "   "))).toEqual({ status: "unavailable", reason: "invalid" });
    expect(mailbox.offer(request("large", "x".repeat(AGENT_LIVE_INPUT_MAX_CHARACTERS + 1))))
      .toEqual({ status: "unavailable", reason: "too_large" });
    mailbox.markUnsupported();
    expect(mailbox.offer(request("late"))).toEqual({ status: "unavailable", reason: "unsupported" });
  });
});
