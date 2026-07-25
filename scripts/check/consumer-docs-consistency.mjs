#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  packageCatalog,
  packageRelativePath,
} from "../lib/package-catalog.mjs";

const userDocRoots = [
  "AGENTS.md",
  "README.md",
  "PACKAGES.md",
  "docs",
  ...packageCatalog.map((entry) => `${packageRelativePath(entry)}/README.md`),
  "packages/create-mono-agent/skills/mono-agent-composer/references",
];
const demoMarkdownRoot = "demos";

const artifactContractSourcePaths = [
  "packages/channel-operator/src/server.ts",
  "packages/operator/package.json",
  "packages/operator/src/state.ts",
  "packages/tui/package.json",
  "packages/tui/src/ui/app.ts",
  "packages/tui/src/ui/terminal-text.ts",
  "scripts/lib/package-catalog.mjs",
];

const monoPackage = (...nameParts) => `@mono-agent/${nameParts.join("-")}`;
const packageDir = (...nameParts) => `packages/${nameParts.join("-")}`;

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageReferencePattern(...nameParts) {
  const bareName = nameParts.join("-");
  return new RegExp([
    escapedPattern(monoPackage(...nameParts)),
    `\\b${escapedPattern(packageDir(...nameParts))}\\b`,
    `\\b${escapedPattern(bareName)}\\b`,
  ].join("|"), "iu");
}

function packageSurfacePattern(...nameParts) {
  const bareName = escapedPattern(nameParts.join("-"));
  return new RegExp([
    escapedPattern(monoPackage(...nameParts)),
    `\\b${escapedPattern(packageDir(...nameParts))}\\b`,
    `\\b${bareName}\\s+(?:package|workspace|surface|module)\\b`,
  ].join("|"), "iu");
}

const retiredDocReferences = [
  {
    label: "@mono-agent/agent-evals",
    pattern: /@mono-agent\/agent-evals|\bpackages\/agent-evals\b|\bagent-evals\b/iu,
  },
  {
    label: "demos package",
    pattern: /@mono-agent\/demos|\bpackages\/demos\b|\bdemos\s+(?:package|workspace|surface)\b/iu,
  },
  {
    label: "WhatsApp/A2A in core",
    pattern:
      /\b(?:whatsapp|a2a)(?:(?:\s+and\s+|\/)(?:whatsapp|a2a))?\s+(?:is|are|as)\s+(?:a\s+)?(?:built[- ]in|bundled|core|in[- ]core)\b|\b(?:built[- ]in|bundled|core|in[- ]core)\s+(?:whatsapp|a2a)(?:(?:\s+and\s+|\/)(?:whatsapp|a2a))?\s+(?:channel|adapter|package|surface)s?\b|\b(?:whatsapp|a2a)[-/](?:whatsapp|a2a)-in-core\b/iu,
  },
  {
    label: "@mono-agent/memory-store",
    pattern: /@mono-agent\/memory-store|\bpackages\/memory-store\b|\bmemory-store\b/iu,
  },
  {
    label: "@mono-agent/memory-search",
    pattern: /@mono-agent\/memory-search|\bpackages\/memory-search\b|\bmemory-search\b/iu,
  },
  {
    label: "memory-bujo package",
    pattern:
      /@mono-agent\/memory-bujo|\bpackages\/memory-bujo\b|\bmemory-bujo\b[^\n.]{0,80}\b(?:package|workspace|surface|module)\b|\b(?:package|workspace|surface|module)\b[^\n.]{0,80}\bmemory-bujo\b/iu,
  },
  {
    label: "@mono-agent/observability-otel",
    pattern: /@mono-agent\/observability-otel|\bpackages\/observability-otel\b|\bobservability-otel\b/iu,
  },
  {
    label: "@mono-agent/settings",
    pattern: /@mono-agent\/settings|\bpackages\/settings\b|\bsettings\s+(?:package|workspace|surface|module)\b/iu,
  },
  {
    label: monoPackage("agent", "host"),
    pattern: packageSurfacePattern("agent", "host"),
  },
  {
    label: monoPackage("tui", "adapter"),
    pattern: packageReferencePattern("tui", "adapter"),
  },
  {
    label: monoPackage("live", "adapter"),
    pattern: packageReferencePattern("live", "adapter"),
  },
  {
    label: "NotifyConversation",
    pattern: /\bNotifyConversation\b|\bnotify_conversation\b/iu,
  },
];

