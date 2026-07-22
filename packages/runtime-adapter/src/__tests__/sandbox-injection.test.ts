import { beforeEach, describe, expect, it, vi } from "vitest";

const kernelMocks = vi.hoisted(() => {
  const createKernelRuntime = () => ({
    run: vi.fn(),
    configureTools: vi.fn(),
  });
  return {
    createRuntime: vi.fn((_host?: unknown) => createKernelRuntime()),
    createRouterRuntime: vi.fn((_options?: unknown) => createKernelRuntime()),
  };
});

vi.mock("@mono-agent/agent-runtime", () => ({
  createPiOAuthApiKeyResolver: vi.fn(),
  createRuntime: kernelMocks.createRuntime,
  createRouterRuntime: kernelMocks.createRouterRuntime,
}));

import { createMonoRuntime } from "../runtime-adapter.js";
import type {
  CreateMonoRuntimeOptions,
  MonoRuntimeAttemptContext,
  MonoRuntimeAttemptResolution,
} from "../runtime-adapter.js";
import type { RuntimeRunOptions, RuntimeToolOptions } from "../types.js";
import { monoSandboxImpl } from "../sandbox-impl.js";

const model = {
  sdk: "pi",
  provider: "faux",
  model: "sandbox-test",
  reference: "pi:faux:sandbox-test",
};

function adversarialSandbox(label = "caller") {
  return {
    mergePolicies: vi.fn(),
    prepareCommand: vi.fn(async () => ({ command: `${label}-sandbox-selected` })),
    networkAllowsUrl: vi.fn(() => true),
  };
}

