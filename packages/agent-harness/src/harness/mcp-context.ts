import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES,
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";
import { isValidMcpServerName } from "@mono-agent/runtime-adapter";

import type { HistoryMessage } from "../context/index.js";
import { classifyContinuationMcpServerTransport, isStdioMcpServerSpec } from "../mcp-server-transport.js";
import type {
  AgentHarnessContinuationClaimCapability,
  AgentHarnessContinuationContextOptions,
  AgentHarnessMcpRequestContextOptions,
  AgentHarnessProgressCapability,
  AgentHarnessRequest,
} from "../types.js";
import { AgentHarnessError } from "./error.js";
import {
  fileIdentity,
  removeOwnedDirectory,
  type AttachmentFileIdentity,
} from "./file-authority.js";
import { isRecord } from "./value-utils.js";

const SAFE_RUN_OUTPUT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MCP_REQUEST_CONTEXT_RESERVED_ENV = {
  conversationId: "MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID",
  runId: "MONO_AGENT_MCP_PRODUCING_RUN_ID",
  runOutputDir: "MONO_AGENT_MCP_RUN_OUTPUT_DIR",
  progressUrl: "MONO_AGENT_INTERACTION_PROGRESS_URL",
  progressToken: "MONO_AGENT_INTERACTION_PROGRESS_TOKEN",
  attachmentsRoot: "MONO_AGENT_MCP_ATTACHMENTS_ROOT",
  allowedAttachmentPaths: "MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS",
  allowedAttachmentIdentities: "MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES",
} as const;

const MCP_CONTINUATION_RESERVED_ENV = {
  url: "MONO_AGENT_CONTINUATION_CLAIM_URL",
  token: "MONO_AGENT_CONTINUATION_CLAIM_TOKEN",
  fingerprint: "MONO_AGENT_CONTINUATION_CLAIM_FINGERPRINT",
  mode: "MONO_AGENT_CONTINUATION_CLAIM_MODE",
} as const;

const MCP_CONTINUATION_RESERVED_HEADERS = {
  url: "x-mono-agent-continuation-claim-url",
  token: "x-mono-agent-continuation-claim-token",
  fingerprint: "x-mono-agent-continuation-claim-fingerprint",
  mode: "x-mono-agent-continuation-claim-mode",
} as const;

export async function injectMcpRequestContext(input: {
  readonly options: AgentHarnessMcpRequestContextOptions | undefined;
  readonly mcpServers: unknown;
  readonly conversationId: string;
  readonly runId: string;
  readonly attachmentsRoot: string;
  readonly allowedAttachmentPaths: readonly string[];
  readonly allowedAttachmentIdentities: readonly AttachmentFileIdentity[];
}): Promise<{
  readonly mcpServers: Record<string, unknown>;
  readonly progressCapability?: AgentHarnessProgressCapability;
  readonly cleanup: () => Promise<void>;
} | undefined> {
  if (input.options === undefined || input.options.serverNames.length === 0 || !isRecord(input.mcpServers)) {
    return undefined;
  }
  const selected = new Set(input.options.serverNames);
  const selectedStdio = Object.entries(input.mcpServers).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      selected.has(entry[0]) && isValidMcpServerName(entry[0]) && isStdioMcpServerSpec(entry[1]),
  );
  if (selectedStdio.length === 0) {
    return undefined;
  }
  if (!SAFE_RUN_OUTPUT_SEGMENT.test(input.runId)) {
    throw new AgentHarnessError(
      "invalid_run_id",
      "The run id is not safe for request-scoped MCP output isolation.",
      { runId: input.runId },
    );
  }
  const outputRoot = resolve(input.options.runOutputRoot);
  const runOutputDir = join(outputRoot, input.runId);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(runOutputDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await lstat(runOutputDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new AgentHarnessError(
        "unsafe_run_output",
        "The request-scoped MCP output path is not a real directory.",
        { runOutputDir },
      );
    }
  }
  const runOutputIdentity = fileIdentity(await lstat(runOutputDir));

  const cleanup = async (): Promise<void> => {
    await removeOwnedDirectory(runOutputDir, runOutputIdentity);
  };
  let progressCapability: AgentHarnessProgressCapability | undefined;
  try {
    progressCapability = input.options.progressCapabilityIssuer === undefined
      ? undefined
      : await input.options.progressCapabilityIssuer.issueProgressCapability({
          conversationId: input.conversationId,
          runId: input.runId,
        });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  const trustedEnv: Record<string, string> = {
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.conversationId]: input.conversationId,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.runId]: input.runId,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.runOutputDir]: runOutputDir,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.progressUrl]: progressCapability?.url ?? "",
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.progressToken]: progressCapability?.token ?? "",
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.attachmentsRoot]: input.attachmentsRoot,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.allowedAttachmentPaths]: JSON.stringify(input.allowedAttachmentPaths),
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.allowedAttachmentIdentities]: JSON.stringify(input.allowedAttachmentIdentities),
    // Opted project MCPs receive a scoped progress capability, never the bridge's
    // all-routes master bearer even if the host process has stale ambient values.
    MONO_AGENT_INTERACTION_BRIDGE_URL: "",
    MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "",
  };
  let mcpServers: Record<string, unknown>;
  try {
    mcpServers = { ...input.mcpServers };
    for (const [name, spec] of selectedStdio) {
      mcpServers[name] = cloneStdioMcpServerWithEnv(spec, trustedEnv);
    }
  } catch (error) {
    await progressCapability?.release();
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    mcpServers,
    ...(progressCapability === undefined ? {} : { progressCapability }),
    cleanup,
  };
}

