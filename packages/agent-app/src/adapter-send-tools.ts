import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { splitTextByCodePoints } from "@mono-agent/agent-contracts";
import { ALLOW_ALL_TOOLS } from "@mono-agent/config";
import type {
  SlackChatPostMessageResult,
  SlackWebApi,
} from "@mono-agent/slack-adapter";
import type {
  TelegramChatId,
  TelegramMessageSender,
  TelegramSentMessage,
} from "@mono-agent/telegram-adapter";
import * as z from "zod/v4";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { LEGACY_TOOL_ALIASES } from "./modules/known-tools.js";
import { appendPostedMessage } from "./posted-message-index.js";

// Lazy per module (mirrors channels.ts): a config without slack/telegram
// send-tool policy never pulls either SDK in.
type SlackAdapterModule = typeof import("@mono-agent/slack-adapter");
type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");
let slackModule: SlackAdapterModule | undefined;
let telegramModule: TelegramAdapterModule | undefined;
const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/slack-adapter"));
const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));
const SLACK_SEND_MESSAGE_MAX_CHARS = 40_000;
/** Keep cancellation responsive even when the loopback bridge is wedged. */
const ASK_BRIDGE_CLEANUP_TIMEOUT_MS = 1_000;
type TelegramSendToolName = "TelegramSendMessage" | "TelegramSendFile";

/**
 * Model-visible send tools for explicitly allowed, already-enabled communication adapters.
 *
 * This mirrors `MemoryRecall`: agent-app injects a stdio MCP server through
 * per-request runtime options. The adapter config remains the source of truth:
 * if Slack or Telegram is disabled, invalid, blocked by tool policy, or lacks an
 * allowed destination policy, the corresponding send tool is not exposed. When
 * exposed, each tool enforces the same adapter allowlist before calling the
 * adapter-owned sender.
 */

export const ADAPTER_SEND_TOOLS_MCP_SERVER_NAME = "mono-agent-adapter-send";

export interface SlackSendToolSettings {
  readonly botToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
}

export interface TelegramSendToolSettings {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
  /** Self-hosted Bot API base URL (also unlocks file:// for non-strict path uploads). */
  readonly apiRoot?: string;
  /** Upload cap for the TelegramSendFile tool; the resolver fills the 20 MiB default. */
  readonly maxUploadBytes?: number;
  /** Which telegram tools the policy permits (the adapter config gates the rest). */
  readonly tools: {
    readonly send: boolean;
    /** The single TelegramSendFile tool (document + photo via a `kind` param). */
    readonly file: boolean;
  };
  readonly sendTools?: {
    readonly scope?: "producing-conversation";
    readonly pathScope?: "run-output";
  };
  /** Trusted exact request conversation, injected by the app-owned parent. */
  readonly producingConversationId?: string;
  /** Trusted current-run output directory, injected by the app-owned parent. */
  readonly runOutputDir?: string;
  /** Identity of the app-created directory object; prevents root path swaps. */
  readonly runOutputIdentity?: FileIdentity;
}

/**
 * Blocking ask-the-user tool, backed by the app's interaction bridge. Channel
 * agnostic: the tool only talks to the bridge; the bridge posts the question
 * through whichever channel sink owns the conversation. `conversationId` is
 * present only in the spawned child (from the per-request env) — without it the
 * tool has no target and is not registered.
 */
export interface AskUserToolSettings {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly timeoutMs: number;
  readonly producerConversationId?: string;
  readonly interactionConversationId?: string;
  readonly runId?: string;
}

export interface AdapterSendToolsSettings {
  readonly slack?: SlackSendToolSettings;
  readonly telegram?: TelegramSendToolSettings;
  readonly askUser?: AskUserToolSettings;
}

export interface AdapterSendToolsClients {
  readonly slack?: Pick<SlackWebApi, "chatPostMessage">;
  readonly telegram?: Partial<Pick<TelegramMessageSender, "sendMessage" | "sendDocument" | "sendPhoto">>;
}

export interface AdapterSendToolsHttpOptions {
  readonly fetchImpl?: typeof fetch;
  readonly deliveryHistory?: AdapterSendToolsDeliveryHistory;
}

export interface AdapterSendToolsDeliveryHistory {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
}

export interface AdapterSendToolsDeliveryHistoryCapabilityIssuer {
  issueDeliveryHistoryCapability(input: {
    readonly runId: string;
    readonly producerConversationId: string;
    readonly allowedChannels: readonly ("slack" | "telegram")[];
  }): { readonly url: string; readonly token: string; release(): void };
}

export interface AdapterSendToolsRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
  readonly settleCleanup?: () => Promise<void>;
}

/**
 * Where a posted message should be linked back to its producing conversation.
 * Forwarded to the stdio child so `SlackSendMessage` can record
 * `(channel, ts) → conversationId` — see {@link appendPostedMessage}.
 */
export interface AdapterSendToolsIndexing {
  readonly conversationId: string;
  readonly indexPath: string;
}

/** Minimal shape of the per-request runtime-options input we read. */
interface AdapterSendToolsRequestInput {
  readonly request?: {
    readonly conversationId?: string;
    readonly replyTo?: { readonly conversationId?: string };
  };
  readonly runId?: string;
}

export interface AdapterSendToolsResolveOptions {
  readonly allowedTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly logger?: {
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
  } | undefined;
  /** Suppress bridge-backed AskUser for MCP-incompatible routes. */
  readonly suppressInteractionTools?: boolean | undefined;
  /** App-owned master bridge settings; never sourced from project MCP config. */
  readonly interaction?: AdapterSendToolsInteractionEnv | undefined;
}

export async function resolveAdapterSendToolsSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions = {},
): Promise<AdapterSendToolsSettings | undefined> {
  const telegramSendAllowed = isAdapterToolAllowed("TelegramSendMessage", options);
  const telegramFileAllowed = isAdapterToolAllowed("TelegramSendFile", options);
  const telegramAnyAllowed = telegramSendAllowed || telegramFileAllowed;
  const [slack, telegram] = await Promise.all([
    isAdapterToolAllowed("SlackSendMessage", options)
      ? resolveSlackSendToolSettings(input, options)
      : undefined,
    telegramAnyAllowed
        ? resolveTelegramSendToolSettings(input, options, {
          send: telegramSendAllowed,
          file: telegramFileAllowed,
        })
      : undefined,
  ]);
  const askUser = options.suppressInteractionTools !== true && isAdapterToolAllowed("AskUser", options)
    ? resolveAskUserToolSettings(input.env, options.interaction)
    : undefined;
  if (slack === undefined && telegram === undefined && askUser === undefined) {
    return undefined;
  }
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
    ...(askUser === undefined ? {} : { askUser }),
  };
}

