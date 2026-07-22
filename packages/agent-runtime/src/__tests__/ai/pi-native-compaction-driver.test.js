import { describe, expect, it, vi } from "vitest";
import { buildSessionContext } from "@earendil-works/pi-agent-core";
import {
  estimateCurrentContextTokens,
  piSummaryReserveTokens,
  resolveLiveCompactionPolicy,
  runProactiveCompaction,
  runReactiveCompaction,
  tryCompact,
} from "../../ai/providers/pi-native/compaction-driver.js";

// A session double whose buildContext / getEntries / (message count) are
// scriptable, so the trigger math is exercised deterministically.
function fakeSession({ entries = [], messages = [] } = {}) {
  return {
    getEntries: async () => entries,
    buildContext: async () => ({ messages }),
  };
}

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "faux",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function reducibleMessages() {
  return [
    userMessage("a".repeat(40_000)),
    userMessage("b".repeat(40_000)),
    userMessage("recent".repeat(4_000)),
  ];
}

function hookHarness({ sourceMessages = reducibleMessages(), summary = "short summary", compactError } = {}) {
  const messages = [...sourceMessages];
  const branchEntries = sourceMessages.map((message, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index === 0 ? null : `e${index}`,
    timestamp: new Date(index + 1).toISOString(),
    message,
  }));
  const session = fakeSession({ entries: branchEntries, messages });
  const handlers = new Set();
  const generationLimits = [];
  let persisted = 0;
  const model = {
    id: "m",
    provider: "faux",
    api: "openai-completions",
    contextWindow: 128_000,
    maxTokens: 64_000,
    reasoning: false,
  };
  const models = {
    completeSimple: vi.fn(async (_model, _context, options) => {
      generationLimits.push(options?.maxTokens);
      return { role: "assistant", content: [{ type: "text", text: summary }], stopReason: "stop" };
    }),
  };
  const harness = {
    models,
    getModel: () => model,
    getThinkingLevel: () => "off",
    waitForIdle: vi.fn(),
    prompt: vi.fn(),
    on: (type, handler) => {
      expect(type).toBe("session_before_compact");
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    compact: vi.fn(async () => {
      if (compactError) throw compactError;
      const handler = [...handlers].at(-1);
      if (!handler) throw new Error("missing compaction hook");
      const hookResult = await handler({
        type: "session_before_compact",
        preparation: {},
        branchEntries,
        signal: new AbortController().signal,
      });
      if (hookResult?.cancel) throw Object.assign(new Error("Compaction cancelled"), { code: "compaction" });
      const result = hookResult?.compaction;
      if (!result) throw new Error("hook did not provide compaction");
      persisted += 1;
      const compactedEntry = {
        type: "compaction",
        id: "compaction-1",
        parentId: branchEntries.at(-1)?.id || null,
        timestamp: new Date().toISOString(),
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        details: result.details,
        fromHook: true,
      };
      messages.splice(0, messages.length, ...buildSessionContext([...branchEntries, compactedEntry]).messages);
      return result;
    }),
  };
  return {
    harness,
    session,
    messages,
    branchEntries,
    generationLimits,
    handlerCount: () => handlers.size,
    persistedCount: () => persisted,
  };
}

function freshRunState(session, { policy } = {}) {
  return {
    session,
    sessionBaselineCount: 0,
    externalAbort: false,
    maxTurnsHit: false,
    compaction: {
      applied: false,
      reactiveAttempted: false,
      compactedThisRun: false,
      policy: policy ?? null,
      diagnostics: {},
    },
  };
}

