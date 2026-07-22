import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SOURCE_EXTENSIONS,
  buildComplexitySnapshot,
  buildFileManifest,
  classifySourcePath,
  collectComplexitySnapshot,
  compareComplexitySnapshots,
  configSchemaFields,
  countPhysicalLines,
  evaluateGate,
  loadComplexityBaseline,
  normalizeSourceText,
  stablePrettyJson,
  validateComplexityPolicy,
  validateComplexitySnapshot,
} from "../lib/v1-complexity.mjs";
import {
  parseV1ComplexityArgs,
  renderHumanReport,
  runV1ComplexityReport,
} from "../v1-complexity-report.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("v1 complexity source accounting", () => {
  it("normalizes every line-ending form before counting physical lines", () => {
    expect(countPhysicalLines("")).toBe(0);
    expect(countPhysicalLines("one")).toBe(1);
    expect(countPhysicalLines("one\ntwo\n")).toBe(2);
    expect(countPhysicalLines("\n")).toBe(1);
    expect(normalizeSourceText("one\r\ntwo\rthree\n")).toBe("one\ntwo\nthree\n");
    expect(countPhysicalLines(normalizeSourceText("one\r\ntwo\rthree\n"))).toBe(3);
  });

  it("classifies test helpers before shipped package source and keeps explicit exclusions auditable", () => {
    const configured = testPolicy({
      excludedRules: [
        rule("type-declarations", { suffixes: [".d.ts"] }),
      ],
      generatedRules: [
        {
          ...rule("generated-client", { prefixes: ["packages/a/src/generated/"] }),
          generator: { command: "pnpm", args: ["generate"] },
          reproducibilityCheck: { command: "git", args: ["diff", "--exit-code"] },
        },
      ],
      nonShippingRules: [
        rule("repository-tooling", { prefixes: ["scripts/"] }),
      ],
      vendoredRules: [
        {
          ...rule("vendored-parser", { prefixes: ["packages/a/src/vendor/"] }),
          upstream: "https://example.invalid/parser",
          version: "1.0.0",
          licensePath: "LICENSE",
        },
      ],
    });

    expect(classifySourcePath("packages/a/src/index.ts", configured)).toMatchObject({
      classification: "production",
      ruleId: "shipped-workspace-source",
    });
    expect(classifySourcePath("packages/a/src/test/fixtures.ts", configured)).toMatchObject({
      classification: "test",
      ruleId: "test-path-or-filename",
    });
    expect(classifySourcePath("packages/a/src/index.test.ts", configured).classification).toBe("test");
    expect(classifySourcePath("packages/a/src/index.d.ts", configured)).toMatchObject({
      classification: "excluded",
      ruleId: "type-declarations",
    });
    expect(classifySourcePath("packages/a/src/generated/client.ts", configured).classification).toBe("generated");
    expect(classifySourcePath("packages/a/src/vendor/parser.ts", configured).classification).toBe("vendored");
    expect(classifySourcePath("scripts/check.mjs", configured).classification).toBe("excluded");
    expect(classifySourcePath("uncatalogued/tool.ts", configured).classification).toBe("unclassified");
  });

  it("classifies package-local Vitest tooling as test while retaining product-bearing Vite configuration", () => {
    const configured = testPolicy({
      productionRoots: ["extras/", "packages/"],
      testFilenameMarkers: [".spec.", ".test.", "vitest.config."],
    });

    expect(classifySourcePath("packages/tui/vitest.config.ts", configured)).toMatchObject({
      classification: "test",
      ruleId: "test-path-or-filename",
    });
    expect(classifySourcePath("packages/web/webapp/vite.config.ts", configured)).toMatchObject({
      classification: "production",
      ruleId: "shipped-workspace-source",
    });
  });

  it("rejects incomplete provenance rules and reports overlapping explicit classifications", () => {
    const invalid = testPolicy({
      generatedRules: [rule("generated-client", { prefixes: ["packages/a/generated/"] })],
    });
    expect(validateComplexityPolicy(invalid)).toEqual(expect.arrayContaining([
      "generatedRules[0] is missing required key generator",
      "generatedRules[0] is missing required key reproducibilityCheck",
    ]));

    const overlapping = testPolicy({
      excludedRules: [rule("excluded-client", { paths: ["packages/a/src/client.ts"] })],
      vendoredRules: [{
        ...rule("vendored-client", { paths: ["packages/a/src/client.ts"] }),
        upstream: "https://example.invalid/client",
        version: "1",
        licensePath: "LICENSE",
      }],
    });
    expect(classifySourcePath("packages/a/src/client.ts", overlapping)).toMatchObject({
      classification: "unclassified",
      ruleId: "conflicting-explicit-rules",
    });
  });

  it("rejects unknown policy keys, unsupported algorithms/extensions, and weakened binding contracts", () => {
    const valid = testPolicy();
    expect(validateComplexityPolicy(valid)).toEqual([]);

    expect(validateComplexityPolicy({ ...valid, surprise: true })).toContain("policy contains unknown key surprise");
    expect(validateComplexityPolicy({ ...valid, algorithmVersion: 999 })).toContain(
      "policy.algorithmVersion must be exactly 1",
    );
    expect(validateComplexityPolicy({ ...valid, sourceExtensions: [".js"] })).toContain(
      `sourceExtensions must exactly equal ${SOURCE_EXTENSIONS.join(", ")}`,
    );
    expect(validateComplexityPolicy({ ...valid, budgets: [] })).toEqual(expect.arrayContaining([
      "required budget kernel-production is missing",
      "required budget repository-production is missing",
    ]));
    expect(validateComplexityPolicy({ ...valid, implementationFamilies: [] })).toContain(
      "required implementation family operator-wire-client is missing",
    );

    const weakened = structuredClone(valid);
    weakened.budgets.find((budget) => budget.id === "repository-production").maxLines = 130_001;
    expect(validateComplexityPolicy(weakened)).toContain(
      "required budget repository-production must exactly match its binding contract",
    );

    const unknownNested = structuredClone(valid);
    unknownNested.budgets[0].waiver = true;
    expect(validateComplexityPolicy(unknownNested)).toContain("budgets[0] contains unknown key waiver");
  });

  it("requires safe vendored provenance and fails when the declared license is not tracked", () => {
    const unsafe = testPolicy({
      vendoredRules: [{
        ...rule("vendored-client", { paths: ["packages/a/src/vendor.ts"] }),
        upstream: "http://user:secret@example.invalid/client",
        version: "latest build",
        licensePath: "../LICENSE",
      }],
    });
    expect(validateComplexityPolicy(unsafe)).toEqual(expect.arrayContaining([
      "vendoredRules[0].licensePath must be a safe repository-relative path",
      "vendoredRules[0].upstream must be an HTTPS URL without credentials",
      "vendoredRules[0].version must be a non-empty whitespace-free version",
    ]));

    const configured = testPolicy({
      vendoredRules: [{
        ...rule("vendored-client", { paths: ["packages/a/src/vendor.ts"] }),
        upstream: "https://example.invalid/client",
        version: "1.0.0",
        licensePath: "vendor/client/LICENSE",
      }],
    });
    const entries = [entry("packages/a/src/vendor.ts", "vendor")];
    const blobsByOid = new Map([["vendor", Buffer.from("export {};\n")]]);
    const snapshot = snapshotFor(entries, blobsByOid, configured);
    expect(snapshot.issues).toContain(
      "vendored rule vendored-client license vendor/client/LICENSE is not tracked",
    );
  });

  it("accounts for invalid text and non-regular source entries without hiding them", () => {
    const configured = testPolicy();
    const entries = [
      entry("packages/a/src/binary.ts", "binary"),
      { ...entry("packages/a/src/link.ts", "link"), mode: "120000" },
      entry("packages/a/src/nul.ts", "nul"),
    ];
    const blobsByOid = new Map([
      ["binary", Buffer.from([0xff])],
      ["link", Buffer.from("target.ts")],
      ["nul", Buffer.from("ok\0bad")],
    ]);

    const manifest = buildFileManifest({ entries, blobsByOid, policy: configured, catalog: [] });

    expect(manifest.files).toHaveLength(3);
    expect(manifest.files.every((file) => file.classification === "unclassified")).toBe(true);
    expect(manifest.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("binary.ts is not valid UTF-8 source text"),
      expect.stringContaining("link.ts is source-shaped but is not a regular stage-0 blob"),
      expect.stringContaining("nul.ts is not valid UTF-8 source text"),
    ]));
  });

  it("produces order-independent digests that change with source content or Git mode", () => {
    const configured = testPolicy();
    const entries = [
      entry("packages/a/src/a.ts", "a"),
      entry("packages/a/src/b.ts", "b"),
    ];
    const blobsByOid = new Map([
      ["a", Buffer.from("export const a = 1;\r\n")],
      ["b", Buffer.from("export const b = 2;\n")],
    ]);
    const first = snapshotFor(entries, blobsByOid, configured);
    const reversed = snapshotFor([...entries].reverse(), new Map([...blobsByOid].reverse()), configured);

    expect(reversed).toEqual(first);
    validateComplexitySnapshot(first);

    const changedBlobs = new Map(blobsByOid);
    changedBlobs.set("a", Buffer.from("export const a = 9;\n"));
    expect(snapshotFor(entries, changedBlobs, configured).snapshotSha256).not.toBe(first.snapshotSha256);

    const changedMode = [{ ...entries[0], mode: "100755" }, entries[1]];
    expect(snapshotFor(changedMode, blobsByOid, configured).snapshotSha256).not.toBe(first.snapshotSha256);
  });

  it("detects stale rules and unstaged source changes as gate failures", () => {
    const configured = testPolicy({
      excludedRules: [rule("never-used", { prefixes: ["packages/missing/"] })],
    });
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const manifest = buildFileManifest({
      entries,
      blobsByOid,
      policy: configured,
      catalog: [],
      unstagedPaths: ["packages/a/src/index.ts"],
    });
    const snapshot = buildComplexitySnapshot({ manifest, policy: configured, entries, blobsByOid, catalog: [] });

    expect(evaluateGate(snapshot, "G0")).toEqual([
      "classification rule never-used did not match any tracked source file",
      "packages/a/src/index.ts has unstaged source changes",
    ]);
  });

  it("defers future budgets and implementation consolidation until their configured gate", () => {
    const configured = testPolicy({
      budgets: [
        {
          id: "repository-production",
          classification: "production",
          maxLines: 0,
          enforceAt: "G8",
        },
        {
          id: "future-kernel",
          classification: "production",
          owners: ["packages/future"],
          requireOwners: true,
          maxLines: 10,
          enforceAt: "G8",
        },
      ],
      implementationFamilies: [
        {
          id: "one-client",
          members: ["packages/a/src/index.ts"],
          maxMembers: 0,
          enforceAt: "G8",
        },
      ],
    });
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const snapshot = snapshotFor(entries, blobsByOid, configured);

    expect(evaluateGate(snapshot, "G0")).toEqual([]);
    expect(evaluateGate(snapshot, "G8")).toEqual([
      "future-kernel is missing required owners: packages/future",
      "one-client has 1 implementations, exceeding 0",
      "repository-production has 1 lines, exceeding 0",
    ]);
  });
});

