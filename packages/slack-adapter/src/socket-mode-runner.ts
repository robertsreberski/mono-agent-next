import WebSocket from "ws";

import { redactSlackErrorMessage } from "./log-redaction.js";
import type {
  SlackEventCallback,
  SlackInteractivityPayload,
  SlackSlashCommandPayload,
  SlackSocketModeEnvelope,
  SlackWebApi,
} from "./types.js";
import type { SlackEventHandlingResult } from "./adapter.js";

export interface SlackEventCallbackHandler {
  handleEventCallback(callback: SlackEventCallback): Promise<SlackEventHandlingResult>;
}

/**
 * Handles a Slack interactivity payload — a shortcut, message action, or a
 * Block Kit button click (`block_actions`). Invoked AFTER the envelope is
 * acknowledged, so a slow handler never risks Slack's 3-second ack deadline.
 */
export type SlackInteractionHandler = (
  payload: SlackInteractivityPayload,
) => void | Promise<void>;

/** Handles a workspace-registered slash command after its Socket Mode ack. */
export type SlackSlashCommandHandler = (
  payload: SlackSlashCommandPayload,
) => void | Promise<void>;

export interface SlackSocketModeRunnerBackoffOptions {
  initialMs?: number;
  maxMs?: number;
  /**
   * Band jitter applied to each backoff sleep, as a fraction of the base delay
   * (0 disables jitter). The actual sleep is uniformly within ±ratio of the base —
   * `base * (1 - ratio + random() * 2 * ratio)` — so clients (or a process restarting
   * in a loop) that would otherwise reconnect in lockstep de-synchronize instead of
   * re-colliding on Slack's per-app connection budget.
   */
  jitterRatio?: number;
  /**
   * How long a freshly opened socket must stay up before the backoff resets to
   * initial and a previously-degraded connection is reported recovered. The reset is
   * gated on this window (not on a mere connect) so a connect→immediate-drop flap
   * keeps accumulating backoff instead of re-hammering at the initial delay. Set to 0
   * to disable the stability gate (the backoff then never auto-resets within a run).
   */
  stabilityMs?: number;
  /**
   * Grace window after `start()` during which a non-graceful disconnect that arrives
   * before the first successful open is treated as an expected lingering prior-process
   * socket (common right after a restart): it is retried quietly with backoff and does
   * NOT flag the channel degraded. Set to 0 to disable the grace.
   */
  startupGraceMs?: number;
  /**
   * Backstop: after a watchdog-triggered `terminate()`, if the socket emits neither
   * `close` nor `error` within this window, the attempt is force-settled so the
   * reconnect loop can never wedge on a stuck socket. Set to 0 to disable.
   */
  drainDeadlineMs?: number;
  /**
   * Minimum (jittered) delay between reconnect attempts on the GRACEFUL path
   * (refresh/warning/clean close), which otherwise reconnects immediately. This is
   * NOT the failure backoff — it stays small — but it rate-limits the loop so a
   * degenerate server that drops every socket at/before open cannot spin into a
   * zero-delay reconnect storm (the very `too_many_websockets` failure mode this
   * adapter guards against). Set to 0 to reconnect with no floor.
   */
  gracefulReconnectFloorMs?: number;
}

export interface SlackSocketModeRunnerHeartbeatOptions {
  /**
   * How often the watchdog wakes to probe an idle socket with a ping and to
   * check for silence. Because the silence check only runs on these ticks,
   * recycling can lag the `timeoutMs` deadline by up to one `intervalMs`.
   * Setting this to 0 disables the watchdog entirely.
   */
  intervalMs?: number;
  /**
   * Silence budget: if no inbound frame (message, ping, or pong) arrives within
   * this window, the socket is treated as silently dead and force-recycled on
   * the next watchdog tick so the reconnect loop can re-establish it. The actual
   * recycle therefore happens between `timeoutMs` and `timeoutMs + intervalMs`
   * after the last frame. Setting this to 0 disables the watchdog entirely.
   */
  timeoutMs?: number;
}

export interface SlackSocketModeRunnerLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface SlackSocketModeRunnerOptions {
  api: SlackWebApi;
  handler: SlackEventCallbackHandler;
  reconnect?: SlackSocketModeRunnerBackoffOptions;
  heartbeat?: SlackSocketModeRunnerHeartbeatOptions;
  webSocketFactory?: SlackWebSocketFactory;
  onEventResult?: (result: SlackEventHandlingResult) => void | Promise<void>;
  /**
   * Optional handler for shortcut interactivity payloads. When absent, interactive
   * envelopes are acknowledged and ignored (the historical behavior); when set,
   * shortcut payloads are routed to it after the envelope is acknowledged.
   */
  onInteraction?: SlackInteractionHandler;
  /** Optional slash-command handler. Envelopes are acknowledged before dispatch. */
  onSlashCommand?: SlackSlashCommandHandler;
  /**
   * Called once when an established connection drops into the reconnect/backoff loop
   * (a real degradation — `too_many_websockets`, a socket error, a heartbeat timeout,
   * an unknown disconnect reason). Suppressed for a graceful refresh and for a
   * lingering prior-process socket inside the startup grace window. Wire this to the
   * app's `onDegraded` so the channel reports `degraded` (responder kept alive) rather
   * than churning silently.
   */
  onConnectionLost?: (reason: string) => void;
  /**
   * Called once a reconnect has stayed open for the stability window after a prior
   * loss (never on the first connect). Wire this to the app's `onRecovered`.
   */
  onConnectionRestored?: () => void;
  /** Injected RNG in [0, 1) for backoff jitter; defaults to `Math.random`. */
  random?: () => number;
  logger?: SlackSocketModeRunnerLogger;
}

export interface SlackSocketModeRunnerStartOptions {
  signal?: AbortSignal;
}

export type SlackWebSocketFactory = (url: string) => SlackWebSocketLike;

export interface SlackWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Send a WebSocket ping frame (keepalive). Optional: not every transport exposes it. */
  ping?(): void;
  /** Forcibly destroy the socket without a closing handshake. Optional. */
  terminate?(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
}

/**
 * `ping`/`pong` are not part of the required {@link SlackWebSocketLike} surface
 * (a custom transport may not emit them), so we register those listeners only
 * when the socket supports `on`, via this widened view — keeping the public
 * interface unchanged for existing implementations.
 */
type SlackWebSocketPingListenable = {
  on(event: "ping" | "pong", listener: () => void): unknown;
};

function onPingPong(socket: SlackWebSocketLike, listener: () => void): void {
  const listenable = socket as unknown as Partial<SlackWebSocketPingListenable>;
  if (typeof listenable.on !== "function") {
    return;
  }
  try {
    listenable.on("ping", listener);
    listenable.on("pong", listener);
  } catch {
    // A transport whose `on` rejects unknown events simply opts out of
    // ping/pong-based liveness; inbound messages still refresh the watchdog.
  }
}

const DEFAULT_INITIAL_BACKOFF_MS = 500;
// Raised from 10s to 30s (matching the Telegram poller's restart ceiling): a
// `too_many_websockets` disconnect signals the app exceeded Slack's per-app
// connection budget, so a longer cool-down gives an orphaned socket time to clear
// server-side instead of re-hammering the limit every 10s.
const DEFAULT_MAX_BACKOFF_MS = 30_000;
// Slack's Socket Mode server pings clients periodically; a healthy idle socket
// therefore sees inbound frames well within this window. These defaults probe
// every 30s and declare a socket dead after 90s of total silence — long enough
// to avoid false positives on a quiet connection, short enough to self-heal a
// half-open socket (e.g. after the host sleeps) within ~1.5 min.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_STABILITY_MS = 30_000;
const DEFAULT_STARTUP_GRACE_MS = 10_000;
const DEFAULT_DRAIN_DEADLINE_MS = 5_000;
const DEFAULT_BACKOFF_JITTER_RATIO = 0.2;
// Small floor between graceful reconnects so a pathological refresh/warning storm
// cannot busy-loop. Far below the failure backoff, so a routine refresh is unaffected.
const DEFAULT_GRACEFUL_RECONNECT_FLOOR_MS = 250;

