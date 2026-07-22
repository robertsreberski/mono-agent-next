import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readMonoAgentConfigJson } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import {
  canonicalBackgroundConfigPath,
  defaultBackgroundDeps,
  ensureBackgroundReady,
  managedBackgroundEnvironment,
  resolveInstanceTarget,
} from "./background.js";
import type { BackgroundLaunchResult } from "./background.js";
import { captureDurableBackgroundInputs } from "./background-snapshot.js";
import type { BackgroundSnapshot } from "./background-snapshot.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { attachScopedKeypress, isAbortLike } from "./cli-cancellation.js";
import {
  formatSection,
  renderPlanCompleteness,
  riskColor,
} from "./cli-validate-config-command.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type { ValidationReport } from "./doctor.js";
import {
  effectiveFirstRunEnvironment,
  evaluateFirstRunConfigurationReadiness,
  evaluateFirstRunReadiness,
  hasSensitivePersistedEnvironmentValue,
  piAuthPathBackgroundConflict,
  readCliConfigSnapshot,
  readCliDotenvSnapshot,
  resolveEffectivePiAuthPath,
  selectedSecretEnvironmentConflicts,
  selectedSecretValues,
  unexpectedPersistedMonoAgentOverrides,
  validateWizardPlanInStaging,
  withExactProcessEnvironment,
} from "./first-run-readiness.js";
import type {
  CliConfigSnapshot,
  CliDotenvSnapshot,
  CliEnvironment,
} from "./first-run-readiness.js";
import {
  initMonoAgentFolder,
  secretEnvConcurrentModificationCause,
  verifySecretEnvPersistenceGuard,
} from "./init.js";
import type { InitMonoAgentFolderResult } from "./init.js";
import { deriveLaunchdLabel, launchdPathsFor } from "./launchd.js";
import {
  detectProviderCredentialStates,
  executeProviderSetupPlan,
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
  providerSetupActionCommandLine,
} from "./provider-setup.js";
import type {
  CodexLoginMode,
  ProviderCredentialState,
  ProviderSetupPlan,
  ProviderSetupResult,
} from "./provider-setup.js";
import { readinessProbeTimeoutMs, runAllRouteReadinessProbe } from "./readiness-probe.js";
import type {
  ReadinessProbeResult,
  ReadinessRouteResult,
} from "./readiness-probe.js";
import { setupManagedSrt } from "./sandbox-manager.js";
import { composeWizardPlan, referencedSetupModelRefs } from "./wizard/answers.js";
import type {
  SecretChecklistItem,
  WizardAnswers,
  WizardPlan,
} from "./wizard/answers.js";
import { answersFromCli, isWithChannel } from "./wizard/from-flags.js";
import type { WithChannel } from "./wizard/from-flags.js";
import { findPreset, presetIds } from "./wizard/presets.js";
import { runInitWizard, runSetupRepairWizard } from "./wizard/run.js";
import * as p from "@clack/prompts";
import * as ui from "./ui.js";

type ReadinessProbeFailure = Extract<ReadinessProbeResult, { readonly ok: false }>;

export interface RunInitEnvironmentContext {
  readonly shellEnv: CliEnvironment;
  readonly dotenvEnv: CliEnvironment;
  readonly dotenvPath: string;
}

