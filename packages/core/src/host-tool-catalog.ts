// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type {
  Channel, ChannelSendTool, JsonValue, ModuleToolContribution, ModuleToolTurnContext,
  RuntimeNativeToolEffect, RuntimeToolCall, RuntimeToolResult,
} from "@mono-agent/module-sdk";
import type { StateStore } from "@mono-agent/module-sdk/internal";
import {
  assertModuleToolBindingCompliance, assertModuleToolContributionsCompliance,
  snapshotSelectedModuleInstanceCompliance,
} from "@mono-agent/module-sdk/testing";
import {
  denseOwnDataArray as boundedOwnDataArray, ownDataRecord as boundedOwnDataRecord,
  snapshotBoundedValue,
} from "./bounded-value.js";
import type { CurrentRunFiles } from "./current-run-output.js";
import { AgentConfigError, errorMessage } from "./errors.js";
import { withTimeoutSignal } from "./host-lifecycle.js";
import {
  assertInstanceLifecycle, assertRequiredInstanceFunctions, assertStateArtifactCompliance,
  requireInstanceRecord,
} from "./host-module-instances.js";
import { boundedUtf8, requestContextTransformer } from "./host-redaction.js";
import {
  MODULE_TOOL_CALL_TIMEOUT_MS,
  type AmbiguousToolAlias, type BoundChannelTool, type BoundModuleTool,
} from "./host-types.js";
import { assertBoundedText } from "./host-values.js";
import type { CoreRuntimeTool } from "./mcp.js";
import { normalizeToolResult, type ToolResultArtifactSink } from "./tool-result-normalizer.js";
import type { AgentSubmitInput, LoadedAgentConfig, ModuleKind } from "./types.js";
export function filterTools(
  tools: readonly CoreRuntimeTool[],
  config: LoadedAgentConfig,
  input: AgentSubmitInput,
  ambiguousAliases: readonly AmbiguousToolAlias[],
): readonly CoreRuntimeTool[] {
  assertUnambiguousToolPolicy(
    input.toolPolicy?.allow,
    input.toolPolicy?.deny,
    ambiguousAliases,
    "request tool policy",
  );
  const instructionTools = tools.filter((tool) =>
    tool.source.kind === "core" && tool.source.capability !== "memory.recall" && tool.source.capability !== "interaction.ask-user");
  const governedTools = tools.filter((tool) =>
    tool.source.kind !== "core" || tool.source.capability === "memory.recall" || tool.source.capability === "interaction.ask-user");
  const policy = config.raw.policy.tools;
  let allowed =
    policy.default === "allow"
      ? new Set(governedTools.map((tool) => tool.name).filter((name) => !(policy.deny ?? []).includes(name)))
      : new Set(policy.allow ?? []);
  if (input.toolPolicy?.allow !== undefined) {
    const narrower = new Set(input.toolPolicy.allow);
    allowed = new Set([...allowed].filter((name) => narrower.has(name)));
  }
  for (const denied of input.toolPolicy?.deny ?? []) allowed.delete(denied);
  return [...instructionTools, ...governedTools.filter((tool) =>
    allowed.has(tool.name)
    && (config.raw.policy.approvals.default !== "deny" || toolEffects(tool).length === 0))];
}
export function assertUnambiguousToolPolicy(
  allow: readonly string[] | undefined,
  deny: readonly string[] | undefined,
  ambiguousAliases: readonly AmbiguousToolAlias[],
  label: string,
): void {
  if (ambiguousAliases.length === 0) return;
  const ambiguous = new Map(ambiguousAliases.map((entry) => [entry.alias, entry.canonicalNames]));
  const conflicts = [...new Set([...(allow ?? []), ...(deny ?? [])])]
    .filter((name) => ambiguous.has(name))
    .sort((left, right) => left.localeCompare(right));
  if (conflicts.length > 0) {
    throw new AgentConfigError(`${label} contains ambiguous tool aliases`, [{
      path: label === "agent tool policy" ? "policy.tools" : "toolPolicy",
      message: conflicts.map((name) =>
        `${JSON.stringify(name)} resolves to ${ambiguous.get(name)!.map((entry) =>
          JSON.stringify(entry)).join(", ")}`).join("; "),
      code: "ambiguous_tool_alias",
    }]);
  }
}
export function toolEffects(tool: CoreRuntimeTool): readonly RuntimeNativeToolEffect[] {
  if (tool.source.kind === "module") return tool.effects ?? [];
  if (tool.source.kind === "core") return [];
  return ["execute", "network"];
}
export async function executeTool(
  call: RuntimeToolCall,
  tools: readonly CoreRuntimeTool[],
  signal: AbortSignal,
  redact: (message: string) => string,
  artifactSink: ToolResultArtifactSink | undefined,
  requestContext?: CurrentRunFiles["requestContext"],
  emitActivity?: (text: string) => Promise<void>,
): Promise<RuntimeToolResult> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) {
    return { callId: call.id, isError: true, content: [{ type: "text", text: `Tool ${call.name} is not allowed` }] };
  }
  let activity = Promise.resolve();
  let activityFailure: { readonly error: unknown } | undefined;
  const transform = tool.requestContextResult === true && requestContext !== undefined
    ? requestContextTransformer(requestContext, redact) : undefined;
  const publicText = transform ?? redact;
  try {
    const output = await tool.execute(call.input, {
      signal, callId: call.id,
      ...(requestContext === undefined ? {} : { requestContext }),
      ...(emitActivity === undefined ? {} : {
        onActivity: (text: string) => {
          const compact = publicText(text)
            .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
          const safe = boundedUtf8(compact.length === 0 ? "MCP progress" : compact, 16_384);
          activity = activity.then(() => emitActivity(safe)).catch((error: unknown) => {
            activityFailure ??= { error };
          });
        },
      }),
    });
    await activity;
    if (activityFailure !== undefined) throw activityFailure.error;
    const normalized = await normalizeToolResult(output, {
      signal,
      ...(artifactSink === undefined ? {} : { artifactSink }),
      ...(transform === undefined ? {} : { transformString: transform }),
    });
    return {
      callId: call.id,
      content: normalized.content,
      ...(normalized.isError ? { isError: true } : {}),
    };
  } catch (error) {
    await activity;
    return {
      callId: call.id,
      isError: true,
      content: [{
        type: "text",
        text: boundedUtf8(publicText(errorMessage(error)), 16_384),
      }],
    };
  }
}
export function stateArtifactSink(state: StateStore | undefined): ToolResultArtifactSink | undefined {
  return state?.putArtifact === undefined
    ? undefined
    : { putArtifact: (request) => state.putArtifact!(request) };
}
export function snapshotChannelSendTools(value: unknown, instanceId: string): readonly ChannelSendTool[] {
  const instance = requireInstanceRecord(value, `${instanceId} channel instance`);
  const descriptor = Object.getOwnPropertyDescriptor(instance, "sendTools");
  if (descriptor === undefined || ("value" in descriptor && descriptor.value === undefined)) return [];
  if (!("value" in descriptor)) throw new TypeError(`${instanceId} channel sendTools must be an own data property`);
  return Object.freeze(boundedOwnDataArray(descriptor.value, `${instanceId} channel sendTools`, 64, true, true).map((raw, index) => {
    const tool = boundedOwnDataRecord(raw, `${instanceId} channel sendTools[${String(index)}]`, true);
    const description = tool.description as string;
    assertBoundedText(description, `${instanceId} channel tool description`, 16_384);
    const inputSchema = snapshotBoundedValue<Readonly<Record<string, unknown>>>(tool.inputSchema, {
      path: `${instanceId} channel tool schema`, maxBytes: 64 * 1024, maxItems: 10_000,
      maxDepth: 32, label: "JSON", freeze: true, requireOrdinaryArrays: true,
    }).value;
    return Object.freeze({ name: tool.name as string, description, inputSchema,
      prepare: tool.prepare as ChannelSendTool["prepare"] });
  }));
}
export function collectChannelTools(
  instances: ReadonlyMap<string, Channel>,
  snapshots: WeakMap<object, readonly ChannelSendTool[]>,
): readonly BoundChannelTool[] {
  return Object.freeze([...instances].flatMap(([instanceId, channel]) =>
    (snapshots.get(channel) ?? []).map((tool) => ({ instanceId, channel, tool })))
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId)
      || left.tool.name.localeCompare(right.tool.name))
    .map((row): BoundChannelTool => Object.freeze({ ...row, name: row.tool.name })));
}
export interface ToolCatalogName {
  readonly identity: string;
  readonly kind: "module" | "mcp" | "channel";
  readonly rawName: string;
}
export interface ResolvedToolCatalog {
  readonly moduleTools: readonly BoundModuleTool[];
  readonly mcpTools: readonly CoreRuntimeTool[];
  readonly channelTools: readonly BoundChannelTool[];
  readonly ambiguousAliases: readonly AmbiguousToolAlias[];
}
export function resolveToolCatalog(
  moduleTools: readonly BoundModuleTool[],
  mcpTools: readonly CoreRuntimeTool[],
  channelTools: readonly BoundChannelTool[],
  reservedNames: readonly string[],
): ResolvedToolCatalog {
  const rows: ToolCatalogName[] = [
    ...moduleTools.map((row) => ({
      identity: moduleToolIdentity(row),
      kind: "module" as const,
      rawName: row.tool.name,
    })),
    ...mcpTools.map((tool) => {
      if (tool.source.kind !== "mcp") throw new Error("Connected MCP catalog contains a non-MCP tool");
      return {
        identity: mcpToolIdentity(tool.source.server, tool.source.tool),
        kind: "mcp" as const,
        rawName: tool.source.tool,
      };
    }),
    ...channelTools.map((row) => ({
      identity: channelToolIdentity(row),
      kind: "channel" as const,
      rawName: row.tool.name,
    })),
  ].sort((left, right) => left.identity.localeCompare(right.identity));
  const identities = new Set<string>();
  const rawCounts = new Map<string, number>();
  for (const row of rows) {
    if (identities.has(row.identity)) {
      throw new Error(`Tool catalog contains duplicate source identity ${row.identity}`);
    }
    identities.add(row.identity);
    rawCounts.set(row.rawName, (rawCounts.get(row.rawName) ?? 0) + 1);
  }
  const reserved = new Set<string>();
  for (const name of reservedNames) {
    if (reserved.has(name)) throw new Error(`Core tool name ${name} is declared more than once`);
    reserved.add(name);
  }
  const finalNames = new Set(reserved);
  const names = new Map<string, string>();
  for (const row of rows) {
    const useRaw = rawCounts.get(row.rawName) === 1
      && isPortableCatalogAlias(row.rawName)
      && !reserved.has(row.rawName);
    const name = useRaw
      ? row.rawName
      : `${row.kind}__${createHash("sha256").update(row.identity, "utf8").digest("base64url")}`;
    if (finalNames.has(name)) throw new Error(`Tool catalog final name collision: ${name}`);
    finalNames.add(name);
    names.set(row.identity, name);
  }
  const ambiguousAliases = Object.freeze([...rawCounts]
    .filter(([, count]) => count > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias]): AmbiguousToolAlias => Object.freeze({
      alias,
      canonicalNames: Object.freeze(rows
        .filter((row) => row.rawName === alias)
        .map((row) => names.get(row.identity)!)
        .sort((left, right) => left.localeCompare(right))),
    })));
  return Object.freeze({
    moduleTools: Object.freeze(moduleTools
      .map((row): BoundModuleTool => Object.freeze({
        ...row,
        name: names.get(moduleToolIdentity(row))!,
      }))
      .sort((left, right) => moduleToolIdentity(left).localeCompare(moduleToolIdentity(right)))),
    mcpTools: Object.freeze(mcpTools.map((tool): CoreRuntimeTool => {
      if (tool.source.kind !== "mcp") throw new Error("Connected MCP catalog contains a non-MCP tool");
      const name = names.get(mcpToolIdentity(tool.source.server, tool.source.tool))!;
      const { rawAlias: _rawAlias, ...snapshot } = tool;
      return Object.freeze({
        ...snapshot,
        name,
        ...(name === tool.source.tool ? { rawAlias: tool.source.tool } : {}),
      });
    })),
    channelTools: Object.freeze(channelTools
      .map((row): BoundChannelTool => Object.freeze({
        ...row,
        name: names.get(channelToolIdentity(row))!,
      }))
      .sort((left, right) => channelToolIdentity(left).localeCompare(channelToolIdentity(right)))),
    ambiguousAliases,
  });
}
export function moduleToolIdentity(row: BoundModuleTool): string {
  return framedToolIdentity("module-tool-v1", [
    row.loaded.slot,
    row.loaded.instanceId,
    row.loaded.packageName,
    row.tool.name,
  ]);
}
export function mcpToolIdentity(server: string, tool: string): string {
  return framedToolIdentity("mcp-tool-v1", [server, tool]);
}
export function channelToolIdentity(row: BoundChannelTool): string {
  return framedToolIdentity("channel-tool-v1", [row.instanceId, row.tool.name]);
}
export function framedToolIdentity(kind: string, values: readonly string[]): string {
  return [kind, ...values.map((value) => `${String(Buffer.byteLength(value, "utf8"))}:${value}`)]
    .join("\0");
}
export function isPortableCatalogAlias(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(name)
    && !["core__", "runtime__", "module__", "mcp__", "channel__"]
      .some((prefix) => name.startsWith(prefix));
}
export function moduleRuntimeTool(row: BoundModuleTool): CoreRuntimeTool {
  return Object.freeze({
    name: row.name,
    description: row.tool.description,
    inputSchema: row.tool.inputSchema,
    effects: row.tool.effects,
    source: Object.freeze({
      kind: "module",
      slot: row.loaded.slot,
      instanceId: row.loaded.instanceId,
      packageName: row.loaded.packageName,
      tool: row.tool.name,
    }),
    async execute() {
      throw new Error(`Module tool ${row.name} is not bound to a turn`);
    },
  });
}
export function bindModuleTools(
  tools: readonly CoreRuntimeTool[],
  moduleTools: readonly BoundModuleTool[],
  context: ModuleToolTurnContext,
): { readonly tools: readonly CoreRuntimeTool[]; revoke(): void } {
  const rows = new Map(moduleTools.map((row) => [row.name, row]));
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const revoke = (): void => controller.abort(new Error("Module tool turn binding is closed"));
  try {
    const bound = tools.map((tool): CoreRuntimeTool => {
      if (tool.source.kind !== "module") return tool;
      const row = rows.get(tool.name);
      if (row === undefined) throw new Error(`Module tool ${tool.name} has no selected source`);
      const rawBinding = row.tool.bind(Object.freeze({ ...context, signal }));
      assertModuleToolBindingCompliance(rawBinding, `${tool.name} module tool binding`);
      const execute = rawBinding.execute.bind(rawBinding);
      return Object.freeze({
        ...tool,
        async execute(
          input: unknown,
          options: NonNullable<Parameters<CoreRuntimeTool["execute"]>[1]> = {},
        ) {
          const callId = options.callId;
          if (callId === undefined) throw new Error("Module tool call identity is unavailable");
          if (signal.aborted) throw new Error(`Module tool ${tool.name} binding is closed`);
          const parent = options.signal === undefined
            ? signal : AbortSignal.any([signal, options.signal]);
          return withTimeoutSignal(
            (callSignal) => execute(input as JsonValue, Object.freeze({ callId, signal: callSignal })),
            MODULE_TOOL_CALL_TIMEOUT_MS,
            parent,
            `Module tool ${tool.name}`,
          );
        },
      });
    });
    return Object.freeze({ tools: Object.freeze(bound), revoke });
  } catch (error) {
    revoke();
    throw error;
  }
}
export function createdModuleToolSnapshot(
  kind: ModuleKind,
  value: unknown,
  instanceId: string,
): readonly ModuleToolContribution[] {
  if (kind === "runtime" || kind === "channel" || kind === "memory") {
    return snapshotSelectedModuleInstanceCompliance(kind, value);
  } else {
    const reserved = requireInstanceRecord(value, `${kind} instance`);
    assertInstanceLifecycle(reserved, `${kind} instance`);
    const required = kind === "state"
      ? ["read", "write", "delete", "list", "compareAndSwap", "transaction", "scan",
          "upsertPresence", "removePresence", "listPresence"] as const
      : kind === "exporter" ? ["export", "flush"] as const
        : kind === "sandbox" ? ["execute", "spawn"] as const : [];
    assertRequiredInstanceFunctions(reserved, required, `${kind} instance`);
    if (kind === "state") assertStateArtifactCompliance(reserved);
  }
  const instance = requireInstanceRecord(value, `${instanceId} module instance`);
  const descriptor = Object.getOwnPropertyDescriptor(instance, "toolContributions");
  if (descriptor !== undefined && !("value" in descriptor))
    throw new TypeError(`${instanceId} module toolContributions must be an own data property`);
  return assertModuleToolContributionsCompliance(
    descriptor?.value, `${instanceId} module toolContributions`,
  );
}
