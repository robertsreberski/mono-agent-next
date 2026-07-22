import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateMonoAgentFolder } from "../doctor.js";
import {
  FIRST_RUN_MEMORY_INITIALIZING_MARKER,
  FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX,
  firstRunMemoryInitializationIsIncomplete,
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

  it("retains its claimed root and in-flight marker when initialization fails", async () => {
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

    expect(await readFile(join(root, FIRST_RUN_MEMORY_INITIALIZING_MARKER), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]+\n$/u);
    await expect(access(join(root, ".index"))).rejects.toMatchObject({ code: "ENOENT" });
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

    expect(await readFile(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]+\n$/u);
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
    expect(await readFile(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER), "utf8"))
      .toMatch(/^initialized:[0-9a-f-]+\n$/u);
    expect((await readdir(finalRoot)).some((name) => name.startsWith(FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX)))
      .toBe(false);
    const completedReport = await validateMonoAgentFolder({
      cwd: dir,
      configPath,
      env: {},
      allowFilesystemWrites: true,
      liveness: false,
    });
    expect(completedReport.sections.find((section) => section.id === "memory")?.details.join("\n"))
      .not.toMatch(/initialization is incomplete/u);
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(finalRoot)?.rollback).toBeUndefined();
  });

  it.each([
    {
      label: "content is malformed",
      mutate: async (path: string) => await writeFile(path, "initialized:forged\n"),
    },
    {
      label: "mode is permissive",
      mutate: async (path: string) => await chmod(path, 0o644),
    },
    {
      label: "inode gains another link",
      mutate: async (path: string) => await link(path, `${path}.alias`),
    },
  ])("doctor fails closed when a committed canonical marker's $label", async ({ mutate }) => {
    const plan = localPrivatePlan();
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify(plan.configJson));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const result = await initializeFirstRunManagedMemory({ agentRoot: dir, plan });
    await mutate(join(result.root!, FIRST_RUN_MEMORY_INITIALIZING_MARKER));

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

  it("fails closed when committed marker bytes change after the first descriptor read", async () => {
    const result = await initializeFirstRunManagedMemory({ agentRoot: dir, plan: localPrivatePlan() });
    const markerPath = join(result.root!, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    const forged = "initialized:00000000-0000-4000-8000-000000000000\n";

    await expect(firstRunMemoryInitializationIsIncomplete(result.root!, {
      afterMarkerRead: async (candidate) => {
        expect(candidate).toBe(markerPath);
        await writeFile(candidate, forged);
      },
    })).resolves.toBe(true);

    expect(await readFile(markerPath, "utf8")).toBe(forged);
  });

  it("fails closed when committed marker permissions change after the first descriptor read", async () => {
    const result = await initializeFirstRunManagedMemory({ agentRoot: dir, plan: localPrivatePlan() });
    const markerPath = join(result.root!, FIRST_RUN_MEMORY_INITIALIZING_MARKER);

    await expect(firstRunMemoryInitializationIsIncomplete(result.root!, {
      afterMarkerRead: async (candidate) => {
        expect(candidate).toBe(markerPath);
        await chmod(candidate, 0o644);
      },
    })).resolves.toBe(true);

    expect((await lstat(markerPath)).mode & 0o777).toBe(0o644);
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

  it("retains both inodes when the canonical marker is swapped before descriptor commit", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    let ownedMarkerPath = "";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeMarkerCommit: async (candidate) => {
          expect(candidate).toBe(markerPath);
          ownedMarkerPath = `${candidate}.owned-marker`;
          await rename(candidate, ownedMarkerPath);
          await writeFile(candidate, "pre-commit replacement\n");
        },
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe("pre-commit replacement\n");
    expect(await readFile(ownedMarkerPath, "utf8")).toMatch(/^initializing:[0-9a-f-]+\n$/u);
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("fails closed when the canonical marker loses owner-only mode before descriptor commit", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeMarkerCommit: async (candidate) => await chmod(candidate, 0o644),
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect((await lstat(markerPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(markerPath, "utf8")).toMatch(/^initializing:[0-9a-f-]+\n$/u);
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("retains both inodes when the canonical marker is swapped after descriptor commit", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    let ownedMarkerPath = "";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterMarkerCommitted: async (candidate) => {
          expect(candidate).toBe(markerPath);
          ownedMarkerPath = `${candidate}.owned-marker`;
          await rename(candidate, ownedMarkerPath);
          await writeFile(candidate, "post-commit replacement\n");
        },
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe("post-commit replacement\n");
    expect(await readFile(ownedMarkerPath, "utf8")).toMatch(/^initialized:[0-9a-f-]+\n$/u);
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("rejects same-inode content replacement after descriptor commit", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    const forged = "initialized:00000000-0000-4000-8000-000000000000\n";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterMarkerCommitted: async (candidate) => await writeFile(candidate, forged),
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe(forged);
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("reports an in-flight canonical marker as incomplete when commit is interrupted", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const plan = localPrivatePlan();
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify(plan.configJson));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");

    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan,
      hooks: {
        beforeMarkerCommit: async () => { throw new Error("injected pre-commit failure"); },
      },
    })).rejects.toThrow("injected pre-commit failure");

    expect(await readFile(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER), "utf8"))
      .toMatch(/^initializing:[0-9a-f-]+\n$/u);
    expect((await readdir(finalRoot)).some((name) => name.startsWith(FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX)))
      .toBe(false);
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
