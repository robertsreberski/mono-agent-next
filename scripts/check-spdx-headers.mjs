#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const identifierLabel = ["SPDX", "License-Identifier"].join("-");
const directiveLinePattern = new RegExp(
  `^\\s*(?:(?:\\/\\/)|(?:\\/\\*+)|(?:\\*)|(?:#))\\s*${identifierLabel}:.*$`,
  "u",
);

export const JAVASCRIPT_MIT_HEADER = `// ${identifierLabel}: MIT`;
export const CSS_MIT_HEADER = `/* ${identifierLabel}: MIT */`;
export const SPDX_SOURCE_EXTENSIONS = Object.freeze([
  ".css",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
]);

export async function checkSpdxHeaders(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  let paths;
  try {
    paths = await listGitSourcePaths(repoRoot);
  } catch (error) {
    return resultOf(
      [`could not enumerate source files from Git (${reasonOf(error)})`],
      0,
    );
  }

  const issues = [];
  for (const path of paths) {
    const absolutePath = resolveWithin(repoRoot, path);
    if (absolutePath === undefined) {
      issues.push(`${path}: Git returned a path outside the repository`);
      continue;
    }

    let source;
    try {
      const listed = await lstat(absolutePath, { bigint: true });
      if (!listed.isFile() || listed.isSymbolicLink()) {
        issues.push(
          `${path}: must be a regular file; symlinks and other file types are not accepted`,
        );
        continue;
      }
      source = await readStableFileWithoutFollowingLinks(absolutePath, listed);
    } catch (error) {
      issues.push(
        `${path}: could not be read as a stable regular file without following links `
        + `(${reasonOf(error)})`,
      );
      continue;
    }

    const issue = inspectHeader(path, source);
    if (issue !== undefined) issues.push(issue);
  }

  return resultOf(issues, paths.length);
}

export function renderSpdxHeaderReport(result) {
  if (result.issues.length === 0) {
    return `SPDX header check passed (${String(result.checkedCount)} source files).\n`;
  }
  return [
    `SPDX header check failed (${String(result.issues.length)} issue(s) across `
      + `${String(result.checkedCount)} source files)`,
    ...result.issues.map((issue) => `- ${issue}`),
    "",
  ].join("\n");
}

export async function runCheckSpdxHeaders(options = {}) {
  const result = await checkSpdxHeaders(options);
  const stdout = options.stdout ?? process.stdout;
  stdout.write(renderSpdxHeaderReport(result));
  return result;
}

async function listGitSourcePaths(repoRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"],
    {
      cwd: repoRoot,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const decoded = splitNullTerminated(stdout).map((bytes) => utf8Decoder.decode(bytes));
  return [...new Set(decoded)]
    .filter((path) => SPDX_SOURCE_EXTENSIONS.includes(extname(path)))
    .sort(compareUtf8Bytes);
}

function splitNullTerminated(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const entries = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) entries.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) {
    throw new Error("Git path enumeration was not NUL-terminated");
  }
  return entries;
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function resolveWithin(repoRoot, path) {
  const absolutePath = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, absolutePath);
  if (
    relativePath === ""
    || isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return absolutePath;
}

async function readStableFileWithoutFollowingLinks(path, listed) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is unavailable on this platform");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(listed, opened)) {
      throw new Error("file identity changed before it was opened");
    }

    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameSnapshot(opened, after) || !sameSnapshot(after, current)) {
      throw new Error("file changed while it was read");
    }
    return contents.toString("utf8");
  } finally {
    await handle.close();
  }
}

function sameIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function inspectHeader(path, source) {
  const lines = source.split(/\r?\n/u);
  const directives = [];
  for (const [index, line] of lines.entries()) {
    if (directiveLinePattern.test(line)) {
      directives.push({ line, lineNumber: index + 1 });
    }
  }

  if (directives.length === 0) {
    return `${path}: missing ${identifierLabel}: MIT directive`;
  }
  if (directives.length > 1) {
    const lineNumbers = directives.map(({ lineNumber }) => String(lineNumber)).join(", ");
    return `${path}: has duplicate license directives at lines ${lineNumbers}; exactly one is required`;
  }

  const directive = directives[0];
  const css = extname(path) === ".css";
  const expectedHeader = css ? CSS_MIT_HEADER : JAVASCRIPT_MIT_HEADER;
  if (directive.line !== expectedHeader) {
    return `${path}:${String(directive.lineNumber)} license directive must be exactly `
      + JSON.stringify(expectedHeader);
  }

  const expectedLine = css ? 1 : lines[0].startsWith("#!") ? 2 : 1;
  if (directive.lineNumber !== expectedLine) {
    return `${path}:${String(directive.lineNumber)} license directive is misplaced; `
      + `expected line ${String(expectedLine)}`;
  }
  return undefined;
}

function resultOf(issues, checkedCount) {
  return Object.freeze({
    exitCode: issues.length === 0 ? 0 : 1,
    checkedCount,
    issues: Object.freeze(issues),
  });
}

function reasonOf(error) {
  if (error !== null && typeof error === "object") {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString("utf8").trim()
      : typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    if (stderr !== "") return stderr.replaceAll(/\s+/gu, " ");
  }
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ");
}

const isCli = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runCheckSpdxHeaders();
  process.exitCode = result.exitCode;
}
