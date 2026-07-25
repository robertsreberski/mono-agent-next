import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolvePreinstalledDocsMcp } from "../../extras/docs-mcp/scripts/smoke-packed-contract.mjs";

const VERSION = "0.15.0";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("packed docs-mcp preinstalled root", () => {
  test("resolves the exact installed package executable", async () => {
    const root = await installedRoot();
    const resolved = await resolvePreinstalledDocsMcp({
      expectedVersion: VERSION,
      installRoot: root,
    });

    expect(resolved).toEqual({
      cli: join(
        await realpath(root),
        "node_modules",
        "@mono-agent",
        "docs-mcp",
        "dist",
        "cli.js",
      ),
      executable: join(
        await realpath(root),
        "node_modules",
        ".bin",
        process.platform === "win32"
          ? "mono-agent-docs-mcp.cmd"
          : "mono-agent-docs-mcp",
      ),
      installRoot: await realpath(root),
      package: "@mono-agent/docs-mcp",
      version: VERSION,
    });
  });

  test("selects the Windows shim without changing the validated CLI", async () => {
    const root = await installedRoot();
    const resolved = await resolvePreinstalledDocsMcp({
      expectedVersion: VERSION,
      installRoot: root,
      platform: "win32",
    });
    expect(resolved.executable).toBe(
      join(await realpath(root), "node_modules", ".bin", "mono-agent-docs-mcp.cmd"),
    );
    expect(resolved.cli).toBe(
      join(
        await realpath(root),
        "node_modules",
        "@mono-agent",
        "docs-mcp",
        "dist",
        "cli.js",
      ),
    );
  });

  test("rejects relative and filesystem-root install paths", async () => {
    await expect(resolvePreinstalledDocsMcp({
      expectedVersion: VERSION,
      installRoot: "relative-consumer",
    })).rejects.toThrow("must be an absolute path");
    await expect(resolvePreinstalledDocsMcp({
      expectedVersion: VERSION,
      installRoot: parse(process.cwd()).root,
    })).rejects.toThrow("must not be a filesystem root");
  });

  test("rejects a symlinked install root", async () => {
    const root = await installedRoot();
    const aliasParent = await mkdtemp(join(tmpdir(), "mono-agent-docs-root-alias-"));
    temporaryDirectories.push(aliasParent);
    const alias = join(aliasParent, "consumer");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(resolvePreinstalledDocsMcp({
      expectedVersion: VERSION,
      installRoot: alias,
    })).rejects.toThrow("must be a real directory");
  });

  test.each([
    [{ name: "@mono-agent/not-docs-mcp" }, /identity\/version mismatch/u],
    [{ version: "0.15.1" }, /identity\/version mismatch/u],
    [{ bin: { "mono-agent-docs-mcp": "./dist/not-cli.js" } }, /bin contract mismatch/u],
  ])("rejects a mismatched installed package contract", async (overrides, pattern) => {
    const root = await installedRoot(overrides);
    await expect(resolvePreinstalledDocsMcp({
      expectedVersion: VERSION,
      installRoot: root,
    })).rejects.toThrow(pattern);
  });

  test.skipIf(process.platform === "win32")(
    "rejects package and executable symlink escapes",
    async () => {
      const outside = await mkdtemp(join(tmpdir(), "mono-agent-docs-outside-"));
      temporaryDirectories.push(outside);
      const outsidePackage = join(outside, "docs-mcp");
      await mkdir(join(outsidePackage, "dist"), { recursive: true });
      await writeFile(join(outsidePackage, "package.json"), `${JSON.stringify({
        name: "@mono-agent/docs-mcp",
        version: VERSION,
        bin: { "mono-agent-docs-mcp": "./dist/cli.js" },
      })}\n`);
      await writeFile(join(outsidePackage, "dist", "cli.js"), "outside cli\n");

      const escapedPackageRoot = await installedRoot();
      const packagePath = join(
        escapedPackageRoot,
        "node_modules",
        "@mono-agent",
        "docs-mcp",
      );
      await rm(packagePath, { recursive: true });
      await symlink(outsidePackage, packagePath, "dir");
      await expect(resolvePreinstalledDocsMcp({
        expectedVersion: VERSION,
        installRoot: escapedPackageRoot,
      })).rejects.toThrow("manifest escapes the install root");

      const escapedExecutableRoot = await installedRoot();
      const executable = join(
        escapedExecutableRoot,
        "node_modules",
        ".bin",
        "mono-agent-docs-mcp",
      );
      await rm(executable);
      await symlink(join(outsidePackage, "dist", "cli.js"), executable);
      await expect(resolvePreinstalledDocsMcp({
        expectedVersion: VERSION,
        installRoot: escapedExecutableRoot,
      })).rejects.toThrow("executable escapes the install root");

      const escapedCliRoot = await installedRoot();
      const cli = join(
        escapedCliRoot,
        "node_modules",
        "@mono-agent",
        "docs-mcp",
        "dist",
        "cli.js",
      );
      await rm(cli);
      await symlink(join(outsidePackage, "dist", "cli.js"), cli);
      await expect(resolvePreinstalledDocsMcp({
        expectedVersion: VERSION,
        installRoot: escapedCliRoot,
      })).rejects.toThrow("CLI escapes the package root");
    },
  );
});

async function installedRoot(manifestOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-docs-preinstalled-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, "node_modules", "@mono-agent", "docs-mcp");
  const distDirectory = join(packageDirectory, "dist");
  const binDirectory = join(root, "node_modules", ".bin");
  await Promise.all([
    mkdir(distDirectory, { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
  ]);
  await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify({
    name: "@mono-agent/docs-mcp",
    version: VERSION,
    bin: { "mono-agent-docs-mcp": "./dist/cli.js" },
    ...manifestOverrides,
  })}\n`);
  await Promise.all([
    writeFile(join(distDirectory, "cli.js"), "fixture cli\n"),
    writeFile(join(binDirectory, "mono-agent-docs-mcp"), "fixture executable\n"),
    writeFile(join(binDirectory, "mono-agent-docs-mcp.cmd"), "fixture executable\n"),
  ]);
  return root;
}
