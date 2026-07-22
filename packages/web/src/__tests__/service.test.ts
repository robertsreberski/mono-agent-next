import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebAgent } from "../contracts.js";
import { WebService, type WebOperatorGateway } from "../service.js";
import { DurableWebStore } from "../store.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

afterEach(cleanup);

describe("web service lifecycle", () => {
  it("registers a durable turn before a blocked first renderer update so cancel cannot miss it", async () => {
    const root = await temporaryDirectory();
    const store = await DurableWebStore.open(join(root, "state"));
    let releaseUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const startedGate = new Promise<void>((resolve) => { updateStarted = resolve; });
    const runTurn = vi.fn<WebOperatorGateway["runTurn"]>();
    const service = new WebService(store, gateway({ runTurn }), { shutdownTimeoutMs: 100 });
    const thread = await service.createThread("personal");

    const running = service.runTurn(thread.id, { text: "blocked update" }, async () => {
      updateStarted();
      await updateGate;
    });
    await startedGate;
    const cancelling = service.cancel(thread.id);
    releaseUpdate();

    await expect(cancelling).resolves.toMatchObject({ thread: { status: "cancelled" } });
    await expect(running).resolves.toMatchObject({ thread: { status: "cancelled" } });
    expect(runTurn).not.toHaveBeenCalled();
    await service.stop();
  });

  it("bounds shutdown, durably interrupts an abort-ignoring gateway, and releases the lease", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const store = await DurableWebStore.open(stateDirectory);
    let gatewayStarted!: () => void;
    const gatewayStartedGate = new Promise<void>((resolve) => { gatewayStarted = resolve; });
    const never = new Promise<void>(() => undefined);
    const service = new WebService(store, gateway({
      async runTurn() {
        gatewayStarted();
        await never;
      },
      async cancel() { await never; },
    }), { shutdownTimeoutMs: 25 });
    const thread = await service.createThread("personal");
    const running = service.runTurn(thread.id, { text: "ignore shutdown" }, async () => undefined);
    await gatewayStartedGate;

    const startedAt = Date.now();
    await service.stop();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(running).resolves.toMatchObject({ thread: { status: "interrupted" } });

    const reopened = await DurableWebStore.open(stateDirectory);
    expect(reopened.getThreadDetail(thread.id)).toMatchObject({ thread: { status: "interrupted" } });
    await reopened.close();
  });
});

function gateway(overrides: Partial<WebOperatorGateway> = {}): WebOperatorGateway {
  return {
    async listAgents() { return [agent()]; },
    async runTurn(input) { await input.onText("done"); },
    async cancel() {},
    ...overrides,
  };
}

function agent(): WebAgent {
  return {
    id: "personal",
    label: "Personal Agent",
    endpoint: "http://127.0.0.1:1",
    online: true,
    capabilities: {},
  };
}
