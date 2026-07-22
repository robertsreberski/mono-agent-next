import type { JsonValue, RuntimeUsage } from "@mono-agent/module-sdk";

import type {
  ClaudeTransport,
  ClaudeTransportEvents,
  ClaudeTransportRequest,
  ClaudeTransportResult,
} from "./transport.js";

interface QueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
}

type QueryFactory = (input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => QueryLike;

class InputQueue implements AsyncIterable<unknown> {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  #closed = false;

  push(value: unknown): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<unknown>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function usage(value: unknown): RuntimeUsage | undefined {
  const item = record(value);
  const inputTokens = Number(item.input_tokens ?? item.inputTokens ?? 0);
  const outputTokens = Number(item.output_tokens ?? item.outputTokens ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  const cacheRead = Number(item.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(item.cache_creation_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(Number.isFinite(cacheRead) && cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(Number.isFinite(cacheWrite) && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function assistantText(message: Record<string, unknown>): string {
  const body = record(message.message);
  const content = Array.isArray(body.content) ? body.content : [];
  return content.map((part) => {
    const block = record(part);
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
}

function userMessage(text: string, receivedAt?: string): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(receivedAt === undefined ? {} : { timestamp: receivedAt, priority: "now" }),
  };
}

async function defaultQueryFactory(input: Parameters<QueryFactory>[0]): Promise<QueryLike> {
  // Keep import evaluation out of module import and schema parsing. This also
  // gives tests a complete SDK seam without loading the native package.
  const packageName: string = "@anthropic-ai/claude-agent-sdk";
  const sdk = await import(packageName) as { query?: QueryFactory };
  if (typeof sdk.query !== "function") throw new Error("Claude Agent SDK does not export query()");
  return sdk.query(input);
}

export interface ClaudeSdkTransportOptions {
  readonly query?: (input: Parameters<QueryFactory>[0]) => QueryLike | Promise<QueryLike>;
}

export function createClaudeSdkTransport(options: ClaudeSdkTransportOptions = {}): ClaudeTransport {
  const createQuery = options.query ?? defaultQueryFactory;
  return {
    async run(request: ClaudeTransportRequest, events: ClaudeTransportEvents): Promise<ClaudeTransportResult> {
      const input = new InputQueue();
      input.push(userMessage(request.prompt));
      const abortController = new AbortController();
      const query = await createQuery({
        prompt: input,
        options: {
          abortController,
          cwd: request.cwd,
          env: request.env,
          model: request.model,
          includePartialMessages: true,
          permissionMode: "dontAsk",
          settingSources: [],
          tools: [],
          ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
          ...(request.sessionId === undefined ? {} : { resume: request.sessionId }),
          ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
          ...(request.responseSchema === undefined ? {} : { outputFormat: { type: "json_schema", schema: request.responseSchema } }),
        },
      });
      events.control({
        async interrupt() { await query.interrupt(); },
        async sendInput(text, receivedAt) { return input.push(userMessage(text, receivedAt)); },
      });
      const onAbort = (): void => {
        abortController.abort(request.signal.reason);
        input.close();
        void query.interrupt().catch(() => undefined);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();

      let streamed = "";
      let finalText = "";
      let sessionId: string | undefined;
      let finalUsage: RuntimeUsage | undefined;
      let structuredOutput: JsonValue | undefined;
      let stopReason: string | undefined;
      try {
        for await (const raw of query) {
          const message = record(raw);
          if (typeof message.session_id === "string" && message.session_id !== sessionId) {
            sessionId = message.session_id;
            await events.session(sessionId);
          }
          if (message.type === "stream_event") {
            const event = record(message.event);
            if (event.type === "content_block_delta") {
              const delta = record(event.delta);
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                streamed += delta.text;
                await events.text(delta.text);
              } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                await events.thinking(delta.thinking);
              }
            }
          } else if (message.type === "assistant") {
            finalText += assistantText(message);
          } else if (message.type === "result") {
            input.close();
            const measured = usage(message.usage);
            if (measured !== undefined) { finalUsage = measured; await events.usage(measured); }
            if (typeof message.session_id === "string") sessionId = message.session_id;
            if (typeof message.result === "string") finalText = message.result;
            if (message.structured_output !== undefined) structuredOutput = message.structured_output as JsonValue;
            stopReason = typeof message.stop_reason === "string" ? message.stop_reason : typeof message.subtype === "string" ? message.subtype : undefined;
            if (message.subtype !== "success") {
              const errors = Array.isArray(message.errors) ? message.errors.join("; ") : "Claude SDK turn failed";
              throw new Error(errors);
            }
          }
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        input.close();
        query.close();
      }
      if (sessionId === undefined) throw new Error("Claude SDK completed without a session id");
      return {
        text: streamed === "" ? finalText : streamed,
        sessionId,
        ...(finalUsage === undefined ? {} : { usage: finalUsage }),
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
        ...(stopReason === undefined ? {} : { stopReason }),
      };
    },
  };
}
