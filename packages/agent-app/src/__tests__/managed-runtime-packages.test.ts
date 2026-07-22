import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguredManagedRuntimePackages } from "../managed-runtime-packages.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scaffold(config: Record<string, unknown>): Promise<{ cwd: string; configPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "mono-agent-managed-packages-"));
  directories.push(cwd);
  const configPath = join(cwd, "mono-agent.config.json");
  await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n", "utf8");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return { cwd, configPath };
}

describe("configured managed-runtime packages", () => {
  it("resolves channel and supermemory extras from the current app installation", async () => {
    const { cwd, configPath } = await scaffold({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      channels: { plugins: [{ package: "@mono-agent/a2a-adapter" }] },
      memory: {
        backend: "supermemory",
        supermemory: { baseUrl: "http://127.0.0.1:8787" },
      },
    });

    const packages = await resolveConfiguredManagedRuntimePackages({ cwd, configPath, env: {} });
    expect(packages.map((entry) => entry.packageName)).toEqual([
      "@mono-agent/a2a-adapter",
      "@mono-agent/memory-supermemory",
    ]);
    for (const entry of packages) {
      const manifest = JSON.parse(await readFile(join(entry.packageSource, "package.json"), "utf8")) as {
        name?: unknown;
      };
      expect(manifest.name).toBe(entry.packageName);
    }
  });

  it("returns no additions for a core-only config", async () => {
    const { cwd, configPath } = await scaffold({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
    });

    await expect(resolveConfiguredManagedRuntimePackages({ cwd, configPath, env: {} }))
      .resolves.toEqual([]);
  });

  it("copies an explicit agent-folder Supermemory plugin into the managed closure", async () => {
    const { cwd, configPath } = await scaffold({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      memory: {
        backend: "supermemory",
        supermemory: { baseUrl: "http://127.0.0.1:8787" },
      },
    });
    const packageSource = join(cwd, "node_modules", "@mono-agent", "memory-supermemory");
    await mkdir(packageSource, { recursive: true });
    await writeFile(join(packageSource, "package.json"), `${JSON.stringify({
      name: "@mono-agent/memory-supermemory",
      version: "0.8.0",
    })}\n`);

    await expect(resolveConfiguredManagedRuntimePackages({ cwd, configPath, env: {} }))
      .resolves.toEqual([{
        packageName: "@mono-agent/memory-supermemory",
        packageSource: await realpath(packageSource),
      }]);
  });
});
