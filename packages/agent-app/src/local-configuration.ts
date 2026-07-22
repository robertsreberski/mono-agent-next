import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import {
  CONFIG_ENV_KEYS,
  readMonoAgentConfigJson,
  type MonoAgentConfig,
  type MonoAgentConfigJson,
} from "@mono-agent/config";
import type {
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
} from "@mono-agent/agent-harness";
import { createToolPolicy } from "@mono-agent/agent-harness";
import type {
  ConfigurationProposalCard,
  ConfigurationProposalResult,
  TuiConfigurationController,
} from "@mono-agent/tui";

import { loadAppCoreConfig } from "./app-config.js";
import { ADAPTER_SEND_TOOLS_MCP_SERVER_NAME } from "./adapter-send-tools.js";
import {
  captureBackgroundSnapshot,
} from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import { createConfiguredAgentResponder } from "./configured-agent.js";
import {
  CONFIGURATION_PROPOSAL_MCP_SERVER_NAME,
  CONFIGURATION_PROPOSAL_TOOL_NAME,
  configurationProposalMcpServerSpec,
  containsUnsafeConfigurationReviewControl,
  type AgentConfigurationProposal,
  type JsonPatchOperation,
} from "./configuration-proposal-tool.js";
import { validateMonoAgentFolder } from "./doctor.js";
import { ADAPTER_SEND_TOOL_NAMES, canonicalToolName } from "./modules/known-tools.js";
import { RUN_HISTORY_MCP_SERVER_NAME, RUN_HISTORY_TOOL_NAME } from "./run-history.js";
import { configuredRuntimeFallbackModels } from "./runtime-routes.js";

export const LOCAL_CONFIGURATION_PROMPT =
  "Begin the dedicated self-configuration session. This is not ordinary chat. Read the mono-agent-configure skill. In the first assistant message, identify the session as SELF-CONFIG and show one compact, user-led map of every capability area: identity and knowledge; runtime and models; skills, tools, MCP servers, and plugins; memory; channels, APIs, and A2A; automation and proactive work; security, sandboxing, and secrets; observability and operations; and acceptance criteria. Explain that the conversation can build a workflow from trigger → context/data → tools/actions → delivery → memory → safety/operations → success checks. State that secrets must never be entered, every file change requires a separate host-owned approval, and approval, rejection, done, or no changes keeps SELF-CONFIG active. Only /quit, /exit, or ctrl+c twice exits this session; quitting never sends a background stop request. Invite the operator to choose an area or describe the workflow they want, using one concise question. Do not repeat the setup wizard and do not overwhelm the operator with a questionnaire. The session may use multiple turns: ask one focused question at a time, and record one minimal coherent proposal with ProposeAgentConfiguration only when enough information is available. It is valid to explain or ask the next question without proposing a change. Never execute ordinary tasks with configuration authority or claim a proposal was applied; the local host validates proposals and asks for separate approval.";

export const LOCAL_CONFIGURATION_OPERATOR_PROMPT =
  "Continue the dedicated SELF-CONFIG conversation. The capability map and opening invitation were already shown: do not repeat them. Read the mono-agent-configure skill and use the existing conversation plus any host outcome below. Help the operator shape a usable workflow across trigger → context/data → tools/actions → delivery → memory → safety/operations → success checks. Take one conversational step: ask at most one focused question, explain the relevant supported or guided path, or, when the request is decision-complete, record one minimal coherent proposal with ProposeAgentConfiguration. A turn without a proposal is expected while exploring. After a host-applied or rejected proposal, continue with the next relevant area instead of handing off to ordinary chat. Never ask for secrets, execute an ordinary task with configuration authority, or claim a proposal was applied.";

const CONFIGURATION_READ_ONLY_TOOLS = [
  "ReadSkill",
  "MemoryRecall",
  CONFIGURATION_PROPOSAL_TOOL_NAME,
  `mcp__${CONFIGURATION_PROPOSAL_MCP_SERVER_NAME}__${CONFIGURATION_PROPOSAL_TOOL_NAME}`,
] as const;

type DisposableResponder = AgentResponder & { dispose?(): Promise<void> };

