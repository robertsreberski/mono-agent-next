import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS,
  MAX_RECONCILIATION_TEXT_CODE_POINTS,
  normalizeCandidate,
  normalizeCandidateText,
} from "../distill.js";

describe("candidate normalization", () => {
  it("uses the 160-code-point capture cap without splitting an astral character", () => {
    expect(MAX_CAPTURE_CANDIDATE_TEXT_CODE_POINTS).toBe(160);
    const exactBoundary = `${"a".repeat(159)}🧠`;
    const overBoundary = `${exactBoundary}tail`;

    expect(normalizeCandidateText(exactBoundary)).toBe(exactBoundary);

    const first = normalizeCandidateText(overBoundary);
    const second = normalizeCandidateText(overBoundary);
    expect(first).toBe(exactBoundary);
    expect(second).toBe(first);
    expect(normalizeCandidate({ text: overBoundary })[0]?.text).toBe(exactBoundary);
    expect(Array.from(first ?? "")).toHaveLength(160);
    expect(first).not.toContain("�");
    expect(first).not.toMatch(/\p{Cs}/u);
  });

  it("uses the separate 280-code-point reconciliation cap", () => {
    expect(MAX_RECONCILIATION_TEXT_CODE_POINTS).toBe(280);
    const exactBoundary = `${"a".repeat(279)}🧠`;
    const overBoundary = `${exactBoundary}tail`;

    expect(normalizeCandidateText(exactBoundary, "reconcile")).toBe(exactBoundary);
    expect(normalizeCandidateText(overBoundary, "reconcile")).toBe(exactBoundary);
    expect(Array.from(normalizeCandidateText(overBoundary, "reconcile") ?? "")).toHaveLength(280);
  });

  it("removes escaped lone surrogates while preserving valid astral pairs", () => {
    const loneHigh = JSON.parse('"\\ud83d"') as string;
    const loneLow = JSON.parse('"\\udc00"') as string;
    const embedded = JSON.parse('"A\\ud83dB\\udc00C"') as string;
    const validPair = JSON.parse('"\\ud83e\\udde0"') as string;

    expect(normalizeCandidateText(loneHigh)).toBeUndefined();
    expect(normalizeCandidateText(loneLow)).toBeUndefined();
    expect(normalizeCandidateText(embedded)).toBe("ABC");
    expect(normalizeCandidateText(validPair)).toBe("🧠");
    expect(normalizeCandidateText(embedded)).not.toContain("�");
    expect(normalizeCandidateText(embedded)).not.toMatch(/\p{Cs}/u);
  });
});
