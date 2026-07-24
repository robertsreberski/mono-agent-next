import type { RuntimeUsage } from "@mono-agent/module-sdk";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function usage(value: unknown): RuntimeUsage | undefined {
  const item = record(value);
  const inputTokens = Number(item.input_tokens ?? item.inputTokens ?? 0);
  const outputTokens = Number(item.output_tokens ?? item.outputTokens ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    return undefined;
  }
  const cacheRead = Number(item.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(item.cache_creation_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(Number.isFinite(cacheRead) && cacheRead > 0
      ? { cacheReadTokens: cacheRead }
      : {}),
    ...(Number.isFinite(cacheWrite) && cacheWrite > 0
      ? { cacheWriteTokens: cacheWrite }
      : {}),
  };
}