describe("estimateCurrentContextTokens", () => {
  it("returns unavailable when there is no usage and no transcript", async () => {
    const out = await estimateCurrentContextTokens(fakeSession(), 0);
    expect(out).toEqual({ tokens: 0, source: "unavailable" });
  });

  it("adds the fixed overhead to the raw branch only and picks the larger source", async () => {
    // Two short messages → small raw token estimate; a large fixed overhead
    // pushes the raw branch above the (zero) usage branch.
    const session = fakeSession({ messages: [{ role: "user", content: "hello" }] });
    const out = await estimateCurrentContextTokens(session, 10_000);
    expect(out.source).toBe("estimate");
    expect(out.tokens).toBeGreaterThanOrEqual(10_000);
  });

  it("adds the current user turn to a prior provider-usage estimate without double-counting fixed overhead", async () => {
    const priorAssistant = assistantMessage("done");
    priorAssistant.usage = {
      input: 900,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const session = fakeSession({
      entries: [{ type: "message", id: "e1", parentId: null, message: priorAssistant }],
      messages: [priorAssistant],
    });

    const out = await estimateCurrentContextTokens(session, 500, 250);

    expect(out).toEqual({ tokens: 1_250, source: "usage" });
  });
});

describe("tryCompact", () => {
  it("emits the applied event, fires onCompactionRecorded, and reports applied", async () => {
    const events = [];
    const recorded = [];
    const fixture = hookHarness();
    const res = await tryCompact(fixture.harness, {
      trigger: "proactive",
      onEvent: (e) => events.push(e),
      runtimeWarnings: [],
      onCompactionRecorded: (row) => recorded.push(row),
      runId: "r1",
      model: "pi:faux:m",
      session: fixture.session,
      policy: { keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 0 },
    });
    expect(res).toMatchObject({ applied: true, reduced: true, nothingToCompact: false });
    expect(res.tokensAfter).toBeGreaterThan(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "context_compaction",
      status: "running",
      sdk: "pi",
      trigger: "proactive",
      model: "pi:faux:m",
    });
    expect(events[1]).toMatchObject({
      type: "context_compaction",
      operationId: events[0].operationId,
      status: "succeeded",
      sdk: "pi",
      trigger: "proactive",
      model: "pi:faux:m",
      tokenCountsExact: false,
    });
    expect(recorded[0]).toMatchObject({ trigger: "proactive", provider_kind: "pi", status: "succeeded" });
    expect(fixture.persistedCount()).toBe(1);
    expect(fixture.handlerCount()).toBe(0);
  });

  it("cancels a non-reducing compaction before it is persisted", async () => {
    const warnings = [];
    const events = [];
    const fixture = hookHarness({ sourceMessages: [userMessage("unchanged")] });
    const res = await tryCompact(
      fixture.harness,
      {
        trigger: "reactive_overflow",
        onEvent: (event) => events.push(event),
        runtimeWarnings: warnings,
        session: fixture.session,
        policy: { keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 0 },
      },
    );
    expect(res).toMatchObject({ applied: false, reduced: false });
    expect(warnings).toContainEqual(expect.objectContaining({
      warning_kind: "context_compaction_not_reducible",
      trigger: "reactive_overflow",
    }));
    expect(fixture.persistedCount()).toBe(0);
    expect(fixture.handlerCount()).toBe(0);
    expect(fixture.messages).toHaveLength(1);
    expect(events.map(({ status }) => status)).toEqual(["running", "skipped"]);
    expect(events[1]).toMatchObject({
      operationId: events[0].operationId,
      trigger: "overflow",
      reason: "not_reducible",
      tokenCountsExact: false,
    });
  });

  it("skips a proactive compaction below the configured minimum savings", async () => {
    const warnings = [];
    const fixture = hookHarness();
    const res = await tryCompact(fixture.harness, {
      trigger: "proactive",
      onEvent: () => {},
      runtimeWarnings: warnings,
      session: fixture.session,
      policy: { keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 500_000 },
    });
    expect(res.applied).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({
      warning_kind: "context_compaction_insufficient_savings",
      minimum_savings_tokens: 500_000,
    }));
    expect(fixture.persistedCount()).toBe(0);
    expect(fixture.handlerCount()).toBe(0);
  });

  it("classifies a nothing-to-compact failure as a warning, not a throw", async () => {
    const warnings = [];
    const err = Object.assign(new Error("nothing to compact"), { code: "compaction" });
    const fixture = hookHarness({ compactError: err });
    const res = await tryCompact(fixture.harness, { trigger: "proactive", onEvent: () => {}, runtimeWarnings: warnings });
    expect(res).toEqual({
      applied: false,
      tokensBefore: null,
      tokensAfter: null,
      reduced: null,
      nothingToCompact: true,
    });
    expect(warnings[0].warning_kind).toBe("context_compaction_nothing_to_compact");
  });

  it("maps auth/busy/other error codes to distinct warning kinds", async () => {
    const kinds = [];
    const lifecycles = [];
    for (const [code, kind] of [
      ["auth", "context_compaction_auth_failed"],
      ["busy", "context_compaction_busy"],
      ["other", "context_compaction_failed"],
    ]) {
      const warnings = [];
      const events = [];
      const fixture = hookHarness({ compactError: Object.assign(new Error("x"), { code }) });
      await tryCompact(fixture.harness, {
        trigger: "reactive_overflow",
        onEvent: (event) => events.push(event),
        runtimeWarnings: warnings,
      });
      kinds.push(warnings[0].warning_kind);
      lifecycles.push(events);
    }
    expect(kinds).toEqual([
      "context_compaction_auth_failed",
      "context_compaction_busy",
      "context_compaction_failed",
    ]);
    expect(lifecycles.map((events) => events.map(({ status }) => status))).toEqual([
      ["running", "failed"],
      ["running", "failed"],
      ["running", "failed"],
    ]);
    expect(lifecycles.map((events) => events[1].operationId === events[0].operationId)).toEqual([
      true,
      true,
      true,
    ]);
    expect(lifecycles.map((events) => events[1].reason)).toEqual([
      "authentication",
      "busy",
      "provider_error",
    ]);
  });

  it("maps summaryMaxTokens to Pi generation limits, including split-turn dual summaries", () => {
    const normalReserve = piSummaryReserveTokens(5_000, false);
    expect(Math.floor(normalReserve * 0.8)).toBeLessThanOrEqual(5_000);
    expect(Math.floor((normalReserve + 1) * 0.8)).toBeGreaterThan(5_000);

    const splitReserve = piSummaryReserveTokens(5_000, true);
    const splitBudget = Math.floor(splitReserve * 0.8) + Math.floor(splitReserve * 0.5);
    const nextSplitBudget = Math.floor((splitReserve + 1) * 0.8) + Math.floor((splitReserve + 1) * 0.5);
    expect(splitBudget).toBeLessThanOrEqual(5_000);
    expect(nextSplitBudget).toBeGreaterThan(5_000);
  });

  it("uses configured retention to change Pi's first-kept cut point", async () => {
    const lowRetention = hookHarness();
    const highRetention = hookHarness();
    const lowRows = [];
    const highRows = [];
    await tryCompact(lowRetention.harness, {
      trigger: "reactive_overflow",
      onEvent: () => {},
      runtimeWarnings: [],
      session: lowRetention.session,
      onCompactionRecorded: (row) => lowRows.push(row),
      policy: { keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 0 },
    });
    await tryCompact(highRetention.harness, {
      trigger: "reactive_overflow",
      onEvent: () => {},
      runtimeWarnings: [],
      session: highRetention.session,
      onCompactionRecorded: (row) => highRows.push(row),
      policy: { keepRecentTokens: 14_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 0 },
    });
    expect(lowRows[0].first_kept_entry_id).toBe("e3");
    expect(highRows[0].first_kept_entry_id).toBe("e2");
  });

  it("keeps the combined generation caps within summaryMaxTokens for a split turn", async () => {
    const fixture = hookHarness({
      sourceMessages: [
        userMessage("prior".repeat(8_000)),
        assistantMessage("prior answer".repeat(4_000)),
        userMessage("current".repeat(7_000)),
        assistantMessage("current answer".repeat(4_000)),
        userMessage("recent".repeat(4_000)),
      ],
    });
    const result = await tryCompact(fixture.harness, {
      trigger: "reactive_overflow",
      onEvent: () => {},
      runtimeWarnings: [],
      session: fixture.session,
      policy: { keepRecentTokens: 14_000, summaryMaxTokens: 3_000, compactionMinSavingsTokens: 0 },
    });
    expect(result.applied).toBe(true);
    expect(fixture.generationLimits).toHaveLength(2);
    expect(fixture.generationLimits.reduce((sum, limit) => sum + limit, 0)).toBeLessThanOrEqual(3_000);
  });
});

