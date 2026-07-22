import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveActiveMemoryDbPath, safeRebuildMemoryIndex } from "@mono-agent/memory/bujo";

import { runCli } from "../cli.js";

let dir: string;
let previousCwd: string;
let previousMonoAgentEnv: Map<string, string>;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "agent-app-cli-validate-")));
  previousCwd = process.cwd();
  previousMonoAgentEnv = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      previousMonoAgentEnv.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      delete process.env[key];
    }
  }
  for (const [key, value] of previousMonoAgentEnv) {
    process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeConsumerConfig(
  consumerDir: string,
  fileName: string,
  json: Record<string, unknown>,
): Promise<string> {
  const configPath = join(consumerDir, fileName);
  await writeFile(configPath, JSON.stringify(json, null, 2), "utf8");
  return configPath;
}

async function seedManagedMemory(root: string, tier: "journal" | "bujo", embeddingModel: string): Promise<void> {
  await safeRebuildMemoryIndex({
    root,
    tier,
    embeddings: {
      id: embeddingModel,
      embed: async (texts) => texts.map(() => {
        const vector = new Array<number>(768).fill(0);
        vector[0] = 1;
        return vector;
      }),
    },
    dim: 768,
  });
}

async function captureRunCli(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);

  try {
    const code = await runCli(argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function closedLoopbackBaseUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Expected a loopback TCP address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return baseUrl;
}

describe("runCli doctor runtime provenance", () => {
  it("renders the unmanaged provenance of the CLI producing the report", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeConsumerConfig(dir, "mono-agent.config.json", {
      runtime: { model: "pi:openai-codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      providers: { piAuthPath: join(dir, "missing-auth.json") },
    });
    process.chdir(dir);

    const result = await captureRunCli(["doctor"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Runtime provenance: dev (unmanaged).");
    expect(result.stderr).toBe("");
  });
});

describe("runCli validate --consumer", () => {
  it.each([
    ["missing", undefined, "no Pi credentials found"],
    ["expired", { "openai-codex": { type: "oauth", expires: 1_000_000_000_000, refresh: "r" } }, "OAuth token for `openai-codex` expired"],
  ] as const)("keeps %s Pi credentials non-fatal but does not describe the config as ready", async (_credentialState, authStore, expectedDetail) => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n", "utf8");
    const authPath = join(dir, "auth.json");
    if (authStore !== undefined) {
      await writeFile(authPath, JSON.stringify(authStore), { encoding: "utf8", mode: 0o600 });
    }
    await writeConsumerConfig(dir, "mono-agent.config.json", {
      runtime: { model: "pi:openai-codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      providers: { piAuthPath: authPath },
    });
    process.chdir(dir);

    const result = await captureRunCli(["validate"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Provider credentials");
    expect(result.stdout).toContain(expectedDetail);
    expect(result.stdout).toContain("Config is structurally valid, but not operationally ready.");
    expect(result.stdout).not.toContain("Config is ready to start.");
  });

  it("does not describe a generic waiting section as ready", async () => {
    const memoryDir = join(dir, ".mono-agent", "memory");
    await seedManagedMemory(memoryDir, "journal", "openai:text-embedding-3-small");
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeConsumerConfig(dir, "mono-agent.config.json", {
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-json-secret" },
      },
    });
    process.chdir(dir);

    const result = await captureRunCli(["validate"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Config warnings");
    expect(result.stdout).toContain("memory.embeddings.apiKey is a secret read from mono-agent.config.json");
    expect(result.stdout).toContain("Config is structurally valid, but not operationally ready.");
    expect(result.stdout).not.toContain("Config is ready to start.");
  });

  it("reports Supermemory as waiting when its base URL points at a closed port", async () => {
    const baseUrl = await closedLoopbackBaseUrl();
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeConsumerConfig(dir, "mono-agent.config.json", {
      runtime: { model: "codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        backend: "supermemory",
        mode: "lite",
        path: ".mono-agent/memory",
        writeMode: "capture",
        supermemory: { baseUrl, container: "closed-port-agent" },
      },
    });
    process.chdir(dir);

    const result = await captureRunCli(["validate", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly structurallyValid: boolean;
      readonly operationallyReady: boolean;
      readonly sections: readonly {
        readonly id: string;
        readonly status: string;
        readonly details: readonly string[];
      }[];
    };
    const memory = report.sections.find((section) => section.id === "memory");
    expect(report.ok).toBe(true);
    expect(report.structurallyValid).toBe(true);
    expect(report.operationallyReady).toBe(false);
    expect(memory?.status).toBe("waiting");
    expect(memory?.details.join("\n")).toContain(`Supermemory is not reachable at ${baseUrl}`);
    expect(memory?.details.join("\n")).toContain("memory.supermemory.baseUrl");
    expect(memory?.details.join("\n")).toContain("mono-agent validate");
  });

  it("loads the consumer .env and config without changing the current directory", async () => {
    const invocationDir = join(dir, "invocation");
    const consumerDir = join(dir, "consumer");
    await mkdir(invocationDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(invocationDir, ".env"), "MONO_AGENT_MODEL=not-a-valid-model\n", "utf8");
    await writeFile(join(consumerDir, ".env"), "MONO_AGENT_MODEL=codex:gpt-5.5\n", "utf8");
    await writeFile(join(consumerDir, "IDENTITY.md"), "# Consumer\n", "utf8");
    await writeConsumerConfig(consumerDir, "mono-agent.config.json", {
      context: { identityPath: "./IDENTITY.md" },
    });

    process.chdir(invocationDir);

    const result = await captureRunCli(["validate", "--consumer", "../consumer"]);

    expect(result.code).toBe(0);
    expect(process.cwd()).toBe(invocationDir);
    expect(result.stdout).toContain(`Loaded ${join(consumerDir, "mono-agent.config.json")}.`);
    expect(result.stdout).toContain("Primary model codex:gpt-5.5");
    expect(result.stderr).toBe("");
  });

  it("resolves --config inside the consumer folder", async () => {
    const invocationDir = join(dir, "invocation");
    const consumerDir = join(dir, "consumer");
    await mkdir(invocationDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(consumerDir, ".env"), "MONO_AGENT_MODEL=codex:gpt-5.5\n", "utf8");
    await writeFile(join(consumerDir, "IDENTITY.alt.md"), "# Consumer\n", "utf8");
    const configPath = await writeConsumerConfig(consumerDir, "alternate.config.json", {
      context: { identityPath: "./IDENTITY.alt.md" },
    });

    process.chdir(invocationDir);

    const result = await captureRunCli(["validate", "--consumer", "../consumer", "--config", "alternate.config.json"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Loaded ${configPath}.`);
    expect(result.stderr).toBe("");
  });

  it("does not create missing consumer memory roots", async () => {
    const invocationDir = join(dir, "invocation");
    const consumerDir = join(dir, "consumer");
    const memoryDir = join(consumerDir, "missing-memory");
    await mkdir(invocationDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(consumerDir, "IDENTITY.md"), "# Consumer\n", "utf8");
    await writeConsumerConfig(consumerDir, "mono-agent.config.json", {
      runtime: { model: "codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "lite",
        path: "./missing-memory",
        writeMode: "append-host-summary",
      },
    });

    process.chdir(invocationDir);

    const result = await captureRunCli(["validate", "--consumer", "../consumer"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Consumer validation is read-only and did not create it");
    expect(await pathExists(memoryDir)).toBe(false);
  });

  it("fails closed when the configured managed database is corrupt", async () => {
    const memoryDir = join(dir, ".mono-agent", "memory");
    await seedManagedMemory(memoryDir, "journal", "openai:text-embedding-3-small");
    const activeDatabase = resolveActiveMemoryDbPath(memoryDir);
    const privateSentinel = "private corrupt database sentinel";
    const apiKeySentinel = "test-openai-key-sentinel";
    process.env.MONO_AGENT_TEST_OPENAI_API_KEY = apiKeySentinel;
    await writeFile(activeDatabase, privateSentinel, "utf8");
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeConsumerConfig(dir, "mono-agent.config.json", {
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKeyEnv: "MONO_AGENT_TEST_OPENAI_API_KEY",
        },
      },
    });
    process.chdir(dir);

    const result = await captureRunCli(["validate", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly sections: readonly { readonly id: string; readonly status: string; readonly details: readonly string[] }[];
    };
    expect(report).toMatchObject({
      ok: false,
      sections: expect.arrayContaining([
        expect.objectContaining({ id: "memory", status: "error" }),
      ]),
    });
    expect(report.sections.find((section) => section.id === "memory")?.details.join("\n"))
      .toContain("mono-agent memory rebuild");
    expect(result.stdout).not.toContain(activeDatabase);
    expect(result.stdout).not.toContain(privateSentinel);
    expect(result.stdout).not.toContain(apiKeySentinel);
  });
});
