import { createHash } from "node:crypto";

import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { JsonValue } from "@mono-agent/module-sdk";
import type { ExportRecord } from "@mono-agent/module-sdk/internal";

type HrTime = [number, number];
type OtlpAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export function serializeOtlpSpans(records: readonly ExportRecord[], projectName: string): Buffer {
  const resource = {
    attributes: {
      "service.name": "mono-agent",
      "service.namespace": "mono-agent-next",
      "openinference.project.name": projectName,
      "mono.agent.project": projectName,
    },
    schemaUrl: undefined,
  };
  const scope = { name: "@mono-agent/exporter-otlp", version: "0.15.0" };
  const spans = records.map((record): ReadableSpan => {
    const canonical = canonicalJson(record);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const timestamp = toHrTime(record.timestamp);
    const attributes: Record<string, OtlpAttributeValue> = Object.create(null) as Record<string, OtlpAttributeValue>;
    for (const [key, value] of Object.entries(record.attributes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)) {
      attributes[key] = toAttributeValue(value);
    }
    if (record.body !== undefined) {
      attributes["mono.agent.body"] = JSON.stringify(sortJson(record.body));
    }
    const span = {
      name: record.name,
      kind: 0,
      spanContext: () => ({ traceId: digest.slice(0, 32), spanId: digest.slice(32, 48), traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: timestamp,
      endTime: timestamp,
      status: { code: 0 },
      attributes,
      links: [],
      events: [],
      duration: [0, 0] as HrTime,
      ended: true,
      resource,
      instrumentationScope: scope,
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
