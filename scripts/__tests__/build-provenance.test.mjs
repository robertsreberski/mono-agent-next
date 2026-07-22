import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runBuildProvenanceProbe } from "../build-provenance-probe.mjs";
import {
  prependNodeToPath,
  resolveTrustedGitExecutable,
  runBuildWithProvenance,
  selectBuildInvocation,
  supportsStrictBuildProvenance,
} from "../build-with-provenance.mjs";
import {
  BUILD_LOCK_FILENAME,
  BUILD_MARKER_FILENAME,
  acquireBuildLock,
  buildLockPath,
  buildMarkerPath,
  clearBuildMarker,
  computeBuildOutputDigest,
  computeDeploymentStateFingerprint,
  computeRuntimeDependencyDigest,
  parseBuildMarker,
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
    ["packages/agent-app/package.json", '{"name":"agent-app"}\n'],
    ["packages/agent-app/dist/cli.js", "#!/usr/bin/env node\n"],
    ["packages/tui/package.json", '{"name":"tui"}\n'],
    ["packages/tui/dist/bin/mono-agent-tui.js", "#!/usr/bin/env node\n"],
    ["packages/web/package.json", '{"name":"web"}\n'],
    ["packages/web/dist/index.js", "export const server = true;\n"],
    ["packages/web/webapp/dist/index.html", "<!doctype html>\n"],
    ["extras/example/package.json", '{"name":"extra"}\n'],
    ["extras/example/dist/index.js", "export const extra = true;\n"],
    ["demos/final-agent/dist/cli.js", "console.log('demo');\n"],
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
      join(first, "demos"),
      join(first, "demos/final-agent"),
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

describe("provenance build lifecycle", () => {
  it("uses the native PATH delimiter for portable build children", () => {
    expect(prependNodeToPath("C:\\node", "C:\\tools", "win32")).toBe("C:\\node;C:\\tools");
    expect(prependNodeToPath("/node", "/tools", "darwin")).toBe("/node:/tools");
    expect(prependNodeToPath("/node", "", "linux")).toBe("/node");
  });

  it("executes a validated Windows npm_execpath with the exact Node runtime", () => {
    expect(selectBuildInvocation("pnpm", ["-r", "--sort", "run", "build"], {
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js",
    })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js",
        "-r",
        "--sort",
        "run",
        "build",
      ],
    });
  });

  it("accepts an exact user-global Windows pnpm entrypoint under PNPM_HOME", () => {
    expect(selectBuildInvocation("pnpm", ["run", "build:demo"], {
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "D:\\Users\\example\\AppData\\Local\\pnpm\\pnpm.cjs",
      env: { PNPM_HOME: "D:\\Users\\example\\AppData\\Local\\pnpm" },
    })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "D:\\Users\\example\\AppData\\Local\\pnpm\\pnpm.cjs",
        "run",
        "build:demo",
      ],
    });
  });

  it("rejects Windows shell fallback and untrusted pnpm entrypoints", () => {
    expect(() => selectBuildInvocation("pnpm", ["run", "build:demo & private-command"], {
      platform: "win32",
    })).toThrow("unsafe Windows pnpm build command");
    for (const npmExecPath of [
      "C:\\private\\pnpm.js",
      "C:\\Program Files\\nodejs\\node_modules\\..\\pnpm.js",
      "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\not-pnpm.js",
      undefined,
    ]) {
      expect(() => selectBuildInvocation("pnpm", ["run", "build:demo"], {
        platform: "win32",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath,
      })).toThrow("trusted Windows pnpm entrypoint unavailable");
    }
  });

  it.each([
    {
      label: "relative PNPM_HOME",
      npmExecPath: "D:\\pnpm\\pnpm.cjs",
      pnpmHome: "relative\\pnpm",
    },
    {
      label: "traversing PNPM_HOME",
      npmExecPath: "D:\\private\\pnpm.cjs",
      pnpmHome: "D:\\trusted\\..\\private",
    },
    {
      label: "drive-root PNPM_HOME",
      npmExecPath: "D:\\private\\pnpm.cjs",
      pnpmHome: "D:\\",
    },
    {
      label: "drive-root Node install",
      nodePath: "C:\\node.exe",
      npmExecPath: "C:\\private\\pnpm.cjs",
    },
    {
      label: "traversing entrypoint",
      npmExecPath: "D:\\trusted\\..\\private\\pnpm.cjs",
      pnpmHome: "D:\\trusted",
    },
    {
      label: "UNC entrypoint",
      npmExecPath: "\\\\server\\share\\pnpm.cjs",
      pnpmHome: "\\\\server\\share",
    },
    {
      label: "device entrypoint",
      npmExecPath: "\\\\?\\D:\\trusted\\pnpm.cjs",
      pnpmHome: "D:\\trusted",
    },
    {
      label: "reserved device segment",
      npmExecPath: "D:\\NUL\\pnpm.cjs",
      pnpmHome: "D:\\NUL",
    },
    {
      label: "control character",
      npmExecPath: "D:\\trusted\\pnpm.cjs\n--require=private.js",
      pnpmHome: "D:\\trusted",
    },
    {
      label: "traversing Node runtime",
      nodePath: "C:\\Program Files\\nodejs\\..\\private\\node.exe",
      npmExecPath: "D:\\trusted\\pnpm.cjs",
      pnpmHome: "D:\\trusted",
    },
  ])("rejects a malformed Windows trust claim: $label", ({
    nodePath = "C:\\Program Files\\nodejs\\node.exe",
    npmExecPath,
    pnpmHome,
  }) => {
    expect(() => selectBuildInvocation("pnpm", ["run", "build:demo"], {
      platform: "win32",
      nodePath,
      npmExecPath,
      pnpmHome,
      env: {},
    })).toThrow("trusted Windows pnpm entrypoint unavailable");
  });

  function inspectedGit(canonicalPath, overrides = {}) {
    return {
      canonicalPath,
      isFile: true,
      mode: 0o100755,
      uid: 0,
      directoryChainTrusted: true,
      ...overrides,
    };
  }

  it("resolves a canonical Nix-store Git from an absolute profile PATH", () => {
    const inspected = [];
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/home/example/.nix-profile/bin:/run/current-system/sw/bin",
      currentUid: 1000,
      inspectExecutable(candidate) {
        inspected.push(candidate);
        if (candidate === "/home/example/.nix-profile/bin/git") {
          return inspectedGit("/nix/store/abc123-git-2.50.0/bin/git", { mode: 0o100555 });
        }
        return null;
      },
    })).toBe("/nix/store/abc123-git-2.50.0/bin/git");
    expect(inspected).toEqual(["/home/example/.nix-profile/bin/git"]);
  });

  it("accepts a current-user-owned executable and skips missing PATH candidates", () => {
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/opt/missing/bin:/home/example/bin",
      currentUid: 1000,
      inspectExecutable(candidate) {
        if (candidate === "/home/example/bin/git") {
          return inspectedGit(candidate, { mode: 0o100700, uid: 1000 });
        }
        return null;
      },
    })).toBe("/home/example/bin/git");
  });

  it("does not inspect a repository-local Git candidate from an injected PATH", () => {
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/workspace/mono-agent/node_modules/.bin:/nix/profile/bin",
      forbiddenRoot: "/workspace/mono-agent",
      currentUid: 1000,
      inspectExecutable(candidate) {
        if (candidate === "/workspace/mono-agent/node_modules/.bin/git") {
          throw new Error("repository candidate must be skipped");
        }
        return inspectedGit("/nix/store/abc123-git-2.50.0/bin/git", { mode: 0o100555 });
      },
    })).toBe("/nix/store/abc123-git-2.50.0/bin/git");
  });

  it("rejects an external PATH candidate whose canonical payload is inside the repository", () => {
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/opt/wrappers/bin:/nix/profile/bin",
      forbiddenRoot: "/workspace/mono-agent",
      currentUid: 1000,
      inspectExecutable(candidate) {
        if (candidate === "/opt/wrappers/bin/git") {
          return inspectedGit("/workspace/mono-agent/private/git", { uid: 1000 });
        }
        return inspectedGit("/nix/store/abc123-git-2.50.0/bin/git", { mode: 0o100555 });
      },
    })).toBe("/nix/store/abc123-git-2.50.0/bin/git");
  });

  it("rejects an executable equal to the forbidden root", () => {
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/candidate/bin",
      forbiddenRoot: "/workspace/git",
      currentUid: 1000,
      inspectExecutable: () => inspectedGit("/workspace/git", { uid: 1000 }),
    })).toBeNull();
  });

  it("does not confuse a sibling prefix with a forbidden-root descendant", () => {
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/candidate/bin",
      forbiddenRoot: "/workspace/mono-agent",
      currentUid: 1000,
      inspectExecutable: () => inspectedGit("/workspace/mono-agent-tools/git", { uid: 1000 }),
    })).toBe("/workspace/mono-agent-tools/git");
  });

  it("keeps strict macOS Git resolution pinned to the system directory", () => {
    const inspected = [];
    expect(resolveTrustedGitExecutable({
      platform: "darwin",
      currentUid: 501,
      inspectExecutable(candidate) {
        inspected.push(candidate);
        return inspectedGit(candidate);
      },
    })).toBe("/usr/bin/git");
    expect(inspected).toEqual(["/usr/bin/git"]);
  });

  it.each([
    undefined,
    "",
    "relative/bin:/usr/bin",
    ":/usr/bin",
    "/tmp/../usr/bin",
    "/usr/bin\n:/bin",
  ])("rejects a hostile Git PATH value: %s", (pathEnv) => {
    let inspected = false;
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv,
      currentUid: 1000,
      inspectExecutable() {
        inspected = true;
        return null;
      },
    })).toBeNull();
    expect(inspected).toBe(false);
  });

  it.each([
    ["missing", null],
    ["directory", inspectedGit("/usr/bin/git", { isFile: false })],
    ["non-executable", inspectedGit("/usr/bin/git", { mode: 0o100644 })],
    ["writable", inspectedGit("/usr/bin/git", { mode: 0o100777 })],
    ["set-id", inspectedGit("/usr/bin/git", { mode: 0o106755 })],
    ["foreign owner", inspectedGit("/usr/bin/git", { uid: 2000 })],
    ["writable ancestor", inspectedGit("/usr/bin/git", { directoryChainTrusted: false })],
    ["wrong basename", inspectedGit("/usr/bin/not-git")],
    ["traversing canonical path", inspectedGit("/nix/store/../private/git")],
  ])("fails closed for an unsafe Git inspection: %s", (_label, inspection) => {
    expect(resolveTrustedGitExecutable({
      platform: "linux",
      pathEnv: "/usr/bin",
      currentUid: 1000,
      inspectExecutable: () => inspection,
    })).toBeNull();
  });

  it("does not resolve strict Git on unsupported platforms", () => {
    expect(resolveTrustedGitExecutable({
      platform: "win32",
      pathEnv: "C:\\Program Files\\Git\\bin",
      currentUid: 1000,
      inspectExecutable: () => {
        throw new Error("must not inspect");
      },
    })).toBeNull();
  });

  it.each(["missing", "symlink"])(
    "fails closed when a required executable is %s",
    (condition) => {
      const root = tempRoot();
      createOutputs(root);
      const cli = join(root, "packages/agent-app/dist/cli.js");
      rmSync(cli);
      if (condition === "symlink") {
        symlinkSync("../../tui/dist/bin/mono-agent-tui.js", cli);
      }
      const result = runBuildWithProvenance({
        repo: root,
        runCommand: fakeGit(),
        commands: [["build", []]],
      });

      expect(result).toEqual({
        exitCode: 1,
        error: "required build entrypoints unavailable or unsafe",
      });
      expect(readBuildMarker(root)).toEqual({ status: "missing" });
    },
  );

  it("leaves non-Windows build invocations shell-free and unchanged", () => {
    expect(selectBuildInvocation("pnpm", ["run", "build:demo"], { platform: "darwin" }))
      .toEqual({ command: "pnpm", args: ["run", "build:demo"] });
  });

  function fakeGit({
    buildStatus = 0,
    afterSha = SHA,
    afterDirty = false,
    calls = [],
    onFinalRevParse,
  } = {}) {
    let revParseCalls = 0;
    let statusCalls = 0;
    return (command, args, options = {}) => {
      calls.push({ command, args, options });
      const isGit = args[0] === "-C";
      if (isGit && args.includes("check-ignore")) {
        return { status: 0, stdout: "" };
      }
      if (isGit && args.includes("rev-parse")) {
        revParseCalls += 1;
        if (revParseCalls === 3) onFinalRevParse?.();
        return { status: 0, stdout: `${revParseCalls === 1 ? SHA : afterSha}\n` };
      }
      if (isGit && args.includes("status")) {
        statusCalls += 1;
        return { status: 0, stdout: statusCalls > 1 && afterDirty ? " M source.ts\n" : "" };
      }
      if (command === "build") return { status: buildStatus, stdout: "" };
      return { status: 127, stdout: "" };
    };
  }

  it("fails before build mutation when no trusted Git executable is available", () => {
    const root = tempRoot();
    publishBuildMarker(root, marker());
    const originalBytes = readFileSync(buildMarkerPath(root), "utf8");

    const result = runBuildWithProvenance({
      repo: root,
      platform: "linux",
      resolveGitExecutable: () => null,
      runCommand() {
        throw new Error("must not execute");
      },
      commands: [["build", []]],
    });

    expect(result).toEqual({ exitCode: 1, error: "trusted Git executable unavailable" });
    expect(readFileSync(buildMarkerPath(root), "utf8")).toBe(originalBytes);
    expect(() => lstatSync(buildLockPath(root))).toThrow();
  });

  it("pins the strict lifecycle to the canonical repository if its input symlink changes", () => {
    const parent = tempRoot();
    const actualRepo = join(parent, "actual-repo");
    const replacementRepo = join(parent, "replacement-repo");
    const linkedRepo = join(parent, "linked-repo");
    mkdirSync(actualRepo);
    mkdirSync(replacementRepo);
    symlinkSync("actual-repo", linkedRepo);
    const calls = [];
    let resolverOptions;

    const result = runBuildWithProvenance({
      repo: linkedRepo,
      platform: "linux",
      resolveGitExecutable(options) {
        resolverOptions = options;
        rmSync(linkedRepo);
        symlinkSync("replacement-repo", linkedRepo);
        return "/usr/bin/git";
      },
      runCommand: fakeGit({ buildStatus: 7, calls }),
      commands: [["build", []]],
    });

    const canonicalRepo = realpathSync.native(actualRepo);
    expect(result).toEqual({ exitCode: 7, error: "workspace build failed" });
    expect(resolverOptions).toEqual({
      platform: "linux",
      forbiddenRoot: canonicalRepo,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.options.cwd === canonicalRepo)).toBe(true);
    expect(calls.filter((call) => call.args[0] === "-C")
      .every((call) => call.args[1] === canonicalRepo)).toBe(true);
  });

  it("uses one exact resolved Nix Git path under the closed environment", () => {
    const root = tempRoot();
    const calls = [];
    const gitExecutable = "/nix/store/abc123-git-2.50.0/bin/git";

    const result = runBuildWithProvenance({
      repo: root,
      platform: "linux",
      resolveGitExecutable: () => gitExecutable,
      runCommand: fakeGit({ buildStatus: 7, calls }),
      commands: [["build", []]],
    });

    expect(result).toEqual({ exitCode: 7, error: "workspace build failed" });
    const gitCalls = calls.filter((call) => call.args[0] === "-C");
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.every((call) => call.command === gitExecutable)).toBe(true);
    for (const call of gitCalls) {
      expect(call.options.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
    }
  });

  it("clears a stale marker before building and leaves marker and lock absent on failure", () => {
    const root = tempRoot();
    publishBuildMarker(root, marker());

    const result = runBuildWithProvenance({
      repo: root,
      runCommand: fakeGit({ buildStatus: 7 }),
      commands: [["build", []]],
    });

    expect(result).toEqual({ exitCode: 7, error: "workspace build failed" });
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
    expect(() => lstatSync(buildLockPath(root))).toThrow();
  });

  it("writes a digest-bound marker only after a stable successful build", () => {
    const root = tempRoot();
    createOutputs(root);
    const outputDigest = computeBuildOutputDigest(root);
    const calls = [];
    const result = runBuildWithProvenance({
      repo: root,
      runCommand: fakeGit({ calls }),
      commands: [["build", []]],
      now: () => new Date(COMPLETED_AT),
    });

    expect(result).toEqual({ exitCode: 0 });
    const dependencyDigest = computeRuntimeDependencyDigest(root);
    expect(computeBuildOutputDigest(root)).toBe(outputDigest);
    expect(lstatSync(join(root, "packages/agent-app/dist/cli.js")).mode & 0o100).toBe(0o100);
    expect(lstatSync(join(root, "packages/tui/dist/bin/mono-agent-tui.js")).mode & 0o100).toBe(0o100);
    expect(readBuildMarker(root)).toMatchObject({
      status: "ok",
      marker: marker({
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules,
        outputDigest,
        dependencyDigest,
      }),
    });
    const gitCalls = calls.filter((call) => call.args[0] === "-C");
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(new Set(gitCalls.map((call) => call.command)).size).toBe(1);
    for (const call of gitCalls) {
      expect(call.command).toMatch(/^\/.+\/git$/u);
      expect(call.options.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
      expect(Object.keys(call.options.env).some((key) => key.startsWith("GIT_"))).toBe(false);
    }
  });

  it.each([
    ["output", "packages/example/dist/index.js"],
    ["dependency", "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js"],
  ])("refuses marker publication when %s changes between deployment digests", (_kind, relativePath) => {
    const root = tempRoot();
    createOutputs(root);
    const result = runBuildWithProvenance({
      repo: root,
      runCommand: fakeGit(),
      commands: [["build", []]],
      afterDeploymentDigests() {
        writeFileSync(join(root, ...relativePath.split("/")), "changed before publication\n");
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      error: "build deployment state changed during attestation",
    });
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
  });

  it.each([
    ["output", "packages/example/dist/index.js"],
    ["dependency", "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js"],
  ])("refuses publication when final source probing races an ignored %s", (_kind, relativePath) => {
    const root = tempRoot();
    createOutputs(root);
    const result = runBuildWithProvenance({
      repo: root,
      runCommand: fakeGit({
        onFinalRevParse() {
          writeFileSync(join(root, ...relativePath.split("/")), "changed during final git probe\n");
        },
      }),
      commands: [["build", []]],
    });

    expect(result).toEqual({
      exitCode: 1,
      error: "build deployment state changed during attestation",
    });
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
  });

  it("fails closed when the checkout changes during the build", () => {
    const root = tempRoot();
    createOutputs(root);
    const result = runBuildWithProvenance({
      repo: root,
      runCommand: fakeGit({ afterDirty: true }),
      commands: [["build", []]],
    });

    expect(result).toEqual({ exitCode: 1, error: "build source changed during build" });
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
  });

  it("does not clear the prior marker when a second overlapping build cannot acquire the lock", () => {
    const root = tempRoot();
    publishBuildMarker(root, marker());
    const originalBytes = readFileSync(buildMarkerPath(root), "utf8");
    const previousUmask = process.umask(0o777);
    let held;
    try {
      held = acquireBuildLock(root);
    } finally {
      process.umask(previousUmask);
    }
    try {
      expect(lstatSync(buildLockPath(root)).mode & 0o777).toBe(0o600);
      const result = runBuildWithProvenance({
        repo: root,
        runCommand: fakeGit(),
        commands: [["build", []]],
      });
      expect(result).toEqual({ exitCode: 1, error: "build already in progress or lock is unsafe" });
      expect(readFileSync(buildMarkerPath(root), "utf8")).toBe(originalBytes);
      expect(readBuildMarker(root)).toEqual({ status: "unsafe" });
    } finally {
      releaseBuildLock(root, held);
    }
    expect(readBuildMarker(root)).toMatchObject({ status: "ok" });
  });

  it("runs commands but invalidates and never republishes provenance on unsupported platforms", () => {
    const root = tempRoot();
    publishBuildMarker(root, marker());
    const calls = [];
    const result = runBuildWithProvenance({
      repo: root,
      platform: "win32",
      commands: [["build", []]],
      runCommand(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: "" };
      },
    });

    expect(supportsStrictBuildProvenance("win32")).toBe(false);
    expect(supportsStrictBuildProvenance("darwin")).toBe(true);
    expect(result).toEqual({ exitCode: 0 });
    expect(calls.map((call) => call.command)).toEqual(["build"]);
    expect(readBuildMarker(root)).toEqual({ status: "missing" });
    expect(() => lstatSync(join(root, BUILD_LOCK_FILENAME))).toThrow();
  });
});

