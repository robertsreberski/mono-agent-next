// Two createRuntime instances in one process must not cross-contaminate.
//
// Before the per-instance ToolContext (tool-context.js), createRuntime mutated a
// process-global tool-runtime singleton, so a second runtime clobbered the
// first's workspace / repoRoot / sandboxPolicy / brand. This drives TWO runtimes
// with different workspace + brand + sandbox IMPLEMENTATION + sandbox POLICY,
// running interleaved (concurrent) faux-model turns, and asserts that tool path
// resolution (cwd), brand stamps, and sandbox policies never cross.
//
// Observation surfaces (all through the REAL createRuntime → pi-native → tool
// path, not internals):
//   - sandbox POLICY + tool-path/cwd: a recording RuntimeSandbox per runtime
//     captures the (policy, cwd) every Bash prepareCommand runs under;
//   - brand: a Grep call with ripgrep forced-missing returns the per-ctx
//     ripgrepMissingMessage, which embeds ctx.runtimeBrand.doctorCommand — a
//     directly observable per-instance brand stamp;
//   - brand global non-clobber: the module-default context's brand is unchanged
//     (neither runtime leaked its brand onto the shared default — the exact bug).
//
// KNOWN SHARED MODULE CACHE (documented, out of scope): ripgrep's cachedRgPath is
// process-global, so both runtimes share the SAME resolved rg path. This test
// forces it null to exercise the brand-stamped missing message; both runtimes
// observe the same null cache (the shared-cache reality) yet each stamps its OWN
// brand into the message (per-instance ctx). See ripgrep.js's cachedRgPath note.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../runtime.js";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";
import { DEFAULT_RUNTIME_BRAND } from "../../runtime-brand.js";
import { cachedRgPath } from "../../agent/tools/shared/ripgrep.js";

// A fresh faux provider + Models per run (each runtime resolves its own model).
function makeFaux() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", reasoning: false }], tokensPerSecond: undefined });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

// A RuntimeSandbox that records the (policy, cwd) every prepareCommand runs under
// and the (policy, url) every networkAllowsUrl checks, then behaves as an
// identity (no real enforcement) so a Bash call proceeds with a harmless command.
function recordingSandbox() {
  const prepareCalls = [];
  const merges = [];
  return {
    prepareCalls,
    merges,
    impl: {
      mergePolicies(configured, request) {
        merges.push({ configured, request });
        // Identity-ish: the configured (host) policy wins, matching how a real
        // merge keeps the host policy when there's no tightening request.
        return configured ?? request;
      },
      async prepareCommand({ policy, command }) {
        prepareCalls.push({ policy, cwd: command?.cwd });
        return { ...command, args: command?.args ?? [], cwd: command?.cwd ?? process.cwd(), sandboxed: false };
      },
      networkAllowsUrl() { return true; },
    },
  };
}

let workspaces = [];
let priorRgCache;

beforeEach(() => {
  workspaces = [];
  // Force ripgrep "missing" so Grep returns the per-ctx brand-stamped message.
  priorRgCache = cachedRgPath.value;
  cachedRgPath.value = null;
});

afterEach(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
  workspaces = [];
  // Restore the shared cache so other suites re-resolve the real binary.
  cachedRgPath.value = priorRgCache;
});

function makeWorkspace(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

// One faux turn: Bash (observes cwd + sandbox policy), then Grep (observes brand
// via the rg-missing message), then a final text so the run completes.
function threeStepResponses(faux, workspace) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("Bash", { command: "echo hi" }, { id: "b1" })]),
    fauxAssistantMessage([fauxToolCall("Grep", { pattern: "needle", path: workspace }, { id: "g1" })]),
    fauxAssistantMessage([fauxText("done")]),
  ]);
}

function collectToolResults(events) {
  const out = [];
  return {
    onEvent: (event) => {
      if (event?.type === "user") {
        for (const block of event.message?.content || []) {
          if (block?.type === "tool_result") out.push(JSON.stringify(block.content));
        }
      }
      events.push(event);
    },
    toolResults: out,
  };
}

function nativePolicy(marker, workspace) {
  return {
    mode: "native",
    marker,
    readableRoots: [workspace],
    writableRoots: [workspace],
  };
}