export async function runInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext): Promise<number> {
  const cwd = process.cwd();
  // On an interactive TTY with no overriding flags, walk the step-by-step wizard;
  // any flag (or a piped/non-TTY invocation) takes the silent default/preset path.
  const wantsWizard = shouldRunInitWizard(args, process.stdin.isTTY === true, process.stdout.isTTY === true);
  if (wantsWizard) {
    // Existing-config pre-check — don't walk the wizard into a guaranteed no-op.
    if (await pathExists(resolve(cwd, "mono-agent.config.json"))) {
      process.stdout.write(ui.hint("Found an existing mono-agent.config.json — `mono-agent init` never overwrites. Run `mono-agent validate`, or start in an empty folder.\n"));
      return 0;
    }
    let resolvedPiAuthPath = resolveEffectivePiAuthPath({
      cwd,
      ...(nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
        : {}),
    });
    const initial = await runInitWizard({
      cwd,
      piAuthPath: resolvedPiAuthPath,
      persistedEnv: environment.dotenvEnv,
    });
    if (initial.status === "cancelled") return 1;
    let answers = initial.answers;
    let moduleSecrets = { ...initial.moduleSecrets };
    let providerEnvironmentSecrets: Record<string, string> = { ...initial.providerEnvironmentSecrets };
    let providerSetupSecrets = { ...initial.providerSetupSecrets };
    let piApiKeyPersistenceByProvider = { ...initial.piApiKeyPersistenceByProvider };
    let credentialStates = { ...initial.credentialStates };
    let pendingProviderSetup = initial.runProviderSetup;
    let selectedCodexAuthMode: CodexLoginMode = "browser";
    let readinessProgress: ReadinessProgress | undefined;
    let sandboxMutationCompleted = false;
    let deferredFailure: ReadinessProbeFailure | undefined;

    firstRun: for (;;) {
      let dotenvSnapshot: CliDotenvSnapshot = { env: {}, fingerprint: "unreadable" };
      let failure: ReadinessProbeResult | undefined = deferredFailure;
      let configurationRecoveryStep: number | undefined;
      let invalidPlanStage: "configuration" | "final_readiness" | undefined;
      deferredFailure = undefined;
      try {
        dotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
      } catch {
        failure ??= dotenvReadinessFailure("The persisted .env could not be read safely. Fix it before retrying setup.");
      }
      const plan = composeWizardPlan(answers, {
        dirBasename: basename(cwd),
        skillsRootExists: await pathExists(resolve(cwd, "skills")),
      });
      resolvedPiAuthPath = resolveEffectivePiAuthPath({
        cwd,
        ...(nonEmptyEnv(dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH)
          ? { envPath: dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH }
          : {}),
        ...(nonEmptyEnv(plan.configJson.providers?.piAuthPath)
          ? { configPath: plan.configJson.providers.piAuthPath }
          : {}),
      });
      const effectiveEnv = effectiveFirstRunEnvironment({
        shellEnv: environment.shellEnv,
        dotenvEnv: dotenvSnapshot.env,
        enteredSecrets: { ...moduleSecrets, ...providerEnvironmentSecrets },
        resolvedPiAuthPath,
      });
      // Re-submit every selected durable value, not only values typed during this
      // wizard session. That lets the secure merge tighten an existing .env to
      // 0600 while preserving its non-empty operator-owned values verbatim.
      const selectedSecrets = {
        ...selectedSecretValues(plan, effectiveEnv),
        ...providerEnvironmentSecrets,
      };
      const secureExistingDotenv = hasSensitivePersistedEnvironmentValue(dotenvSnapshot.env);
      const conflicts = selectedSecretEnvironmentConflicts(
        plan,
        environment.shellEnv,
        dotenvSnapshot.env,
        moduleSecrets,
      );
      const persistedOverrides = unexpectedPersistedMonoAgentOverrides(plan, dotenvSnapshot.env);

      if (failure === undefined && persistedOverrides.length > 0) {
        failure = {
          ok: false,
          kind: "invalid_plan",
          message:
            `Persisted .env contains mono-agent config override${persistedOverrides.length === 1 ? "" : "s"}: ` +
            `${persistedOverrides.join(", ")}. Remove ${persistedOverrides.length === 1 ? "it" : "them"} so the ` +
            "generated config is the exact config validated and started.",
        };
      }
      if (failure === undefined && conflicts.length > 0) {
        failure = {
          ok: false,
          kind: "invalid_plan",
          message:
            `Selected secret${conflicts.length === 1 ? "" : "s"} ${conflicts.join(", ")} ` +
            "differ between the exported shell, persisted .env, or newly entered value. " +
            "Unset the shell value or make every source match, then retry.",
        };
      }
      if (failure === undefined && piAuthPathBackgroundConflict({
        cwd,
        shellPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH,
        dotenvPath: dotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH,
        ...(nonEmptyEnv(plan.configJson.providers?.piAuthPath)
          ? { configPath: plan.configJson.providers.piAuthPath }
          : {}),
      })) {
        failure = {
          ok: false,
          kind: "invalid_plan",
          message:
            "The exported MONO_AGENT_PI_AUTH_PATH selects a different credential store than a background start. " +
            "Persist the same path in .env or providers.piAuthPath, or unset the shell override, then retry.",
        };
      }

      if (failure === undefined && pendingProviderSetup) {
        pendingProviderSetup = false;
        const modelRefs = referencedSetupModelRefs(plan);
        const credentialObservation = await withScopedPreflightCancellation(async (abortSignal) => ({
          states: await detectProviderCredentialStates({
            modelRefs,
            cwd,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            abortSignal,
          }),
          interrupted: abortSignal.aborted,
        }));
        if (credentialObservation.interrupted) {
          pendingProviderSetup = true;
          deferredFailure = {
            ok: false,
            kind: "cancelled",
            message: "Provider status detection was interrupted. No agent files were written.",
            interrupted: true,
          };
          continue firstRun;
        }
        credentialStates = credentialObservation.states;
        const plannedSetup = planProviderSetup({
          modelRefs,
          cwd,
          piAuthPath: resolvedPiAuthPath,
          credentialStates,
          piApiKeyPersistenceByProvider,
        });
        if (plannedSetup.actions.some((action) => action.id === "codex-login")) {
          const selected = await selectCodexAuthMode(selectedCodexAuthMode);
          if (selected === undefined) return 1;
          selectedCodexAuthMode = selected;
        }
        const environmentApiKeys = environmentProviderApiKeys(plannedSetup, effectiveEnv);
        const missingEnvironmentKeys = plannedSetup.actions
          .filter(isProviderSetupPiApiKeyAction)
          .filter((action) => action.persistence === "environment" && environmentApiKeys[action.id] === undefined)
          .map((action) => action.envVar);
        if (missingEnvironmentKeys.length > 0) {
          for (const envVar of missingEnvironmentKeys) {
            const answer = await p.password({
              message: `Enter ${envVar} for the agent's owner-only .env`,
              validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
              clearOnError: true,
            });
            if (p.isCancel(answer)) return 1;
            providerEnvironmentSecrets[envVar] = answer;
          }
          pendingProviderSetup = true;
          continue firstRun;
        }
        const setup = await withScopedPreflightCancellation((abortSignal) =>
          withExactProcessEnvironment(effectiveEnv, () =>
            runProviderSetupBeforeInit({
              modelRefs,
              cwd,
              auth: true,
              dryRun: false,
              piAuthPath: resolvedPiAuthPath,
              apiKeys: { ...providerSetupSecrets, ...environmentApiKeys },
              codexAuthMode: selectedCodexAuthMode,
              credentialStates,
              persistedEnv: dotenvSnapshot.env,
              piApiKeyPersistenceByProvider,
              abortSignal,
            })), { keypress: false });
        if (setup === "fatal") return 130;
        if (setup === "interrupted") {
          pendingProviderSetup = true;
          failure = {
            ok: false,
            kind: "cancelled",
            message: "Provider setup was interrupted. No agent files were written.",
            interrupted: true,
          };
        } else if (setup === "failed") {
          // A plain retry must revisit provider setup rather than falling
          // through to a guaranteed-failing model turn.
          pendingProviderSetup = true;
          failure = {
            ok: false,
            kind: "provider_failed",
            message: "Provider setup did not complete. No agent files were written.",
          };
        }
      }

      if (failure === undefined) {
        if (answers.sandbox) {
          const sandboxPreflight = await runGuidedSandboxPreflight(sandboxMutationCompleted);
          sandboxMutationCompleted = sandboxMutationCompleted || sandboxPreflight.ok;
          if (!sandboxPreflight.ok) failure = sandboxPreflight;
        }
      }

      if (failure === undefined) {
        const configurationGate = await runConfigurationPreflightWithSpinner({
          cwd,
          answers,
          plan,
          env: effectiveEnv,
          secretValues: selectedSecrets,
          secureExistingDotenv,
        });
        if (configurationGate.interrupted === true) {
          failure = {
            ok: false,
            kind: "cancelled",
            message: "Configuration preflight was interrupted. No agent files were written.",
            interrupted: true,
          };
        } else if (!configurationGate.ready) {
          configurationRecoveryStep = focusedConfigurationRepairStep(configurationGate.failedSectionIds);
          invalidPlanStage = "configuration";
          failure = {
            ok: false,
            kind: "invalid_plan",
            message: `Configuration preflight did not pass: ${configurationGate.reasons.join(" ")}`,
          };
        }
      }

      if (failure === undefined) {
        const readiness = await runReadinessProbeWithSpinner({
          plan,
          effectiveEnv,
          resolvedPiAuthPath,
          ...(readinessProgress === undefined ? {} : {
            resume: {
              planFingerprint: readinessProgress.planFingerprint,
              successfulRouteKeys: readinessProgress.successfulRouteKeys,
            },
          }),
        });
        readinessProgress = mergeReadinessProgress(readinessProgress, readiness, plan);
        failure = readiness;
      }

      readyAttempt: if (failure.ok) {
        const stagedGate = await runFinalReadinessValidationWithSpinner({
          cwd,
          answers,
          plan,
          env: effectiveEnv,
          secretValues: selectedSecrets,
          secureExistingDotenv,
          verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
        });
        if (stagedGate.interrupted === true) {
          failure = {
            ok: false,
            kind: "cancelled",
            message: "Final readiness validation was interrupted. No agent files were written.",
            interrupted: true,
          };
          break readyAttempt;
        }
        if (stagedGate.ready) {
          const drift = await firstRunDotenvDrift(environment.dotenvPath, dotenvSnapshot);
          if (drift !== undefined) {
            failure = drift;
            break readyAttempt;
          }
          let result: InitMonoAgentFolderResult;
          try {
            result = await initMonoAgentFolder({
              dir: cwd,
              answers,
              env: effectiveEnv,
              secretValues: selectedSecrets,
              secureExistingDotenv,
              requireConfigCreation: true,
            });
          } catch (error) {
            const recovery = secretPersistenceRecoveryMessage(error);
            process.stderr.write(ui.errorLine(
              `The validated scaffold could not be committed safely. The agent was not started; inspect the destination before retrying.${recovery}`,
            ));
            return 1;
          }
          let committedConfigSnapshot: CliConfigSnapshot;
          try {
            committedConfigSnapshot = await readCliConfigSnapshot(result.configPath);
          } catch {
            printIncompleteSetup(
              ["The committed config could not be read back as the regular file setup created."],
              result.configPath,
            );
            return 1;
          }
          if (committedConfigSnapshot.contents !== `${JSON.stringify(result.plan.configJson, null, 2)}\n`) {
            printIncompleteSetup(
              ["The committed config does not match the exact plan setup validated."],
              result.configPath,
            );
            return 1;
          }
          let committedDotenvSnapshot: CliDotenvSnapshot;
          try {
            committedDotenvSnapshot = await readCliDotenvSnapshot(environment.dotenvPath);
          } catch {
            printIncompleteSetup(
              ["The committed .env could not be read back safely; no readiness claim is safe."],
              result.configPath,
            );
            return 1;
          }
          // A missing default .env is a valid, durable empty environment. Keep
          // proving its absence in the approved snapshot, but do not turn that
          // default into an explicit --env-file argument: the managed worker
          // treats an explicitly named missing file as an operator error.
          const backgroundEnvFile = args.envFile === undefined
            && committedDotenvSnapshot.fingerprint === "missing"
            ? undefined
            : environment.dotenvPath;
          const postWriteConflicts = selectedSecretEnvironmentConflicts(
            result.plan,
            environment.shellEnv,
            committedDotenvSnapshot.env,
            moduleSecrets,
          );
          const postWriteOverrides = unexpectedPersistedMonoAgentOverrides(
            result.plan,
            committedDotenvSnapshot.env,
          );
          const postWritePiAuthConflict = piAuthPathBackgroundConflict({
            cwd,
            shellPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH,
            dotenvPath: committedDotenvSnapshot.env.MONO_AGENT_PI_AUTH_PATH,
            ...(nonEmptyEnv(result.plan.configJson.providers?.piAuthPath)
              ? { configPath: result.plan.configJson.providers.piAuthPath }
              : {}),
          });
          if (postWriteConflicts.length > 0 || postWriteOverrides.length > 0 || postWritePiAuthConflict) {
            printIncompleteSetup(
              ["The committed .env no longer matches the values and generated config that setup approved."],
              result.configPath,
            );
            return 1;
          }
          const postWriteEnv = effectiveFirstRunEnvironment({
            shellEnv: environment.shellEnv,
            dotenvEnv: committedDotenvSnapshot.env,
            resolvedPiAuthPath,
          });
          if (!sameConcreteEnvironment(effectiveEnv, postWriteEnv)) {
            printIncompleteSetup(
              ["The durable environment changed after the primary-model check. Retry setup before claiming readiness."],
              result.configPath,
            );
            return 1;
          }
          let committedBackgroundSnapshot: BackgroundSnapshot;
          let committedBackgroundEnvironment: Readonly<Record<string, string>>;
          let committedBackgroundConfigSourceFingerprint: string;
          try {
            const durableInputs = await captureDurableBackgroundInputs({
              cwd,
              configPath: result.configPath,
              envFile: environment.dotenvPath,
              operationalEnvironment: managedBackgroundEnvironment(postWriteEnv),
            });
            committedBackgroundSnapshot = durableInputs.snapshot;
            committedBackgroundEnvironment = durableInputs.environment;
            committedBackgroundConfigSourceFingerprint = durableInputs.configSourceFingerprint;
          } catch {
            printIncompleteSetup(
              ["The complete committed config, dotenv, Identity, Soul, and MCP snapshot could not be proven safely."],
              result.configPath,
            );
            return 1;
          }
          if (committedBackgroundConfigSourceFingerprint !== committedConfigSnapshot.fingerprint) {
            printIncompleteSetup(
              ["The committed config or durable environment changed before the background snapshot was captured."],
              result.configPath,
            );
            return 1;
          }
          printInitResult(result);
          let report: ValidationReport;
          try {
            report = await validateMonoAgentFolder({
              env: postWriteEnv,
              cwd,
              configPath: result.configPath,
              liveness: true,
              verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
            });
          } catch {
            printIncompleteSetup(
              ["Post-write validation could not complete; no readiness claim is safe."],
              result.configPath,
            );
            return 1;
          }
          process.stdout.write("\n" + ui.heading("Validation"));
          for (const section of report.sections) process.stdout.write(formatSection(section));
          process.stdout.write(renderPlanCompleteness(result.plan.validateExpectations, "Selected capabilities", report));
          const configuredSecrets = configuredSecretNames(result, postWriteEnv);
          printSecretsChecklist(result.plan.secrets, configuredSecrets);
          const finalGate = evaluateFirstRunReadiness({
            plan: result.plan,
            report,
            secretPersistence: result.secretPersistence,
            verifiedCredentialModelRefs: readinessProgress?.verifiedModelRefs ?? [],
          });
          if (!finalGate.ready) {
            printIncompleteSetup(finalGate.reasons, result.configPath);
            return 1;
          }
          const postValidationConfigDrift = await firstRunConfigDrift(
            result.configPath,
            committedConfigSnapshot,
          );
          if (postValidationConfigDrift !== undefined) {
            printIncompleteSetup([postValidationConfigDrift.message], result.configPath);
            return 1;
          }
          const postValidationDrift = await firstRunDotenvDrift(
            environment.dotenvPath,
            committedDotenvSnapshot,
          );
          if (postValidationDrift !== undefined) {
            printIncompleteSetup([postValidationDrift.message], result.configPath);
            return 1;
          }
          const postValidationSecretGuard = await firstRunSecretEnvGuardFailure(
            environment.dotenvPath,
            result.secretPersistence.status === "persisted",
          );
          if (postValidationSecretGuard !== undefined) {
            printIncompleteSetup([postValidationSecretGuard.message], result.configPath);
            return 1;
          }
          process.stdout.write(
            ui.badge("ok") + ui.style.green("All runtime route checks passed — every selected model produced a real no-tool response.\n") +
            ui.badge("ok") + ui.style.green("Agent configuration validated — every selected capability passed full validation.\n"),
          );
          const preTuiConfigDrift = await firstRunConfigDrift(
            result.configPath,
            committedConfigSnapshot,
          );
          if (preTuiConfigDrift !== undefined) {
            printIncompleteSetup([preTuiConfigDrift.message], result.configPath);
            return 1;
          }
          const preTuiDotenvDrift = await firstRunDotenvDrift(
            environment.dotenvPath,
            committedDotenvSnapshot,
          );
          if (preTuiDotenvDrift !== undefined) {
            printIncompleteSetup([preTuiDotenvDrift.message], result.configPath);
            return 1;
          }
          const preTuiSecretGuard = await firstRunSecretEnvGuardFailure(
            environment.dotenvPath,
            result.secretPersistence.status === "persisted",
          );
          if (preTuiSecretGuard !== undefined) {
            printIncompleteSetup([preTuiSecretGuard.message], result.configPath);
            return 1;
          }
          if (process.platform !== "darwin") {
            printUnsupportedGuidedInitHandoff(result.configPath, backgroundEnvFile);
            return 0;
          }
          process.stdout.write(ui.hint("Starting the authoritative background agent before configuration chat…"));
          let background: BackgroundLaunchResult;
          try {
            const resolvedBackgroundTarget = await resolveInstanceTarget({
              args: {
                configPath: result.configPath,
                ...(backgroundEnvFile === undefined ? {} : { envFile: backgroundEnvFile }),
              },
              env: { ...committedBackgroundEnvironment },
              cwd,
              cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
              requireTui: true,
            });
            const backgroundTarget = {
              ...resolvedBackgroundTarget,
              expectedSnapshot: committedBackgroundSnapshot,
            };
            background = await ensureBackgroundReady(
              backgroundTarget,
              defaultBackgroundDeps(),
            );
          } catch (error) {
            printUnexpectedGuidedBackgroundFailure(result.configPath, backgroundEnvFile, error);
            return 1;
          }
          if (!background.ok) {
            process.stderr.write(ui.hint(
              "The validated agent files were preserved, but configuration chat was not opened because the background agent is not ready.",
            ));
            return 1;
          }
          process.stdout.write(
            ui.badge("ok") + ui.style.green("Agent ready — the background process reported startup complete.\n") +
            ui.badge("ok") + ui.style.green("Opening configuration chat on the authoritative background agent.\n"),
          );
          const { runTui } = await import("./tui-command.js");
          return await withExactProcessEnvironment(committedBackgroundEnvironment, () => runTui({
            configPath: result.configPath,
            cwd,
            env: committedBackgroundEnvironment,
            ...(backgroundEnvFile === undefined ? {} : { envFile: backgroundEnvFile }),
            agent: background.source.sourceId,
            configure: true,
          }));
        }
        configurationRecoveryStep = focusedConfigurationRepairStep(stagedGate.failedSectionIds);
        invalidPlanStage = "final_readiness";
        failure = {
          ok: false,
          kind: "invalid_plan",
          message: `Runtime route checks passed, but the complete agent is not ready: ${stagedGate.reasons.join(" ")}`,
        };
      }

      if (failure.ok) throw new Error("First-run recovery reached without a failure.");
      if (failure.interrupted === true || failure.kind === "cancelled") {
        interruptedRecoveryMenu: for (;;) {
          const interruptedRecovery = await selectInterruptedFirstRunRecovery();
          if (interruptedRecovery === "cancel") return 1;
          if (interruptedRecovery === "restart") {
            readinessProgress = undefined;
            break interruptedRecoveryMenu;
          }
          if (interruptedRecovery === "edit") {
            const repaired = await runSetupRepairWizard({
              cwd,
              answers,
              piAuthPath: resolvedPiAuthPath,
              persistedEnv: dotenvSnapshot.env,
              moduleSecrets,
              providerSetupSecrets,
              providerEnvironmentSecrets,
              piApiKeyPersistenceByProvider,
              credentialStates,
              runProviderSetup: pendingProviderSetup,
            });
            if (repaired.status === "cancelled") continue interruptedRecoveryMenu;
            answers = repaired.answers;
            moduleSecrets = { ...repaired.moduleSecrets };
            providerSetupSecrets = { ...repaired.providerSetupSecrets };
            providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
            piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
            credentialStates = { ...repaired.credentialStates };
            pendingProviderSetup = repaired.runProviderSetup;
            if (pendingProviderSetup) readinessProgress = undefined;
          }
          break interruptedRecoveryMenu;
        }
        continue firstRun;
      }
      if (failure.message.startsWith("[sandbox_preflight_failed]")) {
        sandboxRecoveryMenu: for (;;) {
          const recovery = await selectSandboxPreflightRecovery();
          if (recovery === "cancel") return 1;
          if (recovery === "edit") {
            const edited = await runSetupRepairWizard({
              cwd,
              answers,
              piAuthPath: resolvedPiAuthPath,
              persistedEnv: dotenvSnapshot.env,
              moduleSecrets,
              providerSetupSecrets,
              providerEnvironmentSecrets,
              piApiKeyPersistenceByProvider,
              credentialStates,
              runProviderSetup: pendingProviderSetup,
            });
            if (edited.status === "cancelled") continue sandboxRecoveryMenu;
            answers = edited.answers;
            moduleSecrets = { ...edited.moduleSecrets };
            providerSetupSecrets = { ...edited.providerSetupSecrets };
            providerEnvironmentSecrets = { ...edited.providerEnvironmentSecrets };
            piApiKeyPersistenceByProvider = { ...edited.piApiKeyPersistenceByProvider };
            credentialStates = { ...edited.credentialStates };
            pendingProviderSetup = edited.runProviderSetup;
            if (pendingProviderSetup) readinessProgress = undefined;
          }
          break sandboxRecoveryMenu;
        }
        continue firstRun;
      }
      let recoveryFailure: ReadinessProbeFailure = failure;
      recoveryMenu: for (;;) {
        p.log.error(`[${recoveryFailure.kind}] ${recoveryFailure.message}`);
        const recovery = await selectFirstRunRecovery(
          recoveryFailure,
          configurationRecoveryStep,
          invalidPlanStage,
        );
        if (recovery === "cancel") return 1;
        if (recovery === "save") {
          let saved: InitMonoAgentFolderResult;
          try {
            saved = await initMonoAgentFolder({
              dir: cwd,
              answers,
              env: effectiveEnv,
              secretValues: selectedSecrets,
              secureExistingDotenv,
              requireConfigCreation: true,
            });
          } catch (error) {
            const recovery = secretPersistenceRecoveryMessage(error);
            process.stderr.write(ui.errorLine(
              `The incomplete scaffold could not be committed safely; inspect the destination and retry.${recovery}`,
            ));
            return 1;
          }
          printInitResult(saved);
          let durableSavedEnv: CliEnvironment = {};
          if (saved.secretPersistence.status === "persisted") {
            try {
              durableSavedEnv = (await readCliDotenvSnapshot(environment.dotenvPath)).env;
            } catch {
              durableSavedEnv = {};
            }
          }
          printSecretsChecklist(
            saved.plan.secrets,
            configuredSecretNames(saved, durableSavedEnv),
          );
          printIncompleteSetup([recoveryFailure.message], saved.configPath);
          return 1;
        }
        if (recovery === "edit") {
          const repaired = await runSetupRepairWizard({
            cwd,
            answers,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            ...(configurationRecoveryStep === undefined ? {} : { initialStep: configurationRecoveryStep }),
            moduleSecrets,
            providerSetupSecrets,
            providerEnvironmentSecrets,
            piApiKeyPersistenceByProvider,
            credentialStates,
            runProviderSetup: pendingProviderSetup,
          });
          if (repaired.status === "cancelled") continue recoveryMenu;
          answers = repaired.answers;
          moduleSecrets = { ...repaired.moduleSecrets };
          providerSetupSecrets = { ...repaired.providerSetupSecrets };
          providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
          piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
          credentialStates = { ...repaired.credentialStates };
          pendingProviderSetup = repaired.runProviderSetup;
          if (pendingProviderSetup) readinessProgress = undefined;
          continue firstRun;
        }
        if (recovery === "model") {
          const repaired = await runSetupRepairWizard({
            cwd,
            answers,
            piAuthPath: resolvedPiAuthPath,
            persistedEnv: dotenvSnapshot.env,
            initialStep: 1,
            moduleSecrets,
            providerSetupSecrets,
            providerEnvironmentSecrets,
            piApiKeyPersistenceByProvider,
            credentialStates,
            runProviderSetup: pendingProviderSetup,
          });
          if (repaired.status === "cancelled") continue recoveryMenu;
          answers = repaired.answers;
          moduleSecrets = { ...repaired.moduleSecrets };
          providerSetupSecrets = { ...repaired.providerSetupSecrets };
          providerEnvironmentSecrets = { ...repaired.providerEnvironmentSecrets };
          piApiKeyPersistenceByProvider = { ...repaired.piApiKeyPersistenceByProvider };
          credentialStates = { ...repaired.credentialStates };
          pendingProviderSetup = repaired.runProviderSetup;
          if (pendingProviderSetup) readinessProgress = undefined;
          continue firstRun;
        }
        if (recovery === "auth") {
          // Authentication can replace credential bytes without changing the
          // route/config fingerprint. Every route must be proven again.
          readinessProgress = undefined;
          if (referencedSetupModelRefs(plan).some((ref) => ref.startsWith("codex:"))) {
            const selected = await selectCodexAuthMode(selectedCodexAuthMode);
            if (selected === undefined) return 1;
            selectedCodexAuthMode = selected;
          }
          const setupPlan = planProviderSetup({
            modelRefs: referencedSetupModelRefs(plan),
            cwd,
            piAuthPath: resolvedPiAuthPath,
            codexAuthMode: selectedCodexAuthMode,
            forceAuthentication: true,
          });
          const prompted = await promptProviderSetupSecrets(
            setupPlan,
            providerSetupSecrets,
            piApiKeyPersistenceByProvider,
            providerEnvironmentSecrets,
          );
          if (prompted === undefined) return 1;
          providerSetupSecrets = prompted.apiKeys;
          piApiKeyPersistenceByProvider = prompted.persistenceByProvider;
          providerEnvironmentSecrets = prompted.environmentSecrets;
          readinessProgress = undefined;
          const selectedSetupPlan = planProviderSetup({
            modelRefs: referencedSetupModelRefs(plan),
            cwd,
            piAuthPath: resolvedPiAuthPath,
            codexAuthMode: selectedCodexAuthMode,
            forceAuthentication: true,
            piApiKeyPersistenceByProvider,
          });
          const environmentApiKeys = environmentProviderApiKeys(
            selectedSetupPlan,
            { ...effectiveEnv, ...providerEnvironmentSecrets },
          );
          const missingEnvironmentKeys = selectedSetupPlan.actions
            .filter(isProviderSetupPiApiKeyAction)
            .filter((action) => action.persistence === "environment" && environmentApiKeys[action.id] === undefined)
            .map((action) => action.envVar);
          if (missingEnvironmentKeys.length > 0) {
            recoveryFailure = {
              ok: false,
              kind: "provider_failed",
              message: `Add ${missingEnvironmentKeys.join(", ")} to the durable owner-only .env, then retry authentication. No agent files were written.`,
            };
            continue recoveryMenu;
          }
          const setup = await withScopedPreflightCancellation((abortSignal) =>
            withExactProcessEnvironment(effectiveEnv, () =>
              runProviderSetupBeforeInit({
                modelRefs: referencedSetupModelRefs(plan),
                cwd,
                auth: true,
                dryRun: false,
                piAuthPath: resolvedPiAuthPath,
                apiKeys: { ...providerSetupSecrets, ...environmentApiKeys },
                codexAuthMode: selectedCodexAuthMode,
                forceAuthentication: true,
                piApiKeyPersistenceByProvider,
                abortSignal,
              })), { keypress: false });
          if (setup === "fatal") return 130;
          if (setup === "interrupted") {
            pendingProviderSetup = true;
            deferredFailure = {
              ok: false,
              kind: "cancelled",
              message: "Provider setup was interrupted. No agent files were written.",
              interrupted: true,
            };
            continue firstRun;
          }
          if (setup === "failed") {
            pendingProviderSetup = true;
            recoveryFailure = {
              ok: false,
              kind: "provider_failed",
              message: "Provider setup still needs attention. No agent files were written.",
            };
            continue recoveryMenu;
          }
          pendingProviderSetup = false;
        }
        // "retry" deliberately reruns only the live checks. Provider setup is a
        // separate explicit recovery action and is never repeated automatically.
        continue firstRun;
      }
    }
  }

  const presetId = resolveInitPresetId(args);
  if (presetId === "unknown") {
    return 1;
  }

  const withChannels = resolveWithChannels(args);
  if (withChannels === "invalid") {
    return 1;
  }

  const answers = answersFromCli({
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.fallbacks === undefined ? {} : { fallbacks: args.fallbacks }),
    ...(args.routeSafety === undefined ? {} : { routeSafety: args.routeSafety }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.memory === undefined ? {} : { memory: args.memory }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(presetId === undefined ? {} : { presetId }),
  });

  const previewPlan = composeWizardPlan(answers, {
    dirBasename: basename(process.cwd()),
    skillsRootExists: await pathExists(resolve(process.cwd(), "skills")),
  });
  const nonInteractivePiAuthPath = resolveEffectivePiAuthPath({
    cwd,
    ...(nonEmptyEnv(environment.shellEnv.MONO_AGENT_PI_AUTH_PATH)
      ? { envPath: environment.shellEnv.MONO_AGENT_PI_AUTH_PATH }
      : nonEmptyEnv(environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH)
        ? { envPath: environment.dotenvEnv.MONO_AGENT_PI_AUTH_PATH }
        : {}),
    ...(nonEmptyEnv(previewPlan.configJson.providers?.piAuthPath)
      ? { configPath: previewPlan.configJson.providers.piAuthPath }
      : {}),
  });
  const nonInteractiveEnvironment = effectiveFirstRunEnvironment({
    shellEnv: environment.shellEnv,
    dotenvEnv: environment.dotenvEnv,
    resolvedPiAuthPath: nonInteractivePiAuthPath,
  });
  const setup = await withScopedPreflightCancellation((abortSignal) =>
    withExactProcessEnvironment(nonInteractiveEnvironment, () =>
      runProviderSetupBeforeInit({
        modelRefs: referencedSetupModelRefs(previewPlan),
        cwd,
        auth: args.auth === true,
        dryRun: args.dryRun,
        persistedEnv: environment.dotenvEnv,
        piAuthPath: nonInteractivePiAuthPath,
        ...(args.codexAuthMode === undefined ? {} : { codexAuthMode: args.codexAuthMode }),
        abortSignal,
      })), { keypress: false });
  if (setup === "interrupted" || setup === "fatal") {
    return 130;
  }
  if (setup === "failed") {
    return 1;
  }

  const result = await initMonoAgentFolder({
    dir: cwd,
    answers,
    dryRun: args.dryRun,
    // Scaffold-only init has no immediate launchd-minimal worker proof. Reject
    // both shell and persisted memory-identity overrides instead of creating a
    // generation at a different path/tier than a follow-up validate would use.
    env: { ...environment.shellEnv, ...environment.dotenvEnv },
  });

  printInitResult(result);
  printSecretsChecklist(result.plan.secrets, new Set());
  printNextSteps(result.configPath);
  return 0;
}

