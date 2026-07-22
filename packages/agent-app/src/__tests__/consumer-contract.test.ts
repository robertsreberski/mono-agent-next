/**
 * Golden consumer fixtures are source-shaped, secret-free snapshots of the real
 * downstream mono-agent configs. To refresh one, start from the live
 * mono-agent.config.json source, remove credential fields before committing,
 * relativize host paths to fixture-local placeholders, ensure referenced
 * IDENTITY.md, skills/, mcp.json, and cron files exist, then run this test plus
 * the fixture secret scan.
 */
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "@mono-agent/runtime-adapter";

import {
  consumerContractNames,
  consumerContractRunSummaryStatuses,
  validateConsumerContractFixture,
} from "../consumer-contract.js";
import type { ConsumerContractName } from "../consumer-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const consumersRoot = join(here, "fixtures", "consumers");

describe("golden consumer config contracts", () => {
  it("validates the local-agent-alpha fixture without network access", async () => {
    const result = await validateFixture("local-agent-alpha");

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.networkCallCount).toBe(0);
    expect(result.sections).toMatchInlineSnapshot(`
      [
        {
          "id": "core",
          "status": "ok",
        },
        {
          "id": "runtime-provenance",
          "status": "ok",
        },
        {
          "id": "runtime",
          "status": "ok",
        },
        {
          "id": "credentials",
          "status": "waiting",
        },
        {
          "id": "context",
          "status": "ok",
        },
        {
          "id": "memory",
          "status": "ok",
        },
        {
          "id": "tools",
          "status": "ok",
        },
        {
          "id": "continuations",
          "status": "disabled",
        },
        {
          "id": "sandbox",
          "status": "waiting",
        },
        {
          "id": "observability",
          "status": "ok",
        },
        {
          "id": "runs",
          "status": "disabled",
        },
        {
          "id": "launchd-logs",
          "status": "disabled",
        },
        {
          "id": "channel:telegram",
          "status": "waiting",
        },
        {
          "id": "channel:slack",
          "status": "disabled",
        },
        {
          "id": "channel:webhook",
          "status": "ok",
        },
        {
          "id": "channel:openai-api",
          "status": "ok",
        },
        {
          "id": "channel:cron",
          "status": "ok",
        },
        {
          "id": "channel:tui",
          "status": "ok",
        },
      ]
    `);
  });

  it("validates the local-agent-beta fixture without network access", async () => {
    const result = await validateFixture("local-agent-beta");

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.networkCallCount).toBe(0);
    expect(result.sections).toMatchInlineSnapshot(`
      [
        {
          "id": "core",
          "status": "ok",
        },
        {
          "id": "runtime-provenance",
          "status": "ok",
        },
        {
          "id": "runtime",
          "status": "ok",
        },
        {
          "id": "credentials",
          "status": "waiting",
        },
        {
          "id": "context",
          "status": "ok",
        },
        {
          "id": "memory",
          "status": "ok",
        },
        {
          "id": "tools",
          "status": "ok",
        },
        {
          "id": "continuations",
          "status": "disabled",
        },
        {
          "id": "sandbox",
          "status": "waiting",
        },
        {
          "id": "observability",
          "status": "ok",
        },
        {
          "id": "runs",
          "status": "disabled",
        },
        {
          "id": "launchd-logs",
          "status": "disabled",
        },
        {
          "id": "channel:telegram",
          "status": "disabled",
        },
        {
          "id": "channel:slack",
          "status": "waiting",
        },
        {
          "id": "channel:webhook",
          "status": "disabled",
        },
        {
          "id": "channel:openai-api",
          "status": "ok",
        },
        {
          "id": "channel:cron",
          "status": "ok",
        },
        {
          "id": "channel:tui",
          "status": "ok",
        },
      ]
    `);
  });

  it("keeps committed consumer fixtures free of obvious secret markers", async () => {
    const results = await Promise.all(consumerContractNames.map((name) => validateFixture(name)));

    expect(results.flatMap((result) => result.issues.filter((issue) => issue.check === "fixture-secrets"))).toEqual([]);
  });

  it("keeps artifact run statuses aligned with the observability status union", () => {
    expect(Object.keys(consumerContractRunSummaryStatuses).sort()).toEqual([
      "cancelled",
      "failed",
      "interrupted",
      "running",
      "succeeded",
    ]);
  });

  it("rejects an absolute memory path outside the private copy without creating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-app-consumer-escape-"));
    const fixtureDir = join(root, "fixture");
    const outsideMemory = join(root, "outside", "memory");
    try {
      await cp(join(consumersRoot, "local-agent-alpha"), fixtureDir, { recursive: true });
      const configPath = join(fixtureDir, "mono-agent.config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        memory: { path: string };
      };
      config.memory.path = outsideMemory;
      await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

      const result = await validateConsumerContractFixture({
        name: "local-agent-alpha",
        fixtureDir,
      });

      expect(result.ok).toBe(false);
      expect(result.networkCallCount).toBe(0);
      expect(result.issues).toEqual([
        expect.objectContaining({
          check: "consumer-contract",
          message: expect.stringContaining("strict lexical descendant"),
        }),
      ]);
      expect(await pathExists(outsideMemory)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function validateFixture(name: ConsumerContractName) {
  const sandboxEngine: SandboxEngine = {
    id: "synthetic-unavailable-srt",
    isAvailable: vi.fn(async () => false),
    prepareCommand: vi.fn(async () => {
      throw new Error("not used in consumer contract validation");
    }),
  };
  const result = await validateConsumerContractFixture({
    name,
    fixtureDir: join(consumersRoot, name),
    sandboxEngine,
  });
  expect(sandboxEngine.isAvailable).toHaveBeenCalledTimes(1);
  expect(sandboxEngine.prepareCommand).not.toHaveBeenCalled();
  return result;
}
