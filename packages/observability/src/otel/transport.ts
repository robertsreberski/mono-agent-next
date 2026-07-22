/**
 * Native-fetch OTLP/HTTP+protobuf POST. Uses the `fetch` + `AbortController` +
 * `setTimeout`/`clearTimeout` idiom already used elsewhere in the repo
 * (memory-bujo/ollama-llm.ts). The caller (the composite recorder's best-effort
 * wrapper) is responsible for swallowing failures; this function either resolves
 * with `{ ok, status }` or throws.
 *
 * Phoenix's `/v1/traces` accepts ONLY `application/x-protobuf`; the body is the
 * binary `ExportTraceServiceRequest` produced by `serializeTraceSpans`.
 */

export interface PostOtlpProtobufInput {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface PostOtlpProtobufResult {
  readonly ok: boolean;
  readonly status: number;
}

export async function postOtlpProtobuf(input: PostOtlpProtobufInput): Promise<PostOtlpProtobufResult> {
  const { endpoint, headers, body, timeoutMs } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is not available; supply fetchImpl");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-protobuf",
        ...(headers ?? {}),
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OTLP export failed: ${endpoint} responded ${response.status}`);
    }
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
