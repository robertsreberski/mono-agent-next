#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_LINE_LENGTH_MAXIMUM = 140;
export const SOURCE_LINE_LENGTH_PATHS = Object.freeze([
  "packages/core/src/current-run-output.ts",
  "packages/core/src/state-execution-client.ts",
]);

export function collectSourceLineLengthFindings(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const readFile = options.readFile ?? readFileSync;
  const findings = [];

  for (const path of SOURCE_LINE_LENGTH_PATHS) {
    const source = readFile(resolve(cwd, path), "utf8");
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      const length = [...line].length;
      if (length > SOURCE_LINE_LENGTH_MAXIMUM) {
        findings.push(Object.freeze({
          path,
          line: index + 1,
          length,
        }));
      }
    }
  }

  return Object.freeze(findings);
}

export function renderSourceLineLengthReport(findings) {
  if (findings.length === 0) {
    return `Source line-length check passed (${String(SOURCE_LINE_LENGTH_PATHS.length)} files, `
      + `maximum ${String(SOURCE_LINE_LENGTH_MAXIMUM)} characters)\n`;
  }
  return [
    `Source line-length check failed (${String(findings.length)} overlong line(s))`,
    ...findings.map((finding) =>
      `${finding.path}:${String(finding.line)} has ${String(finding.length)} characters `
      + `(maximum ${String(SOURCE_LINE_LENGTH_MAXIMUM)})`),
    "",
  ].join("\n");
}

export function runCheckSourceLineLength(options = {}) {
  const findings = collectSourceLineLengthFindings(options);
  const stdout = options.stdout ?? process.stdout;
  stdout.write(renderSourceLineLengthReport(findings));
  return Object.freeze({
    exitCode: findings.length === 0 ? 0 : 1,
    findings,
  });
}

const isCli = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  process.exitCode = runCheckSourceLineLength().exitCode;
}
