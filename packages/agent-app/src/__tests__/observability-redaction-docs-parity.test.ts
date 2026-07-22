import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SHARED_REDACTION_CONTRACT = [
  "non-numeric values under sensitive-looking object keys are redacted;",
  "numeric values under matched keys are retained;",
  "free text is not content-scanned",
].join(" ");
const RECORDER_REDACTION_CONTRACT = [
  "non-numeric values under sensitive-looking object keys are redacted;",
  "numeric values under matched keys are retained;",
  "retained free text is scanned for a closed set of high-confidence credential shapes",
].join(" ");
const RUN_HISTORY_SECOND_PASS_CONTRACT = [
  "`runhistory` then applies an additional projection sanitizer.",
  "in that second pass, numeric values under `credential`, `private_key`, and `bearer` can remain visible;",
  "numeric values under `apikey`, `token`, `client_secret`, `password`, `authorization`, and `cookie` are redacted.",
  "assignment-shaped password or secret prose is content-scanned and replaced with the diagnostic or tool-result omission sentinel.",
  "an optionally quoted assignment value is exempt only when its complete value is exactly `[redacted]`; any prefix or suffix is omitted.",
].join(" ");
const BACKFILL_INPUT_CONTRACT = "backfill forwards persisted `summary.userinput`";
const CONTENT_PATTERN_OPTION = "contentpatternredaction";

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot(), relativePath), "utf8");
}

function normalized(source: string): string {
  return source.replace(/\s+/gu, " ").toLowerCase();
}

function lineContaining(relativePath: string, anchor: string): string {
  const line = readRepoFile(relativePath).split("\n").find((candidate) => candidate.includes(anchor));
  if (line === undefined) {
    throw new Error(`${relativePath} is missing anchor ${JSON.stringify(anchor)}`);
  }
  return normalized(line);
}

function paragraphContaining(relativePath: string, anchor: string): string {
  const paragraph = readRepoFile(relativePath)
    .split(/\n\s*\n/gu)
    .find((candidate) => candidate.includes(anchor));
  if (paragraph === undefined) {
    throw new Error(`${relativePath} is missing paragraph anchor ${JSON.stringify(anchor)}`);
  }
  return normalized(paragraph);
}

function markdownSection(relativePath: string, heading: string): string {
  const page = readRepoFile(relativePath);
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) {
    throw new Error(`${relativePath} is missing section ${JSON.stringify(heading)}`);
  }
  const rest = page.slice(start + marker.length);
  const next = rest.search(/^## /mu);
  return normalized(next === -1 ? rest : rest.slice(0, next));
}

function declarationFieldDoc(relativePath: string, declarationMarker: string, fieldName: string): string {
  const source = readRepoFile(relativePath);
  const declarationStart = source.indexOf(declarationMarker);
  if (declarationStart === -1) {
    throw new Error(`${relativePath} is missing declaration ${JSON.stringify(declarationMarker)}`);
  }
  const nextExport = source.indexOf("\nexport ", declarationStart + declarationMarker.length);
  const declarationSource = source.slice(declarationStart, nextExport === -1 ? source.length : nextExport);
  const fieldPattern = new RegExp(`\\b(?:readonly\\s+)?${fieldName}\\??:`, "u");
  const fieldMatch = fieldPattern.exec(declarationSource);
  if (fieldMatch === null) {
    throw new Error(`${relativePath} ${declarationMarker} is missing field ${JSON.stringify(fieldName)}`);
  }
  const beforeField = declarationSource.slice(0, fieldMatch.index);
  const commentStart = beforeField.lastIndexOf("/**");
  const commentEnd = commentStart === -1 ? -1 : declarationSource.indexOf("*/", commentStart);
  if (commentStart === -1 || commentEnd === -1 || commentEnd > fieldMatch.index) {
    throw new Error(`${relativePath} ${declarationMarker}.${fieldName} is missing JSDoc`);
  }
  if (!/^\s*$/u.test(declarationSource.slice(commentEnd + 2, fieldMatch.index))) {
    throw new Error(`${relativePath} ${declarationMarker}.${fieldName} has no adjacent JSDoc`);
  }
  return normalized(
    declarationSource
      .slice(commentStart + 3, commentEnd)
      .replace(/^\s*\*\s?/gmu, ""),
  );
}