describe("v1 complexity architecture inventory", () => {
  it("accounts for production dependency edges and cycles, code export subpaths, closures, and native dependencies", () => {
    const catalog = [
      { dir: "a", name: "@test/a", publishable: true },
      { dir: "b", name: "@test/b", publishable: false },
    ];
    const packageA = {
      name: "@test/a",
      dependencies: { "@test/b": "workspace:*", "better-sqlite3": "1.0.0" },
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./feature": ["./dist/feature.mjs", null],
        "./types": "./dist/types.d.ts",
      },
    };
    const packageB = {
      name: "@test/b",
      peerDependencies: { "@test/a": "workspace:*", "sqlite-vec": "1.0.0" },
      exports: "./dist/index.cjs",
    };
    const entries = [
      entry("packages/a/package.json", "manifest-a"),
      entry("packages/a/src/index.ts", "source-a"),
      entry("packages/b/package.json", "manifest-b"),
      entry("packages/b/src/index.ts", "source-b"),
    ];
    const blobsByOid = new Map([
      ["manifest-a", jsonBuffer(packageA)],
      ["source-a", Buffer.from("export {};\n")],
      ["manifest-b", jsonBuffer(packageB)],
      ["source-b", Buffer.from("export {};\n")],
    ]);
    const policy = testPolicy({
      closures: [{ id: "test-closure", roots: ["@test/a"] }],
      knownNativeDependencies: ["better-sqlite3", "sqlite-vec"],
    });
    const manifest = buildFileManifest({ entries, blobsByOid, policy, catalog });
    const snapshot = buildComplexitySnapshot({ manifest, policy, entries, blobsByOid, catalog });

    expect(snapshot.inventory.dependencyGraph).toMatchObject({
      edgeCount: 2,
      cycles: [["@test/a", "@test/b"]],
    });
    expect(snapshot.inventory.dependencyGraph.edges).toEqual([
      { from: "@test/a", to: "@test/b", kind: "dependencies" },
      { from: "@test/b", to: "@test/a", kind: "peerDependencies" },
    ]);
    expect(snapshot.inventory.publicCodeExportSubpaths).toEqual({
      total: 3,
      entries: [
        { package: "@test/a", subpath: "." },
        { package: "@test/a", subpath: "./feature" },
        { package: "@test/b", subpath: "." },
      ],
    });
    expect(snapshot.inventory.closures[0]).toEqual({
      id: "test-closure",
      roots: ["@test/a"],
      packageNames: ["@test/a", "@test/b"],
      packageCount: 2,
      productionLines: 2,
      knownNativeDependencies: ["better-sqlite3", "sqlite-vec"],
    });
    expect(evaluateGate(snapshot, "G0")).toContain(
      "workspace production dependency graph contains 1 cycle(s)",
    );
  });

  it("traverses local refs, combinators, arrays, and schema-valued additional properties", () => {
    const fields = configSchemaFields({
      type: "object",
      properties: {
        routes: { $ref: "#/$defs/routes" },
        reactions: {
          oneOf: [
            { type: "boolean" },
            {
              type: "object",
              properties: {
                done: { type: "boolean" },
                error: { type: "boolean" },
              },
            },
          ],
        },
        workers: {
          type: "array",
          items: {
            allOf: [
              { type: "object", properties: { name: { type: "string" } } },
              { type: "object", properties: { enabled: { type: "boolean" } } },
            ],
          },
        },
      },
      $defs: {
        routes: {
          type: "object",
          additionalProperties: {
            anyOf: [
              { $ref: "#/$defs/route" },
              { type: "object", properties: { disabled: { type: "boolean" } } },
            ],
          },
        },
        route: {
          type: "object",
          properties: { url: { type: "string" } },
        },
      },
    });

    expect(fields.leafPaths).toEqual([
      "reactions.done",
      "reactions.error",
      "routes.*.disabled",
      "routes.*.url",
      "workers[].enabled",
      "workers[].name",
    ]);
    expect(fields.propertyNodes).toBe(10);
    expect(() => configSchemaFields({ $ref: "https://example.invalid/schema" })).toThrow(
      "unsupported config schema reference",
    );
    expect(() => configSchemaFields({ $ref: "#/$defs/missing", $defs: {} })).toThrow(
      "unresolved config schema reference",
    );
    expect(configSchemaFields({
      type: "object",
      properties: { value: { type: "string" } },
      allOf: [{ $ref: "#" }],
    }).leafPaths).toEqual(["value"]);
  });

  it("counts fields hidden behind the repository schema's dynamic maps and union branches", () => {
    const schema = JSON.parse(readFileSync(
      join(process.cwd(), "packages/agent-app/schema/mono-agent.config.schema.json"),
      "utf8",
    ));
    const fields = configSchemaFields(schema);

    expect(fields.leafPaths).toEqual(expect.arrayContaining([
      "continuations.namedRoutes.*.conversationId",
      "continuations.namedRoutes.*.mode",
      "telegram.reactions.done",
      "telegram.reactions.error",
      "telegram.reactions.working",
    ]));
    expect(fields.propertyNodes).toBeGreaterThan(fields.leafPaths.length);
  });
});

