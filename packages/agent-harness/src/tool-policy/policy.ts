import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ToolPolicyInput {
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Record<string, unknown>;
  readonly mcpConfigPath?: string;
}

export interface ToolPolicy {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly mcpServers?: Record<string, unknown>;
  readonly mcpConfigPath?: string;
}

export type ToolPolicyErrorCode = "invalid_tool_policy" | "tool_policy_read_failed";

export type ToolPolicyErrorDetails = Record<string, unknown>;

export class ToolPolicyError extends Error {
  readonly code: ToolPolicyErrorCode;
  readonly details: ToolPolicyErrorDetails;

  constructor(code: ToolPolicyErrorCode, message: string, details: ToolPolicyErrorDetails = {}) {
    super(message);
    this.name = "ToolPolicyError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface ToolPolicyRuntimeOptions extends Record<string, unknown> {
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers?: Record<string, unknown>;
  mcpConfigPath?: string;
}

export function createToolPolicy(input: ToolPolicyInput = {}): ToolPolicy {
  const allowedTools = normalizeToolList(input.allowedTools, "allowedTools");
  const disallowedTools = normalizeToolList(input.disallowedTools, "disallowedTools");
  const overlap = allowedTools.filter((tool) => disallowedTools.includes(tool));
  if (overlap.length > 0) {
    throw new ToolPolicyError("invalid_tool_policy", "Tools cannot be both allowed and disallowed.", { overlap });
  }

  const policy: ToolPolicy = {
    allowedTools,
    disallowedTools,
    ...(input.mcpServers === undefined ? {} : { mcpServers: normalizeMcpServers(input.mcpServers) }),
    ...(input.mcpConfigPath === undefined ? {} : { mcpConfigPath: normalizeInlineString(input.mcpConfigPath, "mcpConfigPath") }),
  };
  return policy;
}

export function failClosedToolPolicy(): ToolPolicy {
  return { allowedTools: [], disallowedTools: [] };
}

export async function loadToolPolicyFromJsonFile(filePath: string): Promise<ToolPolicy> {
  const resolvedPath = resolveRequiredPath(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new ToolPolicyError("tool_policy_read_failed", "Unable to read tool policy JSON.", {
      path: resolvedPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) {
    throw new ToolPolicyError("invalid_tool_policy", "Tool policy JSON must be an object.", { path: resolvedPath });
  }
  return createToolPolicy(parsedToPolicyInput(parsed));
}

export function loadToolPolicyFromJsonFileSync(filePath: string): ToolPolicy {
  const resolvedPath = resolveRequiredPath(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new ToolPolicyError("tool_policy_read_failed", "Unable to read tool policy JSON.", {
      path: resolvedPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) {
    throw new ToolPolicyError("invalid_tool_policy", "Tool policy JSON must be an object.", { path: resolvedPath });
  }
  return createToolPolicy(parsedToPolicyInput(parsed));
}

export function toolPolicyToRuntimeOptions(policy: ToolPolicy): ToolPolicyRuntimeOptions {
  const options: ToolPolicyRuntimeOptions = {
    allowedTools: [...policy.allowedTools],
    disallowedTools: [...policy.disallowedTools],
  };
  if (policy.mcpServers !== undefined) {
    options.mcpServers = policy.mcpServers;
  }
  if (policy.mcpConfigPath !== undefined) {
    options.mcpConfigPath = policy.mcpConfigPath;
  }
  return options;
}

function parsedToPolicyInput(parsed: Record<string, unknown>): ToolPolicyInput {
  // Container-shape validation only; per-entry string validation is performed in
  // a single downstream pass by createToolPolicy's normalize* helpers.
  return {
    ...(parsed.allowedTools === undefined ? {} : { allowedTools: asToolList(parsed.allowedTools, "allowedTools") }),
    ...(parsed.disallowedTools === undefined ? {} : { disallowedTools: asToolList(parsed.disallowedTools, "disallowedTools") }),
    ...(parsed.mcpServers === undefined ? {} : { mcpServers: asRecord(parsed.mcpServers, "mcpServers") }),
    ...(parsed.mcpConfigPath === undefined ? {} : { mcpConfigPath: asUnknownString(parsed.mcpConfigPath, "mcpConfigPath") }),
  };
}

function normalizeToolList(value: readonly unknown[] | undefined, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an array.`, { field });
  }
  const tools = value.map((tool, index) => normalizeInlineString(tool, `${field}[${index}]`));
  const seen = new Set<string>();
  for (const tool of tools) {
    const key = tool.toLowerCase();
    if (seen.has(key)) {
      throw new ToolPolicyError("invalid_tool_policy", `${field} contains duplicate tool names.`, { field, tool });
    }
    seen.add(key);
  }
  return tools;
}

function normalizeMcpServers(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ToolPolicyError("invalid_tool_policy", "mcpServers must be an object.");
  }
  return structuredClone(value);
}

function normalizeInlineString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be a string.`, { field });
  }
  const normalized = value.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
  if (normalized.length === 0) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must not be empty.`, { field });
  }
  return normalized;
}

function resolveRequiredPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolPolicyError("invalid_tool_policy", "filePath must be a non-empty string.");
  }
  return resolve(value);
}

function asToolList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an array.`, { field });
  }
  // Entries are validated per-element by normalizeToolList; this layer only
  // confirms the container is an array so the two validation passes don't diverge.
  return value as readonly string[];
}

function asUnknownString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be a string.`, { field });
  }
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new ToolPolicyError("invalid_tool_policy", `${field} must be an object.`, { field });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
