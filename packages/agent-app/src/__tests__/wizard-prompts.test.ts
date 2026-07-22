import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// `@clack/core`'s cancel sentinel is a private, unexported symbol, so we stub
// `isCancel` to recognise our own sentinel — enough to exercise both `guard`
// branches deterministically without a TTY. The pure option builders below never
// touch clack, so the mock leaves them untouched.
const { CANCEL } = vi.hoisted(() => ({ CANCEL: Symbol("clack:cancel:test") }));
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, isCancel: (value: unknown): value is symbol => value === CANCEL };
});

import { APP_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "../modules/known-tools.js";
import {
  assertConcreteWizardModelRef,
  channelSelectOptions,
  creationReviewOptions,
  CUSTOM_PI_MODEL_OPTION,
  effortSelectOptions,
  fallbackModelSelectOptions,
  formatRouteSafetyMatrix,
  guard,
  memorySelectOptions,
  modelSelectOptions,
  piModelSelectOptions,
  previousWizardStep,
  presetSelectOptions,
  toolMultiselectOptions,
  validateWizardAgentName,
  validateWizardAgentPurpose,
  wizardCancelIntentForKey,
  WizardCancelled,
} from "../wizard/prompts.js";
import {
  defaultEffortForModelRef,
  discoverWizardModelCandidates,
  rankWizardModelCandidates,
  type WizardModelCandidate,
} from "../wizard/model-discovery.js";
import { executeProviderSetupPlan, planProviderSetup, providerSetupActionCommandLine, resolvePiCliPath } from "../provider-setup.js";

function modelCandidate(
  candidate: Pick<WizardModelCandidate, "value" | "label" | "source">
    & Partial<Omit<WizardModelCandidate, "value" | "label" | "source">>,
): WizardModelCandidate {
  return {
    availability: "catalog_available",
    authState: candidate.source === "ollama" || candidate.source === "lmstudio" ? "not_required" : "auth_required",
    supportedEfforts: [],
    ...candidate,
  };
}

describe("wizard prompt builders", () => {
  it("channelSelectOptions lists all six channels, webhook first", () => {
    const options = channelSelectOptions();
    expect(options).toHaveLength(6);
    expect(options[0]?.value).toBe("channel:webhook");
    expect(options.map((option) => option.value)).toEqual([
      "channel:webhook",
      "channel:telegram",
      "channel:slack",
      "channel:openai-api",
      "channel:cron",
      "channel:a2a",
    ]);
    for (const option of options) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("hides optional plugin channels from the live first-run picker", () => {
    expect(channelSelectOptions({ readyOnly: true }).map((option) => option.value)).not.toContain("channel:a2a");
  });

  it("memorySelectOptions leads with an empty-value 'None' option", () => {
    const options = memorySelectOptions();
    expect(options[0]?.value).toBe("");
    expect(options[0]?.label).toContain("None");
    // The rest are real memory module ids.
    for (const option of options.slice(1)) {
      expect(option.value.startsWith("memory:")).toBe(true);
    }
    expect(options.map((option) => option.value)).toEqual([
      "",
      "memory:lite",
      "memory:journal",
      "memory:bujo",
    ]);
  });

  it("offers the Supermemory plugin only when setup confirms it is available", () => {
    expect(memorySelectOptions().map((option) => option.value)).not.toContain("memory:supermemory");
    expect(memorySelectOptions({ includeOptionalPlugins: true }).map((option) => option.value))
      .toContain("memory:supermemory");
  });

  it("modelSelectOptions offers the curated set plus Pi and generic escape hatches", () => {
    const options = modelSelectOptions();
    const values = options.map((option) => option.value);
    expect(values.slice(0, 2)).toEqual([
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-sol",
    ]);
    expect(values).toContain("claude:claude-sonnet-5");
    expect(values).toContain("__pi_other__");
    expect(values).toContain("__other__");
    expect(values[values.length - 2]).toBe("__pi_other__");
    expect(values[values.length - 1]).toBe("__other__");
    expect(options.find((option) => option.value === "codex:gpt-5.6-terra")?.hint)
      .toBe("requires Codex CLI 0.144.0+");
    expect(options.find((option) => option.value === "codex:gpt-5.6-sol")?.hint)
      .toBe("requires Codex CLI 0.144.0+");
  });

  it("modelSelectOptions keeps Terra first and ranks direct Codex before Pi OpenAI-Codex", () => {
    const ranked = rankWizardModelCandidates([
      { value: "pi:openai-codex:gpt-5.6-sol", label: "Pi OpenAI-Codex GPT-5.6 Sol", source: "pi" },
      {
        value: "pi:openai-codex:gpt-5.6-terra",
        label: "Pi OpenAI-Codex GPT-5.6 Terra",
        source: "pi",
        discovered: true,
      },
      { value: "codex:gpt-5.6-sol", label: "Codex GPT-5.6 Sol", source: "codex" },
      { value: "codex:gpt-5.6-terra", label: "Codex GPT-5.6 Terra", source: "codex" },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0])));

    const options = modelSelectOptions(ranked);
    const values = options.map((option) => option.value);
    expect(values.slice(0, 4)).toEqual([
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-sol",
      "pi:openai-codex:gpt-5.6-terra",
      "pi:openai-codex:gpt-5.6-sol",
    ]);
  });

  it("fallbackModelSelectOptions reuses model labels while excluding the primary and prior fallbacks", () => {
    const candidates: WizardModelCandidate[] = [
      { value: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "default", source: "claude" },
      { value: "codex:gpt-5.6-terra", label: "Codex GPT-5.6 Terra", source: "codex" },
      { value: "pi:opencode-go:kimi-k2.6", label: "OpenCode kimi-k2.6", hint: "discovered from opencode", source: "opencode" },
      { value: "pi:ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local", source: "ollama" },
      { value: "pi:lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally", source: "lmstudio" },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0]));

    const options = fallbackModelSelectOptions(
      candidates,
      "claude:claude-sonnet-4-6",
      ["codex:gpt-5.6-terra", "pi:opencode-go:kimi-k2.6"],
    );

    expect(options).toEqual([
      { value: "pi:ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local" },
      { value: "pi:lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally" },
      { value: "__pi_other__", label: "Other Pi model…", hint: "choose provider and model id" },
      { value: "__other__", label: "Other model ref…", hint: "type a full sdk:model reference" },
      { value: "__done__", label: "Done", hint: "finish fallback chain" },
    ]);
  });

  it("piModelSelectOptions offers discovered Pi candidates before the manual escape hatch", () => {
    const candidates: WizardModelCandidate[] = [
      { value: "pi:openai-codex:gpt-5.6-terra", label: "Pi OpenAI-Codex GPT-5.6 Terra", hint: "auth setup available", source: "pi" },
      { value: "pi:openai-codex:gpt-5.6-sol", label: "Pi OpenAI-Codex GPT-5.6 Sol", hint: "auth setup available", source: "pi" },
      { value: "codex:gpt-5.6-terra", label: "Codex GPT-5.6 Terra", source: "codex" },
      { value: "pi:opencode-go:kimi-k2.6", label: "OpenCode kimi-k2.6", hint: "discovered from opencode", source: "opencode" },
      { value: "pi:ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local", source: "ollama" },
      { value: "pi:lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally", source: "lmstudio" },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0]));

    const options = piModelSelectOptions(candidates, ["pi:ollama:llama3.1:8b"]);

    expect(options).toEqual([
      { value: "pi:openai-codex:gpt-5.6-terra", label: "Pi OpenAI-Codex GPT-5.6 Terra", hint: "auth setup available" },
      { value: "pi:openai-codex:gpt-5.6-sol", label: "Pi OpenAI-Codex GPT-5.6 Sol", hint: "auth setup available" },
      { value: "pi:opencode-go:kimi-k2.6", label: "OpenCode kimi-k2.6", hint: "discovered from opencode" },
      { value: "pi:lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally" },
      {
        value: CUSTOM_PI_MODEL_OPTION,
        label: "Supported Pi provider/model id…",
        hint: "Anthropic, GitHub Copilot, OpenAI Codex, OpenCode-Go, Ollama, or LM Studio",
      },
    ]);
  });

  it("assertConcreteWizardModelRef rejects wizard sentinel values", () => {
    for (const sentinel of ["__pi_other__", "__other__", "__done__", CUSTOM_PI_MODEL_OPTION]) {
      expect(() => assertConcreteWizardModelRef(sentinel)).toThrow("Wizard model sentinel");
    }
    expect(() => assertConcreteWizardModelRef("pi:ollama:llama3.1:8b")).not.toThrow();
  });

  it("modelSelectOptions keeps direct Codex first while presenting setup-required Pi OpenAI-Codex", () => {
    const ranked = rankWizardModelCandidates([
      { value: "codex:gpt-5.6-terra", label: "Codex GPT-5.6 Terra", source: "codex" },
      {
        value: "pi:openai-codex:gpt-5.6-terra",
        label: "Pi OpenAI-Codex GPT-5.6 Terra",
        source: "pi",
        setupRequired: true,
        defaultEffort: "medium",
      },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0])));

    const values = modelSelectOptions(ranked).map((option) => option.value);
    expect(values.indexOf("codex:gpt-5.6-terra")).toBeLessThan(values.indexOf("pi:openai-codex:gpt-5.6-terra"));
    expect(values).toContain("pi:openai-codex:gpt-5.6-terra");
  });

  it("preserves an authored unknown model with provider-default effort guidance", () => {
    expect(modelSelectOptions([], "pi:private-provider:future-model")[0]).toEqual({
      value: "pi:private-provider:future-model",
      label: "pi:private-provider:future-model",
      hint: "current authored model; provider-default effort",
    });
  });

  it("effortSelectOptions offers only provider-advertised exact values", () => {
    expect(effortSelectOptions(["minimal", "low", "max", "ultra"], "low").map((option) => option.value))
      .toEqual(["", "minimal", "low", "max", "ultra"]);
  });

  it("represents provider default as an omitted route effort", () => {
    expect(effortSelectOptions(["low", "medium"], "medium")[0]).toEqual({
      value: "",
      label: "Provider default",
      hint: "currently medium; omit effort for this route",
    });
  });

  it("validates names, cancel intent, and back transitions deterministically", () => {
    expect(validateWizardAgentName(" Research Companion ")).toBeUndefined();
    expect(validateWizardAgentName("line one\nline two")).toContain("single-line");
    expect(validateWizardAgentName("x".repeat(81))).toContain("80");
    expect(validateWizardAgentPurpose("Coordinate project research.")).toBeUndefined();
    expect(validateWizardAgentPurpose("line one\nline two")).toContain("one line");
    expect(validateWizardAgentPurpose("x".repeat(241))).toContain("240");
    expect(wizardCancelIntentForKey({ name: "escape" })).toBe("back");
    expect(wizardCancelIntentForKey({ name: "c", ctrl: true })).toBe("exit");
    expect(previousWizardStep(0)).toBeUndefined();
    expect(previousWizardStep(4)).toBe(3);
  });

  it("renders explicit per-route contracts and unambiguous creation actions", () => {
    const matrix = formatRouteSafetyMatrix(
      { model: "pi:openai-codex:gpt-5.6-terra", effort: "minimal" },
      [
        { model: "codex:gpt-5.6-sol", effort: "high" },
        { model: "claude:claude-sonnet-5" },
        { model: "opencode:github-copilot:gpt-5.1" },
      ],
      true,
    );
    expect(matrix).toContain("Pi: mono-agent managed SRT");
    expect(matrix).toContain("Codex-native sandbox + exact allow-all");
    expect(matrix).toContain("representable tool restrictions only");
    expect(matrix).toContain("unsupported capabilities skip this route");
    expect(creationReviewOptions({ setupRequired: true }).map((option) => option.label)).toEqual([
      "Run setup and readiness checks, then create agent",
      "Edit choices",
      "Cancel without writing",
    ]);
    expect(creationReviewOptions({ setupRequired: false })[0]?.label)
      .toBe("Run readiness checks, then create agent");
  });

  it("toolMultiselectOptions appends app and channel tools then AskUser after the built-ins", () => {
    const options = toolMultiselectOptions(["channel:telegram"]);
    const values = options.map((option) => option.value);
    expect(values.slice(0, BUILTIN_TOOL_NAMES.length)).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(values.slice(BUILTIN_TOOL_NAMES.length)).toEqual([
      "RunHistory",
      "TelegramSendMessage",
      "AskUser",
    ]);
    const ask = options.find((option) => option.value === "AskUser");
    expect(ask?.hint).toContain("web, Slack, or Telegram");
    const send = options.find((option) => option.value === "TelegramSendMessage");
    expect(send?.hint).toBe("proactive send (Telegram)");
    expect(options.find((option) => option.value === "RunHistory")?.hint).toContain("prior runs");
  });

  it("toolMultiselectOptions offers the built-ins plus channel-agnostic AskUser with no channel", () => {
    const options = toolMultiselectOptions([]);
    expect(options.map((option) => option.value)).toEqual([...BUILTIN_TOOL_NAMES, ...APP_TOOL_NAMES, "AskUser"]);
    const ask = options.find((option) => option.value === "AskUser");
    expect(ask?.hint).toContain("web, Slack, or Telegram");
  });

  it("presetSelectOptions ends with the __custom__ escape hatch", () => {
    const options = presetSelectOptions();
    expect(options.length).toBeGreaterThan(1);
    expect(options[options.length - 1]?.value).toBe("__custom__");
  });
});