/**
 * AskUser is available only when the app exported a live interaction bridge
 * into the environment (URL + bearer token). The producing conversation id is
 * per-request env, present in the spawned child.
 */
function resolveAskUserToolSettings(
  env: Record<string, string | undefined>,
  interaction?: AdapterSendToolsInteractionEnv,
): AskUserToolSettings | undefined {
  const bridgeUrl = interaction?.bridgeUrl ?? optionalString(env.MONO_AGENT_INTERACTION_BRIDGE_URL);
  const bridgeToken = interaction?.bridgeToken ?? optionalString(env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN);
  if (bridgeUrl === undefined || bridgeToken === undefined) {
    return undefined;
  }
  const timeoutRaw = Number(optionalString(env.MONO_AGENT_ASK_USER_TIMEOUT_MS));
  const timeoutMs = interaction?.timeoutMs
    ?? (Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 ? timeoutRaw : 600_000);
  const producerConversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  const interactionConversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_INTERACTION_CONVERSATION_ID);
  const runId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_RUN_ID);
  return {
    bridgeUrl,
    bridgeToken,
    timeoutMs,
    ...(producerConversationId === undefined ? {} : { producerConversationId }),
    ...(interactionConversationId === undefined ? {} : { interactionConversationId }),
    ...(runId === undefined ? {} : { runId }),
  };
}

export function adapterSendToolNames(settings: AdapterSendToolsSettings): readonly string[] {
  const names: string[] = [];
  if (settings.slack !== undefined) {
    names.push("SlackSendMessage");
  }
  if (settings.telegram?.tools.send === true) {
    names.push("TelegramSendMessage");
  }
  if (settings.telegram?.tools.file === true) {
    names.push("TelegramSendFile");
  }
  if (settings.askUser !== undefined) {
    names.push("AskUser");
  }
  return names;
}

/**
 * Public re-export of the per-tool allow check so callers (e.g. the Telegram
 * channel driver) can gate behavior on whether a specific adapter send tool is
 * permitted by `tools.allowedTools`/`disallowedTools`, matching this module's policy.
 */
export function isAdapterSendToolAllowed(
  name: string,
  policy: { readonly allowedTools?: readonly string[]; readonly disallowedTools?: readonly string[] },
): boolean {
  return isAdapterToolAllowed(name, policy);
}

/**
 * Per-request context forwarded to the stdio child. `conversationId` alone
 * targets AskUser at the producing conversation; `indexPath` additionally
 * enables the posted-message index (Slack reply continuity).
 */
export interface AdapterSendToolsChildContext {
  readonly conversationId?: string;
  readonly interactionConversationId?: string;
  readonly runId?: string;
  readonly indexPath?: string;
  readonly runOutputDir?: string;
  readonly runOutputIdentity?: FileIdentity;
  readonly deliveryHistory?: AdapterSendToolsDeliveryHistory;
}

export interface AdapterSendToolsInteractionEnv {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly timeoutMs: number;
}

export function adapterSendToolsMcpEnv(
  configPath: string,
  allowedTools: readonly string[],
  context?: AdapterSendToolsChildContext,
  interaction?: AdapterSendToolsInteractionEnv,
): Record<string, string> {
  return {
    MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: configPath,
    MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(allowedTools),
    ...(context?.conversationId === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: context.conversationId }),
    ...(context?.interactionConversationId === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_INTERACTION_CONVERSATION_ID: context.interactionConversationId }),
    ...(context?.runId === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_PRODUCING_RUN_ID: context.runId }),
    ...(context?.indexPath === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: context.indexPath }),
    ...(context?.runOutputDir === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DIR: context.runOutputDir }),
    ...(context?.runOutputIdentity === undefined
      ? {}
      : {
          MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DEV: String(context.runOutputIdentity.dev),
          MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_INO: String(context.runOutputIdentity.ino),
        }),
    // Reserved app-owned credentials must override inherited host environment.
    MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_URL: context?.deliveryHistory?.bridgeUrl ?? "",
    MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_TOKEN: context?.deliveryHistory?.bridgeToken ?? "",
    ...(interaction === undefined
      ? {}
      : {
          MONO_AGENT_INTERACTION_BRIDGE_URL: interaction.bridgeUrl,
          MONO_AGENT_INTERACTION_BRIDGE_TOKEN: interaction.bridgeToken,
          MONO_AGENT_ASK_USER_TIMEOUT_MS: String(interaction.timeoutMs),
        }),
  };
}

export interface AdapterSendToolsChildConfig {
  readonly input: MonoAgentAppConfigInput;
  readonly allowedTools: readonly string[];
  readonly indexing?: AdapterSendToolsIndexing;
  readonly deliveryHistory?: AdapterSendToolsDeliveryHistory;
}

export function adapterSendToolsChildConfigFromEnv(env: Record<string, string | undefined>, cwd: string): AdapterSendToolsChildConfig {
  const configPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH);
  if (configPath === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH).");
  }
  const conversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  const indexPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH);
  const historyBridgeUrl = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_URL);
  const historyBridgeToken = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_TOKEN);
  if ((historyBridgeUrl === undefined) !== (historyBridgeToken === undefined)) {
    throw new Error(
      "adapter-send-tools: delivery-history bridge URL and token must either both be present or both be absent.",
    );
  }
  // Both must be present to index; either alone is a misconfiguration we simply skip.
  const indexing = conversationId !== undefined && indexPath !== undefined ? { conversationId, indexPath } : undefined;
  return {
    input: { env, cwd, configPath },
    allowedTools: parseAllowedToolNames(env.MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS),
    ...(indexing === undefined ? {} : { indexing }),
    ...(historyBridgeUrl === undefined || historyBridgeToken === undefined
      ? {}
      : { deliveryHistory: { bridgeUrl: historyBridgeUrl, bridgeToken: historyBridgeToken } }),
  };
}

export function adapterSendToolsMcpServerSpec(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  context?: AdapterSendToolsChildContext,
  interaction?: AdapterSendToolsInteractionEnv,
): Record<string, unknown> {
  const spec: Record<string | symbol, unknown> = {
    type: "stdio",
    command: process.execPath,
    // Node 24 on macOS defaults to the system trust store, whose trustd access
    // is intentionally unavailable inside strict SRT. Force Node's bundled CA
    // set for this child while still honoring NODE_EXTRA_CA_CERTS when SRT TLS
    // termination or an operator supplies an additional root.
    args: ["--use-bundled-ca", fileURLToPath(new URL("./adapter-send-tools-main.js", import.meta.url))],
    cwd,
    env: adapterSendToolsMcpEnv(configPath, allowedTools, context, interaction),
  };
  // Only the trusted app-owned adapter child receives SRT's coarse loopback
  // capability. A symbol cannot be supplied by JSON MCP config and disappears
  // from serialized provider/tool metadata, so ordinary Bash/project MCP
  // processes keep the stricter no-bind allowlist policy.
  Object.defineProperty(spec, Symbol.for("@mono-agent/app-owned-local-binding"), {
    value: true,
    enumerable: false,
  });
  return spec;
}