// Slack `disconnect` reasons that are a planned, graceful refresh: Slack is (or is
// about to be) closing this socket as routine maintenance. `warning` is the courtesy
// heads-up sent shortly before a refresh — reacting to it as a failure (the old
// behavior) doubled the reconnect rate and was a primary `too_many_websockets`
// amplifier. These reconnect immediately with no backoff and are not a degradation.
const GRACEFUL_DISCONNECT_REASONS = new Set(["refresh_requested", "warning"]);

export class SlackSocketModeRunner {
  private readonly api: SlackWebApi;
  private readonly handler: SlackEventCallbackHandler;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly stabilityMs: number;
  private readonly startupGraceMs: number;
  private readonly drainDeadlineMs: number;
  private readonly gracefulReconnectFloorMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly onEventResult:
    | ((result: SlackEventHandlingResult) => void | Promise<void>)
    | undefined;
  private readonly onInteraction: SlackInteractionHandler | undefined;
  private readonly onSlashCommand: SlackSlashCommandHandler | undefined;
  private readonly onConnectionLost: ((reason: string) => void) | undefined;
  private readonly onConnectionRestored: (() => void) | undefined;
  private readonly logger: SlackSocketModeRunnerLogger | undefined;
  private activeSocket: SlackWebSocketLike | undefined;
  // Per-`start()` run state (reset on each start). The backoff is class-scoped so the
  // stability timer (inside connectOnce) can reset it only after a socket proves
  // healthy, rather than it resetting on every connect.
  private currentBackoffMs = 0;
  private connectionDegraded = false;
  private hasEverConnected = false;
  private startedAt = 0;

