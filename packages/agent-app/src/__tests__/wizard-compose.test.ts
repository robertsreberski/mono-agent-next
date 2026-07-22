import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MONO_AGENT_CONFIG_SCHEMA_URL } from "../config-reference.js";
import { CAPABILITY_MODULES, findModule } from "../modules/index.js";
import {
  alwaysOnTools,
  composeWizardPlan,
  type ComposeContext,
  defaultAnswers,
  humanizeAgentName,
  moduleOverrides,
  referencedSetupModelRefs,
  type WizardAnswers,
} from "../wizard/answers.js";
import { PRESET_CATALOG, presetAnswers } from "../wizard/presets.js";

const CTX: ComposeContext = { dirBasename: "smoke", skillsRootExists: false };
const SECRET_PATTERN = /xoxb-|xapp-|sk-[A-Za-z0-9]/u;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-wizard-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a composed config to a temp file and load it with the real zero-env loader. */
async function loadComposed(answers: WizardAnswers, ctx: ComposeContext = CTX) {
  const plan = composeWizardPlan(answers, ctx);
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(plan.configJson, null, 2), "utf8");
  return loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: configPath });
}

/** Answers that enable exactly one module, for the per-module round-trip guard. */
function answersForModule(id: string): WizardAnswers {
  const [kind] = id.split(":");
  switch (kind) {
    case "channel":
      return defaultAnswers({ channels: [id] });
    case "memory":
      return defaultAnswers({ memory: id });
    case "sandbox":
      return defaultAnswers({ sandbox: true });
    case "observability":
      return defaultAnswers({ observability: true });
    case "provider":
      return defaultAnswers({ model: id === "provider:ollama" ? "pi:ollama:llama3.1:8b" : "pi:lmstudio:qwen2.5:7b" });
    default:
      throw new Error(`unhandled module kind for ${id}`);
  }
}

describe("wizard composer — loader round-trip (the load-bearing parity guard)", () => {
  for (const preset of PRESET_CATALOG) {
    it(`preset ${preset.id} composes a config that loads with zero env`, async () => {
      const config = await loadComposed(presetAnswers(preset));
      expect(config.runtime.model, preset.id).toBeDefined();
    });
  }

  for (const module of CAPABILITY_MODULES) {
    it(`module ${module.id} composes a config that loads with zero env`, async () => {
      const config = await loadComposed(answersForModule(module.id));
      expect(config.runtime.model, module.id).toBeDefined();
    });
  }
});

describe("wizard composer — schema + no secret leak", () => {
  it("stamps the shared schema url on every preset config", () => {
    for (const preset of PRESET_CATALOG) {
      const plan = composeWizardPlan(presetAnswers(preset), CTX);
      expect(plan.configJson.$schema, preset.id).toBe(MONO_AGENT_CONFIG_SCHEMA_URL);
    }
  });

  it("strips secret inputs so a fake token never reaches the JSON", () => {
    const answers = defaultAnswers({
      channels: ["channel:telegram"],
      memory: "memory:supermemory",
      moduleInputs: {
        "channel:telegram": { telegramToken: "xoxb-FAKELEAK" },
        "memory:supermemory": { supermemoryApiKey: "sk-FAKELEAK" },
      },
    });
    const plan = composeWizardPlan(answers, CTX);
    expect(JSON.stringify(plan.configJson)).not.toContain("FAKELEAK");
  });

  it("moduleOverrides strips a secret input surgically, preserving non-secret siblings", () => {
    const telegramModule = findModule("channel:telegram");
    expect(telegramModule, "channel:telegram module must exist").toBeDefined();
    const answers = defaultAnswers({
      channels: ["channel:telegram"],
      moduleInputs: {
        "channel:telegram": { telegramToken: "xoxb-FAKELEAK", allowedChatIds: "111,222" },
      },
    });
    const result = moduleOverrides(telegramModule!, answers);
    // The secret input is deleted — its value can never reach a fragment or the JSON.
    expect(result).not.toHaveProperty("telegramToken");
    expect(JSON.stringify(result)).not.toContain("FAKELEAK");
    // The strip is surgical, not wholesale: the non-secret sibling survives.
    expect(result.allowedChatIds).toBe("111,222");
  });

  it("never inlines a secret-shaped value in any preset config", () => {
    for (const preset of PRESET_CATALOG) {
      const plan = composeWizardPlan(presetAnswers(preset), CTX);
      expect(JSON.stringify(plan.configJson), preset.id).not.toMatch(SECRET_PATTERN);
    }
  });
});

describe("wizard composer — env-example + secret checklist coverage", () => {
  for (const preset of PRESET_CATALOG) {
    it(`preset ${preset.id} declares every selected module's secret env var`, () => {
      const plan = composeWizardPlan(presetAnswers(preset), CTX);
      for (const module of plan.selectedModules) {
        for (const input of module.inputs) {
          if (input.secret !== true || input.envVar === undefined) {
            continue;
          }
          expect(plan.secrets.some((s) => s.envVar === input.envVar), `${preset.id} secrets`).toBe(true);
          expect(plan.envExample ?? "", `${preset.id} envExample`).toContain(input.envVar);
        }
      }
    });
  }
});

