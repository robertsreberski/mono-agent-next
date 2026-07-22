import type { ThreadDetail, WebMessage } from "./types";

export interface ConsoleTokenUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly model?: string;
}

export interface ConsoleContextUsage extends ConsoleTokenUsage {
  readonly total: number;
  readonly contextWindow?: number;
}

export type ConsoleContextStatus =
  | "current"
  | "updating"
  | "awaiting_measurement"
  | "last_measured"
  | "unavailable";

export interface ConsoleContextProjection {
  readonly status: ConsoleContextStatus;
  readonly usage?: ConsoleContextUsage;
  readonly measuredModel?: string;
  readonly reason?: string;
}

export interface ConsoleUsage {
  readonly context: ConsoleContextProjection;
  readonly processed?: ConsoleTokenUsage;
  readonly cost?: number;
}

export interface ConsoleUsageOptions {
  readonly selectedModel?: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

interface NormalizedUsage extends ConsoleTokenUsage {
  readonly total?: number;
  readonly contextWindow?: number;
  readonly cost?: number;
}

interface OrderedObservation {
  readonly order: number;
  readonly timestamp?: number;
}

interface ContextObservation extends OrderedObservation {
  readonly usage: ConsoleContextUsage;
  readonly messageStatus: WebMessage["status"];
}

interface CompactionObservation extends OrderedObservation {
  readonly status: "running" | "succeeded";
}

const INPUT_KEYS = ["input", "input_tokens", "inputTokens"] as const;
const CACHED_INPUT_KEYS = [
  "cachedInput",
  "cached_input",
  "cachedInputTokens",
  "cached_input_tokens",
  "cacheRead",
  "cache_read",
  "cacheReadTokens",
  "cache_read_tokens",
] as const;
const CACHE_CREATION_KEYS = [
  "cacheCreation",
  "cache_creation",
  "cacheCreationTokens",
  "cache_creation_tokens",
  "cacheWrite",
  "cache_write",
  "cacheWriteTokens",
  "cache_write_tokens",
] as const;
const OUTPUT_KEYS = ["output", "output_tokens", "outputTokens"] as const;
const REASONING_KEYS = ["reasoning", "reasoning_tokens", "reasoningTokens"] as const;
const TOTAL_KEYS = ["total", "total_tokens", "totalTokens"] as const;
const CONTEXT_WINDOW_KEYS = ["contextWindow", "context_window"] as const;
const COST_KEYS = [
  "cumulativeUsd",
  "cumulative_usd",
  "totalUsd",
  "total_usd",
  "costUsd",
  "cost_usd",
  "cost",
] as const;
const MODEL_KEYS = ["model", "modelId", "model_id"] as const;

const recordValue = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

const dataLayers = (value: unknown): readonly UnknownRecord[] => {
  const layers: UnknownRecord[] = [];
  const seen = new Set<UnknownRecord>();
  let current = recordValue(value);
  while (current !== undefined && layers.length < 8 && !seen.has(current)) {
    layers.push(current);
    seen.add(current);
    current = recordValue(current.data);
  }
  return layers;
};

const numericValue = (
  records: readonly UnknownRecord[],
  keys: readonly string[],
): number | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
};

const stringValue = (
  records: readonly UnknownRecord[],
  keys: readonly string[],
): string | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return undefined;
};

const telemetryLabels = (event: string, layers: readonly UnknownRecord[]): readonly string[] => [
  event,
  ...layers.flatMap((layer) =>
    [layer.type, layer.event, layer.kind].filter(
      (value): value is string => typeof value === "string",
    ),
  ),
];

const hasTelemetryLabel = (
  event: string,
  layers: readonly UnknownRecord[],
  expected: string,
): boolean => telemetryLabels(event, layers).some((label) => label.toLowerCase() === expected);

const isContextTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  hasTelemetryLabel(event, layers, "context_usage");

const isCompactionTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  hasTelemetryLabel(event, layers, "context_compaction");

const isAggregateUsageTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  !isContextTelemetry(event, layers) && telemetryLabels(event, layers).some((label) => {
    const normalized = label.toLowerCase();
    return normalized.includes("usage") || normalized.includes("cost");
  });

