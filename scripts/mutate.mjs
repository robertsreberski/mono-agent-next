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

import { packageCatalog, packageRelativePath } from "./package-catalog.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function usage() {
  return [
    "mutate — mutation testing over workspace packages",
    "",
    "  pnpm run mutate                     mutate the default high-risk packages",
    "  pnpm run mutate <dir> [<dir>...]    mutate the named package directories",
    "  pnpm run mutate --list              list mutatable package directories",
    "",
    `Default targets: ${DEFAULT_TARGETS.join(", ")}`,
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
  return runs.some((run) => run.exitCode !== 0) ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
