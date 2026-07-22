import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { safeRebuildMemoryIndex } from "@mono-agent/memory/bujo";

import { ensureStartable, parseCliArgs } from "../cli.js";

let dir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-preflight-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  cwdSpy.mockRestore();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify(json, null, 2));
}

async function seedManagedMemory(root: string, tier: "journal" | "bujo", embeddingModel: string): Promise<void> {
  await safeRebuildMemoryIndex({
    root,
    tier,
    embeddings: {
      id: embeddingModel,
      embed: async (texts) => texts.map(() => {
        const vector = new Array<number>(768).fill(0);
        vector[0] = 1;
        return vector;
      }),
    },
    dim: 768,
  });
}

describe("ensureStartable (start/restart preflight gate)", () => {
  it("refuses with code 2 when the config file is missing", async () => {
    const result = await ensureStartable(parseCliArgs(["start"]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("missing-config");
      expect(result.code).toBe(2);
      if (result.kind === "missing-config") {
        expect(result.configPath).toBe(join(dir, "mono-agent.config.json"));
      }
    }
  });

  it("refuses with code 1 when the config loads but a section errors", async () => {
    // Valid model, but the referenced identity file does not exist → context error.
    await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
    });

    const result = await ensureStartable(parseCliArgs(["start"]));

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "validation") {
      expect(result.code).toBe(1);
      const context = result.report.sections.find((s) => s.id === "context");
      expect(context?.status).toBe("error");
      expect(context?.details.join("\n")).toContain("Identity file is missing");
    } else {
      expect.fail("expected a validation failure");
    }
  });

  it("passes when the only non-ok sections are waiting, and never hits the network", async () => {
    // bujo + Ollama would normally probe and downgrade to `waiting`; the gate
    // runs with liveness:false, so the probe is skipped entirely.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await seedManagedMemory(join(dir, "mem"), "bujo", "ollama:nomic-embed-text:v1.5");
    await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: join(dir, "mem"),
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const result = await ensureStartable(parseCliArgs(["start"]));

    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
