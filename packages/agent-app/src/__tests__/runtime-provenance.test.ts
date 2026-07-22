import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultManagedBackgroundRuntimeDeps, ensureManagedBackgroundRuntime } from "../background-runtime.js";
import { agentAppPackageVersion } from "../package-version.js";
import { runtimeProvenanceDetail } from "../runtime-provenance.js";

const UNMANAGED_DETAIL = "Runtime provenance: dev (unmanaged).";
const INSTALLED_AT = "2026-07-16T12:34:56.000Z";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "agent-app-runtime-provenance-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ManagedFixture {
  readonly packageRoot: string;
  readonly installRoot: string;
  readonly markerPath: string;
  readonly marker: Record<string, unknown>;
  readonly closureId: string;
  readonly dependencyPath: string;
  readonly dependencyRelativePath: string;
}

async function managedFixture(
  name: string,
  options: { readonly additionalPackage?: boolean } = {},
): Promise<ManagedFixture> {
  const packageVersion = agentAppPackageVersion();
  if (packageVersion === undefined) throw new Error("agent-app version unavailable in test");
  const sourceRoot = join(dir, name, "source");
  const homeDir = join(dir, name, "home");
  const dependencyName = "@fixture/runtime-dependency";
  const dependencySource = join(sourceRoot, "node_modules", "@fixture", "runtime-dependency");
  await mkdir(join(sourceRoot, "dist"), { recursive: true });
  await mkdir(join(dependencySource, "dist"), { recursive: true });
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({
    name: "@mono-agent/agent-app",
    version: packageVersion,
    type: "module",
    bin: { "mono-agent": "./dist/cli.js" },
    dependencies: { [dependencyName]: "1.0.0" },
  }), "utf8");
  await writeFile(
    join(sourceRoot, "dist", "cli.js"),
    `import ${JSON.stringify(dependencyName)};\n// ${name}\n`,
    "utf8",
  );
  await writeFile(join(dependencySource, "package.json"), JSON.stringify({
    name: dependencyName,
    version: "1.0.0",
    type: "module",
    exports: "./dist/index.js",
  }), "utf8");
  await writeFile(
    join(dependencySource, "dist", "index.js"),
    `export const fixture = ${JSON.stringify(name)};\n`,
    "utf8",
  );
  const additionalPackages = options.additionalPackage === true
    ? [{ packageName: "@fixture/provenance-plugin", packageSource: join(dir, name, "plugin") }]
    : [];
  if (additionalPackages[0] !== undefined) {
    await mkdir(join(additionalPackages[0].packageSource, "dist"), { recursive: true });
    await writeFile(join(additionalPackages[0].packageSource, "package.json"), JSON.stringify({
      name: additionalPackages[0].packageName,
      version: "1.0.0",
      type: "module",
      exports: "./dist/index.js",
    }), "utf8");
    await writeFile(
      join(additionalPackages[0].packageSource, "dist", "index.js"),
      "export const plugin = true;\n",
      "utf8",
    );
  }

  let now = Date.parse(INSTALLED_AT);
  const defaults = defaultManagedBackgroundRuntimeDeps();
  const runtime = await ensureManagedBackgroundRuntime({
    currentCliPath: join(sourceRoot, "dist", "cli.js"),
    nodePath: process.execPath,
    homeDir,
    packageVersion,
    packageSource: sourceRoot,
    additionalPackages,
  }, {
    ...defaults,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    randomId: () => name,
    currentProcessIncarnation: async () => ({
      schema: "mono-agent.process-incarnation.v1",
      bootSessionId: "runtime-provenance-test",
      processStartId: name,
    }),
    isSameProcessIncarnation: () => true,
  });
  const installRoot = runtime.installRoot;
  const packageRoot = dirname(dirname(runtime.cliPath));
  const markerPath = join(installRoot, ".mono-agent-runtime.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  const packageLock = JSON.parse(await readFile(join(installRoot, "package-lock.json"), "utf8")) as {
    packages: Record<string, { name?: string }>;
  };
  const dependencyRootRelative = Object.entries(packageLock.packages)
    .find(([, entry]) => entry.name === dependencyName)?.[0];
  if (dependencyRootRelative === undefined) throw new Error("managed dependency missing from fixture lockfile");
  const dependencyRelativePath = `${dependencyRootRelative}/dist/index.js`;
  return {
    packageRoot,
    installRoot,
    markerPath,
    marker,
    closureId: basename(installRoot),
    dependencyPath: join(installRoot, ...dependencyRelativePath.split("/")),
    dependencyRelativePath,
  };
}