const retiredDemoToolReferences = [
  { label: "journal_append", pattern: /\bjournal_append\b/iu },
  { label: "memory_search", pattern: /\bmemory_search\b/iu },
  { label: "entity_get", pattern: /\bentity_get\b/iu },
  { label: "memory_read_day", pattern: /\bmemory_read_day\b/iu },
  { label: "memory_list_days", pattern: /\bmemory_list_days\b/iu },
];

const deprecatedMemoryRecallAlias = "memory_recall";
const deprecatedMemoryRecallAliasPattern = /\bmemory_recall\b/gu;
// The deprecated alias is forbidden in active shipped prose. Historical
// references use one rigid, reader-visible record preceded by path-and-line
// metadata. This is intentionally not an English classifier: arbitrary prose,
// even prose that calls itself historical, remains forbidden.
// <!-- mono-agent-doc-history:v1 {"path":"docs/example.md","line":2} -->
// > Historical compatibility record: `memory_recall` is retired; canonical replacement: `MemoryRecall`.
const deprecatedAliasHistoryAnnotation = "mono-agent-doc-history:v1";
const deprecatedAliasHistoryMarkerPattern =
  /^<!-- mono-agent-doc-history:v1 (\{[^\n]*\}) -->$/u;
const deprecatedAliasHistoryPayload =
  "> Historical compatibility record: `memory_recall` is retired; canonical replacement: `MemoryRecall`.";

