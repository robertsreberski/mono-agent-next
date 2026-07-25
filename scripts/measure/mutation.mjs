#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// Mutation testing over selected workspace packages.
//
// Coverage measures which lines ran; mutation score measures whether any test
// noticed the line changing. This repository has a 0.78 test-to-production line
// ratio, so coverage is not the scarce signal — assertion value is. A surviving
// mutant names a behaviour that nothing asserts.
//
// Read-only with respect to the product: Stryker copies each package into its
// own sandbox and never mutates the working tree.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageCatalog, packageRelativePath } from "../lib/package-catalog.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Stryker resolves plugins from its working directory, which is the package
// under test. pnpm's non-hoisted layout keeps the root devDependency invisible
// from there, so the plugin is passed as an already-resolved absolute path.
const VITEST_RUNNER_PLUGIN = createRequire(join(REPO_ROOT, "package.json"))
  .resolve("@stryker-mutator/vitest-runner");

/**
 * Packages whose defects in this repository have been operator-visible:
 * lifecycle, durable settlement, delivery, and provider routing.
 */
const DEFAULT_TARGETS = Object.freeze([
  "core",
  "channel-telegram",
  "channel-slack",
  "state-local",
]);

/**
 * Per-package logic-score floors, in percent. `--enforce` fails below them.
 *
 * Per package, not one global number, because the packages are 18 points apart:
 * a single threshold low enough for the weakest lets the strongest regress by
 * that whole margin without anyone noticing. A floor that only binds the worst
 * package is not a floor, it is a note about the worst package.
 *
 * The *logic* score, not the overall one, because a StringLiteral mutant is
 * usually a reworded message and almost never a defect -- state-local scores
 * 46.7% on string literals against 71.0% on logic, and gating on the blend
 * would mostly measure how many of its error messages happen to be asserted.
 * Branch, operator and statement mutants are decisions; those are the ones
 * worth requiring a test to notice.
 *
 * A ratchet, like the line budgets: each number sits below the score as
 * measured, so the next change has to hold the line. Raise one whenever the
 * score rises. Lowering one is the diff to argue about in review.
 *
 * Measured 2026-07-25 on this tree: core 67.5, state-local 71.0,
 * channel-slack 64.6, channel-telegram 51.3. Each floor sits ~3.5 points under
 * its measurement, and the margin is not politeness -- a Timeout mutant counts
 * as detected, so a loaded machine scores *higher* than an idle one, and these
 * four ran while the rest of this work competed for the same cores. The first
 * scheduled run on a clean runner is the real calibration.
 */
const LOGIC_SCORE_FLOORS = Object.freeze({
  "@mono-agent/core": 64,
  "@mono-agent/channel-telegram": 48,
  "@mono-agent/channel-slack": 61,
  "@mono-agent/state-local": 67,
});

function usage() {
  return [
    "mutate — mutation testing over workspace packages",
    "",
    "  pnpm run mutate                     mutate the default high-risk packages",
    "  pnpm run mutate <dir> [<dir>...]    mutate the named package directories",
    "  pnpm run mutate --enforce           fail below the per-package logic-score floor",
    "  pnpm run mutate --list              list mutatable package directories",
    "",
    `Default targets: ${DEFAULT_TARGETS.join(", ")}`,
    "",
    "Floors (logic score, percent):",
    ...Object.entries(LOGIC_SCORE_FLOORS).map(([name, floor]) => `  ${name.padEnd(28)} ${String(floor)}`),
  ].join("\n");
}

function mutatableDirectories() {
  return packageCatalog
    .filter((entry) => entry.publishable)
    .map((entry) => entry.dir)
    .sort((left, right) => left.localeCompare(right));
}

function resolveTarget(requested) {
  const entry = packageCatalog.find((candidate) =>
    candidate.dir === requested || candidate.name === requested);
  if (entry === undefined) {
    throw new Error(`Unknown package ${JSON.stringify(requested)}; run with --list to see valid names.`);
  }
  return { name: entry.name, dir: entry.dir, path: resolve(REPO_ROOT, packageRelativePath(entry)) };
}

/**
 * Mutating the text of an error message rarely corresponds to a real defect —
 * few suites assert exact prose. Control-flow and operator mutants do: each one
 * is a branch decision or comparison that no test noticed changing. Both scores
 * are reported so a high literal count cannot flatter or damn a package.
 */
const PROSE_MUTATORS = new Set(["StringLiteral", "Regex"]);

function scoreOf(detected, undetected) {
  const valid = detected + undetected;
  return valid === 0 ? undefined : (detected / valid) * 100;
}

