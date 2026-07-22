import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * Serialize spans into a binary OTLP `ExportTraceServiceRequest` (protobuf).
 *
 * Phoenix's `/v1/traces` accepts ONLY `application/x-protobuf` — it parses the
 * body with `ParseFromString` and rejects `application/json` with HTTP 415. We
 * therefore use the official `@opentelemetry/otlp-transformer` protobuf
 * serializer rather than a hand-rolled OTLP/JSON body.
 *
 * `serializeRequest` returns `undefined` only on an internal encode failure;
 * surface that loudly rather than POSTing an empty body.
 */
export function serializeTraceSpans(spans: readonly ReadableSpan[]): Uint8Array {
  const bytes = ProtobufTraceSerializer.serializeRequest(spans as ReadableSpan[]);
  if (bytes === undefined) {
    throw new Error("ProtobufTraceSerializer.serializeRequest returned undefined");
  }
  return bytes;
}
