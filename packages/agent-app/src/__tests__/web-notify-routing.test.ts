import { beforeEach, describe, expect, it, vi } from "vitest";

const web = vi.hoisted(() => ({ deliver: vi.fn() }));

vi.mock("@mono-agent/web", () => ({
  deliverWebNotification: web.deliver,
}));

import { notifyDestination } from "../app-controller-maintenance.js";

function controller() {
  return {
    running: new Map(),
    logger: { info: vi.fn(), warn: vi.fn() },
    observabilityContext: vi.fn(async () => ({ sourceId: "agent-one" })),
  } as never;
}

describe("web notification destination routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    web.deliver.mockResolvedValue({ threadId: "notification-one", duplicate: false });
  });

  it("routes exact web:new cron/webhook requests with source identity", async () => {
    const result = await notifyDestination(
      controller(),
      "web:new",
      "Morning brief",
      { verbatim: true, deliveryKey: "cron:daily:one:success" },
      "cron",
    );

    expect(result).toEqual({ delivered: true, code: "delivered" });
    expect(web.deliver).toHaveBeenCalledWith({
      sourceId: "agent-one",
      triggerKind: "cron",
      deliveryKey: "cron:daily:one:success",
      text: "Morning brief",
    });
  });

  it("rejects other web destinations and non-trigger callers before channel inference", async () => {
    await expect(notifyDestination(
      controller(),
      "web:existing",
      "text",
      { verbatim: true, deliveryKey: "one" },
      "cron",
    )).resolves.toMatchObject({ delivered: false, code: "unsupported_web_destination" });
    await expect(notifyDestination(
      controller(),
      "web:new",
      "text",
      { verbatim: true, deliveryKey: "one" },
      "telegram",
    )).resolves.toMatchObject({ delivered: false, code: "unsupported_web_notification_source" });
    expect(web.deliver).not.toHaveBeenCalled();
  });

  it("keeps an unavailable web console best-effort with no thrown retry path", async () => {
    web.deliver.mockRejectedValue(Object.assign(new Error("no ingress"), {
      code: "notification_ingress_unavailable",
    }));

    await expect(notifyDestination(
      controller(),
      "web:new",
      "Digest",
      { verbatim: true, deliveryKey: "webhook:digest:req-1:success" },
      "webhook",
    )).resolves.toEqual({
      delivered: false,
      code: "notification_ingress_unavailable",
      reason: "no ingress",
      retryable: false,
    });
  });
});
