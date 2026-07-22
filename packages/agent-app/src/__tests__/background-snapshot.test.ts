import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../background-snapshot-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../background-snapshot-key.js")>();
  const key = Buffer.alloc(32, 0x42);
  return {
    ...actual,
    loadBackgroundSnapshotKey: async () => Buffer.from(key),
    loadOrCreateBackgroundSnapshotKey: async () => Buffer.from(key),
  };
});

import {
  backgroundSnapshotFromMetadata,
  captureBackgroundSnapshot,
  captureDurableBackgroundInputs,
  captureDurableBackgroundSnapshot,
  decodeBackgroundSnapshot,
  encodeBackgroundSnapshot,
  materializeBackgroundRuntimeInputs,
  sameBackgroundSnapshot,
} from "../background-snapshot.js";
import {
  fingerprintBackgroundOperationalEnvironment,
  selectBackgroundOperationalEnvironment,
} from "../background-environment.js";
import { managedBackgroundEnvironment, resolveInstanceTarget } from "../background.js";
import { effectiveFirstRunEnvironment, resolveEffectivePiAuthPath } from "../first-run-readiness.js";
import { composeWizardPlan, defaultAnswers } from "../wizard/answers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "background-snapshot-test-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\n## Role\n\nBe precise.\n", "utf8");
  await writeFile(join(dir, ".env"), "MODEL_API_KEY=top-secret\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
    runtime: { model: "pi:ollama:qwen3:8b", workspace: "." },
    context: { identityPath: "IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
  }), "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("background worker snapshots", () => {
  it("captures secret-free file and operational-environment proof", async () => {
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" },
    });

    expect(snapshot.configPath).toBe(join(dir, "mono-agent.config.json"));
    expect(snapshot.dotenvPath).toBe(join(dir, ".env"));
    expect(snapshot.identityPath).toBe(join(dir, "IDENTITY.md"));
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("top-secret");
    for (const contents of [
      await readFile(join(dir, "mono-agent.config.json")),
      await readFile(join(dir, ".env")),
      await readFile(join(dir, "IDENTITY.md")),
    ]) {
      expect(serialized).not.toContain(createHash("sha256").update(contents).digest("hex"));
    }
    expect(backgroundSnapshotFromMetadata({ backgroundSnapshot: snapshot })).toEqual(snapshot);
    expect(backgroundSnapshotFromMetadata({ backgroundSnapshot: { ...snapshot, configDigest: "" } })).toBeUndefined();
  });

  it("round-trips the secret-free internal LaunchAgent snapshot and rejects malformed values", async () => {
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" },
    });
    const encoded = encodeBackgroundSnapshot(snapshot);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain("top-secret");
    expect(decodeBackgroundSnapshot(encoded)).toEqual(snapshot);
    expect(() => decodeBackgroundSnapshot("not+base64url"))
      .toThrow("managed background snapshot argument is malformed");
    expect(() => decodeBackgroundSnapshot(Buffer.from(JSON.stringify({ schema: "wrong" })).toString("base64url")))
      .toThrow("invalid schema");
  });

  it("detects config, dotenv, identity, and operational environment drift", async () => {
    const baseline = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/one", MODEL_API_KEY: "top-secret" },
    });

    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\n## Role\n\nChanged.\n", "utf8");
    const identityChanged = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/one", MODEL_API_KEY: "top-secret" },
    });
    expect(sameBackgroundSnapshot(baseline, identityChanged)).toBe(false);

    const environmentChanged = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/two", MODEL_API_KEY: "top-secret" },
    });
    expect(sameBackgroundSnapshot(identityChanged, environmentChanged)).toBe(false);

    await writeFile(join(dir, ".env"), "MODEL_API_KEY=rotated\n", { encoding: "utf8", mode: 0o600 });
    const dotenvChanged = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/two", MODEL_API_KEY: "rotated" },
    });
    expect(sameBackgroundSnapshot(environmentChanged, dotenvChanged)).toBe(false);
  });

  it("includes optional Soul proof and rejects incomplete Soul metadata", async () => {
    await writeFile(join(dir, "SOUL.md"), "# Soul\n\nStay kind.\n", "utf8");
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:ollama:qwen3:8b", workspace: "." },
      context: { identityPath: "IDENTITY.md", soulPath: "SOUL.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
    }), "utf8");
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" },
    });

    expect(snapshot.soulPath).toBe(join(dir, "SOUL.md"));
    expect(snapshot.soulFingerprint).toMatch(/^file:/u);
    expect(JSON.stringify(snapshot)).not.toContain(
      createHash("sha256").update("# Soul\n\nStay kind.\n").digest("hex"),
    );
    expect(backgroundSnapshotFromMetadata({ backgroundSnapshot: snapshot })).toEqual(snapshot);
    expect(backgroundSnapshotFromMetadata({
      backgroundSnapshot: { ...snapshot, soulFingerprint: undefined },
    })).toBeUndefined();
    expect(backgroundSnapshotFromMetadata({
      backgroundSnapshot: { ...snapshot, soulPath: undefined },
    })).toBeUndefined();
  });

  it("detects byte-for-byte edit restoration through keyed file proof", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const original = await readFile(configPath, "utf8");
    const before = await captureBackgroundSnapshot({
      cwd: dir,
      configPath,
      envFile: ".env",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" },
    });
    await writeFile(configPath, `${original}\n`, "utf8");
    await writeFile(configPath, original, "utf8");
    const restored = await captureBackgroundSnapshot({
      cwd: dir,
      configPath,
      envFile: ".env",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" },
    });

    expect(restored.configFingerprint).not.toBe(before.configFingerprint);
    expect(sameBackgroundSnapshot(restored, before)).toBe(false);
  });

  it("materializes exact config, Identity, and Soul bytes into an owner-only startup copy", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const identityPath = join(dir, "IDENTITY.md");
    const soulPath = join(dir, "SOUL.md");
    await writeFile(soulPath, "# Soul\n\nOriginal soul.\n", "utf8");
    const originalConfig = JSON.stringify({
      runtime: { model: "pi:ollama:qwen3:8b", workspace: "." },
      context: { identityPath: "IDENTITY.md", soulPath: "SOUL.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
    });
    await writeFile(configPath, originalConfig, "utf8");
    const environment = { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" };
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath,
      envFile: ".env",
      env: environment,
    });
    const runtimeInputs = await materializeBackgroundRuntimeInputs({
      snapshot,
      cwd: dir,
      env: environment,
      runtimeRoot: join(dir, "runtime-inputs"),
    });
    const privateIdentityPath = runtimeInputs.environment.MONO_AGENT_IDENTITY_PATH;
    const privateSoulPath = runtimeInputs.environment.MONO_AGENT_SOUL_PATH;
    expect(privateIdentityPath).toBeTypeOf("string");
    expect(privateSoulPath).toBeTypeOf("string");

    try {
      await writeFile(configPath, "{}", "utf8");
      await writeFile(identityPath, "changed identity", "utf8");
      await writeFile(soulPath, "changed soul", "utf8");
      expect(await readFile(runtimeInputs.configPath, "utf8")).toBe(originalConfig);
      expect(await readFile(privateIdentityPath!, "utf8")).toContain("Be precise.");
      expect(await readFile(privateSoulPath!, "utf8")).toContain("Original soul.");
      expect((await stat(runtimeInputs.configPath)).mode & 0o777).toBe(0o400);
    } finally {
      await runtimeInputs.dispose();
    }
    await expect(stat(runtimeInputs.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("freezes the approved MCP authority file and forces the worker to its private copy", async () => {
    const mcpConfigPath = join(dir, "mcp.json");
    const approvedMcp = JSON.stringify({
      mcpServers: { safe: { command: "/usr/bin/true", args: [] } },
    });
    await writeFile(mcpConfigPath, approvedMcp, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:ollama:qwen3:8b", workspace: "." },
      context: { identityPath: "IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [], mcpConfigPath: "./mcp.json" },
    }), "utf8");
    const environment = { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" };
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: environment,
    });

    expect(snapshot.mcpConfigPath).toBe(mcpConfigPath);
    expect(snapshot.mcpConfigFingerprint).toMatch(/^file:/u);
    expect(JSON.stringify(snapshot)).not.toContain(
      createHash("sha256").update(approvedMcp).digest("hex"),
    );
    expect(backgroundSnapshotFromMetadata({
      backgroundSnapshot: { ...snapshot, mcpConfigFingerprint: undefined },
    })).toBeUndefined();

    const runtimeInputs = await materializeBackgroundRuntimeInputs({
      snapshot,
      cwd: dir,
      env: environment,
      runtimeRoot: join(dir, "runtime-inputs"),
    });
    const privateMcpPath = runtimeInputs.environment.MONO_AGENT_MCP_CONFIG_PATH;
    expect(privateMcpPath).toBeTypeOf("string");
    expect(privateMcpPath).not.toBe(mcpConfigPath);
    expect(await readFile(privateMcpPath!, "utf8")).toBe(approvedMcp);
    expect((await stat(privateMcpPath!)).mode & 0o777).toBe(0o400);

    try {
      await writeFile(mcpConfigPath, JSON.stringify({
        mcpServers: { changed: { command: "/usr/bin/false", args: [] } },
      }), "utf8");
      expect(await readFile(privateMcpPath!, "utf8")).toBe(approvedMcp);
    } finally {
      await runtimeInputs.dispose();
    }
  });

  it("rejects MCP authority drift before any private worker inputs survive", async () => {
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:ollama:qwen3:8b", workspace: "." },
      context: { identityPath: "IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [], mcpConfigPath: "./mcp.json" },
    }), "utf8");
    const environment = { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" };
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: environment,
    });
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: { unapproved: { command: "/tmp/unapproved" } },
    }), "utf8");
    const runtimeRoot = join(dir, "runtime-inputs");

    await expect(materializeBackgroundRuntimeInputs({
      snapshot,
      cwd: dir,
      env: environment,
      runtimeRoot,
    })).rejects.toThrow("approved snapshot changed");
    await expect(readdir(runtimeRoot)).resolves.toEqual([]);
  });

  it("refuses a controller-approved snapshot after config drift, before private runtime inputs exist", async () => {
    const environment = { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" };
    const snapshot = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: environment,
    });
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:ollama:changed", workspace: "." },
      context: { identityPath: "IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
    }), "utf8");
    const runtimeRoot = join(dir, "runtime-inputs");

    await expect(materializeBackgroundRuntimeInputs({
      snapshot,
      cwd: dir,
      env: environment,
      runtimeRoot,
    })).rejects.toThrow("approved snapshot changed");
    await expect(readdir(runtimeRoot)).resolves.toEqual([]);
  });

  it("refuses a symlinked identity file", async () => {
    const realIdentity = join(dir, "REAL-IDENTITY.md");
    await writeFile(realIdentity, "# Identity\n", "utf8");
    await rm(join(dir, "IDENTITY.md"));
    await symlink(realIdentity, join(dir, "IDENTITY.md"));

    await expect(captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" },
    })).rejects.toThrow("symbolic link");
  });

  it("refuses to attest dotenv bytes that are not the worker's effective values", async () => {
    await expect(captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "shell-only-different-value" },
    })).rejects.toThrow("effective MODEL_API_KEY value does not match");
  });

  it("refuses an effective non-operational value that is absent from the current dotenv", async () => {
    await expect(captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: {
        HOME: dir,
        PATH: "/safe/bin",
        MODEL_API_KEY: "top-secret",
        MONO_AGENT_IDENTITY_PATH: "stale-value-from-an-earlier-dotenv-read",
      },
    })).rejects.toThrow("effective MONO_AGENT_IDENTITY_PATH value is not present");
  });

  it("reconstructs the managed worker from dotenv plus only operational plist values", async () => {
    const snapshot = await captureDurableBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      operationalEnvironment: {
        HOME: dir,
        PATH: "/managed/bin",
        MONO_AGENT_MODEL: "shell-override-must-not-win",
        UNPERSISTED_API_KEY: "shell-secret-must-not-win",
      },
    });
    expect(snapshot.operationalEnvironmentFingerprint).toBe(
      fingerprintBackgroundOperationalEnvironment({ HOME: dir, PATH: "/managed/bin" }),
    );
  });

  it("uses one durable environment for a default wizard snapshot, target, and worker recapture", async () => {
    const canonicalDir = await realpath(dir);
    await rm(join(dir, ".env"));
    const plan = composeWizardPlan(defaultAnswers(), {
      dirBasename: "default-wizard-agent",
      skillsRootExists: false,
    });
    await writeFile(
      join(dir, "mono-agent.config.json"),
      `${JSON.stringify(plan.configJson, null, 2)}\n`,
      "utf8",
    );
    const postWriteEnvironment = effectiveFirstRunEnvironment({
      shellEnv: { HOME: dir, PATH: "/wizard/bin" },
      dotenvEnv: {},
      resolvedPiAuthPath: resolveEffectivePiAuthPath({ cwd: canonicalDir }),
    });
    expect(postWriteEnvironment.MONO_AGENT_PI_AUTH_PATH).toBeTypeOf("string");

    const durable = await captureDurableBackgroundInputs({
      cwd: canonicalDir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      operationalEnvironment: managedBackgroundEnvironment(postWriteEnvironment),
    });
    expect(durable.environment).not.toHaveProperty("MONO_AGENT_PI_AUTH_PATH");
    expect(durable.snapshot.dotenvPath).toBe(join(canonicalDir, ".env"));
    expect(durable.snapshot.dotenvFingerprint).toBe("missing");
    expect(sameBackgroundSnapshot(durable.snapshot, await captureBackgroundSnapshot({
      cwd: canonicalDir,
      configPath: "mono-agent.config.json",
      env: durable.environment,
    }))).toBe(true);

    const target = await resolveInstanceTarget({
      args: { configPath: "mono-agent.config.json" },
      env: { ...durable.environment },
      cwd: canonicalDir,
      cliPath: join(dir, "managed-cli.js"),
    });
    expect(target.envFile).toBeUndefined();
    expect(target.configurationEnvironment).toEqual(durable.environment);
    expect(sameBackgroundSnapshot(durable.snapshot, await captureBackgroundSnapshot({
      cwd: target.cwd,
      configPath: target.configPath,
      ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
      env: target.configurationEnvironment,
    }))).toBe(true);
  });

  it("detects dotenv edit-and-restore without publishing a content verifier", async () => {
    const environment = { HOME: dir, PATH: "/safe/bin", MODEL_API_KEY: "top-secret" };
    const before = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: environment,
    });
    await writeFile(join(dir, ".env"), "MODEL_API_KEY=rotated\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(dir, ".env"), "MODEL_API_KEY=top-secret\n", { encoding: "utf8", mode: 0o600 });
    const restored = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: environment,
    });

    expect(restored.dotenvFingerprint).not.toBe(before.dotenvFingerprint);
    expect(JSON.stringify(restored)).not.toContain(
      createHash("sha256").update("MODEL_API_KEY=top-secret\n").digest("hex"),
    );
  });
});

