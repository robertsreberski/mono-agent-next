import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContinuationSynthesisUnavailableError,
  startContinuationService,
  type ContinuationServiceHandle,
} from "../continuation-service.js";
import { canonicalContinuationJson, continuationDigest } from "../continuations.js";

const services: ContinuationServiceHandle[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.stop()));
});

describe("durable continuation service", () => {
  it("uses the cross-repo canonical JSON hash contract", () => {
    const canonical = canonicalContinuationJson({
      z: "last",
      b: 2,
      a: [3, { y: null, x: true }],
    });
    expect(canonical).toBe('{"a":[3,{"x":true,"y":null}],"b":2,"z":"last"}');
    expect(continuationDigest(canonical)).toBe("42be6e8517e86952c2fc0dcf6b3036aafec40f166ba10c75c300580e2ae79446");

    const codePointOrder = canonicalContinuationJson({
      "é": 6,
      a: 4,
      "!": 1,
      _: 3,
      Z: 2,
      "Å": 5,
      nested: { z: 1, A: 2 },
    });
    expect(codePointOrder).toBe('{"!":1,"Z":2,"_":3,"a":4,"nested":{"A":2,"z":1},"Å":5,"é":6}');
    expect(continuationDigest(codePointOrder)).toBe("cc9db41e3fa5758aa0b85b5197c9f01374ae5b739d012742fd81ee2b9f6976e7");
  });

  it("issues exact reserved context, binds the reply destination, synthesizes once, and returns a delivery receipt", async () => {
    const stateDir = fixtureDir("bound");
    const synthesize = vi.fn(async () => ({ text: "Final verified briefing" }));
    const deliver = vi.fn(async () => ({
      kind: "delivered" as const,
      code: "delivered" as const,
      deliveryId: "slack:D1:200.1",
      channelId: "slack",
    }));
    const service = await start({ stateDir, synthesize, deliver });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-1",
      serverName: "a8c-control",
      conversationId: "slack:D1:171.5#2026-07-14",
      replyTo: { conversationId: "slack:D1:171.5" },
      historyBoundary: "run-1",
    });
    expect(capability.headers()).toEqual({
      "x-mono-agent-continuation-claim-url": capability.url,
      "x-mono-agent-continuation-claim-token": capability.token,
      "x-mono-agent-continuation-claim-fingerprint": capability.fingerprint,
      "x-mono-agent-continuation-claim-mode": "reply",
    });
    expect(capability.env()).toEqual({
      MONO_AGENT_CONTINUATION_CLAIM_URL: capability.url,
      MONO_AGENT_CONTINUATION_CLAIM_TOKEN: capability.token,
      MONO_AGENT_CONTINUATION_CLAIM_FINGERPRINT: capability.fingerprint,
      MONO_AGENT_CONTINUATION_CLAIM_MODE: "reply",
    });

    const claim = await claimContinuation(capability, "task-1", hash("task-1"));
    await capability.release();
    expect(await capability.requiresOriginContext()).toBe(true);
    await capability.finalizeOriginContext(originContext("run-1", "slack:D1:171.5#2026-07-14"));
    await capability.activateOriginContext();
    await putResult(claim, { status: "complete", findings: ["JETPACK-1906"] });
    await service.processDue();

    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      continuationId: claim.continuationId,
      originConversationId: "slack:D1:171.5#2026-07-14",
      replyToConversationId: "slack:D1:171.5",
      historyBoundary: "run-1",
    }));
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith({
      continuationId: claim.continuationId,
      conversationId: "slack:D1:171.5",
      text: "Final verified briefing",
      deliveryKey: `continuation:${claim.continuationId}`,
    });
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      receipt: { kind: "delivered", deliveryId: "slack:D1:200.1", channelId: "slack" },
    });
    if (process.platform !== "win32") {
      expect((await stat(stateDir)).mode & 0o077).toBe(0);
      expect((await stat(join(stateDir, "continuation-store-v3.json"))).mode & 0o077).toBe(0);
      expect((await stat(join(stateDir, "records-v3"))).mode & 0o077).toBe(0);
    }
    const recordFiles = await readdir(join(stateDir, "records-v3"));
    const persisted = (await Promise.all(recordFiles.map(async (file) =>
      await readFile(join(stateDir, "records-v3", file), "utf8")))).join("\n");
    expect(persisted).not.toContain(capability.token);
    expect(persisted).not.toContain(claim.token);
    expect(persisted).not.toContain("Final verified briefing");
    await expect(service.health()).resolves.toMatchObject({
      storage: { format: "per-record-v3", records: 1, terminalTombstones: 1, compacted: 1 },
    });
  });

  it("defers without a model while context is pending, then uses one deduplicated pinned snapshot", async () => {
    const stateDir = fixtureDir("pending-context");
    const synthesize = vi.fn(async () => ({ text: "Pinned answer" }));
    const deliver = vi.fn(async (_input: unknown) => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir, synthesize, deliver });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-pending",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
      replyTo: { conversationId: "slack:D1:1.1" },
      historyBoundary: "run-pending",
    });
    const first = await claimContinuation(capability, "pending-1", hash("pending-1"));
    const second = await claimContinuation(capability, "pending-2", hash("pending-2"));
    await capability.release();
    expect(await capability.requiresOriginContext()).toBe(true);
    await putResult(first, { done: 1 });
    await putResult(second, { done: 2 });

    await service.processDue(2);
    expect(synthesize).not.toHaveBeenCalled();
    await expect(getStatus(first)).resolves.toMatchObject({
      state: "result_received",
      synthesisDeferrals: 1,
      originContext: { state: "pending" },
    });

    await capability.finalizeOriginContext(originContext("run-pending", "slack:D1:1.1#2026-07-14"));
    expect(await readdir(join(stateDir, "origin-context-v1"))).toHaveLength(1);
    await capability.activateOriginContext();
    await service.processDue(2);

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await readdir(join(stateDir, "origin-context-v1"))).toEqual([]);
    const persisted = await persistedRecords(stateDir);
    expect(persisted).toHaveLength(2);
    for (const record of persisted) {
      expect(record).toMatchObject({
        originContextState: "scrubbed",
        completionKind: "synthesized",
      });
      expect(record.originContextDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.originContextFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.originContextBindingMac).toMatch(/^[a-f0-9]{64}$/u);
      expect(record).not.toHaveProperty("originContextRef");
    }
  });

  it("turns restart-loss into one deterministic delivery without invoking the model", async () => {
    const stateDir = fixtureDir("missing-context-restart");
    const firstService = await start({ stateDir });
    const capability = firstService.issueContinuationClaimCapability({
      runId: "run-lost",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
      replyTo: { conversationId: "slack:D1:1.1" },
      historyBoundary: "run-lost",
    });
    const claim = await claimContinuation(capability, "lost-task", hash("lost-task"));
    await putResult(claim, { private: "must-not-be-interpolated" });
    await capability.release();
    await firstService.stop();

    const synthesize = vi.fn(async () => ({ text: "must not run" }));
    const deliver = vi.fn(async (_input: unknown) => ({ kind: "delivered" as const, code: "delivered" as const }));
    const restarted = await start({ stateDir, synthesize, deliver });
    await restarted.processDue();

    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      continuationId: claim.continuationId,
      deliveryKey: `continuation:${claim.continuationId}`,
      text: "The background task finished, but I could not safely restore the original conversation context. Please ask me to check the result again.",
    });
    expect(JSON.stringify(deliver.mock.calls[0]?.[0])).not.toContain("must-not-be-interpolated");
    await expect(restarted.status(claim.continuationId)).resolves.toMatchObject({
      state: "delivered",
      completionKind: "origin_context_unavailable",
      originContext: { state: "abandoned" },
      attempts: { synthesis: 0, delivery: 1 },
    });
  });

  it.each(["missing", "corrupt"] as const)(
    "turns a %s pinned blob into deterministic delivery and retains binding provenance",
    async (condition) => {
      const stateDir = fixtureDir(`${condition}-context`);
      const synthesize = vi.fn(async () => ({ text: "must not run" }));
      const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
      const service = await start({ stateDir, synthesize, deliver });
      const capability = service.issueContinuationClaimCapability({
        runId: "run-corrupt",
        serverName: "a8c-control",
        conversationId: "slack:D1:1.1#2026-07-14",
        replyTo: { conversationId: "slack:D1:1.1" },
        historyBoundary: "run-corrupt",
      });
      const claim = await claimContinuation(capability, "corrupt-task", hash("corrupt-task"));
      await capability.release();
      expect(await capability.requiresOriginContext()).toBe(true);
      await capability.finalizeOriginContext(originContext("run-corrupt", "slack:D1:1.1#2026-07-14"));
      await capability.activateOriginContext();
      const [blob] = await readdir(join(stateDir, "origin-context-v1"));
      expect(blob).toBeDefined();
      const blobPath = join(stateDir, "origin-context-v1", blob as string);
      if (condition === "missing") await rm(blobPath);
      else await writeFile(blobPath, "not canonical context", "utf8");
      await putResult(claim, { done: true });
      await service.processDue();

      expect(synthesize).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledOnce();
      const [record] = await persistedRecords(stateDir);
      expect(record).toMatchObject({
        originContextState: "abandoned",
        completionKind: "origin_context_unavailable",
      });
      expect(record?.originContextDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(record?.originContextFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(record?.originContextBindingMac).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  it("treats an unsafe pinned snapshot as unavailable after restart instead of poisoning startup", async () => {
    if (process.platform === "win32") return;
    const stateDir = fixtureDir("unsafe-context-restart");
    const first = await start({ stateDir });
    const capability = first.issueContinuationClaimCapability({
      runId: "run-unsafe-context",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
    });
    const claim = await claimContinuation(capability, "unsafe-context-task", hash("unsafe-context-task"));
    await capability.release();
    await capability.finalizeOriginContext(originContext(
      "run-unsafe-context",
      "slack:D1:1.1#2026-07-14",
    ));
    await capability.activateOriginContext();
    const [blob] = await readdir(join(stateDir, "origin-context-v1"));
    if (blob === undefined) throw new Error("expected a pinned origin-context blob");
    const port = Number(new URL(first.url).port);
    await first.stop();
    services.splice(services.indexOf(first), 1);
    await chmod(join(stateDir, "origin-context-v1", blob), 0o644);

    const synthesize = vi.fn(async () => ({ text: "must not run" }));
    const deliver = vi.fn(async (_input: unknown) => ({ kind: "delivered" as const, code: "delivered" as const }));
    const restarted = await start({ stateDir, port, synthesize, deliver });
    expect((await putResult(claim, { done: true })).status).toBe(202);
    await restarted.processDue();

    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      completionKind: "origin_context_unavailable",
      attempts: { synthesis: 0, delivery: 1 },
    });
  });

  it.each(["binding-mac", "deadline", "result-token"] as const)(
    "blocks native delivery when a pinned record %s is tampered between restarts",
    async (field) => {
      const stateDir = fixtureDir(`tampered-context-${field}`);
      const first = await start({ stateDir });
      const capability = first.issueContinuationClaimCapability({
        runId: "run-tampered-binding",
        serverName: "a8c-control",
        conversationId: "slack:D1:1.1#2026-07-14",
      });
      const claim = await claimContinuation(capability, "tampered-binding-task", hash("tampered-binding-task"));
      await capability.release();
      await capability.finalizeOriginContext(originContext(
        "run-tampered-binding",
        "slack:D1:1.1#2026-07-14",
      ));
      await capability.activateOriginContext();
      await putResult(claim, { done: true });
      const port = Number(new URL(first.url).port);
      await first.stop();
      services.splice(services.indexOf(first), 1);
      const [recordFile] = await readdir(join(stateDir, "records-v3"));
      if (recordFile === undefined) throw new Error("expected a pinned continuation record");
      const recordPath = join(stateDir, "records-v3", recordFile);
      const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
      const tampered = field === "binding-mac"
        ? { ...record, originContextBindingMac: hash("tampered-binding") }
        : field === "deadline"
          ? { ...record, deadline: new Date(Date.now() + 120_000).toISOString() }
          : { ...record, resultTokenHash: hash("tampered-result-token") };
      await writeFile(recordPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
      if (process.platform !== "win32") await chmod(recordPath, 0o600);

      const synthesize = vi.fn(async () => ({ text: "must not run" }));
      const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
      const restarted = await start({ stateDir, port, synthesize, deliver });
      await restarted.processDue();

      expect(synthesize).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      await expect(restarted.status(claim.continuationId)).resolves.toMatchObject({
        state: "dead_lettered",
        lastError: { code: "origin_context_binding_invalid" },
        attempts: { synthesis: 0, delivery: 0 },
      });
    },
  );

  it("rejects spoofed claim/result capabilities and revokes run claims", async () => {
    const service = await start({ stateDir: fixtureDir("auth") });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-auth",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const denied = await fetch(capability.url, {
      method: "POST",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: JSON.stringify(claimBody("auth-task", hash("auth-task"))),
    });
    expect(denied.status).toBe(401);
    const claim = await claimContinuation(capability, "auth-task", hash("auth-task"));
    await expect(fetch(claim.resultUrl, {
      method: "PUT",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: JSON.stringify(resultBody({ ok: true })),
    }).then(async (response) => response.status)).resolves.toBe(401);
    await capability.release();
    await expect(fetch(capability.url, {
      method: "POST",
      headers: { authorization: `Bearer ${capability.token}`, "content-type": "application/json" },
      body: JSON.stringify(claimBody("another", hash("another"))),
    }).then(async (response) => response.status)).resolves.toBe(401);
  });

  it("cannot admit a slow claim body after the capability is released", async () => {
    const service = await start({ stateDir: fixtureDir("slow-claim-release") });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-slow-claim",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
    });
    let request!: ClientRequest;
    const responseStatus = new Promise<number>((resolve, reject) => {
      request = httpRequest(capability.url, {
        method: "POST",
        headers: authJson(capability.token),
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
    });
    request.write('{"taskKey":"slow-body-task",');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    await capability.release();
    request.end(`"taskHash":"${hash("slow-body-task")}","deadline":"${new Date(Date.now() + 60_000).toISOString()}"}`);

    await expect(responseStatus).resolves.toBe(401);
    await expect(service.list()).resolves.toEqual([]);
  });

  it("revokes stale handles and capabilities before releasing durable ownership", async () => {
    const stateDir = fixtureDir("stale-capability-stop");
    const first = await start({ stateDir });
    const capability = first.issueContinuationClaimCapability({
      runId: "run-stale-stop",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
    });
    const claim = await claimContinuation(capability, "stale-stop-task", hash("stale-stop-task"));
    await capability.release();
    const port = Number(new URL(first.url).port);

    await Promise.all([first.stop(), first.stop()]);
    services.splice(services.indexOf(first), 1);
    expect(await capability.requiresOriginContext()).toBe(false);
    await expect(capability.finalizeOriginContext(originContext(
      "run-stale-stop",
      "slack:D1:1.1#2026-07-14",
    ))).resolves.toBeUndefined();
    await expect(capability.activateOriginContext()).resolves.toBeUndefined();
    await expect(capability.abandonOriginContext()).resolves.toBeUndefined();
    await expect(first.retry(claim.continuationId)).rejects.toThrow(/service is stopped/iu);
    await expect(first.status(claim.continuationId)).rejects.toThrow(/service is stopped/iu);

    const synthesize = vi.fn(async () => ({ text: "must not run" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const restarted = await start({ stateDir, port, synthesize, deliver });
    await expect(restarted.status(claim.continuationId)).resolves.toMatchObject({
      state: "claimed",
      originContext: { state: "abandoned" },
    });
    await putResult(claim, { done: true });
    await restarted.processDue();
    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("drains an accepted claim on release and defaults its pinned boundary to the origin run", async () => {
    const synthesize = vi.fn(async () => ({ text: "Safely resumed" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir: fixtureDir("default-boundary"), synthesize, deliver });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-default-boundary",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
      replyTo: { conversationId: "slack:D1:1.1" },
    });
    const claim = await claimContinuation(capability, "default-boundary-task", hash("default-boundary-task"));

    await capability.release();
    expect(await capability.requiresOriginContext()).toBe(true);
    await expect(service.status(claim.continuationId)).resolves.toMatchObject({
      state: "claimed",
      originContext: { state: "pending" },
    });
    await capability.finalizeOriginContext(originContext(
      "run-default-boundary",
      "slack:D1:1.1#2026-07-14",
    ));
    await capability.activateOriginContext();
    await putResult(claim, { done: true });
    await service.processDue();

    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      historyBoundary: "run-default-boundary",
      originContextPolicy: "pinned",
    }));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("keeps a silent result pending until its origin snapshot is activated", async () => {
    const synthesize = vi.fn(async () => ({ text: "must not run" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir: fixtureDir("silent-pending"), synthesize, deliver });
    const capability = service.issueRunClaimCapability({
      runId: "run-silent",
      serverName: "a8c-control",
      originConversationId: "slack:D1:1.1#2026-07-14",
      mode: "silent",
    });
    const claim = await claimContinuation(capability, "silent-task", hash("silent-task"));
    await capability.release();
    await putResult(claim, { done: true });

    await service.processDue();
    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "result_received",
      originContext: { state: "pending" },
      attempts: { synthesis: 0, delivery: 0 },
    });

    await capability.finalizeOriginContext(originContext("run-silent", "slack:D1:1.1#2026-07-14"));
    await capability.activateOriginContext();
    await service.processDue();
    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      receipt: { kind: "silent" },
    });
  });

  it("excludes an expired sibling when settling the remaining origin group", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const synthesize = vi.fn(async () => ({ text: "Active sibling result" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({
      stateDir: fixtureDir("terminal-origin-sibling"),
      synthesize,
      deliver,
      now: () => now,
    });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-terminal-sibling",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1#2026-07-14",
    });
    const expired = await claimContinuation(
      capability,
      "expired-sibling",
      hash("expired-sibling"),
      "2026-07-14T10:00:10.000Z",
    );
    const active = await claimContinuation(
      capability,
      "active-sibling",
      hash("active-sibling"),
      "2026-07-14T10:05:00.000Z",
    );
    now = new Date("2026-07-14T10:00:20.000Z");
    await service.processDue(2);
    await expect(getStatus(expired)).resolves.toMatchObject({ state: "expired" });

    await capability.release();
    expect(await capability.requiresOriginContext()).toBe(true);
    await capability.finalizeOriginContext(originContext(
      "run-terminal-sibling",
      "slack:D1:1.1#2026-07-14",
    ));
    await capability.activateOriginContext();
    await expect(getStatus(active)).resolves.toMatchObject({ originContext: { state: "pinned" } });
    await putResult(active, { done: true });
    await service.processDue();

    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(expired)).resolves.toMatchObject({ state: "expired" });
    await expect(getStatus(active)).resolves.toMatchObject({ state: "delivered" });
  });

  it("makes claims and PUT results idempotent while rejecting changed immutable inputs", async () => {
    const service = await start({ stateDir: fixtureDir("idempotency") });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-idempotent",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const first = await claimContinuation(capability, "stable-task", hash("stable-task"), deadline);
    const replay = await claimContinuation(capability, "stable-task", hash("stable-task"), deadline);
    expect(replay).toMatchObject({ continuationId: first.continuationId, token: first.token, replayed: true });
    const conflict = await rawClaim(capability, "stable-task", hash("changed"), deadline);
    expect(conflict.status).toBe(409);
    const deadlineConflict = await rawClaim(
      capability,
      "stable-task",
      hash("stable-task"),
      new Date(Date.parse(deadline) + 1_000).toISOString(),
    );
    expect(deadlineConflict.status).toBe(409);

    const payload = { alpha: 1, beta: { first: true, second: [1, 2, 3] } };
    expect((await putResult(first, payload)).status).toBe(202);
    expect((await putResult(first, { beta: { second: [1, 2, 3], first: true }, alpha: 1 })).status).toBe(202);
    const changed = await fetch(first.resultUrl, {
      method: "PUT",
      headers: authJson(first.token),
      body: JSON.stringify(resultBody({ result: [4] }, "same-result")),
    });
    expect(changed.status).toBe(409);
  });

  it("supports detached named capture without posting and keeps the route host-owned", async () => {
    const synthesize = vi.fn(async () => ({ text: "Captured validation result" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({
      stateDir: fixtureDir("capture"),
      synthesize,
      deliver,
      namedRoutes: {
        "fleet-capture": { mode: "capture", conversationId: "slack:D-TEST:1.1" },
      },
      detachedServices: { fleet: "fleet-secret-token-123456789" },
    });
    const response = await fetch(`${service.url}/v1/continuations/detached/claim`, {
      method: "POST",
      headers: {
        ...authJson("fleet-secret-token-123456789"),
        "x-mono-agent-service-name": "fleet",
      },
      body: JSON.stringify({ ...claimBody("capture-task", hash("capture-task")), route: "fleet-capture" }),
    });
    expect(response.status).toBe(200);
    const claim = await json<ClaimResponse>(response);
    await putResult(claim, { check: "green" });
    await service.processDue();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      mode: "capture",
      replyToConversationId: "slack:D-TEST:1.1",
    }));
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivered", receipt: { kind: "captured" } });
    await expect(service.capturedText(claim.continuationId)).resolves.toBe("Captured validation result");

    const redirect = await fetch(`${service.url}/v1/continuations/detached/claim`, {
      method: "POST",
      headers: {
        ...authJson("fleet-secret-token-123456789"),
        "x-mono-agent-service-name": "fleet",
      },
      body: JSON.stringify({ ...claimBody("redirect", hash("redirect")), route: "slack:D-EVIL" }),
    });
    expect(redirect.status).toBe(403);
  });

  it("persists synthesis once across delivery retry and never reruns it", async () => {
    const synthesize = vi.fn(async () => ({ text: "Stable final answer" }));
    const deliver = vi.fn()
      .mockResolvedValueOnce({ kind: "retryable", code: "channel_busy", reason: "busy", retryAfterMs: 0 })
      .mockResolvedValueOnce({ kind: "delivered", code: "delivered", deliveryId: "slack:D1:2.1" });
    const service = await start({ stateDir: fixtureDir("retry"), synthesize, deliver });
    const claim = await issueAndClaim(service, "retry-task");
    await putResult(claim, { final: true });
    await service.processDue();
    await service.processDue();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledTimes(2);
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivered", attempts: { synthesis: 1, delivery: 2 } });
  });

  it("queues unavailable synthesis preflight without consuming a model attempt", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    let ready = false;
    const synthesisPreflight = vi.fn(() => ready
      ? { ready: true as const }
      : {
          ready: false as const,
          code: "destination_channel_unavailable",
          reason: "Slack responder is still starting.",
          retryAfterMs: 10_000,
        });
    const synthesize = vi.fn(async () => ({ text: "Prepared exactly once" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({
      stateDir: fixtureDir("synthesis-preflight"),
      synthesisPreflight,
      synthesize,
      deliver,
      now: () => now,
    });
    const claim = await issueAndClaim(service, "synthesis-preflight-task");
    await putResult(claim, { final: true });

    await service.processDue();

    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "result_received",
      attempts: { synthesis: 0, delivery: 0 },
      lastError: { code: "destination_channel_unavailable" },
    });

    ready = true;
    expect(await service.processDue()).toBe(0);
    expect(synthesisPreflight).toHaveBeenCalledOnce();
    now = new Date("2026-07-14T10:00:10.000Z");
    await service.processDue();

    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      attempts: { synthesis: 1, delivery: 1 },
    });
  });

  it("requeues the narrow post-preflight readiness race without consuming or replaying a model attempt", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new ContinuationSynthesisUnavailableError(
        "origin_history_not_ready",
        "The origin turn has not committed its history boundary yet.",
        1_000,
      ))
      .mockResolvedValueOnce({ text: "Prepared after origin commit" });
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir: fixtureDir("history-race"), synthesize, deliver, now: () => now });
    const claim = await issueAndClaim(service, "history-race-task");
    await putResult(claim, { final: true });

    await service.processDue();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "result_received",
      attempts: { synthesis: 0, delivery: 0 },
      lastError: { code: "origin_history_not_ready" },
    });

    now = new Date("2026-07-14T10:00:01.000Z");
    await service.processDue();
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivered", attempts: { synthesis: 1, delivery: 1 } });
  });

  it("makes a failed synthesis terminal and never permits model replay", async () => {
    const synthesize = vi.fn(async () => { throw new Error("provider response was lost"); });
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir: fixtureDir("synthesis-once"), synthesize, deliver });
    const claim = await issueAndClaim(service, "synthesis-once-task");
    await putResult(claim, { final: true });
    await service.processDue();
    await service.processDue();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "dead_lettered",
      attempts: { synthesis: 1, delivery: 0 },
      lastError: { code: "synthesis_failed" },
    });
    await expect(service.retry(claim.continuationId)).rejects.toMatchObject({ code: "synthesis_not_retryable" });
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it("isolates hung synthesis workers and aborts their drain during shutdown", async () => {
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstId = "";
    const synthesize = vi.fn(async (input: { readonly continuationId: string }) => {
      if (input.continuationId === firstId) await held;
      return { text: `answer:${input.continuationId}` };
    });
    const service = await start({
      stateDir: fixtureDir("isolated-workers"),
      synthesize,
      limits: { maxConcurrent: 2 },
    });
    const first = await issueAndClaim(service, "isolated-first");
    firstId = first.continuationId;
    const second = await issueAndClaim(service, "isolated-second");
    await putResult(first, { order: 1 });
    await putResult(second, { order: 2 });

    const processing = service.processDue(2);
    const processingOutcome = processing.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      await expect(getStatus(second)).resolves.toMatchObject({ state: "delivered" });
    });
    await expect(getStatus(first)).resolves.toMatchObject({ state: "synthesizing" });

    await expect(Promise.race([
      service.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown hung")), 500)),
    ])).resolves.toBeUndefined();
    services.splice(services.indexOf(service), 1);
    expect(await processingOutcome).toBeInstanceOf(Error);
    releaseFirst();
  });

  it("dead-letters a timed-out synthesis without replaying the model", async () => {
    const synthesize = vi.fn(async () => await new Promise<{ text: string }>(() => undefined));
    const service = await start({
      stateDir: fixtureDir("synthesis-timeout"),
      synthesize,
      limits: { synthesisTimeoutMs: 10 },
    });
    const claim = await issueAndClaim(service, "synthesis-timeout-task");
    await putResult(claim, { final: true });

    await service.processDue();
    await service.processDue();

    expect(synthesize).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "dead_lettered",
      lastError: { code: "synthesis_timeout_outcome_unknown" },
    });
  });

  it("does not recover a locally supervised worker merely because its lease elapsed", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const synthesize = vi.fn(async () => {
      await held;
      return { text: "completed under local supervision" };
    });
    const service = await start({
      stateDir: fixtureDir("local-lease-supervision"),
      synthesize,
      now: () => now,
      leaseMs: 10,
      limits: { synthesisTimeoutMs: 60_000 },
    });
    const claim = await issueAndClaim(service, "local-lease-supervision-task");
    await putResult(claim, { final: true });
    const processing = service.processDue();
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());

    now = new Date("2026-07-14T10:00:01.000Z");
    await expect(service.processDue()).resolves.toBe(0);
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "synthesizing" });

    release();
    await processing;
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivered" });
  });

  it("never blindly replays an ambiguous native delivery", async () => {
    const deliver = vi.fn()
      .mockResolvedValueOnce({ kind: "unknown", code: "socket_closed", reason: "Slack may have accepted the post" })
      .mockResolvedValueOnce({ kind: "delivered", code: "delivered", deliveryId: "slack:D1:3.1" });
    const service = await start({ stateDir: fixtureDir("unknown"), deliver });
    const claim = await issueAndClaim(service, "unknown-task");
    await putResult(claim, { final: true });
    await service.processDue();
    await service.processDue();
    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivery_unknown" });
    await expect(service.retry(claim.continuationId)).rejects.toMatchObject({ code: "delivery_unknown" });
    await service.resolveUnknown(claim.continuationId, { kind: "not_delivered" });
    await service.processDue();
    expect(deliver).toHaveBeenCalledTimes(2);
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivered" });
  });

  it("records operator-confirmed ambiguous delivery to history without reposting", async () => {
    const deliver = vi.fn(async () => ({
      kind: "unknown" as const,
      code: "socket_closed",
      reason: "Slack may have accepted the post",
    }));
    const recordHistory = vi.fn(async () => ({
      recorded: false as const,
      code: "history_store_down",
    }));
    const service = await start({ stateDir: fixtureDir("unknown-history"), deliver, recordHistory });
    const claim = await issueAndClaim(service, "unknown-history-task");
    await putResult(claim, { final: true });
    await service.processDue();

    await service.resolveUnknown(claim.continuationId, {
      kind: "delivered",
      deliveryId: "slack:D1:confirmed",
    });

    expect(deliver).toHaveBeenCalledOnce();
    expect(recordHistory).toHaveBeenCalledWith({
      continuationId: claim.continuationId,
      conversationId: "slack:D1:1.1",
      text: "Synthesized answer",
      deliveryKey: `continuation:${claim.continuationId}`,
    });
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      receipt: {
        kind: "delivered",
        deliveryId: "slack:D1:confirmed",
        historyRecorded: false,
        historyErrorCode: "history_store_down",
      },
    });
    await expect(service.health()).resolves.toMatchObject({
      status: "degraded",
      storage: { historyDegraded: 1 },
    });
  });

  it("bounds active claims per origin and globally while preserving idempotent replay", async () => {
    const service = await start({
      stateDir: fixtureDir("admission-limits"),
      limits: { maxActiveRecords: 2, maxActivePerOrigin: 1 },
    });
    const firstCapability = service.issueContinuationClaimCapability({
      runId: "run-limit-one",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const first = await claimContinuation(firstCapability, "limit-one", hash("limit-one"), deadline);
    expect((await rawClaim(firstCapability, "limit-two", hash("limit-two"), deadline)).status).toBe(429);
    await expect(claimContinuation(firstCapability, "limit-one", hash("limit-one"), deadline)).resolves.toMatchObject({
      continuationId: first.continuationId,
      replayed: true,
    });

    const secondCapability = service.issueContinuationClaimCapability({
      runId: "run-limit-two",
      serverName: "a8c-control",
      conversationId: "slack:D2:2.2",
    });
    await claimContinuation(secondCapability, "limit-three", hash("limit-three"), deadline);
    const thirdCapability = service.issueContinuationClaimCapability({
      runId: "run-limit-three",
      serverName: "a8c-control",
      conversationId: "slack:D3:3.3",
    });
    expect((await rawClaim(thirdCapability, "limit-four", hash("limit-four"), deadline)).status).toBe(429);
  });

  it("keyset-paginates the bounded operator listing", async () => {
    const service = await start({
      stateDir: fixtureDir("operator-pagination"),
      limits: { operatorPageSize: 2, maxActivePerOrigin: 10 },
    });
    await issueAndClaim(service, "page-one");
    await issueAndClaim(service, "page-two");
    await issueAndClaim(service, "page-three");
    const headers = { authorization: `Bearer ${service.operatorToken}` };

    const firstResponse = await fetch(`${service.url}/v1/operator/continuations`, { headers });
    expect(firstResponse.status).toBe(200);
    const first = await json<{ continuations: unknown[]; nextCursor?: string; pageSize: number }>(firstResponse);
    expect(first.continuations).toHaveLength(2);
    expect(first.pageSize).toBe(2);
    expect(first.nextCursor).toBeTypeOf("string");

    const secondResponse = await fetch(
      `${service.url}/v1/operator/continuations?cursor=${encodeURIComponent(first.nextCursor as string)}`,
      { headers },
    );
    expect(secondResponse.status).toBe(200);
    await expect(json<{ continuations: unknown[]; nextCursor?: string }>(secondResponse)).resolves.toMatchObject({
      continuations: [expect.any(Object)],
    });
    expect((await fetch(`${service.url}/v1/operator/continuations?limit=3`, { headers })).status).toBe(400);
    expect((await fetch(`${service.url}/v1/operator/continuations?cursor=not-a-cursor`, { headers })).status).toBe(400);
  });

  it("rejects operator cancellation while native delivery is in flight and preserves the receipt", async () => {
    let enteredDelivery!: () => void;
    let finishDelivery!: () => void;
    const entered = new Promise<void>((resolve) => { enteredDelivery = resolve; });
    const finish = new Promise<void>((resolve) => { finishDelivery = resolve; });
    const deliver = vi.fn(async () => {
      enteredDelivery();
      await finish;
      return { kind: "delivered" as const, code: "delivered" as const, deliveryId: "slack:D1:in-flight" };
    });
    const service = await start({ stateDir: fixtureDir("cancel-in-flight"), deliver });
    const claim = await issueAndClaim(service, "cancel-in-flight-task");
    await putResult(claim, { final: true });

    const processing = service.processDue();
    await entered;
    await expect(service.cancel(claim.continuationId)).rejects.toMatchObject({ code: "continuation_in_flight" });
    finishDelivery();
    await processing;

    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      receipt: { kind: "delivered", deliveryId: "slack:D1:in-flight" },
    });
  });

  it("never retries a confirmed post when channel-history append fails and exposes degraded health", async () => {
    const deliver = vi.fn(async () => ({
      kind: "delivered" as const,
      code: "delivered" as const,
      deliveryId: "slack:D1:history-degraded",
      channelId: "slack",
      historyRecorded: false,
      historyErrorCode: "history_record_failed",
    }));
    const service = await start({ stateDir: fixtureDir("history-degraded"), deliver });
    const claim = await issueAndClaim(service, "history-degraded-task");
    await putResult(claim, { final: true });

    await service.processDue();
    await service.processDue();

    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "delivered",
      receipt: {
        kind: "delivered",
        deliveryId: "slack:D1:history-degraded",
        historyRecorded: false,
        historyErrorCode: "history_record_failed",
      },
    });
    await expect(service.health()).resolves.toMatchObject({
      status: "degraded",
      storage: { historyDegraded: 1 },
    });
  });

  it("recovers a result_received record after restart with the same callback token", async () => {
    const stateDir = fixtureDir("restart");
    const first = await start({ stateDir });
    const claim = await issueAndClaim(first, "restart-task");
    await putResult(claim, { after: "restart" });
    const port = Number(new URL(first.url).port);
    await first.stop();
    services.splice(services.indexOf(first), 1);

    const synthesize = vi.fn(async () => ({ text: "Recovered answer" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const second = await start({ stateDir, port, synthesize, deliver });
    await second.processDue();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "delivered" });
  });

  it("preserves terminal claim/result idempotency across compaction and restart", async () => {
    const stateDir = fixtureDir("terminal-restart");
    const first = await start({ stateDir });
    const capability = first.issueContinuationClaimCapability({
      runId: "run-terminal-restart",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const claim = await claimContinuation(capability, "terminal-restart-task", hash("terminal-restart-task"), deadline);
    await capability.release();
    await capability.finalizeOriginContext(originContext("run-terminal-restart", "slack:D1:1.1"));
    await capability.activateOriginContext();
    const payload = { status: "complete", details: ["durably compacted"] };
    await putResult(claim, payload);
    await first.processDue();
    const port = Number(new URL(first.url).port);
    await first.stop();
    services.splice(services.indexOf(first), 1);

    const second = await start({ stateDir, port });
    const replayCapability = second.issueContinuationClaimCapability({
      runId: "run-terminal-restart",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const replay = await claimContinuation(replayCapability, "terminal-restart-task", hash("terminal-restart-task"), deadline);
    expect(replay).toMatchObject({ continuationId: claim.continuationId, token: claim.token, replayed: true });
    expect((await putResult(replay, payload)).status).toBe(202);
    await expect(getStatus(replay)).resolves.toMatchObject({ state: "delivered" });
  });

  it("bounds terminal tombstones and captured answer retention across restart", async () => {
    const stateDir = fixtureDir("bounded-retention");
    const retention = {
      terminalMaxRecords: 2,
      terminalMaxAgeMs: 60_000,
      capturedTextMaxRecords: 1,
      capturedTextMaxAgeMs: 60_000,
    };
    const service = await start({
      stateDir,
      retention,
      namedRoutes: { capture: { mode: "capture", conversationId: "slack:D1:1.1" } },
      detachedServices: { fleet: "fleet-secret-token-123456789" },
    });
    const first = await detachedCapture(service, "capture-one");
    await service.processDue();
    const second = await detachedCapture(service, "capture-two");
    await service.processDue();
    const third = await issueAndClaim(service, "ordinary-third");
    await putResult(third, { done: true });
    await service.processDue();

    expect(await service.list()).toHaveLength(2);
    await expect(service.status(first.continuationId)).resolves.toBeUndefined();
    await expect(service.capturedText(second.continuationId)).resolves.toBe("Synthesized answer");
    await expect(service.health()).resolves.toMatchObject({
      storage: { records: 2, terminalTombstones: 2, capturedText: 1 },
    });
    const port = Number(new URL(service.url).port);
    await service.stop();
    services.splice(services.indexOf(service), 1);

    const restarted = await start({ stateDir, port, retention });
    await expect(restarted.health()).resolves.toMatchObject({
      storage: { records: 2, terminalTombstones: 2, capturedText: 1 },
    });
    await expect(restarted.capturedText(second.continuationId)).resolves.toBe("Synthesized answer");
  });

  it("settles a legacy pinned result with a fixed zero-model fallback", async () => {
    const stateDir = fixtureDir("legacy-missing-context");
    const id = "legacy-missing-context-result";
    const payload = { private: "legacy-result-must-not-be-interpolated" };
    await writeLegacyLedger(stateDir, {
      [id]: durableRecord(id, {
        historyBoundary: `run-${id}`,
        state: "result_received",
        resultIdempotencyKey: "legacy-result",
        resultPayload: payload,
        resultPayloadHash: continuationDigest(canonicalContinuationJson(payload)),
      }),
    });
    const synthesize = vi.fn(async () => ({ text: "must not run" }));
    const deliver = vi.fn(async (_input: unknown) => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir, synthesize, deliver });

    await expect(service.status(id)).resolves.toMatchObject({
      state: "result_received",
      originContext: { state: "legacy_missing" },
    });
    await service.processDue();

    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      continuationId: id,
      text: "The background task finished, but I could not safely restore the original conversation context. Please ask me to check the result again.",
    });
    expect(JSON.stringify(deliver.mock.calls[0]?.[0])).not.toContain("legacy-result-must-not-be-interpolated");
    await expect(service.status(id)).resolves.toMatchObject({
      state: "delivered",
      completionKind: "origin_context_unavailable",
      attempts: { synthesis: 0, delivery: 1 },
    });
  });

  it("migrates the legacy v1 ledger idempotently into owner-only per-record state", async () => {
    const stateDir = fixtureDir("legacy-migration");
    const id = "legacy-continuation";
    await writeLegacyLedger(stateDir, { [id]: durableRecord(id) });

    const service = await start({ stateDir });

    await expect(service.status(id)).resolves.toMatchObject({ continuationId: id, state: "claimed" });
    await expect(stat(join(stateDir, "continuations-v1.json"))).resolves.toBeDefined();
    expect(await readdir(join(stateDir, "records-v3"))).toHaveLength(1);
    await expect(stat(join(stateDir, "records-v2", "UPGRADED-TO-RECORDS-V3"))).resolves.toBeDefined();
    await expect(service.health()).resolves.toMatchObject({ storage: { format: "per-record-v3", records: 1 } });
  });

  it("fails closed when a partial legacy migration conflicts with an existing v3 record", async () => {
    const stateDir = fixtureDir("legacy-conflict");
    const first = await start({ stateDir });
    const claim = await issueAndClaim(first, "legacy-conflict-task");
    await first.stop();
    services.splice(services.indexOf(first), 1);
    const [recordFile] = await readdir(join(stateDir, "records-v3"));
    if (recordFile === undefined) throw new Error("expected migrated record");
    const record = JSON.parse(await readFile(join(stateDir, "records-v3", recordFile), "utf8")) as Record<string, unknown>;
    await writeLegacyLedger(stateDir, {
      [claim.continuationId]: { ...record, taskKey: "conflicting-task-key" },
    });
    await rm(join(stateDir, "continuation-store-v3.json"));

    await expect(startContinuationService({
      stateDir,
      autoProcess: false,
      synthesize: async () => ({ text: "x" }),
      deliver: async () => ({ kind: "delivered", code: "delivered" }),
    })).rejects.toThrow(/records conflict/u);
  });

  it("rejects duplicate and overlapping transaction entries before replay", async () => {
    for (const variant of ["duplicate", "overlap"] as const) {
      const stateDir = fixtureDir(`transaction-${variant}`);
      const recordsDir = join(stateDir, "records-v3");
      await mkdir(recordsDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      await chmod(recordsDir, 0o700);
      const record = durableRecord(`transaction-${variant}`);
      const writes = variant === "duplicate" ? [record, record] : [record];
      const deletes = variant === "overlap" ? [record.continuationId] : [];
      const transactionPath = join(stateDir, "continuation-transaction-v3.json");
      await writeFile(transactionPath, JSON.stringify({
        schemaVersion: 3,
        generation: `generation-${variant}`,
        createdAt: new Date().toISOString(),
        writes,
        deletes,
      }), { mode: 0o600 });
      await chmod(transactionPath, 0o600);

      await expect(startContinuationService({
        stateDir,
        autoProcess: false,
        synthesize: async () => ({ text: "x" }),
        deliver: async () => ({ kind: "delivered", code: "delivered" }),
      })).rejects.toThrow(/transaction has a malformed schema/u);
    }
  });

  it("rejects an oversized interrupted transaction before parsing or replay", async () => {
    const stateDir = fixtureDir("transaction-oversized");
    const recordsDir = join(stateDir, "records-v3");
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await chmod(recordsDir, 0o700);
    const transactionPath = join(stateDir, "continuation-transaction-v3.json");
    await writeFile(transactionPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
    await chmod(transactionPath, 0o600);

    await expect(startContinuationService({
      stateDir,
      autoProcess: false,
      synthesize: async () => ({ text: "x" }),
      deliver: async () => ({ kind: "delivered", code: "delivered" }),
    })).rejects.toThrow(/safety limit/u);
  });

  it("recovers an interrupted committed generation from disk and poisons the old instance", async () => {
    const stateDir = fixtureDir("commit-recovery");
    const first = await start({ stateDir });
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    await rm(manifestPath);
    await mkdir(manifestPath);
    const capability = first.issueContinuationClaimCapability({
      runId: "run-commit-recovery",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const deadline = new Date(Date.now() + 60_000).toISOString();

    const failed = await rawClaim(capability, "commit-recovery-task", hash("commit-recovery-task"), deadline);
    expect(failed.status).toBe(500);
    expect((await rawClaim(capability, "another-task", hash("another-task"))).status).toBe(500);
    await rm(manifestPath, { recursive: true, force: true });
    const port = Number(new URL(first.url).port);
    await first.stop();
    services.splice(services.indexOf(first), 1);

    const restarted = await start({ stateDir, port });
    const replayCapability = restarted.issueContinuationClaimCapability({
      runId: "run-commit-recovery",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const replay = await claimContinuation(replayCapability, "commit-recovery-task", hash("commit-recovery-task"), deadline);
    expect(replay.replayed).toBe(true);
  });

  it("expires unfinished continuations without synthesizing or delivering", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const synthesize = vi.fn(async () => ({ text: "too late" }));
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir: fixtureDir("expiry"), synthesize, deliver, now: () => now });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-expiry",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const claim = await claimContinuation(capability, "expiry-task", hash("expiry-task"), "2026-07-14T10:01:00.000Z");
    now = new Date("2026-07-14T10:02:00.000Z");
    await service.processDue();
    expect(synthesize).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({ state: "expired", lastError: { code: "deadline_expired" } });
  });

  it("persists expiry and never posts when synthesis finishes after the deadline", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const synthesize = vi.fn(async () => {
      now = new Date("2026-07-14T10:02:00.000Z");
      return { text: "Late answer that must not be posted" };
    });
    const deliver = vi.fn(async () => ({ kind: "delivered" as const, code: "delivered" as const }));
    const service = await start({ stateDir: fixtureDir("late-synthesis"), synthesize, deliver, now: () => now });
    const capability = service.issueContinuationClaimCapability({
      runId: "run-late-synthesis",
      serverName: "a8c-control",
      conversationId: "slack:D1:1.1",
    });
    const claim = await claimContinuation(
      capability,
      "late-synthesis-task",
      hash("late-synthesis-task"),
      "2026-07-14T10:01:00.000Z",
    );
    await capability.release();
    await capability.finalizeOriginContext(originContext("run-late-synthesis", "slack:D1:1.1"));
    await capability.activateOriginContext();
    await putResult(claim, { final: true });

    await service.processDue();

    expect(synthesize).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    await expect(getStatus(claim)).resolves.toMatchObject({
      state: "expired",
      lastError: { code: "deadline_expired" },
    });
  });

  it("recovers a restart during native send as delivery_unknown even after the deadline", async () => {
    const stateDir = fixtureDir("delivery-deadline-recovery");
    const id = "delivery-in-flight";
    await writeLegacyLedger(stateDir, {
      [id]: durableRecord(id, {
        state: "ready_to_deliver",
        deadline: "2026-07-14T10:01:00.000Z",
        synthesizedText: "Possibly posted before crash",
        deliveryStartedAt: "2026-07-14T10:00:30.000Z",
        leaseOwner: "crashed-process",
        leaseUntil: "2026-07-14T10:30:30.000Z",
      }),
    });

    const service = await start({ stateDir, now: () => new Date("2026-07-14T10:02:00.000Z") });

    await expect(service.status(id)).resolves.toMatchObject({
      state: "delivery_unknown",
      lastError: { code: "delivery_outcome_unknown" },
    });
  });

  it("fails closed when the state directory cannot remain owner-only", async () => {
    if (process.platform === "win32") return;
    const stateDir = fixtureDir("permissions");
    const service = await start({ stateDir });
    await issueAndClaim(service, "permissions-task");
    await service.stop();
    services.splice(services.indexOf(service), 1);
    const [recordFile] = await readdir(join(stateDir, "records-v3"));
    if (recordFile === undefined) throw new Error("expected a continuation record");
    await chmod(join(stateDir, "records-v3", recordFile), 0o644);
    await expect(startContinuationService({
      stateDir,
      autoProcess: false,
      synthesize: async () => ({ text: "x" }),
      deliver: async () => ({ kind: "delivered", code: "delivered" }),
    })).rejects.toThrow(/permissions are not owner-only/u);
  });

  it("holds exclusive state ownership across processes and recovers automatically after owner crash", async () => {
    const stateDir = fixtureDir("lock");
    const first = await start({ stateDir });
    await expect(startContinuationService({
      stateDir,
      autoProcess: false,
      synthesize: async () => ({ text: "x" }),
      deliver: async () => ({ kind: "delivered", code: "delivered" }),
    })).rejects.toThrow(/already owned by another live process/u);
    await first.stop();
    services.splice(services.indexOf(first), 1);

    const ownerDatabase = join(stateDir, "continuations-owner.sqlite");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.argv[1], { timeout: 0 });
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
      database.exec("CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY, pid INTEGER, acquired_at TEXT)");
      database.prepare("INSERT INTO ownership VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, acquired_at=excluded.acquired_at")
        .run(process.pid, new Date().toISOString());
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1_000);
    `, ownerDatabase], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForChildOutput(child, "locked");
    try {
      await expect(startContinuationService({
        stateDir,
        autoProcess: false,
        synthesize: async () => ({ text: "x" }),
        deliver: async () => ({ kind: "delivered", code: "delivered" }),
      })).rejects.toThrow(/already owned by another live process/u);
    } finally {
      child.kill("SIGKILL");
      await waitForChildExit(child);
    }

    const recovered = await start({ stateDir });
    await expect(recovered.health()).resolves.toMatchObject({ status: "healthy", storage: { format: "per-record-v3" } });
  });
});

async function start(overrides: Partial<Parameters<typeof startContinuationService>[0]> = {}): Promise<ContinuationServiceHandle> {
  const service = await startContinuationService({
    stateDir: fixtureDir("default"),
    autoProcess: false,
    synthesize: async () => ({ text: "Synthesized answer" }),
    deliver: async () => ({ kind: "delivered", code: "delivered" }),
    ...overrides,
  });
  services.push(service);
  return service;
}

async function issueAndClaim(service: ContinuationServiceHandle, taskKey: string): Promise<ClaimResponse> {
  const capability = service.issueContinuationClaimCapability({
    runId: `run-${taskKey}`,
    serverName: "a8c-control",
    conversationId: "slack:D1:1.1#2026-07-14",
    replyTo: { conversationId: "slack:D1:1.1" },
  });
  const claim = await claimContinuation(capability, taskKey, hash(taskKey));
  await capability.release();
  expect(await capability.requiresOriginContext()).toBe(true);
  await capability.finalizeOriginContext(originContext(`run-${taskKey}`, "slack:D1:1.1#2026-07-14"));
  await capability.activateOriginContext();
  return claim;
}

async function detachedCapture(service: ContinuationServiceHandle, taskKey: string): Promise<ClaimResponse> {
  const response = await fetch(`${service.url}/v1/continuations/detached/claim`, {
    method: "POST",
    headers: {
      ...authJson("fleet-secret-token-123456789"),
      "x-mono-agent-service-name": "fleet",
    },
    body: JSON.stringify({ ...claimBody(taskKey, hash(taskKey)), route: "capture" }),
  });
  expect(response.status).toBe(200);
  const claim = await json<ClaimResponse>(response);
  expect((await putResult(claim, { taskKey, complete: true })).status).toBe(202);
  return claim;
}

async function claimContinuation(
  capability: { readonly url: string; readonly token: string },
  taskKey: string,
  taskHash: string,
  deadline = new Date(Date.now() + 60_000).toISOString(),
): Promise<ClaimResponse> {
  const response = await rawClaim(capability, taskKey, taskHash, deadline);
  expect(response.status).toBe(200);
  return await json<ClaimResponse>(response);
}

async function rawClaim(
  capability: { readonly url: string; readonly token: string },
  taskKey: string,
  taskHash: string,
  deadline = new Date(Date.now() + 60_000).toISOString(),
): Promise<Response> {
  return await fetch(capability.url, {
    method: "POST",
    headers: authJson(capability.token),
    body: JSON.stringify(claimBody(taskKey, taskHash, deadline)),
  });
}

function claimBody(taskKey: string, taskHash: string, deadline = new Date(Date.now() + 60_000).toISOString()): Record<string, string> {
  return { taskKey, taskHash, deadline };
}

async function putResult(claim: ClaimResponse, payload: unknown): Promise<Response> {
  return await fetch(claim.resultUrl, {
    method: "PUT",
    headers: authJson(claim.token),
    body: JSON.stringify(resultBody(payload)),
  });
}

function resultBody(payload: unknown, idempotencyKey = "same-result"): Record<string, unknown> {
  const serialized = canonicalContinuationJson(payload);
  return { idempotencyKey, payload, payloadHash: continuationDigest(serialized) };
}

async function getStatus(claim: ClaimResponse): Promise<Record<string, unknown>> {
  const response = await fetch(claim.statusUrl, { headers: { authorization: `Bearer ${claim.token}` } });
  expect(response.status).toBe(200);
  return await json<Record<string, unknown>>(response);
}

function authJson(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function hash(value: string): string {
  return continuationDigest(value);
}

function originContext(runId: string, conversationId: string) {
  const capturedAt = "2026-07-14T12:00:00.000Z";
  return {
    schemaVersion: 1 as const,
    conversationId,
    originRunId: runId,
    historyBoundary: runId,
    capturedAt,
    messages: [
      { role: "user" as const, content: "Please delegate this task.", timestamp: capturedAt, runId },
      { role: "assistant" as const, content: "I will return with the result.", timestamp: capturedAt, runId },
    ],
  };
}

function fixtureDir(label: string): string {
  return join(tmpdir(), `mono-agent-continuation-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

async function persistedRecords(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const directory = join(stateDir, "records-v3");
  return await Promise.all((await readdir(directory)).map(async (file) =>
    JSON.parse(await readFile(join(directory, file), "utf8")) as Record<string, unknown>));
}

async function writeLegacyLedger(stateDir: string, records: Record<string, unknown>): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const path = join(stateDir, "continuations-v1.json");
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    records,
  })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function durableRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    continuationId: id,
    serverName: "a8c-control",
    originRunId: `run-${id}`,
    originConversationId: "slack:D1:1.1",
    replyToConversationId: "slack:D1:1.1",
    mode: "reply",
    taskKey: `task-${id}`,
    taskHash: hash(`task-${id}`),
    claimFingerprint: hash(`fingerprint-${id}`),
    resultTokenHash: hash(`token-${id}`),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deadline: new Date(now.getTime() + 60_000).toISOString(),
    state: "claimed",
    synthesisAttempts: 0,
    deliveryAttempts: 0,
    ...overrides,
  };
}

async function waitForChildOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onErrorData = (chunk: Buffer | string) => { errorOutput += chunk.toString(); };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`lock owner exited before readiness (${String(code)}): ${errorOutput}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onErrorData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErrorData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

interface ClaimResponse {
  readonly continuationId: string;
  readonly resultUrl: string;
  readonly statusUrl: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly replayed?: boolean;
}