function readReport(packagePath) {
  const reportPath = join(packagePath, "reports", "mutation", "mutation.json");
  let raw;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw);
  const counts = { killed: 0, survived: 0, timeout: 0, noCoverage: 0, ignored: 0, other: 0 };
  const logic = { detected: 0, undetected: 0 };
  const byMutator = new Map();
  const survivors = [];
  for (const [file, entry] of Object.entries(parsed.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      const status = String(mutant.status ?? "");
      const mutator = String(mutant.mutatorName ?? "unknown");
      if (status === "Killed") counts.killed += 1;
      else if (status === "Survived") counts.survived += 1;
      else if (status === "Timeout") counts.timeout += 1;
      else if (status === "NoCoverage") counts.noCoverage += 1;
      else if (status === "Ignored" || status === "CompileError") counts.ignored += 1;
      else counts.other += 1;

      const detected = status === "Killed" || status === "Timeout";
      const undetected = status === "Survived" || status === "NoCoverage";
      if (!detected && !undetected) continue;
      if (!PROSE_MUTATORS.has(mutator)) {
        if (detected) logic.detected += 1; else logic.undetected += 1;
      }
      const tally = byMutator.get(mutator) ?? { detected: 0, undetected: 0 };
      if (detected) tally.detected += 1; else tally.undetected += 1;
      byMutator.set(mutator, tally);
      if (undetected) {
        survivors.push({ file, line: mutant.location?.start?.line ?? 0, mutator, status });
      }
    }
  }
  survivors.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line);
  return {
    counts,
    score: scoreOf(counts.killed + counts.timeout, counts.survived + counts.noCoverage),
    logicScore: scoreOf(logic.detected, logic.undetected),
    byMutator: [...byMutator.entries()]
      .map(([mutator, tally]) => ({ mutator, ...tally, score: scoreOf(tally.detected, tally.undetected) }))
      .sort((left, right) => right.undetected - left.undetected),
    survivors,
  };
}

function mutatePackage(target) {
  process.stdout.write(`\n=== ${target.name} ===\n`);
  rmSync(join(target.path, "reports", "mutation"), { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [
      resolve(REPO_ROOT, "node_modules/@stryker-mutator/core/bin/stryker.js"),
      "run",
      resolve(REPO_ROOT, "stryker.conf.json"),
      "--plugins",
      VITEST_RUNNER_PLUGIN,
    ],
    { cwd: target.path, stdio: "inherit", env: process.env },
  );
  return { target, exitCode: result.status ?? 1, report: readReport(target.path) };
}

function percent(value) {
  return value === undefined ? "n/a" : `${value.toFixed(1)}%`;
}

function renderSummary(runs) {
  const lines = ["", "Mutation summary", ""];
  lines.push("| Package | Score | Logic score | Killed | Survived | No coverage |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const run of runs) {
    const report = run.report;
    if (report === undefined) {
      lines.push(`| ${run.target.name} | (no report) | - | - | - | - |`);
      continue;
    }
    lines.push(
      `| ${run.target.name} | ${percent(report.score)} | ${percent(report.logicScore)} `
      + `| ${String(report.counts.killed)} | ${String(report.counts.survived)} `
      + `| ${String(report.counts.noCoverage)} |`,
    );
  }
  lines.push("", "Logic score excludes string and regex literals: it counts only branch,");
  lines.push("operator, and statement mutants — each one a decision no test noticed changing.");
  for (const run of runs) {
    const report = run.report;
    if (report === undefined) continue;
    lines.push("", `${run.target.name} — undetected by mutator:`);
    for (const entry of report.byMutator.filter((candidate) => candidate.undetected > 0)) {
      lines.push(
        `  ${entry.mutator.padEnd(24)} undetected ${String(entry.undetected).padStart(4)}`
        + `  score ${percent(entry.score).padStart(6)}`,
      );
    }
    const survivors = report.survivors;
    lines.push("", `${run.target.name} — first undetected sites:`);
    for (const survivor of survivors.slice(0, 25)) {
      lines.push(`  ${survivor.file}:${String(survivor.line)} ${survivor.mutator} [${survivor.status}]`);
    }
    if (survivors.length > 25) lines.push(`  … ${String(survivors.length - 25)} more`);
  }
  return lines.join("\n");
}

/**
 * Floor violations, as printable lines. Empty means every measured package held.
 *
 * A package with a floor and no score is a violation, not a pass. Otherwise the
 * cheapest way past this gate is a run that produces no report.
 */
export function collectFloorViolations(runs, floors = LOGIC_SCORE_FLOORS) {
  const violations = [];
  for (const run of runs) {
    const floor = floors[run.target.name];
    if (floor === undefined) continue;
    const score = run.report?.logicScore;
    if (score === undefined) {
      violations.push(`${run.target.name} produced no mutation score; floor ${String(floor)}% cannot be checked.`);
      continue;
    }
    if (score + 1e-9 < floor) {
      violations.push(
        `${run.target.name} logic score ${score.toFixed(1)}% is below its ${String(floor)}% floor.`,
      );
    }
  }
  return violations;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv.includes("--list")) {
    process.stdout.write(`${mutatableDirectories().join("\n")}\n`);
    return 0;
  }
  const requested = argv.filter((value) => !value.startsWith("-"));
  const targets = (requested.length > 0 ? requested : DEFAULT_TARGETS).map(resolveTarget);
  const runs = targets.map(mutatePackage);
  process.stdout.write(`${renderSummary(runs)}\n`);
  if (runs.some((run) => run.exitCode !== 0)) return 1;
  if (!argv.includes("--enforce")) return 0;

  const violations = collectFloorViolations(runs);
  if (violations.length === 0) {
    process.stdout.write("\nEvery measured package held its logic-score floor.\n");
    return 0;
  }
  process.stderr.write(`\nMutation floor violations:\n${violations.map((line) => `- ${line}`).join("\n")}\n`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