  constructor(options: SlackSocketModeRunnerOptions) {
    this.api = options.api;
    this.handler = options.handler;
    this.initialBackoffMs = options.reconnect?.initialMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.reconnect?.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.heartbeatIntervalMs = options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeat?.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.stabilityMs = options.reconnect?.stabilityMs ?? DEFAULT_STABILITY_MS;
    this.startupGraceMs = options.reconnect?.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.drainDeadlineMs = options.reconnect?.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
    this.gracefulReconnectFloorMs =
      options.reconnect?.gracefulReconnectFloorMs ?? DEFAULT_GRACEFUL_RECONNECT_FLOOR_MS;
    this.jitterRatio = options.reconnect?.jitterRatio ?? DEFAULT_BACKOFF_JITTER_RATIO;
    this.random = options.random ?? Math.random;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url) as SlackWebSocketLike);
    this.onEventResult = options.onEventResult;
    this.onInteraction = options.onInteraction;
    this.onSlashCommand = options.onSlashCommand;
    this.onConnectionLost = options.onConnectionLost;
    this.onConnectionRestored = options.onConnectionRestored;
    this.logger = options.logger;

    if (!Number.isFinite(this.initialBackoffMs) || this.initialBackoffMs < 0) {
      throw new RangeError("SlackSocketModeRunner initial backoff must be non-negative.");
    }
    if (!Number.isFinite(this.maxBackoffMs) || this.maxBackoffMs < this.initialBackoffMs) {
      throw new RangeError("SlackSocketModeRunner max backoff must be at least the initial backoff.");
    }
    if (!Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 0) {
      throw new RangeError("SlackSocketModeRunner heartbeat interval must be non-negative.");
    }
    if (!Number.isFinite(this.heartbeatTimeoutMs) || this.heartbeatTimeoutMs < 0) {
      throw new RangeError("SlackSocketModeRunner heartbeat timeout must be non-negative.");
    }
    if (!Number.isFinite(this.stabilityMs) || this.stabilityMs < 0) {
      throw new RangeError("SlackSocketModeRunner stability window must be non-negative.");
    }
    if (!Number.isFinite(this.startupGraceMs) || this.startupGraceMs < 0) {
      throw new RangeError("SlackSocketModeRunner startup grace must be non-negative.");
    }
    if (!Number.isFinite(this.drainDeadlineMs) || this.drainDeadlineMs < 0) {
      throw new RangeError("SlackSocketModeRunner drain deadline must be non-negative.");
    }
    if (!Number.isFinite(this.gracefulReconnectFloorMs) || this.gracefulReconnectFloorMs < 0) {
      throw new RangeError("SlackSocketModeRunner graceful reconnect floor must be non-negative.");
    }
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new RangeError("SlackSocketModeRunner jitter ratio must be between 0 and 1.");
    }
  }

  async start(options: SlackSocketModeRunnerStartOptions = {}): Promise<void> {
    if (isSignalAborted(options.signal)) {
      return;
    }

    // (Re)initialize per-run state for this start cycle.
    this.currentBackoffMs = this.initialBackoffMs;
    this.connectionDegraded = false;
    this.hasEverConnected = false;
    this.startedAt = Date.now();

    while (!isSignalAborted(options.signal)) {
      try {
        await this.connectOnce(options.signal);
        // A graceful exit (refresh/warning/clean close) resolves here and reconnects
        // with no backoff. Apply a small jittered floor so a degenerate server that
        // drops every socket at/before open cannot spin into a zero-delay storm. The
        // backoff is reset only by the stability timer once a socket proves healthy
        // (see connectOnce), NOT on every connect — a flap must keep accumulating it.
        await abortableDelay(this.jitteredDelay(this.gracefulReconnectFloorMs), options.signal);
      } catch (error) {
        if (isSignalAborted(options.signal)) {
          return;
        }
        this.logger?.warn?.("Slack Socket Mode connection failed; backing off.", {
          error: redactSlackErrorMessage(error),
          backoffMs: this.currentBackoffMs,
        });
        await abortableDelay(this.jitteredDelay(this.currentBackoffMs), options.signal);
        this.currentBackoffMs = Math.min(this.maxBackoffMs, Math.max(this.currentBackoffMs * 2, 1));
      }
    }
  }

  /**
   * Apply band jitter to a backoff base: uniformly within ±`jitterRatio` of `baseMs`.
   * De-synchronizes reconnect attempts so colliding clients (or a restart loop) stop
   * re-triggering Slack's `too_many_websockets` in lockstep.
   */
  private jitteredDelay(baseMs: number): number {
    if (baseMs <= 0 || this.jitterRatio <= 0) {
      return baseMs;
    }
    const factor = 1 - this.jitterRatio + this.random() * this.jitterRatio * 2;
    return baseMs * factor;
  }

  private async connectOnce(signal: AbortSignal | undefined): Promise<void> {
    const connection = await this.api.appsConnectionsOpen({ ...(signal === undefined ? {} : { signal }) });
    if (isSignalAborted(signal)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = this.webSocketFactory(connection.url);
      this.activeSocket = socket;
      let settled = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let stabilityTimer: ReturnType<typeof setTimeout> | undefined;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let lastActivityAt = Date.now();

      const markActivity = (): void => {
        lastActivityAt = Date.now();
      };

      const clearTimers = (): void => {
        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        if (stabilityTimer !== undefined) {
          clearTimeout(stabilityTimer);
          stabilityTimer = undefined;
        }
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
      };

      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        signal?.removeEventListener("abort", onAbort);
        if (this.activeSocket === socket) {
          this.activeSocket = undefined;
        }
        action();
      };

      // Hard teardown: drop the TCP connection immediately (no closing handshake) so
      // a throttled/half-dead peer cannot linger against Slack's per-app connection
      // budget and re-trigger `too_many_websockets`. Falls back to close() on a
      // transport without terminate().
      const drainHard = (): void => {
        try {
          if (typeof socket.terminate === "function") {
            socket.terminate();
          } else {
            socket.close();
          }
        } catch {
          // settle still happens via the close/error handlers or the drain deadline.
        }
      };

      // Graceful teardown: a normal close handshake for a planned, expected swap.
      const drainGraceful = (): void => {
        try {
          socket.close();
        } catch {
          settle(resolve);
        }
      };

      // Backstop after a watchdog terminate: if the socket emits neither close nor
      // error in time, force-settle so the reconnect loop can never wedge on a stuck
      // socket. (The disconnect/error paths settle synchronously and never arm this.)
      const armDrainDeadline = (): void => {
        if (this.drainDeadlineMs <= 0 || drainTimer !== undefined) {
          return;
        }
        drainTimer = setTimeout(() => {
          this.logger?.warn?.("Slack Socket Mode socket did not close after terminate; forcing reconnect.");
          settle(resolve);
        }, this.drainDeadlineMs);
        (drainTimer as { unref?: () => void }).unref?.();
      };

      // Report a real degradation exactly once. Suppressed for a lingering
      // prior-process socket inside the startup grace (the common post-restart case),
      // where retrying quietly with backoff is expected rather than an outage.
      const reportLost = (reason: string): void => {
        if (this.connectionDegraded) {
          return;
        }
        if (!this.hasEverConnected && Date.now() - this.startedAt < this.startupGraceMs) {
          this.logger?.info?.("Slack Socket Mode rejected during startup grace; retrying quietly.", { reason });
          return;
        }
        this.connectionDegraded = true;
        this.logger?.warn?.("Slack Socket Mode connection degraded; transport is recovering.", { reason });
        this.onConnectionLost?.(reason);
      };

      // Watchdog for a silently dead ("half-open") socket: if no inbound frame
      // arrives within heartbeatTimeoutMs, force-recycle so the reconnect loop
      // re-establishes the connection. Without this, a connection broken by host
      // sleep or a network blip never fires `close`, so the runner waits forever
      // and the channel goes silent until a manual restart.
      const startHeartbeat = (): void => {
        if (this.heartbeatTimeoutMs <= 0 || this.heartbeatIntervalMs <= 0) {
          return;
        }
        markActivity();
        heartbeatTimer = setInterval(() => {
          if (settled) {
            return;
          }
          if (Date.now() - lastActivityAt >= this.heartbeatTimeoutMs) {
            this.logger?.warn?.("Slack Socket Mode heartbeat timed out; recycling connection.", {
              silentForMs: Date.now() - lastActivityAt,
            });
            reportLost("heartbeat_timeout");
            drainHard();
            // A silent socket may not emit close after terminate; guarantee progress.
            armDrainDeadline();
            return;
          }
          // Otherwise probe the peer so a healthy-but-idle socket stays marked
          // active via the resulting pong/ping frames.
          try {
            socket.ping?.();
          } catch {
            // A throwing ping means the socket is already gone; the close/error
            // handler will settle and trigger reconnect.
          }
        }, this.heartbeatIntervalMs);
        // Never let the watchdog keep the process alive on its own.
        (heartbeatTimer as { unref?: () => void }).unref?.();
      };

      const onAbort = () => {
        // A clean stop: terminate-first so a fast stop→start (config reload, restart)
        // cannot leave an orphaned socket counted against the per-app budget.
        try {
          drainHard();
        } finally {
          settle(resolve);
        }
      };

      // Planned, graceful refresh: reconnect immediately — no backoff, no degraded.
      const closeForReconnect = (): void => {
        drainGraceful();
      };

      // Real failure: report degraded, settle as a reject (so start() backs off), THEN
      // terminate. Settling before the terminate guarantees the reject wins the race
      // against the terminate-induced `close` (which would otherwise resolve).
      const failForBackoff = (error: Error, reason: string): void => {
        reportLost(reason);
        settle(() => reject(error));
        drainHard();
      };

      socket.on("open", () => {
        this.logger?.info?.("Slack Socket Mode connected.");
        this.hasEverConnected = true;
        startHeartbeat();
        // Stability window: a socket that stays open this long is healthy — reset the
        // backoff curve and, if we were degraded, announce recovery. Gating recovery
        // on `connectionDegraded` keeps it from firing on the first healthy connect.
        if (this.stabilityMs > 0) {
          stabilityTimer = setTimeout(() => {
            if (settled) {
              return;
            }
            // Safe to write the class-scoped backoff here: this fires only while the
            // socket is open and connectOnce's promise is unsettled, so start()'s
            // post-settle read/grow always observes this reset (no cross-await race).
            this.currentBackoffMs = this.initialBackoffMs;
            if (this.connectionDegraded) {
              this.connectionDegraded = false;
              this.logger?.info?.("Slack Socket Mode connection recovered.");
              this.onConnectionRestored?.();
            }
          }, this.stabilityMs);
          (stabilityTimer as { unref?: () => void }).unref?.();
        }
      });
      onPingPong(socket, markActivity);
      socket.on("message", (data: unknown) => {
        markActivity();
        const envelope = parseSocketEnvelope(data);
        if (envelope === undefined) {
          this.logger?.warn?.("Slack Socket Mode envelope was malformed.");
          return;
        }
        if (envelope.type === "disconnect") {
          const reason = envelope.reason ?? "unknown";
          this.logger?.info?.("Slack Socket Mode disconnect requested.", { reason });
          if (GRACEFUL_DISCONNECT_REASONS.has(reason)) {
            closeForReconnect();
            return;
          }
          failForBackoff(new Error(`Slack Socket Mode disconnect requested: ${reason}`), reason);
          return;
        }
        void this.handleEnvelope(socket, envelope).catch((error: unknown) => {
          this.logger?.error?.("Slack Socket Mode envelope handling failed.", {
            error: redactSlackErrorMessage(error),
          });
        });
      });
      socket.on("close", () => {
        settle(resolve);
      });
      socket.on("error", (error: unknown) => {
        reportLost("socket_error");
        settle(() => reject(asSlackSocketError(error)));
      });

      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async handleEnvelope(
    socket: SlackWebSocketLike,
    envelope: SlackSocketModeEnvelope,
  ): Promise<void> {
    if (envelope.envelope_id !== undefined) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    // Interactivity: a clicked ⚡ shortcut, message action, or Block Kit button.
    // The ack above already went out, so a slow handler never risks Slack's 3s
    // ack deadline.
    if (envelope.type === "interactive") {
      if (this.onInteraction === undefined) {
        return;
      }
      const payload = asInteractivityPayload(envelope.payload);
      if (payload === undefined) {
        return;
      }
      await this.onInteraction(payload);
      return;
    }

    if (envelope.type === "slash_commands") {
      if (this.onSlashCommand === undefined) {
        return;
      }
      const payload = asSlashCommandPayload(envelope.payload);
      if (payload === undefined) {
        return;
      }
      await this.onSlashCommand(payload);
      return;
    }

    if (envelope.type !== "events_api" || !isSlackEventCallback(envelope.payload)) {
      return;
    }

    const result = await this.handler.handleEventCallback(envelope.payload);
    await this.onEventResult?.(result);
  }
}

