import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

interface AgentAppManifest {
  readonly bin?: string | Record<string, string>;
}

/**
 * Resolves the absolute path of `@mono-agent/agent-app`'s `mono-agent` CLI entry
 * from the installed dependency's own `package.json` `bin` field.
 *
 * Reading the `bin` path from the manifest (rather than hardcoding `dist/cli.js`)
 * means this survives any install layout — npm/npx global, pnpm-linked — and any
 * future change to agent-app's bin location. We resolve it through CJS
 * `require.resolve` of `@mono-agent/agent-app/package.json` (which agent-app
 * exports), so this works throughout the supported Node range without depending on
 * synchronous `import.meta.resolve` (available throughout the supported Node 22.19.0+ range).
 */
export function resolveAgentAppCliEntry(from: string | URL = import.meta.url): string {
  const require = createRequire(from);
  let manifestPath: string;
  try {
    manifestPath = require.resolve("@mono-agent/agent-app/package.json");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the create-mono-agent installer could not find @mono-agent/agent-app (its CLI host) — reinstall it (\`npm i -g create-mono-agent\`). (${reason})`,
    );
  }
  const manifest = require("@mono-agent/agent-app/package.json") as AgentAppManifest;
  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin : bin?.["mono-agent"];
  if (typeof relative !== "string" || relative.length === 0) {
    throw new Error("@mono-agent/agent-app does not declare a `mono-agent` bin; cannot delegate.");
  }
  return resolve(dirname(manifestPath), relative);
}
