import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentAppPackageVersion } from "../package-version.js";
import {
  SUPERMEMORY_PLUGIN_PACKAGE,
  installedSupermemoryPluginVersion,
  isSupermemoryPluginInstalled,
  loadSupermemoryPlugin,
  missingSupermemoryPluginMessage,
} from "../supermemory-plugin.js";

describe("optional Supermemory plugin loading", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads a structurally valid installed plugin", async () => {
    const createSupermemoryStore = () => ({}) as never;
    const validateSupermemoryConfig = () => ({ valid: true, errors: [] });
    await expect(loadSupermemoryPlugin({
      importModule: async (specifier) => {
        expect(specifier).toMatch(/memory-supermemory\/dist\/index\.js$/u);
        return { createSupermemoryStore, validateSupermemoryConfig };
      },
    })).resolves.toEqual({ createSupermemoryStore, validateSupermemoryConfig });
  });

  it("resolves an explicitly installed agent-folder plugin by default", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "mono-agent-root-"));
    temporaryDirectories.push(agentRoot);
    const packageRoot = join(
      agentRoot,
      "node_modules",
      "@mono-agent",
      "memory-supermemory",
    );
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: SUPERMEMORY_PLUGIN_PACKAGE,
        version: agentAppPackageVersion(),
        type: "module",
        exports: {
          ".": { import: "./dist/index.js" },
          "./package.json": "./package.json",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(packageRoot, "dist", "index.js"),
      [
        "export const marker = 'agent-local';",
        "export const createSupermemoryStore = () => ({});",
        "export const validateSupermemoryConfig = () => ({ valid: true, errors: [] });",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadSupermemoryPlugin({ cwd: agentRoot }) as unknown as { marker?: string };
    expect(loaded.marker).toBe("agent-local");
  });

  it("prefers the app-side plugin for a managed runtime closure", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "mono-agent-root-"));
    temporaryDirectories.push(agentRoot);
    const packageRoot = join(agentRoot, "node_modules", "@mono-agent", "memory-supermemory");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: SUPERMEMORY_PLUGIN_PACKAGE,
      version: agentAppPackageVersion(),
      type: "module",
      exports: {
        ".": { import: "./dist/index.js" },
        "./package.json": "./package.json",
      },
    }), "utf8");
    writeFileSync(join(packageRoot, "dist", "index.js"), [
      "export const marker = 'agent-local';",
      "export const createSupermemoryStore = () => ({});",
      "export const validateSupermemoryConfig = () => ({ valid: true, errors: [] });",
    ].join("\n"), "utf8");

    const loaded = await loadSupermemoryPlugin({
      cwd: agentRoot,
      preferAppInstall: true,
    }) as unknown as { marker?: string };
    expect(loaded.marker).not.toBe("agent-local");
  });

  it("turns only a missing plugin into an exact matching-version install action", async () => {
    const missing = Object.assign(
      new Error(`Cannot find package '${SUPERMEMORY_PLUGIN_PACKAGE}'`),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    let imported = false;
    await expect(loadSupermemoryPlugin({
      importModule: async () => {
        imported = true;
        return {};
      },
      resolveModule: () => { throw missing; },
    })).rejects.toThrow(
      `npm install @mono-agent/memory-supermemory@${agentAppPackageVersion()}`,
    );
    expect(imported).toBe(false);
    expect(missingSupermemoryPluginMessage()).toContain("optional @mono-agent/memory-supermemory plugin");
  });

  it("preserves internal module-not-found failures from an installed plugin", async () => {
    const pluginManifest = fakePluginManifest(agentAppPackageVersion());
    const failure = Object.assign(
      new Error("Cannot find package 'internal-plugin-dependency'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    await expect(loadSupermemoryPlugin({
      importModule: async () => { throw failure; },
      resolveModule: () => pluginManifest,
    })).rejects.toBe(failure);
  });

  it("rejects an incompatible package instead of pretending it loaded", async () => {
    await expect(loadSupermemoryPlugin({ importModule: async () => ({}) })).rejects.toThrow(
      /does not export the expected store and validation API/u,
    );
  });

  it("detects a resolvable lockstep-compatible plugin", () => {
    expect(isSupermemoryPluginInstalled()).toBe(true);
    expect(installedSupermemoryPluginVersion()).toBe(agentAppPackageVersion());
  });

  it("rejects a plugin whose installed version does not match agent-app", async () => {
    const pluginManifest = fakePluginManifest("9.9.9");
    const createSupermemoryStore = () => ({}) as never;
    const validateSupermemoryConfig = () => ({ valid: true, errors: [] });
    let imported = false;

    await expect(loadSupermemoryPlugin({
      importModule: async () => {
        imported = true;
        return { createSupermemoryStore, validateSupermemoryConfig };
      },
      resolveModule: () => pluginManifest,
    })).rejects.toThrow(
      `@mono-agent/memory-supermemory@9.9.9 does not match @mono-agent/agent-app@${agentAppPackageVersion()}`,
    );
    expect(imported).toBe(false);
    expect(isSupermemoryPluginInstalled({ resolveModule: () => pluginManifest })).toBe(false);
  });

  it("fails closed before importing a plugin with unverifiable version metadata", async () => {
    const pluginManifest = fakePluginManifest(undefined);
    let imported = false;

    await expect(loadSupermemoryPlugin({
      importModule: async () => {
        imported = true;
        return {};
      },
      resolveModule: () => pluginManifest,
    })).rejects.toThrow(/version cannot be verified/u);
    expect(imported).toBe(false);
    expect(isSupermemoryPluginInstalled({ resolveModule: () => pluginManifest })).toBe(false);
  });

  function fakePluginManifest(version: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), "mono-agent-supermemory-plugin-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "dist"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: SUPERMEMORY_PLUGIN_PACKAGE,
        ...(version === undefined ? {} : { version }),
        exports: { ".": { import: "./dist/index.js" } },
      }),
      "utf8",
    );
    return join(root, "package.json");
  }
});
