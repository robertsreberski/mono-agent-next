import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import type { KnownProvider as PiBuiltinProvider } from "@earendil-works/pi-ai";
import {
  getBuiltinModels as getPiBuiltinModels,
  getBuiltinProviders as getPiBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { validateCronExpression } from "@mono-agent/cron-adapter";
import {
  classifyContinuationMcpServerTransport,
  isStdioMcpServerSpec,
  loadToolPolicyFromJsonFile,
} from "@mono-agent/agent-harness";
import {
  defaultExecutionModeForModel,
  describeMonoRuntimeSupport,
  isValidMcpServerName,
  modelReferenceKey,
  networkPolicyAllowsUrl,
  parseMonoRuntimeModelReference,
  resolveModelEffortLevels,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";
import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
  resolveSupermemoryContainer,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  describeSandboxEffectiveState,
  resolveSandboxEffectiveState,
  sandboxEffectiveStateWarning,
} from "@mono-agent/runtime-adapter";
import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
} from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { adapterSendToolNames, isAdapterSendToolAllowed, resolveAdapterSendToolsSettings } from "./adapter-send-tools.js";
import { canonicalToolName, isAllowAllTools, isKnownToolName, isMcpToolName, suggestToolName } from "./modules/known-tools.js";
import { collectChannelConfigViews } from "./channel-config-view.js";
import { resolveChannelDrivers } from "./channels.js";
import type { ChannelDriver } from "./channels.js";
import { loadContinuationSettings } from "./continuation-config.js";
import { applyOriginContextGroupCommit } from "./continuation-origin-store.js";
import { readBoundedOwnerOnlyFile } from "./continuation-store-fs.js";
import { loadLegacyStore, mergeMigrationRecords } from "./continuation-store-records.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
} from "./continuation-store.js";
import {
  applyRetention,
  isDurableGeneration,
  isOriginContextGroupCommit,
  isRecord,
  isRecordTransaction,
  isStoreFile,
  normalizeLegacyContinuationRecords,
  requiredDate,
  resolveRetention,
} from "./continuation-store-policy.js";
import {
  MAX_LEGACY_STORE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RECORD_BYTES,
  MAX_TRANSACTION_BYTES,
  type ContinuationRecordTransaction,
  type ContinuationRetentionOptions,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";
import { CONTINUATION_STATES, continuationDigest, type ContinuationState } from "./continuations.js";
import { formatInteractionBridgeUrl, loadInteractionSettings } from "./interaction-bridge.js";
import {
  FIRST_RUN_MEMORY_INITIALIZING_MARKER,
  FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX,
} from "./first-run-managed-memory.js";
import {
  DEFAULT_MEMORY_EMBEDDING_ENDPOINTS,
  probeMemoryEmbeddingSelection,
} from "./memory-embedding-service.js";
import { piAuthRecoveryCommand } from "./provider-setup.js";
import { inspectPiAuthStore, type PiAuthStoreInspection, type PiAuthStoreUnsafeReason } from "./pi-auth-store-inspection.js";
import { checkManagedProjectSkills, managedProjectSkillsExist } from "./project-skills.js";
import { configuredRuntimeFallbackModels, configuredRuntimeModels } from "./runtime-routes.js";
import { runtimeProvenanceDetail } from "./runtime-provenance.js";
import { loadSupermemoryPlugin } from "./supermemory-plugin.js";
import {
  DEFAULT_LAUNCHD_LOG_POLICY,
  inspectLaunchdLogs,
  LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS,
  launchdLogPathsForConfig,
} from "./launchd-logs.js";
import type { LaunchdLogInspection, LaunchdLogStreamInspection } from "./launchd-logs.js";
import { exporterSection, runsSection } from "./doctor-observability.js";
import type { ValidationReport, ValidationSection, ValidationStatus } from "./doctor-types.js";

export type { ValidationReport, ValidationSection, ValidationStatus } from "./doctor-types.js";

const execFile = promisify(execFileCallback);

const CONTINUATION_V2_ROLLBACK_GUARD = "UPGRADED-TO-RECORDS-V3";
const CONTINUATION_V2_ROLLBACK_GUARD_CONTENT =
  "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n";

export interface SdkAuthStatusExecOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
}

export interface SdkAuthStatusExecResult {
  readonly stdout: string;
}

/** Injectable process seam for bounded, read-only provider credential/login checks. */
export type SdkAuthStatusExecFile = (
  file: string,
  args: readonly string[],
  options: SdkAuthStatusExecOptions,
) => Promise<SdkAuthStatusExecResult>;

export interface ValidateMonoAgentFolderOptions extends MonoAgentAppConfigInput {
  readonly drivers?: readonly ChannelDriver[];
  /** Optional sandbox engine override for deterministic validation tests. */
  readonly sandboxEngine?: SandboxEngine;
  /**
   * When false, validation must not create directories or otherwise mutate the
   * target filesystem. This is used for downstream consumer validation from a
   * different working directory. Defaults to true.
   */
  readonly allowFilesystemWrites?: boolean;
  /**
   * When false, skip live probes (Ollama and Supermemory reachability, the
   * Phoenix export probe, and SDK external-login status checks) and validate
   * only structure/shape. Those probes can only ever downgrade a section to
   * `waiting`, never `error`, so skipping them leaves the pass/fail verdict
   * (`ok`) unchanged — the start preflight relies on this. Defaults to true.
   */
  readonly liveness?: boolean;
  /**
   * Internal readiness-probe mode. Direct Codex cannot enforce arbitrary tool
   * allowlists, but the disposable probe has a dedicated runtime contract that
   * runs read-only and fails on the first tool action.
   */
  readonly codexNoToolsProbe?: boolean;
  /** Model refs whose credentials were proven by a successful live turn. */
  readonly verifiedCredentialModelRefs?: readonly string[];
  /** Injectable subprocess seam for deterministic provider credential/login-status tests. */
  readonly sdkAuthStatusExecFile?: SdkAuthStatusExecFile;
  /** Managed workers resolve optional plugins only from their attested app closure. */
  readonly preferAppPluginInstall?: boolean;
  /**
   * Internal managed-worker fast path. The launch verifier has already bound
   * this informational detail to the exact private runtime marker, so doctor
   * must not repeat the full dependency-tree provenance traversal.
   */
  readonly verifiedRuntimeProvenanceDetail?: string;
}

/**
 * Loads every config section the app would use at start and reports it
 * per-section, so an engineer can see exactly what would run, wait, or fail —
 * before starting anything.
 */
export async function validateMonoAgentFolder(
  options: ValidateMonoAgentFolderOptions,
): Promise<ValidationReport> {
  const sections: ValidationSection[] = [];
  const drivers = options.drivers ?? await resolveChannelDrivers(options);
  const liveness = options.liveness ?? true;
  const allowFilesystemWrites = options.allowFilesystemWrites ?? true;

  let coreConfig: MonoAgentConfig | undefined;
  try {
    coreConfig = await loadAppCoreConfig(options);
    sections.push({ id: "core", label: "Core config", status: "ok", details: [`Loaded ${options.configPath}.`] });
  } catch (error) {
    if (!isAppCoreConfigError(error)) {
      throw error;
    }
    sections.push({ id: "core", label: "Core config", status: "error", details: [error.message] });
  }

  sections.push(await runtimeProvenanceSection(options.verifiedRuntimeProvenanceDetail));

  if (coreConfig !== undefined) {
    const staticTriggerCredentialRefs = await collectStaticTriggerCredentialRefs(drivers, options);
    const jsonResult = await readMonoAgentConfigJson(options.configPath);
    // Channel secrets (bot tokens, API keys) live outside the core view, so the
    // placement check spans both: core sections + every channel's config view.
    const configWarnings = [
      ...findJsonSecretConfigWarnings([
        ...buildMonoAgentConfigView({
          redacted: redactMonoAgentConfig(coreConfig),
          json: jsonResult.json,
          env: options.env,
        }),
        ...(await collectChannelConfigViews(drivers, options)),
      ]),
      ...findRemovedConfigWarnings({ json: jsonResult.json, env: options.env }),
    ];
    if (configWarnings.length > 0) {
      sections.push({ id: "secret-placement", label: "Config warnings", status: "waiting", details: configWarnings });
    }
    sections.push(runtimeSection(coreConfig));
    sections.push(await credentialsSection(
      coreConfig,
      options.env,
      options.cwd,
      liveness,
      options.verifiedCredentialModelRefs,
      options.sdkAuthStatusExecFile,
      staticTriggerCredentialRefs,
    ));
    sections.push(await contextSection(coreConfig, options.cwd));
    sections.push(await memorySection(
      coreConfig,
      options.cwd,
      options.env,
      liveness,
      allowFilesystemWrites,
      options.preferAppPluginInstall === true,
    ));
    sections.push(await toolsSection(coreConfig, options));
    sections.push(await continuationSection(coreConfig, options));
    sections.push(await sandboxSection(coreConfig, options.sandboxEngine));
  }

  sections.push(await exporterSection(options, liveness));
  sections.push(await runsSection(options, coreConfig));
  sections.push(await launchdLogsSection(options.configPath));

  for (const driver of drivers) {
    sections.push(await channelSection(driver, options));
  }

  if (coreConfig !== undefined) {
    await applyRequestModelOverrideCompatibilityChecks(sections, coreConfig, drivers, options);
  }

  // Cross-check the built `channel:*` statuses against the tool policy and annotate
  // the tools section (send-tool-allowed-but-channel-disabled, or channel-enabled-
  // but-no-send-tool). Only meaningful once coreConfig — and thus the tools section
  // and the tool policy — loaded.
  if (coreConfig !== undefined) {
    applyToolChannelCrossChecks(sections, coreConfig.tools.allowedTools, coreConfig.tools.disallowedTools);
  }

  const structurallyValid = sections.every((section) => section.status !== "error");
  const operationallyReady = structurallyValid && sections.every((section) => section.status !== "waiting");
  return {
    sections,
    structurallyValid,
    operationallyReady,
    ok: structurallyValid,
  };
}

/** Read-only launchd log inventory used by both `validate` and its `doctor` alias. */
export async function launchdLogsSection(configPath: string): Promise<ValidationSection> {
  let inspection: LaunchdLogInspection;
  try {
    const paths = await launchdLogPathsForConfig(configPath);
    inspection = await inspectLaunchdLogs(paths);
  } catch {
    return {
      id: "launchd-logs",
      label: "Launchd logs",
      status: "waiting",
      details: ["[WARN] Managed launchd log metadata could not be inspected safely."],
    };
  }

  return launchdLogsSectionFromInspection(inspection);
}

/** Pure renderer kept separate so exact byte accounting is deterministic in tests. */
export function launchdLogsSectionFromInspection(
  inspection: LaunchdLogInspection,
): ValidationSection {
  const policy = DEFAULT_LAUNCHD_LOG_POLICY;
  const details = [
    `Policy: ${policy.maxBytes} bytes per file, ${policy.rotationCount} retained generations, checked every ${LAUNCHD_LOG_MAINTENANCE_INTERVAL_SECONDS} seconds.`,
    streamSizeDetail("stdout", inspection.stdout),
    streamSizeDetail("stderr", inspection.stderr),
    ...inspection.issues.map((issue) => `[WARN] ${issue}.`),
    ...oversizedLogDetails("stdout", inspection.stdout, policy.maxBytes),
    ...oversizedLogDetails("stderr", inspection.stderr, policy.maxBytes),
  ];
  if (!inspection.present && inspection.issues.length === 0) {
    return {
      id: "launchd-logs",
      label: "Launchd logs",
      status: "disabled",
      details: [...details, "No managed launchd log files exist yet."],
    };
  }
  return {
    id: "launchd-logs",
    label: "Launchd logs",
    status: inspection.canMaintain && !inspection.needsMaintenance ? "ok" : "waiting",
    details,
  };
}

function streamSizeDetail(label: string, stream: LaunchdLogStreamInspection): string {
  if (!stream.byteAccountingComplete) {
    return `${label}: byte inventory unavailable because one or more paths could not be inspected safely.`;
  }
  return `${label}: active=${stream.activeBytes} bytes, retained=${stream.retainedBytes} bytes, total=${stream.totalBytes} bytes.`;
}

function oversizedLogDetails(
  label: string,
  stream: LaunchdLogStreamInspection,
  maxBytes: number,
): string[] {
  if (!stream.byteAccountingComplete) return [];
  return stream.files.flatMap((file) => file.bytes <= maxBytes
    ? []
    : [`[WARN] ${label}${file.generation === 0 ? "" : `.${file.generation}`} is ${file.bytes} bytes; maintenance limit is ${maxBytes} bytes.`]);
}

interface StaticTriggerConfigEntry {
  readonly entryPath: string;
  readonly entry: Record<string, unknown>;
}

/** Enabled, statically configured webhook/cron entries that can actually execute. */
function staticTriggerConfigEntries(
  driverId: "webhook" | "cron",
  loaded: unknown,
): readonly StaticTriggerConfigEntry[] {
  if (!isUnknownRecord(loaded)) return [];
  if (driverId === "webhook" && loaded.enabled === false) return [];
  const entries = driverId === "webhook" ? loaded.endpoints : loaded.jobs;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry, index) => {
    if (!isUnknownRecord(entry) || entry.enabled === false) return [];
    return [{
      entryPath: `${driverId}.${driverId === "webhook" ? "endpoints" : "jobs"}[${index}]`,
      entry,
    }];
  });
}

/**
 * Collect static trigger model overrides for credential readiness. Dynamic
 * webhook request-body overrides are intentionally unavailable at validate time.
 */