/**
 * Per-request runtime extension that injects the adapter-send stdio MCP server. It
 * reads the request's producing conversationId and, when an `indexPath` is
 * configured, forwards both to the child so a `SlackSendMessage` post is linked
 * back to this conversation (so a later in-thread reply resumes it).
 */
export function createAdapterSendToolsRuntimeExtension(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  indexPath?: string,
  interaction?: AdapterSendToolsInteractionEnv,
  runOutputRoot?: string,
  deliveryHistoryCapabilityIssuer?: AdapterSendToolsDeliveryHistoryCapabilityIssuer,
): (input: AdapterSendToolsRequestInput) => Promise<AdapterSendToolsRuntimeExtension> {
  return async (input) => {
    const conversationId = input?.request?.conversationId;
    const interactionConversationId = input?.request?.replyTo?.conversationId ?? conversationId;
    const runId = input?.runId;
    const hasConversation = typeof conversationId === "string" && conversationId.trim().length > 0;
    const hasRunId = typeof runId === "string" && runId.trim().length > 0;
    const runOutput = runOutputRoot === undefined || !hasRunId
      ? undefined
      : await ensureAdapterRunOutputDir(runOutputRoot, runId);
    const deliveryHistoryChannels = [
      ...(allowedTools.includes("SlackSendMessage") ? ["slack" as const] : []),
      ...(allowedTools.includes("TelegramSendMessage") ? ["telegram" as const] : []),
    ];
    const deliveryHistory = !hasRunId
      || !hasConversation
      || deliveryHistoryCapabilityIssuer === undefined
      || deliveryHistoryChannels.length === 0
      ? undefined
      : deliveryHistoryCapabilityIssuer.issueDeliveryHistoryCapability({
          runId,
          producerConversationId: conversationId as string,
          allowedChannels: deliveryHistoryChannels,
        });
    // The conversation id is forwarded whenever known — AskUser targets it even
    // without indexing; the index path additionally enables posted-message links.
    const context: AdapterSendToolsChildContext | undefined = hasConversation || hasRunId
      ? {
          ...(hasConversation ? { conversationId } : {}),
          ...(typeof interactionConversationId === "string" && interactionConversationId.trim().length > 0
            ? { interactionConversationId }
            : {}),
          ...(hasRunId ? { runId } : {}),
          ...(indexPath === undefined ? {} : { indexPath }),
          ...(runOutput === undefined
            ? {}
            : { runOutputDir: runOutput.path, runOutputIdentity: runOutput.identity }),
          ...(deliveryHistory === undefined
            ? {}
            : {
                deliveryHistory: {
                  bridgeUrl: deliveryHistory.url,
                  bridgeToken: deliveryHistory.token,
                },
              }),
        }
      : undefined;
    return {
      runtimeOptions: {
        mcpServers: {
          [ADAPTER_SEND_TOOLS_MCP_SERVER_NAME]: adapterSendToolsMcpServerSpec(
            configPath,
            cwd,
            allowedTools,
            context,
            interaction,
          ),
        },
      },
      cleanup: async () => {
        deliveryHistory?.release();
      },
      settleCleanup: async () => {
        if (runOutput !== undefined) {
          await removeOwnedDirectory(runOutput.path, runOutput.identity);
        }
      },
    };
  };
}