describe("resolveLiveCompactionPolicy — window recognition", () => {
  it("reads the harness live model context window into the policy", () => {
    const harness = { getModel: () => ({ id: "m", contextWindow: 100_000 }) };
    const policy = resolveLiveCompactionPolicy({
      harness,
      runtime: { model: { id: "m" } },
      resolved: { reference: "pi:faux:m" },
      settings: {},
    });
    expect(policy.contextWindow).toBe(100_000);
    expect(policy.enabled).toBe(true);
    expect(policy.triggerTokens).toBeGreaterThan(0);
  });

  it("falls back to the runtime model window when the harness has no live model", () => {
    const policy = resolveLiveCompactionPolicy({
      harness: {},
      runtime: { model: { id: "m", contextWindow: 40_000 } },
      resolved: {},
      settings: {},
    });
    expect(policy.contextWindow).toBe(40_000);
  });

  it("uses a persistent context-window override instead of inaccurate provider metadata", () => {
    const policy = resolveLiveCompactionPolicy({
      harness: { getModel: () => ({ id: "override-only", contextWindow: 128_000 }) },
      runtime: { model: { id: "override-only", contextWindow: 128_000 } },
      resolved: { reference: "pi:faux:override-only" },
      settings: {},
      contextWindowOverride: 272_000,
    });
    expect(policy).toMatchObject({
      contextWindow: 272_000,
      triggerTokens: 190_400,
      keepRecentTokens: 20_000,
      summaryMaxTokens: 10_880,
      compactionMinSavingsTokens: 20_000,
    });
  });
});

