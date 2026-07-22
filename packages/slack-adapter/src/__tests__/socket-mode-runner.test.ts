import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { SlackSocketModeRunner } from "../socket-mode-runner.js";
import type {
  SlackChatPostMessageParams,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackInteractivityPayload,
  SlackSlashCommandPayload,
  SlackSocketModeEnvelope,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly opened: string[] = [];
  private nextUrlIndex = 0;

  constructor(private readonly urls: readonly string[]) {}

  async authTest() {
    return { ok: true as const };
  }

  async appsConnectionsOpen() {
    const url = this.urls[this.nextUrlIndex] ?? this.urls.at(-1) ?? "wss://slack.test/default";
    this.nextUrlIndex += 1;
    this.opened.push(url);
    return { ok: true as const, url };
  }

  async chatPostMessage(_params: SlackChatPostMessageParams) {
    return { ok: true as const, channel: "C1", ts: "171.1" };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }

  async downloadFile() {
    return new Uint8Array();
  }
}

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed = false;
  pings = 0;
  terminated = false;
  /** When true, each ping() synchronously echoes a pong (a responsive peer). */
  respondToPing = false;
  /** When true, terminate() marks terminated but emits no "close" (a wedged socket). */
  silentTerminate = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  ping(): void {
    this.pings += 1;
    if (this.respondToPing) {
      this.emit("pong");
    }
  }

  terminate(): void {
    this.terminated = true;
    if (!this.silentTerminate) {
      this.close();
    }
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

describe("SlackSocketModeRunner", () => {
  it("opens Socket Mode, acknowledges events, and dispatches event callbacks", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const handled: SlackEventCallback[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: {
        async handleEventCallback(callback) {
          handled.push(callback);
          return { kind: "handled", eventId: callback.event_id, channelId: "C1", action: "responded", trigger: "direct" };
        },
      },
      webSocketFactory: (url) => {
        expect(url).toBe("wss://slack.test/1");
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(socketEnvelope("E1", eventCallback("Ev1")));
    await vi.waitFor(() => expect(handled).toHaveLength(1));
    controller.abort();
    await started;

    expect(api.opened).toEqual(["wss://slack.test/1"]);
    expect(sockets[0]?.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      { envelope_id: "E1" },
    ]);
    expect(handled[0]?.event_id).toBe("Ev1");
  });

  it("acknowledges unsupported envelopes without dispatching", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const handler = { handleEventCallback: vi.fn() };
    const runner = new SlackSocketModeRunner({
      api,
      handler,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({ envelope_id: "E-ignore", type: "slash_commands", payload: { command: "/x" } });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    controller.abort();
    await started;

    expect(handler.handleEventCallback).not.toHaveBeenCalled();
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ envelope_id: "E-ignore" });
  });

  it("acknowledges and routes valid slash-command envelopes", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const commands: SlackSlashCommandPayload[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      onSlashCommand: (payload) => {
        commands.push(payload);
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({
      envelope_id: "E-command",
      type: "slash_commands",
      payload: {
        command: "/mickey-model",
        text: "default",
        channel_id: "C1",
        user_id: "U1",
      },
    });
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    controller.abort();
    await started;

    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ envelope_id: "E-command" });
    expect(commands[0]).toMatchObject({
      command: "/mickey-model",
      text: "default",
      channel_id: "C1",
    });
  });

  it("acknowledges interactive envelopes and routes shortcut payloads to onInteraction", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const interactions: SlackInteractivityPayload[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: {
        async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        },
      },
      onInteraction: (payload) => {
        interactions.push(payload);
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({
      envelope_id: "E-sc",
      type: "interactive",
      payload: { type: "shortcut", callback_id: "sync_now", trigger_id: "T1", user: { id: "U1" } },
    });
    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    controller.abort();
    await started;

    // The interactive envelope is acked, and the shortcut payload is routed.
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ envelope_id: "E-sc" });
    expect(interactions[0]?.callback_id).toBe("sync_now");
  });

  it("routes block_actions (button) payloads to onInteraction too", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const interactions: SlackInteractivityPayload[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: {
        async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        },
      },
      onInteraction: (payload) => {
        interactions.push(payload);
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({
      envelope_id: "E-ba",
      type: "interactive",
      payload: { type: "block_actions", actions: [{ action_id: "sync_now" }], user: { id: "U1" } },
    });
    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    controller.abort();
    await started;

    expect(interactions[0]?.type).toBe("block_actions");
  });

  it("reconnects after Slack refresh disconnects", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({ type: "disconnect", reason: "refresh_requested" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    controller.abort();
    await started;

    expect(api.opened).toEqual(["wss://slack.test/1", "wss://slack.test/2"]);
  });

  it("backs off before reconnecting after too_many_websockets disconnects", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        // jitterRatio: 0 keeps the backoff deterministic for the exact-timing assertions.
        reconnect: { initialMs: 1000, maxMs: 1000, jitterRatio: 0 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });

      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      controller.abort();
      await started;

      expect(api.opened).toEqual(["wss://slack.test/1", "wss://slack.test/2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recycles a silently dead socket via the heartbeat watchdog", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        reconnect: { initialMs: 0, maxMs: 0 },
        heartbeat: { intervalMs: 1000, timeoutMs: 3000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();

      // The peer goes silent (no message/ping/pong). The watchdog probes...
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets[0]?.pings).toBeGreaterThan(0);
      expect(sockets).toHaveLength(1);

      // ...and after the timeout window with no activity, force-recycles it,
      // which triggers a reconnect.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(sockets[0]?.terminated).toBe(true);

      controller.abort();
      await started;
      expect(api.opened).toEqual(["wss://slack.test/1", "wss://slack.test/2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recycle a responsive socket that answers heartbeats", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          socket.respondToPing = true; // healthy peer pongs every probe
          sockets.push(socket);
          return socket;
        },
        reconnect: { initialMs: 0, maxMs: 0 },
        heartbeat: { intervalMs: 1000, timeoutMs: 3000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();

      // Far past the timeout window, but pongs keep refreshing activity.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets[0]?.pings).toBeGreaterThan(0);
      expect(sockets[0]?.terminated).toBe(false);
      expect(sockets).toHaveLength(1);

      controller.abort();
      await started;
      expect(api.opened).toEqual(["wss://slack.test/1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates (not just closes) the old socket on a too_many_websockets disconnect", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    // A throttled/half-dead peer never completes the close handshake; terminate()
    // drops the TCP connection immediately so Slack's per-app budget frees.
    expect(sockets[0]?.terminated).toBe(true);
    controller.abort();
    await started;
  });

  it("reports degraded via onConnectionLost exactly once on a non-refresh disconnect", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const lost: string[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
      reconnect: { initialMs: 0, maxMs: 0 },
      onConnectionLost: (reason) => { lost.push(reason); },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
    await vi.waitFor(() => expect(lost).toEqual(["too_many_websockets"]));
    controller.abort();
    await started;
  });

  it("treats a warning disconnect as a graceful refresh — reconnects with no backoff and no degraded signal", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const lost: string[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
      // Large backoff: if "warning" wrongly took the backoff path, this would stall.
      reconnect: { initialMs: 60_000, maxMs: 60_000 },
      onConnectionLost: (reason) => { lost.push(reason); },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage({ type: "disconnect", reason: "warning" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(lost).toEqual([]);
    expect(sockets[0]?.terminated).toBe(false);
    controller.abort();
    await started;
  });

  it("fires onConnectionRestored only after a reconnect survives the stability window, never on first connect", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const lost: string[] = [];
      let restored = 0;
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 0, maxMs: 0, stabilityMs: 5000 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        onConnectionLost: (reason) => { lost.push(reason); },
        onConnectionRestored: () => { restored += 1; },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      // First connect crosses the stability window but must NOT fire restored
      // (it was never degraded).
      await vi.advanceTimersByTimeAsync(5000);
      expect(restored).toBe(0);

      // Lose the connection, reconnect, and stay open past the stability window.
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.waitFor(() => expect(lost).toEqual(["too_many_websockets"]));
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1]?.emitOpen();
      await vi.advanceTimersByTimeAsync(4999);
      expect(restored).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(restored).toBe(1);

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset backoff when a connection drops before the stability window (graceful refresh included)", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi([
        "wss://slack.test/1", "wss://slack.test/2", "wss://slack.test/3", "wss://slack.test/4",
      ]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 1000, maxMs: 8000, stabilityMs: 60_000, jitterRatio: 0.2 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        random: () => 0.5, // mid-band jitter → jittered delay === base
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      // Backoff #1 === 1000.
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      // A graceful refresh BEFORE the stability window must NOT reset backoff.
      sockets[1]?.emitOpen();
      sockets[1]?.emitMessage({ type: "disconnect", reason: "refresh_requested" });
      await vi.waitFor(() => expect(sockets).toHaveLength(3));

      // So the next too_many backs off at 2000, not a reset-to-1000.
      sockets[2]?.emitOpen();
      sockets[2]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(4));

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies band jitter to the reconnect delay via the injected RNG", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 1000, maxMs: 1000, stabilityMs: 60_000, jitterRatio: 0.2 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        random: () => 0, // low end of the band → delay === base * (1 - 0.2) === 800
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      // Un-jittered the delay would be 1000; jitter pulls it down to 800. Assert
      // hard at the boundary (no waitFor, which would auto-advance and mask it).
      await vi.advanceTimersByTimeAsync(799);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a wedged socket via the drain deadline when a recycled socket emits no close", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const s = new FakeWebSocket();
          s.silentTerminate = true; // terminate() leaves the promise unsettled
          sockets.push(s);
          return s;
        },
        reconnect: { initialMs: 0, maxMs: 0, drainDeadlineMs: 2000 },
        heartbeat: { intervalMs: 1000, timeoutMs: 2000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();

      // Silent peer → heartbeat recycles via terminate(), which emits no close.
      await vi.advanceTimersByTimeAsync(1000); // probe
      await vi.advanceTimersByTimeAsync(1000); // silence timeout → terminate (no close)
      expect(sockets[0]?.terminated).toBe(true);
      expect(sockets).toHaveLength(1); // would wedge here without the drain deadline

      await vi.advanceTimersByTimeAsync(2000); // drain deadline → force settle → reconnect
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the degraded signal during the startup grace window but reports it once connected", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2", "wss://slack.test/3"]);
      const sockets: FakeWebSocket[] = [];
      const lost: string[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 1000, maxMs: 1000, startupGraceMs: 5000, stabilityMs: 60_000 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        onConnectionLost: (reason) => { lost.push(reason); },
        random: () => 0.5,
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      // A too_many BEFORE the first open, inside the grace window: a lingering
      // prior-process socket — retry quietly, do not flag degraded.
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(lost).toEqual([]);

      // Once actually connected, a drop IS a real degradation.
      sockets[1]?.emitOpen();
      sockets[1]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.waitFor(() => expect(lost).toEqual(["too_many_websockets"]));

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate-limits graceful reconnects via the floor so a warning storm cannot busy-loop", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi([
        "wss://slack.test/1", "wss://slack.test/2", "wss://slack.test/3",
      ]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        // The graceful path normally reconnects immediately; the floor caps the rate
        // so an immediate-warning storm cannot spin at zero delay.
        reconnect: { initialMs: 0, maxMs: 0, gracefulReconnectFloorMs: 500 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        random: () => 0.5, // mid-band → floor delay === 500
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emitMessage({ type: "disconnect", reason: "warning" });
      await vi.advanceTimersByTimeAsync(499);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });
});

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

function eventCallback(eventId: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: eventId,
    event_time: 171,
    event: {
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "hello",
      ts: "171.000001",
      event_ts: "171.000001",
    },
  };
}