export async function createAdapterSendToolsClients(
  settings: AdapterSendToolsSettings,
  options: AdapterSendToolsHttpOptions = {},
): Promise<AdapterSendToolsClients> {
  const slack =
    settings.slack === undefined
      ? undefined
      : new (await loadSlackModule()).SlackWebApiClient({
          botToken: settings.slack.botToken,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
  const telegram =
    settings.telegram === undefined
      ? undefined
      : (await loadTelegramModule()).createTelegramMessageSender(settings.telegram.botToken, {
          ...(settings.telegram.apiRoot === undefined ? {} : { apiRoot: settings.telegram.apiRoot }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
  };
}

export async function createAdapterSendToolsServer(
  settings: AdapterSendToolsSettings,
  clients: AdapterSendToolsClients,
  indexing?: AdapterSendToolsIndexing,
  options: AdapterSendToolsHttpOptions = {},
): Promise<McpServer> {
  const server = new McpServer({ name: "agent-adapter-send-tools", version: "0.3.0" });

  if (settings.slack !== undefined && clients.slack !== undefined) {
    const adapter = await loadSlackModule();
    registerSlackSendTool(
      server,
      settings.slack,
      clients.slack,
      adapter.formatMarkdownForSlack,
      indexing,
      options.deliveryHistory,
      options.fetchImpl ?? globalThis.fetch,
    );
  }
  if (settings.telegram !== undefined && clients.telegram !== undefined) {
    const adapter = await loadTelegramModule();
    if (settings.telegram.tools.send && clients.telegram.sendMessage !== undefined) {
      registerTelegramSendTool(
        server,
        settings.telegram,
        { sendMessage: clients.telegram.sendMessage },
        adapter,
        options.deliveryHistory,
        options.fetchImpl ?? globalThis.fetch,
      );
    }
    if (
      settings.telegram.tools.file
      && (clients.telegram.sendDocument !== undefined || clients.telegram.sendPhoto !== undefined)
    ) {
      registerTelegramSendFileTool(
        server,
        settings.telegram,
        clients.telegram,
        adapter,
      );
    }
  }
  // AskUser needs a target conversation; the parent app process resolves the
  // settings without one (for tool-name gating) and must not register the tool.
  if (
    settings.askUser?.producerConversationId !== undefined
    && settings.askUser.interactionConversationId !== undefined
  ) {
    registerAskUserTool(
      server,
      {
        ...settings.askUser,
        producerConversationId: settings.askUser.producerConversationId,
        interactionConversationId: settings.askUser.interactionConversationId,
      },
      options.fetchImpl ?? globalThis.fetch,
    );
  }

  return server;
}

/** Long-poll wait per bridge request; the overall wait is bounded server-side by the ask's timeout. */
const ASK_USER_POLL_WAIT_MS = 20_000;

function registerAskUserTool(
  server: McpServer,
  settings: AskUserToolSettings & {
    readonly producerConversationId: string;
    readonly interactionConversationId: string;
  },
  fetchImpl: typeof fetch,
): void {
  server.registerTool(
    "AskUser",
    {
      title: "Ask the user and wait",
      description:
        "Ask 1–5 related questions and WAIT for the user to answer them in the current conversation. Each question must offer 2–3 concise options with descriptions; the UI also permits a custom reply. Use multiSelect only when several choices may be combined. Put long decision context or a draft in message. A second concurrent AskUser call fails. If the wait expires, finish gracefully using the returned partial answers and state any assumptions.",
      inputSchema: {
        message: z.string().min(1).max(4_096).optional().describe("Optional context or draft shown above the questions."),
        questions: z.array(z.object({
          header: z.string().min(1).max(12).describe("Short section label, at most 12 characters."),
          question: z.string().min(1).max(1_000).describe("The decision or information needed."),
          options: z.array(z.object({
            label: z.string().min(1).max(75).describe("Concise selectable answer."),
            description: z.string().min(1).max(300).describe("What choosing this option means."),
          })).min(2).max(3),
          multiSelect: z.boolean().optional().describe("Allow selecting more than one proposed answer before Done."),
        })).min(1).max(5),
      },
    },
    async (args, extra) => {
      const created = await askBridgeRequest(settings, fetchImpl, "POST", "/v1/asks", {
        conversationId: settings.interactionConversationId,
        producerConversationId: settings.producerConversationId,
        runId: settings.runId,
        message: args.message,
        questions: args.questions,
        timeoutMs: settings.timeoutMs,
      }, extra.signal);
      if (created.status === 409) {
        return askToolResult(
          "A question is already pending for the user. Wait for its answer instead of asking again.",
          { answered: false, reason: "already_pending" },
        );
      }
      if (created.status === 501) {
        return askToolResult(
          "This conversation's channel does not support interactive asks. Ask your question in your final reply instead.",
          { answered: false, reason: "unsupported_channel" },
        );
      }
      if (created.status !== 201 || typeof created.body.interactionId !== "string") {
        throw new Error(`AskUser: the interaction bridge rejected the ask (HTTP ${String(created.status)}).`);
      }
      return await awaitBridgeAsk(settings, created.body.interactionId, extra, fetchImpl, extra.signal);
    },
  );
}

function askToolResult(
  text: string,
  structured: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, ...structured },
  };
}

async function awaitBridgeAsk(
  settings: AskUserToolSettings,
  interactionId: string,
  extra: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }> {
  const startedMs = Date.now();
  try {
    for (;;) {
      const poll = await askBridgeRequest(
        settings,
        fetchImpl,
        "GET",
        `/v1/asks/${encodeURIComponent(interactionId)}?waitMs=${String(ASK_USER_POLL_WAIT_MS)}`,
        undefined,
        signal,
      );
      if (poll.status !== 200) {
        throw new Error(`AskUser: lost the pending ask (HTTP ${String(poll.status)}).`);
      }
      // Keep-alive: progress notifications reset the runtime's MCP inactivity
      // timeout so a long human wait cannot kill the tool call.
      await sendAskProgress(extra, Math.round((Date.now() - startedMs) / 1000));
      const status = poll.body.status;
      if (status === "answered") {
        const answer = formatBridgeAskAnswers(poll.body);
        return askToolResult(`The user answered:\n${answer.text}`, {
          answered: true,
          interactionId,
          answers: answer.answers,
        });
      }
      if (status === "expired") {
        const partial = formatBridgeAskAnswers(poll.body);
        return askToolResult(
          `${partial.answers.length === 0 ? "The user did not answer" : `The user answered only:\n${partial.text}\n\nThe remaining questions were not answered`} within the wait window. Their next message will be a new turn; finish gracefully and state any assumptions.`,
          { answered: false, reason: "timeout", interactionId, answers: partial.answers },
        );
      }
      if (status === "cancelled") {
        return askToolResult("The user cancelled the current run. Stop this task.", {
          answered: false,
          reason: "cancelled",
          interactionId,
        });
      }
    }
  } catch (error) {
    // A cancelled MCP call must not leave a bridge ask pending until its full
    // human timeout. Cleanup gets its own bounded signal (not the aborted call
    // signal), and its failure must never replace the primary tool failure.
    await cleanupBridgeAskBestEffort(settings, fetchImpl, interactionId);
    throw error;
  }
}

function formatBridgeAskAnswers(body: Record<string, unknown>): {
  readonly text: string;
  readonly answers: readonly Record<string, unknown>[];
} {
  const questions = Array.isArray(body.questions) ? body.questions : [];
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const normalized: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const rawAnswer of answers) {
    if (typeof rawAnswer !== "object" || rawAnswer === null || Array.isArray(rawAnswer)) continue;
    const answer = rawAnswer as Record<string, unknown>;
    const questionId = typeof answer.questionId === "string" ? answer.questionId : undefined;
    if (questionId === undefined) continue;
    const question = questions.find((candidate) =>
      typeof candidate === "object"
      && candidate !== null
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).id === questionId
    ) as Record<string, unknown> | undefined;
    const options = Array.isArray(question?.options) ? question.options : [];
    const selectedOptionIds = Array.isArray(answer.selectedOptionIds)
      ? answer.selectedOptionIds.filter((value): value is string => typeof value === "string")
      : [];
    const selectedOptions = selectedOptionIds.flatMap((optionId) => {
      const option = options.find((candidate) =>
        typeof candidate === "object"
        && candidate !== null
        && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).id === optionId
      ) as Record<string, unknown> | undefined;
      return typeof option?.label === "string"
        ? [{ id: optionId, label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }]
        : [];
    });
    const customReply = typeof answer.customReply === "string" ? answer.customReply : undefined;
    const header = typeof question?.header === "string" ? question.header : questionId;
    const rendered = [
      ...selectedOptions.map((option) => option.label),
      ...(customReply === undefined ? [] : [customReply]),
    ].join(", ");
    lines.push(`- ${header}: ${rendered}`);
    normalized.push({
      questionId,
      header,
      selectedOptions,
      ...(customReply === undefined ? {} : { customReply }),
    });
  }
  return { text: lines.join("\n") || "(no answers)", answers: normalized };
}

async function cleanupBridgeAskBestEffort(
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
  interactionId: string,
): Promise<void> {
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new Error("interaction bridge ask cleanup timed out"));
      resolve();
    }, ASK_BRIDGE_CLEANUP_TIMEOUT_MS);
    deadlineTimer.unref?.();
  });
  // Attach the rejection handler before racing. If a test seam or nonstandard
  // fetch ignores abort and rejects later, it cannot become an unhandled error.
  const cleanup = askBridgeRequest(
    settings,
    fetchImpl,
    "DELETE",
    `/v1/asks/${encodeURIComponent(interactionId)}`,
    undefined,
    controller.signal,
  ).then(() => undefined, () => undefined);
  try {
    await Promise.race([cleanup, deadline]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}

async function askBridgeRequest(
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(new URL(path, settings.bridgeUrl), {
    method,
    headers: {
      authorization: `Bearer ${settings.bridgeToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
  };
}

async function sendAskProgress(extra: unknown, elapsedSeconds: number): Promise<void> {
  const handler = extra as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: unknown) => Promise<void>;
  };
  const progressToken = handler._meta?.progressToken;
  if (progressToken === undefined || handler.sendNotification === undefined) {
    return;
  }
  try {
    await handler.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsedSeconds,
        message: `waiting for the user's reply (${String(elapsedSeconds)}s)`,
      },
    });
  } catch {
    // Keep-alive only; a lost notification must never fail the ask.
  }
}

