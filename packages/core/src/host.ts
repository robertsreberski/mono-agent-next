// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_INTERACTION_LIMITS, DEFAULT_APPROVAL_TIMEOUT_MS, HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE,
  MODULE_TOOL_LIMITS,
  RUNTIME_SESSION_UNAVAILABLE_CODE, parseApprovalDecision, parseApprovalRequest, parseArtifactRef,
  parseAskUserAnswer, parseAskUserRequest, snapshotRuntimeTurnError,
  type ArtifactRef, type ApprovalDecision, type ApprovalRequest, type AskUserAnswer, type AskUserRequest,
  type Channel, type ChannelAttachment, type ChannelCapabilities, type ChannelCompletionDelivery,
  type ChannelConversationListRequest, type ChannelConversationListResult, type ChannelDeliveryResult, type ChannelHost,
  type ChannelInboundRequest, type ChannelModuleDefinition, type ChannelOpenConversationRequest,
  type ChannelOpenConversationResult, type ChannelOutboundMessage, type ChannelReplyEvent, type ChannelReplySink,
  type ChannelReplayRequest, type ChannelReplayResult, type ChannelSendTool, type ChannelTurnResult, type ConfigProvenanceMap,
  type JsonObject, type JsonValue, type Memory, type MemoryHost, type MemoryModuleDefinition, type MemoryRecord,
  type MemoryRuntimeCaptureRequest, type MemoryRuntimeCaptureResult, type ModuleDiagnostic,
  type ModuleHost, type ModuleHealth, type ModuleInstance, type ModuleLogger, type Runtime, type RuntimeLiveInputHandler,
  type ModuleToolContribution, type ModuleToolTurnContext,
  type RuntimeModuleDefinition,
  type RuntimeNativeToolDescriptor, type RuntimeNativeToolEffect, type RuntimeSession,
  type RuntimeTurnErrorSnapshot, type RuntimeToolCall,
  type RuntimeToolResult, type RuntimeTurnEvent, type RuntimeTurnResult, type TurnMessage,
} from "@mono-agent/module-sdk";
import type { Exporter, ReservedModuleDefinition, Sandbox, StateStore, TriggerEvent, TriggerHost, TriggerReceipt } from "@mono-agent/module-sdk/internal";
import {
  assertModuleToolBindingCompliance,
  assertModuleToolContributionsCompliance,
  snapshotSelectedModuleInstanceCompliance,
} from "@mono-agent/module-sdk/testing";
import { ensureLoadedAgentConfig, environmentFor } from "./config.js";
import { cloneIntrinsicUint8Array } from "./binary.js";
import { assertOwnKeys, denseOwnDataArray as boundedOwnDataArray, ownDataRecord as boundedOwnDataRecord, snapshotBoundedValue } from "./bounded-value.js";
import { AgentAdmissionError, AgentConfigError, AgentModuleError, RunExecutionError, errorMessage } from "./errors.js";
import { escalateMessageEffort } from "./effort.js";
import { ConversationTails, durableFingerprint, submissionFingerprint } from "./host-admission.js";
import { createAskUserTool, createMemoryRecallTool, moduleProvenance, readInstructions } from "./host-instructions.js";
import { NULL_LOGGER, snapshotInstanceCapabilities } from "./host-module-instances.js";
import { deliveryTriggerKind, normalizeCompletionDelivery, normalizeOutboundMessage } from "./host-outbound.js";
import {
  boundedUtf8, inspectModuleFailure, redactBounded, redactChannelToolEvent, sanitizeModuleCommandError,
} from "./host-redaction.js";
import {
  routeCandidates, runtimeEligibility, runtimeSessionMapKey, runtimeSessionRouteKey,
} from "./host-routing.js";
import { HostDiagnostics } from "./host-diagnostics.js";
import { HostInteractions } from "./host-interactions.js";
import { HostSessions } from "./host-sessions.js";
import { normalizeLiveInput, normalizeSubmitInput } from "./host-submit-input.js";
import {
  assertUnambiguousToolPolicy, bindModuleTools, collectChannelTools, createdModuleToolSnapshot,
  executeTool, filterTools, moduleRuntimeTool, resolveToolCatalog, snapshotChannelSendTools,
  stateArtifactSink, toolEffects,
} from "./host-tool-catalog.js";
import {
  cacheableAssistantMessage, decodeCachedAgentResponse, encodeCachedAgentResponse,
  renderAskUserAnswer, renderAskUserRequest, renderRecalledMemory, snapshotMemoryRecallRecords,
  textFromMessage, turnMessagesFromTranscript,
} from "./host-transcript.js";
import {
  ASK_USER_TOOL_NAME, DEFAULT_INSTRUCTION_BYTES, DEFAULT_MESSAGE_BYTES, MEMORY_RECALL_TOOL_NAME,
  type AmbiguousToolAlias, type BoundChannelTool, type BoundModuleTool, type RunningModule,
  type SessionDisposition, type TranscriptContentDraft, type VerbatimEntry,
} from "./host-types.js";
import {
  assertBoundedText, assertRouteText, encodePersistedValue, immutableClone, isJsonValue, isRecord,
  positiveInteger, referencedEnvironmentValues, sameStringSet, toJsonObject, toJsonValue, turnBinaryData,
} from "./host-values.js";
import {
  HostDelivery,
} from "./host-delivery.js";
import {
  HostHealthMonitor,
  normalizeModuleJson,
  normalizeModuleHealth,
  redactJson,
  type HostLifecycleState,
} from "./host-health.js";
import {
  HostLifecycleCalls,
  TurnSemaphore,
  abortError,
  settlementSignal,
  isAbort,
  throwIfAborted,
  waitForValueWithAbort,
  withTimeoutSignal,
} from "./host-lifecycle.js";
import {
  ActiveTurn, boundedRuntimeFailureMessage, isSafeRuntimeFallback, turnExecutionError,
} from "./host-turn.js";
import { connectProjectMcpTools, type ConnectedMcpTools, type CoreRuntimeTool } from "./mcp.js";
import { decodeAuthorityText, readAuthorityFile } from "./authority-read.js";
import { createCurrentRunFiles, type CurrentRunFiles } from "./current-run-output.js";
import { moduleConfigFor } from "./module-loader.js";
import { nativeToolAllowed, runtimeNativeToolPolicyIssue } from "./native-tool-policy.js";
import { normalizeToolResult, type ToolResultArtifactSink } from "./tool-result-normalizer.js";
import { StateExecutionClient, type DurableFingerprint, type CanonicalTranscript } from "./state-execution-client.js";
import { assertRuntimeTurnEventBoundaryHealthy, createRuntimeTurnEventBoundary, normalizeChannelCapabilities,
  normalizeRuntimeCapabilities, normalizeModuleDiagnostic, normalizeRuntimeModelValidation, normalizeRuntimeToolCall,
  normalizeRuntimeTurnEvent, normalizeRuntimeTurnResult } from "./runtime-result-normalizer.js";
import type { AgentHealth, AgentHost, AgentHostOptions, AgentHostStartInfo, AgentAskAnswer,
  AgentAskAnswerStatus, AgentApprovalAnswer, AgentApprovalAnswerStatus, AgentConfigView, AgentConversationReplay,
  AgentConversationSummary, AgentLiveInput, AgentLiveInputStatus, AgentModuleCommandResult, AgentModuleDiagnostics,
  AgentResponse, AgentResponseMessage, AgentInteractionEvidence, AgentRunAttemptEvidence, AgentRunHistoryPage,
  AgentRunRecord, AgentSubmitInput, AgentTranscriptContentPart, AgentTranscriptEntry, LoadedAgentConfig,
  LoadedAgentModule, ModuleKind, RuntimeRoute } from "./types.js";
