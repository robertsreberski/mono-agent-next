import type { AgentMessageStream, AgentStreamEvent } from "./index.js";

export interface BufferedMessageStreamOptions {
  /**
   * Build the error thrown when writing after `finish()`. Defaults to a plain
   * Error; adapters pass their own typed error to preserve message/code.
   */
  readonly onClosed?: () => Error;
}

/**
 * Minimal in-memory {@link AgentMessageStream} that just accumulates text.
 * Replaces the identical no-op stream copied into the request/response adapters
 * (openai-api, webhook, cron) that collect a final string rather than streaming.
 */
export class BufferedMessageStream implements AgentMessageStream {
  private currentText = "";
  private done = false;
  private readonly onClosed: () => Error;

  constructor(options: BufferedMessageStreamOptions = {}) {
    this.onClosed =
      options.onClosed ??
      (() => new Error("Cannot write to a finished message stream."));
  }

  /** Trimmed accumulated text. */
  get text(): string {
    return this.currentText.trim();
  }

  async status(_text: string): Promise<void> {}

  async event(_event: AgentStreamEvent): Promise<void> {}

  async append(delta: string): Promise<void> {
    this.assertOpen();
    this.currentText += delta;
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
  }

  async finish(finalText?: string): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }
  }

  private assertOpen(): void {
    if (this.done) {
      throw this.onClosed();
    }
  }
}
