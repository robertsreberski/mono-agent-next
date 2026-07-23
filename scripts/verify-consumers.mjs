#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TEMPLATES = Object.freeze(["minimal", "personal", "multi-runtime"]);
const REQUIRED_CONSUMER_PACKAGES = Object.freeze([
  "@mono-agent/cli",
  "@mono-agent/core",
  "@mono-agent/module-sdk",
]);
const FORBIDDEN_PREDECESSOR_PACKAGES = Object.freeze([
  "@mono-agent/agent-app",
  "@mono-agent/agent-runtime",
  "@mono-agent/runtime-adapter",
  "@mono-agent/slack-adapter",
  "@mono-agent/telegram-adapter",
  "@mono-agent/webhook-adapter",
]);
const TEMPLATE_ENVIRONMENT = Object.freeze({
  CLAUDE_CODE_OAUTH_TOKEN: "source-contract-claude-token",
  MONO_AGENT_OPENAI_API_KEY: "source-contract-openai-token-0000000001",
  MONO_AGENT_OPERATOR_TOKEN: "source-contract-operator-token-0000000000000001",
  MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  MONO_AGENT_WEBHOOK_API_KEY: "source-contract-personal-webhook-token",
  MONO_AGENT_WEBHOOK_SIGNATURE_SECRET: "source-contract-personal-signature-secret-0001",
  PERSONAL_AGENT_TELEGRAM_CHAT_ID: "123456789",
  WEBHOOK_API_KEY: "source-contract-webhook-token",
});

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
  const verifySourceContract = options.verifySourceContract ?? verifyGeneratedSourceContract;
  const verifyConsumerContract = options.verifyConsumerContract ?? verifyExistingConsumerContract;

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
    const buildResult = await runCommand("pnpm", ["run", "build"], { cwd });
    if (buildResult !== 0) {
      return finishConsumerRun({
        stdout,
        writeOutput,
        results: sourceContractFailures("skipped because the workspace build failed"),
      });
    }
  }

  let dependencies;
  try {
    dependencies = options.dependencies ?? await loadRuntimeDependencies();
  } catch (error) {
    return finishConsumerRun({
      stdout,
      writeOutput,
      results: sourceContractFailures(`could not load verifier dependencies: ${reasonOf(error)}`),
    });
  }

  const templates = [...dependencies.projectTemplates];
  if (!sameStrings(templates, DEFAULT_TEMPLATES)) {
    return finishConsumerRun({
      stdout,
      writeOutput,
      results: sourceContractFailures(
        `create-mono-agent templates must be exactly ${DEFAULT_TEMPLATES.join(", ")}; found ${templates.join(", ")}`,
      ),
    });
  }

  const results = [];
  for (const template of templates) {
    results.push(await verifySourceContract(template, { cwd, dependencies }));
  }
  for (const consumerPath of parsed.consumers) {
    results.push(await verifyConsumerContract(consumerPath, { cwd, dependencies }));
  }

  return finishConsumerRun({ stdout, writeOutput, results });
}

