import { describe, expect, it, vi } from "vitest";

import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { defaultAnswers, composeWizardPlan } from "../wizard/answers.js";
import {
  readinessProbeEnvironment,
  readinessProbeTimeoutMs,
  runAllRouteReadinessProbe,
} from "../readiness-probe.js";
import { trackPiCredentialResolverSecrets } from "../readiness-probe-worker.js";

async function syntheticReadinessWorker(): Promise<{ readonly url: URL; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-readiness-worker-test-"));
  const path = join(dir, "worker.mjs");
  await writeFile(path, `
    import { parentPort, workerData } from "node:worker_threads";
    const mode = process.env.READINESS_WORKER_TEST_MODE;
    if (mode === "exact-env") {
      const exact = process.env.DURABLE_PROVIDER_KEY === "durable-worker-key"
        && process.env.SHELL_ONLY_PROVIDER_KEY === undefined
        && typeof workerData.cwd === "string"
        && typeof workerData.runtime?.model?.sdk === "string"
        && typeof workerData.runtime?.workspace === "string"
        && workerData.configPath === undefined;
      parentPort.postMessage(exact
        ? { type: "result", hasText: true, cancelled: false }
        : { type: "error", message: "worker environment was not exact" });
    } else if (mode === "tool-result") {
      parentPort.postMessage({ type: "tool", action: "tool_result" });
    } else if (mode === "effort") {
      parentPort.postMessage(workerData.runtime?.effort === "max"
        ? { type: "result", hasText: true, cancelled: false }
        : { type: "error", message: "worker effort did not match" });
    } else if (mode === "transport") {
      parentPort.postMessage(workerData.runtime?.piTransport === "sse"
        ? { type: "result", hasText: true, cancelled: false }
        : { type: "error", message: "worker Pi transport did not match" });
    } else if (mode === "ignore-abort") {
      setInterval(() => {}, 10_000);
    } else {
      parentPort.postMessage({ type: "error", message: "unknown synthetic worker mode" });
    }
    if (mode !== "ignore-abort") {
      parentPort.postMessage({ type: "disposed" });
      parentPort.close();
    }
  `, { mode: 0o600 });
  return { url: pathToFileURL(path), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runProbeForTest(
  options: Parameters<typeof runAllRouteReadinessProbe>[0],
): Promise<Awaited<ReturnType<typeof runAllRouteReadinessProbe>>> {
  const result = await runAllRouteReadinessProbe(options);
  const runtime = (options.plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const hasFallbacks =
    (Array.isArray(runtime.fallbacks) && runtime.fallbacks.length > 0)
    || (Array.isArray(runtime.fallbackModels) && runtime.fallbackModels.length > 0);
  if (hasFallbacks || options.resume !== undefined) {
    return result;
  }
  if (result.ok) {
    return { ok: true };
  }
  const route = result.routes?.[0];
  return {
    ok: false,
    kind: route?.kind ?? result.kind,
    message: route?.message ?? result.message,
  };
}

describe("readiness probe", () => {
  const plan = composeWizardPlan(defaultAnswers(), { dirBasename: "agent", skillsRootExists: false });

  it("returns a typed unsupported result before probing direct OpenCode", async () => {
    const directOpenCodePlan = composeWizardPlan(defaultAnswers({
      model: "opencode:github-copilot:gpt-5.1",
    }), { dirBasename: "agent", skillsRootExists: false });
    const run = vi.fn(async () => ({ text: "must not run" }));
    const dispose = vi.fn(async () => {});

    await expect(runProbeForTest({
      plan: directOpenCodePlan,
      run,
      dispose,
    })).resolves.toEqual({
      ok: false,
      kind: "unsupported_guided_probe",
      message: expect.stringMatching(/pi:opencode-go:<model>.*runtime\.permissionMode/u),
    });
    expect(run).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("runs against the selected model with a no-tool disposable config", async () => {
    let seen: { model: unknown; allowedTools: readonly string[]; workspace: string; identityPath: string } | undefined;
    const result = await runProbeForTest({
      plan,
      run: async ({ config, options }) => {
        seen = {
          model: config.runtime.model,
          allowedTools: options.allowedTools ?? [],
          workspace: config.runtime.workspace,
          identityPath: config.context.identityPath,
        };
        expect(options).toMatchObject({
          maxTurns: 1,
          allowedTools: [],
          disallowedTools: [],
          mcpServers: {},
          codexNoToolsProbe: true,
          sessionKeepAlive: false,
        });
        expect(config.runtime.fallbackModels).toBeUndefined();
        expect(config.memory).toBeUndefined();
        expect(config.tools.allowedTools).toEqual([]);
        await expect(access(config.context.identityPath)).resolves.toBeUndefined();
        await expect(stat(config.runtime.workspace)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
        return { text: "ready" };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toMatchObject({ model: { reference: "codex:gpt-5.6-terra" }, allowedTools: [] });
    expect(seen?.workspace).toContain("mono-agent-readiness-");
    expect(seen?.identityPath).toContain("mono-agent-readiness-");
  });

  it("ignores ambient MONO_AGENT overrides while retaining the selected in-memory secret overlay", async () => {
    const secretValues = { PROVIDER_SECRET: "selected-in-memory-secret" };
    const hostEnv = {
      PATH: "/usr/bin:/bin",
      PROVIDER_SECRET: "ambient-secret",
      UNSET_VALUE: undefined,
      MONO_AGENT_MODEL: "pi:openai-codex:not-the-selected-model",
      MONO_AGENT_FALLBACK_MODELS: "pi:openai-codex:not-the-selected-fallback",
      MONO_AGENT_MEMORY_PATH: "/tmp/ambient-memory",
      MONO_AGENT_MEMORY_BACKEND: "supermemory",
      MONO_AGENT_SESSION_MODE: "per-message",
      MONO_AGENT_PI_SESSIONS_ROOT: "/tmp/ambient-sessions",
    };
    expect(readinessProbeEnvironment(hostEnv, secretValues)).toEqual({
      PATH: "/usr/bin:/bin",
      PROVIDER_SECRET: "selected-in-memory-secret",
    });
    expect(readinessProbeEnvironment(hostEnv, secretValues, {
      resolvedPiAuthPath: "/resolved/pi/auth.json",
    })).toEqual({
      PATH: "/usr/bin:/bin",
      PROVIDER_SECRET: "selected-in-memory-secret",
      MONO_AGENT_PI_AUTH_PATH: "/resolved/pi/auth.json",
    });
    await expect(runProbeForTest({
      plan,
      hostEnv,
      secretValues,
      run: async ({ config, options }) => {
        expect(config.runtime.model).toMatchObject({ reference: "codex:gpt-5.6-terra" });
        expect(config.runtime.fallbackModels).toBeUndefined();
        expect(config.memory).toBeUndefined();
        expect(config.runtime.session).toMatchObject({ mode: "continuous" });
        expect(config.providers?.piNative?.piSessionsRoot).toBeUndefined();
        expect(options.sessionKeepAlive).toBe(false);
        return { text: "ready" };
      },
    })).resolves.toEqual({ ok: true });
  });

  it("passes exact durable credentials to the injected run without swapping the host environment", async () => {
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "shell-openai-key";
    process.env.ANTHROPIC_API_KEY = "shell-anthropic-key";
    const hostEnv: Record<string, string | undefined> = {
      ...process.env,
      OPENAI_API_KEY: "durable-openai-key",
    };
    delete hostEnv.ANTHROPIC_API_KEY;

    try {
      await expect(runProbeForTest({
        plan,
        hostEnv,
        run: async ({ options }) => {
          expect(options.providerEnv.OPENAI_API_KEY).toBe("durable-openai-key");
          expect(options.providerEnv.ANTHROPIC_API_KEY).toBeUndefined();
          expect(Object.isFrozen(options.providerEnv)).toBe(true);
          expect(process.env.OPENAI_API_KEY).toBe("shell-openai-key");
          expect(process.env.ANTHROPIC_API_KEY).toBe("shell-anthropic-key");
          return { text: "ready" };
        },
      })).resolves.toEqual({ ok: true });
      expect(process.env.OPENAI_API_KEY).toBe("shell-openai-key");
      expect(process.env.ANTHROPIC_API_KEY).toBe("shell-anthropic-key");
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
      if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    }
  });

  it("runs the production transport in a worker with only the exact durable environment", async () => {
    const synthetic = await syntheticReadinessWorker();
    const previousShellOnly = process.env.SHELL_ONLY_PROVIDER_KEY;
    process.env.SHELL_ONLY_PROVIDER_KEY = "ambient-shell-key";
    try {
      await expect(runProbeForTest({
        plan,
        hostEnv: {
          READINESS_WORKER_TEST_MODE: "exact-env",
          DURABLE_PROVIDER_KEY: "durable-worker-key",
        },
        workerUrl: synthetic.url,
      })).resolves.toEqual({ ok: true });
      expect(process.env.SHELL_ONLY_PROVIDER_KEY).toBe("ambient-shell-key");
    } finally {
      if (previousShellOnly === undefined) delete process.env.SHELL_ONLY_PROVIDER_KEY;
      else process.env.SHELL_ONLY_PROVIDER_KEY = previousShellOnly;
      await synthetic.cleanup();
    }
  });

  it("probes the exact selected reasoning effort in injected and worker execution", async () => {
    const effortPlan = composeWizardPlan(defaultAnswers({ effort: "max" }), {
      dirBasename: "agent",
      skillsRootExists: false,
    });
    await expect(runProbeForTest({
      plan: effortPlan,
      run: async ({ options }) => {
        expect(options.effort).toBe("max");
        return { text: "ready" };
      },
    })).resolves.toEqual({ ok: true });

    const synthetic = await syntheticReadinessWorker();
    try {
      await expect(runProbeForTest({
        plan: effortPlan,
        hostEnv: { READINESS_WORKER_TEST_MODE: "effort" },
        workerUrl: synthetic.url,
      })).resolves.toEqual({ ok: true });
    } finally {
      await synthetic.cleanup();
    }
  });

  it("probes with the configured Pi transport in injected and worker execution", async () => {
    const configJson = structuredClone(plan.configJson) as Record<string, unknown>;
    configJson.providers = {
      ...((configJson.providers as Record<string, unknown> | undefined) ?? {}),
      piNative: { transport: "sse" },
    };
    const transportPlan = { ...plan, configJson: configJson as never };

    await expect(runProbeForTest({
      plan: transportPlan,
      run: async ({ config, options }) => {
        expect(config.providers?.piNative?.transport).toBe("sse");
        expect(options.piTransport).toBe("sse");
        return { text: "ready" };
      },
    })).resolves.toEqual({ ok: true });

    const synthetic = await syntheticReadinessWorker();
    try {
      await expect(runProbeForTest({
        plan: transportPlan,
        hostEnv: { READINESS_WORKER_TEST_MODE: "transport" },
        workerUrl: synthetic.url,
      })).resolves.toEqual({ ok: true });
    } finally {
      await synthetic.cleanup();
    }
  });

  it("accepts tool_result as a worker-reported no-tool policy violation", async () => {
    const synthetic = await syntheticReadinessWorker();
    try {
      await expect(runProbeForTest({
        plan,
        hostEnv: { READINESS_WORKER_TEST_MODE: "tool-result" },
        workerUrl: synthetic.url,
      })).resolves.toMatchObject({ ok: false, kind: "tool_used" });
    } finally {
      await synthetic.cleanup();
    }
  });

  it("hard-terminates an abort-ignoring worker after bounded cleanup", async () => {
    const synthetic = await syntheticReadinessWorker();
    const startedAt = Date.now();
    try {
      await expect(runProbeForTest({
        plan,
        hostEnv: { READINESS_WORKER_TEST_MODE: "ignore-abort" },
        timeoutMs: 15,
        workerUrl: synthetic.url,
      })).resolves.toMatchObject({ ok: false, kind: "timeout" });
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      await synthetic.cleanup();
    }
  });

  it("surfaces an empty first response as not ready", async () => {
    await expect(runProbeForTest({ plan, run: async () => ({ text: "" }) })).resolves.toMatchObject({
      ok: false,
      kind: "empty_response",
    });
  });

  it("rejects partial text from cancelled and failed provider runs", async () => {
    await expect(runProbeForTest({
      plan,
      run: async () => ({ text: "partial", cancelled: true }),
    })).resolves.toMatchObject({ ok: false, kind: "cancelled" });

    await expect(runProbeForTest({
      plan,
      run: async () => ({
        text: "partial",
        failureKind: "provider_unavailable",
        error: "provider unavailable",
      }),
    })).resolves.toMatchObject({ ok: false, kind: "provider_failed", message: "provider unavailable" });
  });

  it("rejects tool actions observed live or returned in the result", async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(runProbeForTest({
      plan,
      run: async ({ options }) => {
        observedSignal = options.abortSignal;
        options.onEvent?.({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
        });
        return { text: "ready" };
      },
    })).resolves.toMatchObject({ ok: false, kind: "tool_used" });
    expect(observedSignal?.aborted).toBe(true);

    await expect(runProbeForTest({
      plan,
      run: async () => ({ text: "ready", events: [{ type: "file_change" }] }),
    })).resolves.toMatchObject({ ok: false, kind: "tool_used" });
  });

  it("does not start a provider run when the caller is already cancelled", async () => {
    const caller = new AbortController();
    caller.abort();
    const run = vi.fn(() => new Promise<never>(() => {}));
    const dispose = vi.fn(async () => {});

    await expect(runProbeForTest({
      plan,
      abortSignal: caller.signal,
      timeoutMs: 10_000,
      run,
      dispose,
    })).resolves.toMatchObject({ ok: false, kind: "cancelled" });

    expect(run).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("cancels a never-settling provider immediately, aborts it, and disposes it", async () => {
    const caller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const dispose = vi.fn(async () => {});
    const pending = runProbeForTest({
      plan,
      abortSignal: caller.signal,
      timeoutMs: 10_000,
      dispose,
      run: ({ options }) => {
        providerSignal = options.abortSignal;
        markStarted?.();
        return new Promise<never>(() => {});
      },
    });

    await started;
    caller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, kind: "cancelled" });
    expect(providerSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns immediately when a never-settling provider emits a tool event", async () => {
    let providerSignal: AbortSignal | undefined;
    const dispose = vi.fn(async () => {});
    const pending = runProbeForTest({
      plan,
      timeoutMs: 10_000,
      dispose,
      run: ({ options }) => {
        providerSignal = options.abortSignal;
        options.onEvent?.({ type: "file_change" });
        return new Promise<never>(() => {});
      },
    });

    await expect(pending).resolves.toMatchObject({ ok: false, kind: "tool_used" });
    expect(providerSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses a hard deadline and a late provider read still sees the explicit env without any host swap", async () => {
    const ambientName = "READINESS_TEST_AMBIENT_TOKEN";
    const durableName = "READINESS_TEST_DURABLE_TOKEN";
    const previousAmbient = process.env[ambientName];
    const previousDurable = process.env[durableName];
    process.env[ambientName] = "shell-only-after-timeout";
    process.env[durableName] = "shell-durable-value";
    const hostEnv: Record<string, string | undefined> = {
      ...process.env,
      [durableName]: "durable-provider-value",
    };
    delete hostEnv[ambientName];
    let resolveRun: (() => void) | undefined;
    let resolveLateRead: (() => void) | undefined;
    const lateRead = new Promise<void>((resolve) => {
      resolveLateRead = resolve;
    });
    let lateProviderValue: string | undefined;
    let lateAmbientValue: string | undefined;
    let seenSignal: AbortSignal | undefined;
    const dispose = vi.fn(async () => {});
    try {
      const pending = runProbeForTest({
        plan,
        hostEnv,
        timeoutMs: 15,
        dispose,
        run: ({ options }) => {
          seenSignal = options.abortSignal;
          return new Promise((resolve) => {
            resolveRun = () => {
              lateProviderValue = options.providerEnv[durableName];
              lateAmbientValue = process.env[ambientName];
              resolveLateRead?.();
              resolve({ text: "late success" });
            };
          });
        },
      });

      await expect(pending).resolves.toMatchObject({ ok: false, kind: "timeout" });
      expect(seenSignal?.aborted).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(process.env[ambientName]).toBe("shell-only-after-timeout");
      expect(process.env[durableName]).toBe("shell-durable-value");
      resolveRun?.();
      await lateRead;
      expect(lateProviderValue).toBe("durable-provider-value");
      expect(lateAmbientValue).toBe("shell-only-after-timeout");
    } finally {
      if (previousAmbient === undefined) delete process.env[ambientName];
      else process.env[ambientName] = previousAmbient;
      if (previousDurable === undefined) delete process.env[durableName];
      else process.env[durableName] = previousDurable;
    }
  });

  it("uses longer default deadlines for local providers", () => {
    expect(readinessProbeTimeoutMs({ sdk: "codex", model: "gpt-5.6-terra" })).toBe(90_000);
    expect(readinessProbeTimeoutMs({ sdk: "pi", provider: "openai-codex", model: "gpt-5.6-terra" })).toBe(90_000);
    expect(readinessProbeTimeoutMs({ sdk: "pi", provider: "ollama", model: "qwen3:8b" })).toBe(240_000);
    expect(readinessProbeTimeoutMs({ sdk: "pi", provider: "lmstudio", model: "qwen3-8b" })).toBe(240_000);
  });

  it("bounds and redacts provider errors before returning them", async () => {
    const secret = "super-secret-provider-token";
    const result = await runProbeForTest({
      plan,
      secretValues: { PROVIDER_SECRET: secret },
      run: async () => ({
        text: "partial",
        error: `api_key=${secret} ${"x".repeat(800)}`,
      }),
    });

    expect(result).toMatchObject({ ok: false, kind: "provider_failed" });
    if (result.ok) throw new Error("expected the readiness probe to fail");
    expect(result.message).not.toContain(secret);
    expect(result.message).toContain("[REDACTED]");
    expect(result.message.length).toBeLessThanOrEqual(400);
  });

  it("checks every canonical route sequentially with exact independent effort and continues after failures", async () => {
    const configJson = structuredClone(plan.configJson) as Record<string, unknown>;
    configJson.runtime = {
      ...(configJson.runtime as Record<string, unknown>),
      effort: "high",
      routeSafety: "per-route-native",
      fallbacks: [
        { model: "claude:claude-sonnet-5", effort: "low" },
        { model: "pi:openai:gpt-5.5" },
      ],
    };
    const allRoutesPlan = { ...plan, configJson: configJson as never };
    const seen: Array<{ model: string; effort?: string }> = [];
    const starts: string[] = [];
    const completions: string[] = [];
    const result = await runProbeForTest({
      plan: allRoutesPlan,
      onRouteStart: (route) => { starts.push(`${route.index + 1}/${route.total}:${route.model}`); },
      onRouteComplete: (route) => { completions.push(`${route.index}:${route.status}`); },
      run: async ({ config, options }) => {
        const reference = config.runtime.model.reference ?? "";
        seen.push({
          model: reference,
          ...(options.effort === undefined ? {} : { effort: options.effort }),
        });
        return reference.startsWith("claude:")
          ? { text: "", failureKind: "provider_unavailable", error: "Claude unavailable" }
          : { text: "ready" };
      },
    });

    expect(seen).toEqual([
      { model: "codex:gpt-5.6-terra", effort: "high" },
      { model: "claude:claude-sonnet-5", effort: "low" },
      { model: "pi:openai:gpt-5.5" },
    ]);
    expect(starts).toEqual([
      "1/3:codex:gpt-5.6-terra",
      "2/3:claude:claude-sonnet-5",
      "3/3:pi:openai:gpt-5.5",
    ]);
    expect(completions).toEqual(["0:verified", "1:failed", "2:verified"]);
    expect(result).toMatchObject({
      ok: false,
      routes: [
        { status: "verified" },
        { status: "failed", kind: "provider_failed" },
        { status: "verified" },
      ],
    });
  });

  it("resumes only successful route keys under the exact same plan fingerprint", async () => {
    const configJson = structuredClone(plan.configJson) as Record<string, unknown>;
    configJson.runtime = {
      ...(configJson.runtime as Record<string, unknown>),
      fallbackModels: ["pi:openai-codex:gpt-5.6-sol"],
      effort: "xhigh",
    };
    const resumePlan = { ...plan, configJson: configJson as never };
    const first = await runProbeForTest({ plan: resumePlan, run: async () => ({ text: "ready" }) });
    expect(first.ok).toBe(true);
    if (!first.ok || first.routes === undefined || first.planFingerprint === undefined) throw new Error("route summary missing");
    const run = vi.fn(async () => ({ text: "ready" }));
    const resumed = await runProbeForTest({
      plan: resumePlan,
      run,
      resume: {
        planFingerprint: first.planFingerprint,
        successfulRouteKeys: first.routes.map((route) => route.key),
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(resumed).toMatchObject({
      ok: true,
      routes: [{ status: "skipped_verified" }, { status: "skipped_verified" }],
    });
  });

  it("honors an already-aborted signal before accepting fully cached route proofs", async () => {
    const configJson = structuredClone(plan.configJson) as Record<string, unknown>;
    configJson.runtime = {
      ...(configJson.runtime as Record<string, unknown>),
      fallbackModels: ["pi:openai-codex:gpt-5.6-sol"],
    };
    const resumePlan = { ...plan, configJson: configJson as never };
    const first = await runProbeForTest({ plan: resumePlan, run: async () => ({ text: "ready" }) });
    if (!first.ok || first.routes === undefined || first.planFingerprint === undefined) {
      throw new Error("route summary missing");
    }
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => ({ text: "should not run" }));

    const interrupted = await runProbeForTest({
      plan: resumePlan,
      run,
      abortSignal: controller.signal,
      resume: {
        planFingerprint: first.planFingerprint,
        successfulRouteKeys: first.routes.map((route) => route.key),
      },
    });

    expect(run).not.toHaveBeenCalled();
    expect(interrupted).toMatchObject({
      ok: false,
      kind: "cancelled",
      interrupted: true,
      routes: [{ status: "interrupted" }],
    });
  });

  it("invalidates resume keys when non-secret provider execution config changes", async () => {
    const firstConfig = structuredClone(plan.configJson) as Record<string, unknown>;
    firstConfig.runtime = {
      ...(firstConfig.runtime as Record<string, unknown>),
      fallbackModels: ["pi:openai-codex:gpt-5.6-sol"],
    };
    firstConfig.providers = { piAuthPath: "/tmp/readiness-auth-a.json" };
    const firstPlan = { ...plan, configJson: firstConfig as never };
    const first = await runProbeForTest({ plan: firstPlan, run: async () => ({ text: "ready" }) });
    if (!first.ok || first.routes === undefined || first.planFingerprint === undefined) throw new Error("route summary missing");

    const changedConfig = structuredClone(firstConfig);
    changedConfig.providers = { piAuthPath: "/tmp/readiness-auth-b.json" };
    const run = vi.fn(async () => ({ text: "ready" }));
    const changed = await runProbeForTest({
      plan: { ...plan, configJson: changedConfig as never },
      run,
      resume: {
        planFingerprint: first.planFingerprint,
        successfulRouteKeys: first.routes.map((route) => route.key),
      },
    });
    expect(changed.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(changed.planFingerprint).not.toBe(first.planFingerprint);
  });

  it("returns resumable interruption state when caller aborts the current route", async () => {
    const configJson = structuredClone(plan.configJson) as Record<string, unknown>;
    configJson.runtime = {
      ...(configJson.runtime as Record<string, unknown>),
      fallbackModels: ["pi:openai-codex:gpt-5.6-sol"],
    };
    const controller = new AbortController();
    const result = await runProbeForTest({
      plan: { ...plan, configJson: configJson as never },
      abortSignal: controller.signal,
      run: async () => {
        controller.abort();
        return await new Promise<never>(() => {});
      },
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "cancelled",
      interrupted: true,
      routes: [{ status: "interrupted" }],
    });
  });

  it("preserves Pi credential-store methods while tracking only resolver secrets", async () => {
    const readCredential = vi.fn(async () => ({ type: "oauth", access: "oauth-access", expires: 1 }));
    const modifyCredential = vi.fn(async (_provider: string, fn: (value: never) => Promise<never>) => fn(undefined as never));
    const deleteCredential = vi.fn(async () => {});
    const resolver = Object.assign(vi.fn(async () => "resolved-secret"), {
      readCredential,
      modifyCredential,
      deleteCredential,
    });
    const secrets = new Set<string>();
    const tracked = trackPiCredentialResolverSecrets(resolver as never, secrets);

    await expect(tracked("openai-codex")).resolves.toBe("resolved-secret");
    await expect(tracked.readCredential?.("openai-codex")).resolves.toMatchObject({ type: "oauth" });
    await tracked.modifyCredential?.("openai-codex", async (current) => current);
    await tracked.deleteCredential?.("openai-codex");
    expect(secrets).toEqual(new Set(["resolved-secret"]));
    expect(readCredential).toHaveBeenCalledOnce();
    expect(modifyCredential).toHaveBeenCalledOnce();
    expect(deleteCredential).toHaveBeenCalledOnce();
  });
});