function asSlackSocketError(error: unknown): Error {
  return new Error(redactSlackErrorMessage(error));
}

function parseSocketEnvelope(data: unknown): SlackSocketModeEnvelope | undefined {
  const text = dataToString(data);
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const envelope: SlackSocketModeEnvelope = {};
    if (typeof parsed.envelope_id === "string") {
      envelope.envelope_id = parsed.envelope_id;
    }
    if (typeof parsed.type === "string") {
      envelope.type = parsed.type;
    }
    if (typeof parsed.accepts_response_payload === "boolean") {
      envelope.accepts_response_payload = parsed.accepts_response_payload;
    }
    if ("payload" in parsed) {
      envelope.payload = parsed.payload;
    }
    if (typeof parsed.reason === "string") {
      envelope.reason = parsed.reason;
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function dataToString(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((part) => part instanceof Buffer)) {
    return Buffer.concat(data).toString("utf8");
  }
  return undefined;
}

function isSlackEventCallback(value: unknown): value is SlackEventCallback {
  if (!isRecord(value) || value.type !== "event_callback") {
    return false;
  }
  return typeof value.event_id === "string" && isRecord(value.event);
}

function asInteractivityPayload(value: unknown): SlackInteractivityPayload | undefined {
  if (
    !isRecord(value) ||
    (value.type !== "shortcut" && value.type !== "message_action" && value.type !== "block_actions")
  ) {
    return undefined;
  }
  return value as unknown as SlackInteractivityPayload;
}

function asSlashCommandPayload(value: unknown): SlackSlashCommandPayload | undefined {
  if (
    !isRecord(value)
    || typeof value.command !== "string"
    || typeof value.channel_id !== "string"
    || (value.text !== undefined && typeof value.text !== "string")
  ) {
    return undefined;
  }
  return value as unknown as SlackSlashCommandPayload;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
