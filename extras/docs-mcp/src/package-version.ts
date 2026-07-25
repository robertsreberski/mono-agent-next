// SPDX-License-Identifier: MIT
import { createRequire } from "node:module";

export function docsMcpPackageVersion(): string {
  const value = createRequire(import.meta.url)("../package.json") as { readonly version?: unknown };
  if (typeof value.version !== "string" || value.version.trim().length === 0) {
    throw new Error("@mono-agent/docs-mcp package version is unavailable.");
  }
  return value.version.trim();
}
