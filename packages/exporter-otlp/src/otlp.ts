// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { JsonValue } from "@mono-agent/module-sdk";
import type { ExportRecord } from "@mono-agent/module-sdk/internal";

import { PACKAGE_VERSION } from "./version.js";

type HrTime = [number, number];
type OtlpAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export interface SequencedExportRecord {
  readonly record: ExportRecord;
  readonly enqueueSequence: bigint;
}

export const OTLP_INSTRUMENTATION_SCOPE = Object.freeze({
  name: "@mono-agent/exporter-otlp",
  version: PACKAGE_VERSION,
});

export function serializeOtlpSpans(
  records: readonly SequencedExportRecord[],
  projectName: string,
): Buffer {
  const resource = {
    attributes: {
      "service.name": "mono-agent",
      "service.namespace": "mono-agent-next",
      "openinference.project.name": projectName,
      "mono.agent.project": projectName,
    },
    schemaUrl: undefined,
  };
  const spans = records.map(({ record, enqueueSequence }): ReadableSpan => {
    const identity = deriveOtlpSpanIdentity(record, enqueueSequence);
    const timestamp = toHrTime(record.timestamp);
    const attributes = mapRecordAttributes(record);
    if (record.body !== undefined) {
      attributes["mono.agent.body"] = JSON.stringify(sortJson(record.body));
    }
    const span = {
      name: record.name,
      kind: 0,
      spanContext: () => ({ ...identity, traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: timestamp,
      endTime: timestamp,
      status: spanStatus(record),
      attributes,
      links: [],
      events: [],
      duration: [0, 0] as HrTime,
      ended: true,
      resource,
      instrumentationScope: OTLP_INSTRUMENTATION_SCOPE,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    return span as unknown as ReadableSpan;
  });

  const encoded = ProtobufTraceSerializer.serializeRequest(spans);
  if (encoded === undefined) {
    throw new Error("OTLP protobuf serialization failed.");
  }
  return Buffer.from(encoded);
}

export function deriveOtlpSpanIdentity(
  record: ExportRecord,
  enqueueSequence: bigint,
): { readonly traceId: string; readonly spanId: string } {
  if (enqueueSequence < 0n) {
    throw new RangeError("OTLP enqueue sequence must not be negative.");
  }
  const digest = createHash("sha256")
    .update("mono-agent.exporter-otlp.span\u0000")
    .update(canonicalJson(record))
    .update("\u0000")
    .update(enqueueSequence.toString(10))
    .digest("hex");
  return {
    traceId: digest.slice(0, 32),
    spanId: digest.slice(32, 48),
  };
}

/**
 * Add stable OpenInference/Phoenix aliases without discarding the bounded
 * source attributes. Explicit semantic attributes always win.
 */
export function mapRecordAttributes(
  record: ExportRecord,
): Record<string, OtlpAttributeValue> {
  const attributes: Record<string, OtlpAttributeValue> =
    Object.create(null) as Record<string, OtlpAttributeValue>;
  for (const [key, value] of Object.entries(record.attributes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
    attributes[key] = toAttributeValue(value);
  }

  aliasString(
    attributes,
    "mono.agent.agent_id",
    record.attributes.agentId,
    record.attributes["mono.agent.agent_id"],
  );
  aliasString(
    attributes,
    "mono.agent.conversation_id",
    record.attributes.conversationId,
    record.attributes["mono.agent.conversation_id"],
  );
  aliasString(
    attributes,
    "mono.agent.runtime",
    record.attributes.runtime,
    record.attributes["mono.agent.runtime"],
  );
  aliasString(
    attributes,
    "mono.agent.model",
    record.attributes.model,
    record.attributes["mono.agent.model"],
  );
  aliasString(
    attributes,
    "mono.agent.status",
    record.attributes.status,
    record.attributes["mono.agent.status"],
  );
  aliasString(
    attributes,
    "llm.model_name",
    record.attributes.model,
    record.attributes["mono.agent.model"],
    record.attributes["llm.model_name"],
  );

  if (typeof attributes["session.id"] !== "string" || attributes["session.id"].length === 0) {
    const sessionId = firstString(
      record.attributes.sessionId,
      record.attributes["session.id"],
      record.attributes["mono.agent.conversation_id"],
      record.attributes.conversationId,
    );
    if (sessionId !== undefined) attributes["session.id"] = sessionId;
  }
  if (
    typeof attributes["openinference.span.kind"] !== "string"
    || attributes["openinference.span.kind"].length === 0
  ) {
    attributes["openinference.span.kind"] = "AGENT";
  }
  return attributes;
}

function aliasString(
  attributes: Record<string, OtlpAttributeValue>,
  key: string,
  ...values: readonly (JsonValue | undefined)[]
): void {
  if (typeof attributes[key] === "string" && attributes[key].length > 0) return;
  const value = firstString(...values);
  if (value !== undefined) attributes[key] = value;
}

function firstString(...values: readonly (JsonValue | undefined)[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function spanStatus(record: ExportRecord): { readonly code: number } {
  const status = record.attributes["mono.agent.status"] ?? record.attributes.status;
  return typeof status === "string"
    && /^(?:cancelled|error|failed|failure|max-turns|rejected|uncertain|unhealthy)$/iu.test(status)
    ? { code: 2 }
    : { code: 0 };
}

function toHrTime(timestamp: string): HrTime {
  const milliseconds = Date.parse(timestamp);
  const seconds = Math.floor(milliseconds / 1_000);
  const nanos = (milliseconds - seconds * 1_000) * 1_000_000;
  return [seconds, nanos];
}

function toAttributeValue(value: JsonValue): OtlpAttributeValue {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (
    Array.isArray(value) &&
    (value.every((item) => typeof item === "string") ||
      value.every((item) => typeof item === "number") ||
      value.every((item) => typeof item === "boolean"))
  ) {
    return value as readonly string[] | readonly number[] | readonly boolean[];
  }
  return JSON.stringify(sortJson(value));
}

function canonicalJson(record: ExportRecord): string {
  return JSON.stringify(sortJson({
    name: record.name,
    timestamp: record.timestamp,
    attributes: record.attributes,
    ...(record.body === undefined ? {} : { body: record.body }),
  }));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  const object = value as Readonly<Record<string, JsonValue>>;
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(object).sort()) output[key] = sortJson(object[key]!);
  return output;
}