export interface ConfigurationBackgroundConnection {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export type ConfigurationBackgroundRestartResult =
  | { readonly ok: true; readonly connection: ConfigurationBackgroundConnection }
  | { readonly ok: false; readonly message: string };

export type RestartConfigurationBackground = (
  expectedSnapshot: BackgroundSnapshot,
) => Promise<ConfigurationBackgroundRestartResult>;

interface PreparedProposal {
  readonly proposal: AgentConfigurationProposal;
  readonly candidate: MonoAgentConfigJson;
  readonly expectedConfigVersion: string;
  readonly configBefore: string;
  readonly rolePath?: string;
  readonly roleBefore?: string;
  readonly roleAfter?: string;
  readonly expectedRoleHash?: string;
  readonly card: ConfigurationProposalCard;
}

interface AppliedConfigurationChange {
  readonly changeId: string;
  readonly rollbackDir: string;
  readonly snapshot: BackgroundSnapshot;
  rollback(): Promise<BackgroundSnapshot>;
}

export interface LocalConfigurationSession {
  readonly responder: AgentResponder;
  readonly title: string;
  dispose(): Promise<void>;
}

export interface CreateLocalConfigurationSessionOptions {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly configure?: boolean;
  readonly envFile?: string;
  /** Deterministic transaction-race seam for regression tests. */
  readonly beforeSnapshotCapture?: (phase: "apply" | "rollback") => void | Promise<void>;
}

export interface CreateRemoteConfigurationSessionOptions extends CreateLocalConfigurationSessionOptions {
  readonly restartBackground: RestartConfigurationBackground;
  /** Deterministic failure seam for capability-rotation regression tests. */
  readonly beforeRotateAttempt?: () => void | Promise<void>;
}

export interface RemoteConfigurationSession {
  readonly configuration: TuiConfigurationController;
  dispose(): Promise<void>;
}

/** Build a current-folder responder for ordinary embedded chat only. */
export async function createLocalConfigurationSession(
  options: CreateLocalConfigurationSessionOptions,
): Promise<LocalConfigurationSession> {
  if (options.configure === true) {
    throw new Error("Self-configuration must attach to the authoritative background agent; use `mono-agent tui --configure` without `--local`.");
  }
  const authenticated = await authenticatedLocalConfig(options.cwd, options.configPath);
  const secureOptions = { ...options, ...authenticated };
  const config = await loadAppCoreConfig(secureOptions);
  const responder = await createConfiguredAgentResponder({ config }) as DisposableResponder;
  return {
    responder,
    title: config.agent?.name ?? "Mono Agent",
    async dispose(): Promise<void> {
      await responder.dispose?.();
    },
  };
}

/**
 * Create the local host controller for a remote configuration conversation.
 * The daemon only proposes; this process validates, confirms, writes, restarts,
 * proves readiness, and rolls back on failure.
 */
export async function createRemoteConfigurationSession(
  options: CreateRemoteConfigurationSessionOptions,
): Promise<RemoteConfigurationSession> {
  // `runTui` reconstructs the managed worker's dotenv-plus-operational
  // environment once, before discovery and launchd/source verification. Reuse
  // that exact snapshot here: a second dotenv read would open a TOCTOU window
  // and could make proposal validation/restart authority disagree with the
  // already-proven background worker.
  const manager = await LocalConfigurationManager.create(options);
  return {
    configuration: {
      get sessionId() {
        return manager.sessionId;
      },
      conversationId: `tui-configuration-${randomUUID()}`,
      roleLocation: manager.roleLocation,
      initialPrompt: LOCAL_CONFIGURATION_PROMPT,
      prompt: LOCAL_CONFIGURATION_PROMPT,
      operatorPrompt: LOCAL_CONFIGURATION_OPERATOR_PROMPT,
      takeProposal: async () => {
        let proposal: ConfigurationProposalCard | undefined;
        try {
          proposal = await manager.takeProposal();
        } catch (error) {
          const rotationWarning = await rotateAttemptSafely(manager, options.beforeRotateAttempt);
          if (rotationWarning !== undefined) {
            throw new Error(`${reasonOf(error)} ${rotationWarning}`);
          }
          throw error;
        }
        if (proposal === undefined) {
          const rotationWarning = await rotateAttemptSafely(manager, options.beforeRotateAttempt);
          if (rotationWarning !== undefined) throw new Error(rotationWarning);
        }
        return proposal;
      },
      approve: async (id) => {
        return await settleConfigurationAttempt(
          manager,
          () => approveAndRestart(manager, id, options.restartBackground),
          options.beforeRotateAttempt,
        );
      },
      reject: async (id) => {
        return await settleConfigurationAttempt(
          manager,
          () => manager.reject(id),
          options.beforeRotateAttempt,
        );
      },
      abandon: async () => {
        const rotationWarning = await rotateAttemptSafely(manager, options.beforeRotateAttempt);
        if (rotationWarning !== undefined) throw new Error(rotationWarning);
      },
    },
    async dispose(): Promise<void> {
      await manager.dispose();
    },
  };
}

async function settleConfigurationAttempt(
  manager: LocalConfigurationManager,
  task: () => Promise<ConfigurationProposalResult>,
  beforeRotateAttempt?: () => void | Promise<void>,
): Promise<ConfigurationProposalResult> {
  let result: ConfigurationProposalResult | undefined;
  let taskError: unknown;
  try {
    result = await task();
  } catch (error) {
    taskError = error;
  }

  const rotationWarning = await rotateAttemptSafely(manager, beforeRotateAttempt);
  if (taskError !== undefined) {
    if (rotationWarning !== undefined) {
      throw new Error(`${reasonOf(taskError)} ${rotationWarning}`);
    }
    throw taskError;
  }
  if (result === undefined) {
    throw new Error("Configuration attempt finished without a host result.");
  }
  return rotationWarning === undefined
    ? result
    : { ...result, message: `${result.message} ${rotationWarning}` };
}

async function rotateAttemptSafely(
  manager: LocalConfigurationManager,
  beforeRotateAttempt?: () => void | Promise<void>,
): Promise<string | undefined> {
  try {
    await beforeRotateAttempt?.();
    await manager.rotateAttempt();
    return undefined;
  } catch (error) {
    await manager.disableConfigurationAttempts(error);
    return (
      `Warning: the completed configuration capability could not be rotated (${reasonOf(error)}). ` +
      "Self-configuration cannot continue safely in this console; quit it and run `mono-agent tui --configure` again."
    );
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function approveAndRestart(
  manager: LocalConfigurationManager,
  id: string,
  restartBackground: RestartConfigurationBackground,
): Promise<ConfigurationProposalResult> {
  const applied = await manager.apply(id);
  const attempted = await safeRestart(restartBackground, applied.snapshot);
  if (attempted.ok) {
    return {
      kind: "applied",
      connection: attempted.connection,
      message:
        `Configuration applied and the background agent restarted successfully. Self-configuration remains active. ` +
        `Rollback evidence: ${applied.rollbackDir}`,
    };
  }

  try {
    const restoredSnapshot = await applied.rollback();
    const recovered = await safeRestart(restartBackground, restoredSnapshot);
    if (recovered.ok) {
      return {
        kind: "rolled_back",
        connection: recovered.connection,
        message:
          `The new configuration could not start, so the approved files were restored and the previous background agent was restarted. ` +
          `Self-configuration remains active. ${attempted.message} Rollback evidence: ${applied.rollbackDir}`,
      };
    }
    return {
      kind: "error",
      message:
        `The new configuration could not start. The approved files were restored, but the previous background agent also failed to restart. ` +
        `${attempted.message} Recovery attempt: ${recovered.message} Manual recovery is required. ` +
        `Rollback evidence: ${applied.rollbackDir}`,
    };
  } catch (error) {
    return {
      kind: "error",
      message:
        `The new configuration could not start, and automatic file rollback also failed: ` +
        `${error instanceof Error ? error.message : String(error)} ${attempted.message} ` +
        `Manual recovery is required. Rollback evidence: ${applied.rollbackDir}`,
    };
  }

}

async function safeRestart(
  restart: RestartConfigurationBackground,
  expectedSnapshot: BackgroundSnapshot,
): Promise<ConfigurationBackgroundRestartResult> {
  try {
    return await restart(expectedSnapshot);
  } catch (error) {
    return {
      ok: false,
      message: `Background restart failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ConfigurationRuntimeExtensionOptions {
  readonly cwd: string;
  /** Canonical mutable path used only to authenticate this agent folder/capability root. */
  readonly configPath: string;
  /** Immutable worker copy used for route classification and proposal base version. */
  readonly configReadPath?: string;
  readonly env: Record<string, string | undefined>;
}

/** Install proposal-only authority on explicitly capability-marked TUI requests. */
export function createLocalConfigurationRuntimeExtension(
  options: ConfigurationRuntimeExtensionOptions,
): (input: AgentHarnessRuntimeOptionsInput) => Promise<AgentHarnessRuntimeOptionsExtension> {
  return async (input) => {
    const request = configurationRequestFromMetadata(input.request.metadata);
    if (request === undefined) return { runtimeOptions: {} };

    const authenticated = await authenticatedLocalConfig(options.cwd, options.configPath);
    const sessionDir = await resolveOwnedDirectoryInside(
      authenticated.cwd,
      join(authenticated.cwd, ".mono-agent", "configuration-proposals", `session-${request.sessionId}`),
      "Configuration proposal session",
    );
    const configReadPath = options.configReadPath ?? authenticated.configPath;
    const config = await loadAppCoreConfig({
      cwd: authenticated.cwd,
      configPath: configReadPath,
      env: options.env,
    });
    const route = configurationRuntimeRoute(config);
    const allRoutesUseDirectCodex = route.models.every((model) => model.sdk === "codex");
    const runtimeOptions = {
      permissionMode: "plan" as const,
      ...(route.modelOverride === undefined ? {} : { model: route.modelOverride }),
    };
    if (request.phase === "invitation") {
      return {
        toolPolicyOverride: createToolPolicy({
          allowedTools: allRoutesUseDirectCodex ? ["*"] : ["ReadSkill", "MemoryRecall"],
          disallowedTools: [],
          mcpServers: {},
        }),
        runtimeOptions,
      };
    }

    const snapshot = await readMonoAgentConfigJson(configReadPath);
    const sinkPath = join(sessionDir, `proposal-${safeFilePart(input.runId)}.json`);
    const proposalServer = configurationProposalMcpServerSpec({
      sinkPath,
      baseVersion: snapshot.version,
    }, authenticated.cwd);
    return {
      toolPolicyOverride: createToolPolicy({
        allowedTools: allRoutesUseDirectCodex ? ["*"] : CONFIGURATION_READ_ONLY_TOOLS,
        disallowedTools: [],
        mcpServers: {
          [CONFIGURATION_PROPOSAL_MCP_SERVER_NAME]: proposalServer,
        },
      }),
      runtimeOptions,
    };
  };
}

function configurationRuntimeRoute(config: MonoAgentConfig): {
  readonly models: readonly MonoAgentConfig["runtime"]["model"][];
  readonly modelOverride?: MonoAgentConfig["runtime"]["model"];
} {
  const fallbacks = configuredRuntimeFallbackModels(config.runtime);
  const directOpenCodeFallbacks = fallbacks.filter((model) => model.sdk === "opencode");
  if (config.runtime.model.sdk !== "opencode") {
    if (directOpenCodeFallbacks.length > 0) {
      throw new Error(
        "Self-configuration is unavailable while the fallback chain contains direct OpenCode. " +
        "Its provider-owned tool loop cannot receive the host-owned proposal MCP capability, so a failover could silently lose the proposal. " +
        "Use a Pi route such as pi:opencode-go:<model>, or remove the direct opencode:* fallback before running /configure.",
      );
    }
    return { models: [config.runtime.model, ...fallbacks] };
  }

  const supported = fallbacks.find((model) => model.sdk !== "opencode");
  if (supported === undefined || directOpenCodeFallbacks.length > 0) {
    throw new Error(
      "Self-configuration cannot use direct OpenCode's provider-owned tool loop because it cannot receive the host-owned proposal MCP capability. " +
      "Add a proposal-capable fallback such as pi:opencode-go:<model>, or switch the primary runtime before running /configure.",
    );
  }
  const remaining = fallbacks.filter((model) => model !== supported);
  return {
    modelOverride: supported,
    models: [supported, ...remaining],
  };
}

export class LocalConfigurationManager {
  readonly currentConfig: MonoAgentConfig;
  readonly roleLocation: string;
  private readonly prepared = new Map<string, PreparedProposal>();
  private readonly cleanupPaths = new Set<string>();
  private currentSessionId: string;
  private currentSessionDir: string;
  private disabledReason: string | undefined;

  private constructor(
    private readonly options: CreateLocalConfigurationSessionOptions,
    private readonly proposalRoot: string,
    sessionDir: string,
    sessionId: string,
    currentConfig: MonoAgentConfig,
  ) {
    this.currentSessionId = sessionId;
    this.currentSessionDir = sessionDir;
    this.cleanupPaths.add(sessionDir);
    this.currentConfig = currentConfig;
    this.roleLocation = formatRoleLocation(this.options.cwd, currentConfig.context.identityPath);
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  static async create(options: CreateLocalConfigurationSessionOptions): Promise<LocalConfigurationManager> {
    const authenticated = await authenticatedLocalConfig(options.cwd, options.configPath);
    const secureOptions = {
      ...options,
      cwd: authenticated.cwd,
      configPath: authenticated.configPath,
    };
    const parent = await ensureOwnedDirectoryInside(
      secureOptions.cwd,
      join(secureOptions.cwd, ".mono-agent", "configuration-proposals"),
      "Configuration proposal directory",
    );
    const sessionId = randomUUID();
    const sessionDir = join(parent, `session-${sessionId}`);
    await mkdir(sessionDir, { mode: 0o700 });
    await chmod(sessionDir, 0o700);
    const currentConfig = await loadAppCoreConfig(secureOptions);
    return new LocalConfigurationManager(secureOptions, parent, sessionDir, sessionId, currentConfig);
  }

  /** Revoke the completed attempt's opaque filesystem capability before issuing the next one. */
  async rotateAttempt(): Promise<void> {
    this.assertAttemptsEnabled();
    const previousDir = this.currentSessionDir;
    const revokedPath = join(this.proposalRoot, `.revoked-${randomUUID()}`);
    const sessionId = randomUUID();
    const sessionDir = join(this.proposalRoot, `session-${sessionId}`);
    try {
      const revoked = await resolveOwnedDirectoryInside(
        this.options.cwd,
        previousDir,
        "Configuration proposal session",
      );
      // Rename first: removing the exact `session-<capability>` path revokes
      // late model calls atomically even if recursive cleanup is interrupted.
      await rename(revoked, revokedPath);
      this.cleanupPaths.delete(previousDir);
      this.cleanupPaths.add(revokedPath);
      this.prepared.clear();

      await mkdir(sessionDir, { mode: 0o700 });
      this.cleanupPaths.add(sessionDir);
      await chmod(sessionDir, 0o700);
      this.currentSessionId = sessionId;
      this.currentSessionDir = sessionDir;
      // Proposal payloads are secret-rejected and owner-only; a cleanup failure
      // cannot restore the old capability path, so do not invalidate the newly
      // issued attempt if best-effort deletion loses a race with process exit.
      try {
        await rm(revokedPath, { recursive: true, force: true });
        this.cleanupPaths.delete(revokedPath);
      } catch {
        // The capability path is already atomically revoked. Keep the renamed
        // artifact registered so dispose() can retry best-effort cleanup.
      }
    } catch (error) {
      this.cleanupPaths.add(previousDir);
      this.cleanupPaths.add(revokedPath);
      this.cleanupPaths.add(sessionDir);
      await this.disableConfigurationAttempts(error);
      throw error;
    }
  }

  /** Poison the public capability id and best-effort remove every owned attempt path. */
  async disableConfigurationAttempts(error: unknown): Promise<void> {
    if (this.disabledReason === undefined) {
      this.disabledReason = reasonOf(error);
    }
    this.prepared.clear();
    const disabledId = randomUUID();
    this.currentSessionId = disabledId;
    // Deliberately do not create this path: future `/configure` metadata can no
    // longer name any existing proposal capability even when old cleanup fails.
    this.currentSessionDir = join(this.proposalRoot, `session-${disabledId}`);
    await Promise.all(
      [...this.cleanupPaths].map(async (path) => {
        try {
          await rm(path, { recursive: true, force: true });
          this.cleanupPaths.delete(path);
        } catch {
          // Keep failed paths registered so dispose() gets one final retry.
        }
      }),
    );
  }

  private assertAttemptsEnabled(): void {
    if (this.disabledReason !== undefined) {
      throw new Error(
        `Self-configuration continuation is disabled because the prior capability could not be rotated: ${this.disabledReason}`,
      );
    }
  }

  async takeProposal(): Promise<ConfigurationProposalCard | undefined> {
    this.assertAttemptsEnabled();
    const sessionDir = await resolveOwnedDirectoryInside(
      this.options.cwd,
      this.currentSessionDir,
      "Configuration proposal session",
    );
    const sinks = (await readdir(sessionDir))
      .filter((name) => /^proposal-[A-Za-z0-9._-]+\.json$/u.test(name))
      .sort();
    if (sinks.length === 0) return undefined;
    if (sinks.length > 1) {
      // Consume every well-formed sink name before failing closed. Otherwise a
      // single malformed/duplicate turn would permanently poison later
      // /configure attempts that reuse this owner-created capability session.
      for (const name of sinks) {
        const stale = await resolveOwnedRegularFileInside(
          this.options.cwd,
          join(sessionDir, name),
          "Configuration proposal payload",
        );
        await rm(stale);
      }
      throw new Error("The configuration conversation produced more than one proposal payload; nothing was applied.");
    }
    const sink = await resolveOwnedRegularFileInside(
      this.options.cwd,
      join(sessionDir, sinks[0]!),
      "Configuration proposal payload",
    );
    const contents = await readFile(sink, "utf8");
    await rm(sink);
    return await this.prepareProposal(parseProposal(contents));
  }

  async reject(id: string): Promise<ConfigurationProposalResult> {
    this.assertAttemptsEnabled();
    if (!this.prepared.delete(id)) {
      throw new Error(`Configuration proposal ${id} is no longer pending.`);
    }
    return {
      kind: "rejected",
      message: `Proposal rejected; no files changed. Self-configuration remains active.`,
    };
  }

  async prepareProposal(proposal: AgentConfigurationProposal): Promise<ConfigurationProposalCard> {
    this.assertAttemptsEnabled();
    const prepared = await this.prepare(proposal);
    this.prepared.set(proposal.id, prepared);
    return prepared.card;
  }

  private async prepare(proposal: AgentConfigurationProposal): Promise<PreparedProposal> {
    const secureConfig = await resolveOwnedRegularFileInside(this.options.cwd, this.options.configPath, "Config file");
    const current = await readMonoAgentConfigJson(secureConfig);
    if (proposal.baseVersion !== current.version) {
      throw new Error("Configuration changed while the agent was preparing its proposal. Run /configure again from the current config.");
    }
    assertProposalContainsNoSecrets(proposal, this.options.env);
    assertNoEnvironmentShadow(proposal.patch, this.options.env);

    const candidate = applyJsonPatch(current.json, proposal.patch);
    assertConversationalPatchAllowed(current.json, candidate);
    const configBefore = await readFile(secureConfig, "utf8");
    if (sha256(configBefore) !== current.version) {
      throw new Error("Configuration changed while the agent was preparing its proposal. Run /configure again from the current config.");
    }
    await this.validateCandidate(candidate, proposal.id);

    let rolePath: string | undefined;
    let roleBefore: string | undefined;
    let roleAfter: string | undefined;
    let expectedRoleHash: string | undefined;
    if (proposal.role !== undefined) {
      if (proposal.patch.some((operation) => pathsOverlap(operation.path, "/context/identityPath"))) {
        throw new Error("Change context.identityPath separately from a Role update so the host can verify one identity file at a time.");
      }
      const effective = await loadAppCoreConfig(this.options);
      rolePath = effective.context.identityPath;
      rolePath = await resolveOwnedRegularFileInside(this.options.cwd, rolePath, "Identity file");
      roleBefore = await readFile(rolePath, "utf8");
      expectedRoleHash = sha256(roleBefore);
      roleAfter = replaceRoleSection(roleBefore, proposal.role);
    }

    const details = proposal.patch.map(formatPatchOperation);
    if (proposal.role !== undefined && rolePath !== undefined) {
      details.push(`replace ${formatRoleLocation(this.options.cwd, rolePath)}`);
    }
    const card: ConfigurationProposalCard = {
      id: proposal.id,
      title: "Agent configuration proposal",
      rationale: proposal.rationale,
      details,
      ...(proposal.role === undefined || rolePath === undefined
        ? {}
        : {
            role: {
              location: formatRoleLocation(this.options.cwd, rolePath),
              proposedBody: normalizedRoleBody(proposal.role),
            },
          }),
    };
    return {
      proposal,
      candidate,
      expectedConfigVersion: current.version,
      configBefore,
      ...(rolePath === undefined ? {} : { rolePath }),
      ...(roleBefore === undefined ? {} : { roleBefore }),
      ...(roleAfter === undefined ? {} : { roleAfter }),
      ...(expectedRoleHash === undefined ? {} : { expectedRoleHash }),
      card,
    };
  }

  async apply(id: string): Promise<AppliedConfigurationChange> {
    this.assertAttemptsEnabled();
    const prepared = this.prepared.get(id);
    if (prepared === undefined) throw new Error(`Configuration proposal ${id} is no longer pending.`);

    return await withConfigurationTransactionLock(this.options.cwd, id, async () =>
      await this.applyPrepared(id, prepared));
  }

  private async applyPrepared(id: string, prepared: PreparedProposal): Promise<AppliedConfigurationChange> {
    await assertPreparedSourcesCurrent(this.options.cwd, this.options.configPath, prepared, "after the proposal was shown");
    await this.validateCandidate(prepared.candidate, `${id}-approval`);

    const changeId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${id.slice(0, 8)}`;
    const rollbackRoot = await ensureOwnedDirectoryInside(
      this.options.cwd,
      join(this.options.cwd, ".mono-agent", "config-changes"),
      "Configuration rollback directory",
    );
    const rollbackDir = await ensureOwnedDirectoryInside(
      this.options.cwd,
      join(rollbackRoot, changeId),
      "Configuration change directory",
    );
    await writeFile(join(rollbackDir, "mono-agent.config.json.before"), prepared.configBefore, { flag: "wx", mode: 0o600 });
    if (prepared.roleBefore !== undefined) {
      await writeFile(join(rollbackDir, "identity-document.before"), prepared.roleBefore, { flag: "wx", mode: 0o600 });
    }

    const configAfter = `${JSON.stringify(prepared.candidate, null, 2)}\n`;
    let configWritten = false;
    let roleWritten = false;
    let appliedSnapshot: BackgroundSnapshot | undefined;
    try {
      // Candidate validation and rollback-evidence staging both await I/O. A
      // second comparison at the actual commit boundary prevents either step
      // from opening a stale-snapshot overwrite window. The owner-only lock
      // serializes every mono-agent writer; the comparison also catches an
      // editor or other non-cooperating process.
      await assertPreparedSourcesCurrent(this.options.cwd, this.options.configPath, prepared, "while the approved change was being prepared");
      await atomicReplaceExact(this.options.cwd, this.options.configPath, prepared.configBefore, configAfter);
      configWritten = true;
      if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
        // Config and Role are two files, so re-check both sides after the first
        // rename and before the second. If either changed, the guarded catch
        // restores only files that still equal our exact committed bytes.
        await assertExactOwnedContents(this.options.cwd, this.options.configPath, configAfter, "Committed config changed before the Role update");
        await assertExactOwnedContents(this.options.cwd, prepared.rolePath, prepared.roleBefore!, "Configured identity document changed at the Role commit boundary");
        await atomicReplaceExact(this.options.cwd, prepared.rolePath, prepared.roleBefore!, prepared.roleAfter);
        roleWritten = true;
      }
      const verified = await readMonoAgentConfigJson(this.options.configPath);
      if (!isDeepStrictEqual(verified.json, prepared.candidate)) {
        throw new Error("The committed config did not verify byte-for-byte against the approved candidate.");
      }
      if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
        await assertExactOwnedContents(this.options.cwd, prepared.rolePath, prepared.roleAfter, "The committed Role did not verify");
      }
      await ensureOwnedDirectoryInside(this.options.cwd, rollbackDir, "Configuration change directory");
      await writeFile(join(rollbackDir, "change.json"), `${JSON.stringify({
        schema: "mono-agent.configuration-change.v1",
        changeId,
        proposalId: prepared.proposal.id,
        appliedAt: new Date().toISOString(),
        previousConfigVersion: prepared.expectedConfigVersion,
        configVersion: verified.version,
        changedPaths: prepared.proposal.patch.map((operation) => operation.path),
        roleChanged: prepared.roleAfter !== undefined,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await this.options.beforeSnapshotCapture?.("apply");
      appliedSnapshot = await this.captureCommittedSnapshot();
      await assertExactOwnedContents(
        this.options.cwd,
        this.options.configPath,
        configAfter,
        "Committed config changed while its approved background snapshot was captured",
      );
      if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
        await assertExactOwnedContents(
          this.options.cwd,
          prepared.rolePath,
          prepared.roleAfter,
          "Committed Role changed while its approved background snapshot was captured",
        );
      }
    } catch (error) {
      const recoveryErrors: string[] = [];
      if (roleWritten && prepared.rolePath !== undefined && prepared.roleAfter !== undefined && prepared.roleBefore !== undefined) {
        try {
          await restoreIfExact(this.options.cwd, prepared.rolePath, prepared.roleAfter, prepared.roleBefore);
        } catch (restoreError) {
          recoveryErrors.push(restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      }
      if (configWritten) {
        try {
          await restoreIfExact(this.options.cwd, this.options.configPath, configAfter, prepared.configBefore);
        } catch (restoreError) {
          recoveryErrors.push(restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      } else if (!roleWritten) {
        await rm(rollbackDir, { recursive: true, force: true });
      }
      if (recoveryErrors.length > 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Manual recovery is required; concurrent edits were preserved. ` +
          `${recoveryErrors.join(" ")} Rollback evidence: ${rollbackDir}`,
        );
      }
      throw error;
    }

    if (appliedSnapshot === undefined) {
      throw new Error("The approved configuration was not accompanied by an exact background snapshot.");
    }

    this.prepared.delete(id);
    return {
      changeId,
      rollbackDir,
      snapshot: appliedSnapshot,
      rollback: async () => {
        return await withConfigurationTransactionLock(this.options.cwd, `${id}-rollback`, async () => {
          await assertExactOwnedContents(this.options.cwd, this.options.configPath, configAfter, "Configuration changed before rollback");
          let roleRestored = false;
          if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
            await assertExactOwnedContents(this.options.cwd, prepared.rolePath, prepared.roleAfter, "Configured identity document changed before rollback");
            await atomicReplaceExact(this.options.cwd, prepared.rolePath, prepared.roleAfter, prepared.roleBefore!);
            roleRestored = true;
          }
          try {
            await atomicReplaceExact(this.options.cwd, this.options.configPath, configAfter, prepared.configBefore);
          } catch (error) {
            if (roleRestored && prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
              try {
                await atomicReplaceExact(this.options.cwd, prepared.rolePath, prepared.roleBefore!, prepared.roleAfter);
              } catch (compensationError) {
                throw new Error(
                  `${error instanceof Error ? error.message : String(error)} ` +
                  `Role compensation also failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)} ` +
                  `Concurrent edits were preserved; manual recovery is required. Rollback evidence: ${rollbackDir}`,
                );
              }
            }
            throw error;
          }
          await ensureOwnedDirectoryInside(this.options.cwd, rollbackDir, "Configuration change directory");
          await writeFile(join(rollbackDir, "rollback.json"), `${JSON.stringify({
            schema: "mono-agent.configuration-rollback.v1",
            changeId,
            rolledBackAt: new Date().toISOString(),
          }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          await this.options.beforeSnapshotCapture?.("rollback");
          const restoredSnapshot = await this.captureCommittedSnapshot();
          await assertExactOwnedContents(
            this.options.cwd,
            this.options.configPath,
            prepared.configBefore,
            "Restored config changed while its rollback background snapshot was captured",
          );
          if (prepared.rolePath !== undefined && prepared.roleBefore !== undefined) {
            await assertExactOwnedContents(
              this.options.cwd,
              prepared.rolePath,
              prepared.roleBefore,
              "Restored Role changed while its rollback background snapshot was captured",
            );
          }
          return restoredSnapshot;
        });
      },
    };
  }

  private async captureCommittedSnapshot(): Promise<BackgroundSnapshot> {
    return await captureBackgroundSnapshot({
      cwd: this.options.cwd,
      configPath: this.options.configPath,
      ...(this.options.envFile === undefined ? {} : { envFile: this.options.envFile }),
      env: this.options.env,
    });
  }

  private async validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void> {
    const sessionDir = await ensureOwnedDirectoryInside(
      this.options.cwd,
      this.currentSessionDir,
      "Configuration proposal session",
    );
    const path = join(sessionDir, `${safeFilePart(label)}.candidate.json`);
    await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
    try {
      const report = await validateMonoAgentFolder({
        cwd: this.options.cwd,
        configPath: path,
        env: this.options.env,
        allowFilesystemWrites: false,
        liveness: false,
      });
      const errors = report.sections.filter((section) => section.status === "error");
      if (errors.length > 0) {
        throw new Error(
          `Proposed configuration does not validate: ${errors.map((section) => `${section.label}: ${section.details.join(" ")}`).join("; ")}`,
        );
      }
      await loadAppCoreConfig({ cwd: this.options.cwd, configPath: path, env: this.options.env });
    } finally {
      await rm(path, { force: true });
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...new Set([...this.cleanupPaths, this.currentSessionDir])]
        .map((path) => rm(path, { recursive: true, force: true })),
    );
    this.cleanupPaths.clear();
  }
}

export function isLocalConfigurationRequest(metadata: Record<string, unknown> | undefined): boolean {
  return configurationRequestFromMetadata(metadata) !== undefined;
}

function configurationRequestFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { readonly sessionId: string; readonly phase: "invitation" | "operator" } | undefined {
  const tui = metadata?.tui;
  if (metadata?.source !== "tui" || typeof tui !== "object" || tui === null) return undefined;
  const record = tui as Record<string, unknown>;
  const sessionId = record.configurationSessionId;
  const phase = record.configurationPhase;
  return record.configuration === true
      && (phase === "invitation" || phase === "operator")
      && typeof sessionId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)
    ? { sessionId, phase }
    : undefined;
}

function parseProposal(contents: string): AgentConfigurationProposal {
  const parsed = JSON.parse(contents) as Partial<AgentConfigurationProposal>;
  if (
    parsed.schema !== "mono-agent.configuration-proposal.v1"
    || typeof parsed.id !== "string"
    || typeof parsed.baseVersion !== "string"
    || typeof parsed.rationale !== "string"
    || !Array.isArray(parsed.patch)
    || typeof parsed.createdAt !== "string"
    || (parsed.role !== undefined && typeof parsed.role !== "string")
  ) {
    throw new Error("The configuration proposal payload was malformed.");
  }
  return parsed as AgentConfigurationProposal;
}

export function applyJsonPatch(
  input: MonoAgentConfigJson,
  operations: readonly JsonPatchOperation[],
): MonoAgentConfigJson {
  const root = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  for (const operation of operations) {
    if (operation.path === "") throw new Error("Replacing the entire config document is not allowed.");
    const path = pointerSegments(operation.path);
    if (operation.op === "add") addValue(root, path, cloneJson(operation.value));
    else if (operation.op === "remove") removeValue(root, path);
    else if (operation.op === "replace") replaceValue(root, path, cloneJson(operation.value));
    else if (operation.op === "test") {
      if (!isDeepStrictEqual(getValue(root, path), operation.value)) {
        throw new Error(`JSON Patch test failed at ${operation.path}.`);
      }
    } else {
      if (operation.from === undefined) throw new Error(`${operation.op} requires from.`);
      const from = pointerSegments(operation.from);
      const value = cloneJson(getValue(root, from));
      if (operation.op === "move") removeValue(root, from);
      addValue(root, path, value);
    }
  }
  return root as MonoAgentConfigJson;
}

function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  const segments = pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new Error(`Unsafe JSON Pointer segment: ${segment}`);
    }
  }
  return segments;
}

function parentAt(root: Record<string, unknown>, segments: readonly string[]): { parent: Record<string, unknown> | unknown[]; key: string } {
  if (segments.length === 0) throw new Error("Root JSON Patch operations are not allowed.");
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment, current.length, false);
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`JSON Patch path does not exist: /${segments.join("/")}`);
    }
  }
  if (!Array.isArray(current) && !isRecord(current)) {
    throw new Error(`JSON Patch parent is not a container: /${segments.join("/")}`);
  }
  return { parent: current, key: segments.at(-1)! };
}

function addValue(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : arrayIndex(key, parent.length, true);
    parent.splice(index, 0, value);
  } else {
    parent[key] = value;
  }
}

function replaceValue(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) parent[arrayIndex(key, parent.length, false)] = value;
  else {
    if (!Object.hasOwn(parent, key)) throw new Error(`JSON Patch replace target does not exist: /${segments.join("/")}`);
    parent[key] = value;
  }
}

function removeValue(root: Record<string, unknown>, segments: readonly string[]): unknown {
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) return parent.splice(arrayIndex(key, parent.length, false), 1)[0];
  if (!Object.hasOwn(parent, key)) throw new Error(`JSON Patch remove target does not exist: /${segments.join("/")}`);
  const value = parent[key];
  delete parent[key];
  return value;
}

function getValue(root: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[arrayIndex(segment, current.length, false)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else throw new Error(`JSON Patch path does not exist: /${segments.join("/")}`);
  }
  return current;
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(segment)) throw new Error(`Invalid JSON Patch array index: ${segment}`);
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowEnd && index === length)) {
    throw new Error(`JSON Patch array index out of bounds: ${segment}`);
  }
  return index;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function assertProposalContainsNoSecrets(
  proposal: AgentConfigurationProposal,
  env: Record<string, string | undefined>,
): void {
  if (containsUnsafeConfigurationReviewControl(proposal.rationale)) {
    throw new Error("The proposal rationale contains unsafe terminal or bidi control characters. It was rejected.");
  }
  if (proposal.role !== undefined && containsUnsafeConfigurationReviewControl(proposal.role)) {
    throw new Error("The proposed Role contains unsafe terminal or bidi control characters. It was rejected.");
  }
  const secretValues = Object.entries(env)
    .filter(([name, value]) => /(?:api.?key|credential|password|secret|token)/iu.test(name) && (value?.length ?? 0) >= 4)
    .map(([, value]) => value!);
  for (const operation of proposal.patch) {
    if (secretBearingPointer(operation.path) || (operation.from !== undefined && secretBearingPointer(operation.from))) {
      throw new Error("Secret-bearing config fields cannot be proposed in chat. Use the masked mono-agent auth or owner-only .env flow.");
    }
    if (containsSecret(operation.value, secretValues)) {
      throw new Error("A proposal matched a configured secret value. It was rejected and will not be displayed or written.");
    }
  }
  if (containsSecret(proposal.rationale, secretValues) || containsSecretLikeValue(proposal.rationale)) {
    throw new Error("The proposal rationale appears to contain a secret. It was rejected.");
  }
  if (proposal.role !== undefined && containsSecret(proposal.role, secretValues)) {
    throw new Error("The proposed Role matched a configured secret value. It was rejected.");
  }
  if (proposal.role !== undefined && containsSecretLikeValue(proposal.role)) {
    throw new Error("The proposed Role appears to contain a secret. It was rejected.");
  }
}

function secretBearingPointer(pointer: string): boolean {
  return pointerSegments(pointer).some((segment) =>
    /(?:api.?key|credential|password|secret|token)/iu.test(segment) && !/(?:env|path)$/iu.test(segment)
  );
}

function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return secrets.some((secret) => value.includes(secret)) || containsSecretLikeValue(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secrets));
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) =>
      (/(?:api.?key|credential|password|secret|token)/iu.test(key) && !/(?:env|path)$/iu.test(key))
      || containsSecret(entry, secrets)
    );
  }
  return false;
}

function containsSecretLikeValue(value: string): boolean {
  return /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+\S{12,}|\d{6,12}:[A-Za-z0-9_-]{20,})\b/u.test(value);
}

function assertNoEnvironmentShadow(
  patch: readonly JsonPatchOperation[],
  env: Record<string, string | undefined>,
): void {
  const shadowed = Object.entries(CONFIG_ENV_KEYS).filter(([field, envKey]) => {
    if ((env[envKey]?.trim().length ?? 0) === 0) return false;
    const pointer = `/${field.split(".").join("/")}`;
    return patch.some((operation) =>
      pathsOverlap(operation.path, pointer)
      || (operation.from !== undefined && pathsOverlap(operation.from, pointer))
    );
  });
  if (shadowed.length > 0) {
    throw new Error(
      `The effective environment overrides this proposal (${shadowed.map(([field, key]) => `${field} via ${key}`).join(", ")}). ` +
      "Update or remove the durable environment override first, then run /configure again.",
    );
  }
}

/**
 * Conversational configuration deliberately exposes a small positive surface.
 * New schema fields therefore fail closed until they receive an explicit
 * safety decision here; everything involving paths, providers, credentials,
 * background work, network access, or sandbox policy stays in a guided flow.
 */
const CONVERSATIONAL_CONFIG_POINTERS = new Set([
  "/agent/name",
  "/runtime/effort",
  "/runtime/maxTurns",
  "/runtime/session/mode",
  "/runtime/session/idleTimeoutMs",
  "/runtime/session/rollover",
  "/runtime/session/rolloverTimezone",
  "/runtime/session/rolloverNotice",
  "/context/selectedSkills",
  "/context/skillMaxBytes",
  "/context/skillDisclosure",
  "/memory/maxBytes",
  "/memory/recallTool/enabled",
  "/tools/allowedTools",
  "/tools/disallowedTools",
]);

function assertConversationalPatchAllowed(
  before: MonoAgentConfigJson,
  after: MonoAgentConfigJson,
): void {
  const changed = changedJsonPointers(before, after);
  const unsupported = changed.filter((pointer) => !CONVERSATIONAL_CONFIG_POINTERS.has(pointer));
  if (unsupported.length > 0) {
    throw new Error(
      `Conversational configuration cannot change ${unsupported.join(", ")}. ` +
      "Paths, memory tiers or capture cost, providers/models/routes, embeddings endpoints, credentials, channels/cron/plugins, MCP, sandbox/network policy, exporters, and other new schema fields require the explicit guided flow.",
    );
  }
  if (toolAuthorityBroadened(before.tools, after.tools)) {
    throw new Error("Broader tool authority requires explicit guided confirmation outside the model conversation.");
  }
}

function changedJsonPointers(before: unknown, after: unknown, pointer = ""): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  const beforeObject = isRecord(before);
  const afterObject = isRecord(after);
  if (
    (beforeObject || before === undefined)
    && (afterObject || after === undefined)
    && (beforeObject || afterObject)
  ) {
    const keys = new Set([
      ...(beforeObject ? Object.keys(before) : []),
      ...(afterObject ? Object.keys(after) : []),
    ]);
    if (keys.size === 0) return [pointer || "/"];
    return [...keys].flatMap((key) => changedJsonPointers(
      beforeObject ? before[key] : undefined,
      afterObject ? after[key] : undefined,
      `${pointer}/${escapeJsonPointerSegment(key)}`,
    ));
  }
  return [pointer || "/"];
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function toolAuthorityBroadened(
  before: MonoAgentConfigJson["tools"],
  after: MonoAgentConfigJson["tools"],
): boolean {
  const beforeAllowed = (before?.allowedTools ?? ["*"]).map(normalizeToolPattern);
  const afterAllowed = (after?.allowedTools ?? ["*"]).map(normalizeToolPattern);
  const beforeDenied = (before?.disallowedTools ?? []).map(normalizeToolPattern);
  const afterDenied = (after?.disallowedTools ?? []).map(normalizeToolPattern);

  return afterAllowed.some((allowed) => {
    // A deny that covers the whole allow pattern leaves no effective authority.
    if (afterDenied.some((denied) => toolPatternCovers(denied, allowed))) return false;

    // Conservatively require one prior allow pattern to cover the whole new
    // pattern. Finite exact patterns cannot collectively cover a wildcard.
    if (!beforeAllowed.some((priorAllowed) => toolPatternCovers(priorAllowed, allowed))) return true;

    // Deny-wins means every part of this allow pattern that was denied before
    // must remain denied. This catches exact denies hidden by a new MCP server
    // wildcard, as well as wildcard denies narrowed to exact names.
    return beforeDenied.some((priorDenied) => {
      if (afterDenied.some((denied) => toolPatternCovers(denied, priorDenied))) return false;
      const overlap = toolPatternIntersection(allowed, priorDenied);
      return overlap !== undefined
        && !afterDenied.some((denied) => toolPatternCovers(denied, overlap));
    });
  });
}

/**
 * Tool policy values are exact names except for global `*` and the canonical
 * MCP server wildcard `mcp__<server>__*`. Return whether every tool matched by
 * `candidate` is also matched by `covering`.
 */
function toolPatternCovers(covering: string, candidate: string): boolean {
  if (covering === candidate || covering === "*") return true;
  const prefix = mcpServerWildcardPrefix(covering);
  if (prefix === undefined) return false;
  const candidatePrefix = mcpServerWildcardPrefix(candidate);
  return (candidatePrefix ?? candidate).startsWith(prefix)
    || appOwnedMcpWildcardCovers(prefix, candidate);
}

/** Return the narrower pattern when two supported tool patterns overlap. */
function toolPatternIntersection(left: string, right: string): string | undefined {
  if (toolPatternCovers(left, right)) return right;
  if (toolPatternCovers(right, left)) return left;
  if (left === "mcp__*" && isMcpAuthorityTool(right)) return right;
  if (right === "mcp__*" && isMcpAuthorityTool(left)) return left;
  return undefined;
}

function mcpServerWildcardPrefix(pattern: string): string | undefined {
  if (!pattern.startsWith("mcp__") || pattern === "mcp__*") return undefined;
  if (pattern.endsWith("__*")) return pattern.slice(0, -1);
  const serverName = pattern.slice("mcp__".length);
  return serverName.length > 0 && !serverName.includes("__")
    ? `${pattern}__`
    : undefined;
}

function normalizeToolPattern(pattern: string): string {
  const bare = canonicalToolName(pattern);
  if (bare !== pattern) return bare;

  const qualified = mcpQualifiedTool(pattern);
  if (qualified === undefined) return pattern;
  const canonical = canonicalToolName(qualified.tool);
  return isAppOwnedMcpTool(qualified.server, canonical)
    ? canonical
    : pattern;
}

function mcpQualifiedTool(pattern: string): { readonly server: string; readonly tool: string } | undefined {
  if (!pattern.startsWith("mcp__") || mcpServerWildcardPrefix(pattern) !== undefined) return undefined;
  const body = pattern.slice("mcp__".length);
  const separator = body.lastIndexOf("__");
  if (separator <= 0 || separator >= body.length - 2) return undefined;
  return {
    server: body.slice(0, separator),
    tool: body.slice(separator + 2),
  };
}

function isAppOwnedMcpTool(server: string, tool: string): boolean {
  return server === ADAPTER_SEND_TOOLS_MCP_SERVER_NAME
    ? ADAPTER_SEND_TOOL_NAMES.some((name) => name === tool)
    : server === RUN_HISTORY_MCP_SERVER_NAME && tool === RUN_HISTORY_TOOL_NAME;
}

function appOwnedMcpWildcardCovers(prefix: string, candidate: string): boolean {
  if (prefix === `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__`) {
    return ADAPTER_SEND_TOOL_NAMES.some((name) => name === candidate);
  }
  return prefix === `mcp__${RUN_HISTORY_MCP_SERVER_NAME}__`
    && candidate === RUN_HISTORY_TOOL_NAME;
}

function isAppOwnedTool(candidate: string): boolean {
  return ADAPTER_SEND_TOOL_NAMES.some((name) => name === candidate)
    || candidate === RUN_HISTORY_TOOL_NAME;
}

function isMcpAuthorityTool(candidate: string): boolean {
  return (candidate.startsWith("mcp__") && candidate !== "mcp__*") || isAppOwnedTool(candidate);
}

function replaceRoleSection(identity: string, role: string): string {
  const body = normalizedRoleBody(role);
  if (/^##\s/mu.test(body)) {
    throw new Error("The generated Role must be non-empty and cannot introduce another level-two Identity section.");
  }
  const match = /^## Role\s*\n([\s\S]*?)(?=\n##\s|$)/mu.exec(identity);
  if (match === null || match.index === undefined) {
    throw new Error("The configured identity document has no canonical ## Role section to replace safely.");
  }
  const start = match.index;
  const end = start + match[0].length;
  return `${identity.slice(0, start)}## Role\n\n${body}\n${identity.slice(end).replace(/^\n*/u, "\n")}`;
}

function normalizedRoleBody(role: string): string {
  const body = role.trim();
  if (body.length === 0) {
    throw new Error("The generated Role must be non-empty.");
  }
  if (body.length > 8_000) {
    throw new Error("The generated Role exceeds the 8,000-character review limit.");
  }
  return body;
}

function formatPatchOperation(operation: JsonPatchOperation): string {
  if (operation.op === "remove") return `remove ${operation.path}`;
  if (operation.op === "move" || operation.op === "copy") return `${operation.op} ${operation.from} -> ${operation.path}`;
  if (operation.op === "test") return `verify current value at ${operation.path}`;
  const rendered = JSON.stringify(operation.value);
  return `${operation.op} ${operation.path} = ${rendered ?? ""}`;
}

function formatRoleLocation(cwd: string, identityPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(identityPath));
  const display = relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
    ? relativePath
    : resolve(identityPath);
  return `${display} → ## Role`;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function authenticatedLocalConfig(
  cwd: string,
  configPath: string,
): Promise<{ readonly cwd: string; readonly configPath: string }> {
  const lexicalCwd = resolve(cwd);
  const lexicalConfig = resolve(configPath);
  assertLexicalPathInside(lexicalCwd, lexicalConfig, "Config path");
  const canonicalCwd = await realpath(lexicalCwd);
  await assertOwnedDirectory(canonicalCwd, "Current agent folder");
  const relativeConfig = relative(lexicalCwd, lexicalConfig);
  const canonicalConfig = await resolveOwnedRegularFileInside(
    canonicalCwd,
    resolve(canonicalCwd, relativeConfig),
    "Config file",
  );
  return { cwd: canonicalCwd, configPath: canonicalConfig };
}

async function resolveOwnedRegularFileInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`${label} must name a file inside the current agent folder.`);

  let parent = canonicalRoot;
  await assertOwnedDirectory(parent, "Current agent folder");
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    await assertOwnedDirectory(parent, `${label} parent`);
  }
  const target = join(parent, segments.at(-1)!);
  const info = await lstat(target);
  assertOwnedRegularFileInfo(info, target, label);
  const canonicalTarget = await realpath(target);
  assertLexicalPathInside(canonicalRoot, canonicalTarget, label);
  if (canonicalTarget !== target) {
    throw new Error(`${label} must not traverse a symbolic-link parent: ${path}`);
  }
  return target;
}

async function ensureOwnedDirectoryInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  let current = canonicalRoot;
  await assertOwnedDirectory(current, "Current agent folder");
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertOwnedDirectory(current, label);
  }
  return current;
}

/** Resolve an already-created owner-only directory without creating capability ids supplied by a client. */
async function resolveOwnedDirectoryInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  let current = canonicalRoot;
  await assertOwnedDirectory(current, "Current agent folder");
  for (const segment of segments) {
    current = join(current, segment);
    await assertOwnedDirectory(current, label);
  }
  return current;
}

