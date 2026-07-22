import type { WhatsAppAdapter, WhatsAppMessageHandlingResult } from "./adapter.js";
import type { WhatsAppRawMessage, WhatsAppSocketLike } from "./types.js";

export interface WhatsAppEventRunnerOptions {
  socket: WhatsAppSocketLike;
  adapter: WhatsAppAdapter;
  processHistory?: boolean;
  saveCreds?: () => Promise<void> | void;
  onQr?: (qr: string) => void | Promise<void>;
  onConnectionUpdate?: (update: WhatsAppConnectionUpdate) => void | Promise<void>;
  onMessageResult?: (result: WhatsAppMessageHandlingResult) => void | Promise<void>;
  logger?: WhatsAppEventRunnerLogger;
}

export interface WhatsAppEventRunnerStartOptions {
  signal?: AbortSignal;
}

export interface WhatsAppConnectionUpdate {
  connection?: string;
  receivedPendingNotifications?: boolean;
  isNewLogin?: boolean;
  isOnline?: boolean;
  hasQr: boolean;
}

export interface WhatsAppEventRunnerLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

interface MessagesUpsertLike {
  type?: string;
  messages?: WhatsAppRawMessage[];
}

// Malformed/control updates have no chat identity, so keep their legacy FIFO
// ordering on one fallback queue rather than fanning them out unpredictably.
const UNKEYED_MESSAGE_QUEUE = Symbol("unkeyed-message-queue");

type MessageQueueKey = string | typeof UNKEYED_MESSAGE_QUEUE;

export class WhatsAppEventRunner {
  private readonly socket: WhatsAppSocketLike;
  private readonly adapter: WhatsAppAdapter;
  private readonly processHistory: boolean;
  private readonly saveCreds: (() => Promise<void> | void) | undefined;
  private readonly onQr: ((qr: string) => void | Promise<void>) | undefined;
  private readonly onConnectionUpdate:
    | ((update: WhatsAppConnectionUpdate) => void | Promise<void>)
    | undefined;
  private readonly onMessageResult:
    | ((result: WhatsAppMessageHandlingResult) => void | Promise<void>)
    | undefined;
  private readonly logger: WhatsAppEventRunnerLogger | undefined;

  private started = false;
  private readonly processingByChat = new Map<MessageQueueKey, Promise<void>>();
  private readonly pendingProcessing = new Set<Promise<void>>();
  private cleanup: (() => void)[] = [];

  private readonly handleMessagesUpsert = (payload: unknown): void => {
    const dispatch = Promise.resolve()
      .then(() => this.enqueueMessagesUpsert(payload))
      .catch((error: unknown) => this.logProcessingError(error));
    this.pendingProcessing.add(dispatch);
    void dispatch.then(
      () => this.pendingProcessing.delete(dispatch),
      () => this.pendingProcessing.delete(dispatch),
    );
  };

