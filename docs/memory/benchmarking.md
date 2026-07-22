---
title: "Memory quality benchmark"
description: "Run and interpret mono-agent's disposable memory retrieval, capture-efficiency, graph-recall, and optional real-provider benchmark suites."
sidebar:
  order: 6
---

The repository includes a non-publishable, disposable memory benchmark. Its default suite is deterministic and offline: it creates a temporary SQLite store, uses a deterministic semantic embedding, reports quality and efficiency, then deletes the store.

```bash
pnpm run benchmark:memory
node scripts/memory-benchmark.mjs --json
```

The fast suite covers direct facts, paraphrases, updates/contradictions, temporal questions, recurring noise, alternating queries, exact duplicates, and entity-hop-shaped retrieval. Automatic injection is intentionally limited to canonical direct facts; broad paraphrases, relations, and entity hops remain available to the explicit `MemoryRecall` tool without being synthesized into background context. Unqualified current/last-message questions also abstain, because their answer belongs to active conversation history rather than durable memory. The unanswerable set separates out-of-domain questions from in-domain **missing-attribute** questions (for example, a person exists in memory but their phone number does not).

Synthetic selector-policy probes run separately from provider retrieval. Positive probes cover explicit property ownership, direct choice, event date/time, and location. Adversarial probes cover coordinated verbs, ditransitives, reported speech, subordinate wrong objects, inverse relations, and unknown values. Their fixed scores are never mixed into provider Recall/MRR, latency, context, or false-recall measurements.

A second, provider-backed calibration proves that the finite automatic-recall contract survives real indexing and retrieval. It uses the configured embedding provider, `upsertMany(..., { batchSize: 32 })`, `db.recall`, and `selectAutomaticRecallHits` in its own disposable store. At least one eligible direct-fact case must be present and 100% of eligible cases must select their relevant record. Unsupported paraphrase and relational cases are reported, but their coverage or abstention is informational and cannot fail the gate. This separation prevents synthetic scores from certifying provider behavior while keeping the broader retrieval suite free to measure cases that belong to the explicit `MemoryRecall` tool. The gate is:

- Recall@5 at least 90%
- MRR at least 0.8
- at least six canonical direct-fact probes are present, and at least 90% receive the relevant automatic-recall hit
- at least six ambiguous-binding probes are present, and 100% abstain from automatic injection
- at least 90% of unanswerable cases abstain from automatic injection
- 100% of missing-attribute and out-of-domain cases abstain in the fast suite
- stale recall at most 5%
- false recall at most 5%
- every policy-calibration probe passes
- at least one provider-backed eligible direct-fact case is present, and 100% receive their relevant automatic-recall hit

The report also includes evaluation-group count, Recall@1/8, nDCG@8, informational overall automatic Recall@5/answer coverage, direct-fact automatic coverage, ambiguous-binding abstention, both unanswerable abstention classes, context bytes, indexing/search latency, storage bytes, embedding calls/texts/input tokens/cost, LLM calls/tokens/cost, duplicate ratio, and vector coverage. Search latency uses the same bounded 50-hit backend superset as the shared app retrieval service, then measures automatic recall from its score-and-direct-fact-gated five-hit slice. Indexing is one `upsertMany` call per group with a batch size of 32; the compatibility field `efficiency.queueDrainMs` now reports aggregate group-local batch-write wall time rather than a serial per-record queue. The dataset's `efficiency` counters exclude the provider-backed and fixed memory-cleanup calibrations, which expose their own accounting under `calibrations`. The direct-fact and ambiguous-binding gates prevent either "inject nothing" or "inject adjacent topic matches" from passing on good raw search ordering alone; overall answer coverage is intentionally not a gate because unsupported or relational answers belong to `MemoryRecall`. Zero LLM cost in the fast suite is literal: the suite never invokes a chat model.

The additive `calibrations.providerAutomaticRecall` JSON object pins the provider-backed contract and its accounting:

- `eligibleDirectFact.cases` and `eligibleDirectFact.coverage` are gated at nonzero and 100%, respectively.
- `unsupported.cases` and `unsupported.abstentionRate` are informational.
- `efficiency` contains calibration-only indexing/search latency, storage, embedding, and zero-LLM counters.
- `store` contains calibration-only record, duplicate, and vector-coverage accounting.

## Memory-cleanup calibration

The fast gate also runs two fixed, provider-independent calibrations in separate disposable stores. Their counters never mix with the provider retrieval metrics above:

- **Capture efficiency and fidelity:** a checked-in, provenance-pinned legacy baseline must contain at least four LLM calls, four candidates, and two reconcile-required cases. The current pipeline must use at most two calls—exactly one `capture:extract` plus, when required, one `capture:reconcile-batch`—for at least a 50% call reduction while preserving action/entity/relation parity and 100% precision/recall for exact memory/entity associations.
- **One-hop graph retrieval:** at least ten multi-hop and ten direct cases compare the same 50-hit direct retrieval with graph expansion off/on. Multi-hop Recall@5 must improve by at least 10 percentage points; direct Recall@5 must remain at least 90%; direct and overall regression may not exceed 2 points. Adversarial cases require zero leaks, required misses, duplicate additions, and orphan associations. The calibration also proves one embedding request per query and zero chat-LLM calls during recall.

This calibration answers two bounded feasibility questions: whether the richer BuJo capture can reduce model work without losing the fixture's semantics, and whether a deterministic one-hop graph adds measurable retrieval value without degrading ordinary results. It does **not** claim that the synthetic percentages transfer to every personal corpus or provider. Use the opt-in real-provider and external-dataset runs below for broader evidence, and keep production source/accounting checks in `mono-agent memory audit --json`.

Real providers and larger external suites are explicit opt-ins and are not part of normal CI:

```bash
# Real local embeddings; uses MONO_AGENT_MEMORY_EMBEDDINGS_* overrides when set
node scripts/memory-benchmark.mjs --provider ollama --json

# Download the upstream data separately, then point the adapter at that file
node scripts/memory-benchmark.mjs --suite longmemeval --dataset /path/to/longmemeval.json --provider ollama --json
node scripts/memory-benchmark.mjs --suite locomo --dataset /path/to/locomo.json --provider ollama --json
```

The optional adapters target the upstream [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [LoCoMo](https://github.com/snap-research/locomo) datasets. Every LongMemEval row and every LoCoMo conversation is an independent evaluation group with its own disposable database/index; records from unrelated examples are never searchable together. Recall, MRR, nDCG, automatic metrics, and query latency are then aggregated case-by-case across groups. Storage is summed, indexing latency is aggregated across group batches, and duplicate/vector audit ratios are computed from summed group-local counts. This avoids cross-example retrieval leakage while preserving case-weighted quality metrics.

LongMemEval abstention is recognized only from a `question_id` ending in `_abs`; answer-session ids that cannot map to the supplied haystack are rejected. LoCoMo rows with ordinary missing evidence are left unevaluated, while numeric category `5` is deliberately treated as the adversarial/unanswerable class for the retrieval abstention metric. That category-5 treatment differs from standard LoCoMo QA reporting, which commonly excludes those rows. The adapters never download data or contact a provider unless the operator supplies the dataset/provider flags.

Do not point this benchmark at an agent's configured memory path. It intentionally owns and removes only the temporary store it creates.