const DEFAULT_MAX_CONCURRENT_TURNS = 4, DEFAULT_MAX_PENDING_TURNS = 64;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000, DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000, DEFAULT_LIVE_INPUT_ACK_TIMEOUT_MS = 5_000;
const MODULE_DIAGNOSTIC_MAX_ITEMS = 100;
const MAX_TRIGGER_CLAIMS = 10_000;
const PROACTIVE_SUPPRESSION_SENTINEL = "NOTHING_TO_REPORT";
export async function createAgentHost(
  config: string | LoadedAgentConfig,
  options: AgentHostOptions = {},
): Promise<AgentHost> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  const host = new AgentHostImplementation(loaded, options);
  await host.start();
  return host;
}
export async function runAgentModuleCommand(
  config: string | LoadedAgentConfig,
  moduleInstanceId: string,
  commandName: string,
  input?: unknown,
  options: AgentHostOptions = {},
): Promise<AgentModuleCommandResult> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  return new AgentHostImplementation(loaded, options)
    .runModuleCommand(moduleInstanceId, commandName, input);
}
export async function diagnoseAgent(
  config: string | LoadedAgentConfig,
  verbose = false,
  options: AgentHostOptions = {},
): Promise<readonly AgentModuleDiagnostics[]> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  return new AgentHostImplementation(loaded, options).diagnostics(verbose);
}
class AgentHostImplementation implements AgentHost {
  readonly config: LoadedAgentConfig;
  readonly #options: Required<Pick<AgentHostOptions, "maxConcurrentTurns" | "maxPendingTurns" | "drainTimeoutMs" | "lifecycleTimeoutMs">>;
  readonly #hostAbort = new AbortController();
  readonly #runtimeInstances = new Map<string, Runtime>();
  readonly #runtimeCapabilities = new Map<string, Readonly<Runtime["capabilities"]>>();
  readonly #createdRuntimeCapabilities = new WeakMap<object, Readonly<Runtime["capabilities"]>>();
  readonly #channelInstances = new Map<string, Channel>();
  readonly #channelCapabilities = new Map<string, Readonly<ChannelCapabilities>>();
  readonly #createdChannelCapabilities = new WeakMap<object, Readonly<ChannelCapabilities>>();
  readonly #createdChannelTools = new WeakMap<object, readonly ChannelSendTool[]>();
  readonly #createdModuleTools = new WeakMap<object, readonly ModuleToolContribution[]>();
  #moduleTools: readonly BoundModuleTool[] = [];
  #channelTools: readonly BoundChannelTool[] = [];
  #ambiguousToolAliases: readonly AmbiguousToolAlias[] = [];
  readonly #exporterInstances = new Map<string, Exporter>();
  readonly #running: RunningModule[] = [];
  readonly #history = new Map<string, readonly TurnMessage[]>();
  readonly #sessionStore: HostSessions;
  readonly #diagnostics: HostDiagnostics;
  readonly #interactions: HostInteractions;
  readonly #loadedConversations = new Set<string>();
  readonly #conversationUpdatedAt = new Map<string, string>();
  readonly #conversationTitles = new Map<string, string>();
  readonly #conversationMetadata = new Map<string, JsonObject>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #triggerClaims = new Map<string, "pending" | "delivery_unknown" | "execution_unknown">();
  /**
   * Unknown trigger outcomes are retained so a replayed event cannot execute
   * twice. Retention is bounded: the oldest claim is dropped past the cap, and
   * a dropped claim degrades to at-least-once for that one event rather than
   * growing the ledger without limit.
   */
  readonly #health: HostHealthMonitor;
  readonly #conversationTails = new ConversationTails();
  readonly #localHistoryTails = new ConversationTails();
  readonly #inflightRequests = new Map<string, {
    readonly fingerprint: DurableFingerprint;
    readonly promise: Promise<AgentResponse>;
  }>();
  readonly #transcripts = new Map<string, CanonicalTranscript>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #semaphore: TurnSemaphore;
  readonly #lifecycle: HostLifecycleCalls;
  readonly #delivery: HostDelivery;
  readonly #redactionValues: readonly string[];
  #mcp: ConnectedMcpTools = { tools: [], async close() {} };
  #memory: Memory | undefined;
  #memoryRecallEnabled = false;
  #stateStore: StateStore | undefined;
  #execution: StateExecutionClient | undefined;
  #sandbox: Sandbox | undefined;
  #instructions = "";
  #instructionTools: readonly CoreRuntimeTool[] = [];
  #state: HostLifecycleState = "new";
  #pending = 0;
  #active = 0;
  #startPromise?: Promise<void>;
  #drainPromise?: Promise<void>;
  #stopPromise?: Promise<void>;
  #startInfo: AgentHostStartInfo;
  constructor(config: LoadedAgentConfig, options: AgentHostOptions) {
    this.config = config;
    this.#options = {
      maxConcurrentTurns: positiveInteger(options.maxConcurrentTurns, DEFAULT_MAX_CONCURRENT_TURNS, "maxConcurrentTurns"),
      maxPendingTurns: positiveInteger(options.maxPendingTurns, DEFAULT_MAX_PENDING_TURNS, "maxPendingTurns"),
      drainTimeoutMs: positiveInteger(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, "drainTimeoutMs"),
      lifecycleTimeoutMs: positiveInteger(options.lifecycleTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS, "lifecycleTimeoutMs"),
    };
    if (this.#options.maxPendingTurns < this.#options.maxConcurrentTurns) {
      throw new RangeError("maxPendingTurns must be greater than or equal to maxConcurrentTurns");
    }
    this.#semaphore = new TurnSemaphore(this.#options.maxConcurrentTurns);
    this.#sessionStore = new HostSessions({ config, execution: () => this.#execution });
    this.#lifecycle = new HostLifecycleCalls(this.#options.lifecycleTimeoutMs, this.#hostAbort.signal);
    this.#diagnostics = new HostDiagnostics({
      config,
      lifecycle: this.#lifecycle,
      running: () => this.#running,
      createInstance: (module, signal) => this.#createInstance(module, signal),
      redact: (message) => this.#redact(message),
    });
    this.#delivery = new HostDelivery({
      hostSignal: this.#hostAbort.signal,
      lifecycleTimeoutMs: this.#options.lifecycleTimeoutMs,
      channels: this.#channelInstances,
      transcripts: this.#transcripts,
      localHistoryTails: this.#localHistoryTails,
      execution: () => this.#execution,
      loadConversation: (conversationId, signal) => {
        this.#loadedConversations.delete(conversationId);
        return this.#loadConversation(conversationId, signal);
      },
      appendLocalVerbatim: (conversationId, entries, updatedAt) => {
        this.#appendLocalVerbatim(conversationId, entries, updatedAt);
      },
      redact: (message) => this.#redact(message),
    });
    this.#interactions = new HostInteractions({
      config,
      lifecycleTimeoutMs: this.#options.lifecycleTimeoutMs,
      hostSignal: this.#hostAbort.signal,
      activeTurn: (conversationId) => this.#activeTurns.get(conversationId),
      appendEvidence: (input, active, evidence, text, signal) =>
        this.#appendInteractionEvidence(input, active, evidence, text, signal),
    });
    this.#redactionValues = referencedEnvironmentValues(
      [config.raw, config.mcp],
      environmentFor(config),
    );
    this.#health = new HostHealthMonitor(this.#lifecycle, (message) => this.#redact(message));
    this.#startInfo = {
      agentId: config.raw.agent.id,
      configPath: config.configPath,
      projectRoot: config.projectRoot,
      channels: [],
    };
  }
  get startInfo(): AgentHostStartInfo {
    return this.#startInfo;
  }
  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#state === "draining" || this.#state === "stopped" || this.#state === "failed") {
      return Promise.reject(new Error(`Agent host cannot start from ${this.#state}`));
    }
    this.#startPromise ??= this.#startInternal();
    return this.#startPromise;
  }
  submit(input: AgentSubmitInput): Promise<AgentResponse> {
    try {
      input = normalizeSubmitInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#submitRequest(input, async () => {});
  }
  async cancel(conversationId: string, reason = "cancelled by operator"): Promise<boolean> {
    const active = this.#activeTurns.get(conversationId);
    if (active === undefined) return false;
    active.controller.abort(abortError(reason));
    return true;
  }
  async offerLiveInput(
    conversationId: string, input: AgentLiveInput, suppliedSignal?: AbortSignal,
  ): Promise<AgentLiveInputStatus> {
    return this.#interactions.offerLiveInput(conversationId, input, suppliedSignal);
  }
  async answerAsk(conversationId: string, answer: AgentAskAnswer): Promise<AgentAskAnswerStatus> {
    return this.#interactions.answerAsk(conversationId, answer);
  }
  async answerApproval(
    conversationId: string, decision: AgentApprovalAnswer,
  ): Promise<AgentApprovalAnswerStatus> {
    return this.#interactions.answerApproval(conversationId, decision);
  }
  async conversations(): Promise<readonly AgentConversationSummary[]> {
    if (this.#execution !== undefined) {
      let cursor: string | undefined;
      let seen = 0;
      do {
        const page = await this.#execution.listConversations(cursor, this.#hostAbort.signal);
        for (const conversation of page.conversations) {
          this.#commitConversationMetadata(conversation);
          seen += 1;
          if (seen > 10_000) throw new RangeError("conversation discovery exceeds its bound");
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }
    const ids = new Set<string>([
      ...this.#history.keys(),
      ...this.#conversationUpdatedAt.keys(),
      ...this.#activeTurns.keys(),
    ]);
    return [...ids]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => {
        const title = this.#conversationTitles.get(id);
        const metadata = this.#conversationMetadata.get(id);
        return {
          id,
          updatedAt: this.#conversationUpdatedAt.get(id) ?? new Date(0).toISOString(),
          active: this.#activeTurns.has(id),
          ...(title === undefined ? {} : { title }),
          ...(metadata === undefined ? {} : { metadata }),
        };
      });
  }
  async replay(conversationId: string): Promise<AgentConversationReplay> {
    await this.#loadConversation(conversationId, this.#hostAbort.signal);
    const active = this.#activeTurns.get(conversationId);
    return immutableClone({
      conversationId,
      messages: this.#history.get(conversationId) ?? [],
      ...(active === undefined ? {} : { activeTurnId: active.id }),
    });
  }
  async listRuns(cursor?: string): Promise<AgentRunHistoryPage> {
    if (this.#execution !== undefined) {
      return this.#execution.listRuns(cursor, this.#hostAbort.signal);
    }
    if (cursor !== undefined) throw new TypeError("run-history cursor is unavailable without state");
    return { runs: [] };
  }
  async readRun(runId: string): Promise<AgentRunRecord | undefined> {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new TypeError("runId must be non-empty");
    }
    assertBoundedText(runId, "runId", 512);
    if (this.#execution !== undefined) {
      return this.#execution.readRun(runId, this.#hostAbort.signal);
    }
    return undefined;
  }
  async configView(): Promise<AgentConfigView> {
    const source = JSON.stringify(this.config.raw);
    return {
      revision: createHash("sha256").update(source).digest("hex"),
      generatedAt: new Date().toISOString(),
      value: redactJson(
        structuredClone(this.config.raw) as unknown as JsonValue,
        (text) => this.#redact(text),
      ) as unknown as Readonly<Record<string, unknown>>,
      redacted: true,
    };
  }
  async runModuleCommand(
    moduleInstanceId: string, commandName: string, input?: unknown,
  ): Promise<AgentModuleCommandResult> {
    return this.#diagnostics.runCommand(moduleInstanceId, commandName, input);
  }
  async diagnostics(verbose = false): Promise<readonly AgentModuleDiagnostics[]> {
    return this.#diagnostics.inspect(verbose);
  }
  async deliver(channelInstanceId: string, message: ChannelOutboundMessage): Promise<ChannelDeliveryResult> {
    return (await this.#delivery.deliver(
      channelInstanceId, message, this.#hostAbort.signal,
    )).result;
  }
  #admit(input: AgentSubmitInput): void {
    if (this.#state !== "running") {
      throw new AgentAdmissionError(
        "not_accepting",
        `Agent is not accepting turns (${this.#state})`,
        input.requestId === undefined ? {} : { requestId: input.requestId },
      );
    }
    if (typeof input.conversationId !== "string" || input.conversationId.trim().length === 0) {
      throw new TypeError("conversationId must be non-empty");
    }
    if (typeof input.text !== "string" || (input.text.length === 0 && (input.attachments?.length ?? 0) === 0)) {
      throw new TypeError("text or at least one attachment is required");
    }
    if (this.#pending >= this.#options.maxPendingTurns) {
      throw new AgentAdmissionError(
        "capacity_exceeded",
        `Agent pending-turn limit ${this.#options.maxPendingTurns} reached`,
        input.requestId === undefined ? {} : { requestId: input.requestId },
      );
    }
    this.#pending += 1;
  }
  async health(): Promise<AgentHealth> {
    return this.#health.inspect({
      state: this.#state,
      pending: this.#pending,
      active: this.#active,
      running: this.#running,
    });
  }
  drain(): Promise<void> {
    return this.#drainPromise ??= this.#drainInternal();
  }
  stop(): Promise<void> {
    return this.#stopPromise ??= this.#stopInternal();
  }
  async #startInternal(): Promise<void> {
    this.#state = "starting";
    try {
      const loadedInstructions = await readInstructions(this.config);
      this.#instructions = loadedInstructions.text;
      this.#instructionTools = loadedInstructions.tools;
      const environment = environmentFor(this.config);
      const phases: readonly ModuleKind[] = ["state", "sandbox", "exporter", "runtime", "memory"];
      for (const kind of phases) await this.#startKind(kind);
      this.#mcp = await connectProjectMcpTools(this.config.mcp, {
        projectRoot: this.config.projectRoot,
        ...(this.config.paths.mcpConfig === undefined ? {} : { configPath: this.config.paths.mcpConfig }),
        environment,
        ...(this.config.raw.context?.mcp?.requestContextServers === undefined ? {} : {
          requestContextServers: this.config.raw.context.mcp.requestContextServers,
        }),
      });
      const reservedCoreTools = [
        ...this.#instructionTools.map((tool) => tool.name),
        ASK_USER_TOOL_NAME,
        MEMORY_RECALL_TOOL_NAME,
      ];
      await this.#startKind("channel");
      this.#startInfo = {
        ...this.#startInfo,
        channels: [...this.#channelInstances.entries()].map(([instanceId, channel]) => ({
          instanceId,
          kind: "channel" as const,
          ...(isRecord(channel) && typeof channel.endpoint === "string"
            ? { endpoint: channel.endpoint } : {}),
        })),
      };
      await this.#startKind("trigger");
      const connectedMcp = this.#mcp;
      const catalog = resolveToolCatalog(
        this.#moduleTools,
        connectedMcp.tools,
        collectChannelTools(this.#channelInstances, this.#createdChannelTools),
        reservedCoreTools,
      );
      this.#moduleTools = catalog.moduleTools;
      this.#channelTools = catalog.channelTools;
      this.#ambiguousToolAliases = catalog.ambiguousAliases;
      this.#mcp = Object.freeze({
        tools: catalog.mcpTools,
        close: () => connectedMcp.close(),
      });
      assertUnambiguousToolPolicy(
        this.config.raw.policy.tools.allow,
        this.config.raw.policy.tools.deny,
        this.#ambiguousToolAliases,
        "agent tool policy",
      );
      await this.#publishChannelPresence();
      this.#state = "running";
    } catch (error) {
      const redactedError = this.#redactedError(error);
      this.#state = "failed";
      this.#hostAbort.abort(redactedError);
      await this.#stopRunning("startup-failed");
      try {
        await this.#lifecycle.cleanup(
          "MCP close after startup failure",
          () => this.#mcp.close(),
        );
      } catch {
        // Preserve the original startup failure after bounded best-effort cleanup.
      }
      throw redactedError;
    }
  }
  async #startKind(kind: ModuleKind): Promise<void> {
    const selected = this.config.modules
      .filter((module) => module.slot === kind)
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    for (const module of selected) {
      const instance = await this.#lifecycle.run(
        `${module.instanceId} create`,
        (signal) => this.#createInstance(module, signal),
      );
      if (instance === undefined) throw new Error(`${module.packageName} create() returned undefined`);
      this.#running.push({ loaded: module, instance });
      if (kind === "runtime") {
        const runtime = instance as Runtime;
        const capabilities = this.#createdRuntimeCapabilities.get(runtime);
        if (capabilities === undefined) {
          throw new Error(`${module.instanceId} runtime capability snapshot is unavailable`);
        }
        this.#runtimeInstances.set(module.instanceId, runtime);
        this.#runtimeCapabilities.set(module.instanceId, capabilities);
      }
      if (kind === "channel") {
        const channel = instance as Channel;
        const capabilities = this.#createdChannelCapabilities.get(channel);
        if (capabilities === undefined) {
          throw new Error(`${module.instanceId} channel capability snapshot is unavailable`);
        }
        this.#channelInstances.set(module.instanceId, channel);
        this.#channelCapabilities.set(module.instanceId, capabilities);
      }
      if (kind === "memory") {
        this.#memory = instance as Memory;
        this.#memoryRecallEnabled = this.#memory.capabilities.recallTool === true;
      }
      if (kind === "state") this.#stateStore = instance as StateStore;
      if (kind === "sandbox") this.#sandbox = instance as Sandbox;
      if (kind === "exporter") this.#exporterInstances.set(module.instanceId, instance as Exporter);
      if (kind === "state") {
        if (this.#stateStore?.execution === undefined) {
          throw new Error(`${module.instanceId} does not expose the required state execution capability`);
        }
        const execution = new StateExecutionClient(this.#stateStore.execution);
        await this.#lifecycle.run(
          `${module.instanceId} state execution protocol`,
          (signal) => execution.assertCompatible(signal),
        );
        this.#execution = execution;
      }
      if (instance.start !== undefined) {
        await this.#lifecycle.run(
          `${module.instanceId} start`,
          (signal) => instance.start?.({ signal }),
        );
      }
      const contributions = this.#createdModuleTools.get(instance as object) ?? [];
      if (this.#moduleTools.length + contributions.length > MODULE_TOOL_LIMITS.total) {
        throw new Error(
          `Selected modules contribute more than ${String(MODULE_TOOL_LIMITS.total)} tools`,
        );
      }
      this.#moduleTools = Object.freeze([
        ...this.#moduleTools,
        ...contributions.map((tool): BoundModuleTool => Object.freeze({
          loaded: module,
          name: tool.name,
          tool,
        })),
      ]);
    }
  }
  async #publishChannelPresence(): Promise<void> {
    const publish = this.#stateStore?.publishHostPresence;
    if (publish === undefined) return;
    const details: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [instanceId, channel] of [...this.#channelInstances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      // readHostPresence is module code: a blocking implementation must not
      // stall startup, so it runs under the same bound as the publish below.
      const fragment = channel.readHostPresence === undefined
        ? undefined
        : await this.#lifecycle.run(
            `${instanceId} host presence`,
            () => channel.readHostPresence?.(),
          );
      if (fragment === undefined) continue;
      if (!isRecord(fragment) || !isJsonValue(fragment)) {
        throw new Error(`Channel ${instanceId} returned invalid host presence JSON.`);
      }
      for (const [key, value] of Object.entries(fragment)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new Error(`Channel ${instanceId} returned an unsafe host presence key.`);
        }
        if (Object.hasOwn(details, key)) {
          throw new Error(`Channel host presence key ${JSON.stringify(key)} is declared more than once.`);
        }
        details[key] = value;
      }
    }
    if (Object.keys(details).length === 0) return;
    await this.#lifecycle.run(
      "channel discovery publication",
      (signal) => publish.call(this.#stateStore, { status: "ready", details: details as JsonObject, signal }),
    );
  }
  async #createInstance(module: LoadedAgentModule, signal: AbortSignal): Promise<ModuleInstance> {
    const host = this.#moduleHost(module);
    const context = {
      instanceId: module.instanceId,
      config: moduleConfigFor(module),
      provenance: moduleProvenance(module, this.config),
      configDirectory: this.config.configDirectory,
      workspaceDirectory: this.config.paths.workspace,
      dataDirectory: resolve(this.config.projectRoot, ".mono-agent", "data", module.slot, module.instanceId),
      logger: NULL_LOGGER,
      host,
      signal,
    };
    const definition = module.definition;
    let instance: unknown;
    if (module.slot === "runtime") {
      instance = await (definition as RuntimeModuleDefinition).create(context);
    } else if (module.slot === "channel") {
      instance = await (definition as ChannelModuleDefinition).create(context as never);
    } else if (module.slot === "memory") {
      instance = await (definition as MemoryModuleDefinition).create(context);
    } else {
      instance = await (definition as ReservedModuleDefinition).create(context as never);
    }
    try {
      if (module.slot === "runtime") {
        this.#createdRuntimeCapabilities.set(
          instance as Runtime,
          snapshotInstanceCapabilities(
            instance, "runtime", module.instanceId, normalizeRuntimeCapabilities,
          ),
        );
      }
      if (module.slot === "channel") {
        this.#createdChannelCapabilities.set(
          instance as Channel,
          snapshotInstanceCapabilities(
            instance, "channel", module.instanceId, normalizeChannelCapabilities,
          ),
        );
      }
      this.#createdModuleTools.set(
        instance as object,
        createdModuleToolSnapshot(module.slot, instance, module.instanceId),
      );
      if (module.slot === "channel") this.#createdChannelTools.set(
        instance as object, snapshotChannelSendTools(instance, module.instanceId));
    } catch (error) {
      throw new AgentModuleError(
        `${module.instanceId} (${module.packageName}) create() returned an invalid ${module.slot} instance: ${errorMessage(error)}`,
        { packageName: module.packageName, configPath: module.configPath, cause: error },
      );
    }
    return instance as ModuleInstance;
  }
  #moduleHost(module: LoadedAgentModule): ModuleHost | ChannelHost | MemoryHost | TriggerHost {
    const capabilityValues = new Map<string, unknown>();
    if (module.slot === "runtime" && this.#sandbox !== undefined && declaresHostCapability(module, "sandbox.execute.v1")) {
      capabilityValues.set("sandbox.execute.v1", {
        execute: (command: unknown) => this.#sandbox?.execute(command as never),
      });
    }
    if (module.slot === "memory" && declaresHostCapability(module, HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE)) {
      capabilityValues.set(HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE, {
        complete: (request: MemoryRuntimeCaptureRequest) => this.#completeMemoryCapture(request),
      });
    }
    if (module.slot === "trigger" && this.#stateStore !== undefined
      && declaresHostCapability(module, "cron.durable-state.v1")) {
      const key = (value: unknown): string => {
        if (typeof value !== "string" || value.length === 0 || value.length > 512
          || value.startsWith("/") || value.split("/").includes(".."))
          throw new TypeError("cron durable state key must be a bounded relative key");
        return `trigger/${module.instanceId}/${value}`;
      };
      const requestSignal = (value: unknown): AbortSignal => {
        if (!(value instanceof AbortSignal)) throw new TypeError("cron durable state signal must be an AbortSignal");
        return AbortSignal.any([this.#hostAbort.signal, value]);
      };
      capabilityValues.set("cron.durable-state.v1", Object.freeze({
        read: async (request: unknown) => {
          const input = boundedOwnDataRecord(request, "cron durable state read", true);
          assertOwnKeys(input, ["key", "signal"], "cron durable state read");
          const record = await this.#stateStore!.read({ key: key(input.key), signal: requestSignal(input.signal) });
          return record === undefined ? undefined : Object.freeze({ version: record.version,
            value: cloneIntrinsicUint8Array(record.value, "cron durable state value", 64 * 1024) });
        },
        compareAndSwap: async (request: unknown) => {
          const input = boundedOwnDataRecord(request, "cron durable state compareAndSwap", true);
          assertOwnKeys(input, ["key", "expectedVersion", "value", "signal"], "cron durable state compareAndSwap");
          const expectedVersion = input.expectedVersion;
          if (expectedVersion !== null && (typeof expectedVersion !== "string"
            || expectedVersion.length === 0 || expectedVersion.length > 512))
            throw new TypeError("cron durable state expectedVersion is invalid");
          const result = await this.#stateStore!.compareAndSwap({ key: key(input.key), expectedVersion,
            value: cloneIntrinsicUint8Array(input.value, "cron durable state value", 64 * 1024),
            signal: requestSignal(input.signal) });
          return result.status === "applied"
            ? Object.freeze({ status: "applied", version: result.record.version })
            : Object.freeze({ status: "conflict", ...(result.currentVersion === undefined ? {} : { currentVersion: result.currentVersion }) });
        },
      }));
    }
    if (module.slot === "channel" && declaresHostCapability(module, "operator.identity.v1")) {
      capabilityValues.set("operator.identity.v1", Object.freeze({
        agent: Object.freeze({ id: this.config.raw.agent.id, label: this.config.raw.agent.name }),
        process: Object.freeze({ pid: process.pid }),
        defaults: Object.freeze({
          runtime: this.config.raw.routing.primary.runtime,
          model: this.config.raw.routing.primary.model,
          ...(this.config.raw.routing.effort === undefined ? {} : { effort: this.config.raw.routing.effort }),
        }),
        models: this.config.modelCatalog,
        configPath: this.config.configPath,
        projectRoot: this.config.projectRoot,
      }));
    }
    const grantedCapabilities = new Set(capabilityValues.keys());
    const base: ModuleHost = {
      grantedCapabilities,
      getCapability<T = unknown>(name: string): T | undefined {
        return capabilityValues.get(name) as T | undefined;
      },
    };
    if (module.slot === "trigger") {
      return { ...base, emit: (event: TriggerEvent, signal: AbortSignal) => this.#emitTrigger(event, signal) };
    }
    if (module.slot === "memory") {
      const grant = capabilityValues.get(HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE);
      return {
        ...base,
        ...(grant === undefined ? {} : { runtimeCapture: grant }),
      } as MemoryHost;
    }
    if (module.slot !== "channel") return base;
    return {
      ...base,
      dispatch: async (request, reply) => this.#dispatchChannel(module.instanceId, request, reply),
      cancel: async (request) => {
        throwIfAborted(request.signal);
        return { status: await this.cancel(request.conversationId, request.reason) ? "accepted" : "idle" };
      },
      offerLiveInput: async (input) => {
        throwIfAborted(input.signal);
        return {
          status: await this.offerLiveInput(input.conversationId, {
            id: input.id, text: input.text, receivedAt: input.receivedAt,
          }, input.signal),
        };
      },
      answerAsk: async (conversationId, answer, signal) => {
        throwIfAborted(signal);
        return { status: await this.answerAsk(conversationId, answer) };
      },
      answerApproval: async (conversationId, decision, signal) => {
        throwIfAborted(signal);
        return { status: await this.answerApproval(conversationId, decision) };
      },
      listConversations: (request) => this.#listChannelConversations(request),
      readReplay: (request) => this.#readChannelReplay(request),
      readConfig: async (signal) => { throwIfAborted(signal); return toJsonValue(this.config.raw); },
      readHealth: (signal) => this.#readChannelHealth(signal),
      openConversation: (request) => this.#openConversation(request),
    };
  }
  async #listChannelConversations(request: ChannelConversationListRequest): Promise<ChannelConversationListResult> {
    throwIfAborted(request.signal);
    const limit = boundedPageLimit(request.limit);
    const offset = decodePageCursor(request.cursor);
    const conversations = await this.conversations();
    const page = conversations.slice(offset, offset + limit).map((conversation) => ({
      conversationId: conversation.id,
      updatedAt: conversation.updatedAt,
      ...(conversation.title === undefined ? {} : { title: conversation.title }),
      ...(conversation.metadata === undefined ? {} : { metadata: conversation.metadata }),
    }));
    const next = offset + page.length;
    return {
      conversations: page,
      ...(next < conversations.length ? { cursor: encodePageCursor(next) } : {}),
    };
  }
  async #readChannelReplay(request: ChannelReplayRequest): Promise<ChannelReplayResult> {
    throwIfAborted(request.signal);
    const limit = boundedPageLimit(request.limit);
    const offset = decodePageCursor(request.cursor);
    const replay = await this.replay(request.conversationId);
    const fallbackCreatedAt = this.#conversationUpdatedAt.get(request.conversationId) ?? new Date(0).toISOString();
    const entries = replay.messages.slice(offset, offset + limit).map((message, index) => ({
      turnId: message.id ?? stableReplayId(request.conversationId, offset + index, message),
      message,
      createdAt: message.createdAt ?? fallbackCreatedAt,
    }));
    const next = offset + entries.length;
    return immutableClone({
      entries,
      ...(next < replay.messages.length ? { cursor: encodePageCursor(next) } : {}),
    });
  }
  async #readChannelHealth(signal: AbortSignal): Promise<ModuleHealth> {
    throwIfAborted(signal);
    const health = await this.health();
    return {
      status: health.status === "healthy"
        ? "healthy"
        : health.status === "degraded" || health.status === "stopping"
          ? "degraded"
          : "unhealthy",
      checkedAt: new Date().toISOString(),
      summary: `${health.active} active, ${health.pending} pending`,
      details: { accepting: health.accepting, active: health.active, pending: health.pending },
    };
  }
  async #openConversation(request: ChannelOpenConversationRequest): Promise<ChannelOpenConversationResult> {
    throwIfAborted(request.signal);
    const signal = AbortSignal.any([this.#hostAbort.signal, request.signal]);
    if (request.title !== undefined) assertBoundedText(request.title, "title", DEFAULT_MESSAGE_BYTES);
    if (request.initialText !== undefined) assertBoundedText(request.initialText, "initialText", DEFAULT_MESSAGE_BYTES);
    if (this.#execution !== undefined) {
      const conversation = await this.#execution.openConversation({
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.initialText === undefined ? {} : { initialText: request.initialText }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      }, signal);
      await this.#commitConversationView(conversation, signal);
      return { conversationId: conversation.conversationId, createdAt: conversation.createdAt };
    }
    const conversationId = `proactive:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const initialEntries: readonly VerbatimEntry[] =
      request.initialText === undefined || request.initialText.length === 0
        ? []
        : [Object.freeze({
            kind: "verbatim", entryId: `${conversationId}:initial`,
            runId: `${conversationId}:open`, requestId: `${conversationId}:open`,
            conversationId, recordedAt: createdAt, role: "assistant", text: request.initialText,
          })];
    this.#appendLocalVerbatim(conversationId, initialEntries, createdAt);
    this.#commitConversationMetadata({
      conversationId,
      createdAt,
      updatedAt: createdAt,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    });
    return { conversationId, createdAt };
  }
  async #dispatchChannel(
    channelInstanceId: string,
    request: ChannelInboundRequest,
    reply: ChannelReplySink,
  ): Promise<ChannelTurnResult> {
    let emittedText = false;
    let emittedCompaction = false;
    let emittedSessionEviction = false;
    try {
      const channel = this.#channelInstances.get(channelInstanceId);
      const capabilities = this.#channelCapabilities.get(channelInstanceId);
      if (channel === undefined || capabilities === undefined) {
        throw new Error(`Channel ${channelInstanceId} is not started`);
      }
      const completionDelivery = normalizeCompletionDelivery(request.completionDelivery);
      const input = normalizeSubmitInput({
        requestId: request.requestId,
        conversationId: request.conversationId,
        text: request.text,
        ...(request.attachments.length === 0 ? {} : { attachments: request.attachments }),
        ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        signal: request.signal,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      });
      const response = await this.#submitRequest(
        input,
        async (event) => {
          if (event.type === "text-delta") {
            emittedText = true;
            await reply.emit({ type: "text-delta", delta: event.delta });
          } else if (event.type === "thinking-delta") await reply.emit({ type: "thinking-delta", delta: event.delta });
          else if (event.type === "activity") await reply.emit({ type: "activity", text: event.text });
          else if (event.type === "usage") {
            await reply.emit({ type: "usage", usage: event.usage });
            if (!emittedCompaction && event.usage.compaction !== undefined) {
              emittedCompaction = true;
              await reply.emit({ type: "compaction", compaction: event.usage.compaction });
            }
            if (!emittedSessionEviction && event.usage.sessionEvicted === true) {
              emittedSessionEviction = true;
              await reply.emit({ type: "session-evicted" });
            }
          } else if (event.type === "tool-call") {
            await reply.emit(redactChannelToolEvent(event, (value) => this.#redact(value)));
          } else if (event.type === "tool-result") {
            await reply.emit(redactChannelToolEvent(event, (value) => this.#redact(value)));
          } else if (event.type === "compaction") {
            if (!emittedCompaction) { emittedCompaction = true;
              await reply.emit({ type: "compaction", compaction: event.compaction }); }
          }
        },
        capabilities.askUser
          ? async (ask: AskUserRequest) => reply.emit({ type: "ask-user", ask })
          : undefined,
        capabilities.approvals
          ? async (approval: ApprovalRequest) =>
              reply.emit({ type: "approval", approval })
          : undefined,
      );
      if (response.status === "completed" && response.text.length > 0
        && completionDelivery !== undefined) {
        const outcome = await this.#delivery.deliver(completionDelivery.channel, {
          conversationId: completionDelivery.destination ?? "",
          text: response.text,
          idempotencyKey: `channel-completion:${createHash("sha256")
            .update(`${channelInstanceId}\0${request.requestId}`).digest("hex")}`,
          metadata: {
            sourceChannel: channelInstanceId,
            sourceConversationId: request.conversationId,
            sourceRequestId: request.requestId,
            ...deliveryTriggerKind(request.metadata),
          },
        }, request.signal);
        if (outcome.result.status !== "delivered" && outcome.result.status !== "duplicate") {
          throw new Error(`Channel completion delivery ended with ${outcome.result.status}`);
        }
      }
      if (!emittedText && response.text.length > 0) await reply.emit({ type: "text-replace", text: response.text });
      return { status: response.status === "completed" ? "completed" : "cancelled", text: response.text,
        ...(response.message === undefined ? {} : { messageId: `${response.runId}:assistant` }) };
    } catch (error) {
      if (isAbort(error)) return { status: "cancelled" };
      const conflict = error instanceof AgentAdmissionError && error.code === "request_conflict";
      // An uncertain run is not a failed run. Collapsing the two told the
      // channel the turn definitively failed while the durable record stayed
      // unproven, which is the one thing the settlement contract forbids.
      const uncertain = error instanceof RunExecutionError && error.status === "uncertain";
      return {
        status: "rejected",
        diagnostics: [{
          code: conflict ? "request_conflict" : uncertain ? "turn_uncertain" : "turn_failed",
          severity: "error",
          message: conflict
            ? "Request identity conflicts with prior input"
            : this.#redact(errorMessage(error)),
        }],
      };
    }
  }
  #channelRuntimeTool(binding: BoundChannelTool, input: AgentSubmitInput, active: ActiveTurn, signal: AbortSignal): CoreRuntimeTool {
    return {
      name: binding.name, description: binding.tool.description, inputSchema: binding.tool.inputSchema,
      source: { kind: "channel", instanceId: binding.instanceId, tool: binding.tool.name },
      execute: async (raw, options) => {
        if (options?.callId === undefined) throw new Error("Channel tool call identity is unavailable");
        const callSignal = options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
        const runFiles = active.currentRunFiles;
        const idempotencyKey = `channel-tool:${createHash("sha256")
          .update(`${binding.instanceId}\0${binding.tool.name}\0${input.requestId!}\0${options.callId}`)
          .digest("hex")}`;
        if (active.pendingChannelHistory.size > 0)
          throw new Error("A prior channel delivery lacks confirmed destination history");
        const prepared = boundedOwnDataRecord(await binding.tool.prepare(raw as JsonValue, {
          requestId: input.requestId!, conversationId: input.conversationId,
          callId: options.callId, signal: callSignal,
          ...(runFiles === undefined ? {} : {
            readCurrentRunOutput: ({ name, maxBytes }) =>
              runFiles.readOutput(name, { maxBytes, signal: callSignal }),
          }),
        }), `${binding.name} prepared delivery`, true);
        assertOwnKeys(prepared, ["conversationId", "text", "attachments", "replyToMessageId", "metadata"],
          `${binding.name} prepared delivery`);
        active.pendingChannelHistory.add(idempotencyKey);
        let outcome;
        try {
          outcome = await this.#delivery.deliver(binding.instanceId,
            { ...prepared, idempotencyKey } as unknown as ChannelOutboundMessage,
            callSignal);
        } catch (error) {
          active.pendingChannelHistory.delete(idempotencyKey);
          throw error;
        }
        if (outcome.result.status !== "unknown") active.pendingChannelHistory.delete(idempotencyKey);
        if (outcome.result.status === "failed") throw new Error("Channel delivery failed");
        if (outcome.result.status === "unknown") throw new Error("Channel delivery outcome is unknown");
        return {
          status: outcome.result.status,
          destinationConversationId: outcome.destinationConversationId!,
          ...(outcome.result.messageId === undefined ? {} : { messageId: outcome.result.messageId }),
        };
      },
    };
  }
  #submitRequest(
    input: AgentSubmitInput,
    emit: (event: RuntimeTurnEvent) => Promise<void>,
    emitAsk?: (request: AskUserRequest) => Promise<void>,
    emitApproval?: (request: ApprovalRequest) => Promise<void>,
    observeAdmission?: (replayed: boolean) => void,
  ): Promise<AgentResponse> {
    const fingerprint = submissionFingerprint(input);
    const existing = this.#inflightRequests.get(input.requestId!);
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return existing.promise;
      return Promise.reject(new AgentAdmissionError(
        "request_conflict",
        `Request ${input.requestId!} is already active with different input`,
        { requestId: input.requestId! },
      ));
    }
    try {
      this.#admit(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const running = (async (): Promise<AgentResponse> => {
      try {
        const admissionSignal = AbortSignal.any([
          this.#hostAbort.signal,
          ...(input.signal === undefined ? [] : [input.signal]),
        ]);
        return await this.#conversationTails.run(
          input.conversationId,
          admissionSignal,
          async () => {
            const releaseSlot = await this.#semaphore.acquire(admissionSignal);
            try {
              const admission = await this.#admitRun(input, fingerprint, admissionSignal);
              observeAdmission?.(admission.replayed);
              if (admission.response !== undefined) return admission.response;
              const controller = new AbortController();
              const active = new ActiveTurn(
                admission.runId, input.requestId!, new Date().toISOString(), controller,
              );
              const signal = AbortSignal.any([admissionSignal, controller.signal]);
              this.#activeTurns.set(input.conversationId, active);
              this.#active += 1;
              try {
                try {
                  if ((this.config.raw.context?.mcp?.requestContextServers?.length ?? 0) > 0) {
                    active.currentRunFiles = await createCurrentRunFiles({
                      projectRoot: this.config.projectRoot, runId: active.id,
                      conversationId: input.conversationId, attachments: input.attachments ?? [], signal,
                    });
                  }
                  return await this.#runTurn(input, active, signal, emit, emitAsk, emitApproval);
                } catch (error) {
                  if (this.#hostAbort.signal.aborted) {
                    throw abortError("Agent host stopped before the run could settle");
                  }
                  const settlement = this.#settlementSignal();
                  const activeAbortReason = active.controller.signal.reason;
                  const classified = activeAbortReason instanceof RunExecutionError
                    ? activeAbortReason
                    : error instanceof RunExecutionError
                      ? error
                      : undefined;
                  if (classified !== undefined) {
                    // The rejection is captured rather than caught so this keeps
                    // the original promise shape: a `try`/`await`/`catch` here
                    // removes the tick `.catch()` adds, and the surrounding turn
                    // loop is microtask-order sensitive.
                    let settlementError: unknown;
                    await this.#persistRunSettlement({
                      input,
                      runId: active.id,
                      status: classified.status,
                      failureCode: classified.failureCode,
                      signal: settlement,
                    }).catch((error: unknown) => { settlementError = error; });
                    // A definitive status asserts that settlement was proved.
                    // Discarding the write reported `failed` while the durable
                    // run stayed `running`, wedging the requestId behind a live
                    // admission lease. An already `uncertain` classification is
                    // already honest and proceeds unchanged.
                    if (settlementError !== undefined && classified.status !== "uncertain") {
                      throw turnExecutionError(
                        "uncertain",
                        "classified-settlement-failed",
                        "The run was classified but durable settlement could not be proven",
                        input, active, this.#safePublicCause(settlementError),
                      );
                    }
                    throw classified;
                  }
                  if (signal.aborted || isAbort(error)) {
                    const route = active.route ?? routeCandidates(this.config, input)[0]!;
                    try {
                      await this.#settle(
                        input, route, { status: "cancelled" },
                        active.sessionsSupported ?? true, active, settlement,
                      );
                    } catch (settlementError) {
                      const uncertain = turnExecutionError(
                        "uncertain",
                        "cancellation-settlement-failed",
                        "Cancellation occurred but durable settlement could not be proven",
                        input, active, this.#safePublicCause(settlementError),
                      );
                      await this.#persistRunSettlement({
                        input,
                        runId: active.id,
                        status: "uncertain",
                        failureCode: uncertain.failureCode,
                        signal: this.#settlementSignal(),
                      }).catch((persistError: unknown) => {
                        this.#health.record(
                          `uncertain settlement after cancellation: ${errorMessage(persistError)}`,
                        );
                      });
                      throw uncertain;
                    }
                    throw abortError();
                  }
                  const safeCause = this.#safePublicCause(error);
                  const failure = turnExecutionError(
                    "failed", "core-execution-failed", safeCause.message, input, active, safeCause,
                  );
                  try {
                    await this.#persistRunSettlement({
                      input,
                      runId: active.id,
                      status: failure.status,
                      failureCode: failure.failureCode,
                      signal: settlement,
                    });
                  } catch (settlementError) {
                    throw turnExecutionError(
                      "uncertain",
                      "failure-settlement-failed",
                      "Run failure occurred but durable classification could not be proven",
                      input, active, this.#safePublicCause(settlementError),
                    );
                  }
                  throw failure;
                }
              } finally {
                try {
                  await active.currentRunFiles?.cleanup();
                } catch (error) {
                  this.#health.record(`current-run cleanup: ${errorMessage(error)}`);
                }
                if (this.#activeTurns.get(input.conversationId) === active) {
                  this.#activeTurns.delete(input.conversationId);
                }
                this.#active -= 1;
              }
            } finally {
              releaseSlot();
            }
          },
        );
      } finally {
        this.#pending -= 1;
        if (this.#pending === 0) {
          for (const resolveIdle of this.#idleWaiters) resolveIdle();
          this.#idleWaiters.clear();
        }
      }
    })();
    const tracked = running.finally(() => {
      const current = this.#inflightRequests.get(input.requestId!);
      if (current?.promise === tracked) this.#inflightRequests.delete(input.requestId!);
    });
    this.#inflightRequests.set(input.requestId!, { fingerprint, promise: tracked });
    return tracked;
  }
  async #persistRunSettlement(options: {
    readonly input: AgentSubmitInput;
    readonly runId: string;
    readonly status: "completed" | "cancelled" | "max-turns" | "failed" | "uncertain";
    readonly response?: AgentResponse;
    readonly transcript?: CanonicalTranscript;
    readonly session?: RuntimeSession;
    readonly sessionUpdatedAt?: string;
    readonly sessionEviction?: RuntimeRoute;
    readonly failureCode?: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (this.#execution !== undefined) {
      await this.#execution.settle({
        runId: options.runId,
        requestId: options.input.requestId!,
        status: options.status,
        ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
        ...(options.response === undefined
          ? {}
          : { responseBytes: encodeCachedAgentResponse(options.response) }),
        ...(options.session === undefined || options.sessionUpdatedAt === undefined
          ? {}
          : {
              session: {
                value: options.session,
                updatedAt: options.sessionUpdatedAt,
              },
            }),
        ...(options.sessionEviction === undefined
          ? {}
          : {
              sessionEviction: {
                runtimeInstanceId: options.sessionEviction.runtime,
                model: options.sessionEviction.model,
              },
            }),
        ...(options.failureCode === undefined ? {} : { failureCode: options.failureCode }),
        signal: options.signal,
      });
    }
    if (options.transcript !== undefined) {
      this.#transcripts.set(options.input.conversationId, options.transcript);
    }
  }
  async #recordRunAttempt(
    runId: string,
    evidence: AgentRunAttemptEvidence,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#execution !== undefined)
      await this.#execution.recordAttempt(runId, evidence, signal);
  }
  async #appendInteractionEvidence(
    input: AgentSubmitInput,
    active: ActiveTurn,
    evidence: AgentInteractionEvidence,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#execution !== undefined)
      await this.#execution.recordInteraction(active.id, evidence, signal);
    const recordedAt = evidence.kind === "live-input"
      ? evidence.settledAt
      : evidence.settledAt ?? evidence.requestedAt;
    active.transcriptEntries.push(Object.freeze({
      kind: "interaction",
      entryId: `${active.id}:interaction:${evidence.interactionId}:${String(active.transcriptEntries.length)}`,
      runId: active.id,
      requestId: input.requestId!,
      conversationId: input.conversationId,
      recordedAt,
      evidence,
      content: Object.freeze([{ type: "text" as const, text }]),
    }));
  }
  async #admitRun(
    input: AgentSubmitInput,
    fingerprint: DurableFingerprint,
    signal: AbortSignal,
  ): Promise<{ readonly runId: string; readonly replayed: boolean; readonly response?: AgentResponse }> {
    if (this.#execution === undefined) {
      return { runId: randomUUID(), replayed: false };
    }
    const admission = await this.#execution.admit({
      requestId: input.requestId!,
      conversationId: input.conversationId,
      fingerprint,
      signal,
    });
    if (admission.status === "accepted") return { runId: admission.summary.runId, replayed: false };
    if (admission.status === "cached") {
      if (admission.responseRef === undefined) {
        if (
          admission.summary.status === "failed"
          || admission.summary.status === "uncertain"
        ) {
          throw new RunExecutionError(
            admission.summary.status,
            admission.summary.failureCode ?? "durable-run-terminal",
            admission.summary.status === "failed"
              ? `Request ${input.requestId!} previously failed`
              : `Request ${input.requestId!} has uncertain prior effects`,
            {
              requestId: input.requestId!,
              runId: admission.summary.runId,
            },
          );
        }
        throw new AgentAdmissionError(
          "uncertain_admission",
          `Request ${input.requestId!} settled without a replayable response`,
          { requestId: input.requestId!, runId: admission.summary.runId },
        );
      }
      const bytes = await this.#execution.readCachedResponse(admission.responseRef, signal);
      return {
        runId: admission.summary.runId,
        replayed: true,
        response: decodeCachedAgentResponse(
          bytes,
          input.requestId!,
          admission.summary.runId,
          input.conversationId,
        ),
      };
    }
    const code = admission.status === "conflict"
      ? "request_conflict"
      : admission.status === "join"
        ? "request_in_progress"
        : "uncertain_admission";
    throw new AgentAdmissionError(
      code,
      admission.status === "conflict"
        ? `Request ${input.requestId!} was already used with different input`
        : admission.status === "join"
          ? `Request ${input.requestId!} is already in progress`
          : `Request ${input.requestId!} has uncertain prior effects`,
      { requestId: input.requestId!, runId: admission.runId },
    );
  }
  async #runTurn(
    input: AgentSubmitInput,
    active: ActiveTurn,
    signal: AbortSignal,
    emit: (event: RuntimeTurnEvent) => Promise<void>,
    emitAsk?: (request: AskUserRequest) => Promise<void>,
    emitApproval?: (request: ApprovalRequest) => Promise<void>,
  ): Promise<AgentResponse> {
    await this.#loadConversation(input.conversationId, signal);
    const recalled = await this.#recallMemory(input, signal);
    const routes = routeCandidates(this.config, input);
    const memoryRecallTool = this.#memoryRecallEnabled && this.#memory !== undefined
      ? [createMemoryRecallTool(this.#memory, input.conversationId, signal)] : [];
    const askUserTool = input.interactionHandler === undefined && emitAsk === undefined ? [] : [createAskUserTool(
      (request, askSignal) => {
        if (active.route === undefined) throw new Error("AskUser route is unavailable");
        return this.#interactions.askUser(input, active, active.route, request, askSignal, emitAsk);
      }, signal)];
    const selectedTools = filterTools(
      [
        ...this.#instructionTools, ...memoryRecallTool, ...askUserTool,
        ...this.#moduleTools.map(moduleRuntimeTool), ...this.#mcp.tools,
        ...this.#channelTools.map((tool) => this.#channelRuntimeTool(tool, input, active, signal)),
      ],
      this.config,
      input,
      this.#ambiguousToolAliases,
    );
    const moduleBindings = bindModuleTools(selectedTools, this.#moduleTools, {
      conversationId: input.conversationId,
      runId: active.id,
      requestId: input.requestId!,
      signal,
    });
    const tools = moduleBindings.tools;
    try {
    const requiredCapabilities = new Set(input.requiredCapabilities ?? []);
    if ((input.attachments?.length ?? 0) > 0) requiredCapabilities.add("attachments");
    if (input.responseSchema !== undefined) requiredCapabilities.add("structuredOutput");
    if (input.maxTurns !== undefined) requiredCapabilities.add("maxTurns");
    if (input.maxOutputTokens !== undefined) requiredCapabilities.add("maxOutputTokens");
    const hasInteractionHandler =
      input.interactionHandler !== undefined || emitApproval !== undefined;
    const errors: Error[] = [];
    let attemptNumber = 0;
    let hasUncertainEffects = false;
    const sessionRecoveryRoutes = new Set<string>();
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      const route = routes[routeIndex]!;
      attemptNumber += 1;
      const attemptStartedAt = new Date().toISOString();
      const attemptRoute = {
        runtimeInstanceId: route.runtime,
        model: route.model,
      } as const;
      const rejectRoute = async (code: string, message: string): Promise<void> => {
        errors.push(new Error(message));
        await this.#recordRunAttempt(active.id, {
          attempt: attemptNumber, route: attemptRoute, status: "ineligible",
          startedAt: attemptStartedAt, endedAt: new Date().toISOString(), code,
        }, signal);
      };
      if (signal.aborted) throw abortError();
      const runtime = this.#runtimeInstances.get(route.runtime);
      const runtimeCapabilities = this.#runtimeCapabilities.get(route.runtime);
      if (runtime === undefined || runtimeCapabilities === undefined) {
        await rejectRoute("runtime-not-started", `Runtime ${route.runtime} is not started`);
        continue;
      }
      active.route = route;
      let routeCapabilities = runtimeCapabilities;
      let routeNativeTools: readonly RuntimeNativeToolDescriptor[] = [];
      if (runtime.preflightModel !== undefined || runtime.validateModel !== undefined) {
        const rawValidation = runtime.preflightModel !== undefined
          ? await runtime.preflightModel({ model: route.model, signal })
          : await runtime.validateModel!(route.model, signal);
        const validation = normalizeRuntimeModelValidation(
          rawValidation,
          `${route.runtime}:${route.model} model validation result`,
        );
        if (!validation.supported) {
          await rejectRoute("unsupported-model", `${route.runtime} does not support model ${route.model}`);
          continue;
        }
        routeCapabilities = validation.capabilities ?? routeCapabilities;
        routeNativeTools = validation.nativeTools ?? [];
      }
      const nativeToolIssue = runtimeNativeToolPolicyIssue({
        nativeTools: routeNativeTools,
        capabilities: routeCapabilities,
        config: this.config.raw,
        requestToolPolicy: input.toolPolicy,
        routedToolIds: tools.map((tool) => tool.name),
        hasInteractionHandler,
      });
      if (nativeToolIssue !== undefined) {
        await rejectRoute("native-tool-policy-ineligible",
          `${route.runtime}:${route.model} is ineligible: ${nativeToolIssue}`);
        continue;
      }
      const eligibility = runtimeEligibility(
        routeCapabilities,
        tools,
        [...requiredCapabilities],
        this.config,
        hasInteractionHandler,
      );
      if (eligibility !== undefined) {
        await rejectRoute("capability-ineligible",
          `${route.runtime}:${route.model} is ineligible: ${eligibility}`);
        continue;
      }
      active.sessionsSupported = routeCapabilities.sessions;
      let observedEffect = false;
      let runtimeDispatched = false;
      let runtimeReturned = false;
      let runtimeSessionUsed = false;
      let attemptOpen = true;
      const eventBoundary = createRuntimeTurnEventBoundary();
      const observeEffect = (): void => {
        if (!attemptOpen) throw new Error("Runtime attempt context is closed");
        observedEffect = true;
      };
      const closeAttempt = (): void => {
        attemptOpen = false;
        active.liveInput = undefined;
        active.rejectPendingInteractions();
      };
      try {
        await this.#recordRunAttempt(active.id, {
          attempt: attemptNumber,
          route: attemptRoute,
          status: "started",
          startedAt: attemptStartedAt,
        }, signal);
        const emitRuntimeEvent = async (event: RuntimeTurnEvent): Promise<void> => {
          const normalizedEvent = normalizeRuntimeTurnEvent(event, eventBoundary, {
            conversationId: input.conversationId, route: attemptRoute,
          });
          if (routeCapabilities.sessions === false && normalizedEvent.type === "session") {
            const violation = new Error(
              `${route.runtime}:${route.model} emitted a session while advertising sessions: false`,
            );
            eventBoundary.violation = violation;
            throw violation;
          }
          if (normalizedEvent.type === "text-delta" || normalizedEvent.type === "thinking-delta"
            || normalizedEvent.type === "tool-call" || normalizedEvent.type === "tool-result") observeEffect();
          await emit(normalizedEvent);
        };
        const runtimeContext = {
          emit: emitRuntimeEvent,
          executeTool: async (call: RuntimeToolCall, toolSignal: AbortSignal) => {
            observeEffect();
            const normalizedCall = normalizeRuntimeToolCall(call);
            const tool = tools.find((candidate) => candidate.name === normalizedCall.name);
            const effects = tool === undefined ? [] : toolEffects(tool);
            if (tool !== undefined
              && effects.length > 0
              && this.config.raw.policy.approvals.default === "ask") {
              const decision = await this.#interactions.approval(
                input,
                active,
                route,
                {
                  interactionId: randomUUID(),
                  callId: normalizedCall.id,
                  toolId: tool.name,
                  displayName: tool.name,
                  effects,
                  summary: `Allow ${tool.name} to execute for this turn?`,
                  requestedAt: new Date().toISOString(),
                },
                AbortSignal.any([signal, toolSignal]),
                emitApproval,
              );
              if (decision.decision !== "allow_once") {
                return {
                  callId: normalizedCall.id,
                  isError: true,
                  content: [{
                    type: "text" as const,
                    text: `Tool ${normalizedCall.name} was denied`,
                  }],
                } satisfies RuntimeToolResult;
              }
            }
            return executeTool(
              normalizedCall,
              tools,
              AbortSignal.any([signal, toolSignal]),
              (message) => this.#redact(message),
              routeCapabilities.artifactResults === true
                ? stateArtifactSink(this.#stateStore)
                : undefined,
              active.currentRunFiles?.requestContext,
              (text) => emitRuntimeEvent({
                type: "activity", text: boundedUtf8(this.#redact(text), 16_384),
              }),
            );
          },
          registerLiveInput: (handler: RuntimeLiveInputHandler) => {
            if (!attemptOpen) throw new Error("Runtime attempt context is closed");
            throwIfAborted(signal);
            const observedHandler: RuntimeLiveInputHandler = async (liveInput, liveSignal) => {
              throwIfAborted(liveSignal);
              observeEffect();
              return handler(liveInput, AbortSignal.any([signal, liveSignal]));
            };
            active.liveInput = observedHandler;
            return () => {
              if (active.liveInput === observedHandler) active.liveInput = undefined;
            };
          },
          ...(input.interactionHandler === undefined && emitAsk === undefined ? {} : {
            askUser: (request: AskUserRequest, askSignal: AbortSignal) => {
              observeEffect();
              return this.#interactions.askUser(
                input,
                active,
                route,
                request,
                AbortSignal.any([signal, askSignal]),
                emitAsk,
              );
            },
          }),
          ...(routeNativeTools.some((tool) => tool.approval === "core-callback") ? {
            requestApproval: (request: ApprovalRequest, approvalSignal: AbortSignal) => {
              observeEffect();
              return this.#interactions.runtimeApproval(
                input,
                active,
                route,
                routeNativeTools,
                request,
                AbortSignal.any([signal, approvalSignal]),
                emitApproval,
              );
            },
          } : {}),
        };
        const runtimeRequest = await this.#runtimeRequest(
          input,
          route,
          routeCapabilities.sessions,
          sessionRecoveryRoutes.has(runtimeSessionRouteKey(route)),
          tools,
          active.id,
          recalled,
          signal,
        );
        runtimeSessionUsed = runtimeRequest.session !== undefined;
        throwIfAborted(signal);
        runtimeDispatched = true;
        const result = await runtime.runTurn(runtimeRequest, runtimeContext);
        runtimeReturned = true;
        if (this.#hostAbort.signal.aborted) {
          throw abortError("Agent host stopped before the runtime result could settle");
        }
        if (active.pendingChannelHistory.size > 0) {
          throw turnExecutionError(
            "uncertain", "channel-history-unconfirmed",
            "A channel tool may have delivered without confirmed destination history",
            input, active,
          );
        }
        const settlement = this.#settlementSignal();
        assertRuntimeTurnEventBoundaryHealthy(eventBoundary);
        closeAttempt();
        const normalizedResult = normalizeRuntimeTurnResult(result, {
          conversationId: input.conversationId,
          route: attemptRoute,
        });
        if (!routeCapabilities.sessions
          && (normalizedResult.session !== undefined
            || normalizedResult.usage?.sessionEvicted === true)) {
          throw new Error(
            `${route.runtime}:${route.model} returned session state while advertising sessions: false`,
          );
        }
        await this.#recordRunAttempt(active.id, {
          attempt: attemptNumber,
          route: attemptRoute,
          status: "completed",
          startedAt: attemptStartedAt,
          endedAt: new Date().toISOString(),
        }, settlement);
        const response = await this.#settle(
          input,
          route,
          normalizedResult,
          routeCapabilities.sessions,
          active,
          settlement,
        );
        await this.#exportTurn("mono_agent.turn.settled", input, route, response);
        return response;
      } catch (error) {
        if (this.#hostAbort.signal.aborted) {
          throw abortError("Agent host stopped before the runtime attempt could settle");
        }
        if (error instanceof RunExecutionError) throw error;
        const typed = snapshotRuntimeTurnError(error);
        const safeRuntimeCause = this.#safePublicCause(error, typed);
        if (runtimeReturned) {
          throw turnExecutionError(
            "uncertain",
            "runtime-result-unsettled",
            "The runtime returned but its result could not be durably settled",
            input, active, safeRuntimeCause,
          );
        }
        if (signal.aborted || isAbort(error)) {
          if (!runtimeDispatched || typed?.sideEffects === "none") throw abortError();
          throw turnExecutionError(
            "uncertain",
            "runtime-cancellation-outcome-unknown",
            "Cancellation raced a dispatched runtime whose outcome could not be proven",
            input, active, safeRuntimeCause,
          );
        }
        errors.push(safeRuntimeCause);
        const retryability = typed?.retryability ?? "unknown";
        const sideEffects = typed?.sideEffects ?? "unknown";
        hasUncertainEffects ||= runtimeReturned || observedEffect || sideEffects !== "none";
        try {
          await this.#recordRunAttempt(active.id, {
            attempt: attemptNumber,
            route: attemptRoute,
            status: "failed",
            startedAt: attemptStartedAt,
            endedAt: new Date().toISOString(),
            code: typed?.code ?? "runtime-attempt-failed",
            retryability,
            sideEffects,
          }, signal);
        } catch (evidenceError) {
          if (hasUncertainEffects) {
            throw turnExecutionError(
              "uncertain",
              "attempt-evidence-unsettled",
              "The runtime attempt may have effects but its terminal evidence could not be persisted",
              input, active, evidenceError,
            );
          }
          throw evidenceError;
        }
        if (
          runtimeSessionUsed
          && !observedEffect
          && typed?.code === RUNTIME_SESSION_UNAVAILABLE_CODE
          && typed.sideEffects === "none"
          && !sessionRecoveryRoutes.has(runtimeSessionRouteKey(route))
        ) {
          await this.#sessionStore.evict(
            input,
            route,
            runtimeSessionMapKey(route, input.conversationId),
            signal,
          );
          sessionRecoveryRoutes.add(runtimeSessionRouteKey(route));
          routeIndex -= 1;
          continue;
        }
        if (runtimeReturned || observedEffect || !isSafeRuntimeFallback(typed)) break;
      } finally {
        closeAttempt();
      }
    }
    const aggregate = new AggregateError(
      errors,
      `Every eligible runtime route failed for conversation ${input.conversationId}`,
    );
    throw turnExecutionError(
      hasUncertainEffects ? "uncertain" : "failed",
      hasUncertainEffects ? "runtime-effects-uncertain" : "runtime-routes-failed",
      aggregate.message,
      input, active, aggregate,
    );
    } finally {
      moduleBindings.revoke();
    }
  }
  async #runtimeRequest(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    sessionsSupported: boolean,
    forceSessionless: boolean,
    tools: readonly CoreRuntimeTool[],
    turnId: string,
    recalled: readonly MemoryRecord[],
    signal: AbortSignal,
  ) {
    const history = (this.#history.get(input.conversationId) ?? []).map((message) => immutableClone(message));
    const sessionKey = runtimeSessionMapKey(route, input.conversationId);
    const session = forceSessionless
      ? undefined
      : await this.#sessionStore.forRequest(
        input,
        route,
        sessionKey,
        sessionsSupported,
        signal,
      );
    const metadata = toJsonObject(input.metadata);
    const effort = escalateMessageEffort(
      input.text,
      input.effort ?? this.config.raw.routing.effort,
    );
    return {
      turnId,
      conversationId: input.conversationId,
      model: route.model,
      messages: immutableClone([
        { role: "system" as const, content: [{ type: "text" as const, text: this.#instructions }] },
        ...(recalled.length === 0
          ? []
          : [{
              role: "system" as const,
              name: "memory",
              content: [{ type: "text" as const, text: renderRecalledMemory(recalled) }],
            }]),
        ...history,
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: input.text },
            ...(input.attachments ?? []).map((attachment) => ({
              type: "attachment" as const,
              attachment,
            })),
          ],
        },
      ]),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      signal,
      ...(session === undefined ? {} : { session: immutableClone(session) }),
      options: {
        ...(effort === undefined ? {} : { effort }),
        ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
        ...(input.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.responseSchema === undefined
          ? {}
          : { responseSchema: immutableClone(input.responseSchema) }),
      },
      ...(metadata === undefined ? {} : { metadata }),
    };
  }
  async #settle(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    result: RuntimeTurnResult,
    sessionsSupported: boolean,
    active: ActiveTurn,
    signal: AbortSignal,
  ): Promise<AgentResponse> {
    const settledResult = result;
    const sessionDisposition = this.#sessionStore.disposition(input, sessionsSupported);
    if (settledResult.message !== undefined && settledResult.message.role !== "assistant") {
      throw new Error(`${route.runtime} returned a non-assistant turn message`);
    }
    const text = settledResult.message === undefined ? "" : textFromMessage(settledResult.message);
    const updatedAt = new Date().toISOString();
    const entries = await this.#canonicalTurnEntries(
      input,
      route,
      settledResult.message,
      active,
      updatedAt,
      signal,
    );
    const message = settledResult.message === undefined
      ? undefined
      : cacheableAssistantMessage(settledResult.message);
    const output = immutableClone({
      status: settledResult.status,
      ...(message === undefined ? {} : { message }),
      ...(settledResult.status !== "completed" || settledResult.structuredOutput === undefined
        ? {}
        : { structuredOutput: settledResult.structuredOutput }),
      ...(settledResult.usage === undefined ? {} : { usage: settledResult.usage }),
      ...(settledResult.metadata === undefined ? {} : { metadata: settledResult.metadata }),
    });
    const response = immutableClone({
      requestId: input.requestId!,
      runId: active.id,
      conversationId: input.conversationId,
      runtime: route.runtime,
      model: route.model,
      status: settledResult.status,
      text,
      ...(message === undefined ? {} : { message }),
      output,
      ...(settledResult.metadata === undefined ? {} : { metadata: settledResult.metadata }),
    } satisfies AgentResponse);
    const execution = this.#execution;
    const commit = async (): Promise<void> => {
      const current = this.#transcripts.get(input.conversationId);
      const transcript = execution === undefined
        ? Object.freeze({
            schemaVersion: 1 as const,
            kind: "mono-agent.canonical-transcript" as const,
            conversationId: input.conversationId,
            revision: (current?.revision ?? 0) + 1,
            entries: Object.freeze([...(current?.entries ?? []), ...entries]),
          })
        : await execution.appendTranscript(current, input.conversationId, entries, signal);
      try {
        await this.#persistRunSettlement({
          input, runId: active.id, status: settledResult.status, response, transcript,
          ...(settledResult.session === undefined || sessionDisposition !== "retain"
            ? {} : { session: settledResult.session, sessionUpdatedAt: updatedAt }),
          ...(settledResult.usage?.sessionEvicted !== true || sessionDisposition !== "retain"
            ? {} : { sessionEviction: route }),
          signal,
        });
      } catch (error) {
        throw turnExecutionError(
          "uncertain",
          "settlement-failed",
          "The runtime completed but durable settlement could not be proven",
          input, active, error,
        );
      }
      await this.#commitSettledTurnInMemory(
        input, settledResult, transcript, entries, route,
        sessionDisposition, updatedAt, signal,
      );
    };
    if (execution === undefined)
      await this.#localHistoryTails.run(input.conversationId, signal, commit);
    else await commit();
    if (settledResult.status === "completed") {
      await this.#captureMemory({
        id: active.id,
        text: `User: ${input.text}\nAssistant: ${text}`,
        createdAt: updatedAt,
        metadata: {
          conversationId: input.conversationId,
          runtime: route.runtime,
          model: route.model,
        },
      }, this.#hostAbort.signal);
    }
    return response;
  }
  async #canonicalTurnEntries(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    message: TurnMessage | undefined,
    active: ActiveTurn,
    settledAt: string,
    signal: AbortSignal,
  ): Promise<readonly AgentTranscriptEntry[]> {
    const artifacts: {
      readonly slot: string;
      readonly data: Uint8Array;
      readonly mediaType: string;
      readonly fileName?: string;
    }[] = [];
    const userContent: TranscriptContentDraft[] = [{
      type: "text",
      text: input.text,
    }];
    for (const [index, attachment] of (input.attachments ?? []).entries()) {
      const slot = `transcript/user/${String(index).padStart(3, "0")}`;
      artifacts.push({
        slot,
        data: new Uint8Array(attachment.data),
        mediaType: attachment.mediaType,
        fileName: attachment.name,
      });
      userContent.push({ kind: "pending-artifact", slot, name: attachment.name });
    }
    const assistantContent: TranscriptContentDraft[] = [];
    for (const [index, part] of (message?.content ?? []).entries()) {
      if (part.type === "text") {
        assistantContent.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "image" || part.type === "file" || part.type === "attachment") {
        const slot = `transcript/assistant/${String(index).padStart(3, "0")}`;
        const source = part.type === "attachment" ? part.attachment : part;
        const name = source.name;
        artifacts.push({
          slot,
          data: part.type === "attachment"
            ? new Uint8Array(part.attachment.data)
            : turnBinaryData(part.data, `${part.type} response part`),
          mediaType: source.mediaType,
          ...(name === undefined ? {} : { fileName: name }),
        });
        assistantContent.push({
          kind: "pending-artifact",
          slot,
          ...(name === undefined ? {} : { name }),
        });
      }
    }
    const references = new Map<string, ArtifactRef>();
    if (artifacts.length > 0 && this.#execution !== undefined) {
      const staged = await this.#execution.stageRunArtifacts({
        runId: active.id,
        requestId: input.requestId!,
        artifacts,
        signal,
      });
      for (const artifact of staged) references.set(artifact.slot, artifact.ref);
    }
    const materialize = (
      drafts: readonly TranscriptContentDraft[],
    ): readonly AgentTranscriptContentPart[] => Object.freeze(
      drafts.flatMap((part): readonly AgentTranscriptContentPart[] => {
        if ("type" in part) return [part];
        const ref = references.get(part.slot);
        if (ref === undefined) return [];
        return [{
          type: "artifact",
          ref,
          ...(part.name === undefined ? {} : { name: part.name }),
        }];
      }),
    );
    const entries: AgentTranscriptEntry[] = [{
      kind: "message",
      entryId: `${active.id}:user`,
      runId: active.id,
      requestId: input.requestId!,
      conversationId: input.conversationId,
      recordedAt: active.startedAt,
      role: "user",
      content: materialize(userContent),
    }];
    entries.push(...active.transcriptEntries);
    if (message !== undefined) {
      entries.push({
        kind: "message",
        entryId: `${active.id}:assistant`,
        runId: active.id,
        requestId: input.requestId!,
        conversationId: input.conversationId,
        recordedAt: settledAt,
        role: "assistant",
        content: materialize(assistantContent),
        route: {
          runtimeInstanceId: route.runtime,
          model: route.model,
        },
      });
    }
    return Object.freeze(entries);
  }
  async #commitSettledTurnInMemory(
    input: AgentSubmitInput,
    result: RuntimeTurnResult,
    transcript: CanonicalTranscript,
    entries: readonly AgentTranscriptEntry[],
    route: RuntimeRoute,
    sessionDisposition: SessionDisposition,
    updatedAt: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#execution !== undefined) {
      const appended = await turnMessagesFromTranscript({
        schemaVersion: 1,
        kind: "mono-agent.canonical-transcript",
        conversationId: input.conversationId,
        revision: transcript.revision,
        entries,
      }, this.#stateStore, signal);
      const history = this.#history.get(input.conversationId) ?? [];
      this.#history.set(input.conversationId, immutableClone([...history, ...appended]));
      this.#loadedConversations.add(input.conversationId);
    } else {
      const history = this.#history.get(input.conversationId) ?? [];
      const assistantEntryId = entries.find((entry) => entry.kind === "message" && entry.role === "assistant")?.entryId;
      if (result.message !== undefined && assistantEntryId === undefined)
        throw new Error("completed assistant message lacks a canonical transcript identity");
      const user: TurnMessage = {
        role: "user",
        content: [
          { type: "text", text: input.text },
          ...(input.attachments ?? []).map((attachment) => ({
            type: "attachment" as const,
            attachment,
          })),
        ],
        createdAt: updatedAt,
      };
      this.#history.set(input.conversationId, immutableClone([
        ...history,
        user,
        ...(result.message === undefined
          ? []
          : [{ ...result.message, id: assistantEntryId! }]),
      ]));
      this.#loadedConversations.add(input.conversationId);
    }
    this.#conversationUpdatedAt.set(input.conversationId, updatedAt);
    this.#sessionStore.commit(
      runtimeSessionMapKey(route, input.conversationId),
      sessionDisposition,
      result.session,
      result.usage?.sessionEvicted === true,
      updatedAt,
    );
  }
  async #loadConversation(conversationId: string, signal: AbortSignal): Promise<CanonicalTranscript | undefined> {
    if (this.#loadedConversations.has(conversationId)) return this.#transcripts.get(conversationId);
    if (this.#execution === undefined) {
      this.#loadedConversations.add(conversationId);
      return this.#transcripts.get(conversationId);
    }
    const conversation = await this.#execution.loadConversation(conversationId, signal);
    if (conversation === undefined) {
      this.#loadedConversations.add(conversationId);
      return undefined;
    }
    await this.#commitConversationView(conversation, signal);
    return conversation.transcript;
  }
  #appendLocalVerbatim(
    conversationId: string, entries: readonly VerbatimEntry[], updatedAt: string,
  ): void {
    const current = this.#transcripts.get(conversationId);
    this.#transcripts.set(conversationId, Object.freeze({
      schemaVersion: 1, kind: "mono-agent.canonical-transcript", conversationId,
      revision: (current?.revision ?? 0) + 1,
      entries: Object.freeze([...(current?.entries ?? []), ...entries]),
    }));
    this.#history.set(conversationId, immutableClone([
      ...(this.#history.get(conversationId) ?? []),
      ...entries.map((entry) => ({
        id: entry.entryId, role: entry.role,
        content: [{ type: "text" as const, text: entry.text }], createdAt: entry.recordedAt,
      })),
    ]));
    this.#loadedConversations.add(conversationId);
    this.#conversationUpdatedAt.set(conversationId, updatedAt);
  }
  async #commitConversationView(
    conversation: {
      readonly conversationId: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly transcript: CanonicalTranscript;
      readonly title?: string;
      readonly metadata?: JsonObject;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const history = await turnMessagesFromTranscript(conversation.transcript, this.#stateStore, signal);
    const current = this.#transcripts.get(conversation.conversationId);
    if (current !== undefined && current.revision > conversation.transcript.revision) return;
    if (current !== undefined && current.revision === conversation.transcript.revision
      && JSON.stringify(current) !== JSON.stringify(conversation.transcript))
      throw new Error("Conversation revision has divergent canonical history");
    this.#transcripts.set(conversation.conversationId, conversation.transcript);
    this.#history.set(conversation.conversationId, history);
    this.#commitConversationMetadata(conversation);
    this.#loadedConversations.add(conversation.conversationId);
  }
  #commitConversationMetadata(conversation: {
    readonly conversationId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly title?: string;
    readonly metadata?: JsonObject;
  }): void {
    this.#conversationUpdatedAt.set(conversation.conversationId, conversation.updatedAt);
    if (conversation.title === undefined) this.#conversationTitles.delete(conversation.conversationId);
    else this.#conversationTitles.set(conversation.conversationId, conversation.title);
    if (conversation.metadata === undefined) this.#conversationMetadata.delete(conversation.conversationId);
    else this.#conversationMetadata.set(conversation.conversationId, immutableClone(conversation.metadata));
  }
  async #recallMemory(input: AgentSubmitInput, signal: AbortSignal): Promise<readonly MemoryRecord[]> {
    if (this.#memory === undefined) return [];
    try {
      const result = await this.#memory.recall({
        query: input.text,
        limit: 8,
        conversationId: input.conversationId,
        signal,
      });
      return snapshotMemoryRecallRecords(result, 8, "automatic memory recall");
    } catch (error) {
      this.#health.record(`memory recall: ${errorMessage(error)}`);
      return [];
    }
  }
  async #captureMemory(record: MemoryRecord, signal: AbortSignal): Promise<void> {
    if (this.#memory?.capture === undefined) return;
    try {
      await this.#memory.capture({ record, signal });
    } catch (error) {
      this.#health.record(`memory capture: ${errorMessage(error)}`);
    }
  }
  async #exportTurn(
    name: string,
    input: AgentSubmitInput,
    route: RuntimeRoute,
    response: AgentResponse,
  ): Promise<void> {
    if (this.#exporterInstances.size === 0) return;
    const record = {
      name,
      timestamp: new Date().toISOString(),
      attributes: {
        agentId: this.config.raw.agent.id,
        conversationId: input.conversationId,
        runtime: route.runtime,
        model: route.model,
        status: response.status,
      },
    } as const;
    for (const [instanceId, exporter] of this.#exporterInstances) {
      try {
        const result = await this.#lifecycle.run(
          `exporter ${instanceId} export`,
          (signal) => exporter.export({ records: [record], signal }),
        );
        if (result === undefined) {
          throw new Error(`exporter ${instanceId} returned no result`);
        }
        if (result.rejected > 0) this.#health.record(`exporter ${instanceId} rejected a turn record`);
      } catch (error) {
        this.#health.record(`exporter ${instanceId}: ${errorMessage(error)}`);
      }
    }
  }
  async #emitTrigger(event: TriggerEvent, signal: AbortSignal): Promise<TriggerReceipt> {
    const combined = AbortSignal.any([this.#hostAbort.signal, signal]);
    const claimed = this.#triggerClaims.get(event.id);
    if (claimed !== undefined) return {
      status: "unknown", code: claimed === "pending" ? "execution_unknown" : claimed,
      reason: this.#redact("The prior trigger outcome is unknown"),
    };
    this.#claimTrigger(event.id, "pending");
    const conversationId = `trigger:${event.triggerInstanceId}:${event.id}`;
    let delivery: ChannelDeliveryResult | undefined;
    let replayed = false;
    try {
      const response = await this.#submitRequest(normalizeSubmitInput({
        requestId: event.id,
        conversationId,
        text: event.prompt,
        ...(event.runtime === undefined ? {} : { runtime: event.runtime }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(typeof event.metadata?.effort === "string" ? { effort: event.metadata.effort } : {}),
        signal: combined,
        metadata: {
          triggerId: event.id,
          triggerInstanceId: event.triggerInstanceId,
          ...(event.metadata ?? {}),
        },
      }), async () => {}, undefined, undefined, (value) => { replayed = value; });
      if (response.status !== "completed") {
        throw new Error(`Trigger turn ended with ${response.status}`);
      }
      if (replayed && event.deliveryChannel === undefined) {
        this.#triggerClaims.delete(event.id);
        return { status: "rejected", code: "duplicate", reason: "duplicate trigger event" };
      }
      if (response.text === PROACTIVE_SUPPRESSION_SENTINEL) {
        this.#triggerClaims.delete(event.id);
        return replayed
          ? { status: "rejected", code: "duplicate", reason: "duplicate trigger event" }
          : { status: "accepted", runId: response.runId };
      }
      if (event.deliveryChannel !== undefined) {
        const destination = typeof event.metadata?.destination === "string"
          ? event.metadata.destination
          : conversationId;
        delivery = await this.deliver(event.deliveryChannel, {
          conversationId: destination,
          text: response.text,
          idempotencyKey: event.id,
          metadata: {
            triggerId: event.id,
            sourceConversationId: conversationId,
            ...deliveryTriggerKind(event.metadata),
          },
        });
        if (delivery.status !== "delivered" && delivery.status !== "duplicate") {
          throw new Error(`Trigger delivery ended with ${delivery.status}`);
        }
        if (replayed && delivery.status === "duplicate") {
          this.#triggerClaims.delete(event.id);
          return { status: "rejected", code: "duplicate", reason: "duplicate trigger event" };
        }
      }
      this.#triggerClaims.delete(event.id);
      return { status: "accepted", runId: response.runId };
    } catch (error) {
      if (error instanceof AgentAdmissionError && error.code === "request_in_progress") {
        this.#claimTrigger(event.id, "execution_unknown");
        return { status: "unknown", code: "execution_unknown", reason: this.#redact(errorMessage(error)) };
      }
      if (error instanceof AgentAdmissionError && error.code === "request_conflict") {
        this.#triggerClaims.delete(event.id);
        return { status: "rejected", code: "execution_failed", reason: this.#redact(errorMessage(error)) };
      }
      const deliveryUnknown = delivery?.status === "unknown";
      const executionUnknown = error instanceof RunExecutionError && error.status === "uncertain"
        || error instanceof AgentAdmissionError
          && (error.code === "uncertain_admission" || error.code === "stale_admission");
      if (deliveryUnknown) {
        this.#claimTrigger(event.id, "delivery_unknown");
        return { status: "unknown", code: "delivery_unknown", reason: this.#redact(errorMessage(error)) };
      }
      if (executionUnknown) {
        this.#claimTrigger(event.id, "execution_unknown");
        return { status: "unknown", code: "execution_unknown", reason: this.#redact(errorMessage(error)) };
      }
      this.#triggerClaims.delete(event.id);
      return { status: "rejected", code: "execution_failed", reason: this.#redact(errorMessage(error)) };
    }
  }
  async #completeMemoryCapture(request: MemoryRuntimeCaptureRequest): Promise<MemoryRuntimeCaptureResult> {
    assertBoundedText(request.instructions, "memory capture instructions", DEFAULT_INSTRUCTION_BYTES);
    assertBoundedText(request.input, "memory capture input", DEFAULT_MESSAGE_BYTES);
    assertRouteText(request.runtime, "memory capture runtime", 256);
    assertRouteText(request.model, "memory capture model", 512);
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > 16_384) {
      throw new RangeError("memory capture maxOutputTokens must be between 1 and 16384");
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3_600_000) {
      throw new RangeError("memory capture timeoutMs must be between 1 and 3600000");
    }
    const runtime = this.#runtimeInstances.get(request.runtime);
    const configuredCapabilities = this.#runtimeCapabilities.get(request.runtime);
    if (runtime === undefined || configuredCapabilities === undefined) {
      throw new Error(`memory capture runtime ${request.runtime} is unavailable`);
    }
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([this.#hostAbort.signal, request.signal, timeout]);
    let routeCapabilities = configuredCapabilities;
    if (runtime.preflightModel !== undefined || runtime.validateModel !== undefined) {
      const rawValidation = runtime.preflightModel !== undefined
        ? await runtime.preflightModel({ model: request.model, signal })
        : await runtime.validateModel!(request.model, signal);
      const validation = normalizeRuntimeModelValidation(
        rawValidation,
        `${request.runtime}:${request.model} memory capture model validation result`,
      );
      if (!validation.supported) {
        throw new Error(`memory capture runtime ${request.runtime} does not support the selected model`);
      }
      routeCapabilities = validation.capabilities ?? routeCapabilities;
    }
    if (!routeCapabilities.structuredOutput) {
      throw new Error("memory capture route does not support structured output");
    }
    const eventBoundary = createRuntimeTurnEventBoundary();
    const captureConversationId = `memory-capture:${randomUUID()}`;
    const captureAuthority = {
      conversationId: captureConversationId,
      route: {
        runtimeInstanceId: request.runtime,
        model: request.model,
      },
    } as const;
    const rawResult = await runtime.runTurn({
      turnId: randomUUID(),
      conversationId: captureConversationId,
      model: request.model,
      messages: [
        { role: "system", content: [{ type: "text", text: request.instructions }] },
        { role: "user", content: [{ type: "text", text: request.input }] },
      ],
      tools: [],
      signal,
      options: {
        maxOutputTokens: request.maxOutputTokens,
        ...(request.responseSchema === undefined ? {} : { responseSchema: request.responseSchema }),
      },
    }, {
      emit: async (event) => {
        normalizeRuntimeTurnEvent(event, eventBoundary, captureAuthority);
      },
      executeTool: async (call) => {
        normalizeRuntimeToolCall(call);
        throw new Error("tools are disabled for memory capture");
      },
    });
    assertRuntimeTurnEventBoundaryHealthy(eventBoundary);
    const result = normalizeRuntimeTurnResult(rawResult, captureAuthority);
    if (result.status !== "completed") throw new Error(`memory capture runtime ended with ${result.status}`);
    return {
      text: textFromMessage(result.message),
      ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
  async #drainInternal(): Promise<void> {
    if (this.#state === "new") return;
    if (this.#state === "stopped" || this.#state === "failed") return;
    this.#state = "draining";
    const deadline = new Date(Date.now() + this.#options.drainTimeoutMs).toISOString();
    const idle = this.#watchForIdle();
    const failures: unknown[] = [];
    try {
      await withTimeoutSignal(
        () => idle.promise, this.#options.drainTimeoutMs, undefined, "Agent drain",
      );
    } catch (error) {
      this.#hostAbort.abort(error);
      failures.push(error);
    } finally {
      idle.cancel();
    }
    for (const running of [...this.#running].reverse()) {
      if (running.instance.drain === undefined) continue;
      try {
        await this.#lifecycle.run(
          `${running.loaded.instanceId} drain`,
          (signal) => running.instance.drain?.({ signal, deadline }),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Agent host drain failed");
  }
  async #stopInternal(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state !== "failed") {
      try {
        await this.drain();
      } catch {
        // Stop still attempts every reverse lifecycle even when drain is degraded.
      }
    }
    this.#hostAbort.abort("shutdown");
    const failures = await this.#stopRunning("shutdown");
    try {
      await this.#lifecycle.cleanup("MCP close", () => this.#mcp.close());
    } catch (error) {
      failures.push(error);
    }
    this.#state = "stopped";
    if (failures.length > 0) throw new AggregateError(failures, "Agent host stopped with lifecycle errors");
  }
  async #stopRunning(reason: "shutdown" | "startup-failed"): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const running of [...this.#running].reverse()) {
      if (running.instance.stop === undefined) continue;
      try {
        await this.#lifecycle.cleanup(
          `${running.loaded.instanceId} stop`,
          (signal) => running.instance.stop?.({ signal, reason }),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    this.#running.length = 0;
    this.#runtimeInstances.clear();
    this.#runtimeCapabilities.clear();
    this.#channelInstances.clear();
    this.#channelCapabilities.clear();
    this.#moduleTools = [];
    this.#channelTools = [];
    this.#ambiguousToolAliases = [];
    this.#exporterInstances.clear();
    this.#memory = undefined;
    this.#execution = undefined;
    this.#stateStore = undefined;
    this.#sandbox = undefined;
    this.#sessionStore.clear();
    // Conversation caches are per-host process state, not durable state. They
    // previously survived stop() entirely, so a long-lived host grew without
    // bound in conversation count and a restarted host answered from caches
    // whose backing modules were already gone.
    this.#history.clear();
    this.#transcripts.clear();
    this.#loadedConversations.clear();
    this.#conversationUpdatedAt.clear();
    this.#conversationTitles.clear();
    this.#conversationMetadata.clear();
    this.#triggerClaims.clear();
    return failures;
  }
  #watchForIdle(): { readonly promise: Promise<void>; cancel(): void } {
    if (this.#pending === 0) return { promise: Promise.resolve(), cancel() {} };
    let resolveIdle!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolveIdle = resolvePromise;
      this.#idleWaiters.add(resolveIdle);
    });
    return {
      promise,
      cancel: () => this.#idleWaiters.delete(resolveIdle),
    };
  }
  #claimTrigger(id: string, state: "pending" | "delivery_unknown" | "execution_unknown"): void {
    this.#triggerClaims.delete(id);
    this.#triggerClaims.set(id, state);
    while (this.#triggerClaims.size > MAX_TRIGGER_CLAIMS) {
      const oldest = this.#triggerClaims.keys().next();
      if (oldest.done === true) break;
      this.#triggerClaims.delete(oldest.value);
      this.#health.record("trigger claim ledger is full; the oldest claim was dropped");
    }
  }
  /** A settlement window bounded by both the lifecycle timeout and host shutdown. */
  #settlementSignal(): AbortSignal {
    return settlementSignal(this.#options.lifecycleTimeoutMs, this.#hostAbort.signal);
  }
  #redact(message: string): string {
    return redactBounded(message, this.#redactionValues, DEFAULT_MESSAGE_BYTES);
  }
  #redactedError(error: unknown): Error {
    const message = this.#redact(errorMessage(error));
    if (error instanceof AgentConfigError) {
      return new AgentConfigError(message, error.issues.map((issue) => ({
        ...issue,
        message: this.#redact(issue.message),
      })));
    }
    if (error instanceof AgentModuleError) {
      return new AgentModuleError(message, {
        ...(error.code === undefined ? {} : { code: this.#redact(error.code) }), ...(error.packageName === undefined ? {} : { packageName: this.#redact(error.packageName) }),
        ...(error.configPath === undefined ? {} : { configPath: this.#redact(error.configPath) }), ...(error.moduleInstanceId === undefined ? {} : { moduleInstanceId: this.#redact(error.moduleInstanceId) }),
        ...(error.commandName === undefined ? {} : { commandName: boundedUtf8(this.#redact(error.commandName), 512) }), ...(error.phase === undefined ? {} : { phase: error.phase }),
      });
    }
    return new Error(message);
  }
  #safePublicCause(
    error: unknown,
    snapshot: RuntimeTurnErrorSnapshot | undefined = snapshotRuntimeTurnError(error),
  ): Error {
    return new Error(boundedUtf8(
      this.#redact(boundedRuntimeFailureMessage(error, snapshot)),
      4_096,
    ));
  }
}
function declaresHostCapability(module: LoadedAgentModule, capability: string): boolean {
  return module.definition.manifest.capabilities.includes(capability);
}
function boundedPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError("page limit must be an integer between 1 and 10000");
  }
  return value;
}
function decodePageCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor)) throw new TypeError("page cursor is invalid");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new TypeError("page cursor is invalid");
  return offset;
}
function encodePageCursor(offset: number): string {
  return String(offset);
}
function stableReplayId(conversationId: string, index: number, message: TurnMessage): string {
  return createHash("sha256")
    .update(conversationId)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(encodePersistedValue(message))
    .digest("hex");
}
