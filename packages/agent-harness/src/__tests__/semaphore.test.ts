import { describe, expect, it } from "vitest";

import { createSemaphore, SemaphoreAcquireAbortedError } from "../semaphore.js";

describe("createSemaphore", () => {
  it("admits up to the limit immediately and queues the rest", async () => {
    const sema = createSemaphore(1);
    await sema.acquire();
    expect(sema.inUse()).toBe(1);

    let secondAdmitted = false;
    const second = sema.acquire().then(() => {
      secondAdmitted = true;
    });
    await Promise.resolve();
    expect(secondAdmitted).toBe(false); // still waiting behind the first

    sema.release();
    await second;
    expect(secondAdmitted).toBe(true);
    expect(sema.inUse()).toBe(1); // permit transferred, not freed
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const sema = createSemaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(sema.acquire(controller.signal)).rejects.toBeInstanceOf(SemaphoreAcquireAbortedError);
    expect(sema.inUse()).toBe(0);
  });

  it("rejects a queued acquire when its signal aborts, without consuming a permit", async () => {
    const sema = createSemaphore(1);
    await sema.acquire(); // hold the only permit

    const controller = new AbortController();
    const queued = sema.acquire(controller.signal);
    await Promise.resolve();

    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(SemaphoreAcquireAbortedError);

    // The aborted waiter never held a permit, so releasing frees the slot and a
    // fresh acquire is admitted immediately (no leaked permit / no dead waiter).
    sema.release();
    let admitted = false;
    await sema.acquire().then(() => {
      admitted = true;
    });
    expect(admitted).toBe(true);
  });
});