interface DeliveryHistoryOutcome {
  readonly accepted: boolean;
  readonly code: string;
}

const DELIVERY_HISTORY_BRIDGE_TIMEOUT_MS = 2_000;

async function recordAdapterDeliveryHistory(input: {
  readonly settings: AdapterSendToolsDeliveryHistory | undefined;
  readonly fetchImpl: typeof fetch;
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}): Promise<DeliveryHistoryOutcome | undefined> {
  if (input.settings === undefined) return undefined;
  try {
    const response = await input.fetchImpl(new URL("/v1/delivery-history", input.settings.bridgeUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.settings.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationId: input.conversationId,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
      }),
      signal: AbortSignal.timeout(DELIVERY_HISTORY_BRIDGE_TIMEOUT_MS),
    });
    if (response.status === 202) return { accepted: true, code: "queued" };
    if (response.status === 400) return { accepted: false, code: "history_record_invalid" };
    if (response.status === 401) return { accepted: false, code: "history_capability_rejected" };
    if (response.status === 403) return { accepted: false, code: "history_capability_scope_rejected" };
    if (response.status === 501) return { accepted: false, code: "history_record_unavailable" };
    if (response.status === 503) return { accepted: false, code: "history_record_failed" };
    return { accepted: false, code: `history_bridge_http_${String(response.status)}` };
  } catch {
    return { accepted: false, code: "history_bridge_unreachable" };
  }
}

function deliveryHistorySummary(
  outcomes: readonly (DeliveryHistoryOutcome | undefined)[],
): DeliveryHistoryOutcome | undefined {
  const present = outcomes.filter((outcome): outcome is DeliveryHistoryOutcome => outcome !== undefined);
  if (present.length === 0) return undefined;
  const failed = present.find((outcome) => !outcome.accepted);
  return failed ?? { accepted: true, code: "queued" };
}

function withDeliveryHistoryWarning(message: string, history: DeliveryHistoryOutcome | undefined): string {
  return history?.accepted === false
    ? `${message} Delivery succeeded, but destination history was not queued (${history.code}).`
    : message;
}

function registerSlackSendTool(
  server: McpServer,
  settings: SlackSendToolSettings,
  client: Pick<SlackWebApi, "chatPostMessage">,
  formatMarkdownForSlack: (text: string) => string,
  indexing?: AdapterSendToolsIndexing,
  deliveryHistory?: AdapterSendToolsDeliveryHistory,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  server.registerTool(
    "SlackSendMessage",
    {
      title: "Send Slack message",
      description: "Send a message to an allowed Slack channel or DM ID using the configured Slack adapter bot token.",
      inputSchema: {
        channel: z.string().min(1).describe("Slack channel or DM ID, e.g. C123456 or D123456."),
        text: z.string().min(1).describe("Message text to send. Defaults to standard Markdown converted to Slack mrkdwn."),
        thread_ts: z.string().min(1).optional().describe("Optional Slack thread timestamp to reply in."),
        mrkdwn: z.boolean().optional().describe("Whether Slack mrkdwn formatting is enabled. Defaults to true; set false to send plain text unchanged."),
        unfurl_links: z.boolean().optional().describe("Whether Slack should unfurl links."),
        unfurl_media: z.boolean().optional().describe("Whether Slack should unfurl media."),
      },
    },
    async (args, extra) => {
      assertSlackChannelAllowed(settings, args.channel);
      const mrkdwn = args.mrkdwn ?? true;
      const text = mrkdwn ? formatMarkdownForSlack(args.text) : args.text;
      const chunks = splitTextByCodePoints(text, SLACK_SEND_MESSAGE_MAX_CHARS);
      const results: SlackChatPostMessageResult[] = [];
      const historyOutcomes: Array<DeliveryHistoryOutcome | undefined> = [];
      for (const chunk of chunks) {
        const result: SlackChatPostMessageResult = await client.chatPostMessage(
          {
            channel: args.channel.trim(),
            text: chunk,
            ...(args.thread_ts === undefined ? {} : { thread_ts: args.thread_ts }),
            mrkdwn,
            ...(args.unfurl_links === undefined ? {} : { unfurl_links: args.unfurl_links }),
            ...(args.unfurl_media === undefined ? {} : { unfurl_media: args.unfurl_media }),
          },
          { signal: extra.signal },
        );
        results.push(result);
        const historyOutcome = await recordAdapterDeliveryHistory({
          settings: deliveryHistory,
          fetchImpl,
          conversationId: `slack:${result.channel}:${args.thread_ts?.trim() || result.ts}`,
          text: chunk,
          idempotencyKey: `adapter-send:slack:${result.channel}:${result.ts}`,
        });
        historyOutcomes.push(historyOutcome);
        // Link every confirmed posted chunk back to its producing conversation.
        // The history attempt always settles first; an accepted cross-conversation
        // record is therefore durable before the alias appears. A rejected or
        // unreachable best-effort history path remains visible in the tool result
        // but must never regress the existing producer-reply routing contract.
        if (indexing !== undefined) {
          await appendPostedMessage(indexing.indexPath, {
            channelId: result.channel,
            ts: result.ts,
            conversationId: indexing.conversationId,
          });
        }
      }
      const [firstResult] = results;
      if (firstResult === undefined) {
        throw new Error("SlackSendMessage: no message chunks were produced.");
      }
      const chunkRefs = results.map((result) => ({ channel: result.channel, ts: result.ts }));
      const message =
        results.length === 1
          ? `Sent Slack message to ${firstResult.channel} at ${firstResult.ts}.`
          : `Sent ${String(results.length)} Slack messages to ${firstResult.channel} starting at ${firstResult.ts}.`;
      const history = deliveryHistorySummary(historyOutcomes);
      return {
        content: [{ type: "text", text: withDeliveryHistoryWarning(message, history) }],
        structuredContent:
          results.length === 1
            ? {
                ok: true,
                channel: firstResult.channel,
                ts: firstResult.ts,
                ...(history === undefined ? {} : { history }),
              }
            : {
                ok: true,
                channel: firstResult.channel,
                ts: firstResult.ts,
                chunkCount: results.length,
                chunks: chunkRefs,
                ...(history === undefined ? {} : { history }),
              },
      };
    },
  );
}

function registerTelegramSendTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendMessage">,
  adapter: TelegramAdapterModule,
  deliveryHistory?: AdapterSendToolsDeliveryHistory,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  server.registerTool(
    "TelegramSendMessage",
    {
      title: "Send Telegram message",
      description:
        "Send a message to an allowed Telegram chat. Optionally add 2–8 non-blocking reply buttons; a tap arrives later as a new user turn.",
      inputSchema: {
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        text: z.string().min(1).describe("Message text to send."),
        parse_mode: z.string().min(1).optional().describe("Optional Telegram parse mode, e.g. MarkdownV2 or HTML."),
        reply_to_message_id: z.number().int().optional().describe("Optional message id to reply to."),
        disable_web_page_preview: z.boolean().optional().describe("Disable Telegram link previews."),
        reply_options: z
          .array(z.string().min(1).max(75))
          .min(2)
          .max(8)
          .optional()
          .describe("Optional non-blocking reply button labels. Use AskUser when this run must wait for the selection."),
      },
    },
    async (args, extra) => {
      assertTelegramChatAllowed(settings, args.chat_id, "TelegramSendMessage");
      const result: TelegramSentMessage = await client.sendMessage(
        {
          chat_id: args.chat_id,
          text: args.text,
          ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }),
          ...(args.reply_to_message_id === undefined ? {} : { reply_to_message_id: args.reply_to_message_id }),
          ...(args.disable_web_page_preview === undefined ? {} : { disable_web_page_preview: args.disable_web_page_preview }),
          ...(args.reply_options === undefined
            ? {}
            : {
                reply_markup: {
                  inline_keyboard: args.reply_options.map((label, index) => [{
                    text: label,
                    callback_data: adapter.telegramReplyCallbackData(index),
                  }]),
                },
              }),
        },
        { signal: extra.signal },
      );
      const history = await recordAdapterDeliveryHistory({
        settings: deliveryHistory,
        fetchImpl,
        conversationId: `telegram:${String(result.chat.id)}`,
        text: args.text,
        idempotencyKey: `adapter-send:telegram:${String(result.chat.id)}:${String(result.message_id)}`,
      });
      const message = `Sent Telegram message ${result.message_id} to ${String(result.chat.id)}.`;
      return {
        content: [{ type: "text", text: withDeliveryHistoryWarning(message, history) }],
        structuredContent: {
          ok: true,
          chat_id: result.chat.id,
          message_id: result.message_id,
          ...(args.reply_options === undefined ? {} : { reply_options: args.reply_options }),
          ...(history === undefined ? {} : { history }),
        },
      };
    },
  );
}

/**
 * Register the single `TelegramSendFile` tool. A required `kind` param selects
 * `"document"` (any file, shown as a downloadable document) or `"photo"` (an image
 * shown inline). Both accept the file as base64 `data` (with a `filename`) OR a
 * workspace `path` (filename derived from the basename), enforce the adapter
 * allowlist, and bound the size to the adapter's inbound cap before uploading via
 * the adapter-owned sender. Producing-conversation scope omits `chat_id` from the
 * schema and derives it from trusted request context instead.
 */
function registerTelegramSendFileTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Partial<Pick<TelegramMessageSender, "sendDocument" | "sendPhoto">>,
  adapter: TelegramAdapterModule,
): void {
  const producingConversationScope = settings.sendTools?.scope === "producing-conversation";
  const inputSchema = {
    kind: z.enum(["document", "photo"]).describe("`document` for any file (downloadable), `photo` for an image shown inline."),
    ...(producingConversationScope
      ? {}
      : {
          chat_id: z
            .union([z.string().min(1), z.number().int()])
            .describe("Telegram chat id from the adapter allowlist."),
        }),
    data: z.string().min(1).optional().describe("Base64-encoded file bytes. Provide this or `path`."),
    path: z.string().min(1).optional().describe("Path to a file to upload (resolved against the agent working dir). Provide this or `data`."),
    filename: z.string().min(1).optional().describe("Filename to present. Required with `data` for a document; derived from `path` otherwise."),
    caption: z.string().min(1).optional().describe("Optional caption shown with the file."),
  };
  server.registerTool(
    "TelegramSendFile",
    {
      title: "Send Telegram file",
      description: producingConversationScope
        ? "Upload and send a file to the Telegram conversation that produced this run. The host binds the destination; provide only the file content or path. Set `kind:\"document\"` to send any file (shown as a downloadable document) or `kind:\"photo\"` to send an image inline. Strict run-output paths are always read through a pinned descriptor."
        : "Upload and send a file to an allowed Telegram chat. Set `kind:\"document\"` to send any file (shown as a downloadable document) or `kind:\"photo\"` to send an image inline. Provide the bytes as base64 `data` (with a `filename` — required for a document), or a workspace `path`. A self-hosted Bot API can stream legacy path uploads.",
      inputSchema,
    },
    async (args, extra) => {
      extra.signal.throwIfAborted();
      const kind = args.kind;
      const sendDocument = client.sendDocument;
      const sendPhoto = client.sendPhoto;
      if ((kind === "document" && sendDocument === undefined) || (kind === "photo" && sendPhoto === undefined)) {
        throw new Error(`TelegramSendFile: the ${kind} sender is unavailable.`);
      }
      const requestedChatId = "chat_id" in args ? args.chat_id : undefined;
      const chatId = resolveTelegramSendFileChatId(settings, requestedChatId);
      if ((args.data !== undefined) === (args.path !== undefined)) {
        throw new Error("provide exactly one of `data` (base64) or `path`.");
      }
      const maxUploadBytes = settings.maxUploadBytes ?? adapter.DEFAULT_ATTACHMENT_MAX_BYTES;
      const strictPathUpload = args.path !== undefined && settings.sendTools?.pathScope === "run-output";
      const strictFile = strictPathUpload
        ? await readStrictTelegramFile(settings, args.path!, maxUploadBytes, extra.signal, args.filename)
        : undefined;
      const uploadPath = args.path === undefined || strictPathUpload
        ? undefined
        : await resolveTelegramUploadPath(args.path);
      // file:// fast path: a --local self-hosted server reads the file straight
      // from disk, so a path upload needs no buffering at any size — only a
      // stat-level cap check. Falls back once to the buffered path when the
      // server rejects the URI (e.g. a non---local self-hosted root).
      if (kind === "document" && settings.apiRoot !== undefined && uploadPath !== undefined && args.data === undefined) {
        const info = await stat(uploadPath);
        if (!info.isFile() || info.size === 0) {
          throw new Error("file is empty or not a regular file.");
        }
        if (info.size > maxUploadBytes) {
          throw new Error(`file exceeds the ${String(maxUploadBytes)}-byte upload cap.`);
        }
        try {
          const sent: TelegramSentMessage = await sendDocument!(
            {
              chat_id: chatId,
              document: pathToFileURL(uploadPath).href,
              ...(args.caption === undefined ? {} : { caption: args.caption }),
            },
            { signal: extra.signal },
          );
          const name = basename(uploadPath);
          return telegramSendFileResult(producingConversationScope, kind, sent, name);
        } catch (error) {
          // Retry buffered exactly once; rethrow anything that isn't a server-side rejection.
          if ((error as { kind?: string }).kind !== "telegram") {
            throw error;
          }
        }
      }
      const { bytes, filename } = strictFile ?? await resolveTelegramFileBytes({
          data: args.data,
          path: args.path,
          ...(uploadPath === undefined ? {} : { resolvedPath: uploadPath }),
          filename: args.filename,
          requireFilename: kind === "document",
          maxBytes: maxUploadBytes,
          signal: extra.signal,
      });
      const result: TelegramSentMessage =
        kind === "document"
          ? await sendDocument!(
              {
                chat_id: chatId,
                document: bytes,
                filename,
                ...(args.caption === undefined ? {} : { caption: args.caption }),
              },
              { signal: extra.signal },
            )
          : await sendPhoto!(
              {
                chat_id: chatId,
                photo: bytes,
                filename,
                ...(args.caption === undefined ? {} : { caption: args.caption }),
              },
              { signal: extra.signal },
            );
      return telegramSendFileResult(producingConversationScope, kind, result, filename);
    },
  );
}

