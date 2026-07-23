import type { SlackConfig } from "./config.js";

export interface SlackRemoteFile {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes?: number;
  readonly privateUrl: string;
}

export interface SlackMessageEvent {
  readonly kind: "message";
  readonly envelopeId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly text: string;
  readonly files: readonly SlackRemoteFile[];
  readonly receivedAt: string;
}

export interface SlackActionEvent {
  readonly kind: "action";
  readonly envelopeId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly actionId: string;
  readonly value: string;
  readonly receivedAt: string;
}

export interface SlackShortcutEvent {
  readonly kind: "shortcut";
  readonly envelopeId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly callbackId: string;
  readonly sourceChannelId?: string;
  readonly sourceMessageId?: string;
  readonly sourceThreadId?: string;
  readonly receivedAt: string;
}

export interface SlackHomeOpenedEvent {
  readonly kind: "home-opened";
  readonly envelopeId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly receivedAt: string;
}

export interface SlackHomeActionEvent {
  readonly kind: "home-action";
  readonly envelopeId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly actionId: string;
  readonly receivedAt: string;
}

export type SlackSocketEvent =
  | SlackMessageEvent
  | SlackActionEvent
  | SlackShortcutEvent
  | SlackHomeOpenedEvent
  | SlackHomeActionEvent;
export type SlackSocketEventHandler = (event: SlackSocketEvent) => void | Promise<void>;

export interface SlackSocketFailure {
  readonly reason: "closed" | "error" | "ingestion-failed" | "ack-failed";
  readonly summary: string;
}

export type SlackSocketFailureHandler = (failure: SlackSocketFailure) => void;

export interface SlackSocketTransport {
  /** The event handler must durably admit supported work before it resolves. */
  start(
    handler: SlackSocketEventHandler,
    signal: AbortSignal,
    onFailure?: SlackSocketFailureHandler,
  ): Promise<void>;
  stop(): Promise<void>;
}

export type SlackSocketTransportFactory = (config: SlackConfig) => SlackSocketTransport;