type AssessedConfigurationReadiness = ReturnType<typeof evaluateFirstRunConfigurationReadiness> & {
  readonly failedSectionIds: readonly string[];
  readonly interrupted?: true;
};

type AssessedFinalReadiness = ReturnType<typeof evaluateFirstRunReadiness> & {
  readonly failedSectionIds: readonly string[];
  readonly interrupted?: true;
};

const FIRST_RUN_STAGING_FAILURE_MAX_LENGTH = 500;
const FIRST_RUN_SENSITIVE_ENV_NAME = /(api.?key|credential|password|secret|token)/iu;

function throwIfFirstRunPreflightAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Preflight was interrupted.");
  error.name = "AbortError";
  throw error;
}

function firstRunStagingFailureDetail(
  error: unknown,
  sensitiveValues: Iterable<string> = [],
): string {
  let message = reasonOf(error);
  for (const value of [...new Set(sensitiveValues)].filter((candidate) => candidate.length >= 4).sort(
    (left, right) => right.length - left.length,
  )) {
    message = message.replaceAll(value, "[secret-redacted]");
  }
  const normalized = message
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [secret-redacted]")
    .replace(
      /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)(\s*[=:]\s*)([^\s,;]+)/giu,
      (_match, label: string, separator: string) => `${label}${separator}[secret-redacted]`,
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return "Unknown staging failure.";
  return normalized.length <= FIRST_RUN_STAGING_FAILURE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, FIRST_RUN_STAGING_FAILURE_MAX_LENGTH - 1).trimEnd()}…`;
}

function firstRunStagingSensitiveValues(
  env: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>>,
): readonly string[] {
  return [
    ...Object.entries(env)
      .filter((entry): entry is [string, string] =>
        FIRST_RUN_SENSITIVE_ENV_NAME.test(entry[0])
        && typeof entry[1] === "string"
        && entry[1].length > 0
      )
      .map(([, value]) => value),
    ...Object.values(explicit),
  ];
}

async function runConfigurationPreflightWithSpinner(
  options: Omit<Parameters<typeof assessPrewriteFirstRunConfigurationReadiness>[0], "abortSignal">,
): Promise<AssessedConfigurationReadiness> {
  process.stdout.write("\n" + ui.heading("Configuration preflight"));
  const spinner = p.spinner();
  try {
    return await withScopedPreflightCancellation(async (abortSignal) => {
      spinner.start("Validating generated files and selected capabilities before runtime calls");
      const gate = await assessPrewriteFirstRunConfigurationReadiness({ ...options, abortSignal });
      if (abortSignal.aborted || spinner.isCancelled) {
        spinner.cancel("Configuration preflight interrupted");
        return interruptedConfigurationAssessment();
      }
      if (gate.ready) {
        spinner.stop("Selected capabilities are ready for runtime checks");
      } else {
        spinner.error("Configuration preflight needs attention");
      }
      return gate;
    });
  } catch (error) {
    if (!isAbortLike(error)) throw error;
    spinner.cancel("Configuration preflight interrupted");
    return interruptedConfigurationAssessment();
  }
}

function interruptedConfigurationAssessment(): AssessedConfigurationReadiness {
  return {
    ready: false,
    reasons: ["Configuration preflight was interrupted."],
    failedSectionIds: [],
    interrupted: true,
  };
}

async function runFinalReadinessValidationWithSpinner(
  options: Omit<Parameters<typeof assessPrewriteFirstRunReadiness>[0], "abortSignal">,
): Promise<AssessedFinalReadiness> {
  process.stdout.write("\n" + ui.heading("Final readiness validation"));
  const spinner = p.spinner();
  try {
    return await withScopedPreflightCancellation(async (abortSignal) => {
      spinner.start("Revalidating the effective files after runtime route checks");
      const gate = await assessPrewriteFirstRunReadiness({ ...options, abortSignal });
      if (abortSignal.aborted || spinner.isCancelled) {
        spinner.cancel("Final readiness validation interrupted");
        return interruptedFinalReadinessAssessment();
      }
      if (gate.ready) spinner.stop("Effective files and runtime routes are ready");
      else spinner.error("Final readiness validation needs attention");
      return gate;
    });
  } catch (error) {
    if (!isAbortLike(error)) throw error;
    spinner.cancel("Final readiness validation interrupted");
    return interruptedFinalReadinessAssessment();
  }
}

function interruptedFinalReadinessAssessment(): AssessedFinalReadiness {
  return {
    ready: false,
    reasons: ["Final readiness validation was interrupted."],
    failedSectionIds: [],
    interrupted: true,
  };
}

async function assessPrewriteFirstRunConfigurationReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
  readonly abortSignal?: AbortSignal;
}): Promise<AssessedConfigurationReadiness> {
  try {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      env: options.env,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: [],
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const gate = evaluateFirstRunConfigurationReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
    });
    return {
      ...gate,
      failedSectionIds: configurationFailureSectionIds(options.plan, report, true),
    };
  } catch (error) {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      ready: false,
      reasons: [
        `The complete generated configuration could not be validated safely in staging: ${firstRunStagingFailureDetail(
          error,
          firstRunStagingSensitiveValues(options.env, options.secretValues),
        )}`,
      ],
      failedSectionIds: [],
    };
  }
}

async function assessPrewriteFirstRunReadiness(options: {
  readonly cwd: string;
  readonly answers: WizardAnswers;
  readonly plan: WizardPlan;
  readonly env: Record<string, string | undefined>;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly secureExistingDotenv: boolean;
  readonly verifiedCredentialModelRefs: readonly string[];
  readonly abortSignal?: AbortSignal;
}): Promise<AssessedFinalReadiness> {
  try {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const preview = await initMonoAgentFolder({
      dir: options.cwd,
      answers: options.answers,
      env: options.env,
      secretValues: options.secretValues,
      secureExistingDotenv: options.secureExistingDotenv,
      dryRun: true,
    });
    throwIfFirstRunPreflightAborted(options.abortSignal);
    const report = await validateWizardPlanInStaging({
      plan: options.plan,
      sourceCwd: options.cwd,
      env: options.env,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    const gate = evaluateFirstRunReadiness({
      plan: options.plan,
      report,
      secretPersistence: preview.secretPersistence,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
    });
    return {
      ...gate,
      failedSectionIds: configurationFailureSectionIds(options.plan, report, false),
    };
  } catch (error) {
    throwIfFirstRunPreflightAborted(options.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      ready: false,
      reasons: [
        `The complete generated plan could not be validated safely in staging: ${firstRunStagingFailureDetail(
          error,
          firstRunStagingSensitiveValues(options.env, options.secretValues),
        )}`,
      ],
      failedSectionIds: [],
    };
  }
}

function configurationFailureSectionIds(
  plan: WizardPlan,
  report: ValidationReport,
  deferWaitingCredentials: boolean,
): readonly string[] {
  const byId = new Map(report.sections.map((section) => [section.id, section]));
  const ids = new Set<string>();
  for (const expectation of plan.validateExpectations) {
    const actual = byId.get(expectation.sectionId)?.status;
    if (
      actual === expectation.mustBe
      || (deferWaitingCredentials && expectation.sectionId === "credentials" && actual === "waiting")
    ) continue;
    ids.add(expectation.sectionId);
  }
  if (!report.ok) {
    for (const section of report.sections) {
      if (section.status === "error") ids.add(section.id);
    }
  }
  return [...ids];
}

function nonEmptyEnv(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameConcreteEnvironment(left: CliEnvironment, right: CliEnvironment): boolean {
  const concreteEntries = (env: CliEnvironment): readonly (readonly [string, string])[] =>
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const leftEntries = concreteEntries(left);
  const rightEntries = concreteEntries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(
    ([name, value], index) => rightEntries[index]?.[0] === name && rightEntries[index]?.[1] === value,
  );
}

function dotenvReadinessFailure(message: string): ReadinessProbeFailure {
  return { ok: false, kind: "invalid_plan", message };
}

async function firstRunDotenvDrift(
  path: string,
  expected: CliDotenvSnapshot,
): Promise<ReadinessProbeFailure | undefined> {
  let current: CliDotenvSnapshot;
  try {
    current = await readCliDotenvSnapshot(path);
  } catch {
    return dotenvReadinessFailure("The persisted .env became unreadable during setup. Readiness cannot be claimed.");
  }
  if (current.fingerprint === expected.fingerprint) return undefined;
  return dotenvReadinessFailure(
    "The persisted .env changed while setup was validating the agent. Review the change, then retry so the exact durable values can be checked.",
  );
}

async function firstRunConfigDrift(
  path: string,
  expected: CliConfigSnapshot,
): Promise<ReadinessProbeFailure | undefined> {
  let current: CliConfigSnapshot;
  try {
    current = await readCliConfigSnapshot(path);
  } catch {
    return dotenvReadinessFailure(
      "The committed config became unreadable or unsafe during setup. Readiness cannot be claimed.",
    );
  }
  if (current.fingerprint === expected.fingerprint) return undefined;
  return dotenvReadinessFailure(
    "The committed config changed while setup was validating the agent. Review the change, then retry so the exact plan can be checked.",
  );
}

async function firstRunSecretEnvGuardFailure(
  path: string,
  required: boolean,
): Promise<ReadinessProbeFailure | undefined> {
  if (!required) return undefined;
  try {
    if (await verifySecretEnvPersistenceGuard(path)) return undefined;
  } catch {
    // Fall through to one stable, non-secret-bearing operator message.
  }
  return dotenvReadinessFailure(
    "The committed .env is no longer owner-only, safely ignored, and untracked. Readiness cannot be claimed.",
  );
}

function secretPersistenceRecoveryMessage(error: unknown): string {
  const cause = secretEnvConcurrentModificationCause(error);
  return cause === undefined ? "" : ` ${cause.message}`;
}

interface ReadinessProgress {
  readonly planFingerprint: string;
  readonly successfulRouteKeys: readonly string[];
  readonly verifiedModelRefs: readonly string[];
}

function readinessPlanIdentity(plan: WizardPlan): {
  readonly fingerprint: string;
  readonly routes: readonly (Readonly<{ index: number; model: string; effort?: string; key: string }>)[];
} {
  const displayed = readinessRoutesForDisplay(plan);
  const immutable = displayed.map((route, index) => ({
    index,
    model: route.model,
    effort: route.effort ?? null,
  }));
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ version: 1, routes: immutable }))
      .digest("hex"),
    routes: displayed.map((route, index) => ({
      index,
      ...route,
      key: createHash("sha256")
        .update(JSON.stringify({ version: 1, index, model: route.model, effort: route.effort ?? null }))
        .digest("hex"),
    })),
  };
}

function mergeReadinessProgress(
  previous: ReadinessProgress | undefined,
  result: ReadinessProbeResult,
  plan: WizardPlan,
): ReadinessProgress {
  const identity = readinessPlanIdentity(plan);
  const fingerprint = result.planFingerprint ?? identity.fingerprint;
  const successfulKeys = new Set(
    previous?.planFingerprint === fingerprint ? previous.successfulRouteKeys : [],
  );
  const verifiedRefs = new Set(
    previous?.planFingerprint === fingerprint ? previous.verifiedModelRefs : [],
  );
  const reported = result.routes ?? (result.ok
    ? identity.routes.map((route): ReadinessRouteResult => ({ ...route, status: "verified" }))
    : []);
  for (const route of reported) {
    if (route.status === "verified" || route.status === "skipped_verified") {
      successfulKeys.add(route.key);
      verifiedRefs.add(route.model);
    }
  }
  const currentRefs = new Set(identity.routes.map((route) => route.model));
  return {
    planFingerprint: fingerprint,
    successfulRouteKeys: [...successfulKeys],
    verifiedModelRefs: [...verifiedRefs].filter((ref) => currentRefs.has(ref)),
  };
}

async function runGuidedSandboxPreflight(
  installedEarlier: boolean,
): Promise<ReadinessProbeResult> {
  process.stdout.write("\n" + ui.heading("Sandbox preflight"));
  return await withScopedPreflightCancellation(async (signal) => {
    try {
      process.stdout.write(ui.style.dim(
        installedEarlier
          ? "Rechecking the pinned managed SRT copy and its functional enforcement postcondition.\n"
          : "Installing the pinned managed SRT copy in the private user cache, then running the functional enforcement check.\n",
      ));
      const setup = await setupManagedSrt({ signal, verify: true });
      if (setup.status.source !== "managed" || setup.status.state !== "ready" || setup.check === undefined) {
        throw new Error("Managed SRT setup did not return a ready managed functional-check result.");
      }
      process.stdout.write(`${ui.badge("ok")}Managed SRT ${setup.repaired ? "repaired" : setup.installed ? "installed" : "verified"}; functional postcondition passed.\n`);
      return { ok: true };
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("Preflight was interrupted."));
        return {
          ok: false,
          kind: "cancelled",
          message: "Sandbox preflight was interrupted. No agent files were written.",
          interrupted: true,
        };
      }
      return {
        ok: false,
        kind: "provider_failed",
        message: `[sandbox_preflight_failed] ${reasonOf(error)} No agent files were written; retry setup or edit the sandbox choice.`,
      };
    }
  });
}

async function runReadinessProbeWithSpinner(options: {
  readonly plan: ReturnType<typeof composeWizardPlan>;
  readonly effectiveEnv: Record<string, string | undefined>;
  readonly resolvedPiAuthPath: string;
  readonly resume?: Readonly<{ planFingerprint: string; successfulRouteKeys: readonly string[] }>;
}): Promise<ReadinessProbeResult> {
  const routes = readinessRoutesForDisplay(options.plan);
  process.stdout.write("\n" + ui.heading("Runtime readiness"));
  routes.forEach((route, index) => {
    const timeoutMs = readinessProbeTimeoutMs(parseMonoRuntimeModelReference(route.model));
    process.stdout.write(
      `  Route ${index + 1}/${routes.length}: ${route.model} ` +
      ui.style.dim(`(effort: ${route.effort ?? "provider-default"}; up to ${Math.ceil(timeoutMs / 1_000)}s)`) +
      "\n",
    );
  });
  process.stdout.write(ui.style.dim("Running real no-tool checks sequentially. Press Esc or Ctrl-C once to interrupt safely.\n"));

  return await withScopedPreflightCancellation(async (signal) => {
    try {
      const result = await runAllRouteReadinessProbe({
        plan: options.plan,
        hostEnv: options.effectiveEnv,
        secretValues: selectedSecretValues(options.plan, options.effectiveEnv),
        resolvedPiAuthPath: options.resolvedPiAuthPath,
        abortSignal: signal,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        onRouteStart: (route) => {
          process.stdout.write(
            `  Checking route ${route.index + 1}/${route.total}: ${route.model} ` +
            ui.style.dim(`(effort: ${route.effort ?? "provider-default"})`) +
            "\n",
          );
        },
        onRouteComplete: (route) => {
          const ok = route.status === "verified" || route.status === "skipped_verified";
          process.stdout.write(
            `${ok ? ui.badge("ok") : route.status === "interrupted" ? ui.badge("waiting") : ui.badge("error")}` +
            `Route ${route.index + 1}/${routes.length} ${route.status.replaceAll("_", " ")}\n`,
          );
        },
      });
      process.stdout.write(ui.heading("Readiness summary"));
      printReadinessRouteSummary(result, routes);
      return result;
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        process.stderr.write(ui.errorLine("Preflight was interrupted."));
        return {
          ok: false,
          kind: "cancelled",
          message: "Preflight was interrupted before the current route completed.",
          interrupted: true,
        };
      }
      process.stderr.write(ui.errorLine("[readiness_probe_failed] Runtime readiness could not run."));
      return {
        ok: false,
        kind: "probe_failed",
        message: "Runtime readiness could not run. Review provider authentication and retry.",
      };
    }
  });
}

function readinessRoutesForDisplay(plan: WizardPlan): readonly { model: string; effort?: string }[] {
  const runtime = (plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const primaryEffort = typeof runtime.effort === "string" ? runtime.effort : undefined;
  const routes: Array<{ model: string; effort?: string }> = [];
  if (typeof runtime.model === "string") {
    routes.push({ model: runtime.model, ...(primaryEffort === undefined ? {} : { effort: primaryEffort }) });
  }
  if (Array.isArray(runtime.fallbacks) && runtime.fallbacks.length > 0) {
    for (const raw of runtime.fallbacks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.model !== "string") continue;
      routes.push({
        model: entry.model,
        ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
      });
    }
  } else if (Array.isArray(runtime.fallbackModels)) {
    for (const model of runtime.fallbackModels) {
      if (typeof model === "string") {
        routes.push({ model, ...(primaryEffort === undefined ? {} : { effort: primaryEffort }) });
      }
    }
  }
  return routes;
}

function printReadinessRouteSummary(
  result: ReadinessProbeResult,
  planned: readonly { model: string; effort?: string }[],
): void {
  const reported = result.routes ?? planned.map((route, index): ReadinessRouteResult => ({
    key: `${index}:${route.model}`,
    index,
    ...route,
    status: result.ok ? "verified" : result.kind === "cancelled" ? "interrupted" : "failed",
    ...(!result.ok ? { kind: result.kind, message: result.message } : {}),
  }));
  for (const route of reported) {
    const badge = route.status === "verified" || route.status === "skipped_verified"
      ? ui.badge("ok")
      : route.status === "interrupted"
        ? ui.badge("waiting")
        : ui.badge("error");
    const state = route.status === "skipped_verified" ? "verified earlier" : route.status.replaceAll("_", " ");
    process.stdout.write(
      `${badge}Route ${route.index + 1}/${planned.length}: ${route.model} ` +
      ui.style.dim(`(effort: ${route.effort ?? "provider-default"})`) +
      ` — ${state}${route.message === undefined ? "" : `: ${route.message}`}\n`,
    );
  }
  if (!result.ok && result.interrupted === true) {
    process.stderr.write(ui.errorLine("Preflight was interrupted."));
  }
}

async function withScopedPreflightCancellation<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: { readonly keypress?: boolean } = {},
): Promise<T> {
  const controller = new AbortController();
  let interruptCount = 0;
  const interrupt = (): void => {
    interruptCount += 1;
    controller.abort();
    if (interruptCount > 1) process.exitCode = 130;
  };
  const onKeypress = (_value: string, key: { readonly name?: string; readonly ctrl?: boolean } | undefined): void => {
    if (key?.name === "escape" || (key?.ctrl === true && key.name === "c")) interrupt();
  };
  process.on("SIGINT", interrupt);
  const restoreKeypress = options.keypress === false
    ? () => undefined
    : attachScopedKeypress(onKeypress);
  try {
    return await task(controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
    restoreKeypress();
  }
}

type FirstRunRecovery = "retry" | "auth" | "model" | "edit" | "save" | "cancel";

type InterruptedFirstRunRecovery = "resume" | "restart" | "edit" | "cancel";
type SandboxPreflightRecovery = "retry" | "edit" | "cancel";

function focusedConfigurationRepairStep(sectionIds: readonly string[]): number | undefined {
  const mapped = new Set<number>();
  for (const id of sectionIds) {
    if (id === "agent") mapped.add(0);
    else if (id === "runtime" || id === "credentials") mapped.add(1);
    else if (id === "memory" || id.startsWith("memory:")) mapped.add(3);
    else if (id === "context" || id.startsWith("channel:")) mapped.add(4);
    else if (id === "tools") mapped.add(5);
    else if (id === "sandbox") mapped.add(6);
    else if (id === "observability") mapped.add(7);
  }
  return mapped.size === 1 ? [...mapped][0] : undefined;
}

function configurationRecoveryEditLabel(step: number | undefined): string {
  switch (step) {
    case 0: return "Edit agent name";
    case 1: return "Edit model routes";
    case 3: return "Edit memory";
    case 4: return "Edit capability details";
    case 5: return "Edit tools";
    case 6: return "Edit route safety and sandbox";
    case 7: return "Edit observability";
    default: return "Edit setup choices";
  }
}

async function selectSandboxPreflightRecovery(): Promise<SandboxPreflightRecovery> {
  const recovery = await p.select<SandboxPreflightRecovery>({
    message: "Sandbox preflight did not pass. How would you like to recover?",
    initialValue: "retry",
    options: [
      { value: "retry", label: "Retry sandbox setup and check" },
      { value: "edit", label: "Change safety or other choices" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function selectInterruptedFirstRunRecovery(): Promise<InterruptedFirstRunRecovery> {
  const recovery = await p.select<InterruptedFirstRunRecovery>({
    message: "Preflight was interrupted. What would you like to do?",
    initialValue: "resume",
    options: [
      { value: "resume", label: "Resume preflight", hint: "keeps successful auth, SRT setup, and route checks" },
      { value: "restart", label: "Restart all checks", hint: "keeps successful auth and SRT installation" },
      { value: "edit", label: "Edit setup choices" },
      { value: "cancel", label: "Cancel without writing" },
    ],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function selectFirstRunRecovery(
  failure: ReadinessProbeFailure,
  configurationRepairStep?: number,
  invalidPlanStage?: "configuration" | "final_readiness",
): Promise<FirstRunRecovery> {
  type RecoveryOption = { readonly value: FirstRunRecovery; readonly label: string; readonly hint?: string };
  const sharedTail: readonly RecoveryOption[] = [
    { value: "save", label: "Save incomplete", hint: "does not call the agent ready or start it" },
    { value: "cancel", label: "Cancel without writing" },
  ] as const;
  const providerSetupFailed = failure.kind === "provider_failed"
    && /^Provider setup (?:did not complete|still needs attention)\./u.test(failure.message);
  const message = failure.kind === "invalid_plan"
    ? invalidPlanStage === "final_readiness"
      ? "Final readiness validation did not pass. What would you like to do?"
      : "Configuration preflight did not pass. What would you like to do?"
    : providerSetupFailed
      ? "Provider setup did not pass. What would you like to do?"
      : "Runtime readiness did not pass. What would you like to do?";
  const options: readonly RecoveryOption[] = failure.kind === "invalid_plan"
    ? [
        { value: "edit", label: configurationRecoveryEditLabel(configurationRepairStep) },
        {
          value: "retry",
          label: invalidPlanStage === "final_readiness"
            ? "Retry final readiness validation"
            : "Retry configuration preflight",
        },
        ...sharedTail,
      ]
    : providerSetupFailed
      ? [
          { value: "auth", label: "Repair authentication" },
          { value: "retry", label: "Retry provider setup" },
          { value: "model", label: "Edit model routes" },
          ...sharedTail,
        ]
      : failure.kind === "provider_failed"
      ? [
          { value: "retry", label: "Retry failed route" },
          { value: "auth", label: "Repair authentication" },
          { value: "model", label: "Edit model routes" },
          ...sharedTail,
        ]
      : failure.kind === "unsupported_guided_probe"
        ? [
            { value: "model", label: "Edit model routes" },
            ...sharedTail,
          ]
        : [
            { value: "retry", label: "Retry runtime checks" },
            { value: "model", label: "Edit model routes" },
            ...sharedTail,
          ];
  const recovery = await p.select<FirstRunRecovery>({
    message,
    initialValue: options[0]?.value ?? "cancel",
    options: [...options],
  });
  return p.isCancel(recovery) ? "cancel" : recovery;
}

async function promptProviderSetupSecrets(
  plan: ProviderSetupPlan,
  existing: Readonly<Record<string, string>>,
  existingPersistence: Readonly<Record<string, "secure-store" | "environment">> = {},
  existingEnvironmentSecrets: Readonly<Record<string, string>> = {},
): Promise<{
  readonly apiKeys: Record<string, string>;
  readonly persistenceByProvider: Record<string, "secure-store" | "environment">;
  readonly environmentSecrets: Record<string, string>;
} | undefined> {
  const values = { ...existing };
  const persistenceByProvider = { ...existingPersistence };
  const environmentSecrets = { ...existingEnvironmentSecrets };
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action)) continue;
    const reviewedPersistence = existingPersistence[action.provider];
    const persistence = reviewedPersistence ?? await p.select<"secure-store" | "environment">({
      message: `How should ${action.label} receive ${action.envVar}?`,
      initialValue: "secure-store",
      options: [
        { value: "secure-store", label: "Store securely in Pi auth.json", hint: "owner-only credential store" },
        { value: "environment", label: `Use environment variable ${action.envVar}`, hint: "save it to the agent's owner-only .env" },
      ],
    });
    if (p.isCancel(persistence)) return undefined;
    if (persistence === "environment") {
      delete values[action.id];
      persistenceByProvider[action.provider] = "environment";
      const answer = await p.password({
        message: `Enter ${action.envVar} for the agent's owner-only .env`,
        validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
        clearOnError: true,
      });
      if (p.isCancel(answer)) return undefined;
      environmentSecrets[action.envVar] = answer;
      continue;
    }
    persistenceByProvider[action.provider] = "secure-store";
    delete environmentSecrets[action.envVar];
    const answer = await p.password({
      message: `Enter ${action.label} (${action.envVar})`,
      validate: (value) => (value ?? "").trim().length === 0 ? "API key is required." : undefined,
      clearOnError: true,
    });
    if (p.isCancel(answer)) return undefined;
    values[action.id] = answer;
  }
  return { apiKeys: values, persistenceByProvider, environmentSecrets };
}

