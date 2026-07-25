// SPDX-License-Identifier: MIT

// The mutation gate is weekly, not per-PR, so nobody watches it fail. That
// makes its own failure logic the part most worth testing: a floor check that
// silently passes is indistinguishable from no floor at all, and it would take
// a week and a regression before anyone found out.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectFloorViolations } from "../measure/mutation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function run(name, logicScore) {
  return {
    target: { name },
    report: logicScore === undefined ? undefined : { logicScore },
  };
}

const floors = { "@mono-agent/core": 68, "@mono-agent/state-local": 69 };

describe("mutation logic-score floors", () => {
  it("accepts a score at the floor and rejects one below it", () => {
    expect(collectFloorViolations([run("@mono-agent/core", 68)], floors)).toEqual([]);
    expect(collectFloorViolations([run("@mono-agent/core", 68.4)], floors)).toEqual([]);

    expect(collectFloorViolations([run("@mono-agent/core", 67.9)], floors)).toEqual([
      "@mono-agent/core logic score 67.9% is below its 68% floor.",
    ]);
  });

  it("treats a missing score as a violation rather than a pass", () => {
    // Otherwise the cheapest way past this gate is a run that produces no
    // report -- a crashed Stryker, a moved report path, a mistyped package.
    expect(collectFloorViolations([run("@mono-agent/state-local", undefined)], floors)).toEqual([
      "@mono-agent/state-local produced no mutation score; floor 69% cannot be checked.",
    ]);
  });

  it("ignores packages that have no floor", () => {
    expect(collectFloorViolations([run("@mono-agent/tui", 3)], floors)).toEqual([]);
  });

  it("reports every violation, not just the first", () => {
    expect(collectFloorViolations([
      run("@mono-agent/core", 10),
      run("@mono-agent/state-local", 20),
    ], floors)).toHaveLength(2);
  });

  it("runs every floored package in the weekly workflow", () => {
    // A floor for a package the schedule never mutates is a floor that never
    // binds. The matrix and the floor list must name the same packages.
    const workflow = readFileSync(resolve(root, ".github/workflows/maintenance.yml"), "utf8");
    const matrix = /package:\s*\[([^\]]+)\]/u.exec(workflow)?.[1] ?? "";
    const scheduled = new Set(
      matrix.split(",").map((entry) => `@mono-agent/${entry.trim().replaceAll('"', "")}`),
    );
    const usage = readFileSync(resolve(root, "scripts/measure/mutation.mjs"), "utf8");
    const floored = [...usage.matchAll(/"(@mono-agent\/[a-z-]+)":\s*\d+,/gu)].map((match) => match[1]);

    expect(floored.length).toBeGreaterThan(0);
    expect(floored.filter((name) => !scheduled.has(name))).toEqual([]);
  });
});