const misleadingArtifactDurabilityClaims = [
  {
    label: "JSONL artifacts as a source of truth",
    pattern:
      /\b(?:local\s+)?JSONL(?:\s+run)?\s+artifacts?\b(?:(?!\bnot\b)[^\n.!?]){0,200}\bsource of truth\b/iu,
  },
  {
    label: "always-on JSONL run record",
    pattern: /\balways-on(?:\s+JSONL)?\s+run record\b/iu,
  },
  {
    label: "always-on local traceability fallback",
    pattern: /\balways-on local traceability fallback\b/iu,
  },
  {
    label: "append-only JSONL run artifact",
    pattern:
      /\bappend-only\b[^\n.!?]{0,100}\b(?:JSONL|event stream|run artifacts?)\b|\b(?:JSONL|event stream|run artifacts?)\b[^\n.!?]{0,100}\bappend-only\b/iu,
  },
  {
    label: "full payload guaranteed in run artifacts",
    pattern:
      /\bfull\s+(?:data|payload)\b\s+(?:is\s+always\s+|is\s+(?:available|preserved|retained)\s+|stays?\s+(?:available\s+)?|remains?\s+)?(?:in\s+)?(?:the\s+)?run(?:'s)?\s+(?:\[\s*)?(?:JSONL\s+)?artifacts?\b/iu,
  },
  {
    label: "full or no-drop replay timeline",
    pattern:
      /\bfull(?:\s+coalesced)?\s+event timeline\b(?:[^\n.!?]{0,160}\bnothing\s+(?:is\s+)?dropped\b)?|\bnothing\s+(?:is\s+)?dropped\b/iu,
  },
  {
    label: "full AgentStreamEvent fidelity",
    pattern: /\bfull\s+`?AgentStreamEvent`?\s+fidelity\b/iu,
  },
  {
    label: "verbatim complete TUI event stream",
    pattern:
      /\b(?:streams?\s+)?every\s+(?:structured\s+)?`?AgentStreamEvent`?\s+verbatim\b|\bexact\s+(?:in-process\s+)?stream callbacks?\b/iu,
  },
  {
    label: "full stream-event insight",
    pattern: /\bfull\s+stream-event\s+insight\b/iu,
  },
  {
    label: "full thinking/tool/telemetry help insight",
    pattern:
      /\blive chat with full(?:[\s"',]+)thinking\/tool\/telemetry insight\b/iu,
  },
  {
    label: "full-fidelity TUI NDJSON metadata",
    pattern: /\bfull[- ]fidelity\s+TUI\s+NDJSON\s+(?:turns?|frames?|stream)\b/iu,
  },
  {
    label: "guaranteed every-run Phoenix stream",
    pattern:
      /\bevery\s+run(?:\s+lifecycle)?\s+streams?\s+to\s+(?:a\s+)?\[?Phoenix\b|\bstream\s+every\s+run(?:\s+lifecycle)?\s+to\s+Phoenix\b/iu,
  },
  {
    label: "guaranteed every-run Phoenix export",
    pattern: /\bexported\s+on\s+every\s+run\b/iu,
  },
  {
    label: "always-written JSONL artifacts",
    pattern:
      /\bJSONL(?:\s+run)?(?:\s+artifacts?)?\b(?:(?!\bnot\b)[^\n.!?]){0,180}\b(?:always\s+written|written\s+on\s+every\s+run)\b/iu,
  },
  {
    label: "unbounded session artifact detail",
    pattern:
      /\bfull\s+timelines?\s+are\s+loaded\b|\b(?:use\s+\{@link\s+readInstanceSession\}\s+for|contains?|loading)\s+full\s+detail\b|\bA\s+single\s+run\s+read\s+in\s+full\b|\bfuller\s+\(redacted\)\s+payload\b/iu,
  },
  {
    label: "broad TUI wire-bound claim",
    pattern:
      /\bper-frame payload bound\b|\bup to the wire bound\b|\bbounded wire protocol\b|\bupper\s+bound\s+for\s+one\s+serialized\s+NDJSON\s+frame\b/iu,
  },
  {
    label: "non-enforced TUI event reduction threshold",
    pattern:
      /\b(?:serialized\s+|oversized\s+|remote\s+)?event frames?\b[^\n.!?]{0,220}\b256\s+KiB\b[^\n.!?]{0,220}\bnot\s+a\s+strict\s+(?:byte\s+)?(?:maximum|cap)\b/iu,
  },
  {
    label: "blanket TUI event field-reduction claim",
    pattern:
      /\b(?:(?:all|every)\s+)?oversized events?\s+(?:(?:is|are)\s+field[- ]reduced|receive\s+field[- ]level(?:\s+payload)?\s+reduction)\b|\b(?:(?:a|all|every)\s+)?(?:serialized(?:\s+remote)?|remote)\s+event frames?(?:\s+(?:over|above)\s+256\s+KiB)?\s+(?:(?:is|are)\s+field[- ]reduced|receive\s+field[- ]level(?:\s+payload)?\s+reduction)\b/iu,
  },
  {
    label: "guaranteed tool-output artifact persistence",
    pattern:
      /\bwhen\s+a\s+(?:tool\s+)?result\s+exceeds\b[^\n.!?]{0,180}\bit\s+is\s+persisted\s+as\s+an\s+artifact\b[^\n.!?]{0,180}\bnothing\s+is\s+silently\s+lost\b/iu,
  },
];

const retiredSurfaces = [
  {
    label: "@mono-agent/memory-mcp",
    readmePattern: /@mono-agent\/memory-mcp|\bmemory-mcp\b/iu,
    exposurePattern: /@mono-agent\/memory-mcp|\bmemory-mcp\b/iu,
  },
  {
    label: "memory_note",
    readmePattern: /\bmemory_note\b/iu,
    exposurePattern: /\bmemory_note\b/iu,
  },
  {
    label: "operator console",
    readmePattern: /@mono-agent\/operator-console|\boperator[ -]console\b/iu,
    exposurePattern: /@mono-agent\/operator-console|\boperator-console\b/iu,
  },
];

export async function checkConsumerDocsConsistency(consumerPaths, options = {}) {
  const warnings = [];
  const issues = [];
  let checked = 0;
  let userDocsChecked = 0;
  let artifactContractSourcesChecked = 0;

  if (options.scanUserDocs !== false) {
    const repoRoot = resolve(options.repoRoot ?? process.cwd());
    const userDocRecords = options.userDocRecords ?? await readUserDocRecords(repoRoot);
    const demoMarkdownRecords = options.demoMarkdownRecords
      ?? await readMarkdownRecordsIfPresent(join(repoRoot, demoMarkdownRoot));
    const artifactContractSourceRecords = options.artifactContractSourceRecords
      ?? await readExplicitTextRecords(repoRoot, artifactContractSourcePaths);
    const shippedDocRecords = [...userDocRecords, ...demoMarkdownRecords];
    userDocsChecked = shippedDocRecords.length;
    artifactContractSourcesChecked = artifactContractSourceRecords.length;
    issues.push(...scanRetiredDocReferences(shippedDocRecords));
    issues.push(...scanRetiredDemoTools(demoMarkdownRecords));
    issues.push(...scanDeprecatedMemoryRecallAliases(shippedDocRecords, repoRoot));
    issues.push(...scanMisleadingArtifactDurabilityClaims([
      ...shippedDocRecords,
      ...artifactContractSourceRecords,
    ]));
  }

  for (const rawPath of consumerPaths) {
    const consumerDir = resolve(rawPath);
    const readmePath = join(consumerDir, "README.md");
    if (!(await pathExists(readmePath))) {
      warnings.push(`${consumerDir}: README.md missing; skipped.`);
      continue;
    }

    checked += 1;
    const configPath = join(consumerDir, "mono-agent.config.json");
    const readme = await readFile(readmePath, "utf8");
    const config = await readConsumerConfig(configPath, issues);
    if (config === undefined) {
      continue;
    }

    const consumerReadmeRecord = { path: readmePath, text: readme };
    issues.push(...scanRetiredDocReferences([consumerReadmeRecord]));
    issues.push(...scanDeprecatedMemoryRecallAliases([consumerReadmeRecord], consumerDir));

    const mcpTexts = await readConfiguredMcpTexts(consumerDir, config);
    const exposureText = [
      JSON.stringify(config),
      ...mcpTexts,
    ].join("\n");

    for (const surface of retiredSurfaces) {
      if (surface.readmePattern.test(readme) && !surface.exposurePattern.test(exposureText)) {
        issues.push(
          `${readmePath}: references retired surface "${surface.label}", but mono-agent.config.json` +
            " and its configured MCP file do not expose it.",
        );
      }
    }
  }

  return { checked, userDocsChecked, artifactContractSourcesChecked, warnings, issues };
}

function parseArgs(argv) {
  const consumers = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, consumers };
    }
    if (arg === "--consumer") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--consumer requires a path.");
      }
      consumers.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, consumers };
}

