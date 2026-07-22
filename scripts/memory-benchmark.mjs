#!/usr/bin/env node
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUTO_RECALL_BACKEND_HITS,
  AUTO_RECALL_MAX_BYTES,
  selectAutomaticRecallHits,
} from "../packages/memory/dist/bujo/index.js";
import { openMemoryDb } from "../packages/memory/dist/store/index.js";
import {
  MEMORY_CLEANUP_BENCHMARK_GATES,
  runMemoryCleanupBenchmark,
} from "./lib/memory-cleanup-calibration.mjs";

export const MEMORY_BENCHMARK_GATES = Object.freeze({
  recallAt5: 0.9,
  mrr: 0.8,
  directFactCaseCount: 6,
  directFactAutomaticCoverage: 0.9,
  ambiguousBindingCaseCount: 6,
  ambiguousBindingAbstentionRate: 1,
  abstentionRate: 0.9,
  missingAttributeAbstentionRate: 1,
  outOfDomainAbstentionRate: 1,
  staleRecallRate: 0.05,
  falseRecallRate: 0.05,
  providerEligibleDirectFactCaseCount: 1,
  providerEligibleDirectFactCoverage: 1,
});

const FAST_RECORDS = [
  record("fact-cobalt", "Morgan selected cobalt as the deployment color."),
  record("deploy-strategy", "Database rollouts use a blue-green deployment strategy."),
  record("release-old", "The release train leaves on Tuesday.", { status: "invalidated" }),
  record("release-current", "The release train now leaves on Thursday."),
  record("launch-date", "The API launch date is 2026-08-14.", { type: "event" }),
  ...[1, 2, 3, 4].map((index) => record(`heartbeat-${index}`, "Nightly heartbeat completed with no action required.")),
  record("atlas-lead", "Project Atlas is led by Morgan."),
  record("morgan-office", "Morgan's office is in Amsterdam."),
  record("noise-lunch", "The team orders soup for lunch on rainy days."),
];

const FAST_CASES = [
  testCase("fact", "What deployment color did Morgan select?", ["fact-cobalt"]),
  testCase("paraphrase", "How are database changes shipped?", ["deploy-strategy"]),
  testCase("update", "Which day does the release train now leave?", ["release-current"], ["release-old"]),
  testCase("temporal", "When is the API launch date?", ["launch-date"]),
  testCase("out-of-domain-abstention", "What fertilizer should I use for roses?", []),
  testCase("out-of-domain-abstention", "What temperature should I bake sourdough at?", []),
  testCase("out-of-domain-abstention", "What is the capital of Peru?", []),
  testCase("missing-attribute", "What is Morgans favorite food?", []),
  testCase("missing-attribute", "What is Morgans phone number?", []),
  testCase("missing-attribute", "Which cloud provider hosts Project Atlas?", []),
  testCase("missing-attribute", "Who approved the blue-green deployment strategy?", []),
  testCase("missing-attribute", "What time does the release train leave on Thursday?", []),
  testCase("missing-attribute", "Where will the API launch event be held?", []),
  testCase("missing-attribute", "What is Project Atlas budget?", []),
  testCase("missing-attribute", "Does Morgan work remotely?", []),
  testCase("missing-attribute", "Who chose the database vendor?", []),
  testCase("missing-attribute", "What color is Morgans car?", []),
  testCase("recurring-noise", "Did the nightly heartbeat require action?", [
    "heartbeat-1", "heartbeat-2", "heartbeat-3", "heartbeat-4",
  ]),
  testCase("duplicates", "Show the repeated nightly heartbeat status.", [
    "heartbeat-1", "heartbeat-2", "heartbeat-3", "heartbeat-4",
  ]),
  testCase("entity-hop", "Where is Morgan, the person who leads Project Atlas, based?", [
    "morgan-office", "atlas-lead",
  ]),
  testCase("alternating", "Remind me of Morgan's deployment color.", ["fact-cobalt"]),
  testCase("alternating", "What date is the API launch?", ["launch-date"]),
  testCase("alternating", "Remind me of Morgan's deployment color.", ["fact-cobalt"]),
];

// Unlike FAST_POLICY_CASES, these cases exercise the configured embedding
// provider, a real disposable index, db.recall, and the production selector.
// Unsupported cases are informational: only the finite eligible direct-fact
// contract is gated.
const PROVIDER_AUTOMATIC_RECORDS = [
  record("provider-color", "Morgan selected cobalt as the deployment color."),
  record("provider-phone", "Morgan's phone number is 555-0100."),
  record("provider-car", "Morgan's car color is red."),
  record("provider-release", "The release train leaves on Thursday."),
  record("provider-launch", "The API launch date is 2026-08-14."),
  record("provider-location", "Morgan works in Amsterdam."),
  record("provider-strategy", "Database rollouts use a blue-green deployment strategy."),
  record("provider-atlas-lead", "Project Atlas is led by Morgan."),
  record("provider-morgan-office", "Morgan's office is in Amsterdam."),
];

