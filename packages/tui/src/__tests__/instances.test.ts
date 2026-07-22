import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverInstances, resolveInstanceApiKey, toInstance } from "../data/instances.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-instances-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifestIn(
  registryDir: string,
  sourceId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, `${sourceId}.json`),
    JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId,
      label: sourceId,
      artifactDir: join(dir, "artifacts"),
      pid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      transports: ["tui"],
      configPath: join(dir, "mono-agent.config.json"),
      metadata: {
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/gui" } },
      },
      ...overrides,
    }),
  );
}

async function writeManifest(
  sourceId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeManifestIn(dir, sourceId, overrides);
}

describe("discoverInstances", () => {
  it("lists running agents with their tui endpoint and agent dir", async () => {
    await writeManifest("agent-a");

    const result = await discoverInstances({ registryDir: dir });

    expect(result.registryDir).toBe(dir);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]?.tuiBaseUrl).toBe("http://127.0.0.1:5151/gui");
    expect(result.instances[0]?.agentDir).toBe(dir);
    expect(result.instances[0]?.source.health).toBe("running");
  });

  it("filters stopped agents but keeps stale ones (still connectable)", async () => {
    await writeManifest("agent-stopped", { status: "stopped" });
    await writeManifest("agent-stale", { updatedAt: new Date(Date.now() - 120_000).toISOString() });

    const result = await discoverInstances({ registryDir: dir });

    expect(result.instances.map((instance) => instance.source.sourceId)).toEqual(["agent-stale"]);
    expect(result.instances[0]?.source.health).toBe("stale");
  });

  it("yields no tuiBaseUrl when the tui channel is absent or not running", async () => {
    await writeManifest("agent-no-tui", { metadata: { channels: { tui: { kind: "disabled", reason: "off" } } } });

    const result = await discoverInstances({ registryDir: dir });

    expect(result.instances[0]?.tuiBaseUrl).toBeUndefined();
  });

  it("returns empty for a missing registry dir", async () => {
    const result = await discoverInstances({ registryDir: join(dir, "does-not-exist") });

    expect(result.instances).toEqual([]);
  });

  it("discovers across multiple registries: union shown, fresher dupe wins with its own manifest paths", async () => {
    const registryA = join(dir, "registry-a");
    const registryB = join(dir, "registry-b");
    await writeManifestIn(registryA, "only-a");
    await writeManifestIn(registryB, "only-b");
    // The same agent registered in both (mirror): registry A holds the older
    // heartbeat, registry B the fresher one with different artifact paths.
    await writeManifestIn(registryA, "dupe", {
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
      artifactDir: join(dir, "stale-artifacts"),
    });
    await writeManifestIn(registryB, "dupe", {
      artifactDir: join(dir, "fresh-artifacts"),
    });

    const result = await discoverInstances({ registryDirs: [registryA, registryB] });

    expect(result.registryDirs).toEqual([registryA, registryB]);
    expect(result.registryDir).toBe(registryA);
    expect(result.instances.map((instance) => instance.source.sourceId).sort()).toEqual([
      "dupe",
      "only-a",
      "only-b",
    ]);
    // The winning (fresher) manifest's own absolute paths ride along, so
    // replay/config for the dupe resolve against the copy that won.
    const dupe = result.instances.find((instance) => instance.source.sourceId === "dupe");
    expect(dupe?.source.artifactDir).toBe(join(dir, "fresh-artifacts"));
  });

  it("dedupes repeated registry dirs and keeps the single-dir option working unchanged", async () => {
    await writeManifest("agent-a");

    const result = await discoverInstances({ registryDirs: [dir, dir] });

    expect(result.instances).toHaveLength(1);
    expect(result.registryDirs).toEqual([dir]);
  });
});

describe("resolveInstanceApiKey", () => {
  it("reads tui.apiKey from the agent's config file", async () => {
    await writeManifest("agent-a");
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({ tui: { apiKey: "from-config" } }));
    const { instances } = await discoverInstances({ registryDir: dir });

    await expect(resolveInstanceApiKey(instances[0]!, {})).resolves.toBe("from-config");
  });

  it("trims the config key so it matches the adapter's own (trimming) loader", async () => {
    await writeManifest("agent-a");
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({ tui: { apiKey: "  padded-key  " } }));
    const { instances } = await discoverInstances({ registryDir: dir });

    await expect(resolveInstanceApiKey(instances[0]!, {})).resolves.toBe("padded-key");
  });

  it("prefers the MONO_AGENT_TUI_API_KEY env of this shell", async () => {
    await writeManifest("agent-a");
    const { instances } = await discoverInstances({ registryDir: dir });

    await expect(
      resolveInstanceApiKey(instances[0]!, { MONO_AGENT_TUI_API_KEY: "from-env" }),
    ).resolves.toBe("from-env");
  });

  it("resolves undefined when nothing is configured (best-effort)", async () => {
    await writeManifest("agent-a");
    const { instances } = await discoverInstances({ registryDir: dir });

    await expect(resolveInstanceApiKey(instances[0]!, {})).resolves.toBeUndefined();
  });
});

describe("toInstance", () => {
  it("derives agentDir from configPath", async () => {
    await writeManifest("agent-a");
    const { instances } = await discoverInstances({ registryDir: dir });

    expect(toInstance(instances[0]!.source).agentDir).toBe(dir);
  });
});
