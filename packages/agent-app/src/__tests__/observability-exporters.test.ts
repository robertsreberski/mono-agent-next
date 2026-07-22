import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAppCoreConfigError, resolveAppObservabilityExporters } from "../app-config.js";
import type { MonoAgentAppConfigInput } from "../app-config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-obs-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json, null, 2));
  return configPath;
}

function inputFor(configPath: string, env: Record<string, string | undefined> = {}): MonoAgentAppConfigInput {
  return { env, cwd: dir, configPath };
}

describe("resolveAppObservabilityExporters", () => {
  it("returns [] when no exporter is configured", async () => {
    const configPath = await writeConfig({ runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." } });
    const exporters = await resolveAppObservabilityExporters(inputFor(configPath));
    expect(exporters).toEqual([]);
  });

  it("reads exporters from the config file with the default endpoint", async () => {
    const configPath = await writeConfig({
      observability: { exporters: [{ type: "phoenix" }] },
    });
    const exporters = await resolveAppObservabilityExporters(inputFor(configPath));
    expect(exporters).toHaveLength(1);
    expect(exporters[0]?.type).toBe("phoenix");
    expect(exporters[0]?.endpoint).toBe("http://127.0.0.1:6006/v1/traces");
    expect(exporters[0]?.includeSensitiveData).toBe(false);
    expect(exporters[0]?.contentPatternRedaction).toBe(false);
  });

  it("honors an explicit endpoint and content redaction opt-ins from config", async () => {
    const configPath = await writeConfig({
      observability: {
        exporters: [{
          type: "phoenix",
          endpoint: "http://collector:4318/v1/traces",
          includeSensitiveData: true,
          contentPatternRedaction: true,
        }],
      },
    });
    const exporters = await resolveAppObservabilityExporters(inputFor(configPath));
    expect(exporters[0]?.endpoint).toBe("http://collector:4318/v1/traces");
    expect(exporters[0]?.includeSensitiveData).toBe(true);
    expect(exporters[0]?.contentPatternRedaction).toBe(true);
  });

  it("rejects a non-boolean contentPatternRedaction value", async () => {
    const configPath = await writeConfig({
      observability: { exporters: [{ type: "phoenix", contentPatternRedaction: "yes" }] },
    });
    await expect(resolveAppObservabilityExporters(inputFor(configPath))).rejects.toThrow(/contentPatternRedaction/iu);
  });

  it("lets MONO_AGENT_OBSERVABILITY_EXPORTERS override the config file", async () => {
    const configPath = await writeConfig({
      observability: { exporters: [{ type: "phoenix", endpoint: "http://from-config:6006/v1/traces" }] },
    });
    const exporters = await resolveAppObservabilityExporters(
      inputFor(configPath, {
        MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([{ type: "phoenix", endpoint: "http://from-env:6006/v1/traces" }]),
      }),
    );
    expect(exporters[0]?.endpoint).toBe("http://from-env:6006/v1/traces");
  });

  it("throws a MonoAgentConfigError for an unknown exporter type", async () => {
    const configPath = await writeConfig({
      observability: { exporters: [{ type: "not-a-thing" }] },
    });
    await expect(resolveAppObservabilityExporters(inputFor(configPath))).rejects.toSatisfy((error: unknown) =>
      isAppCoreConfigError(error),
    );
  });

  it("throws for an invalid endpoint url and never probes it", async () => {
    const configPath = await writeConfig({
      observability: { exporters: [{ type: "phoenix", endpoint: "not a url" }] },
    });
    await expect(resolveAppObservabilityExporters(inputFor(configPath))).rejects.toSatisfy((error: unknown) =>
      isAppCoreConfigError(error),
    );
  });

  it("tolerates an unreadable config file by returning []", async () => {
    const configPath = join(dir, "broken.json");
    await writeFile(configPath, "{ this is not json");
    const exporters = await resolveAppObservabilityExporters(inputFor(configPath));
    expect(exporters).toEqual([]);
  });

  it("defaults an omitted exporter type to phoenix (matches core config normalization)", async () => {
    const configPath = await writeConfig({
      observability: { exporters: [{ endpoint: "http://127.0.0.1:6006/v1/traces" }] },
    });
    const exporters = await resolveAppObservabilityExporters(inputFor(configPath));
    expect(exporters).toHaveLength(1);
    expect(exporters[0]?.type).toBe("phoenix");
  });

  it("throws for more than one configured exporter (only the first is wired)", async () => {
    const configPath = await writeConfig({
      observability: {
        exporters: [
          { type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" },
          { type: "phoenix", endpoint: "http://127.0.0.1:6007/v1/traces" },
        ],
      },
    });
    await expect(resolveAppObservabilityExporters(inputFor(configPath))).rejects.toSatisfy((error: unknown) =>
      isAppCoreConfigError(error),
    );
  });

  it("throws for an endpoint that embeds credentials or query/fragment secrets", async () => {
    for (const endpoint of [
      "https://user:pass@127.0.0.1:6006/v1/traces",
      "http://127.0.0.1:6006/v1/traces?api_key=SECRET",
      "http://127.0.0.1:6006/v1/traces#token",
    ]) {
      const configPath = await writeConfig({
        observability: { exporters: [{ type: "phoenix", endpoint }] },
      });
      await expect(resolveAppObservabilityExporters(inputFor(configPath))).rejects.toSatisfy((error: unknown) =>
        isAppCoreConfigError(error),
      );
    }
  });
});