function resolveTelegramSendFileChatId(
  settings: TelegramSendToolSettings,
  requestedChatId: TelegramChatId | undefined,
): TelegramChatId {
  if (settings.sendTools?.scope === "producing-conversation") {
    const producingChatId = telegramChatIdFromConversation(settings.producingConversationId);
    if (producingChatId === undefined) {
      throw new Error("TelegramSendFile: producing Telegram conversation context is unavailable.");
    }
    assertTelegramChatAllowed(settings, producingChatId, "TelegramSendFile");
    return producingChatId;
  }
  if (requestedChatId === undefined) {
    throw new Error("TelegramSendFile: chat_id is required outside producing-conversation scope.");
  }
  assertTelegramChatAllowed(settings, requestedChatId, "TelegramSendFile");
  return requestedChatId;
}

function telegramSendFileResult(
  producingConversationScope: boolean,
  kind: "document" | "photo",
  sent: TelegramSentMessage,
  filename: string,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const destination = producingConversationScope
    ? "the producing Telegram conversation"
    : String(sent.chat.id);
  return {
    content: [{ type: "text", text: `Sent ${kind} ${sent.message_id} (${filename}) to ${destination}.` }],
    structuredContent: {
      ok: true,
      ...(producingConversationScope ? {} : { chat_id: sent.chat.id }),
      message_id: sent.message_id,
      filename,
    },
  };
}

/** Resolve the upload bytes + filename from exactly one of base64 `data` or a `path`. */
async function resolveTelegramFileBytes(input: {
  data: string | undefined;
  path: string | undefined;
  resolvedPath?: string;
  filename: string | undefined;
  requireFilename: boolean;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const hasData = input.data !== undefined;
  const hasPath = input.path !== undefined;
  if (hasData === hasPath) {
    throw new Error("provide exactly one of `data` (base64) or `path`.");
  }
  let bytes: Uint8Array;
  let filename: string;
  if (hasData) {
    bytes = new Uint8Array(Buffer.from(input.data!, "base64"));
    if (input.filename === undefined) {
      if (input.requireFilename) {
        throw new Error("`filename` is required when sending a document by `data`.");
      }
      filename = "image";
    } else {
      filename = input.filename;
    }
  } else {
    const resolved = input.resolvedPath ?? resolvePath(process.cwd(), input.path!);
    bytes = new Uint8Array(await readFile(resolved, { signal: input.signal }));
    filename = input.filename ?? basename(resolved);
  }
  if (bytes.byteLength === 0) {
    throw new Error("file is empty.");
  }
  if (bytes.byteLength > input.maxBytes) {
    throw new Error(`file exceeds the ${String(input.maxBytes)}-byte upload cap.`);
  }
  return { bytes, filename };
}

async function resolveTelegramUploadPath(inputPath: string): Promise<string> {
  return resolvePath(process.cwd(), inputPath);
}

const STRICT_TELEGRAM_PATH_ERROR =
  "TelegramSendFile: path must be a regular file inside the current run output directory.";

/**
 * Read a strict upload through one no-follow file descriptor. Every path check
 * deliberately collapses to the same error so callers cannot use the tool as
 * an existence oracle for files outside the run directory.
 */
async function readStrictTelegramFile(
  settings: TelegramSendToolSettings,
  inputPath: string,
  maxBytes: number,
  signal: AbortSignal,
  requestedFilename: string | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly filename: string }> {
  try {
    signal.throwIfAborted();
    if (settings.runOutputDir === undefined || settings.runOutputIdentity === undefined) {
      throw new Error(STRICT_TELEGRAM_PATH_ERROR);
    }
    const rootStats = await lstat(settings.runOutputDir);
    if (!rootStats.isDirectory()
      || rootStats.isSymbolicLink()
      || !sameFileIdentity(rootStats, settings.runOutputIdentity)) {
      throw new Error(STRICT_TELEGRAM_PATH_ERROR);
    }
    const rootReal = await realpath(settings.runOutputDir);
    const candidate = resolvePath(process.cwd(), inputPath);
    const candidateLinkStats = await lstat(candidate);
    if (!candidateLinkStats.isFile()
      || candidateLinkStats.isSymbolicLink()
      || candidateLinkStats.nlink !== 1) {
      throw new Error(STRICT_TELEGRAM_PATH_ERROR);
    }
    const candidateReal = await realpath(candidate);
    if (!pathIsInside(rootReal, candidateReal)) throw new Error(STRICT_TELEGRAM_PATH_ERROR);

    const handle = await open(candidateReal, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile()
        || openedStats.nlink !== 1
        || openedStats.size === 0
        || openedStats.size > maxBytes) {
        throw new Error(STRICT_TELEGRAM_PATH_ERROR);
      }
      if (!sameFileIdentity(openedStats, fileIdentity(candidateLinkStats))) {
        throw new Error(STRICT_TELEGRAM_PATH_ERROR);
      }
      await assertPinnedCandidate(candidateReal, openedStats);
      await assertUnchangedRunRoot(settings.runOutputDir, rootReal, settings.runOutputIdentity);
      const bytes = await readPinnedBytes(handle, openedStats.size, signal);
      await assertPinnedCandidate(candidateReal, openedStats);
      await assertUnchangedRunRoot(settings.runOutputDir, rootReal, settings.runOutputIdentity);
      const finalStats = await handle.stat();
      if (!sameFileIdentity(finalStats, fileIdentity(openedStats))
        || finalStats.nlink !== 1
        || finalStats.size !== openedStats.size
        || bytes.byteLength === 0
        || bytes.byteLength > maxBytes) {
        throw new Error(STRICT_TELEGRAM_PATH_ERROR);
      }
      return { bytes, filename: requestedFilename ?? basename(candidateReal) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  }
}

async function readPinnedBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset !== size) throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  return new Uint8Array(bytes);
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function assertPinnedCandidate(
  path: string,
  opened: { readonly dev: number; readonly ino: number },
): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || !sameFileIdentity(current, fileIdentity(opened))) {
    throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  }
}

