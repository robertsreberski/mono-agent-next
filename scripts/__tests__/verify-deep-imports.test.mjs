// SPDX-License-Identifier: MIT
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  importSafetyNodeArguments,
  mappedEntries,
  runVerifyDeepImports,
} from "../verify-deep-imports.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL_BUILT_EXPORT_TIMEOUT_MS = 30_000;
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("verify-deep-imports", () => {
  it("maps every export in the exact 23-package publishable roster", () => {
    const entries = mappedEntries(repoRoot);
    const packageNames = [...new Set(entries.map((entry) => entry.packageName))];
    const specifiers = entries.map((entry) => entry.specifier);

    expect(packageNames).toHaveLength(23);
    expect(packageNames).toContain("@mono-agent/core");
    expect(packageNames).toContain("@mono-agent/docs-mcp");
    expect(packageNames).toContain("create-mono-agent");
    expect(packageNames).not.toContain("@mono-agent/agent-app");
    expect(packageNames).not.toContain("@mono-agent/agent-runtime");
    expect(specifiers).toContain("@mono-agent/module-sdk/http");
    expect(specifiers).toContain("@mono-agent/operator/testing");
    expect(specifiers).toContain("@mono-agent/cli/package.json");
    expect(specifiers).toContain("create-mono-agent/package.json");
    expect(entries.some((entry) => entry.specifier.includes("*"))).toBe(false);

    const roots = entries.filter((entry) => entry.key === ".");
    expect(roots).toHaveLength(23);
    expect(roots.every((entry) => entry.defaultTarget.endsWith("/dist/index.js"))).toBe(true);
    expect(roots.every((entry) => entry.typesTarget?.endsWith("/dist/index.d.ts"))).toBe(true);
  });

  it("rejects wildcard exports instead of silently skipping them", () => {
    expect(() => mappedEntries("/repo", {
      catalog: fixtureCatalog(),
      readFile: () => JSON.stringify({
        name: "@mono-agent/fixture",
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./*": { import: "./dist/*.js", types: "./dist/*.d.ts" },
        },
      }),
    })).toThrow(/must not use wildcard mappings/u);
  });

  it("verifies all mapped default imports and declared type targets through injectable boundaries", async () => {
    const imports = [];
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot,
      importFn: async (specifier, entry) => {
        imports.push({ specifier, json: entry.json });
        return {};
      },
      fileExists: () => true,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(0);
    expect(imports).toHaveLength(mappedEntries(repoRoot).length);
    expect(imports).toContainEqual({
      specifier: "@mono-agent/cli/package.json",
      json: true,
    });
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(stdout.text).toContain("built-exports ok (23 packages");
    expect(stdout.text).toContain("(default)");
    expect(stdout.text).toContain("(types)");
  });

  it("fails when a declared types target is missing", async () => {
    const stdout = sink();
    const missing = resolve(repoRoot, "packages/module-sdk/dist/http.d.ts");
    const result = await runVerifyDeepImports({
      repoRoot,
      importFn: async () => ({}),
      fileExists: (path) => path !== missing,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain(
      "FAIL @mono-agent/module-sdk/http (types): declared types target missing on disk",
    );
    expect(result.results.find(
      (entry) => entry.specifier === "@mono-agent/module-sdk/http",
    )?.ok).toBe(false);
  });

  it("reports the exact default export that fails to load", async () => {
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot,
      importFn: async (specifier) => {
        if (specifier === "@mono-agent/operator/testing") throw new Error("boom");
        return {};
      },
      fileExists: () => true,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL @mono-agent/operator/testing (default): boom");
    expect(result.results.find(
      (entry) => entry.specifier === "@mono-agent/operator/testing",
    )?.ok).toBe(false);
  });

  it("actually executes each package entrypoint in the import-safety subprocess", async () => {
    const fixture = await importFixture('throw new Error("fixture import executed");\n');
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot: fixture.root,
      catalog: fixture.catalog,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("import failed: fixture import executed");
  });

  it("runs the import probe with package-scoped read-only Node permissions", () => {
    const entry = mappedEntries(repoRoot)[0];
    const args = importSafetyNodeArguments("/repo/scripts/import-safety-harness.mjs", entry);
    const workspaceRoot = dirname(dirname(entry.packageDirectory));

    expect(args[0]).toBe("--permission");
    expect(args.filter((argument) => argument.startsWith("--allow-"))).toEqual([
      "--allow-fs-read=/repo/scripts/import-safety-harness.mjs",
      "--allow-fs-read=/repo/package.json",
      `--allow-fs-read=${resolve(workspaceRoot, "package.json")}`,
      `--allow-fs-read=${resolve(workspaceRoot, "packages")}`,
      `--allow-fs-read=${resolve(workspaceRoot, "extras")}`,
      `--allow-fs-read=${resolve(workspaceRoot, "node_modules")}`,
    ]);
    expect(args.some((argument) => argument.includes("*"))).toBe(false);
    expect(args).not.toContain("--allow-child-process");
    expect(args).not.toContain("--allow-worker");
    expect(args).not.toContain("--allow-wasi");
  });

  it("enforces the read-only permission state inside the actual probe", async () => {
    const fixture = await importFixture([
      'if (process.permission?.has("fs.read", "/etc/hosts") !== false) throw new Error("host fs.read unexpectedly allowed");',
      'for (const scope of ["fs.write", "child", "worker", "wasi"]) {',
      '  if (process.permission?.has(scope) !== false) throw new Error(`${scope} unexpectedly allowed`);',
      "}",
      "",
    ].join("\n"));
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot: fixture.root,
      catalog: fixture.catalog,
      stdout,
      stderr: sink(),
    });

    if (result.exitCode !== 0) {
      throw new Error(`scoped permission fixture failed:\n${stdout.text}`);
    }
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("built-exports ok (1 packages, 1 exports");
  });

  it.each([
    {
      label: "environment reads",
      source: "try { void process.env.MONO_AGENT_IMPORT_SECRET; } catch {}\nexport const safe = false;\n",
      expected: "import-time environment read is forbidden",
    },
    {
      label: "delayed environment reads",
      source: "try { setTimeout(() => void process.env.MONO_AGENT_IMPORT_SECRET, 0).unref(); } catch {}\nexport const safe = false;\n",
      expected: "import-time async scheduling is forbidden",
    },
    {
      label: "data URL environment reads",
      source: 'await import("data:text/javascript,try%20%7B%20void%20process.env.MONO_AGENT_IMPORT_SECRET%3B%20%7D%20catch%20%7B%7D");\nexport const safe = false;\n',
      expected: "import-time environment read is forbidden",
    },
    {
      label: "MessageChannel callbacks",
      source: 'import { MessageChannel } from "node:worker_threads";\ntry { const { port1, port2 } = new MessageChannel(); port1.on("message", () => { try { void process.env.MONO_AGENT_IMPORT_SECRET; } catch {} }); port2.postMessage(1); } catch {}\nexport const safe = false;\n',
      expected: "import-time async scheduling is forbidden",
    },
    {
      label: "filesystem reads",
      source: 'import { readFileSync } from "node:fs";\ntry { readFileSync("/etc/hosts", "utf8"); } catch {}\nexport const safe = false;\n',
      expected: "import-time filesystem read is forbidden",
    },
    {
      label: "network access",
      source: 'import { connect } from "node:net";\ntry { connect(9, "127.0.0.1"); } catch {}\nexport const safe = false;\n',
      expected: "import-time network access is forbidden",
    },
    {
      label: "process spawning",
      source: 'import { spawnSync } from "node:child_process";\ntry { spawnSync("false"); } catch {}\nexport const safe = false;\n',
      expected: "import-time process spawn is forbidden",
    },
  ])("rejects swallowed import-time $label", async ({ source, expected }) => {
    const fixture = await importFixture(source);
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot: fixture.root,
      catalog: fixture.catalog,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain(expected);
  });

  it("attributes environment reads made by imported CommonJS dependencies", async () => {
    const fixture = await importFixture('import "./dependency.cjs";\n');
    await writeFile(
      join(fixture.packageDirectory, "dist/dependency.cjs"),
      "try { void process.env.MONO_AGENT_IMPORT_SECRET; } catch {}\n",
    );
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot: fixture.root,
      catalog: fixture.catalog,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("import-time environment read is forbidden");
  });

  it("blocks import-time filesystem writes before bytes reach disk", async () => {
    const fixture = await importFixture("");
    const marker = join(fixture.root, "must-not-exist");
    await writeFile(
      join(fixture.packageDirectory, "dist/index.js"),
      `import { writeFile } from "node:fs/promises";\ntry { await writeFile(${JSON.stringify(marker)}, "bad"); } catch {}\n`,
    );
    const stdout = sink();
    const result = await runVerifyDeepImports({
      repoRoot: fixture.root,
      catalog: fixture.catalog,
      stdout,
      stderr: sink(),
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("import-time filesystem write is forbidden");
    await expect(access(marker)).rejects.toThrow();
  });

  it("blocks ChildProcess.prototype.spawn before a child can create a marker", async () => {
    const fixture = await importFixture("");
    const marker = join(fixture.root, "child-process-marker");
    const childSource = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`;
    await writeFile(
      join(fixture.packageDirectory, "dist/index.js"),
      [
        'import { ChildProcess } from "node:child_process";',
        "try {",
        "  const child = new ChildProcess();",
        "  child.spawn({",
        `    file: process.execPath, args: [process.execPath, "-e", ${JSON.stringify(childSource)}],`,
        '    cwd: undefined, detached: false, envPairs: [], stdio: [{ type: "ignore" }, { type: "ignore" }, { type: "ignore" }],',
        "  });",
        "} catch {}",
        "",
      ].join("\n"),
    );

    const stdout = await verifyFixtureRejected(fixture);
    expect(stdout.text).toContain("import-time process spawn is forbidden");
    await expect(access(marker)).rejects.toThrow();
  });

  it.each([
    {
      label: "callback top-level resolver",
      source: 'import { resolveTlsa } from "node:dns";\ntry { resolveTlsa("localhost", () => {}); } catch {}\n',
    },
    {
      label: "callback Resolver variant",
      source: 'import { Resolver } from "node:dns";\ntry { new Resolver().resolveCaa("localhost", () => {}); } catch {}\n',
    },
    {
      label: "promise top-level resolver",
      source: 'import { resolveNaptr } from "node:dns/promises";\ntry { await resolveNaptr("localhost"); } catch {}\n',
    },
    {
      label: "promise Resolver variant",
      source: 'import { Resolver } from "node:dns/promises";\ntry { await new Resolver().resolveTlsa("localhost"); } catch {}\n',
    },
  ])("blocks every class of $label", async ({ source }) => {
    const fixture = await importFixture(source);
    const stdout = await verifyFixtureRejected(fixture);

    expect(stdout.text).toContain("import-time network access is forbidden");
  });

  it("blocks worker creation before worker code can create a marker", async () => {
    const fixture = await importFixture("");
    const marker = join(fixture.root, "worker-marker");
    const workerSource = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`;
    await writeFile(
      join(fixture.packageDirectory, "dist/index.js"),
      `import { Worker } from "node:worker_threads";\ntry { new Worker(${JSON.stringify(workerSource)}, { eval: true }); } catch {}\n`,
    );

    const stdout = await verifyFixtureRejected(fixture);
    expect(stdout.text).toContain("import-time worker creation is forbidden");
    await expect(access(marker)).rejects.toThrow();
  });

  it("blocks SQLite database creation before a database reaches disk", async () => {
    const fixture = await importFixture("");
    const database = join(fixture.root, "import-side-effect.sqlite");
    await writeFile(
      join(fixture.packageDirectory, "dist/index.js"),
      `import { DatabaseSync } from "node:sqlite";\ntry { new DatabaseSync(${JSON.stringify(database)}); } catch {}\n`,
    );

    const stdout = await verifyFixtureRejected(fixture);
    expect(stdout.text).toContain("import-time SQLite database creation is forbidden");
    await expect(access(database)).rejects.toThrow();
  });

  it.skipIf(Number(process.versions.node.split(".")[0]) < 24)(
    "blocks mkdtempDisposableSync before a directory reaches disk",
    async () => {
      const fixture = await importFixture("");
      const prefix = join(fixture.root, "sync-disposable-");
      await writeFile(
        join(fixture.packageDirectory, "dist/index.js"),
        `import { mkdtempDisposableSync } from "node:fs";\ntry { mkdtempDisposableSync(${JSON.stringify(prefix)}); } catch {}\n`,
      );

      const stdout = await verifyFixtureRejected(fixture);
      expect(stdout.text).toContain("import-time filesystem write is forbidden");
      expect((await readdir(fixture.root)).some((name) => name.startsWith("sync-disposable-")))
        .toBe(false);
    },
  );

  it.skipIf(Number(process.versions.node.split(".")[0]) < 24)(
    "blocks promises.mkdtempDisposable before a directory reaches disk",
    async () => {
      const fixture = await importFixture("");
      const prefix = join(fixture.root, "async-disposable-");
      await writeFile(
        join(fixture.packageDirectory, "dist/index.js"),
        `import { mkdtempDisposable } from "node:fs/promises";\ntry { await mkdtempDisposable(${JSON.stringify(prefix)}); } catch {}\n`,
      );

      const stdout = await verifyFixtureRejected(fixture);
      expect(stdout.text).toContain("import-time filesystem write is forbidden");
      expect((await readdir(fixture.root)).some((name) => name.startsWith("async-disposable-")))
        .toBe(false);
    },
  );

  it(
    "resolves and imports every real built export",
    async () => {
      const stdout = sink();
      const result = await runVerifyDeepImports({
        repoRoot,
        stdout,
        stderr: sink(),
      });
      if (result.exitCode !== 0) {
        throw new Error(`built export verification failed:\n${stdout.text}`);
      }

      expect(result.exitCode).toBe(0);
      expect(result.results.every((entry) => entry.ok)).toBe(true);
    },
    REAL_BUILT_EXPORT_TIMEOUT_MS,
  );
});

function fixtureCatalog() {
  return [{
    dir: "fixture",
    name: "@mono-agent/fixture",
    publishable: true,
  }];
}

async function importFixture(source) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-import-safety-"));
  temporaryRoots.push(root);
  const packageDirectory = join(root, "packages/fixture");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify({
    name: "@mono-agent/fixture",
    type: "module",
    exports: { ".": "./dist/index.js" },
  })}\n`);
  await writeFile(join(packageDirectory, "dist/index.js"), source);
  return {
    root,
    packageDirectory,
    catalog: [{
      dir: "fixture",
      name: "@mono-agent/fixture",
      publishable: true,
    }],
  };
}

async function verifyFixtureRejected(fixture) {
  const stdout = sink();
  const result = await runVerifyDeepImports({
    repoRoot: fixture.root,
    catalog: fixture.catalog,
    stdout,
    stderr: sink(),
  });
  expect(result.exitCode).toBe(1);
  return stdout;
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
