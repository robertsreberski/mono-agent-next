import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { memoryBenchmarkGateResults, runMemoryBenchmark } from "../memory-benchmark.mjs";

describe("memory benchmark", () => {
  it("covers every required fast-suite scenario and passes the offline gates", async () => {
    const report = await runMemoryBenchmark();

    expect(report.disposableStore).toBe(true);
    expect(report.groups).toBe(1);
    expect(report.store.groups).toBe(1);
    expect(report.categories).toEqual(expect.arrayContaining([
      "fact",
      "paraphrase",
      "update",
      "temporal",
      "missing-attribute",
      "out-of-domain-abstention",
      "recurring-noise",
      "alternating",
      "duplicates",
      "entity-hop",
    ]));
    expect(report.policyCategories).toContain("high-similarity-adjacent");
    expect(report.policyCategories).toContain("ambiguous-binding");
    expect(report.policyCategories).toContain("direct-fact");
    expect(report.policyCalibration.passed).toBe(true);
    expect(report.gates.passed).toBe(true);
    expect(report.quality.recallAt5).toBeGreaterThanOrEqual(0.9);
    expect(report.quality.mrr).toBeGreaterThanOrEqual(0.8);
    expect(report.quality.directFactCaseCount).toBeGreaterThanOrEqual(6);
    expect(report.quality.directFactAutomaticCoverage).toBeGreaterThanOrEqual(0.9);
    expect(report.quality.ambiguousBindingCaseCount).toBeGreaterThanOrEqual(6);
    expect(report.quality.ambiguousBindingAbstentionRate).toBe(1);
    expect(report.quality.abstentionRate).toBeGreaterThanOrEqual(0.9);
    expect(report.quality.missingAttributeAbstentionRate).toBe(1);
    expect(report.quality.outOfDomainAbstentionRate).toBe(1);
    expect(report.quality.staleRecallRate).toBeLessThanOrEqual(0.05);
    expect(report.quality.falseRecallRate).toBeLessThanOrEqual(0.05);
    expect(report.efficiency).toMatchObject({
      contextBytes: expect.any(Object),
      indexingLatencyMs: expect.any(Object),
      searchLatencyMs: expect.any(Object),
      storageBytes: expect.any(Number),
      embeddings: expect.any(Object),
      llm: expect.any(Object),
      queueDrainMs: expect.any(Number),
    });
    const cleanup = report.calibrations.memoryCleanup;
    expect(cleanup.capture).toMatchObject({
      passed: true,
      metrics: { candidate: { calls: 2, callReduction: 0.6, associationPrecision: 1, associationRecall: 1 } },
    });
    expect(cleanup.graph).toMatchObject({
      passed: true,
      metrics: {
        multiHop: { cases: 10, baselineRecallAt5: 0, enabledRecallAt5: 1 },
        direct: { cases: 10, baselineRecallAt5: 1, enabledRecallAt5: 1 },
        adversarial: {
          cases: 25,
          leakCount: 0,
          missingRequiredCount: 0,
          categories: expect.arrayContaining([
            "negated-query",
            "stored-negated-relation",
            "stored-qualified-relation",
            "wrong-endpoint",
            "relation-particle-collision",
            "relation-particle-control",
          ]),
        },
        efficiency: { queryEmbeddingCalls: 20, expectedQueryEmbeddingCalls: 20, llmCalls: 0 },
      },
    });
    expect(report.gates.checks.memoryCleanup).toBe(true);
    expect(report.calibrations.providerAutomaticRecall).toMatchObject({
      provider: "deterministic",
      disposableStore: true,
      passed: true,
      eligibleDirectFact: { cases: 6, coverage: 1 },
      unsupported: { cases: 2, abstentionRate: 1 },
      efficiency: {
        embeddings: { calls: 9, texts: 17 },
        llm: { calls: 0 },
      },
      store: { records: 9, duplicateRatio: 0, vectorCoverage: 1 },
    });
    expect(report.gates.checks.providerEligibleDirectFactCaseCount).toBe(true);
    expect(report.gates.checks.providerEligibleDirectFactCoverage).toBe(true);
  });

  it("adapts opt-in LongMemEval session ids and LoCoMo dialogue evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-datasets-"));
    const longMemEval = join(dir, "longmemeval.json");
    const locomo = join(dir, "locomo.json");
    try {
      await writeFile(longMemEval, JSON.stringify([
        {
          question_id: "launch-office",
          question_type: "fact",
          question: "Where is the launch office?",
          haystack_session_ids: ["session-alpha"],
          haystack_sessions: [[{ content: "The launch office is in Amsterdam." }]],
          answer_session_ids: ["session-alpha"],
        },
        {
          question_id: "fertilizer_abs",
          question_type: "single-session-user",
          question: "What fertilizer should roses use?",
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]));
      await writeFile(locomo, JSON.stringify([{
        conversation: {
          speaker_a: "Morgan",
          session_1: [{ dia_id: "D1:1", text: "The launch office is in Amsterdam." }],
        },
        qa: [
          {
            category: "fact",
            question: "Where is the launch office?",
            evidence: ["D1:1"],
          },
          {
            category: 5,
            question: "What fertilizer should roses use?",
            evidence: ["D1:1"],
          },
          {
            category: 3,
            question: "Which sports car would Morgan probably prefer?",
          },
        ],
      }]));

      const longReport = await runMemoryBenchmark({ suite: "longmemeval", datasetPath: longMemEval });
      const locomoReport = await runMemoryBenchmark({ suite: "locomo", datasetPath: locomo });

      expect(longReport).toMatchObject({
        groups: 2,
        cases: 2,
        store: { groups: 2 },
        quality: { answerableCases: 1, abstentionRate: 1 },
      });
      expect(locomoReport).toMatchObject({
        groups: 1,
        cases: 2,
        store: { groups: 1 },
        quality: { answerableCases: 1, abstentionRate: 1 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates LongMemEval rows before aggregating case-weighted retrieval quality", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-grouped-dataset-"));
    const dataset = join(dir, "longmemeval-groups.json");
    try {
      await writeFile(dataset, JSON.stringify(Array.from({ length: 10 }, (_, index) => ({
        question_id: `shared-${index}`,
        question_type: "fact",
        question: "What is the launch office code?",
        haystack_session_ids: [`session-${index}`],
        haystack_sessions: [[{ content: "The launch office code is cobalt." }]],
        answer_session_ids: [`session-${index}`],
      }))));

      const report = await runMemoryBenchmark({ suite: "longmemeval", datasetPath: dataset });

      expect(report).toMatchObject({
        groups: 10,
        cases: 10,
        retrievalCases: 10,
        quality: { recallAt1: 1, recallAt5: 1, mrr: 1 },
        store: { groups: 10, records: 10, duplicateRatio: 0, vectorCoverage: 1 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("indexes each group in provider-sized batches instead of serial record upserts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-batched-dataset-"));
    const dataset = join(dir, "longmemeval-batch.json");
    try {
      const ids = Array.from({ length: 65 }, (_, index) => `session-${index}`);
      await writeFile(dataset, JSON.stringify([{
        question_id: "batch-target",
        question_type: "fact",
        question: "Which archive entry contains the unique ultramarine launch phrase?",
        haystack_session_ids: ids,
        haystack_sessions: ids.map((_, index) => [{
          content: index === 64
            ? "The unique ultramarine launch phrase is stored in archive entry sixty-five."
            : `Routine archive filler entry ${index}.`,
        }]),
        answer_session_ids: ["session-64"],
      }]));

      const report = await runMemoryBenchmark({ suite: "longmemeval", datasetPath: dataset });

      expect(report).toMatchObject({
        groups: 1,
        cases: 1,
        store: { records: 65 },
        efficiency: { embeddings: { calls: 4, texts: 66 } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails the gate when automatic injection finds no answers or does not abstain", () => {
    const base = {
      recallAt5: 1,
      mrr: 1,
      automaticAnswerCoverage: 1,
      directFactCaseCount: 6,
      directFactAutomaticCoverage: 1,
      ambiguousBindingCaseCount: 6,
      ambiguousBindingAbstentionRate: 1,
      abstentionRate: 1,
      missingAttributeAbstentionRate: 1,
      outOfDomainAbstentionRate: 1,
      staleRecallRate: 0,
      falseRecallRate: 0,
    };
    const providerContract = {
      eligibleDirectFact: { cases: 6, coverage: 1 },
      unsupported: { cases: 2, abstentionRate: 1 },
    };

    expect(memoryBenchmarkGateResults(
      { ...base, directFactAutomaticCoverage: 0 },
      { passed: true },
      providerContract,
    )).toMatchObject({
      passed: false,
      checks: { directFactAutomaticCoverage: false },
    });
    expect(memoryBenchmarkGateResults(
      { ...base, ambiguousBindingAbstentionRate: 0 },
      { passed: true },
      providerContract,
    )).toMatchObject({
      passed: false,
      checks: { ambiguousBindingAbstentionRate: false },
    });
    expect(memoryBenchmarkGateResults(
      { ...base, directFactCaseCount: 0 },
      { passed: true },
      providerContract,
    )).toMatchObject({
      passed: false,
      checks: { directFactCaseCount: false },
    });
    expect(memoryBenchmarkGateResults(
      { ...base, ambiguousBindingCaseCount: 5 },
      { passed: true },
      providerContract,
    )).toMatchObject({
      passed: false,
      checks: { ambiguousBindingCaseCount: false },
    });
    expect(memoryBenchmarkGateResults(
      { ...base, automaticAnswerCoverage: 0 },
      { passed: true },
      providerContract,
    ).passed).toBe(true);
    expect(memoryBenchmarkGateResults(
      { ...base, abstentionRate: 0 },
      { passed: true },
      providerContract,
    )).toMatchObject({
      passed: false,
      checks: { abstentionRate: false },
    });
    expect(memoryBenchmarkGateResults(base, { passed: false }, providerContract)).toMatchObject({
      passed: false,
      checks: { policyCalibration: false },
    });
    expect(memoryBenchmarkGateResults(base, { passed: true }, {
      eligibleDirectFact: { cases: 0, coverage: 1 },
      unsupported: { cases: 2, abstentionRate: 1 },
    })).toMatchObject({
      passed: false,
      checks: { providerEligibleDirectFactCaseCount: false },
    });
    expect(memoryBenchmarkGateResults(base, { passed: true }, {
      eligibleDirectFact: { cases: 6, coverage: 0 },
      unsupported: { cases: 2, abstentionRate: 1 },
    })).toMatchObject({
      passed: false,
      checks: { providerEligibleDirectFactCoverage: false },
    });
    // Unsupported relational/paraphrase behavior remains informational. Zero
    // unsupported coverage or abstention cannot make the eligible contract fail.
    expect(memoryBenchmarkGateResults(base, { passed: true }, {
      eligibleDirectFact: { cases: 6, coverage: 1 },
      unsupported: { cases: 2, abstentionRate: 0 },
    }).passed).toBe(true);
    expect(memoryBenchmarkGateResults(base, { passed: true }, {
      eligibleDirectFact: { cases: 6, coverage: 1 },
      unsupported: { cases: 0, abstentionRate: 0 },
    }).passed).toBe(true);
  });

  it("rejects LongMemEval answer evidence that cannot map to a haystack session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-memory-invalid-dataset-"));
    const dataset = join(dir, "longmemeval-invalid.json");
    try {
      await writeFile(dataset, JSON.stringify([{
        question_id: "broken-answer",
        question_type: "fact",
        question: "Where is the launch office?",
        haystack_session_ids: ["session-alpha"],
        haystack_sessions: [[{ content: "The launch office is in Amsterdam." }]],
        answer_session_ids: ["missing-session"],
      }]));
      await expect(runMemoryBenchmark({ suite: "longmemeval", datasetPath: dataset }))
        .rejects.toThrow("do not map to haystack_session_ids");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
