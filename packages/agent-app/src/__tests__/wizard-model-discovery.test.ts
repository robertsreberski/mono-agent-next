import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: childProcessMocks.execFile,
  spawn: childProcessMocks.spawn,
}));

import {
  codexModelDiscoveryEnvironment,
  discoverWizardModelCandidates,
  guidedPiProviderProblem,
} from "../wizard/model-discovery.js";

async function missingAuthStore() {
  return { status: "missing" as const };
}

function unavailableFetch(): Promise<Response> {
  return Promise.reject(new Error("unavailable"));
}

afterEach(() => {
  vi.useRealTimers();
  childProcessMocks.execFile.mockReset();
  childProcessMocks.spawn.mockReset();
});

describe("supported wizard model catalog", () => {
  it("uses only the durable Codex auth root for live model catalog discovery", () => {
    expect(codexModelDiscoveryEnvironment(
      { CODEX_HOME: "/Users/example/.codex-durable" },
      {
        PATH: "/usr/bin",
        HOME: "/Users/example",
        CODEX_HOME: "/tmp/shell-only-codex",
        OPENAI_API_KEY: "shell-only-secret",
        TODOIST_API_TOKEN: "unrelated-secret",
      },
    )).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      CODEX_HOME: "/Users/example/.codex-durable",
    });
  });

  it("rejects unsupported remote and undeclared custom providers in manual guided entry", () => {
    expect(guidedPiProviderProblem("cloudflare-workers-ai")).toMatch(/Configure other Pi providers manually/u);
    expect(guidedPiProviderProblem("amazon-bedrock")).toMatch(/Configure other Pi providers manually/u);
    expect(guidedPiProviderProblem("openai-codex")).toBeUndefined();
    expect(guidedPiProviderProblem("ollama")).toBeUndefined();
    expect(guidedPiProviderProblem("lmstudio")).toBeUndefined();
    expect(guidedPiProviderProblem("llamacpp")).toMatch(/providers\.local/u);
    expect(guidedPiProviderProblem("my-local-server")).toMatch(/providers\.local/u);
  });

  it("keeps OpenCode-Go discovery credential-aware and rejects empty auth records", async () => {
    const discover = async (auth: unknown) => discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "opencode" && args[0] === "models") return { stdout: "opencode-go/kimi-k2.6\n" };
        throw new Error("provider CLI unavailable");
      }),
      inspectPiAuthStore: async () => ({
        status: "ok",
        auth: auth as Readonly<Record<string, unknown>>,
      }),
      fetch: unavailableFetch as never,
      codexModelList: async () => [],
      claudeModelList: async () => [],
    });

    const missing = await discover({ "opencode-go": {} });
    expect(missing.candidates.find((candidate) => candidate.value === "pi:opencode-go:kimi-k2.6"))
      .toMatchObject({
        label: expect.stringContaining("OpenCode-Go"),
        source: "pi",
        authState: "auth_required",
        setupRequired: true,
        discovered: true,
      });

    const detected = await discover({ "opencode-go": { type: "api_key", key: "stored-key" } });
    expect(detected.candidates.find((candidate) => candidate.value === "pi:opencode-go:kimi-k2.6"))
      .toMatchObject({ source: "pi", authState: "credential_detected", discovered: true });
  });

  it("ignores OpenCode-Go CLI rows absent from the bundled Pi catalog and reports that truthfully", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "opencode" && args[0] === "models") {
          return { stdout: "opencode-go/future-model-not-yet-bundled\n" };
        }
        throw new Error("provider CLI unavailable");
      }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      codexModelList: async () => [],
      claudeModelList: async () => [],
    });

    expect(result.candidates.some((candidate) => candidate.value === "pi:opencode-go:future-model-not-yet-bundled"))
      .toBe(false);
    expect(result.statuses.find((status) => status.provider === "OpenCode-Go"))
      .toMatchObject({
        status: "unavailable",
        detail: "no runtime-supported models; 1 unsupported CLI row ignored",
      });
  });

  it.skipIf(process.platform === "win32")("rejects a group-readable default Pi auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-auth-mode-"));
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "secret" } }), { mode: 0o644 });
      await chmod(authPath, 0o644);

      const result = await discoverWizardModelCandidates({
        piAuthPath: authPath,
        execFile: async () => { throw new Error("provider CLI unavailable"); },
        fetch: unavailableFetch as never,
        codexModelList: async () => [],
        claudeModelList: async () => [],
      });

      expect(result.statuses.find((status) => status.provider === "Pi"))
        .toMatchObject({ status: "unavailable" });
      expect(result.statuses.find((status) => status.provider === "Pi")?.detail).toContain("not-owner-only");
      expect(result.candidates.find((candidate) => candidate.value === "pi:opencode-go:kimi-k2.6"))
        .toMatchObject({ authState: "auth_required", setupRequired: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link default Pi auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-auth-link-"));
    const target = join(dir, "target.json");
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(target, JSON.stringify({ "opencode-go": { type: "api_key", key: "secret" } }), { mode: 0o600 });
      await chmod(target, 0o600);
      await symlink(target, authPath);

      const result = await discoverWizardModelCandidates({
        piAuthPath: authPath,
        execFile: async () => { throw new Error("provider CLI unavailable"); },
        fetch: unavailableFetch as never,
        codexModelList: async () => [],
        claudeModelList: async () => [],
      });

      expect(result.statuses.find((status) => status.provider === "Pi"))
        .toMatchObject({ status: "unavailable" });
      expect(result.statuses.find((status) => status.provider === "Pi")?.detail).toContain("symbolic-link");
      expect(result.candidates.find((candidate) => candidate.value === "pi:opencode-go:kimi-k2.6"))
        .toMatchObject({ authState: "auth_required", setupRequired: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("detects credentials in an owner-only regular Pi auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-auth-valid-"));
    const authPath = join(dir, "auth.json");
    try {
      await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "secret" } }), { mode: 0o600 });
      await chmod(authPath, 0o600);

      const result = await discoverWizardModelCandidates({
        piAuthPath: authPath,
        execFile: async () => { throw new Error("provider CLI unavailable"); },
        fetch: unavailableFetch as never,
        codexModelList: async () => [],
        claudeModelList: async () => [],
      });

      expect(result.statuses.find((status) => status.provider === "Pi"))
        .toMatchObject({ status: "detected" });
      expect(result.candidates.find((candidate) => candidate.value === "pi:opencode-go:kimi-k2.6"))
        .toMatchObject({ authState: "credential_detected" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes every model for the guided Pi providers without advertising unsupported cloud providers", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.144.0\n" };
        if (file === "codex") return { stdout: "signed in\n" };
        throw new Error("provider CLI unavailable");
      }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      codexModelList: async () => [],
      claudeModelList: async () => [],
    });

    const pi = result.candidates.filter((candidate) => candidate.value.startsWith("pi:"));
    expect(pi.length).toBeGreaterThan(20);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:anthropic:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:github-copilot:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:openai-codex:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:opencode-go:"))).toBe(true);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:amazon-bedrock:"))).toBe(false);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:cloudflare-"))).toBe(false);
    expect(pi.some((candidate) => candidate.value.startsWith("pi:openai:"))).toBe(false);
    expect(pi.every((candidate) => candidate.availability === "catalog_available")).toBe(true);
    expect(pi.some((candidate) => candidate.supportedEfforts?.includes("minimal"))).toBe(true);
    expect(pi.find((candidate) => candidate.value === "pi:openai-codex:gpt-5.6-sol")).toMatchObject({
      authState: "auth_required",
      setupRequired: true,
    });
    expect(pi.find((candidate) => candidate.value === "pi:openai-codex:gpt-5.6-sol")?.defaultEffort).toBeUndefined();
  });

  it("uses exact visible Codex model ids and effort metadata without equating login status with verification", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.144.0\n" };
        if (file === "codex") return { stdout: "signed in\n" };
        throw new Error("provider CLI unavailable");
      }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      codexModelList: async () => [{
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "xhigh",
        isDefault: true,
      }],
      claudeModelList: async () => [],
    });

    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-luna")).toMatchObject({
      label: "Codex GPT-5.6-Luna",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "xhigh",
      providerDefault: true,
      availability: "catalog_available",
      authState: "credential_detected",
    });
    expect(result.candidates.find((candidate) => candidate.source === "codex")?.value).toBe("codex:gpt-5.6-luna");
    expect(result.candidates.some((candidate) => candidate.authState === "verified")).toBe(false);
  });

  it("shows durable destination credentials as detected without probing CLI login state", async () => {
    const calls: string[] = [];
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        calls.push([file, ...args].join(" "));
        if (file === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.144.0\n" };
        throw new Error("provider CLI unavailable");
      }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      persistedEnv: {
        OPENAI_API_KEY: "durable-openai-key",
        CLAUDE_CODE_OAUTH_TOKEN: "durable-claude-token",
        OPENCODE_API_KEY: "durable-opencode-key",
      },
      codexModelList: async () => [],
      claudeModelList: async () => [{
        model: "claude-sonnet-5",
        reference: "claude:claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Sonnet",
        supportedEfforts: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        source: "cached",
        catalogVersion: "claude-agent-sdk-0.3.206",
      }],
    });

    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra"))
      .toMatchObject({ authState: "credential_detected" });
    expect(result.candidates.find((candidate) => candidate.value === "claude:claude-sonnet-5"))
      .toMatchObject({ authState: "credential_detected" });
    expect(result.candidates.find((candidate) => candidate.value === "pi:opencode-go:kimi-k2.6"))
      .toMatchObject({ authState: "credential_detected" });
    expect(result.statuses.find((status) => status.provider === "Codex")?.detail)
      .toContain("durable OPENAI_API_KEY detected");
    expect(result.statuses.find((status) => status.provider === "Claude")?.detail)
      .toContain("durable provider credential detected");
    expect(result.statuses.find((status) => status.provider === "Pi")).toMatchObject({ status: "detected" });
    expect(calls).not.toContain("codex login status");
    expect(calls).not.toContain("claude auth status --json");
    expect(JSON.stringify(result)).not.toContain("durable-openai-key");
    expect(JSON.stringify(result)).not.toContain("durable-claude-token");
    expect(JSON.stringify(result)).not.toContain("durable-opencode-key");
  });

  it("does not let shell-only provider tokens masquerade as durable CLI login state", async () => {
    const names = ["OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.OPENAI_API_KEY = "shell-only-openai";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "shell-only-claude";
    try {
      const result = await discoverWizardModelCandidates({
        execFile: vi.fn(async (
          file: string,
          args: readonly string[],
          options: { readonly env?: Readonly<Record<string, string | undefined>> },
        ) => {
          if (file === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.144.0\n" };
          if (file === "codex" && args[0] === "login" && options.env?.OPENAI_API_KEY !== undefined) {
            return { stdout: "signed in from shell token\n" };
          }
          if (file === "claude" && options.env?.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
            return { stdout: "signed in from shell token\n" };
          }
          throw new Error("no durable login");
        }),
        inspectPiAuthStore: missingAuthStore,
        fetch: unavailableFetch as never,
        persistedEnv: {},
        codexModelList: async () => [],
        claudeModelList: async () => [{
          model: "claude-sonnet-5",
          reference: "claude:claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          description: "Sonnet",
          supportedEfforts: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          source: "cached",
          catalogVersion: "claude-agent-sdk-0.3.206",
        }],
      });

      expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra"))
        .toMatchObject({ authState: "auth_required" });
      expect(result.candidates.find((candidate) => candidate.value === "claude:claude-sonnet-5"))
        .toMatchObject({ authState: "auth_required" });
      expect(result.statuses.find((status) => status.provider === "Codex")?.detail)
        .toContain("shell-only OPENAI_API_KEY ignored");
      expect(result.statuses.find((status) => status.provider === "Claude")?.detail)
        .toContain("shell-only Claude credential ignored");
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("does not invent Codex effort metadata when live model discovery is unavailable", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "codex" && args[0] === "--version") return { stdout: "codex-cli 0.144.0\n" };
        if (file === "codex") return { stdout: "signed in\n" };
        throw new Error("provider CLI unavailable");
      }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      codexModelList: async () => [],
      claudeModelList: async () => [],
    });

    const terra = result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra");
    expect(terra?.supportedEfforts).toEqual([]);
    expect(terra?.defaultEffort).toBeUndefined();
    expect(terra?.providerDefault).toBe(true);
  });

  it("bounds cleanup when a Codex app-server ignores stdin close and SIGTERM", async () => {
    vi.useFakeTimers();

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin,
      stdout,
      kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(),
    });
    child.kill.mockImplementation((signal) => {
      // Model a genuinely wedged process: SIGTERM has no effect. It only
      // transitions to a terminal state after the hard-kill escalation.
      if (signal === "SIGKILL") child.signalCode = "SIGKILL";
      return true;
    });
    childProcessMocks.spawn.mockImplementation((file: string, args: readonly string[]) => {
      if (file === "codex" && args[0] === "app-server") return child;
      const probeStdout = new PassThrough();
      const probe = Object.assign(new EventEmitter(), {
        pid: 12_345,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdout: probeStdout,
        kill: vi.fn(() => true),
      });
      queueMicrotask(() => {
        if (file === "codex" && args[0] === "--version") {
          probeStdout.end("codex-cli 0.144.0\n");
          probe.emit("close", 0, null);
        } else if (file === "codex" && args[0] === "login") {
          probeStdout.end("signed in\n");
          probe.emit("close", 0, null);
        } else {
          probeStdout.end();
          probe.emit("close", 1, null);
        }
      });
      return probe;
    });
    childProcessMocks.execFile.mockImplementation((
      file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result?: { readonly stdout: string }) => void,
    ) => {
      if (file === "codex" && args[0] === "--version") {
        callback(null, { stdout: "codex-cli 0.144.0\n" });
      } else if (file === "codex" && args[0] === "login") {
        callback(null, { stdout: "signed in\n" });
      } else {
        callback(new Error("provider CLI unavailable"));
      }
      return child;
    });

    const discovery = discoverWizardModelCandidates({
      timeoutMs: 250,
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      claudeModelList: async () => [],
    });

    await vi.runAllTimersAsync();
    const result = await discovery;

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "ignore"] }),
    );
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(stdin.writableEnded).toBe(true);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra"))
      .toMatchObject({ authState: "credential_detected", supportedEfforts: [] });
  });

  it("keeps exact Claude SDK rows selectable without auth and marks only supplied probe evidence verified", async () => {
    const reference = "claude:claude-opus-4-8[1m]";
    const result = await discoverWizardModelCandidates({
      execFile: vi.fn(async (file: string, args: readonly string[]) => {
        if (file === "codex" && args[0] === "--version") throw new Error("missing");
        throw new Error("not signed in");
      }),
      inspectPiAuthStore: missingAuthStore,
      fetch: unavailableFetch as never,
      claudeModelList: async () => [{
        model: "claude-opus-4-8[1m]",
        reference,
        displayName: "Claude Opus 4.8 (1M context)",
        description: "Opus",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
        source: "discovered",
        catalogVersion: "claude-agent-sdk-0.3.206",
      }],
      verifiedModelRefs: [reference],
    });

    expect(result.candidates.find((candidate) => candidate.value === reference)).toMatchObject({
      authState: "verified",
      discovered: true,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(result.statuses.find((status) => status.provider === "Claude")).toMatchObject({
      status: "setup_available",
    });
  });
});
