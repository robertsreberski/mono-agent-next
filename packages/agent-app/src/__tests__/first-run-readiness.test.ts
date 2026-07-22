import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateMonoAgentFolder, type ValidationReport } from "../doctor.js";
import { initMonoAgentFolder } from "../init.js";
import {
  effectiveFirstRunEnvironment,
  evaluateFirstRunConfigurationReadiness,
  evaluateFirstRunReadiness,
  hasSensitivePersistedEnvironmentValue,
  piAuthPathBackgroundConflict,
  readCliConfigSnapshot,
  readCliDotenvFile,
  readCliDotenvSnapshot,
  resolveEffectivePiAuthPath,
  selectedSecretEnvironmentConflicts,
  selectedSecretValues,
  unexpectedPersistedMonoAgentOverrides,
  validateWizardPlanInStaging,
  withExactProcessEnvironment,
} from "../first-run-readiness.js";
import { composeWizardPlan, defaultAnswers, referencedSetupModelRefs } from "../wizard/answers.js";
import { findPreset, presetAnswers } from "../wizard/presets.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function telegramPlan() {
  return composeWizardPlan(defaultAnswers({
    channels: ["channel:telegram"],
    moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
  }), { dirBasename: "test-agent", skillsRootExists: false });
}

function cronPlan(expression = "0 8 * * *") {
  return composeWizardPlan(defaultAnswers({
    channels: ["channel:cron"],
    moduleInputs: { "channel:cron": { cronExpression: expression } },
  }), { dirBasename: "test-agent", skillsRootExists: false });
}

function presetPlan(presetId: "local-private" | "telegram-assistant") {
  return composeWizardPlan(presetAnswers(findPreset(presetId)!), {
    dirBasename: "test-agent",
    skillsRootExists: false,
  });
}