export function createSlackSocketModeTransport(config: SlackConfig, fetchImpl: typeof fetch = fetch): SlackSocketTransport {
  let socket: WebSocket | undefined;
  let stopped = false;
  return {
    async start(handler, signal, onFailure) {
      if (socket !== undefined) return;
      const startSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const response = await fetchImpl("https://slack.com/api/apps.connections.open", { method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.appToken}`, "content-type": "application/x-www-form-urlencoded" }, signal: startSignal });
      const value = await boundedJson(response, 256 * 1024);
      if (!response.ok || !record(value) || value.ok !== true || typeof value.url !== "string") throw new Error(`Slack Socket Mode connection failed with HTTP ${response.status}.`);
      const connectionUrl = slackSocketUrl(value.url);
      const next = new WebSocket(connectionUrl);
      socket = next;
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            startSignal.removeEventListener("abort", aborted);
            next.removeEventListener("open", opened);
            next.removeEventListener("error", failed);
          };
          const aborted = (): void => { cleanup(); next.close(); reject(startSignal.reason instanceof Error ? startSignal.reason : new Error("Slack start aborted.")); };
          const opened = (): void => { cleanup(); resolve(); };
          const failed = (): void => { cleanup(); reject(new Error("Slack Socket Mode connection failed.")); };
          startSignal.addEventListener("abort", aborted, { once: true });
          next.addEventListener("open", opened, { once: true });
          next.addEventListener("error", failed, { once: true });
        });
      } catch (error) {
        next.close();
        socket = undefined;
        throw error;
      }
      stopped = false;
      let failureReported = false;
      const reportFailure = (failure: SlackSocketFailure): void => {
        if (stopped || signal.aborted || failureReported) return;
        failureReported = true;
        try { onFailure?.(failure); } catch { /* Lifecycle observers cannot mask transport failure. */ }
      };
      next.addEventListener("error", () => {
        reportFailure({ reason: "error", summary: "Slack Socket Mode connection failed." });
        try { next.close(1011, "socket error"); } catch { /* Failure is already reported. */ }
      });
      next.addEventListener("close", () => {
        if (socket === next) socket = undefined;
        reportFailure({ reason: "closed", summary: "Slack Socket Mode connection closed unexpectedly." });
      });
      next.addEventListener("message", (message) => {
        if (stopped) return;
        if (typeof message.data !== "string" || message.data.length > 2 * 1024 * 1024) {
          reportFailure({ reason: "ingestion-failed", summary: "Slack Socket Mode received an invalid frame." });
          try { next.close(1009, "invalid frame"); } catch { /* Failure is already reported. */ }
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(message.data) as unknown; } catch {
          reportFailure({ reason: "ingestion-failed", summary: "Slack Socket Mode received invalid JSON." });
          try { next.close(1007, "invalid json"); } catch { /* Failure is already reported. */ }
          return;
        }
        if (!record(parsed)) return;
        if (parsed.type === "disconnect") {
          reportFailure({ reason: "closed", summary: "Slack Socket Mode requested a disconnect." });
          try { next.close(1012, "disconnect requested"); } catch { /* Failure is already reported. */ }
          return;
        }
        if (typeof parsed.envelope_id !== "string") return;
        const event = parseEnvelope(parsed);
        void (async () => {
          try {
            if (event !== undefined) await handler(event);
          } catch {
            reportFailure({
              reason: "ingestion-failed",
              summary: "Slack Socket Mode could not durably admit an envelope.",
            });
            try { next.close(1011, "ingestion failed"); } catch { /* Failure is already reported. */ }
            return;
          }
          if (stopped || signal.aborted || next.readyState !== WebSocket.OPEN) return;
          try {
            next.send(JSON.stringify({ envelope_id: parsed.envelope_id }));
          } catch {
            reportFailure({
              reason: "ack-failed",
              summary: "Slack Socket Mode could not acknowledge a durably admitted envelope.",
            });
            try { next.close(1011, "ack failed"); } catch { /* Failure is already reported. */ }
          }
        })();
      });
      if (signal.aborted) {
        stopped = true;
        next.close();
      } else {
        signal.addEventListener("abort", () => {
          stopped = true;
          next.close();
        }, { once: true });
      }
    },
    async stop() { stopped = true; socket?.close(); socket = undefined; },
  };
}

function parseEnvelope(envelope: Record<string, unknown>): SlackSocketEvent | undefined {
  const envelopeId = envelope.envelope_id as string;
  if (envelope.type === "events_api" && record(envelope.payload)) {
    const payload = envelope.payload;
    const event = record(payload.event) ? payload.event : undefined;
    if (typeof payload.team_id !== "string" || event === undefined) return undefined;
    if (event.type === "app_home_opened" && typeof event.user === "string") {
      return {
        kind: "home-opened",
        envelopeId,
        teamId: payload.team_id,
        userId: event.user,
        receivedAt: new Date().toISOString(),
      };
    }
    if (event.type !== "message" || event.subtype !== undefined || typeof event.channel !== "string" || typeof event.ts !== "string" || typeof event.user !== "string") return undefined;
    return { kind: "message", envelopeId, teamId: payload.team_id, channelId: event.channel, messageId: event.ts, threadId: typeof event.thread_ts === "string" ? event.thread_ts : event.ts, userId: event.user, text: typeof event.text === "string" ? event.text : "", files: Object.freeze(parseFiles(event.files)), receivedAt: new Date().toISOString() };
  }
  if (envelope.type === "interactive" && record(envelope.payload)) {
    const payload = envelope.payload;
    if ((payload.type === "shortcut" || payload.type === "message_action")
      && record(payload.team)
      && record(payload.user)
      && typeof payload.team.id === "string"
      && typeof payload.user.id === "string"
      && typeof payload.callback_id === "string") {
      const channelId = record(payload.channel) && typeof payload.channel.id === "string"
        ? payload.channel.id
        : undefined;
      const messageId = record(payload.message) && typeof payload.message.ts === "string"
        ? payload.message.ts
        : undefined;
      const threadId = record(payload.message) && typeof payload.message.thread_ts === "string"
        ? payload.message.thread_ts
        : messageId;
      return {
        kind: "shortcut",
        envelopeId,
        teamId: payload.team.id,
        userId: payload.user.id,
        callbackId: payload.callback_id,
        ...(channelId === undefined ? {} : { sourceChannelId: channelId }),
        ...(messageId === undefined ? {} : { sourceMessageId: messageId }),
        ...(threadId === undefined ? {} : { sourceThreadId: threadId }),
        receivedAt: new Date().toISOString(),
      };
    }
    const action = Array.isArray(payload.actions) && record(payload.actions[0]) ? payload.actions[0] : undefined;
    if (record(payload.team)
      && record(payload.user)
      && action !== undefined
      && typeof payload.team.id === "string"
      && typeof payload.user.id === "string"
      && typeof action.action_id === "string"
      && (!record(payload.channel) || !record(payload.message))) {
      return {
        kind: "home-action",
        envelopeId,
        teamId: payload.team.id,
        userId: payload.user.id,
        actionId: action.action_id,
        receivedAt: new Date().toISOString(),
      };
    }
    if (!record(payload.team) || !record(payload.channel) || !record(payload.user) || !record(payload.message) || action === undefined || typeof payload.team.id !== "string" || typeof payload.channel.id !== "string" || typeof payload.user.id !== "string" || typeof payload.message.ts !== "string" || typeof action.action_id !== "string" || typeof action.value !== "string") return undefined;
    return { kind: "action", envelopeId, teamId: payload.team.id, channelId: payload.channel.id, messageId: payload.message.ts, threadId: typeof payload.message.thread_ts === "string" ? payload.message.thread_ts : payload.message.ts, userId: payload.user.id, actionId: action.action_id, value: action.value, receivedAt: new Date().toISOString() };
  }
  return undefined;
}

function parseFiles(value: unknown): SlackRemoteFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!record(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url_private_download !== "string") return [];
    return [{ id: item.id, name: safeName(item.name), mediaType: typeof item.mimetype === "string" ? item.mimetype : "application/octet-stream", ...(Number.isSafeInteger(item.size) ? { sizeBytes: item.size as number } : {}), privateUrl: item.url_private_download }];
  });
}

function safeName(value: string): string { const result = value.replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, "_").trim() ?? "attachment"; return (result || "attachment").slice(0, 255); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function boundedJson(response: Response, max: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > max)) {
    await response.body?.cancel();
    throw new Error("Slack response exceeds the byte limit.");
  }
  if (response.body === null) throw new Error("Slack response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error("Slack response exceeds the byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function slackSocketUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Slack Socket Mode returned an invalid WebSocket URL."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "wss:" || (host !== "slack.com" && !host.endsWith(".slack.com")) || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Slack Socket Mode returned an untrusted WebSocket URL.");
  }
  return url.toString();
}
