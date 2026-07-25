// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  CSS_MIT_HEADER,
  JAVASCRIPT_MIT_HEADER,
  checkSpdxHeaders,
  renderSpdxHeaderReport,
} from "../check-spdx-headers.mjs";

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("check-spdx-headers", () => {
  it("checks tracked and nonignored untracked source files without executing them", async () => {
    const repo = await fixtureRepo();
    await writeAt(repo, "src/a.ts", javascriptSource());
    await writeAt(repo, "src/b.tsx", javascriptSource());
    await writeAt(repo, "scripts/c.mjs", `#!/usr/bin/env node\n${javascriptSource()}`);
    await writeAt(repo, "public/d.js", javascriptSource());
    await writeAt(repo, "styles/e.css", `${CSS_MIT_HEADER}\nbody {}\n`);
    await writeAt(
      repo,
      "src/accessor.js",
      [
        JAVASCRIPT_MIT_HEADER,
        "const trap = {",
        "  get explosive() { throw new Error(\"source code must not run\"); },",
        "};",
        "trap.explosive;",
        "",
      ].join("\n"),
    );
    await writeAt(repo, "untracked/deep/f.ts", javascriptSource());
    await writeAt(repo, "ignored.js", "invalid but ignored\n");
    await writeAt(repo, "notes.md", "not in source scope\n");
    await writeAt(repo, ".gitignore", "ignored.js\n");
    await git(repo, "add", ".gitignore", "notes.md", "public/d.js", "scripts/c.mjs");
    await git(repo, "add", "src", "styles/e.css");

    const result = await checkSpdxHeaders({ repoRoot: repo });

    expect(result).toEqual({
      exitCode: 0,
      checkedCount: 7,
      issues: [],
    });
    expect(renderSpdxHeaderReport(result)).toBe(
      "SPDX header check passed (7 source files).\n",
    );
  });

  it("keeps ignored tracked sources in scope while excluding ignored untracked sources", async () => {
    const repo = await fixtureRepo();
    await writeAt(repo, "tracked.ignored.js", "missing\n");
    await git(repo, "add", "tracked.ignored.js");
    await writeAt(repo, ".gitignore", "*.ignored.js\n");
    await writeAt(repo, "untracked.ignored.js", "missing\n");
    await git(repo, "add", ".gitignore");

    const result = await checkSpdxHeaders({ repoRoot: repo });

    expect(result.checkedCount).toBe(1);
    expect(result.issues).toEqual([
      "tracked.ignored.js: missing SPDX-License-Identifier: MIT directive",
    ]);
  });

  it("rejects wrong, missing, misplaced, and duplicate directives in bytewise path order", async () => {
    const repo = await fixtureRepo();
    await writeAt(
      repo,
      "A-wrong.ts",
      `${JAVASCRIPT_MIT_HEADER.replace("MIT", "Apache-2.0")}\n`,
    );
    await writeAt(repo, "B-wrong-syntax.js", `${CSS_MIT_HEADER}\n`);
    await writeAt(
      repo,
      "b-misplaced.mjs",
      `#!/usr/bin/env node\n\n${JAVASCRIPT_MIT_HEADER}\n`,
    );
    await writeAt(repo, "z-missing.js", "export {};\n");
    await writeAt(
      repo,
      "ä-duplicate.css",
      `${CSS_MIT_HEADER}\n${CSS_MIT_HEADER}\n`,
    );

    const result = await checkSpdxHeaders({ repoRoot: repo });

    expect(result.exitCode).toBe(1);
    expect(result.checkedCount).toBe(5);
    expect(result.issues).toEqual([
      `A-wrong.ts:1 license directive must be exactly ${JSON.stringify(JAVASCRIPT_MIT_HEADER)}`,
      `B-wrong-syntax.js:1 license directive must be exactly ${JSON.stringify(JAVASCRIPT_MIT_HEADER)}`,
      "b-misplaced.mjs:3 license directive is misplaced; expected line 2",
      "z-missing.js: missing SPDX-License-Identifier: MIT directive",
      "ä-duplicate.css: has duplicate license directives at lines 1, 2; exactly one is required",
    ]);
    expect(renderSpdxHeaderReport(result)).toContain(
      "SPDX header check failed (5 issue(s) across 5 source files)",
    );
  });

  it("rejects symlinks and Git-linked directories without following them", async () => {
    const repo = await fixtureRepo();
    await writeAt(repo, "target.txt", javascriptSource());
    await symlink("target.txt", join(repo, "link.js"));
    await git(repo, "add", "link.js");

    const nested = join(repo, "module.ts");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await writeAt(nested, "README.md", "nested repository\n");
    await git(nested, "add", "README.md");
    await git(
      nested,
      "-c",
      "user.name=SPDX Test",
      "-c",
      "user.email=spdx-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    await git(repo, "add", "module.ts");

    const result = await checkSpdxHeaders({ repoRoot: repo });

    expect(result.issues).toEqual([
      "link.js: must be a regular file; symlinks and other file types are not accepted",
      "module.ts: must be a regular file; symlinks and other file types are not accepted",
    ]);
  });

  it("fails closed when Git cannot enumerate the repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mono-agent-spdx-not-git-"));
    tempDirs.push(directory);

    const result = await checkSpdxHeaders({ repoRoot: directory });

    expect(result.exitCode).toBe(1);
    expect(result.checkedCount).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("could not enumerate source files from Git");
  });
});

function javascriptSource() {
  return `${JAVASCRIPT_MIT_HEADER}\nexport {};\n`;
}

async function fixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), "mono-agent-spdx-check-"));
  tempDirs.push(repo);
  await git(repo, "init", "--quiet");
  return repo;
}

async function writeAt(root, path, contents) {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function git(cwd, ...args) {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}
