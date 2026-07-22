#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLASSIFICATIONS,
  GATE_ORDER,
  collectComplexitySnapshot,
  collectTrackedTreeEvidence,
  compareComplexitySnapshots,
  evaluateGate,
  G0_AUTHORITY_PATH,
  loadComplexityG0Authority,
  loadComplexityBaseline,
  stablePrettyJson,
  validateComplexitySnapshot,
} from "./lib/v1-complexity.mjs";

export function parseV1ComplexityArgs(argv) {
  const options = {
    baseline: undefined,
    authority: G0_AUTHORITY_PATH,
    gate: undefined,
    help: false,
    json: false,
    policy: "refactor/v1-complexity-policy.json",
    verifyBaseline: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--baseline") {
      options.baseline = requiredValue(argv, ++index, arg);
    } else if (arg === "--authority") {
      options.authority = requiredValue(argv, ++index, arg);
    } else if (arg === "--verify-baseline") {
      options.verifyBaseline = requiredValue(argv, ++index, arg);
    } else if (arg === "--gate") {
      options.gate = requiredValue(argv, ++index, arg);
      if (!GATE_ORDER.includes(options.gate)) throw new Error(`Unknown gate ${options.gate}.`);
    } else if (arg === "--policy") {
      options.policy = requiredValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.baseline !== undefined && options.verifyBaseline !== undefined) {
    throw new Error("Use either --baseline or --verify-baseline, not both.");
  }
  if (options.gate !== undefined
    && options.baseline === undefined
    && options.verifyBaseline === undefined) {
    throw new Error("--gate requires --baseline or --verify-baseline committed evidence.");
  }
  return options;
}

export function runV1ComplexityReport(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseV1ComplexityArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return { exitCode: 0 };
    }
    const treeEvidenceBefore = parsed.gate === undefined
      ? undefined
      : (options.collectTreeEvidence ?? collectTrackedTreeEvidence)({ cwd });
    const snapshot = (options.collectSnapshot ?? collectComplexitySnapshot)({
      cwd,
      policyPath: parsed.policy,
    });
    const baselinePath = parsed.verifyBaseline ?? parsed.baseline;
    let comparison;
    let authorityEvidence;
    if (baselinePath !== undefined) {
      const authority = parsed.gate === undefined
        ? undefined
        : (options.loadAuthority ?? loadComplexityG0Authority)({
          cwd,
          path: parsed.authority,
          baselinePath,
          gate: parsed.gate,
        });
      const loaded = authority?.baseline ?? (options.loadBaseline ?? loadComplexityBaseline)({
        cwd,
        path: baselinePath,
        requireCommitted: false,
      });
      validateComplexitySnapshot(loaded.snapshot);
      comparison = {
        ...compareComplexitySnapshots(snapshot, loaded.snapshot),
        baselineEvidence: loaded.evidence,
      };
      authorityEvidence = authority === undefined ? undefined : {
        artifact: authority.authorityEvidence,
        ref: authority.refEvidence,
      };
    }
    const treeEvidenceAfter = parsed.gate === undefined
      ? undefined
      : (options.collectTreeEvidence ?? collectTrackedTreeEvidence)({ cwd });
    const treeEvidenceStable = treeEvidenceBefore === undefined
      || JSON.stringify(treeEvidenceBefore) === JSON.stringify(treeEvidenceAfter);
    const report = {
      ...snapshot,
      ...(treeEvidenceAfter === undefined ? {} : { currentTreeEvidence: treeEvidenceAfter }),
      ...(comparison === undefined ? {} : { comparison }),
      ...(authorityEvidence === undefined ? {} : { g0AuthorityEvidence: authorityEvidence }),
    };
    stdout.write(parsed.json ? stablePrettyJson(report) : renderHumanReport(report, parsed.gate));

    const failures = parsed.gate === undefined ? [] : evaluateGate(snapshot, parsed.gate);
    if (!treeEvidenceStable) {
      failures.push("tracked tree changed while the complexity report was collected");
    }
    if (treeEvidenceAfter !== undefined && treeEvidenceAfter.stagedPaths.length > 0) {
      failures.push(`tracked tree has staged changes relative to HEAD: ${treeEvidenceAfter.stagedPaths.join(", ")}`);
    }
    if (treeEvidenceAfter !== undefined && treeEvidenceAfter.unstagedPaths.length > 0) {
      failures.push(`tracked tree has unstaged changes relative to the index: ${treeEvidenceAfter.unstagedPaths.join(", ")}`);
    }
    if (parsed.gate === "G0"
      && comparison?.baselineEvidence.commit !== treeEvidenceAfter?.commit) {
      failures.push("baseline evidence commit does not match the measured HEAD");
    }
    if (parsed.gate !== undefined && comparison?.algorithmMatches !== true) {
      failures.push("current report algorithm does not match the committed baseline");
    }
    if (parsed.gate !== undefined && comparison?.classificationAuthorityMatches !== true) {
      failures.push("current classification authority does not match the frozen G0 baseline");
    }
    if ((parsed.gate === "G0" || parsed.verifyBaseline !== undefined) && comparison?.matches !== true) {
      failures.push(`current snapshot ${snapshot.snapshotSha256} does not match baseline ${comparison?.baselineSnapshotSha256}`);
    }
    if (parsed.verifyBaseline !== undefined && snapshot.issues.length > 0) {
      failures.push(...snapshot.issues);
    }
    const uniqueFailures = [...new Set(failures)].sort();
    if (uniqueFailures.length > 0) {
      stderr.write(`V1 complexity check failed:\n${uniqueFailures.map((failure) => `- ${failure}`).join("\n")}\n`);
      return { exitCode: 1, report, failures: uniqueFailures };
    }
    return { exitCode: 0, report, failures: [] };
  } catch (error) {
    stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    return { exitCode: 1 };
  }
}

