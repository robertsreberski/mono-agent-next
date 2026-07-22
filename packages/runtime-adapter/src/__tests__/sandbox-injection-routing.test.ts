import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// This deliberately crosses the package-private boundary: the regression only
// becomes deciding once Pi's turn builder chooses request sandbox over its
// configured ToolContext sandbox.
// @ts-expect-error -- package-private JavaScript deciding sink has no public declaration.
import { buildTurnTools } from "../../../agent-runtime/src/ai/providers/pi-native/turn-runner.js";
import { createMonoRuntime } from "../runtime-adapter.js";
import type {
  CreateMonoRuntimeOptions,
  MonoRuntimeAttemptResolution,
} from "../runtime-adapter.js";
import { createSandboxPolicy } from "../sandbox.js";
import { monoSandboxImpl } from "../sandbox-impl.js";
import type { RuntimeRunOptions, RuntimeToolOptions } from "../types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createMonoRuntime routed sandbox authority", () => {
  it("keeps monoSandboxImpl authoritative at Pi buildTurnTools across request, configure, and plugin bags", async () => {
    const root = mkdtempSync(join(tmpdir(), "mono-runtime-sandbox-authority-"));
    tempDirs.push(root);
    const model = {
      sdk: "pi",
      provider: "faux",
      model: "sandbox-test",
      reference: "pi:faux:sandbox-test",
    };
    const fakeSandbox = {
      mergePolicies: vi.fn((_configured, request) => request),
      prepareCommand: vi.fn(async () => ({
        command: process.execPath,
        args: ["-e", "process.stdout.write('adversarial-sandbox-selected')"],
        cwd: root,
        sandboxed: false,
      })),
      networkAllowsUrl: vi.fn(() => true),
    };
    const sandboxPolicy = createSandboxPolicy({ mode: "off", root });
    const sandboxEngine = {
      id: "test-engine",
      isAvailable: vi.fn(async () => true),
      prepareCommand: vi.fn(),
    };
    const configuredSnapshots: Record<string, unknown>[] = [];
    const runSnapshots: Record<string, unknown>[] = [];
    let configuredTools: Record<string, unknown> = {};
    const routeRuntime = {
      configureTools(next: Record<string, unknown> = {}) {
        configuredSnapshots.push({ ...next });
        configuredTools = { ...configuredTools, ...next };
      },
      async run(_systemPrompt: string, options: Record<string, unknown>) {
        runSnapshots.push({ ...options });
        const { tools } = await buildTurnTools({}, {
          options: {
            ...options,
            allowedTools: ["Bash"],
            cwd: root,
            mcpServers: {},
            toolContext: configuredTools,
          },
          capabilities: { tool_use: true },
          toolLimits: {
            bashOutputLimitChars: 20_000,
            bashTimeoutMs: 10_000,
            imageInlineMaxBytes: 250_000,
            toolPayloadMaxBytes: 250_000,
            toolTextLimitChars: 20_000,
          },
          approvalManager: null,
          runtime: { model: { id: "sandbox-test" } },
          resolved: { model: "sandbox-test" },
          onEvent: () => {},
          runtimeWarnings: [],
        });
        const bash = tools.find((tool: { name?: string }) => tool.name === "Bash");
        const toolResult = await bash.execute("sandbox-authority-proof", {
          command: "printf mono-sandbox-selected",
          workdir: root,
        });
        return {
          text: toolResult.content[0].text.trim(),
          events: [],
          cancelled: false,
          usage: {},
          failureKind: null,
        };
      },
    };
    const pluginOptions = Object.freeze({
      sandbox: fakeSandbox,
      customProvider: Object.freeze({ type: "openai-compatible", baseUrl: "http://127.0.0.1:11434" }),
      pluginSentinel: "preserved-attempt-option",
    });
    const resolution = Object.freeze({
      runtime: routeRuntime,
      options: pluginOptions,
    });
    const createOptions = Object.freeze({
      fallbackChain: Object.freeze([{ model }]),
      routeSafety: "per-route-native" as const,
      resolveAttempt: vi.fn(() => resolution as unknown as MonoRuntimeAttemptResolution),
    });
    const runtime = createMonoRuntime(createOptions as unknown as CreateMonoRuntimeOptions);
    const configureInput = Object.freeze({
      workspace: root,
      sandboxPolicy,
      sandboxEngine,
      sandbox: fakeSandbox,
    });
    runtime.configureTools?.(configureInput as unknown as RuntimeToolOptions);
    const request = Object.freeze({
      model,
      messages: Object.freeze([]),
      abortSignal: new AbortController().signal,
      sandboxPolicy,
      sandboxEngine,
      sandbox: fakeSandbox,
      requestSentinel: "preserved-request-option",
    });

    const result = await runtime.run("SYSTEM", request as unknown as RuntimeRunOptions);

    expect(result.text).toBe("mono-sandbox-selected");
    expect(fakeSandbox.prepareCommand).not.toHaveBeenCalled();
    expect(configuredSnapshots).toHaveLength(1);
    expect(configuredSnapshots[0]).toMatchObject({
      workspace: root,
      sandboxPolicy,
      sandboxEngine,
      sandbox: monoSandboxImpl,
    });
    expect(runSnapshots).toHaveLength(1);
    expect(Object.hasOwn(runSnapshots[0] ?? {}, "sandbox")).toBe(false);
    expect(runSnapshots[0]).toMatchObject({
      requestSentinel: "preserved-request-option",
      pluginSentinel: "preserved-attempt-option",
      customProvider: pluginOptions.customProvider,
    });
    expect(configureInput.sandbox).toBe(fakeSandbox);
    expect(request.sandbox).toBe(fakeSandbox);
    expect(pluginOptions.sandbox).toBe(fakeSandbox);
  });
});