const PROVIDER_AUTOMATIC_CASES = [
  providerCase("eligible-direct-fact", "What deployment color did Morgan select?", ["provider-color"]),
  providerCase("eligible-direct-fact", "What is Morgan's phone number?", ["provider-phone"]),
  providerCase("eligible-direct-fact", "What color is Morgan's car?", ["provider-car"]),
  providerCase("eligible-direct-fact", "When does the release train leave?", ["provider-release"]),
  providerCase("eligible-direct-fact", "When is the API launch date?", ["provider-launch"]),
  providerCase("eligible-direct-fact", "Where does Morgan work?", ["provider-location"]),
  providerCase("unsupported", "How are database changes shipped?", ["provider-strategy"]),
  providerCase(
    "unsupported",
    "Where is Morgan, the person who leads Project Atlas, based?",
    ["provider-morgan-office", "provider-atlas-lead"],
  ),
];

// Regression distribution captured from the default nomic provider: a direct
// answer is followed by semantically adjacent records with deceptively high
// absolute scores. Synthetic scores exercise policy calibration separately
// from provider quality/latency metrics.
const FAST_POLICY_CASES = [{
  item: testCase(
    "high-similarity-adjacent",
    "What deployment color did Morgan select?",
    ["probe-answer"],
    [],
    "direct-fact",
  ),
  hits: [
    scoredHit("probe-answer", "Morgan selected cobalt as the deployment color.", 1.005),
    scoredHit("probe-adjacent", "Morgan's office is in Amsterdam.", 0.798),
    scoredHit("probe-other", "Database rollouts use a blue-green deployment strategy.", 0.751),
    scoredHit("probe-weak", "Project Atlas is led by Morgan.", 0.708),
  ],
}, ...[
  {
    query: "What is Morgan's phone number?",
    id: "direct-phone",
    text: "Morgan's phone number is 555-0100.",
  },
  {
    query: "What color is Morgan's car?",
    id: "direct-car-color",
    text: "Morgan's car color is red.",
  },
  {
    query: "When does the release train leave?",
    id: "direct-release-time",
    text: "The release train leaves on Thursday.",
  },
  {
    query: "When is the API launch date?",
    id: "direct-api-date",
    text: "The API launch date is 2026-08-14.",
  },
  {
    query: "Where does Morgan work?",
    id: "direct-location",
    text: "Morgan works in Amsterdam.",
  },
].map(({ query, id, text }) => ({
  item: testCase("direct-fact", query, [id], [], "direct-fact"),
  hits: [scoredHit(id, text, 0.95)],
})), ...[
  {
    query: "What color is Morgans car?",
    id: "ambiguous-coordination",
    text: "Morgan selected cobalt as the deployment color and drives a hatchback car.",
  },
  {
    query: "What is Morgans phone number?",
    id: "ambiguous-ditransitive",
    text: "Morgan gave Taylor the phone number 555-0100.",
  },
  {
    query: "What is Morgans phone number?",
    id: "ambiguous-reported",
    text: "Morgan said Taylor's phone number is 555-0100.",
  },
  {
    query: "Who approved the blue-green deployment strategy?",
    id: "ambiguous-subordinate",
    text: "The database uses a blue-green deployment strategy that Taylor discussed after approving the travel policy.",
  },
  {
    query: "Where is Morgans manager based?",
    id: "ambiguous-inverse",
    text: "Morgan manages Taylor and Taylor is based in Paris.",
  },
  {
    query: "What is Morgans phone number?",
    id: "ambiguous-unknown",
    text: "Morgan's phone number is unknown.",
  },
].map(({ query, id, text }) => ({
  item: testCase("ambiguous-binding", query, [], [], "ambiguous-binding"),
  hits: [scoredHit(id, text, 0.95)],
}))];

