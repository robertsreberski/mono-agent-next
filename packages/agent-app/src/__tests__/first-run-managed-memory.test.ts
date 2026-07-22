import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateMonoAgentFolder } from "../doctor.js";
import {
  FIRST_RUN_MEMORY_INITIALIZING_MARKER,
  FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX,
  initializeFirstRunManagedMemory,
} from "../first-run-managed-memory.js";
import { composeWizardPlan } from "../wizard/answers.js";
import { findPreset, presetAnswers } from "../wizard/presets.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-first-memory-"));
  await mkdir(join(dir, ".mono-agent"));
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const value = String(url);
    if (value.endsWith("/api/embed")) {
      return new Response(JSON.stringify({ embeddings: [new Array<number>(768).fill(0.01)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected first-run embeddings request: ${value}`);
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function localPrivatePlan() {
  return composeWizardPlan(presetAnswers(findPreset("local-private")!), {
    dirBasename: "first-memory",
    skillsRootExists: false,
  });
}

function lmStudioPlan(options: { readonly apiKeyEnv?: string; readonly dimension?: number } = {}) {
  const base = localPrivatePlan();
  return {
    ...base,
    configJson: {
      ...base.configJson,
      memory: {
        ...base.configJson.memory!,
        embeddings: {
          provider: "lmstudio" as const,
          model: "text-embedding-test",
          endpoint: "http://localhost:1234",
          dim: options.dimension ?? 4,
          ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }),
        },
      },
    },
  };
}

describe("initializeFirstRunManagedMemory", () => {
  it("proves keyless LM Studio embeddings before publishing their exact managed identity", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await initializeFirstRunManagedMemory({ agentRoot: dir, plan: lmStudioPlan() });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:1234/v1/embeddings");
    expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/json" });
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(result.root!)?.active).toMatchObject({
      tier: "journal",
      embeddingModel: "lmstudio:text-embedding-test",
      dimension: 4,
    });
  });

  it("resolves a declared LM Studio credential only from the supplied effective environment", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: lmStudioPlan({ apiKeyEnv: "LM_STUDIO_API_KEY" }),
      env: { LM_STUDIO_API_KEY: "effective-token" },
    });

    expect(calls[0]?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer effective-token",
    });
  });

  it("rejects a declared missing LM Studio credential without probing or claiming the root", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("must not probe keyless"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: lmStudioPlan({ apiKeyEnv: "LM_STUDIO_API_KEY" }),
      env: {},
    })).rejects.toThrow(/LM_STUDIO_API_KEY.*no non-empty value/iu);

    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(access(join(dir, ".mono-agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not claim the managed root when LM Studio is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(initializeFirstRunManagedMemory({ agentRoot: dir, plan: lmStudioPlan() }))
      .rejects.toThrow(/LM Studio embedding probe.*could not connect/iu);

    await expect(access(join(dir, ".mono-agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "malformed", payload: { data: [{ embedding: [] }] }, error: /invalid embedding vector/iu },
    { label: "wrong-dimension", payload: { data: [{ embedding: [1, 0] }] }, error: /dimension 2.*configured dimension is 4/iu },
  ])("does not publish a root when the LM Studio proof is $label", async ({ payload, error }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(initializeFirstRunManagedMemory({ agentRoot: dir, plan: lmStudioPlan() })).rejects.toThrow(error);

    await expect(access(join(dir, ".mono-agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "escaping", path: "../outside-memory" },
    { label: "absolute", path: "/tmp/outside-memory" },
    { label: "root", path: "." },
  ])("rejects a $label configured path before claiming anything", async ({ path }) => {
    const base = localPrivatePlan();
    const plan = {
      ...base,
      configJson: {
        ...base.configJson,
        memory: { ...base.configJson.memory!, path },
      },
    };

    await expect(initializeFirstRunManagedMemory({ agentRoot: dir, plan }))
      .rejects.toThrow(/Refusing first-run managed memory/u);
    await expect(access(join(dir, ".mono-agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a root and its contents untouched when another creator wins the claim race", async () => {
    const root = join(await realpath(dir), ".mono-agent", "memory");
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeRootClaim: async (candidate) => {
          expect(candidate).toBe(root);
          await mkdir(candidate);
          await writeFile(join(candidate, "sentinel"), "external-winner\n");
        },
      },
    })).rejects.toThrow(/another creator won/u);

    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("external-winner\n");
  });

  it("cleans only its claimed root when initialization fails", async () => {
    const root = join(dir, ".mono-agent", "memory");
    const sibling = join(dir, ".mono-agent", "keep.txt");
    await writeFile(sibling, "keep\n");

    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeRebuild: async () => { throw new Error("injected rebuild failure"); },
      },
    })).rejects.toThrow("injected rebuild failure");

    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sibling, "utf8")).toBe("keep\n");
  });

  it("preserves raced external content when a claimed staging root fails", async () => {
    const finalRoot = join(dir, ".mono-agent", "memory");
    let stagingRoot = "";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeRebuild: async (candidate) => {
          stagingRoot = candidate;
          await writeFile(join(candidate, "external-sentinel"), "external\n");
          throw new Error("external race");
        },
      },
    })).rejects.toThrow("external race");

    await expect(access(finalRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(stagingRoot, "external-sentinel"), "utf8")).toBe("external\n");
  });

  it("publishes only a complete managed generation at the final root", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    let stagingRoot = "";
    const plan = localPrivatePlan();
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify(plan.configJson));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const result = await initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan,
      hooks: {
        beforePromotion: async (candidate, destination) => {
          stagingRoot = candidate;
          expect(destination).toBe(finalRoot);
          await access(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER));
          await expect(access(join(finalRoot, ".index"))).rejects.toMatchObject({ code: "ENOENT" });
          const report = await validateMonoAgentFolder({
            cwd: dir,
            configPath,
            env: {},
            allowFilesystemWrites: true,
            liveness: false,
          });
          expect(report.sections.find((section) => section.id === "memory")).toMatchObject({
            status: "error",
            details: expect.arrayContaining([expect.stringMatching(/initialization is incomplete/u)]),
          });
          const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
          expect(readManagedIndexManifest(candidate)).toMatchObject({
            active: {
              tier: "journal",
              embeddingModel: "ollama:nomic-embed-text:v1.5",
              dimension: 768,
            },
          });
        },
      },
    });

    expect(result).toEqual({ initialized: true, root: finalRoot });
    await expect(access(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(finalRoot)?.rollback).toBeUndefined();
  });

  it("does not replace an external final root created at promotion time", async () => {
    const finalRoot = join(dir, ".mono-agent", "memory");
    let stagingRoot = "";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforePromotion: async (candidate) => {
          stagingRoot = candidate;
          await rm(finalRoot, { recursive: true });
          await mkdir(finalRoot);
          await writeFile(join(finalRoot, "external-sentinel"), "winner\n");
        },
      },
    })).rejects.toThrow(/claimed root changed/u);

    expect(await readFile(join(finalRoot, "external-sentinel"), "utf8")).toBe("winner\n");
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(stagingRoot)?.active.tier).toBe("journal");
  });

  it("never overwrites an empty .index raced immediately before publication", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    let racedIndexIdentity: { readonly dev: number; readonly ino: number } | undefined;
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforePromotion: async () => {
          const racedIndex = join(finalRoot, ".index");
          await mkdir(racedIndex);
          const pathStat = await lstat(racedIndex);
          racedIndexIdentity = { dev: pathStat.dev, ino: pathStat.ino };
        },
      },
    })).rejects.toThrow(/claimed root changed before publication/u);

    const after = await lstat(join(finalRoot, ".index"));
    expect({ dev: after.dev, ino: after.ino }).toEqual(racedIndexIdentity);
    await expect(access(join(finalRoot, ".index", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the fail-closed marker when failure follows the manifest authority link", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterManifestLinked: async (publishedRoot) => {
          expect(publishedRoot).toBe(finalRoot);
          await access(join(finalRoot, ".index", "manifest.json"));
          throw new Error("injected manifest source-cleanup failure");
        },
      },
    })).rejects.toThrow("injected manifest source-cleanup failure");

    await access(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER));
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("fails instead of reporting success when its exact marker is replaced after publication", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterManifestLinked: async () => {
          await rm(markerPath);
          await writeFile(markerPath, "external replacement\n");
        },
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe("external replacement\n");
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("leaves a replacement untouched when the marker changes at its release boundary", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeMarkerRelease: async (candidate) => {
          expect(candidate).toBe(markerPath);
          await rm(candidate);
          await writeFile(candidate, "release-boundary replacement\n");
        },
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe("release-boundary replacement\n");
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("retains a canonical replacement raced after marker quarantine", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterMarkerQuarantined: async (releasedPath, candidate) => {
          expect(candidate).toBe(markerPath);
          await access(releasedPath);
          await writeFile(candidate, "post-quarantine replacement\n");
        },
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe("post-quarantine replacement\n");
    expect((await readdir(finalRoot)).some((name) => name.startsWith(FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX)))
      .toBe(true);
  });

  it("reports a quarantined marker as incomplete when release fails after rename", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const plan = localPrivatePlan();
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify(plan.configJson));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");

    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan,
      hooks: {
        afterMarkerQuarantined: async () => { throw new Error("injected post-quarantine failure"); },
      },
    })).rejects.toThrow("injected post-quarantine failure");

    await expect(access(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(finalRoot)).some((name) => name.startsWith(FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX)))
      .toBe(true);
    const report = await validateMonoAgentFolder({
      cwd: dir,
      configPath,
      env: {},
      allowFilesystemWrites: true,
      liveness: false,
    });
    expect(report.sections.find((section) => section.id === "memory")).toMatchObject({
      status: "error",
      details: expect.arrayContaining([expect.stringMatching(/initialization is incomplete/u)]),
    });
  });

  it("rejects a pinned parent replaced by a symlink before publication", async () => {
    const originalParent = join(dir, ".mono-agent");
    const holder = await mkdtemp(join(tmpdir(), "agent-app-first-memory-moved-parent-"));
    const movedParent = join(holder, "moved-mono-agent");
    try {
      await expect(initializeFirstRunManagedMemory({
        agentRoot: dir,
        plan: localPrivatePlan(),
        hooks: {
          beforePromotion: async () => {
            await rename(originalParent, movedParent);
            await symlink(movedParent, originalParent);
          },
        },
      })).rejects.toThrow(/pinned parent directory changed identity/u);

      await expect(access(join(movedParent, "memory", ".index", "manifest.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(originalParent, { recursive: true, force: true });
      await rm(holder, { recursive: true, force: true });
    }
  });

  it("detects a claimed-root symlink replacement without touching its target", async () => {
    const finalRoot = join(dir, ".mono-agent", "memory");
    let stagingRoot = "";
    const outside = await mkdtemp(join(tmpdir(), "agent-app-first-memory-outside-"));
    try {
      await writeFile(join(outside, "sentinel"), "outside\n");
      await expect(initializeFirstRunManagedMemory({
        agentRoot: dir,
        plan: localPrivatePlan(),
        hooks: {
          afterRootClaim: async (candidate) => {
            stagingRoot = candidate;
            await rm(candidate, { recursive: true });
            await symlink(outside, candidate);
          },
        },
      })).rejects.toThrow(/claimed root changed identity/u);

      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("outside\n");
      expect((await lstat(stagingRoot)).isSymbolicLink()).toBe(true);
      expect((await lstat(finalRoot)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