describe("runProactiveCompaction — trigger math", () => {
  const policy = (over = {}) => ({
    enabled: true,
    contextWindow: 1_000,
    triggerTokens: 500,
    keepRecentTokens: 4_000,
    summaryMaxTokens: 2_000,
    compactionMinSavingsTokens: 0,
    fixedOverheadEnabled: true,
    ...over,
  });

  it("does nothing when the policy is disabled", async () => {
    const runState = freshRunState(fakeSession(), { policy: policy({ enabled: false }) });
    const harness = { waitForIdle: vi.fn(), compact: vi.fn() };
    await runProactiveCompaction(runState, {
      harness, systemPrompt: "s", options: { settings: {} }, tools: [],
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
    });
    expect(harness.compact).not.toHaveBeenCalled();
    expect(runState.compaction.applied).toBe(false);
  });

  it("does not compact when the estimate is below the trigger", async () => {
    // tiny transcript, fixed overhead disabled → estimate well under 500.
    const runState = freshRunState(fakeSession({ messages: [{ role: "user", content: "hi" }] }), {
      policy: policy({ fixedOverheadEnabled: false }),
    });
    const harness = { waitForIdle: vi.fn(), compact: vi.fn(async () => ({ tokensBefore: 1 })) };
    await runProactiveCompaction(runState, {
      harness, systemPrompt: "s",
      options: { settings: { agent_compaction_fixed_overhead_enabled: false } },
      tools: [], promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
    });
    expect(harness.compact).not.toHaveBeenCalled();
    expect(runState.compaction.diagnostics).toMatchObject({
      context_request_estimate_tokens: expect.any(Number),
      context_fixed_overhead_tokens: expect.any(Number),
      context_compaction_trigger_tokens: 500,
    });
  });

  it("compacts, records diagnostics, and re-anchors the baseline when the estimate crosses the trigger", async () => {
    // Large fixed overhead pushes the estimate over triggerTokens.
    const fixture = hookHarness();
    const runState = freshRunState(fixture.session, { policy: policy() });
    await runProactiveCompaction(runState, {
      harness: fixture.harness, systemPrompt: "s",
      options: { settings: {} }, // fixed overhead ON
      tools: [{ name: "Bash", description: "x".repeat(4000), parameters: {} }],
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
    });
    expect(fixture.harness.compact).toHaveBeenCalledTimes(1);
    expect(runState.compaction.applied).toBe(true);
    expect(runState.compaction.compactedThisRun).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_proactive).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_tokens_before).toBeGreaterThan(0);
    expect(runState.compaction.diagnostics.context_request_estimate_tokens).toBeGreaterThan(500);
    // Re-anchored to the compacted context length.
    expect(runState.sessionBaselineCount).toBe(fixture.messages.length);
  });
});

