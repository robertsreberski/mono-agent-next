#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { docsMcpPackageVersion } from "./package-version.js";
import { loadDefaultDocsSearchIndex } from "./search.js";
import { createMonoAgentDocsMcpServer } from "./server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const index = await loadDefaultDocsSearchIndex();
    process.stdout.write(`${JSON.stringify({
      package: "@mono-agent/docs-mcp",
      version: docsMcpPackageVersion(),
      docsVersion: index.manifest.docsVersion,
      corpusDigest: index.manifest.corpusDigest,
      model: index.manifest.model,
    })}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--check") {
    const index = await loadDefaultDocsSearchIndex();
    const result = await index.search({
      query: "How do I configure fallback models?",
      limit: 3,
    });
    if (result.results.length === 0) {
      throw new Error("Documentation corpus check returned no results.");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  if (args.length > 0) {
    throw new Error("Usage: mono-agent-docs-mcp [--check|--version]");
  }

  const server = createMonoAgentDocsMcpServer();
  const close = async (): Promise<void> => {
    await server.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
