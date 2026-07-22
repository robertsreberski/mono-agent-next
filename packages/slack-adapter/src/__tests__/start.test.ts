import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { startSlackAdapter, type SlackAdapterStartOptions } from "../start.js";
import type {
  AgentRequest,
  AgentResponder,
} from "../adapter.js";
import type {
  SlackChatPostMessageParams,
  SlackChatUpdateParams,
  SlackReactionsAddParams,
  SlackAuthTestResult,
  SlackEventCallback,
  SlackSocketModeEnvelope,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  authTestCalls = 0;
  authTestFailure: unknown = undefined;
  readonly opened: string[] = [];
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];
  readonly reactionsAddCalls: SlackReactionsAddParams[] = [];

  constructor(private readonly authTestResult: SlackAuthTestResult = { ok: true }) {}

  async authTest() {
    this.authTestCalls += 1;
    if (this.authTestFailure !== undefined) throw this.authTestFailure;
    return this.authTestResult;
  }

  async appsConnectionsOpen() {
    const url = "wss://slack.test/socket";
    this.opened.push(url);
    return { ok: true as const, url };
  }

  async chatPostMessage(params: SlackChatPostMessageParams) {
    this.postMessageCalls.push(params);
    return { ok: true as const, channel: params.channel, ts: "200.000001" };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    this.updateCalls.push(params);
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }

  async reactionsAdd(params: SlackReactionsAddParams): Promise<void> {
    this.reactionsAddCalls.push(params);
  }

  async downloadFile() {
    return new Uint8Array();
  }
}

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function responderFrom(
  fn: (request: AgentRequest) => Promise<{ text: string }>,
): AgentResponder {
  return { respond: async (request) => fn(request) };
}

