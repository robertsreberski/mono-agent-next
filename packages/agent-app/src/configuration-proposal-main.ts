#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  configurationProposalChildSettingsFromEnv,
  createConfigurationProposalServer,
} from "./configuration-proposal-tool.js";

async function main(): Promise<void> {
  const settings = configurationProposalChildSettingsFromEnv(process.env);
  const server = createConfigurationProposalServer(settings);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`mono-agent-configuration-proposal: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
