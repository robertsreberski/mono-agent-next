import { describe, expect, it } from "vitest";
import { OPENAI_API_CONFIG_FIELDS } from "@mono-agent/openai-api-adapter";
import { SLACK_CONFIG_FIELDS } from "@mono-agent/slack-adapter";
import { TELEGRAM_CONFIG_FIELDS } from "@mono-agent/telegram-adapter";

import {
  CAPABILITY_MODULES,
  findModule,
  modulesByKind,
  resolveModuleInputs,
} from "../modules/index.js";

const MODEL = "claude:claude-sonnet-4-6";

/** Section ids the doctor emits — a `channel:<driver>` id or one of the fixed sections. */
const FIXED_SECTION_IDS = new Set(["runtime", "credentials", "memory", "sandbox", "tools", "observability"]);
function isValidSectionId(id: string): boolean {
  return FIXED_SECTION_IDS.has(id) || id.startsWith("channel:");
}

describe("capability-module catalog", () => {
  it("is non-empty with unique ids", () => {
    expect(CAPABILITY_MODULES.length).toBeGreaterThan(0);
    const ids = CAPABILITY_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findModule resolves every catalog id and rejects unknown ids", () => {
    for (const module of CAPABILITY_MODULES) {
      expect(findModule(module.id)?.id).toBe(module.id);
    }
    expect(findModule("does-not-exist")).toBeUndefined();
  });

  it("every module's configFragment returns an object and never leaks a secret value", () => {
    for (const module of CAPABILITY_MODULES) {
      const fragment = module.configFragment(resolveModuleInputs(module, { model: MODEL }));
      expect(typeof fragment).toBe("object");
      expect(fragment).not.toBeNull();
      expect(JSON.stringify(fragment)).not.toMatch(/xoxb-|xapp-|sk-[A-Za-z0-9]/u);
    }
  });

  it("every module declares at least one validate expectation with a valid section id", () => {
    for (const module of CAPABILITY_MODULES) {
      expect(module.validateExpectations.length).toBeGreaterThanOrEqual(1);
      for (const expectation of module.validateExpectations) {
        expect(isValidSectionId(expectation.sectionId)).toBe(true);
      }
    }
  });

  it("threads the composer-supplied model into the memory:bujo LLM", () => {
    const module = findModule("memory:bujo");
    expect(module).toBeDefined();
    const fragment = module!.configFragment(resolveModuleInputs(module!, { model: MODEL }));
    expect(fragment.memory?.llm?.model).toBe(MODEL);
  });

  it("configures a native fail-closed sandbox that mentions srt", () => {
    const module = findModule("sandbox");
    expect(module).toBeDefined();
    const fragment = module!.configFragment(resolveModuleInputs(module!, { model: MODEL }));
    expect(fragment.sandbox?.mode).toBe("native");
    expect(fragment.sandbox?.fallback).toBe("fail-closed");
    const note = module!.validateExpectations.find((e) => e.sectionId === "sandbox")?.note ?? "";
    expect(note).toContain("srt");
  });

  it("scaffolds a cron/digest.md carrying the resolved cron expression", () => {
    const module = findModule("channel:cron");
    expect(module).toBeDefined();
    const values = resolveModuleInputs(module!, { model: MODEL, cronExpression: "30 7 * * 1-5" });
    expect(module!.configFragment(values).cron).toEqual({ dir: "cron" });
    const files = module!.files?.(values) ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("cron/digest.md");
    expect(files[0]?.contents).toContain("30 7 * * 1-5");
  });

  it("validates cron input with actionable five-field messages", () => {
    const input = findModule("channel:cron")?.inputs.find((candidate) => candidate.id === "cronExpression");
    expect(input?.secret).not.toBe(true);
    if (input === undefined || input.secret === true) return;
    expect(input.validate?.("   ")).toBe(
      "Enter a cron expression using five fields: minute hour day-of-month month day-of-week.",
    );
    expect(input.validate?.("0 8 * * * *")).toBe(
      "Use exactly five fields: minute hour day-of-month month day-of-week (for example, 0 8 * * *).",
    );
    expect(input.validate?.("61 8 * * *")).toMatch(/^Invalid cron expression: /u);
    expect(input.validate?.("30 7 * * 1-5")).toBeUndefined();
    expect(input.validate?.("H 7 * * 1-5")).toBeUndefined();
    expect(input.description).toContain("UTC");
    expect(findModule("channel:cron")?.validateExpectations[0]?.note)
      .toBe("Use at least one valid enabled cron/*.md job.");
  });

  it("groups modules by kind: exactly 2 providers and 6 channels", () => {
    const providers = modulesByKind("provider");
    expect(providers.map((m) => m.id).sort()).toEqual(["provider:lmstudio", "provider:ollama"]);
    expect(modulesByKind("channel")).toHaveLength(6);
  });

  it("keeps required channel secret env vars identical to adapter registries", () => {
    const adapterSecretEnv = new Map([
      ["channel:telegram", new Set(TELEGRAM_CONFIG_FIELDS.filter((field) => field.secret === true).map((field) => field.env))],
      ["channel:slack", new Set(SLACK_CONFIG_FIELDS.filter((field) => field.secret === true).map((field) => field.env))],
      ["channel:openai-api", new Set(OPENAI_API_CONFIG_FIELDS.filter((field) => field.secret === true).map((field) => field.env))],
    ]);

    for (const [moduleId, registryEnv] of adapterSecretEnv) {
      const module = findModule(moduleId);
      expect(module, `${moduleId} module`).toBeDefined();
      const declared = module!.inputs
        .filter((input) => input.secret === true)
        .map((input) => input.envVar);
      expect(declared, moduleId).toEqual([...registryEnv]);
    }
    expect(findModule("channel:telegram")?.inputs.find((input) => input.secret === true)?.envVar)
      .toBe("MONO_AGENT_TELEGRAM_BOT_TOKEN");
  });
});
