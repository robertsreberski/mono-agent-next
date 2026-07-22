// Prompt-fragment override defaults + override application. The run>host merge
// precedence is exercised end-to-end in runtime.test.js (createRuntime threads a
// merged `prompts` to bridge.execute); here we assert each fragment function
// falls back to its built-in string and honors an override when present.

import { describe, expect, it } from "vitest";
import { formatLiveInputGuidance } from "../../ai/live-input-prompt.js";
import {
  appendStructuredOutputInstruction,
  structuredOutputFinalizationPrompt,
} from "../../ai/providers/pi-native/structured-output.js";

describe("appendStructuredOutputInstruction", () => {
  it("returns the prompt unchanged when there is no output schema (no override consulted)", () => {
    const called = { hit: false };
    const prompts = { structuredOutputInstruction: () => { called.hit = true; return "X"; } };
    expect(appendStructuredOutputInstruction("sys", null, prompts)).toBe("sys");
    expect(called.hit).toBe(false);
  });

  it("appends the built-in instruction when a schema is active and no override is given", () => {
    const out = appendStructuredOutputInstruction("sys", { type: "object" });
    expect(out.startsWith("sys\n")).toBe(true);
    expect(out).toContain("StructuredOutput");
  });

  it("uses the override (receiving the raw system prompt) when supplied", () => {
    const out = appendStructuredOutputInstruction("sys", { type: "object" }, {
      structuredOutputInstruction: (systemPrompt) => `${systemPrompt} :: CUSTOM`,
    });
    expect(out).toBe("sys :: CUSTOM");
  });
});

describe("structuredOutputFinalizationPrompt", () => {
  it("returns the built-in finalization text by default", () => {
    expect(structuredOutputFinalizationPrompt()).toContain("StructuredOutput");
  });

  it("uses the override when supplied", () => {
    expect(structuredOutputFinalizationPrompt({ structuredOutputFinalization: () => "FINAL" })).toBe("FINAL");
  });
});

describe("formatLiveInputGuidance", () => {
  it("wraps the body in the built-in guidance by default", () => {
    const out = formatLiveInputGuidance("do X");
    expect(out).toContain("Live guidance from the user:");
    expect(out).toContain("do X");
  });

  it("uses the override (receiving the raw body) when supplied", () => {
    const out = formatLiveInputGuidance("do X", { liveInputGuidance: (body) => `>> ${body}` });
    expect(out).toBe(">> do X");
  });
});
