import type { RunSummary } from "@mono-agent/observability";

import type { ExternalRunSummary } from "../types.js";

export function externalResponseSummary(summary: RunSummary): ExternalRunSummary | undefined {
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(summary);
    prototype = Object.getPrototypeOf(summary);
  } catch {
    return undefined;
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const runId = summaryDataProperty(descriptors, "runId");
  const conversationId = summaryDataProperty(descriptors, "conversationId");
  const status = summaryDataProperty(descriptors, "status");
  const durationMs = summaryDataProperty(descriptors, "durationMs");
  const eventCount = summaryDataProperty(descriptors, "eventCount");
  const rawArtifactPaths = summaryDataProperty(descriptors, "artifactPaths");
  const artifactPaths = cloneExternalSummaryValue(rawArtifactPaths);
  if (
    typeof runId !== "string" ||
    typeof conversationId !== "string" ||
    !isExternalSummaryStatus(status) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    typeof eventCount !== "number" ||
    !Number.isFinite(eventCount) ||
    !Array.isArray(artifactPaths) ||
    !Array.from(artifactPaths).every((value) => typeof value === "string")
  ) {
    return undefined;
  }

  const external = Object.create(null) as Record<string, unknown>;
  external.runId = runId;
  external.conversationId = conversationId;
  external.status = status;
  external.durationMs = durationMs;
  external.eventCount = eventCount;
  external.artifactPaths = artifactPaths;
  // This allowlist is deliberately explicit. Recorder implementations are a
  // public injection seam, so a rest spread could copy a callable `toJSON`
  // hook that reconstructs the omitted systemPrompt during channel JSON
  // serialization. Unknown-valued fields are cloned without invoking toJSON,
  // getters, or custom prototypes; an unsafe value is omitted fail-closed.
  for (const key of EXTERNAL_SUMMARY_OPTIONAL_KEYS) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const value = descriptor.value;
    if (value === undefined) continue;
    const cloned = cloneExternalSummaryValue(value);
    if (cloned !== UNSAFE_EXTERNAL_SUMMARY_VALUE) {
      external[key] = cloned;
    }
  }
  return external as unknown as ExternalRunSummary;
}

const UNSAFE_EXTERNAL_SUMMARY_VALUE = Symbol("unsafe-external-summary-value");
const MAX_EXTERNAL_SUMMARY_DEPTH = 64;
const EXTERNAL_SUMMARY_STATUSES = new Set(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const EXTERNAL_SUMMARY_OPTIONAL_KEYS = [
  "failureKind",
  "error",
  "failoverHistory",
  "startedAt",
  "endedAt",
  "updatedAt",
  "usage",
  "cost",
  "providerSessionId",
  "isolated",
  "runtimeWarnings",
  "diagnostics",
  "capabilitiesUsed",
  "userInput",
  "model",
  "effort",
  "source",
  "sourceDetail",
] as const;

function summaryDataProperty(
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown | typeof UNSAFE_EXTERNAL_SUMMARY_VALUE {
  const descriptor = descriptors[key];
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : UNSAFE_EXTERNAL_SUMMARY_VALUE;
}

function isExternalSummaryStatus(value: unknown): value is RunSummary["status"] {
  return typeof value === "string" && EXTERNAL_SUMMARY_STATUSES.has(value);
}

/** Clone JSON-shaped recorder data without honoring executable serialization hooks. */
function cloneExternalSummaryValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown | typeof UNSAFE_EXTERNAL_SUMMARY_VALUE {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNSAFE_EXTERNAL_SUMMARY_VALUE;
  if (typeof value !== "object" || depth >= MAX_EXTERNAL_SUMMARY_DEPTH) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  if (ancestors.has(value)) return UNSAFE_EXTERNAL_SUMMARY_VALUE;

  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  }
  const isArray = Array.isArray(value);
  if (
    (isArray && prototype !== Array.prototype && prototype !== null) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  }
  const toJson = descriptors.toJSON;
  if (toJson !== undefined && (!("value" in toJson) || typeof toJson.value === "function")) {
    return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (!Number.isSafeInteger(length) || length < 0) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
      const cloned: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
        const item = cloneExternalSummaryValue(descriptor.value, ancestors, depth + 1);
        if (item === UNSAFE_EXTERNAL_SUMMARY_VALUE) return item;
        cloned[index] = item;
      }
      return cloned;
    }

    const cloned = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || key === "toJSON") continue;
      if (!("value" in descriptor)) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
      const item = cloneExternalSummaryValue(descriptor.value, ancestors, depth + 1);
      if (item === UNSAFE_EXTERNAL_SUMMARY_VALUE) return item;
      Object.defineProperty(cloned, key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}