describe("provider setup planner", () => {
  it("plans auth and preflight for selected primary and fallback providers", () => {
    const plan = planProviderSetup({
      cwd: "/agent",
      piAuthPath: ".pi/auth.json",
      modelRefs: [
        "claude:claude-sonnet-4-6",
        "codex:gpt-5.6-terra",
        "pi:openai-codex:gpt-5.6-terra",
        "pi:openai:gpt-5.5",
        "pi:opencode-go:kimi-k2.6",
        "pi:ollama:gemma4:31b",
        "pi:lmstudio:qwen/qwen3-8b",
      ],
    });

    expect(plan.actions.map((action) => action.id)).toEqual([
      "claude-login",
      "codex-login",
      "pi-login:openai-codex",
      "pi-api-key:opencode-go",
      "ollama-list",
      "lmstudio-models",
    ]);
    const piLogin = plan.actions.find((action) => action.id === "pi-login:openai-codex");
    expect(piLogin).toMatchObject({ cwd: "/agent/.pi" });
    expect("command" in piLogin! ? piLogin.command : []).toEqual([
      process.execPath,
      expect.stringMatching(/pi-oauth-login-main\.js$/u),
      "openai-codex",
    ]);
    expect(providerSetupActionCommandLine(piLogin!)).toBe("mono-agent auth login openai-codex --pi-auth-path /agent/.pi/auth.json");
    expect(plan.actions.find((action) => action.id === "ollama-list")).toMatchObject({
      command: ["ollama", "list"],
      cwd: "/agent",
    });
    expect(plan.actions.find((action) => action.id === "lmstudio-models")).toMatchObject({
      url: "http://localhost:1234/v1/models",
      cwd: "/agent",
    });
    expect(plan.actions.find((action) => action.id === "pi-api-key:opencode-go")).toMatchObject({
      provider: "opencode-go",
      envVar: "OPENCODE_API_KEY",
      piAuthPath: "/agent/.pi/auth.json",
    });
  });

  it("stages Pi login, preserves existing providers, and atomically writes a custom auth filename", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authDir = join(tmp, "nested", ".pi");
      const authPath = join(authDir, "credentials.json");
      await mkdir(authDir, { recursive: true });
      await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "existing" } }));
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/credentials.json",
        modelRefs: ["pi:openai-codex:gpt-5.6-terra"],
      });
      const fakeSpawn = vi.fn((_file: string, _args: readonly string[], opts: { cwd?: string }) => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        void (async () => {
          const stagedAuthPath = join(opts.cwd!, "auth.json");
          const auth = JSON.parse(await readFile(stagedAuthPath, "utf8"));
          await writeFile(stagedAuthPath, JSON.stringify({ ...auth, "openai-codex": { type: "oauth", refresh: "new" } }));
          listeners.get("close")?.(0, null);
        })();
        return {
          once: (event: string, listener: (value: unknown, signal?: unknown) => void) => {
            listeners.set(event, listener);
          },
        };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect(fakeSpawn).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringMatching(/pi-oauth-login-main\.js$/u), "openai-codex"],
        expect.objectContaining({ cwd: expect.stringMatching(/\.mono-agent-pi-auth-/u) }),
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("ok");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
        anthropic: { type: "oauth", refresh: "existing" },
        "openai-codex": { type: "oauth", refresh: "new" },
      });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(authDir)).toEqual(["credentials.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("runs the app-owned Pi OAuth wrapper from a packed layout and stages a custom auth path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const bundledLoginCliPath = join(tmp, "global", "lib", "node_modules", "@mono-agent", "agent-app", "dist", "pi-oauth-login-main.js");
      await mkdir(dirname(bundledLoginCliPath), { recursive: true });
      await writeFile(bundledLoginCliPath, "// app-owned Pi OAuth wrapper fixture\n", "utf8");
      const authPath = join(tmp, "nested", ".pi", "credentials.json");
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/credentials.json",
        piCliPath: bundledLoginCliPath,
        modelRefs: ["pi:openai-codex:gpt-5.6-terra"],
      });
      const fakeSpawn = vi.fn((_file: string, _args: readonly string[], opts: { cwd?: string }) => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        void (async () => {
          await writeFile(join(opts.cwd!, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", refresh: "new" } }));
          listeners.get("close")?.(0, null);
        })();
        return { once: (event: string, listener: (value: unknown, signal?: unknown) => void) => listeners.set(event, listener) };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect(fakeSpawn).toHaveBeenCalledWith(
        process.execPath,
        [bundledLoginCliPath, "openai-codex"],
        expect.objectContaining({ cwd: expect.stringMatching(/\.mono-agent-pi-auth-/u) }),
      );
      expect(results[0]?.status).toBe("ok");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ "openai-codex": { type: "oauth", refresh: "new" } });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
      expect(resolvePiCliPath()).toMatch(/(?:src|dist)\/pi-oauth-login-main\.js$/u);
      expect(await readdir(dirname(authPath))).toEqual(["credentials.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("cleans Pi auth staging after a failed login without touching the configured store", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authDir = join(tmp, "nested", ".pi");
      const authPath = join(authDir, "credentials.json");
      await mkdir(authDir, { recursive: true });
      await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "existing" } }));
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/credentials.json",
        modelRefs: ["pi:openai-codex:gpt-5.6-terra"],
      });
      const fakeSpawn = vi.fn(() => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        queueMicrotask(() => listeners.get("close")?.(1, null));
        return { once: (event: string, listener: (value: unknown, signal?: unknown) => void) => listeners.set(event, listener) };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect(results[0]?.status).toBe("failed");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ anthropic: { type: "oauth", refresh: "existing" } });
      expect(await readdir(authDir)).toEqual(["credentials.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("stores OpenCode-Go API keys in the Pi auth store", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authPath = join(tmp, "nested", ".pi", "auth.json");
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/auth.json",
        modelRefs: ["pi:opencode-go:kimi-k2.6"],
      });

      const results = await executeProviderSetupPlan(plan, { apiKeys: { "pi-api-key:opencode-go": "sk-opencode" } });

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("ok");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
        "opencode-go": { type: "api_key", key: "sk-opencode" },
      });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("skips OpenCode-Go API-key setup when no key is provided", async () => {
    const plan = planProviderSetup({
      cwd: "/agent",
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
    });

    const results = await executeProviderSetupPlan(plan, { apiKeys: {} });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.detail).toContain("OPENCODE_API_KEY");
  });

  it("finishes every provider setup action so recovery can summarize all failures", async () => {
    const plan = planProviderSetup({
      cwd: "/agent",
      modelRefs: ["codex:gpt-5.6-terra", "claude:claude-sonnet-4-6"],
    });
    const spawnCalls: string[] = [];
    const fakeSpawn = vi.fn((file: string, args: readonly string[]) => {
      spawnCalls.push([file, ...args].join(" "));
      const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
      queueMicrotask(() => listeners.get("close")?.(1, null));
      return {
        once: (event: string, listener: (value: unknown, signal?: unknown) => void) => {
          listeners.set(event, listener);
        },
      };
    });

    const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "failed")).toBe(true);
    expect(spawnCalls).toEqual(["codex login", "claude /login"]);
  });
});