export async function runMemoryBenchmark(options = {}) {
  const suite = options.suite ?? "fast";
  const fixture = suite === "fast"
    ? {
        groups: [{
          id: "fast",
          records: FAST_RECORDS,
          cases: FAST_CASES,
          staleIds: new Set(["release-old"]),
        }],
        policyCases: FAST_POLICY_CASES,
      }
    : await loadExternalFixture(suite, options.datasetPath);
  const root = await mkdtemp(join(tmpdir(), "mono-agent-memory-benchmark-"));
  const metrics = {
    embeddingCalls: 0,
    embeddedTexts: 0,
    embeddingInputTokens: 0,
  };
  const provider = await embeddingProvider(options.provider ?? "deterministic", options, metrics);
  const dim = options.dim ?? provider.dim;
  const indexingLatencies = [];
  const searchLatencies = [];
  const queryResults = [];
  const audits = [];
  let queueDrainMs = 0;
  try {
    for (const [groupIndex, group] of fixture.groups.entries()) {
      const dbPath = join(root, `memory-${groupIndex}.db`);
      const db = openMemoryDb({ path: dbPath, embeddings: provider, dim });
      try {
        const started = performance.now();
        await db.upsertMany(group.records, { batchSize: 32 });
        indexingLatencies.push(performance.now() - started);
        for (const item of group.cases) {
          const searchStarted = performance.now();
          // Match the app-owned service: automatic recall fetches one bounded
          // superset that can also satisfy the explicit tool limit without a
          // second backend lookup for the same normalized query.
          const hits = await db.recall(item.query, { topK: AUTO_RECALL_BACKEND_HITS });
          searchLatencies.push(performance.now() - searchStarted);
          const automatic = selectAutomaticRecallHits(hits, { query: item.query });
          queryResults.push({ item, hits, automatic, staleIds: group.staleIds ?? new Set() });
        }
        audits.push(db.audit());
      } finally {
        db.close();
      }
    }
    // Compatibility field: there is no longer a serial per-record queue, so
    // this is the aggregate wall time spent draining group-local batch writes.
    queueDrainMs = sum(indexingLatencies);

    const policyResults = (fixture.policyCases ?? FAST_POLICY_CASES).map(({ item, hits }) => ({
      item,
      hits,
      automatic: selectAutomaticRecallHits(hits, { query: item.query }),
    }));
    const automaticContract = automaticContractMetrics(policyResults);
    const quality = { ...qualityMetrics(queryResults), ...automaticContract };
    const policyCalibration = policyCalibrationMetrics(policyResults);
    const storageBytes = await directoryBytes(root);
    const providerAutomaticRecall = await runProviderAutomaticRecallCalibration(options);
    // Fixed capture/graph calibration is intentionally separate from provider
    // retrieval quality, latency, and cost. It uses its own disposable stores,
    // deterministic providers, and counters so it cannot improve or pollute the
    // selected provider's metrics above.
    const memoryCleanup = suite === "fast" ? await runMemoryCleanupBenchmark() : undefined;
    const primaryGates = memoryBenchmarkGateResults(
      quality,
      policyCalibration,
      providerAutomaticRecall,
    );
    const recordCount = fixture.groups.reduce((total, group) => total + group.records.length, 0);
    const aggregateAudit = aggregateStoreAudits(audits);
    const report = {
      suite,
      provider: options.provider ?? "deterministic",
      disposableStore: true,
      groups: fixture.groups.length,
      cases: queryResults.length,
      retrievalCases: queryResults.length,
      policyCases: policyResults.length,
      categories: [...new Set(queryResults.map(({ item }) => item.category))].sort(),
      policyCategories: [...new Set(policyResults.map(({ item }) => item.category))].sort(),
      quality,
      policyCalibration,
      efficiency: {
        contextBytes: contextByteMetrics(queryResults),
        indexingLatencyMs: latencyMetrics(indexingLatencies),
        searchLatencyMs: latencyMetrics(searchLatencies),
        storageBytes,
        embeddings: {
          calls: metrics.embeddingCalls,
          texts: metrics.embeddedTexts,
          inputTokens: metrics.embeddingInputTokens,
          costUsd: 0,
        },
        llm: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        queueDrainMs,
      },
      store: {
        groups: fixture.groups.length,
        records: recordCount,
        duplicateRatio: aggregateAudit.duplicateRatio,
        vectorCoverage: aggregateAudit.vectorCoverage,
      },
      calibrations: {
        providerAutomaticRecall,
        ...(memoryCleanup === undefined ? {} : { memoryCleanup }),
      },
      gates: combineBenchmarkGates(primaryGates, memoryCleanup),
    };
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function combineBenchmarkGates(primary, memoryCleanup) {
  if (memoryCleanup === undefined) return primary;
  return {
    ...primary,
    passed: primary.passed && memoryCleanup.passed,
    checks: { ...primary.checks, memoryCleanup: memoryCleanup.passed },
    thresholds: { ...primary.thresholds, memoryCleanup: MEMORY_CLEANUP_BENCHMARK_GATES },
  };
}

function qualityMetrics(results) {
  const answerable = results.filter(({ item }) => item.relevantIds.length > 0);
  const recalls = { 1: [], 5: [], 8: [] };
  const automaticRecalls = [];
  const automaticCoverage = [];
  const reciprocalRanks = [];
  const ndcg = [];
  let staleHits = 0;
  let falseHits = 0;
  let totalAutomaticHits = 0;
  for (const { item, hits, automatic, staleIds } of results) {
    const relevant = new Set(item.relevantIds);
    if (relevant.size > 0) {
      for (const k of [1, 5, 8]) {
        const found = new Set(hits.slice(0, k).map((hit) => hit.record.id).filter((id) => relevant.has(id)));
        recalls[k].push(found.size / relevant.size);
      }
      const first = hits.findIndex((hit) => relevant.has(hit.record.id));
      reciprocalRanks.push(first < 0 ? 0 : 1 / (first + 1));
      ndcg.push(ndcgAt(hits.map((hit) => relevant.has(hit.record.id)), relevant.size, 8));
      const automaticFound = new Set(automatic
        .map((hit) => hit.record.id)
        .filter((id) => relevant.has(id)));
      automaticRecalls.push(automaticFound.size / relevant.size);
      automaticCoverage.push(automaticFound.size > 0 ? 1 : 0);
    }
    for (const hit of automatic) {
      totalAutomaticHits += 1;
      if (staleIds.has(hit.record.id) || item.staleIds.includes(hit.record.id)) staleHits += 1;
      if (!relevant.has(hit.record.id)) falseHits += 1;
    }
  }
  return {
    recallAt1: mean(recalls[1]),
    recallAt5: mean(recalls[5]),
    recallAt8: mean(recalls[8]),
    mrr: mean(reciprocalRanks),
    ndcgAt8: mean(ndcg),
    automaticRecallAt5: mean(automaticRecalls),
    automaticAnswerCoverage: mean(automaticCoverage),
    automaticAnswerCoverageByCategory: Object.fromEntries([...new Set(answerable.map(({ item }) => item.category))]
      .sort()
      .map((category) => {
        const matching = results.filter(({ item }) => item.category === category && item.relevantIds.length > 0);
        return [category, mean(matching.map(({ item, automatic }) => {
          const relevant = new Set(item.relevantIds);
          return automatic.some((hit) => relevant.has(hit.record.id)) ? 1 : 0;
        }))];
      })),
    staleRecallRate: totalAutomaticHits === 0 ? 0 : staleHits / totalAutomaticHits,
    falseRecallRate: totalAutomaticHits === 0 ? 0 : falseHits / totalAutomaticHits,
    abstentionRate: mean(results
      .filter(({ item }) => item.relevantIds.length === 0)
      .map(({ automatic }) => automatic.length === 0 ? 1 : 0)),
    missingAttributeAbstentionRate: abstentionRateForCategory(results, "missing-attribute"),
    outOfDomainAbstentionRate: abstentionRateForCategory(results, "out-of-domain-abstention"),
    answerableCases: answerable.length,
  };
}

function policyCalibrationMetrics(results) {
  const checks = results.map(({ item, automatic }) => {
    const expected = new Set(item.relevantIds);
    const selected = new Set(automatic.map((hit) => hit.record.id));
    if (item.automaticClass === "ambiguous-binding") return selected.size === 0;
    return expected.size > 0
      && [...expected].every((id) => selected.has(id))
      && [...selected].every((id) => expected.has(id));
  });
  return { cases: results.length, passed: checks.every(Boolean), checks };
}

function automaticContractMetrics(results) {
  const directFacts = results.filter(({ item }) => item.automaticClass === "direct-fact");
  const ambiguousBindings = results.filter(({ item }) => item.automaticClass === "ambiguous-binding");
  return {
    directFactCaseCount: directFacts.length,
    directFactAutomaticCoverage: mean(directFacts.map(({ item, automatic }) => {
      const relevant = new Set(item.relevantIds);
      return automatic.some((hit) => relevant.has(hit.record.id)) ? 1 : 0;
    })),
    ambiguousBindingCaseCount: ambiguousBindings.length,
    ambiguousBindingAbstentionRate:
      mean(ambiguousBindings.map(({ automatic }) => automatic.length === 0 ? 1 : 0)),
  };
}

export function memoryBenchmarkGateResults(
  quality,
  policyCalibration = { passed: true },
  providerAutomaticRecall = {},
) {
  const checks = {
    recallAt5: quality.recallAt5 >= MEMORY_BENCHMARK_GATES.recallAt5,
    mrr: quality.mrr >= MEMORY_BENCHMARK_GATES.mrr,
    directFactCaseCount:
      quality.directFactCaseCount >= MEMORY_BENCHMARK_GATES.directFactCaseCount,
    directFactAutomaticCoverage:
      quality.directFactAutomaticCoverage >= MEMORY_BENCHMARK_GATES.directFactAutomaticCoverage,
    ambiguousBindingCaseCount:
      quality.ambiguousBindingCaseCount >= MEMORY_BENCHMARK_GATES.ambiguousBindingCaseCount,
    ambiguousBindingAbstentionRate:
      quality.ambiguousBindingAbstentionRate >= MEMORY_BENCHMARK_GATES.ambiguousBindingAbstentionRate,
    abstentionRate: quality.abstentionRate >= MEMORY_BENCHMARK_GATES.abstentionRate,
    missingAttributeAbstentionRate:
      quality.missingAttributeAbstentionRate >= MEMORY_BENCHMARK_GATES.missingAttributeAbstentionRate,
    outOfDomainAbstentionRate:
      quality.outOfDomainAbstentionRate >= MEMORY_BENCHMARK_GATES.outOfDomainAbstentionRate,
    staleRecallRate: quality.staleRecallRate <= MEMORY_BENCHMARK_GATES.staleRecallRate,
    falseRecallRate: quality.falseRecallRate <= MEMORY_BENCHMARK_GATES.falseRecallRate,
    policyCalibration: policyCalibration.passed === true,
    providerEligibleDirectFactCaseCount:
      (providerAutomaticRecall.eligibleDirectFact?.cases ?? 0)
        >= MEMORY_BENCHMARK_GATES.providerEligibleDirectFactCaseCount,
    providerEligibleDirectFactCoverage:
      (providerAutomaticRecall.eligibleDirectFact?.coverage ?? 0)
        >= MEMORY_BENCHMARK_GATES.providerEligibleDirectFactCoverage,
  };
  return { passed: Object.values(checks).every(Boolean), checks, thresholds: MEMORY_BENCHMARK_GATES };
}

function abstentionRateForCategory(results, category) {
  const matching = results.filter(({ item }) => item.category === category);
  return matching.length === 0
    ? 1
    : mean(matching.map(({ automatic }) => automatic.length === 0 ? 1 : 0));
}

function contextByteMetrics(results) {
  const bytes = results.map(({ automatic }) => Math.min(AUTO_RECALL_MAX_BYTES, Buffer.byteLength(
    automatic.length === 0 ? "" : ["## Memory (recalled)", "", ...automatic.map((hit) => `- ${hit.record.text}`)].join("\n"),
    "utf8",
  )));
  return { total: sum(bytes), average: mean(bytes), p95: percentile(bytes, 0.95), max: Math.max(0, ...bytes) };
}

function latencyMetrics(values) {
  return { total: sum(values), average: mean(values), p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

async function runProviderAutomaticRecallCalibration(options) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-memory-provider-contract-"));
  const metrics = { embeddingCalls: 0, embeddedTexts: 0, embeddingInputTokens: 0 };
  const provider = await embeddingProvider(options.provider ?? "deterministic", options, metrics);
  const dim = options.dim ?? provider.dim;
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: provider, dim });
  const indexingLatencies = [];
  const searchLatencies = [];
  try {
    const indexStarted = performance.now();
    await db.upsertMany(PROVIDER_AUTOMATIC_RECORDS, { batchSize: 32 });
    indexingLatencies.push(performance.now() - indexStarted);

    const results = [];
    for (const item of PROVIDER_AUTOMATIC_CASES) {
      const searchStarted = performance.now();
      const hits = await db.recall(item.query, { topK: AUTO_RECALL_BACKEND_HITS });
      searchLatencies.push(performance.now() - searchStarted);
      results.push({
        item,
        automatic: selectAutomaticRecallHits(hits, { query: item.query }),
      });
    }

    const eligible = results.filter(({ item }) => item.eligibility === "eligible-direct-fact");
    const unsupported = results.filter(({ item }) => item.eligibility === "unsupported");
    const eligibleCoverage = mean(eligible.map(({ item, automatic }) => {
      const relevant = new Set(item.relevantIds);
      return automatic.some((hit) => relevant.has(hit.record.id)) ? 1 : 0;
    }));
    const unsupportedAbstention = mean(unsupported.map(({ automatic }) =>
      automatic.length === 0 ? 1 : 0));
    const audit = db.audit();
    return {
      provider: options.provider ?? "deterministic",
      disposableStore: true,
      passed: eligible.length >= MEMORY_BENCHMARK_GATES.providerEligibleDirectFactCaseCount
        && eligibleCoverage >= MEMORY_BENCHMARK_GATES.providerEligibleDirectFactCoverage,
      eligibleDirectFact: {
        cases: eligible.length,
        coverage: eligibleCoverage,
      },
      unsupported: {
        cases: unsupported.length,
        abstentionRate: unsupportedAbstention,
      },
      efficiency: {
        indexingLatencyMs: latencyMetrics(indexingLatencies),
        searchLatencyMs: latencyMetrics(searchLatencies),
        storageBytes: await directoryBytes(root),
        embeddings: {
          calls: metrics.embeddingCalls,
          texts: metrics.embeddedTexts,
          inputTokens: metrics.embeddingInputTokens,
          costUsd: 0,
        },
        llm: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
      store: {
        records: PROVIDER_AUTOMATIC_RECORDS.length,
        duplicateRatio: audit.duplicates.ratio,
        vectorCoverage: audit.vectors.liveCoverage,
      },
    };
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

function aggregateStoreAudits(audits) {
  const live = sum(audits.map((audit) => audit.counts.live));
  const redundant = sum(audits.map((audit) => audit.duplicates.redundantRecords));
  const liveIndexed = sum(audits.map((audit) => audit.vectors.liveIndexed));
  return {
    duplicateRatio: live === 0 ? 0 : redundant / live,
    vectorCoverage: live === 0 ? 1 : liveIndexed / live,
  };
}

async function embeddingProvider(kind, options, metrics) {
  let delegate;
  let dim = options.dim ?? 256;
  if (kind === "deterministic") {
    delegate = { id: "benchmark-deterministic", embed: async (texts) => texts.map((text) => embedDeterministic(text, dim)) };
  } else if (kind === "ollama") {
    const { createEmbeddingProvider } = await import("../packages/memory/dist/search/index.js");
    dim = options.dim ?? Number(process.env.MONO_AGENT_MEMORY_EMBEDDINGS_DIM ?? 768);
    delegate = createEmbeddingProvider({
      provider: "ollama",
      model: process.env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL ?? "nomic-embed-text:v1.5",
      endpoint: process.env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT ?? "http://127.0.0.1:11434",
    });
  } else {
    throw new Error(`Unknown benchmark provider "${kind}" (expected deterministic or ollama).`);
  }
  return {
    id: delegate.id,
    dim,
    embed: async (texts) => {
      metrics.embeddingCalls += 1;
      metrics.embeddedTexts += texts.length;
      metrics.embeddingInputTokens += texts.reduce((total, text) => total + tokenCount(text), 0);
      return await delegate.embed(texts);
    },
  };
}

function embedDeterministic(text, dim) {
  const vector = new Array(dim).fill(0);
  const stripped = text.replace(/^search_(query|document):\s*/u, "");
  for (const raw of stripped.toLowerCase().split(/[^a-z0-9-]+/u)) {
    if (!raw) continue;
    const token = canonicalToken(raw);
    vector[hash(token) % dim] += 1;
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function canonicalToken(token) {
  const aliases = {
    based: "office", changes: "database", deploy: "deployment", deployed: "deployment",
    rollouts: "deployment", rollout: "deployment", shipped: "deployment", shipping: "deployment",
    leads: "led", leading: "led", selected: "select", preferred: "select", preference: "select",
    scheduled: "leave", leaves: "leave", launch: "launchdate", date: "launchdate",
  };
  return aliases[token] ?? token;
}

function hash(token) {
  let value = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    value ^= token.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

async function loadExternalFixture(suite, datasetPath) {
  if (suite !== "longmemeval" && suite !== "locomo") {
    throw new Error(`Unknown benchmark suite "${suite}" (expected fast, longmemeval, or locomo).`);
  }
  if (!datasetPath) throw new Error(`--dataset is required for the opt-in ${suite} suite.`);
  const raw = JSON.parse(await readFile(datasetPath, "utf8"));
  return suite === "longmemeval" ? adaptLongMemEval(raw) : adaptLocomo(raw);
}

function adaptLongMemEval(value) {
  const rows = Array.isArray(value) ? value : value.data;
  if (!Array.isArray(rows)) throw new Error("LongMemEval dataset must be an array or {data: array}.");
  const groups = [];
  for (const [rowIndex, row] of rows.entries()) {
    const records = [];
    const cases = [];
    const sessions = Array.isArray(row.haystack_sessions) ? row.haystack_sessions : [];
    const upstreamSessionIds = Array.isArray(row.haystack_session_ids)
      ? row.haystack_session_ids.map(String)
      : [];
    const ids = [];
    for (const [sessionIndex, session] of sessions.entries()) {
      const id = `lme-${rowIndex}-${sessionIndex}`;
      ids.push(id);
      const messages = Array.isArray(session) ? session : [];
      records.push(record(id, messages.map((message) => message.content ?? "").join(" ")));
    }
    const rawRelevant = Array.isArray(row.answer_session_ids) ? row.answer_session_ids : [];
    const relevant = rawRelevant.flatMap((entry) => {
      const upstreamIndex = upstreamSessionIds.indexOf(String(entry));
      if (upstreamIndex >= 0 && ids[upstreamIndex]) return [ids[upstreamIndex]];
      const numericIndex = typeof entry === "number" ? entry : Number(entry);
      return Number.isInteger(numericIndex) && ids[numericIndex] ? [ids[numericIndex]] : [];
    });
    if (typeof row.question === "string") {
      const isAbstention = String(row.question_id ?? "").endsWith("_abs");
      if (isAbstention) {
        cases.push(testCase(String(row.question_type ?? "abstention"), row.question, []));
      } else {
        if (rawRelevant.length > 0 && relevant.length === 0) {
          throw new Error(
            `LongMemEval row ${rowIndex} has answer_session_ids that do not map to haystack_session_ids.`,
          );
        }
        // A non-abstention row without answer-session evidence is not evaluable as
        // retrieval recall. Skip it instead of treating it as a successful abstention.
        if (relevant.length > 0) {
          cases.push(testCase(String(row.question_type ?? "external"), row.question, [...new Set(relevant)]));
        }
      }
    }
    if (cases.length > 0) groups.push({ id: `longmemeval-${rowIndex}`, records, cases, staleIds: new Set() });
  }
  return { groups };
}

function adaptLocomo(value) {
  const rows = Array.isArray(value) ? value : value.data;
  if (!Array.isArray(rows)) throw new Error("LoCoMo dataset must be an array or {data: array}.");
  const groups = [];
  for (const [rowIndex, row] of rows.entries()) {
    const records = [];
    const cases = [];
    const sessions = row.conversation && typeof row.conversation === "object" ? row.conversation : {};
    const localRecords = [];
    for (const [session, messages] of Object.entries(sessions)) {
      if (!Array.isArray(messages)) continue;
      for (const [messageIndex, message] of messages.entries()) {
        const id = `locomo-${rowIndex}-${session}-${messageIndex}`;
        const text = String(message.text ?? message.content ?? "");
        const item = record(id, text);
        records.push(item);
        const evidenceId = String(message.dia_id ?? message.dialogue_id ?? message.message_id ?? message.id ?? "");
        localRecords.push({
          item,
          keys: new Set([
            evidenceId,
            `${session}:${messageIndex}`,
            `${session}:${messageIndex + 1}`,
          ].filter(Boolean)),
        });
      }
    }
    for (const qa of Array.isArray(row.qa) ? row.qa : []) {
      if (typeof qa.question !== "string") continue;
      const isAdversarial = Number(qa.category) === 5 || qa.category === "adversarial";
      if (isAdversarial) {
        // LoCoMo category 5 is the adversarial/unanswerable class. Standard QA
        // reports usually exclude it; this retrieval suite deliberately uses it
        // to measure automatic-recall abstention.
        cases.push(testCase("adversarial", qa.question, []));
        continue;
      }
      const evidence = (Array.isArray(qa.evidence) ? qa.evidence : [])
        .map((entry) => typeof entry === "object" && entry !== null
          ? String(entry.dia_id ?? entry.dialogue_id ?? entry.message_id ?? entry.id ?? entry.text ?? "")
          : String(entry))
        .filter(Boolean);
      const relevant = localRecords
        .filter(({ item, keys }) => evidence.some((snippet) =>
          keys.has(snippet) || item.text.includes(snippet) || snippet.includes(item.text)))
        .map(({ item }) => item.id);
      if (evidence.length > 0 && relevant.length === 0) {
        throw new Error(`LoCoMo row ${rowIndex} has evidence that does not map to any dialogue record.`);
      }
      // Ordinary rows without evidence are not necessarily unanswerable and
      // cannot score retrieval, so leave them unevaluated.
      if (relevant.length > 0) {
        cases.push(testCase(String(qa.category ?? "external"), qa.question, [...new Set(relevant)]));
      }
    }
    if (cases.length > 0) groups.push({ id: `locomo-${rowIndex}`, records, cases, staleIds: new Set() });
  }
  return { groups };
}

function record(id, text, overrides = {}) {
  return {
    id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: "2026-07-10T12:00:00.000Z", accessCount: 0, tags: [], source: {}, ...overrides,
  };
}

function scoredHit(id, text, score) {
  return { score, record: record(id, text) };
}

function testCase(category, query, relevantIds, staleIds = [], automaticClass) {
  return { category, query, relevantIds, staleIds, automaticClass };
}

function providerCase(eligibility, query, relevantIds) {
  return { eligibility, query, relevantIds };
}

function ndcgAt(relevance, relevantCount, k) {
  const dcg = relevance.slice(0, k).reduce((total, hit, index) => total + (hit ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevantCount, k) }, (_, index) => 1 / Math.log2(index + 2));
  return sum(ideal) === 0 ? 0 : dcg / sum(ideal);
}

function tokenCount(text) {
  return (text.match(/[a-z0-9]+/giu) ?? []).length;
}

function sum(values) { return values.reduce((total, value) => total + value, 0); }
function mean(values) { return values.length === 0 ? 0 : sum(values) / values.length; }
function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

async function directoryBytes(root) {
  let total = 0;
  for (const name of await readdir(root)) {
    const info = await stat(join(root, name));
    if (info.isFile()) total += info.size;
  }
  return total;
}

function parseArgs(argv) {
  const out = { suite: "fast", provider: "deterministic", gate: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gate") out.gate = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--suite") out.suite = argv[++index];
    else if (arg === "--provider") out.provider = argv[++index];
    else if (arg === "--dataset") out.datasetPath = argv[++index];
    else if (arg === "--dim") out.dim = Number(argv[++index]);
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return out;
}

function render(report) {
  const q = report.quality;
  const e = report.efficiency;
  const providerAutomatic = report.calibrations.providerAutomaticRecall;
  const cleanup = report.calibrations?.memoryCleanup;
  const cleanupLines = cleanup === undefined ? [] : [
    `capture calls ${cleanup.capture.metrics.baseline.calls}->${cleanup.capture.metrics.candidate.calls} (${(cleanup.capture.metrics.candidate.callReduction * 100).toFixed(1)}% reduction)  associations P/R ${cleanup.capture.metrics.candidate.associationPrecision.toFixed(3)}/${cleanup.capture.metrics.candidate.associationRecall.toFixed(3)}`,
    `graph multi-hop Recall@5 ${(cleanup.graph.metrics.multiHop.baselineRecallAt5 * 100).toFixed(1)}%->${(cleanup.graph.metrics.multiHop.enabledRecallAt5 * 100).toFixed(1)}%  direct ${(cleanup.graph.metrics.direct.baselineRecallAt5 * 100).toFixed(1)}%->${(cleanup.graph.metrics.direct.enabledRecallAt5 * 100).toFixed(1)}%  adversarial leaks ${cleanup.graph.metrics.adversarial.leakCount}`,
  ];
  return [
    `memory benchmark (${report.suite}, ${report.provider}, disposable store)`,
    `Recall@1/5/8 ${(q.recallAt1 * 100).toFixed(1)}% / ${(q.recallAt5 * 100).toFixed(1)}% / ${(q.recallAt8 * 100).toFixed(1)}%`,
    `MRR ${q.mrr.toFixed(3)}  nDCG@8 ${q.ndcgAt8.toFixed(3)}`,
    `automatic Recall@5 ${(q.automaticRecallAt5 * 100).toFixed(1)}%  overall answer coverage ${(q.automaticAnswerCoverage * 100).toFixed(1)}%`,
    `direct-fact auto coverage ${(q.directFactAutomaticCoverage * 100).toFixed(1)}% (${q.directFactCaseCount} cases)  ambiguous-binding abstention ${(q.ambiguousBindingAbstentionRate * 100).toFixed(1)}% (${q.ambiguousBindingCaseCount} cases)`,
    `stale ${(q.staleRecallRate * 100).toFixed(2)}%  false ${(q.falseRecallRate * 100).toFixed(2)}%  abstention ${(q.abstentionRate * 100).toFixed(1)}%`,
    `missing-attribute abstention ${(q.missingAttributeAbstentionRate * 100).toFixed(1)}%  out-of-domain abstention ${(q.outOfDomainAbstentionRate * 100).toFixed(1)}%`,
    `synthetic policy calibration ${report.policyCalibration.passed ? "PASS" : "FAIL"} (${report.policyCalibration.cases} separate case(s))`,
    `provider-backed eligible direct-fact coverage ${(providerAutomatic.eligibleDirectFact.coverage * 100).toFixed(1)}% (${providerAutomatic.eligibleDirectFact.cases} cases)  unsupported abstention ${(providerAutomatic.unsupported.abstentionRate * 100).toFixed(1)}% (${providerAutomatic.unsupported.cases} informational cases)`,
    `context ${e.contextBytes.total} B  search p50/p95 ${e.searchLatencyMs.p50.toFixed(3)}/${e.searchLatencyMs.p95.toFixed(3)} ms`,
    `index ${e.indexingLatencyMs.total.toFixed(3)} ms  storage ${e.storageBytes} B  embeddings ${e.embeddings.calls} calls/${e.embeddings.texts} texts, ${e.embeddings.inputTokens} tokens, $${e.embeddings.costUsd.toFixed(6)}`,
    `LLM ${e.llm.calls} calls, ${e.llm.inputTokens + e.llm.outputTokens} tokens, $${e.llm.costUsd.toFixed(6)}  queue drain ${e.queueDrainMs.toFixed(3)} ms`,
    ...cleanupLines,
    `gate ${report.gates.passed ? "PASS" : "FAIL"}`,
  ].join("\n") + "\n";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runMemoryBenchmark(options);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    if (options.gate && !report.gates.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`memory benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
