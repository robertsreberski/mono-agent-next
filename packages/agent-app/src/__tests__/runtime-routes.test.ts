import { describe, expect, it } from "vitest";

import {
  configuredRuntimeFallbackModels,
  configuredRuntimeModels,
  hasConfiguredRuntimeFallbacks,
} from "../runtime-routes.js";

const primary = { sdk: "codex", model: "gpt-5.6-terra", reference: "codex:gpt-5.6-terra" };
const legacy = { sdk: "pi", provider: "ollama", model: "qwen3", reference: "pi:ollama:qwen3" };
const canonical = { sdk: "claude", model: "claude-sonnet-5", reference: "claude:claude-sonnet-5" };

describe("configured runtime routes", () => {
  it("uses structured fallbacks when present and keeps their effort out of model-only consumers", () => {
    const runtime = {
      model: primary,
      fallbackModels: [legacy],
      fallbacks: [{ model: canonical, effort: "high" as const }],
    };
    expect(configuredRuntimeFallbackModels(runtime)).toEqual([canonical]);
    expect(configuredRuntimeModels(runtime)).toEqual([primary, canonical]);
    expect(hasConfiguredRuntimeFallbacks(runtime)).toBe(true);
  });

  it("preserves legacy configs when the structured list is absent or empty", () => {
    expect(configuredRuntimeFallbackModels({ fallbackModels: [legacy] })).toEqual([legacy]);
    expect(configuredRuntimeFallbackModels({ fallbackModels: [legacy], fallbacks: [] })).toEqual([legacy]);
    expect(hasConfiguredRuntimeFallbacks({ fallbackModels: [], fallbacks: [] })).toBe(false);
  });
});
