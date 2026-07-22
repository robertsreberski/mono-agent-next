import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type Channel,
  type ChannelHost,
  type ChannelInboundRequest,
  type ChannelModuleDefinition,
  type ChannelReplySink,
  type ChannelTurnResult,
  type ConfigProvenanceMap,
  type JsonObject,
  type JsonValue,
  type MemoryModuleDefinition,
  type ModuleHost,
  type ModuleInstance,
  type ModuleLogger,
  type Runtime,
  type RuntimeModuleDefinition,
  type RuntimeSession,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeTurnEvent,
  type RuntimeTurnResult,
  type TurnMessage,
} from "@mono-agent/module-sdk";
import type { ReservedModuleDefinition } from "@mono-agent/module-sdk/internal";

import { ensureLoadedAgentConfig, environmentFor } from "./config.js";
import {
  AgentAdmissionError,
  AgentConfigError,
  AgentModuleError,
  errorMessage,
} from "./errors.js";
import {
  connectProjectMcpTools,
  loadProjectMcpConfig,
  type ConnectedMcpTools,
  type CoreRuntimeTool,
} from "./mcp.js";
import { moduleConfigFor } from "./module-loader.js";
import type {
  AgentHealth,
  AgentHost,
  AgentHostOptions,
  AgentHostStartInfo,
  AgentResponse,
  AgentSubmitInput,
  LoadedAgentConfig,
  LoadedAgentModule,
  ModuleKind,
  RuntimeRoute,
} from "./types.js";

const DEFAULT_MAX_CONCURRENT_TURNS = 4;
const DEFAULT_MAX_PENDING_TURNS = 64;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;
const DEFAULT_INSTRUCTION_BYTES = 1_000_000;

interface RunningModule {
  readonly loaded: LoadedAgentModule;
  readonly instance: ModuleInstance;
}

type HostState = "new" | "starting" | "running" | "draining" | "stopped" | "failed";

export async function createAgentHost(
  config: string | LoadedAgentConfig,
  options: AgentHostOptions = {},
): Promise<AgentHost> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  const host = new AgentHostImplementation(loaded, options);
  await host.start();
  return host;
}