describe("wizard composer — complete setup dependencies", () => {
  it("includes runtime, fallback, and hidden agent-host memory refs in stable order", () => {
    const plan = composeWizardPlan(defaultAnswers({
      fallbackModels: ["claude:claude-sonnet-4-6"],
      memory: "memory:bujo",
    }), CTX);

    expect(referencedSetupModelRefs(plan)).toEqual([
      "codex:gpt-5.6-terra",
      "claude:claude-sonnet-4-6",
      "pi:openai-codex:gpt-5.6-terra",
    ]);
    expect(plan.configJson.memory?.embeddings?.model).toBe("nomic-embed-text:v1.5");
    expect(plan.validateExpectations).toContainEqual(expect.objectContaining({ sectionId: "credentials", mustBe: "ok" }));
  });

  it("keeps embedding-native setup out of generic local runtime refs", () => {
    const plan = composeWizardPlan(defaultAnswers({
      model: "pi:ollama:qwen3:8b",
      memory: "memory:bujo",
    }), CTX);

    expect(referencedSetupModelRefs(plan)).toEqual([
      "pi:ollama:qwen3:8b",
    ]);
    expect(plan.validateExpectations.map((expectation) => expectation.sectionId)).not.toContain("credentials");
  });

  it("maps every CLI-only Codex primary to the SDK-capable Pi memory model", () => {
    const plan = composeWizardPlan(defaultAnswers({
      model: "codex:gpt-5.5",
      memory: "memory:bujo",
    }), CTX);

    expect(plan.configJson.memory?.llm?.model).toBe("pi:openai-codex:gpt-5.6-terra");
    expect(referencedSetupModelRefs(plan)).toEqual([
      "codex:gpt-5.5",
      "pi:openai-codex:gpt-5.6-terra",
    ]);
  });
});

describe("wizard composer — tool selection", () => {
  it("defaults allowedTools to allow-all (the single scaffold/preset/flag choke point)", () => {
    expect(defaultAnswers().allowedTools).toEqual(["*"]);
  });

  it("composes allow-all for every preset (none pin an explicit tool list)", () => {
    for (const preset of PRESET_CATALOG) {
      const plan = composeWizardPlan(presetAnswers(preset), CTX);
      expect(plan.configJson.tools?.allowedTools, preset.id).toEqual(["*"]);
    }
  });

  it("preserves an explicit zero-tools override and warns chat-only", () => {
    const plan = composeWizardPlan(defaultAnswers({ allowedTools: [] }), CTX);
    expect(plan.configJson.tools?.allowedTools).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("chat-only"))).toBe(true);
  });

  it("preserves an explicit specific-tool override verbatim (the choose-specific path)", () => {
    const plan = composeWizardPlan(defaultAnswers({ allowedTools: ["Read", "Bash"] }), CTX);
    expect(plan.configJson.tools?.allowedTools).toEqual(["Read", "Bash"]);
    expect(plan.warnings).toEqual([]);
  });
});

describe("wizard composer — alwaysOnTools (auto-provisioned, not gated by allowedTools)", () => {
  it("includes MemoryRecall for a recall-provisioning memory tier (bujo)", () => {
    expect(alwaysOnTools(defaultAnswers({ memory: "memory:bujo" }))).toEqual(["ReadSkill", "MemoryRecall"]);
  });

  it("includes MemoryRecall for journal and supermemory too", () => {
    expect(alwaysOnTools(defaultAnswers({ memory: "memory:journal" }))).toEqual(["ReadSkill", "MemoryRecall"]);
    expect(alwaysOnTools(defaultAnswers({ memory: "memory:supermemory" }))).toEqual(["ReadSkill", "MemoryRecall"]);
  });

  it("includes recall for lite memory and keeps ReadSkill with no memory", () => {
    expect(alwaysOnTools(defaultAnswers({ memory: "memory:lite" }))).toEqual(["ReadSkill", "MemoryRecall"]);
    expect(alwaysOnTools(defaultAnswers())).toEqual(["ReadSkill"]);
  });
});