async function writeMarker(path: string, marker: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function rewriteClosureManifestForDependency(
  fixture: ManagedFixture,
  contents: string,
): Promise<void> {
  await writeFile(fixture.dependencyPath, contents, "utf8");
  const manifestPath = join(fixture.installRoot, ".mono-agent-closure.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    entries: Array<{ path: string; type: string; sha256?: string }>;
  };
  const entry = manifest.entries.find((candidate) =>
    candidate.type === "file"
    && candidate.path === fixture.dependencyRelativePath);
  if (entry === undefined) throw new Error("dependency fixture missing from managed closure manifest");
  entry.sha256 = sha256(Buffer.from(contents, "utf8"));
  const manifestContents = `${JSON.stringify(manifest, undefined, 2)}\n`;
  await writeFile(manifestPath, manifestContents, { encoding: "utf8", mode: 0o600 });
  const marker = {
    ...fixture.marker,
    closureManifestSha256: sha256(Buffer.from(manifestContents, "utf8")),
  };
  await writeMarker(fixture.markerPath, marker);
}

describe("runtimeProvenanceDetail", () => {
  it("names the full closure and sanitized install metadata for a valid managed snapshot", async () => {
    const fixture = await managedFixture("managed");

    const detail = await runtimeProvenanceDetail(fixture.packageRoot);

    expect(detail).toBe(
      `Runtime provenance: managed closure ${fixture.closureId} (`
      + `@mono-agent/agent-app ${agentAppPackageVersion()}; ${process.platform}-${process.arch}; `
      + `Node ABI ${process.versions.modules}; installed ${INSTALLED_AT}).`,
    );
    expect(detail).not.toContain(dir);
    expect(detail).not.toContain(fixture.installRoot);
  });

  it("verifies configured plugin roots when reconstructing a valid managed closure", async () => {
    const fixture = await managedFixture("managed-plugin", { additionalPackage: true });

    const detail = await runtimeProvenanceDetail(fixture.packageRoot);

    expect(detail).toContain(`Runtime provenance: managed closure ${fixture.closureId}`);
  });

  it("reports dev (unmanaged) outside the canonical managed layout", async () => {
    const packageRoot = join(dir, "workspace", "packages", "agent-app");
    await mkdir(packageRoot, { recursive: true });

    await expect(runtimeProvenanceDetail(packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("does not claim a managed closure after a non-CLI closure file changes", async () => {
    const fixture = await managedFixture("tampered-closure");
    await writeFile(fixture.dependencyPath, "export const fixture = 'tampered';\n", "utf8");

    await expect(runtimeProvenanceDetail(fixture.packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("rejects dependency tampering even when the manifest and marker are coherently rewritten", async () => {
    const fixture = await managedFixture("forged-manifest");
    await rewriteClosureManifestForDependency(fixture, "export const fixture = 'forged-manifest';\n");

    await expect(runtimeProvenanceDetail(fixture.packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("rejects a closure file hardlinked outside the private runtime", async () => {
    const fixture = await managedFixture("external-hardlink");
    const externalAlias = join(dir, "external-runtime-alias.js");
    await link(fixture.dependencyPath, externalAlias);

    await expect(runtimeProvenanceDetail(fixture.packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("rejects a relocated snapshot with fabricated source-closure and filesystem proofs", async () => {
    const fixture = await managedFixture("fabricated-proof");
    const fabricatedSourceClosure = "d".repeat(64);
    const fabricatedExecutionProof = "e".repeat(64);
    const cliSha256 = fixture.marker.cliSha256;
    if (typeof cliSha256 !== "string") throw new Error("fixture marker is missing cliSha256");
    const relocatedRoot = join(dirname(fixture.installRoot), `${cliSha256}-${fabricatedSourceClosure}`);
    await rename(fixture.installRoot, relocatedRoot);
    await writeMarker(join(relocatedRoot, ".mono-agent-runtime.json"), {
      ...fixture.marker,
      sourceClosureSha256: fabricatedSourceClosure,
      executionProofSha256: fabricatedExecutionProof,
    });
    const relocatedPackageRoot = join(relocatedRoot, "node_modules", "@mono-agent", "agent-app");

    await expect(runtimeProvenanceDetail(relocatedPackageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("rejects a marker with a fabricated execution proof for an otherwise valid closure", async () => {
    const fixture = await managedFixture("fabricated-execution-proof");
    await writeMarker(fixture.markerPath, {
      ...fixture.marker,
      executionProofSha256: "e".repeat(64),
    });

    await expect(runtimeProvenanceDetail(fixture.packageRoot)).resolves.toBe(UNMANAGED_DETAIL);
  });

  it("rejects an overwrite of an already-captured file during provenance verification", async () => {
    const fixture = await managedFixture("concurrent-overwrite");
    let mutated = false;

    const detail = await runtimeProvenanceDetail(fixture.packageRoot, {
      afterFinalRootCapture: async () => {
        mutated = true;
        await writeFile(fixture.dependencyPath, "export const fixture = 'concurrent-overwrite';\n", "utf8");
      },
    });

    expect(mutated).toBe(true);
    expect(detail).toBe(UNMANAGED_DETAIL);
  });

  it("rejects a non-package closure mutation after the final execution capture", async () => {
    const fixture = await managedFixture("package-lock-overwrite");
    let mutated = false;

    const detail = await runtimeProvenanceDetail(fixture.packageRoot, {
      beforeFinalManifestProof: async () => {
        mutated = true;
        await writeFile(join(fixture.installRoot, "package-lock.json"), "{}\n", "utf8");
      },
    });

    expect(mutated).toBe(true);
    expect(detail).toBe(UNMANAGED_DETAIL);
  });

  it("displays metadata only from the exact marker whose full verification succeeded", async () => {
    const fixture = await managedFixture("marker-swap");
    const replacementInstalledAt = "2026-07-16T12:35:57.000Z";

    const detail = await runtimeProvenanceDetail(fixture.packageRoot, {
      afterInitialClosureCapture: async () => {
        await writeMarker(fixture.markerPath, {
          ...fixture.marker,
          installedAt: replacementInstalledAt,
        });
      },
    });

    expect(detail).toBe(UNMANAGED_DETAIL);
    expect(detail).not.toContain(replacementInstalledAt);
  });

  it("rejects a marker replaced during the final full-manifest proof", async () => {
    const fixture = await managedFixture("marker-final-swap");
    const replacementInstalledAt = "2026-07-16T12:35:58.000Z";

    const detail = await runtimeProvenanceDetail(fixture.packageRoot, {
      beforeFinalManifestProof: async () => {
        await writeMarker(fixture.markerPath, {
          ...fixture.marker,
          installedAt: replacementInstalledAt,
        });
      },
    });

    expect(detail).toBe(UNMANAGED_DETAIL);
    expect(detail).not.toContain(replacementInstalledAt);
  });

  it("fails closed without echoing malformed or untrusted marker contents", async () => {
    const malformed = await managedFixture("malformed-json");
    await writeFile(malformed.markerPath, "{\"operatorSecret\":", { mode: 0o600 });

    const wrongSchema = await managedFixture("wrong-schema");
    await writeMarker(wrongSchema.markerPath, { ...wrongSchema.marker, schema: "attacker-schema" });

    const missingCliHash = await managedFixture("missing-cli-hash");
    const { cliSha256: _removedCliHash, ...withoutCliHash } = missingCliHash.marker;
    await writeMarker(missingCliHash.markerPath, withoutCliHash);

    const missingClosureHash = await managedFixture("missing-closure-hash");
    const { sourceClosureSha256: _removedClosureHash, ...withoutClosureHash } = missingClosureHash.marker;
    await writeMarker(missingClosureHash.markerPath, withoutClosureHash);

    const mismatchedLayout = await managedFixture("mismatched-layout");
    await writeMarker(mismatchedLayout.markerPath, {
      ...mismatchedLayout.marker,
      sourceClosureSha256: "d".repeat(64),
    });

    const invalidClosureManifest = await managedFixture("invalid-closure-manifest");
    const invalidManifest = Buffer.from(JSON.stringify({ schema: "attacker-manifest", entries: [] }), "utf8");
    await writeFile(join(invalidClosureManifest.installRoot, ".mono-agent-closure.json"), invalidManifest, { mode: 0o600 });
    await writeMarker(invalidClosureManifest.markerPath, {
      ...invalidClosureManifest.marker,
      closureManifestSha256: sha256(invalidManifest),
    });

    const extraKey = await managedFixture("extra-key");
    await writeMarker(extraKey.markerPath, {
      ...extraKey.marker,
      operatorSecret: "DO-NOT-ECHO-this-marker-content",
    });

    const permissiveMarker = await managedFixture("permissive-marker");
    await chmod(permissiveMarker.markerPath, 0o644);

    const symlinkMarker = await managedFixture("symlink-marker");
    const symlinkTarget = join(dir, "untrusted-marker-target.json");
    await writeFile(symlinkTarget, "DO-NOT-ECHO-symlink-target", { mode: 0o600 });
    await unlink(symlinkMarker.markerPath);
    await symlink(symlinkTarget, symlinkMarker.markerPath);

    const permissiveRoot = await managedFixture("permissive-root");
    await chmod(permissiveRoot.installRoot, 0o755);

    for (const [name, fixture] of Object.entries({
      malformed,
      wrongSchema,
      missingCliHash,
      missingClosureHash,
      mismatchedLayout,
      invalidClosureManifest,
      extraKey,
      permissiveMarker,
      symlinkMarker,
      permissiveRoot,
    })) {
      const detail = await runtimeProvenanceDetail(fixture.packageRoot);
      expect(detail, name).toBe(UNMANAGED_DETAIL);
      expect(detail, name).not.toContain("DO-NOT-ECHO");
      expect(detail, name).not.toContain(dir);
    }
  }, 15_000);
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