async function collectStaticTriggerCredentialRefs(
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<readonly { label: string; ref: RuntimeModelReference }[]> {
  const refs: { label: string; ref: RuntimeModelReference }[] = [];
  const seen = new Set<string>();
  for (const driver of drivers) {
    if (driver.id !== "webhook" && driver.id !== "cron") continue;
    let loaded: unknown;
    try {
      loaded = await driver.loadConfig(input);
    } catch {
      // The channel section owns malformed/unreadable config diagnostics.
      continue;
    }
    for (const { entryPath, entry } of staticTriggerConfigEntries(driver.id, loaded)) {
      if (typeof entry.model !== "string") continue;
      try {
        const ref = parseMonoRuntimeModelReference(entry.model);
        const key = `${entryPath}\u0000${modelReferenceKey(ref)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ label: entryPath, ref });
      } catch {
        // The channel section owns invalid model-reference syntax.
      }
    }
  }
  return refs;
}

async function applyRequestModelOverrideCompatibilityChecks(
  sections: ValidationSection[],
  config: MonoAgentConfig,
  drivers: readonly ChannelDriver[],
  input: MonoAgentAppConfigInput,
): Promise<void> {
  const baseIsDirectCodex = config.runtime.model.sdk === "codex";
  const routeSafety = config.runtime.routeSafety ?? "uniform";
  const directBoundaryConflicts: string[] = [];
  const sandboxBypasses: string[] = [];
  const toolPolicyBypasses: string[] = [];
  const effortBypasses: string[] = [];
  const turnCapBypasses: string[] = [];
  const mcpBypasses: string[] = [];
  const skillBypasses: string[] = [];
  const piModelResolutionFailures: string[] = [];
  const monoSandboxActive = config.sandbox !== undefined && config.sandbox.mode !== "off";
  const restrictiveToolPolicy = !hasExactAllowAllToolPolicy(config.tools);
  let configuredMcpServerNames: string[] = [];
  if (config.tools.mcpConfigPath !== undefined) {
    try {
      configuredMcpServerNames = Object.keys(
        (await loadToolPolicyFromJsonFile(config.tools.mcpConfigPath)).mcpServers ?? {},
      );
    } catch {
      // The tools section owns missing/malformed MCP-file diagnostics.
    }
  }
  let adapterToolNames: readonly string[] = [];
  try {
    const settings = await resolveAdapterSendToolsSettings(input, {
      allowedTools: config.tools.allowedTools,
      disallowedTools: config.tools.disallowedTools,
    });
    if (settings !== undefined) adapterToolNames = adapterSendToolNames(settings);
  } catch {
    // Channel/tools sections own adapter config diagnostics.
  }
  const effectiveMcpSources = effectiveMcpRuntimeSources(config, configuredMcpServerNames, adapterToolNames);
  for (const driver of drivers) {
    if (driver.id !== "webhook" && driver.id !== "cron") continue;
    let loaded: unknown;
    try {
      loaded = await driver.loadConfig(input);
    } catch {
      // The channel section already reports malformed/unreadable config.
      continue;
    }
    for (const { entryPath, entry } of staticTriggerConfigEntries(driver.id, loaded)) {
      const hasModelOverride = typeof entry.model === "string";
      const hasEffortOverride = typeof entry.effort === "string";
      if (!hasModelOverride && !hasEffortOverride) continue;
      try {
        const model = hasModelOverride
          ? parseMonoRuntimeModelReference(entry.model as string)
          : config.runtime.model;
        const location = hasModelOverride
          ? `${entryPath}.model=${entry.model as string}`
          : `${entryPath}.effort=${entry.effort as string}`;
        if (hasModelOverride) {
          const resolutionIssue = piModelResolutionIssue(config, model);
          if (resolutionIssue !== undefined) {
            piModelResolutionFailures.push(`${location}: ${resolutionIssue}.`);
          }
        }
        if (routeSafety === "uniform" && hasModelOverride && (model.sdk === "codex") !== baseIsDirectCodex) {
          directBoundaryConflicts.push(location);
        }
        if (routeSafety === "uniform" && hasModelOverride && monoSandboxActive && (model.sdk === "claude" || model.sdk === "opencode" || model.sdk === "codex")) {
          sandboxBypasses.push(location);
        }
        if (hasModelOverride && restrictiveToolPolicy && model.sdk === "opencode") {
          toolPolicyBypasses.push(location);
        }
        const effectiveEffort = hasEffortOverride ? entry.effort as string : config.runtime.effort;
        const legacyFallbacks = (config.runtime.fallbacks?.length ?? 0) > 0
          ? []
          : config.runtime.fallbackModels ?? [];
        const directOpenCodeModels = [model, ...legacyFallbacks]
          .filter((candidate) => candidate.sdk === "opencode");
        if (directOpenCodeModels.length > 0 && effectiveEffort !== undefined) {
          effortBypasses.push(
            `${location} (effective effort=${effectiveEffort}) (direct OpenCode route=${directOpenCodeModels.map(referenceOf).join(", ")})`,
          );
        }
        if (directOpenCodeModels.length > 0 && Number(config.runtime.maxTurns) > 0) {
          turnCapBypasses.push(
            `${location} (runtime.maxTurns=${config.runtime.maxTurns}; direct OpenCode route=${directOpenCodeModels.map(referenceOf).join(", ")})`,
          );
        }
        if (directOpenCodeModels.length > 0 && effectiveMcpSources.length > 0) {
          mcpBypasses.push(
            `${location} (direct OpenCode route=${directOpenCodeModels.map(referenceOf).join(", ")}; MCP sources=${effectiveMcpSources.join("; ")})`,
          );
        }
        if (
          directOpenCodeModels.length > 0
          && config.context.skillDisclosure === "index"
          && config.context.skillsRoot !== undefined
        ) {
          skillBypasses.push(location);
        }
      } catch {
        // Adapter configIssues owns syntax diagnostics.
      }
    }
  }
  if (
    directBoundaryConflicts.length === 0
    && sandboxBypasses.length === 0
    && toolPolicyBypasses.length === 0
    && effortBypasses.length === 0
    && turnCapBypasses.length === 0
    && mcpBypasses.length === 0
    && skillBypasses.length === 0
    && piModelResolutionFailures.length === 0
  ) return;
  const index = sections.findIndex((section) => section.id === "runtime");
  if (index < 0) return;
  const runtime = sections[index]!;
  sections[index] = {
    ...runtime,
    status: "error",
    details: [
      ...runtime.details,
      ...(directBoundaryConflicts.length === 0
        ? []
        : [
            "Uniform route safety cannot cross the direct-Codex runtime boundary because tool and sandbox contracts would change mid-agent. Choose per-route-native to opt into explicit route-local contracts.",
            ...directBoundaryConflicts,
          ]),
      ...(sandboxBypasses.length === 0
        ? []
        : [
            "Claude or direct OpenCode model overrides cannot run under uniform route safety while mono-agent SRT is active; direct Codex is also provider-owned. Choose per-route-native only after reviewing the explicit route-local contracts.",
            ...sandboxBypasses,
          ]),
      ...(toolPolicyBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode model overrides require exact allow-all because OpenCode's provider-owned tool loop does not consume mono-agent allowedTools/disallowedTools.",
            ...toolPolicyBypasses,
          ]),
      ...(effortBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot receive runtime effort because the OpenCode SDK does not expose effort control.",
            ...effortBypasses,
          ]),
      ...(turnCapBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot enforce runtime.maxTurns; omit it, set it to 0, or use a runtime with a hard turn cap.",
            ...turnCapBypasses,
          ]),
      ...(mcpBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot receive configured or auto-provisioned MCP runtime options.",
            ...mcpBypasses,
          ]),
      ...(skillBypasses.length === 0
        ? []
        : [
            "Per-trigger direct OpenCode routes cannot use index skill disclosure because the bridge disables external/runtime skills; use full disclosure or a Pi runtime.",
            ...skillBypasses,
          ]),
      ...(piModelResolutionFailures.length === 0
        ? []
        : [
            "Per-trigger Pi model overrides must resolve through providers.local or Pi's exact built-in catalog before execution.",
            ...piModelResolutionFailures,
          ]),
    ],
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactAllowAllToolPolicy(
  tools: Pick<MonoAgentConfig["tools"], "allowedTools" | "disallowedTools">,
): boolean {
  return tools.allowedTools.length === 1
    && tools.allowedTools[0] === "*"
    && tools.disallowedTools.length === 0;
}

/** Adapter send tools each channel owns; an allowed entry needs BOTH the tool AND the enabled channel. */
const CHANNEL_OWNED_SEND_TOOLS: Record<string, readonly string[]> = {
  slack: ["SlackSendMessage"],
  telegram: ["TelegramSendMessage", "TelegramSendFile"],
};

/**
 * Reconciles the already-built `channel:*` section statuses with the tool policy
 * and mutates the `tools` section in place:
 * - Direction A: an adapter send tool is allowed but its channel is DISABLED — the
 *   tool will never be exposed; append a note and downgrade tools to `waiting`
 *   (unless it is already `error`). This is a genuine misconfiguration.
 * - Direction B: a channel is ENABLED and not errored but no send tool is allowed —
 *   replies still work, so this is a HINT only (status unchanged). Skipped for a
 *   channel in `error` status, where "replies still work" would be misleading.
 *
 * Reads the sections built earlier (no channel re-loading). Guards for a missing
 * tools section (coreConfig failed to load), in which case there is nothing to annotate.
 */
function applyToolChannelCrossChecks(
  sections: ValidationSection[],
  allowedTools: readonly string[],
  disallowedTools: readonly string[],
): void {
  const toolsIndex = sections.findIndex((section) => section.id === "tools");
  if (toolsIndex < 0) {
    return;
  }
  const current = sections[toolsIndex]!;
  const extraDetails: string[] = [];
  let status: ValidationStatus = current.status;

  // Under allow-all (`"*"`) the wildcard "allows" every send tool incidentally, so
  // Direction A must NOT fire for a merely-disabled channel: the user opted into
  // everything, not that specific send tool, and an unused channel is not a
  // misconfiguration. Direction B is unaffected (with send tools allowed it never fires).
  const allowAll = isAllowAllTools(allowedTools);

  for (const [channel, sendTools] of Object.entries(CHANNEL_OWNED_SEND_TOOLS)) {
    const section = sections.find((candidate) => candidate.id === `channel:${channel}`);
    if (section === undefined) {
      continue; // Driver not present — nothing to cross-check.
    }
    const allowedForCh = sendTools.filter((tool) => isAdapterSendToolAllowed(tool, { allowedTools, disallowedTools }));
    if (section.status === "disabled") {
      // Direction A: send tool EXPLICITLY allowed but channel off — the tool will not be
      // exposed. Skipped under allow-all, where the wildcard allowance is incidental.
      if (!allowAll && allowedForCh.length > 0) {
        extraDetails.push(
          `${allowedForCh.join(", ")} in allowedTools, but the ${channel} channel is disabled — the tool will not be exposed.`,
        );
        if (status !== "error") {
          status = "waiting";
        }
      }
    } else if ((section.status === "ok" || section.status === "waiting") && allowedForCh.length === 0) {
      // Direction B: channel enabled AND not errored, but no send tool allowed — a
      // non-fatal hint. An errored channel has a structural problem, so appending
      // "replies still work…" onto it would be misleading; skip it there.
      extraDetails.push(
        `${channel} is enabled without ${sendTools.join("/")} in allowedTools — replies still work, ` +
          `but the agent cannot send proactively${channel === "telegram" ? " or ask blocking questions" : ""}.`,
      );
    }
  }

  if (extraDetails.length === 0 && status === current.status) {
    return;
  }
  sections[toolsIndex] = { ...current, status, details: [...current.details, ...extraDetails] };
}

async function runtimeProvenanceSection(verifiedDetail?: string): Promise<ValidationSection> {
  return {
    id: "runtime-provenance",
    label: "Runtime provenance",
    status: "ok",
    details: [verifiedDetail ?? await runtimeProvenanceDetail()],
  };
}

function runtimeSection(config: MonoAgentConfig): ValidationSection {
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const routes = configuredRuntimeRouteChecks(config);
  const routeSafety = config.runtime.routeSafety ?? "uniform";
  details.push(`Route safety: ${routeSafety}.`);
  if (routes.length > 1) {
    details.push(
      routeSafety === "per-route-native"
        ? "Mixed runtime families are allowed; every attempt uses its explicit route-native safety contract."
        : "Fallback routes use the uniform compatibility contract; validation fails closed when any route cannot represent a required capability.",
    );
  }
  const directOpenCodeModels = routes.filter((route) => route.model.sdk === "opencode");
  if (Number(config.runtime.maxTurns) > 0 && directOpenCodeModels.length > 0) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.map((route) => referenceOf(route.model)).join(", ")} cannot enforce runtime.maxTurns=${config.runtime.maxTurns}; omit it, set it to 0, or use a runtime with a hard turn cap.`,
    );
  }
  if (
    directOpenCodeModels.length > 0
    && config.context.skillDisclosure === "index"
    && config.context.skillsRoot !== undefined
  ) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.map((route) => referenceOf(route.model)).join(", ")} cannot use context.skillDisclosure=index because runtime skills are disabled; use full disclosure or a Pi runtime.`,
    );
  }
  for (const route of routes) {
    try {
      const support = describeMonoRuntimeSupport(route.model, route.executionMode);
      const resolutionIssue = piModelResolutionIssue(config, route.model);
      const effortIssue = runtimeRouteEffortIssue(config, route);
      if (support.compatible && resolutionIssue === undefined) {
        details.push(
          `${route.label} ${referenceOf(route.model)} runs on ${support.backend?.label ?? "unknown backend"} ` +
          `(effort: ${route.effort ?? "provider default"}).`,
        );
      } else {
        status = "error";
        details.push(`${route.label} ${referenceOf(route.model)}: ${resolutionIssue ?? support.incompatibilityReason ?? "unsupported"}.`);
      }
      if (effortIssue !== undefined) {
        status = "error";
        details.push(`${route.label} ${referenceOf(route.model)}: ${effortIssue}`);
      }
    } catch (error) {
      status = "error";
      details.push(`${route.label} ${referenceOf(route.model)}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  return { id: "runtime", label: "Runtime", status, details };
}

interface ConfiguredRuntimeRouteCheck {
  readonly label: string;
  readonly model: RuntimeModelReference;
  readonly effort?: string;
  readonly executionMode?: MonoAgentConfig["runtime"]["executionMode"];
}

function configuredRuntimeRouteChecks(config: MonoAgentConfig): readonly ConfiguredRuntimeRouteCheck[] {
  const primary: ConfiguredRuntimeRouteCheck = {
    label: "Primary model",
    model: config.runtime.model,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    executionMode: config.runtime.executionMode,
  };
  if ((config.runtime.fallbacks?.length ?? 0) > 0) {
    return [
      primary,
      ...(config.runtime.fallbacks ?? []).map((fallback) => ({
        label: "Fallback model",
        model: fallback.model,
        ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
      })),
    ];
  }
  return [
    primary,
    ...(config.runtime.fallbackModels ?? []).map((model) => ({
      label: "Fallback model",
      model,
      ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    })),
  ];
}

function runtimeRouteEffortIssue(
  config: MonoAgentConfig,
  route: ConfiguredRuntimeRouteCheck,
): string | undefined {
  if (route.effort === undefined) return undefined;
  if (route.model.sdk === "opencode") {
    return `Direct OpenCode model ${referenceOf(route.model)} cannot receive runtime.effort=${route.effort}; the OpenCode SDK exposes no reasoning-effort input. Omit the route effort.`;
  }
  const metadata = resolveModelEffortLevels(route.model, config.providers?.local);
  if (metadata.effortLevels !== undefined && !metadata.effortLevels.includes(route.effort)) {
    return `effort=${route.effort} is unsupported by known model metadata; choose ${metadata.effortLevels.join(", ")}, or omit it for provider default.`;
  }
  if (metadata.reasoning === false && route.effort !== "none") {
    return `effort=${route.effort} is unsupported because known model metadata marks this route as non-reasoning; use none or provider default.`;
  }
  if (
    route.model.sdk === "claude"
    && (route.executionMode ?? defaultExecutionModeForModel(route.model)) === "sdk"
    && !["low", "medium", "high", "xhigh", "max"].includes(route.effort)
  ) {
    return `effort=${route.effort} is unsupported by the Claude Agent SDK; choose low, medium, high, xhigh, max, or provider default.`;
  }
  return undefined;
}

/**
 * Mirrors the Pi runtime's actual model-resolution boundary. Mono-agent only
 * registers a custom Pi provider from `providers.local`; it deliberately does
 * not import Pi CLI's ambient sibling `models.json`. Without a matching local
 * provider, `resolvePiRuntimeModel` performs an exact built-in catalog lookup.
 */
function piModelResolutionIssue(
  config: MonoAgentConfig,
  model: RuntimeModelReference,
): string | undefined {
  if (model.sdk !== "pi" || model.provider === undefined) {
    return undefined;
  }

  const localProvider = config.providers?.local?.find((provider) => provider.id === model.provider);
  if (localProvider !== undefined) {
    if (localProvider.enabled === false) {
      return `provider \`${model.provider}\` is disabled in providers.local`;
    }
    const localModel = localProvider.models?.find(
      (candidate) => candidate.name === model.model || candidate.alias === model.model,
    );
    if (localModel?.enabled === false) {
      return `model \`${model.model}\` is disabled in providers.local for provider \`${model.provider}\``;
    }
    return undefined;
  }

  if (
    isPiBuiltinProvider(model.provider)
    && getPiBuiltinModels(model.provider).some((candidate) => candidate.id === model.model)
  ) {
    return undefined;
  }

  return (
    `pi model not found: ${model.provider}:${model.model}; no matching providers.local entry exists and Pi's built-in catalog has no exact model. ` +
    "The sibling Pi CLI models.json is not a mono-agent runtime source; add providers.local for a self-hosted provider or choose a built-in Pi model"
  );
}

function isPiBuiltinProvider(provider: string): provider is PiBuiltinProvider {
  return (getPiBuiltinProviders() as readonly string[]).includes(provider);
}

interface PiAuthEntry {
  readonly type?: string;
  readonly key?: string;
  readonly access?: string;
  readonly expires?: number;
  readonly refresh?: string;
}

const PI_API_KEY_ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};

/** Inspects Pi credentials without following aliases or reading unbounded input. */
async function readPiAuthProviders(path: string): Promise<
  | { readonly status: "ok"; readonly providers: Readonly<Record<string, PiAuthEntry>> }
  | Exclude<PiAuthStoreInspection, { readonly status: "ok" }>
> {
  const inspection = await inspectPiAuthStore(path);
  if (inspection.status !== "ok") return inspection;
  return { status: "ok", providers: inspection.auth as Readonly<Record<string, PiAuthEntry>> };
}

/**
 * Static env-credential contract for an SDK-authenticated backend (claude/codex).
 * `envKeys` are the environment variables the backend accepts, in preference
 * order; `loginDetail` names the interactive OAuth path that lives OUTSIDE the
 * environment (Claude subscription / ChatGPT sign-in) and therefore CANNOT be
 * verified by a static env check; `failureHint` is what a fresh user actually
 * sees when neither is present (the opaque E1 failure).
 */
type SdkAuthName = "claude" | "codex";

interface SdkAuthScheme {
  readonly envKeys: readonly string[];
  readonly loginCommand: string;
  readonly loginDetail: string;
  readonly failureHint: string;
  readonly statusCommand: string;
  readonly statusArgs: readonly string[];
}