const normalizeUsage = (data: unknown): NormalizedUsage | null => {
  const outerToInner = dataLayers(data);
  const innerToOuter = [...outerToInner].reverse();
  const tokenRecords = [
    ...innerToOuter.flatMap((layer) => {
      const tokens = recordValue(layer.tokens);
      return tokens === undefined ? [] : [tokens];
    }),
    ...innerToOuter,
  ];
  const input = numericValue(tokenRecords, INPUT_KEYS);
  const cachedInput = numericValue(tokenRecords, CACHED_INPUT_KEYS);
  const cacheCreation = numericValue(tokenRecords, CACHE_CREATION_KEYS);
  const output = numericValue(tokenRecords, OUTPUT_KEYS);
  const reasoning = numericValue(tokenRecords, REASONING_KEYS);
  const total = numericValue(tokenRecords, TOTAL_KEYS);
  const contextWindow = numericValue(innerToOuter, CONTEXT_WINDOW_KEYS);
  const cost = numericValue(innerToOuter, COST_KEYS);
  const model = stringValue(innerToOuter, MODEL_KEYS);
  const usage: NormalizedUsage = {
    ...(input === undefined ? {} : { input }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheCreation === undefined ? {} : { cacheCreation }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(total === undefined ? {} : { total }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
    ...(model === undefined ? {} : { model }),
  };
  return Object.keys(usage).length === 0 ? null : usage;
};

const contextUsage = (data: unknown): ConsoleContextUsage | undefined => {
  const usage = normalizeUsage(data);
  if (usage?.total === undefined || usage.total < 0) return undefined;
  return {
    total: usage.total,
    ...(usage.input === undefined ? {} : { input: usage.input }),
    ...(usage.cachedInput === undefined ? {} : { cachedInput: usage.cachedInput }),
    ...(usage.cacheCreation === undefined ? {} : { cacheCreation: usage.cacheCreation }),
    ...(usage.output === undefined ? {} : { output: usage.output }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    ...(usage.model === undefined ? {} : { model: usage.model }),
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
  };
};

const hasProcessedTokens = (usage: NormalizedUsage): boolean =>
  usage.input !== undefined ||
  usage.cachedInput !== undefined ||
  usage.cacheCreation !== undefined ||
  usage.output !== undefined ||
  usage.reasoning !== undefined;

const latestMessageProcessed = (
  parts: ThreadDetail["messages"][number]["parts"],
): ConsoleTokenUsage | null => {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry") continue;
    const layers = dataLayers(part.data);
    if (!isAggregateUsageTelemetry(part.event, layers)) continue;
    const usage = normalizeUsage(part.data);
    if (usage === null || !hasProcessedTokens(usage)) continue;
    return {
      ...(usage.input === undefined ? {} : { input: usage.input }),
      ...(usage.cachedInput === undefined ? {} : { cachedInput: usage.cachedInput }),
      ...(usage.cacheCreation === undefined ? {} : { cacheCreation: usage.cacheCreation }),
      ...(usage.output === undefined ? {} : { output: usage.output }),
      ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
      ...(usage.model === undefined ? {} : { model: usage.model }),
    };
  }
  return null;
};

const latestMessageCost = (
  parts: ThreadDetail["messages"][number]["parts"],
): number | undefined => {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry") continue;
    const layers = dataLayers(part.data);
    if (!isAggregateUsageTelemetry(part.event, layers)) continue;
    const cost = normalizeUsage(part.data)?.cost;
    if (cost !== undefined) return cost;
  }
  return undefined;
};

const occursAfter = (candidate: OrderedObservation, reference: OrderedObservation): boolean => {
  if (
    candidate.timestamp !== undefined &&
    reference.timestamp !== undefined &&
    candidate.timestamp !== reference.timestamp
  ) {
    return candidate.timestamp > reference.timestamp;
  }
  return candidate.order > reference.order;
};

const latestObservation = <T extends OrderedObservation>(values: readonly T[]): T | undefined =>
  values.reduce<T | undefined>(
    (latest, candidate) => latest === undefined || occursAfter(candidate, latest) ? candidate : latest,
    undefined,
  );

const contextProjection = (
  detail: ThreadDetail,
  selectedModel: string | undefined,
): ConsoleContextProjection => {
  const contexts: ContextObservation[] = [];
  const compactions: CompactionObservation[] = [];
  let order = 0;

  for (const message of detail.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "telemetry") continue;
      order += 1;
      const layers = dataLayers(part.data);
      const innerToOuter = [...layers].reverse();
      const timestamp = numericValue(innerToOuter, ["timestamp"]);
      if (isContextTelemetry(part.event, layers)) {
        const usage = contextUsage(part.data);
        if (usage !== undefined) {
          contexts.push({
            usage,
            messageStatus: message.status,
            order,
            ...(timestamp === undefined ? {} : { timestamp }),
          });
        }
      }
      if (isCompactionTelemetry(part.event, layers)) {
        const status = stringValue(innerToOuter, ["status"]);
        if (status === "running" || status === "succeeded") {
          compactions.push({
            status,
            order,
            ...(timestamp === undefined ? {} : { timestamp }),
          });
        }
      }
    }
  }

  // A failed/cancelled/interrupted turn can report usage for a request that was
  // never committed to the conversation. Exact snapshots from those messages
  // are deliberately excluded; completed and currently-running turns remain.
  const latestExact = latestObservation(contexts.filter(
    (observation) => observation.messageStatus === "complete" || observation.messageStatus === "running",
  ));
  const latestInvalidation = latestObservation(compactions);
  const invalidated = latestInvalidation !== undefined &&
    (latestExact === undefined || occursAfter(latestInvalidation, latestExact));

  if (invalidated) {
    return {
      status: "awaiting_measurement",
      reason: "Context changed during compaction; waiting for the next exact provider measurement.",
    };
  }

  const runStatus = detail.thread.runState.status;
  const running = runStatus === "running" || detail.messages.some((message) => message.status === "running");
  if (running) {
    if (latestExact === undefined) {
      return {
        status: "updating",
        reason: "The current turn has not reported an exact provider measurement yet.",
      };
    }
    return {
      status: "updating",
      usage: latestExact.usage,
      ...(latestExact.usage.model === undefined ? {} : { measuredModel: latestExact.usage.model }),
      reason: "The provider measurement is exact, but the current turn is still updating context.",
    };
  }

  if (latestExact !== undefined) {
    const measuredModel = latestExact.usage.model;
    const nextModel = selectedModel?.trim() || undefined;
    const modelMismatch = nextModel !== undefined && measuredModel !== nextModel;
    const failedTurn = runStatus === "failed" || runStatus === "cancelled" || runStatus === "interrupted";
    if (failedTurn || modelMismatch) {
      return {
        status: "last_measured",
        usage: latestExact.usage,
        ...(measuredModel === undefined ? {} : { measuredModel }),
        reason: modelMismatch
          ? measuredModel === undefined
            ? `The exact measurement did not identify its model; the next turn is set to ${nextModel}.`
            : `This measurement belongs to ${measuredModel}; the next turn is set to ${nextModel}.`
          : "The latest turn did not complete, so this is the last successful provider measurement.",
      };
    }
    return {
      status: "current",
      usage: latestExact.usage,
      ...(measuredModel === undefined ? {} : { measuredModel }),
    };
  }

  const nextModel = selectedModel?.trim();
  return {
    status: "unavailable",
    reason: nextModel?.startsWith("claude:")
      ? "This Claude runtime does not expose exact context measurements."
      : "Exact context usage has not been reported for this conversation.",
  };
};

export const conversationConsoleUsage = (
  detail: ThreadDetail | null,
  options: ConsoleUsageOptions = {},
): ConsoleUsage | null => {
  if (detail === null) return null;

  let processed: ConsoleTokenUsage | undefined;
  let cost: number | undefined;
  for (const message of detail.messages) {
    const messageProcessed = latestMessageProcessed(message.parts);
    if (messageProcessed !== null) processed = messageProcessed;
    const messageCost = latestMessageCost(message.parts);
    if (messageCost !== undefined) cost = (cost ?? 0) + messageCost;
  }
  return {
    context: contextProjection(detail, options.selectedModel),
    ...(processed === undefined ? {} : { processed }),
    ...(cost === undefined ? {} : { cost }),
  };
};
