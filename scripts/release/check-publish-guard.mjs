#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
export const SUCCESSOR_GUARD_HEADING = "## Successor bootstrap safety";

export function assertPublishingAllowed(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const instructionsPath = path.join(repo, "AGENTS.md");
  let instructions;
  try {
    instructions = fs.readFileSync(instructionsPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`refusing to publish: cannot read ${instructionsPath}: ${reason}`);
  }
  if (instructions.split(/\r?\n/u).includes(SUCCESSOR_GUARD_HEADING)) {
    throw new Error(
      "refusing to publish: successor bootstrap safety guard is present in AGENTS.md; remove it only during the reviewed canonical-repository cutover",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertPublishingAllowed();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
