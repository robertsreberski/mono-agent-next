import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireBuildLock,
  buildLockPath,
  buildMarkerPath,
  clearBuildMarker,
  computeBuildOutputDigest,
  computeDeploymentStateFingerprint,
  computeRuntimeDependencyDigest,
  parseBuildMarker,
  preserveBuildLock,
  publishBuildMarker,
  readBuildMarker,
  releaseBuildLock,
} from "../lib/build-provenance.mjs";

const SHA = "445c851e46e65f0048735ea8ecb0b85bff3c0bb9";
const COMPLETED_AT = "2026-07-12T20:00:00.000Z";
const DIGEST = "a".repeat(64);
const DEPENDENCY_DIGEST = "b".repeat(64);
const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-build-provenance-"));
  roots.push(root);
  return root;
}

function marker(overrides = {}) {
  return {
    schemaVersion: 2,
    gitSha: SHA,
    completedAt: COMPLETED_AT,
    nodeVersion: "24.15.0",
    nodeAbi: "137",
    sourceState: "clean",
    outputDigest: DIGEST,
    dependencyDigest: DEPENDENCY_DIGEST,
    ...overrides,
  };
}

function createOutputs(root, order = "forward") {
  const entries = [
    ["packages/example/package.json", '{"name":"example"}\n'],
    ["packages/example/dist/index.js", "export const example = 1;\n"],
    ["packages/example/dist/nested/value.txt", "nested\n"],
    ["packages/core/package.json", '{"name":"core"}\n'],
    ["packages/core/dist/index.js", "export const core = true;\n"],
    ["packages/tui/package.json", '{"name":"tui"}\n'],
    ["packages/tui/dist/bin/mono-agent-tui.js", "#!/usr/bin/env node\n"],
    ["packages/web/package.json", '{"name":"web"}\n'],
    ["packages/web/dist/index.js", "export const server = true;\n"],
    ["packages/web/webapp/dist/index.html", "<!doctype html>\n"],
    ["extras/example/package.json", '{"name":"extra"}\n'],
    ["extras/example/dist/index.js", "export const extra = true;\n"],
  ];
  if (order === "reverse") entries.reverse();
  for (const [relativePath, contents] of entries) {
    const path = join(root, ...relativePath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  // The scanner requires both workspace category directories even if only a
  // subset of packages have deployable dist output.
  mkdirSync(join(root, "packages"), { recursive: true });
  mkdirSync(join(root, "extras"), { recursive: true });
  createDependencies(root, order);
}

function createDependencies(root, order = "forward") {
  const entries = [
    ["node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js", "export const value = 1;\n"],
    ["node_modules/.pnpm/better-sqlite3@12.0.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01])],
  ];
  if (order === "reverse") entries.reverse();
  for (const [relativePath, contents] of entries) {
    const path = join(root, ...relativePath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  const rootLink = join(root, "node_modules/example-dep");
  symlinkSync(".pnpm/example-dep@1.0.0/node_modules/example-dep", rootLink);
  symlinkSync("../packages/example", join(root, "node_modules/example-workspace"));
  const packageLink = join(root, "packages/example/node_modules/example-dep");
  mkdirSync(join(packageLink, ".."), { recursive: true });
  symlinkSync("../../../node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep", packageLink);
  const extraLink = join(root, "extras/example/node_modules/example-dep");
  mkdirSync(join(extraLink, ".."), { recursive: true });
  symlinkSync("../../../node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep", extraLink);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("strict build marker", () => {
  it("accepts only the exact closed schema", () => {
    expect(parseBuildMarker(marker())).toEqual(marker());
    expect(parseBuildMarker({ ...marker(), extra: "private-value" })).toBeNull();
    expect(parseBuildMarker(marker({ sourceState: "unknown" }))).toBeNull();
    expect(parseBuildMarker(marker({ completedAt: "2026-07-12T20:00:00Z" }))).toBeNull();
    expect(parseBuildMarker(marker({ gitSha: "445c851" }))).toBeNull();
    expect(parseBuildMarker(marker({ nodeAbi: 137 }))).toBeNull();
    expect(parseBuildMarker(marker({ outputDigest: "short" }))).toBeNull();
    expect(parseBuildMarker(marker({ dependencyDigest: "short" }))).toBeNull();
    const { dependencyDigest: _missing, ...withoutDependencyDigest } = marker();
    expect(parseBuildMarker(withoutDependencyDigest)).toBeNull();
    expect(parseBuildMarker(marker({ schemaVersion: 1 }))).toBeNull();
  });

  it("publishes explicit owner-only canonical bytes even under a hostile umask", () => {
    const root = tempRoot();
    const previousUmask = process.umask(0o777);
    try {
      publishBuildMarker(root, marker());
    } finally {
      process.umask(previousUmask);
    }

    expect(lstatSync(buildMarkerPath(root)).mode & 0o777).toBe(0o600);
    expect(readFileSync(buildMarkerPath(root), "utf8")).toBe(`${JSON.stringify(marker())}\n`);
    expect(readBuildMarker(root)).toMatchObject({ status: "ok", marker: marker() });
    expect(readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([]);

    clearBuildMarker(root);
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
  });

  it("rejects permissive, hard-linked, and non-canonical duplicate-key markers", () => {
    const root = tempRoot();
    publishBuildMarker(root, marker());
    linkSync(buildMarkerPath(root), join(root, "second-marker-link"));
    expect(readBuildMarker(root)).toEqual({ status: "unsafe" });
    rmSync(join(root, "second-marker-link"));

    const duplicate = `${JSON.stringify(marker()).replace(
      `\"outputDigest\":\"${DIGEST}\"`,
      `\"outputDigest\":\"${"b".repeat(64)}\",\"outputDigest\":\"${DIGEST}\"`,
    )}\n`;
    writeFileSync(buildMarkerPath(root), duplicate, { mode: 0o600 });
    expect(readBuildMarker(root)).toEqual({ status: "malformed" });

    writeFileSync(buildMarkerPath(root), `${JSON.stringify(marker())}\n`);
    chmodSync(buildMarkerPath(root), 0o644);
    expect(readBuildMarker(root)).toEqual({ status: "unsafe" });
  });

  it("removes the renamed destination when a post-rename durability step fails", () => {
    const root = tempRoot();
    expect(() => publishBuildMarker(root, marker(), {
      afterRename() {
        throw new Error("injected post-rename failure");
      },
    })).toThrow("injected post-rename failure");
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
    expect(readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("preserves an active lock and recreates one after normal release removed it", () => {
    const root = tempRoot();
    const active = acquireBuildLock(root);
    preserveBuildLock(root, active);
    expect(readBuildMarker(root)).toEqual({ status: "unsafe" });

    rmSync(buildLockPath(root));
    const released = acquireBuildLock(root);
    releaseBuildLock(root, released);
    preserveBuildLock(root, released);
    expect(readBuildMarker(root)).toEqual({ status: "unsafe" });
  });

  it.each(["replace", "unlink"])(
    "rejects bytes read from a stale descriptor when the marker path is %s after read",
    (action) => {
      const root = tempRoot();
      publishBuildMarker(root, marker());
      const result = readBuildMarker(root, {
        afterRead() {
          if (action === "replace") {
            publishBuildMarker(root, marker());
          } else {
            rmSync(buildMarkerPath(root));
          }
        },
      });
      expect(result).toEqual({ status: "unsafe" });
    },
  );
});

describe("deterministic output digest", () => {
  it("is creation-order independent and changes when any deploy output changes", () => {
    const first = tempRoot();
    const second = tempRoot();
    createOutputs(first, "forward");
    createOutputs(second, "reverse");
    const syncedDirectories = [];
    const digest = computeBuildOutputDigest(first, {
      sync: true,
      onDirectorySync(path) {
        syncedDirectories.push(path);
      },
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeBuildOutputDigest(second)).toBe(digest);
    for (const ancestor of [
      first,
      join(first, "packages"),
      join(first, "packages/web"),
      join(first, "packages/web/webapp"),
      join(first, "extras"),
    ]) {
      expect(syncedDirectories).toContain(ancestor);
    }

    writeFileSync(join(first, "packages/example/dist/index.js"), "export const example = 2;\n");
    expect(computeBuildOutputDigest(first)).not.toBe(digest);
  });

  it("rejects symlinks instead of hashing through them", () => {
    const root = tempRoot();
    createOutputs(root);
    symlinkSync("index.js", join(root, "packages/example/dist/alias.js"));
    expect(() => computeBuildOutputDigest(root)).toThrow("unsafe build output entry");
  });
});

describe("deterministic runtime dependency digest", () => {
  it("ignores only node_modules Vitest result-cache creation and mutation", () => {
    const root = tempRoot();
    createOutputs(root);
    const digest = computeRuntimeDependencyDigest(root);
    const cacheDirectories = [
      join(root, "node_modules/.vite/vitest"),
      join(root, "packages/example/node_modules/.vite/vitest"),
      join(root, "extras/example/node_modules/.vite/vitest"),
    ];

    for (const cacheDirectory of cacheDirectories) {
      mkdirSync(cacheDirectory, { recursive: true });
      writeFileSync(join(cacheDirectory, "results.json"), '{"version":1}\n');
    }
    expect(computeRuntimeDependencyDigest(root)).toBe(digest);

    for (const cacheDirectory of cacheDirectories) {
      writeFileSync(join(cacheDirectory, "results.json"), '{"version":2}\n');
      mkdirSync(join(cacheDirectory, "nested"));
      writeFileSync(join(cacheDirectory, "nested/state.bin"), Buffer.from([0x01, 0x02]));
    }
    expect(computeRuntimeDependencyDigest(root)).toBe(digest);

    const attestedViteEntry = join(root, "packages/example/node_modules/.vite/runtime.js");
    writeFileSync(attestedViteEntry, "export const runtime = 1;\n");
    const digestWithViteEntry = computeRuntimeDependencyDigest(root);
    expect(digestWithViteEntry).not.toBe(digest);

    writeFileSync(attestedViteEntry, "export const runtime = 2;\n");
    expect(computeRuntimeDependencyDigest(root)).not.toBe(digestWithViteEntry);
  });

  it("is creation-order independent and changes on arbitrary JavaScript mutation", () => {
    const first = tempRoot();
    const second = tempRoot();
    createOutputs(first, "forward");
    createOutputs(second, "reverse");
    const digest = computeRuntimeDependencyDigest(first);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeRuntimeDependencyDigest(second)).toBe(digest);

    writeFileSync(
      join(first, "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js"),
      "export const value = 2;\n",
    );
    expect(computeRuntimeDependencyDigest(first)).not.toBe(digest);
  });

  it("changes when a native addon is rebuilt", () => {
    const root = tempRoot();
    createOutputs(root);
    const digest = computeRuntimeDependencyDigest(root);
    writeFileSync(
      join(root, "node_modules/.pnpm/better-sqlite3@12.0.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x02]),
    );
    expect(computeRuntimeDependencyDigest(root)).not.toBe(digest);
  });

  it("streams large files in bounded reusable chunks", () => {
    const root = tempRoot();
    createOutputs(root);
    const largeDependency = join(
      root,
      "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/large.bin",
    );
    writeFileSync(largeDependency, Buffer.alloc((2 * 1024 * 1024) + 17, 0x5a));
    const chunkSizes = [];
    expect(computeRuntimeDependencyDigest(root, {
      onFileReadChunk(bytesRead) {
        chunkSizes.push(bytesRead);
      },
    })).toMatch(/^[0-9a-f]{64}$/u);
    expect(Math.max(...chunkSizes)).toBe(1024 * 1024);
    expect(chunkSizes.filter((size) => size === 1024 * 1024)).toHaveLength(4);
  });

  it("frames dependency mode bits without changing output digest mode semantics", () => {
    const root = tempRoot();
    createOutputs(root);
    const dependency = join(
      root,
      "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js",
    );
    chmodSync(dependency, 0o755);
    const dependencyDigest = computeRuntimeDependencyDigest(root);
    chmodSync(dependency, 0o644);
    expect(computeRuntimeDependencyDigest(root)).not.toBe(dependencyDigest);

    const output = join(root, "packages/example/dist/index.js");
    const outputDigest = computeBuildOutputDigest(root);
    chmodSync(output, 0o755);
    expect(computeBuildOutputDigest(root)).toBe(outputDigest);
  });

  it("hashes safe symlink targets and rejects absolute or repository-escaping targets", () => {
    const root = tempRoot();
    createOutputs(root);
    const alternate = join(root, "node_modules/.pnpm/alternate@1.0.0/node_modules/alternate");
    mkdirSync(alternate, { recursive: true });
    writeFileSync(join(alternate, "index.js"), "export const value = 1;\n");
    const digest = computeRuntimeDependencyDigest(root);
    const link = join(root, "node_modules/example-dep");
    rmSync(link);
    symlinkSync(".pnpm/alternate@1.0.0/node_modules/alternate", link);
    expect(computeRuntimeDependencyDigest(root)).not.toBe(digest);

    rmSync(link);
    symlinkSync("/tmp/outside", link);
    expect(() => computeRuntimeDependencyDigest(root)).toThrow("unsafe runtime dependency symlink");
    rmSync(link);
    symlinkSync("../../outside", link);
    expect(() => computeRuntimeDependencyDigest(root)).toThrow("runtime dependency symlink escapes repository");
  });

  it("accepts exact canonical workspace links and rejects arbitrary in-repo referents", () => {
    const root = tempRoot();
    createOutputs(root);
    const digest = computeRuntimeDependencyDigest(root);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);

    writeFileSync(join(root, "packages/example/ignored-runtime.js"), "export const ignored = true;\n");
    expect(computeRuntimeDependencyDigest(root)).not.toBe(digest);

    const ignoredRuntime = join(root, "ignored-runtime");
    mkdirSync(ignoredRuntime);
    writeFileSync(join(ignoredRuntime, "index.js"), "export const ignored = true;\n");
    symlinkSync("../ignored-runtime", join(root, "node_modules/ignored-runtime"));
    expect(() => computeRuntimeDependencyDigest(root)).toThrow(
      "runtime dependency symlink target is not attested",
    );
  });

  it("fails closed when dependency bytes change between stable passes", () => {
    const root = tempRoot();
    createOutputs(root);
    const dependency = join(
      root,
      "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js",
    );
    expect(() => computeRuntimeDependencyDigest(root, {
      afterFirstPass() {
        writeFileSync(dependency, "export const value = 9;\n");
      },
    })).toThrow("runtime dependency");
  });

  it("requires the root dependency tree", () => {
    const root = tempRoot();
    mkdirSync(join(root, "packages"));
    mkdirSync(join(root, "extras"));
    expect(() => computeRuntimeDependencyDigest(root)).toThrow("runtime dependency directory unavailable");
  });
});

describe("combined deployment state fingerprint", () => {
  it("is stable when output and dependency metadata are quiescent", () => {
    const root = tempRoot();
    createOutputs(root);
    const fingerprint = computeDeploymentStateFingerprint(root);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeDeploymentStateFingerprint(root)).toBe(fingerprint);
    chmodSync(
      join(root, "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js"),
      0o755,
    );
    expect(computeDeploymentStateFingerprint(root)).not.toBe(fingerprint);
  });

  it.each([
    ["output", "packages/example/dist/index.js"],
    ["dependency", "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js"],
  ])("fails closed when %s metadata changes between its own passes", (_kind, relativePath) => {
    const root = tempRoot();
    createOutputs(root);
    expect(() => computeDeploymentStateFingerprint(root, {
      afterFirstPass() {
        writeFileSync(join(root, ...relativePath.split("/")), "changed between metadata passes\n");
      },
    })).toThrow("deployment state changed during metadata fingerprint");
  });
});
