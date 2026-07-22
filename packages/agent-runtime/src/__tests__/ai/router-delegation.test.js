import { describe, expect, it, vi } from "vitest";

const configureToolsMock = vi.fn();
const syncSessionMock = vi.fn().mockResolvedValue(true);
const refreshSessionMock = vi.fn().mockResolvedValue(undefined);
const retireDurableSessionMock = vi.fn().mockResolvedValue(undefined);
const disposeSessionMock = vi.fn().mockResolvedValue(true);
const invalidateSessionMock = vi.fn().mockResolvedValue(true);
const disposeAllSessionsMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../runtime.js", () => ({
  createRuntime: () => ({
    run: vi.fn(),
    configureTools: configureToolsMock,
    syncSession: syncSessionMock,
    refreshSession: refreshSessionMock,
    retireDurableSession: retireDurableSessionMock,
    disposeSession: disposeSessionMock,
    invalidateSession: invalidateSessionMock,
    disposeAllSessions: disposeAllSessionsMock,
  }),
}));

const { createRouterRuntime } = await import("../../ai/runtime/router.js");

describe("createRouterRuntime — inner runtime delegation", () => {
  it("delegates configureTools, syncSession, refreshSession, retireDurableSession, disposeSession, invalidateSession, and disposeAllSessions", async () => {
    const router = createRouterRuntime({
      chain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
    });

    router.configureTools({ workspace: "/tmp/w" });
    expect(configureToolsMock).toHaveBeenCalledWith({ workspace: "/tmp/w" });

    await expect(router.syncSession("session-1")).resolves.toBe(true);
    expect(syncSessionMock).toHaveBeenCalledWith("session-1");

    await expect(router.refreshSession("session-1")).resolves.toBeUndefined();
    expect(refreshSessionMock).toHaveBeenCalledWith("session-1");

    await expect(router.retireDurableSession("session-1", "/tmp/pi")).resolves.toBeUndefined();
    expect(retireDurableSessionMock).toHaveBeenCalledWith("session-1", "/tmp/pi");

    await expect(router.disposeSession("session-1")).resolves.toBe(true);
    expect(disposeSessionMock).toHaveBeenCalledWith("session-1");

    await expect(router.invalidateSession("session-1")).resolves.toBe(true);
    expect(invalidateSessionMock).toHaveBeenCalledWith("session-1");

    await router.disposeAllSessions();
    expect(disposeAllSessionsMock).toHaveBeenCalledTimes(1);
  });
});
