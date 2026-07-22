#!/usr/bin/env node
import { parseCliArgs } from "./cli-args.js";
import { startFinalAgentDemo } from "./final-demo.js";
import type { A2AStatus, CronStatus, OpenAIApiStatus, TelegramStatus, TraceabilityStatus, WebhookStatus } from "./final-demo.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const demo = await startFinalAgentDemo({
    env: process.env,
    cwd: process.cwd(),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
    logger: console,
  });

  console.log(`config:    ${demo.configPath}`);
  console.log("edits:     edit the config JSON, then restart the demo to apply changes");
  printTraceabilityStatus(demo.traceabilityStatus);
  printTelegramStatus(demo.telegramStatus);
  printA2AStatus(demo.a2aStatus);
  printWebhookStatus(demo.webhookStatus);
  printOpenAIApiStatus(demo.openAIApiStatus);
  printCronStatus(demo.cronStatus);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal} — stopping final demo`);
    try {
      await demo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

function printTraceabilityStatus(status: TraceabilityStatus): void {
  if (status.kind === "running") {
    console.log(`trace:     running - ${status.sourceId}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log(`trace:     disabled - ${status.reason}`);
    return;
  }
  console.log(`trace:     failed - ${status.reason}`);
}

function printTelegramStatus(status: TelegramStatus): void {
  if (status.kind === "running") {
    console.log("telegram:  running");
    return;
  }
  if (status.kind === "disabled") {
    console.log(`telegram:  disabled — ${status.reason}`);
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`telegram:  waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`telegram:  failed — ${status.reason}`);
}

function printA2AStatus(status: A2AStatus): void {
  if (status.kind === "running") {
    console.log(`a2a:       running — ${status.agentCardUrl}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log("a2a:       disabled");
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`a2a:       waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`a2a:       failed — ${status.reason}`);
}

function printWebhookStatus(status: WebhookStatus): void {
  if (status.kind === "running") {
    console.log(`webhook:   running — ${status.invokeUrl}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log("webhook:   disabled");
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`webhook:   waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`webhook:   failed — ${status.reason}`);
}

function printOpenAIApiStatus(status: OpenAIApiStatus): void {
  if (status.kind === "running") {
    console.log(`openai:    running — ${status.baseUrl}`);
    return;
  }
  if (status.kind === "disabled") {
    console.log("openai:    disabled");
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`openai:    waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`openai:    failed — ${status.reason}`);
}

function printCronStatus(status: CronStatus): void {
  if (status.kind === "running") {
    console.log(`cron:      running — ${status.jobs} job(s)`);
    return;
  }
  if (status.kind === "disabled") {
    console.log("cron:      disabled");
    return;
  }
  if (status.kind === "waiting_for_config") {
    console.log(`cron:      waiting_for_config — ${status.reason}`);
    return;
  }
  console.log(`cron:      failed — ${status.reason}`);
}

function printHelp(): void {
  console.log(`Usage: pnpm run demo:final -- [--config <path>]\n\nStarts the headless final demo: traceability first, then optional Telegram, A2A, webhook, OpenAI API, and cron adapters once mono-agent.config.json is valid. Config edits apply on restart.\n\nOptions:\n  --config <path>  Config file path (default: ./mono-agent.config.json)\n  -h, --help       Show this help`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
