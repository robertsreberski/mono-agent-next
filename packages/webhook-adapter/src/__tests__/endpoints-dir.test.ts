import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWebhookEndpointsFromDirectory,
  parseWebhookEndpointMarkdown,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-webhook-dir-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseWebhookEndpointMarkdown", () => {
  it("reads frontmatter routing and uses the body as the prompt", () => {
    const endpoint = parseWebhookEndpointMarkdown(
      "deep-research.md",
      [
        "---",
        "path: /webhook/deep-research",
        "mode: async",
        "enabled: true",
        "notify: true",
        "notifyConversationId: telegram:42",
        "---",
        "",
        "Check deep-research/requests/*.md and match the incoming request.",
        "After addressing it, move the file to deep-research/researched/.",
      ].join("\n"),
      "sync",
    );

    expect(endpoint).toEqual({
      name: "deep-research",
      path: "/webhook/deep-research",
      mode: "async",
      enabled: true,
      notify: true,
      notifyConversationId: "telegram:42",
      prompt:
        "Check deep-research/requests/*.md and match the incoming request.\nAfter addressing it, move the file to deep-research/researched/.",
    });
  });

  it("reads per-endpoint model and effort overrides from frontmatter", () => {
    const endpoint = parseWebhookEndpointMarkdown(
      "delegate.md",
      [
        "---",
        "path: /delegate",
        "model: claude:claude-opus-4-8",
        "effort: high",
        "maxRunMs: 45000",
        "---",
        "Run the delegated deep research.",
      ].join("\n"),
      "sync",
    );

    expect(endpoint.model).toBe("claude:claude-opus-4-8");
    expect(endpoint.effort).toBe("high");
    expect(endpoint.maxRunMs).toBe(45_000);
  });

  it("preserves maxRunMs zero as an explicit per-endpoint watchdog disable", () => {
    const endpoint = parseWebhookEndpointMarkdown(
      "unbounded.md",
      "---\npath: /unbounded\nmaxRunMs: 0\n---\nRun until complete.",
      "async",
    );

    expect(endpoint.maxRunMs).toBe(0);
  });

  it.each(["-1", "1.5", "86400001", "forever"])(
    "rejects invalid maxRunMs frontmatter value %s",
    (maxRunMs) => {
      expect(() => parseWebhookEndpointMarkdown(
        "invalid-timeout.md",
        `---\npath: /invalid\nmaxRunMs: ${maxRunMs}\n---\nRun.`,
        "sync",
      )).toThrowError(/maxRunMs/u);
    },
  );

  it("defaults name to the filename stem and mode to the provided default", () => {
    const endpoint = parseWebhookEndpointMarkdown("results.md", "---\npath: /results\n---\nFile it.", "async");
    expect(endpoint.name).toBe("results");
    expect(endpoint.mode).toBe("async");
    expect(endpoint.enabled).toBe(true);
  });

  it("allows an empty body (endpoint with no prompt)", () => {
    const endpoint = parseWebhookEndpointMarkdown("bare.md", "---\npath: /bare\n---\n\n   \n", "sync");
    expect(endpoint).toEqual({ name: "bare", path: "/bare", mode: "sync", enabled: true });
    expect(endpoint.prompt).toBeUndefined();
  });

  it("rejects a file with no path, naming the file", () => {
    let error: unknown;
    try {
      parseWebhookEndpointMarkdown("broken.md", "---\nmode: async\n---\nNo path here.", "sync");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_config", details: { file: "broken.md" } });
  });

  it("rejects an invalid mode", () => {
    expect(() => parseWebhookEndpointMarkdown("x.md", "---\npath: /x\nmode: fire\n---\nBody.", "sync")).toThrowError(
      /sync or async/u,
    );
  });

  it("rejects a non-boolean enabled value", () => {
    expect(() => parseWebhookEndpointMarkdown("x.md", "---\npath: /x\nenabled: maybe\n---\nBody.", "sync")).toThrowError(
      /enabled/u,
    );
  });

  it("rejects a non-boolean notify value", () => {
    expect(() => parseWebhookEndpointMarkdown("x.md", "---\npath: /x\nnotify: maybe\n---\nBody.", "sync")).toThrowError(
      /notify/u,
    );
  });

  it("treats a __proto__ frontmatter key as inert data", () => {
    const endpoint = parseWebhookEndpointMarkdown(
      "p.md",
      ["---", "__proto__: polluted", "path: /p", "---", "Body."].join("\n"),
      "sync",
    );
    expect(endpoint.path).toBe("/p");
    expect(({} as Record<string, unknown>).path).toBeUndefined();
  });
});

describe("loadWebhookEndpointsFromDirectory", () => {
  it("loads markdown endpoints in sorted filename order", async () => {
    await writeFile(join(dir, "b-second.md"), "---\npath: /second\n---\nSecond.", "utf8");
    await writeFile(join(dir, "a-first.md"), "---\npath: /first\n---\nFirst.", "utf8");

    const endpoints = await loadWebhookEndpointsFromDirectory(dir, "sync");
    expect(endpoints.map((endpoint) => endpoint.name)).toEqual(["a-first", "b-second"]);
  });

  it("ignores non-markdown files", async () => {
    await writeFile(join(dir, "hook.md"), "---\npath: /hook\n---\nReal.", "utf8");
    await writeFile(join(dir, "notes.txt"), "path: /nope", "utf8");

    const endpoints = await loadWebhookEndpointsFromDirectory(dir, "sync");
    expect(endpoints.map((endpoint) => endpoint.name)).toEqual(["hook"]);
  });

  it("returns no endpoints for a missing directory", async () => {
    const endpoints = await loadWebhookEndpointsFromDirectory(join(dir, "does-not-exist"), "sync");
    expect(endpoints).toEqual([]);
  });

  it("rejects two files that resolve to the same name", async () => {
    await writeFile(join(dir, "one.md"), "---\nname: shared\npath: /one\n---\nOne.", "utf8");
    await writeFile(join(dir, "two.md"), "---\nname: shared\npath: /two\n---\nTwo.", "utf8");

    await expect(loadWebhookEndpointsFromDirectory(dir, "sync")).rejects.toMatchObject({ code: "invalid_config" });
  });
});
