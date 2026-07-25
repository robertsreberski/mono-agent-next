#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Getting-started install docs used to carry literal `@mono-agent/<pkg>@X.Y.Z`
 * pins that silently rotted one release behind (goal #164 E-evidence: docs pinned
 * `0.4.0` while the packages had already shipped `0.4.1`). This check reads the
 * lockstep version from `packages/module-sdk/package.json` and fails whenever any
 * version pin in the getting-started docs disagrees with it — so a pin is either
 * current or the docs go versionless (the preferred, un-rottable form). A shell
 * placeholder like `@mono-agent/module-sdk@$version` is NOT a pin and is ignored.
 *
 * Covers the scoped `@mono-agent/<pkg>@X.Y.Z` pins, the unscoped
 * `create-mono-agent@X.Y.Z` installer, and (still) the bare `mono-agent@X.Y.Z`
 * form — all release in the same lockstep, so any pinned `npm i -g …@X.Y.Z` in
 * these docs must track the same version. (The bare `mono-agent` name is no longer
 * published, but the pattern is kept so an accidental stale pin can't slip in.)
 */

const GETTING_STARTED_DIR = join("docs", "getting-started");
const LOCKSTEP_PACKAGE_JSON = join("packages", "module-sdk", "package.json");

// A literal, concrete version pin for the scoped `@mono-agent/<name>`, the
// unscoped `create-mono-agent` installer, or the bare `mono-agent` name. The
// leading negative lookbehind stops a shorter alternative from matching inside a
// longer name (e.g. the `mono-agent` inside `@mono-agent/…` — preceded by `@` — or
// inside `create-mono-agent` — preceded by `-`); the longer `create-mono-agent`
// alternative is listed before `mono-agent` so it wins. The version must start
// with a digit, so `$version` / `<published-version>` placeholders and dist-tags
// (`@latest`) never match.
const VERSION_PIN_PATTERN =
  /(?<![\w@/-])(?:@mono-agent\/[a-z0-9-]+|create-mono-agent|mono-agent)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu;

/**
 * @param {{ repoRoot?: string, docRecords?: { path: string, text: string }[], lockstepVersion?: string }} [options]
 * @returns {Promise<{ lockstepVersion: string, pins: { path: string, line: number, pin: string, version: string }[], issues: string[] }>}
 */
export async function checkGettingStartedVersionPins(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? cliRepoRoot());
  const lockstepVersion = options.lockstepVersion ?? await readLockstepVersion(repoRoot);
  const docRecords = options.docRecords ?? await readGettingStartedDocs(repoRoot);

  const pins = [];
  const issues = [];
  for (const record of docRecords) {
    for (const match of record.text.matchAll(VERSION_PIN_PATTERN)) {
      const version = match[1];
      const line = record.text.slice(0, match.index).split("\n").length;
      pins.push({ path: record.path, line, pin: match[0], version });
      if (version !== lockstepVersion) {
        issues.push(
          `${record.path}:${line}: version pin \`${match[0]}\` disagrees with the lockstep ` +
            `@mono-agent version \`${lockstepVersion}\`. Update the pin or make the docs versionless.`,
        );
      }
    }
  }

  return { lockstepVersion, pins, issues };
}

async function readLockstepVersion(repoRoot) {
  const raw = await readFile(join(repoRoot, LOCKSTEP_PACKAGE_JSON), "utf8");
  const version = JSON.parse(raw).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${LOCKSTEP_PACKAGE_JSON} has no version field.`);
  }
  return version;
}

async function readGettingStartedDocs(repoRoot) {
  const dir = join(repoRoot, GETTING_STARTED_DIR);
  const entries = await readdir(dir, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === ".md") {
      const path = join(dir, entry.name);
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

function cliRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function main() {
  const result = await checkGettingStartedVersionPins();
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      process.stderr.write(`ERROR ${issue}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Getting-started version pins OK: ${result.pins.length} pin(s) checked against ` +
      `@mono-agent/module-sdk@${result.lockstepVersion}.\n`,
  );
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await main();
}
