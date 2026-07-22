// @ts-check
// Turn execution for the pi-native bridge.
//
// Pure moves out of pi-native.js: effort→thinkingLevel mapping, harness
// construction + stream-subscriber wiring + abort wiring, the live-input
// steering consumer, and the prompt/waitForIdle run. No module-level mutable
// state; run state (harness, removeAbortHandler, externalAbort) lives on the
// caller-owned runState.

import { AgentHarness } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createStructuredOutputTool,
  getPiBuiltinTools,
  initPiMcpTools,
} from "../../../agent/tools/pi-bridge.js";
import { createNodeReplController } from "../../../agent/tools/node-repl.js";
import { readToolRuntime } from "../../../agent/tools/shared/runtime-context.js";
import { formatLiveInputGuidance } from "../../live-input-prompt.js";
import { appendStructuredOutputInstruction } from "./structured-output.js";
import { createStreamSubscriber } from "./stream-subscriber.js";

/**
 * Build the turn's tool set: the sandboxed/allowlisted/bloat-guarded builtin
 * tools, the MCP tool bridge, and the StructuredOutput tool (whose callback
 * writes runState.structuredResult). Surfaces MCP init/list failures to both the
 * event stream and runtimeWarnings. Returns the assembled tools plus the MCP
 * clients (closed by the caller's finally), run-owned tool cleanup, and the
 * structured tool.
 * @param {any} runState
 * @param {any} params
 * @returns {Promise<{tools: any[], structuredTool: any, mcpClients: any[], closeRunTools: () => Promise<void>}>}
 */
export async function buildTurnTools(runState, {
  options,
  capabilities,
  toolLimits,
  approvalManager,
  runtime,
  resolved,
  onEvent,
  runtimeWarnings,
}) {
  const onTruncate = (info) => {
    try {
      onEvent({
        type: "runtime_warning",
        warning_kind: "tool_payload_truncated",
        source: "tool_bloat_guard",
        ...info,
      });
    } catch { /* best-effort */ }
  };
  const persistArtifact = options.persistArtifact || null;
  const qaOutputDir = options.qaOutputDir || options.runArtifactDir || null;

  // Per-run sandbox override (item 7): precedence run impl > host impl >
  // passthrough. When the run supplies its own RuntimeSandbox, thread a ctx copy
  // whose `.sandbox` is that impl so this run's tools/MCP-stdio launcher enforce
  // through it; otherwise the host/default ToolContext is used unchanged. The
  // per-run policy DATA (sandboxPolicy) still merges monotonically inside
  // resolveSandboxPolicy (I13) regardless of which impl is chosen.
  const runCtx = options.sandbox
    ? { ...(options.toolContext ?? readToolRuntime()), sandbox: options.sandbox }
    : options.toolContext;
  const sandboxEngine = options.sandboxEngine ?? runCtx?.sandboxEngine;
  const nodeReplController = capabilities.tool_use === false
    ? null
    : createNodeReplController({
      cwd: options.cwd,
      maxOutputChars: toolLimits.bashOutputLimitChars || toolLimits.toolTextLimitChars,
      sandboxPolicy: options.sandboxPolicy,
      sandboxEngine,
      ctx: runCtx,
    });

  // REUSED custom pieces: built-in tool sandboxing + allowlist/bloat filter +
  // approval gates. These are identical to the legacy bridge.
  // Cast: pi-bridge's tool-builder option bags are not precisely typed (their
  // no-default destructured keys drop out of structural inference), so the
  // caller's full bag is passed through an `any` boundary — matching how the
  // pre-split (non-@ts-check) orchestrator called these.
  const builtIns = capabilities.tool_use === false
    ? []
    : getPiBuiltinTools(options.allowedTools, /** @type {any} */ ({
      // deny-wins filter applied over the built-ins + ReadSkill inside pi-bridge.
      disallowedTools: options.disallowedTools,
      skillNames: (options.skills || []).map((/** @type {{name: string}} */ skill) => skill.name),
      // Full skill objects so ReadSkill can honor pi's neutral Skill shape
      // ({name, filePath, ...}) and derive each skill's root from its own
      // filePath when no shared skillsRoot is threaded.
      skills: options.skills || [],
      // Progressive skill disclosure: when the harness threads the skills root
      // (the directory holding `<name>/SKILL.md`) the ReadSkill tool resolves
      // bodies directly from there. `dataDir` (skills under `<dataDir>/skills`)
      // remains the back-compat fallback; a per-skill filePath is the third path.
      skillsRoot: options.skillsRoot,
      dataDir: options.dataDir,
      cwd: options.cwd,
      onEvent,
      persistArtifact,
      onTruncate,
      toolLimits,
      toolPayloadMaxBytes: toolLimits.toolPayloadMaxBytes,
      imageInlineMaxBytes: toolLimits.imageInlineMaxBytes,
      toolPolicy: options.toolPolicy,
      sandboxPolicy: options.sandboxPolicy,
      sandboxEngine,
      approvalManager,
      approvalModel: runtime.model?.id || runtime.model?.name || resolved.model,
      nodeReplController,
      ctx: runCtx,
    }));

  const structuredTool = createStructuredOutputTool(options.outputSchema, (value) => {
    runState.structuredResult = value;
  });
  const reservedNames = new Set(builtIns.map((/** @type {{name: string}} */ toolDef) => toolDef.name));
  if (structuredTool) reservedNames.add(structuredTool.name);

  // REUSED MCP tool bridge: same initPiMcpTools sandboxing path (see the cast
  // note above — the option bag crosses the same untyped pi-bridge boundary).
  const mcpInit = capabilities.tool_use === false
    ? { clients: [], tools: [], warnings: [] }
    : await initPiMcpTools(options.mcpServers || {}, reservedNames, /** @type {any} */ ({
      cwd: options.cwd,
      persistArtifact,
      qaOutputDir,
      onTruncate,
      limits: toolLimits,
      toolPayloadMaxBytes: toolLimits.toolPayloadMaxBytes,
      sandboxPolicy: options.sandboxPolicy,
      sandboxEngine,
      ctx: runCtx,
    }));
  // Surface MCP init/list failures BOTH to the live event stream and to runtimeWarnings, so a
  // failed server (e.g. an stdio adapter-send child that closed on startup) lands in the run
  // summary's runtimeWarnings instead of being buried as a transient event the summary drops.
  for (const warning of mcpInit.warnings || []) {
    onEvent(warning);
    runtimeWarnings.push(warning);
  }

  const tools = [
    ...builtIns,
    ...mcpInit.tools,
    ...(structuredTool ? [structuredTool] : []),
  ];
  return {
    tools,
    structuredTool,
    mcpClients: mcpInit.clients,
    closeRunTools: async () => { await nodeReplController?.close(); },
  };
}