describe("two createRuntime instances in one process — no cross-contamination", () => {
  it("interleaved faux turns keep workspace/cwd, brand, and sandbox policy fully isolated", async () => {
    const workspaceA = makeWorkspace("two-rt-A-");
    const workspaceB = makeWorkspace("two-rt-B-");
    const sandboxA = recordingSandbox();
    const sandboxB = recordingSandbox();
    const brandA = { doctorCommand: "doctor-A-cmd" };
    const brandB = { doctorCommand: "doctor-B-cmd" };

    const runtimeA = createRuntime({
      workspace: workspaceA,
      runtimeBrand: brandA,
      sandbox: sandboxA.impl,
      sandboxPolicy: nativePolicy("A", workspaceA),
    });
    const runtimeB = createRuntime({
      workspace: workspaceB,
      runtimeBrand: brandB,
      sandbox: sandboxB.impl,
      sandboxPolicy: nativePolicy("B", workspaceB),
    });

    const fauxA = makeFaux();
    const fauxB = makeFaux();
    threeStepResponses(fauxA.faux, workspaceA);
    threeStepResponses(fauxB.faux, workspaceB);

    const eventsA = [];
    const eventsB = [];
    const capA = collectToolResults(eventsA);
    const capB = collectToolResults(eventsB);

    const model = (m) => ({ sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model", _m: m });

    // Interleaved: both turns in flight concurrently.
    const [resultA, resultB] = await Promise.all([
      runtimeA.run("system", {
        model: model("A"),
        piResolvedModel: fauxA.model,
        piResolvedModels: fauxA.models,
        effort: "none",
        allowedTools: ["Bash", "Grep"],
        messages: [{ role: "user", content: "go A" }],
        onEvent: capA.onEvent,
      }),
      runtimeB.run("system", {
        model: model("B"),
        piResolvedModel: fauxB.model,
        piResolvedModels: fauxB.models,
        effort: "none",
        allowedTools: ["Bash", "Grep"],
        messages: [{ role: "user", content: "go B" }],
        onEvent: capB.onEvent,
      }),
    ]);

    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();

    // (1) Sandbox POLICY isolation: each runtime's sandbox saw ONLY its own
    // policy marker; neither ever saw the other's.
    expect(sandboxA.prepareCalls.length).toBeGreaterThan(0);
    expect(sandboxB.prepareCalls.length).toBeGreaterThan(0);
    expect(sandboxA.prepareCalls.every((c) => c.policy?.marker === "A")).toBe(true);
    expect(sandboxB.prepareCalls.every((c) => c.policy?.marker === "B")).toBe(true);
    expect(sandboxA.prepareCalls.some((c) => c.policy?.marker === "B")).toBe(false);
    expect(sandboxB.prepareCalls.some((c) => c.policy?.marker === "A")).toBe(false);

    // (2) Tool path / cwd isolation: each runtime's Bash ran in ITS workspace.
    expect(sandboxA.prepareCalls.every((c) => resolve(c.cwd) === resolve(workspaceA))).toBe(true);
    expect(sandboxB.prepareCalls.every((c) => resolve(c.cwd) === resolve(workspaceB))).toBe(true);

    // (3) Brand isolation (observed in-turn): each Grep returned its OWN brand's
    // doctorCommand, never the other's.
    const joinedA = capA.toolResults.join("\n");
    const joinedB = capB.toolResults.join("\n");
    expect(joinedA).toContain("doctor-A-cmd");
    expect(joinedA).not.toContain("doctor-B-cmd");
    expect(joinedB).toContain("doctor-B-cmd");
    expect(joinedB).not.toContain("doctor-A-cmd");

    // (4) Brand isolation (global non-clobber): neither runtime leaked its brand
    // onto the shared module-default context — the exact pre-ToolContext bug.
    expect(readRuntimeBrand()).toEqual(DEFAULT_RUNTIME_BRAND);
  });

  it("configureTools mutates only its own instance's context, never the sibling's", async () => {
    const workspaceA = makeWorkspace("two-rt-cfg-A-");
    const workspaceB = makeWorkspace("two-rt-cfg-B-");
    const sandboxA = recordingSandbox();
    const sandboxB = recordingSandbox();

    const runtimeA = createRuntime({ workspace: workspaceA, sandbox: sandboxA.impl, sandboxPolicy: nativePolicy("A", workspaceA) });
    const runtimeB = createRuntime({ workspace: workspaceB, sandbox: sandboxB.impl, sandboxPolicy: nativePolicy("B", workspaceB) });

    // Reconfigure A's workspace at runtime; B must be untouched.
    const workspaceA2 = makeWorkspace("two-rt-cfg-A2-");
    runtimeA.configureTools({ workspace: workspaceA2, sandboxPolicy: nativePolicy("A2", workspaceA2) });

    const fauxA = makeFaux();
    const fauxB = makeFaux();
    fauxA.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Bash", { command: "echo a" }, { id: "b1" })]),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    fauxB.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("Bash", { command: "echo b" }, { id: "b1" })]),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    const base = { effort: "none", allowedTools: ["Bash"], onEvent: () => {} };
    const [rA, rB] = await Promise.all([
      runtimeA.run("system", {
        ...base,
        model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model" },
        piResolvedModel: fauxA.model,
        piResolvedModels: fauxA.models,
        messages: [{ role: "user", content: "go A" }],
      }),
      runtimeB.run("system", {
        ...base,
        model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model" },
        piResolvedModel: fauxB.model,
        piResolvedModels: fauxB.models,
        messages: [{ role: "user", content: "go B" }],
      }),
    ]);

    expect(rA.error).toBeNull();
    expect(rB.error).toBeNull();
    // A's reconfigured workspace + policy took effect; B kept its own.
    expect(sandboxA.prepareCalls.every((c) => c.policy?.marker === "A2" && resolve(c.cwd) === resolve(workspaceA2))).toBe(true);
    expect(sandboxB.prepareCalls.every((c) => c.policy?.marker === "B" && resolve(c.cwd) === resolve(workspaceB))).toBe(true);
  });
});
