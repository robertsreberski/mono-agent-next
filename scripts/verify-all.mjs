#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MINIMUM_NODE_VERSION } from "./node-version.mjs";
import {
  packageCatalog,
  packageRelativePath,
} from "./package-catalog.mjs";
import { runVerifyConsumers } from "./verify-consumers.mjs";

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
    {
      label: "check:source-beta-docs",
      command: "pnpm",
      args: ["run", "check:source-beta-docs"],
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
    { label: "git diff --check", command: "git", args: ["diff", "--check"] },
  ];
}

export function readReleaseSmokeTag(
  cwd,
  readFile = readFileSync,
  catalog = packageCatalog,
) {
  const publishable = catalog.filter((entry) => entry.publishable === true);
  if (publishable.length === 0) {
    throw new Error("The publishable package roster is empty.");
  }
  let lockstepVersion;
  let lockstepPackage;
  for (const entry of publishable) {
    const manifestPath = resolve(cwd, packageRelativePath(entry), "package.json");
    const manifest = JSON.parse(readFile(manifestPath, "utf8"));
    if (manifest.name !== entry.name) {
      throw new Error(
        `${manifestPath} must describe ${entry.name}; found ${String(manifest.name)}.`,
      );
    }
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
      throw new Error(`${manifestPath} must contain a version for release smoke checks.`);
    }
    if (lockstepVersion === undefined) {
      lockstepVersion = manifest.version;
      lockstepPackage = manifest.name;
      continue;
    }
    if (manifest.version !== lockstepVersion) {
      throw new Error(
        `Publishable packages must share one lockstep version; `
        + `${lockstepPackage}@${lockstepVersion} differs from ${manifest.name}@${manifest.version}.`,
      );
    }
  }
  return `v${lockstepVersion}`;
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
    stdout.write(renderFinalSummary({
      repoOk: false,
      minimalOk: false,
      personalOk: false,
      multiRuntimeOk: false,
    }));
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
  let minimalOk = false;
  let personalOk = false;
  let multiRuntimeOk = false;
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
      minimalOk = consumerResult.statusByLabel.get("minimal template contract") === true;
      personalOk = consumerResult.statusByLabel.get("personal template contract") === true;
      multiRuntimeOk =
        consumerResult.statusByLabel.get("multi-runtime template contract") === true;
      consumersOk =
        consumerResult.exitCode === 0
        && minimalOk
        && personalOk
        && multiRuntimeOk;
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

  stdout.write(renderFinalSummary({
    repoOk,
    minimalOk,
    personalOk,
    multiRuntimeOk,
  }));
  return {
    exitCode: repoOk && consumersOk ? 0 : 1,
  };
}

export function renderFinalSummary(input) {
  const verificationOk =
    input.repoOk
    && input.minimalOk
    && input.personalOk
    && input.multiRuntimeOk;
  return [
    "final summary",
    `repo ${input.repoOk ? "ok" : "fail"}`,
    `minimal template contract ${input.minimalOk ? "ok" : "fail"}`,
    `personal template contract ${input.personalOk ? "ok" : "fail"}`,
    `multi-runtime template contract ${input.multiRuntimeOk ? "ok" : "fail"}`,
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
