#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DISABLED_RELEASE_AGE_POLICY_COMMENT =
  "Package release-age cooldown is explicitly disabled across supported pnpm versions.";

const RELEASE_AGE_NPMRC_KEYS = new Set([
  "minimumreleaseage",
  "minimumreleaseageexclude",
]);

export function validatePnpmReleaseAgePolicy(input) {
  const issues = [];
  const minimumReleaseAge = input.minimumReleaseAge;
  const parsedExclusions = parseExclusions(input.minimumReleaseAgeExclude, issues);
  const npmrcKeys = releaseAgeNpmrcKeys(input.npmrcSource ?? "");

  if (minimumReleaseAge === undefined) {
    issues.push(
      "minimumReleaseAge must be explicit because pnpm 10 and pnpm 11 have different defaults.",
    );
  } else if (!Number.isSafeInteger(minimumReleaseAge) || minimumReleaseAge < 0) {
    issues.push("minimumReleaseAge must be a non-negative safe integer number of minutes.");
  }

  if (npmrcKeys.length > 0) {
    issues.push(
      `Release-age policy must live only in pnpm-workspace.yaml; remove ${npmrcKeys.join(", ")} from .npmrc.`,
    );
  }

  if (minimumReleaseAge === 0) {
    if (input.minimumReleaseAgeExclude !== undefined) {
      issues.push(
        "minimumReleaseAgeExclude must be absent while minimumReleaseAge is 0.",
      );
    }
    if (!hasDisabledPolicyComment(input.workspaceSource)) {
      issues.push(
        `Workspace must state "${DISABLED_RELEASE_AGE_POLICY_COMMENT}" while the cooldown is disabled.`,
      );
    }
  } else if (Number.isSafeInteger(minimumReleaseAge) && minimumReleaseAge > 0) {
    if (hasDisabledPolicyComment(input.workspaceSource)) {
      issues.push(
        `Workspace comment says "${DISABLED_RELEASE_AGE_POLICY_COMMENT}" but minimumReleaseAge is positive.`,
      );
    }
  }

  if (Number.isSafeInteger(minimumReleaseAge) && minimumReleaseAge >= 0) {
    issues.push(...validatePnpmVersionContract({
      currentPnpmVersion: input.currentPnpmVersion,
      packageManager: input.packageManager,
      pnpmEngine: input.pnpmEngine,
      requiredVersion: minimumPnpmVersionForPolicy(parsedExclusions),
    }));
  }

  return {
    exclusions: parsedExclusions,
    issues,
    minimumReleaseAge,
  };
}

export function minimumPnpmVersionForPolicy(exclusions) {
  let required = [10, 16, 0];
  for (const selector of exclusions) {
    const kind = classifyExclusionSelector(selector);
    if (kind === "version") {
      required = maxVersion(required, [10, 19, 0]);
    } else if (kind === "pattern") {
      required = maxVersion(required, [10, 17, 0]);
    }
  }
  return required;
}

export function classifyExclusionSelector(selector) {
  if (selector.includes("||") || hasPackageVersionSuffix(selector)) {
    return "version";
  }
  return selector.startsWith("!") || selector.includes("*") ? "pattern" : "package";
}

export function validatePnpmVersionContract(input) {
  const issues = [];
  const requiredLabel = input.requiredVersion.join(".");
  const packageManagerVersion = parseExactPackageManagerVersion(input.packageManager);
  const pnpmEngineVersion = parsePnpmEngineFloor(input.pnpmEngine);
  const packageManagerSatisfies = packageManagerVersion !== undefined
    && compareVersions(packageManagerVersion, input.requiredVersion) >= 0;
  const pnpmEngineSatisfies = pnpmEngineVersion !== undefined
    && compareVersions(pnpmEngineVersion, input.requiredVersion) >= 0;

  if (!packageManagerSatisfies && !pnpmEngineSatisfies) {
    issues.push(
      `Release-age policy requires packageManager to pin pnpm >=${requiredLabel} or engines.pnpm to enforce >=${requiredLabel}.`,
    );
  }

  const currentVersion = parseVersion(input.currentPnpmVersion);
  if (currentVersion === undefined) {
    issues.push("Could not determine the running pnpm version for release-age policy verification.");
  } else if (compareVersions(currentVersion, input.requiredVersion) < 0) {
    issues.push(`Running pnpm must be >=${requiredLabel} for the configured release-age policy.`);
  }

  return issues;
}

export function parsePnpmConfigGetOutput(output, key) {
  const value = output.trim();
  if (value === "" || value === "undefined") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`pnpm config get ${key} did not return JSON (${reasonOf(error)}).`);
  }
}

