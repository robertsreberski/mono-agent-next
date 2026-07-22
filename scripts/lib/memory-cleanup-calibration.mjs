import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  appendGraphBatch,
  appendBullet,
  captureTurn,
  createBujoMemoryStore,
  dailyFilePath,
  readGraph,
} from "../../packages/memory/dist/bujo/index.js";
import { assertCanonicalGraphRepairBaseParity } from "../../packages/memory/dist/bujo/rebuild.js";
import {
  prepareAndPublishReplayProjectionDelta,
  replayProjectionAuthorityId,
} from "../../packages/memory/dist/bujo/replay-projection.js";
import { openMemoryDb } from "../../packages/memory/dist/store/index.js";

const FIXED_NOW = new Date("2026-07-11T00:00:00.000Z");
const CAPTURE_FIXTURE_URL = new URL("../fixtures/memory-capture-mixed.json", import.meta.url);
const CAPTURE_BASELINE_URL = new URL("../fixtures/memory-capture-mixed.baseline.json", import.meta.url);
const GRAPH_CODES = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
];
const GRAPH_DIM = GRAPH_CODES.length * 2 + 1;
const GRAPH_NUISANCE_DIM = GRAPH_DIM - 1;

export const MEMORY_CLEANUP_BENCHMARK_GATES = Object.freeze({
  capture: Object.freeze({
    baselineSchema: 2,
    minimumBaselineCalls: 4,
    minimumCandidates: 4,
    minimumReconcileRequired: 2,
    maximumCandidateCalls: 2,
    minimumCallReduction: 0.5,
    associationPrecision: 1,
    associationRecall: 1,
  }),
  graph: Object.freeze({
    minimumMultiHopCases: 10,
    minimumDirectCases: 10,
    minimumAdversarialCases: 8,
    minimumMultiHopLift: 0.1,
    minimumDirectRecallAt5: 0.9,
    maximumOverallRegression: 0.02,
    maximumDirectRegression: 0.02,
    maximumLeakCount: 0,
    maximumRequiredMisses: 0,
    maximumDuplicateAdditions: 0,
    maximumOrphanedAssociations: 0,
  }),
});

export async function runMemoryCleanupBenchmark() {
  const capture = await runCaptureCalibration();
  const graph = await runGraphCalibration();
  const passed = gatesPassed(capture.gates) && gatesPassed(graph.gates);
  return {
    schema: 1,
    benchmark: "memory-cleanup",
    disposableStores: true,
    deterministicProviders: true,
    capture,
    graph,
    passed,
  };
}

