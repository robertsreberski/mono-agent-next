#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultConsumerNames = ["local-agent-alpha", "local-agent-beta"];

export function parseVerifyConsumersArgs(argv) {
  const consumers = [];
  let skipBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, skipBuild, consumers };
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--consumer") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--consumer requires a path.");
      }
      consumers.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, skipBuild, consumers };
}

export async function runVerifyConsumers(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandStdio;
  const writeOutput = options.writeOutput ?? true;

  let parsed;
  try {
    parsed = parseVerifyConsumersArgs(argv);
  } catch (error) {
    stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    return failedConsumerRun("argument parsing failed");
  }

  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0, results: [], statusByLabel: new Map() };
  }

  if (!parsed.skipBuild) {
    const buildResult = await runCommand("pnpm", ["--filter", "@mono-agent/agent-app...", "--sort", "run", "build"], { cwd });
    if (buildResult !== 0) {
      const results = defaultConsumerNames.map((name) => ({
        label: `${name} contract`,
        ok: false,
        details: ["skipped because the dependency build failed"],
      }));
      return finishConsumerRun({
        stdout,
        writeOutput,
        results,
      });
    }
  }

  let dependencies;
  try {
    dependencies = options.dependencies ?? await loadRuntimeDependencies();
  } catch (error) {
    const results = defaultConsumerNames.map((name) => ({
      label: `${name} contract`,
      ok: false,
      details: [`could not load verifier dependencies: ${reasonOf(error)}`],
    }));
    return finishConsumerRun({
      stdout,
      writeOutput,
      results,
    });
  }

  const results = [];
  const fixtureRoot = join(cwd, "packages", "agent-app", "src", "__tests__", "fixtures", "consumers");
  for (const name of dependencies.consumerContractNames) {
    const result = await dependencies.validateConsumerContractFixture({
      name,
      fixtureDir: join(fixtureRoot, name),
      env: {},
    });
    results.push({
      label: `${name} contract`,
      ok: result.ok,
      details: result.issues.map((issue) => `${issue.check}: ${issue.message}`),
    });
  }

  for (const consumerPath of parsed.consumers) {
    results.push(await runConsumerArtifactAudit(consumerPath, { cwd, dependencies }));
  }

  return finishConsumerRun({
    stdout,
    writeOutput,
    results,
  });
}

function failedConsumerRun(message) {
  const results = defaultConsumerNames.map((name) => ({
    label: `${name} contract`,
    ok: false,
    details: [message],
  }));
  return {
    exitCode: 1,
    results,
    statusByLabel: statusByLabel(results),
  };
}

function finishConsumerRun(input) {
  const aggregateOk = input.results.every((result) => result.ok);
  const results = [
    ...input.results,
    {
      label: "consumers",
      ok: aggregateOk,
      details: aggregateOk ? [] : ["one or more consumer checks failed"],
    },
  ];
  if (input.writeOutput) {
    input.stdout.write(renderConsumerResults(results));
  }
  return {
    exitCode: aggregateOk ? 0 : 1,
    results,
    statusByLabel: statusByLabel(results),
  };
}

export function renderConsumerResults(results) {
  const lines = [];
  for (const result of results) {
    const prefix = result.ok ? "PASS" : "FAIL";
    const details = result.details.length === 0 ? "" : `: ${result.details.join("; ")}`;
    lines.push(`${prefix} ${result.label}${details}`);
  }
  lines.push("consumer verification summary");
  for (const result of results) {
    lines.push(`${result.label} ${result.ok ? "ok" : "fail"}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runConsumerArtifactAudit(consumerPath, input) {
  const consumerDir = resolve(input.cwd, consumerPath);
  try {
    const configPath = join(consumerDir, "mono-agent.config.json");
    const configInput = { env: {}, cwd: consumerDir, configPath };
    const artifactDir = await input.dependencies.resolveAppArtifactDir(configInput);
    const staleAfterMs = await input.dependencies.resolveAppTraceStaleAfterMs(configInput);
    const report = await input.dependencies.auditRecordedRuns(artifactDir, { staleAfterMs });
    const details = auditFailureDetails(report);
    return {
      label: `${basename(consumerDir)} artifact audit`,
      ok: details.length === 0,
      details: details.length === 0
        ? [`${report.parsedSummaryFiles}/${report.totalSummaryFiles} summaries parsed`]
        : details,
    };
  } catch (error) {
    return {
      label: `${basename(consumerDir)} artifact audit`,
      ok: false,
      details: [reasonOf(error)],
    };
  }
}

function auditFailureDetails(report) {
  const details = [];
  if (report.parseFailureCount > 0) {
    details.push(`${report.parseFailureCount} parse failure(s)`);
  }
  if (report.unrecognizedStatusCount > 0) {
    details.push(`${report.unrecognizedStatusCount} unrecognized status value(s)`);
  }
  if (report.unrecognizedFailureKindCount > 0) {
    details.push(`${report.unrecognizedFailureKindCount} unrecognized failure kind value(s)`);
  }
  if (report.staleRunningCount > 0) {
    details.push(`${report.staleRunningCount} stale running summary file(s)`);
  }
  if (report.warnings.length > 0) {
    details.push(...report.warnings.map((warning) => `warning: ${warning}`));
  }
  return details;
}

function statusByLabel(results) {
  return new Map(results.map((result) => [result.label, result.ok]));
}

async function loadRuntimeDependencies() {
  const importPackage = Function("specifier", "return import(specifier)");
  const agentApp = await importPackage("@mono-agent/agent-app");
  const observability = await importPackage("@mono-agent/observability");
  return {
    consumerContractNames: agentApp.consumerContractNames,
    validateConsumerContractFixture: agentApp.validateConsumerContractFixture,
    resolveAppArtifactDir: agentApp.resolveAppArtifactDir,
    resolveAppTraceStaleAfterMs: agentApp.resolveAppTraceStaleAfterMs,
    auditRecordedRuns: observability.auditRecordedRuns,
  };
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
    "  pnpm run verify:consumers",
    "  pnpm run verify:consumers --skip-build",
    "  pnpm run verify:consumers --consumer <path>",
    "  pnpm run verify:consumers --consumer <path> --skip-build",
    "",
    "Default mode validates committed golden-consumer fixtures with liveness:false.",
    "--consumer <path> can be repeated to add read-only artifact audits for downstream folders.",
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runVerifyConsumers();
  process.exitCode = result.exitCode;
}