/**
 * What each SDK-authenticated backend truthfully reads for credentials. Only the
 * env vars are statically checkable; the login paths are recorded so the warning
 * can stay honest (a logged-in user is fine and we must not claim otherwise).
 *
 * - claude (`claude:*`, sdk + cli): the Claude Code process authenticates from
 *   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` in
 *   the env, OR from a `claude /login` subscription session stored outside the
 *   environment (macOS Keychain / `~/.claude`), OR from a Bedrock/Vertex
 *   configuration (`CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX` + cloud
 *   credentials) — none of which the env-key check can see, hence the hedge in
 *   the warning. Its own error string is verbatim: "Claude Code authentication
 *   failed. Run `claude /login` or configure ANTHROPIC_API_KEY,
 *   ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN."
 * - codex (`codex:*`, cli): the Codex app-server authenticates from
 *   `OPENAI_API_KEY` in the env, OR from a `codex login` ChatGPT session stored
 *   in `~/.codex/auth.json` — also outside the environment.
 */
const SDK_AUTH_SCHEMES: Record<SdkAuthName, SdkAuthScheme> = {
  claude: {
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    loginCommand: "claude /login",
    loginDetail:
      "a `claude /login` subscription session or a Bedrock/Vertex configuration (CLAUDE_CODE_USE_BEDROCK/VERTEX)",
    failureHint: 'the first turn fails with an opaque "Claude Code process exited with code 1" that names nothing',
    statusCommand: "claude auth status --json",
    statusArgs: ["auth", "status", "--json"],
  },
  codex: {
    envKeys: ["OPENAI_API_KEY"],
    loginCommand: "codex login",
    loginDetail: "a `codex login` ChatGPT session (`~/.codex/auth.json`, outside the environment)",
    failureHint: "the first turn fails to authenticate",
    statusCommand: "codex login status",
    statusArgs: ["login", "status"],
  },
};

const SDK_AUTH_STATUS_TIMEOUT_MS = 5_000;
const SDK_AUTH_STATUS_MAX_BUFFER_BYTES = 64 * 1024;

function isSdkAuthName(value: string): value is SdkAuthName {
  return value === "claude" || value === "codex";
}

const defaultSdkAuthStatusExecFile: SdkAuthStatusExecFile = async (file, args, options) => {
  const { stdout } = await execFile(file, [...args], options);
  return { stdout };
};

/**
 * Performs the SDK's local, read-only login-status command. A zero Codex exit
 * confirms its external login; Claude additionally requires strict JSON with
 * `loggedIn: true`. Missing binaries, timeouts, non-zero exits, and malformed
 * output all fail closed without leaking command output into validation.
 */
async function checkSdkExternalLoginStatus(
  sdk: SdkAuthName,
  env: Record<string, string | undefined>,
  cwd: string,
  run: SdkAuthStatusExecFile,
): Promise<boolean> {
  const scheme = SDK_AUTH_SCHEMES[sdk];
  try {
    const { stdout } = await run(sdk, scheme.statusArgs, {
      cwd,
      env,
      timeout: SDK_AUTH_STATUS_TIMEOUT_MS,
      maxBuffer: SDK_AUTH_STATUS_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    if (sdk === "codex") {
      return true;
    }
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && (parsed as { readonly loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

type OpenCodeCredentialInspection =
  | { readonly status: "ok"; readonly providers: ReadonlySet<string> }
  | { readonly status: "migration_required" | "auth_missing" | "auth_invalid" | "inline_auth_unsupported" };

/** Read provider IDs directly from auth.json without launching mutation-capable OpenCode middleware. */
async function inspectOpenCodeCredentialProviders(
  env: Record<string, string | undefined>,
): Promise<OpenCodeCredentialInspection> {
  if (env.OPENCODE_AUTH_CONTENT !== undefined) {
    return { status: "inline_auth_unsupported" };
  }
  const dataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : join(typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir(), ".local", "share");
  const opencodeData = join(dataHome, "opencode");
  const marker = await regularCurrentUserFile(join(opencodeData, "opencode.db"));
  if (!marker) return { status: "migration_required" };
  const authPath = join(opencodeData, "auth.json");
  if (!(await regularCurrentUserFile(authPath))) return { status: "auth_missing" };
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
    if (!isUnknownRecord(parsed)) return { status: "auth_invalid" };
    const providers = new Set<string>();
    for (const [provider, credential] of Object.entries(parsed)) {
      if (provider.length === 0 || provider.trim() !== provider || !isOpenCodeCredentialEntry(credential)) {
        return { status: "auth_invalid" };
      }
      providers.add(provider);
    }
    return { status: "ok", providers };
  } catch {
    return { status: "auth_invalid" };
  }
}

async function regularCurrentUserFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid());
  } catch {
    return false;
  }
}

function isOpenCodeCredentialEntry(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  if (value.type === "oauth") {
    return typeof value.refresh === "string"
      && typeof value.access === "string"
      && (value.refresh.trim().length > 0 || value.access.trim().length > 0)
      && typeof value.expires === "number"
      && Number.isSafeInteger(value.expires)
      && value.expires >= 0
      && (value.accountId === undefined || typeof value.accountId === "string")
      && (value.enterpriseUrl === undefined || typeof value.enterpriseUrl === "string");
  }
  if (value.type === "api") {
    return typeof value.key === "string"
      && value.key.trim().length > 0
      && (value.metadata === undefined
        || (isUnknownRecord(value.metadata) && Object.values(value.metadata).every((entry) => typeof entry === "string")));
  }
  if (value.type === "wellknown") {
    return typeof value.key === "string" && value.key.trim().length > 0
      && typeof value.token === "string" && value.token.trim().length > 0;
  }
  return false;
}

async function checkOpenCodeVersion(
  env: Record<string, string | undefined>,
  cwd: string,
  run: SdkAuthStatusExecFile,
): Promise<boolean> {
  const versionEnv: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) versionEnv[key] = value;
  }
  try {
    const { stdout } = await run("opencode", ["--version"], {
      cwd,
      env: versionEnv,
      timeout: SDK_AUTH_STATUS_TIMEOUT_MS,
      maxBuffer: SDK_AUTH_STATUS_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(stdout.trim());
    if (match === null) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    return Number.isSafeInteger(major)
      && Number.isSafeInteger(minor)
      && Number.isSafeInteger(patch)
      && (major > 1 || (major === 1 && minor >= 15));
  } catch {
    return false;
  }
}

/** First env key whose value is present and non-blank, or undefined when none are set. */
function firstPresentEnvKey(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return key;
    }
  }
  return undefined;
}

/**
 * Checks that every referenced model (primary, fallbacks, and the agent-host memory LLM)
 * has discoverable credentials, so a keyless or expired-OAuth provider is caught at
 * `validate` time instead of degrading crons/memory silently at runtime (the failure mode
 * that broke memory capture for ~10 days: the auth store's OAuth token had quietly expired,
 * and the E1 fresh-instance case where `claude:*` with no `ANTHROPIC_API_KEY` "validates"
 * clean but the first turn dies with an opaque "process exited with code 1").
 *
 * The check is read-only. Static validation never launches a process; live validation may
 * run bounded, local SDK login-status commands, which inspect durable external login state
 * without making a model turn or mutating the auth store.
 *
 * - Pi providers: inspect the auth store (`piAuthPath`) and the config's own
 *   `providers.local` custom providers. A custom/local provider follows its declared
 *   `apiKey` / `apiKeyEnv` contract instead of Pi OAuth; an OAuth provider absent from
 *   the store, or whose access token has expired, is flagged `waiting` with a re-auth hint.
 * - SDK-authenticated providers (`claude:*` / `codex:*`): inspect the RESOLVED ENV (process
 *   env + loaded `.env`) for the backend's accepted keys. During live validation only, a
 *   missing env credential falls back to `claude auth status --json` / `codex login status`.
 *   The commands use the same resolved environment (including PATH and HOME), are bounded,
 *   cached once per SDK, and never make a model turn. Static validation remains process-free.
 * - Direct OpenCode (`opencode:<provider>:<model>`): inspect exact provider IDs in the
 *   standard auth.json and require the native DB migration marker. Static validation launches
 *   no process. Live validation runs only a bounded `opencode --version` preflight; it never
 *   runs the mutation-capable auth middleware or makes a model turn.
 *
 * `waiting` (never `error`) keeps the verdict non-fatal, mirroring the Ollama/Phoenix
 * probes — the goal is visibility, not blocking start.
 */
async function credentialsSection(
  config: MonoAgentConfig,
  env: Record<string, string | undefined>,
  cwd: string,
  liveness: boolean,
  verifiedCredentialModelRefs: readonly string[] = [],
  sdkAuthStatusExecFile: SdkAuthStatusExecFile = defaultSdkAuthStatusExecFile,
  staticTriggerRefs: readonly { label: string; ref: RuntimeModelReference }[] = [],
): Promise<ValidationSection> {
  const refs: { label: string; ref: RuntimeModelReference }[] = [
    { label: "Primary", ref: config.runtime.model },
    ...configuredRuntimeRouteChecks(config).slice(1).map((route) => ({
      label: "Fallback",
      ref: route.model,
    })),
    ...staticTriggerRefs,
  ];
  if (config.memory?.llm !== undefined && config.memory.llm.provider !== "ollama") {
    try {
      refs.push({ label: "Memory LLM", ref: parseMonoRuntimeModelReference(config.memory.llm.model) });
    } catch {
      // A malformed memory model reference is surfaced by the memory/runtime shape checks.
    }
  }

  const authenticatedRefs = refs.filter((r) =>
    (r.ref.sdk === "pi" && typeof r.ref.provider === "string")
    || (r.ref.sdk === "opencode" && typeof r.ref.provider === "string")
    || isSdkAuthName(r.ref.sdk),
  );
  if (authenticatedRefs.length === 0) {
    return {
      id: "credentials",
      label: "Provider credentials",
      status: "disabled",
      details: ["No provider-authenticated models referenced."],
    };
  }

  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const verified = new Set(verifiedCredentialModelRefs);
  for (const { label, ref } of authenticatedRefs) {
    const refStr = referenceOf(ref);
    if (verified.has(refStr)) {
      details.push(`${label} ${refStr}: credentials verified by a successful live model check.`);
    }
  }
  const unverifiedRefs = authenticatedRefs.filter(({ ref }) => !verified.has(referenceOf(ref)));
  const piRefs = unverifiedRefs.filter((r) => r.ref.sdk === "pi" && typeof r.ref.provider === "string");
  const openCodeRefs = unverifiedRefs.filter((r) => r.ref.sdk === "opencode" && typeof r.ref.provider === "string");
  const sdkRefs = unverifiedRefs.filter(
    (r): r is { label: string; ref: RuntimeModelReference & { sdk: SdkAuthName } } => isSdkAuthName(r.ref.sdk),
  );

  if (piRefs.length > 0) {
    const piStatus = await appendPiCredentialDetails(config, piRefs, details, env);
    if (piStatus === "waiting") {
      status = "waiting";
    }
  }

  const openCodeInspection = openCodeRefs.length > 0
    ? inspectOpenCodeCredentialProviders(env)
    : undefined;
  const openCodeVersion = liveness && openCodeRefs.length > 0
    ? checkOpenCodeVersion(env, cwd, sdkAuthStatusExecFile)
    : undefined;

  const sdkAuthStatuses = new Map<SdkAuthName, Promise<boolean>>();
  const externalLoginStatus = (sdk: SdkAuthName): Promise<boolean> => {
    const cached = sdkAuthStatuses.get(sdk);
    if (cached !== undefined) {
      return cached;
    }
    const pending = checkSdkExternalLoginStatus(sdk, env, cwd, sdkAuthStatusExecFile);
    sdkAuthStatuses.set(sdk, pending);
    return pending;
  };

  // Start each unique local status check before awaiting details so two SDKs
  // cost one bounded timeout window rather than running serially.
  if (liveness) {
    for (const { ref } of sdkRefs) {
      const scheme = SDK_AUTH_SCHEMES[ref.sdk];
      if (scheme !== undefined && firstPresentEnvKey(env, scheme.envKeys) === undefined) {
        void externalLoginStatus(ref.sdk);
      }
    }
  }

  for (const { label, ref } of sdkRefs) {
    const refStr = referenceOf(ref);
    const scheme = SDK_AUTH_SCHEMES[ref.sdk];
    if (scheme === undefined) {
      continue;
    }
    const present = firstPresentEnvKey(env, scheme.envKeys);
    if (present !== undefined) {
      details.push(`${label} ${refStr}: SDK credential present in the resolved env (${present}); credential detected, live model verification is still pending.`);
      continue;
    }
    if (liveness && await externalLoginStatus(ref.sdk)) {
      details.push(
        `${label} ${refStr}: external sign-in detected by read-only \`${scheme.statusCommand}\`; ` +
          "credentials are not verified until a live model turn succeeds.",
      );
      continue;
    }
    status = "waiting";
    details.push(
      `[WARN] ${label} ${refStr}: no SDK credential in the resolved env (checked ${scheme.envKeys.join(", ")}). ` +
        (liveness
          ? `External login was not verified by \`${scheme.statusCommand}\`; `
          : `If you authenticated via ${scheme.loginDetail} this is fine and can't be verified during static validation; `) +
        `otherwise ${scheme.failureHint} — set ${scheme.envKeys[0]} or run \`${scheme.loginCommand}\`.`,
    );
  }


  if (openCodeRefs.length > 0) {
    const inspection = openCodeInspection === undefined ? undefined : await openCodeInspection;
    const supportedVersion = openCodeVersion === undefined ? false : await openCodeVersion;
    for (const { label, ref } of openCodeRefs) {
      const refStr = referenceOf(ref);
      const provider = ref.provider as string;
      const credentialPresent = inspection?.status === "ok" && inspection.providers.has(provider);
      if (credentialPresent && liveness && supportedVersion) {
        details.push(
          `${label} ${refStr}: provider \`${provider}\` credential present in the standard OpenCode auth store; stable OpenCode CLI >=1.15.0 detected without a model turn. Credential detected; live model verification is still pending.`,
        );
      } else {
        status = "waiting";
        const warning = inspection?.status === "migration_required"
          ? "the native OpenCode database migration marker is missing or invalid; run `opencode db migrate --pure` once"
          : inspection?.status === "inline_auth_unsupported"
            ? "OPENCODE_AUTH_CONTENT is unsupported for direct runs; persist credentials with `opencode auth login` and unset it"
            : inspection?.status === "auth_invalid"
              ? "the standard OpenCode auth.json is malformed or contains an unsupported credential entry"
              : credentialPresent && !liveness
                ? "credentials and migration marker are present, but the required stable OpenCode CLI >=1.15.0 is unverified during static validation"
                : credentialPresent && !supportedVersion
                  ? "credentials are present, but stable OpenCode CLI >=1.15.0 could not be verified"
              : inspection?.status === "ok"
                ? `no exact credential entry exists for provider \`${provider}\`; run \`opencode auth login\` for that provider`
                : "the standard OpenCode auth.json is missing; run `opencode auth login`";
        const safetyNote = liveness
          ? "No model turn or mutation-capable OpenCode command was run."
          : "No OpenCode process was launched.";
        details.push(`[WARN] ${label} ${refStr}: ${warning}. ${safetyNote}`);
      }
    }
  }

  return { id: "credentials", label: "Provider credentials", status, details };
}

/**
 * Appends one detail line per Pi provider reference and returns "waiting" if any
 * was flagged (missing/expired), else "ok". Recognizes custom providers only
 * through the config's `providers.local` set, matching the runtime boundary.
 */