describe("closed marker probe", () => {
  it("emits only the validated marker plus the recomputed current digest", () => {
    const root = tempRoot();
    createOutputs(root);
    const outputDigest = computeBuildOutputDigest(root);
    const dependencyDigest = computeRuntimeDependencyDigest(root);
    const value = marker({ outputDigest, dependencyDigest });
    publishBuildMarker(root, value);
    const out = sink();
    expect(runBuildProvenanceProbe([root], out)).toBe(0);
    expect(JSON.parse(out.text)).toEqual({
      schemaVersion: 2,
      status: "ok",
      marker: value,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      outputDigest,
      dependencyDigest,
    });
  });

  it("exposes a digest mismatch without exposing output paths", () => {
    const root = tempRoot();
    createOutputs(root);
    const originalDigest = computeBuildOutputDigest(root);
    const dependencyDigest = computeRuntimeDependencyDigest(root);
    publishBuildMarker(root, marker({ outputDigest: originalDigest, dependencyDigest }));
    writeFileSync(join(root, "demos/final-agent/dist/cli.js"), "console.log('changed');\n");
    const out = sink();
    expect(runBuildProvenanceProbe([root], out)).toBe(0);
    const report = JSON.parse(out.text);
    expect(report.outputDigest).not.toBe(report.marker.outputDigest);
    expect(out.text).not.toContain(root);
    expect(out.text).not.toContain("cli.js");
  });

  it("fails closed when outputs change during the dependency attestation window", () => {
    const root = tempRoot();
    createOutputs(root);
    const outputDigest = computeBuildOutputDigest(root);
    const dependencyDigest = computeRuntimeDependencyDigest(root);
    publishBuildMarker(root, marker({ outputDigest, dependencyDigest }));
    const out = sink();
    expect(runBuildProvenanceProbe([root], out, {
      afterDependencyDigest() {
        writeFileSync(join(root, "demos/final-agent/dist/cli.js"), "console.log('raced');\n");
      },
    })).toBe(1);
    expect(JSON.parse(out.text)).toEqual({ schemaVersion: 2, status: "unsafe" });
  });

  it("fails closed when dependencies change during the output/dependency attestation window", () => {
    const root = tempRoot();
    createOutputs(root);
    const outputDigest = computeBuildOutputDigest(root);
    const dependencyDigest = computeRuntimeDependencyDigest(root);
    publishBuildMarker(root, marker({ outputDigest, dependencyDigest }));
    const out = sink();
    expect(runBuildProvenanceProbe([root], out, {
      afterDependencyDigest() {
        writeFileSync(
          join(root, "node_modules/.pnpm/example-dep@1.0.0/node_modules/example-dep/index.js"),
          "export const raced = true;\n",
        );
      },
    })).toBe(1);
    expect(JSON.parse(out.text)).toEqual({ schemaVersion: 2, status: "unsafe" });
  });

  it("fails closed while a build lock exists", () => {
    const root = tempRoot();
    createOutputs(root);
    publishBuildMarker(root, marker({
      outputDigest: computeBuildOutputDigest(root),
      dependencyDigest: computeRuntimeDependencyDigest(root),
    }));
    const lock = acquireBuildLock(root);
    try {
      const out = sink();
      expect(runBuildProvenanceProbe([root], out)).toBe(1);
      expect(JSON.parse(out.text)).toEqual({ schemaVersion: 2, status: "unsafe" });
    } finally {
      releaseBuildLock(root, lock);
    }
  });

  it("collapses hostile input to a closed unsafe status", () => {
    const out = sink();
    expect(runBuildProvenanceProbe([`relative-${BUILD_MARKER_FILENAME}`], out)).toBe(1);
    expect(JSON.parse(out.text)).toEqual({ schemaVersion: 2, status: "unsafe" });
  });
});

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
