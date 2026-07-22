#!/usr/bin/env node
import { resolve } from "node:path";

import { startMonoAgentTui } from "../runtime/start.js";
import { sanitizeTerminalText } from "../ui/terminal-text.js";
import { exitWithError, HELP_TEXT, parseArgs } from "./cli.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) exitWithError(parsed.error);
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (process.stdin.isTTY !== true) {
    exitWithError("stdin is not a TTY; inject a Terminal through the programmatic API for tests");
  }
  const tokenEnvironment = parsed.endpoint === undefined
    ? undefined
    : parsed.tokenEnvironment ?? "MONO_AGENT_OPERATOR_TOKEN";
  const token = tokenEnvironment === undefined ? undefined : process.env[tokenEnvironment];
  if (tokenEnvironment !== undefined && (token === undefined || token.length === 0)) {
    exitWithError(`environment variable ${tokenEnvironment} is empty or missing`);
  }

  const handle = await startMonoAgentTui({
    ...(parsed.endpoint === undefined ? {} : { endpoint: parsed.endpoint }),
    ...(token === undefined || token.length === 0 ? {} : { token }),
    ...(parsed.registryDirectories.length === 0
      ? {}
      : { registryDirectories: parsed.registryDirectories.map((directory) => resolve(directory)) }),
    ...(parsed.operatorId === undefined ? {} : { operatorId: parsed.operatorId }),
    ...(parsed.conversationId === undefined ? {} : { conversationId: parsed.conversationId }),
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
  });
  await handle.waitUntilExit();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mono-agent-tui: ${sanitizeTerminalText(message)}\n`);
  process.exitCode = 1;
});
