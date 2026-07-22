import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runBuildWithProvenance } from "../build-with-provenance.mjs";

const CI_SOURCE = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const PACKAGE_SCRIPTS = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).scripts;

const AGGREGATE_DEMO_STEPS = [
  { name: "Build packages and demos", run: "pnpm run build" },
  { name: "Typecheck packages and demos", run: "pnpm run typecheck" },
  { name: "Run tests", run: "pnpm test" },
];
const REDUNDANT_DEMO_STEPS = [
  { name: "Build demos", run: "pnpm run build:demo" },
  { name: "Typecheck demos", run: "pnpm run typecheck:demo" },
  { name: "Test demos", run: "pnpm run test:demo" },
];
const DEMO_STEP_RUNS = new Set([
  ...AGGREGATE_DEMO_STEPS,
  ...REDUNDANT_DEMO_STEPS,
].map(({ run }) => run));

describe("CI demo command chaining", () => {
  it("keeps the three demos inside their aggregate CI steps", () => {
    const steps = singleLineRunSteps(workflowJob(CI_SOURCE, "verify", "website"));

    expect(steps.filter(({ run }) => DEMO_STEP_RUNS.has(run))).toEqual(AGGREGATE_DEMO_STEPS);
  });

  it("keeps each demo command last in its root aggregate", () => {
    expect(PACKAGE_SCRIPTS.build).toBe("node scripts/build-with-provenance.mjs");
    expect(splitSuccessfulCommands(PACKAGE_SCRIPTS.typecheck)).toEqual([
      "pnpm -r --sort run typecheck",
      "pnpm run typecheck:demo",
    ]);
    expect(splitSuccessfulCommands(PACKAGE_SCRIPTS.test)).toEqual([
      "pnpm run release:test",
      "pnpm run scripts:test",
      "pnpm -r --sort run test",
      "pnpm run test:demo",
    ]);
  });

  it("runs the build demo once after package builds with inherited output", () => {
    const repo = mkdtempSync(join(tmpdir(), "mono-agent-ci-demo-chaining-"));
    const calls = [];
    try {
      const result = runBuildWithProvenance({
        platform: "freebsd",
        repo,
        runCommand(command, args, options) {
          calls.push({ command, args, stdio: options.stdio });
          return { status: 0, stdout: "" };
        },
      });
      expect(result).toEqual({ exitCode: 0 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }

    expect(calls).toEqual([
      { command: "pnpm", args: ["-r", "--sort", "run", "build"], stdio: "inherit" },
      { command: "pnpm", args: ["run", "build:demo"], stdio: "inherit" },
    ]);
  });
});

// This intentionally checks the workflow's ordinary structural form instead
// of trying to interpret arbitrary shell programs. The contract protects the
// three removed steps from accidental reintroduction; the production diff is
// the evidence that the issue's named-step count dropped by exactly three.
function singleLineRunSteps(source) {
  return [...source.matchAll(/^ {6}- name: ([^\n]+)\n {8}run: ([^\n]+)$/gmu)]
    .map((match) => ({ name: match[1].trim(), run: match[2].trim() }));
}

function workflowJob(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  const end = source.indexOf(`  ${nextName}:\n`, start + 1);
  if (start < 0 || end < 0) throw new Error(`expected ${name} before ${nextName}`);
  return source.slice(start, end);
}

function splitSuccessfulCommands(script) {
  return script.split(/\s*&&\s*/u);
}