function environmentProviderApiKeys(
  plan: ProviderSetupPlan,
  env: CliEnvironment,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const action of plan.actions) {
    if (!isProviderSetupPiApiKeyAction(action) || action.persistence !== "environment") continue;
    const value = env[action.envVar];
    if (nonEmptyEnv(value)) values[action.id] = value;
  }
  return values;
}

async function selectCodexAuthMode(
  initialValue: CodexLoginMode,
): Promise<CodexLoginMode | undefined> {
  const selected = await p.select<CodexLoginMode>({
    message: "How should Codex authenticate on this machine?",
    initialValue,
    options: [
      { value: "browser", label: "Browser login", hint: "opens a localhost callback server" },
      { value: "device", label: "Device-code login", hint: "recommended for remote or headless machines" },
    ],
  });
  return p.isCancel(selected) ? undefined : selected;
}

function configuredSecretNames(
  result: InitMonoAgentFolderResult,
  effectiveEnv: CliEnvironment,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const secret of result.plan.secrets) {
    if (nonEmptyEnv(effectiveEnv[secret.envVar])) names.add(secret.envVar);
  }
  return names;
}

function printIncompleteSetup(reasons: readonly string[], configPath: string): void {
  process.stderr.write(ui.hint("INCOMPLETE SETUP: no readiness claim was made and the agent was not started.\n"));
  for (const reason of reasons) process.stderr.write(ui.style.yellow(`  - ${reason}\n`));
  process.stderr.write(ui.hint(`Review ${configPath}, run \`mono-agent validate\`, then retry the first turn.\n`));
}