async function appendPiCredentialDetails(
  config: MonoAgentConfig,
  piRefs: readonly { label: string; ref: RuntimeModelReference }[],
  details: string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ValidationStatus> {
  const authPath = config.providers?.piAuthPath;
  const authInspection = authPath === undefined ? undefined : await readPiAuthProviders(authPath);
  const authProviders = authInspection?.status === "ok" ? authInspection.providers : undefined;
  // A matching `providers.local` entry owns the runtime route, even when its ID
  // collides with a Pi built-in provider. Report the local entry's declared auth
  // contract instead of consulting the unrelated Pi auth store. A disabled entry
  // remains authoritative because the runtime rejects it before credential use.
  const localProviders = new Map(
    (config.providers?.local ?? []).map((provider) => [provider.id, provider] as const),
  );
  const now = Date.now();
  let status: ValidationStatus = "ok";
  if (authPath !== undefined) {
    details.push(`Pi auth store: ${authPath}`);
  }

  for (const { label, ref } of piRefs) {
    const provider = ref.provider as string;
    const refStr = referenceOf(ref);
    const loginCommand = piAuthRecoveryCommand(provider, authPath);
    const localProvider = localProviders.get(provider);
    if (localProvider !== undefined) {
      if (localProvider.enabled === false) {
        status = "waiting";
        details.push(
          `[WARN] ${label} ${refStr}: provider \`${provider}\` is configured in providers.local but disabled (\`enabled: false\`); the runtime will throw \`provider disabled: ${provider}\` on the first turn. Set \`enabled: true\` on that providers.local entry.`,
        );
      } else if (localProvider.apiKey !== undefined) {
        details.push(
          `${label} ${refStr}: provider \`${provider}\` configured via config providers.local (API key configured); credential detected, live model verification is still pending.`,
        );
      } else if (localProvider.apiKeyEnv !== undefined) {
        if (hasNonEmptyCredentialValue(env[localProvider.apiKeyEnv])) {
          details.push(
            `${label} ${refStr}: provider \`${provider}\` configured via config providers.local with ${localProvider.apiKeyEnv} present in the resolved environment; credential detected, live model verification is still pending.`,
          );
        } else {
          status = "waiting";
          details.push(
            `[WARN] ${label} ${refStr}: provider \`${provider}\` declares apiKeyEnv \`${localProvider.apiKeyEnv}\`, but the resolved environment has no non-empty value and no inline apiKey fallback. Set ${localProvider.apiKeyEnv} before starting.`,
          );
        }
      } else {
        details.push(
          `${label} ${refStr}: provider \`${provider}\` configured via config providers.local (keyless local provider; no API key declared).`,
        );
      }
      continue;
    }
    const apiKeyEnv = PI_API_KEY_ENV_BY_PROVIDER[provider];
    if (apiKeyEnv !== undefined && hasNonEmptyCredentialValue(env[apiKeyEnv])) {
      details.push(
        `${label} ${refStr}: Pi API-key credential for \`${provider}\` present in the resolved environment (${apiKeyEnv}); credential detected, live model verification is still pending.`,
      );
      continue;
    }
    if (authInspection?.status === "unsafe") {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: Pi auth store was not trusted because ${describePiAuthStoreUnsafeReason(authInspection.reason)}. ` +
          `Move the unsafe entry aside if needed, then run \`${loginCommand}\` to create or atomically harden a current-user 0600 store. ` +
          "A current-user, non-writable legacy store can be replaced during this explicit repair, but is intentionally never trusted for credential detection. " +
          "No credential values or file contents were displayed.",
      );
      continue;
    }
    const entry = authProviders?.[provider];
    if (entry === undefined) {
      status = "waiting";
      details.push(apiKeyEnv === undefined
        ? `[WARN] ${label} ${refStr}: no Pi credentials found for provider \`${provider}\` in the auth store. Authenticate it with \`${loginCommand}\`, or set providers.piAuthPath.`
        : `[WARN] ${label} ${refStr}: no Pi API key credentials found for provider \`${provider}\` in the auth store or resolved environment. Run \`${loginCommand}\`, or set ${apiKeyEnv}.`);
      continue;
    }
    const isOAuth = entry.type === "oauth";
    const isApiKey = entry.type === "api_key";
    if (isApiKey && !hasNonEmptyCredentialValue(entry.key)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored API-key credential for \`${provider}\` has no usable key. Run \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (isOAuth && !hasNonEmptyCredentialValue(entry.access) && !hasNonEmptyCredentialValue(entry.refresh)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored OAuth credential for \`${provider}\` has no usable access or refresh token. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (!isOAuth && !isApiKey) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored credential for \`${provider}\` has an unsupported or missing type. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    const expired = typeof entry.expires === "number" && entry.expires < now;
    const whenNote = typeof entry.expires === "number" ? ` ${new Date(entry.expires).toISOString()}` : "";
    if (isOAuth && expired) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: OAuth token for \`${provider}\` expired${whenNote} — the runtime may auto-refresh, but this credential is not ready until a request succeeds; if runs fail with "No API key for provider: ${provider}" re-authenticate with \`${loginCommand}\`.`,
      );
      continue;
    }
    details.push(
      isOAuth
        ? `${label} ${refStr}: OAuth credentials for \`${provider}\` present (token valid${whenNote}); credential detected, live model verification is still pending.`
        : `${label} ${refStr}: API key credentials for \`${provider}\` present; credential detected, live model verification is still pending.`,
    );
  }

  return status;
}

function describePiAuthStoreUnsafeReason(reason: PiAuthStoreUnsafeReason): string {
  switch (reason) {
    case "owner-check-unavailable": return "the current file owner could not be verified";
    case "symbolic-link": return "the configured entry is a symbolic link";
    case "not-regular-file": return "the configured entry is not a regular file";
    case "multiple-hard-links": return "the file has multiple hard links";
    case "oversized": return "the file exceeds the 1 MiB inspection limit";
    case "foreign-owner": return "the file is not owned by the current user";
    case "not-owner-only": return "its permissions are not owner-only";
    case "changed-during-read": return "its identity or metadata changed during inspection";
    case "malformed-json": return "it is not a valid JSON object";
    case "unreadable": return "it could not be opened and inspected safely";
  }
}

function hasNonEmptyCredentialValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 65_536 && !value.includes("\0");
}

async function contextSection(config: MonoAgentConfig, cwd: string): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  if (await pathExists(config.context.identityPath)) {
    details.push(`Identity: ${config.context.identityPath}`);
  } else {
    status = "error";
    details.push(`Identity file is missing: ${config.context.identityPath}`);
  }

  if (config.context.soulPath !== undefined && !(await pathExists(config.context.soulPath))) {
    status = "error";
    details.push(`Soul file is missing: ${config.context.soulPath}`);
  }

  if (config.context.skillsRoot !== undefined) {
    if (await pathExists(config.context.skillsRoot)) {
      details.push(`Skills root: ${config.context.skillsRoot}`);
      for (const skill of config.context.selectedSkills) {
        const skillPath = join(config.context.skillsRoot, skill, "SKILL.md");
        if (await pathExists(skillPath)) {
          details.push(`Skill \`${skill}\`: ${skillPath}`);
        } else {
          status = "error";
          details.push(`Skill \`${skill}\` is selected but ${skillPath} is missing.`);
        }
      }
    } else {
      status = "error";
      details.push(`Skills root is missing: ${config.context.skillsRoot}`);
    }
  } else if (config.context.selectedSkills.length > 0) {
    status = "error";
    details.push("Skills are selected but context.skillsRoot is not set.");
  }

  if (await managedProjectSkillsExist(cwd)) {
    const managed = await checkManagedProjectSkills(cwd);
    const drift = managed.statuses.filter((entry) => entry.status !== "ready");
    if (drift.length === 0) {
      details.push(`Managed project skills: current (${managed.manifestVersion ?? "unknown version"}).`);
    } else {
      if (status === "ok") status = "waiting";
      details.push(
        `Managed project skill drift: ${drift.map((entry) => `${entry.name}=${entry.status}`).join(", ")}. ` +
        "Run `mono-agent install-skill --project --check`; use --update only after reconciling modified copies.",
      );
    }
  }

  return { id: "context", label: "Context & skills", status, details };
}

const DEFAULT_CONSOLIDATION_CRON = "0 */2 * * *";

function memoryConsolidationCronIssue(expression: string): string | undefined {
  const result = validateCronExpression(expression, { timezone: "UTC" });
  if (result.ok) {
    return undefined;
  }
  if (result.code === "required") {
    return "memory.consolidation.cron is required when consolidation is enabled.";
  }
  if (result.code === "field_count") {
    return `memory.consolidation.cron must use exactly five fields; received ${result.fieldCount}.`;
  }
  return `memory.consolidation.cron is invalid: ${result.reason}`;
}

async function memorySection(
  config: MonoAgentConfig,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  liveness: boolean,
  allowFilesystemWrites: boolean,
  preferAppPluginInstall: boolean,
): Promise<ValidationSection> {
  if (config.memory === undefined) {
    return { id: "memory", label: "Memory", status: "disabled", details: ["No memory configured."] };
  }
  // External backend (e.g. supermemory): mode/embeddings/llm are bujo-only and
  // ignored, so validate the plugin-owned shape before any soft liveness probe.
  if ((config.memory.backend ?? "bujo") === "supermemory") {
    const sm = config.memory.supermemory;
    if (sm === undefined) {
      return {
        id: "memory",
        label: "Memory",
        status: "error",
        details: ["[ERROR] backend 'supermemory' requires a memory.supermemory block."],
      };
    }
    try {
      const plugin = await loadSupermemoryPlugin({ cwd, preferAppInstall: preferAppPluginInstall });
      const validation = plugin.validateSupermemoryConfig({
        baseUrl: sm.baseUrl,
        container: resolveSupermemoryContainer(config),
        ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
        ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
        ...(config.memory.maxBytes === undefined ? {} : { maxBytes: config.memory.maxBytes }),
      });
      if (!validation.valid) {
        return {
          id: "memory",
          label: "Memory",
          status: "error",
          details: validation.errors.map((detail) => `[ERROR] ${detail}`),
        };
      }
    } catch (error) {
      return {
        id: "memory",
        label: "Memory",
        status: "error",
        details: [`[ERROR] ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    const details = [
      `Backend: supermemory, writeMode: ${config.memory.writeMode}.`,
      `Endpoint: ${sm.baseUrl} (container "${resolveSupermemoryContainer(config)}").`,
      sm.apiKey === undefined
        ? "Auth: no API key configured (keyless — works only if the instance allows it)."
        : "Auth: API key configured.",
    ];
    if (!liveness) {
      details.push("Supermemory liveness probe skipped; ingestion is async.");
      return { id: "memory", label: "Memory", status: "ok", details };
    }

    const probe = await probeSupermemoryEndpoint(sm.baseUrl);
    if (!probe.reachable) {
      details.push(
        `[WARN] Supermemory is not reachable at ${sm.baseUrl} (${probe.reason}). ` +
        "Start Supermemory or fix memory.supermemory.baseUrl, then re-run `mono-agent validate`; " +
        "capture and recall will degrade until it is reachable.",
      );
      return { id: "memory", label: "Memory", status: "waiting", details };
    }

    details.push(
      `Supermemory transport reachable at ${sm.baseUrl} (HTTP ${probe.status}); ingestion is async.`,
    );
    return { id: "memory", label: "Memory", status: "ok", details };
  }
  const details: string[] = [
    `Mode: ${config.memory.mode}, path: ${config.memory.path}, writeMode: ${config.memory.writeMode}.`,
  ];
  let status: ValidationStatus = "ok";
  if (config.memory.llm !== undefined) {
    details.push(`Chat LLM: ${memoryLlmLabel(config.memory.llm)}.`);
    if (config.memory.llm.provider === "agent-host") {
      try {
        const model = parseMonoRuntimeModelReference(config.memory.llm.model);
        const resolutionIssue = piModelResolutionIssue(config, model);
        if (resolutionIssue !== undefined) {
          status = "error";
          details.push(`Agent-host memory LLM ${referenceOf(model)}: ${resolutionIssue}.`);
        }
      } catch (error) {
        status = "error";
        details.push(
          `Agent-host memory LLM ${config.memory.llm.model}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
  }

  if (config.memory.mode === "bujo") {
    // Report consolidation scheduler cadence.
    const consolidationEnabled = config.memory.consolidation?.enabled !== false;
    const consolidationCron = config.memory.consolidation?.cron ?? DEFAULT_CONSOLIDATION_CRON;
    if (consolidationEnabled) {
      details.push(`Consolidation: ${consolidationCron} (auto).`);
    } else {
      details.push("Consolidation: disabled.");
    }
    const cronIssue = memoryConsolidationCronIssue(consolidationCron);
    if (cronIssue !== undefined) {
      status = "error";
      details.push(`[ERROR] ${cronIssue}`);
    }
  }

  const managedIdentity = await managedMemoryIdentityStatus(config.memory);
  if (managedIdentity !== undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: status === "error" ? "error" : managedIdentity.status,
      details: [...details, ...managedIdentity.details],
    };
  }

  const nativeAvailability = await builtInMemoryNativeStatus(config.memory);
  if (nativeAvailability !== undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: "error",
      details: [...details, nativeAvailability],
    };
  }

  if (config.memory.mode === "journal" || config.memory.mode === "bujo") {
    const warns = await memoryLivenessWarnings(config.memory, env, liveness, allowFilesystemWrites);
    if (warns.length > 0) {
      return {
        id: "memory",
        label: "Memory",
        status: status === "error" ? "error" : "waiting",
        details: [...details, ...warns],
      };
    }
  }

  if (config.memory.mode === "lite") {
    const liteWarns = await liteRootWritableWarning(config.memory.path, allowFilesystemWrites);
    if (liteWarns.length > 0) {
      return {
        id: "memory",
        label: "Memory",
        status: status === "error" ? "error" : "waiting",
        details: [...details, ...liteWarns],
      };
    }
  }

  return { id: "memory", label: "Memory", status, details };
}

async function managedMemoryIdentityStatus(
  memory: NonNullable<MonoAgentConfig["memory"]>,
): Promise<{ readonly status: "error"; readonly details: readonly string[] } | undefined> {
  if (await firstRunMemoryInitializationIsIncomplete(memory.path)) {
    return {
      status: "error",
      details: [
        "[ERROR] First-run managed memory initialization is incomplete.",
        "Re-run `mono-agent init` in a clean target or remove only the failed first-run root after inspecting it.",
      ],
    };
  }
  const manifestPath = join(memory.path, ".index", "manifest.json");
  if (!(await pathExists(manifestPath))) {
    // Lite has no semantic index authority. Journal/BuJo readiness is strict:
    // a missing manifest is fatal even for a wholly new/unmanaged root, and the
    // provider must not be probed until rebuild establishes that authority.
    if (memory.mode === "lite") return undefined;
    return {
      status: "error",
      details: [
        "[ERROR] Managed memory generation metadata is missing for Journal/BuJo memory.",
        "Stop the agent with `mono-agent stop`, run `mono-agent memory rebuild`, then re-run `mono-agent validate` before restarting.",
      ],
    };
  }
  let manifest;
  try {
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    manifest = readManagedIndexManifest(memory.path);
  } catch {
    return {
      status: "error",
      details: ["[ERROR] Managed memory generation metadata is invalid or unavailable."],
    };
  }
  if (manifest === undefined) {
    return {
      status: "error",
      details: ["[ERROR] Managed memory generation metadata disappeared during validation."],
    };
  }

  const configuredModel = memory.embeddings === undefined
    ? undefined
    : `${memory.embeddings.provider}:${memory.embeddings.model}`;
  const configuredDimension = memory.embeddings === undefined ? undefined : memory.embeddings.dim ?? 768;
  const active = manifest.active;
  if (active.tier === memory.mode
    && active.embeddingModel === configuredModel
    && active.dimension === configuredDimension) {
    return undefined;
  }

  const identity = (tier: string, model: string | undefined, dimension: number | undefined): string =>
    `tier=${tier}, model=${model ?? "none"}, dim=${dimension ?? "none"}`;
  return {
    status: "error",
    details: [
      `[ERROR] Active managed generation does not match the configured memory identity: active ${identity(active.tier, active.embeddingModel, active.dimension)}; configured ${identity(memory.mode, configuredModel, configuredDimension)}.`,
      "Stop the agent with `mono-agent stop`, run `mono-agent memory rebuild`, then re-run `mono-agent validate` before restarting.",
    ],
  };
}

async function firstRunMemoryInitializationIsIncomplete(root: string): Promise<boolean> {
  if (await pathExists(join(root, FIRST_RUN_MEMORY_INITIALIZING_MARKER))) return true;
  try {
    return (await readdir(root)).some((name) => name.startsWith(FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX));
  } catch {
    return false;
  }
}

async function builtInMemoryNativeStatus(
  memory: NonNullable<MonoAgentConfig["memory"]>,
): Promise<string | undefined> {
  let database: { close(): void; indexMetadata(): unknown } | undefined;
  let managedGeneration = false;
  try {
    const { openMemoryDb } = await import("@mono-agent/memory/store");
    const manifestPath = join(memory.path, ".index", "manifest.json");
    if (await pathExists(manifestPath)) {
      managedGeneration = true;
      const { resolveActiveMemoryDbPath } = await import("@mono-agent/memory/bujo");
      database = openMemoryDb({ path: resolveActiveMemoryDbPath(memory.path), readOnly: true });
    } else {
      // Lite roots may not exist yet and validation must remain read-only. An
      // in-memory open exercises the exact native ABI + extension load without
      // scanning durable memory or creating the configured root.
      database = openMemoryDb({ path: ":memory:" });
    }
    // A single schema-row lookup proves the opened handle can actually read
    // SQLite state (constructor-only opens can accept a truncated file). This
    // remains constant-work and avoids the corpus/queue scans of strict audit.
    database.indexMetadata();
    database.close();
    database = undefined;
    return undefined;
  } catch (error) {
    if (isBuiltInMemoryNativeFailure(error)) {
      return "[ERROR] Built-in memory native module is unavailable for this Node runtime. Rebuild dependencies with the launch runtime, then re-run `mono-agent validate`.";
    }
    if (managedGeneration) {
      return "[ERROR] Built-in memory active generation is unavailable. Stop the agent with `mono-agent stop`, run `mono-agent memory rebuild`, then re-run `mono-agent validate` before restarting.";
    }
    return "[ERROR] Built-in memory database smoke check failed. Rebuild dependencies with the launch runtime; if the runtime is compatible, stop the agent and run `mono-agent memory rebuild`, then re-run `mono-agent validate`.";
  } finally {
    try { database?.close(); } catch { /* best-effort smoke cleanup */ }
  }
}

function isBuiltInMemoryNativeFailure(error: unknown): boolean {
  try {
    const message = error instanceof Error ? error.message : "";
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
    return /(?:err_(?:dlopen|module_not_found)|module_not_found|better[-_ ]?sqlite|sqlite[-_ ]?vec|node_module_version|native module|dlopen|\.node\b)/iu
      .test(`${code} ${message}`);
  } catch {
    return false;
  }
}

async function liteRootWritableWarning(memoryPath: string, allowFilesystemWrites: boolean): Promise<string[]> {
  return await memoryRootWritableWarnings("lite", memoryPath, allowFilesystemWrites);
}

const LIVENESS_PROBE_TIMEOUT_MS = 3_000;

type SupermemoryProbeResult =
  | { readonly reachable: true; readonly status: number }
  | { readonly reachable: false; readonly reason: string };

/**
 * Read-only transport probe for a configured Supermemory service root. Neither
 * the hosted nor self-hosted base URL has a documented health response, so any
 * HTTP status proves reachability; only transport failure or timeout degrades
 * validation. Manual redirects and omitted auth keep the probe on the exact
 * configured endpoint without sending memory data or credentials.
 */
async function probeSupermemoryEndpoint(endpoint: string): Promise<SupermemoryProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "HEAD",
      redirect: "manual",
      signal: ctrl.signal,
    });
    return { reachable: true, status: response.status };
  } catch (error) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes Ollama /api/tags and returns a sorted list of model names, or throws. */
