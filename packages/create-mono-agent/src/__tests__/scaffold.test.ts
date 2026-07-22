import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScaffoldError, scaffoldAgent } from "../scaffold.js";
import { renderMinimalProject } from "../templates.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("renderMinimalProject", () => {
  it("snapshots the exact five-package runtime closure and minimal config", () => {
    const rendered = renderMinimalProject({ projectName: "minimal-example" });
    const files = new Map(rendered.map((file) => [file.path, file.contents]));
    const manifest = JSON.parse(files.get("package.json")!);
    const config = JSON.parse(files.get("mono-agent.config.json")!);

    expect([...files.keys()]).toMatchInlineSnapshot(`
      [
        ".env.example",
        ".gitignore",
        ".mono-agent/mono-agent.config.schema.json",
        "AGENTS.md",
        "README.md",
        "mono-agent.config.json",
        "package.json",
      ]
    `);

    expect({ dependencies: manifest.dependencies, config }).toMatchInlineSnapshot(`
      {
        "config": {
          "$schema": "./.mono-agent/mono-agent.config.schema.json",
          "agent": {
            "id": "minimal-example",
            "instructions": "./AGENTS.md",
            "name": "Minimal Example",
            "workspace": ".",
          },
          "channels": {
            "inbound": {
              "$use": "@mono-agent/channel-webhook",
              "apiKey": {
                "$env": "WEBHOOK_API_KEY",
              },
              "listen": {
                "host": "127.0.0.1",
                "port": 3210,
              },
            },
          },
          "configVersion": 1,
          "policy": {
            "approvals": {
              "default": "allow",
            },
            "sandbox": {
              "mode": "off",
            },
            "tools": {
              "allow": [],
              "default": "deny",
            },
          },
          "routing": {
            "effort": "high",
            "fallbacks": [],
            "primary": {
              "model": "openai:gpt-5.6-sol",
              "runtime": "pi",
            },
          },
          "runtimes": {
            "pi": {
              "$use": "@mono-agent/runtime-pi",
              "auth": {
                "path": "./.secrets/pi/auth.json",
              },
            },
          },
          "session": {
            "mode": "continuous",
          },
        },
        "dependencies": {
          "@mono-agent/channel-webhook": "0.15.0",
          "@mono-agent/cli": "0.15.0",
          "@mono-agent/core": "0.15.0",
          "@mono-agent/module-sdk": "0.15.0",
          "@mono-agent/runtime-pi": "0.15.0",
        },
      }
    `);
    expect(Object.keys(manifest.dependencies)).toHaveLength(5);
  });

  it("contains only secret names and references, never secret values", () => {
    const rendered = renderMinimalProject({ projectName: "minimal-example" });
    const files = new Map(rendered.map((file) => [file.path, file.contents]));
    expect(files.get(".env.example")).toBe("WEBHOOK_API_KEY=\n");
    expect(files.get("README.md")).toContain('"openai": { "type": "api_key"');
    expect(files.get("README.md")).toContain("chmod 600 .secrets/pi/auth.json");
    expect([...files.values()].join("\n")).not.toMatch(/(?:sk-[A-Za-z0-9]|bearer\s+\S+|secret-value)/iu);
  });
});

describe("scaffoldAgent", () => {
  it("publishes a complete project into an absent or empty directory", async () => {
    const root = await makeTemporaryDirectory();
    const absent = join(root, "absent-agent");
    const empty = join(root, "empty-agent");
    await mkdir(empty);

    await expect(scaffoldAgent({ targetDirectory: absent })).resolves.toMatchObject({
      directory: absent,
      installed: false,
    });
    await expect(scaffoldAgent({ targetDirectory: empty })).resolves.toMatchObject({
      directory: empty,
      installed: false,
    });

    expect(await readdir(absent)).toEqual(expect.arrayContaining([
      ".env.example",
      ".gitignore",
      ".mono-agent",
      "AGENTS.md",
      "README.md",
      "mono-agent.config.json",
      "package.json",
    ]));
    expect(JSON.parse(await readFile(join(empty, "package.json"), "utf8")).name).toBe("empty-agent");
  });

  it("rejects non-empty and symlink targets without changing their data", async () => {
    const root = await makeTemporaryDirectory();
    const occupied = join(root, "occupied");
    const external = join(root, "external");
    const linked = join(root, "linked");
    await mkdir(occupied);
    await mkdir(external);
    await writeFile(join(occupied, "keep.txt"), "keep", "utf8");
    await writeFile(join(external, "keep.txt"), "external", "utf8");
    await symlink(external, linked);

    await expect(scaffoldAgent({ targetDirectory: occupied })).rejects.toThrow(ScaffoldError);
    await expect(scaffoldAgent({ targetDirectory: linked })).rejects.toThrow(/symbolic link/u);
    await expect(readFile(join(occupied, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(external, "keep.txt"), "utf8")).resolves.toBe("external");
    expect(await readdir(external)).toEqual(["keep.txt"]);
  });

  it("allows only one concurrent scaffold owner", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "race-agent");
    let releaseInstall!: () => void;
    let markInstallerStarted!: () => void;
    const installerStarted = new Promise<void>((resolvePromise) => {
      markInstallerStarted = resolvePromise;
    });
    const installer = vi.fn(async () => {
      markInstallerStarted();
      await new Promise<void>((resolvePromise) => {
        releaseInstall = resolvePromise;
      });
    });
    const first = scaffoldAgent({ targetDirectory: target, install: true, installer });
    await installerStarted;

    await expect(scaffoldAgent({ targetDirectory: target })).rejects.toThrow(/Another scaffold operation/u);
    releaseInstall();
    await expect(first).resolves.toMatchObject({ installed: true });
    expect(installer).toHaveBeenCalledTimes(1);
  });

  it("never invokes a package manager without the explicit install flag", async () => {
    const root = await makeTemporaryDirectory();
    const installer = vi.fn(async () => undefined);

    await scaffoldAgent({ targetDirectory: join(root, "default-agent"), installer });
    expect(installer).not.toHaveBeenCalled();

    await scaffoldAgent({
      targetDirectory: join(root, "installed-agent"),
      install: true,
      packageManager: "npm",
      installer,
    });
    expect(installer).toHaveBeenCalledOnce();
    expect(installer).toHaveBeenCalledWith("npm", expect.stringContaining(".installed-agent.mono-agent-stage-"));
  });

  it("rolls back the staged directory when explicit installation fails", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "failed-agent");

    await expect(scaffoldAgent({
      targetDirectory: target,
      install: true,
      installer: async () => {
        throw new Error("registry unavailable");
      },
    })).rejects.toThrow("registry unavailable");

    await expect(readdir(target)).rejects.toThrow();
    expect((await readdir(root)).filter((entry) => entry.includes("mono-agent-stage"))).toEqual([]);
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "create-mono-agent-test-"));
  temporaryDirectories.push(path);
  return path;
}