/**
 * Map an effort level to the harness thinkingLevel, respecting model reasoning
 * capability (no reasoning / reasoning_mode "none" → "off").
 * @param {string} effort
 * @param {any} capabilities
 * @returns {string}
 */
export function thinkingLevelForEffort(effort, capabilities) {
  if (!capabilities?.reasoning || capabilities.reasoning_mode === "none") return "off";
  if (effort === "none") return "off";
  // Pi <0.80.6 and older/custom model metadata do not advertise native max.
  // Preserve the historical xhigh ceiling for those models, but pass max
  // through when the resolved model explicitly declares it.
  if (effort === "max") {
    return Array.isArray(capabilities.reasoning_levels)
      && capabilities.reasoning_levels.includes("max")
      ? "max"
      : "xhigh";
  }
  if (effort === "xhigh") return "xhigh";
  if (effort === "high") return "high";
  if (effort === "medium") return "medium";
  if (effort === "minimal") return "minimal";
  return "low";
}

/**
 * Construct the AgentHarness for this turn, subscribe the stream-subscriber, and
 * wire the external abort handler. Sets runState.harness and
 * runState.removeAbortHandler; the abort handler sets runState.externalAbort and
 * aborts the harness. Returns the harness.
 * @param {any} runState
 * @param {any} params
 * @returns {any}
 */