async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { models?: { name?: unknown }[] };
    return (data.models ?? []).flatMap((m) => (typeof m.name === "string" ? [m.name] : []));
  } finally {
    clearTimeout(timer);
  }
}

async function memoryLivenessWarnings(
  memory: NonNullable<MonoAgentConfig["memory"]>,
  env: Readonly<Record<string, string | undefined>>,
  liveness: boolean,
  allowFilesystemWrites: boolean,
): Promise<string[]> {
  const warns: string[] = [];
  const mode = memory.mode;
  const llmUsesOllama = memory.llm?.provider === "ollama";
  const ollamaModelsByEndpoint = new Map<string, string[] | undefined>();

  // 1. Memory root writable (every embedded tier) — local I/O, always checked.
  const rootWarns = await memoryRootWritableWarnings(mode, memory.path, allowFilesystemWrites);
  warns.push(...rootWarns);

  const embeddings = memory.embeddings;
  let embeddingApiKey = embeddings?.apiKey;
  if (embeddings?.apiKeyEnv !== undefined) {
    embeddingApiKey = env[embeddings.apiKeyEnv]?.trim();
    if (embeddingApiKey === undefined || embeddingApiKey.length === 0) {
      warns.push(
        `[WARN] Embeddings apiKeyEnv ${embeddings.apiKeyEnv} is declared, but the resolved environment has no ` +
        `non-empty value. Set ${embeddings.apiKeyEnv} before starting managed memory; no keyless probe was attempted.`,
      );
      embeddingApiKey = undefined;
    }
  }

  // Network-dependent probes below only ever produce `waiting`, so the start
  // preflight skips them (liveness=false) without changing the pass/fail verdict.
  if (!liveness) {
    return warns;
  }

  if (
    embeddings !== undefined
    && (embeddings.provider === "ollama" || embeddings.provider === "lmstudio")
    && (embeddings.apiKeyEnv === undefined || embeddingApiKey !== undefined)
  ) {
    warns.push(...await localEmbeddingLivenessWarnings(embeddings, embeddingApiKey));
  }

  async function modelsForOllamaEndpoint(endpoint: string): Promise<string[] | undefined> {
    const normalizedEndpoint = endpoint.replace(/\/$/u, "");
    if (ollamaModelsByEndpoint.has(normalizedEndpoint)) {
      return ollamaModelsByEndpoint.get(normalizedEndpoint);
    }
    try {
      const models = await fetchOllamaModels(normalizedEndpoint);
      ollamaModelsByEndpoint.set(normalizedEndpoint, models);
      return models;
    } catch (err) {
      ollamaModelsByEndpoint.set(normalizedEndpoint, undefined);
      warns.push(
        `[WARN] Ollama not reachable at ${normalizedEndpoint}; ${mode} memory components configured for that endpoint will fail at runtime (${err instanceof Error ? err.message : String(err)}). Start Ollama or fix the endpoint.`,
      );
      return undefined;
    }
  }

  // 2. Chat-LLM Ollama liveness remains independent from the selected
  // embeddings service. OpenAI embeddings and agent-host chat LLMs have no
  // local typed model catalog to validate here.
  if (llmUsesOllama && memory.llm !== undefined) {
    const endpoint = memory.llm.endpoint ?? "http://localhost:11434";
    const ollamaModels = await modelsForOllamaEndpoint(endpoint);
    if (ollamaModels !== undefined) {
      const chatModel = memory.llm.model;
      if (!ollamaModels.includes(chatModel)) {
        warns.push(`[WARN] Chat LLM model ${chatModel} not pulled — run \`ollama pull ${chatModel}\`.`);
      }
    }
  }

  return warns;
}

async function localEmbeddingLivenessWarnings(
  embeddings: NonNullable<NonNullable<MonoAgentConfig["memory"]>["embeddings"]>,
  apiKey: string | undefined,
): Promise<string[]> {
  if (embeddings.provider !== "ollama" && embeddings.provider !== "lmstudio") return [];
  const provider = embeddings.provider;
  const label = provider === "ollama" ? "Ollama" : "LM Studio";
  const endpoint = (embeddings.endpoint ?? DEFAULT_MEMORY_EMBEDDING_ENDPOINTS[provider]).replace(/\/+$/u, "");
  // Runtime readiness is authoritative on the exact configured model. Typed
  // catalogs help the wizard offer choices, but an unavailable/incomplete
  // catalog must not make its explicit manual fallback permanently unready.
  try {
    await probeMemoryEmbeddingSelection({
      provider,
      endpoint,
      model: embeddings.model,
      expectedDimension: embeddings.dim ?? 768,
      timeoutMs: LIVENESS_PROBE_TIMEOUT_MS,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/HTTP 401/u.test(reason)) {
      return [
        `[WARN] ${label} authentication failed at ${endpoint} (HTTP 401). ` +
        "Set the configured embeddings apiKeyEnv to a valid bearer token and retry.",
      ];
    }
    if (/could not connect|timed out/iu.test(reason)) {
      return [
        `[WARN] ${label} not reachable at ${endpoint}; embeddings will fail at runtime (${reason}). ` +
        `Start ${label} or fix the endpoint.`,
      ];
    }
    if (provider === "ollama" && /HTTP 404/u.test(reason)) {
      return [
        `[WARN] Ollama embedding model ${embeddings.model} could not be proved at ${endpoint} (${reason}); ` +
        `run \`ollama pull ${embeddings.model}\` and verify its embedding capability.`,
      ];
    }
    return [
      `[WARN] ${label} embedding readiness failed for ${embeddings.model} at ${endpoint} (${reason}). ` +
      "Verify the selected model, authentication, and configured dimension.",
    ];
  }
}

async function memoryRootWritableWarnings(
  mode: string,
  memoryPath: string,
  allowFilesystemWrites: boolean,
): Promise<string[]> {
  if (allowFilesystemWrites) {
    try {
      await mkdir(memoryPath, { recursive: true });
      return [];
    } catch (err) {
      return [
        `[WARN] ${mode} memory root is not writable: ${memoryPath} (${err instanceof Error ? err.message : String(err)}). Fix filesystem permissions.`,
      ];
    }
  }

  try {
    const info = await stat(memoryPath);
    if (!info.isDirectory()) {
      return [`[WARN] ${mode} memory root is not a directory: ${memoryPath}. Fix filesystem permissions.`];
    }
    await access(memoryPath, constants.W_OK);
    return [];
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : undefined;
    if (code === "ENOENT") {
      return [
        `[WARN] ${mode} memory root is missing: ${memoryPath}. Consumer validation is read-only and did not create it.`,
      ];
    }
    return [
      `[WARN] ${mode} memory root is not writable: ${memoryPath} (${err instanceof Error ? err.message : String(err)}). Fix filesystem permissions.`,
    ];
  }
}

function memoryLlmLabel(llm: NonNullable<MonoAgentConfig["memory"]>["llm"]): string {
  if (llm === undefined) {
    return "none";
  }
  return llm.provider === "ollama"
    ? `ollama:${llm.model}`
    : `agent-host:${llm.model}${llm.executionMode === undefined ? "" : ` (${llm.executionMode})`}`;
}

async function toolsSection(config: MonoAgentConfig, input: ValidateMonoAgentFolderOptions): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  const allowedTools = config.tools.allowedTools;
  const allowAll = isAllowAllTools(allowedTools);
  if (allowAll) {
    // Allow-all (`"*"`): render the policy plainly instead of echoing the raw sentinel
    // as `Allowed tools: *.`. The disallow list (if any) is folded in as the "except"
    // clause here, so the separate `Disallowed tools:` line below is skipped for
    // allow-all to avoid printing it twice. Status stays `ok`; the per-name unknown /
    // MemoryRecall checks do not apply when every tool is allowed.
    details.push(
      config.tools.disallowedTools.length > 0
        ? `All tools allowed (except: ${config.tools.disallowedTools.join(", ")}).`
        : "All tools allowed.",
    );
  } else if (allowedTools.length === 0) {
    // An agent with no tools can chat but can do nothing else — the user's core
    // "no-tools trap". `waiting` (never `error`) surfaces it without failing a
    // deliberately chat-only agent (`report.ok` only checks for `error`).
    status = "waiting";
    details.push(
      "No tools allowed — the agent can chat but cannot read files, run commands, or send proactive messages. " +
        "Add names to tools.allowedTools (e.g. Read, Glob, Grep), or re-run `mono-agent init` in an empty folder to pick tools interactively.",
    );
  } else {
    details.push(`Allowed tools: ${allowedTools.join(", ")}.`);
    let mcpNoteAdded = false;
    for (const name of allowedTools) {
      if (isMcpToolName(name)) {
        // MCP tool names are owned by their servers; we cannot verify them offline.
        if (!mcpNoteAdded) {
          details.push("MCP tool names are provided by their servers and cannot be validated offline.");
          mcpNoteAdded = true;
        }
        continue;
      }
      // Accept both the new `MemoryRecall` and the legacy `memory_recall` alias.
      if (canonicalToolName(name) === "MemoryRecall") {
        // MemoryRecall is auto-provisioned from memory.recallTool.enabled and is NOT
        // allowlist-gated. Listing it is harmless redundancy WHEN recall is on, but a
        // real misconfiguration when it is off (the user expects a recall they won't get).
        if (config.memory?.recallTool?.enabled === true) {
          details.push(
            `${name} in allowedTools has no effect — recall is auto-provisioned by memory.recallTool.enabled (already on). You can remove this entry.`,
          );
        } else {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but memory.recallTool.enabled is off — recall will not work. Enable memory.recallTool (or remove this entry).`,
          );
        }
        continue;
      }
      if (!isKnownToolName(name)) {
        status = "waiting";
        const suggestion = suggestToolName(name);
        details.push(
          `Unknown tool name "${name}"` +
            (suggestion !== undefined ? ` — did you mean ${suggestion}?` : "") +
            " (pi silently drops unknown names).",
        );
      }
    }
  }
  if (!allowAll && config.tools.disallowedTools.length > 0) {
    // Under allow-all the disallow list is already folded into the "except" clause above.
    details.push(`Disallowed tools: ${config.tools.disallowedTools.join(", ")}.`);
  }
  const runtimeModels = configuredRuntimeModels(config.runtime);
  const directCodexModels = runtimeModels
    .filter((model) => model.sdk === "codex")
    .map(referenceOf);
  const directOpenCodeModels = runtimeModels
    .filter((model) => model.sdk === "opencode")
    .map(referenceOf);
  const claudeCliModels = [
    { model: config.runtime.model, executionMode: config.runtime.executionMode },
    ...configuredRuntimeFallbackModels(config.runtime).map((model) => ({
      model,
      executionMode: defaultExecutionModeForModel(model),
    })),
  ]
    .filter(({ model, executionMode }) => model.sdk === "claude" && executionMode === "cli")
    .map(({ model }) => referenceOf(model));
  const exactAllowAll = hasExactAllowAllToolPolicy(config.tools);
  const dedicatedNoToolsProbe = input.codexNoToolsProbe === true
    && allowedTools.length === 0
    && config.tools.disallowedTools.length === 0;
  if (
    directCodexModels.length > 0
    && !dedicatedNoToolsProbe
    && !exactAllowAll
  ) {
    status = "error";
    details.push(
      `Direct Codex model${directCodexModels.length === 1 ? "" : "s"} ${directCodexModels.join(", ")} cannot enforce ` +
        "tools.allowedTools/tools.disallowedTools. Use exact allow-all (allowedTools: [\"*\"] with no disallowedTools), " +
        "or select a runtime that supports restrictive tool policies.",
    );
  }
  if (directOpenCodeModels.length > 0 && !exactAllowAll) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.join(", ")} cannot enforce ` +
        "tools.allowedTools/tools.disallowedTools. Use exact allow-all (allowedTools: [\"*\"] with no disallowedTools), " +
        "or use a Pi runtime (including pi:opencode-go:*).",
    );
  }
  if (claudeCliModels.length > 0 && allowedTools.length === 0) {
    status = "error";
    details.push(
      `Claude CLI model${claudeCliModels.length === 1 ? "" : "s"} ${claudeCliModels.join(", ")} cannot enforce an empty ` +
        "tools.allowedTools list because omitting --tools enables Claude Code's default tool set. Use Claude SDK for a chat-only agent, or configure a non-empty enforceable tool list.",
    );
  }
  let configuredMcpServerNames: string[] = [];
  let configuredMcpServers: Record<string, unknown> = {};
  if (config.tools.mcpConfigPath !== undefined) {
    if (await pathExists(config.tools.mcpConfigPath)) {
      details.push(`MCP config: ${config.tools.mcpConfigPath}`);
      try {
        const policy = await loadToolPolicyFromJsonFile(config.tools.mcpConfigPath);
        configuredMcpServers = policy.mcpServers ?? {};
        configuredMcpServerNames = Object.keys(configuredMcpServers);
      } catch {
        status = "error";
        details.push(`MCP config is malformed or unreadable: ${config.tools.mcpConfigPath}`);
      }
    } else {
      status = "error";
      details.push(`MCP config file is missing: ${config.tools.mcpConfigPath}`);
    }
  }
  for (const serverName of config.tools.mcpRequestContextServers ?? []) {
    if (!isValidMcpServerName(serverName)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" is not a runtime-valid MCP server name (letters, digits, underscores, and hyphens only).`,
      );
      continue;
    }
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (!isStdioMcpServerSpec(spec)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" must reference a stdio MCP server (command/type:stdio), not HTTP/SSE.`,
      );
    }
  }
  for (const serverName of config.tools.continuationServers ?? []) {
    if (!isValidMcpServerName(serverName)) {
      status = "error";
      details.push(
        `tools.continuationServers entry "${serverName}" is not a runtime-valid MCP server name (letters, digits, underscores, and hyphens only).`,
      );
      continue;
    }
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.continuationServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (classifyContinuationMcpServerTransport(spec) === "unsupported") {
      status = "error";
      details.push(
        `tools.continuationServers entry "${serverName}" must reference a stdio or loopback HTTP MCP server; remote HTTP and SSE are not supported.`,
      );
    }
  }
  const adapterSendTools = await resolveAdapterSendToolsSettings(input, {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    suppressInteractionTools: directOpenCodeModels.length > 0,
  });
  if (adapterSendTools === undefined) {
    details.push("No adapter-derived send tools enabled.");
  } else {
    details.push(`Adapter send tools: ${adapterSendToolNames(adapterSendTools).join(", ")}.`);
  }
  const blockedAdapterEndpoints = await adapterSendToolNetworkPolicyWarnings(
    config,
    input,
    adapterSendTools,
    directOpenCodeModels.length > 0,
  );
  if (blockedAdapterEndpoints.length > 0) {
    if (status !== "error") {
      status = "waiting";
    }
    details.push(...blockedAdapterEndpoints);
  }
  const effectiveMcpSources = effectiveMcpRuntimeSources(
    config,
    configuredMcpServerNames,
    adapterSendTools === undefined ? [] : adapterSendToolNames(adapterSendTools),
  );
  if (directOpenCodeModels.length > 0 && effectiveMcpSources.length > 0) {
    status = "error";
    details.push(
      `Direct OpenCode model${directOpenCodeModels.length === 1 ? "" : "s"} ${directOpenCodeModels.join(", ")} cannot safely consume ` +
        `MCP runtime options from ${effectiveMcpSources.join("; ")}. Disable those MCP sources or use a Pi runtime (including pi:opencode-go:*).`,
    );
  }

  return { id: "tools", label: "Tools & MCP", status, details };
}

