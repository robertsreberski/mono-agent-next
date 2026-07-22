#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./package-graph.mjs";
import { validateRelease } from "./validate-release.mjs";

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function cleanRegistryEnv() {
  return {
    ...process.env,
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
}

// First-time publishes can take several minutes to propagate to the
// public registry reads, so allow ~5 minutes per package.
function retry(command, args) {
  let lastOutput = "";
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: cleanRegistryEnv(),
    });
    lastOutput = `${result.stdout || ""}${result.stderr || ""}`;
    if (result.status === 0) {
      // Only stdout is machine output; npm config warnings land on stderr.
      return (result.stdout || "").trim();
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error(`${command} ${args.join(" ")} failed after retries:\n${lastOutput.trim()}`);
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  const { publishablePackages } = validateRelease({ tag, silent: true });

  for (const pkg of publishablePackages) {
    const version = retry("npm", [
      "view",
      `${pkg.name}@${pkg.version}`,
      "version",
      "--json",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
    console.log(`${pkg.name}@${JSON.parse(version)} verified on npm`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