describe("runReactiveCompaction — overflow recovery", () => {
  const overflowState = { stopReason: "error", lastAssistant: { errorMessage: "context length exceeded, too many tokens" } };

  it("no-ops when already compacted this run (avoids the near-certain nothing-to-compact)", async () => {
    const runState = freshRunState(fakeSession(), { policy: { enabled: true } });
    runState.compaction.compactedThisRun = true;
    const harness = { compact: vi.fn(), waitForIdle: vi.fn(), prompt: vi.fn(), getModel: () => null };
    const out = await runReactiveCompaction(runState, {
      harness, runtime: {}, resolved: {}, options: {}, promptText: "hi", promptImages: [],
      reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: overflowState, runError: null, captureState: async () => overflowState,
    });
    // reactiveAttempted flips, but no second compaction fires.
    expect(runState.compaction.reactiveAttempted).toBe(true);
    expect(harness.compact).not.toHaveBeenCalled();
    expect(out.state).toBe(overflowState);
  });

  it("compacts once and re-prompts once on a fresh overflow", async () => {
    const fixture = hookHarness();
    const runState = freshRunState(fixture.session, {
      // Reactive recovery accepts any positive reduction even when the
      // proactive minimum is intentionally impossible to meet.
      policy: { enabled: true, keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 500_000 },
    });
    const rerunState = { stopReason: "endTurn", lastAssistant: { content: [{ type: "text", text: "recovered" }] } };
    let capturedCalls = 0;
    const out = await runReactiveCompaction(runState, {
      harness: fixture.harness, runtime: { model: { id: "m" } }, resolved: { reference: "pi:faux:reactive-success" }, options: {},
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: overflowState, runError: null,
      captureState: async () => { capturedCalls += 1; return rerunState; },
    });
    expect(fixture.harness.compact).toHaveBeenCalledTimes(1);
    expect(fixture.harness.prompt).toHaveBeenCalledTimes(1);
    expect(runState.compaction.applied).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_reactive).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_reactive_attempted).toBe(true);
    expect(runState.compaction.diagnostics.context_compaction_reduced).toBe(true);
    expect(out.state).toBe(rerunState);
    expect(capturedCalls).toBe(1);
  });

  it("does not re-prompt when compaction leaves the built context unchanged", async () => {
    const fixture = hookHarness({ sourceMessages: [userMessage("unchanged")] });
    const runState = freshRunState(fixture.session, {
      policy: { enabled: true, keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 0 },
    });
    const warnings = [];
    const out = await runReactiveCompaction(runState, {
      harness: fixture.harness, runtime: { model: { id: "m" } }, resolved: { reference: "pi:faux:reactive-no-reduction" }, options: {},
      promptText: "hi", promptImages: [], reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: warnings,
      state: overflowState, runError: null, captureState: vi.fn(),
    });
    expect(fixture.harness.compact).toHaveBeenCalledTimes(1);
    expect(fixture.harness.prompt).not.toHaveBeenCalled();
    expect(runState.compaction.diagnostics.context_compaction_reduced).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ warning_kind: "context_compaction_not_reducible" }));
    expect(out.state).toBe(overflowState);
  });

  it("lowers a process-local ceiling to 90% of a failed estimate for a generic overflow", async () => {
    const fixture = hookHarness({
      sourceMessages: [
        userMessage("a".repeat(100_000)),
        userMessage("b".repeat(100_000)),
        userMessage("c".repeat(100_000)),
      ],
    });
    const reference = "pi:faux:generic-ceiling";
    const runState = freshRunState(fixture.session, {
      policy: { enabled: true, keepRecentTokens: 4_000, summaryMaxTokens: 2_000, compactionMinSavingsTokens: 0 },
    });
    await runReactiveCompaction(runState, {
      harness: fixture.harness,
      runtime: { model: { id: "m", contextWindow: 128_000 } },
      resolved: { reference },
      options: {},
      promptText: "hi",
      promptImages: [],
      reference,
      onEvent: () => {},
      runtimeWarnings: [],
      state: overflowState,
      runError: null,
      captureState: async () => ({ stopReason: "endTurn", lastAssistant: null }),
    });
    const failedEstimate = runState.compaction.diagnostics.context_failed_request_estimate_tokens;
    expect(runState.compaction.diagnostics.context_learned_window).toBe(Math.floor(failedEstimate * 0.90));
    expect(runState.compaction.diagnostics.context_learned_window_source).toBe("generic_overflow");
    const nextPolicy = resolveLiveCompactionPolicy({
      harness: fixture.harness,
      runtime: { model: { id: "m", contextWindow: 128_000 } },
      resolved: { reference },
      settings: {},
      contextWindowOverride: 200_000,
    });
    expect(nextPolicy.contextWindow).toBe(Math.floor(failedEstimate * 0.90));
  });

  it("does not fire on a non-overflow error", async () => {
    const runState = freshRunState(fakeSession(), { policy: { enabled: true } });
    const harness = { compact: vi.fn(), waitForIdle: vi.fn(), prompt: vi.fn(), getModel: () => null };
    const benign = { stopReason: "error", lastAssistant: { errorMessage: "401 unauthorized" } };
    const out = await runReactiveCompaction(runState, {
      harness, runtime: {}, resolved: {}, options: {}, promptText: "hi", promptImages: [],
      reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: benign, runError: null, captureState: async () => benign,
    });
    expect(harness.compact).not.toHaveBeenCalled();
    expect(runState.compaction.reactiveAttempted).toBe(false);
    expect(out.runError).toBeNull();
  });

  it("skips when the run was externally aborted or hit max turns", async () => {
    const runState = freshRunState(fakeSession(), { policy: { enabled: true } });
    runState.externalAbort = true;
    const harness = { compact: vi.fn(), waitForIdle: vi.fn(), prompt: vi.fn() };
    await runReactiveCompaction(runState, {
      harness, runtime: {}, resolved: {}, options: {}, promptText: "hi", promptImages: [],
      reference: "pi:faux:m", onEvent: () => {}, runtimeWarnings: [],
      state: overflowState, runError: null, captureState: async () => overflowState,
    });
    expect(runState.compaction.reactiveAttempted).toBe(false);
    expect(harness.compact).not.toHaveBeenCalled();
  });
});
