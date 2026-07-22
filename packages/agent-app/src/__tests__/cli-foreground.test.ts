import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForShutdownSignal } from "../cli.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("waitForShutdownSignal", () => {
  afterEach(() => {
    // Defensive: ensure no stray listeners leak between tests.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    vi.restoreAllMocks();
  });

  it("stays pending until a signal arrives (foreground does not exit immediately)", async () => {
    const app = { stop: vi.fn(async () => {}) };
    const pending = waitForShutdownSignal(app);

    const outcome = await Promise.race([
      pending.then(() => "resolved" as const),
      delay(25).then(() => "still-pending" as const),
    ]);

    expect(outcome).toBe("still-pending");
    expect(app.stop).not.toHaveBeenCalled();

    // Clean up: trigger shutdown so the referenced keep-alive timer is cleared.
    process.emit("SIGINT");
    await pending;
  });

  it("stops the app and resolves 0 on SIGTERM", async () => {
    const app = { stop: vi.fn(async () => {}) };
    const pending = waitForShutdownSignal(app);

    process.emit("SIGTERM");
    const code = await pending;

    expect(code).toBe(0);
    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("removes its signal listeners after shutdown so it owns no lingering handle", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const app = { stop: vi.fn(async () => {}) };
    const pending = waitForShutdownSignal(app);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm + 1);

    process.emit("SIGINT");
    await pending;

    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("stops only once even if both signals fire", async () => {
    const app = { stop: vi.fn(async () => {}) };
    const pending = waitForShutdownSignal(app);

    process.emit("SIGINT");
    process.emit("SIGTERM");
    await pending;

    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("resolves a failed shutdown so outer cleanup can release the worker lease", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = { stop: vi.fn(async () => { throw new Error("stop failed"); }) };
    const pending = waitForShutdownSignal(app);

    process.emit("SIGTERM");

    await expect(pending).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Foreground shutdown failed: stop failed"));
  });
});