async function readConsumerConfig(configPath, issues) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    issues.push(`${configPath}: could not read mono-agent.config.json (${reasonOf(error)}).`);
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    issues.push(`${configPath}: malformed JSON (${reasonOf(error)}).`);
    return undefined;
  }
}

async function readConfiguredMcpTexts(consumerDir, config) {
  const mcpConfigPath = config?.tools?.mcpConfigPath;
  if (typeof mcpConfigPath !== "string" || mcpConfigPath.trim().length === 0) {
    return [];
  }

  const path = resolve(consumerDir, mcpConfigPath);
  try {
    return [await readFile(path, "utf8")];
  } catch {
    return [];
  }
}

async function readUserDocRecords(repoRoot) {
  const records = [];
  for (const relativePath of userDocRoots) {
    const path = join(repoRoot, relativePath);
    if (!(await pathExists(path))) {
      continue;
    }
    const pathStat = await stat(path);
    if (pathStat.isDirectory()) {
      records.push(...await readMarkdownRecords(path));
      continue;
    }
    if (pathStat.isFile() && extname(path) === ".md") {
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

async function readExplicitTextRecords(repoRoot, relativePaths) {
  const records = [];
  for (const relativePath of relativePaths) {
    const path = join(repoRoot, relativePath);
    if (!(await pathExists(path))) {
      continue;
    }
    const pathStat = await stat(path);
    if (pathStat.isFile()) {
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

async function readMarkdownRecords(dir) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const records = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      records.push(...await readMarkdownRecords(path));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".md") {
      records.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return records;
}

export function compareCodeUnits(left, right) {
  // ECMAScript string relational comparison is defined over UTF-16 code units
  // and does not depend on the host's locale or ICU data.
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readMarkdownRecordsIfPresent(dir) {
  if (!(await pathExists(dir))) {
    return [];
  }
  return await readMarkdownRecords(dir);
}

function scanRetiredDocReferences(records) {
  const issues = [];
  for (const record of records) {
    for (const retiredReference of retiredDocReferences) {
      for (const match of findPatternMatches(retiredReference.pattern, record.text)) {
        const location = lineAndColumn(record.text, match.index);
        issues.push(
          `${record.path}:${location.line}:${location.column}: references retired pre-v1 surface ` +
            `"${retiredReference.label}". Update the user docs to the current v1 package map.`,
        );
      }
    }
  }
  return issues;
}

function scanRetiredDemoTools(records) {
  const issues = [];
  for (const record of records) {
    for (const retiredReference of retiredDemoToolReferences) {
      for (const match of findPatternMatches(retiredReference.pattern, record.text)) {
        const location = lineAndColumn(record.text, match.index);
        issues.push(
          `${record.path}:${location.line}:${location.column}: references retired memory tool ` +
            `"${retiredReference.label}". Use the current read-only MemoryRecall surface or ` +
            "describe host-driven capture instead.",
        );
      }
    }
  }
  return issues;
}

function scanMisleadingArtifactDurabilityClaims(records) {
  const issues = [];
  for (const record of records) {
    for (const claim of misleadingArtifactDurabilityClaims) {
      for (const match of findPatternMatches(claim.pattern, record.text)) {
        const location = lineAndColumn(record.text, match.index);
        issues.push(
          `${record.path}:${location.line}:${location.column}: uses absolute observability/replay wording ` +
            `"${claim.label}". Describe transport and string caps, best-effort export, the start snapshot, ` +
            "in-memory buffering, terminal replacement, and crash-loss/reconciliation boundaries instead.",
        );
      }
    }
  }
  return issues;
}

function scanDeprecatedMemoryRecallAliases(records, repoRoot) {
  const issues = [];
  for (const record of records) {
    const annotation = approvedHistoryAnnotationIndexes(record, repoRoot);
    issues.push(...annotation.issues);
    for (const match of findPatternMatches(deprecatedMemoryRecallAliasPattern, record.text)) {
      if (annotation.approvedAliasIndexes.has(match.index)) {
        continue;
      }
      const location = lineAndColumn(record.text, match.index);
      issues.push(
        `${record.path}:${location.line}:${location.column}: retired alias ` +
          '"memory_recall" is forbidden in active shipped docs. Use canonical "MemoryRecall". ' +
          `Historical references must use the exact ${deprecatedAliasHistoryAnnotation} record.`,
      );
    }
  }
  return issues;
}

function approvedHistoryAnnotationIndexes(record, repoRoot) {
  const approvedAliasIndexes = new Set();
  const issues = [];
  const relativePath = repoRelativePath(repoRoot, record.path);
  const lines = indexedLines(record.text);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const markerLine = lines[lineIndex];
    if (!markerLine.text.includes("<!-- mono-agent-doc-history")) {
      continue;
    }
    const markerMatch = deprecatedAliasHistoryMarkerPattern.exec(markerLine.text);
    if (markerMatch === null) {
      issues.push(annotationIssue(record.path, markerLine.number, "history annotation marker is malformed"));
      continue;
    }
    const metadata = parseHistoryAnnotationMetadata(markerMatch[1]);
    if (metadata === undefined) {
      issues.push(annotationIssue(record.path, markerLine.number, "history annotation metadata is invalid"));
      continue;
    }
    if (relativePath === undefined || metadata.path !== relativePath) {
      issues.push(
        annotationIssue(
          record.path,
          markerLine.number,
          `history annotation path "${metadata.path}" does not match "${relativePath ?? "<outside-repo>"}"`,
        ),
      );
      continue;
    }
    const payloadLine = lines[lineIndex + 1];
    if (payloadLine === undefined || metadata.line !== payloadLine.number) {
      issues.push(
        annotationIssue(
          record.path,
          markerLine.number,
          `history annotation line ${metadata.line} does not match the next line`,
        ),
      );
      continue;
    }
    if (payloadLine.text !== deprecatedAliasHistoryPayload) {
      issues.push(
        annotationIssue(
          record.path,
          markerLine.number,
          "history annotation payload must match exactly",
        ),
      );
      continue;
    }
    approvedAliasIndexes.add(
      payloadLine.start + deprecatedAliasHistoryPayload.indexOf(deprecatedMemoryRecallAlias),
    );
  }

  return { approvedAliasIndexes, issues };
}

function parseHistoryAnnotationMetadata(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "line" || keys[1] !== "path") {
    return undefined;
  }
  if (
    typeof value.path !== "string"
    || value.path.length === 0
    || isAbsolute(value.path)
    || value.path.split("/").includes("..")
    || !Number.isSafeInteger(value.line)
    || value.line < 1
  ) {
    return undefined;
  }
  if (raw !== JSON.stringify({ path: value.path, line: value.line })) {
    return undefined;
  }
  return { path: value.path, line: value.line };
}

function repoRelativePath(repoRoot, path) {
  const absolutePath = isAbsolute(path) ? path : resolve(repoRoot, path);
  const candidate = relative(repoRoot, absolutePath).replaceAll("\\", "/");
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) {
    return undefined;
  }
  return candidate;
}

function indexedLines(text) {
  const lines = [];
  let start = 0;
  for (const [index, rawLine] of text.split("\n").entries()) {
    lines.push({
      number: index + 1,
      start,
      text: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine,
    });
    start += rawLine.length + 1;
  }
  return lines;
}

function annotationIssue(path, line, detail) {
  return `${path}:${line}:1: invalid ${deprecatedAliasHistoryAnnotation} annotation: ${detail}.`;
}

function findPatternMatches(pattern, text) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ index: match.index, length: match[0].length });
    if (match[0] === "") {
      regex.lastIndex += 1;
    }
  }
  return matches;
}

function lineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const line = prefix.split("\n").length;
  const lastNewlineIndex = prefix.lastIndexOf("\n");
  const column = lastNewlineIndex === -1 ? index + 1 : index - lastNewlineIndex;
  return { line, column };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  const bin = fileURLToPath(import.meta.url);
  return [
    "Usage:",
    `  node ${bin} [--consumer <path> ...]`,
    "",
    "Scans repo user docs (AGENTS.md, README.md, PACKAGES.md, docs/**/*.md, relevant package READMEs,",
    "mono-agent-composer references, and demos/**/*.md)",
    "for retired pre-v1 surfaces",
    "and scans those docs plus TUI source text for absolute artifact/replay claims",
    "that contradict wire truncation, best-effort export, recorder redaction, or terminal persistence.",
    "Each optional consumer folder should contain README.md and mono-agent.config.json.",
  ].join("\n");
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${reasonOf(error)}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await checkConsumerDocsConsistency(parsed.consumers, { repoRoot: cliRepoRoot() });
  for (const warning of result.warnings) {
    process.stderr.write(`WARN ${warning}\n`);
  }
  if (result.checked === 0 && result.userDocsChecked === 0 && result.artifactContractSourcesChecked === 0) {
    process.stderr.write(
      "ERROR No repo user docs or consumer folders were checked.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      process.stderr.write(`ERROR ${issue}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Repo/consumer docs/config consistency passed for ${result.userDocsChecked} repo doc file(s) ` +
      `and ${result.artifactContractSourcesChecked} artifact-contract source file(s) ` +
      `and ${result.checked} consumer folder(s).\n`,
  );
}

function cliRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await main();
}
