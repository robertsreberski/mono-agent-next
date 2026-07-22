import { createRequire } from "node:module";

/** The installed agent-app version, used for exact lockstep plugin guidance. */
export function agentAppPackageVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { readonly version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim().length > 0
      ? pkg.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
