import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPERATOR_PROTOCOL,
  OPERATOR_REGISTRY_DETAILS_SCHEMA,
  OPERATOR_REGISTRY_SCHEMA,
  OperatorDirectory,
  OperatorDirectoryError,
  createOperatorClientForEntry,
  discoverOperators,
  getDefaultOperatorRegistryDirectory,
  type OperatorRegistryDescriptor,
} from "../index.js";
import { FIXTURE_CAPABILITIES } from "../testing.js";

const roots: string[] = [];
async function temporaryRegistry(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-operator-"));
  roots.push(root);
  const registry = join(root, "registry");
  await mkdir(registry, { mode: 0o700 });
  await chmod(registry, 0o700);
  return registry;
}

function descriptor(overrides: Partial<OperatorRegistryDescriptor> = {}): OperatorRegistryDescriptor {
  return {
    schema: OPERATOR_REGISTRY_SCHEMA,
    agent: { id: "fixture-agent", label: "Fixture Agent" },
    operator: { endpoint: "http://127.0.0.1:4321/operator", tokenEnvironment: "FIXTURE_OPERATOR_TOKEN" },
    pid: 42,
    startedAt: "2026-01-02T03:04:05.000Z",
    heartbeatAt: "2026-01-02T03:04:10.000Z",
    capabilities: FIXTURE_CAPABILITIES,
    ...overrides,
  };
}

function operatorRegistryDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: OPERATOR_REGISTRY_DETAILS_SCHEMA,
    agent: { id: "presence-agent", label: "Presence Agent" },
    operator: {
      endpoint: "http://127.0.0.1:8765/operator",
      tokenEnvironment: "PRESENCE_OPERATOR_TOKEN",
    },
    process: { pid: 314, startedAt: "2026-01-02T03:04:05.000Z" },
    capabilities: FIXTURE_CAPABILITIES,
    ...overrides,
  };
}

function statePresence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "mono-agent.state-presence.v1",
    sourceId: "presence-agent",
    sourceLabel: "Presence Agent",
    instanceId: "presence-instance",
    pid: 999,
    stateRoot: "/owner-private/state",
    status: "ready",
    startedAt: "2026-01-02T02:00:00.000Z",
    heartbeatAt: "2026-01-02T03:04:20.000Z",
    details: { operatorRegistry: operatorRegistryDetails() },
    ...overrides,
  };
}

