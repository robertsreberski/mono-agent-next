import type {
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
} from "@mono-agent/agent-harness";

export type RuntimeOptionsExtension = (
  input: AgentHarnessRuntimeOptionsInput,
) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;

export interface RuntimeOptionsCompositionOptions {
  /**
   * Internal extensions whose request-scoped MCP servers remain available
   * inside a later authoritative tool-policy override. This is deliberately
   * extension-identity based: an arbitrary caller cannot preserve a server by
   * merely reusing a trusted server name.
   */
  readonly preserveMcpServersUnderOverride?: readonly RuntimeOptionsExtension[];
}

/** Compose request-scoped runtime extensions without dropping tools or cleanup hooks. */
export function composeRuntimeOptionExtensions(
  extensions: ReadonlyArray<RuntimeOptionsExtension | undefined>,
  options: RuntimeOptionsCompositionOptions = {},
): RuntimeOptionsExtension | undefined {
  const active = extensions.filter((extension): extension is RuntimeOptionsExtension => extension !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  return async (input) => {
    const settled = await Promise.allSettled(active.map((extension) => extension(input)));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      await Promise.all(settled.map(async (result) => {
        if (result.status === "fulfilled") {
          await Promise.resolve(result.value.cleanup?.()).catch(() => undefined);
          await Promise.resolve(result.value.settleCleanup?.()).catch(() => undefined);
        }
      }));
      throw failures[0]!.reason;
    }

    const results = settled.map((result) => (result as PromiseFulfilledResult<AgentHarnessRuntimeOptionsExtension>).value);
    const runtimeOptions: Record<string, unknown> = {};
    for (const result of results) mergeRuntimeOptions(runtimeOptions, result.runtimeOptions);
    let toolPolicyOverride: AgentHarnessRuntimeOptionsExtension["toolPolicyOverride"];
    for (const result of results) {
      if (result.toolPolicyOverride !== undefined) toolPolicyOverride = result.toolPolicyOverride;
    }
    if (toolPolicyOverride !== undefined) {
      const preservedServers: Record<string, unknown> = {};
      const preservedExtensions = new Set(options.preserveMcpServersUnderOverride ?? []);
      for (const [index, extension] of active.entries()) {
        if (!preservedExtensions.has(extension)) continue;
        const servers = results[index]?.runtimeOptions?.mcpServers;
        if (isRecord(servers)) Object.assign(preservedServers, servers);
      }
      toolPolicyOverride = {
        ...toolPolicyOverride,
        ...(toolPolicyOverride.mcpServers === undefined && Object.keys(preservedServers).length === 0
          ? {}
          : {
              mcpServers: {
                ...(toolPolicyOverride.mcpServers ?? {}),
                ...preservedServers,
              },
            }),
      };
    }
    return {
      runtimeOptions,
      ...(toolPolicyOverride === undefined ? {} : { toolPolicyOverride }),
      cleanup: async () => {
        await Promise.all(results.map(async (result) => result.cleanup?.()));
      },
      settleCleanup: async () => {
        await Promise.all(results.map(async (result) => result.settleCleanup?.()));
      },
    };
  };
}

function mergeRuntimeOptions(
  target: Record<string, unknown>,
  next: AgentHarnessRuntimeOptionsExtension["runtimeOptions"],
): void {
  if (next === undefined) return;
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (key === "allowedTools" || key === "disallowedTools") {
      target[key] = mergeStringLists(target[key], value);
      continue;
    }
    if (key === "mcpServers") {
      target[key] = {
        ...(isRecord(target[key]) ? target[key] : {}),
        ...(isRecord(value) ? value : {}),
      };
      continue;
    }
    target[key] = value;
  }
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const list of [current, next]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