export async function runCheckPnpmReleaseAgePolicy(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const readText = options.readText ?? readFile;
  const runPnpm = options.runPnpm ?? runPnpmCommand;
  const baseEnv = options.env ?? process.env;

  if (argv.length > 0) {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      stdout.write(`${usage()}\n`);
      return { exitCode: 0 };
    }
    stderr.write(`Unknown argument: ${argv[0]}\n\n${usage()}\n`);
    return { exitCode: 1 };
  }

  let packageJson;
  let workspaceSource;
  let npmrcSource;
  try {
    packageJson = JSON.parse(await readText(join(cwd, "package.json"), "utf8"));
    workspaceSource = await readText(join(cwd, "pnpm-workspace.yaml"), "utf8");
    npmrcSource = await readOptionalText(join(cwd, ".npmrc"), readText);
  } catch (error) {
    stderr.write(`ERROR Could not read release-age policy inputs: ${reasonOf(error)}\n`);
    return { exitCode: 1 };
  }

  const commands = [
    // Let the selected pnpm parse the workspace YAML; raw-line matching misses valid key syntax.
    ["minimumReleaseAge", ["config", "get", "minimumReleaseAge", "--location=project", "--json"]],
    ["minimumReleaseAgeExclude", ["config", "get", "minimumReleaseAgeExclude", "--location=project", "--json"]],
  ];
  const outputs = new Map();
  let pnpmVersion;
  let isolatedConfig;
  try {
    isolatedConfig = await createIsolatedPnpmConfigEnvironment(baseEnv);
    const versionResult = await runPnpm(["--version"], { cwd, env: isolatedConfig.env });
    if (versionResult.status !== 0) {
      stderr.write(`ERROR pnpm --version failed: ${versionResult.stderr.trim() || "unknown error"}\n`);
      return { exitCode: 1 };
    }
    pnpmVersion = versionResult.stdout.trim();
    const parsedPnpmVersion = parseVersion(pnpmVersion);
    if (parsedPnpmVersion === undefined || compareVersions(parsedPnpmVersion, [10, 16, 0]) < 0) {
      stderr.write("ERROR Running pnpm must be >=10.16.0 to read the release-age policy.\n");
      return { exitCode: 1 };
    }

    for (const [label, args] of commands) {
      const result = await runPnpm(args, { cwd, env: isolatedConfig.env });
      if (result.status !== 0) {
        stderr.write(`ERROR pnpm ${args.join(" ")} failed: ${result.stderr.trim() || "unknown error"}\n`);
        return { exitCode: 1 };
      }
      outputs.set(label, result.stdout);
    }
  } catch (error) {
    stderr.write(`ERROR Could not run isolated pnpm policy probes: ${reasonOf(error)}\n`);
    return { exitCode: 1 };
  } finally {
    if (isolatedConfig !== undefined) {
      await rm(isolatedConfig.directory, { recursive: true, force: true });
    }
  }

  if (pnpmVersion === undefined) {
    stderr.write("ERROR Could not determine the running pnpm version.\n");
    return { exitCode: 1 };
  }

  let minimumReleaseAge;
  let minimumReleaseAgeExclude;
  try {
    minimumReleaseAge = parsePnpmConfigGetOutput(
      outputs.get("minimumReleaseAge") ?? "",
      "minimumReleaseAge",
    );
    minimumReleaseAgeExclude = parsePnpmConfigGetOutput(
      outputs.get("minimumReleaseAgeExclude") ?? "",
      "minimumReleaseAgeExclude",
    );
  } catch (error) {
    stderr.write(`ERROR ${reasonOf(error)}\n`);
    return { exitCode: 1 };
  }

  const validation = validatePnpmReleaseAgePolicy({
    currentPnpmVersion: pnpmVersion,
    minimumReleaseAge,
    minimumReleaseAgeExclude,
    npmrcSource,
    packageManager: packageJson.packageManager,
    pnpmEngine: packageJson.engines?.pnpm,
    workspaceSource,
  });
  if (validation.issues.length > 0) {
    for (const issue of validation.issues) {
      stderr.write(`ERROR ${issue}\n`);
    }
    return { exitCode: 1 };
  }

  stdout.write(
    `pnpm release-age policy passed: minimumReleaseAge=${validation.minimumReleaseAge}; `
      + `${validation.exclusions.length} exclusion(s).\n`,
  );
  return { exitCode: 0 };
}

function parseExclusions(value, issues) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("minimumReleaseAgeExclude must be absent or a list of non-empty strings.");
    return [];
  }
  const exclusions = [];
  for (const selector of value) {
    if (typeof selector !== "string" || selector.length === 0) {
      issues.push("minimumReleaseAgeExclude entries must be non-empty strings.");
      continue;
    }
    if (selector.trim() !== selector) {
      issues.push("minimumReleaseAgeExclude entries must not have surrounding whitespace.");
      continue;
    }
    if (/[?[\]{}]/u.test(selector)) {
      issues.push(
        "minimumReleaseAgeExclude entries must not use unsupported pattern metacharacters (?, [], or {}).",
      );
      continue;
    }
    exclusions.push(selector);
  }
  return exclusions;
}

