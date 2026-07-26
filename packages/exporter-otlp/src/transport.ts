// SPDX-License-Identifier: MIT
import { OtlpExporterError, throwIfAborted } from "./errors.js";

export interface OtlpTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

export interface OtlpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OtlpTransport {
  send(request: OtlpTransportRequest): Promise<OtlpTransportResponse>;
}

export class FetchOtlpTransport implements OtlpTransport {
  async send(request: OtlpTransportRequest): Promise<OtlpTransportResponse> {
    throwIfAborted(request.signal);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: Buffer.from(request.body),
        redirect: "manual",
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw new OtlpExporterError("OTLP_ABORTED", "The OTLP request was aborted.", error);
      }
      throw new OtlpExporterError("OTLP_HTTP_FAILED", "The OTLP collector request failed.", error);
    }
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    const location = response.headers.get("location");
    if (location !== null) headers.location = location;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) headers["retry-after"] = retryAfter;
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, headers };
  }
}