export function shouldRunInitWizard(args: ParsedCliArgs, stdinIsTty: boolean, stdoutIsTty: boolean): boolean {
  if (!stdinIsTty || !stdoutIsTty || args.command !== "init" || args.positionals.length > 0) {
    return false;
  }
  if (args.force || args.foreground || args.follow || args.all || args.dryRun || args.includeMemory) {
    return false;
  }
  // A bare parsed init has only these required/default keys. Treat every
  // optional key—current or future—as an overriding flag so the documented
  // "any flag is scaffold-only" contract cannot silently drift again.
  const bareKeys = new Set([
    "command",
    "positionals",
    "force",
    "foreground",
    "follow",
    "all",
    "dryRun",
    "includeMemory",
  ]);
  return Object.keys(args).every((key) => bareKeys.has(key));
}

export type InitProviderSetupStatus = "ok" | "failed" | "skipped" | "interrupted" | "fatal";

export interface RunProviderSetupBeforeInitOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly auth: boolean;
  readonly dryRun: boolean;
  readonly piAuthPath?: string;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  readonly codexAuthMode?: CodexLoginMode;
  readonly forceAuthentication?: boolean;
  readonly credentialStates?: Readonly<Record<string, ProviderCredentialState | undefined>>;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly piApiKeyPersistenceByProvider?: Readonly<Record<string, "secure-store" | "environment" | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly execute?: (plan: ProviderSetupPlan) => Promise<readonly ProviderSetupResult[]>;
}

