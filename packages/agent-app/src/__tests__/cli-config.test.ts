import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { renderConfigView, runCli } from "../cli.js";
import type { ConfigViewSection } from "@mono-agent/config";

const sections: readonly ConfigViewSection[] = [
  {
    id: "runtime",
    label: "Runtime",
    status: "active",
    fields: [
      { id: "runtime.model", label: "Model", value: "pi:ollama:qwen3:8b", source: "json" },
      { id: "runtime.effort", label: "Effort", value: "—", source: "default" },
      { id: "runtime.workspace", label: "Workspace", value: "/work", source: "env" },
      { id: "traceability.heartbeatMs", label: "Heartbeat", value: "10000", source: "json", restatesDefault: true },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    status: "disabled",
    fields: [{ id: "memory.mode", label: "Status", value: "not configured", source: "default" }],
  },
];

describe("renderConfigView", () => {
  it("tags every field with its source layer", () => {
    const out = renderConfigView(sections);
    expect(out).toContain("Runtime");
    expect(out).toMatch(/Model.*pi:ollama:qwen3:8b.*\[json\]/u);
    expect(out).toMatch(/Effort.*\[default\]/u);
    expect(out).toMatch(/Workspace.*\[env\]/u);
    expect(out).toMatch(/Heartbeat.*10000.*same as default.*\[json\]/u);
  });

  it("renders an active section with the ok badge and a disabled one with the off badge", () => {
    const out = renderConfigView(sections);
    // Plain (NO_COLOR) badges are width-equal ASCII tags.
    expect(out).toContain("[ok]   ");
    expect(out).toContain("[off]  ");
    expect(out).toContain("not configured");
  });

  it("marks redacted fields with a secret note", () => {
    const out = renderConfigView([
      {
        id: "memory",
        label: "Memory",
        status: "active",
        fields: [
          { id: "memory.embeddings.apiKey", label: "Embeddings API key", value: "set", source: "env", redacted: true },
        ],
      },
    ]);
    expect(out).toContain("(secret)");
    expect(out).not.toContain("sk-");
  });
});

describe("runCli config", () => {
  it("prints JSON-sourced secret warnings without leaking the value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);

    try {
      process.chdir(dir);
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: { model: "pi:openai-codex:gpt-5.5" },
          context: { identityPath: "./IDENTITY.md" },
          memory: {
            mode: "journal",
            path: "./memory",
            embeddings: {
              provider: "openai",
              model: "text-embedding-3-small",
              apiKey: "sk-json-secret",
            },
          },
        }, null, 2),
      );

      await expect(runCli(["config", "--config", configPath])).resolves.toBe(0);

      const out = chunks.join("");
      expect(out).toContain("[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json");
      expect(out).toContain("MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY");
      expect(out).not.toContain("sk-json-secret");
    } finally {
      stdoutSpy.mockRestore();
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
    }
  });

  it("prints removed memory key warnings without leaking ignored values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);

    try {
      process.chdir(dir);
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: { model: "pi:openai-codex:gpt-5.5" },
          context: { identityPath: "./IDENTITY.md" },
          memory: {
            mode: "bujo",
            path: "./memory",
            embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
            llm: { provider: "ollama", model: "qwen3.6:latest" },
            reflection: { cron: "ignored-secret-cron" },
            migration: { enabled: false },
          },
        }, null, 2),
      );

      await expect(runCli(["config", "--config", configPath])).resolves.toBe(0);

      const out = chunks.join("");
      expect(out).toContain("[WARN] memory.reflection is removed and ignored");
      expect(out).toContain("[WARN] memory.migration is removed and ignored");
      expect(out).not.toContain("ignored-secret-cron");
    } finally {
      stdoutSpy.mockRestore();
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
    }
  });

  it("emits a flat JSON envelope with redacted secrets and no ANSI in --json mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);

    try {
      process.chdir(dir);
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: { model: "pi:openai-codex:gpt-5.5" },
          context: { identityPath: "./IDENTITY.md" },
          memory: {
            mode: "journal",
            path: "./memory",
            embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-json-secret" },
          },
        }, null, 2),
      );

      await expect(runCli(["config", "--config", configPath, "--json"])).resolves.toBe(0);

      const out = chunks.join("");
      // stdout is exactly one JSON object; no ANSI escape sequences.
      expect(out).not.toMatch(/\u001b\[/u);
      expect(out).not.toContain("sk-json-secret");
      const parsed = JSON.parse(out) as {
        readonly ok: boolean;
        readonly config: readonly { readonly id: string; readonly fields: readonly { readonly id: string; readonly value: string; readonly redacted?: boolean }[] }[];
        readonly channels: readonly unknown[];
        readonly channelStatus: readonly unknown[];
        readonly warnings: readonly string[];
      };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.config)).toBe(true);
      expect(Array.isArray(parsed.channels)).toBe(true);
      expect(Array.isArray(parsed.channelStatus)).toBe(true);
      // The secret warning still travels, but inside the JSON payload, not on stdout prose.
      expect(parsed.warnings.some((warning) => warning.includes("memory.embeddings.apiKey"))).toBe(true);
      // The redacted apiKey field never carries the raw secret.
      const secretField = parsed.config
        .flatMap((section) => section.fields)
        .find((field) => field.id === "memory.embeddings.apiKey");
      expect(secretField?.redacted).toBe(true);
      expect(secretField?.value).not.toContain("sk-json-secret");
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MONO_AGENT_")) delete process.env[key];
      }
      for (const [key, value] of previousMonoAgentEnv) process.env[key] = value;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits an ok:false error envelope and exit 1 for a broken config file in --json mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write);

    try {
      process.chdir(dir);
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(configPath, "{ this is not valid json", "utf8");

      await expect(runCli(["config", "--config", configPath, "--json"])).resolves.toBe(1);

      const out = stdoutChunks.join("");
      const parsed = JSON.parse(out) as { readonly ok: boolean; readonly error: { readonly code: string; readonly message: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("config-invalid");
      expect(typeof parsed.error.message).toBe("string");
      // JSON mode keeps stdout pure JSON; no human error prose leaks onto stdout.
      expect(out).not.toMatch(/\u001b\[/u);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      process.chdir(previousCwd);
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MONO_AGENT_")) delete process.env[key];
      }
      for (const [key, value] of previousMonoAgentEnv) process.env[key] = value;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown keys instead of silently ignoring stale config blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-cli-config-"));
    const previousCwd = process.cwd();
    const previousMonoAgentEnv = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        previousMonoAgentEnv.set(key, process.env[key] ?? "");
        delete process.env[key];
      }
    }

    const chunks: string[] = [];
    const errorChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      errorChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write);

    try {
      process.chdir(dir);
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: { model: "pi:openai-codex:gpt-5.5" },
          context: { identityPath: "./IDENTITY.md" },
          console: { enabled: true, port: 4400 },
          traceability: {
            heartbeatMs: 10000,
            staleAfterMs: 30000,
            heartBeatMs: 10000,
          },
        }, null, 2),
      );

      await expect(runCli(["config", "--config", configPath])).resolves.toBe(1);

      const out = chunks.join("");
      const errors = errorChunks.join("");
      expect(out).toBe("");
      expect(errors).toContain("unknown keys: console, traceability.heartBeatMs");
      expect(errors).toContain("unknown keys are not ignored");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
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
    }
  });
});