export function buildTurnHarness(runState, {
  cwd,
  session,
  piModels,
  model,
  thinkingLevel,
  systemPrompt,
  outputSchema,
  tools,
  transport,
  maxRetries,
  maxRetryDelayMs,
  steeringMode,
  onEvent,
  options,
  toolLimits,
  sdk,
  reference,
}) {
  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: cwd || process.cwd() }),
    session,
    models: piModels,
    model,
    thinkingLevel,
    systemPrompt: appendStructuredOutputInstruction(systemPrompt, outputSchema, options.prompts),
    tools,
    streamOptions: { transport, maxRetries, maxRetryDelayMs },
    steeringMode,
    followUpMode: steeringMode,
  });
  // MCP `CallToolResult.isError` is a successful protocol response, so pi's
  // execute() promise resolves. The bridge records that bit in result details;
  // this after-tool hook restores the error flag while preserving the already
  // bounded content/details verbatim. Downstream tool_execution_end and timing
  // events therefore report the failure accurately.
  harness.on("tool_result", (event) => /** @type {any} */ (event?.details)?.mcp_result_is_error === true
    ? { isError: true }
    : undefined);
  runState.harness = harness;

  harness.subscribe(createStreamSubscriber(runState, {
    onEvent,
    options,
    toolLimits,
    harness,
    sdk,
    model: reference,
  }));

  const abortHandler = () => {
    runState.externalAbort = true;
    harness.abort();
  };
  if (options.abortSignal) {
    options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    runState.removeAbortHandler = () => options.abortSignal.removeEventListener?.("abort", abortHandler);
  }
  return harness;
}

/**
 * Start the live-input steering consumer. Consumes follow-up messages and steers
 * the harness mid-run; the consumer is tied to run completion (an internal
 * runComplete flag) so it stops steering once the run finishes and does not
 * swallow a follow-up meant for a later turn. Returns a `stop()` teardown.
 * @param {{harness: any, options: any, onEvent: (event: any) => void}} deps
 * @returns {{stop: () => Promise<void>}}
 */
export function startLiveInput({ harness, options, onEvent }) {
  if (!options.liveInput) return { stop: async () => {} };
  const iterator = typeof options.liveInput[Symbol.asyncIterator] === "function"
    ? options.liveInput[Symbol.asyncIterator]()
    : options.liveInput;
  let runComplete = false;
  /** @type {() => void} */
  let signalStop = () => {};
  const stopped = new Promise((resolve) => { signalStop = () => resolve(); });
  const task = (async () => {
    try {
      while (!runComplete && !options.abortSignal?.aborted) {
        const next = await Promise.race([
          iterator.next(),
          stopped.then(() => ({ done: true, value: undefined })),
        ]);
        if (next.done || runComplete || options.abortSignal?.aborted) break;
        try {
          await harness.steer(formatLiveInputGuidance(next.value.body, options.prompts));
          next.value.acknowledge?.();
        } catch (err) {
          next.value.reject?.(err);
          throw err;
        }
      }
    } catch (err) {
      onEvent({
        type: "runtime_warning",
        warning_kind: "live_input_failed",
        message: (/** @type {any} */ (err))?.message || String(err),
      });
    }
  })();
  return {
    // The run is done: stop the live-steering consumer so it cannot steer a
    // finished harness or swallow a follow-up meant for the next turn. We signal
    // completion, then best-effort return() the iterator. The explicit stop
    // race releases the task even when a third-party iterator's return() does
    // not unblock its pending next(); awaiting the task still closes any steer
    // acknowledgement already in progress.
    stop: async () => {
      runComplete = true;
      signalStop();
      if (iterator && typeof iterator.return === "function") {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* best-effort */ }
      }
      await task;
    },
  };
}

/**
 * Run a single prompt on the harness and wait for it to go idle. A stream error
 * surfaces on the harness (not a throw), so a thrown prompt is captured as
 * runError; waitForIdle always runs afterward.
 * @param {any} harness
 * @param {string} promptText
 * @param {Array<any>} promptImages
 * @returns {Promise<{runError: any}>}
 */
export async function runHarnessPrompt(harness, promptText, promptImages) {
  let runError = null;
  try {
    // Pass structured images (when present) so multimodal input reaches the
    // model as image blocks rather than stringified text. AgentHarness.prompt
    // takes them under an options object (`{ images }`); a bare array would be
    // read as `options` and silently dropped (options?.images === undefined).
    if (Array.isArray(promptImages) && promptImages.length > 0) {
      await harness.prompt(promptText, { images: promptImages });
    } else {
      await harness.prompt(promptText);
    }
  } catch (err) {
    runError = err;
  }
  await harness.waitForIdle();
  return { runError };
}
