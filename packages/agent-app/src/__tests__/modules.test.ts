import { describe, expect, it } from "vitest";

import {
  ALLOW_ALL_TOOLS,
  baseConfig,
  BUILTIN_TOOL_NAMES,
  APP_TOOL_NAMES,
  type CapabilityModule,
  DEFAULT_MODEL,
  isAllowAllTools,
  isKnownToolName,
  isMcpToolName,
  resolveModuleInputs,
  suggestToolName,
} from "../modules/index.js";

/** A minimal module fixture used only to exercise resolveModuleInputs. */
const fixtureModule: CapabilityModule = {
  id: "channel:telegram",
  kind: "channel",
  title: "Telegram",
  summary: "Chat with the agent over Telegram.",
  riskLevel: "low",
  inputs: [
    { id: "model", label: "Model", description: "Primary model.", default: DEFAULT_MODEL },
    { id: "botToken", label: "Bot token", description: "Telegram bot token.", secret: true, envVar: "MONO_AGENT_TELEGRAM_BOT_TOKEN" },
  ],
  configFragment: () => ({}),
  validateExpectations: [],
};

describe("resolveModuleInputs", () => {
  it("applies declared defaults when no override is supplied", () => {
    const values = resolveModuleInputs(fixtureModule);
    expect(values.model).toBe(DEFAULT_MODEL);
    // A secret input with no default resolves to undefined.
    expect(values.botToken).toBeUndefined();
  });

  it("lets overrides win over defaults", () => {
    const values = resolveModuleInputs(fixtureModule, { model: "codex:gpt-5.5" });
    expect(values.model).toBe("codex:gpt-5.5");
  });

  it("preserves overrides that do not correspond to a declared input", () => {
    const values = resolveModuleInputs(fixtureModule, { extra: "kept" });
    expect(values.extra).toBe("kept");
    expect(values.model).toBe(DEFAULT_MODEL);
  });
});

describe("baseConfig", () => {
  it("sets runtime.model and workspace '.'", () => {
    const config = baseConfig({ dirBasename: "my-agent", skillsRootExists: false }, "My Agent", DEFAULT_MODEL, [], "uniform");
    expect(config.runtime?.model).toBe(DEFAULT_MODEL);
    expect(config.runtime?.workspace).toBe(".");
  });

  it("always selects the two bundled project skills with index disclosure", () => {
    const withSkills = baseConfig({ dirBasename: "a", skillsRootExists: true }, "A", DEFAULT_MODEL, [], "uniform");
    expect(withSkills.context?.skillsRoot).toBe("./skills");

    const withoutSkills = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [], "uniform");
    expect(withoutSkills.context?.skillsRoot).toBe("./skills");
    expect(withoutSkills.context?.selectedSkills).toEqual(["mono-agent-configure", "mono-agent-memory"]);
    expect(withoutSkills.context?.skillDisclosure).toBe("index");
  });

  it("sets public identity and traceability.sourceLabel from the agent name", () => {
    const config = baseConfig({ dirBasename: "orchestrator", skillsRootExists: false }, "Research Companion", DEFAULT_MODEL, [], "uniform");
    expect(config.agent?.name).toBe("Research Companion");
    expect(config.traceability?.sourceLabel).toBe("Research Companion");
    expect(config.traceability?.registryDir).toBe("./.mono-agent/trace-sources");
  });

  it("includes canonical fallbacks only when non-empty", () => {
    const none = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [], "uniform");
    expect(none.runtime).not.toHaveProperty("fallbacks");

    const some = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [{ model: "codex:gpt-5.5", effort: "high" }], "per-route-native");
    expect(some.runtime?.fallbacks).toEqual([{ model: "codex:gpt-5.5", effort: "high" }]);
    expect(some.runtime?.routeSafety).toBe("per-route-native");
  });

  it("includes runtime.effort only when supplied", () => {
    const none = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [], "uniform");
    expect(none.runtime).not.toHaveProperty("effort");

    const configured = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [], "uniform", "high");
    expect(configured.runtime?.effort).toBe("high");
  });

  it("starts with an empty allowedTools policy", () => {
    const config = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [], "uniform");
    expect(config.tools?.allowedTools).toEqual([]);
    expect(config.tools?.disallowedTools).toEqual([]);
  });

  it("omits $schema and any module-owned blocks (memory/sandbox/webhook)", () => {
    const config = baseConfig({ dirBasename: "a", skillsRootExists: false }, "A", DEFAULT_MODEL, [], "uniform");
    expect(config).not.toHaveProperty("$schema");
    expect(config).not.toHaveProperty("memory");
    expect(config).not.toHaveProperty("sandbox");
    expect(config).not.toHaveProperty("webhook");
  });
});

describe("known-tools", () => {
  it("lists all nine built-in tools", () => {
    expect(BUILTIN_TOOL_NAMES).toHaveLength(9);
    for (const name of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NodeRepl", "WebFetch", "WebSearch"]) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
    }
  });

  it("recognizes exact built-in and adapter-send tool names, case-sensitively", () => {
    expect(isKnownToolName("Read")).toBe(true);
    expect(isKnownToolName("NodeRepl")).toBe(true);
    expect(isKnownToolName("read")).toBe(false);
    expect(isKnownToolName("AskUser")).toBe(true);
    expect(APP_TOOL_NAMES).toEqual(["RunHistory"]);
    expect(isKnownToolName("RunHistory")).toBe(true);
    expect(isKnownToolName("run_history")).toBe(true);
    expect(isKnownToolName("nope")).toBe(false);
  });

  it("treats the canonical PascalCase alias-value names as known, not just their snake_case aliases", () => {
    // These names exist only as alias VALUES (not in BUILTIN ∪ ADAPTER_SEND). A config
    // listing the new canonical name must validate at least as cleanly as one listing the
    // deprecated snake_case spelling — otherwise the canonical name is wrongly "unknown".
    for (const name of ["ReadSkill", "AskCollaborator", "MemoryRecall"]) {
      expect(isKnownToolName(name)).toBe(true);
    }
    // The deprecated snake_case aliases stay accepted for backwards-compat.
    for (const alias of ["read_skill", "ask_collaborator", "memory_recall", "run_history"]) {
      expect(isKnownToolName(alias)).toBe(true);
    }
    // The retired loopback tool was deleted — its dead alias no longer resolves.
    expect(isKnownToolName("NotifyConversation")).toBe(false);
    expect(isKnownToolName("notify_conversation")).toBe(false);
  });

  it("treats the allow-all sentinel ('*') as a known tool name", () => {
    expect(ALLOW_ALL_TOOLS).toBe("*");
    expect(isKnownToolName(ALLOW_ALL_TOOLS)).toBe(true);
  });

  it("detects the allow-all sentinel in a tool list", () => {
    expect(isAllowAllTools([ALLOW_ALL_TOOLS])).toBe(true);
    expect(isAllowAllTools(["Read", "*"])).toBe(true);
    expect(isAllowAllTools(["Read"])).toBe(false);
    expect(isAllowAllTools([])).toBe(false);
  });

  it("detects MCP server tool names by prefix", () => {
    expect(isMcpToolName("mcp__x__y")).toBe(true);
    expect(isMcpToolName("Read")).toBe(false);
  });

  it("suggests the closest known tool name for a case-only typo", () => {
    expect(suggestToolName("read")).toBe("Read");
    expect(suggestToolName("BASH")).toBe("Bash");
    expect(suggestToolName("zzz")).toBeUndefined();
  });
});