function stubOllamaModels(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({
        models: ["nomic-embed-text:v1.5", "llama3.1:8b"].map((name) => ({ name })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/show")) {
      return new Response(JSON.stringify({ capabilities: ["embedding"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/embed")) {
      return new Response(JSON.stringify({ embeddings: [new Array<number>(768).fill(0.01)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected first-run readiness Ollama request: ${url}`);
  }));
}

function presetEnvironment(presetId: "local-private" | "telegram-assistant") {
  return presetId === "telegram-assistant"
    ? {
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "test-telegram-token",
        MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS: "true",
      }
    : {};
}

function report(
  statuses: Readonly<Record<string, "ok" | "waiting" | "disabled" | "error">>,
  annotations: Readonly<Record<string, {
    readonly label?: string;
    readonly details?: readonly string[];
  }>> = {},
): ValidationReport {
  const sections = Object.entries(statuses).map(([id, status]) => ({
    id,
    label: annotations[id]?.label ?? id,
    status,
    details: annotations[id]?.details ?? [],
  }));
  const structurallyValid = sections.every((section) => section.status !== "error");
  const operationallyReady = structurallyValid && sections.every((section) => section.status !== "waiting");
  return { sections, structurallyValid, operationallyReady, ok: structurallyValid };
}

describe("first-run environment", () => {
  it("loads durable values without replacing operational state, then overlays entered values", () => {
    const result = effectiveFirstRunEnvironment({
      shellEnv: {
        PATH: "/shell/bin",
        HOME: "/shell/home",
        OPENAI_API_KEY: "shell-openai",
        ANTHROPIC_API_KEY: "shell-anthropic",
        CODEX_HOME: "/tmp/shell-only-codex",
        CLAUDE_CONFIG_DIR: "/tmp/shell-only-claude",
        MONO_AGENT_ALLOWED_TOOLS: "shell,tools",
        MONO_AGENT_MODEL: "pi:shell:model",
        MONO_AGENT_OPENAI_API_KEY: "shell-mono-openai",
      },
      dotenvEnv: {
        PATH: "/dotenv/bin",
        HOME: "/dotenv/home",
        OPENAI_API_KEY: "persisted-openai",
        CODEX_HOME: "/Users/example/.codex",
        CLAUDE_CONFIG_DIR: "/Users/example/.claude",
        DOTENV_ONLY: "yes",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "old",
      },
      enteredSecrets: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "new" },
      resolvedPiAuthPath: "/auth/pi.json",
    });
    expect(result).toMatchObject({
      PATH: "/shell/bin",
      HOME: "/shell/home",
      OPENAI_API_KEY: "persisted-openai",
      CODEX_HOME: "/Users/example/.codex",
      CLAUDE_CONFIG_DIR: "/Users/example/.claude",
      DOTENV_ONLY: "yes",
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "new",
      MONO_AGENT_PI_AUTH_PATH: "/auth/pi.json",
    });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("MONO_AGENT_ALLOWED_TOOLS");
    expect(result).not.toHaveProperty("MONO_AGENT_MODEL");
    expect(result).not.toHaveProperty("MONO_AGENT_OPENAI_API_KEY");
  });

  it("reports persisted wizard-plan overrides by exact name while allowing secrets and Pi auth", () => {
    const plan = telegramPlan();
    expect(unexpectedPersistedMonoAgentOverrides(plan, {
      MONO_AGENT_ALLOWED_TOOLS: "bash",
      MONO_AGENT_MAX_TURNS: "9",
      MONO_AGENT_PI_AUTH_PATH: "./auth.json",
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "telegram-secret",
      MONO_AGENT_OPENAI_API_KEY: "openai-secret",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "CUSTOM_KEY",
    })).toEqual([
      "MONO_AGENT_ALLOWED_TOOLS",
      "MONO_AGENT_MAX_TURNS",
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
    ]);
  });

  it("detects only selected secret conflicts and exposes selected probe values", () => {
    const plan = telegramPlan();
    expect(selectedSecretEnvironmentConflicts(
      plan,
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "shell", UNRELATED: "shell" },
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "dotenv", UNRELATED: "dotenv" },
    )).toEqual(["MONO_AGENT_TELEGRAM_BOT_TOKEN"]);
    expect(selectedSecretEnvironmentConflicts(
      plan,
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "shell-only" },
      {},
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "newly-entered" },
    )).toEqual(["MONO_AGENT_TELEGRAM_BOT_TOKEN"]);
    expect(selectedSecretEnvironmentConflicts(
      plan,
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "same" },
      {},
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "same" },
    )).toEqual([]);
    expect(selectedSecretValues(plan, {
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "persisted",
      OTHER_TOKEN: "not selected",
    })).toEqual({ MONO_AGENT_TELEGRAM_BOT_TOKEN: "persisted" });
  });

  it("recognizes durable provider credentials that require secure dotenv handling", () => {
    expect(hasSensitivePersistedEnvironmentValue({ OPENAI_API_KEY: "provider-key" })).toBe(true);
    expect(hasSensitivePersistedEnvironmentValue({ ANTHROPIC_AUTH_TOKEN: "provider-token" })).toBe(true);
    expect(hasSensitivePersistedEnvironmentValue({ GOOGLE_APPLICATION_CREDENTIALS: "/private/key.json" })).toBe(true);
    expect(hasSensitivePersistedEnvironmentValue({ OPENAI_API_KEY: "", OLLAMA_HOST: "localhost:11434" })).toBe(false);
  });

  it("parses dotenv separately without mutating process.env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "first-run-env-"));
    temporaryDirectories.push(dir);
    const path = join(dir, ".env");
    const before = process.env.FIRST_RUN_TEST_TOKEN;
    await writeFile(path, "FIRST_RUN_TEST_TOKEN='from file'\n");
    expect(await readCliDotenvFile(path)).toEqual({ FIRST_RUN_TEST_TOKEN: "from file" });
    expect(process.env.FIRST_RUN_TEST_TOKEN).toBe(before);
    await expect(readCliDotenvFile(join(dir, "missing"))).resolves.toEqual({});
  });

  it("fingerprints an open regular dotenv handle and refuses symlink or directory inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "first-run-safe-env-"));
    temporaryDirectories.push(dir);
    const target = join(dir, "target.env");
    const link = join(dir, "linked.env");
    const directory = join(dir, "directory.env");
    await writeFile(target, "TOKEN=secret\n", { mode: 0o600 });
    await symlink(target, link);
    await mkdir(directory);

    const snapshot = await readCliDotenvSnapshot(target);
    expect(snapshot.env).toEqual({ TOKEN: "secret" });
    expect(snapshot.fingerprint).not.toContain("secret");
    await expect(readCliDotenvSnapshot(link)).rejects.toThrow(/symbolic link/u);
    await expect(readCliDotenvSnapshot(directory)).rejects.toThrow(/not a regular file/u);
  });

  it("binds config snapshots to exact regular-file contents and identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "first-run-safe-config-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "mono-agent.config.json");
    const link = join(dir, "linked.config.json");
    await writeFile(path, "{\"runtime\":{}}\n", { mode: 0o600 });
    await symlink(path, link);

    const before = await readCliConfigSnapshot(path);
    expect(before.contents).toBe("{\"runtime\":{}}\n");
    expect(before.fingerprint).not.toContain(before.contents);
    await writeFile(path, "{\"runtime\":{\"maxTurns\":2}}\n", { mode: 0o600 });
    const after = await readCliConfigSnapshot(path);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    await expect(readCliConfigSnapshot(link)).rejects.toThrow(/symbolic link/u);
  });

  it("rejects FIFO and device dotenv inputs without blocking before the regular-file check", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "first-run-special-env-"));
    temporaryDirectories.push(dir);
    const fifo = join(dir, "fifo.env");
    await execFileAsync("mkfifo", [fifo]);

    const pending = readCliDotenvSnapshot(fifo);
    let blockTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "blocked" }>((resolveBlocked) => {
        blockTimer = setTimeout(() => resolveBlocked({ kind: "blocked" }), 500);
      }),
    ]);
    if (blockTimer !== undefined) clearTimeout(blockTimer);
    if (outcome.kind === "blocked") {
      // Keep a regression from hanging the test worker forever: a writer lets
      // a blocking read-only open proceed to its fstat rejection.
      await Promise.allSettled([
        execFileAsync("sh", ["-c", "printf x > \"$1\"", "sh", fifo]),
        pending,
      ]);
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(/not a regular file/u);
    }
    await expect(readCliDotenvSnapshot("/dev/null")).rejects.toThrow(/not a regular file/u);
  });

  it("serializes exact durable process environments and restores the caller snapshot", async () => {
    const shellOnlyName = "MONO_AGENT_TEST_SHELL_ONLY_SECRET";
    const durableName = "MONO_AGENT_TEST_DURABLE_SECRET";
    const previousShellOnly = process.env[shellOnlyName];
    const previousDurable = process.env[durableName];
    process.env[shellOnlyName] = "shell-only";
    delete process.env[durableName];
    const durableEnv: Record<string, string | undefined> = { ...process.env, [durableName]: "durable" };
    delete durableEnv[shellOnlyName];

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const holdFirst = new Promise<void>((resolveHold) => {
      releaseFirst = resolveHold;
    });
    let secondStarted = false;

    try {
      const first = withExactProcessEnvironment(durableEnv, async () => {
        expect(process.env[shellOnlyName]).toBeUndefined();
        expect(process.env[durableName]).toBe("durable");
        markFirstStarted();
        await holdFirst;
      });
      await firstStarted;
      const second = withExactProcessEnvironment({ ...durableEnv, [durableName]: "second" }, async () => {
        secondStarted = true;
        expect(process.env[shellOnlyName]).toBeUndefined();
        expect(process.env[durableName]).toBe("second");
      });
      await Promise.resolve();
      expect(secondStarted).toBe(false);
      releaseFirst();
      await Promise.all([first, second]);

      expect(process.env[shellOnlyName]).toBe("shell-only");
      expect(process.env[durableName]).toBeUndefined();
      await expect(withExactProcessEnvironment(durableEnv, async () => {
        throw new Error("exact-env-test");
      })).rejects.toThrow("exact-env-test");
      expect(process.env[shellOnlyName]).toBe("shell-only");
    } finally {
      if (previousShellOnly === undefined) delete process.env[shellOnlyName];
      else process.env[shellOnlyName] = previousShellOnly;
      if (previousDurable === undefined) delete process.env[durableName];
      else process.env[durableName] = previousDurable;
    }
  });
});

describe("Pi auth path", () => {
  it("uses explicit, env, config, default precedence and expands paths", () => {
    const cwd = "/tmp/agent";
    expect(resolveEffectivePiAuthPath({
      cwd,
      explicitPath: "explicit/auth.json",
      envPath: "env/auth.json",
      configPath: "config/auth.json",
    })).toBe(resolve(cwd, "explicit/auth.json"));
    expect(resolveEffectivePiAuthPath({ cwd, envPath: "~/pi/auth.json", configPath: "config/auth.json" }))
      .toBe(resolve(homedir(), "pi/auth.json"));
    expect(resolveEffectivePiAuthPath({ cwd, configPath: "config/auth.json" }))
      .toBe(resolve(cwd, "config/auth.json"));
    expect(resolveEffectivePiAuthPath({ cwd })).toBe(resolve(homedir(), ".pi/agent/auth.json"));
  });

  it("detects shell paths that a background worker cannot reproduce", () => {
    expect(piAuthPathBackgroundConflict({
      cwd: "/tmp/agent",
      shellPath: "shell/auth.json",
      dotenvPath: "dotenv/auth.json",
    })).toBe(true);
    expect(piAuthPathBackgroundConflict({
      cwd: "/tmp/agent",
      shellPath: "shared/auth.json",
      dotenvPath: "shared/auth.json",
    })).toBe(false);
    expect(piAuthPathBackgroundConflict({
      cwd: "/tmp/agent",
      dotenvPath: "dotenv/auth.json",
    })).toBe(false);
  });
});

describe("complete readiness gate", () => {
  it("defers only waiting credentials during configuration preflight", () => {
    const plan = telegramPlan();
    const waitingCredentials = report({
      runtime: "ok",
      credentials: "waiting",
      "channel:telegram": "ok",
    });

    expect(evaluateFirstRunConfigurationReadiness({
      plan,
      report: waitingCredentials,
      secretPersistence: { status: "planned", changed: true },
    })).toEqual({ ready: true, reasons: [] });

    const completeGate = evaluateFirstRunReadiness({
      plan,
      report: waitingCredentials,
      secretPersistence: { status: "planned", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });
    expect(completeGate.ready).toBe(false);
    expect(completeGate.reasons).toHaveLength(1);
    expect(completeGate.reasons[0]).toContain("credentials must be ok, but is waiting");
  });

  it("reports the cron doctor detail and blocks every non-credential waiting expectation", () => {
    const plan = {
      ...telegramPlan(),
      validateExpectations: [
        { sectionId: "runtime", mustBe: "ok" as const },
        { sectionId: "credentials", mustBe: "ok" as const },
        {
          sectionId: "channel:cron",
          mustBe: "ok" as const,
          note: "Use at least one valid enabled cron/*.md job.",
        },
      ],
    };
    const gate = evaluateFirstRunConfigurationReadiness({
      plan,
      report: report(
        { runtime: "ok", credentials: "waiting", "channel:cron": "waiting" },
        {
          "channel:cron": {
            label: "Scheduled jobs (cron)",
            details: ["  Cron job expression is invalid: minute must be between 0 and 59.\nRetry with five fields.  "],
          },
        },
      ),
      secretPersistence: { status: "not-requested", changed: false },
    });

    expect(gate.ready).toBe(false);
    expect(gate.reasons).toHaveLength(1);
    expect(gate.reasons[0]).toBe(
      "channel:cron must be ok, but is waiting (Scheduled jobs (cron) [channel:cron]). " +
      "Cron job expression is invalid: minute must be between 0 and 59. Retry with five fields. " +
      "Use at least one valid enabled cron/*.md job.",
    );
  });

  it.each([
    {
      case: "reachable service with a missing model",
      warning: "[WARN] Embeddings model nomic-embed-text:v1.5 not pulled — run `ollama pull nomic-embed-text:v1.5`.",
    },
    {
      case: "unreachable service",
      warning: "[WARN] Ollama not reachable at http://localhost:11434; journal memory components configured for that endpoint will fail at runtime. Start Ollama or fix the endpoint.",
    },
  ])("propagates the actionable memory warning for $case", ({ warning }) => {
    const plan = {
      ...telegramPlan(),
      validateExpectations: [{
        sectionId: "memory",
        mustBe: "ok" as const,
        note:
          "Ollama must be reachable and contain nomic-embed-text:v1.5; if the model is missing, run `ollama pull nomic-embed-text:v1.5`.",
      }],
    };
    const gate = evaluateFirstRunConfigurationReadiness({
      plan,
      report: report({ memory: "waiting" }, {
        memory: {
          label: "Memory",
          details: [
            "Mode: journal, path: /agent/.mono-agent/memory, writeMode: disabled.",
            warning,
          ],
        },
      }),
      secretPersistence: { status: "not-requested", changed: false },
    });

    expect(gate.ready).toBe(false);
    expect(gate.reasons).toHaveLength(1);
    expect(gate.reasons[0]).toContain(warning);
    expect(gate.reasons[0]).not.toContain("Mode: journal");
  });

  it.each(["error", "disabled"] as const)(
    "does not defer a %s credential section during configuration preflight",
    (credentialStatus) => {
      const gate = evaluateFirstRunConfigurationReadiness({
        plan: telegramPlan(),
        report: report(
          { runtime: "ok", credentials: credentialStatus, "channel:telegram": "ok" },
          {
            credentials: {
              label: "Provider credentials",
              details: ["No durable credentials were found."],
            },
          },
        ),
        secretPersistence: { status: "planned", changed: true },
      });

      expect(gate.ready).toBe(false);
      expect(gate.reasons).toHaveLength(1);
      expect(gate.reasons[0]).toContain(
        `credentials must be ok, but is ${credentialStatus} (Provider credentials [credentials]).`,
      );
      expect(gate.reasons[0]).toContain("No durable credentials were found.");
    },
  );

  it("blocks a missing credential section instead of treating it as deferred", () => {
    const gate = evaluateFirstRunConfigurationReadiness({
      plan: telegramPlan(),
      report: report({ runtime: "ok", "channel:telegram": "ok" }),
      secretPersistence: { status: "planned", changed: true },
    });

    expect(gate.ready).toBe(false);
    expect(gate.reasons).toHaveLength(1);
    expect(gate.reasons[0]).toContain("credentials must be ok, but is missing");
    expect(gate.reasons[0]).toContain("Missing validation section [credentials]");
  });

  it("does not require live route proofs until the complete gate", () => {
    const plan = telegramPlan();
    const readyReport = report({ runtime: "ok", credentials: "ok", "channel:telegram": "ok" });
    expect(evaluateFirstRunConfigurationReadiness({
      plan,
      report: readyReport,
      secretPersistence: { status: "planned", changed: true },
    })).toEqual({ ready: true, reasons: [] });

    const completeGate = evaluateFirstRunReadiness({
      plan,
      report: readyReport,
      secretPersistence: { status: "planned", changed: true },
    });
    expect(completeGate.ready).toBe(false);
    expect(completeGate.reasons).toEqual([
      "Runtime route codex:gpt-5.6-terra has not completed its exact live readiness check.",
    ]);
  });

  it("blocks refused secret persistence in configuration preflight", () => {
    const gate = evaluateFirstRunConfigurationReadiness({
      plan: telegramPlan(),
      report: report({ runtime: "ok", credentials: "waiting", "channel:telegram": "ok" }),
      secretPersistence: {
        status: "refused",
        changed: false,
        reason: "unsafe-env-path",
        detail: "Repair /safe/.env before retrying.",
      },
    });
    expect(gate.ready).toBe(false);
    expect(gate.reasons).toEqual([
      "Secure secret persistence was refused (unsafe-env-path). Repair /safe/.env before retrying.",
    ]);
  });

  it("emits one bounded, unambiguous reason for an expected section error", () => {
    const repeatedDetail = `Invalid cron expression. ${"x".repeat(400)}`;
    const base = telegramPlan();
    const plan = {
      ...base,
      validateExpectations: [
        ...base.validateExpectations,
        { sectionId: "channel:cron", mustBe: "ok" as const, note: "Fix the cron job." },
        { sectionId: "channel:cron", mustBe: "ok" as const, note: "Fix the cron job." },
      ],
    };
    const gate = evaluateFirstRunConfigurationReadiness({
      plan,
      report: report(
        {
          runtime: "ok",
          credentials: "waiting",
          "channel:telegram": "ok",
          "channel:cron": "error",
        },
        { "channel:cron": { label: "Scheduled jobs (cron)", details: [repeatedDetail] } },
      ),
      secretPersistence: { status: "planned", changed: true },
    });

    expect(gate.ready).toBe(false);
    expect(gate.reasons).toHaveLength(1);
    expect(gate.reasons[0]).not.toContain("complete generated configuration has validation errors");
    expect(gate.reasons[0]?.length).toBeLessThan(450);
    expect(gate.reasons[0]).toContain("… Fix the cron job.");
  });

  it("reports unrelated doctor errors even when selected expectations are ready", () => {
    const gate = evaluateFirstRunConfigurationReadiness({
      plan: telegramPlan(),
      report: report(
        {
          runtime: "ok",
          credentials: "waiting",
          "channel:telegram": "ok",
          core: "error",
        },
        { core: { label: "Core config", details: ["Generated config is not loadable."] } },
      ),
      secretPersistence: { status: "planned", changed: true },
    });

    expect(gate).toEqual({
      ready: false,
      reasons: ["Validation error in Core config [core]. Generated config is not loadable."],
    });
  });

  it("requires every selected expectation and secure persistence", () => {
    const plan = telegramPlan();
    const readyReport = report({ runtime: "ok", credentials: "ok", "channel:telegram": "ok" });
    expect(evaluateFirstRunReadiness({
      plan,
      report: readyReport,
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    })).toEqual({ ready: true, reasons: [] });

    const waiting = evaluateFirstRunReadiness({
      plan,
      report: report({ runtime: "ok", credentials: "ok", "channel:telegram": "waiting" }),
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });
    expect(waiting.ready).toBe(false);
    expect(waiting.reasons.join(" ")).toContain("channel:telegram must be ok, but is waiting");

    const refused = evaluateFirstRunReadiness({
      plan,
      report: readyReport,
      secretPersistence: {
        status: "refused",
        changed: false,
        reason: "owner-only-permissions-unsupported",
        detail: "Use the owner-only manual setup path /safe/recovery before retrying.",
      },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });
    expect(refused.ready).toBe(false);
    expect(refused.reasons.join(" ")).toContain("owner-only-permissions-unsupported");
    expect(refused.reasons.join(" ")).toContain("/safe/recovery");
  });

  it("requires a successful live check for every persistent primary and fallback route", () => {
    const base = telegramPlan();
    const configJson = structuredClone(base.configJson) as Record<string, unknown>;
    configJson.runtime = {
      ...(configJson.runtime as Record<string, unknown>),
      fallbacks: [
        { model: "claude:claude-sonnet-5", effort: "low" },
        { model: "pi:openai:gpt-5.5" },
      ],
    };
    const plan = { ...base, configJson: configJson as never };
    const reportReady = report({ runtime: "ok", credentials: "ok", "channel:telegram": "ok" });
    const incomplete = evaluateFirstRunReadiness({
      plan,
      report: reportReady,
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra", "claude:claude-sonnet-5"],
    });
    expect(incomplete.ready).toBe(false);
    expect(incomplete.reasons).toContain("Runtime route pi:openai:gpt-5.5 has not completed its exact live readiness check.");

    expect(evaluateFirstRunReadiness({
      plan,
      report: reportReady,
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: [
        "codex:gpt-5.6-terra",
        "claude:claude-sonnet-5",
        "pi:openai:gpt-5.5",
      ],
    })).toEqual({ ready: true, reasons: [] });
  });

  it.each([
    { presetId: "local-private" as const, tier: "journal" },
    { presetId: "telegram-assistant" as const, tier: "bujo" },
  ])("stages a real managed generation for $presetId before real doctor validation", async ({ presetId, tier }) => {
    stubOllamaModels();
    const plan = presetPlan(presetId);
    const verified = referencedSetupModelRefs(plan);
    let stagedCwd = "";
    const result = await validateWizardPlanInStaging({
      plan,
      env: presetEnvironment(presetId),
      verifiedCredentialModelRefs: verified,
      validate: async (options) => {
        stagedCwd = options.cwd;
        const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
        const memoryRoot = resolve(options.cwd, plan.configJson.memory!.path!);
        expect(readManagedIndexManifest(memoryRoot)).toMatchObject({
          active: {
            tier,
            embeddingModel: "ollama:nomic-embed-text:v1.5",
            dimension: 768,
          },
        });
        expect(readManagedIndexManifest(memoryRoot)?.rollback).toBeUndefined();
        return await validateMonoAgentFolder(options);
      },
    });

    expect(result.sections.find((section) => section.id === "memory")).toMatchObject({ status: "ok" });
    expect(evaluateFirstRunReadiness({
      plan,
      report: result,
      secretPersistence: presetId === "telegram-assistant"
        ? { status: "persisted", changed: true }
        : { status: "not-requested", changed: false },
      verifiedCredentialModelRefs: verified,
    })).toEqual({ ready: true, reasons: [] });
    await expect(access(stagedCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { presetId: "local-private" as const, tier: "journal" },
    { presetId: "telegram-assistant" as const, tier: "bujo" },
  ])("commits $presetId with post-init doctor readiness and no rollback", async ({ presetId, tier }) => {
    stubOllamaModels();
    const target = await mkdtemp(join(tmpdir(), `first-run-${presetId}-committed-`));
    temporaryDirectories.push(target);
    const init = await initMonoAgentFolder({
      dir: target,
      answers: presetAnswers(findPreset(presetId)!),
      ...(presetId === "telegram-assistant"
        ? { secretValues: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "test-telegram-token" } }
        : {}),
    });
    const verified = referencedSetupModelRefs(init.plan);
    const result = await validateMonoAgentFolder({
      cwd: target,
      configPath: init.configPath,
      env: presetEnvironment(presetId),
      allowFilesystemWrites: true,
      liveness: true,
      verifiedCredentialModelRefs: verified,
    });
    const memoryRoot = resolve(target, init.plan.configJson.memory!.path!);
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");

    expect(readManagedIndexManifest(memoryRoot)?.active.tier).toBe(tier);
    expect(readManagedIndexManifest(memoryRoot)?.rollback).toBeUndefined();
    expect(result.sections.find((section) => section.id === "memory")).toMatchObject({ status: "ok" });
    expect(evaluateFirstRunReadiness({
      plan: init.plan,
      report: result,
      secretPersistence: init.secretPersistence,
      verifiedCredentialModelRefs: verified,
    })).toEqual({ ready: true, reasons: [] });
  });

  it("stages the complete plan, passes exact readiness options, and cleans up", async () => {
    const plan = telegramPlan();
    let stagedCwd = "";
    const result = await validateWizardPlanInStaging({
      plan,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        stagedCwd = options.cwd;
        await access(options.configPath);
        await access(join(options.cwd, "IDENTITY.md"));
        expect(await readFile(join(options.cwd, "skills", "mono-agent-configure", "SKILL.md"), "utf8"))
          .toContain("ProposeAgentConfiguration");
        expect(await readFile(join(options.cwd, "skills", "mono-agent-memory", "SKILL.md"), "utf8"))
          .toContain("# Configure memory");
        expect(options.allowFilesystemWrites).toBe(true);
        expect(options.liveness).toBe(true);
        expect(options.verifiedCredentialModelRefs).toEqual(["codex:gpt-5.6-terra"]);
        return report({ runtime: "ok", "channel:telegram": "ok" });
      },
    });
    expect(result.ok).toBe(true);
    await expect(access(stagedCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing source identity in staging", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-identity-source-"));
    temporaryDirectories.push(sourceCwd);
    const identity = "# Existing identity\n\nPreserve this exact operator-authored identity.\n";
    await writeFile(join(sourceCwd, "IDENTITY.md"), identity);

    await expect(validateWizardPlanInStaging({
      plan: telegramPlan(),
      sourceCwd,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        expect(await readFile(join(options.cwd, "IDENTITY.md"), "utf8")).toBe(identity);
        return report({ runtime: "ok", "channel:telegram": "ok" });
      },
    })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    { kind: "symbolic-link", make: async (sourceCwd: string) => {
      const victim = join(sourceCwd, "identity-target.md");
      await writeFile(victim, "# Outside identity\n");
      await symlink(victim, join(sourceCwd, "IDENTITY.md"));
    } },
    { kind: "non-regular", make: async (sourceCwd: string) => {
      await mkdir(join(sourceCwd, "IDENTITY.md"));
    } },
  ])("rejects a $kind existing identity before validation", async ({ kind, make }) => {
    const sourceCwd = await mkdtemp(join(tmpdir(), `first-run-identity-${kind}-source-`));
    temporaryDirectories.push(sourceCwd);
    await make(sourceCwd);
    let validateCalled = false;

    await expect(validateWizardPlanInStaging({
      plan: telegramPlan(),
      sourceCwd,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => {
        validateCalled = true;
        return report({ runtime: "ok", "channel:telegram": "ok" });
      },
    })).rejects.toThrow(new RegExp(kind, "u"));
    expect(validateCalled).toBe(false);
  });

  it("passes the real doctor for a generated directory-backed cron job", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-generated-source-"));
    temporaryDirectories.push(sourceCwd);
    const result = await validateWizardPlanInStaging({
      plan: cronPlan("15 9 * * MON-FRI"),
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });

    expect(result.sections.find((section) => section.id === "channel:cron")).toMatchObject({
      status: "ok",
    });
  });

  it("preserves an existing plan file instead of replacing it with generated contents", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-preserved-source-"));
    temporaryDirectories.push(sourceCwd);
    const existing = [
      "---",
      'expression: "30 7 * * 1-5"',
      "---",
      "Preserve this operator-authored prompt.",
      "",
    ].join("\n");
    await mkdir(join(sourceCwd, "cron"), { recursive: true });
    await writeFile(join(sourceCwd, "cron", "digest.md"), existing);

    const result = await validateWizardPlanInStaging({
      plan: cronPlan("0 8 * * *"),
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        expect(await readFile(join(options.cwd, "cron", "digest.md"), "utf8")).toBe(existing);
        return await validateMonoAgentFolder(options);
      },
    });

    expect(result.sections.find((section) => section.id === "channel:cron")).toMatchObject({
      status: "ok",
    });
  });

  it("preserves an invalid existing digest so the real doctor blocks readiness", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-invalid-digest-source-"));
    temporaryDirectories.push(sourceCwd);
    const existing = "---\nconversationId: existing-digest\n---\nMissing expression.\n";
    await mkdir(join(sourceCwd, "cron"), { recursive: true });
    await writeFile(join(sourceCwd, "cron", "digest.md"), existing);

    const result = await validateWizardPlanInStaging({
      plan: cronPlan(),
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        expect(await readFile(join(options.cwd, "cron", "digest.md"), "utf8")).toBe(existing);
        return await validateMonoAgentFolder(options);
      },
    });

    expect(result.sections.find((section) => section.id === "channel:cron")).toMatchObject({
      status: "waiting",
      details: [expect.stringMatching(/requires an `expression`/u)],
    });
  });

  it("stages every existing cron markdown job so an extra invalid job blocks readiness", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-extra-source-"));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "cron"), { recursive: true });
    await writeFile(
      join(sourceCwd, "cron", "extra.md"),
      "---\nconversationId: extra\n---\nThis job is missing its expression.\n",
    );

    const result = await validateWizardPlanInStaging({
      plan: cronPlan(),
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });

    expect(result.sections.find((section) => section.id === "channel:cron")).toMatchObject({
      status: "waiting",
      details: [expect.stringMatching(/requires an `expression`/u)],
    });
  });

  it.each([
    { kind: "symbolic-link", make: async (sourceCwd: string) => {
      const victim = join(sourceCwd, "outside.md");
      await writeFile(victim, "---\nexpression: \"0 8 * * *\"\n---\noutside\n");
      await symlink(victim, join(sourceCwd, "cron", "unsafe.md"));
    } },
    { kind: "non-regular", make: async (sourceCwd: string) => {
      await mkdir(join(sourceCwd, "cron", "unsafe.md"));
    } },
  ])("rejects a $kind cron markdown entry before validation", async ({ kind, make }) => {
    const sourceCwd = await mkdtemp(join(tmpdir(), `first-run-cron-${kind}-source-`));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "cron"), { recursive: true });
    await make(sourceCwd);
    let validateCalled = false;

    await expect(validateWizardPlanInStaging({
      plan: cronPlan(),
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => {
        validateCalled = true;
        return report({ runtime: "ok", "channel:cron": "ok" });
      },
    })).rejects.toThrow(new RegExp(kind, "u"));
    expect(validateCalled).toBe(false);
  });

  it("rejects a cron directory that escapes the source root", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-escape-source-"));
    temporaryDirectories.push(sourceCwd);
    const base = cronPlan();
    const plan = {
      ...base,
      configJson: { ...base.configJson, cron: { dir: "../outside" } },
    };

    await expect(validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    })).rejects.toThrow(/cron directory .* outside its source root/u);
  });

  it("rejects an absolute cron directory instead of validating outside staging", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-absolute-source-"));
    temporaryDirectories.push(sourceCwd);
    const base = cronPlan();
    const plan = {
      ...base,
      configJson: { ...base.configJson, cron: { dir: join(sourceCwd, "cron") } },
    };

    await expect(validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    })).rejects.toThrow(/absolute cron directory/u);
  });

  it("does not inspect an unrelated cron directory for a plan without cron", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-non-cron-source-"));
    temporaryDirectories.push(sourceCwd);
    const outside = await mkdtemp(join(tmpdir(), "first-run-non-cron-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(sourceCwd, "cron"));

    await expect(validateWizardPlanInStaging({
      plan: telegramPlan(),
      sourceCwd,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => report({ runtime: "ok", "channel:telegram": "ok" }),
    })).resolves.toMatchObject({ ok: true });
  });

  it("bounds existing cron job bytes before copying them", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-cron-large-source-"));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "cron"), { recursive: true });
    await writeFile(
      join(sourceCwd, "cron", "too-large.md"),
      `---\nexpression: "0 8 * * *"\n---\n${"x".repeat(1_100_000)}`,
    );

    await expect(validateWizardPlanInStaging({
      plan: cronPlan(),
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    })).rejects.toThrow(/exceeds 1048576 bytes/u);
  });

  it("checks cancellation after validation and removes the disposable directory", async () => {
    const controller = new AbortController();
    let stagedCwd = "";
    await expect(validateWizardPlanInStaging({
      plan: telegramPlan(),
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      abortSignal: controller.signal,
      validate: async (options) => {
        stagedCwd = options.cwd;
        controller.abort();
        return report({ runtime: "ok", "channel:telegram": "ok" });
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(access(stagedCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes an existing target skills root and copies only explicitly selected skills", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-skills-source-"));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "skills", "research"), { recursive: true });
    await writeFile(join(sourceCwd, "skills", "research", "SKILL.md"), "# Research\n");
    const plan = composeWizardPlan(defaultAnswers(), {
      dirBasename: "test-agent",
      skillsRootExists: true,
    });
    let stagedCwd = "";

    const result = await validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        stagedCwd = options.cwd;
        await access(join(options.cwd, "skills"));
        await expect(access(join(options.cwd, "skills", "research", "SKILL.md")))
          .rejects.toMatchObject({ code: "ENOENT" });
        return report({ runtime: "ok", context: "ok" });
      },
    });

    expect(result.ok).toBe(true);
    await expect(access(stagedCwd)).rejects.toMatchObject({ code: "ENOENT" });

    const selectedPlan = {
      ...plan,
      configJson: {
        ...plan.configJson,
        context: { ...plan.configJson.context, selectedSkills: ["research"] },
      },
    };
    await expect(validateWizardPlanInStaging({
      plan: selectedPlan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        await access(join(options.cwd, "skills", "research", "SKILL.md"));
        return report({ runtime: "ok", context: "ok" });
      },
    })).resolves.toMatchObject({ ok: true });
  });

  it("rejects a selected symbolic-link manifest before generated files can follow it outside staging", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-symlink-skill-source-"));
    temporaryDirectories.push(sourceCwd);
    const victim = join(sourceCwd, "outside-victim.md");
    await writeFile(victim, "ORIGINAL-OUTSIDE-STAGING\n");
    await mkdir(join(sourceCwd, "skills", "escape"), { recursive: true });
    await symlink(victim, join(sourceCwd, "skills", "escape", "SKILL.md"));
    const base = composeWizardPlan(defaultAnswers(), {
      dirBasename: "test-agent",
      skillsRootExists: true,
    });
    const plan = {
      ...base,
      configJson: {
        ...base.configJson,
        context: { ...base.configJson.context, selectedSkills: ["escape"] },
      },
      files: [
        ...base.files,
        { path: "skills/escape/SKILL.md", contents: "OVERWRITTEN-BY-GENERATED-FILE\n" },
      ],
    };
    let validateCalled = false;

    await expect(validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => {
        validateCalled = true;
        return report({ runtime: "ok", context: "ok" });
      },
    })).rejects.toThrow(/symbolic-link skill manifest/u);

    expect(validateCalled).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("ORIGINAL-OUTSIDE-STAGING\n");
  });

  it("rejects an intermediate selected-skill symlink that leaves the configured root", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-parent-symlink-skill-source-"));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "skills"), { recursive: true });
    await mkdir(join(sourceCwd, "outside"), { recursive: true });
    await writeFile(join(sourceCwd, "outside", "SKILL.md"), "OUTSIDE-SKILL\n");
    await symlink(join("..", "outside"), join(sourceCwd, "skills", "escape"));
    const base = composeWizardPlan(defaultAnswers(), {
      dirBasename: "test-agent",
      skillsRootExists: true,
    });
    const plan = {
      ...base,
      configJson: {
        ...base.configJson,
        context: { ...base.configJson.context, selectedSkills: ["escape"] },
      },
    };

    await expect(validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => report({ runtime: "ok", context: "ok" }),
    })).rejects.toThrow(/outside its configured root/u);
  });

  it("refuses generated staging files that escape the disposable agent folder", async () => {
    const base = telegramPlan();
    const plan = {
      ...base,
      files: [...base.files, { path: "../escape.txt", contents: "escape" }],
    };

    await expect(validateWizardPlanInStaging({
      plan,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => report({ runtime: "ok" }),
    })).rejects.toThrow(/outside the disposable agent folder/u);
  });
});
