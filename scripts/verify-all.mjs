#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MINIMUM_NODE_VERSION } from "./node-version.mjs";
import { runVerifyConsumers } from "./verify-consumers.mjs";

export const CI_RELEASE_TAG_EXPRESSION = "${{ steps.release-smoke.outputs.tag }}";

/**
 * Intentional semantic differences from the CI verify job.
 *
 * scripts/__tests__/verify-all.test.mjs checks the complete ordered action,
 * environment, and gate sequence for every CI Node-matrix leg. The separate
 * website job is not a repo gate.
 */
export const VERIFY_GATE_DELTA = Object.freeze({
  ciSetup: Object.freeze([
    Object.freeze({
      key: "checkout",
      after: null,
      reason: "CI checks out the source tree; local verify:all runs in the caller's existing checkout.",
    }),
    Object.freeze({
      key: "Node setup",
      after: "checkout",
      reason: "CI selects each exact Node-matrix runtime; local verify:all uses the active supported runtime.",
    }),
    Object.freeze({
      key: "corepack setup",
      after: "Node setup",
      reason: "CI enables Corepack in its clean runner; local verify:all assumes the selected pnpm is already available.",
    }),
    Object.freeze({
      key: "dependency install",
      after: "check:node",
      reason: "CI installs the frozen workspace after proving the Node floor; local verify:all uses the caller's installed workspace.",
    }),
    Object.freeze({
      key: "bundled web console dependency install",
      after: "dependency install",
      reason: "CI installs the bundled web console's isolated frozen graph before its license gate; local verify:all uses the caller's installed webapp workspace.",
    }),
    Object.freeze({
      key: "release-tag derivation",
      after: "check:consumer-docs-consistency",
      reason: "CI exports the manifest-derived smoke tag for later steps; local verify:all reads that manifest value in-process.",
    }),
  ]),
  ciOnly: Object.freeze([]),
  verifyAllOnly: Object.freeze([
    Object.freeze({
      gate: Object.freeze({
        label: "test:demo",
        command: "pnpm",
        args: Object.freeze(["run", "test:demo"]),
      }),
      after: "test",
      reason: "verify:all retains the explicit demo-test rerun while CI relies on the demo tests already chained into the root test command.",
    }),
  ]),
  commandDifferences: Object.freeze([
    Object.freeze({
      label: "check:secrets",
      ci: Object.freeze({
        label: "check:secrets",
        command: "docker",
        args: Object.freeze([
          "run",
          "--rm",
          "-v",
          "$PWD:/repo",
          "ghcr.io/gitleaks/gitleaks:v8.30.1",
          "dir",
          "--redact",
          "--no-banner",
          "--config",
          "/repo/.gitleaks.toml",
          "/repo",
        ]),
      }),
      verifyAll: Object.freeze({
        label: "check:secrets",
        command: "pnpm",
        args: Object.freeze(["run", "check:secrets"]),
      }),
      reason: "CI runs the pinned gitleaks container; the local gate uses the host-aware check:secrets wrapper.",
    }),
    Object.freeze({
      label: "test",
      ci: Object.freeze({
        label: "test",
        command: "pnpm",
        args: Object.freeze(["test"]),
      }),
      verifyAll: Object.freeze({
        label: "test",
        command: "pnpm",
        args: Object.freeze(["run", "test"]),
      }),
      reason: "pnpm test and pnpm run test invoke the same package script.",
    }),
  ]),
  relocatedCommandDifferences: Object.freeze([
    Object.freeze({
      label: "check:pnpm-policy",
      ci: Object.freeze({
        label: "check:pnpm-policy",
        command: "node",
        args: Object.freeze(["scripts/pnpm-release-age-policy.mjs"]),
      }),
      ciAfter: "corepack setup",
      verifyAll: Object.freeze({
        label: "check:pnpm-policy",
        command: "pnpm",
        args: Object.freeze(["run", "check:pnpm-policy"]),
      }),
      verifyAllAfter: "check:node",
      reason: "CI runs the policy script directly before invoking pnpm; local verify:all proves the Node floor first, then uses the package-script wrapper.",
    }),
    Object.freeze({
      label: "check:dependency-vulnerabilities",
      ci: Object.freeze({
        label: "check:dependency-vulnerabilities",
        command: "pnpm",
        args: Object.freeze(["run", "check:dependency-vulnerabilities"]),
      }),
      ciAfter: "dependency install",
      ciNodeVersion: MINIMUM_NODE_VERSION,
      verifyAll: Object.freeze({
        label: "check:dependency-vulnerabilities",
        command: "pnpm",
        args: Object.freeze(["run", "check:dependency-vulnerabilities"]),
      }),
      verifyAllAfter: "check:licenses",
      reason: "CI runs the production advisory gate immediately after its frozen install on the minimum-Node leg; local verify:all runs it after license policy on every supported runtime.",
    }),
  ]),
  matrixDifferences: Object.freeze([
    Object.freeze({
      label: "check:dependency-vulnerabilities",
      ciCondition: `\${{ matrix.node-version == '${MINIMUM_NODE_VERSION}' }}`,
      ciNodeVersion: MINIMUM_NODE_VERSION,
      verifyAllOnlyGate: Object.freeze({
        label: "check:dependency-vulnerabilities",
        command: "pnpm",
        args: Object.freeze(["run", "check:dependency-vulnerabilities"]),
      }),
      reason: "CI audits production dependencies once on the minimum-Node leg; verify:all runs the same fail-closed audit on every supported local runtime.",
    }),
    Object.freeze({
      label: "release:consumer",
      ciCondition: `\${{ matrix.node-version == '${MINIMUM_NODE_VERSION}' }}`,
      ciNodeVersion: MINIMUM_NODE_VERSION,
      verifyAllOnlyGate: Object.freeze({
        label: "release:consumer",
        command: "pnpm",
        args: Object.freeze(["run", "release:consumer", "--", "--tag", CI_RELEASE_TAG_EXPRESSION]),
      }),
      reason: "CI runs the packed consumer only on the minimum-Node leg; verify:all also smoke-tests it on newer supported Node versions without --require-minimum.",
    }),
  ]),
});

