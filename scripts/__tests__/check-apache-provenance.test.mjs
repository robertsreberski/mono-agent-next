import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  APACHE_PROVENANCE_PATH,
  AUDITED_PREDECESSOR_COMMIT,
  checkApacheProvenance,
  renderApacheProvenanceReport,
} from "../check-apache-provenance.mjs";

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("check-apache-provenance", () => {
  it("accepts exact equality between the repository's tracked Apache files and reviewed entries", async () => {
    const result = await checkApacheProvenance();

    expect(result).toMatchObject({
      exitCode: 0,
      issues: [],
      trackedFileCount: 35,
      manifestFileCount: 35,
    });
    expect(renderApacheProvenanceReport(result)).toContain(
      "35 tracked files have exact hashes and reviewed authority",
    );
  });

  it("fails closed when the tracked set grows by exactly one file", async () => {
    const fixture = await fixtureRepo();
    const addedPath = "packages/operator/src/plus-one.ts";
    await writeFileAt(join(fixture.repoRoot, addedPath), "export const plusOne = 1;\n");
    await git(fixture.repoRoot, "add", "--", addedPath);

    const result = await checkApacheProvenance({ repoRoot: fixture.repoRoot });

    expect(result.trackedFileCount).toBe(fixture.manifest.files.length + 1);
    expect(result.issues).toContain(`tracked Apache package file is missing provenance: ${addedPath}`);
  });

  it("rejects stale hashes, stale entries, and uncovered untracked files", async () => {
    const fixture = await fixtureRepo();
    const changedPath = "packages/module-sdk/src/alpha.ts";
    const removedPath = "packages/operator/src/beta.ts";
    const untrackedPath = "packages/operator/src/untracked.ts";
    await writeFile(join(fixture.repoRoot, changedPath), "export const alpha = 2;\n");
    await git(fixture.repoRoot, "rm", "--", removedPath);
    await writeFileAt(join(fixture.repoRoot, untrackedPath), "export const untracked = true;\n");

    const result = await checkApacheProvenance({ repoRoot: fixture.repoRoot });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toContain(`untracked file in Apache package scope is not covered: ${untrackedPath}`);
    expect(result.issues).toContain(
      `provenance entry does not name a tracked Apache package file: ${removedPath}`,
    );
    expect(result.issues.some((issue) => issue.startsWith(`${changedPath} has stale provenance hash:`))).toBe(true);
  });

  it("does not allow the materially adapted operator client to be downgraded to original work", async () => {
    const fixture = await fixtureRepo();
    const client = fixture.manifest.files.find(
      (entry) => entry.path === "packages/operator/src/client.ts",
    );
    client.origin = {
      classification: "successor-original",
      repository: "mono-agent-next",
      commit: fixture.sourceCommit,
      path: client.path,
    };
    client.authorityBasis = "robert-sreberski-original-apache-2.0";
    await writeManifest(fixture.repoRoot, fixture.manifest);

    const result = await checkApacheProvenance({ repoRoot: fixture.repoRoot });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toContain(
      "packages/operator/src/client.ts must retain predecessor-authorized-adaptation provenance",
    );
    expect(result.issues).toContain(
      "packages/operator/src/client.ts must use the sole-holder relicensing authority",
    );
  });

  it("requires complete reviewed authority fields instead of accepting descriptive prose", async () => {
    const fixture = await fixtureRepo();
    fixture.manifest.files[0].copyrightHolder = "";
    fixture.manifest.authorityDeclarations[1].basis = "trust me";
    await writeManifest(fixture.repoRoot, fixture.manifest);

    const result = await checkApacheProvenance({ repoRoot: fixture.repoRoot });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toContain(
      "robert-sreberski-original-apache-2.0 basis does not match the reviewed authority declaration",
    );
    expect(result.issues.some((issue) => issue.includes(".copyrightHolder does not match"))).toBe(true);
  });
});

async function fixtureRepo() {
  const repoRoot = await mkdtemp(join(tmpdir(), "mono-agent-apache-provenance-"));
  tempDirs.push(repoRoot);
  const contents = new Map([
    ["packages/module-sdk/src/alpha.ts", "export const alpha = 1;\n"],
    ["packages/operator/src/beta.ts", "export const beta = 1;\n"],
    ["packages/operator/src/client.ts", "export class FixtureOperatorClient {}\n"],
  ]);
  for (const [path, value] of contents) {
    await writeFileAt(join(repoRoot, path), value);
  }
  await git(repoRoot, "init", "--quiet");
  await git(repoRoot, "add", "--", ...contents.keys());
  await git(
    repoRoot,
    "-c",
    "user.name=Provenance Test",
    "-c",
    "user.email=provenance@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture source",
  );
  const sourceCommit = (await git(repoRoot, "rev-parse", "HEAD")).trim();
  const manifest = {
    schemaVersion: 1,
    license: "Apache-2.0",
    hashAlgorithm: "sha256",
    scopes: ["packages/module-sdk", "packages/operator"],
    authorityDeclarations: authorityDeclarations(),
    files: [...contents.entries()].map(([path, value]) => (
      path === "packages/operator/src/client.ts"
        ? predecessorClientEntry(path, value)
        : originalEntry(path, value, sourceCommit)
    )),
  };
  await writeManifest(repoRoot, manifest);
  return { repoRoot, sourceCommit, manifest };
}

function authorityDeclarations() {
  return [
    {
      id: "canonical-apache-2.0-license-text",
      copyrightHolder: "The Apache Software Foundation",
      basis: "Verbatim canonical Apache License 2.0 text published for inclusion with Apache-licensed works.",
    },
    {
      id: "robert-sreberski-original-apache-2.0",
      copyrightHolder: "Robert Sreberski",
      basis: "Original successor work authored for these extension surfaces and expressly offered under Apache-2.0.",
    },
    {
      id: "robert-sreberski-sole-holder-relicense-apache-2.0",
      copyrightHolder: "Robert Sreberski",
      basis: "Sole-holder authorization to adapt the identified predecessor material and distribute the successor file under Apache-2.0, recorded in APACHE_PACKAGE_PROVENANCE.md.",
    },
  ];
}

function originalEntry(path, contents, sourceCommit) {
  return {
    path,
    sha256: sha256(contents),
    origin: {
      classification: "successor-original",
      repository: "mono-agent-next",
      commit: sourceCommit,
      path,
    },
    copyrightHolder: "Robert Sreberski",
    authorityBasis: "robert-sreberski-original-apache-2.0",
  };
}

function predecessorClientEntry(path, contents) {
  return {
    path,
    sha256: sha256(contents),
    origin: {
      classification: "predecessor-authorized-adaptation",
      repository: "mono-agent-predecessor",
      commit: AUDITED_PREDECESSOR_COMMIT,
      path: "packages/web/src/operator-client.ts",
      sha256: "d292e281c5cbd91fcb28bda03856b09535a5ae72c6203601d327975a51573364",
      materialCommits: [
        "92ddcdaa915d8586bff96636169717bf91a7d1dc",
        "8450daa4fc56c7cadacf2fa0842ecbaae7fd3069",
        "7c89e063491de78959bf9baf0e7f974cc7801141",
        "b87f154b42b8a975c1d7966f851b7f29e2cd6962",
      ],
    },
    copyrightHolder: "Robert Sreberski",
    authorityBasis: "robert-sreberski-sole-holder-relicense-apache-2.0",
  };
}

async function writeManifest(repoRoot, manifest) {
  await writeFileAt(
    join(repoRoot, APACHE_PROVENANCE_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeFileAt(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function git(repoRoot, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