function hasDisabledPolicyComment(source) {
  return source.split(/\r?\n/u).includes(`# ${DISABLED_RELEASE_AGE_POLICY_COMMENT}`);
}

function releaseAgeNpmrcKeys(source) {
  const keys = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const rawKey = line.slice(0, separator).trim().replace(/\[\]$/u, "");
    const normalizedKey = rawKey.replaceAll("-", "").replaceAll("_", "").toLowerCase();
    if (RELEASE_AGE_NPMRC_KEYS.has(normalizedKey)) {
      keys.push(rawKey);
    }
  }
  return [...new Set(keys)].sort();
}

function hasPackageVersionSuffix(selector) {
  const lastAt = selector.lastIndexOf("@");
  if (!selector.startsWith("@")) {
    return lastAt > 0;
  }
  const slash = selector.indexOf("/");
  return slash !== -1 && lastAt > slash;
}

function parseExactPackageManagerVersion(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+(sha224|sha256|sha384|sha512)\.([a-f\d]+))?$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const version = safeVersionComponents(match.slice(1, 4));
  if (version === undefined || match[4] === undefined) {
    return version;
  }
  const expectedHashLength = {
    sha224: 56,
    sha256: 64,
    sha384: 96,
    sha512: 128,
  }[match[4].toLowerCase()];
  return match[5].length === expectedHashLength ? version : undefined;
}

function parsePnpmEngineFloor(value) {
  // Accept a deliberately small, auditable range subset and fail closed on anything ambiguous.
  if (typeof value !== "string" || value.includes("||")) {
    return undefined;
  }
  const match = /^>=\s*v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:\s+(<=|<)\s*v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?)?$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const lower = safeVersionComponents([
    match[1],
    match[2] ?? "0",
    match[3] ?? "0",
  ]);
  if (lower === undefined || match[4] === undefined) {
    return lower;
  }
  const upper = safeVersionComponents([
    match[5],
    match[6] ?? "0",
    match[7] ?? "0",
  ]);
  if (upper === undefined) {
    return undefined;
  }
  const comparison = compareVersions(lower, upper);
  return comparison < 0 || (comparison === 0 && match[4] === "<=") ? lower : undefined;
}

function parseVersion(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value.trim());
  return match === null ? undefined : safeVersionComponents(match.slice(1, 4));
}

function safeVersionComponents(components) {
  const parsed = components.map(Number);
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
}

function maxVersion(left, right) {
  return compareVersions(left, right) >= 0 ? left : right;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

async function readOptionalText(path, readText) {
  try {
    return await readText(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function runPnpmCommand(args, options) {
  const npmExecPath = options.env?.npm_execpath ?? process.env.npm_execpath;
  const useRunningPnpm = npmExecPath !== undefined
    && /^pnpm(?:\.[cm]?js)?$/u.test(basename(npmExecPath));
  const command = useRunningPnpm ? process.execPath : "pnpm";
  const commandArgs = useRunningPnpm ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? result.error?.message ?? "",
    stdout: result.stdout ?? "",
  };
}

async function createIsolatedPnpmConfigEnvironment(baseEnv) {
  const directory = await mkdtemp(join(tmpdir(), "mono-agent-pnpm-policy-"));
  try {
    const userConfig = join(directory, "user.npmrc");
    const globalConfig = join(directory, "global.npmrc");
    const xdgConfigHome = join(directory, "xdg");
    await mkdir(xdgConfigHome);
    await Promise.all([
      writeFile(userConfig, "", "utf8"),
      writeFile(globalConfig, "", "utf8"),
    ]);

    // Config reads must represent committed project policy, not a developer's user/global/env state.
    const env = { ...baseEnv };
    for (const key of Object.keys(env)) {
      const normalized = key.toLowerCase();
      const match = /^(?:npm|pnpm)_config_(.+)$/u.exec(normalized);
      if (match !== null) {
        const configKey = match[1].replaceAll("_", "").replaceAll("-", "");
        if (RELEASE_AGE_NPMRC_KEYS.has(configKey)
          || configKey === "userconfig"
          || configKey === "globalconfig") {
          delete env[key];
        }
      }
    }
    Object.assign(env, {
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_USERCONFIG: userConfig,
      PNPM_CONFIG_GLOBALCONFIG: globalConfig,
      PNPM_CONFIG_USERCONFIG: userConfig,
      XDG_CONFIG_HOME: xdgConfigHome,
      npm_config_globalconfig: globalConfig,
      npm_config_userconfig: userConfig,
      pnpm_config_globalconfig: globalConfig,
      pnpm_config_userconfig: userConfig,
    });
    return { directory, env };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return "Usage: node scripts/pnpm-release-age-policy.mjs";
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const result = await runCheckPnpmReleaseAgePolicy();
  process.exitCode = result.exitCode;
}
