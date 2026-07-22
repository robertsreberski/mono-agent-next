import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { initMonoAgentFolder, mergeSecretEnvFile } from "../init.js";
import { defaultAnswers } from "../wizard/answers.js";
import { findPreset, presetAnswers } from "../wizard/presets.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("initMonoAgentFolder", () => {
  it("scaffolds the default config, identity, and working dirs in an empty folder", async () => {
    const result = await initMonoAgentFolder({ dir });

    expect(result.created).toContain(result.configPath);
    expect(result.created).toContain(result.identityPath);
    expect(result.identityRole).toEqual({
      path: result.identityPath,
      section: "## Role",
      status: "created",
    });
    expect(result.knowledgeFiles).toEqual([]);
    expect(result.plan.configJson).toBeDefined();

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.$schema).toBe(MONO_AGENT_CONFIG_SCHEMA_URL);
    expect(config.runtime.model).toBe("codex:gpt-5.6-terra");
    expect(config.runtime.maxTurns).toBeUndefined();
    expect(config.context.identityPath).toBe("./IDENTITY.md");
    expect(config.context).toMatchObject({
      skillsRoot: "./skills",
      selectedSkills: ["mono-agent-configure", "mono-agent-memory"],
      skillDisclosure: "index",
    });
    expect(config.webhook.enabled).toBe(true);
    expect(config.memory).toBeUndefined();
    // Deliberate behavior change: the default scaffold now allows all tools (`["*"]`).
    expect(config.tools.allowedTools).toEqual(["*"]);

    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("# Identity");
    expect(identity).toContain("You are Agent App Init");
    expect(identity).toContain("## Role\n\nHelp the operator work effectively in this folder.\n\n## Knowledge");
    expect(identity).toContain(
      "## Knowledge\n\nNo existing project knowledge files were detected. " +
      "Add references to authoritative knowledge here when available.\n\n## Boundaries",
    );
    expect(identity).not.toContain("describe the agent's purpose and boundaries here");
  });

  it("composes the supplied answers (model + extra channels)", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: defaultAnswers({
        name: "Atlas",
        purpose: "Coordinate research for this project.",
        model: "pi:ollama:gemma4:31b",
        channels: ["channel:webhook", "channel:slack", "channel:cron"],
      }),
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.runtime.model).toBe("pi:ollama:gemma4:31b");
    expect(config.agent).toEqual({ name: "Atlas" });
    expect(config.slack).toEqual({ enabled: true });
    expect(config.cron).toEqual({ dir: "cron" });
    expect(await readFile(result.identityPath, "utf8")).toContain("You are Atlas, a mono agent");
    expect(await readFile(result.identityPath, "utf8")).toContain(
      "## Role\n\nCoordinate research for this project.\n\n## Knowledge",
    );
  });

  it("writes fallback models, effort, and memory when the answers request them", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: defaultAnswers({
        model: "claude:claude-sonnet-4-6",
        effort: "medium",
        fallbackModels: ["pi:ollama:gemma4:31b"],
        memory: "memory:journal",
      }),
    });

    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config.runtime.fallbacks).toEqual([{
      model: "pi:ollama:gemma4:31b",
      effort: "medium",
    }]);
    expect(config.runtime.fallbackModels).toBeUndefined();
    expect(config.runtime.effort).toBe("medium");
    expect(config.memory).toMatchObject({ mode: "journal", path: "./.mono-agent/memory" });
  });

  it("writes lite and bujo memory blocks with a directory path", async () => {
    const bujo = await initMonoAgentFolder({ dir, answers: defaultAnswers({ memory: "memory:bujo" }) });
    const bujoConfig = JSON.parse(await readFile(bujo.configPath, "utf8"));
    expect(bujoConfig.memory).toMatchObject({ mode: "bujo" });
    expect(bujoConfig.memory.path).toContain(".mono-agent/memory");
  });

  it.each([
    { presetId: "local-private", tier: "journal" },
    { presetId: "telegram-assistant", tier: "bujo" },
  ])("initializes the $presetId preset with one managed $tier generation", async ({ presetId, tier }) => {
    const result = await initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset(presetId)!),
    });
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    const memoryRoot = resolve(dir, config.memory.path);
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(memoryRoot)).toMatchObject({
      active: {
        tier,
        embeddingModel: "ollama:nomic-embed-text:v1.5",
        dimension: 768,
      },
    });
    expect(readManagedIndexManifest(memoryRoot)?.rollback).toBeUndefined();
    expect(result.created).toContainEqual(expect.stringMatching(/[\\/]\.mono-agent[\\/]memory$/u));
  });

  it.each(["local-private", "telegram-assistant"])(
    "keeps a %s preset dry-run entirely write-free",
    async (presetId) => {
      const result = await initMonoAgentFolder({
        dir,
        answers: presetAnswers(findPreset(presetId)!),
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      await expect(access(join(dir, "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(dir, ".mono-agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("never touches a pre-existing managed-memory root", async () => {
    const memoryRoot = join(dir, ".mono-agent", "memory");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "sentinel"), "operator-owned\n");

    await expect(initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("local-private")!),
    })).rejects.toThrow(/root already exists/u);
    expect(await readFile(join(memoryRoot, "sentinel"), "utf8")).toBe("operator-owned\n");
    await expect(access(join(dir, "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dir, "IDENTITY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dir, ".mono-agent", "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never follows a pre-existing memory-root symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-app-init-memory-outside-"));
    try {
      await mkdir(join(dir, ".mono-agent"));
      await writeFile(join(outside, "sentinel"), "outside\n");
      await symlink(outside, join(dir, ".mono-agent", "memory"));

      await expect(initMonoAgentFolder({
        dir,
        answers: presetAnswers(findPreset("local-private")!),
      })).rejects.toThrow(/root already exists/u);
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("outside\n");
      await expect(access(join(dir, "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(dir, "IDENTITY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a managed-memory identity override before any scaffold write", async () => {
    await expect(initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("local-private")!),
      env: { MONO_AGENT_MEMORY_PATH: "./external-memory" },
    })).rejects.toThrow(/refuses MONO_AGENT_MEMORY_PATH/u);

    await expect(access(join(dir, "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dir, "IDENTITY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dir, ".mono-agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an env tier that would turn a fresh Lite scaffold into managed Journal", async () => {
    await expect(initMonoAgentFolder({
      dir,
      answers: defaultAnswers({ memory: "memory:lite" }),
      env: { MONO_AGENT_MEMORY_MODE: "journal" },
    })).rejects.toThrow(/refuses MONO_AGENT_MEMORY_MODE/u);
    await expect(access(join(dir, "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only its unchanged config when first-run memory publication fails", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await expect(initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("local-private")!),
      firstRunManagedMemoryHooks: {
        beforeRootClaim: async () => { throw new Error("injected first-run failure"); },
      },
    })).rejects.toThrow("injected first-run failure");

    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a raced config edit when first-run memory publication fails", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await expect(initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("local-private")!),
      firstRunManagedMemoryHooks: {
        beforeRootClaim: async () => {
          await writeFile(configPath, "external raced config\n");
          throw new Error("injected raced first-run failure");
        },
      },
    })).rejects.toThrow("injected raced first-run failure");

    expect(await readFile(configPath, "utf8")).toBe("external raced config\n");
  });

  it("references existing knowledge files in the generated identity", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
    await writeFile(join(dir, "CLAUDE.md"), "# Claude\n");

    const result = await initMonoAgentFolder({ dir });

    expect(result.knowledgeFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
    const identity = await readFile(result.identityPath, "utf8");
    expect(identity).toContain("`AGENTS.md`");
    expect(identity).toContain("`CLAUDE.md`");
  });

  it("writes a telegram preset's .env.example with the token placeholder, never in JSON", async () => {
    const result = await initMonoAgentFolder({
      dir,
      answers: presetAnswers(findPreset("telegram-assistant")!),
    });

    expect(result.plan.envExample).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN");
    const envExample = await readFile(join(dir, ".env.example"), "utf8");
    expect(envExample).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN=");
    const configText = await readFile(result.configPath, "utf8");
    expect(configText).not.toContain("telegramToken");
  });

  it("never overwrites existing files", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { model: "codex:gpt-5.6-terra" } }));
    await writeFile(join(dir, "IDENTITY.md"), "# Mine\n");

    const result = await initMonoAgentFolder({ dir });

    expect(result.skipped).toContain(configPath);
    expect(result.skipped).toContain(result.identityPath);
    expect(result.identityRole).toEqual({
      path: result.identityPath,
      section: "## Role",
      status: "preserved",
    });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime.model).toBe("codex:gpt-5.6-terra");
    expect(await readFile(result.identityPath, "utf8")).toBe("# Mine\n");
  });

  it("reports a planned Role write without touching the identity during dry-run", async () => {
    const result = await initMonoAgentFolder({
      dir,
      dryRun: true,
      answers: defaultAnswers({ purpose: "Preserve this exact Role text." }),
    });

    expect(result.identityRole).toEqual({
      path: result.identityPath,
      section: "## Role",
      status: "planned-create",
    });
    await expect(access(result.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write generated capability files through a symlinked parent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-app-init-outside-"));
    try {
      await symlink(outside, join(dir, "cron"));
      const answers = defaultAnswers({
        channels: ["channel:cron"],
        moduleInputs: { "channel:cron": { cronExpression: "0 8 * * *" } },
      });

      await expect(initMonoAgentFolder({ dir, answers })).rejects.toThrow(
        /Refusing to create scaffold artifact through symbolic-link parent/u,
      );
      await expect(access(join(outside, "digest.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to create working directories through a symlinked scaffold parent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-app-workspace-outside-"));
    try {
      await symlink(outside, join(dir, ".mono-agent"));

      await expect(initMonoAgentFolder({ dir })).rejects.toThrow(
        /Refusing to create scaffold artifact through symbolic-link parent/u,
      );
      await expect(access(join(outside, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(outside, "workspace"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("merges required secrets into a private env file without replacing existing values or comments", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "# retain me\nMONO_AGENT_TELEGRAM_BOT_TOKEN=already-set\nMONO_AGENT_SLACK_BOT_TOKEN=\n");
    await mergeSecretEnvFile(envPath, {
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "replacement-must-not-win",
      MONO_AGENT_SLACK_BOT_TOKEN: "new-value",
    });
    const env = await readFile(envPath, "utf8");
    expect(env).toContain("# retain me");
    expect(env).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN=already-set");
    expect(parseEnv(env).MONO_AGENT_SLACK_BOT_TOKEN).toBe("new-value");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("/.env\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("reports secret persistence precisely without claiming a dry-run write", async () => {
    const result = await initMonoAgentFolder({
      dir,
      dryRun: true,
      secretValues: { MONO_AGENT_SLACK_BOT_TOKEN: "not-written" },
    });

    expect(result.secretsPersisted).toBe(false);
    expect(result.secretPersistence).toMatchObject({ status: "planned", changed: true });
    expect(result.changes).toContainEqual({ path: join(dir, ".env"), kind: "planned-create", sensitive: true });
    await expect(readFile(join(dir, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