class AgentHostImplementation implements AgentHost {
  readonly config: LoadedAgentConfig;
  readonly #options: Required<Pick<AgentHostOptions, "maxConcurrentTurns" | "maxPendingTurns" | "drainTimeoutMs" | "lifecycleTimeoutMs">>;
  readonly #hostAbort = new AbortController();
  readonly #runtimeInstances = new Map<string, Runtime>();
  readonly #channelInstances = new Map<string, Channel>();
  readonly #running: RunningModule[] = [];
  readonly #history = new Map<string, TurnMessage[]>();
  readonly #sessions = new Map<string, RuntimeSession>();
  readonly #conversationTails = new Map<string, Promise<void>>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #semaphore: Semaphore;
  #mcp: ConnectedMcpTools = { tools: [], async close() {} };
  #instructions = "";
  #state: HostState = "new";
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
    this.#semaphore = new Semaphore(this.#options.maxConcurrentTurns);
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
      this.#admit(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#submitSerialized(input);
  }

  #admit(input: AgentSubmitInput): void {
    if (this.#state !== "running") {
      throw new AgentAdmissionError(`Agent is not accepting turns (${this.#state})`);
    }
    if (typeof input.conversationId !== "string" || input.conversationId.trim().length === 0) {
      throw new TypeError("conversationId must be non-empty");
    }
    if (typeof input.text !== "string" || input.text.length === 0) {
      throw new TypeError("text must be non-empty");
    }
    if (this.#pending >= this.#options.maxPendingTurns) {
      throw new AgentAdmissionError(`Agent pending-turn limit ${this.#options.maxPendingTurns} reached`);
    }
    this.#pending += 1;
  }

  async health(): Promise<AgentHealth> {
    if (this.#state === "stopped" || this.#state === "failed") {
      return { status: "stopped", accepting: false, pending: this.#pending, active: this.#active, modules: [] };
    }
    const modules = [];
    let degraded = false;
    for (const running of this.#running) {
      if (running.instance.health === undefined) {
        modules.push({ kind: running.loaded.slot, instanceId: running.loaded.instanceId, status: "unknown" });
        continue;
      }
      try {
        const health = await withTimeoutSignal(
          (signal) => running.instance.health?.({ signal }),
          this.#options.lifecycleTimeoutMs,
          this.#hostAbort.signal,
          `${running.loaded.instanceId} health`,
        );
        const status = health?.status ?? "unknown";
        if (status !== "healthy") degraded = true;
        modules.push({ kind: running.loaded.slot, instanceId: running.loaded.instanceId, status, detail: health });
      } catch (error) {
        degraded = true;
        modules.push({
          kind: running.loaded.slot,
          instanceId: running.loaded.instanceId,
          status: "unhealthy",
          detail: { message: this.#redact(errorMessage(error)) },
        });
      }
    }
    return {
      status: this.#state === "draining" ? "stopping" : degraded ? "degraded" : "healthy",
      accepting: this.#state === "running",
      pending: this.#pending,
      active: this.#active,
      modules,
    };
  }

  drain(): Promise<void> {
    this.#drainPromise ??= this.#drainInternal();
    return this.#drainPromise;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    return this.#stopPromise;
  }

  async #startInternal(): Promise<void> {
    this.#state = "starting";
    try {
      this.#instructions = await readInstructions(this.config);
      const environment = environmentFor(this.config);
      const mcpConfig = await loadProjectMcpConfig(this.config.paths.mcpConfig, environment);
      const phases: readonly ModuleKind[] = ["runtime", "memory", "state", "sandbox", "exporter"];
      for (const kind of phases) await this.#startKind(kind);
      this.#mcp = await connectProjectMcpTools(mcpConfig, {
        projectRoot: this.config.projectRoot,
        ...(this.config.paths.mcpConfig === undefined ? {} : { configPath: this.config.paths.mcpConfig }),
        environment,
      });
      await this.#startKind("channel");
      await this.#startKind("trigger");
      this.#startInfo = {
        ...this.#startInfo,
        channels: [...this.#channelInstances.entries()].map(([instanceId, channel]) => ({
          instanceId,
          kind: "channel" as const,
          ...readEndpoint(channel),
        })),
      };
      this.#state = "running";
    } catch (error) {
      const redactedError = this.#redactedError(error);
      this.#state = "failed";
      this.#hostAbort.abort(redactedError);
      await this.#stopRunning("startup-failed");
      try {
        await withTimeoutSignal(
          () => this.#mcp.close(),
          this.#options.lifecycleTimeoutMs,
          undefined,
          "MCP close after startup failure",
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
      const instance = await withTimeoutSignal(
        (signal) => this.#createInstance(module, signal),
        this.#options.lifecycleTimeoutMs,
        this.#hostAbort.signal,
        `${module.instanceId} create`,
      );
      if (instance === undefined) throw new Error(`${module.packageName} create() returned undefined`);
      this.#running.push({ loaded: module, instance });
      if (kind === "runtime") this.#runtimeInstances.set(module.instanceId, instance as Runtime);
      if (kind === "channel") this.#channelInstances.set(module.instanceId, instance as Channel);
      if (instance.start !== undefined) {
        await withTimeoutSignal(
          (signal) => instance.start?.({ signal }),
          this.#options.lifecycleTimeoutMs,
          this.#hostAbort.signal,
          `${module.instanceId} start`,
        );
      }
    }
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
    if (!isModuleInstance(instance)) throw new Error(`${module.packageName} create() returned an invalid module instance`);
    return instance;
  }

  #moduleHost(module: LoadedAgentModule): ModuleHost | ChannelHost {
    const capabilityValues = new Map<string, unknown>();
    const grantedCapabilities = new Set(capabilityValues.keys());
    const base: ModuleHost = {
      grantedCapabilities,
      getCapability<T = unknown>(name: string): T | undefined {
        return capabilityValues.get(name) as T | undefined;
      },
    };
    if (module.slot !== "channel") return base;
    return {
      ...base,
      dispatch: async (request, reply) => this.#dispatchChannel(request, reply),
    };
  }

  async #dispatchChannel(request: ChannelInboundRequest, reply: ChannelReplySink): Promise<ChannelTurnResult> {
    let emittedText = false;
    try {
      const input: AgentSubmitInput = {
        conversationId: request.conversationId,
        text: request.text,
        ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        signal: request.signal,
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      };
      this.#admit(input);
      const response = await this.#submitWithEvents(
        input,
        async (event) => {
          if (event.type === "text-delta") {
            emittedText = true;
            await reply.emit({ type: "text-delta", delta: event.delta });
          }
        },
      );
      if (!emittedText && response.text.length > 0) await reply.emit({ type: "text-replace", text: response.text });
      return { status: response.status === "completed" ? "completed" : "cancelled", text: response.text };
    } catch (error) {
      if (isAbort(error)) return { status: "cancelled" };
      return {
        status: "rejected",
        diagnostics: [{ code: "turn_failed", severity: "error", message: this.#redact(errorMessage(error)) }],
      };
    }
  }

  async #submitSerialized(input: AgentSubmitInput): Promise<AgentResponse> {
    return this.#submitWithEvents(input, async () => {});
  }

  async #submitWithEvents(
    input: AgentSubmitInput,
    emit: (event: RuntimeTurnEvent) => Promise<void>,
  ): Promise<AgentResponse> {
    const previous = this.#conversationTails.get(input.conversationId) ?? Promise.resolve();
    let releaseConversation!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseConversation = resolveGate;
    });
    const current = previous.catch(() => {}).then(() => gate);
    this.#conversationTails.set(input.conversationId, current);
    const signal = AbortSignal.any([this.#hostAbort.signal, ...(input.signal === undefined ? [] : [input.signal])]);
    try {
      await waitWithAbort(previous.catch(() => {}), signal);
      const releaseSlot = await this.#semaphore.acquire(signal);
      this.#active += 1;
      try {
        return await this.#runTurn(input, signal, emit);
      } finally {
        this.#active -= 1;
        releaseSlot();
      }
    } finally {
      releaseConversation();
      if (this.#conversationTails.get(input.conversationId) === current) this.#conversationTails.delete(input.conversationId);
      this.#pending -= 1;
      if (this.#pending === 0) {
        for (const resolveIdle of this.#idleWaiters) resolveIdle();
        this.#idleWaiters.clear();
      }
    }
  }

  async #runTurn(
    input: AgentSubmitInput,
    signal: AbortSignal,
    emit: (event: RuntimeTurnEvent) => Promise<void>,
  ): Promise<AgentResponse> {
    const routes = routeCandidates(this.config, input);
    const tools = filterTools(this.#mcp.tools, this.config, input);
    const errors: Error[] = [];
    for (const route of routes) {
      if (signal.aborted) throw abortError();
      const runtime = this.#runtimeInstances.get(route.runtime);
      if (runtime === undefined) {
        errors.push(new Error(`Runtime ${route.runtime} is not started`));
        continue;
      }
      let routeCapabilities = runtime.capabilities;
      if (runtime.validateModel !== undefined) {
        const validation = await runtime.validateModel(route.model, signal);
        if (!validation.supported) {
          errors.push(new Error(`${route.runtime} does not support model ${route.model}`));
          continue;
        }
        routeCapabilities = validation.capabilities ?? routeCapabilities;
      }
      const eligibility = runtimeEligibility(
        routeCapabilities,
        tools,
        input.requiredCapabilities ?? [],
        this.config,
      );
      if (eligibility !== undefined) {
        errors.push(new Error(`${route.runtime}:${route.model} is ineligible: ${eligibility}`));
        continue;
      }
      try {
        const result = await runtime.runTurn(
          this.#runtimeRequest(input, route, tools, signal),
          {
            emit,
            executeTool: async (call, toolSignal) => executeTool(
              call,
              tools,
              AbortSignal.any([signal, toolSignal]),
              (message) => this.#redact(message),
            ),
          },
        );
        if (signal.aborted) throw abortError();
        return this.#settle(input, route, result);
      } catch (error) {
        if (signal.aborted || isAbort(error)) throw abortError();
        errors.push(new Error(this.#redact(errorMessage(error))));
        if (hasCommittedEffects(error) || !isRetryable(error)) break;
      }
    }
    throw new AggregateError(errors, `Every eligible runtime route failed for conversation ${input.conversationId}`);
  }

  #runtimeRequest(
    input: AgentSubmitInput,
    route: RuntimeRoute,
    tools: readonly CoreRuntimeTool[],
    signal: AbortSignal,
  ) {
    const history = this.#history.get(input.conversationId) ?? [];
    const sessionKey = `${route.runtime}\0${input.conversationId}`;
    const session = this.config.raw.session?.mode === "per-message" ? undefined : this.#sessions.get(sessionKey);
    const metadata = toJsonObject(input.metadata);
    return {
      turnId: randomUUID(),
      conversationId: input.conversationId,
      model: route.model,
      messages: [
        { role: "system" as const, content: [{ type: "text" as const, text: this.#instructions }] },
        ...history,
        { role: "user" as const, content: [{ type: "text" as const, text: input.text }] },
      ],
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      signal,
      ...(session === undefined ? {} : { session }),
      options: {
        ...(input.effort ?? this.config.raw.routing.effort) === undefined
          ? {}
          : { effort: input.effort ?? this.config.raw.routing.effort },
      },
      ...(metadata === undefined ? {} : { metadata }),
    };
  }

  #settle(input: AgentSubmitInput, route: RuntimeRoute, result: RuntimeTurnResult): AgentResponse {
    if (!isRuntimeTurnResult(result)) throw new Error(`${route.runtime} returned an invalid turn result`);
    const text = result.message === undefined ? "" : textFromMessage(result.message);
    if (result.status === "completed") {
      const history = this.#history.get(input.conversationId) ?? [];
      history.push(
        { role: "user", content: [{ type: "text", text: input.text }] },
        result.message,
      );
      this.#history.set(input.conversationId, history);
      if (result.session !== undefined && this.config.raw.session?.mode !== "per-message") {
        this.#sessions.set(`${route.runtime}\0${input.conversationId}`, result.session);
      }
    }
    return {
      conversationId: input.conversationId,
      runtime: route.runtime,
      model: route.model,
      status: result.status,
      text,
      output: result,
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    };
  }

  async #drainInternal(): Promise<void> {
    if (this.#state === "new") return;
    if (this.#state === "stopped" || this.#state === "failed") return;
    this.#state = "draining";
    const deadline = new Date(Date.now() + this.#options.drainTimeoutMs).toISOString();
    const idle = this.#watchForIdle();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<"timeout">((resolveTimer) => {
      timeout = setTimeout(() => resolveTimer("timeout"), this.#options.drainTimeoutMs);
    });
    let outcome: "idle" | "timeout";
    try {
      outcome = await Promise.race([idle.promise.then(() => "idle" as const), timer]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      idle.cancel();
    }
    const failures: unknown[] = [];
    if (outcome === "timeout") {
      const error = new Error(`Agent drain timed out after ${this.#options.drainTimeoutMs}ms`);
      this.#hostAbort.abort(error);
      failures.push(error);
    }
    for (const running of [...this.#running].reverse()) {
      if (running.instance.drain === undefined) continue;
      try {
        await withTimeoutSignal(
          (signal) => running.instance.drain?.({ signal, deadline }),
          this.#options.lifecycleTimeoutMs,
          this.#hostAbort.signal,
          `${running.loaded.instanceId} drain`,
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
      await withTimeoutSignal(
        () => this.#mcp.close(),
        this.#options.lifecycleTimeoutMs,
        undefined,
        "MCP close",
      );
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
        await withTimeoutSignal(
          (signal) => running.instance.stop?.({ signal, reason }),
          this.#options.lifecycleTimeoutMs,
          undefined,
          `${running.loaded.instanceId} stop`,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    this.#running.length = 0;
    this.#runtimeInstances.clear();
    this.#channelInstances.clear();
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

  #redact(message: string): string {
    let redacted = message;
    for (const value of Object.values(environmentFor(this.config))) {
      if (typeof value === "string" && value.length >= 4) redacted = redacted.replaceAll(value, "[REDACTED]");
    }
    return redacted;
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
        ...(error.packageName === undefined ? {} : { packageName: error.packageName }),
        ...(error.configPath === undefined ? {} : { configPath: error.configPath }),
      });
    }
    return new Error(message);
  }
}

function routeCandidates(config: LoadedAgentConfig, input: AgentSubmitInput): readonly RuntimeRoute[] {
  const primary =
    input.runtime === undefined && input.model === undefined
      ? config.raw.routing.primary
      : {
          runtime: input.runtime ?? config.raw.routing.primary.runtime,
          model: input.model ?? config.raw.routing.primary.model,
        };
  const routes = [primary, ...config.raw.routing.fallbacks];
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.runtime}\0${route.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runtimeEligibility(
  capabilities: Runtime["capabilities"],
  tools: readonly CoreRuntimeTool[],
  required: readonly string[],
  config: LoadedAgentConfig,
): string | undefined {
  if (tools.length > 0 && (!capabilities.tools || !capabilities.mcp)) return "MCP tools unsupported";
  if (config.raw.policy.approvals.default === "ask" && !capabilities.approvals) return "approvals unsupported";
  if (!("mode" in config.raw.policy.sandbox && config.raw.policy.sandbox.mode === "off") && !capabilities.sandbox) {
    return "sandbox unsupported";
  }
  for (const capability of required) {
    if (!Object.hasOwn(capabilities, capability)) return `unknown required capability ${capability}`;
    if (!(capabilities as unknown as Record<string, boolean>)[capability]) return `${capability} unsupported`;
  }
  return undefined;
}

function filterTools(
  tools: readonly CoreRuntimeTool[],
  config: LoadedAgentConfig,
  input: AgentSubmitInput,
): readonly CoreRuntimeTool[] {
  if (config.raw.policy.approvals.default === "deny") return [];
  const policy = config.raw.policy.tools;
  let allowed =
    policy.default === "allow"
      ? new Set(tools.map((tool) => tool.name).filter((name) => !(policy.deny ?? []).includes(name)))
      : new Set(policy.allow ?? []);
  if (input.toolPolicy?.allow !== undefined) {
    const narrower = new Set(input.toolPolicy.allow);
    allowed = new Set([...allowed].filter((name) => narrower.has(name)));
  }
  for (const denied of input.toolPolicy?.deny ?? []) allowed.delete(denied);
  return tools.filter((tool) => allowed.has(tool.name));
}

async function executeTool(
  call: RuntimeToolCall,
  tools: readonly CoreRuntimeTool[],
  signal: AbortSignal,
  redact: (message: string) => string,
): Promise<RuntimeToolResult> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) {
    return { callId: call.id, isError: true, content: [{ type: "text", text: `Tool ${call.name} is not allowed` }] };
  }
  try {
    const output = await tool.execute(call.input, { signal });
    return { callId: call.id, content: normalizeToolContent(output) };
  } catch (error) {
    return {
      callId: call.id,
      isError: true,
      content: [{ type: "text", text: redact(errorMessage(error)) }],
    };
  }
}

function normalizeToolContent(output: unknown): RuntimeToolResult["content"] {
  if (isRecord(output) && Array.isArray(output.content)) {
    return output.content.map((part) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return { type: "text" as const, text: part.text };
      if (isRecord(part) && part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        return { type: "file" as const, data: part.data, mediaType: part.mimeType };
      }
      return { type: "json" as const, value: toJsonValue(part) };
    });
  }
  return [{ type: "json", value: toJsonValue(output) }];
}

function isRuntimeTurnResult(value: unknown): value is RuntimeTurnResult {
  if (!isRecord(value) || !(["completed", "cancelled", "max-turns"] as const).includes(value.status as never)) return false;
  if (value.status === "completed") return isTurnMessage(value.message);
  return value.message === undefined || isTurnMessage(value.message);
}

function isTurnMessage(value: unknown): value is TurnMessage {
  return isRecord(value) && typeof value.role === "string" && Array.isArray(value.content);
}

function textFromMessage(message: TurnMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function moduleProvenance(module: LoadedAgentModule, config: LoadedAgentConfig): ConfigProvenanceMap {
  const selected = lookupPath(config.raw, module.configPath);
  const map: Record<string, { source: "file" | "environment"; filePath?: string; environmentName?: string }> = {};
  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (isEnvReference(value)) {
      map[toPointer(path)] = { source: "environment", environmentName: value.$env };
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, index]));
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key !== "$use") visit(child, [...path, key]);
      }
    } else {
      map[toPointer(path)] = { source: "file", filePath: config.configPath };
    }
  };
  visit(selected, []);
  return map;
}

async function readInstructions(config: LoadedAgentConfig): Promise<string> {
  const info = await stat(config.paths.instructions);
  if (!info.isFile()) throw new AgentConfigError("Agent instructions are not a regular file", [
    { path: "agent.instructions", message: "must resolve to a regular file", code: "file_type" },
  ]);
  const maxBytes = config.raw.context?.skills?.maxBytes ?? DEFAULT_INSTRUCTION_BYTES;
  if (info.size > maxBytes) throw new AgentConfigError("Agent instructions exceed the configured context bound", [
    { path: "agent.instructions", message: `${info.size} bytes exceeds ${maxBytes}`, code: "size" },
  ]);
  return readFile(config.paths.instructions, "utf8");
}

function readEndpoint(instance: Channel): { readonly endpoint?: string } {
  if (isRecord(instance) && typeof instance.endpoint === "string") return { endpoint: instance.endpoint };
  return {};
}

function isModuleInstance(value: unknown): value is ModuleInstance {
  return typeof value === "object" && value !== null;
}

function isEnvReference(value: unknown): value is { readonly $env: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.$env === "string";
}

function lookupPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function toPointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "";
  return `/${path.map((entry) => String(entry).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  const converted = toJsonValue(value);
  return isRecord(converted) ? (converted as JsonObject) : undefined;
}

function toJsonValue(value: unknown, seen = new Set<object>(), depth = 0): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 32) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen, depth + 1));
  if (isRecord(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of Object.entries(value)) output[key] = toJsonValue(entry, seen, depth + 1);
    seen.delete(value);
    return output;
  }
  return String(value);
}

function hasCommittedEffects(error: unknown): boolean {
  return isRecord(error) && (error.committed === true || error.committedSideEffects === true);
}

function isRetryable(error: unknown): boolean {
  return !(isRecord(error) && error.retryable === false);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

async function waitWithAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(abortError());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

async function withTimeoutSignal<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T> | undefined,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  label: string,
): Promise<T | undefined> {
  const timeoutController = new AbortController();
  const signal = parent === undefined
    ? timeoutController.signal
    : AbortSignal.any([parent, timeoutController.signal]);
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timeoutController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const running = Promise.resolve().then(() => operation(signal));
  try {
    return await Promise.race([running, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: { readonly resolve: (release: () => void) => void; readonly reject: (error: Error) => void; readonly signal: AbortSignal }[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolveAcquire, rejectAcquire) => {
      const waiter = { resolve: resolveAcquire, reject: rejectAcquire, signal };
      this.#waiters.push(waiter);
      signal.addEventListener(
        "abort",
        () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          rejectAcquire(abortError());
        },
        { once: true },
      );
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#active -= 1;
      return;
    }
    if (next.signal.aborted) {
      this.#release();
      return;
    }
    next.resolve(() => this.#release());
  }
}

const NULL_LOGGER: ModuleLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});