function interfaceFieldDoc(relativePath: string, interfaceName: string, fieldName: string): string {
  return declarationFieldDoc(relativePath, `export interface ${interfaceName} {`, fieldName);
}

function typeFieldDoc(relativePath: string, typeName: string, fieldName: string): string {
  return declarationFieldDoc(relativePath, `export type ${typeName} =`, fieldName);
}

function functionDoc(relativePath: string, functionName: string): string {
  const source = readRepoFile(relativePath);
  const functionPattern = new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`, "u");
  const functionMatch = functionPattern.exec(source);
  if (functionMatch === null) {
    throw new Error(`${relativePath} is missing function ${JSON.stringify(functionName)}`);
  }
  const beforeFunction = source.slice(0, functionMatch.index);
  const commentStart = beforeFunction.lastIndexOf("/**");
  const commentEnd = commentStart === -1 ? -1 : source.indexOf("*/", commentStart);
  if (commentStart === -1 || commentEnd === -1 || commentEnd > functionMatch.index) {
    throw new Error(`${relativePath} ${functionName} is missing JSDoc`);
  }
  if (!/^\s*$/u.test(source.slice(commentEnd + 2, functionMatch.index))) {
    throw new Error(`${relativePath} ${functionName} has no adjacent JSDoc`);
  }
  return normalized(
    source
      .slice(commentStart + 3, commentEnd)
      .replace(/^\s*\*\s?/gmu, ""),
  );
}

describe("observability redaction docs parity", () => {
  it("distinguishes always-scanned local artifacts from the opt-in exporter scan", () => {
    const recorderSurfaces = [
      ["docs/runtime/tools-and-guards.md", "Each run collects per-turn usage"],
      ["docs/observability/index.md", "| JSONL run artifacts |"],
      ["docs/playbooks/phoenix-observed-agent.md", "- [`observability.jsonl-artifacts`]"],
      ["docs/reference/feature-registry.md", "| `observability.jsonl-artifacts` |"],
      ["packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md", "| JSONL run artifacts"],
      ["packages/agent-app/skills/mono-agent-composer/references/playbooks.md", "**Smoke:** complete a TUI prompt"],
      ["packages/agent-app/skills/mono-agent-composer/references/validation.md", "| Observability |"],
    ] as const;

    for (const [relativePath, anchor] of recorderSurfaces) {
      expect(lineContaining(relativePath, anchor), `${relativePath}: ${anchor}`).toContain(RECORDER_REDACTION_CONTRACT);
    }

    const exporterSurfaces = [
      ["docs/observability/phoenix-and-backfill.md", "| `includeSensitiveData` |"],
      ["docs/playbooks/phoenix-observed-agent.md", "With `includeSensitiveData: false`"],
      ["docs/reference/feature-registry.md", "| `observability.phoenix-exporter` |"],
    ] as const;
    for (const [relativePath, anchor] of exporterSurfaces) {
      expect(lineContaining(relativePath, anchor), `${relativePath}: ${anchor}`).toContain(SHARED_REDACTION_CONTRACT);
    }
  });

  it("distinguishes RunHistory's second sanitizer from shared observability redaction", () => {
    const surfaces = [
      markdownSection("docs/tools/mcp.md", "`RunHistory`: prior-run evidence"),
      markdownSection(
        "docs/observability/artifacts-and-traces.md",
        "Agent-facing prior-run evidence (`RunHistory`)",
      ),
      lineContaining("docs/reference/feature-registry.md", "| `agent-app.run-history-tool` |"),
      paragraphContaining("packages/agent-app/README.md", "`RunHistory` requires no config key."),
    ];

    for (const surface of surfaces) {
      expect(surface).toContain(SHARED_REDACTION_CONTRACT);
      expect(surface).toContain(RUN_HISTORY_SECOND_PASS_CONTRACT);
    }
  });

  it("documents the current separator misses and substring false positives as follow-up", () => {
    for (const relativePath of [
      "docs/observability/artifacts-and-traces.md",
      "packages/observability/README.md",
    ]) {
      const page = normalized(readRepoFile(relativePath));
      expect(page).toContain("follow-up");
      for (const term of ["space", "dot", "slash", "colon", "credentialtype", "bearerstatus", "privatekeyboard"]) {
        expect(page, `${relativePath} is missing ${term}`).toContain(term);
      }
    }
  });

  it("keeps recorder-boundary summaries explicit about both persisted redaction passes", () => {
    const surfaces = [
      ["README.md", "Local JSONL artifacts are the completed-run fallback"],
      ["docs/observability/artifacts-and-traces.md", "mono-agent is local-first about observability"],
      ["docs/observability/artifacts-and-traces.md", "- `run-<id>.events.jsonl`"],
      ["docs/observability/phoenix-and-backfill.md", "Phoenix export never changes a run's outcome"],
      ["docs/playbooks/phoenix-observed-agent.md", "This playbook configures best-effort"],
      ["docs/playbooks/phoenix-observed-agent.md", "The exporters array can also be supplied"],
      ["docs/channels/tui.md", "Frames are defined in `@mono-agent/agent-contracts`"],
      ["docs/config/blueprint.md", "buffers sensitive-key-redacted"],
      ["docs/observability/tui.md", "Remote event frames are capped"],
      ["docs/observability/tui.md", "| replay | `f3` |"],
      ["docs/reference/feature-registry.md", "| `tui.chat` |"],
      ["packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md", "buffers sensitive-key-redacted"],
      ["packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md", "Fills: `artifacts.dir`"],
      ["packages/agent-app/skills/mono-agent-composer/references/package-map.md", "- `@mono-agent/tui`"],
      ["packages/agent-app/skills/mono-agent-composer/references/package-map.md", "Traceability is local-first"],
      ["packages/agent-app/skills/mono-agent-composer/references/playbooks.md", "**Goal:** run locally with the TUI"],
      ["packages/observability/README.md", "`.events.jsonl` artifacts contain"],
    ] as const;

    for (const [relativePath, anchor] of surfaces) {
      const surface = lineContaining(relativePath, anchor);
      expect(surface, `${relativePath}: ${anchor}`).toContain("key");
      expect(surface, `${relativePath}: ${anchor}`).toContain("redact");
      expect(surface, `${relativePath}: ${anchor}`).toMatch(/credential-(?:shape|scanned)|credential shapes/u);
    }
    const staleRunContract = paragraphContaining(
      "packages/observability/README.md",
      "Stale-run reconciliation repairs summary status",
    );
    expect(staleRunContract).toContain("redacted");
    expect(normalized(readRepoFile("packages/observability/README.md"))).toContain("always-on credential-shape scan");
  });

  it("keeps public replay and payload boundaries explicit about shared redaction semantics", () => {
    expect(lineContaining("packages/tui/README.md", "| replay | Recorded runs"))
      .toContain(RECORDER_REDACTION_CONTRACT);

    const exporterSurfaces = [
      interfaceFieldDoc("packages/observability/src/run-export-mapping.ts", "EventSpanMapping", "payload"),
      functionDoc("packages/observability/src/run-export-mapping.ts", "toContentString"),
    ];

    for (const surface of exporterSurfaces) {
      expect(surface).toContain(SHARED_REDACTION_CONTRACT);
    }

    const rawStringContent = functionDoc("packages/observability/src/run-export-mapping.ts", "toContentString");
    expect(rawStringContent).toContain("raw string input is retained free text");
    expect(rawStringContent).toContain("capped for display");
    expect(rawStringContent).toContain("not content-scanned by default");
    expect(rawStringContent).toContain(CONTENT_PATTERN_OPTION);
  });

  it("keeps the exporter content-pattern scan explicitly opt-in and default-off", () => {
    const operatorSurfaces = [
      paragraphContaining("README.md", "Phoenix is the recommended trace viewer"),
      paragraphContaining("packages/observability/README.md", "Privacy default is metadata-only"),
      lineContaining("docs/observability/phoenix-and-backfill.md", "| `contentPatternRedaction` |"),
      lineContaining("docs/reference/feature-registry.md", "| `observability.phoenix-exporter` |"),
    ];

    for (const surface of operatorSurfaces) {
      expect(surface).toContain(CONTENT_PATTERN_OPTION);
      expect(surface).toMatch(/\b(?:default(?:s)?(?:-off)?|false|opt-in)\b/u);
    }

    const implementationSurfaces = [
      interfaceFieldDoc("packages/observability/src/types.ts", "RunExportContext", "contentPatternRedaction"),
      interfaceFieldDoc("packages/observability/src/types.ts", "PhoenixExporterConfig", "contentPatternRedaction"),
      functionDoc("packages/observability/src/run-export-mapping.ts", "toContentString"),
      functionDoc("packages/observability/src/otel/spans.ts", "buildRunReadableSpans"),
    ];
    for (const surface of implementationSurfaces) {
      expect(surface).toContain("high-confidence");
      expect(surface).toContain("scan");
    }
  });

  it("keeps persisted backfill input forwarding and its export bound explicit", () => {
    const surfaces = [
      interfaceFieldDoc("packages/observability/src/types.ts", "RunExportContext", "userInput"),
      functionDoc("packages/observability/src/otel/spans.ts", "buildRunReadableSpans"),
      functionDoc("packages/agent-app/src/backfill.ts", "backfillRuns"),
    ];

    for (const surface of surfaces) {
      expect(surface).toContain(BACKFILL_INPUT_CONTRACT);
    }
    expect(surfaces[0]).toContain("bounded at the phoenix span boundary");
    expect(surfaces[1]).toContain("utf-8-aware export boundary");

    const implementationDocs = normalized([
      readRepoFile("packages/observability/src/types.ts"),
      readRepoFile("packages/observability/src/otel/spans.ts"),
      readRepoFile("packages/agent-app/src/backfill.ts"),
    ].join("\n"));
    expect(implementationDocs).not.toMatch(/absent for backfill|backfill lacks it|not recorded in artifacts/iu);
  });

  it("documents recorder scanning separately from legacy-reader and display behavior", () => {
    const persistedFields = [
      ["packages/observability/src/types.ts", "RunSummary", "error"],
      ["packages/observability/src/types.ts", "RunSummary", "userInput"],
      ["packages/observability/src/types.ts", "RunSummary", "systemPrompt"],
      ["packages/observability/src/types.ts", "JsonlRunRecorderOptions", "userInput"],
      ["packages/observability/src/types.ts", "JsonlRunRecorderOptions", "systemPrompt"],
    ] as const;
    for (const [relativePath, interfaceName, fieldName] of persistedFields) {
      const doc = interfaceFieldDoc(relativePath, interfaceName, fieldName);
      expect(doc, `${interfaceName}.${fieldName}`).toContain("retained free text");
      expect(doc, `${interfaceName}.${fieldName}`).toMatch(/\b(?:bounded|capped)\b/u);
      expect(doc, `${interfaceName}.${fieldName}`).toContain("content-scanned");
      expect(doc, `${interfaceName}.${fieldName}`).toContain("high-confidence credential shapes");
    }

    const legacyReaderFields = [
      ["packages/observability/src/types.ts", "RecordedRunListItem", "error"],
      ["packages/observability/src/types.ts", "RecordedRunListItem", "userInput"],
      ["packages/observability/src/types.ts", "RecordedRunListItem", "systemPrompt"],
    ] as const;
    for (const [relativePath, interfaceName, fieldName] of legacyReaderFields) {
      const doc = interfaceFieldDoc(relativePath, interfaceName, fieldName);
      expect(doc, `${interfaceName}.${fieldName}`).toContain("retained free text");
      expect(doc, `${interfaceName}.${fieldName}`).toContain("re-bounded");
      expect(doc, `${interfaceName}.${fieldName}`).toContain("does not retroactively scan legacy artifacts");
    }

    const displayFields = [
      ["packages/observability/src/session-mapping.ts", "Session", "instr"],
      ["packages/observability/src/session-mapping.ts", "Session", "sysPrompt"],
      ["packages/observability/src/session-mapping.ts", "Session", "error"],
    ] as const;

    for (const [relativePath, interfaceName, fieldName] of displayFields) {
      const doc = interfaceFieldDoc(relativePath, interfaceName, fieldName);
      expect(doc, `${interfaceName}.${fieldName}`).toContain("retained free text");
      expect(doc, `${interfaceName}.${fieldName}`).toMatch(/\b(?:bounded|capped|re-bounded)\b/u);
      expect(doc, `${interfaceName}.${fieldName}`).toContain("not content-scanned or scrubbed");
    }

    const liveExportInput = interfaceFieldDoc(
      "packages/observability/src/types.ts",
      "RunExportContext",
      "userInput",
    );
    expect(liveExportInput).toContain("retained free text");
    expect(liveExportInput).toContain("not content-scanned by default");
    expect(liveExportInput).toContain(CONTENT_PATTERN_OPTION);
    expect(liveExportInput).not.toMatch(/\bredacted\s*(?:\+|and|into)\b/u);
  });
});
