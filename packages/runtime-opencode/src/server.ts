const DENY_ALL_RULE = Object.freeze({
  permission: "*",
  pattern: "*",
  action: "deny",
} as const);

export const OPEN_CODE_DENY_ALL_RULESET = Object.freeze([DENY_ALL_RULE]);
export const OPEN_CODE_PROMPT_TOOLS = Object.freeze({ "*": false } as const);

type Fetch = typeof globalThis.fetch;

interface OpenCodeServerClientOptions {
  readonly baseUrl: URL;
  readonly username: string;
  readonly password: string;
  readonly directory: string;
  readonly requestTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly fetch?: Fetch;
}

export interface OpenCodeServerSession {
  readonly id: string;
  readonly permission: readonly unknown[];
}

export interface OpenCodeServerEvent {
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface OpenCodeEventSubscription {
  readonly connected: Promise<void>;
  readonly done: Promise<void>;
  close(reason?: unknown): void;
}

export class OpenCodeServerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeServerHttpError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "operation aborted",
  );
  error.name = "AbortError";
  return error;
}

function boundedDeadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(abortError(parent?.reason));
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`${label} timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  timer.unref?.();
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      throw new Error(`OpenCode server response exceeds ${maxBytes} bytes`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`OpenCode server response exceeds ${maxBytes} bytes`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength === 0) throw new Error(`${label} returned an empty response`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function isDenyAllRule(value: unknown): boolean {
  const candidate = record(value);
  return candidate.permission === "*"
    && candidate.pattern === "*"
    && candidate.action === "deny";
}

function session(value: unknown, label: string): OpenCodeServerSession {
  const candidate = record(value);
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error(`${label} did not return a session id`);
  }
  if (candidate.permission !== undefined && !Array.isArray(candidate.permission)) {
    throw new Error(`${label} returned invalid session permissions`);
  }
  return {
    id: candidate.id,
    permission: candidate.permission ?? [],
  };
}

function denyAllSession(
  value: OpenCodeServerSession,
  label: string,
): OpenCodeServerSession {
  if (
    value.permission.length === 0
    || !isDenyAllRule(value.permission[value.permission.length - 1])
  ) {
    throw new Error(`${label} did not retain an effective deny-all session permission`);
  }
  return value;
}

function exactDenyAllSession(
  value: OpenCodeServerSession,
  label: string,
): OpenCodeServerSession {
  if (value.permission.length !== 1 || !isDenyAllRule(value.permission[0])) {
    throw new Error(`${label} did not return the exact deny-all permission set`);
  }
  return value;
}

function modelReference(model: string): {
  readonly providerID: string;
  readonly modelID: string;
} {
  const slash = model.indexOf("/");
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

export class OpenCodeServerClient {
  readonly #baseUrl: URL;
  readonly #authorization: string;
  readonly #directory: string;
  readonly #requestTimeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #fetch: Fetch;

  constructor(options: OpenCodeServerClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#authorization = `Basic ${Buffer.from(
      `${options.username}:${options.password}`,
      "utf8",
    ).toString("base64")}`;
    this.#directory = options.directory;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async health(signal?: AbortSignal): Promise<string> {
    const value = record(await this.#json(
      "/global/health",
      { method: "GET" },
      signal,
      "OpenCode server health check",
    ));
    if (value.healthy !== true || typeof value.version !== "string") {
      throw new Error("OpenCode server health check returned an invalid response");
    }
    return value.version;
  }

  async createSession(
    agent: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerSession> {
    const selected = modelReference(model);
    return exactDenyAllSession(session(await this.#json(
      "/session",
      {
        method: "POST",
        body: JSON.stringify({
          agent,
          model: {
            id: selected.modelID,
            providerID: selected.providerID,
          },
          permission: OPEN_CODE_DENY_ALL_RULESET,
        }),
      },
      signal,
      "OpenCode session creation",
    ), "OpenCode session creation"), "OpenCode session creation");
  }

  async secureSession(sessionId: string, signal?: AbortSignal): Promise<OpenCodeServerSession> {
    const current = session(await this.#json(
      `/session/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      signal,
      "OpenCode session lookup",
    ), "OpenCode session lookup");
    if (isDenyAllRule(current.permission[current.permission.length - 1])) return current;
    return denyAllSession(session(await this.#json(
      `/session/${encodeURIComponent(sessionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ permission: OPEN_CODE_DENY_ALL_RULESET }),
      },
      signal,
      "OpenCode session permission update",
    ), "OpenCode session permission update"), "OpenCode session permission update");
  }

  async promptAsync(
    sessionId: string,
    input: {
      readonly model: string;
      readonly text: string;
      readonly agent: string;
      readonly variant?: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#noContent(
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: "POST",
        body: JSON.stringify({
          agent: input.agent,
          model: modelReference(input.model),
          parts: [{ type: "text", text: input.text }],
          tools: OPEN_CODE_PROMPT_TOOLS,
          ...(input.variant === undefined ? {} : { variant: input.variant }),
        }),
      },
      signal,
      "OpenCode async prompt",
    );
  }

  async abortSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#json(
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
      signal,
      "OpenCode session abort",
    );
    if (result !== true) {
      throw new Error("OpenCode session abort returned an invalid response");
    }
  }

  subscribe(
    signal: AbortSignal,
    onEvent: (event: OpenCodeServerEvent) => void | Promise<void>,
  ): OpenCodeEventSubscription {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let resolveConnected!: () => void;
    let rejectConnected!: (error: unknown) => void;
    let connectedSettled = false;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    const done = (async () => {
      try {
        const deadline = boundedDeadlineSignal(
          combined,
          this.#requestTimeoutMs,
          "OpenCode event subscription",
        );
        let response: Response;
        try {
          response = await this.#request(
            "/event",
            { method: "GET", headers: { Accept: "text/event-stream" } },
            AbortSignal.any([combined, deadline.signal]),
            "OpenCode event subscription",
          );
        } finally {
          deadline.dispose();
        }
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.startsWith("text/event-stream")) {
          throw new Error("OpenCode event subscription did not return text/event-stream");
        }
        if (response.body === null) {
          throw new Error("OpenCode event subscription returned no body");
        }
        const reader = response.body.getReader();
        let pending = Buffer.alloc(0);
        let dataLines: string[] = [];
        let eventBytes = 0;
        const deliver = async (): Promise<void> => {
          if (dataLines.length === 0) return;
          const raw = dataLines.join("\n");
          dataLines = [];
          eventBytes = 0;
          let value: unknown;
          try {
            value = JSON.parse(raw) as unknown;
          } catch {
            throw new Error("OpenCode event stream emitted invalid JSON");
          }
          const candidate = record(value);
          if (typeof candidate.type !== "string") {
            throw new Error("OpenCode event stream emitted an invalid event");
          }
          const event: OpenCodeServerEvent = {
            type: candidate.type,
            properties: record(candidate.properties),
          };
          if (event.type === "server.connected" && !connectedSettled) {
            connectedSettled = true;
            resolveConnected();
          }
          await onEvent(event);
        };
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = Buffer.from(
              result.value.buffer,
              result.value.byteOffset,
              result.value.byteLength,
            );
            pending = pending.length === 0
              ? Buffer.from(chunk)
              : Buffer.concat([pending, chunk], pending.length + chunk.length);
            if (pending.length > this.#maxFrameBytes && !pending.includes(0x0a)) {
              throw new Error(
                `OpenCode event stream line exceeds ${this.#maxFrameBytes} bytes`,
              );
            }
            while (true) {
              const newline = pending.indexOf(0x0a);
              if (newline < 0) break;
              let line = pending.subarray(0, newline);
              pending = pending.subarray(newline + 1);
              if (line.length > 0 && line[line.length - 1] === 0x0d) {
                line = line.subarray(0, line.length - 1);
              }
              if (line.length > this.#maxFrameBytes) {
                throw new Error(
                  `OpenCode event stream line exceeds ${this.#maxFrameBytes} bytes`,
                );
              }
              if (line.length === 0) {
                await deliver();
                continue;
              }
              const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
              if (!text.startsWith("data:")) continue;
              const data = text.slice(5).replace(/^ /u, "");
              eventBytes += line.byteLength + 1;
              if (eventBytes > this.#maxFrameBytes) {
                throw new Error(
                  `OpenCode event stream event exceeds ${this.#maxFrameBytes} bytes`,
                );
              }
              dataLines.push(data);
            }
            if (pending.length > this.#maxFrameBytes) {
              throw new Error(
                `OpenCode event stream line exceeds ${this.#maxFrameBytes} bytes`,
              );
            }
          }
          if (pending.length > 0 || dataLines.length > 0) {
            throw new Error("OpenCode event stream ended with an incomplete event");
          }
          throw new Error("OpenCode event stream ended unexpectedly");
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        if (!connectedSettled) {
          connectedSettled = true;
          rejectConnected(error);
        }
        throw error;
      }
    })();
    return {
      connected,
      done,
      close(reason?: unknown) {
        controller.abort(abortError(reason));
      },
    };
  }

  async #json(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<unknown> {
    const deadline = boundedDeadlineSignal(signal, this.#requestTimeoutMs, label);
    try {
      const response = await this.#request(path, init, deadline.signal, label);
      return parseJson(
        await readBoundedBody(response, this.#maxFrameBytes),
        label,
      );
    } finally {
      deadline.dispose();
    }
  }

  async #noContent(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<void> {
    const deadline = boundedDeadlineSignal(signal, this.#requestTimeoutMs, label);
    try {
      const response = await this.#request(path, init, deadline.signal, label);
      if (response.status !== 204) {
        await response.body?.cancel();
        throw new Error(`${label} returned HTTP ${response.status}; expected 204`);
      }
      if (response.body !== null) {
        await readBoundedBody(response, this.#maxFrameBytes);
      }
    } finally {
      deadline.dispose();
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.#authorization);
    headers.set("X-OpenCode-Directory", this.#directory);
    headers.set("Cache-Control", "no-store");
    if (init.body !== undefined && init.body !== null) {
      headers.set("Content-Type", "application/json");
    }
    const response = await this.#fetch(
      new URL(path, this.#baseUrl),
      {
        ...init,
        headers,
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenCodeServerHttpError(
        response.status,
        `${label} failed with HTTP ${response.status}`,
      );
    }
    return response;
  }
}