export function createRepoGate({ releaseTag, nodeVersion = process.versions.node }) {
  const packedConsumerArgs = ["run", "release:consumer", "--", "--tag", releaseTag];
  if (nodeVersion === MINIMUM_NODE_VERSION) {
    packedConsumerArgs.push("--require-minimum");
  }

  return [
    { label: "check:node", command: "pnpm", args: ["run", "check:node"] },
    { label: "check:pnpm-policy", command: "pnpm", args: ["run", "check:pnpm-policy"] },
    { label: "check:secrets", command: "pnpm", args: ["run", "check:secrets"] },
    { label: "check:oss-hygiene", command: "pnpm", args: ["run", "check:oss-hygiene"] },
    { label: "check:licenses", command: "pnpm", args: ["run", "check:licenses"] },
    {
      label: "check:dependency-vulnerabilities",
      command: "pnpm",
      args: ["run", "check:dependency-vulnerabilities"],
    },
    { label: "check:codex-discoverability", command: "pnpm", args: ["run", "check:codex-discoverability"] },
    {
      label: "check:consumer-docs-consistency",
      command: "pnpm",
      args: ["run", "check:consumer-docs-consistency"],
    },
    {
      label: "check:getting-started-version-pins",
      command: "pnpm",
      args: ["run", "check:getting-started-version-pins"],
    },
    { label: "check:docs", command: "pnpm", args: ["run", "check:docs"] },
    { label: "release:validate", command: "pnpm", args: ["run", "release:validate", "--", "--tag", releaseTag] },
    { label: "check:architecture", command: "pnpm", args: ["run", "check:architecture"] },
    { label: "build", command: "pnpm", args: ["run", "build"] },
    { label: "check:doc-snippets", command: "pnpm", args: ["run", "check:doc-snippets"] },
    { label: "check:deep-imports", command: "pnpm", args: ["run", "check:deep-imports"] },
    {
      label: "verify:consumers",
      command: "pnpm",
      args: ["run", "verify:consumers", "--skip-build"],
      runner: "verifyConsumers",
    },
    { label: "release:pack", command: "pnpm", args: ["run", "release:pack", "--", "--tag", releaseTag] },
    { label: "release:consumer", command: "pnpm", args: packedConsumerArgs },
    { label: "typecheck", command: "pnpm", args: ["run", "typecheck"] },
    { label: "test", command: "pnpm", args: ["run", "test"] },
    { label: "test:demo", command: "pnpm", args: ["run", "test:demo"] },
    { label: "git diff --check", command: "git", args: ["diff", "--check"] },
  ];
}

