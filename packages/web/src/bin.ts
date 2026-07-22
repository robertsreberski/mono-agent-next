#!/usr/bin/env node
import { resolve } from "node:path";

import { startWebServer } from "./server.js";

const configPath = resolve(process.argv[2] ?? "web.config.json");

try {
  const server = await startWebServer({ configPath });
  process.stdout.write(`mono-agent web listening at ${server.url}\n`);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.stop();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
