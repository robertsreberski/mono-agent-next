import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  artifactDirForKind,
  normalizeRunArtifactScope,
  relativeSummaryFileName,
  summaryMatchesArtifactScope,
  type SummaryFileLocation,
} from "./artifact-scope.js";
import {
  errorMessage,
  isErrno,
  isRecord,
  safeJoin as safeJoinGuard,
} from "./artifact-fs.js";
import { SUMMARY_SUFFIX } from "./summary-schema.js";
import type { ArtifactAuditFileIssue, RunArtifactScope } from "./types.js";

export interface ArtifactSummaryRecord {
  readonly fileName: string;
  readonly raw: Record<string, unknown>;
}

export interface ReadArtifactSummaryRecordsResult {
  readonly artifactDir: string;
  readonly totalSummaryFiles: number;
  readonly parsedSummaryFiles: number;
  readonly parseFailures: readonly ArtifactAuditFileIssue[];
  readonly summaries: readonly ArtifactSummaryRecord[];
  readonly warnings: readonly string[];
}

export interface ReadArtifactSummaryRecordsOptions {
  readonly scope?: RunArtifactScope;
}

export async function readArtifactSummaryRecords(
  artifactDir: string,
  options: ReadArtifactSummaryRecordsOptions = {},
): Promise<ReadArtifactSummaryRecordsResult> {
  if (typeof artifactDir !== "string" || artifactDir.trim().length === 0) {
    throw new Error("artifactDir must be a non-empty path.");
  }

  const normalizedDir = resolve(artifactDir);
  const scope = normalizeRunArtifactScope(options.scope);
  const parseFailures: ArtifactAuditFileIssue[] = [];
  const summaries: ArtifactSummaryRecord[] = [];
  const warnings: string[] = [];
  let totalSummaryFiles = 0;

  totalSummaryFiles += await readNamespaceSummaryRecords({
    rootArtifactDir: normalizedDir,
    namespaceKind: "agent",
    scope,
    parseFailures,
    summaries,
    warnings,
    includeUnknownFailures: scope !== "memory",
  });
  if (scope === "memory" || scope === "all") {
    totalSummaryFiles += await readNamespaceSummaryRecords({
      rootArtifactDir: normalizedDir,
      namespaceKind: "memory",
      scope,
      parseFailures,
      summaries,
      warnings,
      includeUnknownFailures: true,
    });
  }

  summaries.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return buildReadResult(normalizedDir, totalSummaryFiles, parseFailures, summaries, warnings);
}

async function readNamespaceSummaryRecords(input: {
  readonly rootArtifactDir: string;
  readonly namespaceKind: "agent" | "memory";
  readonly scope: RunArtifactScope;
  readonly parseFailures: ArtifactAuditFileIssue[];
  readonly summaries: ArtifactSummaryRecord[];
  readonly warnings: string[];
  readonly includeUnknownFailures: boolean;
}): Promise<number> {
  const artifactDir = artifactDirForKind(input.rootArtifactDir, input.namespaceKind);
  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return 0;
    }
    input.warnings.push(`Unable to read artifact directory: ${errorMessage(error)}.`);
    return 0;
  }

  const summaryFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SUMMARY_SUFFIX))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  let included = 0;
  for (const fileName of summaryFiles) {
    const location: SummaryFileLocation = {
      artifactDir,
      fileName,
      relativeFileName: relativeSummaryFileName(fileName, input.namespaceKind),
      namespaceKind: input.namespaceKind,
    };
    const raw = await readSummaryRecord(location, input.includeUnknownFailures ? input.parseFailures : []);
    if (raw !== undefined && summaryMatchesArtifactScope(input.namespaceKind, raw, input.scope)) {
      input.summaries.push({ fileName: location.relativeFileName, raw });
      included += 1;
    } else if (raw === undefined && input.includeUnknownFailures) {
      included += 1;
    }
  }

  return included;
}

async function readSummaryRecord(
  location: SummaryFileLocation,
  parseFailures: ArtifactAuditFileIssue[],
): Promise<Record<string, unknown> | undefined> {
  const filePath = safeJoin(location.artifactDir, location.fileName);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    parseFailures.push(fileIssue(location.relativeFileName, `unable to read: ${errorMessage(error)}`));
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    parseFailures.push(fileIssue(location.relativeFileName, `invalid JSON: ${errorMessage(error)}`));
    return undefined;
  }
  if (!isRecord(parsed)) {
    parseFailures.push(fileIssue(location.relativeFileName, "summary is not an object", parsed));
    return undefined;
  }
  return parsed;
}

function buildReadResult(
  artifactDir: string,
  totalSummaryFiles: number,
  parseFailures: readonly ArtifactAuditFileIssue[],
  summaries: readonly ArtifactSummaryRecord[],
  warnings: readonly string[],
): ReadArtifactSummaryRecordsResult {
  return {
    artifactDir,
    totalSummaryFiles,
    parsedSummaryFiles: summaries.length,
    parseFailures,
    summaries,
    warnings,
  };
}

function safeJoin(root: string, fileName: string): string {
  return safeJoinGuard(root, fileName, () => {
    throw new Error("Resolved artifact path escapes artifactDir.");
  });
}

function fileIssue(fileName: string, reason: string, value?: unknown): ArtifactAuditFileIssue {
  return value === undefined
    ? { fileName, reason }
    : { fileName, reason, value: describeValue(value) };
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
