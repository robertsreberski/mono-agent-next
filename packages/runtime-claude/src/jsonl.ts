import type { RuntimeUsage } from "@mono-agent/module-sdk";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function usage(value: unknown): RuntimeUsage | undefined {
  const item = record(value);
  const rawInputTokens = item.input_tokens ?? item.inputTokens;
  const rawOutputTokens = item.output_tokens ?? item.outputTokens;
  if (rawInputTokens === undefined || rawOutputTokens === undefined) {
    return undefined;
  }
  const inputTokens = Number(rawInputTokens);
  const outputTokens = Number(rawOutputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    return undefined;
  }
  const cacheRead = Number(item.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(item.cache_creation_input_tokens ?? 0);
  const cacheReadTokens = Number.isFinite(cacheRead) && cacheRead > 0
    ? cacheRead
    : undefined;
  const cacheWriteTokens = Number.isFinite(cacheWrite) && cacheWrite > 0
    ? cacheWrite
    : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
      + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}