export function renderHumanReport(report, gate) {
  const lines = [
    "V1 complexity report",
    `snapshot ${report.snapshotSha256}`,
    `manifest ${report.manifestSha256}`,
    "",
    "classification       files      lines",
  ];
  for (const classification of CLASSIFICATIONS) {
    const count = report.totals.byClassification[classification];
    lines.push(`${classification.padEnd(17)} ${String(count.files).padStart(7)} ${String(count.lines).padStart(10)}`);
  }
  lines.push(
    `${"all executable".padEnd(17)} ${String(report.totals.allExecutable.files).padStart(7)} ${String(report.totals.allExecutable.lines).padStart(10)}`,
    "",
    ...report.budgets.map((budget) => {
      const status = budget.withinLimit ? "within" : `enforced at ${budget.enforceAt}`;
      return `${budget.id}: ${budget.actualLines}/${budget.maxLines} (${status})`;
    }),
    `packages: ${report.inventory.workspacePackages.total} (${report.inventory.workspacePackages.publishable} publishable)`,
    `public code export subpaths: ${report.inventory.publicCodeExportSubpaths.total}`,
    `dependency edges/cycles: ${report.inventory.dependencyGraph.edgeCount}/${report.inventory.dependencyGraph.cycles.length}`,
    `issues: ${report.issues.length}`,
  );
  if (report.comparison !== undefined) {
    lines.push(
      "",
      `baseline: ${report.comparison.matches ? "exact match" : "changed"}`,
      `baseline evidence: ${report.comparison.baselineEvidence.source} ${report.comparison.baselineEvidence.contentSha256}`,
      `baseline snapshot: ${report.comparison.baselineEvidence.snapshotSha256}`,
      `production delta: ${signed(report.comparison.byClassification.production.lines)} lines`,
      `file delta: +${report.comparison.files.added} -${report.comparison.files.removed} changed=${report.comparison.files.changed} reclassified=${report.comparison.files.reclassified}`,
    );
  }
  if (report.currentTreeEvidence !== undefined) {
    lines.push(
      "",
      `current HEAD: ${report.currentTreeEvidence.commit}`,
      `current tree: ${report.currentTreeEvidence.tree}`,
      `tracked tree: ${report.currentTreeEvidence.trackedClean ? "clean" : "dirty"}`,
    );
  }
  if (report.g0AuthorityEvidence !== undefined) {
    lines.push(
      "",
      `G0 authority: ${report.g0AuthorityEvidence.artifact.contentSha256}`,
      `authority ref: ${report.g0AuthorityEvidence.ref.ref} (${report.g0AuthorityEvidence.ref.status})`,
    );
  }
  if (gate !== undefined) lines.push("", `gate: ${gate}`);
  if (report.issues.length > 0) lines.push("", ...report.issues.map((issue) => `- ${issue}`));
  return `${lines.join("\n")}\n`;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/v1-complexity-report.mjs [--json] [--baseline PATH] [--gate GATE]",
    "  node scripts/v1-complexity-report.mjs [--json] --verify-baseline PATH [--gate GATE] [--authority PATH]",
    "",
    "Reads stage-0 Git blobs and emits a deterministic classified source manifest. Gate mode requires a clean tracked tree and the digest-bound G0 authority artifact.",
    `Known gates: ${GATE_ORDER.join(", ")}`,
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = runV1ComplexityReport();
  process.exitCode = result.exitCode;
}