describe("v1 complexity Git-index integration", () => {
  it("reads stage-0 blobs, ignores untracked files, and flags a dirty indexed source", async () => {
    const cwd = await tempGitRepository();
    const configured = testPolicy({
      nonShippingRules: [rule("repository-tooling", { prefixes: ["scripts/"] })],
    });
    await writeJson(join(cwd, "refactor/v1-complexity-policy.json"), configured);
    await writeJson(join(cwd, "packages/a/package.json"), {
      name: "@test/a",
      version: "1.0.0",
      exports: "./dist/index.js",
    });
    await writeFile(join(cwd, "packages/a/src/index.ts"), "export const value = 1;\r\n", "utf8");
    await writeFile(join(cwd, "packages/a/src/test/helper.ts"), "export const helper = true;\n", "utf8");
    await writeFile(join(cwd, "scripts/check.mjs"), "#!/usr/bin/env node\n", "utf8");
    git(cwd, "add", ".");

    const catalog = [{ dir: "a", name: "@test/a", publishable: true }];
    const beforeUntracked = collectComplexitySnapshot({ cwd, catalog });
    await writeFile(join(cwd, "packages/a/src/untracked.ts"), "throw new Error();\n", "utf8");
    const clean = collectComplexitySnapshot({ cwd, catalog });

    expect(clean.manifestSha256).toBe(beforeUntracked.manifestSha256);
    expect(clean.snapshotSha256).toBe(beforeUntracked.snapshotSha256);
    expect(clean.issues).toEqual([]);
    expect(clean.totals.byClassification.production).toEqual({ files: 1, lines: 1 });
    expect(clean.totals.byClassification.test).toEqual({ files: 1, lines: 1 });
    expect(clean.totals.byClassification.excluded).toEqual({ files: 1, lines: 1 });
    expect(clean.files.map((file) => file.path)).not.toContain("packages/a/src/untracked.ts");
    expect(clean.inventory.workspacePackages).toEqual({ total: 1, publishable: 1 });

    await writeFile(join(cwd, "packages/a/src/index.ts"), "export const value = 2;\n", "utf8");
    const dirty = collectComplexitySnapshot({ cwd, catalog });
    expect(dirty.totals).toEqual(clean.totals);
    expect(dirty.manifestSha256).toBe(clean.manifestSha256);
    expect(dirty.snapshotSha256).toBe(clean.snapshotSha256);
    expect(evaluateGate(dirty, "G0")).toContain("packages/a/src/index.ts has unstaged source changes");
  });

  it("derives package catalog paths and publishability from stage-0 rather than the worktree", async () => {
    const cwd = await tempGitRepository();
    const configured = testPolicy({
      nonShippingRules: [rule("repository-tooling", { prefixes: ["scripts/"] })],
    });
    await writeJson(join(cwd, "refactor/v1-complexity-policy.json"), configured);
    await writeJson(join(cwd, "packages/a/package.json"), {
      name: "@test/a",
      version: "1.0.0",
      exports: "./dist/index.js",
    });
    await writeFile(join(cwd, "packages/a/src/index.ts"), "export const value = 1;\n", "utf8");
    const catalogPath = join(cwd, "scripts/package-catalog.mjs");
    const indexedCatalog = [
      "export const packageCatalog = [",
      "  { dir: \"a\", name: \"@test/a\", publishable: true },",
      "];",
      "export function packageRelativePath(entry) {",
      "  return entry.path ?? `packages/${entry.dir}`;",
      "}",
      "",
    ].join("\n");
    await writeFile(catalogPath, indexedCatalog, "utf8");
    git(cwd, "add", ".");

    const clean = collectComplexitySnapshot({ cwd });
    await writeFile(catalogPath, indexedCatalog.replace("publishable: true", "publishable: false"), "utf8");
    const dirty = collectComplexitySnapshot({ cwd });

    expect(clean.inventory.workspacePackages).toEqual({ total: 1, publishable: 1 });
    expect(dirty.inventory.workspacePackages).toEqual(clean.inventory.workspacePackages);
    expect(dirty.manifestSha256).toBe(clean.manifestSha256);
    expect(dirty.snapshotSha256).toBe(clean.snapshotSha256);
    expect(dirty.issues).toEqual(expect.arrayContaining([
      "scripts/package-catalog.mjs has unstaged report-input changes",
      "scripts/package-catalog.mjs has unstaged source changes",
    ]));
  });
});

