import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beforeCommit: undefined as (() => Promise<void>) | undefined,
  defaultBackgroundDeps: vi.fn(),
  ensureBackgroundReady: vi.fn(),
  confirmAnswers: [] as unknown[],
  detectProviderCredentialStatesOverride: undefined as undefined | ((...args: unknown[]) => unknown),
  executeProviderSetupPlan: vi.fn(),
  logError: vi.fn(),
  passwordAnswers: [] as unknown[],
  runInitWizard: vi.fn(),
  runSetupRepairWizard: vi.fn(),
  runTui: vi.fn(),
  resolveInstanceTarget: vi.fn(),
  runAllRouteReadinessProbe: vi.fn(),
  sandboxRuntimeStatus: vi.fn(),
  setupManagedSrt: vi.fn(),
  checkSandboxRuntime: vi.fn(),
  selectAnswers: [] as unknown[],
  selectCalls: [] as Array<Record<string, unknown>>,
  validateMonoAgentFolder: vi.fn(),
}));

function nextAnswer(queue: unknown[], name: string): unknown {
  if (queue.length === 0) throw new Error(`No queued ${name} answer.`);
  return queue.shift();
}

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  confirm: vi.fn(async () => nextAnswer(mocks.confirmAnswers, "confirm")),
  intro: vi.fn(),
  isCancel: () => false,
  log: {
    error: mocks.logError,
    info: vi.fn(),
    step: vi.fn(),
    warn: vi.fn(),
  },
  note: vi.fn(),
  password: vi.fn(async () => nextAnswer(mocks.passwordAnswers, "password")),
  select: vi.fn(async (options: Record<string, unknown>) => {
    mocks.selectCalls.push(options);
    return nextAnswer(mocks.selectAnswers, "select");
  }),
  spinner: vi.fn(() => ({
    cancel: vi.fn(),
    error: vi.fn(),
    get isCancelled() {
      return false;
    },
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../wizard/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/run.js")>();
  return {
    ...actual,
    runInitWizard: mocks.runInitWizard,
    runSetupRepairWizard: mocks.runSetupRepairWizard,
  };
});

vi.mock("../readiness-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../readiness-probe.js")>();
  return { ...actual, runAllRouteReadinessProbe: mocks.runAllRouteReadinessProbe };
});

vi.mock("../background-snapshot-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../background-snapshot-key.js")>();
  const key = Buffer.alloc(32, 0x44);
  return {
    ...actual,
    loadBackgroundSnapshotKey: async () => Buffer.from(key),
    loadOrCreateBackgroundSnapshotKey: async () => Buffer.from(key),
  };
});

vi.mock("../background.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../background.js")>();
  return {
    ...actual,
    defaultBackgroundDeps: mocks.defaultBackgroundDeps,
    ensureBackgroundReady: mocks.ensureBackgroundReady,
    resolveInstanceTarget: mocks.resolveInstanceTarget,
  };
});

vi.mock("../tui-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tui-command.js")>();
  return { ...actual, runTui: mocks.runTui };
});

vi.mock("../provider-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-setup.js")>();
  return {
    ...actual,
    detectProviderCredentialStates: (...args: unknown[]) =>
      mocks.detectProviderCredentialStatesOverride?.(...args) ?? actual.detectProviderCredentialStates(
        args[0] as Parameters<typeof actual.detectProviderCredentialStates>[0],
      ),
    executeProviderSetupPlan: mocks.executeProviderSetupPlan,
  };
});

vi.mock("../sandbox-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox-manager.js")>();
  return {
    ...actual,
    sandboxRuntimeStatus: mocks.sandboxRuntimeStatus,
    setupManagedSrt: mocks.setupManagedSrt,
    checkSandboxRuntime: mocks.checkSandboxRuntime,
  };
});

vi.mock("../doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../doctor.js")>();
  return { ...actual, validateMonoAgentFolder: mocks.validateMonoAgentFolder };
});

vi.mock("../init.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../init.js")>();
  return {
    ...actual,
    initMonoAgentFolder: async (options: Parameters<typeof actual.initMonoAgentFolder>[0]) => {
      if (options?.dryRun !== true) await mocks.beforeCommit?.();
      return await actual.initMonoAgentFolder(options);
    },
  };
});

import { runCli } from "../cli.js";
import { defaultAnswers } from "../wizard/answers.js";

const originalCwd = process.cwd();
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalPiAuthPath = process.env.MONO_AGENT_PI_AUTH_PATH;
const originalTelegramToken = process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const temporaryDirectories: string[] = [];

function readyReport() {
  return {
    ok: true,
    sections: [
      { id: "runtime", label: "Runtime", status: "ok" as const, details: [] },
      { id: "credentials", label: "Credentials", status: "ok" as const, details: [] },
      { id: "context", label: "Context", status: "ok" as const, details: [] },
      { id: "tools", label: "Tools", status: "ok" as const, details: [] },
      { id: "sandbox", label: "Sandbox", status: "ok" as const, details: [] },
      { id: "channel:telegram", label: "Telegram", status: "ok" as const, details: [] },
      { id: "channel:webhook", label: "Webhook", status: "ok" as const, details: [] },
    ],
  };
}