describe("wizard composer — per-preset invariants", () => {
  it("code-sandbox: allow-all tools + native fail-closed sandbox", () => {
    const plan = composeWizardPlan(presetAnswers(PRESET_CATALOG.find((p) => p.id === "code-sandbox")!), CTX);
    expect(plan.configJson.runtime?.model).toBe("pi:openai-codex:gpt-5.6-terra");
    expect(plan.configJson.tools?.allowedTools).toEqual(["*"]);
    expect(plan.configJson.sandbox).toMatchObject({ mode: "native", fallback: "fail-closed" });
  });

  it("telegram-assistant: allow-all tools + bujo memory on the composer model", () => {
    const plan = composeWizardPlan(presetAnswers(PRESET_CATALOG.find((p) => p.id === "telegram-assistant")!), CTX);
    expect(plan.configJson.tools?.allowedTools).toEqual(["*"]);
    expect(plan.configJson.memory?.mode).toBe("bujo");
    expect(plan.configJson.memory?.llm?.model).toBe("pi:openai-codex:gpt-5.6-terra");
  });

  it("local-private: ollama provider block, embeddings endpoint, provider module selected", () => {
    const preset = PRESET_CATALOG.find((p) => p.id === "local-private")!;
    const plan = composeWizardPlan(presetAnswers(preset), CTX);
    expect(plan.configJson.providers?.local?.[0]?.type).toBe("ollama");
    expect(plan.configJson.memory?.embeddings?.endpoint).toBe("http://localhost:11434");
    expect(plan.selectedModules.map((m) => m.id)).toContain("provider:ollama");
  });

  it("auto-derives the ollama provider block from a pi:ollama model", () => {
    const plan = composeWizardPlan(defaultAnswers({ model: "pi:ollama:llama3.1:8b" }), CTX);
    expect(plan.configJson.providers?.local).toBeDefined();
  });

  it("auto-derives local provider blocks from fallback models too", () => {
    const plan = composeWizardPlan(defaultAnswers({
      model: "claude:claude-sonnet-4-6",
      fallbackModels: ["pi:lmstudio:qwen/qwen3-8b", "pi:ollama:gemma4:31b"],
    }), CTX);
    expect(plan.selectedModules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["provider:lmstudio", "provider:ollama"]),
    );
    expect(plan.configJson.providers?.local?.map((provider) => provider.type).sort()).toEqual(["lmstudio", "ollama"]);
  });

  it("preserves fallback model order in the runtime config", () => {
    const plan = composeWizardPlan(defaultAnswers({
      model: "claude:claude-sonnet-4-6",
      fallbacks: [
        { model: "codex:gpt-5.6-terra", effort: "minimal" },
        { model: "pi:ollama:gemma4:31b" },
      ],
      routeSafety: "per-route-native",
    }), CTX);

    expect(plan.configJson.runtime?.fallbacks).toEqual([
      { model: "codex:gpt-5.6-terra", effort: "minimal" },
      { model: "pi:ollama:gemma4:31b" },
    ]);
    expect(plan.configJson.runtime?.fallbackModels).toBeUndefined();
    expect(plan.configJson.runtime?.routeSafety).toBe("per-route-native");
  });

  it("converts legacy fallbackModels inputs to canonical routes with inherited effort", () => {
    const plan = composeWizardPlan(defaultAnswers({
      effort: "high",
      fallbackModels: ["codex:gpt-5.6-sol"],
    }), CTX);
    expect(plan.configJson.runtime?.fallbacks).toEqual([{ model: "codex:gpt-5.6-sol", effort: "high" }]);
    expect(plan.configJson.runtime?.fallbackModels).toBeUndefined();
  });

  it("writes runtime.effort when wizard answers specify one", () => {
    const plan = composeWizardPlan(defaultAnswers({ effort: "high" }), CTX);
    expect(plan.configJson.runtime?.effort).toBe("high");
  });
});

describe("wizard composer — default parity with today's scaffold", () => {
  it("matches the init.ts default template except tools.allowedTools", () => {
    const plan = composeWizardPlan(defaultAnswers(), { dirBasename: "acme", skillsRootExists: false });
    const config = plan.configJson;

    expect(config.runtime?.model).toBe("codex:gpt-5.6-terra");
    expect(config.runtime?.workspace).toBe(".");
    expect(config.context?.identityPath).toBe("./IDENTITY.md");
    expect(config.context?.selectedSkills).toEqual(["mono-agent-configure", "mono-agent-memory"]);
    expect(config.context?.skillsRoot).toBe("./skills");
    expect(config.context?.skillDisclosure).toBe("index");
    expect((config as Record<string, { enabled?: boolean }>).webhook?.enabled).toBe(true);
    expect(config.artifacts?.retention?.maxCount).toBe(50000);
    expect(config.agent?.name).toBe("Acme");
    expect(config.traceability?.sourceLabel).toBe("Acme");
    expect(config).not.toHaveProperty("memory");
    // The one intentional difference from today's scaffold — the default is now allow-all:
    expect(config.tools?.allowedTools).toEqual(["*"]);
  });

  it("humanizes the folder default and applies an authored name to trace and A2A metadata", () => {
    expect(humanizeAgentName("research-companion")).toBe("Research Companion");
    expect(Array.from(humanizeAgentName("a".repeat(100))).length).toBe(80);
    const plan = composeWizardPlan(defaultAnswers({
      name: "Research Companion",
      channels: ["channel:a2a"],
    }), CTX);
    expect(plan.configJson.agent?.name).toBe("Research Companion");
    expect(plan.configJson.traceability?.sourceLabel).toBe("Research Companion");
    const channels = plan.configJson.channels as { plugins?: Array<{ package?: string; config?: unknown }> } | undefined;
    const plugin = channels?.plugins?.find((entry) => entry.package === "@mono-agent/a2a-adapter");
    expect((plugin?.config as { agent?: { name?: string } } | undefined)?.agent?.name).toBe("Research Companion");
  });
});
