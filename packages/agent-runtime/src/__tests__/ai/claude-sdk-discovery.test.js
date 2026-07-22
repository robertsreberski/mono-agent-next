import { EventEmitter } from "node:events";
import { access, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_SDK_CATALOG_VERSION,
  createClaudeSdkDiscoveryIsolation,
  discoverClaudeSdkModels,
  normalizeClaudeSdkCatalog,
  normalizeClaudeSdkModelId,
} from "../../ai/providers/claude-sdk-discovery.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
  }

  disconnect() {}

  kill(signal) {
    if (this.exitCode != null) return true;
    this.signalCode = signal;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

describe("Claude SDK catalog normalization", () => {
  it("deduplicates aliases by exact resolved id and preserves capabilities", () => {
    const models = normalizeClaudeSdkCatalog([
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default (recommended)",
        description: "Sonnet 5 · Efficient for routine tasks",
        supportedEffortLevels: ["low", "medium", "invalid", "max"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        description: "Sonnet 5",
        supportedEffortLevels: ["high", "xhigh"],
      },
    ]);
    expect(models).toEqual([expect.objectContaining({
      model: "claude-sonnet-5",
      reference: "claude:claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      supportedEfforts: ["low", "medium", "max", "high", "xhigh"],
      supportsAdaptiveThinking: true,
      source: "discovered",
      catalogVersion: CLAUDE_SDK_CATALOG_VERSION,
    })]);
    expect(JSON.stringify(models)).not.toContain("Default (recommended)");
  });

  it("preserves exact dated ids and [1m], recognizes Opus 4.8, and rejects aliases", () => {
    expect(normalizeClaudeSdkModelId("claude:claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
    expect(normalizeClaudeSdkModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    for (const alias of ["default", "opus", "sonnet", "haiku", "fable", "mythos", "inherit"]) {
      expect(normalizeClaudeSdkModelId(alias)).toBeNull();
    }
    expect(normalizeClaudeSdkModelId("my-custom-opus")).toBeNull();
  });
});

describe("Claude SDK discovery isolation", () => {
  it("creates owner-only no-auth homes and removes them on cleanup", async () => {
    const isolation = await createClaudeSdkDiscoveryIsolation({
      baseEnvironment: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "must-not-cross",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-cross",
      },
    });
    expect(isolation.env.PATH).toBe("/usr/bin");
    expect(isolation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolation.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(isolation.env.HOME).toContain(isolation.root);
    expect(isolation.env.CLAUDE_CONFIG_DIR).toContain(isolation.root);
    expect(isolation.env.XDG_CONFIG_HOME).toContain(isolation.root);
    if (process.platform !== "win32") {
      expect((await stat(isolation.root)).mode & 0o777).toBe(0o700);
      expect((await stat(isolation.env.CLAUDE_CONFIG_DIR)).mode & 0o777).toBe(0o700);
    }
    await isolation.cleanup();
    await expect(access(isolation.root)).rejects.toThrow();
  });

  it("returns sanitized discovered rows, keeps the versioned fallback complete, and cleans up", async () => {
    const child = new FakeChild();
    let capturedOptions;
    let root;
    const forkProcess = vi.fn((_file, _args, options) => {
      capturedOptions = options;
      queueMicrotask(() => child.emit("message", {
        type: "claude_catalog",
        account: { email: "never-return-this@example.com", tokenSource: "oauth" },
        models: [{
          value: "opus",
          resolvedModel: "claude-opus-4-8",
          description: "Opus 4.8",
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          supportsAdaptiveThinking: true,
          supportsFastMode: true,
          tokenSource: "never-return-this",
        }],
      }));
      return child;
    });

    const models = await discoverClaudeSdkModels({
      forkProcess,
      authoredModelRefs: ["claude:claude-fable-5"],
      onIsolation: (isolation) => { root = isolation.root; },
    });
    expect(capturedOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "claude-opus-4-8", source: "discovered" }),
      expect.objectContaining({ model: "claude-opus-4-8[1m]", source: "cached" }),
      expect.objectContaining({ model: "claude-sonnet-5" }),
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
      expect.objectContaining({ model: "claude-fable-5", reference: "claude:claude-fable-5" }),
    ]));
    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain("never-return-this");
    expect(serialized).not.toContain("tokenSource");
    await expect(access(root)).rejects.toThrow();
  });

  it("aborts a stuck worker and falls back without exposing an error", async () => {
    const child = new FakeChild();
    const models = await discoverClaudeSdkModels({
      timeoutMs: 5,
      forkProcess: () => child,
      authoredModelRefs: ["claude:claude-opus-4-8"],
    });
    expect(child.sent).toContainEqual({ type: "abort" });
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "claude-opus-4-8", source: "cached" }),
      expect.objectContaining({ model: "claude-opus-4-8[1m]", source: "cached" }),
    ]));
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.every((model) => model.source === "cached")).toBe(true);
  });
});