beforeEach(async () => {
  mocks.detectProviderCredentialStatesOverride = undefined;
  delete process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MONO_AGENT_PI_AUTH_PATH;
  mocks.confirmAnswers.length = 0;
  mocks.passwordAnswers.length = 0;
  mocks.selectAnswers.length = 0;
  mocks.selectCalls.length = 0;
  mocks.beforeCommit = undefined;
  mocks.defaultBackgroundDeps.mockReset();
  mocks.defaultBackgroundDeps.mockReturnValue({});
  mocks.ensureBackgroundReady.mockReset();
  mocks.ensureBackgroundReady.mockResolvedValue({
    ok: true,
    action: "started",
    source: { sourceId: "mono-agent-ready-source" },
  });
  mocks.executeProviderSetupPlan.mockReset();
  mocks.logError.mockReset();
  mocks.runInitWizard.mockReset();
  mocks.runSetupRepairWizard.mockReset();
  mocks.runTui.mockReset();
  mocks.runTui.mockResolvedValue(0);
  mocks.runAllRouteReadinessProbe.mockReset();
  mocks.sandboxRuntimeStatus.mockReset();
  mocks.setupManagedSrt.mockReset();
  mocks.checkSandboxRuntime.mockReset();
  mocks.validateMonoAgentFolder.mockReset();
  mocks.runAllRouteReadinessProbe.mockResolvedValue({ ok: true });
  mocks.resolveInstanceTarget.mockReset();
  mocks.resolveInstanceTarget.mockResolvedValue({ target: "guided-init-background" });
  const managedStatus = {
    state: "ready" as const,
    source: "managed" as const,
    version: "0.0.64" as const,
    installRoot: "/cache/managed-srt",
    message: "managed ready",
  };
  const check = {
    status: managedStatus,
    checks: [{ id: "engine" as const, ok: true, detail: "enforced" }],
  };
  mocks.setupManagedSrt.mockResolvedValue({ installed: true, repaired: false, status: managedStatus, check });
  mocks.sandboxRuntimeStatus.mockResolvedValue({
    ...managedStatus,
    source: "external" as const,
    message: "external ready",
  });
  mocks.checkSandboxRuntime.mockResolvedValue(check);
  mocks.validateMonoAgentFolder.mockResolvedValue(readyReport());
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-cli-first-run-"));
  temporaryDirectories.push(dir);
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (stdinTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
  if (stdoutTtyDescriptor === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  if (originalTelegramToken === undefined) delete process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
  else process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN = originalTelegramToken;
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalPiAuthPath === undefined) delete process.env.MONO_AGENT_PI_AUTH_PATH;
  else process.env.MONO_AGENT_PI_AUTH_PATH = originalPiAuthPath;
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("guided init state transitions", () => {
  it("keeps an absent default dotenv implicit for the launchd worker and configuration TUI", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.resolveInstanceTarget).toHaveBeenCalledWith(expect.objectContaining({
      args: { configPath: join(process.cwd(), "mono-agent.config.json") },
    }));
    expect(mocks.resolveInstanceTarget.mock.calls[0]?.[0]?.args).not.toHaveProperty("envFile");
    expect(mocks.runTui).toHaveBeenCalledWith(expect.objectContaining({
      configPath: join(process.cwd(), "mono-agent.config.json"),
      agent: "mono-agent-ready-source",
      configure: true,
    }));
    expect(mocks.runTui.mock.calls[0]?.[0]).not.toHaveProperty("envFile");
    await expect(access(join(process.cwd(), ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("securely re-processes an existing selected dotenv secret without replacing its value", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "MONO_AGENT_TELEGRAM_BOT_TOKEN=operator-value\n", { mode: 0o644 });
    // Ensure umask did not already make the test fixture owner-only.
    await chmod(envPath, 0o644);
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        channels: ["channel:telegram"],
        moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
      }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(await readFile(envPath, "utf8")).toBe("MONO_AGENT_TELEGRAM_BOT_TOKEN=operator-value\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    expect(mocks.runTui).toHaveBeenCalledWith(expect.objectContaining({
      configPath: join(process.cwd(), "mono-agent.config.json"),
      cwd: process.cwd(),
      envFile: join(process.cwd(), ".env"),
      agent: "mono-agent-ready-source",
      configure: true,
    }));
    expect(mocks.runTui.mock.calls[0]?.[0]).not.toHaveProperty("local");
    expect(mocks.ensureBackgroundReady).toHaveBeenCalledOnce();
    const backgroundResolution = mocks.resolveInstanceTarget.mock.calls[0]?.[0] as {
      readonly env: Readonly<Record<string, string | undefined>>;
    };
    expect(backgroundResolution.env.MONO_AGENT_TELEGRAM_BOT_TOKEN).toBe("operator-value");
    expect(backgroundResolution.env).not.toHaveProperty("MONO_AGENT_PI_AUTH_PATH");
    const configurationEnvironment = mocks.runTui.mock.calls[0]?.[0]?.env as
      | Readonly<Record<string, string | undefined>>
      | undefined;
    expect(configurationEnvironment?.MONO_AGENT_TELEGRAM_BOT_TOKEN).toBe("operator-value");
    expect(configurationEnvironment).not.toHaveProperty("MONO_AGENT_PI_AUTH_PATH");
  });

  it("passes an explicit env file through ordinary TUI dispatch for later managed restarts", async () => {
    await expect(runCli(["tui", "--env-file", ".env.operator"])).resolves.toBe(0);

    expect(mocks.runTui).toHaveBeenCalledWith(expect.objectContaining({
      configPath: join(process.cwd(), "mono-agent.config.json"),
      cwd: process.cwd(),
      envFile: ".env.operator",
    }));
  });

  it("preserves committed files and skips configuration chat when background readiness fails", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);
    mocks.ensureBackgroundReady.mockResolvedValue({ ok: false, action: "start", reason: "timeout" });

    await expect(runCli(["init"])).resolves.toBe(1);

    await expect(access(join(process.cwd(), "mono-agent.config.json"))).resolves.toBeUndefined();
    expect(mocks.runTui).not.toHaveBeenCalled();
    const diagnostic = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(diagnostic).toContain("files were preserved");
    expect(diagnostic).toContain("configuration chat was not opened");
  });

  it("prints exact recovery commands when background target resolution throws unexpectedly", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);
    mocks.resolveInstanceTarget.mockRejectedValue(new Error("trace registry resolution failed"));

    await expect(runCli(["init"])).resolves.toBe(1);

    await expect(access(join(process.cwd(), "mono-agent.config.json"))).resolves.toBeUndefined();
    expect(mocks.ensureBackgroundReady).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
    const diagnostic = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(diagnostic).toContain("trace registry resolution failed");
    expect(diagnostic).toContain("validated agent files were preserved");
    expect(diagnostic).toContain("mono-agent start --config");
    expect(diagnostic).toContain("mono-agent status --config");
    expect(diagnostic).toContain("mono-agent logs --config");
    expect(diagnostic).toContain("--follow");
    expect(diagnostic).toContain(".mono-agent/logs/");
    expect(diagnostic).not.toContain("--env-file");
  });

  it("gives explicit two-terminal guidance without claiming readiness on unsupported platforms", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.ensureBackgroundReady).not.toHaveBeenCalled();
    expect(mocks.runTui).not.toHaveBeenCalled();
    const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("Automatic background start and configuration chat require macOS launchd");
    expect(output).toContain("mono-agent start --foreground --config");
    expect(output).toContain("Configure manually:");
    expect(output).toContain("mono-agent tui --config");
    expect(output).toContain("Conversational configuration requires the managed macOS background lifecycle");
    expect(output).not.toContain("mono-agent tui --configure");
    expect(output).not.toContain("--env-file");
    expect(output).toContain("readiness is not claimed");
    expect(output).not.toContain("Agent ready");
  });

  it("hardens an existing provider key even when the selected plan has no module secrets", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "OPENAI_API_KEY=operator-provider-key\n", { mode: 0o644 });
    await chmod(envPath, 0o644);
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(await readFile(envPath, "utf8")).toBe("OPENAI_API_KEY=operator-provider-key\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(process.cwd(), ".gitignore"), "utf8")).toContain("/.env");
  });

  it("installs the pinned managed SRT even when an external SRT is already valid", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ sandbox: true }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.setupManagedSrt).toHaveBeenCalledWith(expect.objectContaining({
      verify: true,
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.sandboxRuntimeStatus).not.toHaveBeenCalled();
    expect(mocks.checkSandboxRuntime).not.toHaveBeenCalled();
  });

  it("routes an interrupted managed-SRT setup through resume without writing early", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ sandbox: true }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      runProviderSetup: false,
    });
    const successfulSetup = mocks.setupManagedSrt.getMockImplementation();
    mocks.setupManagedSrt.mockImplementationOnce(async (options: { readonly signal?: AbortSignal }) => {
      process.emit("SIGINT");
      expect(options.signal?.aborted).toBe(true);
      throw Object.assign(new Error("sandbox setup aborted"), { name: "AbortError" });
    });
    if (successfulSetup === undefined) throw new Error("expected default managed-SRT setup mock");
    mocks.setupManagedSrt.mockImplementationOnce(successfulSetup);
    mocks.selectAnswers.push("resume");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.setupManagedSrt).toHaveBeenCalledTimes(2);
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    const rendered = [
      ...vi.mocked(process.stdout.write).mock.calls.flat(),
      ...vi.mocked(process.stderr.write).mock.calls.flat(),
    ].join("");
    expect(rendered).toContain("Preflight was interrupted");
  });

  it("offers an explicit sandbox retry after managed-SRT setup fails", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ sandbox: true }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: {},
      credentialStates: { codex: "credential_detected" },
      runProviderSetup: false,
    });
    const successfulSetup = mocks.setupManagedSrt.getMockImplementation();
    mocks.setupManagedSrt.mockRejectedValueOnce(new Error("managed SRT integrity mismatch"));
    if (successfulSetup === undefined) throw new Error("expected default managed-SRT setup mock");
    mocks.setupManagedSrt.mockImplementationOnce(successfulSetup);
    mocks.selectAnswers.push("retry");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.setupManagedSrt).toHaveBeenCalledTimes(2);
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
  });

  it("refuses readiness when a provider key comes from a tracked dotenv", async () => {
    const envPath = join(process.cwd(), ".env");
    await execFilePromise("git", ["init", "-q"], process.cwd());
    await writeFile(envPath, "OPENAI_API_KEY=tracked-provider-key\n", { mode: 0o600 });
    await execFilePromise("git", ["add", "-f", ".env"], process.cwd());
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    await expect(access(join(process.cwd(), "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.confirmAnswers).toEqual([]);
  });

  it("returns to recovery after failed auth setup without rerunning the live probe", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe.mockResolvedValue({
      ok: false,
      kind: "provider_failed",
      message: "Authentication failed.",
    });
    mocks.selectAnswers.push("auth", "browser", "cancel");
    mocks.executeProviderSetupPlan.mockImplementation(async (plan: { actions: readonly Record<string, unknown>[] }) =>
      plan.actions.map((action) => ({ action, status: "failed", detail: "login failed" })));

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledOnce();
    const providerRecovery = mocks.selectCalls.find(
      (call) => call.message === "Runtime readiness did not pass. What would you like to do?",
    );
    expect((providerRecovery?.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Retry failed route",
      "Repair authentication",
      "Edit model routes",
      "Save incomplete",
      "Cancel without writing",
    ]);
    await expect(access(join(process.cwd(), "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dotenv drift during the live probe before committing the scaffold", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "OPENAI_API_KEY=durable-before\n", { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe.mockImplementation(async () => {
      await writeFile(envPath, "OPENAI_API_KEY=durable-after\n", { mode: 0o600 });
      return { ok: true };
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    await expect(access(join(process.cwd(), "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks readiness when dotenv changes in the final check-to-commit race", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "OPENAI_API_KEY=durable-before\n", { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.beforeCommit = async () => {
      await writeFile(envPath, "OPENAI_API_KEY=durable-after\n", { mode: 0o600 });
    };

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    await expect(access(join(process.cwd(), "mono-agent.config.json"))).resolves.toBeUndefined();
    expect(mocks.confirmAnswers).toEqual([]);
  });

  it("atomically refuses a config created after the wizard started", async () => {
    const configPath = join(process.cwd(), "mono-agent.config.json");
    const concurrent = '{"runtime":{"model":"pi:ollama:concurrent"}}\n';
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.beforeCommit = async () => {
      await writeFile(configPath, concurrent, { mode: 0o600 });
    };

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect(mocks.confirmAnswers).toEqual([]);
  });

  it("withdraws readiness when the committed config changes during full validation", async () => {
    const configPath = join(process.cwd(), "mono-agent.config.json");
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementation(async (options: { readonly cwd: string }) => {
      if (options.cwd === process.cwd()) {
        await writeFile(configPath, '{"runtime":{"model":"pi:ollama:changed"}}\n', { mode: 0o600 });
      }
      return readyReport();
    });

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.confirmAnswers).toEqual([]);
    expect(await readFile(configPath, "utf8")).toContain("pi:ollama:changed");
  });

  it("withdraws readiness when the committed provider dotenv becomes tracked during validation", async () => {
    const envPath = join(process.cwd(), ".env");
    await execFilePromise("git", ["init", "-q"], process.cwd());
    await writeFile(envPath, "OPENAI_API_KEY=durable-provider-key\n", { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementation(async (options: { readonly cwd: string }) => {
      if (options.cwd === process.cwd()) {
        await execFilePromise("git", ["add", "-f", ".env"], process.cwd());
      }
      return readyReport();
    });

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.confirmAnswers).toEqual([]);
    await expect(execFilePromise("git", ["ls-files", "--error-unmatch", ".env"], process.cwd()))
      .resolves.toBeUndefined();
  });

  it("re-prompts an API key during explicit authentication repair", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6" }),
      moduleSecrets: {},
      providerSetupSecrets: { "pi-api-key:opencode-go": "rejected-key-one" },
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: { "opencode-go": "secure-store" },
      credentialStates: { "pi:opencode-go": "credential_detected" },
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe
      .mockResolvedValueOnce({ ok: false, kind: "provider_failed", message: "Authentication failed." })
      .mockResolvedValueOnce({ ok: true });
    mocks.selectAnswers.push("auth");
    mocks.passwordAnswers.push("replacement-key-two");
    let setupApiKeys: Readonly<Record<string, string | undefined>> | undefined;
    mocks.executeProviderSetupPlan.mockImplementation(async (
      plan: { readonly actions: readonly Record<string, unknown>[] },
      options: { readonly apiKeys?: Readonly<Record<string, string | undefined>> },
    ) => {
      setupApiKeys = options.apiKeys;
      return plan.actions.map((action) => ({ action, status: "ok", detail: "stored" }));
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(setupApiKeys?.["pi-api-key:opencode-go"]).toBe("replacement-key-two");
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledTimes(2);
    await expect(access(join(process.cwd(), ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists an environment-selected Pi key owner-only without copying it to auth.json", async () => {
    const authPath = join(process.cwd(), "pi-credentials", "auth.json");
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, `MONO_AGENT_PI_AUTH_PATH=${authPath}\n`, { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6" }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: { OPENCODE_API_KEY: "environment-only-secret" },
      piApiKeyPersistenceByProvider: { "opencode-go": "environment" },
      credentialStates: { "pi:opencode-go": "auth_required" },
      runProviderSetup: true,
    });
    let setupAction: Record<string, unknown> | undefined;
    let setupApiKeys: Readonly<Record<string, string | undefined>> | undefined;
    mocks.executeProviderSetupPlan.mockImplementation(async (
      plan: { readonly actions: readonly Record<string, unknown>[] },
      options: { readonly apiKeys?: Readonly<Record<string, string | undefined>> },
    ) => {
      setupAction = plan.actions[0];
      setupApiKeys = options.apiKeys;
      return plan.actions.map((action) => ({ action, status: "ok", detail: "environment verified" }));
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(setupAction).toMatchObject({
      id: "pi-api-key:opencode-go",
      persistence: "environment",
    });
    expect(setupApiKeys?.["pi-api-key:opencode-go"]).toBe("environment-only-secret");
    const persisted = await readFile(envPath, "utf8");
    expect(persisted).toContain("OPENCODE_API_KEY='environment-only-secret'");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
    const rendered = [
      ...vi.mocked(process.stdout.write).mock.calls.flat(),
      ...vi.mocked(process.stderr.write).mock.calls.flat(),
    ].join("");
    expect(rendered).not.toContain("environment-only-secret");
  });

  it("marks an in-memory module secret missing when save-incomplete persistence was refused", async () => {
    const envPath = join(process.cwd(), ".env");
    await execFilePromise("git", ["init", "-q"], process.cwd());
    await writeFile(envPath, "MONO_AGENT_TELEGRAM_BOT_TOKEN=\n", { mode: 0o600 });
    await execFilePromise("git", ["add", "-f", ".env"], process.cwd());
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        channels: ["channel:telegram"],
        moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
      }),
      moduleSecrets: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "in-memory-only" },
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe.mockResolvedValue({
      ok: false,
      kind: "provider_failed",
      message: "Save for later.",
    });
    mocks.selectAnswers.push("save");

    await expect(runCli(["init"])).resolves.toBe(1);

    const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    const errorOutput = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN");
    expect(output).toContain("missing");
    expect(output).not.toContain("in-memory-only");
    expect(errorOutput).toContain(`Automatic secret persistence refused because ${envPath} is tracked by git.`);
    expect(errorOutput).not.toContain("in-memory-only");
  });

  it("resumes an interrupted multi-route preflight without rerunning a verified route", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        model: "codex:gpt-5.6-terra",
        fallbacks: [{ model: "claude:claude-sonnet-5", effort: "high" }],
        routeSafety: "per-route-native",
      }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      credentialStates: { codex: "credential_detected", claude: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe
      .mockResolvedValueOnce({
        ok: false,
        kind: "cancelled",
        message: "interrupted",
        interrupted: true,
        planFingerprint: "route-plan",
        routes: [
          { key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "verified" },
          { key: "fallback-key", index: 1, model: "claude:claude-sonnet-5", effort: "high", status: "interrupted" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        planFingerprint: "route-plan",
        routes: [
          { key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "skipped_verified" },
          { key: "fallback-key", index: 1, model: "claude:claude-sonnet-5", effort: "high", status: "verified" },
        ],
      });
    mocks.selectAnswers.push("resume");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledTimes(2);
    expect(mocks.runAllRouteReadinessProbe.mock.calls[1]?.[0]).toMatchObject({
      resume: { planFingerprint: "route-plan", successfulRouteKeys: ["primary-key"] },
    });
    const rendered = vi.mocked(process.stdout.write).mock.calls.flat().join("");
    expect(rendered).toContain("Route 1/2: codex:gpt-5.6-terra");
    expect(rendered).toContain("Route 2/2: claude:claude-sonnet-5");
    expect(rendered).toContain("effort: high");
  });

  it("interrupts provider authentication safely and resumes through the shared preflight recovery menu", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6" }),
      moduleSecrets: {},
      providerSetupSecrets: { "pi-api-key:opencode-go": "entered-key" },
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: { "opencode-go": "secure-store" },
      credentialStates: { "pi:opencode-go": "auth_required" },
      runProviderSetup: true,
    });
    mocks.detectProviderCredentialStatesOverride = () => ({ "pi:opencode-go": "auth_required" });
    let setupAttempt = 0;
    const sigintListenersBefore = process.listenerCount("SIGINT");
    mocks.executeProviderSetupPlan.mockImplementation(async (
      plan: { readonly actions: readonly Record<string, unknown>[] },
      options: { readonly abortSignal?: AbortSignal },
    ) => {
      setupAttempt += 1;
      if (setupAttempt === 1) {
        process.emit("SIGINT");
        expect(options.abortSignal?.aborted).toBe(true);
        return plan.actions.map((action) => ({ action, status: "failed", detail: "interrupted" }));
      }
      expect(options.abortSignal?.aborted).toBe(false);
      return plan.actions.map((action) => ({ action, status: "ok", detail: "stored" }));
    });
    mocks.selectAnswers.push("resume");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledTimes(2);
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore);
    const rendered = [
      ...vi.mocked(process.stdout.write).mock.calls.flat(),
      ...vi.mocked(process.stderr.write).mock.calls.flat(),
    ].join("");
    expect(rendered).toContain("Provider setup was interrupted");
  });

  it("retries failed provider setup before any runtime route and labels recovery accurately", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6" }),
      moduleSecrets: {},
      providerSetupSecrets: { "pi-api-key:opencode-go": "entered-key" },
      providerEnvironmentSecrets: {},
      piApiKeyPersistenceByProvider: { "opencode-go": "secure-store" },
      credentialStates: { "pi:opencode-go": "auth_required" },
      runProviderSetup: true,
    });
    mocks.detectProviderCredentialStatesOverride = () => ({ "pi:opencode-go": "auth_required" });
    let setupAttempt = 0;
    mocks.executeProviderSetupPlan.mockImplementation(async (plan) => {
      setupAttempt += 1;
      return plan.actions.map((action: object) => ({
        action,
        status: setupAttempt === 1 ? "failed" : "ok",
        detail: setupAttempt === 1 ? "provider unavailable" : "stored",
      }));
    });
    mocks.selectAnswers.push("retry");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledTimes(2);
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    const recovery = mocks.selectCalls.find(
      (call) => call.message === "Provider setup did not pass. What would you like to do?",
    );
    expect((recovery?.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Repair authentication",
      "Retry provider setup",
      "Edit model routes",
      "Save incomplete",
      "Cancel without writing",
    ]);
  });

  it.each(["resume", "restart"] as const)(
    "%s reruns interrupted provider status detection and authentication before readiness",
    async (recovery) => {
      mocks.runInitWizard.mockResolvedValue({
        status: "answers",
        answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6" }),
        moduleSecrets: {},
        providerSetupSecrets: { "pi-api-key:opencode-go": "entered-key" },
        providerEnvironmentSecrets: {},
        piApiKeyPersistenceByProvider: { "opencode-go": "secure-store" },
        credentialStates: { "pi:opencode-go": "auth_required" },
        runProviderSetup: true,
      });
      const order: string[] = [];
      let detectionAttempt = 0;
      mocks.detectProviderCredentialStatesOverride = async (...args: unknown[]) => {
        detectionAttempt += 1;
        order.push(`detect-${detectionAttempt}`);
        const options = args[0] as { readonly abortSignal?: AbortSignal };
        if (detectionAttempt === 1) {
          process.stdin.emit("keypress", "", { name: "escape" });
          expect(options.abortSignal?.aborted).toBe(true);
        }
        return { "pi:opencode-go": "auth_required" };
      };
      mocks.executeProviderSetupPlan.mockImplementation(async (plan) => {
        order.push("setup");
        return plan.actions.map((action: object) => ({ action, status: "ok", detail: "stored" }));
      });
      mocks.runAllRouteReadinessProbe.mockImplementation(async () => {
        order.push("readiness");
        return { ok: true };
      });
      mocks.selectAnswers.push(recovery);
      mocks.confirmAnswers.push(false);

      await expect(runCli(["init"])).resolves.toBe(0);

      expect(order).toEqual(["detect-1", "detect-2", "setup", "readiness"]);
    },
  );

  it("restarts all model checks after an interrupted preflight when requested", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe
      .mockResolvedValueOnce({
        ok: false,
        kind: "cancelled",
        message: "interrupted",
        interrupted: true,
        planFingerprint: "route-plan",
        routes: [{ key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "verified" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        planFingerprint: "route-plan",
        routes: [{ key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "verified" }],
      });
    mocks.selectAnswers.push("restart");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.runAllRouteReadinessProbe.mock.calls[1]?.[0]).not.toHaveProperty("resume");
  });

  it("reruns previously verified routes after forced authentication repair", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        model: "codex:gpt-5.6-terra",
        fallbacks: [{ model: "claude:claude-sonnet-5" }],
        routeSafety: "per-route-native",
      }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected", claude: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe
      .mockResolvedValueOnce({
        ok: false,
        kind: "provider_failed",
        message: "fallback auth failed",
        planFingerprint: "route-plan",
        routes: [
          { key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "verified" },
          { key: "fallback-key", index: 1, model: "claude:claude-sonnet-5", status: "failed", kind: "provider_failed" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        planFingerprint: "route-plan-after-auth",
        routes: [
          { key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "verified" },
          { key: "fallback-key", index: 1, model: "claude:claude-sonnet-5", status: "verified" },
        ],
      });
    mocks.selectAnswers.push("auth", "browser");
    mocks.executeProviderSetupPlan.mockImplementation(async (plan: { actions: readonly Record<string, unknown>[] }) =>
      plan.actions.map((action) => ({ action, status: "ok", detail: "repaired" })));
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledOnce();
    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledTimes(2);
    expect(mocks.runAllRouteReadinessProbe.mock.calls[1]?.[0]).not.toHaveProperty("resume");
  });

  it("validates the staged configuration before making a real route call", async () => {
    const order: string[] = [];
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementation(async () => {
      order.push("configuration");
      return readyReport();
    });
    mocks.runAllRouteReadinessProbe.mockImplementation(async () => {
      order.push("route");
      return { ok: true };
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(order.indexOf("configuration")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("route")).toBeGreaterThan(order.indexOf("configuration"));
  });

  it.each([
    ["Ctrl-C", () => process.emit("SIGINT")],
    ["Escape", () => process.stdin.emit("keypress", "", { name: "escape" })],
  ])("interrupts configuration preflight with %s before any model call and restores listeners", async (_name, interrupt) => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementationOnce(async () => {
      interrupt();
      await Promise.resolve();
      return readyReport();
    });
    mocks.selectAnswers.push("cancel");
    const sigintListenersBefore = process.listenerCount("SIGINT");
    const keypressListenersBefore = process.stdin.rawListeners("keypress");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore);
    expect(process.stdin.rawListeners("keypress")).toEqual(keypressListenersBefore);
    expect(mocks.selectCalls.at(-1)?.message).toBe("Preflight was interrupted. What would you like to do?");
  });

  it("normalizes an ordinary staging error racing with cancellation into interrupted recovery", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementationOnce(async () => {
      process.emit("SIGINT");
      throw new Error("concurrent validation failure");
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
    expect(mocks.selectCalls.at(-1)?.message).toBe("Preflight was interrupted. What would you like to do?");
  });

  it("surfaces a precise preserved-filesystem staging failure before any model call", async () => {
    const outsideIdentity = join(process.cwd(), "outside-identity.md");
    await writeFile(outsideIdentity, "# Outside identity\n");
    await symlink(outsideIdentity, join(process.cwd(), "IDENTITY.md"));
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
    const diagnostic = mocks.logError.mock.calls.flat().join("\n");
    expect(diagnostic).toContain("symbolic-link scaffold identity");
    expect(diagnostic).toContain("IDENTITY.md");
  });

  it("redacts durable sensitive environment values before normalizing and bounding staging diagnostics", async () => {
    const durableSecret = "alpha  beta";
    await writeFile(
      join(process.cwd(), ".env"),
      `EXISTING_API_KEY="${durableSecret}"\n`,
      { mode: 0o600 },
    );
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockRejectedValueOnce(
      new Error(`staging exposed ${durableSecret}\n${"x".repeat(700)}`),
    );
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    const diagnostic = mocks.logError.mock.calls.flat().join("\n");
    expect(diagnostic).toContain("[secret-redacted]");
    expect(diagnostic).not.toContain(durableSecret);
    expect(diagnostic).not.toContain("alpha beta");
    expect(diagnostic).toContain("…");
    expect(diagnostic.length).toBeLessThan(700);
    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
  });

  it("does not let Save incomplete bypass staging through a symlinked capability directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mono-agent-cli-first-run-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(process.cwd(), "cron"));
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        channels: ["channel:cron"],
        moduleInputs: { "channel:cron": { cronExpression: "0 8 * * *" } },
      }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.selectAnswers.push("save");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
    await expect(access(join(outside, "digest.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not call a model when cron staging fails and offers only configuration recovery", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        channels: ["channel:cron"],
        moduleInputs: { "channel:cron": { cronExpression: "not a cron" } },
      }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockResolvedValue({
      ...readyReport(),
      sections: [
        ...readyReport().sections,
        {
          id: "channel:cron",
          label: "Scheduled jobs (cron)",
          status: "waiting" as const,
          details: ["Cron job expression is invalid."],
        },
      ],
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
    const recovery = mocks.selectCalls.at(-1);
    expect(recovery?.message).toBe("Configuration preflight did not pass. What would you like to do?");
    expect((recovery?.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Edit capability details",
      "Retry configuration preflight",
      "Save incomplete",
      "Cancel without writing",
    ]);
    expect(JSON.stringify(recovery?.options)).not.toContain("Repair authentication");
    expect(JSON.stringify(recovery?.options)).not.toContain("model check");
  });

  it("opens configuration repair at the section identified by preflight", async () => {
    const answers = defaultAnswers({
      channels: ["channel:cron"],
      moduleInputs: { "channel:cron": { cronExpression: "0 8 * * *" } },
    });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers,
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockResolvedValue({
      ...readyReport(),
      sections: [
        ...readyReport().sections,
        {
          id: "channel:cron",
          label: "Scheduled jobs (cron)",
          status: "waiting" as const,
          details: ["Cron job expression is invalid."],
        },
      ],
    });
    mocks.runSetupRepairWizard.mockResolvedValue({ status: "cancelled" });
    mocks.selectAnswers.push("edit", "cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runSetupRepairWizard).toHaveBeenCalledWith(expect.objectContaining({
      answers,
      initialStep: 4,
    }));
    expect(mocks.runAllRouteReadinessProbe).not.toHaveBeenCalled();
  });

  it("labels post-route staged recovery as final readiness validation", async () => {
    const answers = defaultAnswers({
      channels: ["channel:cron"],
      moduleInputs: { "channel:cron": { cronExpression: "0 8 * * *" } },
    });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers,
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    const cronReady = {
      ...readyReport(),
      sections: [
        ...readyReport().sections,
        { id: "channel:cron", label: "Scheduled jobs (cron)", status: "ok" as const, details: [] },
      ],
    };
    const cronWaiting = {
      ...readyReport(),
      sections: [
        ...readyReport().sections,
        {
          id: "channel:cron",
          label: "Scheduled jobs (cron)",
          status: "waiting" as const,
          details: ["An existing cron file changed during route checks."],
        },
      ],
    };
    mocks.validateMonoAgentFolder
      .mockResolvedValueOnce(cronReady)
      .mockResolvedValueOnce(cronWaiting);
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runAllRouteReadinessProbe).toHaveBeenCalledOnce();
    const recovery = mocks.selectCalls.at(-1);
    expect(recovery?.message).toBe("Final readiness validation did not pass. What would you like to do?");
    expect((recovery?.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Edit capability details",
      "Retry final readiness validation",
      "Save incomplete",
      "Cancel without writing",
    ]);
  });

  it("keeps route progress when interrupted setup repair changes only capabilities", async () => {
    const answers = defaultAnswers({
      model: "codex:gpt-5.6-terra",
      fallbacks: [{ model: "claude:claude-sonnet-5", effort: "high" }],
      routeSafety: "per-route-native",
    });
    const baseOutcome = {
      status: "answers" as const,
      answers,
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: {},
      credentialStates: { codex: "credential_detected" as const, claude: "credential_detected" as const },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    };
    mocks.runInitWizard.mockResolvedValue(baseOutcome);
    mocks.runSetupRepairWizard.mockResolvedValue({
      ...baseOutcome,
      answers: defaultAnswers({ ...answers, channels: ["channel:webhook", "channel:cron"] }),
    });
    mocks.validateMonoAgentFolder.mockResolvedValue({
      ...readyReport(),
      sections: [
        ...readyReport().sections,
        { id: "channel:cron", label: "Scheduled jobs (cron)", status: "ok" as const, details: [] },
      ],
    });
    mocks.runAllRouteReadinessProbe
      .mockResolvedValueOnce({
        ok: false,
        kind: "cancelled",
        message: "interrupted",
        interrupted: true,
        planFingerprint: "route-plan",
        routes: [
          { key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "verified" },
          { key: "fallback-key", index: 1, model: "claude:claude-sonnet-5", effort: "high", status: "interrupted" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        planFingerprint: "route-plan",
        routes: [
          { key: "primary-key", index: 0, model: "codex:gpt-5.6-terra", status: "skipped_verified" },
          { key: "fallback-key", index: 1, model: "claude:claude-sonnet-5", effort: "high", status: "verified" },
        ],
      });
    mocks.selectAnswers.push("edit");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.runSetupRepairWizard).toHaveBeenCalledOnce();
    expect(mocks.runAllRouteReadinessProbe.mock.calls[1]?.[0]).toMatchObject({
      resume: { planFingerprint: "route-plan", successfulRouteKeys: ["primary-key"] },
    });
  });

  it("retains progress through model edits so the route fingerprint invalidates it", async () => {
    const initialAnswers = defaultAnswers({ model: "codex:gpt-5.6-terra" });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: initialAnswers,
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: { OPENAI_API_KEY: "ephemeral-provider-key" },
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.runSetupRepairWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ model: "codex:gpt-5.6-sol" }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      providerEnvironmentSecrets: { OPENAI_API_KEY: "ephemeral-provider-key" },
      credentialStates: { codex: "credential_detected" },
      piApiKeyPersistenceByProvider: {},
      runProviderSetup: false,
    });
    mocks.runAllRouteReadinessProbe
      .mockResolvedValueOnce({
        ok: false,
        kind: "provider_failed",
        message: "route failed",
        planFingerprint: "old-route-plan",
        routes: [{ key: "old-primary", index: 0, model: "codex:gpt-5.6-terra", status: "verified" }],
      })
      .mockResolvedValueOnce({ ok: true, planFingerprint: "new-route-plan" });
    mocks.selectAnswers.push("model");
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(mocks.runSetupRepairWizard).toHaveBeenCalledWith(expect.objectContaining({
      initialStep: 1,
      providerEnvironmentSecrets: { OPENAI_API_KEY: "ephemeral-provider-key" },
    }));
    expect(mocks.runAllRouteReadinessProbe.mock.calls[1]?.[0]).toMatchObject({
      resume: { planFingerprint: "old-route-plan", successfulRouteKeys: ["old-primary"] },
    });
  });
});

function execFilePromise(file: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
