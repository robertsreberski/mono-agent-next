import { describe, expect, it } from "vitest";
import {
  appendStructuredOutputInstruction,
  runStructuredOutputFinalizationRetry,
  shouldRetryStructuredOutputFinalization,
  structuredOutputFinalizationPrompt,
  structuredOutputRetryDiagnostics,
} from "../../ai/providers/pi-native/structured-output.js";

describe("appendStructuredOutputInstruction", () => {
  it("returns the prompt unchanged when there is no output schema", () => {
    expect(appendStructuredOutputInstruction("sys", null)).toBe("sys");
    expect(appendStructuredOutputInstruction("sys", undefined)).toBe("sys");
  });

  it("appends the StructuredOutput tool instruction when a schema is active", () => {
    const out = appendStructuredOutputInstruction("sys", { type: "object" });
    expect(out.startsWith("sys\n")).toBe(true);
    expect(out).toContain("Structured output is available through the `StructuredOutput` tool.");
    expect(out).toContain("Do not also print the same JSON as prose");
  });
});

describe("shouldRetryStructuredOutputFinalization (predicate table)", () => {
  const base = {
    outputSchema: { type: "object" },
    structuredResult: null,
    finalText: "",
    stopReason: "endTurn",
    externalAbort: false,
    maxTurnsHit: false,
  };

  const cases = [
    ["retries on an empty non-error turn with a schema", base, true],
    ["no schema → never retries", { ...base, outputSchema: null }, false],
    ["structured result already present → no retry", { ...base, structuredResult: { ok: true } }, false],
    ["structured result present as falsy-but-defined (0) → no retry", { ...base, structuredResult: 0 }, false],
    ["non-empty final text → no retry", { ...base, finalText: "done" }, false],
    ["whitespace-only final text still retries", { ...base, finalText: "   " }, true],
    ["external abort → no retry", { ...base, externalAbort: true }, false],
    ["max turns hit → no retry", { ...base, maxTurnsHit: true }, false],
    ["error stop reason → no retry", { ...base, stopReason: "error" }, false],
    ["aborted stop reason → no retry", { ...base, stopReason: "aborted" }, false],
    ["null stop reason → retries", { ...base, stopReason: null }, true],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(shouldRetryStructuredOutputFinalization(input)).toBe(expected);
    });
  }
});

describe("structuredOutputRetryDiagnostics", () => {
  it("is empty when no attempt was made", () => {
    expect(structuredOutputRetryDiagnostics(0, null, false)).toEqual({});
  });

  it("spells out the retry diagnostics keys when an attempt happened", () => {
    expect(structuredOutputRetryDiagnostics(1, "empty_final_output", true)).toEqual({
      structured_output_finalization_retry_attempts: 1,
      structured_output_finalization_retry_reason: "empty_final_output",
      structured_output_finalization_retry_failed: true,
    });
  });
});

// A minimal harness double: records setActiveTools calls and prompts, lets a
// test script the prompt to throw so the retry_failed warning path is exercised.
function fakeHarness({ activeTools = [{ name: "Bash" }, { name: "StructuredOutput" }], promptThrows = null } = {}) {
  const calls = { setActiveTools: [], prompts: [], waited: 0 };
  return {
    calls,
    getActiveTools: () => activeTools,
    setActiveTools: async (names) => { calls.setActiveTools.push(names); },
    prompt: async (text) => {
      calls.prompts.push(text);
      if (promptThrows) throw promptThrows;
    },
    waitForIdle: async () => { calls.waited += 1; },
  };
}

describe("runStructuredOutputFinalizationRetry", () => {
  it("narrows to StructuredOutput, re-prompts once, restores the prior tools, and warns", async () => {
    const harness = fakeHarness();
    const runtimeWarnings = [];
    const structuredTool = { name: "StructuredOutput" };

    const out = await runStructuredOutputFinalizationRetry({ harness, structuredTool, runtimeWarnings });

    expect(out).toEqual({ attempts: 1, reason: "empty_final_output" });
    // narrowed to only StructuredOutput, then restored the previous active set.
    expect(harness.calls.setActiveTools).toEqual([["StructuredOutput"], ["Bash", "StructuredOutput"]]);
    expect(harness.calls.prompts).toEqual([structuredOutputFinalizationPrompt()]);
    expect(runtimeWarnings).toEqual([
      {
        warning_kind: "structured_output_finalization_retry",
        source: "pi",
        reason: "empty_final_output",
        message: "Pi stopped without text or structured output; retrying once in the same session with only StructuredOutput enabled.",
      },
    ]);
  });

  it("narrows to an empty tool set when no structured tool is present", async () => {
    const harness = fakeHarness({ activeTools: [{ name: "Bash" }] });
    await runStructuredOutputFinalizationRetry({ harness, structuredTool: null, runtimeWarnings: [] });
    expect(harness.calls.setActiveTools[0]).toEqual([]);
  });

  it("emits a retry_failed warning and still restores tools when the re-prompt throws", async () => {
    const harness = fakeHarness({ promptThrows: new Error("boom") });
    const runtimeWarnings = [];
    await runStructuredOutputFinalizationRetry({ harness, structuredTool: { name: "StructuredOutput" }, runtimeWarnings });

    expect(runtimeWarnings).toContainEqual({
      warning_kind: "structured_output_finalization_retry_failed",
      source: "pi",
      message: "boom",
    });
    // tools restored despite the throw (finally).
    expect(harness.calls.setActiveTools[harness.calls.setActiveTools.length - 1]).toEqual(["Bash", "StructuredOutput"]);
  });
});
