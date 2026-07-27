// SPDX-License-Identifier: MIT

// The mutation gate is weekly, not per-PR, so nobody watches it fail. That
// makes its own failure logic the part most worth testing: a floor check that
// silently passes is indistinguishable from no floor at all, and it would take
// a week and a regression before anyone found out.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertSupportedMutationOptions,
  collectFloorViolations,
  collectTargetedSelectionViolations,
  parseTargetedMutationSelection,
  validateTargetedMutationSelection,
} from "../measure/mutation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateTarget = {
  name: "@mono-agent/state-local",
  path: resolve(root, "packages/state-local"),
};

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

describe("targeted mutation selection", () => {
  it("accepts documented options and rejects misspelled or bare targeted options", () => {
    expect(() => assertSupportedMutationOptions([
      "state-local",
      "--",
      "--mutate=src/execution-codec.ts:111-169",
      "--test-files=src/__tests__/execution-codec.test.ts",
    ])).not.toThrow();

    for (const option of [
      "--mutatee=src/execution-codec.ts",
      "--test-file=src/__tests__/execution-codec.test.ts",
      "--mutate",
      "--test-files",
      "--unknown",
    ]) {
      expect(() => assertSupportedMutationOptions(["state-local", option])).toThrow(
        /Unknown mutation option/u,
      );
    }
  });

  it("accepts one package with bounded production and test selectors", () => {
    const selection = parseTargetedMutationSelection([
      "state-local",
      "--mutate=src/execution-codec.ts:111-169",
      "--test-files=src/__tests__/execution-codec.test.ts",
    ], 1);
    expect(selection).toEqual({
      mutate: "src/execution-codec.ts:111-169",
      testFiles: "src/__tests__/execution-codec.test.ts",
    });
    expect(validateTargetedMutationSelection(stateTarget, selection)).toEqual({
      mutateEntries: ["src/execution-codec.ts:111-169"],
      mutateSelectors: [{
        file: "src/execution-codec.ts",
        start: 111,
        end: 169,
      }],
      mutateFiles: ["src/execution-codec.ts"],
      testEntries: ["src/__tests__/execution-codec.test.ts"],
      testFiles: ["src/__tests__/execution-codec.test.ts"],
    });
  });

  it("rejects ambiguous targets, duplicate selectors, and whole-package floor claims", () => {
    expect(() => parseTargetedMutationSelection([
      "--mutate=src/execution-codec.ts",
    ], 2)).toThrow(/exactly one package/u);
    expect(() => parseTargetedMutationSelection([
      "--mutate=src/a.ts",
      "--mutate=src/b.ts",
    ], 1)).toThrow(/only once/u);
    expect(() => parseTargetedMutationSelection([
      "--test-files=",
    ], 1)).toThrow(/non-empty selector/u);
    expect(() => parseTargetedMutationSelection([
      "--mutate=src/execution-codec.ts",
      "--enforce",
    ], 1)).toThrow(/whole-package score floor/u);
  });

  it("rejects unmatched, escaping, and invalid-range selectors before Stryker can fall back", () => {
    expect(() => validateTargetedMutationSelection(stateTarget, {
      mutate: "src/missing-decoder.ts",
      testFiles: undefined,
    })).toThrow(/matched no package file/u);
    expect(() => validateTargetedMutationSelection(stateTarget, {
      mutate: undefined,
      testFiles: "src/__tests__/missing-decoder.test.ts",
    })).toThrow(/matched no package file/u);
    expect(() => validateTargetedMutationSelection(stateTarget, {
      mutate: "../outside.ts",
      testFiles: undefined,
    })).toThrow(/escapes the selected package/u);
    expect(() => validateTargetedMutationSelection(stateTarget, {
      mutate: "src/execution-codec.ts:169-111",
      testFiles: undefined,
    })).toThrow(/reversed line range/u);
    expect(() => validateTargetedMutationSelection(stateTarget, {
      mutate: "src/execution-codec.ts:1-999999",
      testFiles: undefined,
    })).toThrow(/exceeds .* source lines/u);
  });

  it("rejects a selected file reached through a symlinked package parent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "mono-agent-mutation-selector-"));
    try {
      const packagePath = join(temporary, "package");
      const outsidePath = join(temporary, "outside");
      mkdirSync(packagePath);
      mkdirSync(outsidePath);
      writeFileSync(join(outsidePath, "escape.ts"), "export const escaped = true;\n");
      symlinkSync(outsidePath, join(packagePath, "src"));

      expect(() => validateTargetedMutationSelection({
        name: "@mono-agent/test",
        path: packagePath,
      }, {
        mutate: "src/escape.ts",
        testFiles: undefined,
      })).toThrow(/traverses a symbolic link/u);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects zero-mutant reports and fallback-all test reports", () => {
    const selection = {
      mutate: "src/execution-codec.ts:111-169",
      testFiles: "src/__tests__/execution-codec.test.ts",
    };
    const expected = validateTargetedMutationSelection(stateTarget, selection);
    const report = {
      mutantCount: 0,
      sourceFiles: ["src/execution-codec.ts"],
      configuredMutate: ["src/execution-codec.ts:111-169"],
      mutants: [],
      testCount: 100,
      testFiles: ["src/__tests__/store.test.ts"],
      configuredTestFiles: [],
    };

    expect(collectTargetedSelectionViolations([
      { target: stateTarget, report },
    ], selection, expected)).toEqual([
      "@mono-agent/state-local targeted mutation selection produced zero mutants.",
      '@mono-agent/state-local targeted mutation selector "src/execution-codec.ts:111-169" produced zero mutants.',
      "@mono-agent/state-local targeted mutation report did not contain exactly the requested test files.",
      "@mono-agent/state-local targeted mutation report did not retain the requested test selectors.",
    ]);
  });

  it("rejects a mixed source selection when any requested range produces zero mutants", () => {
    const selection = {
      mutate: "src/execution-codec.ts:111-169,src/execution-codec.ts:1-1",
      testFiles: "src/__tests__/execution-codec.test.ts",
    };
    const expected = validateTargetedMutationSelection(stateTarget, selection);
    const report = {
      mutantCount: 1,
      sourceFiles: ["src/execution-codec.ts"],
      configuredMutate: [
        "src/execution-codec.ts:111-169",
        "src/execution-codec.ts:1-1",
      ],
      mutants: [{
        file: "src/execution-codec.ts",
        startLine: 130,
        endLine: 131,
      }],
      testCount: 83,
      testFiles: ["src/__tests__/execution-codec.test.ts"],
      configuredTestFiles: ["src/__tests__/execution-codec.test.ts"],
    };

    expect(collectTargetedSelectionViolations([
      { target: stateTarget, report },
    ], selection, expected)).toEqual([
      '@mono-agent/state-local targeted mutation selector "src/execution-codec.ts:1-1" produced zero mutants.',
    ]);
  });

  it("does not let a broad-range mutant satisfy an overlapping narrow selector", () => {
    const selection = {
      mutate: "src/execution-codec.ts:111-169,src/execution-codec.ts:130-130",
      testFiles: "src/__tests__/execution-codec.test.ts",
    };
    const expected = validateTargetedMutationSelection(stateTarget, selection);
    const report = {
      mutantCount: 1,
      sourceFiles: ["src/execution-codec.ts"],
      configuredMutate: [
        "src/execution-codec.ts:111-169",
        "src/execution-codec.ts:130-130",
      ],
      mutants: [{
        file: "src/execution-codec.ts",
        startLine: 120,
        endLine: 150,
      }],
      testCount: 83,
      testFiles: ["src/__tests__/execution-codec.test.ts"],
      configuredTestFiles: ["src/__tests__/execution-codec.test.ts"],
    };

    expect(collectTargetedSelectionViolations([
      { target: stateTarget, report },
    ], selection, expected)).toEqual([
      '@mono-agent/state-local targeted mutation selector "src/execution-codec.ts:130-130" produced zero mutants.',
    ]);
  });
});
