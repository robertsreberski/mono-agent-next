import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readSettingsJson,
  SettingsJsonError,
  writeSettingsJson,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings JSON store", () => {
  it("preserves unknown top-level sections and merges object sections generically", async () => {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      `${JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 8 },
        channel: { botToken: "abc" },
        nestedSection: { entry: { name: "Before", description: "Keep me", version: "0.1.0" } },
        futureAdapter: { enabled: true, mode: "alpha" },
      })}\n`,
      "utf8",
    );

    await writeSettingsJson({
      path,
      patch: {
        runtime: { maxTurns: 12 },
        nestedSection: { entry: { name: "After" } },
        futureAdapter: { mode: "beta" },
      },
    });

    const { json } = await readSettingsJson(path);
    expect(json).toEqual({
      runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
      channel: { botToken: "abc" },
      nestedSection: { entry: { name: "After", description: "Keep me", version: "0.1.0" } },
      futureAdapter: { enabled: true, mode: "beta" },
    });
    expect(await readFile(path, "utf8")).toContain("\"futureAdapter\"");
  });
});

describe("readSettingsJson error paths", () => {
  it("returns a missing result instead of throwing when the file is absent", async () => {
    const result = await readSettingsJson(join(dir, "absent.json"));
    expect(result).toEqual({ json: {}, version: "", path: join(dir, "absent.json"), missing: true });
  });

  it("treats an empty/whitespace file as an empty object", async () => {
    const path = join(dir, "empty.json");
    await writeFile(path, "   \n", "utf8");
    const result = await readSettingsJson(path);
    expect(result.json).toEqual({});
    expect(result.missing).toBe(false);
  });

  it("throws invalid_json_source when the file is not valid JSON", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readSettingsJson(path)).rejects.toMatchObject({
      name: "SettingsJsonError",
      code: "invalid_json_source",
      details: { code: "invalid_json_source", path },
    });
  });

  it("throws invalid_json_source when the JSON is not an object", async () => {
    const path = join(dir, "array.json");
    await writeFile(path, "[1, 2, 3]", "utf8");
    await expect(readSettingsJson(path)).rejects.toMatchObject({
      code: "invalid_json_source",
      message: `${path} must contain a JSON object.`,
    });
  });

  it("exposes the error code via the SettingsJsonError class", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "nope", "utf8");
    const error = await readSettingsJson(path).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SettingsJsonError);
    expect((error as SettingsJsonError).details.code).toBe("invalid_json_source");
  });
});

describe("writeSettingsJson atomic write", () => {
  it("creates the file with 0600 permissions and leaves no tmp file behind", async () => {
    const path = join(dir, "nested", "settings.json");
    await writeSettingsJson({ path, patch: { runtime: { model: "m" } } });

    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const entries = await readdir(join(dir, "nested"));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual([basename(path)]);
  });

  it("returns a content version hash", async () => {
    const path = join(dir, "settings.json");
    const { version } = await writeSettingsJson({ path, patch: { runtime: { model: "m" } } });
    expect(version).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("cleans up the tmp file and surfaces invalid_json_source when the rename target is a directory", async () => {
    const path = join(dir, "as-dir");
    await writeFile(`${path}-keep`, "x", "utf8");
    // Make the destination path a non-empty directory so rename(tmp -> path) fails.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "child"), "x", "utf8");

    await expect(writeSettingsJson({ path, patch: { runtime: { model: "m" } } })).rejects.toMatchObject({
      code: "invalid_json_source",
    });

    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});
