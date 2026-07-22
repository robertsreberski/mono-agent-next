import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiscoveredOperatorAgent } from "../discovery.js";

export async function temporaryRoot(prefix = "mono-agent-web-"): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export function fakeDiscoveredAgent(overrides: Partial<DiscoveredOperatorAgent> = {}): DiscoveredOperatorAgent {
  return {
    source: {
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: "/tmp/agent-one-artifacts",
      pid: 123,
      status: "running",
      health: "running",
      startedAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T09:00:00.000Z",
      warnings: [],
    },
    baseUrl: "http://127.0.0.1:45123/gui",
    ...overrides,
  };
}

export function operatorFetch(options: {
  readonly turns?: (body: Record<string, unknown>) => string | ReadableStream<Uint8Array>;
  readonly supportsAttachments?: boolean;
  readonly supportsHistoryAppend?: boolean;
  readonly supportsAskUser?: boolean;
  readonly supportsLiveInput?: boolean;
  readonly pendingAsk?: Record<string, unknown> | null;
  readonly onAskSubmit?: (body: Record<string, unknown>) => void;
  readonly onTurn?: (body: Record<string, unknown>) => void;
  readonly onLiveInput?: (
    conversationId: string,
    body: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly onVerbatim?: (conversationId: string, body: Record<string, unknown>) => void | Promise<void>;
} = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/info")) {
      return Response.json({
        schema: 1,
        label: "Agent One",
        model: "provider/default",
        effort: "medium",
        models: ["provider/default", "provider/fallback"],
        modelOptions: {
          "provider/default": {
            effortLevels: ["low", "medium", "high"],
            reasoning: true,
            contextWindow: 128_000,
          },
          "provider/fallback": { effortLevels: ["low", "high"], reasoning: true },
        },
        capabilities: {
          attachments: options.supportsAttachments ?? true,
          ...(options.supportsHistoryAppend === true ? { historyAppend: true } : {}),
          askUser: options.supportsAskUser ?? false,
          liveInput: options.supportsLiveInput ?? false,
        },
      });
    }
    if (url.endsWith("/v1/turns")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      options.onTurn?.(body);
      const responseBody = options.turns?.(body) ?? [
        JSON.stringify({ kind: "append", delta: "Hello " }),
        JSON.stringify({ kind: "event", event: { type: "assistant_thought", text: "Reasoning" } }),
        JSON.stringify({ kind: "append", delta: "world" }),
        JSON.stringify({ kind: "finish", finalText: "Hello world" }),
        "",
      ].join("\n");
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/cancel")) {
      return Response.json({ cancelled: true }, { status: 202 });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/live-input")) {
      const encodedConversationId = url.slice(
        url.lastIndexOf("/v1/conversations/") + "/v1/conversations/".length,
        -"/live-input".length,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const result = await options.onLiveInput?.(decodeURIComponent(encodedConversationId), body)
        ?? { status: "applied", runId: "run-1" };
      return Response.json(result, { status: 200 });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/verbatim")) {
      const encodedConversationId = url.slice(
        url.lastIndexOf("/v1/conversations/") + "/v1/conversations/".length,
        -"/verbatim".length,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await options.onVerbatim?.(decodeURIComponent(encodedConversationId), body);
      return Response.json({ recorded: true }, { status: 200 });
    }
    if (url.includes("/v1/conversations/") && url.endsWith("/ask")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        options.onAskSubmit?.(body);
        return Response.json({ accepted: true, snapshot: { ...options.pendingAsk, status: "answered" } });
      }
      return Response.json({ ask: options.pendingAsk ?? null });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
