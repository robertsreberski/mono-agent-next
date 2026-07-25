// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkConsumerDocsConsistency,
  compareCodeUnits,
} from "../check/consumer-docs-consistency.mjs";

const tempDirs = [];
const monoPackage = (...nameParts) => `@mono-agent/${nameParts.join("-")}`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-consumer-docs-consistency", () => {
  it("flags retired pre-v1 package references in repo user docs", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/getting-started/quickstart.md", [
      "# Quickstart",
      "",
      "Install @mono-agent/agent-evals for the old evaluation path.",
      "The memory-bujo package owns durable memory.",
      "WhatsApp and A2A are bundled core channels.",
      "Built-in WhatsApp/A2A channels are available.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.checked).toBe(0);
    expect(result.userDocsChecked).toBe(1);
    expect(result.issues).toHaveLength(4);
    expect(result.issues.join("\n")).toContain("@mono-agent/agent-evals");
    expect(result.issues.join("\n")).toContain("memory-bujo package");
    expect(result.issues.join("\n")).toContain("WhatsApp/A2A in core");
  });

  it("allows current generic and external-plugin references", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/config/blueprint.md", [
      "# Config",
      "",
      "Settings can be adjusted in mono-agent.config.json.",
      "WhatsApp and A2A are external channel plugins/extras.",
      "Use memory.llm.provider: \"agent-host\" for SDK memory capture.",
      "Run memory-bujo recall ./memory \"question\" for manual maintenance.",
      "JSONL artifacts become the completed-run record after terminal persistence; events buffer in memory before then.",
      "JSONL artifacts are not a source of truth for in-flight runs.",
      "Replay shows only redacted, bounded events that reached terminal persistence.",
      "A separate tool-output artifact may retain a block when best-effort persistence succeeds.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.userDocsChecked).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("flags retired memory tools across shipped demo Markdown while excluding generated and historical copies", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "demos/a/IDENTITY.example.md", [
      "# Identity",
      "",
      "Use journal_append.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "demos/a/SOUL.example.md", "Use entity_get.\n");
    await writeRepoDoc(repoRoot, "demos/b/README.md", "Use memory_search.\n");
    await writeRepoDoc(repoRoot, "demos/c/PLAYBOOK.example.md", "Use memory_read_day or memory_list_days.\n");
    await writeRepoDoc(
      repoRoot,
      "website/src/content/docs/demo.md",
      "Generated copy says to use memory_search and journal_append.\n",
    );
    await writeRepoDoc(repoRoot, "audit/history.md", "Historical memory_search and journal_append references.\n");

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.userDocsChecked).toBe(4);
    expect(result.issues).toHaveLength(5);
    expect(result.issues[0]).toContain('demos/a/IDENTITY.example.md:3:5: references retired memory tool "journal_append"');
    expect(result.issues[1]).toContain('demos/a/SOUL.example.md:1:5: references retired memory tool "entity_get"');
    expect(result.issues[2]).toContain('demos/b/README.md:1:5: references retired memory tool "memory_search"');
    expect(result.issues[3]).toContain('demos/c/PLAYBOOK.example.md:1:5: references retired memory tool "memory_read_day"');
    expect(result.issues[4]).toContain('demos/c/PLAYBOOK.example.md:1:24: references retired memory tool "memory_list_days"');
    expect(result.issues.join("\n")).not.toContain("website/src/content/docs");
    expect(result.issues.join("\n")).not.toContain("audit/history.md");
  });

  it("orders recursive demo Markdown by locale-independent UTF-16 code units", async () => {
    const repoRoot = await tempRepo();
    const orderedPaths = [
      "demos/A/README.md",
      "demos/Z/README.md",
      "demos/Ä/README.md",
      "demos/á/README.md",
    ];
    for (const relativePath of orderedPaths) {
      await writeRepoDoc(repoRoot, relativePath, "Use journal_append.\n");
    }

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.issues).toHaveLength(orderedPaths.length);
    expect(result.issues.map((issue) => issue.slice(repoRoot.length + 1).split(":", 1)[0])).toEqual(
      orderedPaths,
    );
    expect(["á", "a", "Ä", "A", "Z"].sort(compareCodeUnits)).toEqual([
      "A",
      "Z",
      "a",
      "Ä",
      "á",
    ]);
  });

  it("enforces canonical MemoryRecall spelling in current package READMEs", async () => {
    const repoRoot = await tempRepo();
    const readmePaths = [
      "packages/core/README.md",
      "packages/memory-local/README.md",
      "packages/module-sdk/README.md",
      "packages/create-mono-agent/README.md",
    ];
    for (const relativePath of readmePaths) {
      await writeRepoDoc(repoRoot, relativePath, "Use canonical `MemoryRecall`.\n");
    }

    const baseline = await checkConsumerDocsConsistency([], { repoRoot });
    expect(baseline.userDocsChecked).toBe(readmePaths.length);
    expect(baseline.issues).toEqual([]);

    for (const relativePath of readmePaths) {
      await writeRepoDoc(repoRoot, relativePath, "Use deprecated `memory_recall`.\n");
      const mutated = await checkConsumerDocsConsistency([], { repoRoot });
      expect(mutated.issues).toHaveLength(1);
      expect(mutated.issues[0]).toContain(`${relativePath}:1:17: retired alias "memory_recall"`);
      await writeRepoDoc(repoRoot, relativePath, "Use canonical `MemoryRecall`.\n");
    }
  });

  it("rejects active lowercase memory_recall identities while allowing exact history records", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(
      repoRoot,
      "AGENTS.md",
      "The canonical app-owned tool is `memory_recall`.\n",
    );
    await writeRepoDoc(
      repoRoot,
      "docs/memory/migration.md",
      historyAnnotationBlock("docs/memory/migration.md", 2) + "\n",
    );
    await writeRepoDoc(
      repoRoot,
      "demos/current/SOUL.example.md",
      historyAnnotationBlock("demos/current/SOUL.example.md", 2) + "\n",
    );
    await writeRepoDoc(
      repoRoot,
      "docs/memory/compatibility.md",
      [
        historyAnnotationBlock("docs/memory/compatibility.md", 2),
        historyAnnotationBlock("docs/memory/compatibility.md", 4),
      ].join("\n"),
    );
    await writeRepoDoc(
      repoRoot,
      "website/src/content/docs/copied-agents.md",
      "The canonical app-owned tool is `memory_recall`.\n",
    );

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.userDocsChecked).toBe(4);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("AGENTS.md:1:34");
    expect(result.issues[0]).toContain('retired alias "memory_recall"');
    expect(result.issues.join("\n")).not.toContain("migration.md");
    expect(result.issues.join("\n")).not.toContain("website/src/content/docs");
  });

  it("rejects every unannotated occurrence regardless of nearby qualifiers", async () => {
    const repoRoot = await tempRepo();
    const probes = [
      "The old API is deprecated; the canonical tool to use is `memory_recall`.",
      "`memory_recall` is not deprecated; use it for recall.",
      "The `memory_recall` alias is deprecated, but agents should still use `memory_recall`.",
      "Legacy mode is disabled. Use `memory_recall` as the current tool.",
    ];
    await writeRepoDoc(repoRoot, "docs/memory/adversarial-aliases.md", `${probes.join("\n")}\n`);

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.issues).toHaveLength(5);
    expect(result.issues.map((issue) => issue.match(/adversarial-aliases\.md:(\d+):(\d+)/u)?.slice(1))).toEqual([
      ["1", String(probes[0].indexOf("memory_recall") + 1)],
      ["2", String(probes[1].indexOf("memory_recall") + 1)],
      ["3", String(probes[2].indexOf("memory_recall") + 1)],
      ["3", String(probes[2].lastIndexOf("memory_recall") + 1)],
      ["4", String(probes[3].indexOf("memory_recall") + 1)],
    ]);
  });

  it("rejects negated or unrelated qualifiers immediately before memory_recall", async () => {
    const repoRoot = await tempRepo();
    const probes = [
      "This is not a deprecated alias `memory_recall`; use it as the current tool.",
      "This is no longer the legacy alias `memory_recall`; use it as the current tool.",
      "This is not actually a deprecated alias `memory_recall`; use it as the current tool.",
      "The retired alias `run_history` remains documented; use `memory_recall` for current recall.",
    ];
    await writeRepoDoc(repoRoot, "demos/current/NEGATED.example.md", `${probes.join("\n")}\n`);

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.issues).toHaveLength(4);
    expect(result.issues.map((issue) => issue.match(/NEGATED\.example\.md:(\d+):(\d+)/u)?.slice(1))).toEqual(
      probes.map((probe, index) => [String(index + 1), String(probe.indexOf("memory_recall") + 1)]),
    );
  });

  it("rejects the prior 12 active and 7 history forms until history is migrated", async () => {
    const activeRepoRoot = await tempRepo();
    const activeProbes = [
      { text: "The old API is deprecated; the canonical tool to use is `memory_recall`." },
      { text: "`memory_recall` is not deprecated; use it for recall." },
      {
        text: "The `memory_recall` alias is deprecated, but agents should still use `memory_recall`.",
      },
      { text: "Legacy mode is disabled. Use `memory_recall` as the current tool." },
      { text: "This is not a deprecated alias `memory_recall`; use it as the current tool." },
      { text: "This is no longer the legacy alias `memory_recall`; use it as the current tool." },
      { text: "This is not actually a deprecated alias `memory_recall`; use it as the current tool." },
      { text: "The retired alias `run_history` remains documented; use `memory_recall` for current recall." },
      { text: "This is not a currently deprecated alias `memory_recall`; use it as the current tool." },
      { text: "This is not an actually deprecated alias `memory_recall`; use it as the current tool." },
      { text: "This is not an officially deprecated alias `memory_recall`; use it as the current tool." },
      { text: "The label is not a deprecated compatibility alias `memory_recall`; use it now." },
    ];
    await writeRepoDoc(
      activeRepoRoot,
      "docs/memory/active-alias-matrix.md",
      `${activeProbes.map(({ text }) => text).join("\n")}\n`,
    );

    const validRepoRoot = await tempRepo();
    const validProbes = [
      "The deprecated compatibility alias `memory_recall` maps to canonical `MemoryRecall`.",
      "Use canonical `MemoryRecall`; legacy alias `memory_recall` exists for compatibility only.",
      "`memory_recall` remains accepted only as a deprecated input alias.",
      "The historical name `memory_recall` is retained for migration documentation.",
      "The retired name `memory_recall` appears only in migration documentation.",
      "The backward-compatible input alias `memory_recall` maps to canonical `MemoryRecall`.",
      "`memory_recall` compatibility alias is deprecated.",
    ];
    await writeRepoDoc(
      validRepoRoot,
      "docs/memory/valid-alias-matrix.md",
      `${validProbes.join("\n")}\n`,
    );

    const migratedRepoRoot = await tempRepo();
    const migratedPath = "docs/memory/migrated-alias-matrix.md";
    await writeRepoDoc(
      migratedRepoRoot,
      migratedPath,
      historyAnnotationDocument(migratedPath, validProbes.length),
    );

    const [activeResult, validResult, migratedResult] = await Promise.all([
      checkConsumerDocsConsistency([], { repoRoot: activeRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: validRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: migratedRepoRoot }),
    ]);

    expect(activeResult.issues).toHaveLength(13);
    expect(
      activeResult.issues.map((issue) => issue.match(/active-alias-matrix\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(activeProbes.map(({ text }) => text)));
    expect(validResult.issues).toHaveLength(validProbes.length);
    expect(
      validResult.issues.map((issue) => issue.match(/valid-alias-matrix\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(validProbes));
    expect(migratedResult.issues).toEqual([]);
  });

  it("rejects the prior five active and three history forms unless history uses the contract", async () => {
    const activeRepoRoot = await tempRepo();
    const activeProbes = [
      "The deprecated compatibility alias `memory_recall` is still the canonical tool to use.",
      "`memory_recall` compatibility alias is not deprecated; use it as the current tool.",
      "This isn't a deprecated alias `memory_recall`; use it as the current tool.",
      "This is not considered to be a deprecated alias `memory_recall`; use it as the current tool.",
      "Do not treat this as a deprecated alias `memory_recall`; use it as the current tool.",
    ];
    await writeRepoDoc(
      activeRepoRoot,
      "docs/memory/natural-active-aliases.md",
      `${activeProbes.join("\n")}\n`,
    );

    const historyRepoRoot = await tempRepo();
    const historyProbes = [
      "The deprecated alias `memory_recall` was previously the active tool name.",
      "`memory_recall` remains accepted only as a deprecated input alias; do not recommend it.",
      "The historical name `memory_recall` appeared in pre-v1 docs.",
    ];
    await writeRepoDoc(
      historyRepoRoot,
      "docs/memory/legitimate-history.md",
      `${historyProbes.join("\n")}\n`,
    );

    const migratedRepoRoot = await tempRepo();
    const migratedPath = "docs/memory/migrated-legitimate-history.md";
    await writeRepoDoc(
      migratedRepoRoot,
      migratedPath,
      historyAnnotationDocument(migratedPath, historyProbes.length),
    );

    const [activeResult, historyResult, migratedResult] = await Promise.all([
      checkConsumerDocsConsistency([], { repoRoot: activeRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: historyRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: migratedRepoRoot }),
    ]);

    expect(activeResult.issues).toHaveLength(activeProbes.length);
    expect(
      activeResult.issues.map((issue) => issue.match(/natural-active-aliases\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(
      activeProbes.map((probe, index) => [
        String(index + 1),
        String(probe.indexOf("memory_recall") + 1),
      ]),
    );
    expect(historyResult.issues).toHaveLength(historyProbes.length);
    expect(
      historyResult.issues.map((issue) => issue.match(/legitimate-history\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(historyProbes));
    expect(migratedResult.issues).toEqual([]);
  });

  it("rejects generated prose uniformly and handles every neighboring occurrence", async () => {
    const qualifierPhrases = [
      "deprecated alias",
      "deprecated compatibility alias",
      "legacy alias",
      "historical name",
      "retired reference",
      "backward-compatible input alias",
    ];
    const activeFrames = [
      (qualifier) => `The ${qualifier} \`memory_recall\` is still the current tool to use.`,
      (qualifier) => `This isn't a ${qualifier} \`memory_recall\`; use it now.`,
      (qualifier) => `This isn’t a ${qualifier} \`memory_recall\`; use it now.`,
      (qualifier) => `This is not considered to be a ${qualifier} \`memory_recall\`; use it now.`,
      (qualifier) => `Do not treat this as a ${qualifier} \`memory_recall\`; use it now.`,
      (qualifier) => `\`memory_recall\` ${qualifier} is not deprecated; use it now.`,
      (qualifier) => `\`memory_recall\` is not a ${qualifier}; use it now.`,
      (qualifier) => `The ${qualifier} \`memory_recall\` remains canonical.`,
      (qualifier) => `The ${qualifier} \`memory_recall\` was previously active, and agents should use it now.`,
      (qualifier) => `The ${qualifier} \`memory_recall\` is documented for history; use it as the current tool.`,
      (qualifier) => `The ${qualifier} \`memory_recall\`, previously active, remains the current tool.`,
      (qualifier) => `Agents should invoke the ${qualifier} \`memory_recall\`.`,
      (qualifier) => `The ${qualifier} \`memory_recall\` remains the option agents should choose.`,
      (qualifier) => `The ${qualifier} \`memory_recall\` remains the default tool.`,
      (qualifier) => `The ${qualifier} \`memory_recall\` is still the official name.`,
    ];
    const activeProbes = qualifierPhrases.flatMap((qualifier) =>
      activeFrames.map((frame) => frame(qualifier)),
    );
    const validProbes = qualifierPhrases.flatMap((qualifier) => [
      `The ${qualifier} \`memory_recall\` is documented for migration only.`,
      `\`memory_recall\` remains documented only as a ${qualifier}.`,
      `\`memory_recall\` remains documented only as a ${qualifier}; do not recommend it.`,
    ]);
    const multipleOccurrenceProbes = [
      "The deprecated alias `memory_recall` maps to canonical `MemoryRecall`, but agents should use `memory_recall` as the current tool.",
      "`memory_recall` remains accepted only as a deprecated input alias and `memory_recall` is the current tool to use.",
      "Use `memory_recall` as the current tool, but the historical name `memory_recall` remains in migration docs.",
      "The deprecated alias `memory_recall` remains documented; use `memory_recall` as the current tool.",
    ];

    const activeRepoRoot = await tempRepo();
    await writeRepoDoc(activeRepoRoot, "docs/memory/generated-active.md", `${activeProbes.join("\n")}\n`);
    const validRepoRoot = await tempRepo();
    await writeRepoDoc(validRepoRoot, "docs/memory/generated-valid.md", `${validProbes.join("\n")}\n`);
    const migratedRepoRoot = await tempRepo();
    const migratedPath = "docs/memory/generated-migrated.md";
    await writeRepoDoc(
      migratedRepoRoot,
      migratedPath,
      historyAnnotationDocument(migratedPath, validProbes.length),
    );
    const multipleRepoRoot = await tempRepo();
    await writeRepoDoc(
      multipleRepoRoot,
      "docs/memory/multiple-occurrences.md",
      `${multipleOccurrenceProbes.join("\n")}\n`,
    );

    const [activeResult, validResult, migratedResult, multipleResult] = await Promise.all([
      checkConsumerDocsConsistency([], { repoRoot: activeRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: validRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: migratedRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: multipleRepoRoot }),
    ]);

    expect(activeResult.issues).toHaveLength(activeProbes.length);
    expect(validResult.issues).toHaveLength(validProbes.length);
    expect(
      validResult.issues.map((issue) => issue.match(/generated-valid\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(validProbes));
    expect(migratedResult.issues).toEqual([]);
    expect(multipleResult.issues).toHaveLength(8);
    expect(
      multipleResult.issues.map((issue) => issue.match(/multiple-occurrences\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(multipleOccurrenceProbes));
  });

  it("rejects the full natural challenge matrix until legitimate history is migrated", async () => {
    const activeProbes = [
      "The deprecated alias `memory_recall` was previously active; use it now.",
      "The deprecated alias `memory_recall` must be run for every recall.",
      "The deprecated alias `memory_recall` is the standard tool name.",
      "Despite deprecation, agents rely on `memory_recall` for recall.",
      "`memory_recall` remains supported and should be configured.",
      "Choose `memory_recall` whenever older context is needed.",
      "The compatibility name `memory_recall` is the default invocation.",
      "Production agents call `memory_recall` before each answer.",
    ];
    const legitimateHistoryProbes = [
      "Use `MemoryRecall` instead of the deprecated alias `memory_recall`.",
      "The deprecated alias `memory_recall` was used previously in old docs.",
      "The deprecated alias `memory_recall` is retained only so existing configs continue to work.",
      "Avoid using `memory_recall` because it is a deprecated alias.",
      "Do not call `memory_recall`; it was the pre-v1 spelling.",
      "Existing migration notes may mention `memory_recall`, which is retired.",
      "The old configuration example `memory_recall` is shown only for comparison.",
      "Replace any occurrence of `memory_recall` with `MemoryRecall`.",
      "`memory_recall` appeared in logs produced before the rename.",
      "A compatibility parser still recognizes `memory_recall` for old manifests.",
      "The migration guide quotes `memory_recall` as the removed name.",
      "Never recommend `memory_recall`; canonical docs use `MemoryRecall`.",
      "Historical screenshots can display `memory_recall`.",
      "The v0 release notes referred to `memory_recall`.",
      "Support can identify stale configs by the literal `memory_recall`.",
    ];

    const activeRepoRoot = await tempRepo();
    const activePath = "docs/memory/natural-challenge-active.md";
    await writeRepoDoc(activeRepoRoot, activePath, activeProbes.join("\n") + "\n");

    const historyRepoRoot = await tempRepo();
    const historyPath = "docs/memory/natural-challenge-history.md";
    await writeRepoDoc(historyRepoRoot, historyPath, legitimateHistoryProbes.join("\n") + "\n");

    const migratedRepoRoot = await tempRepo();
    const migratedPath = "docs/memory/natural-challenge-migrated.md";
    await writeRepoDoc(
      migratedRepoRoot,
      migratedPath,
      historyAnnotationDocument(migratedPath, legitimateHistoryProbes.length),
    );

    const [activeResult, historyResult, migratedResult] = await Promise.all([
      checkConsumerDocsConsistency([], { repoRoot: activeRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: historyRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: migratedRepoRoot }),
    ]);

    expect(activeResult.issues).toHaveLength(activeProbes.length);
    expect(
      activeResult.issues.map((issue) => issue.match(/natural-challenge-active\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(activeProbes));
    expect(historyResult.issues).toHaveLength(legitimateHistoryProbes.length);
    expect(
      historyResult.issues.map((issue) => issue.match(/natural-challenge-history\.md:(\d+):(\d+)/u)?.slice(1)),
    ).toEqual(aliasLocations(legitimateHistoryProbes));
    expect(migratedResult.issues).toEqual([]);
  });

  it("requires an exact path-and-line history annotation and rejects annotation abuse", async () => {
    const validRepoRoot = await tempRepo();
    const validPath = "docs/memory/annotated-history.md";
    await writeRepoDoc(validRepoRoot, validPath, historyAnnotationBlock(validPath, 2) + "\n");

    const unannotatedRepoRoot = await tempRepo();
    await writeRepoDoc(
      unannotatedRepoRoot,
      "docs/memory/unannotated-history.md",
      HISTORY_ANNOTATION_PAYLOAD + "\n",
    );

    const activeRepoRoot = await tempRepo();
    const activePath = "docs/memory/annotated-active.md";
    await writeRepoDoc(activeRepoRoot, activePath, [
      historyAnnotationMarker(activePath, 2),
      "Agents must use `memory_recall` for every recall.",
      "",
    ].join("\n"));

    const staleRepoRoot = await tempRepo();
    const stalePath = "docs/memory/stale-history.md";
    await writeRepoDoc(staleRepoRoot, stalePath, [
      historyAnnotationMarker(stalePath, 2),
      HISTORY_ANNOTATION_PAYLOAD.replace("is retired", "was retired"),
      "",
    ].join("\n"));

    const movedRepoRoot = await tempRepo();
    const originalPath = "docs/memory/original-history.md";
    await writeRepoDoc(movedRepoRoot, "docs/memory/moved-history.md", [
      historyAnnotationMarker(originalPath, 2),
      HISTORY_ANNOTATION_PAYLOAD,
      "",
    ].join("\n"));

    const shiftedRepoRoot = await tempRepo();
    const shiftedPath = "docs/memory/shifted-history.md";
    await writeRepoDoc(shiftedRepoRoot, shiftedPath, [
      historyAnnotationMarker(shiftedPath, 3),
      HISTORY_ANNOTATION_PAYLOAD,
      "",
    ].join("\n"));

    const malformedRepoRoot = await tempRepo();
    const malformedPath = "docs/memory/malformed-history.md";
    await writeRepoDoc(malformedRepoRoot, malformedPath, [
      "<!-- mono-agent-doc-history:v1 " +
        JSON.stringify({ path: malformedPath, line: 2, reason: "history" }) +
        " -->",
      HISTORY_ANNOTATION_PAYLOAD,
      "",
    ].join("\n"));

    const duplicateRepoRoot = await tempRepo();
    const duplicatePath = "docs/memory/duplicate-history.md";
    await writeRepoDoc(duplicateRepoRoot, duplicatePath, [
      "<!-- mono-agent-doc-history:v1 " +
        `{"path":"wrong.md","path":"${duplicatePath}","line":2}` +
        " -->",
      HISTORY_ANNOTATION_PAYLOAD,
      "",
    ].join("\n"));

    const multipleRepoRoot = await tempRepo();
    const multiplePath = "docs/memory/exact-occurrences.md";
    const activeLine = "Use `memory_recall` now; `memory_recall` is the standard tool.";
    await writeRepoDoc(multipleRepoRoot, multiplePath, [
      historyAnnotationBlock(multiplePath, 2),
      activeLine,
      "",
    ].join("\n"));

    const [valid, unannotated, active, stale, moved, shifted, malformed, duplicate, multiple] = await Promise.all([
      checkConsumerDocsConsistency([], { repoRoot: validRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: unannotatedRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: activeRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: staleRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: movedRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: shiftedRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: malformedRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: duplicateRepoRoot }),
      checkConsumerDocsConsistency([], { repoRoot: multipleRepoRoot }),
    ]);

    expect(valid.issues).toEqual([]);
    expect(unannotated.issues).toHaveLength(1);
    expect(active.issues).toHaveLength(2);
    expect(active.issues.join("\n")).toContain("history annotation payload must match exactly");
    expect(active.issues.join("\n")).toContain('retired alias "memory_recall"');
    expect(stale.issues.join("\n")).toContain("history annotation payload must match exactly");
    expect(moved.issues.join("\n")).toContain("history annotation path");
    expect(shifted.issues.join("\n")).toContain("history annotation line 3");
    expect(malformed.issues.join("\n")).toContain("history annotation metadata is invalid");
    expect(duplicate.issues.join("\n")).toContain("history annotation metadata is invalid");
    expect(multiple.issues).toHaveLength(2);
    expect(multiple.issues.map((issue) => issue.match(/exact-occurrences\.md:3:(\d+)/u)?.[1])).toEqual([
      String(activeLine.indexOf("memory_recall") + 1),
      String(activeLine.lastIndexOf("memory_recall") + 1),
    ]);
  });

  it("applies the same alias contract to supplied consumer READMEs", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/index.md", "# Docs\n");

    const activeConsumer = await tempDir("consumer-docs-active-");
    const activeReadme = "This consumer still calls `memory_recall`.\n";
    await writeFile(
      join(activeConsumer, "README.md"),
      activeReadme,
      "utf8",
    );
    await writeFile(join(activeConsumer, "mono-agent.config.json"), "{}\n", "utf8");

    const historyConsumer = await tempDir("consumer-docs-history-");
    await writeFile(
      join(historyConsumer, "README.md"),
      historyAnnotationBlock("README.md", 2) + "\n",
      "utf8",
    );
    await writeFile(join(historyConsumer, "mono-agent.config.json"), "{}\n", "utf8");

    const [activeResult, historyResult] = await Promise.all([
      checkConsumerDocsConsistency([activeConsumer], { repoRoot }),
      checkConsumerDocsConsistency([historyConsumer], { repoRoot }),
    ]);

    expect(activeResult.issues).toHaveLength(1);
    expect(activeResult.issues[0]).toContain(
      `README.md:1:${activeReadme.indexOf("memory_recall") + 1}`,
    );
    expect(historyResult.issues).toEqual([]);
  });

  it("flags absolute JSONL durability claims across authoritative repo docs", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "README.md", [
      "# Framework",
      "",
      "The local JSONL artifacts remain the local fallback and source of truth.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/observability/phoenix-and-backfill.md", [
      "# Phoenix",
      "",
      "Read from the always-on run record.",
      "See the always-on JSONL run record for backfill.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/config/folder-layout.md", [
      "# Layout",
      "",
      "Artifacts are the always-on local traceability fallback.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/exporter-otlp/README.md", [
      "# Observability",
      "",
      "Raw `.events.jsonl` artifacts stay append-only.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.checked).toBe(0);
    expect(result.userDocsChecked).toBe(4);
    expect(result.issues).toHaveLength(5);
    expect(result.issues.join("\n")).toContain("JSONL artifacts as a source of truth");
    expect(result.issues.join("\n")).toContain("always-on JSONL run record");
    expect(result.issues.join("\n")).toContain("always-on local traceability fallback");
    expect(result.issues.join("\n")).toContain("append-only JSONL run artifact");
  });

  it("flags full/no-drop TUI recovery claims across docs, package READMEs, and runtime source text", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/channels/tui.md", [
      "# TUI channel",
      "It streams every structured `AgentStreamEvent` verbatim.",
      "The full data stays in the run's [JSONL artifacts].",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/observability/tui.md", [
      "# TUI",
      "The full data is always in the run's JSONL artifacts and visible in replay.",
      "Replay opens a full coalesced event timeline.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/README.md", [
      "# TUI package",
      "Open any run for its full coalesced event timeline (nothing dropped).",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator/README.md", [
      "# Operator",
      "The endpoint streams at full `AgentStreamEvent` fidelity.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/terminal-text.ts", [
      "const notice = '(payload truncated for streaming — full data in run artifacts)';",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator/src/state.ts", [
      "// The full data remains in the run's JSONL artifacts.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/channel-operator/src/server.ts", [
      "// The full payload stays available in run artifacts.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator/package.json", [
      "// A full event timeline is richer than live since nothing is dropped.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/app.ts", [
      "const description = 'Browse recorded runs (full event timeline)';",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });
    const reported = result.issues.join("\n");

    expect(result.userDocsChecked).toBe(4);
    expect(result.artifactContractSourcesChecked).toBe(5);
    expect(reported).toContain("full payload guaranteed in run artifacts");
    expect(reported).toContain("full or no-drop replay timeline");
    expect(reported).toContain("full AgentStreamEvent fidelity");
    expect(reported).toContain("verbatim complete TUI event stream");
    for (const relativePath of [
      "docs/channels/tui.md",
      "docs/observability/tui.md",
      "packages/tui/README.md",
      "packages/operator/README.md",
      "packages/tui/src/ui/terminal-text.ts",
      "packages/operator/src/state.ts",
      "packages/channel-operator/src/server.ts",
      "packages/operator/package.json",
      "packages/tui/src/ui/app.ts",
    ]) {
      expect(reported).toContain(relativePath);
    }
  });

  it("flags residual absolute observability claims in playbooks, composer references, and operator sources", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/reference/v1-architecture.md", [
      "# Architecture",
      "live chat with full stream-event insight",
      "every structured `AgentStreamEvent` verbatim",
      "Serialized event frames over 256 KiB receive field-level reduction.",
      "Rich traces are exported on every run.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/playbooks/index.md", [
      "# Playbooks",
      "Every run lifecycle streams to a [Phoenix] dashboard.",
      "Redacted JSONL artifacts are always written locally as the fallback.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/config/reference.md", [
      "# Config",
      "JSONL artifacts (always written; the local fallback)",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/runtime/index.md", [
      "# Runtime",
      "When a tool result exceeds the budget it is persisted as an artifact, so nothing is silently lost.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/create-mono-agent/skills/mono-agent-composer/references/config.md", [
      "# Config",
      "live chat with full stream-event insight",
      "Serialized remote event frames are field-reduced to a strict cap.",
      "JSONL artifacts are always written regardless of exporter state.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/create-mono-agent/skills/mono-agent-composer/references/validation.md", [
      "# Validation",
      "stream every run to Phoenix as OpenInference spans",
      "Local JSONL artifacts are always written and are the fallback.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator/src/state.ts", [
      "// Upper bound for one serialized NDJSON frame.",
      "// Oversized events are field-reduced until the encoded frame fits.",
      "// Every oversized event is field reduced.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/channel-operator/src/server.ts", [
      "function describeExporter() {",
      "  return \"JSONL artifacts are always written locally\";",
      "}",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/app.ts", [
      "const HELP_COMMANDS = [",
      "  \"Open the operator console from any directory: live chat with full\",",
      "  \"thinking/tool/telemetry insight, recorded-run replay, and config view.\",",
      "];",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator/package.json", JSON.stringify({
      description: "Loopback operator adapters: full-fidelity TUI NDJSON turns and live SSE.",
    }));
    await writeRepoDoc(repoRoot, "packages/tui/package.json", JSON.stringify({
      description: "live chat with full stream-event insight",
    }));
    await writeRepoDoc(repoRoot, "scripts/lib/package-catalog.mjs", [
      "const responsibility = 'full-fidelity TUI NDJSON turns';",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/channels/tui.md", [
      "# TUI channel",
      "Structured event kinds are subject to the per-frame payload bound.",
      "Tool arguments and results stream up to the wire bound.",
      "A serialized event frame over 256 KiB is field-reduced and remeasured.",
      "Remote event frames above 256 KiB are field-reduced.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/observability/tui.md", [
      "# TUI",
      "Remote mode transports callbacks through the bounded wire protocol.",
      "Oversized remote event frames trigger reduction at the 256 KiB threshold; it is not a strict maximum.",
      "Oversized events receive field-level payload reduction until they fit.",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });
    const reported = result.issues.join("\n");

    expect(result.userDocsChecked).toBe(8);
    expect(result.artifactContractSourcesChecked).toBe(6);
    expect(reported).toContain("full stream-event insight");
    expect(reported).toContain("guaranteed every-run Phoenix stream");
    expect(reported).toContain("guaranteed every-run Phoenix export");
    expect(reported).toContain("always-written JSONL artifacts");
    expect(result.issues).toContain(
      `${join(repoRoot, "packages/channel-operator/src/server.ts")}:2:11: ` +
        "uses absolute observability/replay wording \"always-written JSONL artifacts\". " +
        "Describe transport and string caps, best-effort export, the start snapshot, " +
        "in-memory buffering, terminal replacement, and crash-loss/reconciliation boundaries instead.",
    );
    expect(reported).toContain("verbatim complete TUI event stream");
    expect(reported).toContain("broad TUI wire-bound claim");
    expect(reported).toContain("non-enforced TUI event reduction threshold");
    expect(reported).toContain("blanket TUI event field-reduction claim");
    expect(reported).toContain("full thinking/tool/telemetry help insight");
    expect(reported).toContain("full-fidelity TUI NDJSON metadata");
    expect(reported).toContain("guaranteed tool-output artifact persistence");
    for (const relativePath of [
      "docs/reference/v1-architecture.md",
      "docs/playbooks/index.md",
      "docs/config/reference.md",
      "docs/runtime/index.md",
      "packages/create-mono-agent/skills/mono-agent-composer/references/config.md",
      "packages/create-mono-agent/skills/mono-agent-composer/references/validation.md",
      "packages/channel-operator/src/server.ts",
      "packages/tui/src/ui/app.ts",
      "packages/operator/package.json",
      "packages/operator/src/state.ts",
      "packages/tui/package.json",
      "scripts/lib/package-catalog.mjs",
      "docs/channels/tui.md",
      "docs/observability/tui.md",
    ]) {
      expect(reported).toContain(relativePath);
    }
  });

  it("allows bounded replay wording and separate best-effort tool-output persistence", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/observability/tui.md", [
      "# TUI",
      "Replay shows redacted, capped events that reached terminal JSONL persistence.",
      "A crash can lose RAM-buffered events before that boundary.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/README.md", [
      "# TUI package",
      "Replay is bounded; a separate tool-output file exists only when persistence succeeds.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/terminal-text.ts", [
      "const notice = '(payload truncated for streaming; replay may also be bounded)';",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/create-mono-agent/skills/mono-agent-composer/references/package-map.md", [
      "# Package map",
      "Remote event frames have a strict 256 KiB UTF-8 NDJSON cap: assistant-thought/tool-call payload fields are reduced, while other oversized variants become bounded markers; other frame kinds are unaffected.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/create-mono-agent/skills/mono-agent-composer/references/discovery-questions.md", [
      "# Discovery",
      "Phoenix provides best-effort export of every run lifecycle at the terminal boundary.",
      "JSONL artifacts are not always written to a terminal state; a crash can lose buffered events.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/runtime/tools-and-guards.md", [
      "# Tool guard",
      "The guard attempts best-effort persistence; missing or failed sinks leave omitted bytes unavailable.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/channel-operator/src/server.ts", [
      "function describeExporter() {",
      "  return \"JSONL artifacts remain local\";",
      "}",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/app.ts", [
      "const HELP_COMMANDS = [",
      "  \"Open the operator console from any directory: live chat with structured\",",
      "  \"thinking/tool/telemetry insight, recorded-run replay, and config view.\",",
      "];",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator/package.json", JSON.stringify({
      description: "Loopback operator adapters: structured TUI NDJSON turns and live SSE.",
    }));
    await writeRepoDoc(repoRoot, "docs/channels/tui.md", [
      "# TUI channel",
      "Serialized event frames are capped at 256 KiB after UTF-8 NDJSON encoding. Assistant-thought/tool-call payload fields are reduced, while other oversized variants become bounded markers; non-event frames are unaffected.",
      "The full on-disk history remains pageable, subject to its documented retention contract.",
      "The full terminal-result replay horizon remains available after successful persistence.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/package.json", JSON.stringify({
      description: "live chat with structured stream-event insight and bounded replay",
    }));
    await writeRepoDoc(repoRoot, "scripts/lib/package-catalog.mjs", [
      "const responsibility = 'structured stream-event insight with bounded replay';",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.issues).toEqual([]);
  });

  it("flags retired pre-v1 names in supplied consumer README files", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/index.md", "# Docs\n");
    const consumerDir = await tempDir("consumer-docs-");
    await writeFile(join(consumerDir, "README.md"), [
      "# Downstream Agent",
      "",
      `This folder still depends on ${monoPackage("tui", "adapter")}.`,
      "",
    ].join("\n"), "utf8");
    await writeFile(join(consumerDir, "mono-agent.config.json"), JSON.stringify({ runtime: { model: "test" } }), "utf8");

    const result = await checkConsumerDocsConsistency([consumerDir], { repoRoot });

    expect(result.checked).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(monoPackage("tui", "adapter"));
  });
});

async function tempRepo() {
  const dir = await tempDir("consumer-docs-repo-");
  await mkdir(join(dir, "docs"), { recursive: true });
  return dir;
}

async function writeRepoDoc(repoRoot, relativePath, contents) {
  const path = join(repoRoot, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

const HISTORY_ANNOTATION_PAYLOAD =
  "> Historical compatibility record: `memory_recall` is retired; canonical replacement: `MemoryRecall`.";

function historyAnnotationMarker(relativePath, payloadLine) {
  return "<!-- mono-agent-doc-history:v1 " +
    JSON.stringify({ path: relativePath, line: payloadLine }) +
    " -->";
}

function historyAnnotationBlock(relativePath, payloadLine) {
  return historyAnnotationMarker(relativePath, payloadLine) + "\n" + HISTORY_ANNOTATION_PAYLOAD;
}

function historyAnnotationDocument(relativePath, recordCount) {
  return Array.from(
    { length: recordCount },
    (_, index) => historyAnnotationBlock(relativePath, (index * 2) + 2),
  ).join("\n") + "\n";
}

function aliasLocations(probes) {
  return probes.flatMap((probe, lineIndex) => {
    const locations = [];
    let occurrenceIndex = probe.indexOf("memory_recall");
    while (occurrenceIndex !== -1) {
      locations.push([String(lineIndex + 1), String(occurrenceIndex + 1)]);
      occurrenceIndex = probe.indexOf("memory_recall", occurrenceIndex + 1);
    }
    return locations;
  });
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