async function continuationSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
): Promise<ValidationSection> {
  let settings;
  try {
    settings = await loadContinuationSettings({
      cwd: input.cwd,
      configPath: input.configPath,
      env: input.env,
    });
  } catch (error) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "error",
      details: [`Continuation configuration is invalid: ${continuationReason(error)}`],
    };
  }

  const continuationServers = config.tools.continuationServers ?? [];
  if (!settings.configured && continuationServers.length === 0) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "disabled",
      details: ["No continuation-capable MCP servers or detached continuation routes are configured."],
    };
  }
  if (!settings.enabled) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "error",
      details: ["Continuation service is disabled while continuation functionality is configured."],
    };
  }

  const details = [
    `Loopback service: http://${formatContinuationHost(settings.host)}:${String(settings.port)}.`,
    `Owner-only state: ${settings.stateDir}.`,
    continuationServers.length === 0
      ? "Run-scoped continuation MCP servers: none."
      : `Run-scoped continuation MCP servers: ${continuationServers.join(", ")}.`,
  ];
  const routeNames = Object.entries(settings.namedRoutes).map(([name, route]) => `${name} (${route.mode})`);
  details.push(routeNames.length === 0 ? "Named detached routes: none." : `Named detached routes: ${routeNames.join(", ")}.`);
  const detachedNames = Object.keys(settings.detachedServices);
  details.push(detachedNames.length === 0 ? "Detached services: none." : `Detached services: ${detachedNames.join(", ")}.`);

  const state = await inspectContinuationState(settings.stateDir, settings.retention);
  details.push(...state.details);
  return {
    id: "continuations",
    label: "Durable continuations",
    status: state.status,
    details,
  };
}

async function inspectContinuationState(
  stateDir: string,
  retention: ContinuationRetentionOptions,
): Promise<{
  readonly status: "ok" | "waiting" | "error";
  readonly details: readonly string[];
}> {
  const details: string[] = [];
  const retentionPolicy = resolveRetention(retention);
  let directory;
  try {
    directory = await lstat(stateDir);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return {
        status: "ok",
        details: ["State has not been initialized; the app will create it with owner-only permissions on first start."],
      };
    }
    return { status: "error", details: [`Continuation state cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    return { status: "error", details: ["Continuation state path must be a real directory, not a file or symlink."] };
  }
  const directorySecurityError = continuationOwnershipError(directory, "state directory", 0o700);
  if (directorySecurityError !== undefined) {
    return { status: "error", details: [directorySecurityError] };
  }

  const secretError = await inspectContinuationSecret(join(stateDir, "continuation-secret"));
  if (secretError !== undefined) {
    return { status: "error", details: [secretError] };
  }

  const manifestPath = join(stateDir, "continuation-store-v3.json");
  let manifestInfo;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Continuation store manifest cannot be inspected: ${continuationReason(error)}`] };
    }
  }
  if (manifestInfo !== undefined) {
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      return { status: "error", details: ["Continuation store manifest must be a regular file, not a symlink."] };
    }
    const manifestSecurityError = continuationOwnershipError(manifestInfo, "store manifest", 0o600);
    if (manifestSecurityError !== undefined) return { status: "error", details: [manifestSecurityError] };
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readBoundedOwnerOnlyFile(
        manifestPath,
        MAX_MANIFEST_BYTES,
        "Continuation v3 manifest",
      )) as unknown;
    } catch (error) {
      return { status: "error", details: [`Continuation store manifest contains invalid JSON: ${continuationReason(error)}`] };
    }
    if (!isContinuationStoreManifest(
      manifest,
      CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
      "per-record-v3",
    )) {
      return { status: "error", details: ["Continuation store manifest has an unsupported or malformed schema."] };
    }
    const recordsDirectoryPath = join(stateDir, "records-v3");
    const recordsDirectoryError = await inspectContinuationRecordsDirectory(recordsDirectoryPath);
    if (recordsDirectoryError !== undefined) return { status: "error", details: [recordsDirectoryError] };
    let recordsDirectoryHasEntries: boolean;
    try {
      recordsDirectoryHasEntries = (await readdir(recordsDirectoryPath))
        .some((entry) => !(entry.startsWith(".") && entry.endsWith(".tmp")));
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation record directory cannot be inspected: ${continuationReason(error)}`],
      };
    }
    const transaction = await inspectContinuationTransaction(
      join(stateDir, "continuation-transaction-v3.json"),
      CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    );
    if (!transaction.valid) return { status: "error", details: [transaction.detail] };
    const legacyRecordsDirectoryPath = join(stateDir, "records-v2");
    let legacyRecordsDirectoryExists = false;
    try {
      const legacyRecordsDirectoryInfo = await lstat(legacyRecordsDirectoryPath);
      legacyRecordsDirectoryExists = true;
      if (!legacyRecordsDirectoryInfo.isDirectory() || legacyRecordsDirectoryInfo.isSymbolicLink()) {
        return { status: "error", details: ["Legacy continuation record directory must be a real directory."] };
      }
      const legacyRecordsDirectoryError = await inspectContinuationRecordsDirectory(
        legacyRecordsDirectoryPath,
        { allowV2RollbackGuard: true },
      );
      if (legacyRecordsDirectoryError !== undefined) {
        return { status: "error", details: [legacyRecordsDirectoryError] };
      }
    } catch (error) {
      if (continuationFsCode(error) !== "ENOENT") {
        return {
          status: "error",
          details: [`Legacy continuation record directory cannot be inspected: ${continuationReason(error)}`],
        };
      }
    }
    let legacyStateExists = legacyRecordsDirectoryExists;
    const legacyV1Path = join(stateDir, "continuations-v1.json");
    const legacyV1 = await inspectContinuationEvidenceFile(legacyV1Path, "v1 store");
    if (!legacyV1.valid) return { status: "error", details: [legacyV1.detail] };
    legacyStateExists ||= legacyV1.exists;
    const legacyV2Manifest = await inspectContinuationEvidenceFile(
      join(stateDir, "continuation-store-v2.json"),
      "v2 manifest",
    );
    if (!legacyV2Manifest.valid) return { status: "error", details: [legacyV2Manifest.detail] };
    legacyStateExists ||= legacyV2Manifest.exists;
    const legacyTransaction = await inspectContinuationTransaction(
      join(stateDir, "continuation-transaction-v2.json"),
      2,
    );
    if (!legacyTransaction.valid) return { status: "error", details: [legacyTransaction.detail] };
    legacyStateExists ||= legacyTransaction.pending;
    const manifestRollbackGuardRequired = manifest.rollbackGuardRequired ?? true;
    const legacyMigrationPending = legacyStateExists && !manifestRollbackGuardRequired;
    let recoverableRecords: Map<string, DurableContinuationRecord>;
    try {
      recoverableRecords = await loadContinuationRecordsForRecoveryInspection(recordsDirectoryPath);
      if (transaction.transaction !== undefined) {
        applyContinuationTransactionForInspection(recoverableRecords, transaction.transaction);
      }
      normalizeLegacyContinuationRecords(recoverableRecords);
      if (legacyMigrationPending) {
        const legacy = legacyRecordsDirectoryExists
          ? await loadContinuationRecordsForRecoveryInspection(legacyRecordsDirectoryPath)
          : new Map<string, DurableContinuationRecord>();
        if (legacyTransaction.transaction !== undefined) {
          applyContinuationTransactionForInspection(legacy, legacyTransaction.transaction);
        }
        if (legacyV1.exists) {
          mergeMigrationRecords(legacy, await loadLegacyStore(legacyV1Path), "recoverable v1 and v2");
        }
        mergeMigrationRecords(recoverableRecords, legacy, "recoverable v2 and v3");
      }
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation recoverable records are malformed or conflicting: ${continuationReason(error)}`],
      };
    }
    const originGroups = await inspectContinuationEvidenceDirectory(
      join(stateDir, "origin-context-groups-v1"),
      "origin-context activation directory",
      async () => recoverableRecords,
    );
    if (!originGroups.valid) return { status: "error", details: [originGroups.detail] };
    try {
      applyRetention(recoverableRecords, retentionPolicy, new Date());
    } catch (error) {
      return {
        status: "error",
        details: [`Continuation retention projection cannot be recovered safely: ${continuationReason(error)}`],
      };
    }
    const rollbackGuardRequired = manifestRollbackGuardRequired
      || recordsDirectoryHasEntries
      || transaction.pending
      || originGroups.hasEntries;
    const rollbackGuard = await inspectContinuationRollbackGuard(
      join(legacyRecordsDirectoryPath, CONTINUATION_V2_ROLLBACK_GUARD),
      rollbackGuardRequired,
      legacyMigrationPending
        ? "Legacy continuation state is awaiting v3 migration; the current runtime will fence it before v3 materialization."
        : "The empty v3 store has no v2 rollback guard; the current runtime will install one before its first v3 record becomes durable.",
    );
    if (!rollbackGuard.valid) return { status: "error", details: [rollbackGuard.detail] };
    const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
    if (!owner.valid) return { status: "error", details: [owner.detail] };
    details.push(
      `Store v3: ${String(manifest.stats.records)} retained; ${String(manifest.stats.active)} active; ${String(manifest.stats.unresolvedDelivery)} delivery unknown; ${String(manifest.stats.deadLettered)} dead-lettered; ${String(manifest.stats.historyDegraded)} history-degraded deliveries; ${String(manifest.stats.terminalTombstones)} terminal tombstones; ${String(manifest.stats.compacted)} compacted; ${String(manifest.stats.capturedText)} captured answers.`,
      `Retention: at most ${String(manifest.stats.limits.terminalMaxRecords)} terminal tombstones with a maximum age of ${String(manifest.stats.limits.terminalMaxAgeMs)} ms and ${String(manifest.stats.limits.capturedTextMaxRecords)} captured answers with a maximum age of ${String(manifest.stats.limits.capturedTextMaxAgeMs)} ms.`,
      transaction.detail,
      rollbackGuard.detail,
      originGroups.detail,
      ...(legacyMigrationPending ? ["Legacy continuation state is awaiting idempotent v3 migration."] : []),
      owner.detail,
    );
    return {
      status: transaction.pending
        || originGroups.hasEntries
        || legacyMigrationPending
        || manifest.stats.unresolvedDelivery > 0
        || manifest.stats.deadLettered > 0
        || manifest.stats.historyDegraded > 0
        ? "waiting"
        : "ok",
      details,
    };
  }

  // Without a v3 manifest, derive one complete read-only recovery projection
  // before choosing a status. A crash may leave a WAL, already-applied records
  // after WAL removal, legacy inputs, or an activation marker in any
  // combination; reporting one item as waiting must not mask another item that
  // runtime recovery would reject.
  const unmanifestedV3Transaction = await inspectContinuationTransaction(
    join(stateDir, "continuation-transaction-v3.json"),
    CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  );
  if (!unmanifestedV3Transaction.valid) {
    return { status: "error", details: [unmanifestedV3Transaction.detail] };
  }
  const unmanifestedV2Transaction = await inspectContinuationTransaction(
    join(stateDir, "continuation-transaction-v2.json"),
    2,
  );
  if (!unmanifestedV2Transaction.valid) {
    return { status: "error", details: [unmanifestedV2Transaction.detail] };
  }

  const legacyManifestPath = join(stateDir, "continuation-store-v2.json");
  let legacyManifestInfo;
  try {
    legacyManifestInfo = await lstat(legacyManifestPath);
  } catch (error) {
    if (continuationFsCode(error) !== "ENOENT") {
      return { status: "error", details: [`Legacy continuation store manifest cannot be inspected: ${continuationReason(error)}`] };
    }
  }
  let legacyManifestExists = false;
  let legacyManifestDetails: readonly string[] | undefined;
  if (legacyManifestInfo !== undefined) {
    legacyManifestExists = true;
    if (!legacyManifestInfo.isFile() || legacyManifestInfo.isSymbolicLink()) {
      return { status: "error", details: ["Legacy continuation store manifest must be a regular file, not a symlink."] };
    }
    const manifestSecurityError = continuationOwnershipError(legacyManifestInfo, "legacy store manifest", 0o600);
    if (manifestSecurityError !== undefined) return { status: "error", details: [manifestSecurityError] };
    let legacyManifest: unknown;
    try {
      legacyManifest = JSON.parse(await readBoundedOwnerOnlyFile(
        legacyManifestPath,
        MAX_MANIFEST_BYTES,
        "Continuation v2 manifest",
      )) as unknown;
    } catch (error) {
      return { status: "error", details: [`Legacy continuation store manifest contains invalid JSON: ${continuationReason(error)}`] };
    }
    if (!isContinuationStoreManifest(legacyManifest, 2, "per-record-v2")) {
      return { status: "error", details: ["Legacy continuation store manifest has an unsupported or malformed schema."] };
    }
    legacyManifestDetails = [
      `Legacy store v2 awaiting v3 migration: ${String(legacyManifest.stats.records)} retained; ${String(legacyManifest.stats.active)} active; ${String(legacyManifest.stats.unresolvedDelivery)} delivery unknown; ${String(legacyManifest.stats.deadLettered)} dead-lettered; ${String(legacyManifest.stats.historyDegraded)} history-degraded deliveries; ${String(legacyManifest.stats.terminalTombstones)} terminal tombstones; ${String(legacyManifest.stats.compacted)} compacted; ${String(legacyManifest.stats.capturedText)} captured answers.`,
      `Retention: at most ${String(legacyManifest.stats.limits.terminalMaxRecords)} terminal tombstones with a maximum age of ${String(legacyManifest.stats.limits.terminalMaxAgeMs)} ms and ${String(legacyManifest.stats.limits.capturedTextMaxRecords)} captured answers with a maximum age of ${String(legacyManifest.stats.limits.capturedTextMaxAgeMs)} ms.`,
    ];
  }

  const legacyV1Path = join(stateDir, "continuations-v1.json");
  const legacyV1 = await inspectContinuationEvidenceFile(legacyV1Path, "v1 store");
  if (!legacyV1.valid) return { status: "error", details: [legacyV1.detail] };
  let v3Directory: Awaited<ReturnType<typeof loadOptionalContinuationRecordsForRecoveryInspection>>;
  let v2Directory: Awaited<ReturnType<typeof loadOptionalContinuationRecordsForRecoveryInspection>>;
  let projectedRecords: Map<string, DurableContinuationRecord>;
  let hasCommittedV3Records = false;
  try {
    v3Directory = await loadOptionalContinuationRecordsForRecoveryInspection(join(stateDir, "records-v3"));
    hasCommittedV3Records = v3Directory.records.size > 0;
    v2Directory = await loadOptionalContinuationRecordsForRecoveryInspection(join(stateDir, "records-v2"), {
      allowV2RollbackGuard: true,
    });
    const legacyRecords = v2Directory.records;
    if (unmanifestedV2Transaction.transaction !== undefined) {
      applyContinuationTransactionForInspection(legacyRecords, unmanifestedV2Transaction.transaction);
    }
    if (legacyV1.exists) {
      mergeMigrationRecords(legacyRecords, await loadLegacyStore(legacyV1Path), "recoverable v1 and v2");
    }
    projectedRecords = v3Directory.records;
    if (unmanifestedV3Transaction.transaction !== undefined) {
      applyContinuationTransactionForInspection(projectedRecords, unmanifestedV3Transaction.transaction);
    }
    normalizeLegacyContinuationRecords(projectedRecords);
    mergeMigrationRecords(projectedRecords, legacyRecords, "recoverable v2 and v3");
  } catch (error) {
    return {
      status: "error",
      details: [`Continuation recovery evidence is malformed or conflicting: ${continuationReason(error)}`],
    };
  }
  const originGroups = await inspectContinuationEvidenceDirectory(
    join(stateDir, "origin-context-groups-v1"),
    "origin-context activation directory",
    async () => projectedRecords,
  );
  if (!originGroups.valid) return { status: "error", details: [originGroups.detail] };
  try {
    applyRetention(projectedRecords, retentionPolicy, new Date());
  } catch (error) {
    return {
      status: "error",
      details: [`Continuation retention projection cannot be recovered safely: ${continuationReason(error)}`],
    };
  }
  const rollbackGuard = await inspectContinuationRollbackGuard(
    join(stateDir, "records-v2", CONTINUATION_V2_ROLLBACK_GUARD),
    false,
    "The v2 rollback guard is not installed; the current runtime will install it during v3 migration before publishing v3 state.",
  );
  if (!rollbackGuard.valid) return { status: "error", details: [rollbackGuard.detail] };
  const recoverableEvidenceExists = legacyManifestExists
    || v2Directory.exists
    || hasCommittedV3Records
    || unmanifestedV2Transaction.pending
    || unmanifestedV3Transaction.pending
    || originGroups.hasEntries;
  if (recoverableEvidenceExists) {
    const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
    if (!owner.valid) return { status: "error", details: [owner.detail] };
    details.push(
      ...(legacyManifestDetails ?? ["Continuation records are awaiting completion of the v3 manifest."]),
      ...(unmanifestedV2Transaction.pending ? [unmanifestedV2Transaction.detail] : []),
      ...(unmanifestedV3Transaction.pending ? [unmanifestedV3Transaction.detail] : []),
      rollbackGuard.detail,
      originGroups.detail,
      owner.detail,
    );
    return { status: "waiting", details };
  }

  const storePath = join(stateDir, "continuations-v1.json");
  let storeInfo;
  try {
    storeInfo = await lstat(storePath);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      details.push("No continuation ledger has been written yet.");
      const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
      details.push(owner.detail);
      return { status: owner.valid ? "ok" : "error", details };
    }
    return { status: "error", details: [`Continuation ledger cannot be inspected: ${continuationReason(error)}`] };
  }
  if (!storeInfo.isFile() || storeInfo.isSymbolicLink()) {
    return { status: "error", details: ["Continuation ledger must be a regular file, not a symlink."] };
  }
  const storeSecurityError = continuationOwnershipError(storeInfo, "ledger", 0o600);
  if (storeSecurityError !== undefined) {
    return { status: "error", details: [storeSecurityError] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedOwnerOnlyFile(
      storePath,
      MAX_LEGACY_STORE_BYTES,
      "Continuation legacy store",
    )) as unknown;
  } catch (error) {
    return { status: "error", details: [`Continuation ledger contains invalid JSON: ${continuationReason(error)}`] };
  }
  if (!isContinuationLedger(parsed)) {
    return { status: "error", details: ["Continuation ledger has an unsupported or malformed schema."] };
  }

  const counts = Object.fromEntries(CONTINUATION_STATES.map((state) => [state, 0])) as Record<ContinuationState, number>;
  for (const record of Object.values(parsed.records)) {
    if (!isDoctorObject(record) || typeof record.state !== "string" || !CONTINUATION_STATES.includes(record.state as ContinuationState)) {
      return { status: "error", details: ["Continuation ledger contains a record with an invalid lifecycle state."] };
    }
    counts[record.state as ContinuationState] += 1;
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const pending = counts.claimed + counts.result_received + counts.synthesizing + counts.ready_to_deliver + counts.delivery_retry;
  details.push(
    `Legacy ledger awaiting v3 migration: ${String(total)} total; ${String(pending)} pending; ${String(counts.delivery_unknown)} delivery unknown; ${String(counts.dead_lettered)} dead-lettered.`,
  );
  const owner = await inspectContinuationOwnerDatabase(join(stateDir, "continuations-owner.sqlite"));
  details.push(owner.detail);
  return {
    status: !owner.valid
      ? "error"
      : counts.delivery_unknown > 0 || counts.dead_lettered > 0
        ? "waiting"
        : "ok",
    details,
  };
}

