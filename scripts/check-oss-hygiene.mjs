#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const consumerFixturePrefix = "packages/agent-app/src/__tests__/fixtures/consumers/";
const publicConsumerFixtureNames = new Set(["local-agent-alpha", "local-agent-beta"]);
const publicHomePathNames = new Set(["example", "me", "runner", "u", "user"]);
const homePathPattern = /\/(?:Users|home)\/([^/\s"'`<>]+)/gu;

export function scanOssHygieneRecords(records) {
  const disallowedConsumerNames = collectDisallowedConsumerNames(records);
  const findings = [];

  for (const record of records) {
    const fixtureName = consumerFixtureNameFromPath(record.path);
    const safeFile = sanitizeFilePath(record.path, disallowedConsumerNames);
    if (fixtureName !== undefined && !publicConsumerFixtureNames.has(fixtureName)) {
      findings.push({
        file: safeFile,
        line: 0,
        column: 1,
        label: "non-synthetic-consumer-fixture-name",
      });
    }

    if (record.text !== undefined) {
      findings.push(...scanTextForDisallowedConsumerNames(record.text, safeFile, disallowedConsumerNames));
      findings.push(...scanTextForHomePaths(record.text, safeFile));
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
    const record = { path, text: undefined };
    try {
      const buffer = await readFile(resolve(cwd, path));
      if (!buffer.includes(0)) {
        record.text = buffer.toString("utf8");
      }
    } catch {
      // Deleted or unreadable tracked files are not hygiene findings.
    }
    records.push(record);
  }

  const findings = scanOssHygieneRecords(records);
  stdout.write(renderOssHygieneReport(findings));
  return { exitCode: findings.length === 0 ? 0 : 1, findings };
}

export function renderOssHygieneReport(findings) {
  if (findings.length === 0) {
    return "OSS hygiene check passed\n";
  }

  const lines = [
    "OSS hygiene check failed",
    `Findings: ${findings.length}`,
  ];
  for (const finding of findings.sort(compareFindings)) {
    lines.push(`  ${finding.file}:${finding.line}:${finding.column} label=${finding.label}`);
  }
  return `${lines.join("\n")}\n`;
}

function collectDisallowedConsumerNames(records) {
  const names = new Set();
  for (const record of records) {
    const fixtureName = consumerFixtureNameFromPath(record.path);
    if (fixtureName !== undefined && !publicConsumerFixtureNames.has(fixtureName)) {
      names.add(fixtureName);
    }
  }
  return names;
}

function consumerFixtureNameFromPath(path) {
  if (!path.startsWith(consumerFixturePrefix)) {
    return undefined;
  }
  const rest = path.slice(consumerFixturePrefix.length);
  const name = rest.split("/")[0];
  return name.length === 0 ? undefined : name;
}

function scanTextForDisallowedConsumerNames(text, file, disallowedConsumerNames) {
  const findings = [];
  for (const name of disallowedConsumerNames) {
    let start = 0;
    while (start < text.length) {
      const index = text.indexOf(name, start);
      if (index === -1) {
        break;
      }
      const location = locationForIndex(text, index);
      findings.push({
        file,
        line: location.line,
        column: location.column,
        label: "non-synthetic-consumer-fixture-reference",
      });
      start = index + name.length;
    }
  }
  return findings;
}

function scanTextForHomePaths(text, file) {
  const findings = [];
  homePathPattern.lastIndex = 0;
  for (const match of text.matchAll(homePathPattern)) {
    const username = match[1];
    if (username === undefined || publicHomePathNames.has(username)) {
      continue;
    }
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

function sanitizeFilePath(path, disallowedConsumerNames) {
  let result = path;
  for (const name of disallowedConsumerNames) {
    result = result.split(`${consumerFixturePrefix}${name}/`).join(`${consumerFixturePrefix}[non-synthetic-consumer]/`);
    result = result.split(name).join("[non-synthetic-consumer]");
  }
  return result;
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
