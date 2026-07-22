import { describe, expect, it, vi } from "vitest";
import { MAX_MODEL_JSON_CHARS, parseJsonLoose, parseJsonLooseWithDiagnostics } from "../json.js";
describe("parseJsonLoose", () => {
  it("parses a bare array", () => expect(parseJsonLoose('[{"a":1}]')).toEqual([{ a: 1 }]));
  it("parses fenced json with prose", () => expect(parseJsonLoose('Sure!\n```json\n{"x":[1,2]}\n```\nDone')).toEqual({ x: [1, 2] }));
  it("does not recover unrelated JSON before an unterminated first fence", () => {
    const fencedRemainder = '{"answer":';
    const scan = parseJsonLooseWithDiagnostics<{ answer: string }>(
      `Example only: {"unrelated":true}\n\`\`\`json\n${fencedRemainder}`,
    );

    expect(scan.value).toBeUndefined();
    expect(scan.characters).toBe(fencedRemainder.length);
    expect(scan.parseAttempts).toBe(0);
  });
  it("prefers a valid closed fence over complete JSON before and after it", () => {
    expect(parseJsonLoose(
      'Before: {"unrelated":true}\n```json\n{"selected":true}\n```\nAfter: {"alsoUnrelated":true}',
    )).toEqual({ selected: true });
  });
  it("keeps whole-text scanning when no fence exists", () => {
    expect(parseJsonLoose('Before {"small":true}; selected: {"larger":{"nested":true}}')).toEqual({
      larger: { nested: true },
    });
  });
  it.each([
    ["mixed-case JSON tag", "JsOn", "\n", true],
    ["non-JSON language tag", "javascript", "\n", false],
    ["Unicode-confusable tag", "jſon", "\n", false],
    ["Unicode whitespace after JSON tag", "JSON", "\u00a0", true],
  ])("preserves loose fence handling for a %s", (_label, tag, separator, recognizedJsonTag) => {
    const payload = '{"edge":true}';
    const input = ["```", tag, separator, payload, "\n```"].join("");
    const scan = parseJsonLooseWithDiagnostics<{ edge: boolean }>(input);

    expect(scan.value).toEqual({ edge: true });
    expect(scan.characters).toBe((recognizedJsonTag ? `${payload}\n` : `${tag}${separator}${payload}\n`).length);
  });
  it("parses an object embedded in prose with braces inside strings", () => expect(parseJsonLoose('result: {"t":"a } b"} ok')).toEqual({ t: "a } b" }));
  it("returns undefined for non-json", () => expect(parseJsonLoose("no json here")).toBeUndefined());
  it("skips prose/pseudocode brackets before the real JSON", () => {
    expect(parseJsonLoose('According to [research] the data is: {"result": true}')).toEqual({ result: true });
    expect(parseJsonLoose("Example: {x: 1} is pseudocode. Real: {\"x\": 1}")).toEqual({ x: 1 });
    expect(parseJsonLoose('See [link](url) and {fake} before {"data": [1,2]}')).toEqual({ data: [1, 2] });
  });
  it("prefers the largest parseable value over a trivial leading citation", () => {
    expect(parseJsonLoose('Rated [5] stars: [{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("rejects over-cap model output before attempting JSON.parse", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(parseJsonLoose(`${"x".repeat(MAX_MODEL_JSON_CHARS + 1)} {"ignored":true}`)).toBeUndefined();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("recovers a valid payload after 2k-16k unmatched starts with deterministically linear scan work", () => {
    const sizes = [2_000, 4_000, 8_000, 16_000];
    const scans = sizes.map((size) => {
      const input = `${"{".repeat(size)}\n{"result":true}`;
      const scan = parseJsonLooseWithDiagnostics<{ result: boolean }>(input);
      expect(scan.value).toEqual({ result: true });
      expect(scan.parseAttempts).toBe(1);
      expect(scan.rejectedForSize).toBe(false);
      return scan;
    });

    // Input grows 8x. The old per-start rescan grew ~64x; bounded active
    // candidates make measured scanner work grow no faster than input.
    expect(scans[3]!.candidateSteps).toBeLessThan(scans[0]!.candidateSteps * 8.1);
    for (let index = 1; index < scans.length; index += 1) {
      expect(scans[index]!.candidateSteps).toBeLessThan(scans[index - 1]!.candidateSteps * 2.1);
    }
  });
});
