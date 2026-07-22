import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Role, TaskState, type Message, type Part, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import { InMemoryTaskStore, ServerCallContext, type A2ARequestHandler } from "@a2a-js/sdk/server";

import type { AgentRequestBase, AgentResponder } from "@mono-agent/agent-contracts";

import {
  A2AConsumerError,
  A2A_IDEMPOTENCY_EXTENSION_URI,
  A2A_IDEMPOTENCY_METADATA_KEY,
  createA2AConsumer,
  createA2AConsumerResponder,
  sendA2AMessage,
  startA2AProvider,
  type A2AProviderStartResult,
} from "../index.js";
import {
  classifyA2AIdempotencyTransportError,
  createIdempotentA2ARequestHandler,
} from "../idempotency.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable A2A logical dispatch idempotency", () => {
  it("rejects a blank programmatic stateDir before binding a provider", async () => {
    await expect(startProvider({
      stateDir: "   ",
      responder: { async respond() { return { text: "must not run" }; } },
    })).rejects.toMatchObject({
      code: "invalid_config",
      details: { field: "idempotency.stateDir" },
    });
  });

  it("does not advertise support without durable state and refuses a keyed send before POST", async () => {
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: "unexpected" };
        },
      },
      durable: false,
    });
    const methods: string[] = [];
    const consumer = await createA2AConsumer({
      agentUrl: provider.agentCardUrl,
      fetchImpl: async (input, init) => {
        methods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
        return await fetch(input, init);
      },
    });

    expect(provider.agentCard.capabilities?.extensions).toEqual([]);
    await expect(consumer.sendMessage({
      text: "must not post",
      idempotencyKey: "logical-unsupported-1",
    })).rejects.toMatchObject({ code: "idempotency_unsupported" });
    expect(methods).toEqual(["GET", "GET"]);
    expect(responderCalls).toBe(0);
  });

  it("re-checks a previously supported Agent Card before every keyed POST", async () => {
    let responderCalls = 0;
    let cardReads = 0;
    let posts = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    const consumer = await createA2AConsumer({
      agentUrl: provider.agentCardUrl,
      fetchImpl: async (request, init) => {
        const method = init?.method ?? (request instanceof Request ? request.method : "GET");
        if (method === "GET") {
          cardReads += 1;
          if (cardReads > 1) {
            return new Response(JSON.stringify({
              ...provider.agentCard,
              capabilities: {
                ...provider.agentCard.capabilities,
                extensions: [],
              },
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
        } else {
          posts += 1;
        }
        return await fetch(request, init);
      },
    });

    await expect(consumer.sendMessage({
      text: "card changed before dispatch",
      idempotencyKey: "logical-live-card-check-1",
    })).rejects.toMatchObject({ code: "idempotency_unsupported" });
    expect(cardReads).toBe(2);
    expect(posts).toBe(0);
    expect(responderCalls).toBe(0);
  });

  it("makes an unconfigured provider reject a stale keyed POST instead of ignoring it", async () => {
    let responderCalls = 0;
    const provider = await startProvider({
      durable: false,
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    const mutableCard = consumer.agentCard as typeof consumer.agentCard & {
      capabilities: NonNullable<typeof consumer.agentCard.capabilities>;
    };
    mutableCard.capabilities.extensions.push({
      uri: A2A_IDEMPOTENCY_EXTENSION_URI,
      description: "stale cached capability",
      required: false,
      params: {
        schemaVersion: 1,
        metadataKey: A2A_IDEMPOTENCY_METADATA_KEY,
      },
    });
    Object.defineProperty(consumer, "refreshConnection", { value: undefined });

    await expect(consumer.sendMessage({
      text: "stale capability must fail closed",
      idempotencyKey: "logical-stale-card-1",
    })).rejects.toMatchObject({ code: "idempotency_unsupported" });
    expect(responderCalls).toBe(0);
  });

  it("rejects a keyed REST request whose transport strips extension negotiation", async () => {
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    const consumer = await createA2AConsumer({
      agentUrl: provider.agentCardUrl,
      fetchImpl: async (request, init = {}) => {
        const headers = new Headers(init.headers);
        headers.delete("A2A-Extensions");
        return await fetch(request, { ...init, headers });
      },
    });

    await expect(consumer.sendMessage({
      text: "missing negotiated extension",
      idempotencyKey: "logical-missing-extension-1",
    })).rejects.toMatchObject({ code: "invalid_idempotency_key" });
    expect(responderCalls).toBe(0);
  });

  it("advertises the named extension, strips its envelope, and replays one completed REST task", async () => {
    let responderCalls = 0;
    let leakedEnvelope = false;
    const requestedExtensions: string[] = [];
    const activatedExtensions: string[] = [];
    const provider = await startProvider({
      responder: {
        async respond(request) {
          responderCalls += 1;
          leakedEnvelope ||= JSON.stringify(request.metadata).includes(A2A_IDEMPOTENCY_METADATA_KEY);
          return { text: `done: ${request.text}` };
        },
      },
    });

    expect(provider.agentCard.capabilities?.extensions).toContainEqual(expect.objectContaining({
      uri: A2A_IDEMPOTENCY_EXTENSION_URI,
      params: expect.objectContaining({ schemaVersion: 1 }),
    }));
    const consumer = await createA2AConsumer({
      agentUrl: provider.agentCardUrl,
      fetchImpl: async (request, init) => {
        const headers = new Headers(init?.headers);
        const isSend = (init?.method ?? (request instanceof Request ? request.method : "GET")) !== "GET";
        if (isSend) {
          requestedExtensions.push(headers.get("A2A-Extensions") ?? "");
        }
        const response = await fetch(request, init);
        if (isSend) {
          activatedExtensions.push(response.headers.get("A2A-Extensions") ?? "");
        }
        return response;
      },
    });
    const input = {
      text: "one job",
      idempotencyKey: "logical-rest-1",
    } as const;
    const first = await consumer.sendMessage(input);
    const replay = await consumer.sendMessage(input);

    expect(first.text).toBe("done: one job");
    expect(replay).toEqual(first);
    expect(responderCalls).toBe(1);
    expect(leakedEnvelope).toBe(false);
    expect(requestedExtensions).toEqual([
      A2A_IDEMPOTENCY_EXTENSION_URI,
      A2A_IDEMPOTENCY_EXTENSION_URI,
    ]);
    expect(activatedExtensions).toEqual(requestedExtensions);
    const recordPath = await onlyRecordPath(providerStateDir(provider));
    const persisted = await readFile(recordPath, "utf8");
    expect(persisted).not.toContain("logical-rest-1");
    expect((await stat(providerStateDir(provider))).mode & 0o777).toBe(0o700);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it("persists and replays rejected tasks containing every protocol-valid non-text Part variant", async () => {
    const stateDir = await temporaryStateDir();
    let responderCalls = 0;
    const responder: AgentResponder = {
      async respond() {
        responderCalls += 1;
        return { text: "must not run for unsupported input" };
      },
    };
    const variants: ReadonlyArray<{
      readonly key: string;
      readonly part: () => Part;
    }> = [
      {
        key: "data",
        part: () => ({
          content: { $case: "data", value: { nested: [true, 1, "value", null] } },
          filename: "payload.json",
          mediaType: "application/json",
          metadata: {},
        }),
      },
      {
        key: "data-undefined",
        part: () => ({
          content: { $case: "data", value: undefined },
          filename: "empty.json",
          mediaType: "application/json",
          metadata: {},
        }),
      },
      {
        key: "url",
        part: () => ({
          content: { $case: "url", value: "https://example.test/file.txt" },
          filename: "file.txt",
          mediaType: "text/plain",
          metadata: {},
        }),
      },
      {
        key: "raw",
        part: () => ({
          content: { $case: "raw", value: Buffer.from([0, 1, 2, 253, 254, 255]) },
          filename: "bytes.bin",
          mediaType: "application/octet-stream",
          metadata: {},
        }),
      },
      {
        key: "absent",
        part: () => ({
          content: undefined,
          filename: "",
          mediaType: "application/octet-stream",
          metadata: {},
        }),
      },
    ];
    const sendVariants = async (agentUrl: string) => {
      const consumer = await createA2AConsumer({ agentUrl });
      for (const variant of variants) {
        await expect(consumer.sendMessage({
          idempotencyKey: `logical-valid-part-${variant.key}`,
          message: {
            messageId: `message-${variant.key}`,
            contextId: "",
            taskId: "",
            role: Role.ROLE_USER,
            parts: [variant.part()],
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
        })).rejects.toMatchObject({ code: "remote_rejected" });
      }
    };

    const original = await startProvider({ stateDir, responder });
    await sendVariants(original.agentCardUrl);
    await original.stop();

    const restarted = await startProvider({ stateDir, responder });
    await sendVariants(restarted.agentCardUrl);
    expect(responderCalls).toBe(0);
  });

  it("preserves raw Part Buffer identity and bytes through immediate and restart replay clones", async () => {
    const stateDir = await temporaryStateDir();
    const rawBytes = Buffer.from([0, 1, 2, 127, 128, 253, 254, 255]);
    const response: Message = {
      messageId: "raw-response-message",
      contextId: "raw-response-context",
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [{
        content: { $case: "raw", value: rawBytes },
        filename: "response.bin",
        mediaType: "application/octet-stream",
        metadata: {},
      }],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    };
    const request: SendMessageRequest = {
      tenant: "",
      message: {
        messageId: "raw-request-message",
        contextId: "raw-response-context",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: "text", value: "return raw bytes" },
          filename: "",
          mediaType: "text/plain",
          metadata: {},
        }],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: ["application/octet-stream"],
        taskPushNotificationConfig: undefined,
        historyLength: 10,
        returnImmediately: false,
      },
      metadata: {
        [A2A_IDEMPOTENCY_METADATA_KEY]: {
          schemaVersion: 1,
          key: "logical-raw-clone-1",
        },
      },
    };
    const options = {
      stateDir,
      namespace: "test-raw-clone-provider",
      retentionMs: 60_000,
      maxRecords: 10,
    } as const;
    const context = () => new ServerCallContext({
      requestedExtensions: [A2A_IDEMPOTENCY_EXTENSION_URI],
    });
    const firstHandler = await createIdempotentA2ARequestHandler({
      delegate: {
        async sendMessage() {
          return response;
        },
      } as unknown as A2ARequestHandler,
      taskStore: new InMemoryTaskStore(),
      options,
    });
    const first = await firstHandler.sendMessage(request, context());
    assertRawPartBuffer(first, rawBytes);

    const restartedHandler = await createIdempotentA2ARequestHandler({
      delegate: {
        async sendMessage() {
          throw new Error("restart replay must not invoke the delegate");
        },
      } as unknown as A2ARequestHandler,
      taskStore: new InMemoryTaskStore(),
      options,
    });
    const replay = await restartedHandler.sendMessage(request, context());
    assertRawPartBuffer(replay, rawBytes);
  });

  it("fails closed if the durable directory pathname is replaced while the provider is running", async () => {
    const stateDir = await temporaryStateDir();
    let responderCalls = 0;
    const provider = await startProvider({
      stateDir,
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: `execution-${responderCalls}` };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    const input = { text: "same logical dispatch", idempotencyKey: "logical-directory-swap-1" } as const;
    await consumer.sendMessage(input);

    await rename(stateDir, `${stateDir}.moved`);
    await mkdir(`${stateDir}/slots`, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await chmod(`${stateDir}/slots`, 0o700);

    await expect(consumer.sendMessage(input)).rejects.toMatchObject({ code: "send_failed" });
    expect(responderCalls).toBe(1);
  });

  it("creates each missing directory component as an owner-only durable directory", async () => {
    const stateDir = `${await temporaryStateDir()}/nested/provider/state`;
    const provider = await startProvider({
      stateDir,
      responder: { async respond() { return { text: "ready" }; } },
    });
    const components = [
      stateDir.replace(/\/nested\/provider\/state$/u, ""),
      stateDir.replace(/\/provider\/state$/u, ""),
      stateDir.replace(/\/state$/u, ""),
      stateDir,
      `${stateDir}/slots`,
    ];
    for (const component of components) {
      expect((await stat(component)).mode & 0o777).toBe(0o700);
    }
    await provider.stop();
  });

  it("projects concurrent immediate and blocking callers independently onto one task", async () => {
    const gate = deferred<void>();
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          await gate.promise;
          return { text: "terminal result" };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });

    const immediate = await consumer.sendMessage({
      text: "mixed projection",
      idempotencyKey: "logical-mixed-1",
      returnImmediately: true,
      historyLength: 0,
    });
    const blockingPromise = consumer.sendMessage({
      text: "mixed projection",
      idempotencyKey: "logical-mixed-1",
      returnImmediately: false,
      historyLength: 1,
    });
    expect(immediate.metadata.a2a.state).toBe("TASK_STATE_SUBMITTED");
    expect(responderCalls).toBe(1);

    gate.resolve();
    const blocking = await blockingPromise;
    const sequentialImmediate = await consumer.sendMessage({
      text: "mixed projection",
      idempotencyKey: "logical-mixed-1",
      returnImmediately: true,
      historyLength: 100,
      // Per-caller response projection is not workload identity.
      metadata: {},
    });
    expect(blocking.text).toBe("terminal result");
    expect(blocking.metadata.a2a.taskId).toBe(immediate.metadata.a2a.taskId);
    expect(sequentialImmediate.metadata.a2a.taskId).toBe(immediate.metadata.a2a.taskId);
    expect(responderCalls).toBe(1);
  });

  it("serializes one admission across concurrent provider instances sharing a durable namespace", async () => {
    const stateDir = await temporaryStateDir();
    const gate = deferred<void>();
    let responderCalls = 0;
    const responder: AgentResponder = {
      async respond() {
        responderCalls += 1;
        await gate.promise;
        return { text: "one cross-provider execution" };
      },
    };
    const [left, right] = await Promise.all([
      startProvider({ stateDir, responder }),
      startProvider({ stateDir, responder }),
    ]);
    const input = {
      text: "cross-provider race",
      idempotencyKey: "logical-cross-provider-1",
      returnImmediately: true,
    } as const;

    try {
      const settled = await Promise.allSettled([
        sendA2AMessage({ ...input, agentUrl: left.agentCardUrl }),
        sendA2AMessage({ ...input, agentUrl: right.agentCardUrl }),
      ]);
      const fulfilled = settled.filter((result) => result.status === "fulfilled");
      const rejected = settled.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]).toMatchObject({
        value: { metadata: { a2a: { state: "TASK_STATE_SUBMITTED" } } },
      });
      expect(rejected[0]).toMatchObject({
        reason: { code: "idempotency_in_doubt" },
      });
      expect(responderCalls).toBe(1);
      expect((await readdir(`${stateDir}/slots`)).filter((name) => /^slot-/u.test(name))).toHaveLength(1);
    } finally {
      gate.resolve();
    }
  });

  it("publishes a complete admission before a concurrent provider can observe it", async () => {
    const stateDir = await temporaryStateDir();
    const beforePublication = deferred<void>();
    const releasePublication = deferred<void>();
    const afterConcurrentPublication = deferred<void>();
    const releaseConcurrentCleanup = deferred<void>();
    const delegateEntered = deferred<void>();
    let delegateCalls = 0;
    const terminal = testTerminalMessage("publication-race-response", "one durable execution");
    const delegate = {
      async sendMessage() {
        delegateCalls += 1;
        delegateEntered.resolve();
        return terminal;
      },
    } as unknown as A2ARequestHandler;
    const options = testIdempotencyOptions(stateDir);
    const [pausedPublisher, concurrentPublisher] = await Promise.all([
      createIdempotentA2ARequestHandler({
        delegate,
        taskStore: new InMemoryTaskStore(),
        options,
        storeHooks: {
          async beforeAdmissionPublish() {
            beforePublication.resolve();
            await releasePublication.promise;
          },
        },
      }),
      createIdempotentA2ARequestHandler({
        delegate,
        taskStore: new InMemoryTaskStore(),
        options,
        storeHooks: {
          async afterAdmissionPublish() {
            afterConcurrentPublication.resolve();
            await releaseConcurrentCleanup.promise;
          },
        },
      }),
    ]);
    const key = "logical-atomic-publication-1";
    const keyHash = testStoreKeyHash(key);
    const request = testDirectRequest(key, "publish this admission atomically");
    const pausedOutcome = captureOutcome(pausedPublisher.sendMessage(request, testServerCallContext()));
    let concurrentOutcome: Promise<CapturedOutcome<Message | Task>> | undefined;

    try {
      await expectMilestoneBeforeSettlement(
        beforePublication.promise,
        pausedOutcome,
        "pre-publication staging",
      );
      await expect(readFile(join(stateDir, `${keyHash}.json`), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      const stagedNames = (await readdir(stateDir)).filter((name) => (
        name.startsWith(`.${keyHash}.`) && name.endsWith(".tmp")
      ));
      expect(stagedNames).toHaveLength(1);
      expect(JSON.parse(await readFile(join(stateDir, stagedNames[0] as string), "utf8")))
        .toMatchObject({ keyHash, status: "active" });

      concurrentOutcome = captureOutcome(concurrentPublisher.sendMessage(request, testServerCallContext()));
      await expectMilestoneBeforeSettlement(
        afterConcurrentPublication.promise,
        concurrentOutcome,
        "concurrent publication",
      );
      expect((await stat(join(stateDir, `${keyHash}.json`))).nlink).toBe(2);
      releasePublication.resolve();

      const outcome = await pausedOutcome;
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected" || !(outcome.reason instanceof Error)) {
        throw new Error("Expected the losing admission to fail with an Error.");
      }
      expect(classifyA2AIdempotencyTransportError(outcome.reason.message)).toBe("in_doubt");
      expect(delegateCalls).toBe(0);

      releaseConcurrentCleanup.resolve();
      await expectMilestoneBeforeSettlement(
        delegateEntered.promise,
        concurrentOutcome,
        "delegate entry",
      );
      const concurrentResult = await concurrentOutcome;
      expect(concurrentResult.status).toBe("fulfilled");
      if (concurrentResult.status !== "fulfilled") {
        throw concurrentResult.reason;
      }
      expect(concurrentResult.value).toEqual(terminal);
      expect(delegateCalls).toBe(1);
      expect((await stat(join(stateDir, `${keyHash}.json`))).nlink).toBe(1);
      expect((await readdir(stateDir)).filter((name) => name.startsWith(`.${keyHash}.`))).toHaveLength(0);
    } finally {
      releasePublication.resolve();
      releaseConcurrentCleanup.resolve();
      await Promise.allSettled([
        pausedOutcome,
        ...(concurrentOutcome === undefined ? [] : [concurrentOutcome]),
      ]);
    }
  });

  it.each(["HTTP+JSON", "JSONRPC"] as const)(
    "returns a typed integrity conflict over %s without a second responder call",
    async (transport) => {
      let responderCalls = 0;
      const provider = await startProvider({
        responder: {
          async respond(request) {
            responderCalls += 1;
            return { text: request.text };
          },
        },
      });
      const consumer = await createA2AConsumer({
        agentUrl: provider.agentCardUrl,
        preferredTransports: [transport],
      });
      const key = `logical-conflict-${transport.replace(/[^A-Za-z0-9]/gu, "-")}`;
      await consumer.sendMessage({ text: "original", idempotencyKey: key });
      await expect(consumer.sendMessage({
        text: "changed",
        idempotencyKey: key,
      })).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(responderCalls).toBe(1);
    },
  );

  it("replays a completed task after provider restart without invoking the new responder", async () => {
    const stateDir = await temporaryStateDir();
    let firstCalls = 0;
    const firstProvider = await startProvider({
      stateDir,
      responder: {
        async respond() {
          firstCalls += 1;
          return { text: "persisted terminal" };
        },
      },
    });
    const request = {
      agentUrl: firstProvider.agentCardUrl,
      text: "restart-safe",
      idempotencyKey: "logical-restart-complete-1",
    } as const;
    const first = await sendA2AMessage(request);
    await firstProvider.stop();

    let secondCalls = 0;
    const secondProvider = await startProvider({
      stateDir,
      responder: {
        async respond() {
          secondCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    const replay = await sendA2AMessage({ ...request, agentUrl: secondProvider.agentCardUrl });
    expect(replay.text).toBe(first.text);
    expect(replay.metadata.a2a.taskId).toBe(first.metadata.a2a.taskId);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  });

  it("fails closed with idempotency_in_doubt for an active admission after restart", async () => {
    const stateDir = await temporaryStateDir();
    const gate = deferred<void>();
    const firstProvider = await startProvider({
      stateDir,
      responder: {
        async respond() {
          await gate.promise;
          return { text: "late" };
        },
      },
    });
    const input = {
      text: "ambiguous work",
      idempotencyKey: "logical-restart-active-1",
      returnImmediately: true,
    } as const;
    await sendA2AMessage({ ...input, agentUrl: firstProvider.agentCardUrl });
    await firstProvider.stop();

    let restartedCalls = 0;
    const restarted = await startProvider({
      stateDir,
      responder: {
        async respond() {
          restartedCalls += 1;
          return { text: "must not run" };
        },
      },
    });
    await expect(sendA2AMessage({ ...input, agentUrl: restarted.agentCardUrl }))
      .rejects.toMatchObject({ code: "idempotency_in_doubt" });
    expect(restartedCalls).toBe(0);
    gate.resolve();
  });

  it("fails closed at hard capacity without evicting an existing binding", async () => {
    let responderCalls = 0;
    const provider = await startProvider({
      maxRecords: 1,
      responder: {
        async respond(request) {
          responderCalls += 1;
          return { text: request.text };
        },
      },
    });
    const consumer = await createA2AConsumer({ agentUrl: provider.agentCardUrl });
    await consumer.sendMessage({ text: "first", idempotencyKey: "capacity-first" });
    await expect(consumer.sendMessage({ text: "second", idempotencyKey: "capacity-second" }))
      .rejects.toMatchObject({ code: "idempotency_capacity_exhausted" });
    await expect(consumer.sendMessage({ text: "changed", idempotencyKey: "capacity-first" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(responderCalls).toBe(1);
  });

  it("reuses a crash-remnant reservation for the same logical key without consuming another slot", async () => {
    const stateDir = await temporaryStateDir();
    const initialized = await startProvider({
      stateDir,
      maxRecords: 2,
      responder: { async respond(request) { return { text: request.text }; } },
    });
    await initialized.stop();

    const idempotencyKey = "logical-resume-slot-1";
    const keyHash = testStoreKeyHash(idempotencyKey);
    const slot = Number(BigInt(`0x${keyHash.slice(0, 13)}`) % 2n);
    const slotPath = `${stateDir}/slots/slot-${slot}.json`;
    await writeFile(slotPath, `${JSON.stringify({
      schemaVersion: 1,
      slot,
      keyHash,
      createdAtMs: Date.now() - 10 * 60_000,
    })}\n`, { mode: 0o600 });
    await chmod(slotPath, 0o600);

    const restarted = await startProvider({
      stateDir,
      maxRecords: 2,
      responder: { async respond(request) { return { text: request.text }; } },
    });
    const consumer = await createA2AConsumer({ agentUrl: restarted.agentCardUrl });
    await expect(consumer.sendMessage({ text: "resumed", idempotencyKey })).resolves.toMatchObject({ text: "resumed" });
    await expect(consumer.sendMessage({
      text: "another key",
      idempotencyKey: "logical-resume-slot-2",
    })).resolves.toMatchObject({ text: "another key" });
    expect((await readdir(`${stateDir}/slots`)).filter((name) => /^slot-/u.test(name))).toHaveLength(2);
  });

  it("fails closed on legacy duplicate same-key reservations without deleting either slot", async () => {
    const stateDir = await temporaryStateDir();
    const initialized = await startProvider({
      stateDir,
      maxRecords: 2,
      responder: { async respond(request) { return { text: request.text }; } },
    });
    await initialized.stop();

    const keyHash = testStoreKeyHash("logical-duplicate-slot-1");
    for (const slot of [0, 1]) {
      const slotPath = `${stateDir}/slots/slot-${slot}.json`;
      await writeFile(slotPath, `${JSON.stringify({
        schemaVersion: 1,
        slot,
        keyHash,
        createdAtMs: Date.now() - 10 * 60_000,
      })}\n`, { mode: 0o600 });
      await chmod(slotPath, 0o600);
    }

    await expect(startProvider({
      stateDir,
      maxRecords: 2,
      responder: { async respond() { return { text: "must not run" }; } },
    })).rejects.toMatchObject({ code: "idempotency_store_error" });
    expect((await readdir(`${stateDir}/slots`)).filter((name) => /^slot-/u.test(name))).toHaveLength(2);
  });

  it("rejects an out-of-range persisted capacity slot during startup reconciliation", async () => {
    const stateDir = await temporaryStateDir();
    const initialized = await startProvider({
      stateDir,
      maxRecords: 2,
      responder: { async respond(request) { return { text: request.text }; } },
    });
    await initialized.stop();
    const slotPath = `${stateDir}/slots/slot-2.json`;
    await writeFile(slotPath, `${JSON.stringify({
      schemaVersion: 1,
      slot: 2,
      keyHash: testStoreKeyHash("logical-out-of-range-slot-1"),
      createdAtMs: Date.now(),
    })}\n`, { mode: 0o600 });
    await chmod(slotPath, 0o600);

    await expect(startProvider({
      stateDir,
      maxRecords: 2,
      responder: { async respond() { return { text: "must not run" }; } },
    })).rejects.toMatchObject({ code: "idempotency_store_error" });
  });

  it("forwards a caller-supplied responder key resolver without inventing an identity", async () => {
    let responderCalls = 0;
    const provider = await startProvider({
      responder: {
        async respond() {
          responderCalls += 1;
          return { text: "remote result" };
        },
      },
    });
    const responder = createA2AConsumerResponder({
      agentUrl: provider.agentCardUrl,
      idempotencyKeyForRequest(request) {
        return typeof request.metadata?.logicalDispatchId === "string"
          ? request.metadata.logicalDispatchId
          : undefined;
      },
    });
    const localRequest: AgentRequestBase = {
      conversationId: "local-conversation",
      text: "delegated once",
      abortSignal: new AbortController().signal,
      metadata: { logicalDispatchId: "responder-logical-1" },
    };
    const stream = { async append() {} };
    const first = await responder.respond(localRequest, stream);
    const replay = await responder.respond(localRequest, stream);
    expect(first.text).toBe("remote result");
    expect(replay.text).toBe("remote result");
    expect(responderCalls).toBe(1);
  });

  it("refuses malformed persisted protocol output instead of returning it", async () => {
    const stateDir = await temporaryStateDir();
    const provider = await startProvider({
      stateDir,
      responder: { async respond() { return { text: "valid first" }; } },
    });
    await sendA2AMessage({
      agentUrl: provider.agentCardUrl,
      text: "corrupt later",
      idempotencyKey: "logical-corruption-1",
    });
    await provider.stop();

    const recordPath = await onlyRecordPath(stateDir);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const result = record.result as Record<string, unknown>;
    result.history = "not-an-array";
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    await chmod(recordPath, 0o600);

    await expect(startProvider({
      stateDir,
      responder: { async respond() { return { text: "must not run" }; } },
    })).rejects.toMatchObject({ code: "idempotency_store_error" });
  });

  it("refuses a persisted completed record whose task is still non-terminal", async () => {
    const stateDir = await temporaryStateDir();
    const provider = await startProvider({
      stateDir,
      responder: { async respond() { return { text: "valid terminal" }; } },
    });
    await sendA2AMessage({
      agentUrl: provider.agentCardUrl,
      text: "corrupt terminal state later",
      idempotencyKey: "logical-nonterminal-corruption-1",
    });
    await provider.stop();

    const recordPath = await onlyRecordPath(stateDir);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const result = record.result as Record<string, unknown>;
    const status = result.status as Record<string, unknown>;
    status.state = TaskState.TASK_STATE_WORKING;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    await chmod(recordPath, 0o600);

    await expect(startProvider({
      stateDir,
      responder: { async respond() { return { text: "must not run" }; } },
    })).rejects.toMatchObject({ code: "idempotency_store_error" });
  });

  it("securely reopens a canonical record replaced after open by expiry compaction", async () => {
    const stateDir = await temporaryStateDir();
    const key = "logical-reopen-after-compaction-1";
    const keyHash = testStoreKeyHash(key);
    const options = testIdempotencyOptions(stateDir);
    const request = testDirectRequest(key, "reopen the compacted receipt");
    const terminal = testTerminalMessage("reopen-compaction-response", "seed result");
    const seed = await createIdempotentA2ARequestHandler({
      delegate: {
        async sendMessage() {
          return terminal;
        },
      } as unknown as A2ARequestHandler,
      taskStore: new InMemoryTaskStore(),
      options,
    });
    await seed.sendMessage(request, testServerCallContext());
    const recordPath = await onlyRecordPath(stateDir);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    record.updatedAtMs = Date.now() - 61_000;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    await chmod(recordPath, 0o600);

    const oldRecordOpened = deferred<void>();
    const releaseOldReader = deferred<void>();
    const pausedReadAttempts: number[] = [];
    let paused = false;
    let recordStartupAttempts = true;
    let successorCalls = 0;
    const successor = {
      async sendMessage() {
        successorCalls += 1;
        return testTerminalMessage("unexpected-successor", "must not run");
      },
    } as unknown as A2ARequestHandler;
    const pausedCreation = captureOutcome(createIdempotentA2ARequestHandler({
      delegate: successor,
      taskStore: new InMemoryTaskStore(),
      options,
      storeHooks: {
        async afterRecordOpen(input) {
          if (recordStartupAttempts && input.keyHash === keyHash) {
            pausedReadAttempts.push(input.attempt);
          }
          if (!paused && input.keyHash === keyHash) {
            paused = true;
            oldRecordOpened.resolve();
            await releaseOldReader.promise;
          }
        },
      },
    }));

    try {
      await expectMilestoneBeforeSettlement(
        oldRecordOpened.promise,
        pausedCreation,
        "old canonical record open",
      );
      const openedIdentity = await stat(recordPath);
      const sibling = await createIdempotentA2ARequestHandler({
        delegate: successor,
        taskStore: new InMemoryTaskStore(),
        options,
      });
      const compactedIdentity = await stat(recordPath);
      expect(compactedIdentity.ino).not.toBe(openedIdentity.ino);
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
        keyHash,
        status: "tombstone",
      });

      releaseOldReader.resolve();
      const pausedResult = await pausedCreation;
      expect(pausedResult.status).toBe("fulfilled");
      if (pausedResult.status !== "fulfilled") {
        throw pausedResult.reason;
      }
      recordStartupAttempts = false;
      expect(pausedReadAttempts.slice(0, 2)).toEqual([1, 2]);
      expect((await stat(recordPath)).ino).toBe(compactedIdentity.ino);
      const expiredOutcomes = await Promise.all([
        captureOutcome(pausedResult.value.sendMessage(request, testServerCallContext())),
        captureOutcome(sibling.sendMessage(request, testServerCallContext())),
      ]);
      for (const outcome of expiredOutcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected" || !(outcome.reason instanceof Error)) {
          throw new Error("Expected a typed expired-result failure.");
        }
        expect(classifyA2AIdempotencyTransportError(outcome.reason.message)).toBe("result_expired");
      }
      expect(successorCalls).toBe(0);
    } finally {
      releaseOldReader.resolve();
      await pausedCreation;
    }
  });

  it("fails closed after bounded canonical record replacement churn", async () => {
    const stateDir = await temporaryStateDir();
    const key = "logical-bounded-record-churn-1";
    const keyHash = testStoreKeyHash(key);
    const options = testIdempotencyOptions(stateDir);
    const request = testDirectRequest(key, "never accept an unstable receipt");
    const seed = await createIdempotentA2ARequestHandler({
      delegate: {
        async sendMessage() {
          return testTerminalMessage("bounded-churn-seed", "stable seed");
        },
      } as unknown as A2ARequestHandler,
      taskStore: new InMemoryTaskStore(),
      options,
    });
    await seed.sendMessage(request, testServerCallContext());
    const recordPath = await onlyRecordPath(stateDir);
    let replacements = 0;
    let exceededReplacementBound = false;
    let successorCalls = 0;

    await expect(createIdempotentA2ARequestHandler({
      delegate: {
        async sendMessage() {
          successorCalls += 1;
          return testTerminalMessage("unexpected-churn-successor", "must not run");
        },
      } as unknown as A2ARequestHandler,
      taskStore: new InMemoryTaskStore(),
      options,
      storeHooks: {
        async afterRecordOpen(input) {
          if (input.attempt > 20) {
            exceededReplacementBound = true;
            throw new Error("Canonical record retry bound was exceeded.");
          }
          replacements += 1;
          const temporary = join(
            stateDir,
            `.${input.keyHash}.${input.attempt.toString(16).padStart(2, "0")}.tmp`,
          );
          await writeFile(temporary, await readFile(recordPath), { mode: 0o600 });
          await chmod(temporary, 0o600);
          await rename(temporary, recordPath);
        },
      },
    })).rejects.toMatchObject({ code: "idempotency_store_error" });

    expect(replacements).toBe(20);
    expect(exceededReplacementBound).toBe(false);
    expect(successorCalls).toBe(0);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
      keyHash,
      status: "completed",
    });
    expect((await readdir(stateDir)).filter((name) => name.startsWith(`.${keyHash}.`))).toHaveLength(0);
  });

  it("concurrently compacts an expired result to a permanent tombstone without admitting a successor", async () => {
    const stateDir = await temporaryStateDir();
    const original = await startProvider({
      stateDir,
      responder: { async respond() { return { text: "short-lived result" }; } },
    });
    const request = {
      text: "never reuse this key",
      idempotencyKey: "logical-expired-1",
    } as const;
    await sendA2AMessage({ ...request, agentUrl: original.agentCardUrl });
    await original.stop();
    const recordPath = await onlyRecordPath(stateDir);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    record.updatedAtMs = Date.now() - 61_000;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`);
    await chmod(recordPath, 0o600);

    let successorCalls = 0;
    const responder: AgentResponder = {
      async respond() {
        successorCalls += 1;
        return { text: "must not run" };
      },
    };
    const [left, right] = await Promise.all([
      startProvider({ stateDir, responder }),
      startProvider({ stateDir, responder }),
    ]);
    await Promise.all([
      expect(sendA2AMessage({ ...request, agentUrl: left.agentCardUrl }))
        .rejects.toMatchObject({ code: "idempotency_result_expired" }),
      expect(sendA2AMessage({ ...request, agentUrl: right.agentCardUrl }))
        .rejects.toMatchObject({ code: "idempotency_result_expired" }),
    ]);
    expect(successorCalls).toBe(0);
    const tombstone = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    expect(tombstone.status).toBe("tombstone");
    expect(tombstone).not.toHaveProperty("result");
  });
});

async function startProvider(input: {
  readonly responder: AgentResponder;
  readonly durable?: boolean;
  readonly stateDir?: string;
  readonly maxRecords?: number;
}): Promise<A2AProviderStartResult> {
  const stateDir = input.stateDir ?? await temporaryStateDir();
  const provider = await startA2AProvider({
    host: "127.0.0.1",
    port: 0,
    responder: input.responder,
    ...(input.durable === false
      ? {}
      : {
          idempotency: {
            stateDir,
            namespace: "test-logical-provider",
            retentionMs: 60_000,
            maxRecords: input.maxRecords ?? 100,
          },
        }),
    agent: {
      name: "Idempotency test agent",
      description: "Exercises logical dispatch receipts.",
      version: "test",
    },
    skill: {
      id: "idempotency-test",
      name: "Idempotency test",
      description: "Exercises logical dispatch receipts.",
      tags: ["test"],
    },
  });
  cleanups.push(() => provider.stop().catch(() => undefined));
  Object.defineProperty(provider, "__testStateDir", { value: stateDir });
  return provider;
}

function providerStateDir(provider: A2AProviderStartResult): string {
  return (provider as A2AProviderStartResult & { readonly __testStateDir: string }).__testStateDir;
}

async function temporaryStateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-a2a-idempotency-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

async function onlyRecordPath(stateDir: string): Promise<string> {
  const records = (await readdir(stateDir)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  expect(records).toHaveLength(1);
  return join(stateDir, records[0] as string);
}

function testStoreKeyHash(key: string): string {
  const providerScope = createHash("sha256").update("test-logical-provider").digest("hex");
  return createHash("sha256")
    .update(JSON.stringify({ key, providerScope }))
    .digest("hex");
}

function testIdempotencyOptions(stateDir: string) {
  return {
    stateDir,
    namespace: "test-logical-provider",
    retentionMs: 60_000,
    maxRecords: 100,
  } as const;
}

function testDirectRequest(key: string, text: string): SendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId: `request-${key}`,
      contextId: `context-${key}`,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: "text", value: text },
        filename: "",
        mediaType: "text/plain",
        metadata: {},
      }],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: 1,
      returnImmediately: false,
    },
    metadata: {
      [A2A_IDEMPOTENCY_METADATA_KEY]: { schemaVersion: 1, key },
    },
  };
}

function testTerminalMessage(messageId: string, text: string): Message {
  return {
    messageId,
    contextId: `context-${messageId}`,
    taskId: "",
    role: Role.ROLE_AGENT,
    parts: [{
      content: { $case: "text", value: text },
      filename: "",
      mediaType: "text/plain",
      metadata: {},
    }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function testServerCallContext(): ServerCallContext {
  return new ServerCallContext({
    requestedExtensions: [A2A_IDEMPOTENCY_EXTENSION_URI],
  });
}

function assertRawPartBuffer(result: Message | Task, expected: Buffer): void {
  if (!("parts" in result)) {
    throw new Error("Expected a replayed Message result.");
  }
  const content = result.parts[0]?.content;
  if (content?.$case !== "raw") {
    throw new Error("Expected a raw Part result.");
  }
  expect(Buffer.isBuffer(content.value)).toBe(true);
  expect(content.value.equals(expected)).toBe(true);
}

type CapturedOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

function captureOutcome<T>(promise: Promise<T>): Promise<CapturedOutcome<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value } as const),
    (reason: unknown) => ({ status: "rejected", reason } as const),
  );
}

async function expectMilestoneBeforeSettlement<T>(
  milestone: Promise<void>,
  outcome: Promise<CapturedOutcome<T>>,
  label: string,
): Promise<void> {
  const first = await Promise.race([
    milestone.then(() => ({ kind: "milestone" } as const)),
    outcome.then((settled) => ({ kind: "settled", settled } as const)),
  ]);
  if (first.kind === "settled") {
    const detail = first.settled.status === "rejected" && first.settled.reason instanceof Error
      ? `: ${first.settled.reason.message}`
      : "";
    throw new Error(`${label} was not reached before the handler settled${detail}`);
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