async function assertUnchangedRunRoot(
  path: string,
  expectedRealPath: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expectedIdentity)) {
    throw new Error(STRICT_TELEGRAM_PATH_ERROR);
  }
  if (await realpath(path) !== expectedRealPath) throw new Error(STRICT_TELEGRAM_PATH_ERROR);
}

async function resolveSlackSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
): Promise<SlackSendToolSettings | undefined> {
  try {
    const adapter = await loadSlackModule();
    const config = await adapter.loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    return {
      botToken: config.botToken,
      allowedChannelIds: config.allowedChannelIds.map(normalizeSlackChannelId),
      allowAllChannels: config.allowAllChannels,
    };
  } catch (error) {
    options.logger?.warn?.("Slack send tool skipped because Slack adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
}

async function resolveTelegramSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
  tools: TelegramSendToolSettings["tools"],
): Promise<TelegramSendToolSettings | undefined> {
  try {
    const adapter = await loadTelegramModule();
    const config = await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    const producingConversationId = optionalString(input.env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
    const runOutputDir = optionalString(input.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DIR);
    const runOutputIdentity = parseFileIdentity(
      input.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DEV,
      input.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_INO,
    );
    return {
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      allowAllChats: config.allowAllChats,
      ...(config.apiRoot === undefined ? {} : { apiRoot: config.apiRoot }),
      maxUploadBytes: config.attachments?.maxUploadBytes ?? adapter.DEFAULT_ATTACHMENT_MAX_BYTES,
      tools,
      ...(config.sendTools === undefined ? {} : { sendTools: config.sendTools }),
      ...(producingConversationId === undefined ? {} : { producingConversationId }),
      ...(runOutputDir === undefined ? {} : { runOutputDir }),
      ...(runOutputIdentity === undefined ? {} : { runOutputIdentity }),
    };
  } catch (error) {
    options.logger?.warn?.("Telegram send tool skipped because Telegram adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
}

function assertSlackChannelAllowed(settings: SlackSendToolSettings, channel: string): void {
  if (settings.allowAllChannels || settings.allowedChannelIds.includes(normalizeSlackChannelId(channel))) {
    return;
  }
  throw new Error("SlackSendMessage: channel is not allowed by Slack adapter config.");
}

function assertTelegramChatAllowed(
  settings: TelegramSendToolSettings,
  chatId: TelegramChatId,
  toolName: TelegramSendToolName,
): void {
  const normalized = String(chatId);
  if (settings.sendTools?.scope === "producing-conversation") {
    const producingChatId = telegramChatIdFromConversation(settings.producingConversationId);
    if (producingChatId === undefined) {
      throw new Error(`${toolName}: producing Telegram conversation context is unavailable.`);
    }
    if (normalized !== producingChatId) {
      throw new Error(`${toolName}: chat_id must match the producing Telegram conversation.`);
    }
  }
  if (settings.allowAllChats || settings.allowedChatIds.includes(normalized)) {
    return;
  }
  throw new Error(`${toolName}: chat_id is not allowed by Telegram adapter config.`);
}

function telegramChatIdFromConversation(conversationId: string | undefined): string | undefined {
  if (conversationId === undefined) return undefined;
  const base = conversationId.split("#", 1)[0] ?? conversationId;
  if (!base.startsWith("telegram:")) return undefined;
  const chatId = base.slice("telegram:".length);
  return chatId.length === 0 ? undefined : chatId;
}

const SAFE_ADAPTER_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function ensureAdapterRunOutputDir(
  root: string,
  runId: string,
): Promise<{ readonly path: string; readonly identity: FileIdentity }> {
  if (!SAFE_ADAPTER_RUN_ID.test(runId)) {
    throw new Error("adapter-send-tools: run id is unsafe for the run output directory.");
  }
  const outputRoot = resolvePath(root);
  const runOutputDir = join(outputRoot, runId);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(runOutputDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await lstat(runOutputDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("adapter-send-tools: run output path is not a real directory.");
    }
  }
  const current = await lstat(runOutputDir);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error("adapter-send-tools: run output path is not a real directory.");
  }
  return { path: runOutputDir, identity: fileIdentity(current) };
}

function fileIdentity(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(
  stats: { readonly dev: number; readonly ino: number },
  expected: FileIdentity,
): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

function parseFileIdentity(devValue: string | undefined, inoValue: string | undefined): FileIdentity | undefined {
  const dev = Number(devValue);
  const ino = Number(inoValue);
  return Number.isSafeInteger(dev) && dev >= 0 && Number.isSafeInteger(ino) && ino > 0
    ? { dev, ino }
    : undefined;
}

async function removeOwnedDirectory(path: string, expected: FileIdentity): Promise<void> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) return;
  await rm(path, { recursive: true, force: true });
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeSlackChannelId(value: string): string {
  return value.trim().toLowerCase();
}

/** The legacy snake_case names that alias to the canonical new `name` (may be empty). */
function legacyAliasesFor(name: string): readonly string[] {
  return Object.keys(LEGACY_TOOL_ALIASES).filter((legacy) => LEGACY_TOOL_ALIASES[legacy] === name);
}

function isAdapterToolAllowed(name: string, options: AdapterSendToolsResolveOptions): boolean {
  const wildcard = `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__*`;
  // Match the canonical new name AND every legacy snake_case alias that maps to it.
  // A pre-rename config listing e.g. the `telegram_send_photo` alias still enables
  // the collapsed `TelegramSendFile` tool; each is matched bare + mcp-prefixed.
  const matchNames = [name, ...legacyAliasesFor(name)];
  const aliases = matchNames.flatMap((matchName) => [
    matchName,
    `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__${matchName}`,
  ]);
  const allowed = options.allowedTools ?? [];
  const disallowed = options.disallowedTools ?? [];
  if (disallowed.includes(wildcard) || aliases.some((alias) => disallowed.includes(alias))) {
    return false;
  }
  if (aliases.some((alias) => allowed.includes(alias))) {
    return true;
  }
  if (allowed.includes(wildcard)) {
    return true;
  }
  return allowed.includes(ALLOW_ALL_TOOLS); // global allow-all (deny check above still wins)
}

function parseAllowedToolNames(raw: string | undefined): readonly string[] {
  const value = optionalString(raw);
  if (value === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("adapter-send-tools: invalid MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS (expected a JSON string array).");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("adapter-send-tools: invalid MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS (expected a JSON string array).");
  }
  return parsed;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
