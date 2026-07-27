// SPDX-License-Identifier: MIT
import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue, RuntimeUsage } from "@mono-agent/module-sdk";

import { record, usage } from "./jsonl.js";
import type {
  ClaudeTransport,
  ClaudeTransportEvents,
  ClaudeTransportRequest,
  ClaudeTransportResult,
} from "./transport.js";
import {
  ClaudeSessionUnavailableError,
  isClaudeSessionUnavailable,
} from "./transport.js";

const SDK_INTERRUPT_GRACE_MS = 1_000;
const QUERY_CREATION_ABORTED = Symbol("query-creation-aborted");

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
  readonly spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
}

export function createClaudeSdkTransport(options: ClaudeSdkTransportOptions = {}): ClaudeTransport {
  const createQuery = options.query ?? defaultQueryFactory;
  return {
    async run(request: ClaudeTransportRequest, events: ClaudeTransportEvents): Promise<ClaudeTransportResult> {
      const input = new InputQueue();
      input.push(userMessage(request.prompt));
      const abortController = new AbortController();
      let query: QueryLike | undefined;
      let closeRequested = false;
      let queryClosed = false;
      let queryCloseError: unknown;
      const closeQuery = (): void => {
        closeRequested = true;
        if (query === undefined || queryClosed) return;
        queryClosed = true;
        try {
          query.close();
        } catch (error) {
          queryCloseError = error;
        }
      };
      let interruptPromise: Promise<unknown> | undefined;
      const interruptQuery = (): Promise<void> => {
        if (query === undefined) return Promise.resolve();
        if (interruptPromise === undefined) {
          const ownedQuery = query;
          const rawInterrupt = Promise.resolve().then(async () => ownedQuery.interrupt());
          void rawInterrupt.catch(() => undefined);
          let timer!: NodeJS.Timeout;
          const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SDK_INTERRUPT_GRACE_MS);
          });
          interruptPromise = Promise.race([
            rawInterrupt.then(() => undefined),
            deadline,
          ]).finally(() => {
            clearTimeout(timer);
            closeQuery();
          });
          void interruptPromise.catch(() => undefined);
        }
        return interruptPromise.then(() => undefined);
      };
      let resolveCreationAbort!: (value: typeof QUERY_CREATION_ABORTED) => void;
      const creationAbort = new Promise<typeof QUERY_CREATION_ABORTED>((resolve) => {
        resolveCreationAbort = resolve;
      });
      const onAbort = (): void => {
        const reason = request.signal.reason
          ?? new DOMException("Aborted", "AbortError");
        abortController.abort(reason);
        input.close();
        closeRequested = true;
        resolveCreationAbort(QUERY_CREATION_ABORTED);
        if (query !== undefined) void interruptQuery().catch(() => undefined);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      let primaryFailure = false;
      try {
        if (request.signal.aborted) {
          onAbort();
          throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        const creation = Promise.resolve().then(async () => createQuery({
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
            ...(options.spawnClaudeCodeProcess === undefined
              ? {}
              : { spawnClaudeCodeProcess: options.spawnClaudeCodeProcess }),
            ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
            ...(request.sessionId === undefined ? {} : { resume: request.sessionId }),
            ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.responseSchema === undefined ? {} : { outputFormat: { type: "json_schema", schema: request.responseSchema } }),
          },
        })).then((created) => {
          query = created;
          if (closeRequested) {
            let lateInterrupt: Promise<unknown>;
            try {
              lateInterrupt = Promise.resolve(created.interrupt());
            } catch (error) {
              lateInterrupt = Promise.reject(error);
            }
            void lateInterrupt.catch(() => undefined);
            closeQuery();
          }
          return created;
        });
        void creation.catch(() => undefined);
        const created = await Promise.race([creation, creationAbort]);
        if (created === QUERY_CREATION_ABORTED) {
          throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        query = created;
        if (request.signal.aborted) {
          throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        events.control({
          interrupt: interruptQuery,
          async sendInput(text, receivedAt) { return input.push(userMessage(text, receivedAt)); },
        });

        let streamed = "";
        let finalText = "";
        let sessionId: string | undefined;
        let finalUsage: RuntimeUsage | undefined;
        let structuredOutput: JsonValue | undefined;
        let stopReason: string | undefined;
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
              const failures = Array.isArray(message.errors)
                ? message.errors.filter((value): value is string => typeof value === "string")
                : [];
              if (
                failures.length === 1
                && isClaudeSessionUnavailable(failures[0], request.sessionId)
              ) {
                throw new ClaudeSessionUnavailableError();
              }
              throw new Error(
                failures.length > 0
                  ? failures.join("; ")
                  : "Claude SDK turn failed",
              );
            }
          }
        }
        if (sessionId === undefined) throw new Error("Claude SDK completed without a session id");
        return {
          text: streamed === "" ? finalText : streamed,
          sessionId,
          ...(finalUsage === undefined ? {} : { usage: finalUsage }),
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          ...(stopReason === undefined ? {} : { stopReason }),
        };
      } catch (error) {
        primaryFailure = true;
        if (request.signal.aborted) {
          throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        if (isClaudeSessionUnavailable(error, request.sessionId)) {
          throw new ClaudeSessionUnavailableError();
        }
        throw error;
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        input.close();
        closeQuery();
        if (!primaryFailure && queryCloseError !== undefined) throw queryCloseError;
      }
    },
  };
}
