import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverWebNotification } from "../notification-client.js";
import { prepareWebStatePaths } from "../state-paths.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function writeIngressRecord(stateDir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const paths = await prepareWebStatePaths({ stateDir });
  await writeFile(paths.notificationIngress, JSON.stringify({
    schema: 1,
    pid: process.pid,
    instanceId: "fixture-instance",
    url: "http://127.0.0.1:45124/internal/v1/notifications",
    token: "a".repeat(43),
    updatedAt: "2026-07-21T09:00:00.000Z",
    ...overrides,
  }), { mode: 0o600 });
  return paths.notificationIngress;
}

describe("deliverWebNotification", () => {
  it("reads the private loopback record and makes exactly one bounded authenticated attempt", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    await writeIngressRecord(stateDir);
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({ threadId: "notification-one", duplicate: false }, { status: 201 });
    }) as typeof fetch;
    const input = {
      sourceId: "agent-one",
      triggerKind: "webhook" as const,
      deliveryKey: "webhook:digest:req-1:success",
      text: "Digest ready",
    };

    await expect(deliverWebNotification(input, { stateDir, fetchImpl }))
      .resolves.toEqual({ threadId: "notification-one", duplicate: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "http://127.0.0.1:45124/internal/v1/notifications",
      init: {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed for missing, permissive, symlinked, or non-loopback ingress records", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const input = {
      sourceId: "agent-one",
      triggerKind: "cron" as const,
      deliveryKey: "cron:daily:one:success",
      text: "Morning brief",
    };
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(deliverWebNotification(input, { stateDir, fetchImpl }))
      .rejects.toMatchObject({ code: "notification_ingress_unavailable" });

    const ingressPath = await writeIngressRecord(stateDir);
    await chmod(ingressPath, 0o644);
    await expect(deliverWebNotification(input, { stateDir, fetchImpl }))
      .rejects.toMatchObject({ code: "notification_ingress_unavailable" });

    await rm(ingressPath);
    const target = join(base, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, ingressPath);
    await expect(deliverWebNotification(input, { stateDir, fetchImpl }))
      .rejects.toMatchObject({ code: "notification_ingress_unavailable" });

    await rm(ingressPath);
    await writeIngressRecord(stateDir, { url: "http://192.0.2.10/internal/v1/notifications" });
    await expect(deliverWebNotification(input, { stateDir, fetchImpl }))
      .rejects.toMatchObject({ code: "notification_ingress_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