async function runCaptureCalibration() {
  const fixtureBytes = await readFile(CAPTURE_FIXTURE_URL);
  const baselineBytes = await readFile(CAPTURE_BASELINE_URL);
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  const fixtureSha256 = sha256(fixtureBytes);
  const root = await mkdtemp(join(tmpdir(), "mono-agent-memory-cleanup-capture-"));
  const labels = [];
  const embeddingMetrics = { calls: 0, texts: 0 };
  const embeddings = {
    id: "fixture:capture-v1",
    async embed(texts) {
      embeddingMetrics.calls += 1;
      embeddingMetrics.texts += texts.length;
      return texts.map((text) => /hiking trip/iu.test(text) ? [0, 1] : [1, 0]);
    },
  };
  const llm = {
    id: "fixture:capture-llm-v1",
    async complete(_prompt, options = {}) {
      const label = options.label ?? "unlabeled";
      labels.push(label);
      if (label === "capture:extract") {
        return JSON.stringify({
          memories: fixture.candidates.map(({ decision: _decision, ...candidate }) => candidate),
          entities: fixture.entities,
          relations: fixture.relations,
        });
      }
      if (label === "capture:reconcile-batch") {
        return JSON.stringify(fixture.candidates.flatMap((candidate, index) => (
          candidate.decision.action === "add" ? [] : [{ index, ...candidate.decision }]
        )));
      }
      throw new Error(`unexpected capture label ${String(label)}`);
    },
  };
  const db = openMemoryDb({
    path: join(root, "memory.db"),
    embeddings,
    dim: 2,
    clock: () => FIXED_NOW,
  });
  try {
    for (const seed of fixture.seeds) {
      const bullet = {
        id: seed.id,
        type: "note",
        status: "open",
        text: seed.text,
        salience: 0.5,
        isInsight: false,
        createdAt: FIXED_NOW.toISOString(),
        refs: [],
      };
      appendBullet(root, bullet, FIXED_NOW);
      await db.upsert({
        ...bullet,
        accessCount: 0,
        tags: [],
        source: { file: relative(root, dailyFilePath(root, FIXED_NOW)) },
      });
    }

    let sequence = 0;
    const result = await captureTurn(fixture.turnText, {
      db,
      root,
      llm,
      nextId: () => `new-${++sequence}`,
      now: () => FIXED_NOW,
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
    const graph = readGraph(root);
    const actualAssociations = graph.associations
      .map(({ memoryId, entityId, provenance }) => ({ memoryId, entityId, provenance }))
      .sort(compareAssociation);
    const expectedAssociations = [
      { memoryId: "seed-deploy", entityId: "person:morgan", provenance: "capture" },
      { memoryId: "seed-release", entityId: "project:release-train", provenance: "capture" },
      { memoryId: "new-1", entityId: "project:atlas", provenance: "capture" },
      { memoryId: "new-2", entityId: "person:casey", provenance: "capture" },
    ].sort(compareAssociation);
    const actualAssociationKeys = new Set(actualAssociations.map(associationKey));
    const expectedAssociationKeys = new Set(expectedAssociations.map(associationKey));
    const matchedAssociations = [...expectedAssociationKeys]
      .filter((key) => actualAssociationKeys.has(key)).length;
    const associationPrecision = actualAssociationKeys.size === 0
      ? 0
      : matchedAssociations / actualAssociationKeys.size;
    const associationRecall = expectedAssociationKeys.size === 0
      ? 1
      : matchedAssociations / expectedAssociationKeys.size;
    const callReduction = baseline.calls === 0 ? 0 : (baseline.calls - labels.length) / baseline.calls;
    const expectedLabels = ["capture:extract", "capture:reconcile-batch"];
    const baselineProvenanceComplete = (
      typeof baseline.expectedHead === "string"
      && baseline.expectedHead.length === 40
      && baseline.observedHead === baseline.expectedHead
      && baseline.trackedClean === true
      && baseline.legacyCaptureDistVerified === true
      && typeof baseline.probeSha256 === "string"
      && Object.keys(baseline.distSha256 ?? {}).length >= 5
    );

    const metrics = {
      baseline: {
        schema: baseline.schema,
        exactHead: baseline.expectedHead,
        provenanceComplete: baselineProvenanceComplete,
        fixtureSha256: baseline.fixtureSha256,
        calls: baseline.calls,
        candidates: baseline.candidates,
        reconcileRequired: baseline.reconcileRequired,
      },
      candidate: {
        fixtureSha256,
        calls: labels.length,
        labels,
        callReduction,
        actions: result.actions,
        entities: result.entities,
        relations: result.relations,
        associations: result.associations,
        associationPrecision,
        associationRecall,
        expectedAssociations,
        actualAssociations,
        embeddings: embeddingMetrics,
      },
    };
    const gates = {
      baselineSchema: equalityGate(baseline.schema, MEMORY_CLEANUP_BENCHMARK_GATES.capture.baselineSchema),
      baselineProvenance: equalityGate(baselineProvenanceComplete, true),
      fixtureIntegrity: equalityGate(fixtureSha256, baseline.fixtureSha256),
      baselineCallsNonVacuous: minimumGate(
        baseline.calls,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.minimumBaselineCalls,
      ),
      candidateCountNonVacuous: minimumGate(
        baseline.candidates,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.minimumCandidates,
      ),
      reconcileCountNonVacuous: minimumGate(
        baseline.reconcileRequired,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.minimumReconcileRequired,
      ),
      candidateCallCeiling: maximumGate(
        labels.length,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.maximumCandidateCalls,
      ),
      exactBatchedLabels: equalityGate(labels, expectedLabels),
      callReduction: minimumGate(
        callReduction,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.minimumCallReduction,
      ),
      actionParity: equalityGate(result.actions, baseline.actions),
      entityCountParity: equalityGate(result.entities, baseline.entities),
      relationCountParity: equalityGate(result.relations, baseline.relations),
      associationPrecision: minimumGate(
        associationPrecision,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.associationPrecision,
      ),
      associationRecall: minimumGate(
        associationRecall,
        MEMORY_CLEANUP_BENCHMARK_GATES.capture.associationRecall,
      ),
      exactAssociations: equalityGate(actualAssociations, expectedAssociations),
    };
    return { metrics, gates, passed: gatesPassed(gates) };
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runGraphCalibration() {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-memory-cleanup-graph-"));
  const embeddingMetrics = { calls: 0, texts: 0 };
  const llmMetrics = { calls: 0 };
  const embeddings = graphEmbeddingProvider(embeddingMetrics);
  const db = openMemoryDb({
    path: join(root, "memory.db"),
    embeddings,
    dim: GRAPH_DIM,
    clock: () => FIXED_NOW,
  });
  let store;
  try {
    const fixture = graphFixture();
    for (const item of fixture.records) {
      appendBullet(root, {
        id: item.id,
        type: item.type,
        status: item.status,
        text: item.text,
        salience: item.salience,
        isInsight: item.isInsight,
        createdAt: item.createdAt,
        refs: [],
      }, new Date(item.createdAt));
    }
    appendGraphBatch(root, fixture.graph);
    await db.upsertMany(fixture.records, { batchSize: 32 });
    seedGraph(db, fixture.graph);
    prepareAndPublishReplayProjectionDelta(root, {
      terminals: [{
        id: "adv-stale-target",
        at: "2026-07-10T00:00:00.000Z",
        authorityKind: "migration",
        authorityId: replayProjectionAuthorityId({
          benchmark: "memory-cleanup",
          terminal: "adv-stale-target",
        }),
      }],
    });
    const auditBefore = db.audit();
    const indexingEmbeddingCalls = embeddingMetrics.calls;
    db.close();

    store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings,
      dim: GRAPH_DIM,
      clock: () => FIXED_NOW,
      llm: {
        id: "fixture:unused",
        async complete() {
          llmMetrics.calls += 1;
          throw new Error("graph calibration must not call an LLM");
        },
      },
    });

    const multiHopResults = [];
    const directResults = [];
    for (const item of fixture.multiHopCases) {
      const raw = await store.recall(item.query, { topK: 50, trackAccess: false });
      const baseline = raw.slice(0, 5);
      const enabled = store.expandGraph(item.query, raw, { topK: 5 });
      multiHopResults.push(graphCaseResult(item, raw, baseline, enabled));
    }
    for (const item of fixture.directCases) {
      const raw = await store.recall(item.query, { topK: 50, trackAccess: false });
      const baseline = raw.slice(0, 5);
      const enabled = store.expandGraph(item.query, raw, { topK: 5 });
      directResults.push(graphCaseResult(item, raw, baseline, enabled));
    }
    const queryEmbeddingCalls = embeddingMetrics.calls - indexingEmbeddingCalls;

    const adversarialResults = fixture.adversarialCases.map((item) => {
      const directHits = item.seedIds.map((id, index) => ({
        record: fixture.recordById.get(id),
        score: 1 - index * 0.01,
      }));
      if (directHits.some(({ record }) => record === undefined)) {
        throw new Error(`adversarial fixture ${item.id} refers to an unknown seed`);
      }
      const enabled = store.expandGraph(item.query, directHits, { topK: 8 });
      const ids = enabled.map((hit) => hit.record.id);
      const additions = ids.filter((id) => !item.seedIds.includes(id));
      const leaks = item.forbiddenIds.filter((id) => ids.includes(id));
      const missingRequired = item.requiredIds.filter((id) => !ids.includes(id));
      const duplicateAdditions = additions.length - new Set(additions).size;
      return {
        id: item.id,
        category: item.category,
        leaks,
        missingRequired,
        duplicateAdditions,
        passed: leaks.length === 0 && missingRequired.length === 0 && duplicateAdditions === 0,
      };
    });

    const multiHopBaseline = recallAt5(multiHopResults, "baselineHit");
    const multiHopEnabled = recallAt5(multiHopResults, "enabledHit");
    const directBaseline = recallAt5(directResults, "baselineHit");
    const directEnabled = recallAt5(directResults, "enabledHit");
    const allResults = [...multiHopResults, ...directResults];
    const overallBaseline = recallAt5(allResults, "baselineHit");
    const overallEnabled = recallAt5(allResults, "enabledHit");
    const multiHopLift = multiHopEnabled - multiHopBaseline;
    const directDelta = directEnabled - directBaseline;
    const overallDelta = overallEnabled - overallBaseline;
    const targetsBelowTop5 = multiHopResults.filter((item) => item.rawRank > 5 && item.rawRank <= 50).length;
    const leakCount = adversarialResults.reduce((sum, item) => sum + item.leaks.length, 0);
    const missingRequiredCount = adversarialResults.reduce((sum, item) => sum + item.missingRequired.length, 0);
    const duplicateAdditions = adversarialResults.reduce((sum, item) => sum + item.duplicateAdditions, 0);
    const multiHopMultiplicityFailures = multiHopResults.filter((item) => item.enabledMultiplicity !== 1).length;
    const categories = [...new Set(adversarialResults.map((item) => item.category))].sort();
    const requiredCategories = [...new Set(fixture.adversarialCases.map((item) => item.category))].sort();
    const metrics = {
      multiHop: {
        cases: multiHopResults.length,
        baselineRecallAt5: multiHopBaseline,
        enabledRecallAt5: multiHopEnabled,
        lift: multiHopLift,
        targetsBelowTop5,
        results: multiHopResults,
      },
      direct: {
        cases: directResults.length,
        baselineRecallAt5: directBaseline,
        enabledRecallAt5: directEnabled,
        delta: directDelta,
        results: directResults,
      },
      overall: {
        cases: allResults.length,
        baselineRecallAt5: overallBaseline,
        enabledRecallAt5: overallEnabled,
        delta: overallDelta,
      },
      adversarial: {
        cases: adversarialResults.length,
        categories,
        leakCount,
        missingRequiredCount,
        duplicateAdditions,
        results: adversarialResults,
      },
      efficiency: {
        indexingEmbeddingCalls,
        queryEmbeddingCalls,
        expectedQueryEmbeddingCalls: allResults.length,
        llmCalls: llmMetrics.calls,
      },
      store: {
        records: fixture.records.length,
        entityRelations: auditBefore.counts.entityRelations,
        memoryEntityAssociations: auditBefore.counts.memoryEntityAssociations,
        orphanedAssociations: auditBefore.counts.orphanedAssociations,
      },
    };
    const gates = {
      multiHopCaseCount: minimumGate(
        multiHopResults.length,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.minimumMultiHopCases,
      ),
      directCaseCount: minimumGate(
        directResults.length,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.minimumDirectCases,
      ),
      adversarialCaseCount: minimumGate(
        adversarialResults.length,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.minimumAdversarialCases,
      ),
      rawTargetRankNonVacuity: equalityGate(targetsBelowTop5, multiHopResults.length),
      multiHopLift: minimumGate(
        multiHopLift,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.minimumMultiHopLift,
      ),
      directBaselineRecall: minimumGate(
        directBaseline,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.minimumDirectRecallAt5,
      ),
      overallRegression: minimumGate(
        overallDelta,
        -MEMORY_CLEANUP_BENCHMARK_GATES.graph.maximumOverallRegression,
      ),
      directRegression: minimumGate(
        directDelta,
        -MEMORY_CLEANUP_BENCHMARK_GATES.graph.maximumDirectRegression,
      ),
      adversarialLeaks: maximumGate(
        leakCount,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.maximumLeakCount,
      ),
      adversarialControlMisses: maximumGate(
        missingRequiredCount,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.maximumRequiredMisses,
      ),
      multiHopMultiplicity: maximumGate(multiHopMultiplicityFailures, 0),
      duplicateAdditions: maximumGate(
        duplicateAdditions,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.maximumDuplicateAdditions,
      ),
      adversarialCategories: equalityGate(categories, requiredCategories),
      orphanedAssociations: maximumGate(
        auditBefore.counts.orphanedAssociations,
        MEMORY_CLEANUP_BENCHMARK_GATES.graph.maximumOrphanedAssociations,
      ),
      oneEmbeddingPerQuery: equalityGate(queryEmbeddingCalls, allResults.length),
      noLlmCalls: equalityGate(llmMetrics.calls, 0),
    };
    return { metrics, gates, passed: gatesPassed(gates) };
  } finally {
    if (store !== undefined) {
      await store.close();
    } else {
      try { db.close(); } catch { /* already closed */ }
    }
    await rm(root, { recursive: true, force: true });
  }
}

function graphFixture() {
  const records = [];
  const entities = [];
  const relations = [];
  const associations = [];
  const multiHopCases = [];
  const directCases = [];
  const recordById = new Map();

  for (const [index, code] of GRAPH_CODES.entries()) {
    const incoming = index >= GRAPH_CODES.length / 2;
    const marker = `SemanticProbe${code}`;
    const seedName = incoming ? `Worker${code}` : `Anchor${code}`;
    const targetName = incoming ? `Manager${code}` : `Target${code}`;
    const seedEntityId = `person:${seedName.toLowerCase()}`;
    const targetEntityId = `person:${targetName.toLowerCase()}`;
    const seedId = `multi-${String(index).padStart(2, "0")}-00-seed`;
    const targetId = `multi-${String(index).padStart(2, "0")}-90-target`;
    addRecord(record(`${seedId}`, `${marker}: ${seedName} anchors the durable graph calibration.`));
    for (let noise = 0; noise < 5; noise += 1) {
      const signal = noise < 2 ? "strong-signal" : "low-signal";
      addRecord(record(
        `multi-${String(index).padStart(2, "0")}-${String(noise + 10).padStart(2, "0")}-noise`,
        `${marker} ${signal} distractor ${noise} contains unrelated calibration chatter.`,
      ));
    }
    addRecord(record(targetId, `${targetName} uses Value${code}.`));
    entities.push(entity(seedEntityId, seedName), entity(targetEntityId, targetName));
    relations.push(incoming
      ? relation(targetEntityId, seedEntityId, "manages")
      : relation(seedEntityId, targetEntityId, "mentors"));
    associations.push(association(seedId, seedEntityId), association(targetId, targetEntityId));
    multiHopCases.push({
      id: `multi-hop-${code.toLowerCase()}`,
      query: incoming
        ? `${marker}: Which person manages ${seedName}, and what do they use?`
        : `${marker}: ${seedName} mentors which person, and what does that person use?`,
      targetId,
    });
    directCases.push({
      id: `direct-${code.toLowerCase()}`,
      query: `What does ${targetName} use?`,
      targetId,
    });
  }

  const adversarialCases = [];
  addAdversarialCase({
    id: "missing-relation",
    category: "missing-relation",
    query: "MissingAnchor mentors which person?",
    seed: ["adv-missing-seed", "MissingAnchor", "entity:missing-anchor"],
    targets: [["adv-missing-target", "MissingTarget", "entity:missing-target", "open"]],
    forbiddenIds: ["adv-missing-target"],
  });
  addAdversarialCase({
    id: "invalid-target",
    category: "invalid-target",
    query: "InvalidAnchor mentors which person?",
    seed: ["adv-invalid-seed", "InvalidAnchor", "entity:invalid-anchor"],
    targets: [["adv-invalid-target", "InvalidTarget", "entity:invalid-target", "invalidated"]],
    relations: [["entity:invalid-anchor", "entity:invalid-target", "mentors"]],
    forbiddenIds: ["adv-invalid-target"],
  });
  addAdversarialCase({
    id: "stale-target",
    category: "stale-target",
    query: "StaleAnchor mentors which person?",
    seed: ["adv-stale-seed", "StaleAnchor", "entity:stale-anchor"],
    targets: [["adv-stale-target", "StaleTarget", "entity:stale-target", "stale"]],
    relations: [["entity:stale-anchor", "entity:stale-target", "mentors"]],
    forbiddenIds: ["adv-stale-target"],
  });
  addAdversarialCase({
    id: "two-relations-away",
    category: "two-relations-away",
    query: "HopAnchor mentors which person, and what does that person use?",
    seed: ["adv-hop-seed", "HopAnchor", "entity:hop-anchor"],
    entities: [["entity:hop-middle", "HopMiddle"]],
    targets: [["adv-hop-target", "HopFar", "entity:hop-far", "open"]],
    relations: [
      ["entity:hop-anchor", "entity:hop-middle", "mentors"],
      ["entity:hop-middle", "entity:hop-far", "mentors"],
    ],
    forbiddenIds: ["adv-hop-target"],
  });
  addAdversarialCase({
    id: "self-loop",
    category: "self-loop",
    query: "LoopAnchor mentors which person?",
    seed: ["adv-loop-seed", "LoopAnchor", "entity:loop-anchor"],
    targets: [["adv-loop-target", "LoopTarget", "entity:loop-anchor", "open"]],
    relations: [["entity:loop-anchor", "entity:loop-anchor", "mentors"]],
    forbiddenIds: ["adv-loop-target"],
  });
  addAdversarialCase({
    id: "inverse-direction",
    category: "inverse-direction",
    query: "Who manages InverseAnchor?",
    seed: ["adv-inverse-seed", "InverseAnchor", "entity:inverse-anchor"],
    targets: [["adv-inverse-target", "InverseTarget", "entity:inverse-target", "open"]],
    relations: [["entity:inverse-anchor", "entity:inverse-target", "manages"]],
    forbiddenIds: ["adv-inverse-target"],
  });
  addAdversarialCase({
    id: "negated-query",
    category: "negated-query",
    query: "NegatedAnchor does not mentor which person?",
    seed: ["adv-negated-query-seed", "NegatedAnchor", "entity:negated-anchor"],
    targets: [["adv-negated-query-target", "NegatedTarget", "entity:negated-target", "open"]],
    relations: [["entity:negated-anchor", "entity:negated-target", "mentors"]],
    forbiddenIds: ["adv-negated-query-target"],
  });
  addAdversarialCase({
    id: "stored-negated-relation",
    category: "stored-negated-relation",
    query: "StoredNegativeAnchor mentors which person?",
    seed: ["adv-stored-negative-seed", "StoredNegativeAnchor", "entity:stored-negative-anchor"],
    targets: [["adv-stored-negative-target", "StoredNegativeTarget", "entity:stored-negative-target", "open"]],
    relations: [["entity:stored-negative-anchor", "entity:stored-negative-target", "does not mentor"]],
    forbiddenIds: ["adv-stored-negative-target"],
  });
  addAdversarialCase({
    id: "stored-historical-relation",
    category: "stored-qualified-relation",
    query: "HistoricalAnchor mentors which person?",
    seed: ["adv-historical-seed", "HistoricalAnchor", "entity:historical-anchor"],
    targets: [["adv-historical-target", "HistoricalTarget", "entity:historical-target", "open"]],
    relations: [["entity:historical-anchor", "entity:historical-target", "formerly mentored"]],
    forbiddenIds: ["adv-historical-target"],
  });
  addAdversarialCase({
    id: "stored-modal-relation",
    category: "stored-qualified-relation",
    query: "ModalAnchor mentors which person?",
    seed: ["adv-modal-seed", "ModalAnchor", "entity:modal-anchor"],
    targets: [["adv-modal-target", "ModalTarget", "entity:modal-target", "open"]],
    relations: [["entity:modal-anchor", "entity:modal-target", "might mentor"]],
    forbiddenIds: ["adv-modal-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint",
    category: "wrong-endpoint",
    query: "Does EndpointMorgan lead Project EndpointApollo?",
    seed: ["adv-endpoint-seed", "EndpointMorgan", "person:endpoint-morgan"],
    targets: [["adv-endpoint-target", "Project EndpointAtlas", "project:endpoint-atlas", "open"]],
    relations: [["person:endpoint-morgan", "project:endpoint-atlas", "leads"]],
    forbiddenIds: ["adv-endpoint-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint-city",
    category: "wrong-endpoint",
    query: "Does EndpointCityMorgan lead Amsterdam?",
    seed: ["adv-endpoint-city-seed", "EndpointCityMorgan", "person:endpoint-city-morgan"],
    targets: [["adv-endpoint-city-target", "Project EndpointCityAtlas", "project:endpoint-city-atlas", "open"]],
    relations: [["person:endpoint-city-morgan", "project:endpoint-city-atlas", "leads"]],
    forbiddenIds: ["adv-endpoint-city-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint-lowercase",
    category: "wrong-endpoint",
    query: "Does EndpointGardenMorgan lead the garden club?",
    seed: ["adv-endpoint-garden-seed", "EndpointGardenMorgan", "person:endpoint-garden-morgan"],
    targets: [["adv-endpoint-garden-target", "Project EndpointGardenAtlas", "project:endpoint-garden-atlas", "open"]],
    relations: [["person:endpoint-garden-morgan", "project:endpoint-garden-atlas", "leads"]],
    forbiddenIds: ["adv-endpoint-garden-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint-possessive-unknown",
    category: "wrong-endpoint",
    query: "Where is PossessiveMorgan's manager Unknown based?",
    seed: ["adv-endpoint-possessive-seed", "PossessiveMorgan", "person:endpoint-possessive-morgan"],
    targets: [["adv-endpoint-possessive-target", "PossessiveManager", "person:endpoint-possessive-manager", "open"]],
    relations: [["person:endpoint-possessive-manager", "person:endpoint-possessive-morgan", "manages"]],
    forbiddenIds: ["adv-endpoint-possessive-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint-possessive-lowercase",
    category: "wrong-endpoint",
    query: "Where is PossessiveGardenMorgan's manager the garden club based?",
    seed: ["adv-endpoint-possessive-garden-seed", "PossessiveGardenMorgan", "person:endpoint-possessive-garden-morgan"],
    targets: [["adv-endpoint-possessive-garden-target", "PossessiveGardenManager", "person:endpoint-possessive-garden-manager", "open"]],
    relations: [["person:endpoint-possessive-garden-manager", "person:endpoint-possessive-garden-morgan", "manages"]],
    forbiddenIds: ["adv-endpoint-possessive-garden-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint-possessive-subject-unknown",
    category: "wrong-endpoint",
    query: "Is Unknown PossessiveSubjectMorgan's manager?",
    seed: ["adv-endpoint-possessive-subject-seed", "PossessiveSubjectMorgan", "person:endpoint-possessive-subject-morgan"],
    targets: [["adv-endpoint-possessive-subject-target", "PossessiveSubjectManager", "person:endpoint-possessive-subject-manager", "open"]],
    relations: [["person:endpoint-possessive-subject-manager", "person:endpoint-possessive-subject-morgan", "manages"]],
    forbiddenIds: ["adv-endpoint-possessive-subject-target"],
  });
  addAdversarialCase({
    id: "wrong-endpoint-possessive-subject-lowercase",
    category: "wrong-endpoint",
    query: "Is the garden club PossessiveSubjectGardenMorgan's manager?",
    seed: ["adv-endpoint-possessive-subject-garden-seed", "PossessiveSubjectGardenMorgan", "person:endpoint-possessive-subject-garden-morgan"],
    targets: [["adv-endpoint-possessive-subject-garden-target", "PossessiveSubjectGardenManager", "person:endpoint-possessive-subject-garden-manager", "open"]],
    relations: [["person:endpoint-possessive-subject-garden-manager", "person:endpoint-possessive-subject-garden-morgan", "manages"]],
    forbiddenIds: ["adv-endpoint-possessive-subject-garden-target"],
  });
  for (const [kind, stored, queried] of [
    ["works", "works with", "works for"],
    ["reports", "reports about", "reports to"],
    ["talks", "talks about", "talks to"],
  ]) {
    addAdversarialCase({
      id: `relation-particle-${kind}`,
      category: "relation-particle-collision",
      query: `Who ${queried} ParticleAcme${kind}?`,
      seed: [`adv-particle-${kind}-seed`, `ParticleAcme${kind}`, `org:particle-acme-${kind}`],
      targets: [[`adv-particle-${kind}-target`, `ParticleActor${kind}`, `person:particle-actor-${kind}`, "open"]],
      relations: [[`person:particle-actor-${kind}`, `org:particle-acme-${kind}`, stored]],
      forbiddenIds: [`adv-particle-${kind}-target`],
    });
  }
  addAdversarialCase({
    id: "relation-particle-control",
    category: "relation-particle-control",
    query: "Who works with ParticleAcmeControl?",
    seed: ["adv-particle-control-seed", "ParticleAcmeControl", "org:particle-acme-control"],
    targets: [["adv-particle-control-target", "ParticleActorControl", "person:particle-actor-control", "open"]],
    relations: [["person:particle-actor-control", "org:particle-acme-control", "works with"]],
    requiredIds: ["adv-particle-control-target"],
  });
  addAdversarialCase({
    id: "wrong-relation",
    category: "wrong-relation",
    query: "RelationAnchor mentors which person?",
    seed: ["adv-relation-seed", "RelationAnchor", "entity:relation-anchor"],
    targets: [
      ["adv-relation-wrong", "WrongPeer", "entity:wrong-peer", "open"],
      ["adv-relation-right", "RightPeer", "entity:right-peer", "open"],
    ],
    relations: [
      ["entity:relation-anchor", "entity:wrong-peer", "collaborates"],
      ["entity:relation-anchor", "entity:right-peer", "mentors"],
    ],
    forbiddenIds: ["adv-relation-wrong"],
    requiredIds: ["adv-relation-right"],
  });
  addAdversarialCase({
    id: "bidirectional-cycle",
    category: "bidirectional-cycle",
    query: "CycleAnchor mentors which person?",
    seed: ["adv-cycle-seed", "CycleAnchor", "entity:cycle-anchor"],
    targets: [["adv-cycle-target", "CycleTarget", "entity:cycle-target", "open"]],
    relations: [
      ["entity:cycle-anchor", "entity:cycle-target", "mentors"],
      ["entity:cycle-target", "entity:cycle-anchor", "mentors"],
    ],
    requiredIds: ["adv-cycle-target"],
  });
  addAdversarialCase({
    id: "precise-association",
    category: "precise-association",
    query: "MorganPrecision prefers which color?",
    seed: ["adv-precision-seed", "MorganPrecision", "person:morgan-precision"],
    targets: [["adv-precision-phone", "CaseyPrecision", "person:casey-precision", "open"]],
    forbiddenIds: ["adv-precision-phone"],
  });
  addAdversarialCase({
    id: "one-relation-control",
    category: "one-relation-control",
    query: "ControlAnchor mentors which person?",
    seed: ["adv-control-seed", "ControlAnchor", "entity:control-anchor"],
    targets: [["adv-control-target", "ControlTarget", "entity:control-target", "open"]],
    relations: [["entity:control-anchor", "entity:control-target", "mentors"]],
    requiredIds: ["adv-control-target"],
  });

  return {
    records,
    recordById,
    graph: { entities, relations, associations },
    multiHopCases,
    directCases,
    adversarialCases,
  };

  function addRecord(item) {
    if (recordById.has(item.id)) throw new Error(`duplicate graph fixture record ${item.id}`);
    records.push(item);
    recordById.set(item.id, item);
  }

  function addAdversarialCase(spec) {
    const [seedId, seedName, seedEntityId] = spec.seed;
    addRecord(record(seedId, `${seedName} anchors an adversarial graph case.`));
    entities.push(entity(seedEntityId, seedName));
    associations.push(association(seedId, seedEntityId));
    for (const [entityId, name] of spec.entities ?? []) entities.push(entity(entityId, name));
    for (const [targetId, targetName, targetEntityId, targetState] of spec.targets ?? []) {
      const overrides = targetState === "invalidated"
        ? { status: "invalidated" }
        : targetState === "stale"
          ? {
              status: "dropped",
              createdAt: "2026-07-09T00:00:00.000Z",
              validTo: "2026-07-10T00:00:00.000Z",
              source: { file: "daily/2026-07-09.md" },
            }
          : {};
      addRecord(record(targetId, `${targetName} contains forbidden or required graph evidence.`, overrides));
      entities.push(entity(targetEntityId, targetName));
      associations.push(association(targetId, targetEntityId));
    }
    for (const [src, dst, label] of spec.relations ?? []) relations.push(relation(src, dst, label));
    adversarialCases.push({
      id: spec.id,
      category: spec.category,
      query: spec.query,
      seedIds: [seedId],
      forbiddenIds: spec.forbiddenIds ?? [],
      requiredIds: spec.requiredIds ?? [],
    });
  }
}

function seedGraph(db, graph) {
  for (const item of graph.entities) db.upsertEntity(item);
  for (const item of graph.relations) db.addEntityRelation(item.src, item.dst, item.relation);
  for (const item of graph.associations) db.associateMemory(item);
}

function graphEmbeddingProvider(metrics) {
  const normalizedCodes = GRAPH_CODES.map((code) => code.toLowerCase());
  return {
    id: "fixture:graph-v1",
    async embed(texts) {
      metrics.calls += 1;
      metrics.texts += texts.length;
      return texts.map((raw) => {
        const text = raw.toLowerCase();
        const markerIndex = normalizedCodes.findIndex((code) => text.includes(`semanticprobe${code}`));
        const targetIndex = normalizedCodes.findIndex((code, index) => {
          const name = index >= GRAPH_CODES.length / 2 ? `manager${code}` : `target${code}`;
          return text.includes(name);
        });
        if (text.startsWith("search_query:") && markerIndex >= 0) {
          return vector([[markerIndex, 1], [GRAPH_CODES.length + markerIndex, 0.55]]);
        }
        if (text.startsWith("search_query:") && targetIndex >= 0) {
          return vector([[GRAPH_CODES.length + targetIndex, 1]]);
        }
        if (markerIndex >= 0) {
          return text.includes("low-signal")
            ? vector([[markerIndex, 1], [GRAPH_NUISANCE_DIM, 1]])
            : vector([[markerIndex, 1]]);
        }
        if (targetIndex >= 0) return vector([[GRAPH_CODES.length + targetIndex, 1]]);
        return vector([[GRAPH_NUISANCE_DIM, 1]]);
      });
    },
  };
}

function vector(entries) {
  const output = Array(GRAPH_DIM).fill(0);
  for (const [index, value] of entries) output[index] = value;
  return output;
}

function graphCaseResult(item, raw, baseline, enabled) {
  const rawIds = raw.map((hit) => hit.record.id);
  const baselineIds = baseline.map((hit) => hit.record.id);
  const enabledIds = enabled.map((hit) => hit.record.id);
  return {
    id: item.id,
    targetId: item.targetId,
    rawRank: rawIds.indexOf(item.targetId) + 1,
    baselineHit: baselineIds.includes(item.targetId),
    enabledHit: enabledIds.includes(item.targetId),
    enabledMultiplicity: enabledIds.filter((id) => id === item.targetId).length,
  };
}

function record(id, text, overrides = {}) {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: FIXED_NOW.toISOString(),
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-07-11.md" },
    ...overrides,
  };
}

function entity(id, name) {
  return { id, name, type: "person", createdAt: FIXED_NOW.toISOString() };
}

function relation(src, dst, label) {
  return { src, dst, relation: label, createdAt: FIXED_NOW.toISOString() };
}

function association(memoryId, entityId) {
  return { memoryId, entityId, provenance: "capture", createdAt: FIXED_NOW.toISOString() };
}

function recallAt5(results, field) {
  if (results.length === 0) return 0;
  return results.filter((item) => item[field]).length / results.length;
}

function associationKey(item) {
  return `${item.memoryId}|${item.entityId}|${item.provenance}`;
}

function compareAssociation(left, right) {
  return associationKey(left).localeCompare(associationKey(right));
}

function equalityGate(actual, expected) {
  return { passed: isDeepStrictEqual(actual, expected), actual, operator: "deepEqual", expected };
}

function minimumGate(actual, expected) {
  return { passed: actual >= expected, actual, operator: ">=", expected };
}

function maximumGate(actual, expected) {
  return { passed: actual <= expected, actual, operator: "<=", expected };
}

function gatesPassed(gates) {
  return Object.values(gates).every((gate) => gate.passed === true);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