describe("createMonoRuntime sandbox injection", () => {
  beforeEach(() => {
    kernelMocks.createRuntime.mockClear();
    kernelMocks.createRouterRuntime.mockClear();
  });

  it.each([
    ["fake", adversarialSandbox()],
    ["undefined", undefined],
    ["null", null],
  ])("ignores an adversarial constructor sandbox (%s) without mutating its input", (_label, callerSandbox) => {
    const callerOptions = Object.freeze({
      workspace: "/repo/workspace",
      sandbox: callerSandbox,
    });

    createMonoRuntime(callerOptions as unknown as CreateMonoRuntimeOptions);

    expect(kernelMocks.createRuntime).toHaveBeenCalledOnce();
    const host = kernelMocks.createRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(host.workspace).toBe("/repo/workspace");
    expect(host.sandbox).toBe(monoSandboxImpl);
    expect(host.sandbox).not.toBe(callerSandbox);
    expect(callerOptions.sandbox).toBe(callerSandbox);
    expect(kernelMocks.createRouterRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["fake", adversarialSandbox("request")],
    ["undefined", undefined],
    ["null", null],
  ])("strips an adversarial run sandbox (%s) while preserving request extensions", async (_label, callerSandbox) => {
    const runtime = createMonoRuntime({ workspace: "/host/workspace" });
    const sandboxPolicy = { mode: "off" };
    const sandboxEngine = { id: "request-engine", isAvailable: vi.fn(), prepareCommand: vi.fn() };
    const request = Object.freeze({
      model,
      messages: Object.freeze([]),
      abortSignal: new AbortController().signal,
      cwd: "/request/workspace",
      sandbox: callerSandbox,
      sandboxPolicy,
      sandboxEngine,
      pluginSentinel: "preserved-request-extension",
    });

    await runtime.run("SYSTEM", request as unknown as RuntimeRunOptions);

    const kernelRuntime = kernelMocks.createRuntime.mock.results[0]?.value;
    expect(kernelRuntime?.run).toHaveBeenCalledOnce();
    const forwarded = kernelRuntime?.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.hasOwn(forwarded, "sandbox")).toBe(false);
    expect(forwarded).toMatchObject({
      cwd: "/request/workspace",
      sandboxPolicy,
      sandboxEngine,
      pluginSentinel: "preserved-request-extension",
      executionMode: "sdk",
    });
    expect(request.sandbox).toBe(callerSandbox);
  });

  it.each([
    ["fake", adversarialSandbox("configured")],
    ["undefined", undefined],
    ["null", null],
  ])("strips an adversarial configureTools sandbox (%s) while preserving tool data", (_label, callerSandbox) => {
    const runtime = createMonoRuntime();
    const sandboxPolicy = { mode: "off" };
    const sandboxEngine = { id: "configured-engine", isAvailable: vi.fn(), prepareCommand: vi.fn() };
    const next = Object.freeze({
      workspace: "/configured/workspace",
      sandbox: callerSandbox,
      sandboxPolicy,
      sandboxEngine,
      pluginSentinel: "preserved-tool-extension",
    });

    runtime.configureTools?.(next as unknown as RuntimeToolOptions);

    const kernelRuntime = kernelMocks.createRuntime.mock.results[0]?.value;
    expect(kernelRuntime?.configureTools).toHaveBeenCalledOnce();
    const forwarded = kernelRuntime?.configureTools.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(forwarded, "sandbox")).toBe(false);
    expect(forwarded).toMatchObject({
      workspace: "/configured/workspace",
      sandboxPolicy,
      sandboxEngine,
      pluginSentinel: "preserved-tool-extension",
    });
    expect(next.sandbox).toBe(callerSandbox);
  });

  it("protects router host, request, and plugin option bags without mutating any caller object", async () => {
    const hostSandbox = adversarialSandbox("host");
    const requestSandbox = adversarialSandbox("request");
    const pluginSandbox = adversarialSandbox("plugin");
    const pluginOptions = Object.freeze({
      sandbox: pluginSandbox,
      customProvider: Object.freeze({ baseUrl: "http://127.0.0.1:11434" }),
      pluginSentinel: "preserved-plugin-extension",
    });
    const resolution = Object.freeze({
      options: pluginOptions,
      cleanup: vi.fn(),
    });
    const callerOptions = Object.freeze({
      workspace: "/router/workspace",
      sandbox: hostSandbox,
      fallbackChain: Object.freeze([{ model }]),
      resolveAttempt: vi.fn(() => resolution as unknown as MonoRuntimeAttemptResolution),
    });

    const runtime = createMonoRuntime(callerOptions as unknown as CreateMonoRuntimeOptions);
    const request = Object.freeze({
      model,
      messages: Object.freeze([]),
      abortSignal: new AbortController().signal,
      sandbox: requestSandbox,
      requestSentinel: "preserved-router-request",
    });
    await runtime.run("SYSTEM", request as unknown as RuntimeRunOptions);

    expect(kernelMocks.createRouterRuntime).toHaveBeenCalledOnce();
    const routerOptions = kernelMocks.createRouterRuntime.mock.calls[0]?.[0] as {
      host: Record<string, unknown>;
      resolveAttempt: (context: MonoRuntimeAttemptContext) => Promise<MonoRuntimeAttemptResolution | undefined>;
    };
    expect(routerOptions.host).toMatchObject({ workspace: "/router/workspace", sandbox: monoSandboxImpl });
    const protectedResolution = await routerOptions.resolveAttempt({
      model,
      executionMode: "sdk",
      attemptIndex: 0,
      routeSafety: "uniform",
    });
    expect(protectedResolution?.cleanup).toBe(resolution.cleanup);
    expect(Object.hasOwn(protectedResolution?.options ?? {}, "sandbox")).toBe(false);
    expect(protectedResolution?.options).toMatchObject({
      customProvider: pluginOptions.customProvider,
      pluginSentinel: "preserved-plugin-extension",
    });

    const kernelRuntime = kernelMocks.createRouterRuntime.mock.results[0]?.value;
    const forwarded = kernelRuntime?.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.hasOwn(forwarded, "sandbox")).toBe(false);
    expect(forwarded.requestSentinel).toBe("preserved-router-request");
    expect(callerOptions.sandbox).toBe(hostSandbox);
    expect(request.sandbox).toBe(requestSandbox);
    expect(pluginOptions.sandbox).toBe(pluginSandbox);
  });
});