  private readonly handleCredsUpdate = (): void => {
    if (this.saveCreds === undefined) {
      return;
    }
    Promise.resolve()
      .then(async () => this.saveCreds?.())
      .catch((error: unknown) => {
        this.logger?.error?.("WhatsApp creds.update save failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  private readonly handleConnectionUpdate = (payload: unknown): void => {
    const update = normalizeConnectionUpdate(payload);
    this.logger?.info?.("WhatsApp connection update.", {
      connection: update.connection,
      receivedPendingNotifications: update.receivedPendingNotifications,
      isNewLogin: update.isNewLogin,
      isOnline: update.isOnline,
      hasQr: update.hasQr,
    });

    const qr = qrFromConnectionUpdate(payload);
    if (qr !== undefined && this.onQr !== undefined) {
      Promise.resolve(this.onQr(qr)).catch((error: unknown) => {
        this.logger?.error?.("WhatsApp QR callback failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (this.onConnectionUpdate !== undefined) {
      Promise.resolve(this.onConnectionUpdate(update)).catch((error: unknown) => {
        this.logger?.error?.("WhatsApp connection update callback failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  private readonly handleAbort = (): void => {
    this.stop();
  };

  constructor(options: WhatsAppEventRunnerOptions) {
    this.socket = options.socket;
    this.adapter = options.adapter;
    this.processHistory = options.processHistory === true;
    this.saveCreds = options.saveCreds;
    this.onQr = options.onQr;
    this.onConnectionUpdate = options.onConnectionUpdate;
    this.onMessageResult = options.onMessageResult;
    this.logger = options.logger;
  }

  start(options: WhatsAppEventRunnerStartOptions = {}): void {
    if (this.started) {
      return;
    }
    if (options.signal?.aborted === true) {
      return;
    }
    const ev = this.socket.ev;
    if (ev === undefined) {
      throw new TypeError("WhatsAppEventRunner requires a socket with an event emitter.");
    }

    this.started = true;
    ev.on("messages.upsert", this.handleMessagesUpsert);
    ev.on("creds.update", this.handleCredsUpdate);
    ev.on("connection.update", this.handleConnectionUpdate);
    this.cleanup.push(() => removeListener(ev, "messages.upsert", this.handleMessagesUpsert));
    this.cleanup.push(() => removeListener(ev, "creds.update", this.handleCredsUpdate));
    this.cleanup.push(() => removeListener(ev, "connection.update", this.handleConnectionUpdate));

    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", this.handleAbort, { once: true });
      this.cleanup.push(() => options.signal?.removeEventListener("abort", this.handleAbort));
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    for (const cleanup of this.cleanup.splice(0)) {
      cleanup();
    }
    this.started = false;
  }

  async idle(): Promise<void> {
    while (this.pendingProcessing.size > 0) {
      await Promise.all([...this.pendingProcessing]);
    }
  }

  private enqueueMessagesUpsert(payload: unknown): void {
    if (!isMessagesUpsertLike(payload)) {
      this.enqueueProcessing(UNKEYED_MESSAGE_QUEUE, async () => {
        await this.emitMessageResult({ kind: "ignored", reason: "non_message_update" });
      });
      return;
    }

    if (payload.type !== "notify" && !this.processHistory) {
      this.enqueueProcessing(UNKEYED_MESSAGE_QUEUE, async () => {
        await this.emitMessageResult({ kind: "ignored", reason: "history_sync_ignored" });
      });
      return;
    }

    for (const message of payload.messages ?? []) {
      this.enqueueProcessing(messageQueueKey(message), async () => {
        await this.processMessage(message);
      });
    }
  }

  private enqueueProcessing(key: MessageQueueKey, process: () => Promise<void>): void {
    const previous = this.processingByChat.get(key) ?? Promise.resolve();
    const processing = previous
      .then(process)
      .catch((error: unknown) => this.logProcessingError(error));

    this.processingByChat.set(key, processing);
    this.pendingProcessing.add(processing);
    void processing.then(
      () => this.finishProcessing(key, processing),
      () => this.finishProcessing(key, processing),
    );
  }

  private finishProcessing(key: MessageQueueKey, processing: Promise<void>): void {
    this.pendingProcessing.delete(processing);
    if (this.processingByChat.get(key) === processing) {
      this.processingByChat.delete(key);
    }
  }

  private logProcessingError(error: unknown): void {
    this.logger?.error?.("WhatsApp messages.upsert processing failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async processMessage(message: WhatsAppRawMessage): Promise<void> {
    try {
      const result = await this.adapter.handleMessage(message);
      await this.emitMessageResult(result);
    } catch (error) {
      const result: WhatsAppMessageHandlingResult = { kind: "error", error };
      await this.emitMessageResult(result);
    }
  }

  private async emitMessageResult(result: WhatsAppMessageHandlingResult): Promise<void> {
    if (this.onMessageResult !== undefined) {
      await this.onMessageResult(result);
    }
  }
}

function isMessagesUpsertLike(value: unknown): value is MessagesUpsertLike {
  if (!isRecord(value)) {
    return false;
  }
  const messages = value.messages;
  return messages === undefined || Array.isArray(messages);
}

function messageQueueKey(message: WhatsAppRawMessage): MessageQueueKey {
  try {
    if (!isRecord(message) || !isRecord(message.key)) {
      return UNKEYED_MESSAGE_QUEUE;
    }
    const remoteJid = message.key.remoteJid;
    if (typeof remoteJid !== "string") {
      return UNKEYED_MESSAGE_QUEUE;
    }
    const chatJid = remoteJid.trim();
    return chatJid.length > 0 ? chatJid : UNKEYED_MESSAGE_QUEUE;
  } catch {
    return UNKEYED_MESSAGE_QUEUE;
  }
}

function normalizeConnectionUpdate(payload: unknown): WhatsAppConnectionUpdate {
  const record = isRecord(payload) ? payload : {};
  const update: WhatsAppConnectionUpdate = { hasQr: typeof record.qr === "string" };
  if (typeof record.connection === "string") {
    update.connection = record.connection;
  }
  if (typeof record.receivedPendingNotifications === "boolean") {
    update.receivedPendingNotifications = record.receivedPendingNotifications;
  }
  if (typeof record.isNewLogin === "boolean") {
    update.isNewLogin = record.isNewLogin;
  }
  if (typeof record.isOnline === "boolean") {
    update.isOnline = record.isOnline;
  }
  return update;
}

function qrFromConnectionUpdate(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.qr !== "string") {
    return undefined;
  }
  return payload.qr;
}

function removeListener(
  ev: NonNullable<WhatsAppSocketLike["ev"]>,
  event: string,
  listener: (payload: unknown) => void,
): void {
  if (typeof ev.off === "function") {
    ev.off(event, listener);
    return;
  }
  ev.removeListener?.(event, listener);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
