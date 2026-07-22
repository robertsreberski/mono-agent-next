#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMemoryRecallServer, createRecallStore, memoryRecallSettingsFromEnv } from "./memory-recall.js";

async function main(): Promise<void> {
  const settings = memoryRecallSettingsFromEnv(process.env);
  const store = await createRecallStore(settings);
  const server = createMemoryRecallServer(store);
  // Registering these listeners overrides Node's default terminate-on-signal, so we must exit
  // explicitly. store.close() drains/closes the db before the process leaves.
  const shutdown = (): void => {
    void store
      .close()
      .catch((error: unknown) => {
        // Don't let a failed close become an unhandled rejection; log to stderr (stdout is the MCP
        // transport) and still exit so the signal isn't swallowed.
        process.stderr.write(`mono-agent-memory-recall: shutdown close failed: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`mono-agent-memory-recall: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
