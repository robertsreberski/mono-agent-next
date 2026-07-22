import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs, presetShowData, renderPresetList, renderPresetShow, resolvePiAuthPathForLogin, runCli, runProviderSetupBeforeInit, shouldRunInitWizard } from "../cli.js";
import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { initMonoAgentFolder } from "../init.js";
import { answersFromCli } from "../wizard/from-flags.js";
import { findPreset, presetAnswers, presetIds } from "../wizard/presets.js";

describe("parseCliArgs preset flags & alias normalization", () => {
  it("collects positionals for `presets show <id>`", () => {
    expect(parseCliArgs(["presets", "show", "code-sandbox"])).toMatchObject({
      command: "presets",
      positionals: ["show", "code-sandbox"],
    });
  });

  it("parses init --preset --with --dry-run", () => {
    expect(parseCliArgs(["init", "--preset", "telegram-assistant", "--with", "slack,cron", "--dry-run"])).toMatchObject({
      command: "init",
      preset: "telegram-assistant",
      withChannels: ["slack", "cron"],
      dryRun: true,
    });
  });

  it("parses init --yes", () => {
    expect(parseCliArgs(["init", "--yes"])).toMatchObject({ command: "init", yes: true });
    // Without --yes there is no `yes` key (conditional spread).
    expect(parseCliArgs(["init"]).yes).toBeUndefined();
  });

  it("parses init --auth", () => {
    expect(parseCliArgs(["init", "--auth"])).toMatchObject({ command: "init", auth: true });
    expect(shouldRunInitWizard(parseCliArgs(["init"]), true, true)).toBe(true);
    expect(shouldRunInitWizard(parseCliArgs(["init", "--auth"]), true, true)).toBe(false);
    expect(shouldRunInitWizard(parseCliArgs(["init", "--env-file", ".env.local"]), true, true)).toBe(false);
    expect(shouldRunInitWizard(parseCliArgs(["init", "--config", "custom.json"]), true, true)).toBe(false);
    expect(() => parseCliArgs(["init", "--force"])).toThrow(/--force is only supported/u);
    expect(shouldRunInitWizard(parseCliArgs(["init", "unexpected"]), true, true)).toBe(false);
  });

  it("parses app-owned Pi auth login and resolves exact path precedence", async () => {
    expect(parseCliArgs(["auth", "login", "openai-codex", "--pi-auth-path", "custom/auth.json"])).toMatchObject({
      command: "auth",
      positionals: ["login", "openai-codex"],
      piAuthPath: "custom/auth.json",
    });
    const dir = await mkdtemp(join(tmpdir(), "cli-pi-auth-path-"));
    try {
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(configPath, JSON.stringify({ providers: { piAuthPath: "configured/auth.json" } }));
      await expect(resolvePiAuthPathForLogin({ configPath, cwd: dir }))
        .resolves.toBe(resolve(dir, "configured/auth.json"));
      await expect(resolvePiAuthPathForLogin({ configPath, cwd: dir, envPath: "env/auth.json" }))
        .resolves.toBe(resolve(dir, "env/auth.json"));
      await expect(resolvePiAuthPathForLogin({
        configPath,
        cwd: dir,
        envPath: "env/auth.json",
        piAuthPath: "~/flag/auth.json",
      })).resolves.toBe(resolve(homedir(), "flag/auth.json"));

      await writeFile(configPath, "{ malformed");
      await expect(resolvePiAuthPathForLogin({ configPath, cwd: dir })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses validate --preset", () => {
    expect(parseCliArgs(["validate", "--preset", "code-sandbox"])).toMatchObject({
      command: "validate",
      preset: "code-sandbox",
    });
  });

  it("normalizes `setup` to `init`", () => {
    expect(parseCliArgs(["setup", "--preset", "starter"])).toMatchObject({ command: "init", preset: "starter" });
  });

  it("rejects the removed `recipes` command and `--recipe` flag", () => {
    expect(() => parseCliArgs(["recipes", "show", "starter"]))
      .toThrow(/`recipes` was removed; use `mono-agent presets`/u);
    expect(() => parseCliArgs(["init", "--recipe", "minimal-webhook"]))
      .toThrow(/`--recipe` was removed/u);
  });
});

describe("init provider setup gate", () => {
  it("does not execute provider setup during dry-run even with --auth", async () => {
    const execute = vi.fn(async () => []);
    const status = await runProviderSetupBeforeInit({
      modelRefs: ["codex:gpt-5.6-terra"],
      cwd: "/agent",
      auth: true,
      dryRun: true,
      execute,
    });
    expect(status).toBe("skipped");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports provider setup failures as failed", async () => {
    const status = await runProviderSetupBeforeInit({
      modelRefs: ["codex:gpt-5.6-terra"],
      cwd: "/agent",
      auth: true,
      dryRun: false,
      execute: async (plan) => [
        {
          action: plan.actions[0]!,
          status: "failed",
          detail: "codex login exited 1.",
        },
      ],
    });
    expect(status).toBe("failed");
  });

  it("skips direct provider login when durable dotenv credentials are detected", async () => {
    const execute = vi.fn(async () => []);
    const status = await runProviderSetupBeforeInit({
      modelRefs: ["codex:gpt-5.6-sol", "claude:claude-sonnet-5"],
      cwd: "/agent",
      auth: true,
      dryRun: false,
      persistedEnv: {
        OPENAI_API_KEY: "durable-openai-key",
        CLAUDE_CODE_OAUTH_TOKEN: "durable-claude-token",
      },
      execute,
    });

    expect(status).toBe("skipped");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not fail non-interactive setup when an API-key action is skipped", async () => {
    const status = await runProviderSetupBeforeInit({
      modelRefs: ["pi:opencode-go:kimi-k2.6"],
      cwd: "/agent",
      auth: true,
      dryRun: false,
      credentialStates: { "pi:opencode-go": "auth_required" },
      execute: async (plan) => [
        {
          action: plan.actions[0]!,
          status: "skipped",
          detail: "OPENCODE_API_KEY was not provided.",
        },
      ],
    });
    expect(status).toBe("ok");
  });

  it("returns an explicit interrupted status when scoped provider setup is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => []);

    const status = await runProviderSetupBeforeInit({
      modelRefs: ["codex:gpt-5.6-terra"],
      cwd: "/agent",
      auth: true,
      dryRun: false,
      forceAuthentication: true,
      credentialStates: { codex: "auth_required" },
      abortSignal: controller.signal,
      execute,
    });

    expect(status).toBe("interrupted");
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("answersFromCli", () => {
  it("unions --with channels onto the preset channels and defaults tools to allow-all", () => {
    const answers = answersFromCli({ presetId: "telegram-assistant", withChannels: ["slack"] });
    expect(answers.channels).toContain("channel:telegram");
    expect(answers.channels).toContain("channel:slack");
    // No flag pins a tool list, so the single defaultAnswers choke point yields allow-all.
    expect(answers.allowedTools).toEqual(["*"]);
  });

  it("maps --memory to a module id and lets --model/--effort override the preset runtime", () => {
    const answers = answersFromCli({ presetId: "local-private", model: "codex:gpt-5.6-terra", effort: "high", memory: "lite" });
    expect(answers.model).toBe("codex:gpt-5.6-terra");
    expect(answers.effort).toBe("high");
    expect(answers.memory).toBe("memory:lite");
  });

  it("preserves exact --model and canonical --fallback refs from non-interactive flags", () => {
    const answers = answersFromCli({
      model: "pi:ollama:gemma4:31b",
      fallbacks: [{ model: "codex:gpt-5.6-terra" }, { model: "pi:lmstudio:qwen/qwen3-8b" }],
    });

    expect(answers.model).toBe("pi:ollama:gemma4:31b");
    expect(answers.fallbacks).toEqual([
      { model: "codex:gpt-5.6-terra" },
      { model: "pi:lmstudio:qwen/qwen3-8b" },
    ]);
  });

  it("preserves the public --name compatibility input", () => {
    expect(answersFromCli({ name: "  Research Companion  " }).name).toBe("Research Companion");
  });

  it("forwards canonical per-route fallbacks and route safety", () => {
    const answers = answersFromCli({
      model: "pi:ollama:qwen3:8b",
      fallbacks: [
        { model: "codex:gpt-5.6-sol", effort: "minimal" },
        { model: "claude:claude-sonnet-5", effort: "max" },
      ],
      routeSafety: "per-route-native",
    });
    expect(answers.fallbacks).toEqual([
      { model: "codex:gpt-5.6-sol", effort: "minimal" },
      { model: "claude:claude-sonnet-5", effort: "max" },
    ]);
    expect(answers.routeSafety).toBe("per-route-native");
  });

  it("rejects duplicate canonical routes and invalid public names", () => {
    expect(() => answersFromCli({
      model: "codex:gpt-5.6-sol",
      fallbacks: [{ model: "codex:gpt-5.6-sol" }],
    })).toThrow("Duplicate model route");
    expect(() => answersFromCli({ name: "line one\nline two" })).toThrow("single-line");
  });

  it("rejects wizard sentinel values from non-interactive model flags", () => {
    expect(() => answersFromCli({ model: "__other__" })).toThrow("Wizard model sentinel");
    expect(() => answersFromCli({ fallbacks: [{ model: "__done__" }, { model: "pi:ollama:gemma4:31b" }] }))
      .toThrow("Wizard model sentinel");
  });

  it("defaults to the webhook channel with no preset and no flags", () => {
    expect(answersFromCli({}).channels).toEqual(["channel:webhook"]);
  });
});

describe("renderPresetList", () => {
  it("lists every catalog preset id and the scaffold hint", () => {
    const out = renderPresetList();
    for (const id of presetIds()) {
      expect(out).toContain(id);
    }
    expect(out).toContain("mono-agent init --preset");
  });
});

describe("renderPresetShow", () => {
  it("includes the composed sandbox config for code-sandbox", () => {
    const out = renderPresetShow(findPreset("code-sandbox")!);
    expect(out).toContain("Generated mono-agent.config.json");
    expect(out).toContain(MONO_AGENT_CONFIG_SCHEMA_URL);
    expect(out).toContain("\"sandbox\"");
    expect(out).toContain("\"fail-closed\"");
    expect(out).toContain("Follow-up checklist");
  });

  it("includes the .env.example and never inlines the secret token", () => {
    const out = renderPresetShow(findPreset("telegram-assistant")!);
    expect(out).toContain(".env.example");
    expect(out).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN");
    expect(out).not.toMatch(/"telegramToken"\s*:/u);
  });
});

describe("presetShowData", () => {
  it("returns configJson as an object plus env example, files, and checklist", () => {
    const data = presetShowData(findPreset("code-sandbox")!);
    expect(typeof data.configJson).toBe("object");
    expect((data.configJson as { sandbox?: unknown }).sandbox).toBeDefined();
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.checklist.every((item) => typeof item.sectionId === "string" && typeof item.mustBe === "string")).toBe(true);
  });

  it("projects only the public preset fields, never the internal wizard answers", () => {
    // telegram-assistant carries a non-empty `answers` in the catalog, so absence
    // in the projection is a real narrowing, not a vacuous check.
    const source = findPreset("telegram-assistant")!;
    expect(Object.keys(source.answers).length).toBeGreaterThan(0);
    const data = presetShowData(source);
    expect(Object.keys(data.preset).sort()).toEqual(["description", "id", "playbook", "riskLevel", "title"]);
    expect("answers" in data.preset).toBe(false);
  });
});

describe("runCli presets --json", () => {
  function captureStdout(): { chunks: string[]; restore: () => void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    return { chunks, restore: () => spy.mockRestore() };
  }

  it("lists every preset in a flat ok envelope with no ANSI", async () => {
    const capture = captureStdout();
    try {
      await expect(runCli(["presets", "list", "--json"])).resolves.toBe(0);
      const out = capture.chunks.join("");
      expect(out).not.toContain(String.fromCharCode(27));
      const parsed = JSON.parse(out) as { readonly ok: boolean; readonly presets: readonly Record<string, unknown>[] };
      expect(parsed.ok).toBe(true);
      for (const id of presetIds()) {
        expect(parsed.presets.some((preset) => preset.id === id)).toBe(true);
      }
      // The internal `answers` wizard shape must never leak into the list contract.
      expect(parsed.presets.every((preset) => !("answers" in preset))).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("shows a preset with configJson as an object", async () => {
    const capture = captureStdout();
    try {
      await expect(runCli(["presets", "show", "code-sandbox", "--json"])).resolves.toBe(0);
      const parsed = JSON.parse(capture.chunks.join("")) as {
        readonly ok: boolean;
        readonly preset: Record<string, unknown> & { readonly id: string };
        readonly configJson: { readonly sandbox?: unknown };
        readonly envExample: string;
        readonly files: readonly string[];
        readonly checklist: readonly unknown[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.preset.id).toBe("code-sandbox");
      // Only the doc'd public fields are exposed; the wizard `answers` seed is not.
      expect(Object.keys(parsed.preset).sort()).toEqual(["description", "id", "playbook", "riskLevel", "title"]);
      expect("answers" in parsed.preset).toBe(false);
      expect(parsed.configJson.sandbox).toBeDefined();
      expect(typeof parsed.envExample).toBe("string");
      expect(Array.isArray(parsed.files)).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("returns an unknown-preset error envelope with exit 1", async () => {
    const capture = captureStdout();
    try {
      await expect(runCli(["presets", "show", "does-not-exist", "--json"])).resolves.toBe(1);
      const parsed = JSON.parse(capture.chunks.join("")) as { readonly ok: boolean; readonly error: { readonly code: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("unknown-preset");
    } finally {
      capture.restore();
    }
  });
});

describe("init --preset --dry-run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mono-agent-init-preset-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("plans the telegram preset's config + .env.example without writing anything", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("telegram-assistant")!),
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.created.some((path) => path.endsWith("mono-agent.config.json"))).toBe(true);
    expect(result.created.some((path) => path.endsWith(".env.example"))).toBe(true);
    // Nothing was actually written.
    expect(await readdir(dir)).toEqual([]);
    expect(existsSync(join(dir, "mono-agent.config.json"))).toBe(false);
  });
});