async function assertOwnedDirectory(path: string, label: string): Promise<void> {
  assertOwnedDirectoryInfo(await lstat(path), path, label);
}

function assertOwnedDirectoryInfo(info: Stats, path: string, label: string): void {
  if (!info.isDirectory()) throw new Error(`${label} must be a real directory, not a symbolic link: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
}

function assertOwnedRegularFileInfo(
  info: Stats,
  path: string,
  label: string,
): void {
  if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} must be one regular file with one link: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
}

function isLexicallyInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertLexicalPathInside(root: string, path: string, label: string): void {
  if (!isLexicallyInside(root, path)) {
    throw new Error(`${label} must stay inside the current agent folder: ${path}`);
  }
}

async function assertPreparedSourcesCurrent(
  cwd: string,
  configPath: string,
  prepared: PreparedProposal,
  phase: string,
): Promise<void> {
  const secureConfig = await resolveOwnedRegularFileInside(cwd, configPath, "Config file");
  const current = await readMonoAgentConfigJson(secureConfig);
  if (current.version !== prepared.expectedConfigVersion) {
    throw new Error(`Configuration changed ${phase}. Nothing was written; run /configure again.`);
  }
  if (prepared.rolePath !== undefined) {
    const secureRole = await resolveOwnedRegularFileInside(cwd, prepared.rolePath, "Identity file");
    const currentRole = await readFile(secureRole, "utf8");
    if (sha256(currentRole) !== prepared.expectedRoleHash) {
      throw new Error(`Configured identity document changed ${phase}. Nothing was written; run /configure again.`);
    }
  }
}

async function assertExactOwnedContents(
  cwd: string,
  path: string,
  expected: string,
  label: string,
): Promise<void> {
  const securePath = await resolveOwnedRegularFileInside(cwd, path, label);
  if (await readFile(securePath, "utf8") !== expected) {
    throw new Error(`${label}; the concurrent edit was preserved.`);
  }
}

async function restoreIfExact(cwd: string, path: string, expected: string, restore: string): Promise<void> {
  await atomicReplaceExact(cwd, path, expected, restore);
}

async function atomicReplaceExact(
  root: string,
  path: string,
  expected: string,
  contents: string,
): Promise<void> {
  const securePath = await resolveOwnedRegularFileInside(root, path, "Configuration transaction file");
  const info = await lstat(securePath);
  const temporary = join(dirname(securePath), `.${randomUUID()}.mono-agent-tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      info.mode & 0o777,
    );
    await handle.writeFile(contents, "utf8");
    await handle.chmod(info.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Temp creation and fsync intentionally happen before the last source
    // comparison. From that comparison through rename there is no JavaScript
    // yield: an editor that reacts to the staged temp is observed, while a
    // cooperating mono-agent writer is also serialized by the owner lock.
    commitAtomicReplacementSync(root, securePath, temporary, expected, info);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function commitAtomicReplacementSync(
  root: string,
  path: string,
  temporary: string,
  expected: string,
  initialInfo: Stats,
): void {
  const securePath = resolveOwnedRegularFileInsideSync(root, path, "Configuration transaction file");
  let sourceHandle: number | undefined;
  try {
    sourceHandle = openSync(securePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(sourceHandle);
    assertOwnedRegularFileInfo(openedBefore, securePath, "Configuration transaction file");
    const current = readFileSync(sourceHandle, "utf8");
    const openedAfter = fstatSync(sourceHandle);
    const named = lstatSync(securePath);
    if (
      current !== expected
      || !sameFileIdentityAndMetadata(initialInfo, openedBefore)
      || !sameFileIdentityAndMetadata(openedBefore, openedAfter)
      || !sameFileIdentityAndMetadata(openedAfter, named)
    ) {
      throw new Error(`Refusing to replace changed file ${securePath}; the concurrent edit was preserved.`);
    }
    renameSync(temporary, securePath);
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
  }
}

function resolveOwnedRegularFileInsideSync(root: string, path: string, label: string): string {
  const canonicalRoot = realpathSync(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`${label} must name a file inside the current agent folder.`);

  let parent = canonicalRoot;
  assertOwnedDirectoryInfo(lstatSync(parent), parent, "Current agent folder");
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    assertOwnedDirectoryInfo(lstatSync(parent), parent, `${label} parent`);
  }
  const target = join(parent, segments.at(-1)!);
  assertOwnedRegularFileInfo(lstatSync(target), target, label);
  const canonicalTarget = realpathSync(target);
  assertLexicalPathInside(canonicalRoot, canonicalTarget, label);
  if (canonicalTarget !== target) {
    throw new Error(`${label} must not traverse a symbolic-link parent: ${path}`);
  }
  return target;
}

function sameFileIdentityAndMetadata(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function withConfigurationTransactionLock<T>(
  cwd: string,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const monoAgentDir = await ensureOwnedDirectoryInside(cwd, join(cwd, ".mono-agent"), "Configuration state directory");
  const lockPath = join(monoAgentDir, "configuration.lock");
  const token = randomUUID();
  const contents = `${JSON.stringify({
    schema: "mono-agent.configuration-lock.v1",
    pid: process.pid,
    token,
    label: safeFilePart(label),
    createdAt: new Date().toISOString(),
  })}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Another local configuration transaction owns ${lockPath}. Wait for it to finish; inspect and remove the lock manually only if its owner crashed.`,
        );
      }
      throw error;
    }
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const info = await handle.stat();
    assertOwnedRegularFileInfo(info, lockPath, "Configuration transaction lock");
    identity = { dev: info.dev, ino: info.ino };
    await handle.close();
    handle = undefined;
    return await operation();
  } finally {
    await handle?.close();
    if (identity !== undefined) {
      const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (
        current === undefined
        || current.dev !== identity.dev
        || current.ino !== identity.ino
        || await readFile(lockPath, "utf8") !== contents
      ) {
        throw new Error(`Configuration transaction lock changed unexpectedly and was left untouched: ${lockPath}`);
      }
      await rm(lockPath);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
