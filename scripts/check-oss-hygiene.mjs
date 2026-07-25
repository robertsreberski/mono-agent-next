#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const publicHomePathNames = new Set(["example", "me", "runner", "u", "user"]);
const homePathPattern =
  /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+Users[\\/]+)([^/\\\s"'`<>]+)/giu;
const authorFile = "AUTHORS.md";
const personalEmailPattern = new RegExp(
  `${["roberts", "reberski"].join("")}@${["gmail", "com"].join("\\.")}`,
  "giu",
);
const identifierBoundaryStart = "(?<![A-Za-z0-9])";
const identifierBoundaryEnd = "(?![A-Za-z0-9])";
const identifierSeparator = "[\\s/_.-]+";
const privateReferenceRules = Object.freeze([
  Object.freeze({
    // A gate that a contributor can switch off in the file under review is not
    // a gate. Skipped tests and coverage/mutation pragmas disarm the very
    // checks that are supposed to bind the change introducing them.
    // `skipIf`/`runIf` are deliberately NOT banned: they are environment guards
    // (platform, tool availability, Node version), not disabled tests.
    label: "disabled-test",
    pattern: /\b(?:it|test|describe)\s*\.\s*(?:skip(?!If)|only|todo|fails)\s*\(/gu,
  }),
  Object.freeze({
    label: "coverage-or-mutation-pragma",
    pattern: /(?:^|\s)(?:\/\*|\/\/)\s*(?:v8|c8|istanbul)\s+ignore\b|Stryker\s+disable\b/gu,
  }),
  Object.freeze({
    label: "employer-reference",
    pattern: new RegExp(
      `${identifierBoundaryStart}${["a8", "c"].join("")}${identifierBoundaryEnd}`,
      "giu",
    ),
  }),
  Object.freeze({
    label: "private-fleet-path",
    pattern: new RegExp(
      `~/(?:${["personal", "agent"].join("-")}|${["a8", "c", "agents"].join("-")})(?:/|${identifierBoundaryEnd})`,
      "giu",
    ),
  }),
  Object.freeze({
    label: "private-service-identifier",
    pattern: new RegExp(
      `${["personal", "agent", "059657c8"].join("-")}|${identifierBoundaryStart}(?:${[
        ["45", "99"].join(""),
        ["54", "17"].join(""),
        ["54", "18"].join(""),
        ["54", "19"].join(""),
        ["54", "20"].join(""),
      ].join("|")})${identifierBoundaryEnd}`,
      "giu",
    ),
  }),
  Object.freeze({
    label: "private-persona-reference",
    pattern: new RegExp(
      [
        ["Sleep", "Ambra"],
        ["Ambra", "Sleep"],
        ["Therapy", "Council"],
        ["Inner", "Child"],
      ].map(([first, second]) =>
        `${identifierBoundaryStart}${first}${identifierSeparator}${second}${identifierBoundaryEnd}`)
        .join("|"),
      "giu",
    ),
  }),
]);
const redactedTrackedPath = "[redacted-tracked-path]";

export function scanOssHygieneRecords(records) {
  const findings = [];

  for (const record of records) {
    const pathFindings = scanPathForPrivateReferences(record.path);
    const safeFile = pathFindings.length > 0 ? redactedTrackedPath : record.path;
    findings.push(...pathFindings);
    if (record.isUnsafeSymlink === true) {
      findings.push({
        file: safeFile,
        line: 0,
        column: 1,
        label: "tracked-symlink",
      });
    }
    if (record.text === undefined) continue;
    findings.push(...scanTextForPrivateReferences(record.text, safeFile));
    findings.push(...scanTextForHomePaths(record.text, safeFile));
    if (record.path !== authorFile) {
      findings.push(...scanPattern(
        record.text,
        safeFile,
        personalEmailPattern,
        "personal-email-outside-authors",
      ));
    }
  }

  return findings.sort(compareFindings);
}

export async function runCheckOssHygiene(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandDefault;

  const listed = await runCommand("git", ["ls-files", "-z"], { cwd });
  if (listed.status !== 0) {
    stderr.write(listed.stderr.length > 0 ? listed.stderr : "git ls-files failed\n");
    return { exitCode: 1, findings: [] };
  }

  const records = [];
  for (const path of listed.stdout.split("\0").filter(Boolean).sort()) {
    const record = { path, text: undefined, isUnsafeSymlink: false };
    let handle;
    try {
      const absolutePath = resolve(cwd, path);
      const listedDetails = await lstat(absolutePath);
      if (listedDetails.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const resolvedTarget = resolve(dirname(absolutePath), target);
        const targetWithinRepo = relative(cwd, resolvedTarget);
        record.text = target;
        record.isUnsafeSymlink = isAbsolute(target)
          || targetWithinRepo === ".."
          || targetWithinRepo.startsWith(`..${sep}`)
          || isAbsolute(targetWithinRepo);
        records.push(record);
        continue;
      }
      if (!listedDetails.isFile()) {
        records.push(record);
        continue;
      }
      handle = await open(
        absolutePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const openedDetails = await handle.stat();
      if (
        !openedDetails.isFile()
        || openedDetails.dev !== listedDetails.dev
        || openedDetails.ino !== listedDetails.ino
      ) {
        records.push(record);
        continue;
      }
      const buffer = await handle.readFile();
      if (!buffer.includes(0)) record.text = buffer.toString("utf8");
    } catch {
      // Deleted or unreadable tracked files are not hygiene findings.
    } finally {
      await handle?.close();
    }
    records.push(record);
  }

  const findings = scanOssHygieneRecords(records);
  stdout.write(renderOssHygieneReport(findings));
  return { exitCode: findings.length === 0 ? 0 : 1, findings };
}

export function renderOssHygieneReport(findings) {
  if (findings.length === 0) return "OSS hygiene check passed\n";

  const lines = [
    "OSS hygiene check failed",
    `Findings: ${findings.length}`,
  ];
  for (const finding of findings.sort(compareFindings)) {
    lines.push(`  ${finding.file}:${finding.line}:${finding.column} label=${finding.label}`);
  }
  return `${lines.join("\n")}\n`;
}

function scanTextForPrivateReferences(text, file) {
  return privateReferenceRules.flatMap((rule) =>
    scanPattern(text, file, rule.pattern, rule.label));
}

function scanPathForPrivateReferences(path) {
  const labels = new Set();
  for (const rule of privateReferenceRules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(path)) labels.add(rule.label);
  }
  personalEmailPattern.lastIndex = 0;
  if (personalEmailPattern.test(path)) labels.add("personal-email-outside-authors");
  if (scanTextForHomePaths(`/${path.replace(/^\/+/u, "")}`, redactedTrackedPath).length > 0) {
    labels.add("non-example-home-path");
  }
  return [...labels].map((label) => ({
    file: redactedTrackedPath,
    line: 0,
    column: 1,
    label,
  }));
}

function scanTextForHomePaths(text, file) {
  const findings = [];
  homePathPattern.lastIndex = 0;
  for (const match of text.matchAll(homePathPattern)) {
    const username = match[1]?.toLowerCase();
    if (username === undefined || publicHomePathNames.has(username)) continue;
    const location = locationForIndex(text, match.index ?? 0);
    findings.push({
      file,
      line: location.line,
      column: location.column,
      label: "non-example-home-path",
    });
  }
  return findings;
}

function scanPattern(text, file, pattern, label) {
  const findings = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const location = locationForIndex(text, match.index ?? 0);
    findings.push({ file, line: location.line, column: location.column, label });
  }
  return findings;
}

function locationForIndex(text, index) {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function compareFindings(a, b) {
  return a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.label.localeCompare(b.label);
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
      status: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error),
    };
  }
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runCheckOssHygiene();
  process.exitCode = result.exitCode;
}
