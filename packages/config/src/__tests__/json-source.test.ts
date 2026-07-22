import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MonoAgentConfigError } from "../index.js";
import { readMonoAgentConfigJson, writeMonoAgentConfigJson } from "../json-source.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readMonoAgentConfigJson", () => {
  it("returns an empty config when the file is missing", async () => {
    const result = await readMonoAgentConfigJson(join(dir, "absent.json"));
    expect(result.missing).toBe(true);
    expect(result.json).toEqual({});
    expect(result.version).toBe("");
  });

  it("parses an existing file and reports a stable version hash", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ runtime: { maxTurns: 12 } }), "utf8");
    const first = await readMonoAgentConfigJson(path);
    const second = await readMonoAgentConfigJson(path);
    expect(first.json.runtime?.maxTurns).toBe(12);
    expect(first.version).toBe(second.version);
    expect(first.missing).toBe(false);
  });

  it("rejects files that don't contain a JSON object", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "[1,2,3]", "utf8");
    await expect(readMonoAgentConfigJson(path)).rejects.toBeInstanceOf(MonoAgentConfigError);
  });

  it("rejects malformed JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readMonoAgentConfigJson(path)).rejects.toBeInstanceOf(MonoAgentConfigError);
  });

  it("treats an empty file as an empty config", async () => {
    const path = join(dir, "empty.json");
    await writeFile(path, "", "utf8");
    const result = await readMonoAgentConfigJson(path);
    expect(result.json).toEqual({});
    expect(result.missing).toBe(false);
  });
});

describe("writeMonoAgentConfigJson", () => {
  it("creates the file with mode 0o600 and pretty-printed content", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: { runtime: { maxTurns: 12 }, futureAdapter: { enabled: true } },
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain("\"maxTurns\": 12");
    expect(text.endsWith("\n")).toBe(true);
    const stats = await stat(path);
    // mask off file-type bits and check the permission bits.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("merges a sparse patch into an existing file (deep-merge per section)", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: {
        runtime: { maxTurns: 8, model: "pi:openai-codex:gpt-5.5" },
        tools: { allowedTools: ["Read"] },
      },
    });
    await writeMonoAgentConfigJson({
      path,
      patch: { runtime: { maxTurns: 16 } },
    });
    const { json } = await readMonoAgentConfigJson(path);
    expect(json.runtime?.maxTurns).toBe(16);
    expect(json.runtime?.model).toBe("pi:openai-codex:gpt-5.5");
    expect(json.tools?.allowedTools).toEqual(["Read"]);
  });

  it("preserves and merges unknown object sections for adapter-owned settings", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: {
        runtime: { maxTurns: 8 },
        telegram: { botToken: "abc", allowedChatIds: ["111"] },
      },
    });
    await writeMonoAgentConfigJson({
      path,
      patch: { telegram: { allowedChatIds: ["222"] } },
    });
    const { json } = await readMonoAgentConfigJson(path);
    expect(json.telegram).toEqual({ botToken: "abc", allowedChatIds: ["222"] });
  });

  it("round-trips LM Studio embeddings including an optional credential reference", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: {
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "lmstudio",
            model: "embed-model",
            endpoint: "http://localhost:1234",
            apiKeyEnv: "LM_STUDIO_API_KEY",
            dim: 768,
          },
        },
      },
    });

    const { json } = await readMonoAgentConfigJson(path);
    expect(json.memory?.embeddings).toEqual({
      provider: "lmstudio",
      model: "embed-model",
      endpoint: "http://localhost:1234",
      apiKeyEnv: "LM_STUDIO_API_KEY",
      dim: 768,
    });
  });

  it("does not leave a .tmp file behind on success", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({ path, patch: { runtime: { maxTurns: 4 } } });
    const tmpStat = await stat(`${path}.tmp`).catch(() => null);
    expect(tmpStat).toBeNull();
  });

  it("creates parent directories when needed", async () => {
    const path = join(dir, "nested", "deeper", "config.json");
    await writeMonoAgentConfigJson({ path, patch: { runtime: { maxTurns: 4 } } });
    const stats = await stat(path);
    expect(stats.isFile()).toBe(true);
  });
});