export async function injectMcpContinuationContext(input: {
  readonly options: AgentHarnessContinuationContextOptions | undefined;
  readonly mcpServers: unknown;
  readonly conversationId: string;
  readonly replyTo: AgentHarnessRequest["replyTo"];
  readonly runId: string;
}): Promise<{
  readonly mcpServers: Record<string, unknown>;
  readonly capabilities: readonly AgentHarnessContinuationClaimCapability[];
} | undefined> {
  if (input.options === undefined || input.options.serverNames.length === 0 || !isRecord(input.mcpServers)) {
    return undefined;
  }

  const selected = new Set(input.options.serverNames);
  const entries = Object.entries(input.mcpServers).filter(([name]) => selected.has(name));
  if (entries.length === 0) {
    return undefined;
  }

  const capabilities: AgentHarnessContinuationClaimCapability[] = [];
  const mcpServers: Record<string, unknown> = { ...input.mcpServers };
  try {
    for (const [serverName, rawSpec] of entries) {
      if (!isValidMcpServerName(serverName) || !isRecord(rawSpec)) {
        throw unsupportedContinuationServer(serverName);
      }
      const transport = classifyContinuationMcpServerTransport(rawSpec);
      if (transport === "unsupported") {
        throw unsupportedContinuationServer(serverName);
      }

      const capability = await input.options.capabilityIssuer.issueContinuationClaimCapability({
        runId: input.runId,
        serverName,
        conversationId: input.conversationId,
        ...(input.replyTo === undefined
          ? {}
          : { replyTo: input.replyTo, historyBoundary: input.runId }),
      });
      if (capability !== undefined) {
        capabilities.push(capability);
        validateContinuationCapability(capability, serverName);
      }

      if (transport === "stdio") {
        const trustedEnv = {
          [MCP_CONTINUATION_RESERVED_ENV.url]: capability?.url ?? "",
          [MCP_CONTINUATION_RESERVED_ENV.token]: capability?.token ?? "",
          [MCP_CONTINUATION_RESERVED_ENV.fingerprint]: capability?.fingerprint ?? "",
          [MCP_CONTINUATION_RESERVED_ENV.mode]: capability?.mode ?? "",
        };
        mcpServers[serverName] = cloneStdioMcpServerWithEnv(rawSpec, trustedEnv);
      } else {
        mcpServers[serverName] = cloneHttpMcpServerWithContinuationHeaders(rawSpec, capability);
      }
    }
  } catch (error) {
    await Promise.allSettled(capabilities.map(async (capability) => capability.release()));
    throw error;
  }

  return { mcpServers, capabilities };
}

function unsupportedContinuationServer(serverName: string): AgentHarnessError {
  return new AgentHarnessError(
    "unsupported_continuation_server",
    `Continuation server ${serverName} must use stdio or loopback HTTP.`,
    { serverName },
  );
}

function validateContinuationCapability(
  capability: AgentHarnessContinuationClaimCapability,
  serverName: string,
): void {
  if (typeof capability.url !== "string" || !isLoopbackUrl(capability.url)) {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must use a loopback HTTP URL.",
      { serverName },
    );
  }
  if (typeof capability.token !== "string" || capability.token.trim().length === 0
    || typeof capability.fingerprint !== "string" || capability.fingerprint.trim().length === 0
    || !(["reply", "notify_if_actionable", "silent", "capture"] as const).includes(capability.mode)) {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must include a token, fingerprint, and supported mode.",
      { serverName },
    );
  }
  if (typeof capability.release !== "function") {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must provide release().",
      { serverName },
    );
  }
  if (typeof capability.finalizeOriginContext !== "function"
    || typeof capability.requiresOriginContext !== "function"
    || typeof capability.activateOriginContext !== "function"
    || typeof capability.abandonOriginContext !== "function") {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must provide durable origin-context finalization.",
      { serverName },
    );
  }
}

export async function continuationCapabilitiesRequiringOriginContext(
  capabilities: readonly AgentHarnessContinuationClaimCapability[],
): Promise<AgentHarnessContinuationClaimCapability[]> {
  const required = await Promise.all(capabilities.map(async (capability) => ({
    capability,
    required: await capability.requiresOriginContext(),
  })));
  return required.filter((entry) => entry.required).map((entry) => entry.capability);
}

export async function activateContinuationOriginContexts(
  capabilities: readonly AgentHarnessContinuationClaimCapability[],
): Promise<void> {
  await Promise.all(capabilities.map(async (capability) => {
    await capability.activateOriginContext();
  }));
}

