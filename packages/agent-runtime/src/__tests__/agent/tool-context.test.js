import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFakeSandbox, testSandboxPolicy as failClosedSandboxPolicy } from "../helpers/fake-sandbox.js";
import {
  createToolContext,
  updateToolContext,
  resetToolContext,
  resolveSandboxPolicy,
} from "../../agent/tools/shared/tool-context.js";
import {
  configureToolRuntime,
  readToolRuntime,
  resetToolRuntime,
} from "../../agent/tools/shared/runtime-context.js";
import { DEFAULT_RUNTIME_BRAND } from "../../runtime-brand.js";
import { readToolImpl } from "../../agent/tools/index.js";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-tool-ctx-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetToolRuntime();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("createToolContext", () => {
  it("copies recognized data keys and resolves the brand", () => {
    const ctx = createToolContext({
      workspace: "/tmp/w",
      repoRoot: "/tmp/r",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
      runId: "run-1",
      toolArtifactDir: "/tmp/art",
      runtimeBrand: { schemaPrefix: "demo" },
    });
    expect(ctx.workspace).toBe("/tmp/w");
    expect(ctx.repoRoot).toBe("/tmp/r");
    expect(ctx.ripgrepPath).toBe("/usr/bin/rg");
    expect(ctx.qaOutputDir).toBe("/tmp/qa");
    expect(ctx.runId).toBe("run-1");
    expect(ctx.toolArtifactDir).toBe("/tmp/art");
    expect(ctx.runtimeBrand.schemaPrefix).toBe("demo");
    // Unspecified brand fields fall back to the defaults.
    expect(ctx.runtimeBrand.tempdirPrefix).toBe(DEFAULT_RUNTIME_BRAND.tempdirPrefix);
  });

  it("defaults the brand to DEFAULT_RUNTIME_BRAND and ignores unknown keys", () => {
    const ctx = createToolContext({ workspace: "/tmp/w", bogus: "nope" });
    expect(ctx.runtimeBrand).toEqual(DEFAULT_RUNTIME_BRAND);
    expect(ctx.bogus).toBeUndefined();
  });
});

describe("updateToolContext", () => {
  it("mutates in place, leaving untouched keys and returning the same reference", () => {
    const ctx = createToolContext({ workspace: "/tmp/w", ripgrepPath: "/usr/bin/rg" });
    const returned = updateToolContext(ctx, { workspace: "/tmp/updated" });
    expect(returned).toBe(ctx);
    expect(ctx.workspace).toBe("/tmp/updated");
    expect(ctx.ripgrepPath).toBe("/usr/bin/rg");
  });

  it("re-resolves the brand only when runtimeBrand is present", () => {
    const ctx = createToolContext({ runtimeBrand: { schemaPrefix: "one" } });
    updateToolContext(ctx, { workspace: "/tmp/w" });
    expect(ctx.runtimeBrand.schemaPrefix).toBe("one");
    updateToolContext(ctx, { runtimeBrand: { schemaPrefix: "two" } });
    expect(ctx.runtimeBrand.schemaPrefix).toBe("two");
  });
});

describe("resetToolContext", () => {
  it("clears data keys and restores the default brand", () => {
    const ctx = createToolContext({ workspace: "/tmp/w", runtimeBrand: { schemaPrefix: "demo" } });
    resetToolContext(ctx);
    expect(ctx.workspace).toBeUndefined();
    expect(ctx.runtimeBrand).toEqual(DEFAULT_RUNTIME_BRAND);
  });
});

describe("resolveSandboxPolicy (I13 monotonic merge)", () => {
  it("returns the context policy when no request policy tightens it", () => {
    const ctx = createToolContext({
      sandbox: createFakeSandbox(),
      sandboxPolicy: failClosedSandboxPolicy({ root: "/tmp/host" }),
    });
    const resolved = resolveSandboxPolicy(ctx, undefined);
    expect(resolved?.mode).toBe("native");
  });

  it("delegates the merge to ctx.sandbox.mergePolicies, passing both policies through untouched", () => {
    const calls = [];
    const hostPolicy = failClosedSandboxPolicy({ root: "/tmp/host" });
    const requestPolicy = failClosedSandboxPolicy({ root: "/tmp/host/sub" });
    const fake = createFakeSandbox();
    const ctx = createToolContext({
      sandboxPolicy: hostPolicy,
      sandbox: {
        ...fake,
        mergePolicies(configured, request) {
          calls.push([configured, request]);
          return fake.mergePolicies(configured, request);
        },
      },
    });
    const resolved = resolveSandboxPolicy(ctx, requestPolicy);
    expect(calls).toEqual([[hostPolicy, requestPolicy]]);
    // The delegated merge tightens readableRoots to the more specific request
    // root rather than weakening back to the host root (I13).
    expect(resolved?.readableRoots).toEqual([requestPolicy.root]);
  });

  it("falls back to passthroughSandbox's own monotonic merge when ctx carries no sandbox impl", () => {
    // A bare ToolContext-shaped object built without createToolContext (e.g. a
    // hand-rolled host object) still gets a safe default merge.
    const hostPolicy = { mode: "native", network: { mode: "none" } };
    const resolved = resolveSandboxPolicy({ sandboxPolicy: hostPolicy }, undefined);
    expect(resolved).toEqual(hostPolicy);
  });

  it("returns undefined when neither context nor request supplies a policy", () => {
    expect(resolveSandboxPolicy(createToolContext({}), undefined)).toBeUndefined();
    expect(resolveSandboxPolicy(undefined, undefined)).toBeUndefined();
  });
});

describe("per-instance vs default context divergence", () => {
  it("two contexts do not clobber each other and stay independent of the default", () => {
    const a = createToolContext({ workspace: "/tmp/a", runtimeBrand: { schemaPrefix: "aa" } });
    const b = createToolContext({ workspace: "/tmp/b", runtimeBrand: { schemaPrefix: "bb" } });
    updateToolContext(a, { workspace: "/tmp/a-updated" });
    expect(a.workspace).toBe("/tmp/a-updated");
    expect(b.workspace).toBe("/tmp/b");
    expect(a.runtimeBrand.schemaPrefix).toBe("aa");
    expect(b.runtimeBrand.schemaPrefix).toBe("bb");
    // The module-default context is a separate object, untouched by either.
    expect(readToolRuntime().workspace).toBeUndefined();
  });

  it("a real tool resolves against the threaded ctx workspace, falling back to the default when ctx is absent", async () => {
    const defaultWs = tempDir();
    const ctxWs = tempDir();
    // The target file exists ONLY inside the per-instance workspace.
    writeFileSync(resolve(ctxWs, "target.txt"), "hello from ctx", "utf8");
    // The deep/worklab default path configures the process-global context.
    configureToolRuntime({ workspace: defaultWs });

    const ctx = createToolContext({ workspace: ctxWs });
    // With the instance ctx threaded, the relative path resolves under ctxWs.
    const withCtx = await readToolImpl({ file_path: "target.txt" }, { ctx });
    expect(withCtx).toContain("hello from ctx");

    // Without a ctx, the same call falls back to the default context (defaultWs),
    // where the file does not exist — proving the two paths are genuinely distinct.
    const withoutCtx = await readToolImpl({ file_path: "target.txt" }, {});
    expect(withoutCtx).toContain("Error: File not found");
  });
});