describe("v1 complexity report CLI", () => {
  it("parses a gate/report request and rejects ambiguous baseline modes", () => {
    expect(parseV1ComplexityArgs(["--json", "--baseline", "base.json", "--gate", "G0.5"])).toMatchObject({
      baseline: "base.json",
      gate: "G0.5",
      json: true,
    });
    expect(() => parseV1ComplexityArgs([
      "--baseline", "base.json", "--verify-baseline", "other.json",
    ])).toThrow("Use either --baseline or --verify-baseline");
    expect(() => parseV1ComplexityArgs(["--gate", "G8"])).toThrow(
      "--gate requires --baseline or --verify-baseline committed evidence",
    );
    expect(() => parseV1ComplexityArgs(["--gate", "G9"])).toThrow("Unknown gate G9");
  });

  it("renders deterministic JSON and a useful human report", () => {
    const configured = testPolicy();
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const snapshot = snapshotFor(entries, blobsByOid, configured);
    const stdout = sink();
    const stderr = sink();

    const result = runV1ComplexityReport({
      argv: ["--json", "--gate", "G0", "--baseline", "base.json"],
      collectSnapshot: () => snapshot,
      loadBaseline: () => ({
        snapshot,
        evidence: baselineEvidence(snapshot),
      }),
      collectTreeEvidence: () => currentTreeEvidence(),
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`${JSON.stringify(JSON.parse(stdout.text), null, 2)}\n`);
    expect(JSON.parse(stdout.text)).toMatchObject({
      snapshotSha256: snapshot.snapshotSha256,
      comparison: {
        matches: true,
        algorithmMatches: true,
        policyMatches: true,
        baselineEvidence: baselineEvidence(snapshot),
      },
    });
    expect(stderr.text).toBe("");
    expect(renderHumanReport(result.report, "G0")).toContain(`snapshot ${snapshot.snapshotSha256}`);
    expect(renderHumanReport(result.report, "G0")).toContain(
      `baseline evidence: committed-git-blob ${baselineEvidence(snapshot).contentSha256}`,
    );
    expect(renderHumanReport(result.report, "G0")).toContain(`current tree: ${currentTreeEvidence().tree}`);
    expect(renderHumanReport(result.report, "G0")).toContain("gate: G0");
  });

  it("validates baseline self-digests and reports exact or changed snapshots", () => {
    const configured = testPolicy();
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const baseline = snapshotFor(entries, blobsByOid, configured);
    const exact = snapshotFor([...entries], new Map(blobsByOid), configured);
    expect(compareComplexitySnapshots(exact, baseline)).toMatchObject({
      matches: true,
      files: { added: 0, removed: 0, changed: 0, reclassified: 0 },
    });

    const changed = structuredClone(baseline);
    changed.files[0].lines += 1;
    expect(() => validateComplexitySnapshot(changed)).toThrow("Baseline snapshot digest does not match its contents");

    const other = snapshotFor(entries, new Map([["a", Buffer.from("export const x = 1;\n")]]), configured);
    expect(compareComplexitySnapshots(other, baseline)).toMatchObject({
      matches: false,
      algorithmMatches: true,
      policyMatches: true,
      files: { added: 0, removed: 0, changed: 1, reclassified: 0 },
    });
  });

  it("requires gate baselines to be clean tracked blobs committed at HEAD", async () => {
    const cwd = await tempGitRepository();
    const configured = testPolicy();
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const snapshot = snapshotFor(entries, blobsByOid, configured);
    const baselinePath = "refactor/baseline.json";
    const absoluteBaseline = join(cwd, baselinePath);
    await writeFile(absoluteBaseline, stablePrettyJson(snapshot), "utf8");
    await writeFile(join(cwd, "tracked.txt"), "clean\n", "utf8");
    git(cwd, "add", baselinePath, "tracked.txt");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "baseline");

    const loaded = loadComplexityBaseline({ cwd, path: baselinePath, requireCommitted: true });
    expect(loaded.snapshot.snapshotSha256).toBe(snapshot.snapshotSha256);
    expect(loaded.evidence).toMatchObject({
      source: "committed-git-blob",
      path: baselinePath,
      snapshotSha256: snapshot.snapshotSha256,
      manifestSha256: snapshot.manifestSha256,
      policySha256: snapshot.policySha256,
    });
    expect(loaded.evidence.commit).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(loaded.evidence.gitBlobOid).toMatch(/^[0-9a-f]{40,64}$/u);

    const exact = runV1ComplexityReport({
      argv: ["--gate", "G0", "--verify-baseline", baselinePath],
      cwd,
      collectSnapshot: () => snapshot,
      stdout: sink(),
      stderr: sink(),
    });
    expect(exact.exitCode).toBe(0);
    expect(exact.report.currentTreeEvidence).toMatchObject({
      commit: loaded.evidence.commit,
      trackedClean: true,
    });

    await writeFile(join(cwd, "tracked.txt"), "unstaged\n", "utf8");
    const unstaged = runV1ComplexityReport({
      argv: ["--gate", "G0", "--verify-baseline", baselinePath],
      cwd,
      collectSnapshot: () => snapshot,
      stdout: sink(),
      stderr: sink(),
    });
    expect(unstaged.exitCode).toBe(1);
    expect(unstaged.failures).toContain(
      "tracked tree has unstaged changes relative to the index: tracked.txt",
    );

    git(cwd, "add", "tracked.txt");
    const staged = runV1ComplexityReport({
      argv: ["--gate", "G0", "--verify-baseline", baselinePath],
      cwd,
      collectSnapshot: () => snapshot,
      stdout: sink(),
      stderr: sink(),
    });
    expect(staged.exitCode).toBe(1);
    expect(staged.failures).toContain(
      "tracked tree has staged changes relative to HEAD: tracked.txt",
    );
    git(cwd, "restore", "--staged", "--worktree", "tracked.txt");

    await writeFile(absoluteBaseline, `${stablePrettyJson(snapshot)}\n`, "utf8");
    expect(() => loadComplexityBaseline({ cwd, path: baselinePath, requireCommitted: true })).toThrow(
      "must have no unstaged changes",
    );
    git(cwd, "add", baselinePath);
    expect(() => loadComplexityBaseline({ cwd, path: baselinePath, requireCommitted: true })).toThrow(
      "must be unchanged between HEAD and the Git index",
    );
  });

  it("fails a gate when the current policy digest differs from committed baseline evidence", () => {
    const configured = testPolicy();
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const baseline = snapshotFor(entries, blobsByOid, configured);
    const currentPolicy = testPolicy({ knownNativeDependencies: ["native-addon"] });
    const current = snapshotFor(entries, blobsByOid, currentPolicy);
    const stdout = sink();
    const stderr = sink();
    const result = runV1ComplexityReport({
      argv: ["--gate", "G0", "--baseline", "baseline.json"],
      collectSnapshot: () => current,
      loadBaseline: () => ({ snapshot: baseline, evidence: baselineEvidence(baseline) }),
      collectTreeEvidence: () => currentTreeEvidence(),
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures).toContain("current policy digest does not match the committed baseline");
  });

  it("rejects transient workspace issues while preserving the measured snapshot digest", () => {
    const configured = testPolicy();
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const baseline = snapshotFor(entries, blobsByOid, configured);
    const dirty = { ...baseline, issues: ["packages/a/src/index.ts has unstaged source changes"] };
    const result = runV1ComplexityReport({
      argv: ["--verify-baseline", "baseline.json"],
      collectSnapshot: () => dirty,
      loadBaseline: () => ({ snapshot: baseline, evidence: baselineEvidence(baseline) }),
      stdout: sink(),
      stderr: sink(),
    });

    expect(dirty.snapshotSha256).toBe(baseline.snapshotSha256);
    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual(["packages/a/src/index.ts has unstaged source changes"]);
  });
});

function testPolicy(overrides = {}) {
  return {
    schema: "mono-agent.v1-complexity-policy.v1",
    algorithmVersion: 1,
    sourceExtensions: [...SOURCE_EXTENSIONS],
    testPathSegments: ["test", "tests"],
    testFilenameMarkers: [".test.", "vitest.config."],
    productionRoots: ["packages/"],
    generatedRules: [],
    vendoredRules: [],
    excludedRules: [],
    nonShippingRules: [],
    budgets: [
      {
        id: "repository-production",
        classification: "production",
        maxLines: 130_000,
        enforceAt: "G8",
      },
      {
        id: "kernel-production",
        classification: "production",
        owners: ["packages/cli", "packages/core", "packages/module-sdk"],
        maxLines: 15_000,
        enforceAt: "G8",
        requireOwners: true,
      },
    ],
    configSchemaPath: null,
    closures: [],
    knownNativeDependencies: [],
    implementationFamilies: [{
      id: "operator-wire-client",
      members: [
        "packages/tui/src/remote/client.ts",
        "packages/web/src/operator-client.ts",
      ],
      maxMembers: 1,
      enforceAt: "G8",
    }],
    ...overrides,
  };
}

function rule(id, match) {
  return { id, reason: `Reason for ${id}.`, match };
}

function entry(path, oid) {
  return { mode: "100644", oid, path };
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function baselineEvidence(snapshot) {
  return {
    source: "committed-git-blob",
    path: "base.json",
    commit: "a".repeat(40),
    gitBlobOid: "b".repeat(40),
    contentSha256: "c".repeat(64),
    snapshotSha256: snapshot.snapshotSha256,
    manifestSha256: snapshot.manifestSha256,
    policySha256: snapshot.policySha256,
  };
}

function currentTreeEvidence(overrides = {}) {
  return {
    source: "git-head",
    commit: "a".repeat(40),
    tree: "d".repeat(40),
    trackedClean: true,
    stagedPaths: [],
    unstagedPaths: [],
    ...overrides,
  };
}

function snapshotFor(entries, blobsByOid, policy) {
  const manifest = buildFileManifest({ entries, blobsByOid, policy, catalog: [] });
  return buildComplexitySnapshot({ manifest, policy, entries, blobsByOid, catalog: [] });
}

async function tempGitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "v1-complexity-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, "refactor"), { recursive: true });
  await mkdir(join(cwd, "packages/a/src/test"), { recursive: true });
  await mkdir(join(cwd, "scripts"), { recursive: true });
  git(cwd, "init", "--quiet");
  return cwd;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