async function verifyGeneratedSourceContract(template, input) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-agent-source-consumer-"));
  const consumerDirectory = join(temporaryRoot, template);
  const label = sourceContractLabel(template);
  try {
    await input.dependencies.scaffoldAgent({
      targetDirectory: template,
      cwd: temporaryRoot,
      projectName: `mono-agent-${template}-consumer`,
      template,
      install: false,
    });

    const manifest = await readJson(join(consumerDirectory, "package.json"));
    const configPath = join(consumerDirectory, "mono-agent.config.json");
    const config = await readJson(configPath);
    const selectedPackages = collectSelectedPackages(config);
    const expectedDependencies = [...new Set([
      ...REQUIRED_CONSUMER_PACKAGES,
      ...selectedPackages,
    ])].sort(compareText);
    const actualDependencies = Object.keys(manifest.dependencies ?? {}).sort(compareText);
    if (!sameStrings(actualDependencies, expectedDependencies)) {
      throw new Error(
        `direct dependencies must be exactly ${expectedDependencies.join(", ")}; `
        + `found ${actualDependencies.join(", ")}`,
      );
    }

    const serializedAuthority = JSON.stringify({ config, manifest });
    for (const packageName of FORBIDDEN_PREDECESSOR_PACKAGES) {
      if (serializedAuthority.includes(packageName)) {
        throw new Error(`consumer authority retains predecessor package ${packageName}`);
      }
    }

    await symlink(
      join(input.cwd, "node_modules"),
      join(consumerDirectory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeSourceConsumerLock(consumerDirectory, manifest, input.cwd);

    const validation = await input.dependencies.validateAgentConfig(configPath, {
      environment: TEMPLATE_ENVIRONMENT,
    });
    if (!validation.ok || validation.loaded === undefined) {
      throw new Error(renderValidationIssues(validation.issues));
    }
    const loadedPackages = validation.loaded.modules.map((module) => module.packageName).sort(compareText);
    if (!sameStrings(loadedPackages, [...selectedPackages].sort(compareText))) {
      throw new Error(
        `Core loaded ${loadedPackages.join(", ")}; selected ${selectedPackages.join(", ")}`,
      );
    }

    const cliOutput = sink();
    const cliError = sink();
    const cliExit = await withProcessEnvironment(TEMPLATE_ENVIRONMENT, () =>
      input.dependencies.runCli(
        ["validate", "--config", configPath, "--json"],
        {
          cwd: consumerDirectory,
          stdout: (text) => cliOutput.write(text),
          stderr: (text) => cliError.write(text),
        },
      ));
    if (cliExit !== 0) {
      throw new Error(`@mono-agent/cli exited ${String(cliExit)}: ${cliError.text || cliOutput.text}`);
    }
    const cliResult = JSON.parse(cliOutput.text);
    if (cliResult.ok !== true || cliError.text.length > 0) {
      throw new Error(`@mono-agent/cli did not validate the generated config: ${cliOutput.text}${cliError.text}`);
    }

    return {
      label,
      ok: true,
      details: [
        `${String(selectedPackages.length)} selected module(s) validated through public scaffold, CLI, and Core APIs`,
      ],
    };
  } catch (error) {
    return { label, ok: false, details: [reasonOf(error)] };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyExistingConsumerContract(consumerPath, input) {
  const consumerDirectory = resolve(input.cwd, consumerPath);
  const label = `${basename(consumerDirectory)} config contract`;
  try {
    const result = await input.dependencies.validateAgentConfig(
      join(consumerDirectory, "mono-agent.config.json"),
    );
    if (!result.ok) {
      return {
        label,
        ok: false,
        details: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
      };
    }
    return {
      label,
      ok: true,
      details: [`${String(result.loaded?.modules.length ?? 0)} selected module(s) validated`],
    };
  } catch (error) {
    return { label, ok: false, details: [reasonOf(error)] };
  }
}

async function writeSourceConsumerLock(consumerDirectory, manifest, cwd) {
  const packages = {
    "": {
      dependencies: manifest.dependencies ?? {},
    },
  };
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    const installed = await readJson(join(cwd, "node_modules", ...packageName.split("/"), "package.json"));
    if (typeof installed.version !== "string" || installed.version.length === 0) {
      throw new Error(`${packageName} has no installed version`);
    }
    if (manifest.dependencies[packageName] !== installed.version) {
      throw new Error(
        `${packageName} source consumer pin ${String(manifest.dependencies[packageName])} `
        + `does not match installed ${installed.version}`,
      );
    }
    packages[`node_modules/${packageName}`] = { version: installed.version };
  }
  await writeFile(
    join(consumerDirectory, "package-lock.json"),
    `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages,
    }, null, 2)}\n`,
    "utf8",
  );
}

function collectSelectedPackages(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectSelectedPackages(entry, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (Object.hasOwn(value, "$use")) {
    if (typeof value.$use !== "string" || value.$use.length === 0) {
      throw new Error("selected module $use must be a non-empty package name");
    }
    output.push(value.$use);
  }
  for (const child of Object.values(value)) collectSelectedPackages(child, output);
  return output;
}

function failedConsumerRun(message) {
  const results = sourceContractFailures(message);
  return {
    exitCode: 1,
    results,
    statusByLabel: statusByLabel(results),
  };
}

function sourceContractFailures(message) {
  return DEFAULT_TEMPLATES.map((template) => ({
    label: sourceContractLabel(template),
    ok: false,
    details: [message],
  }));
}

function sourceContractLabel(template) {
  return `${template} template contract`;
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
  if (input.writeOutput) input.stdout.write(renderConsumerResults(results));
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
  for (const result of results) lines.push(`${result.label} ${result.ok ? "ok" : "fail"}`);
  return `${lines.join("\n")}\n`;
}

function statusByLabel(results) {
  return new Map(results.map((result) => [result.label, result.ok]));
}

async function loadRuntimeDependencies() {
  const importPackage = Function("specifier", "return import(specifier)");
  const [createMonoAgent, core, cli] = await Promise.all([
    importPackage("create-mono-agent"),
    importPackage("@mono-agent/core"),
    importPackage("@mono-agent/cli"),
  ]);
  return {
    projectTemplates: createMonoAgent.PROJECT_TEMPLATES,
    scaffoldAgent: createMonoAgent.scaffoldAgent,
    validateAgentConfig: core.validateAgentConfig,
    runCli: cli.runCli,
  };
}

async function withProcessEnvironment(environment, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function renderValidationIssues(issues) {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
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
    "Default mode scaffolds and validates the minimal, personal, and multi-runtime source contracts.",
    "--consumer <path> can be repeated to validate an installed downstream mono-agent config read-only.",
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
