// SPDX-License-Identifier: MIT
import { dirname } from "node:path";
import type { ChannelReplyEvent, RuntimeTurnEvent } from "@mono-agent/module-sdk";
import { denseOwnDataArray as boundedOwnDataArray } from "./bounded-value.js";
import type { CurrentRunFiles } from "./current-run-output.js";
import { errorMessage } from "./errors.js";
import { redactJson } from "./host-health.js";
export function sanitizeModuleCommandError(error: unknown, redact: (value: string) => string, depth = 0): Error {
  const message = boundedUtf8(redact(inspectModuleFailure(error)), 4_096);
  const nestedCause = depth >= 4 ? undefined : ownDataProperty(error, "cause");
  const options = nestedCause === undefined ? undefined
    : { cause: sanitizeModuleCommandError(nestedCause, redact, depth + 1) };
  const aggregateErrors = depth >= 4 ? undefined : ownDataProperty(error, "errors");
  let sanitizedErrors: Error[] | undefined;
  if (aggregateErrors !== undefined) {
    try {
      const entries = boundedOwnDataArray(aggregateErrors, "module command aggregate errors", 8, true, true);
      sanitizedErrors = [];
      for (let index = 0; index < entries.length; index += 1)
        sanitizedErrors.push(sanitizeModuleCommandError(entries[index], redact, depth + 1));
    } catch { sanitizedErrors = [new Error("Unsafe aggregate error details were omitted")]; }
  }
  const safe = sanitizedErrors === undefined
    ? new Error(message, options) : new AggregateError(sanitizedErrors, message, options);
  const code = ownDataProperty(error, "code");
  if (typeof code === "string" && code.length > 0) {
    Object.defineProperty(safe, "code", { value: boundedUtf8(redact(code), 128), enumerable: true });
  }
  return safe;
}
export function inspectModuleFailure(error: unknown): string {
  try { return errorMessage(error); }
  catch { return "Module failure could not be inspected safely"; }
}
export function ownDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
export function redactChannelToolEvent(
  event: Extract<RuntimeTurnEvent, { readonly type: "tool-call" | "tool-result" }>,
  redact: (value: string) => string,
): Extract<ChannelReplyEvent, { readonly type: "tool-call" | "tool-result" }> {
  if (event.type === "tool-call") return {
    type: "tool-call",
    call: { id: redact(event.call.id), name: redact(event.call.name), input: redactJson(event.call.input, redact) },
  };
  return {
    type: "tool-result",
    result: {
      callId: redact(event.result.callId),
      ...(event.result.isError === undefined ? {} : { isError: event.result.isError }),
      content: event.result.content.map((part) => part.type === "text"
        ? { type: "text", text: redact(part.text) }
        : part.type === "json"
          ? { type: "json", value: redactJson(part.value, redact) }
          : { type: "text", text: part.type === "file"
              ? `[file result omitted: ${redact(part.name ?? part.mediaType)}]`
              : `[artifact result omitted${part.preview === undefined ? "" : `: ${redact(part.preview)}`}]` }),
    },
  };
}
export function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "...";
  const payloadBytes = maxBytes - Buffer.byteLength(suffix, "utf8");
  const bytes = Buffer.from(value, "utf8");
  let end = Math.max(0, payloadBytes);
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}
export function requestContextTransformer(
  context: CurrentRunFiles["requestContext"],
  redact: (message: string) => string,
): (value: string) => string {
  const paths = [...new Set([
    dirname(context.runOutputDir), context.runOutputDir, context.attachmentsRoot,
    ...context.allowedAttachmentPaths,
    ...context.allowedAttachmentIdentities.map((entry) => entry.path),
    ...context.attachments.map((entry) => entry.path),
  ])].sort((left, right) => right.length - left.length);
  return (value) => redact(paths.reduce(
    (text, path) => text.replaceAll(path, "[REDACTED_PATH]"), value,
  ));
}
export function redactBounded(value: string, secrets: readonly string[], maxBytes: number): string {
  let redacted = value;
  if (secrets.length === 0) return utf8Prefix(redacted, maxBytes);
  const minimum = Math.min(...secrets.map((secret) => Buffer.byteLength(secret, "utf8")));
  const separator = ["*", "#", "~", "^", "|", "_", "!", "?", "%", "+", "=", "\u0001", "\u0002"]
    .find((candidate) => Buffer.byteLength(candidate, "utf8") <= minimum
      && !value.includes(candidate)
      && secrets.every((secret) => !secret.includes(candidate)));
  if (separator === undefined) return "";
  for (const secret of secrets) redacted = redacted.replaceAll(secret, separator);
  if (secrets.every((secret) => Buffer.byteLength(secret, "utf8") >= 10)) {
    const marked = redacted.replaceAll(separator, "[REDACTED]");
    if (secrets.every((secret) => !marked.includes(secret))) return utf8Prefix(marked, maxBytes);
  }
  return utf8Prefix(redacted, maxBytes);
}
export function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1]!)) low -= 1;
  return value.slice(0, low);
}
