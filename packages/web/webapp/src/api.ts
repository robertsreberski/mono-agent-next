import type {
  Agent,
  Bootstrap,
  StartTurnInput,
  StreamFrame,
  Thread,
  ThreadDetail,
  WebEvent,
} from "./types";
import { serializeInlineTurnRequest } from "./inline-attachments";

const TOKEN_KEY = "mono-agent-web-token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function readToken(): string {
  return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveToken(token: string): void {
  const clean = token.trim();
  if (clean) window.sessionStorage.setItem(TOKEN_KEY, clean);
  else window.sessionStorage.removeItem(TOKEN_KEY);
}

function authenticationHeader(): Record<string, string> {
  const token = readToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  includeAuthentication = true,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(includeAuthentication ? authenticationHeader() : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  return await response.json() as T;
}

export const api = {
  probeBootstrap: (signal?: AbortSignal) =>
    request<Bootstrap>(
      "/api/v1/bootstrap",
      signal === undefined ? {} : { signal },
      false,
    ),

  bootstrap: (signal?: AbortSignal) =>
    request<Bootstrap>("/api/v1/bootstrap", signal === undefined ? {} : { signal }),

  thread: (threadId: string, signal?: AbortSignal) =>
    request<ThreadDetail>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      signal === undefined ? {} : { signal },
    ),

  createThread: (agentId: string) =>
    request<Thread>("/api/v1/threads", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),

  patchAgent: (agentId: string, pinned: boolean) =>
    request<Agent>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),

  patchThread: (threadId: string, patch: { readonly title?: string; readonly archived?: boolean }) =>
    request<Thread>(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteThread: (threadId: string) =>
    request<{ readonly deleted: true }>(`/api/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      body: "{}",
    }),

  cancel: (threadId: string) =>
    request<ThreadDetail>(`/api/v1/threads/${encodeURIComponent(threadId)}/cancel`, {
      method: "POST",
      body: "{}",
    }),

  liveInput: (threadId: string, text: string) =>
    request<{ readonly status: string }>(`/api/v1/threads/${encodeURIComponent(threadId)}/live-input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  answerAsk: (
    threadId: string,
    interactionId: string,
    answers: Readonly<Record<string, readonly string[]>>,
  ) =>
    request<{ readonly status: string }>(`/api/v1/threads/${encodeURIComponent(threadId)}/ask`, {
      method: "POST",
      body: JSON.stringify({ interactionId, answers }),
    }),
};

export async function streamTurn(
  threadId: string,
  input: StartTurnInput,
  onFrame: (frame: StreamFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = serializeInlineTurnRequest(input);
  const response = await fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/turns`, {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      ...authenticationHeader(),
      "content-type": "application/json",
    },
    body,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw await responseError(response);
  if (response.body === null) throw new ApiError("The response stream is unavailable.", 502);
  await parseLineStream(response.body, (line) => {
    const frame = JSON.parse(line) as StreamFrame;
    onFrame(frame);
  });
}

export async function subscribeEvents(
  afterRevision: number | undefined,
  onEvent: (event: WebEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/v1/events", {
    headers: {
      accept: "text/event-stream",
      ...authenticationHeader(),
      ...(afterRevision === undefined ? {} : { "last-event-id": String(afterRevision) }),
    },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await responseError(response);
  if (response.body === null) throw new ApiError("The event stream is unavailable.", 502);
  await parseEventStream(response.body, onEvent);
}

export async function parseEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: WebEvent) => void,
): Promise<void> {
  await parseBlockStream(stream, (block) => {
    if (block.startsWith(":")) return;
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    onEvent(JSON.parse(data) as WebEvent);
  });
}

async function parseLineStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
      if (done) break;
    }
    if (pending.trim()) onLine(pending);
  } finally {
    reader.releaseLock();
  }
}

async function parseBlockStream(
  stream: ReadableStream<Uint8Array>,
  onBlock: (block: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done }).replace(/\r\n/gu, "\n");
      let separator = pending.indexOf("\n\n");
      while (separator >= 0) {
        const block = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        if (block) onBlock(block);
        separator = pending.indexOf("\n\n");
      }
      if (done) break;
    }
    if (pending.trim()) onBlock(pending);
  } finally {
    reader.releaseLock();
  }
}

async function responseError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim();
  let code: string | undefined;
  try {
    const payload = await response.json() as {
      readonly error?: { readonly message?: string; readonly code?: string } | string;
    };
    if (typeof payload.error === "string") message = payload.error;
    else if (payload.error !== undefined) {
      message = payload.error.message ?? message;
      code = payload.error.code;
    }
  } catch {
    // The status line remains actionable for non-JSON proxy failures.
  }
  return new ApiError(message, response.status, code);
}
