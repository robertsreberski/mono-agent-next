import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createToolPolicy, failClosedToolPolicy, loadToolPolicyFromJsonFile, loadToolPolicyFromJsonFileSync, ToolPolicyError, toolPolicyToRuntimeOptions } from "../index.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tool-policy-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tool policy", () => {
  it("defaults to a fail-closed empty allowlist", () => {
    expect(failClosedToolPolicy()).toEqual({ allowedTools: [], disallowedTools: [] });
  });

  it("rejects duplicate or overlapping tool entries", () => {
    expect(() => createToolPolicy({ allowedTools: ["Read", "read"] })).toThrow(/duplicate/u);
    expect(() => createToolPolicy({ allowedTools: ["Read"], disallowedTools: ["Read"] })).toThrow(/both allowed/u);
  });

  it("converts policy into runtime options", () => {
    const policy = createToolPolicy({
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      mcpServers: { filesystem: { command: "mcp-server" } },
      mcpConfigPath: "/repo/mcp.json",
    });

    expect(toolPolicyToRuntimeOptions(policy)).toEqual({
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      mcpServers: { filesystem: { command: "mcp-server" } },
      mcpConfigPath: "/repo/mcp.json",
    });
  });

  it("omits mcp fields from runtime options when absent", () => {
    expect(toolPolicyToRuntimeOptions(createToolPolicy({ allowedTools: ["Read"] }))).toEqual({
      allowedTools: ["Read"],
      disallowedTools: [],
    });
  });

  it("loads JSON policy files", async () => {
    const dir = await tempDir();
    const file = join(dir, "policy.json");
    await writeFile(file, JSON.stringify({ allowedTools: ["Read"], mcpServers: { fs: { command: "server" } }, mcpConfigPath: "/repo/mcp.json" }), "utf8");

    await expect(loadToolPolicyFromJsonFile(file)).resolves.toMatchObject({
      allowedTools: ["Read"],
      disallowedTools: [],
      mcpServers: { fs: { command: "server" } },
      mcpConfigPath: "/repo/mcp.json",
    });
  });

  describe("loadToolPolicyFromJsonFileSync", () => {
    it("loads JSON policy files", async () => {
      const dir = await tempDir();
      const file = join(dir, "policy.json");
      await writeFile(file, JSON.stringify({ allowedTools: ["Read"], mcpServers: { fs: { command: "server" } }, mcpConfigPath: "/repo/mcp.json" }), "utf8");

      expect(loadToolPolicyFromJsonFileSync(file)).toMatchObject({
        allowedTools: ["Read"],
        disallowedTools: [],
        mcpServers: { fs: { command: "server" } },
        mcpConfigPath: "/repo/mcp.json",
      });
    });

    it("throws tool_policy_read_failed for a missing file", async () => {
      const dir = await tempDir();
      expect(() => loadToolPolicyFromJsonFileSync(join(dir, "missing.json"))).toThrowError(
        expect.objectContaining({ code: "tool_policy_read_failed" }),
      );
    });

    it("throws tool_policy_read_failed for invalid JSON", async () => {
      const dir = await tempDir();
      const file = join(dir, "broken.json");
      await writeFile(file, "{not json", "utf8");
      expect(() => loadToolPolicyFromJsonFileSync(file)).toThrowError(
        expect.objectContaining({ code: "tool_policy_read_failed" }),
      );
    });

    it("throws invalid_tool_policy for a non-object document", async () => {
      const dir = await tempDir();
      const file = join(dir, "scalar.json");
      await writeFile(file, JSON.stringify("just a string"), "utf8");
      expect(() => loadToolPolicyFromJsonFileSync(file)).toThrowError(
        expect.objectContaining({ code: "invalid_tool_policy" }),
      );
    });
  });

  describe("createToolPolicy field validation", () => {
    it("rejects a non-array tool list", () => {
      expect(() => createToolPolicy({ allowedTools: "Read" as unknown as readonly string[] })).toThrow(/allowedTools must be an array/u);
    });

    it("rejects a non-string tool entry", () => {
      expect(() => createToolPolicy({ allowedTools: [7 as unknown as string] })).toThrow(/allowedTools\[0\] must be a string/u);
    });

    it("rejects an empty/whitespace tool entry", () => {
      expect(() => createToolPolicy({ allowedTools: ["   "] })).toThrow(/allowedTools\[0\] must not be empty/u);
    });

    it("rejects a non-object mcpServers", () => {
      expect(() => createToolPolicy({ mcpServers: "nope" as unknown as Record<string, unknown> })).toThrow(/mcpServers must be an object/u);
    });

    it("rejects a non-string mcpConfigPath", () => {
      expect(() => createToolPolicy({ mcpConfigPath: 5 as unknown as string })).toThrow(/mcpConfigPath must be a string/u);
    });

    it("rejects an empty mcpConfigPath", () => {
      expect(() => createToolPolicy({ mcpConfigPath: "  " })).toThrow(/mcpConfigPath must not be empty/u);
    });
  });

  describe("loadToolPolicyFromJsonFile validation", () => {
    it("throws tool_policy_read_failed for a missing file", async () => {
      const dir = await tempDir();
      await expect(loadToolPolicyFromJsonFile(join(dir, "missing.json"))).rejects.toMatchObject({
        code: "tool_policy_read_failed",
      });
    });

    it("throws tool_policy_read_failed for invalid JSON", async () => {
      const dir = await tempDir();
      const file = join(dir, "broken.json");
      await writeFile(file, "{not json", "utf8");
      const error = await loadToolPolicyFromJsonFile(file).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolPolicyError);
      expect((error as ToolPolicyError).code).toBe("tool_policy_read_failed");
    });

    it("throws invalid_tool_policy for a non-object document", async () => {
      const dir = await tempDir();
      const file = join(dir, "scalar.json");
      await writeFile(file, JSON.stringify("just a string"), "utf8");
      await expect(loadToolPolicyFromJsonFile(file)).rejects.toMatchObject({
        code: "invalid_tool_policy",
        details: { code: "invalid_tool_policy" },
      });
    });

    it("throws invalid_tool_policy for a non-string tool entry in JSON", async () => {
      const dir = await tempDir();
      const file = join(dir, "bad-tools.json");
      await writeFile(file, JSON.stringify({ allowedTools: [1] }), "utf8");
      await expect(loadToolPolicyFromJsonFile(file)).rejects.toMatchObject({ code: "invalid_tool_policy" });
    });

    it("throws invalid_tool_policy when allowedTools is not an array in JSON", async () => {
      const dir = await tempDir();
      const file = join(dir, "not-array.json");
      await writeFile(file, JSON.stringify({ allowedTools: { Read: true } }), "utf8");
      await expect(loadToolPolicyFromJsonFile(file)).rejects.toThrow(/allowedTools must be an array/u);
    });

    it("throws invalid_tool_policy when mcpServers is an array in JSON", async () => {
      const dir = await tempDir();
      const file = join(dir, "array-servers.json");
      await writeFile(file, JSON.stringify({ mcpServers: [] }), "utf8");
      await expect(loadToolPolicyFromJsonFile(file)).rejects.toThrow(/mcpServers must be an object/u);
    });

    it("throws invalid_tool_policy for a blank file path", async () => {
      await expect(loadToolPolicyFromJsonFile("   ")).rejects.toMatchObject({ code: "invalid_tool_policy" });
    });
  });
});
