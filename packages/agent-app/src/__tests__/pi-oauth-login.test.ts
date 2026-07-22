import { execFile, execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPiOAuthLoginPersistenceSupported,
  runPiOAuthLogin,
} from "../pi-oauth-login.js";

const dirs: string[] = [];
const execFileAsync = promisify(execFile);
const wrongStateFixtureReportPrefix = "mono-agent-pi-oauth-wrong-state:";
const wrongStateFixture = fileURLToPath(new URL("./fixtures/pi-oauth-wrong-state.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi OAuth terminal wrapper", () => {
  it("fails closed where final-component symlink safety is unavailable", () => {
    expect(() => assertPiOAuthLoginPersistenceSupported("win32")).toThrow(
      /symlink-safe owner-only writes cannot be verified/u,
    );
    expect(() => assertPiOAuthLoginPersistenceSupported("linux")).not.toThrow();
    expect(() => assertPiOAuthLoginPersistenceSupported("darwin")).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("hands a pasted full redirect URL unchanged to the provider and preserves sibling credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ sibling: { type: "api_key", key: "keep" } })}\n`, { mode: 0o644 });

    const redirect = "http://localhost:53692/callback?code=test-code&state=expected-state";
    const questions: string[] = [];
    let received = "";
    const provider = {
      id: "anthropic",
      name: "Anthropic",
      usesCallbackServer: true,
      login: vi.fn(async (callbacks: OAuthLoginCallbacks) => {
        callbacks.onAuth({ url: "https://claude.ai/oauth/authorize?state=expected-state" });
        received = await callbacks.onManualCodeInput!();
        const parsed = new URL(received);
        if (parsed.searchParams.get("state") !== "expected-state") throw new Error("OAuth state mismatch");
        if (parsed.searchParams.get("code") === null) throw new Error("Missing authorization code");
        return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
      }),
      refreshToken: vi.fn(),
      getApiKey: vi.fn(),
    } as unknown as OAuthProviderInterface;

    await runPiOAuthLogin("anthropic", {
      authPath,
      provider,
      io: {
        ask: async (question) => {
          questions.push(question);
          return redirect;
        },
        write: vi.fn(),
      },
    });

    expect(received).toBe(redirect);
    expect(questions).toEqual([expect.stringMatching(/OAuth state will be validated/u)]);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      sibling: { type: "api_key", key: "keep" },
      anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: expect.any(Number) },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps Anthropic's shipped code/state validation when its fixed callback port is occupied", async () => {
    const { stdout } = await execFileAsync(process.execPath, [wrongStateFixture], {
      encoding: "utf8",
      env: { ...process.env, PI_OAUTH_CALLBACK_HOST: "127.0.0.1" },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const reportLine = stdout.split("\n")
      .find((line) => line.startsWith(wrongStateFixtureReportPrefix));
    if (reportLine === undefined) throw new Error("Pi wrong-state fixture did not report its result");

    expect(JSON.parse(reportLine.slice(wrongStateFixtureReportPrefix.length))).toEqual({
      error: "OAuth state mismatch",
      fallbackPrompts: 0,
      fixedPort: 53692,
      interceptedBinds: 1,
      isolatedPort: expect.any(Number),
      manualInputs: 1,
      occupation: expect.stringMatching(/^(ambient|fixture)$/u),
      tokenExchangeAttempts: 0,
    });
  }, 15_000);

  it.skipIf(process.platform === "win32")("refuses a symlinked auth path without changing its victim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const victimPath = join(dir, "victim.json");
    const authPath = join(dir, "auth.json");
    const victimContents = '{"victim":"must remain unchanged"}\n';
    await writeFile(victimPath, victimContents, { mode: 0o600 });
    await symlink(victimPath, authPath);

    await expect(withCwd(dir, () => runPiOAuthLogin("anthropic", {
      provider: stubProvider({ access: "new-access", refresh: "new-refresh" }),
      io: { ask: async () => "", write: vi.fn() },
    }))).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:ELOOP|EMLINK)$/u),
    });

    expect(await readFile(victimPath, "utf8")).toBe(victimContents);
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO auth path without blocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    await execFileAsync("mkfifo", [authPath]);

    const pending = runPiOAuthLogin("anthropic", {
      authPath,
      provider: stubProvider({ access: "new-access", refresh: "new-refresh" }),
      io: { ask: async () => "", write: vi.fn() },
    });
    let blockTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "blocked" }>((resolveBlocked) => {
        blockTimer = setTimeout(() => resolveBlocked({ kind: "blocked" }), 500);
      }),
    ]);
    if (blockTimer !== undefined) clearTimeout(blockTimer);

    if (outcome.kind === "blocked") {
      // Let a regressed blocking reader finish so cleanup cannot strand the
      // test worker after the bounded assertion records the failure.
      const writer = await open(
        authPath,
        fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
      );
      await writer.close();
      await Promise.allSettled([pending]);
    }
    expect(outcome.kind).not.toBe("blocked");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.error).toEqual(expect.objectContaining({
      message: expect.stringMatching(/must be a regular file/u),
    }));
  });

  it.skipIf(process.platform === "win32")("rejects a missing auth path replaced by a FIFO before write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    let fifoInstalled = false;
    const credentials = {
      access: "new-access",
      refresh: "new-refresh",
      toJSON: () => {
        if (!fifoInstalled) {
          execFileSync("mkfifo", [authPath]);
          fifoInstalled = true;
        }
        return { access: "new-access", refresh: "new-refresh" };
      },
    };

    const pending = runPiOAuthLogin("anthropic", {
      authPath,
      provider: stubProvider(credentials),
      io: { ask: async () => "", write: vi.fn() },
    });
    let blockTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "blocked" }>((resolveBlocked) => {
        blockTimer = setTimeout(() => resolveBlocked({ kind: "blocked" }), 500);
      }),
    ]);
    if (blockTimer !== undefined) clearTimeout(blockTimer);

    if (outcome.kind === "blocked") {
      const reader = await open(
        authPath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
      );
      await Promise.allSettled([pending]);
      await reader.close();
    }
    expect(outcome.kind).not.toBe("blocked");
    expect(outcome.kind).toBe("rejected");
    expect((await stat(authPath)).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("truncates an existing auth file before writing a shorter replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      anthropic: { type: "oauth", access: "x".repeat(4_096), refresh: "old-refresh" },
    }, null, 2)}\n`, { mode: 0o600 });

    const credentials = { access: "new-access", refresh: "new-refresh" };
    await runPiOAuthLogin("anthropic", {
      authPath,
      provider: stubProvider(credentials),
      io: { ask: async () => "", write: vi.fn() },
    });

    expect(await readFile(authPath, "utf8")).toBe(`${JSON.stringify({
      anthropic: { type: "oauth", ...credentials },
    }, null, 2)}\n`);
  });

  it.skipIf(process.platform === "win32")("preserves missing-file behavior by creating an owner-only auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    const credentials = { access: "new-access", refresh: "new-refresh" };

    await runPiOAuthLogin("anthropic", {
      authPath,
      provider: stubProvider(credentials),
      io: { ask: async () => "", write: vi.fn() },
    });

    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      anthropic: { type: "oauth", ...credentials },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });
});

function stubProvider(credentials: Record<string, unknown>): OAuthProviderInterface {
  return {
    id: "anthropic",
    name: "Anthropic",
    usesCallbackServer: true,
    login: vi.fn(async () => credentials),
    refreshToken: vi.fn(),
    getApiKey: vi.fn(),
  } as unknown as OAuthProviderInterface;
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    return await run();
  } finally {
    process.chdir(previous);
  }
}