describe("startSlackAdapter", () => {
  it("wires the client, adapter, and runner with a single call using an injected transport", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const createApi = vi.fn(() => api);
    const seen: AgentRequest[] = [];

    const started = await startSlackAdapter(buildOptions({
      createApi,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async (request) => {
        seen.push(request);
        return { text: `echo: ${request.text}` };
      }),
    }));

    try {
      // The factory was used instead of a real Slack client.
      expect(createApi).toHaveBeenCalledTimes(1);
      expect(started.api).toBe(api);

      // The runner opened a Socket Mode connection through the fake transport.
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      expect(api.opened).toEqual(["wss://slack.test/socket"]);
      const socket = sockets[0];
      if (socket === undefined) {
        throw new Error("expected a socket");
      }
      socket.emitOpen();

      // A fake inbound DM is routed to the responder.
      socket.emitMessage(socketEnvelope("E1", directMessage("hello there")));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.text).toBe("hello there");
      expect(seen[0]?.channelId).toBe("D1");

      // The envelope was acknowledged and, with final-only delivery, the final
      // responder text was posted as a single chat.postMessage (no chat.update).
      expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ envelope_id: "E1" });
      await vi.waitFor(() =>
        expect(api.postMessageCalls.some((call) => call.text === "echo: hello there")).toBe(true),
      );
      expect(api.updateCalls).toEqual([]);
    } finally {
      await started.stop();
    }

    // stop() tore the connection down: the socket is closed, no open handles.
    expect(sockets[0]?.closed).toBe(true);
  });

  it("discovers the bot identity and recognizes mention-prefixed runtime commands", async () => {
    const api = new FakeSlackApi({ ok: true, user: "mickey", user_id: "U_MICKEY" });
    const sockets: FakeWebSocket[] = [];
    const seen: AgentRequest[] = [];
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      stripMentionText: false,
      runtimeControls: {
        defaultModel: "pi:openai:gpt-default",
        models: [{ value: "pi:openai:gpt-default", label: "Default GPT", efforts: [] }],
      },
      responder: responderFrom(async (request) => {
        seen.push(request);
        return { text: "ok" };
      }),
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (socket === undefined) throw new Error("expected a socket");
      socket.emitOpen();

      socket.emitMessage(socketEnvelope("E-model", directMessage("<@U_MICKEY> /model")));
      await vi.waitFor(() => expect(api.postMessageCalls).toHaveLength(1));
      expect(api.authTestCalls).toBe(1);
      expect(api.postMessageCalls[0]?.text).toBe(
        "Current model: Default GPT. Choose a configured model:",
      );
      expect(seen).toEqual([]);

      socket.emitMessage(socketEnvelope("E-prompt", directMessage("<@U_MICKEY> keep this mention")));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.text).toBe("<@U_MICKEY> keep this mention");
    } finally {
      await started.stop();
    }
  });

  it("derives bot-namespaced slash commands and applies them channel-wide", async () => {
    const api = new FakeSlackApi({ ok: true, user: "mickey", user_id: "U_MICKEY" });
    const sockets: FakeWebSocket[] = [];
    const seen: AgentRequest[] = [];
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      runtimeControls: {
        defaultModel: "pi:openai-codex:gpt-default",
        defaultEffort: "medium",
        models: [
          {
            value: "pi:openai-codex:gpt-default",
            label: "pi:openai-codex:gpt-default",
            efforts: [{ value: "medium", label: "Medium" }],
          },
          {
            value: "pi:anthropic:claude-fallback",
            label: "pi:anthropic:claude-fallback",
            efforts: [{ value: "high", label: "High" }],
          },
        ],
      },
      responder: responderFrom(async (request) => {
        seen.push(request);
        return { text: "ok" };
      }),
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (socket === undefined) throw new Error("expected a socket");
      socket.emitOpen();

      socket.emitMessage({
        envelope_id: "SC-model",
        type: "slash_commands",
        payload: {
          command: "/mickey-model",
          text: "",
          channel_id: "C1",
          user_id: "U1",
        },
      });
      await vi.waitFor(() => expect(api.postMessageCalls).toHaveLength(1));
      expect(api.postMessageCalls[0]).toMatchObject({
        channel: "C1",
        text: "Current model: gpt-default. Choose a configured model:",
      });
      expect(api.postMessageCalls[0]?.thread_ts).toBeUndefined();
      const blocks = api.postMessageCalls[0]?.blocks as readonly {
        readonly elements?: readonly {
          readonly action_id?: string;
          readonly options?: readonly {
            readonly text: { readonly text: string; readonly emoji: boolean };
            readonly description?: { readonly text: string; readonly emoji: boolean };
            readonly value: string;
          }[];
        }[];
      }[];
      const fallback = blocks
        .flatMap((block) => block.elements ?? [])
        .find((element) => element.action_id === "mono_agent_runtime_model")
        ?.options?.find((option) => option.text.text === "claude-fallback");
      if (fallback === undefined) throw new Error("expected fallback option");
      expect(fallback.text.emoji).toBe(false);
      expect(fallback.description).toEqual({
        type: "plain_text",
        text: "pi:anthropic:claude-fallback",
        emoji: false,
      });

      socket.emitMessage({
        envelope_id: "I-model",
        type: "interactive",
        payload: {
          type: "block_actions",
          channel: { id: "C1" },
          message: { ts: "200.000001" },
          actions: [{
            action_id: "mono_agent_runtime_model",
            selected_option: { value: fallback.value },
          }],
        },
      });
      await vi.waitFor(() => expect(api.updateCalls).toHaveLength(1));
      expect(api.updateCalls[0]?.text).toBe(
        "Model changed to claude-fallback for this channel until /mickey-model default or restart.",
      );

      socket.emitMessage({
        envelope_id: "SC-effort",
        type: "slash_commands",
        payload: {
          command: "/mickey-effort",
          text: "high",
          channel_id: "C1",
          user_id: "U1",
        },
      });
      await vi.waitFor(() => expect(api.postMessageCalls).toHaveLength(2));
      expect(api.postMessageCalls[1]?.text).toBe(
        "Effort changed to High for this channel until /mickey-effort default or restart.",
      );

      socket.emitMessage(socketEnvelope("E-prompt", sharedMention("use the channel choice")));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.metadata.slack).toMatchObject({
        model: "pi:anthropic:claude-fallback",
        effort: "high",
      });
    } finally {
      await started.stop();
    }
  });

  it("keeps configured mention identities when bot discovery is unavailable", async () => {
    const api = new FakeSlackApi();
    api.authTestFailure = new Error("temporary auth.test failure");
    const sockets: FakeWebSocket[] = [];
    const warn = vi.fn();
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      botUserIds: ["U_CONFIGURED"],
      stripMentionText: false,
      runtimeControls: {
        defaultModel: "pi:openai:gpt-default",
        models: [{ value: "pi:openai:gpt-default", label: "Default GPT", efforts: [] }],
      },
      responder: responderFrom(async () => ({ text: "unused" })),
      logger: { warn },
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (socket === undefined) throw new Error("expected a socket");
      socket.emitOpen();
      socket.emitMessage(socketEnvelope("E-model", directMessage("<@U_CONFIGURED> /model")));
      await vi.waitFor(() => expect(api.postMessageCalls).toHaveLength(1));
      expect(warn).toHaveBeenCalledWith(
        "Could not discover the Slack bot user ID; continuing with configured mention identities.",
        { error: "temporary auth.test failure" },
      );
    } finally {
      await started.stop();
    }
  });

  it("routes runtime-control interactions even without shortcuts or App Home buttons", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const responder = vi.fn(async () => ({ text: "unused" }));
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: { respond: responder },
      runtimeControls: {
        defaultModel: "pi:openai:default",
        models: [
          { value: "pi:openai:default", label: "Default", efforts: [] },
          { value: "pi:anthropic:fallback", label: "Fallback", efforts: [] },
        ],
      },
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (socket === undefined) throw new Error("expected a socket");
      socket.emitOpen();
      socket.emitMessage(socketEnvelope("E-model", directMessage("/model")));
      await vi.waitFor(() => expect(api.postMessageCalls).toHaveLength(1));
      const blocks = api.postMessageCalls[0]?.blocks as readonly {
        readonly elements?: readonly {
          readonly action_id?: string;
          readonly options?: readonly { readonly text: { readonly text: string }; readonly value: string }[];
        }[];
      }[];
      const option = blocks
        .flatMap((block) => block.elements ?? [])
        .find((element) => element.action_id === "mono_agent_runtime_model")
        ?.options?.find((candidate) => candidate.text.text === "Fallback");
      if (option === undefined) throw new Error("expected fallback option");

      socket.emitMessage({
        envelope_id: "I-model",
        type: "interactive",
        accepts_response_payload: true,
        payload: {
          type: "block_actions",
          channel: { id: "D1" },
          message: { ts: "200.000001", thread_ts: "171.000001" },
          actions: [{
            action_id: "mono_agent_runtime_model",
            selected_option: { value: option.value },
          }],
        },
      });

      await vi.waitFor(() => expect(api.updateCalls).toHaveLength(1));
      expect(api.updateCalls[0]).toMatchObject({
        channel: "D1",
        ts: "200.000001",
        text: "Model changed to Fallback for this DM until /model default or restart.",
        blocks: [],
      });
      expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({ envelope_id: "I-model" });
      expect(responder).not.toHaveBeenCalled();
    } finally {
      await started.stop();
    }
  });

  it("redacts configured Slack tokens at the composition-root logger boundary", async () => {
    // Build credential-shaped fixtures at runtime so repository secret
    // scanners do not mistake them for committed credentials.
    const botToken = [
      "xoxb",
      "123456789012",
      "123456789012",
      "exampleBotSecret0123456789",
    ].join("-");
    const appToken = ["xapp", "1", "exampleAppSecret0123456789"].join("-");
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const error = vi.fn();
    const warn = vi.fn();
    const started = await startSlackAdapter(buildOptions({
      botToken,
      appToken,
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async () => {
        throw Object.assign(new Error(`request failed for ${botToken} with ${appToken}`), {
          request: { headers: { Authorization: `Bearer ${appToken}` } },
        });
      }),
      shortcuts: [{ callbackId: botToken, prompt: "Run the secret route." }],
      logger: { error, warn },
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (socket === undefined) {
        throw new Error("expected a socket");
      }
      socket.emitOpen();
      socket.emitMessage(socketEnvelope("E-secret", directMessage("hello")));
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      await expect(started.adapter.handleShortcut({
        type: "shortcut",
        callback_id: botToken,
        trigger_id: "T-secret",
        user: { id: "U-secret" },
      })).resolves.toMatchObject({ kind: "ignored", reason: "missing_channel" });
      expect(warn).toHaveBeenCalled();

      const serialized = JSON.stringify([error.mock.calls, warn.mock.calls]);
      expect(serialized).not.toContain(botToken);
      expect(serialized).not.toContain(appToken);
      expect(serialized).toContain("[REDACTED_SLACK_TOKEN]");
    } finally {
      await started.stop();
    }
  });

  it("does not invoke hostile error accessors before the redacted logger boundary", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const error = vi.fn();
    const messageGetter = vi.fn(() => { throw new Error("hostile message getter"); });
    const hostileError = new Error("safe");
    Object.defineProperty(hostileError, "message", {
      configurable: true,
      get: messageGetter,
    });
    const proxyDescriptorHook = vi.fn(() => { throw new Error("hostile descriptor hook"); });
    const proxyPrototypeHook = vi.fn(() => { throw new Error("hostile prototype hook"); });
    const proxyPrototype = new Proxy({}, {
      getOwnPropertyDescriptor: proxyDescriptorHook,
      getPrototypeOf: proxyPrototypeHook,
    });
    let responderError: unknown = hostileError;
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async () => { throw responderError; }),
      logger: { error },
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0];
      if (socket === undefined) throw new Error("expected a socket");
      socket.emitOpen();
      socket.emitMessage(socketEnvelope("E-hostile", directMessage("hello")));
      await vi.waitFor(() => expect(error).toHaveBeenCalled());

      responderError = Object.create(proxyPrototype) as object;
      socket.emitMessage(socketEnvelope("E-hostile-proxy", {
        ...directMessage("hello again"),
        event_id: "Ev-hostile-proxy",
      }));
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));

      expect(messageGetter).not.toHaveBeenCalled();
      expect(proxyDescriptorHook).not.toHaveBeenCalled();
      expect(proxyPrototypeHook).not.toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).toContain("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    } finally {
      await started.stop();
    }
  });

  it("does not coerce hostile socket errors while reconnecting", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const primitiveHook = vi.fn(() => { throw new Error("hostile coercion hook"); });
    const prototypeHook = vi.fn(() => { throw new Error("hostile prototype hook"); });
    const hostileSocketError = new Proxy({
      [Symbol.toPrimitive]: primitiveHook,
    }, {
      getPrototypeOf: prototypeHook,
    });
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async () => ({ text: "ok" })),
    }));

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emit("error", hostileSocketError);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      expect(primitiveHook).not.toHaveBeenCalled();
      expect(prototypeHook).not.toHaveBeenCalled();
    } finally {
      await started.stop();
    }
  });

  it("stop() is idempotent and tears down the runner loop", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async () => ({ text: "ok" })),
    }));

    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await started.stop();
    await expect(started.stop()).resolves.toBeUndefined();
    expect(sockets[0]?.closed).toBe(true);
  });

  it("fails closed when no responder is provided", async () => {
    await expect(
      // @ts-expect-error intentional missing responder
      startSlackAdapter({ botToken: "bot-token", appToken: "app-token", allowAllChannels: true }),
    ).rejects.toThrow(/responder/);
  });

  it("fails closed when neither allowedChannelIds nor allowAllChannels is set", async () => {
    await expect(
      startSlackAdapter({
        botToken: "bot-token",
        appToken: "app-token",
        createApi: () => new FakeSlackApi(),
        responder: responderFrom(async () => ({ text: "ok" })),
      }),
    ).rejects.toThrow(/allowedChannelIds/);
  });

  it("sanitizes connection loss and contains host callback failures during recovery", async () => {
    vi.useFakeTimers();
    try {
      const botToken = "test-bot-token";
      const appToken = "test-app-token";
      const socketTicket = "socket-ticket-secret";
      const api = new FakeSlackApi();
      const sockets: FakeWebSocket[] = [];
      const lost: string[] = [];
      const info = vi.fn();
      const warn = vi.fn();
      let restored = 0;
      const started = await startSlackAdapter(buildOptions({
        botToken,
        appToken,
        createApi: () => api,
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        responder: responderFrom(async () => ({ text: "ok" })),
        reconnect: { initialMs: 0, maxMs: 0, stabilityMs: 1000 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        logger: { info, warn },
        onConnectionLost: async (reason) => {
          lost.push(reason);
          throw new Error("host degraded callback failed");
        },
        onConnectionRestored: () => {
          restored += 1;
          throw new Error("host recovered callback failed");
        },
      }));

      try {
        await vi.waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.emitOpen();
        sockets[0]?.emitMessage({
          type: "disconnect",
          reason: `too_many_websockets ${botToken} ${appToken} wss://wss.slack.com/link/?ticket=${socketTicket}`,
        });
        await vi.waitFor(() => expect(lost).toHaveLength(1));
        await vi.waitFor(() => expect(info).toHaveBeenCalled());
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(lost[0]).toContain("too_many_websockets");
        expect(lost[0]).not.toContain(botToken);
        expect(lost[0]).not.toContain(appToken);
        expect(lost[0]).not.toContain(socketTicket);
        const serializedLogs = JSON.stringify([info.mock.calls, warn.mock.calls]);
        expect(info.mock.calls.some(([message]) => (
          message === "Slack Socket Mode disconnect requested."
        ))).toBe(true);
        expect(serializedLogs).not.toContain(botToken);
        expect(serializedLogs).not.toContain(appToken);
        expect(serializedLogs).not.toContain(socketTicket);
        await vi.waitFor(() => expect(sockets).toHaveLength(2));
        sockets[1]?.emitOpen();
        await vi.advanceTimersByTimeAsync(1000);
        expect(restored).toBe(1);
      } finally {
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

function buildOptions(
  overrides: Partial<SlackAdapterStartOptions> & Pick<SlackAdapterStartOptions, "responder">,
): SlackAdapterStartOptions {
  return {
    botToken: "test-bot-token",
    appToken: "test-app-token",
    allowAllChannels: true,
    reconnect: { initialMs: 0, maxMs: 0 },
    ...overrides,
  };
}

function socketEnvelope(
  envelopeId: string,
  callback: SlackEventCallback,
): SlackSocketModeEnvelope {
  return {
    envelope_id: envelopeId,
    type: "events_api",
    accepts_response_payload: false,
    payload: callback,
  };
}

function directMessage(text: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 171,
    event: {
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text,
      ts: "171.000001",
      event_ts: "171.000001",
    },
  };
}

function sharedMention(text: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev-shared",
    event_time: 172,
    event: {
      type: "app_mention",
      channel: "C1",
      user: "U1",
      text,
      ts: "172.000001",
      event_ts: "172.000001",
    },
  };
}
