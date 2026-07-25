#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gitleaksArgs = ["dir", "--redact", "--no-banner", "--config", ".gitleaks.toml", "."];

export async function runCheckSecrets(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandDefault;

  const result = await runCommand("gitleaks", gitleaksArgs, { cwd });
  if (result.status === 127) {
    stderr.write([
      "gitleaks is required for pnpm run check:secrets.",
      "Install it with: brew install gitleaks",
      "Other install options: https://github.com/gitleaks/gitleaks#installing",
      "",
    ].join("\n"));
    return { exitCode: result.status };
  }

  stdout.write(result.stdout);
  stderr.write(result.stderr);
  return { exitCode: result.status };
}

async function runCommandDefault(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: error.code === "ENOENT" ? 127 : typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error),
    };
  }
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runCheckSecrets();
  process.exitCode = result.exitCode;
}