async function writeDescriptor(registry: string, name: string, value: unknown, mode = 0o600): Promise<string> {
  const path = join(registry, name);
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator directory", () => {
  it("discovers, normalizes, deduplicates, and selects owner-private entries deterministically", async () => {
    const older = await temporaryRegistry();
    const newer = await temporaryRegistry();
    await writeDescriptor(older, "agent.json", descriptor());
    await writeDescriptor(newer, "agent.json", descriptor({ heartbeatAt: "2026-01-02T03:04:20.000Z" }));
    const entries = await discoverOperators({
      registryDirectories: [newer, older],
      now: new Date("2026-01-02T03:04:30.000Z"),
      staleAfterMs: 15_000,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "fixture-agent", endpoint: "http://127.0.0.1:4321/operator", stale: false });
    expect(entries[0]!.heartbeatAt).toBe("2026-01-02T03:04:20.000Z");

    const directory = new OperatorDirectory(entries);
    expect(directory.select()).toEqual(entries[0]);
    directory.pin("fixture-agent");
    expect(directory.pinnedId).toBe("fixture-agent");
  });

  it("marks stale entries without making wall-clock decisions inside the domain state", async () => {
    const registry = await temporaryRegistry();
    await writeDescriptor(registry, "agent.json", descriptor());
    const [entry] = await discoverOperators({ registryDirectories: [registry], now: Date.parse("2026-01-02T03:05:00.000Z"), staleAfterMs: 10_000 });
    expect(entry?.stale).toBe(true);
    expect(() => new OperatorDirectory([entry!]).select()).toThrow("no live operator");
  });

  it("normalizes an active state-local presence using the exact operator process identity", async () => {
    const registry = await temporaryRegistry();
    const path = await writeDescriptor(registry, "presence.json", statePresence({ status: "degraded" }));

    const entries = await discoverOperators({
      registryDirectories: [registry],
      now: Date.parse("2026-01-02T03:04:30.000Z"),
      staleAfterMs: 15_000,
    });

    expect(entries).toEqual([{
      id: "presence-agent",
      label: "Presence Agent",
      endpoint: "http://127.0.0.1:8765/operator",
      tokenEnvironment: "PRESENCE_OPERATOR_TOKEN",
      pid: 314,
      startedAt: "2026-01-02T03:04:05.000Z",
      heartbeatAt: "2026-01-02T03:04:20.000Z",
      stale: false,
      sourcePath: path,
      capabilities: FIXTURE_CAPABILITIES,
    }]);
  });

  it("skips recognized non-serving lifecycle states and active sources without an operator", async () => {
    const registry = await temporaryRegistry();
    await writeDescriptor(registry, "01-starting.json", statePresence({
      status: "starting",
      details: { operatorRegistry: operatorRegistryDetails() },
    }));
    await writeDescriptor(registry, "02-stopping.json", statePresence({ status: "stopping" }));
    await writeDescriptor(registry, "03-stopped.json", statePresence({ status: "stopped" }));
    await writeDescriptor(registry, "04-ready-without-operator.json", statePresence({
      status: "ready",
      details: { state: "available" },
    }));
    await writeDescriptor(registry, "05-degraded-without-operator.json", statePresence({
      status: "degraded",
      details: { reason: "operator intentionally disabled" },
    }));

    await expect(discoverOperators({ registryDirectories: [registry] })).resolves.toEqual([]);
  });

  it("fails closed on malformed state envelopes and malformed active operator details", async () => {
    const malformedEnvelope = await temporaryRegistry();
    await writeDescriptor(malformedEnvelope, "presence.json", statePresence({ unexpected: true }));
    await expect(discoverOperators({ registryDirectories: [malformedEnvelope] })).rejects.toMatchObject({
      code: "INVALID_REGISTRY",
      cause: { message: expect.stringContaining("unknown field") },
    });

    const malformedOperator = await temporaryRegistry();
    const missingCapabilities = operatorRegistryDetails();
    delete missingCapabilities.capabilities;
    await writeDescriptor(malformedOperator, "presence.json", statePresence({
      details: { operatorRegistry: missingCapabilities },
    }));
    await expect(discoverOperators({ registryDirectories: [malformedOperator] })).rejects.toMatchObject({
      code: "INVALID_REGISTRY",
      cause: { message: expect.stringContaining("capabilities is required") },
    });
  });

  it("rejects permissive files and symlink entries without repairing them", async () => {
    const registry = await temporaryRegistry();
    const permissive = await writeDescriptor(registry, "permissive.json", descriptor(), 0o644);
    await expect(discoverOperators({ registryDirectories: [registry] })).rejects.toMatchObject({ code: "UNSAFE_REGISTRY" });
    await chmod(permissive, 0o600);

    const target = await writeDescriptor(registry, "target.txt", descriptor());
    await symlink(target, join(registry, "linked.json"));
    await expect(discoverOperators({ registryDirectories: [registry] })).rejects.toMatchObject({ code: "UNSAFE_REGISTRY" });
  });

  it("rejects malformed descriptors and non-loopback endpoints", async () => {
    const malformedRegistry = await temporaryRegistry();
    await writeDescriptor(malformedRegistry, "bad.json", { schema: OPERATOR_REGISTRY_SCHEMA });
    await expect(discoverOperators({ registryDirectories: [malformedRegistry] })).rejects.toMatchObject({ code: "INVALID_REGISTRY" });

    const remoteRegistry = await temporaryRegistry();
    await writeDescriptor(remoteRegistry, "remote.json", descriptor({ operator: { endpoint: "http://example.com/operator" } }));
    await expect(discoverOperators({ registryDirectories: [remoteRegistry] })).rejects.toThrow("literal 127/8 or ::1");

    const secretRegistry = await temporaryRegistry();
    await writeDescriptor(secretRegistry, "secret.json", descriptor({
      operator: { endpoint: "http://127.0.0.1:4321/operator", tokenEnvironment: "NOT-A-VALID-ENV-NAME" },
    }));
    await expect(discoverOperators({ registryDirectories: [secretRegistry] })).rejects.toMatchObject({
      code: "INVALID_REGISTRY",
      cause: { message: expect.stringContaining("valid environment variable name") },
    });
  });

  it("resolves a named token only when constructing a client", async () => {
    const entry = {
      id: "fixture-agent",
      label: "Fixture Agent",
      endpoint: "http://127.0.0.1:4321/operator",
      tokenEnvironment: "FIXTURE_OPERATOR_TOKEN",
      pid: 42,
      startedAt: "2026-01-02T03:04:05.000Z",
      heartbeatAt: "2026-01-02T03:04:10.000Z",
      stale: false,
      sourcePath: "/owner-private/fixture.json",
    } as const;
    expect(() => createOperatorClientForEntry(entry, { env: {} })).toThrow(OperatorDirectoryError);

    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-value");
      return new Response(JSON.stringify({
        protocol: OPERATOR_PROTOCOL,
        agent: { id: "fixture-agent", label: "Fixture Agent" },
        process: { pid: 42, startedAt: "2026-01-02T03:04:05.000Z" },
        capabilities: FIXTURE_CAPABILITIES,
      }), { headers: { "content-type": "application/json" } });
    });
    const client = createOperatorClientForEntry(entry, { env: { FIXTURE_OPERATOR_TOKEN: "secret-value" }, fetch });
    await expect(client.getInfo()).resolves.toMatchObject({ agent: { id: "fixture-agent" } });
  });

  it("exposes one canonical default registry location", () => {
    expect(getDefaultOperatorRegistryDirectory()).toMatch(/[\\/]\.mono-agent[\\/]trace-sources$/);
  });

  it("one foreign-schema file does not hide healthy operators", async () => {
    const registry = await temporaryRegistry();
    await writeFile(join(registry, "agent.json"), JSON.stringify(descriptor()), { mode: 0o600 });
    await chmod(join(registry, "agent.json"), 0o600);
    // A registry directory is shared ground; another tool's file must be
    // skipped rather than take every healthy operator down with it.
    await writeFile(
      join(registry, "foreign.json"),
      JSON.stringify({ schema: "some.other.v1", anything: true }),
      { mode: 0o600 },
    );
    await chmod(join(registry, "foreign.json"), 0o600);

    await expect(discoverOperators({ registryDirectories: [registry] }))
      .resolves.toMatchObject([{ id: "fixture-agent" }]);
  });

  it("still fails closed on a malformed file that claims our own schema", async () => {
    const registry = await temporaryRegistry();
    await writeFile(
      join(registry, "broken.json"),
      JSON.stringify({ schema: OPERATOR_REGISTRY_SCHEMA, agent: { id: "" } }),
      { mode: 0o600 },
    );
    await chmod(join(registry, "broken.json"), 0o600);

    await expect(discoverOperators({ registryDirectories: [registry] })).rejects.toThrow();
  });

  it("rejects unsafe prototype keys in presence details", async () => {
    const registry = await temporaryRegistry();
    // The directory copy of the JSON walker used to allow these keys while the
    // protocol copy rejected them; both now share one definition.
    await writeFile(join(registry, "presence.json"), JSON.stringify({
      schema: "mono-agent.state-presence.v1",
      sourceId: "presence-agent",
      sourceLabel: "Presence Agent",
      instanceId: "instance",
      pid: 314,
      stateRoot: "/tmp/state",
      status: "ready",
      startedAt: "2026-01-02T03:04:05.000Z",
      heartbeatAt: "2026-01-02T03:04:10.000Z",
      details: { operatorRegistry: operatorRegistryDetails(), nested: { constructor: "unsafe" } },
    }), { mode: 0o600 });
    await chmod(join(registry, "presence.json"), 0o600);

    await expect(discoverOperators({ registryDirectories: [registry] })).rejects.toMatchObject({
      code: "INVALID_REGISTRY",
    });
  });
});
