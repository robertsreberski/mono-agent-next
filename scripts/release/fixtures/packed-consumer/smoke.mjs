import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parsePackedSmokeArgs,
  publicExportSpecifiers,
} from "./public-exports.mjs";

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const { target } = parsePackedSmokeArgs(process.argv.slice(2));
const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
if (target !== null && !dependencyNames.includes(target)) {
  throw new Error(`Packed smoke target ${target} is not installed as a direct consumer dependency.`);
}
const packageNames = target === null ? dependencyNames : [target];
const packageManifests = new Map();
for (const name of packageNames) {
  packageManifests.set(name, await readInstalledManifest(name));
}
const importSpecifiers = packageNames.flatMap((name) =>
  publicExportSpecifiers(name, packageManifests.get(name)));

for (const specifier of importSpecifiers) {
  if (specifier.endsWith("/package.json")) {
    await import(specifier, { with: { type: "json" } });
  } else {
    await import(specifier);
  }
}

const cliSmokes = [
  { packageName: "@mono-agent/cli", binName: "mono-agent", args: ["--help"], statuses: [0] },
  { packageName: "@mono-agent/tui", binName: "mono-agent-tui", args: ["--help"], statuses: [0] },
  { packageName: "create-mono-agent", binName: "create-mono-agent", args: ["--help"], statuses: [0] },
];
const selectedCliSmokes = cliSmokes.filter((entry) => packageNames.includes(entry.packageName));
for (const entry of selectedCliSmokes) {
  const packageJson = packageManifests.get(entry.packageName);
  const relativeCli = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.[entry.binName];
  if (typeof relativeCli !== "string") {
    throw new Error(`Packed ${entry.packageName} is missing bin ${entry.binName}.`);
  }
  const cli = join(installedPackageDirectory(entry.packageName), relativeCli);
  const { status, stderr } = await runNodeCli(cli, entry.args);
  if (!entry.statuses.includes(status)) {
    throw new Error(`${cli} ${entry.args.join(" ")} exited ${status}: ${stderr}`);
  }
  if (entry.stderrIncludes !== undefined && !stderr.includes(entry.stderrIncludes)) {
    throw new Error(
      `${cli} ${entry.args.join(" ")} stderr must contain ${JSON.stringify(entry.stderrIncludes)}: ${stderr}`,
    );
  }
}

const scope = target === null ? "consumer" : `isolated ${target} consumer`;
console.log(`Packed ${scope} imported ${importSpecifiers.length} public export(s) and ran ${selectedCliSmokes.length} CLI(s).`);

async function readInstalledManifest(name) {
  return JSON.parse(await readFile(join(installedPackageDirectory(name), "package.json"), "utf8"));
}

function installedPackageDirectory(name) {
  return join(process.cwd(), "node_modules", ...name.split("/"));
}

async function runNodeCli(cli, args) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: 1, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stderr }));
  });
}
