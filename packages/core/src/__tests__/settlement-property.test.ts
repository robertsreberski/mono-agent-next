// SPDX-License-Identifier: MIT

// Property: a terminal status the caller can act on must never be reported when
// durable settlement was not proved.
//
// `RunExecutionError` documents `uncertain` as meaning "an externally visible
// effect or durable settlement could not be proved and the caller must inspect
// the run before retrying" (src/errors.ts). Reporting `failed` therefore asserts
// settlement *was* proved. Whenever the `run.settle` write fails, the only
// honest terminal status is `uncertain`.
//
// The host reaches settlement from several distinct terminal paths, and each
// was previously covered — or not — by whichever scenario someone happened to
// write. This enumerates them against one shared invariant instead.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RuntimeTurnError } from "@mono-agent/module-sdk";

import { createAgentHost } from "../index.js";
import { MemoryStateStore } from "./durable-state-fixture.js";
import { createFixtureProject, minimalConfig, type FixtureController } from "./fixture.js";

/** How the runtime terminates the turn, before settlement is attempted. */
type TerminalPath = "provider-failure" | "success";

const RUNTIME_CAPABILITIES = Object.freeze({
  tools: true,
  mcp: true,
  attachments: true,
  approvals: true,
  structuredOutput: true,
  sandbox: true,
  sessions: true,
  maxTurns: true,
  maxOutputTokens: true,
});

function runtimeFor(path: TerminalPath): FixtureController {
  return {
    create: () => ({
      capabilities: RUNTIME_CAPABILITIES,
      runTurn: () => {
        if (path === "success") return { status: "completed", output: [{ type: "text", text: "ok" }] };
        // Not retryable and effect-free, so every configured route is exhausted
        // and the host classifies the run definitively before settling it.
        throw new RuntimeTurnError({
          code: "provider_down",
          message: "provider is down",
          retryability: "not-retryable",
          sideEffects: "none",
        });
      },
    }),
  };
}

function stateFailingSettle(shouldFail: () => boolean): FixtureController {
  const state = new MemoryStateStore();
  state.shouldFailExecution = (operation) => operation === "run.settle" && shouldFail();
  return { create: () => state };
}

interface Attempt {
  readonly thrown: { readonly status?: string; readonly failureCode?: string } | undefined;
  readonly durableStatus: string | undefined;
}

async function runTurnUnderSettlementFailure(path: TerminalPath): Promise<Attempt> {
  const suffix = randomUUID().toLowerCase();
  const runtimeName = `@fixture/runtime-settle-${suffix}`;
  const stateName = `@fixture/state-settle-${suffix}`;
  let failSettle = false;
  const project = await createFixtureProject([
    { name: runtimeName, kind: "runtime", controller: runtimeFor(path) },
    { name: stateName, kind: "state", controller: stateFailingSettle(() => failSettle) },
  ]);
  await project.writeConfig(minimalConfig(runtimeName, { state: { $use: stateName } }));
  const host = await createAgentHost(project.configPath);
  try {
    failSettle = true;
    let thrown: { status?: string; failureCode?: string; runId?: string } | undefined;
    await host
      .submit({ requestId: `settle-${suffix}`, conversationId: `c-${suffix}`, text: "go" })
      .catch((error: unknown) => {
        thrown = error as { status?: string; failureCode?: string; runId?: string };
      });
    failSettle = false;
    const runId = thrown?.runId;
    const durable = runId === undefined ? undefined : await host.readRun(runId);
    return { thrown, durableStatus: durable?.summary?.status };
  } finally {
    await host.stop();
    await project.cleanup();
  }
}

const TERMINAL_PATHS: readonly TerminalPath[] = ["provider-failure", "success"];

describe("durable settlement honesty", () => {
  // Enumerated rather than sampled. The reachable terminal paths are a closed,
  // two-element set, and each case costs a real on-disk project and host, so
  // random sampling would buy no coverage while multiplying setup. An earlier
  // draft sampled this space and passed while the defect was present, having
  // drawn the same path twice.
  it.each(TERMINAL_PATHS)("never reports a definitive status when run.settle failed (%s)", async (path) => {
    const attempt = await runTurnUnderSettlementFailure(path);

    // The submit must fail — settlement did not happen.
    expect(attempt.thrown).toBeDefined();
    // …and it must say so honestly rather than naming a definitive outcome.
    expect({ path, status: attempt.thrown?.status })
      .toStrictEqual({ path, status: "uncertain" });
  }, 120_000);

  it("keeps the durable record consistent with a definitive report", async () => {
    // `uncertain` legitimately leaves the run open — that is what it means. The
    // invariant is narrower: a caller told the run is definitively over must not
    // find it still running, or the requestId stays wedged behind a live
    // admission lease and the operator run listing shows a phantom active run.
    //
    // Asserted unconditionally. An earlier draft skipped each `uncertain` case
    // with `continue`, so once the settlement fix made *every* path uncertain
    // the loop body stopped running and the test passed having asserted
    // nothing. `--expect.requireAssertions` is what surfaced that.
    const outcomes = [];
    for (const path of TERMINAL_PATHS) {
      const attempt = await runTurnUnderSettlementFailure(path);
      outcomes.push({
        path,
        status: attempt.thrown?.status,
        durable: attempt.durableStatus,
      });
    }

    expect(outcomes.map((outcome) => outcome.status))
      .toStrictEqual(TERMINAL_PATHS.map(() => "uncertain"));

    for (const outcome of outcomes.filter((candidate) => candidate.status !== "uncertain")) {
      expect({ path: outcome.path, durable: outcome.durable })
        .toStrictEqual({ path: outcome.path, durable: outcome.status });
    }
  }, 300_000);
});