export async function finalizeContinuationOriginContexts(
  capabilities: readonly AgentHarnessContinuationClaimCapability[],
  snapshot: AgentContinuationOriginContext,
): Promise<void> {
  // One origin run may expose more than one continuation-capable MCP server.
  // Every issuer must durably pin the same completed snapshot before the origin
  // answer is returned; partial success is treated as a failed origin turn.
  await Promise.all(capabilities.map(async (capability) => {
    await capability.finalizeOriginContext(snapshot);
  }));
}

export function buildContinuationOriginContext(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly capturedAt: string;
  readonly priorHistory: readonly HistoryMessage[];
  readonly completedTurn: readonly HistoryMessage[];
}): AgentContinuationOriginContext {
  // Preserve exact bytes for the newest bounded host-history projection. An
  // overlarge/invalid older message is omitted as a whole; content is never
  // silently truncated. The completed origin turn itself must fit or the run
  // fails closed before reporting success.
  const availableMessages = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES - input.completedTurn.length;
  const priorGroups = continuationSnapshotHistoryGroups(input.priorHistory)
    .filter((group) => group.every(isContinuationSnapshotHistoryMessage));
  const selectedGroups: HistoryMessage[][] = [];
  let selectedCount = 0;
  for (let index = priorGroups.length - 1; index >= 0; index -= 1) {
    const group = priorGroups[index] as HistoryMessage[];
    if (selectedCount + group.length > availableMessages) break;
    selectedGroups.unshift(group);
    selectedCount += group.length;
  }
  while (true) {
    const prior = selectedGroups.flat();
    const snapshot: AgentContinuationOriginContext = {
      schemaVersion: 1,
      conversationId: input.conversationId,
      originRunId: input.runId,
      historyBoundary: input.runId,
      capturedAt: input.capturedAt,
      messages: [...prior, ...input.completedTurn],
    };
    try {
      assertAgentContinuationOriginContext(snapshot);
      return snapshot;
    } catch (error) {
      if (selectedGroups.length === 0) throw error;
      // Size pressure evicts an entire oldest host turn. Never leave an
      // assistant reply without its user message (or vice versa).
      selectedGroups.shift();
    }
  }
}

function continuationSnapshotHistoryGroups(messages: readonly HistoryMessage[]): HistoryMessage[][] {
  const groups: HistoryMessage[][] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index] as HistoryMessage;
    if (typeof message.runId === "string" && message.runId.length > 0) {
      const group = [message];
      index += 1;
      while (index < messages.length && messages[index]?.runId === message.runId) {
        group.push(messages[index] as HistoryMessage);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    const next = messages[index + 1];
    if (message.role === "user" && next?.role === "assistant" && next.runId === undefined) {
      groups.push([message, next]);
      index += 2;
      continue;
    }
    // Legacy history can contain standalone system/tool entries. Retain them
    // atomically; only user/assistant pairs are inferred as a turn.
    groups.push([message]);
    index += 1;
  }
  return groups;
}

function isContinuationSnapshotHistoryMessage(message: HistoryMessage): boolean {
  try {
    const timestamp = "2026-01-01T00:00:00.000Z";
    assertAgentContinuationOriginContext({
      schemaVersion: 1,
      conversationId: "validation",
      originRunId: "validation-run",
      historyBoundary: "validation-run",
      capturedAt: timestamp,
      messages: [
        { ...message },
        { role: "user", content: "validation", timestamp, runId: "validation-run" },
        { role: "assistant", content: "validation", timestamp, runId: "validation-run" },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:")
      && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1");
  } catch {
    return false;
  }
}

function cloneHttpMcpServerWithContinuationHeaders(
  spec: Record<string, unknown>,
  capability: AgentHarnessContinuationClaimCapability | undefined,
): Record<string, unknown> {
  const reserved = new Set<string>(Object.values(MCP_CONTINUATION_RESERVED_HEADERS));
  const configuredHeaders = isRecord(spec.headers)
    ? Object.fromEntries(
        Object.entries(spec.headers).filter(([name]) => !reserved.has(name.toLowerCase())),
      )
    : {};
  const trustedHeaders = capability === undefined
    ? {}
    : {
        [MCP_CONTINUATION_RESERVED_HEADERS.url]: capability.url,
        [MCP_CONTINUATION_RESERVED_HEADERS.token]: capability.token,
        [MCP_CONTINUATION_RESERVED_HEADERS.fingerprint]: capability.fingerprint,
        [MCP_CONTINUATION_RESERVED_HEADERS.mode]: capability.mode,
      };
  return { ...spec, headers: { ...configuredHeaders, ...trustedHeaders } };
}

function cloneStdioMcpServerWithEnv(
  spec: Record<string, unknown>,
  trustedEnv: Readonly<Record<string, string>>,
): Record<string | symbol, unknown> {
  const configuredEnv = isRecord(spec.env) ? spec.env : {};
  return { ...spec, env: { ...configuredEnv, ...trustedEnv } };
}