export function readReleaseSmokeTag(cwd, readFile = readFileSync) {
  const manifest = JSON.parse(readFile(resolve(cwd, "packages/agent-app/package.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("packages/agent-app/package.json must contain a version for release smoke checks.");
  }
  return `v${manifest.version}`;
}

export function parseVerifyAllArgs(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false };
}

export async function runVerifyAll(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandStdio;
  const verifyConsumers = options.verifyConsumers ?? runVerifyConsumers;

  let parsed;
  try {
    parsed = parseVerifyAllArgs(argv);
  } catch (error) {
    stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    stdout.write(renderFinalSummary({ repoOk: false, alphaOk: false, betaOk: false }));
    return { exitCode: 1 };
  }

  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  const releaseTag = options.releaseTag ?? readReleaseSmokeTag(cwd);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  let repoOk = true;
  let consumersAttempted = false;
  let consumersOk = false;
  let alphaOk = false;
  let betaOk = false;
  for (const command of createRepoGate({ releaseTag, nodeVersion })) {
    if (command.runner === "verifyConsumers") {
      consumersAttempted = true;
      const consumerResult = await verifyConsumers({
        argv: command.args.slice(2),
        cwd,
        stdout,
        stderr,
        runCommand,
        writeOutput: true,
      });
      alphaOk = consumerResult.statusByLabel.get("local-agent-alpha contract") === true;
      betaOk = consumerResult.statusByLabel.get("local-agent-beta contract") === true;
      consumersOk = consumerResult.exitCode === 0 && alphaOk && betaOk;
      if (!consumersOk) {
        repoOk = false;
        stderr.write("Consumer gate failed at verify:consumers; later repo gates skipped.\n");
        break;
      }
      continue;
    }

    const result = await runCommand(command.command, command.args, { cwd, label: command.label });
    if (result !== 0) {
      repoOk = false;
      stderr.write(`Repo gate failed at ${command.label}.\n`);
      break;
    }
  }

  if (!consumersAttempted) {
    stderr.write("Consumer verification skipped because the repo gate is not green.\n");
  }

  stdout.write(renderFinalSummary({ repoOk, alphaOk, betaOk }));
  return {
    exitCode: repoOk && consumersOk ? 0 : 1,
  };
}

export function renderFinalSummary(input) {
  const verificationOk = input.repoOk && input.alphaOk && input.betaOk;
  return [
    "final summary",
    `repo ${input.repoOk ? "ok" : "fail"}`,
    `local-agent-alpha contract ${input.alphaOk ? "ok" : "fail"}`,
    `local-agent-beta contract ${input.betaOk ? "ok" : "fail"}`,
    `verification ${verificationOk ? "green" : "failed"}`,
  ].join("\n") + "\n";
}

async function runCommandStdio(command, args, options) {
  return await new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
    });
    child.on("error", () => resolveExit(1));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

function usage() {
  return [
    "Usage:",
    "  pnpm run verify:all",
    "",
    "Runs the CI-aligned repo gate, including consumer/docs consistency, pnpm and dependency-vulnerability policy checks, consumer contracts immediately after build, release validation, package packing, and a packed-consumer smoke test.",
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runVerifyAll();
  process.exitCode = result.exitCode;
}