export async function runProviderSetupBeforeInit(
  options: RunProviderSetupBeforeInitOptions,
): Promise<InitProviderSetupStatus> {
  const credentialStates = options.credentialStates !== undefined
    ? options.credentialStates
    : options.forceAuthentication === true || !options.auth || options.dryRun
      ? undefined
    : await detectProviderCredentialStates({
        modelRefs: options.modelRefs,
        cwd: options.cwd,
        ...(options.piAuthPath === undefined ? {} : { piAuthPath: options.piAuthPath }),
        ...(options.persistedEnv === undefined ? {} : { persistedEnv: options.persistedEnv }),
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      });
  const plan = planProviderSetup({
    ...options,
    ...(credentialStates === undefined ? {} : { credentialStates }),
    ...(options.codexAuthMode === undefined ? {} : { codexAuthMode: options.codexAuthMode }),
    ...(options.forceAuthentication === undefined ? {} : { forceAuthentication: options.forceAuthentication }),
  });
  if (plan.actions.length === 0) {
    return "skipped";
  }
  if (options.dryRun) {
    process.stdout.write("\n" + ui.heading("Provider setup"));
    process.stdout.write(ui.style.dim("Dry run - provider auth/preflight commands were not launched.\n"));
    printProviderSetupPlan(plan);
    return "skipped";
  }
  if (!options.auth) {
    return "skipped";
  }

  process.stdout.write("\n" + ui.heading("Provider setup"));
  printProviderSetupPlan(plan);
  if (options.abortSignal !== undefined) {
    process.stdout.write(ui.style.dim("Press Ctrl-C once to interrupt authentication safely.\n"));
  }
  const results = await (options.execute ?? ((setupPlan) => executeProviderSetupPlan(setupPlan, {
    ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  })))(plan);
  const interrupted = options.abortSignal?.aborted === true;
  for (const result of results) {
    const badge = interrupted && result.status === "failed"
      ? ui.badge("waiting")
      : result.status === "ok"
      ? ui.badge("ok")
      : result.status === "skipped"
        ? ui.style.dim("- ")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  if (results.some((result) => result.failureKind !== undefined)) {
    process.stderr.write(ui.errorLine(
      "Provider setup ended in an unconfirmed process or credential-cleanup state. Follow the reported manual cleanup guidance before retrying; automatic recovery is disabled.",
    ));
    return "fatal";
  }
  if (interrupted) {
    process.stderr.write(ui.errorLine("Provider setup was interrupted."));
    return "interrupted";
  }
  if (results.some((result) => result.status === "failed")) {
    process.stderr.write(ui.errorLine("Provider setup failed; init stopped before writing files."));
    return "failed";
  }
  return "ok";
}

export async function runAuth(args: ParsedCliArgs): Promise<number> {
  const [subcommand, provider, ...extra] = args.positionals;
  if (subcommand !== "login" || provider === undefined || extra.length > 0) {
    process.stderr.write(ui.errorLine(
      "Usage: mono-agent auth login <provider|codex> [--pi-auth-path <path>] [--api-key-stdin] [--codex-auth browser|device] [--config <path>].",
    ));
    return 2;
  }

  const cwd = process.cwd();
  const configPath = await canonicalBackgroundConfigPath(cwd, args.configPath);
  const directCodex = provider === "codex";
  if (directCodex && args.piAuthPath !== undefined) {
    process.stderr.write(ui.errorLine("--pi-auth-path does not apply to direct Codex login."));
    return 2;
  }
  let configuredPiAuthPath: string;
  try {
    configuredPiAuthPath = directCodex ? resolve(cwd, ".pi", "auth.json") : await resolvePiAuthPathForLogin({
      configPath,
      cwd,
      ...(process.env.MONO_AGENT_PI_AUTH_PATH === undefined
        ? {}
        : { envPath: process.env.MONO_AGENT_PI_AUTH_PATH }),
      ...(args.piAuthPath === undefined ? {} : { piAuthPath: args.piAuthPath }),
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Cannot resolve the Pi auth path from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  const plan = planProviderSetup({
    modelRefs: [directCodex ? "codex:gpt-5.6-terra" : `pi:${provider}:credential-setup`],
    cwd,
    piAuthPath: configuredPiAuthPath,
    forceAuthentication: true,
    ...(args.codexAuthMode === undefined ? {} : { codexAuthMode: args.codexAuthMode }),
  });
  if (plan.actions.length === 0) {
    process.stderr.write(ui.errorLine(
      `Provider \`${provider}\` has no interactive auth method in the bundled ${directCodex ? "Codex" : "Pi"} provider catalog.`,
    ));
    return 2;
  }

  const apiKeyActions = plan.actions.filter(isProviderSetupPiApiKeyAction);
  if (args.apiKeyStdin === true && apiKeyActions.length !== 1) {
    process.stderr.write(ui.errorLine(
      "--api-key-stdin is only supported when the selected provider has one bundled API-key login action.",
    ));
    return 2;
  }

  process.stdout.write("\n" + ui.heading(directCodex ? "Codex authentication" : "Pi authentication"));
  printProviderSetupPlan(plan);

  let apiKeys: Readonly<Record<string, string>> | undefined;
  const apiKeyAction = apiKeyActions[0];
  if (apiKeyAction !== undefined) {
    let apiKey: string;
    if (args.apiKeyStdin === true) {
      if (process.stdin.isTTY === true) {
        process.stderr.write(ui.errorLine(
          "--api-key-stdin requires redirected standard input. Omit the flag to enter the key in a masked prompt.",
        ));
        return 2;
      }
      try {
        apiKey = await readApiKeyFromStdin(process.stdin);
      } catch {
        process.stderr.write(ui.errorLine(
          `Could not read a valid ${apiKeyAction.envVar} value from standard input; no credentials were written.`,
        ));
        return 1;
      }
    } else {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        process.stderr.write(ui.errorLine(
          `Cannot securely prompt for ${apiKeyAction.envVar} without an interactive TTY. ` +
          `Run this command in a terminal, or pipe the value explicitly with --api-key-stdin; no credentials were written.`,
        ));
        return 1;
      }
      const answer = await p.password({
        message: `Enter ${apiKeyAction.label} (${apiKeyAction.envVar})`,
        validate: (value) => apiKeyInputProblem(value ?? ""),
        clearOnError: true,
      });
      if (p.isCancel(answer)) {
        process.stderr.write(ui.errorLine("Authentication was cancelled; no credentials were written."));
        return 130;
      }
      apiKey = answer.trim();
    }
    apiKeys = { [apiKeyAction.id]: apiKey };
  }

  process.stdout.write(ui.style.dim("Press Ctrl-C once to interrupt authentication safely.\n"));
  const execution = await withScopedPreflightCancellation(async (abortSignal) => ({
    results: await executeProviderSetupPlan(plan, {
      ...(apiKeys === undefined ? {} : { apiKeys }),
      abortSignal,
    }),
    interrupted: abortSignal.aborted,
  }), { keypress: false });
  const { results } = execution;
  for (const result of results) {
    const badge = execution.interrupted && result.status === "failed"
      ? ui.badge("waiting")
      : result.status === "ok"
        ? ui.badge("ok")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  if (results.some((result) => result.failureKind !== undefined)) {
    process.stderr.write(ui.errorLine(
      "Provider setup ended in an unconfirmed process or credential-cleanup state. Follow the reported manual cleanup guidance before retrying; automatic recovery is disabled.",
    ));
    return 130;
  }
  if (execution.interrupted) {
    process.stderr.write(ui.errorLine("Authentication was interrupted; temporary credentials were cleaned up."));
    return 130;
  }
  return results.every((result) => result.status === "ok") ? 0 : 1;
}

const MAX_STANDALONE_API_KEY_BYTES = 65_536;

function apiKeyInputProblem(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return "API key is required.";
  if (normalized.includes("\0") || /[\r\n]/u.test(normalized)) return "API key must be a single non-empty line.";
  if (Buffer.byteLength(normalized, "utf8") > MAX_STANDALONE_API_KEY_BYTES) return "API key is too large.";
  return undefined;
}

/**
 * Read one explicitly redirected API key without consulting ambient provider
 * environment variables. A single trailing line ending from `echo` is accepted;
 * embedded newlines, NUL bytes, empty input, and unbounded input fail closed.
 */
export async function readApiKeyFromStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input as NodeJS.ReadableStream & AsyncIterable<string | Uint8Array>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_STANDALONE_API_KEY_BYTES + 2) throw new Error("API key input is too large.");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  const problem = apiKeyInputProblem(value);
  if (problem !== undefined) throw new Error(problem);
  return value.trim();
}

export async function resolvePiAuthPathForLogin(options: {
  readonly piAuthPath?: string;
  readonly envPath?: string;
  readonly configPath: string;
  readonly cwd?: string;
}): Promise<string> {
  // A missing config is represented by readMonoAgentConfigJson as `missing`; a
  // malformed or unreadable config throws and must remain visible to operators.
  const result = await readMonoAgentConfigJson(options.configPath);
  const configured = result.missing ? undefined : result.json.providers?.piAuthPath;
  return resolveEffectivePiAuthPath({
    cwd: options.cwd ?? dirname(resolve(options.configPath)),
    ...(nonEmptyEnv(options.piAuthPath) ? { explicitPath: options.piAuthPath } : {}),
    ...(nonEmptyEnv(options.envPath) ? { envPath: options.envPath } : {}),
    ...(nonEmptyEnv(configured) ? { configPath: configured } : {}),
  });
}

function printProviderSetupPlan(plan: ProviderSetupPlan): void {
  for (const action of plan.actions) {
    process.stdout.write(
      `  ${action.label}: ${providerSetupActionCommandLine(action)} ${ui.style.dim(`(cwd: ${action.cwd})`)}\n`,
    );
  }
}

/**
 * Resolve the preset id for `init`: `--preset` wins. Returns the preset id to
 * compose from, `undefined` for the default scaffold, or `"unknown"` after
 * emitting the error/hint for an unknown preset.
 */
function resolveInitPresetId(args: ParsedCliArgs): string | undefined | "unknown" {
  if (args.preset !== undefined) {
    const preset = findPreset(args.preset);
    if (preset === undefined) {
      process.stderr.write(ui.errorLine(`Unknown preset \`${args.preset}\`.`));
      process.stderr.write(ui.hint(`Available presets: ${presetIds().join(", ")}. Run \`mono-agent presets list\`.`));
      return "unknown";
    }
    return preset.id;
  }
  return undefined;
}

function resolveWithChannels(args: ParsedCliArgs): readonly WithChannel[] | undefined | "invalid" {
  if (args.withChannels === undefined) {
    return undefined;
  }
  const invalid = args.withChannels.filter((channel) => !isWithChannel(channel));
  if (invalid.length > 0) {
    process.stderr.write(ui.errorLine(`Unknown --with channel(s): ${invalid.join(", ")}.`));
    process.stderr.write(ui.hint("Valid channels: telegram, slack, webhook, openaiApi, cron."));
    return "invalid";
  }
  return args.withChannels.filter(isWithChannel);
}

export interface InitChangeDisplayRow {
  readonly label: "created" | "updated" | "kept" | "would create" | "would update";
  readonly path: string;
  readonly unchanged: boolean;
}

/** Safe reporting rows: paths and outcomes only, never secret contents. */
export function initChangeDisplayRows(result: InitMonoAgentFolderResult): readonly InitChangeDisplayRow[] {
  const labels = {
    created: "created",
    updated: "updated",
    unchanged: "kept",
    "planned-create": "would create",
    "planned-update": "would update",
  } as const;
  return result.changes.map((change) => ({
    label: labels[change.kind],
    path: change.path,
    unchanged: change.kind === "unchanged",
  }));
}

/** Human-readable, value-free proof of where the wizard Role did (or did not) land. */
export function identityRoleDisplayLine(identityRole: InitMonoAgentFolderResult["identityRole"]): string {
  switch (identityRole.status) {
    case "created":
      return `Role saved to ${identityRole.path} → ${identityRole.section}. ` +
        `Edit ${identityRole.path} → ${identityRole.section} later to change it.`;
    case "preserved":
      return `${identityRole.path} already existed and was preserved; the entered Role was not written. ` +
        `Add or edit ${identityRole.path} → ${identityRole.section} to set it.`;
    case "planned-create":
      return `Dry run: Role would be saved to ${identityRole.path} → ${identityRole.section}.`;
  }
}

export interface SecretChecklistDisplayRow {
  readonly envVar: string;
  readonly label: string;
  readonly description: string;
  readonly status: "configured" | "missing" | "optional";
}

export function secretChecklistDisplayRows(
  secrets: readonly SecretChecklistItem[],
  configured: ReadonlySet<string>,
): readonly SecretChecklistDisplayRow[] {
  return secrets.map((secret) => ({
    envVar: secret.envVar,
    label: secret.label,
    description: secret.description,
    status: configured.has(secret.envVar) ? "configured" : secret.required ? "missing" : "optional",
  }));
}

function printInitResult(result: InitMonoAgentFolderResult): void {
  if (result.dryRun) {
    process.stdout.write(ui.style.dim("Dry run — nothing was written.\n"));
  }
  for (const row of initChangeDisplayRows(result)) {
    const prefix = row.unchanged ? "  " : ui.badge("ok");
    const rendered = row.unchanged
      ? ui.style.dim(row.label.padEnd(12))
      : ui.style.green(row.label.padEnd(12));
    // Sensitive files are safe to identify by path; their contents are never
    // included in this result or printed here.
    process.stdout.write(`${prefix}${rendered}  ${row.path}\n`);
  }
  process.stdout.write(`\n${identityRoleDisplayLine(result.identityRole)}\n`);
  if (result.knowledgeFiles.length > 0) {
    process.stdout.write(`\nIdentity references existing knowledge: ${ui.style.cyan(result.knowledgeFiles.join(", "))}\n`);
  }
  // Internal `provider:*` modules are auto-added for local models; they are an
  // implementation detail, not a user-facing capability, so exclude them here.
  const capabilities = result.plan.selectedModules.filter((module) => module.kind !== "provider");
  if (capabilities.length > 0) {
    process.stdout.write("\n" + ui.heading("Capabilities"));
    for (const module of capabilities) {
      process.stdout.write(`  ${ui.style.cyan(module.title)} ${ui.style.dim(`(risk: ${riskColor(module.riskLevel)})`)}\n`);
    }
  }
  if (result.secretPersistence.status === "persisted") {
    process.stdout.write("\n" + ui.style.dim(
      result.secretPersistence.changed
        ? "Required secrets were securely merged into .env (mode 0600).\n"
        : "Required secrets were already securely configured in .env.\n",
    ));
  } else if (result.secretPersistence.status === "planned") {
    process.stdout.write("\n" + ui.style.dim("Dry run: required secrets would be securely merged into .env.\n"));
  } else if (result.secretPersistence.status === "refused") {
    process.stderr.write(ui.hint(
      `Automatic secret persistence was refused${result.secretPersistence.reason === undefined ? "" : ` (${result.secretPersistence.reason})`}. No secret value was written.\n` +
      (result.secretPersistence.detail === undefined ? "" : `${result.secretPersistence.detail}\n`),
    ));
  } else if (result.plan.envExample !== undefined) {
    process.stdout.write("\n" + ui.style.dim("Use .env.example as a reference and add missing values to .env; do not overwrite an existing .env.\n"));
  }
}

function printSecretsChecklist(
  secrets: readonly SecretChecklistItem[],
  configured: ReadonlySet<string> = new Set(),
): void {
  process.stdout.write("\n" + ui.heading("Secrets checklist"));
  if (secrets.length === 0) {
    process.stdout.write(ui.style.dim("No secrets required by the selected capabilities.\n"));
    return;
  }
  process.stdout.write(ui.style.dim("Secret values are never written to config JSON and are never printed.\n"));
  for (const secret of secretChecklistDisplayRows(secrets, configured)) {
    const status = secret.status === "configured"
      ? ui.style.green(secret.status)
      : ui.style.yellow(secret.status);
    process.stdout.write(
      `  ${ui.style.bold(secret.envVar)} ${ui.style.dim(`- ${secret.label}: ${secret.description}`)} ${status}\n`,
    );
  }
}

function printNextSteps(configPath: string): void {
  const startCommand = process.platform === "darwin" ? "mono-agent start" : "mono-agent start --foreground";
  const tuiCommand = process.platform === "darwin"
    ? `mono-agent tui --configure ${ui.style.dim("(after the agent reports ready)")}`
    : `mono-agent tui ${ui.style.dim("(ordinary chat after foreground startup; edit config files manually)")}`;
  process.stdout.write(
    "\n" +
      ui.heading("Next steps") +
      `  ${ui.style.bold("1.")} Edit ${configPath} ${ui.style.dim("(model, channels, skills, memory, sandbox)")}\n` +
      `  ${ui.style.bold("2.")} mono-agent validate\n` +
      `  ${ui.style.bold("3.")} ${startCommand}\n` +
      `  ${ui.style.bold("4.")} ${tuiCommand}\n`,
  );
}

function printUnsupportedGuidedInitHandoff(configPath: string, envFile?: string): void {
  const flags = guidedHandoffFlags(configPath, envFile);
  process.stdout.write(
    "\n" +
      ui.heading("Manual start required") +
      ui.style.yellow("Automatic background start and configuration chat require macOS launchd.\n") +
      ui.style.dim("The validated agent files were preserved, but no agent process was started and readiness is not claimed.\n") +
      `  ${ui.style.bold("Configure manually:")} edit ${configPath} and IDENTITY.md, then run mono-agent validate${flags}\n` +
      `  ${ui.style.bold("Terminal 1:")} mono-agent start --foreground${flags}\n` +
      `  ${ui.style.bold("Terminal 2:")} mono-agent tui${flags} ${ui.style.dim("(ordinary chat after startup completes)")}\n` +
      ui.style.dim("Conversational configuration requires the managed macOS background lifecycle.\n"),
  );
}

function printUnexpectedGuidedBackgroundFailure(configPath: string, envFile: string | undefined, error: unknown): void {
  const flags = guidedHandoffFlags(configPath, envFile);
  const paths = launchdPathsFor(deriveLaunchdLabel(configPath));
  process.stderr.write(ui.errorLine(
    `The background lifecycle failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
  ));
  process.stderr.write(ui.style.dim(
    "The validated agent files were preserved, but configuration chat was not opened. Retry or inspect with:\n",
  ));
  process.stderr.write(
    `  ${ui.style.gray("logs:  ")} ${paths.stderrPath}\n` +
      `          ${paths.stdoutPath}\n` +
      `  ${ui.style.gray("retry: ")} mono-agent start${flags}\n` +
      `  ${ui.style.gray("status:")} mono-agent status${flags}\n` +
      `  ${ui.style.gray("follow:")} mono-agent logs${flags} --follow\n`,
  );
}

function guidedHandoffFlags(configPath: string, envFile?: string): string {
  return ` --config ${shellCommandArgument(configPath)}`
    + (envFile === undefined ? "" : ` --env-file ${shellCommandArgument(envFile)}`);
}

function shellCommandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}


async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
