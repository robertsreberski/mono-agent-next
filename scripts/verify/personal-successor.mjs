#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertProofNodeVersion, captureCleanGitHead } from "../lib/system-proof.mjs";
import {
  assertPersonalSuccessorBlueprint,
  readPersonalSuccessorBlueprint,
  renderPersonalSuccessorProducts,
} from "../lib/personal-successor.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMAND_TIMEOUT_MS = 1_200_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export function personalSuccessorCommands() {
  return Object.freeze([
    Object.freeze({
      label: "packed-system",
      command: "pnpm",
      args: Object.freeze(["run", "verify:system"]),
    }),
    Object.freeze({
      label: "operator-products",
      command: "pnpm",
      args: Object.freeze(["run", "verify:operator-products"]),
    }),
    Object.freeze({
      label: "service-lifecycle",
      command: "pnpm",
      args: Object.freeze(["--filter", "@mono-agent/service-macos", "test"]),
    }),
  ]);
}

export function parsePersonalSuccessorArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length === 0) return { contractOnly: false };
  if (normalized.length === 1 && normalized[0] === "--contract-only") {
    return { contractOnly: true };
  }
  if (
    normalized.length === 1
    && (normalized[0] === "--help" || normalized[0] === "-h")
  ) {
    return { help: true };
  }
  throw new Error(`Unknown argument: ${normalized.join(" ")}`);
}

export async function runPersonalSuccessorProof(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? REPO_ROOT;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandDefault;
  const parsed = parsePersonalSuccessorArgs(argv);
  if (parsed.help === true) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  const node = assertProofNodeVersion(options.nodeVersion ?? process.versions.node);
  const version = packageVersion(cwd);
  const loaded = readPersonalSuccessorBlueprint(cwd);
  const blueprint = assertPersonalSuccessorBlueprint(loaded.blueprint, version);
  const rendered = renderPersonalSuccessorProducts(loaded.fixtureRoot, "/example/personal-agent-next");
  const source = parsed.contractOnly
    ? { commitSha: options.sourceSha ?? "contract-only", clean: true }
    : options.captureSource?.() ?? captureCleanGitHead({ repo: cwd });
  const completed = [];

  if (!parsed.contractOnly) {
    for (const step of personalSuccessorCommands()) {
      stdout.write(`personal-successor: ${step.label}\n`);
      const result = await runCommand(step.command, step.args, {
        cwd,
        label: step.label,
      });
      if (result !== 0) {
        stderr.write(`Personal successor proof failed at ${step.label}.\n`);
        return { exitCode: result, completed };
      }
      completed.push(step.label);
    }
  }

  const evidence = {
    schema: "mono-agent.personal-successor-proof.v1",
    result: "passed",
    sourceSha: source.commitSha,
    nodeVersion: node.nodeVersion,
    packageVersion: blueprint.packageVersion,
    blueprintSha256: loaded.sha256,
    dependencyCount: blueprint.directDependencies.length,
    excludedPackages: blueprint.excludedPackages,
    renderedProducts: Object.keys(rendered).sort(),
    completed,
    browserCompanion: blueprint.proofs.browser,
    browserNode: "22.19.0",
    externalNetworkServices: 0,
    serviceMutation: "fake launchctl and temporary LaunchAgents only",
  };
  stdout.write(`${JSON.stringify(evidence)}\n`);
  return { exitCode: 0, completed, evidence };
}

function packageVersion(root) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "packages", "core", "package.json"), "utf8"),
  );
  if (manifest.name !== "@mono-agent/core" || typeof manifest.version !== "string") {
    throw new Error("Could not resolve the current @mono-agent/core version.");
  }
  return manifest.version;
}

function runCommandDefault(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    let killTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal !== null) {
        rejectPromise(new Error(
          `${basename(command)} ${args.join(" ")} exited via ${signal}.`,
        ));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

function usage() {
  return [
    "Usage:",
    "  pnpm run verify:personal-successor",
    "  pnpm run verify:personal-successor -- --contract-only",
  ].join("\n");
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const result = await runPersonalSuccessorProof();
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
