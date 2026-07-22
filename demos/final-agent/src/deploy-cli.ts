#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkOllamaModel,
  DEFAULT_FINAL_DEMO_DEPLOY_MODEL,
  DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL,
  modelReferenceFor,
  writeFinalDemoDeploymentFiles,
} from "./deployment.js";
import { startFinalAgentDemo } from "./final-demo.js";
import type { A2AStatus, TraceabilityStatus } from "./final-demo.js";

interface DeployCliArgs {
  readonly model: string;
  readonly ollamaBaseUrl: string;
  readonly configPath?: string;
  readonly a2aPort?: number;
  readonly noStart: boolean;
  readonly help: boolean;
}

async function main(): Promise<void> {
  const args = parseDeployCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const readiness = await checkOllamaModel({
    model: args.model,
    ollamaBaseUrl: args.ollamaBaseUrl,
  });
  if (readiness.kind !== "ready") {
    printReadinessFailure(readiness);
    process.exitCode = 1;
    return;
  }

  const files = await writeFinalDemoDeploymentFiles({
    cwd: process.cwd(),
    model: args.model,
    ollamaBaseUrl: args.ollamaBaseUrl,
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    ...(args.a2aPort === undefined ? {} : { a2aPort: args.a2aPort }),
  });

  const modelReference = modelReferenceFor(args.model);
  if (args.noStart) {
    console.log("final-demo deploy config written");
    console.log(`config:         ${files.configPath}`);
    console.log(`model:          ${modelReference}`);
    console.log(`ollama:         ${readiness.baseUrl}`);
    console.log(`trace-source:   final-agent-gemma4`);
    console.log(`trace-registry: ${files.traceRegistryDir}`);
    console.log(`artifacts:      ${files.artifactDir}`);
    console.log("start:          skipped (--no-start)");
    return;
  }

  const demo = await startFinalAgentDemo({
    env: process.env,
    cwd: process.cwd(),
    configPath: files.configPath,
    logger: console,
  });

  console.log(`config:           ${files.configPath}`);
  console.log("edits:            edit the config JSON, then restart the deployment to apply changes");
  console.log(`model:            ${modelReference}`);
  console.log(`ollama:           ${readiness.baseUrl}`);
  printTraceabilityStatus(demo.traceabilityStatus);
  printA2AStatus(demo.a2aStatus);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal}: stopping final demo deployment`);
    try {
      await demo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

export function parseDeployCliArgs(argv: readonly string[]): DeployCliArgs {
  let model = DEFAULT_FINAL_DEMO_DEPLOY_MODEL;
  let ollamaBaseUrl = DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL;
  let configPath: string | undefined;
  let a2aPort: number | undefined;
  let noStart = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--no-start") {
      noStart = true;
      continue;
    }
    if (arg === "--model") {
      model = readStringArg(argv, i, "--model");
      i += 1;
      continue;
    }
    if (arg === "--ollama-url") {
      ollamaBaseUrl = readStringArg(argv, i, "--ollama-url");
      i += 1;
      continue;
    }
    if (arg === "--config") {
      configPath = readStringArg(argv, i, "--config");
      i += 1;
      continue;
    }
    if (arg === "--a2a-port") {
      a2aPort = readPortArg(argv, i, "--a2a-port");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    model,
    ollamaBaseUrl,
    noStart,
    help,
    ...(configPath === undefined ? {} : { configPath }),
    ...(a2aPort === undefined ? {} : { a2aPort }),
  };
}

function readStringArg(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} requires a value.`);
  }
  return value.trim();
}

function readPortArg(argv: readonly string[], index: number, name: string): number {
  const value = readStringArg(argv, index, name);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} requires a numeric port.`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} must be between 0 and 65535.`);
  }
  return port;
}

function printReadinessFailure(readiness: Exclude<Awaited<ReturnType<typeof checkOllamaModel>>, { readonly kind: "ready" }>): void {
  if (readiness.kind === "model_missing") {
    console.error(`Ollama model ${readiness.model} is not installed at ${readiness.baseUrl}.`);
    if (readiness.availableModels.length > 0) {
      console.error(`Available models: ${readiness.availableModels.join(", ")}`);
    }
    console.error(`Install it with: ollama pull ${readiness.model}`);
    return;
  }
  console.error(`Ollama is not reachable at ${readiness.baseUrl}: ${readiness.reason}`);
  console.error("Start Ollama and verify it with: curl http://localhost:11434/api/tags");
}

function printTraceabilityStatus(status: TraceabilityStatus): void {
  if (status.kind === "running") {
    console.log(`trace-source:     ${status.sourceId}`);
    console.log(`trace-registry:   ${status.registryDir}`);
    console.log(`artifacts:        ${status.artifactDir}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log(`traceability:     disabled - ${status.reason}`);
    return;
  }
  console.log(`traceability:     failed - ${status.reason}`);
}

function printA2AStatus(status: A2AStatus): void {
  if (status.kind === "running") {
    console.log(`a2a-agent-card:   ${status.agentCardUrl}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log(`a2a:              disabled - ${status.reason}`);
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`a2a:              waiting_for_config - ${status.reason}`);
    return;
  }
  console.log(`a2a:              failed - ${status.reason}`);
}

function printHelp(): void {
  console.log(`Usage: pnpm run deploy:final -- [options]\n\nWrites a local final-demo deployment config, checks Ollama for Gemma 4, then starts the headless A2A provider with traceability enabled. Config edits apply on restart.\n\nOptions:\n  --model <tag>        Ollama model tag (default: ${DEFAULT_FINAL_DEMO_DEPLOY_MODEL})\n  --ollama-url <url>   Ollama base URL (default: ${DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL})\n  --config <path>      Generated config path (default: ./.mono-agent/deploy/final-agent-gemma4.config.json)\n  --a2a-port <port>    A2A provider port (default: 0, choose a free loopback port)\n  --no-start           Write files and verify Ollama, but do not start the demo\n  -h, --help           Show this help`);
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
