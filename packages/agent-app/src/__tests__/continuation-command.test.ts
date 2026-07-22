import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runContinuationCommand } from "../continuation-command.js";
import { continuationOperatorToken } from "../continuation-service.js";

async function commandFixture(config: Record<string, unknown> = { continuations: { port: 4381 } }): Promise<{
  readonly cwd: string;
  readonly configPath: string;
  readonly secret: Buffer;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "mono-continuation-command-"));
  const stateDir = join(cwd, ".mono-agent", "continuations");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const secret = Buffer.alloc(32, 7);
  const secretPath = join(stateDir, "continuation-secret");
  await writeFile(secretPath, `${secret.toString("base64url")}\n`, { mode: 0o600 });
  await chmod(secretPath, 0o600);
  const configPath = join(cwd, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({
    runtime: { model: "pi:openai-codex:gpt-5.5" },
    context: { identityPath: "./IDENTITY.md" },
    ...config,
  }));
  return { cwd, configPath, secret };
}

describe("runContinuationCommand", () => {
  it("queries authenticated health on the configured fixed service endpoint", async () => {
    const fixture = await commandFixture();
    const stdout: string[] = [];
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({
        status: "degraded",
        checkedAt: new Date().toISOString(),
        counts: { delivery_unknown: 1, dead_lettered: 0 },
        pending: 2,
        due: 1,
        storage: { historyDegraded: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const exit = await runContinuationCommand({
      ...fixture,
      env: {},
      positionals: ["health"],
      fetchImpl,
      stdout: (text) => stdout.push(text),
    });

    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4381/v1/operator/health");
    expect(new Headers(calls[0]?.init?.headers).get("authorization"))
      .toBe(`Bearer ${continuationOperatorToken(fixture.secret)}`);
    expect(stdout.join("")).toContain("pending=2");
    expect(stdout.join("")).toContain("delivery_unknown=1");
    expect(stdout.join("")).toContain("history_degraded=1");
  });

  it("uses documented defaults when continuation servers implicitly enable the service", async () => {
    const fixture = await commandFixture({
      tools: { continuationServers: ["a8c-control"] },
    });
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({
        status: "healthy",
        checkedAt: new Date().toISOString(),
        counts: { delivery_unknown: 0, dead_lettered: 0 },
        pending: 0,
        due: 0,
        storage: { historyDegraded: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const exit = await runContinuationCommand({
      ...fixture,
      env: {},
      positionals: ["health"],
      fetchImpl,
      stdout: () => undefined,
    });

    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4319/v1/operator/health");
    expect(new Headers(calls[0]?.init?.headers).get("authorization"))
      .toBe(`Bearer ${continuationOperatorToken(fixture.secret)}`);
  });

  it("rejects an agent with no explicit or implicit continuation configuration", async () => {
    const fixture = await commandFixture({});
    const fetchImpl = vi.fn<typeof fetch>();
    const stderr: string[] = [];

    const exit = await runContinuationCommand({
      ...fixture,
      env: {},
      positionals: ["health"],
      fetchImpl,
      stderr: (text) => stderr.push(text),
    });

    expect(exit).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("Continuations are not configured");
  });

  it("sends an explicit delivery-unknown resolution without accepting a destination", async () => {
    const fixture = await commandFixture();
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({
        continuationId: "continuation-1",
        state: "delivered",
        mode: "reply",
        taskKey: "task",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deadline: new Date().toISOString(),
        attempts: { synthesis: 1, delivery: 1 },
        receipt: { kind: "delivered", deliveredAt: new Date().toISOString(), deliveryId: "slack:C1:171.5" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const exit = await runContinuationCommand({
      ...fixture,
      env: {},
      positionals: ["resolve", "continuation-1", "delivered", "slack:C1:171.5"],
      fetchImpl,
      stdout: () => undefined,
    });

    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4381/v1/operator/continuations/continuation-1/resolve");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "delivered",
      deliveryId: "slack:C1:171.5",
    });
  });

  it("requests an explicit operator page and tells human operators how to continue", async () => {
    const fixture = await commandFixture();
    const calls: string[] = [];
    const stdout: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        continuations: [{
          continuationId: "continuation-2",
          state: "delivery_unknown",
          mode: "reply",
          taskKey: "task",
          createdAt: "2026-07-14T10:00:00.000Z",
          updatedAt: "2026-07-14T10:01:00.000Z",
          deadline: "2026-07-15T10:00:00.000Z",
          attempts: { synthesis: 1, delivery: 1 },
        }],
        pageSize: 1,
        nextCursor: "opaque-page-three",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const exit = await runContinuationCommand({
      ...fixture,
      env: {},
      positionals: ["list"],
      limit: 1,
      cursor: "opaque-page-two",
      fetchImpl,
      stdout: (text) => stdout.push(text),
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([
      "http://127.0.0.1:4381/v1/operator/continuations?limit=1&cursor=opaque-page-two",
    ]);
    expect(stdout.join("\n")).toContain("continuation-2");
    expect(stdout.join("\n")).toContain("--cursor opaque-page-three");
  });

  it("rejects extra positional destination data before contacting the service", async () => {
    const fixture = await commandFixture();
    const fetchImpl = vi.fn<typeof fetch>();
    const stderr: string[] = [];

    const exit = await runContinuationCommand({
      ...fixture,
      env: {},
      positionals: ["retry", "continuation-1", "slack:D1"],
      fetchImpl,
      stderr: (text) => stderr.push(text),
    });

    expect(exit).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("Usage: mono-agent continuations");
  });
});