async function inspectContinuationSecret(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? undefined
      : `Continuation secret cannot be inspected: ${continuationReason(error)}`;
  }
  if (!info.isFile() || info.isSymbolicLink()) return "Continuation secret must be a regular file, not a symlink.";
  const securityError = continuationOwnershipError(info, "secret", 0o600);
  if (securityError !== undefined) return securityError;
  try {
    const secret = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (secret.length !== 32) return "Continuation secret contents are invalid.";
  } catch (error) {
    return `Continuation secret cannot be read: ${continuationReason(error)}`;
  }
  return undefined;
}

async function inspectContinuationOwnerDatabase(path: string): Promise<{
  readonly valid: boolean;
  readonly detail: string;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, detail: "The OS-backed continuation ownership database has not been initialized yet." }
      : { valid: false, detail: `Continuation ownership database cannot be inspected: ${continuationReason(error)}` };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { valid: false, detail: "Continuation ownership database is not a regular file." };
  }
  const securityError = continuationOwnershipError(info, "ownership database", 0o600);
  if (securityError !== undefined) return { valid: false, detail: securityError };
  return { valid: true, detail: "OS-backed exclusive ownership is released automatically on clean stop or process death." };
}

async function inspectContinuationRecordsDirectory(
  path: string,
  options: { readonly allowV2RollbackGuard?: boolean } = {},
): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? "Continuation record directory is missing."
      : `Continuation record directory cannot be inspected: ${continuationReason(error)}`;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return "Continuation record directory must be a real directory, not a file or symlink.";
  }
  const directorySecurityError = continuationOwnershipError(info, "record directory", 0o700);
  if (directorySecurityError !== undefined) return directorySecurityError;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (options.allowV2RollbackGuard && entry.name === CONTINUATION_V2_ROLLBACK_GUARD) continue;
      if (!entry.name.endsWith(".json") && !(entry.name.startsWith(".") && entry.name.endsWith(".tmp"))) {
        return `Continuation record directory contains an unexpected entry: ${entry.name}.`;
      }
      const recordInfo = await lstat(join(path, entry.name));
      if (!recordInfo.isFile() || recordInfo.isSymbolicLink()) {
        return `Continuation record entry is not a regular file: ${entry.name}.`;
      }
      const securityError = continuationOwnershipError(recordInfo, "record", 0o600);
      if (securityError !== undefined) return securityError;
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
        try {
          await readBoundedOwnerOnlyFile(
            join(path, entry.name),
            MAX_RECORD_BYTES,
            "Continuation temporary record",
          );
        } catch (error) {
          return `Continuation temporary record is unsafe: ${continuationReason(error)}`;
        }
      }
    }
  } catch (error) {
    return `Continuation record directory cannot be inspected: ${continuationReason(error)}`;
  }
  return undefined;
}

async function inspectContinuationEvidenceDirectory(
  path: string,
  label: string,
  loadRecoverableRecords: () => Promise<Map<string, DurableContinuationRecord>>,
): Promise<{
  readonly valid: boolean;
  readonly hasEntries: boolean;
  readonly hasTemporaryDebris: boolean;
  readonly detail: string;
}> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, hasEntries: false, hasTemporaryDebris: false, detail: `${label} has not been created.` }
      : {
          valid: false,
          hasEntries: false,
          hasTemporaryDebris: false,
          detail: `${label} cannot be inspected: ${continuationReason(error)}`,
        };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { valid: false, hasEntries: false, hasTemporaryDebris: false, detail: `${label} must be a real directory.` };
  }
  const securityError = continuationOwnershipError(info, label, 0o700);
  if (securityError !== undefined) {
    return { valid: false, hasEntries: false, hasTemporaryDebris: false, detail: securityError };
  }
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const temporaryEntries = entries.filter((entry) => entry.name.startsWith(".") && entry.name.endsWith(".tmp"));
    let projectedRecords: Map<string, DurableContinuationRecord> | undefined;
    const recordsForRecovery = async (): Promise<Map<string, DurableContinuationRecord>> => {
      if (projectedRecords !== undefined) return projectedRecords;
      projectedRecords = await loadRecoverableRecords();
      return projectedRecords;
    };
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      const temporary = entry.name.startsWith(".") && entry.name.endsWith(".tmp");
      if (temporary) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return {
            valid: false,
            hasEntries: true,
            hasTemporaryDebris: true,
            detail: `${label} temporary entry must be a regular file: ${entry.name}.`,
          };
        }
        try {
          await readBoundedOwnerOnlyFile(
            entryPath,
            64 * 1024,
            "Continuation origin-context group temporary",
          );
        } catch (error) {
          return {
            valid: false,
            hasEntries: false,
            hasTemporaryDebris: true,
            detail: `${label} temporary entry is unsafe: ${continuationReason(error)}`,
          };
        }
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} contains an unexpected entry: ${entry.name}.`,
        };
      }
      const entryInfo = await lstat(entryPath);
      if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.nlink !== 1) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker must be a single-link regular file: ${entry.name}.`,
        };
      }
      const entrySecurityError = continuationOwnershipError(entryInfo, `${label} marker`, 0o600);
      if (entrySecurityError !== undefined) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: entrySecurityError,
        };
      }
      if (entryInfo.size > 64 * 1024) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker exceeds its safety limit: ${entry.name}.`,
        };
      }
      let markerBody: string;
      try {
        markerBody = await readBoundedOwnerOnlyFile(
          entryPath,
          64 * 1024,
          "Continuation origin-context group commit",
        );
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker is unsafe to read: ${continuationReason(error)}`,
        };
      }
      let marker: unknown;
      try {
        marker = JSON.parse(markerBody) as unknown;
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker contains invalid JSON: ${continuationReason(error)}`,
        };
      }
      if (!isOriginContextGroupCommit(marker) || `${marker.groupKey}.json` !== entry.name) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker has a malformed schema or filename: ${entry.name}.`,
        };
      }
      try {
        applyOriginContextGroupCommit(await recordsForRecovery(), marker);
      } catch (error) {
        return {
          valid: false,
          hasEntries: true,
          hasTemporaryDebris: temporaryEntries.length > 0,
          detail: `${label} marker does not match the recoverable durable records: ${continuationReason(error)}`,
        };
      }
    }
    const markerCount = entries.length - temporaryEntries.length;
    const hasEntries = markerCount > 0;
    const detail = markerCount > 0
      ? `${label} contains ${markerCount === 1 ? "a durable marker" : `${String(markerCount)} durable markers`} awaiting idempotent recovery${temporaryEntries.length > 0 ? ", plus incomplete temporary debris awaiting cleanup" : ""}.`
      : temporaryEntries.length > 0
        ? `${label} contains only incomplete temporary debris awaiting cleanup.`
        : `${label} is owner-only and empty.`;
    return {
      valid: true,
      hasEntries,
      hasTemporaryDebris: temporaryEntries.length > 0,
      detail,
    };
  } catch (error) {
    return {
      valid: false,
      hasEntries: false,
      hasTemporaryDebris: false,
      detail: `${label} cannot be inspected: ${continuationReason(error)}`,
    };
  }
}

async function loadContinuationRecordsForRecoveryInspection(
  path: string,
): Promise<Map<string, DurableContinuationRecord>> {
  const records = new Map<string, DurableContinuationRecord>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!entry.name.endsWith(".json")) continue;
    const entryPath = join(path, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(await readBoundedOwnerOnlyFile(
        entryPath,
        MAX_RECORD_BYTES,
        "Continuation record",
      )) as unknown;
    } catch (error) {
      throw new Error(`Continuation record cannot be validated for activation recovery: ${entry.name}`, {
        cause: error,
      });
    }
    if (!isDoctorObject(value)
      || typeof value.continuationId !== "string"
      || !isRecord(value, value.continuationId)
      || `${continuationDigest(value.continuationId)}.json` !== entry.name
      || records.has(value.continuationId)) {
      throw new Error(`Continuation record has a malformed schema, duplicate id, or mismatched filename: ${entry.name}`);
    }
    records.set(value.continuationId, structuredClone(value) as DurableContinuationRecord);
  }
  return records;
}

async function loadOptionalContinuationRecordsForRecoveryInspection(
  path: string,
  options: { readonly allowV2RollbackGuard?: boolean } = {},
): Promise<{
  readonly exists: boolean;
  readonly records: Map<string, DurableContinuationRecord>;
}> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Continuation record directory must be a real directory, not a file or symlink.");
    }
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return { exists: false, records: new Map() };
    }
    throw error;
  }
  const inspectionError = await inspectContinuationRecordsDirectory(path, options);
  if (inspectionError !== undefined) throw new Error(inspectionError);
  return {
    exists: true,
    records: await loadContinuationRecordsForRecoveryInspection(path),
  };
}

function applyContinuationTransactionForInspection(
  records: Map<string, DurableContinuationRecord>,
  transaction: ContinuationRecordTransaction,
): void {
  for (const record of transaction.writes) {
    records.set(record.continuationId, structuredClone(record));
  }
  for (const id of transaction.deletes) records.delete(id);
}

async function inspectContinuationEvidenceFile(
  path: string,
  label: string,
): Promise<{ readonly valid: boolean; readonly exists: boolean; readonly detail: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, exists: false, detail: `Legacy continuation ${label} is absent.` }
      : {
        valid: false,
        exists: false,
        detail: `Legacy continuation ${label} cannot be inspected: ${continuationReason(error)}`,
      };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return {
      valid: false,
      exists: true,
      detail: `Legacy continuation ${label} must be a single-link regular file.`,
    };
  }
  const securityError = continuationOwnershipError(info, `legacy ${label}`, 0o600);
  return securityError === undefined
    ? { valid: true, exists: true, detail: `Legacy continuation ${label} is owner-only.` }
    : { valid: false, exists: true, detail: securityError };
}

async function inspectContinuationRollbackGuard(
  path: string,
  required: boolean,
  missingDetail = "The v2 rollback guard is not installed; the current runtime will install it during v3 migration.",
): Promise<{ readonly valid: boolean; readonly detail: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (continuationFsCode(error) === "ENOENT") {
      return required
        ? { valid: false, detail: "Continuation v2 rollback guard is missing from the v3 store." }
        : { valid: true, detail: missingDetail };
    }
    return { valid: false, detail: `Continuation v2 rollback guard cannot be inspected: ${continuationReason(error)}` };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return { valid: false, detail: "Continuation v2 rollback guard must be a single-link regular file, not a symlink." };
  }
  const securityError = continuationOwnershipError(info, "v2 rollback guard", 0o600);
  if (securityError !== undefined) return { valid: false, detail: securityError };
  if (info.size > 4 * 1024) {
    return { valid: false, detail: "Continuation v2 rollback guard exceeds its safety limit." };
  }
  let contents: string;
  try {
    contents = await readBoundedOwnerOnlyFile(path, 4 * 1024, "Continuation v2 rollback guard");
  } catch (error) {
    return { valid: false, detail: `Continuation v2 rollback guard cannot be read: ${continuationReason(error)}` };
  }
  if (contents !== CONTINUATION_V2_ROLLBACK_GUARD_CONTENT) {
    return { valid: false, detail: "Continuation v2 rollback guard contents are invalid." };
  }
  return {
    valid: true,
    detail: "The owner-only v2 rollback guard prevents older runtimes from opening stale continuation records.",
  };
}

