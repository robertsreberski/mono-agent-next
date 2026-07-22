import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  COMPLEXITY_ALGORITHM_VERSION,
  G0_AUTHORITY_REF,
  SOURCE_EXTENSIONS,
  buildComplexitySnapshot,
  buildFileManifest,
  buildShippedReachability,
  classifySourcePath,
  collectComplexitySnapshot,
  compareComplexitySnapshots,
  configSchemaFields,
  countPhysicalLines,
  evaluateGate,
  loadIndexedPackageCatalog,
  loadComplexityBaseline,
  loadComplexityG0Authority,
  normalizeSourceText,
  resolveComplexityPolicy,
  sha256,
  stablePrettyJson,
  validateComplexityClassificationAuthority,
  validateComplexityG0Authority,
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
    const invalid = testInventoryPolicy({
      generatedFiles: [{
        id: "generated-client",
        path: "packages/a/generated/client.ts",
        reason: "Generated client.",
        contentSha256: "a".repeat(64),
      }],
    });
    expect(validateComplexityPolicy(invalid)).toEqual(expect.arrayContaining([
      "generatedFiles[0] is missing required key generator",
      "generatedFiles[0] is missing required key reproducibilityCheck",
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
    const valid = testInventoryPolicy();
    expect(validateComplexityPolicy(valid)).toEqual([]);

    expect(validateComplexityPolicy({ ...valid, surprise: true })).toContain(
      "inventory policy contains unknown key surprise",
    );
    const authority = testClassificationAuthority();
    expect(validateComplexityClassificationAuthority(authority)).toEqual([]);
    expect(validateComplexityClassificationAuthority({ ...authority, algorithmVersion: 999 })).toContain(
      `classification authority.algorithmVersion must be exactly ${COMPLEXITY_ALGORITHM_VERSION}`,
    );
    expect(validateComplexityClassificationAuthority({ ...authority, packageTextExtensions: [".json"] })).toContain(
      `classification source extensions must exactly equal ${SOURCE_EXTENSIONS.join(", ")}`,
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
    const unsafe = testInventoryPolicy({
      vendoredFiles: [{
        id: "vendored-client",
        path: "packages/a/src/vendor.ts",
        reason: "Vendored client.",
        contentSha256: "a".repeat(64),
        upstream: "http://user:secret@example.invalid/client",
        version: "latest build",
        licensePath: "../LICENSE",
        licenseSha256: "b".repeat(64),
      }],
    });
    expect(validateComplexityPolicy(unsafe)).toEqual(expect.arrayContaining([
      "vendoredFiles[0].licensePath must be a safe repository-relative path",
      "vendoredFiles[0].upstream must be an HTTPS URL without credentials",
      "vendoredFiles[0].version must be a non-empty whitespace-free version",
    ]));

    const vendorBytes = Buffer.from("export {};\n");
    const configured = testPolicy({ inventoryPolicy: {
      vendoredFiles: [{
        id: "vendored-client",
        path: "packages/a/src/vendor.ts",
        reason: "Vendored client.",
        contentSha256: sha256(vendorBytes),
        upstream: "https://example.invalid/client",
        version: "1.0.0",
        licensePath: "vendor/client/LICENSE",
        licenseSha256: "b".repeat(64),
      }],
    } });
    const entries = [entry("packages/a/src/vendor.ts", "vendor")];
    const blobsByOid = new Map([["vendor", vendorBytes]]);
    const snapshot = snapshotFor(entries, blobsByOid, configured);
    expect(snapshot.issues).toContain(
      "vendored evidence vendored-client license vendor/client/LICENSE is not tracked",
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
      catalog: [catalogEntry()],
      unstagedPaths: ["packages/a/src/index.ts"],
    });
    const snapshot = buildComplexitySnapshot({
      manifest,
      policy: configured,
      ...inventoryInputs(entries, blobsByOid, [catalogEntry()]),
      catalog: [catalogEntry()],
    });

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
          detection: {
            allContentMarkers: ["export"],
            pathPrefixes: ["packages/"],
          },
          registeredMember: "packages/a/src/index.ts",
          minMembers: 0,
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

describe("v1 complexity adversarial closure", () => {
  it("accounts for unknown mode-0644 package source instead of silently omitting it", () => {
    const configured = testPolicy();
    const entries = [
      entry("packages/known/src/opaque.custom", "known"),
      entry("packages/rogue/src/payload.custom", "rogue"),
    ];
    const blobsByOid = new Map([
      ["known", Buffer.from("opaque product source\n")],
      ["rogue", Buffer.from("uncatalogued product source\n")],
    ]);
    const manifest = buildFileManifest({
      entries,
      blobsByOid,
      policy: configured,
      catalog: [catalogEntry({ name: "@test/known", path: "packages/known" })],
    });

    expect(manifest.files.map(({ path }) => path)).toEqual(entries.map(({ path }) => path));
    expect(manifest.files.find(({ path }) => path.includes("rogue"))).toMatchObject({
      classification: "unclassified",
      ruleId: "uncatalogued-package-source",
    });
    expect(manifest.issues).toEqual(expect.arrayContaining([
      "packages/known/src/opaque.custom has an unknown source extension under packages/known",
      "packages/rogue/src/payload.custom is source-shaped under a package root but has no exact package-catalog owner",
    ]));
  });

  it("makes stage-0 runtime reachability override test-looking paths and includes CSS, HTML, build config, and packed source", () => {
    const configured = testPolicy();
    const manifestValue = {
      name: "@test/a",
      exports: "./dist/main.js",
      files: ["src/test/packed.ts"],
      scripts: { build: "vite build" },
    };
    const entries = [
      entry("packages/a/package.json", "manifest"),
      entry("packages/a/index.html", "html"),
      entry("packages/a/vite.config.ts", "vite"),
      entry("packages/a/src/main.ts", "main"),
      entry("packages/a/src/styles.css", "css"),
      entry("packages/a/src/test/product.ts", "product"),
      entry("packages/a/src/test/helper.ts", "helper"),
      entry("packages/a/src/test/packed.ts", "packed"),
    ];
    const blobsByOid = new Map([
      ["manifest", jsonBuffer(manifestValue)],
      ["html", Buffer.from('<script type="module" src="./src/main.ts"></script>\n')],
      ["vite", Buffer.from("export default {};\n")],
      ["main", Buffer.from('import "./styles.css";\nimport "./test/product.ts";\n')],
      ["css", Buffer.from("body { color: black; }\n")],
      ["product", Buffer.from("export const product = true;\n")],
      ["helper", Buffer.from("export const helper = true;\n")],
      ["packed", Buffer.from("export const packed = true;\n")],
    ]);
    const catalog = [catalogEntry()];
    const reachability = buildShippedReachability({ entries, blobsByOid, catalog, policy: configured });
    const fileManifest = buildFileManifest({ entries, blobsByOid, catalog, policy: configured, reachability });
    const byPath = new Map(fileManifest.files.map((file) => [file.path, file]));

    for (const path of [
      "packages/a/index.html",
      "packages/a/vite.config.ts",
      "packages/a/src/main.ts",
      "packages/a/src/styles.css",
      "packages/a/src/test/product.ts",
      "packages/a/src/test/packed.ts",
    ]) {
      expect(byPath.get(path)?.classification, path).toBe("production");
    }
    expect(byPath.get("packages/a/src/test/helper.ts")?.classification).toBe("test");
    expect(reachability.production.has("packages/a/src/test/product.ts")).toBe(true);
    expect(reachability.packed.has("packages/a/src/test/packed.ts")).toBe(true);
  });

  it("forbids broad exclusion syntax and refuses to downgrade production-reachable exact exclusions", () => {
    const bytes = Buffer.from("export const product = true;\n");
    const invalid = testInventoryPolicy({
      excludedFiles: [{
        id: "broad-exclusion",
        path: "packages/a/src/product.ts",
        reason: "Attempted downgrade.",
        evidence: "Review note.",
        contentSha256: sha256(bytes),
        match: { prefixes: ["packages/a/src/"] },
      }],
    });
    expect(validateComplexityPolicy(invalid)).toContain("excludedFiles[0] contains unknown key match");

    const policy = testPolicy({ inventoryPolicy: {
      excludedFiles: [{
        id: "exact-exclusion",
        path: "packages/a/src/product.ts",
        reason: "Attempted exact downgrade.",
        evidence: "Review note.",
        contentSha256: sha256(bytes),
      }],
    } });
    const entries = [entry("packages/a/src/product.ts", "product")];
    const blobsByOid = new Map([["product", bytes]]);
    const manifest = buildFileManifest({
      entries,
      blobsByOid,
      policy,
      catalog: [catalogEntry()],
      reachability: {
        production: new Set(["packages/a/src/product.ts"]),
        packed: new Set(),
        issues: [],
      },
    });
    expect(manifest.files[0]).toMatchObject({
      classification: "unclassified",
      ruleId: "reachable-production-exclusion",
    });
    expect(manifest.issues).toContain(
      "packages/a/src/product.ts is production-reachable and cannot be downgraded to excluded",
    );
  });

  it("enforces zero, exactly-one registered, and unknown operator-client states at G8", () => {
    const markers = Buffer.from([
      'const endpoint = "/v1/turns";',
      'const contentType = "application/x-ndjson";',
      "const fetchImpl = fetch;",
      "",
    ].join("\n"));
    const empty = snapshotFor([], new Map(), testPolicy());
    expect(evaluateGate(empty, "G0").filter(operatorFailure)).toEqual([]);
    expect(evaluateGate(empty, "G8").filter(operatorFailure)).toEqual(expect.arrayContaining([
      "operator-wire-client has 0 implementations, below 1",
      "operator-wire-client has no registered canonical implementation",
    ]));

    const canonicalPath = "packages/a/src/operator-client.ts";
    const onePolicy = testPolicy({ inventoryPolicy: {
      implementationFamilies: [{
        ...testInventoryPolicy().implementationFamilies[0],
        registeredMember: canonicalPath,
      }],
    } });
    const one = snapshotFor(
      [entry(canonicalPath, "one")],
      new Map([["one", markers]]),
      onePolicy,
    );
    expect(evaluateGate(one, "G8").filter(operatorFailure)).toEqual([]);

    const two = snapshotFor(
      [entry(canonicalPath, "one"), entry("packages/b/src/operator-client.ts", "two")],
      new Map([["one", markers], ["two", markers]]),
      onePolicy,
    );
    expect(evaluateGate(two, "G8").filter(operatorFailure)).toEqual(expect.arrayContaining([
      "operator-wire-client has 2 implementations, exceeding 1",
      "operator-wire-client has unregistered implementations: packages/b/src/operator-client.ts",
    ]));
  });

  it("fails exact catalog identity mismatches and overlapping ownership roots", () => {
    const entries = [
      entry("packages/a/package.json", "manifest"),
      entry("packages/a/src/index.ts", "source"),
    ];
    const blobsByOid = new Map([
      ["manifest", jsonBuffer({ name: "@test/wrong" })],
      ["source", Buffer.from("export {};\n")],
    ]);
    const policy = testPolicy();
    const catalog = [catalogEntry({ name: "@test/expected" })];
    const manifest = buildFileManifest({ entries, blobsByOid, policy, catalog });
    const snapshot = buildComplexitySnapshot({ manifest, policy, entries, blobsByOid, catalog });
    expect(snapshot.issues).toContain(
      "packages/a/package.json: manifest name must exactly match catalog identity @test/expected",
    );

    const catalogSource = [
      'export const PACKAGE_CATEGORIES = ["core"];',
      "export const packageCatalog = [",
      '  { allowedDependencyCategories: [], category: "core", name: "@test/a", path: "packages/a", publishable: true, responsibility: "A." },',
      '  { allowedDependencyCategories: [], category: "core", name: "@test/nested", path: "packages/a/nested", publishable: true, responsibility: "Nested." },',
      "];",
      "export function packageRelativePath(entry) { return entry.path; }",
      "",
    ].join("\n");
    expect(() => loadIndexedPackageCatalog({
      entries: [entry("scripts/package-catalog.mjs", "catalog")],
      blobsByOid: new Map([["catalog", Buffer.from(catalogSource)]]),
    })).toThrow("Indexed package catalog paths overlap: packages/a and packages/a/nested");
  });
});

describe("v1 complexity architecture inventory", () => {
  it("accounts for production dependency edges and cycles, code export subpaths, closures, and native dependencies", () => {
    const catalog = [
      catalogEntry({ name: "@test/a", path: "packages/a" }),
      catalogEntry({ name: "@test/b", path: "packages/b", publishable: false }),
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
  it("executes the declared generator and detects a non-reproducible tracked result", async () => {
    const cwd = await tempGitRepository();
    const generatedPath = "packages/a/src/generated.ts";
    const generatedBytes = Buffer.from("export const generated = 1;\n");
    await writeJson(
      join(cwd, "refactor/v1-complexity-classification-authority.json"),
      testClassificationAuthority(),
    );
    await writeJson(join(cwd, "refactor/v1-complexity-policy.json"), testInventoryPolicy({
      generatedFiles: [{
        id: "generated-client",
        path: generatedPath,
        reason: "Generated fixture.",
        contentSha256: sha256(generatedBytes),
        generator: {
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync('packages/a/src/generated.ts', 'export const generated = 2;\\n')",
          ],
        },
        reproducibilityCheck: {
          command: "git",
          args: ["diff", "--exit-code", "--", generatedPath],
        },
      }],
    }));
    await writeJson(join(cwd, "packages/a/package.json"), { name: "@test/a" });
    await writeFile(join(cwd, generatedPath), generatedBytes);
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");

    const snapshot = collectComplexitySnapshot({ cwd, catalog: [catalogEntry()] });
    expect(readFileSync(join(cwd, generatedPath), "utf8")).toContain("generated = 2");
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("generated evidence generated-client reproducibility check exited 1"),
      "generated evidence generated-client reproducibility run changed the repository tree",
    ]));
  });

  it("reads stage-0 blobs, ignores untracked files, and flags a dirty indexed source", async () => {
    const cwd = await tempGitRepository();
    await writeJson(
      join(cwd, "refactor/v1-complexity-classification-authority.json"),
      testClassificationAuthority({ nonShippingRules: [rule("repository-tooling", { prefixes: ["scripts/"] })] }),
    );
    await writeJson(join(cwd, "refactor/v1-complexity-policy.json"), testInventoryPolicy());
    await writeJson(join(cwd, "packages/a/package.json"), {
      name: "@test/a",
      version: "1.0.0",
      exports: "./dist/index.js",
    });
    await writeFile(join(cwd, "packages/a/src/index.ts"), "export const value = 1;\r\n", "utf8");
    await writeFile(join(cwd, "packages/a/src/test/helper.ts"), "export const helper = true;\n", "utf8");
    await writeFile(join(cwd, "scripts/check.mjs"), "#!/usr/bin/env node\n", "utf8");
    git(cwd, "add", ".");

    const catalog = [catalogEntry()];
    const beforeUntracked = collectComplexitySnapshot({ cwd, catalog });
    await writeFile(join(cwd, "packages/a/src/untracked.ts"), "throw new Error();\n", "utf8");
    const clean = collectComplexitySnapshot({ cwd, catalog });

    expect(clean.manifestSha256).toBe(beforeUntracked.manifestSha256);
    expect(clean.snapshotSha256).toBe(beforeUntracked.snapshotSha256);
    expect(clean.issues).toEqual([]);
    expect(clean.totals.byClassification.production).toEqual({ files: 1, lines: 1 });
    expect(clean.totals.byClassification.test).toEqual({ files: 1, lines: 1 });
    expect(clean.totals.byClassification.excluded).toEqual({ files: 2, lines: 6 });
    expect(clean.files.map((file) => file.path)).not.toContain("packages/a/src/untracked.ts");
    expect(clean.inventory.workspacePackages).toMatchObject({ total: 1, publishable: 1 });

    await writeFile(join(cwd, "packages/a/src/index.ts"), "export const value = 2;\n", "utf8");
    const dirty = collectComplexitySnapshot({ cwd, catalog });
    expect(dirty.totals).toEqual(clean.totals);
    expect(dirty.manifestSha256).toBe(clean.manifestSha256);
    expect(dirty.snapshotSha256).toBe(clean.snapshotSha256);
    expect(evaluateGate(dirty, "G0")).toContain("packages/a/src/index.ts has unstaged source changes");
  });

  it("derives package catalog paths and publishability from stage-0 rather than the worktree", async () => {
    const cwd = await tempGitRepository();
    await writeJson(
      join(cwd, "refactor/v1-complexity-classification-authority.json"),
      testClassificationAuthority({ nonShippingRules: [rule("repository-tooling", { prefixes: ["scripts/"] })] }),
    );
    await writeJson(join(cwd, "refactor/v1-complexity-policy.json"), testInventoryPolicy());
    await writeJson(join(cwd, "packages/a/package.json"), {
      name: "@test/a",
      version: "1.0.0",
      exports: "./dist/index.js",
    });
    await writeFile(join(cwd, "packages/a/src/index.ts"), "export const value = 1;\n", "utf8");
    const catalogPath = join(cwd, "scripts/package-catalog.mjs");
    const indexedCatalog = [
      "export const PACKAGE_CATEGORIES = [\"core\"];",
      "export const packageCatalog = [",
      "  { allowedDependencyCategories: [], category: \"core\", dir: \"a\", name: \"@test/a\", publishable: true, responsibility: \"Test package.\" },",
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

    expect(clean.inventory.workspacePackages).toMatchObject({ total: 1, publishable: 1 });
    expect(dirty.inventory.workspacePackages).toEqual(clean.inventory.workspacePackages);
    expect(dirty.manifestSha256).toBe(clean.manifestSha256);
    expect(dirty.snapshotSha256).toBe(clean.snapshotSha256);
    expect(dirty.issues).toEqual(expect.arrayContaining([
      "scripts/package-catalog.mjs has unstaged report-input changes",
      "scripts/package-catalog.mjs has unstaged source changes",
    ]));
  });
});

describe("v1 complexity frozen G0 authority", () => {
  it("uses a non-release authority tag that cannot match the npm v* release trigger", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/npm-release.yml"), "utf8");
    const releasePattern = /tags:\s*\n\s*-\s*"([^"]+)"/u.exec(workflow)?.[1];
    const authorityTag = G0_AUTHORITY_REF.replace(/^refs\/tags\//u, "");

    expect(releasePattern).toBe("v*");
    expect(matchesSimpleTagPattern(authorityTag, releasePattern)).toBe(false);
    expect(authorityTag).toBe("authority/v1-complexity-g0");
  });

  it("requires exact paths, internally consistent totals, and a non-release ref", () => {
    const valid = g0AuthorityFixture();
    expect(() => validateComplexityG0Authority(valid)).not.toThrow();
    expect(() => validateComplexityG0Authority({
      ...valid,
      authorityRef: "refs/tags/v1-complexity-g0",
    })).toThrow(`must be non-release annotated tag ${G0_AUTHORITY_REF}`);
    expect(() => validateComplexityG0Authority({
      ...valid,
      totals: {
        ...valid.totals,
        allAccounted: { files: 1, lines: 1 },
      },
    })).toThrow("totals.allAccounted must equal the classification sum");
    expect(() => validateComplexityG0Authority({
      ...valid,
      baseline: { ...valid.baseline, path: "refactor/baselines/weaker.json" },
    })).toThrow("baseline.path must be refactor/baselines/v1-complexity-baseline.json");
  });

  it("bootstraps only at G0, requires an annotated digest-bound tag later, and ignores rewritten baseline bytes", async () => {
    const cwd = await tempGitRepository();
    await mkdir(join(cwd, "refactor/baselines"), { recursive: true });
    const classificationAuthority = testClassificationAuthority();
    const inventoryPolicy = testInventoryPolicy();
    const policy = resolveComplexityPolicy(classificationAuthority, inventoryPolicy);
    const baseline = snapshotFor([], new Map(), policy);
    const classificationPath = "refactor/v1-complexity-classification-authority.json";
    const inventoryPath = "refactor/v1-complexity-policy.json";
    const baselinePath = "refactor/baselines/v1-complexity-baseline.json";
    const authorityPath = "refactor/baselines/v1-complexity-g0-authority.json";
    await writeJson(join(cwd, classificationPath), classificationAuthority);
    await writeJson(join(cwd, inventoryPath), inventoryPolicy);
    await writeFile(join(cwd, baselinePath), stablePrettyJson(baseline), "utf8");

    const authority = g0AuthorityFixture({
      baseline: {
        contentSha256: sha256(readFileSync(join(cwd, baselinePath))),
        gitBlobOid: git(cwd, "hash-object", baselinePath).trim(),
        manifestSha256: baseline.manifestSha256,
        path: baselinePath,
        snapshotSha256: baseline.snapshotSha256,
      },
      classificationAuthority: {
        canonicalSha256: baseline.classificationAuthoritySha256,
        contentSha256: sha256(readFileSync(join(cwd, classificationPath))),
        gitBlobOid: git(cwd, "hash-object", classificationPath).trim(),
        path: classificationPath,
      },
      initialInventoryPolicy: {
        canonicalSha256: baseline.inventoryPolicySha256,
        contentSha256: sha256(readFileSync(join(cwd, inventoryPath))),
        gitBlobOid: git(cwd, "hash-object", inventoryPath).trim(),
        path: inventoryPath,
      },
      totals: {
        allAccounted: baseline.totals.allExecutable,
        ...baseline.totals.byClassification,
      },
    });
    await writeJson(join(cwd, authorityPath), authority);
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "G0");

    const bootstrap = loadComplexityG0Authority({ cwd, path: authorityPath, baselinePath, gate: "G0" });
    expect(bootstrap.refEvidence).toMatchObject({ status: "pending-post-merge", annotated: false });
    expect(() => loadComplexityG0Authority({ cwd, path: authorityPath, baselinePath, gate: "G0.25" })).toThrow(
      `Annotated G0 authority ref ${G0_AUTHORITY_REF} is required after G0`,
    );

    const shortRef = G0_AUTHORITY_REF.replace(/^refs\/tags\//u, "");
    git(cwd, "tag", shortRef);
    expect(() => loadComplexityG0Authority({ cwd, path: authorityPath, baselinePath, gate: "G0.25" })).toThrow(
      "must be an annotated tag object",
    );
    git(cwd, "tag", "-d", shortRef);

    const authorityDigest = sha256(readFileSync(join(cwd, authorityPath)));
    git(
      cwd,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid",
      "tag", "-a", shortRef,
      "-m", "Freeze V1 complexity G0 authority.",
      "-m", `Complexity-Authority-SHA256: ${authorityDigest}`,
    );
    const anchored = loadComplexityG0Authority({ cwd, path: authorityPath, baselinePath, gate: "G0.25" });
    expect(anchored.refEvidence).toMatchObject({ status: "anchored", annotated: true });
    expect(anchored.baseline.snapshot.snapshotSha256).toBe(baseline.snapshotSha256);

    await writeFile(join(cwd, baselinePath), "{}\n", "utf8");
    git(cwd, "add", baselinePath);
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Attempt rewrite");
    const afterRewrite = loadComplexityG0Authority({ cwd, path: authorityPath, baselinePath, gate: "G0.25" });
    expect(afterRewrite.baseline.snapshot.snapshotSha256).toBe(baseline.snapshotSha256);
    expect(afterRewrite.baseline.evidence.source).toBe("annotated-authority-ref");
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
      loadAuthority: () => authorityResult(snapshot),
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
    expect(renderHumanReport(result.report, "G0")).toContain(
      `authority ref: ${G0_AUTHORITY_REF} (pending-post-merge)`,
    );
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
      loadAuthority: () => authorityResult(snapshot, loaded.evidence),
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
      loadAuthority: () => authorityResult(snapshot, loaded.evidence),
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
      loadAuthority: () => authorityResult(snapshot, loaded.evidence),
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

  it("requires an exact frozen snapshot at G0 even when report mode uses --baseline", () => {
    const configured = testPolicy();
    const entries = [entry("packages/a/src/index.ts", "a")];
    const blobsByOid = new Map([["a", Buffer.from("export {};\n")]]);
    const baseline = snapshotFor(entries, blobsByOid, configured);
    const currentPolicy = testPolicy({ inventoryPolicy: { knownNativeDependencies: ["native-addon"] } });
    const current = snapshotFor(entries, blobsByOid, currentPolicy);
    const stdout = sink();
    const stderr = sink();
    const result = runV1ComplexityReport({
      argv: ["--gate", "G0", "--baseline", "baseline.json"],
      collectSnapshot: () => current,
      loadAuthority: () => authorityResult(baseline),
      collectTreeEvidence: () => currentTreeEvidence(),
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failures).toContain(
      `current snapshot ${current.snapshotSha256} does not match baseline ${baseline.snapshotSha256}`,
    );
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

function testClassificationAuthority(overrides = {}) {
  return {
    schema: "mono-agent.v1-complexity-classification-authority.v1",
    algorithmVersion: COMPLEXITY_ALGORITHM_VERSION,
    executableExtensions: [
      ".bash", ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".sh", ".ts", ".tsx", ".zsh",
    ],
    packageTextExtensions: [
      ".css", ".gql", ".graphql", ".html", ".json", ".jsonc", ".md", ".sql", ".svg", ".vue", ".yaml", ".yml",
    ],
    sourceDirectorySegments: ["bin", "resources", "schema", "scripts", "skills", "src"],
    testPathSegments: ["__fixtures__", "__tests__", "fixtures", "test", "testdata", "tests"],
    testFilenameMarkers: [".spec.", ".test.", "vitest.config."],
    productionRoots: ["packages/"],
    nonShippingRules: [],
    declarationSuffixes: [".d.cts", ".d.mts", ".d.ts"],
    packageDocumentationNames: [
      "AGENTS.md", "ARCHITECTURE.md", "LICENSE", "MIGRATION.md", "README.md", "THIRD_PARTY_NOTICES.md",
    ],
    packageMetadataNames: [
      ".gitignore", ".npmignore", "package-lock.json", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    ],
    buildConfigFilenameMarkers: ["tsconfig"],
    binaryAssetExtensions: [".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp", ".woff", ".woff2"],
    ...overrides,
  };
}

function testInventoryPolicy(overrides = {}) {
  return {
    schema: "mono-agent.v1-complexity-inventory-policy.v1",
    classificationAuthorityPath: "refactor/v1-complexity-classification-authority.json",
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
      detection: {
        allContentMarkers: ["/v1/turns", "application/x-ndjson", "fetchImpl"],
        pathPrefixes: ["extras/", "packages/"],
      },
      registeredMember: null,
      minMembers: 1,
      maxMembers: 1,
      enforceAt: "G8",
    }],
    generatedFiles: [],
    vendoredFiles: [],
    excludedFiles: [],
    ...overrides,
  };
}

function testPolicy(overrides = {}) {
  const {
    classificationAuthority: classificationAuthorityOverrides = {},
    inventoryPolicy: inventoryPolicyOverrides = {},
    ...resolvedOverrides
  } = overrides;
  return {
    ...resolveComplexityPolicy(
      testClassificationAuthority(classificationAuthorityOverrides),
      testInventoryPolicy(inventoryPolicyOverrides),
    ),
    ...resolvedOverrides,
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

function authorityResult(snapshot, evidence = baselineEvidence(snapshot)) {
  return {
    baseline: { snapshot, evidence },
    authorityEvidence: {
      source: "committed-git-blob",
      path: "refactor/baselines/v1-complexity-g0-authority.json",
      commit: evidence.commit,
      gitBlobOid: "e".repeat(40),
      contentSha256: "f".repeat(64),
    },
    refEvidence: {
      status: "pending-post-merge",
      ref: G0_AUTHORITY_REF,
      annotated: false,
      commit: null,
    },
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

function snapshotFor(entries, blobsByOid, policy, catalog = catalogForEntries(entries)) {
  const manifest = buildFileManifest({ entries, blobsByOid, policy, catalog });
  return buildComplexitySnapshot({
    manifest,
    policy,
    ...inventoryInputs(entries, blobsByOid, catalog),
    catalog,
  });
}

function inventoryInputs(entries, blobsByOid, catalog) {
  const augmentedEntries = [...entries];
  const augmentedBlobs = new Map(blobsByOid);
  const paths = new Set(entries.map(({ path }) => path));
  for (const [index, catalogRecord] of catalog.entries()) {
    const manifestPath = `${catalogRecord.path}/package.json`;
    if (paths.has(manifestPath)) continue;
    const oid = `synthetic-manifest-${index}`;
    augmentedEntries.push(entry(manifestPath, oid));
    augmentedBlobs.set(oid, jsonBuffer({ name: catalogRecord.name }));
  }
  return { entries: augmentedEntries, blobsByOid: augmentedBlobs };
}

function catalogForEntries(entries) {
  const roots = new Set(entries.flatMap(({ path }) => {
    const match = /^(packages|extras)\/([^/]+)\//u.exec(path);
    return match === null ? [] : [`${match[1]}/${match[2]}`];
  }));
  return [...roots].sort().map((path) => catalogEntry({
    path,
    name: `@test/${path.split("/")[1]}`,
  }));
}

function catalogEntry(overrides = {}) {
  return {
    allowedDependencyCategories: [],
    category: "core",
    name: "@test/a",
    path: "packages/a",
    publishable: true,
    responsibility: "Test package.",
    tier: null,
    ...overrides,
  };
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

function operatorFailure(message) {
  return message.startsWith("operator-wire-client");
}

function matchesSimpleTagPattern(tag, pattern) {
  if (pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")) {
    return tag.startsWith(pattern.slice(0, -1));
  }
  return tag === pattern;
}

function g0AuthorityFixture(overrides = {}) {
  const zero = { files: 0, lines: 0 };
  return {
    schema: "mono-agent.v1-complexity-g0-authority.v1",
    algorithmVersion: COMPLEXITY_ALGORITHM_VERSION,
    authorityRef: G0_AUTHORITY_REF,
    baseline: {
      contentSha256: "a".repeat(64),
      gitBlobOid: "b".repeat(40),
      manifestSha256: "c".repeat(64),
      path: "refactor/baselines/v1-complexity-baseline.json",
      snapshotSha256: "d".repeat(64),
    },
    classificationAuthority: {
      canonicalSha256: "e".repeat(64),
      contentSha256: "f".repeat(64),
      gitBlobOid: "1".repeat(40),
      path: "refactor/v1-complexity-classification-authority.json",
    },
    initialInventoryPolicy: {
      canonicalSha256: "2".repeat(64),
      contentSha256: "3".repeat(64),
      gitBlobOid: "4".repeat(40),
      path: "refactor/v1-complexity-policy.json",
    },
    totals: {
      allAccounted: zero,
      excluded: zero,
      generated: zero,
      production: zero,
      test: zero,
      unclassified: zero,
      vendored: zero,
    },
    postMergeRefContract: {
      annotatedTagRequired: true,
      authorityDigestTrailer: "Complexity-Authority-SHA256",
      protectedRefRequired: true,
      releaseWorkflowMustNotMatch: true,
      targetMustContainExactBlobs: true,
    },
    ...overrides,
  };
}
