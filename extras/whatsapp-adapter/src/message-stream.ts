import {
  DEFAULT_EMPTY_FINAL_TEXT,
  DEFAULT_MAX_MESSAGE_CHARS,
  normalizeTrailing,
  splitTextByCodePoints,
  type AgentMessageStream,
} from "@mono-agent/agent-contracts";
import type {
  WhatsAppJid,
  WhatsAppRawMessage,
  WhatsAppSocketLike,
} from "./types.js";

export interface WhatsAppMessageStreamOptions {
  socket: WhatsAppSocketLike;
  chatJid: WhatsAppJid;
  initialStatusText?: string;
  sendInitialStatus?: boolean;
  maxMessageChars?: number;
  quotedMessage?: WhatsAppRawMessage;
  logger?: WhatsAppMessageStreamLogger;
}

export interface WhatsAppMessageStreamLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";

export class WhatsAppMessageStream implements AgentMessageStream {
  private readonly socket: WhatsAppSocketLike;
  private readonly chatJid: WhatsAppJid;
  private readonly initialStatusText: string;
  private readonly sendInitialStatus: boolean;
  private readonly maxMessageChars: number;
  private readonly quotedMessage: WhatsAppRawMessage | undefined;
  private readonly logger: WhatsAppMessageStreamLogger | undefined;

  private currentText = "";
  private statusSent = false;
  private finished = false;

  constructor(options: WhatsAppMessageStreamOptions) {
    this.socket = options.socket;
    this.chatJid = options.chatJid;
    this.initialStatusText = normalizeWhatsAppText(
      options.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT,
    );
    this.sendInitialStatus = options.sendInitialStatus !== false;
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.quotedMessage = options.quotedMessage;
    this.logger = options.logger;

    if (!Number.isInteger(this.maxMessageChars) || this.maxMessageChars < 32) {
      throw new RangeError("maxMessageChars must be an integer of at least 32.");
    }
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    if (!this.sendInitialStatus || this.statusSent) {
      return;
    }

    const statusText = normalizeWhatsAppText(text.length > 0 ? text : this.initialStatusText);
    await this.sendText(statusText);
    this.statusSent = true;
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    if (delta.length === 0) {
      return;
    }
    this.currentText += delta;
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }

    const chunks = splitWhatsAppText(this.currentText, this.maxMessageChars);
    for (const chunk of chunks) {
      await this.sendText(chunk);
    }
  }

  private async sendText(text: string): Promise<void> {
    const options =
      this.quotedMessage !== undefined ? { quoted: this.quotedMessage } : undefined;
    try {
      await this.socket.sendMessage(this.chatJid, { text }, options);
    } catch (error) {
      this.logger?.error?.("WhatsApp stream send failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("Cannot write to a finished WhatsAppMessageStream.");
    }
  }
}

export function splitWhatsAppText(text: string, maxChars: number): string[] {
  return splitTextByCodePoints(
    normalizeTrailing(text, DEFAULT_EMPTY_FINAL_TEXT),
    maxChars,
  );
}

function normalizeWhatsAppText(text: string): string {
  return normalizeTrailing(text, DEFAULT_EMPTY_FINAL_TEXT);
}
