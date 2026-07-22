import { describe, expect, it } from "vitest";

import {
  isPlainObject,
  isValidMcpServerName,
  listMonoRuntimeBackends,
  parseMcpServers,
  selectMonoRuntimeBackendId,
} from "../index.js";

describe("isPlainObject", () => {
  it("accepts records and rejects arrays/null/primitives", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});

describe("isValidMcpServerName", () => {
  it("accepts alnum/_/- and rejects spaces and empty", () => {
    expect(isValidMcpServerName("github_one-2")).toBe(true);
    expect(isValidMcpServerName("bad name")).toBe(false);
    expect(isValidMcpServerName("")).toBe(false);
  });
});

describe("parseMcpServers", () => {
  it("classifies http (default for url), explicit sse, and stdio entries", () => {
    const parsed = parseMcpServers({
      github: { type: "http", url: "http://example.com", headers: { Authorization: "Bearer x" } },
      docs: { url: "http://docs.example.com" },
      events: { type: "sse", url: "http://sse.example.com" },
      local: { command: "node", args: ["server.js", 7], env: { A: "1", B: 2 }, cwd: "/work" },
    });
    expect(parsed).toEqual([
      { name: "github", transport: "http", url: "http://example.com", headers: { Authorization: "Bearer x" } },
      { name: "docs", transport: "http", url: "http://docs.example.com" },
      { name: "events", transport: "sse", url: "http://sse.example.com" },
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], env: { A: "1" }, cwd: "/work" },
    ]);
  });

  it("drops invalid names and malformed shapes, and returns [] for undefined", () => {
    expect(parseMcpServers(undefined)).toEqual([]);
    expect(
      parseMcpServers({
        "bad name": { url: "http://x" },
        broken: { type: "http" },
        notobj: "nope" as unknown as Record<string, unknown>,
      }),
    ).toEqual([]);
  });
});

describe("(sdk, executionMode) selection table", () => {
  it("includes a row per backend and resolves backend ids alias-aware", () => {
    expect(selectMonoRuntimeBackendId("claude", "sdk")).toBe("claude-sdk");
    expect(selectMonoRuntimeBackendId("anthropic", "sdk")).toBeUndefined();
    expect(selectMonoRuntimeBackendId("claude", "cli")).toBe("claude-code-cli");
    expect(selectMonoRuntimeBackendId("codex", "cli")).toBe("codex-app-cli");
    expect(selectMonoRuntimeBackendId("pi", "sdk")).toBe("pi-sdk");
    expect(selectMonoRuntimeBackendId("openai", "cli")).toBeUndefined();
    expect(selectMonoRuntimeBackendId("openai", "sdk")).toBeUndefined();
  });

  it("exposes only agent-runtime-backed runtime descriptors", () => {
    for (const backend of listMonoRuntimeBackends()) {
      expect(backend.runtimeBridgeId).not.toBe(backend.id);
      expect(backend.providerBoundary).toContain("@mono-agent/agent-runtime");
    }
  });
});