describe("background operational environment", () => {
  it("selects only the non-secret allowlist and fingerprints values deterministically", () => {
    const env = {
      PATH: "/safe/bin",
      HOME: "/home/u",
      MONO_AGENT_MODEL: "must-not-persist",
      OPENAI_API_KEY: "must-not-persist",
    };
    expect(selectBackgroundOperationalEnvironment(env)).toEqual({ HOME: "/home/u", PATH: "/safe/bin" });
    expect(fingerprintBackgroundOperationalEnvironment(env)).toBe(
      fingerprintBackgroundOperationalEnvironment({ HOME: "/home/u", PATH: "/safe/bin" }),
    );
    expect(fingerprintBackgroundOperationalEnvironment({ HOME: "/other", PATH: "/safe/bin" })).not.toBe(
      fingerprintBackgroundOperationalEnvironment(env),
    );
  });

  it("uses the same normalized PATH for the approved snapshot and the launchd worker", async () => {
    const operational = managedBackgroundEnvironment({ HOME: dir, PATH: "/wizard/bin" });
    expect(operational.PATH).toBe("/wizard/bin:/opt/homebrew/bin:/usr/local/bin");

    const approved = await captureDurableBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      operationalEnvironment: operational,
    });
    const workerEnvironment: Record<string, string | undefined> = {
      ...operational,
      MODEL_API_KEY: "top-secret",
    };
    delete workerEnvironment.MONO_AGENT_MANAGED_WORKER;
    const worker = await captureBackgroundSnapshot({
      cwd: dir,
      configPath: "mono-agent.config.json",
      envFile: ".env",
      env: workerEnvironment,
    });
    expect(sameBackgroundSnapshot(approved, worker)).toBe(true);
  });
});