describe("wizard model discovery", () => {
  it("derives only local/reasoning defaults and never fabricates cloud effort metadata", () => {
    expect(defaultEffortForModelRef("claude:claude-sonnet-5")).toBeUndefined();
    expect(defaultEffortForModelRef("codex:gpt-5.6-terra")).toBeUndefined();
    expect(defaultEffortForModelRef("codex:gpt-5.6-sol")).toBeUndefined();
    expect(defaultEffortForModelRef("pi:openai-codex:gpt-5.6-terra")).toBeUndefined();
    expect(defaultEffortForModelRef("pi:openai-codex:gpt-5.6-sol")).toBeUndefined();
    expect(defaultEffortForModelRef("pi:ollama:llama3.1:8b")).toBe("none");
    expect(defaultEffortForModelRef("pi:lmstudio:qwen/qwen3-8b")).toBe("medium");
    expect(defaultEffortForModelRef("pi:opencode-go:some-model", true)).toBe("medium");
    expect(defaultEffortForModelRef("pi:opencode-go:some-model", false)).toBe("none");
    expect(defaultEffortForModelRef("pi:openai:gpt-5.5")).toBeUndefined();
  });

  it("discovers Pi, OpenCode --pure, Ollama, and LM Studio candidates without dropping static options", async () => {
    let openCodeConfigMode: number | undefined;
    const exec = vi.fn(async (
      file: string,
      args: readonly string[],
      options?: { readonly timeout: number; readonly env?: Record<string, string | undefined> },
    ) => {
      if (file === "codex") {
        return { stdout: args[0] === "--version" ? "codex-cli 1.2.3\n" : "Logged in\n" };
      }
      if (file === "opencode") {
        if (process.platform !== "win32") {
          openCodeConfigMode = (await stat(join(options?.env?.XDG_CONFIG_HOME as string, "opencode"))).mode & 0o777;
        }
        return { stdout: "  opencode-go/kimi-k2.6  \nopencode-go/deepseek-v4-pro\nopenai/gpt-5.1\nopencode-go/\n" };
      }
      if (file === "ollama") {
        return { stdout: "NAME ID SIZE MODIFIED\nllama3.1:8b abc 4GB today\n" };
      }
      throw new Error(file);
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "qwen/qwen3-8b" }] }), { status: 200 }));

    const result = await discoverWizardModelCandidates({
      execFile: exec,
      fetch: fetchImpl,
      inspectPiAuthStore: async () => ({
        status: "ok",
        auth: { "openai-codex": { type: "oauth", access: "fixture-access" } },
      }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("claude:claude-sonnet-5");
    expect(values).toContain("pi:openai-codex:gpt-5.6-terra");
    expect(values).toContain("pi:openai-codex:gpt-5.6-sol");
    expect(values).toContain("codex:gpt-5.6-terra");
    expect(values).toContain("codex:gpt-5.6-sol");
    expect(values.indexOf("codex:gpt-5.6-terra"))
      .toBeLessThan(values.indexOf("pi:openai-codex:gpt-5.6-terra"));
    expect(values).toContain("pi:opencode-go:kimi-k2.6");
    expect(values).toContain("pi:opencode-go:deepseek-v4-pro");
    expect(values).not.toContain("pi:opencode-go:openai/gpt-5.1");
    expect(exec).toHaveBeenCalledWith(
      "opencode",
      ["models", "opencode-go", "--pure"],
      expect.objectContaining({ timeout: 5000, env: expect.any(Object) }),
    );
    const opencodeCall = exec.mock.calls.find(([file]) => file === "opencode");
    const opencodeEnv = opencodeCall?.[2]?.env as Record<string, string | undefined>;
    expect(opencodeEnv.OPENCODE_DB).toBe(join(opencodeEnv.XDG_DATA_HOME as string, "opencode", "opencode.db"));
    expect(opencodeEnv.XDG_DATA_HOME).not.toBe(process.env.XDG_DATA_HOME);
    expect(opencodeEnv.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(opencodeEnv.OPENCODE_API_KEY).toBeUndefined();
    expect(opencodeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(opencodeEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    if (process.platform !== "win32") expect(openCodeConfigMode).toBe(0o500);
    await expect(stat(dirname(opencodeEnv.XDG_DATA_HOME as string))).rejects.toMatchObject({ code: "ENOENT" });
    expect(values).toContain("pi:ollama:llama3.1:8b");
    expect(values).toContain("pi:lmstudio:qwen/qwen3-8b");
    expect(result.candidates.find((candidate) => candidate.value === "pi:openai-codex:gpt-5.6-terra")?.defaultEffort).toBeUndefined();
    expect(result.candidates.find((candidate) => candidate.value === "pi:ollama:llama3.1:8b")?.defaultEffort).toBeUndefined();
    expect(result.candidates.find((candidate) => candidate.value === "pi:lmstudio:qwen/qwen3-8b")?.defaultEffort).toBeUndefined();
    expect(result.statuses.map((status) => status.status)).toEqual([
      "detected",
      "detected",
      "setup_available",
      "detected",
      "detected",
      "detected",
    ]);
    expect(result.statuses[0]).toMatchObject({ provider: "Codex", status: "detected" });
    const codex = result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra");
    expect(codex).toMatchObject({ discovered: true });
    expect(codex?.setupRequired).toBeUndefined();
    const sol = result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-sol");
    expect(sol).toMatchObject({ discovered: true });
    expect(sol?.hint).toContain("codex-cli 1.2.3; sign-in detected; live readiness pending");
  });

  it("reads Pi auth providers from the top-level auth store shape", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: async () => {
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: async () => ({
        status: "ok",
        auth: { "openai-codex": { type: "oauth", access: "fixture-access" } },
      }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("pi:openai-codex:gpt-5.6-terra");
    expect(values).toContain("pi:openai-codex:gpt-5.6-sol");
    expect(values.indexOf("pi:openai-codex:gpt-5.6-terra"))
      .toBeLessThan(values.indexOf("pi:openai-codex:gpt-5.3-codex-spark"));
    expect(result.statuses[1]).toMatchObject({ provider: "Pi", status: "detected" });
  });

  it("marks direct Codex as setup-required when the CLI is missing", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: async () => {
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: async () => ({ status: "missing" }),
    });

    expect(result.statuses[0]).toMatchObject({ provider: "Codex", status: "setup_available" });
    expect(result.statuses[0]?.detail).toContain("install");
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra"))
      .toMatchObject({ setupRequired: true });
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-sol"))
      .toMatchObject({ setupRequired: true });
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-sol")?.hint)
      .toBe("install Codex CLI 0.144.0+ and sign in");
  });

  it("distinguishes an installed but signed-out Codex CLI", async () => {
    const exec = vi.fn(async (
      file: string,
      args: readonly string[],
      _options?: { readonly timeout?: number; readonly env?: Readonly<Record<string, string | undefined>> },
    ) => {
      if (file === "codex" && args[0] === "--version") {
        return { stdout: "codex-cli 1.2.3\n" };
      }
      throw new Error("not signed in");
    });

    const result = await discoverWizardModelCandidates({
      execFile: exec,
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: async () => ({ status: "missing" }),
    });

    const statusOptions = exec.mock.calls.find(
      ([file, args]) => file === "codex" && args.join(" ") === "login status",
    )?.[2];
    expect(statusOptions?.timeout).toBe(1200);
    expect(statusOptions?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(result.statuses[0]).toMatchObject({ provider: "Codex", status: "setup_available" });
    expect(result.statuses[0]?.detail).toContain("sign-in required");
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra"))
      .toMatchObject({ setupRequired: true });
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-sol"))
      .toMatchObject({ setupRequired: true });
    expect(result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-sol")?.hint)
      .toBe("Codex sign-in required");
  });

  it.each([
    {
      version: "codex-cli 0.143.9",
      setupRequired: true,
      hint: "update Codex CLI to 0.144.0+ (found codex-cli 0.143.9)",
    },
    {
      version: "codex-cli 0.144.0",
      setupRequired: false,
      hint: "codex-cli 0.144.0; sign-in detected; live readiness pending",
    },
    {
      version: "codex-cli development-build",
      setupRequired: true,
      hint: "Codex CLI 0.144.0+ required; installed version could not be verified",
    },
  ])("applies the GPT-5.6 Codex CLI minimum to $version", async ({ version, setupRequired, hint }) => {
    const result = await discoverWizardModelCandidates({
      execFile: async (file, args) => {
        if (file === "codex") {
          return { stdout: args[0] === "--version" ? `${version}\n` : "Logged in\n" };
        }
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: async () => ({ status: "missing" }),
    });

    const terra = result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-terra");
    const sol = result.candidates.find((candidate) => candidate.value === "codex:gpt-5.6-sol");
    expect(sol?.hint).toBe(hint);
    if (setupRequired) {
      expect(terra).toMatchObject({ setupRequired: true });
      expect(terra?.hint).toBe(hint);
      expect(sol).toMatchObject({ setupRequired: true });
      expect(sol?.discovered).not.toBe(true);
      expect(result.statuses[0]?.status).toBe("setup_available");
      expect(result.statuses[0]?.detail).toContain(hint);
    } else {
      expect(terra).toMatchObject({ discovered: true });
      expect(terra?.setupRequired).toBeUndefined();
      expect(sol).toMatchObject({ discovered: true });
      expect(sol?.setupRequired).toBeUndefined();
      expect(result.statuses[0]?.status).toBe("detected");
      expect(result.statuses[0]?.detail).not.toContain("setup required");
    }
  });

  it("uses the supplied Pi auth path and treats malformed stores as unavailable", async () => {
    const inspect = vi.fn(async () => ({ status: "unsafe" as const, reason: "malformed-json" as const }));
    const result = await discoverWizardModelCandidates({
      piAuthPath: "/agent/custom/pi-auth.json",
      execFile: async () => {
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: inspect,
    });

    expect(inspect).toHaveBeenCalledWith("/agent/custom/pi-auth.json");
    expect(result.statuses[1]).toMatchObject({ provider: "Pi", status: "unavailable" });
  });

  it("treats absent provider tools and servers as unavailable status, not thrown errors", async () => {
    const exec = vi.fn(async () => {
      throw new Error("missing");
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });

    const result = await discoverWizardModelCandidates({
      execFile: exec,
      fetch: fetchImpl,
      inspectPiAuthStore: async () => ({ status: "missing" }),
    });

    const pi = result.candidates.find((candidate: WizardModelCandidate) => candidate.value === "pi:openai-codex:gpt-5.6-terra");
    const piSol = result.candidates.find((candidate: WizardModelCandidate) => candidate.value === "pi:openai-codex:gpt-5.6-sol");
    expect(result.candidates.map((candidate: WizardModelCandidate) => candidate.value)).toContain("codex:gpt-5.6-terra");
    expect(result.candidates.map((candidate: WizardModelCandidate) => candidate.value)).toContain("codex:gpt-5.6-sol");
    expect(pi).toMatchObject({ setupRequired: true });
    expect(pi?.defaultEffort).toBeUndefined();
    expect(piSol).toMatchObject({ setupRequired: true });
    expect(piSol?.defaultEffort).toBeUndefined();
    expect(piSol?.hint).toBe("OAuth setup available");
    expect(result.candidates.map((candidate) => candidate.value).indexOf("codex:gpt-5.6-terra"))
      .toBeLessThan(result.candidates.map((candidate) => candidate.value).indexOf("pi:openai-codex:gpt-5.6-terra"));
    expect(result.statuses.map((status) => status.status)).toEqual([
      "setup_available",
      "setup_available",
      "setup_available",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("guard", () => {
  it("returns the value for a non-cancel result", () => {
    expect(guard("claude:claude-sonnet-4-6")).toBe("claude:claude-sonnet-4-6");
    expect(guard(["Read", "Glob", "Grep"])).toEqual(["Read", "Glob", "Grep"]);
    expect(guard(true)).toBe(true);
    expect(guard([])).toEqual([]);
  });

  it("throws WizardCancelled for the clack cancel symbol", () => {
    expect(() => guard(CANCEL)).toThrow(WizardCancelled);
  });
});
