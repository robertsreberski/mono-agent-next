import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverOperatorAgents,
  isTrustedOperatorBaseUrl,
  operatorBaseUrlFromMetadata,
} from "../discovery.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("operator discovery", () => {
  it("accepts only credential-free loopback HTTP(S) operator URLs", () => {
    expect(isTrustedOperatorBaseUrl("http://127.0.0.1:4321/gui")).toBe(true);
    expect(isTrustedOperatorBaseUrl("https://[::1]:4321/gui")).toBe(true);
    expect(isTrustedOperatorBaseUrl("http://localhost:4321/gui")).toBe(true);
    expect(isTrustedOperatorBaseUrl("http://192.168.1.4:4321/gui")).toBe(false);
    expect(isTrustedOperatorBaseUrl("http://user:pass@127.0.0.1:4321/gui")).toBe(false);
    expect(isTrustedOperatorBaseUrl("file:///tmp/socket")).toBe(false);
  });

  it("extracts only running trusted channel metadata", () => {
    expect(operatorBaseUrlFromMetadata({ channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:1234/gui/" } } }))
      .toBe("http://127.0.0.1:1234/gui");
    expect(operatorBaseUrlFromMetadata({ channels: { tui: { kind: "failed", baseUrl: "http://127.0.0.1:1234/gui" } } })).toBeUndefined();
    expect(operatorBaseUrlFromMetadata({ channels: { tui: { kind: "running", baseUrl: "http://evil.example/gui" } } })).toBeUndefined();
  });

  it("merges registries, filters stopped agents, and resolves the local API key without exposing it in metadata", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ tui: { apiKey: "  secret  " } }));
    const manifest = {
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: { channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" } } },
    };
    await writeFile(join(registry, "agent-one.json"), JSON.stringify(manifest));

    const found = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ baseUrl: "http://127.0.0.1:5555/gui", apiKey: "secret", source: { sourceId: "agent-one" } });
  });

  it("resolves the documented per-agent dotenv key from an attested background snapshot", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    const dotenvPath = join(base, ".env");
    await writeFile(configPath, JSON.stringify({ tui: { apiKey: "legacy-inline" } }), { mode: 0o600 });
    await writeFile(dotenvPath, "MONO_AGENT_TUI_API_KEY=' durable-key '\nOTHER_SECRET=never-read\n", { mode: 0o600 });
    await writeFile(join(registry, "agent-one.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: {
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" } },
        backgroundSnapshot: {
          schema: "mono-agent.background-snapshot.v1",
          configPath,
          configFingerprint: "config-proof",
          dotenvPath,
          dotenvFingerprint: "dotenv-proof",
        },
      },
    }));

    const found = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(found[0]).toMatchObject({ apiKey: "durable-key" });
    expect(found[0]?.source.metadata).not.toHaveProperty("apiKey");
  });

  it("does not follow a dotenv symlink advertised by trace metadata", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    const secretPath = join(base, "secret.env");
    const dotenvPath = join(base, ".env");
    await writeFile(configPath, "{}", { mode: 0o600 });
    await writeFile(secretPath, "MONO_AGENT_TUI_API_KEY=must-not-follow\n", { mode: 0o600 });
    await symlink(secretPath, dotenvPath);
    await writeFile(join(registry, "agent-one.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: {
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" } },
        backgroundSnapshot: {
          schema: "mono-agent.background-snapshot.v1",
          configPath,
          configFingerprint: "config-proof",
          dotenvPath,
          dotenvFingerprint: "dotenv-proof",
        },
      },
    }));

    const found = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(found[0]?.apiKey).toBeUndefined();
  });
});