async function inspectContinuationTransaction(
  path: string,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): Promise<{
  readonly valid: boolean;
  readonly pending: boolean;
  readonly transaction?: ContinuationRecordTransaction;
  readonly detail: string;
}> {
  const versionLabel = `v${String(expectedSchemaVersion)}`;
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return continuationFsCode(error) === "ENOENT"
      ? { valid: true, pending: false, detail: `No interrupted durable ${versionLabel} transaction is awaiting recovery.` }
      : {
          valid: false,
          pending: false,
          detail: `Continuation ${versionLabel} transaction cannot be inspected: ${continuationReason(error)}`,
        };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction must be a single-link regular file, not a symlink.`,
    };
  }
  const securityError = continuationOwnershipError(info, `${versionLabel} transaction`, 0o600);
  if (securityError !== undefined) return { valid: false, pending: true, detail: securityError };
  let transaction: unknown;
  try {
    transaction = JSON.parse(await readBoundedOwnerOnlyFile(
      path,
      MAX_TRANSACTION_BYTES,
      `Continuation ${versionLabel} transaction`,
    )) as unknown;
  } catch (error) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction cannot be read as bounded JSON: ${continuationReason(error)}`,
    };
  }
  if (!isRecordTransaction(transaction, expectedSchemaVersion)) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction has an unsupported or malformed schema.`,
    };
  }
  const oversizedRecord = transaction.writes.find((record) =>
    Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8") > MAX_RECORD_BYTES);
  if (oversizedRecord !== undefined) {
    return {
      valid: false,
      pending: true,
      detail: `Continuation ${versionLabel} transaction contains a record over its ${String(MAX_RECORD_BYTES)} byte safety limit: ${oversizedRecord.continuationId}.`,
    };
  }
  return {
    valid: true,
    pending: true,
    transaction,
    detail: `An interrupted durable ${versionLabel} transaction is present and will be completed idempotently by the state owner.`,
  };
}

function continuationOwnershipError(
  info: Awaited<ReturnType<typeof lstat>>,
  label: string,
  expectedMode: number,
): string | undefined {
  if (typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) {
    return `Continuation ${label} is not owned by the current user.`;
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== expectedMode) {
    return `Continuation ${label} permissions must be ${expectedMode.toString(8)}.`;
  }
  return undefined;
}

function isContinuationLedger(value: unknown): value is {
  readonly schemaVersion: number;
  readonly records: Record<string, unknown>;
} {
  return isStoreFile(value);
}

function isContinuationStoreManifest(
  value: unknown,
  schemaVersion: number,
  format: "per-record-v2" | "per-record-v3",
): value is {
  readonly schemaVersion: number;
  readonly generation: string;
  readonly updatedAt: string;
  readonly rollbackGuardRequired?: boolean;
  readonly stats: {
    readonly records: number;
    readonly active: number;
    readonly unresolvedDelivery: number;
    readonly deadLettered: number;
    readonly historyDegraded: number;
    readonly terminalTombstones: number;
    readonly compacted: number;
    readonly capturedText: number;
    readonly limits: {
      readonly terminalMaxRecords: number;
      readonly terminalMaxAgeMs: number;
      readonly capturedTextMaxRecords: number;
      readonly capturedTextMaxAgeMs: number;
    };
  };
} {
  if (!isDoctorObject(value)
    || value.schemaVersion !== schemaVersion
    || !isDurableGeneration(value.generation)
    || !requiredDate(value.updatedAt)
    || (value.rollbackGuardRequired !== undefined && typeof value.rollbackGuardRequired !== "boolean")
    || !isDoctorObject(value.stats)
    || value.stats.format !== format
    || !isDoctorObject(value.stats.limits)) return false;
  return [
    value.stats.records,
    value.stats.active,
    value.stats.unresolvedDelivery,
    value.stats.deadLettered,
    value.stats.historyDegraded,
    value.stats.terminalTombstones,
    value.stats.compacted,
    value.stats.capturedText,
    value.stats.limits.terminalMaxRecords,
    value.stats.limits.terminalMaxAgeMs,
    value.stats.limits.capturedTextMaxRecords,
    value.stats.limits.capturedTextMaxAgeMs,
  ].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0);
}

function isDoctorObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function continuationFsCode(error: unknown): string | undefined {
  return isDoctorObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function continuationReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatContinuationHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

interface AdapterEndpointRequirement {
  readonly label: string;
  readonly tools: readonly string[];
  readonly url: string;
}

/**
 * Adapter-send tools run in a stdio MCP child governed by the native SRT
 * policy. Channel readiness alone therefore is not enough: the child also
 * needs the remote adapter API (or the app-owned interaction bridge) admitted
 * by sandbox.network.
 */
async function adapterSendToolNetworkPolicyWarnings(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
  settings: Awaited<ReturnType<typeof resolveAdapterSendToolsSettings>>,
  suppressInteractionTools: boolean,
): Promise<readonly string[]> {
  if (config.sandbox === undefined || config.sandbox.mode !== "native") {
    return [];
  }

  const toolNames = settings === undefined ? [] : adapterSendToolNames(settings);
  const requirements: AdapterEndpointRequirement[] = [];
  if (settings?.slack !== undefined) {
    requirements.push({
      label: "Slack adapter-send API",
      tools: ["SlackSendMessage"],
      url: "https://slack.com/api",
    });
  }
  if (settings?.telegram !== undefined) {
    requirements.push({
      label: "Telegram adapter-send API",
      tools: toolNames.filter((name) => name.startsWith("Telegram")),
      url: settings.telegram.apiRoot ?? "https://api.telegram.org",
    });
  }

  const askUserAllowed = !suppressInteractionTools && isAdapterSendToolAllowed("AskUser", {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
  });
  const bridgeTools = [
    ...(askUserAllowed ? ["AskUser"] : []),
  ];
  if (bridgeTools.length > 0) {
    const configuredBridgeUrl = input.env.MONO_AGENT_INTERACTION_BRIDGE_URL?.trim();
    const interaction = await loadInteractionSettings(input);
    const bridgeUrl = configuredBridgeUrl === undefined || configuredBridgeUrl.length === 0
      ? formatInteractionBridgeUrl(interaction.host, interaction.port)
      : configuredBridgeUrl;
    requirements.push({ label: "AskUser interaction bridge", tools: bridgeTools, url: bridgeUrl });
  }

  return requirements.flatMap((requirement) => {
    if (adapterSendChildNetworkAllowsUrl(config, requirement.url)) {
      return [];
    }
    const host = endpointHost(requirement.url);
    const allowlistHost = host === "::1" ? "localhost" : host;
    return [
      `Native sandbox network policy blocks ${requirement.label} host "${host}", required by ${requirement.tools.join(", ")}. ` +
        `Set sandbox.network.mode to "allowlist" and add "${allowlistHost}" to sandbox.network.allowlist, ` +
        `or disable ${requirement.tools.join(", ")}.`,
    ];
  });
}

function adapterSendChildNetworkAllowsUrl(config: MonoAgentConfig, url: string): boolean {
  if (networkPolicyAllowsUrl(config.sandbox, url)) return true;
  if (config.sandbox?.mode !== "native" || config.sandbox.network.mode !== "allowlist") return false;
  const host = endpointHost(url);
  return isLoopbackEndpointHost(host) && config.sandbox.network.allowlist.some(isLoopbackEndpointHost);
}

function isLoopbackEndpointHost(host: string): boolean {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
}

function endpointHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return url;
  }
}

function effectiveMcpRuntimeSources(
  config: MonoAgentConfig,
  configuredMcpServerNames: readonly string[],
  adapterToolNames: readonly string[],
): string[] {
  const sources: string[] = [];
  if (configuredMcpServerNames.length > 0) {
    sources.push(`tools.mcpConfigPath (${configuredMcpServerNames.join(", ")})`);
  }
  if (config.memory?.recallTool?.enabled === true) {
    sources.push("memory.recallTool");
  }
  if (
    config.memory?.backend === "supermemory"
    && config.memory.supermemory?.exposeMcpServer === true
    && config.memory.supermemory.apiKey !== undefined
  ) {
    sources.push("memory.supermemory.exposeMcpServer");
  }
  if (adapterToolNames.length > 0) {
    sources.push(`adapter send tools (${adapterToolNames.join(", ")})`);
  }
  return sources;
}

async function sandboxSection(config: MonoAgentConfig, engine?: SandboxEngine): Promise<ValidationSection> {
  const runtimeModels = configuredRuntimeModels(config.runtime);
  const directCodexRefs = runtimeModels
    .filter((model) => model.sdk === "codex")
    .map((model) => model.reference ?? `codex:${model.model}`);
  const claudeRefs = runtimeModels
    .filter((model) => model.sdk === "claude")
    .map((model) => model.reference ?? `claude:${model.model}`);
  const directOpenCodeRefs = runtimeModels
    .filter((model) => model.sdk === "opencode")
    .map((model) => model.reference ?? `opencode:${model.provider ?? "unknown"}:${model.model}`);
  const routeSafety = config.runtime.routeSafety ?? "uniform";
  if (routeSafety === "per-route-native") {
    const monoSandboxActive = config.sandbox !== undefined && config.sandbox.mode !== "off";
    const piRoutes = runtimeModels.filter((model) => model.sdk === "pi");
    const details = runtimeModels.map((model, index) => routeNativeSafetyDetail(model, index, config));
    let status: ValidationStatus = !monoSandboxActive && piRoutes.length > 0 ? "disabled" : "ok";
    if (monoSandboxActive && piRoutes.length > 0) {
      const state = await resolveSandboxEffectiveState({
        policy: config.sandbox!,
        ...(engine === undefined ? {} : { engine }),
      });
      const warning = sandboxEffectiveStateWarning(state);
      details.push(
        `Pi route SRT policy: mode ${config.sandbox!.mode}, network ${config.sandbox!.network.mode}, fallback ${config.sandbox!.fallback}.`,
        describeSandboxEffectiveState(state),
        ...(warning === undefined ? [] : [warning]),
      );
      if (warning !== undefined || state.effective === "blocked") status = "waiting";
    } else if (piRoutes.length > 0) {
      details.push(
        "Pi route SRT policy: disabled; Bash and stdio MCP subprocesses run unsandboxed.",
      );
    } else if (monoSandboxActive) {
      details.push(
        "The configured mono-agent SRT policy has no Pi route to enforce it; provider-owned route contracts below apply instead.",
      );
      status = "waiting";
    }
    if (monoSandboxActive && runtimeModels.some((model) => model.sdk !== "pi")) {
      details.push(
        "[WARN] Per-route-native explicitly does not project mono-agent readableRoots, writableRoots, denyWrite, or network rules onto non-Pi routes; review each route contract before start.",
      );
      status = "waiting";
    }
    if (runtimeModels.some((model) => model.sdk === "codex") && config.runtime.permissionMode === "bypassPermissions") {
      status = "waiting";
    }
    return { id: "sandbox", label: "Sandbox", status, details };
  }
  const incompatibleDetails: string[] = [];
  if (config.sandbox !== undefined && config.sandbox.mode !== "off" && directCodexRefs.length > 0) {
    const codexPosture = directCodexSandboxPosture(config.runtime.permissionMode);
    incompatibleDetails.push(
      `Native mono-agent sandbox policy cannot govern direct Codex runtime${directCodexRefs.length === 1 ? "" : "s"}: ${directCodexRefs.join(", ")}.`,
      `${codexPosture.detail} Remove the mono-agent sandbox block or use Pi when exact srt roots, denyWrite, or network policy are required.`,
    );
  }
  if (config.sandbox !== undefined && config.sandbox.mode !== "off" && claudeRefs.length > 0) {
    incompatibleDetails.push(
      `Native mono-agent sandbox policy cannot govern Claude runtime${claudeRefs.length === 1 ? "" : "s"}: ${claudeRefs.join(", ")}.`,
      "Claude's provider-owned tool loop does not consume mono-agent sandboxPolicy. Set sandbox.mode to off, remove the sandbox block, or use a Pi runtime when mono-agent srt enforcement is required.",
    );
  }
  if (config.sandbox !== undefined && config.sandbox.mode !== "off" && directOpenCodeRefs.length > 0) {
    incompatibleDetails.push(
      `Native mono-agent sandbox policy cannot govern direct OpenCode runtime${directOpenCodeRefs.length === 1 ? "" : "s"}: ${directOpenCodeRefs.join(", ")}.`,
      "Direct OpenCode's provider-owned tool loop does not consume mono-agent sandboxPolicy. Set sandbox.mode to off, remove the sandbox block, or use a pi:opencode-go:* runtime when mono-agent srt enforcement is required.",
    );
  }
  if (incompatibleDetails.length > 0) {
    return {
      id: "sandbox",
      label: "Sandbox",
      status: "error",
      details: incompatibleDetails,
    };
  }
  if (directCodexRefs.length > 0 && (config.sandbox === undefined || config.sandbox.mode === "off")) {
    const posture = directCodexSandboxPosture(config.runtime.permissionMode);
    return {
      id: "sandbox",
      label: "Sandbox",
      status: posture.status,
      details: [
        posture.detail,
        config.sandbox === undefined
          ? "No mono-agent native srt policy is configured."
          : "The mono-agent native srt policy is explicitly off; the Codex-native posture still applies.",
      ],
    };
  }
  if (config.sandbox === undefined) {
    return { id: "sandbox", label: "Sandbox", status: "disabled", details: ["No sandbox policy configured."] };
  }
  const state = await resolveSandboxEffectiveState({
    policy: config.sandbox,
    ...(engine === undefined ? {} : { engine }),
  });
  const warning = sandboxEffectiveStateWarning(state);
  const details = [
    `Mode: ${config.sandbox.mode}, network: ${config.sandbox.network.mode}, fallback: ${config.sandbox.fallback}.`,
    describeSandboxEffectiveState(state),
    ...(warning === undefined ? [] : [warning]),
  ];
  const status: ValidationStatus = warning !== undefined
    ? "waiting"
    : state.effective === "off"
      ? "disabled"
      : state.effective === "blocked"
        ? "waiting"
      : "ok";
  return {
    id: "sandbox",
    label: "Sandbox",
    status,
    details,
  };
}

function routeNativeSafetyDetail(
  model: RuntimeModelReference,
  index: number,
  config: MonoAgentConfig,
): string {
  const label = index === 0 ? "Primary" : `Fallback ${index}`;
  const ref = referenceOf(model);
  if (model.sdk === "pi") {
    if (config.sandbox === undefined || config.sandbox.mode === "off") {
      return `${label} ${ref}: Pi-owned tools use mono-agent tool policy; SRT is disabled, so Bash and stdio MCP subprocesses run unsandboxed.`;
    }
    if (config.sandbox.fallback === "unsafe-host-process") {
      return `${label} ${ref}: Pi-owned tools use the configured mono-agent SRT policy; its explicit unsafe-host-process fallback can run subprocesses unsandboxed when SRT is unavailable.`;
    }
    return `${label} ${ref}: Pi-owned tools use the configured mono-agent SRT policy and fail closed when it is unavailable.`;
  }
  if (model.sdk === "claude") {
    return `${label} ${ref}: Claude provider-owned permissions apply; mono-agent SRT filesystem/network rules are not projected.`;
  }
  if (model.sdk === "codex") {
    return `${label} ${ref}: ${directCodexSandboxPosture(config.runtime.permissionMode).detail}`;
  }
  return `${label} ${ref}: OpenCode provider-owned execution with exact allow-all tool policy applies; mono-agent SRT rules are not projected.`;
}

function directCodexSandboxPosture(permissionMode: MonoAgentConfig["runtime"]["permissionMode"]): {
  readonly status: ValidationStatus;
  readonly detail: string;
} {
  if (permissionMode === "bypassPermissions") {
    return {
      status: "waiting",
      detail: "[WARN] Direct Codex bypassPermissions uses native danger-full-access with no filesystem or network sandbox; unattended approval prompts are still disabled.",
    };
  }
  if (permissionMode === "plan") {
    return {
      status: "ok",
      detail: "Direct Codex plan mode uses its native read-only sandbox with network disabled; unattended escalation requests are denied.",
    };
  }
  return {
    status: "ok",
    detail: "Direct Codex default/acceptEdits mode uses its native workspace-write sandbox with network disabled; unattended escalation requests are denied.",
  };
}


async function channelSection(
  driver: ChannelDriver,
  input: MonoAgentAppConfigInput,
): Promise<ValidationSection> {
  const id = `channel:${driver.id}`;
  try {
    const config = await driver.loadConfig(input);
    const disabledReason = driver.disabledReason?.(config);
    if (disabledReason !== undefined) {
      return { id, label: driver.label, status: "disabled", details: [disabledReason] };
    }
    const waitingReason = driver.waitingReason?.(config);
    if (waitingReason !== undefined) {
      return { id, label: driver.label, status: "waiting", details: [waitingReason] };
    }
    // A structural issue (e.g. a typo'd per-trigger model override) fails
    // validate loudly here; `start` still runs the channel and warn-ignores
    // the bad value at run time.
    const issues = driver.configIssues?.(config) ?? [];
    if (issues.length > 0) {
      return { id, label: driver.label, status: "error", details: [...issues] };
    }
    return { id, label: driver.label, status: "ok", details: ["Configured; will start with the app."] };
  } catch (error) {
    if (driver.isConfigError(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      return { id, label: driver.label, status: "waiting", details: [reason] };
    }
    throw error;
  }
}

function referenceOf(model: RuntimeModelReference): string {
  return modelReferenceKey(model);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
