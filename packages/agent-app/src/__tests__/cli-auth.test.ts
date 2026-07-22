import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelValue: Symbol("cancel"),
  executeProviderSetupPlan: vi.fn(),
  password: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => value === mocks.cancelValue,
  password: mocks.password,
}));

vi.mock("../provider-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-setup.js")>();
  return { ...actual, executeProviderSetupPlan: mocks.executeProviderSetupPlan };
});

import { parseCliArgs, readApiKeyFromStdin, runCli } from "../cli.js";

const originalCwd = process.cwd();
const originalOpenCodeApiKey = process.env.OPENCODE_API_KEY;
const processStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const temporaryDirectories: string[] = [];

function capturedOutput(spy: {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}): string {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

beforeEach(async () => {
  delete process.env.OPENCODE_API_KEY;
  mocks.executeProviderSetupPlan.mockReset();
  mocks.executeProviderSetupPlan.mockImplementation(async (plan) =>
    plan.actions.map((action: object) => ({ action, status: "ok", detail: "saved securely" })),
  );
  mocks.password.mockReset();
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-cli-auth-"));
  temporaryDirectories.push(dir);
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  Object.defineProperty(process, "stdin", processStdinDescriptor);
  if (stdinTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
  if (stdoutTtyDescriptor === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
  if (originalOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalOpenCodeApiKey;
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("standalone Pi API-key login", () => {
  it("parses the explicit standard-input mode only for auth", () => {
    expect(parseCliArgs(["auth", "login", "opencode-go", "--api-key-stdin"])).toMatchObject({
      command: "auth",
      positionals: ["login", "opencode-go"],
      apiKeyStdin: true,
    });
    expect(() => parseCliArgs(["init", "--api-key-stdin"])).toThrow(
      "--api-key-stdin is only supported for `mono-agent auth login <provider>`.",
    );
  });

  it("collects OpenCode-Go credentials through a masked TTY prompt and ignores ambient keys", async () => {
    const enteredKey = "tty-secret-sentinel";
    process.env.OPENCODE_API_KEY = "ambient-secret-must-not-be-copied";
    mocks.password.mockResolvedValue(enteredKey);
    const stdout = vi.mocked(process.stdout.write);
    const stderr = vi.mocked(process.stderr.write);

    await expect(runCli([
      "auth",
      "login",
      "opencode-go",
      "--pi-auth-path",
      join(process.cwd(), "pi", "auth.json"),
    ])).resolves.toBe(0);

    expect(mocks.password).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("OPENCODE_API_KEY"),
      clearOnError: true,
      validate: expect.any(Function),
    }));
    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledWith(
      expect.objectContaining({ actions: [expect.objectContaining({ id: "pi-api-key:opencode-go" })] }),
      {
        apiKeys: { "pi-api-key:opencode-go": enteredKey },
        abortSignal: expect.any(AbortSignal),
      },
    );
    const output = capturedOutput(stdout) + capturedOutput(stderr);
    expect(output).not.toContain(enteredKey);
    expect(output).not.toContain("ambient-secret-must-not-be-copied");
  });

  it("fails closed when masked input is cancelled", async () => {
    mocks.password.mockResolvedValue(mocks.cancelValue);

    await expect(runCli(["auth", "login", "opencode-go"])).resolves.toBe(130);

    expect(mocks.executeProviderSetupPlan).not.toHaveBeenCalled();
    expect(capturedOutput(vi.mocked(process.stderr.write))).toContain(
      "Authentication was cancelled; no credentials were written.",
    );
  });

  it("requires an explicit redirected-input mode when no TTY is available", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    await expect(runCli(["auth", "login", "opencode-go"])).resolves.toBe(1);

    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.executeProviderSetupPlan).not.toHaveBeenCalled();
    expect(capturedOutput(vi.mocked(process.stderr.write))).toContain("--api-key-stdin");
  });

  it("accepts one explicitly redirected API key without printing it", async () => {
    const enteredKey = "piped-secret-sentinel";
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from([`${enteredKey}\n`]),
    });
    const stdout = vi.mocked(process.stdout.write);
    const stderr = vi.mocked(process.stderr.write);

    await expect(runCli(["auth", "login", "opencode-go", "--api-key-stdin"])).resolves.toBe(0);

    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledWith(
      expect.anything(),
      {
        apiKeys: { "pi-api-key:opencode-go": enteredKey },
        abortSignal: expect.any(AbortSignal),
      },
    );
    expect(capturedOutput(stdout) + capturedOutput(stderr)).not.toContain(enteredKey);
  });

  it("rejects empty, multiline, and oversized redirected secrets before persistence", async () => {
    await expect(readApiKeyFromStdin(Readable.from(["\n"]))).rejects.toThrow("API key is required");
    await expect(readApiKeyFromStdin(Readable.from(["first\nsecond\n"]))).rejects.toThrow("single non-empty line");
    await expect(readApiKeyFromStdin(Readable.from(["x".repeat(65_539)]))).rejects.toThrow("too large");
  });

  it("rejects redirected API-key input for OAuth and direct Codex login", async () => {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: Readable.from(["must-not-be-consumed"]),
    });

    await expect(runCli(["auth", "login", "codex", "--api-key-stdin"])).resolves.toBe(2);

    expect(mocks.executeProviderSetupPlan).not.toHaveBeenCalled();
    expect(capturedOutput(vi.mocked(process.stderr.write))).toContain(
      "--api-key-stdin is only supported when the selected provider has one bundled API-key login action.",
    );
  });

  it("interrupts standalone OAuth safely and restores scoped listeners", async () => {
    const listenersBefore = process.listenerCount("SIGINT");
    const keypressListenersBefore = process.stdin.listenerCount("keypress");
    let observedSignal: AbortSignal | undefined;
    mocks.executeProviderSetupPlan.mockImplementation(async (plan, options) => {
      observedSignal = options.abortSignal;
      return await new Promise((resolveResult) => {
        options.abortSignal.addEventListener("abort", () => resolveResult(
          plan.actions.map((action: object) => ({ action, status: "failed", detail: "interrupted" })),
        ), { once: true });
      });
    });

    const pending = runCli(["auth", "login", "codex"]);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    process.emit("SIGINT");

    await expect(pending).resolves.toBe(130);
    expect(observedSignal?.aborted).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
    expect(process.stdin.listenerCount("keypress")).toBe(keypressListenersBefore);
    expect(capturedOutput(vi.mocked(process.stderr.write))).toContain("Authentication was interrupted");
  });

  it("interrupts flagged init authentication without writing agent files", async () => {
    let observedSignal: AbortSignal | undefined;
    mocks.executeProviderSetupPlan.mockImplementation(async (plan, options) => {
      observedSignal = options.abortSignal;
      return await new Promise((resolveResult) => {
        options.abortSignal.addEventListener("abort", () => resolveResult(
          plan.actions.map((action: object) => ({ action, status: "failed", detail: "interrupted" })),
        ), { once: true });
      });
    });

    const pending = runCli(["init", "--model", "pi:ollama:qwen3.6:latest", "--auth"]);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    process.emit("SIGINT");

    await expect(pending).resolves.toBe(130);
    expect(observedSignal?.aborted).toBe(true);
    expect(await readdir(process.cwd())).not.toContain("mono-agent.config.json");
  });

  it("never offers recovery when an interrupted child exit is unconfirmed", async () => {
    mocks.executeProviderSetupPlan.mockImplementation(async (plan) => {
      return plan.actions.map((action: object) => ({
        action,
        status: "failed",
        failureKind: "child_exit_unconfirmed",
        detail: "child exit could not be confirmed after SIGKILL",
      }));
    });

    await expect(runCli(["auth", "login", "codex"])).resolves.toBe(130);

    const output = capturedOutput(vi.mocked(process.stdout.write)) + capturedOutput(vi.mocked(process.stderr.write));
    expect(output).toContain("automatic recovery is disabled");
    expect(output).not.toContain("How would you like to recover");
  });
});
