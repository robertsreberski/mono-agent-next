import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "@mono-agent/runtime-adapter";
import { safeRebuildMemoryIndex } from "@mono-agent/memory/bujo";
import * as memoryStore from "@mono-agent/memory/store";

import { canonicalContinuationJson, continuationDigest } from "../continuations.js";
import { MAX_RECORD_BYTES } from "../continuation-store-types.js";
import { launchdLogsSectionFromInspection, validateMonoAgentFolder } from "../doctor.js";
import type { SdkAuthStatusExecFile } from "../doctor.js";
import type { LaunchdLogInspection } from "../launchd-logs.js";
import { agentAppPackageVersion } from "../package-version.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-doctor-"));
});

describe("launchd log doctor section", () => {
  it("reports exact active, retained, and total bytes without mutating inventory", () => {
    const inspection: LaunchdLogInspection = {
      stdout: {
        activeBytes: 123,
        retainedBytes: 456,
        totalBytes: 579,
        byteAccountingComplete: true,
        files: [{ generation: 0, state: "ok", bytes: 123 }],
      },
      stderr: {
        activeBytes: 7,
        retainedBytes: 11,
        totalBytes: 18,
        byteAccountingComplete: true,
        files: [{ generation: 0, state: "ok", bytes: 7 }],
      },
      present: true,
      canMaintain: true,
      needsMaintenance: false,
      pendingTransaction: false,
      pendingMaintenance: false,
      issues: [],
    };

    const section = launchdLogsSectionFromInspection(inspection);

    expect(section.status).toBe("ok");
    expect(section.details).toContain("stdout: active=123 bytes, retained=456 bytes, total=579 bytes.");
    expect(section.details).toContain("stderr: active=7 bytes, retained=11 bytes, total=18 bytes.");
    expect(inspection.stdout.activeBytes).toBe(123);
  });

  it("warns on unsafe or oversized inventory and marks absent inventory disabled", () => {
    const maxBytes = 5 * 1024 * 1024;
    const waiting = launchdLogsSectionFromInspection({
      stdout: {
        activeBytes: maxBytes + 1,
        retainedBytes: 0,
        totalBytes: maxBytes + 1,
        byteAccountingComplete: false,
        files: [{ generation: 0, state: "unsafe", bytes: maxBytes + 1, issue: "symbolic link" }],
      },
      stderr: {
        activeBytes: maxBytes + 2,
        retainedBytes: 0,
        totalBytes: maxBytes + 2,
        byteAccountingComplete: true,
        files: [{ generation: 0, state: "ok", bytes: maxBytes + 2 }],
      },
      present: true,
      canMaintain: false,
      needsMaintenance: true,
      pendingTransaction: false,
      pendingMaintenance: false,
      issues: ["stdout: symbolic link"],
    });
    expect(waiting.status).toBe("waiting");
    expect(waiting.details.join(" ")).toContain("maintenance limit");
    expect(waiting.details.join(" ")).toContain("symbolic link");
    expect(waiting.details).toContain(
      "stdout: byte inventory unavailable because one or more paths could not be inspected safely.",
    );
    expect(waiting.details.join(" ")).not.toContain(`stdout: active=${String(maxBytes + 1)}`);

    const disabled = launchdLogsSectionFromInspection({
      stdout: { activeBytes: 0, retainedBytes: 0, totalBytes: 0, byteAccountingComplete: true, files: [] },
      stderr: { activeBytes: 0, retainedBytes: 0, totalBytes: 0, byteAccountingComplete: true, files: [] },
      present: false,
      canMaintain: true,
      needsMaintenance: false,
      pendingTransaction: false,
      pendingMaintenance: false,
      issues: [],
    });
    expect(disabled.status).toBe("disabled");
    expect(disabled.details).toContain("No managed launchd log files exist yet.");
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json, null, 2));
  return configPath;
}

function sectionById(report: Awaited<ReturnType<typeof validateMonoAgentFolder>>, id: string) {
  const section = report.sections.find((candidate) => candidate.id === id);
  expect(section, `section ${id}`).toBeDefined();
  return section!;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function doctorPreparedContinuationRecord(input: {
  readonly id: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly historyBoundary: string;
  readonly snapshotDigest: string;
}): Record<string, unknown> {
  const now = "2026-07-14T12:00:00.000Z";
  return {
    continuationId: input.id,
    serverName: "doctor-fixture",
    originRunId: input.originRunId,
    originConversationId: input.originConversationId,
    replyToConversationId: input.originConversationId,
    historyBoundary: input.historyBoundary,
    originContextState: "pending",
    originContextRef: {
      schemaVersion: 1,
      digest: input.snapshotDigest,
      bytes: 128,
      messageCount: 2,
    },
    originContextDigest: input.snapshotDigest,
    originContextMessageCount: 2,
    originContextFingerprint: continuationDigest(`origin-${input.id}`),
    originContextBindingMac: continuationDigest(`binding-${input.id}`),
    mode: "reply",
    taskKey: `task-${input.id}`,
    taskHash: continuationDigest(`task-${input.id}`),
    claimFingerprint: continuationDigest(`claim-${input.id}`),
    resultTokenHash: continuationDigest(`token-${input.id}`),
    createdAt: now,
    updatedAt: now,
    deadline: "2030-07-14T13:00:00.000Z",
    state: "claimed",
    synthesisAttempts: 0,
    synthesisDeferrals: 0,
    deliveryAttempts: 0,
  };
}

async function seedDoctorV3Store(
  stateDir: string,
  rollbackGuardRequired: boolean,
): Promise<{ readonly recordsDir: string; readonly manifestPath: string }> {
  const recordsDir = join(stateDir, "records-v3");
  await mkdir(recordsDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await chmod(recordsDir, 0o700);
  if (rollbackGuardRequired) {
    const legacyRecordsDir = join(stateDir, "records-v2");
    await mkdir(legacyRecordsDir, { mode: 0o700 });
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
  }
  const manifestPath = join(stateDir, "continuation-store-v3.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 3,
    generation: "doctor-v3-generation",
    updatedAt: "2026-07-14T12:00:00.000Z",
    rollbackGuardRequired,
    stats: {
      format: "per-record-v3",
      records: 0,
      active: 0,
      unresolvedDelivery: 0,
      deadLettered: 0,
      terminalTombstones: 0,
      compacted: 0,
      capturedText: 0,
      historyDegraded: 0,
      limits: {
        terminalMaxRecords: 50_000,
        terminalMaxAgeMs: 31_536_000_000,
        capturedTextMaxRecords: 1_000,
        capturedTextMaxAgeMs: 2_592_000_000,
      },
    },
  }), { mode: 0o600 });
  return { recordsDir, manifestPath };
}

async function seedManagedMemoryFixture(input: {
  readonly root: string;
  readonly tier: "journal" | "bujo";
  readonly embeddingModel?: string;
  readonly dimension?: number;
}): Promise<void> {
  const dimension = input.dimension ?? 768;
  await safeRebuildMemoryIndex({
    root: input.root,
    tier: input.tier,
    ...(input.embeddingModel === undefined
      ? {}
      : {
          embeddings: {
            id: input.embeddingModel,
            embed: async (texts) => texts.map(() =>
              Array.from({ length: dimension }, (_value, index) => index === 0 ? 1 : 0)),
          },
          dim: dimension,
        }),
  });
}

async function writeRunSummary(artifactDir: string, name: string, summary: Record<string, unknown>): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

const availableSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return true;
  },
  async prepareCommand() {
    throw new Error("not used in validation");
  },
};

const unavailableSandboxEngine: SandboxEngine = {
  id: "fake-srt",
  async isAvailable() {
    return false;
  },
  async prepareCommand() {
    throw new Error("not used in validation");
  },
};

describe("validateMonoAgentFolder", () => {
  it("reports a ready config with runtime, fallback, and channel sections", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      context: { identityPath: "./IDENTITY.md" },
      webhook: { enabled: true },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      sdkAuthStatusExecFile: async () => ({ stdout: "" }),
    });

    expect(report.ok).toBe(true);
    expect(sectionById(report, "core").status).toBe("ok");
    expect(sectionById(report, "runtime-provenance").details)
      .toContain("Runtime provenance: dev (unmanaged).");
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("ok");
    expect(runtime.details.join("\n")).toContain("Fallback model claude:claude-sonnet-4-6");
    expect(sectionById(report, "channel:webhook").status).toBe("ok");
    expect(report.sections.some((section) => section.id === "channel:a2a")).toBe(false);
    expect(sectionById(report, "channel:telegram").status).toBe("disabled");
  });

  it("reports runtime provenance even when core config cannot load", async () => {
    const configPath = join(dir, "missing.config.json");

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      drivers: [],
      liveness: false,
      allowFilesystemWrites: false,
    });

    expect(sectionById(report, "core").status).toBe("error");
    expect(sectionById(report, "runtime-provenance")).toEqual({
      id: "runtime-provenance",
      label: "Runtime provenance",
      status: "ok",
      details: ["Runtime provenance: dev (unmanaged)."],
    });
  });

  it("reuses launch-verified managed runtime provenance without a second closure scan", async () => {
    const configPath = join(dir, "missing.config.json");
    const verifiedDetail = "Runtime provenance: managed closure verified-by-launch.";

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      drivers: [],
      liveness: false,
      allowFilesystemWrites: false,
      verifiedRuntimeProvenanceDetail: verifiedDetail,
    });

    expect(sectionById(report, "runtime-provenance").details).toEqual([verifiedDetail]);
  });

  it("reports fixed-port continuation configuration without creating state during read-only validation", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: { "a8c-control": { command: "a8c-control" } },
    }));
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { mcpConfigPath, continuationServers: ["a8c-control"] },
      continuations: { port: 4381 },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      allowFilesystemWrites: false,
    });

    const section = sectionById(report, "continuations");
    expect(section.status).toBe("ok");
    expect(section.details.join("\n")).toContain("http://127.0.0.1:4381");
    expect(section.details.join("\n")).toContain("a8c-control");
    expect(await pathExists(stateDir)).toBe(false);
  });

  it("fails continuation doctor validation for ephemeral configured ports", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: { port: 0 },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(report, "continuations").details.join("\n")).toContain("between 1 and 65535");
  });

  it("surfaces continuation lifecycle counts without exposing stored result payloads", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const ledgerPath = join(stateDir, "continuations-v1.json");
    await writeFile(ledgerPath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      records: {
        unknown: {
          ...doctorPreparedContinuationRecord({
            id: "unknown",
            originRunId: "run-unknown",
            originConversationId: "doctor:legacy",
            historyBoundary: "run-unknown",
            snapshotDigest: continuationDigest("snapshot-unknown"),
          }),
          state: "delivery_unknown",
          resultPayload: "TOP SECRET",
        },
        dead: {
          ...doctorPreparedContinuationRecord({
            id: "dead",
            originRunId: "run-dead",
            originConversationId: "doctor:legacy",
            historyBoundary: "run-dead",
            snapshotDigest: continuationDigest("snapshot-dead"),
          }),
          state: "dead_lettered",
          resultPayload: "MORE SECRET",
        },
        pending: {
          ...doctorPreparedContinuationRecord({
            id: "pending",
            originRunId: "run-pending",
            originConversationId: "doctor:legacy",
            historyBoundary: "run-pending",
            snapshotDigest: continuationDigest("snapshot-pending"),
          }),
          state: "delivery_retry",
          synthesizedText: "PRIVATE ANSWER",
        },
      },
    }), { mode: 0o600 });
    await chmod(ledgerPath, 0o600);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const section = sectionById(report, "continuations");
    expect(section.status).toBe("waiting");
    expect(section.details.join("\n")).toContain("3 total; 1 pending; 1 delivery unknown; 1 dead-lettered");
    expect(section.details.join("\n")).not.toContain("TOP SECRET");
    expect(section.details.join("\n")).not.toContain("PRIVATE ANSWER");
  });

  it("rejects a v1 monolith whose individual record cannot fit the v3 record bound", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const recordId = "doctor-oversized-v1-record";
    await writeFile(join(stateDir, "continuations-v1.json"), JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: {
        [recordId]: {
          ...doctorPreparedContinuationRecord({
            id: recordId,
            originRunId: "run-doctor-oversized-v1",
            originConversationId: "doctor:oversized-v1",
            historyBoundary: "run-doctor-oversized-v1",
            snapshotDigest: continuationDigest("doctor-oversized-v1-snapshot"),
          }),
          resultPayload: "x".repeat((2 * 1024 * 1024) + 1),
        },
      },
    }), { mode: 0o600 });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const section = sectionById(report, "continuations");
    expect(section.status).toBe("error");
    expect(section.details.join("\n"))
      .toContain("Continuation legacy record exceeds its 2097152 byte safety limit");
  });

  it("rejects a legacy retention projection that cannot fit its v3 tombstone", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const recordId = "doctor-retention-growth";
    const record: Record<string, unknown> = {
      ...doctorPreparedContinuationRecord({
        id: recordId,
        originRunId: "run-doctor-retention-growth",
        originConversationId: "doctor:retention-growth",
        historyBoundary: "run-doctor-retention-growth",
        snapshotDigest: continuationDigest("doctor-retention-growth-snapshot"),
      }),
      originContextState: "legacy_missing",
      state: "delivered",
      lastError: {
        code: "retained_terminal",
        reason: "",
        at: "2026-07-14T12:00:00.000Z",
      },
    };
    delete record.originContextRef;
    const emptyReasonBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    (record.lastError as Record<string, unknown>).reason = "x".repeat(MAX_RECORD_BYTES - emptyReasonBytes);
    expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8")).toBe(MAX_RECORD_BYTES);
    await writeFile(join(stateDir, "continuations-v1.json"), JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: { [recordId]: record },
    }), { mode: 0o600 });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: { retention: { terminalMaxAgeMs: Number.MAX_SAFE_INTEGER } },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const section = sectionById(report, "continuations");
    expect(section.status).toBe("error");
    expect(section.details.join("\n"))
      .toContain("Continuation retained record exceeds its 2097152 byte safety limit");
  });

  it("reports bounded v3 storage and history degradation without exposing record payloads", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const recordsDir = join(stateDir, "records-v3");
    const legacyRecordsDir = join(stateDir, "records-v2");
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await mkdir(legacyRecordsDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await chmod(recordsDir, 0o700);
    await chmod(legacyRecordsDir, 0o700);
    const recordId = "doctor-valid-secret-record";
    const recordPath = join(recordsDir, `${continuationDigest(recordId)}.json`);
    await writeFile(recordPath, JSON.stringify({
      ...doctorPreparedContinuationRecord({
        id: recordId,
        originRunId: "run-doctor-secret",
        originConversationId: "doctor:secret",
        historyBoundary: "run-doctor-secret",
        snapshotDigest: continuationDigest("doctor-secret-snapshot"),
      }),
      resultPayload: "TOP SECRET V3",
    }), { mode: 0o600 });
    await chmod(recordPath, 0o600);
    const rollbackGuardPath = join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3");
    await writeFile(
      rollbackGuardPath,
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
    await chmod(rollbackGuardPath, 0o600);
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 3,
      generation: "TOP SECRET V3 GENERATION",
      updatedAt: new Date().toISOString(),
      stats: {
        format: "per-record-v3",
        records: 8,
        active: 1,
        unresolvedDelivery: 1,
        deadLettered: 1,
        terminalTombstones: 4,
        compacted: 3,
        capturedText: 2,
        historyDegraded: 1,
        limits: {
          terminalMaxRecords: 50_001,
          terminalMaxAgeMs: 31_536_000_002,
          capturedTextMaxRecords: 1_003,
          capturedTextMaxAgeMs: 2_592_000_004,
        },
      },
    }), { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const section = sectionById(report, "continuations");
    expect(section.status).toBe("waiting");
    expect(section.details).toContain(
      "Store v3: 8 retained; 1 active; 1 delivery unknown; 1 dead-lettered; 1 history-degraded deliveries; 4 terminal tombstones; 3 compacted; 2 captured answers.",
    );
    expect(section.details).toContain(
      "Retention: at most 50001 terminal tombstones with a maximum age of 31536000002 ms and 1003 captured answers with a maximum age of 2592000004 ms.",
    );
    expect(section.details.join("\n")).toContain("rollback guard prevents older runtimes");
    expect(section.details.join("\n")).not.toContain("TOP SECRET V3");
  });

  it("rejects continuation manifests whose compacted and age-limit fields are missing or malformed", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    const validManifest = {
      schemaVersion: 3,
      generation: "PRIVATE MANIFEST SENTINEL",
      updatedAt: new Date().toISOString(),
      stats: {
        format: "per-record-v3",
        records: 3,
        active: 1,
        unresolvedDelivery: 0,
        deadLettered: 0,
        terminalTombstones: 2,
        compacted: 2,
        capturedText: 1,
        historyDegraded: 0,
        limits: {
          terminalMaxRecords: 101,
          terminalMaxAgeMs: 102,
          capturedTextMaxRecords: 103,
          capturedTextMaxAgeMs: 104,
        },
      },
    };
    const invalidCases: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (manifest: typeof validManifest) => void;
    }> = [
      {
        label: "missing compacted",
        mutate: (manifest) => {
          Reflect.deleteProperty(manifest.stats, "compacted");
        },
      },
      {
        label: "malformed compacted",
        mutate: (manifest) => {
          Reflect.set(manifest.stats, "compacted", "two");
        },
      },
      {
        label: "missing terminalMaxAgeMs",
        mutate: (manifest) => {
          Reflect.deleteProperty(manifest.stats.limits, "terminalMaxAgeMs");
        },
      },
      {
        label: "malformed terminalMaxAgeMs",
        mutate: (manifest) => {
          Reflect.set(manifest.stats.limits, "terminalMaxAgeMs", "102");
        },
      },
      {
        label: "missing capturedTextMaxAgeMs",
        mutate: (manifest) => {
          Reflect.deleteProperty(manifest.stats.limits, "capturedTextMaxAgeMs");
        },
      },
      {
        label: "malformed capturedTextMaxAgeMs",
        mutate: (manifest) => {
          Reflect.set(manifest.stats.limits, "capturedTextMaxAgeMs", "104");
        },
      },
    ];
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    for (const invalidCase of invalidCases) {
      const manifest = structuredClone(validManifest);
      invalidCase.mutate(manifest);
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      await chmod(manifestPath, 0o600);

      const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
      const section = sectionById(report, "continuations");
      const details = section.details.join("\n");
      expect(section.status, invalidCase.label).toBe("error");
      expect(details, invalidCase.label).toContain("Continuation store manifest has an unsupported or malformed schema.");
      expect(details, invalidCase.label).not.toContain("PRIVATE MANIFEST SENTINEL");
    }
  });

  it("requires the same v3 manifest generation and timestamp fields as runtime recovery", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const { manifestPath } = await seedDoctorV3Store(stateDir, false);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    await writeFile(manifestPath, JSON.stringify({ ...manifest, generation: "" }), { mode: 0o600 });
    const emptyGeneration = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(emptyGeneration, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(emptyGeneration, "continuations").details.join("\n"))
      .toContain("manifest has an unsupported or malformed schema");

    const missingTimestamp = { ...manifest };
    delete missingTimestamp.updatedAt;
    await writeFile(manifestPath, JSON.stringify(missingTimestamp), { mode: 0o600 });
    const noUpdatedAt = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(noUpdatedAt, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(noUpdatedAt, "continuations").details.join("\n"))
      .toContain("manifest has an unsupported or malformed schema");

    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      generation: "g".repeat(257),
    }), { mode: 0o600 });
    const oversizedGeneration = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(oversizedGeneration, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(oversizedGeneration, "continuations").details.join("\n"))
      .toContain("manifest has an unsupported or malformed schema");
  });

  it("accepts an empty v3 store before its lazy rollback guard is needed", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const recordsDir = join(stateDir, "records-v3");
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await chmod(recordsDir, 0o700);
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    const manifest = {
      schemaVersion: 3,
      generation: "generation-empty-v3",
      updatedAt: new Date().toISOString(),
      rollbackGuardRequired: false,
      stats: {
        format: "per-record-v3",
        records: 0,
        active: 0,
        unresolvedDelivery: 0,
        deadLettered: 0,
        terminalTombstones: 0,
        compacted: 0,
        capturedText: 0,
        historyDegraded: 0,
        limits: {
          terminalMaxRecords: 50_000,
          terminalMaxAgeMs: 31_536_000_000,
          capturedTextMaxRecords: 1_000,
          capturedTextMaxAgeMs: 2_592_000_000,
        },
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const section = sectionById(report, "continuations");
    expect(section.status).toBe("ok");
    expect(section.details.join("\n")).toContain("empty v3 store has no v2 rollback guard");
    expect(section.details.join("\n")).toContain("before its first v3 record becomes durable");
    expect(await pathExists(join(stateDir, "records-v2"))).toBe(false);

    const unsafeLegacyPath = join(stateDir, "continuations-v1.json");
    await mkdir(unsafeLegacyPath);
    const unsafeLegacyReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const unsafeLegacySection = sectionById(unsafeLegacyReport, "continuations");
    expect(unsafeLegacySection.status).toBe("error");
    expect(unsafeLegacySection.details.join("\n")).toContain("single-link regular file");
    await rm(unsafeLegacyPath, { recursive: true });

    const staleRecordId = "doctor-stale-v3-record";
    const staleRecordPath = join(recordsDir, `${continuationDigest(staleRecordId)}.json`);
    await writeFile(staleRecordPath, JSON.stringify(doctorPreparedContinuationRecord({
      id: staleRecordId,
      originRunId: "run-doctor-stale",
      originConversationId: "doctor:stale",
      historyBoundary: "run-doctor-stale",
      snapshotDigest: continuationDigest("doctor-stale-snapshot"),
    })), { mode: 0o600 });
    const staleRecordReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const staleRecordSection = sectionById(staleRecordReport, "continuations");
    expect(staleRecordSection.status).toBe("error");
    expect(staleRecordSection.details.join("\n")).toContain("rollback guard is missing");
    await rm(staleRecordPath);

    const groupIdentity = {
      originRunId: "run-doctor-marker",
      originConversationId: "doctor:marker",
      historyBoundary: "run-doctor-marker",
    };
    const groupKey = continuationDigest(
      `mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`,
    );
    const markerMemberId = "doctor-marker-member";
    const groupMarker = {
      schemaVersion: 1,
      groupKey,
      ...groupIdentity,
      snapshotDigest: continuationDigest("doctor-marker-snapshot"),
      memberCount: 1,
      memberSetDigest: continuationDigest(
        `mono-agent-origin-context-members-v1\0${canonicalContinuationJson([markerMemberId])}`,
      ),
      activatedAt: "2026-07-14T12:01:00.000Z",
    };
    const markerRecordPath = join(recordsDir, `${continuationDigest(markerMemberId)}.json`);
    await writeFile(
      markerRecordPath,
      JSON.stringify(doctorPreparedContinuationRecord({
        id: markerMemberId,
        ...groupIdentity,
        snapshotDigest: groupMarker.snapshotDigest,
      })),
      { mode: 0o600 },
    );
    const originGroupsDir = join(stateDir, "origin-context-groups-v1");
    await mkdir(originGroupsDir, { mode: 0o700 });
    await writeFile(join(originGroupsDir, `${groupKey}.json`), JSON.stringify(groupMarker), { mode: 0o600 });
    const groupMarkerReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const groupMarkerSection = sectionById(groupMarkerReport, "continuations");
    expect(groupMarkerSection.status).toBe("error");
    expect(groupMarkerSection.details.join("\n")).toContain("rollback guard is missing");
    await rm(originGroupsDir, { recursive: true });
    await rm(markerRecordPath);

    const legacyTransactionPath = join(stateDir, "continuation-transaction-v2.json");
    await writeFile(legacyTransactionPath, JSON.stringify({
      schemaVersion: 2,
      generation: "doctor-v2-pending",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [],
      deletes: [],
    }), { mode: 0o600 });
    const legacyReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const legacySection = sectionById(legacyReport, "continuations");
    expect(legacySection.status).toBe("waiting");
    expect(legacySection.details.join("\n")).toContain("awaiting idempotent v3 migration");
    await writeFile(legacyTransactionPath, "{}\n", { mode: 0o600 });
    const malformedLegacyReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const malformedLegacySection = sectionById(malformedLegacyReport, "continuations");
    expect(malformedLegacySection.status).toBe("error");
    expect(malformedLegacySection.details.join("\n")).toContain("v2 transaction has an unsupported or malformed schema");
    await rm(legacyTransactionPath);

    const legacyRecordsDir = join(stateDir, "records-v2");
    await mkdir(legacyRecordsDir, { mode: 0o700 });
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
    const guardedFalseReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const guardedFalseSection = sectionById(guardedFalseReport, "continuations");
    expect(guardedFalseSection.status).toBe("waiting");
    expect(guardedFalseSection.details.join("\n")).toContain("awaiting idempotent v3 migration");
    await rm(legacyRecordsDir, { recursive: true });

    const fieldlessManifest = { ...manifest } as Record<string, unknown>;
    delete fieldlessManifest.rollbackGuardRequired;
    await writeFile(manifestPath, JSON.stringify(fieldlessManifest), { mode: 0o600 });
    const fieldlessReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const fieldlessSection = sectionById(fieldlessReport, "continuations");
    expect(fieldlessSection.status).toBe("error");
    expect(fieldlessSection.details.join("\n")).toContain("rollback guard is missing");

    await mkdir(legacyRecordsDir, { mode: 0o700 });
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
    await writeFile(manifestPath, JSON.stringify({ ...manifest, rollbackGuardRequired: true }), { mode: 0o600 });
    const activatedEmptyReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const activatedEmptySection = sectionById(activatedEmptyReport, "continuations");
    expect(activatedEmptySection.status).toBe("ok");
    expect(activatedEmptySection.details.join("\n")).toContain("rollback guard prevents older runtimes");

    await mkdir(originGroupsDir, { mode: 0o700 });
    await writeFile(join(originGroupsDir, `${groupKey}.json`), JSON.stringify(groupMarker), { mode: 0o600 });
    const unmatchedMarkerReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const unmatchedMarkerSection = sectionById(unmatchedMarkerReport, "continuations");
    expect(unmatchedMarkerSection.status).toBe("error");
    expect(unmatchedMarkerSection.details.join("\n")).toContain("does not match the recoverable durable records");

    const matchingMarker = groupMarker;
    await writeFile(join(originGroupsDir, `${groupKey}.json`), JSON.stringify(matchingMarker), { mode: 0o600 });
    await writeFile(
      markerRecordPath,
      JSON.stringify(doctorPreparedContinuationRecord({
        id: markerMemberId,
        ...groupIdentity,
        snapshotDigest: matchingMarker.snapshotDigest,
      })),
      { mode: 0o600 },
    );
    const guardedMarkerReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const guardedMarkerSection = sectionById(guardedMarkerReport, "continuations");
    expect(guardedMarkerSection.status).toBe("waiting");
    expect(guardedMarkerSection.details.join("\n")).toContain("durable marker awaiting idempotent recovery");
    await writeFile(join(originGroupsDir, `${groupKey}.json`), "{}\n", { mode: 0o600 });
    const malformedMarkerReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const malformedMarkerSection = sectionById(malformedMarkerReport, "continuations");
    expect(malformedMarkerSection.status).toBe("error");
    expect(malformedMarkerSection.details.join("\n")).toContain("malformed schema or filename");
    await rm(markerRecordPath);
    await rm(originGroupsDir, { recursive: true });

    await mkdir(originGroupsDir, { mode: 0o700 });
    await writeFile(join(originGroupsDir, "unexpected.txt"), "{}\n", { mode: 0o600 });
    const unexpectedMarkerReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const unexpectedMarkerSection = sectionById(unexpectedMarkerReport, "continuations");
    expect(unexpectedMarkerSection.status).toBe("error");
    expect(unexpectedMarkerSection.details.join("\n")).toContain("unexpected entry");
    await rm(originGroupsDir, { recursive: true });

    await mkdir(join(originGroupsDir, `${"d".repeat(64)}.json`), { recursive: true, mode: 0o700 });
    const directoryMarkerReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const directoryMarkerSection = sectionById(directoryMarkerReport, "continuations");
    expect(directoryMarkerSection.status).toBe("error");
    expect(directoryMarkerSection.details.join("\n")).toContain("unexpected entry");
  });

  it("validates v2/v3 transaction schemas and activation members projected from recovery", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    await seedDoctorV3Store(stateDir, true);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });
    const memberId = "doctor-transaction-member";
    const groupIdentity = {
      originRunId: "run-doctor-transaction",
      originConversationId: "doctor:transaction",
      historyBoundary: "run-doctor-transaction",
    };
    const snapshotDigest = continuationDigest("doctor-transaction-snapshot");
    const member = doctorPreparedContinuationRecord({
      id: memberId,
      ...groupIdentity,
      snapshotDigest,
    });
    const v3TransactionPath = join(stateDir, "continuation-transaction-v3.json");
    await writeFile(v3TransactionPath, JSON.stringify({
      schemaVersion: 3,
      generation: "doctor-v3-pending",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [member],
      deletes: [],
    }), { mode: 0o600 });
    const groupKey = continuationDigest(
      `mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`,
    );
    const groupsDir = join(stateDir, "origin-context-groups-v1");
    await mkdir(groupsDir, { mode: 0o700 });
    await writeFile(join(groupsDir, `${groupKey}.json`), JSON.stringify({
      schemaVersion: 1,
      groupKey,
      ...groupIdentity,
      snapshotDigest,
      memberCount: 1,
      memberSetDigest: continuationDigest(
        `mono-agent-origin-context-members-v1\0${canonicalContinuationJson([memberId])}`,
      ),
      activatedAt: "2026-07-14T12:01:00.000Z",
    }), { mode: 0o600 });

    const projected = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const projectedSection = sectionById(projected, "continuations");
    expect(projectedSection.status).toBe("waiting");
    expect(projectedSection.details.join("\n")).toContain("interrupted durable v3 transaction");
    expect(projectedSection.details.join("\n")).toContain("durable marker awaiting idempotent recovery");

    await writeFile(v3TransactionPath, JSON.stringify({
      schemaVersion: 3,
      generation: "g".repeat((1024 * 1024) + 1),
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [],
      deletes: [],
    }), { mode: 0o600 });
    const oversizedGeneration = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(oversizedGeneration, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(oversizedGeneration, "continuations").details.join("\n"))
      .toContain("v3 transaction has an unsupported or malformed schema");

    await writeFile(v3TransactionPath, "{}\n", { mode: 0o600 });
    const malformedV3 = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(malformedV3, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(malformedV3, "continuations").details.join("\n"))
      .toContain("v3 transaction has an unsupported or malformed schema");
    await rm(v3TransactionPath);
    await rm(groupsDir, { recursive: true });

    const v2TransactionPath = join(stateDir, "continuation-transaction-v2.json");
    await writeFile(v2TransactionPath, JSON.stringify({
      schemaVersion: 2,
      generation: "doctor-v2-stale-but-valid",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [],
      deletes: [],
    }), { mode: 0o600 });
    const validV2 = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(validV2, "continuations").status).toBe("ok");
    await writeFile(v2TransactionPath, "{}\n", { mode: 0o600 });
    const malformedV2 = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(malformedV2, "continuations")).toMatchObject({ status: "error" });
    expect(sectionById(malformedV2, "continuations").details.join("\n"))
      .toContain("v2 transaction has an unsupported or malformed schema");
  });

  it("rejects an activation marker whose projected record exceeds the v3 record bound", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const { recordsDir } = await seedDoctorV3Store(stateDir, true);
    const memberId = "doctor-oversized-activation";
    const groupIdentity = {
      originRunId: "run-doctor-oversized-activation",
      originConversationId: "doctor:oversized-activation",
      historyBoundary: "run-doctor-oversized-activation",
    };
    const snapshotDigest = continuationDigest("doctor-oversized-activation-snapshot");
    const record = {
      ...doctorPreparedContinuationRecord({ id: memberId, ...groupIdentity, snapshotDigest }),
      updatedAt: "2026-01-01",
      resultPayload: "",
    };
    const emptyPayloadBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    record.resultPayload = "x".repeat(MAX_RECORD_BYTES - emptyPayloadBytes);
    expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8")).toBe(MAX_RECORD_BYTES);
    await writeFile(
      join(recordsDir, `${continuationDigest(memberId)}.json`),
      JSON.stringify(record),
      { mode: 0o600 },
    );
    const groupKey = continuationDigest(
      `mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`,
    );
    const groupsDir = join(stateDir, "origin-context-groups-v1");
    await mkdir(groupsDir, { mode: 0o700 });
    await writeFile(join(groupsDir, `${groupKey}.json`), JSON.stringify({
      schemaVersion: 1,
      groupKey,
      ...groupIdentity,
      snapshotDigest,
      memberCount: 1,
      memberSetDigest: continuationDigest(
        `mono-agent-origin-context-members-v1\0${canonicalContinuationJson([memberId])}`,
      ),
      activatedAt: "2026-07-14T12:01:00.000Z",
    }), { mode: 0o600 });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const section = sectionById(report, "continuations");
    expect(section.status).toBe("error");
    expect(section.details.join("\n"))
      .toContain("Continuation activated record exceeds its 2097152 byte safety limit");
  });

  it("inspects applied records and cross-generation conflicts before an unmanifested recovery verdict", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const recordsV3 = join(stateDir, "records-v3");
    await mkdir(recordsV3, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });
    const recordId = "doctor-applied-before-manifest";
    const record = doctorPreparedContinuationRecord({
      id: recordId,
      originRunId: "run-doctor-applied",
      originConversationId: "doctor:applied",
      historyBoundary: "run-doctor-applied",
      snapshotDigest: continuationDigest("doctor-applied-snapshot"),
    });
    await writeFile(
      join(recordsV3, `${continuationDigest(recordId)}.json`),
      JSON.stringify(record),
      { mode: 0o600 },
    );

    const appliedV3 = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const appliedV3Section = sectionById(appliedV3, "continuations");
    expect(appliedV3Section.status).toBe("waiting");
    expect(appliedV3Section.details.join("\n")).toContain("awaiting completion of the v3 manifest");
    expect(appliedV3Section.details.join("\n")).not.toContain("No continuation ledger");

    await rm(recordsV3, { recursive: true });
    const recordsV2 = join(stateDir, "records-v2");
    await mkdir(recordsV2, { mode: 0o700 });
    await writeFile(
      join(recordsV2, `${continuationDigest(recordId)}.json`),
      JSON.stringify(record),
      { mode: 0o600 },
    );
    const appliedV2 = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(appliedV2, "continuations").status).toBe("waiting");
    expect(sectionById(appliedV2, "continuations").details.join("\n"))
      .toContain("awaiting completion of the v3 manifest");

    await writeFile(join(stateDir, "continuations-v1.json"), JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: {
        [recordId]: { ...record, taskHash: continuationDigest("conflicting-task") },
      },
    }), { mode: 0o600 });
    const conflicting = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const conflictingSection = sectionById(conflicting, "continuations");
    expect(conflictingSection.status).toBe("error");
    expect(conflictingSection.details.join("\n")).toContain("refusing lossy migration");
  });

  it("classifies safe activation temporaries as cleanup-only without closing the fresh rollback window", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const { recordsDir } = await seedDoctorV3Store(stateDir, false);
    const groupsDir = join(stateDir, "origin-context-groups-v1");
    await mkdir(groupsDir, { mode: 0o700 });
    const recordTemporary = join(recordsDir, ".orphan-record.tmp");
    const markerTemporary = join(groupsDir, ".orphan-marker.tmp");
    await writeFile(recordTemporary, "incomplete\n", { mode: 0o600 });
    await writeFile(markerTemporary, "incomplete\n", { mode: 0o600 });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const section = sectionById(report, "continuations");
    expect(section.status).toBe("ok");
    expect(section.details.join("\n")).toContain("only incomplete temporary debris awaiting cleanup");
    expect(section.details.join("\n")).not.toContain("durable marker awaiting idempotent recovery");
    expect(await pathExists(join(stateDir, "records-v2"))).toBe(false);
    expect(await pathExists(recordTemporary)).toBe(true);
    expect(await pathExists(markerTemporary)).toBe(true);

    await rm(join(stateDir, "continuation-store-v3.json"));
    const unmanifested = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(unmanifested, "continuations").status).toBe("ok");
    expect(sectionById(unmanifested, "continuations").details.join("\n"))
      .not.toContain("awaiting completion of the v3 manifest");
    expect(await pathExists(join(stateDir, "records-v2"))).toBe(false);
  });

  it("rejects linked, aliased, permissive, and oversized continuation recovery evidence", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    await seedDoctorV3Store(stateDir, true);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    const validManifest = await readFile(manifestPath, "utf8");
    const manifestAlias = join(stateDir, "manifest-alias.json");
    await link(manifestPath, manifestAlias);
    const hardlinkedManifest = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(hardlinkedManifest, "continuations").details.join("\n"))
      .toContain("Continuation v3 manifest must have exactly one filesystem link");
    await rm(manifestAlias);

    await writeFile(manifestPath, "x".repeat((1024 * 1024) + 1), { mode: 0o600 });
    const oversizedManifest = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(oversizedManifest, "continuations").details.join("\n"))
      .toContain("Continuation v3 manifest exceeds its 1048576 byte safety limit");
    await writeFile(manifestPath, validManifest, { mode: 0o600 });

    const validTransaction = JSON.stringify({
      schemaVersion: 3,
      generation: "doctor-security-transaction",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [],
      deletes: [],
    });
    const transactionPath = join(stateDir, "continuation-transaction-v3.json");
    const transactionSource = join(stateDir, "transaction-source.json");
    await writeFile(transactionSource, validTransaction, { mode: 0o600 });
    await link(transactionSource, transactionPath);
    const hardlinkedTransaction = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(hardlinkedTransaction, "continuations").details.join("\n"))
      .toContain("single-link regular file");
    await rm(transactionPath);
    await rm(transactionSource);

    const transactionTarget = join(stateDir, "transaction-target.json");
    await writeFile(transactionTarget, validTransaction, { mode: 0o600 });
    await symlink(transactionTarget, transactionPath);
    const linkedTransaction = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(linkedTransaction, "continuations").details.join("\n"))
      .toContain("single-link regular file");
    await rm(transactionPath);
    await rm(transactionTarget);

    await writeFile(transactionPath, validTransaction, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(transactionPath, 0o644);
    const permissiveTransaction = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    if (process.platform !== "win32") {
      expect(sectionById(permissiveTransaction, "continuations").details.join("\n")).toContain("permissions must be 600");
    }
    await rm(transactionPath);

    await writeFile(transactionPath, "x".repeat((16 * 1024 * 1024) + 1), { mode: 0o600 });
    const oversizedTransaction = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(oversizedTransaction, "continuations").details.join("\n")).toContain("safety limit");
    await rm(transactionPath);

    await writeFile(transactionPath, JSON.stringify({
      schemaVersion: 3,
      generation: "doctor-oversized-record-transaction",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [{
        ...doctorPreparedContinuationRecord({
          id: "doctor-oversized-transaction-record",
          originRunId: "run-doctor-oversized",
          originConversationId: "doctor:oversized",
          historyBoundary: "run-doctor-oversized",
          snapshotDigest: continuationDigest("doctor-oversized-snapshot"),
        }),
        resultPayload: "x".repeat((2 * 1024 * 1024) + 1),
      }],
      deletes: [],
    }), { mode: 0o600 });
    const oversizedTransactionRecord = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(oversizedTransactionRecord, "continuations").details.join("\n"))
      .toContain("transaction contains a record over its 2097152 byte safety limit");
    await rm(transactionPath);

    const groupsDir = join(stateDir, "origin-context-groups-v1");
    await mkdir(groupsDir, { mode: 0o700 });
    const markerPath = join(groupsDir, `${"a".repeat(64)}.json`);
    const markerSource = join(stateDir, "marker-source");
    await writeFile(markerSource, "{}\n", { mode: 0o600 });
    await link(markerSource, markerPath);
    const hardlinkedMarker = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(hardlinkedMarker, "continuations").details.join("\n"))
      .toContain("single-link regular file");
    await rm(markerPath);
    await rm(markerSource);
    await writeFile(markerPath, "x".repeat((64 * 1024) + 1), { mode: 0o600 });
    const oversizedMarker = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(oversizedMarker, "continuations").details.join("\n")).toContain("exceeds its safety limit");
    await rm(markerPath);
    await rm(groupsDir, { recursive: true });

    const guardPath = join(stateDir, "records-v2", "UPGRADED-TO-RECORDS-V3");
    const guardAlias = join(stateDir, "guard-alias");
    await link(guardPath, guardAlias);
    const hardlinkedGuard = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(hardlinkedGuard, "continuations").details.join("\n"))
      .toContain("single-link regular file");
  });

  it("reports a legacy v2 store as awaiting migration before and after its exact rollback guard is installed", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const recordsDir = join(stateDir, "records-v2");
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await chmod(recordsDir, 0o700);
    const recordId = "doctor-valid-legacy-record";
    const recordPath = join(recordsDir, `${continuationDigest(recordId)}.json`);
    await writeFile(recordPath, JSON.stringify({
      ...doctorPreparedContinuationRecord({
        id: recordId,
        originRunId: "run-doctor-legacy",
        originConversationId: "doctor:legacy",
        historyBoundary: "run-doctor-legacy",
        snapshotDigest: continuationDigest("doctor-legacy-snapshot"),
      }),
      resultPayload: "TOP SECRET LEGACY",
    }), { mode: 0o600 });
    await chmod(recordPath, 0o600);
    const rollbackGuardPath = join(recordsDir, "UPGRADED-TO-RECORDS-V3");
    await writeFile(
      rollbackGuardPath,
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
    await chmod(rollbackGuardPath, 0o600);
    const manifestPath = join(stateDir, "continuation-store-v2.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 2,
      generation: "TOP SECRET LEGACY GENERATION",
      updatedAt: new Date().toISOString(),
      stats: {
        format: "per-record-v2",
        records: 6,
        active: 1,
        unresolvedDelivery: 0,
        deadLettered: 0,
        terminalTombstones: 5,
        compacted: 4,
        capturedText: 3,
        historyDegraded: 0,
        limits: {
          terminalMaxRecords: 40_001,
          terminalMaxAgeMs: 41_536_000_002,
          capturedTextMaxRecords: 2_003,
          capturedTextMaxAgeMs: 3_592_000_004,
        },
      },
    }), { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const section = sectionById(report, "continuations");
    expect(section.status).toBe("waiting");
    expect(section.details).toContain(
      "Legacy store v2 awaiting v3 migration: 6 retained; 1 active; 0 delivery unknown; 0 dead-lettered; 0 history-degraded deliveries; 5 terminal tombstones; 4 compacted; 3 captured answers.",
    );
    expect(section.details).toContain(
      "Retention: at most 40001 terminal tombstones with a maximum age of 41536000002 ms and 2003 captured answers with a maximum age of 3592000004 ms.",
    );
    expect(section.details.join("\n")).toContain("rollback guard prevents older runtimes");
    expect(section.details.join("\n")).not.toContain("TOP SECRET LEGACY");

    await rm(rollbackGuardPath);
    const beforeMigration = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const beforeMigrationSection = sectionById(beforeMigration, "continuations");
    expect(beforeMigrationSection.status).toBe("waiting");
    expect(beforeMigrationSection.details.join("\n")).toContain("will install it during v3 migration");
  });

  it("rejects a forged v2 rollback guard beside an active v3 store", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const stateDir = join(dir, ".mono-agent", "continuations");
    const recordsDir = join(stateDir, "records-v3");
    const legacyRecordsDir = join(stateDir, "records-v2");
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await mkdir(legacyRecordsDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await chmod(recordsDir, 0o700);
    await chmod(legacyRecordsDir, 0o700);
    const rollbackGuardPath = join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3");
    await writeFile(rollbackGuardPath, "not a real rollback guard\n", { mode: 0o600 });
    await chmod(rollbackGuardPath, 0o600);
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 3,
      generation: "generation-v3",
      updatedAt: new Date().toISOString(),
      stats: {
        format: "per-record-v3",
        records: 0,
        active: 0,
        unresolvedDelivery: 0,
        deadLettered: 0,
        terminalTombstones: 0,
        compacted: 0,
        capturedText: 0,
        historyDegraded: 0,
        limits: {
          terminalMaxRecords: 50_000,
          terminalMaxAgeMs: 31_536_000_000,
          capturedTextMaxRecords: 1_000,
          capturedTextMaxAgeMs: 2_592_000_000,
        },
      },
    }), { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      continuations: {},
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const section = sectionById(report, "continuations");
    expect(section.status).toBe("error");
    expect(section.details.join("\n")).toContain("rollback guard contents are invalid");
  });

  it("reports adapter-derived send tools when enabled adapter configs are valid", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["SlackSendMessage", "TelegramSendMessage"] },
      slack: {
        enabled: true,
        botToken: "xoxb-test",
        appToken: "xapp-test",
        allowedChannelIds: ["C1"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toContain("SlackSendMessage");
    expect(tools.details.join("\n")).toContain("TelegramSendMessage");
  });

  it("fails when the identity file is missing", async () => {
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    const context = sectionById(report, "context");
    expect(context.status).toBe("error");
    expect(context.details.join("\n")).toContain("Identity file is missing");
  });

  it("fails when a selected skill has no SKILL.md", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md", skillsRoot: ".", selectedSkills: ["missing-skill"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "context").details.join("\n")).toContain("missing-skill");
  });

  it("reports core config errors without throwing", async () => {
    const configPath = await writeConfig({ context: { identityPath: "./IDENTITY.md" } });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    const core = sectionById(report, "core");
    expect(core.status).toBe("error");
    expect(core.details.join("\n")).toContain("MONO_AGENT_MODEL");
  });

  it("warns non-fatally when a secret is sourced from JSON", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await seedManagedMemoryFixture({
      root: dir,
      tier: "journal",
      embeddingModel: "openai:text-embedding-3-small",
    });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "journal",
        path: dir,
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-json-secret",
        },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY).",
    ]);
  });

  it("does not add a secret-placement warning when the same secret is env-sourced", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await seedManagedMemoryFixture({
      root: dir,
      tier: "journal",
      embeddingModel: "openai:text-embedding-3-small",
    });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "journal",
        path: dir,
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-env-secret" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(true);
    expect(report.sections.find((section) => section.id === "secret-placement")).toBeUndefined();
  });

  it("warns non-fatally for removed JSON memory ritual keys", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await seedManagedMemoryFixture({
      root: dir,
      tier: "bujo",
      embeddingModel: "ollama:nomic-embed-text:v1.5",
    });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: dir,
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3.6:latest" },
        reflection: { cron: "ignored-secret-cron" },
        migration: { enabled: false },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.",
      "[WARN] memory.migration is removed and ignored; use memory.consolidation instead.",
    ]);
    expect(placement.details.join("\n")).not.toContain("ignored-secret-cron");
  });

  it("warns non-fatally for removed memory env keys without requiring a memory path", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const report = await validateMonoAgentFolder({
        env: {
          MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
          MONO_AGENT_MEMORY_MIGRATION_CRON: "ignored-secret-cron",
        },
        cwd: dir,
        configPath,
        liveness: false,
      });

      expect(report.ok).toBe(true);
      expect(sectionById(report, "memory").status).toBe("disabled");
      const placement = sectionById(report, "secret-placement");
      expect(placement.status).toBe("waiting");
      expect(placement.details).toEqual([
        "[WARN] MONO_AGENT_MEMORY_REFLECTION_ENABLED is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
        "[WARN] MONO_AGENT_MEMORY_MIGRATION_CRON is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
      ]);
      expect(placement.details.join("\n")).not.toContain("ignored-secret-cron");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns non-fatally when a channel secret (bot token) is sourced from JSON", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      telegram: { enabled: true, botToken: "123:json-bot-token", allowAllChats: true },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] telegram.botToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_TELEGRAM_BOT_TOKEN).",
    ]);
    expect(placement.details.join("\n")).not.toContain("json-bot-token");
  });

  it("warns when an external A2A driver reports JSON bearer tokens", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      channels: {
        plugins: [
          {
            package: "@mono-agent/a2a-adapter",
            config: {
              provider: {
                bearerToken: "provider-json-secret",
              },
              consumer: {
                bearerToken: "consumer-json-secret",
              },
            },
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(true);
    const placement = sectionById(report, "secret-placement");
    expect(placement.status).toBe("waiting");
    expect(placement.details).toEqual([
      "[WARN] a2a.provider.bearerToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_A2A_BEARER_TOKEN).",
      "[WARN] a2a.consumer.bearerToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN).",
    ]);
    expect(placement.details.join("\n")).not.toContain("provider-json-secret");
    expect(placement.details.join("\n")).not.toContain("consumer-json-secret");
  });

  it("errors on an invalid per-trigger model/effort override at validate time", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      cron: {
        jobs: [
          { id: "digest", enabled: true, expression: "0 7 * * *", prompt: "Summarize.", model: "not-a-model" },
        ],
      },
      webhook: { enabled: true, effort: "extreme" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const cron = sectionById(report, "channel:cron");
    expect(cron.status).toBe("error");
    expect(cron.details.join("\n")).toContain('cron job "digest" has an invalid model override "not-a-model"');
    const webhook = sectionById(report, "channel:webhook");
    expect(webhook.status).toBe("error");
    expect(webhook.details.join("\n")).toContain('invalid effort override "extreme"');
  });

  it("rejects unknown exact Pi models in static webhook and cron overrides", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "unknown-model",
          path: "/unknown-model",
          mode: "sync",
          model: "pi:opencode-go:not-in-the-catalog",
        }],
      },
      cron: {
        jobs: [{
          id: "unknown-model",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          model: "pi:opencode-go:not-in-the-catalog",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "channel:webhook").status).toBe("ok");
    expect(sectionById(report, "channel:cron").status).toBe("ok");
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    const text = runtime.details.join("\n");
    expect(text).toContain("Per-trigger Pi model overrides must resolve");
    expect(text).toContain(
      "webhook.endpoints[0].model=pi:opencode-go:not-in-the-catalog: pi model not found: opencode-go:not-in-the-catalog",
    );
    expect(text).toContain(
      "cron.jobs[0].model=pi:opencode-go:not-in-the-catalog: pi model not found: opencode-go:not-in-the-catalog",
    );
  });

  it.each(["webhook", "cron"] as const)(
    "ignores unknown Pi model overrides on disabled %s entries",
    async (channel) => {
      await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
      const disabledEntry = channel === "webhook"
        ? {
            endpoints: [{
              name: "disabled",
              path: "/disabled",
              mode: "sync",
              enabled: false,
              model: "pi:opencode-go:not-in-the-catalog",
            }],
          }
        : {
            jobs: [{
              id: "disabled",
              enabled: false,
              expression: "0 7 * * *",
              prompt: "Summarize.",
              model: "pi:opencode-go:not-in-the-catalog",
            }],
          };
      const configPath = await writeConfig({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "./IDENTITY.md" },
        [channel]: { enabled: true, ...disabledEntry },
      });

      const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

      expect(report.ok).toBe(true);
      expect(sectionById(report, "runtime").status).toBe("ok");
      expect(sectionById(report, `channel:${channel}`).status).not.toBe("error");
      expect(sectionById(report, "runtime").details.join("\n")).not.toContain("not-in-the-catalog");
    },
  );

  it("accepts inferred and aliased models from providers.local on every Pi validation surface", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await seedManagedMemoryFixture({
      root: dir,
      tier: "bujo",
      embeddingModel: "openai:text-embedding-3-small",
    });
    const configPath = await writeConfig({
      runtime: {
        model: "pi:local-compat:inferred-primary",
        fallbackModels: ["pi:local-compat:friendly"],
      },
      context: { identityPath: "./IDENTITY.md" },
      providers: {
        local: [{
          id: "local-compat",
          type: "openai_compat",
          baseUrl: "http://127.0.0.1:11434",
          models: [{ name: "canonical", alias: "friendly" }],
        }],
      },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-only" },
        llm: { provider: "agent-host", model: "pi:local-compat:inferred-memory" },
      },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "alias",
          path: "/alias",
          mode: "sync",
          model: "pi:local-compat:friendly",
        }],
      },
      cron: {
        jobs: [{
          id: "inferred",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          model: "pi:local-compat:inferred-cron",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    expect(sectionById(report, "runtime").status).toBe("ok");
    expect(sectionById(report, "memory").status).toBe("ok");
    expect(sectionById(report, "channel:webhook").status).toBe("ok");
    expect(sectionById(report, "channel:cron").status).toBe("ok");
  });

  it("accepts valid per-trigger model/effort overrides", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      cron: {
        jobs: [
          {
            id: "digest",
            enabled: true,
            expression: "0 7 * * *",
            prompt: "Summarize.",
            model: "claude:claude-opus-4-8",
            effort: "high",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "channel:cron").status).toBe("ok");
  });

  it("rejects a static Claude trigger override while the mono-agent sandbox is active", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
      cron: {
        jobs: [{
          id: "claude-turn",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          model: "claude:claude-sonnet-4-6",
        }],
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain("Claude or direct OpenCode model overrides cannot run");
    expect(runtime.details.join("\n")).toContain("cron.jobs[0].model=claude:claude-sonnet-4-6");
  });

  it("allows a static Pi-to-Claude trigger override when the configured sandbox is off", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "off" },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "claude-turn",
          path: "/claude",
          mode: "sync",
          model: "claude:claude-sonnet-4-6",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    expect(sectionById(report, "runtime").status).toBe("ok");
    expect(sectionById(report, "channel:webhook").status).toBe("ok");
  });

  it("rejects a static direct OpenCode trigger override while the mono-agent sandbox is active", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "opencode-turn",
          path: "/opencode",
          mode: "sync",
          model: "opencode:github-copilot:gpt-5.1",
        }],
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain("Claude or direct OpenCode model overrides cannot run");
    expect(runtime.details.join("\n")).toContain("webhook.endpoints[0].model=opencode:github-copilot:gpt-5.1");
  });

  it("rejects a static direct OpenCode trigger override under a restrictive tool policy", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["Read", "Grep"] },
      cron: {
        jobs: [{
          id: "opencode-turn",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          model: "opencode:github-copilot:gpt-5.1",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain("direct OpenCode model overrides require exact allow-all");
    expect(runtime.details.join("\n")).toContain("cron.jobs[0].model=opencode:github-copilot:gpt-5.1");
  });

  it("allows a static direct OpenCode trigger override by suppressing implicit AskUser for that turn", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "opencode-turn",
          path: "/opencode",
          mode: "sync",
          model: "opencode:github-copilot:gpt-5.1",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    expect(sectionById(report, "runtime")).toMatchObject({ status: "ok" });
    expect(sectionById(report, "channel:webhook")).toMatchObject({ status: "ok" });
  });

  it("rejects a static direct OpenCode override when auto-MCP or index skills would be injected", async () => {
    const skillsRoot = join(dir, "skills");
    await mkdir(join(skillsRoot, "deploy"), { recursive: true });
    await writeFile(join(skillsRoot, "deploy", "SKILL.md"), "# Deploy\n");
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: {
        identityPath: "./IDENTITY.md",
        skillsRoot,
        selectedSkills: ["deploy"],
        skillDisclosure: "index",
      },
      memory: { mode: "lite", path: join(dir, "memory"), recallTool: { enabled: true } },
      tools: { allowedTools: ["*"] },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "opencode-turn",
          path: "/opencode",
          mode: "sync",
          model: "opencode:github-copilot:gpt-5.1",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.details.join("\n")).toContain("cannot receive configured or auto-provisioned MCP runtime options");
    expect(runtime.details.join("\n")).toContain("memory.recallTool");
    expect(runtime.details.join("\n")).toContain("cannot use index skill disclosure");
  });

  it("rejects a model-only direct OpenCode trigger override that would inherit host effort", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5", effort: "high" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      cron: {
        jobs: [{
          id: "opencode-turn",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          model: "opencode:github-copilot:gpt-5.1",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.details.join("\n")).toContain("direct OpenCode routes cannot receive runtime effort");
    expect(runtime.details.join("\n")).toContain(
      "cron.jobs[0].model=opencode:github-copilot:gpt-5.1 (effective effort=high)",
    );
  });

  it("rejects a direct OpenCode trigger model paired with endpoint effort", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "opencode-turn",
          path: "/opencode",
          mode: "sync",
          model: "opencode:github-copilot:gpt-5.1",
          effort: "low",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.details.join("\n")).toContain("direct OpenCode routes cannot receive runtime effort");
    expect(runtime.details.join("\n")).toContain("effective effort=low");
  });

  it("rejects endpoint effort when the retained fallback chain contains direct OpenCode", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["opencode:github-copilot:gpt-5.1"],
      },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      cron: {
        jobs: [{
          id: "deep-turn",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          effort: "high",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain("direct OpenCode routes cannot receive runtime effort");
    expect(runtime.details.join("\n")).toContain("cron.jobs[0].effort=high");
    expect(runtime.details.join("\n")).toContain("direct OpenCode route=opencode:github-copilot:gpt-5.1");
  });

  it("rejects a direct OpenCode trigger route that would inherit runtime.maxTurns", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 3 },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "opencode-turn",
          path: "/opencode",
          mode: "sync",
          model: "opencode:github-copilot:gpt-5.1",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.details.join("\n")).toContain("cannot enforce runtime.maxTurns");
    expect(runtime.details.join("\n")).toContain("webhook.endpoints[0].model=opencode:github-copilot:gpt-5.1");
  });

  it("rejects a webhook override from a direct-Codex host to Pi", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      webhook: {
        enabled: true,
        endpoints: [{ name: "pi-turn", path: "/pi", mode: "sync", model: "pi:ollama:qwen3:8b" }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "runtime").details.join("\n")).toContain("webhook.endpoints[0].model=pi:ollama:qwen3:8b");
  });

  it("rejects a cron override from a Pi host to direct Codex", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      cron: {
        jobs: [{
          id: "codex-turn",
          enabled: true,
          expression: "0 7 * * *",
          prompt: "Summarize.",
          model: "codex:gpt-5.6-terra",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "runtime").details.join("\n")).toContain("cron.jobs[0].model=codex:gpt-5.6-terra");
  });

  it("reports an effective native sandbox when the engine is available", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("ok");
    const text = sandbox.details.join("\n");
    expect(text).toContain('Sandbox is effective with native engine "fake-srt"');
    expect(text).toContain("commands run sandboxed");
  });

  it("rejects native srt policy when a direct Codex primary or fallback would bypass it", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["codex:gpt-5.6-terra"],
      },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "runtime").details.join("\n")).toContain("Route safety: uniform");
    expect(sectionById(report, "runtime").details.join("\n")).toContain("Fallback model codex:gpt-5.6-terra");
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("error");
    expect(sandbox.details.join("\n")).toContain("codex:gpt-5.6-terra");
    expect(sandbox.details.join("\n")).toContain("cannot govern direct Codex");
  });

  it("reports canonical mixed-route efforts and explicit per-route-native safety contracts", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        effort: "medium",
        fallbacks: [
          { model: "claude:claude-sonnet-4-6" },
          { model: "codex:gpt-5.6-sol", effort: "high" },
        ],
        routeSafety: "per-route-native",
      },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const runtimeText = sectionById(report, "runtime").details.join("\n");
    expect(runtimeText).toContain("Route safety: per-route-native");
    expect(runtimeText).toContain("claude:claude-sonnet-4-6 runs on Claude SDK (effort: provider default)");
    expect(runtimeText).toContain("codex:gpt-5.6-sol runs on Codex app CLI (effort: high)");
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("waiting");
    expect(sandbox.details.join("\n")).toContain("Pi-owned tools use the configured mono-agent SRT policy");
    expect(sandbox.details.join("\n")).toContain("fail closed when it is unavailable");
    expect(sandbox.details.join("\n")).toContain("Claude provider-owned permissions apply");
    expect(sandbox.details.join("\n")).toContain("Codex default/acceptEdits mode uses its native workspace-write sandbox");
  });

  it.each([
    ["absent", undefined],
    ["explicitly off", { mode: "off" }],
  ])("reports per-route-native Pi SRT as disabled when the sandbox is %s", async (_label, sandbox) => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        routeSafety: "per-route-native",
      },
      context: { identityPath: "./IDENTITY.md" },
      ...(sandbox === undefined ? {} : { sandbox }),
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const sandboxSection = sectionById(report, "sandbox");
    const text = sandboxSection.details.join("\n");
    expect(sandboxSection.status).toBe("disabled");
    expect(text).toContain("SRT is disabled");
    expect(text).toContain("Bash and stdio MCP subprocesses run unsandboxed");
    expect(text).not.toContain("use the configured mono-agent SRT policy and fail closed");
  });

  it("rejects native srt policy for a Claude primary", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("error");
    expect(sandbox.details.join("\n")).toContain("cannot govern Claude runtime");
    expect(sandbox.details.join("\n")).toContain("claude:claude-sonnet-4-6");
  });

  it("rejects native srt policy for a Claude fallback", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("error");
    expect(sandbox.details.join("\n")).toContain("cannot govern Claude runtime");
    expect(sandbox.details.join("\n")).toContain("claude:claude-sonnet-4-6");
  });

  it("rejects native srt policy for a direct OpenCode primary", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("error");
    expect(sandbox.details.join("\n")).toContain("cannot govern direct OpenCode runtime");
    expect(sandbox.details.join("\n")).toContain("opencode:github-copilot:gpt-5.1");
  });

  it("rejects native srt policy for a direct OpenCode fallback", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["opencode:github-copilot:gpt-5.1"],
      },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(false);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("error");
    expect(sandbox.details.join("\n")).toContain("cannot govern direct OpenCode runtime");
    expect(sandbox.details.join("\n")).toContain("opencode:github-copilot:gpt-5.1");
  });

  it("keeps pi:opencode-go under the native mono-agent sandbox", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6", routeSafety: "per-route-native" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox).toMatchObject({ status: "ok" });
    expect(sandbox.details.join("\n")).toContain("configured mono-agent SRT policy and fail closed");
    expect(sandbox.details.join("\n")).not.toContain("SRT is disabled");
  });

  it("rejects runtime effort when a direct OpenCode fallback would inherit it", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["opencode:github-copilot:gpt-5.1"],
        effort: "high",
      },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain(
      "Direct OpenCode model opencode:github-copilot:gpt-5.1 cannot receive runtime.effort=high",
    );
  });

  it("rejects runtime.maxTurns when a direct OpenCode fallback cannot enforce the cap", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["opencode:github-copilot:gpt-5.1"],
        maxTurns: 2,
      },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "runtime").details.join("\n")).toContain(
      "cannot enforce runtime.maxTurns=2",
    );
  });

  it("rejects index skill disclosure for a direct OpenCode route", async () => {
    const skillsRoot = join(dir, "skills");
    await mkdir(join(skillsRoot, "deploy"), { recursive: true });
    await writeFile(join(skillsRoot, "deploy", "SKILL.md"), "# Deploy\n");
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: {
        identityPath: "./IDENTITY.md",
        skillsRoot,
        selectedSkills: ["deploy"],
        skillDisclosure: "index",
      },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "runtime").details.join("\n")).toContain(
      "cannot use context.skillDisclosure=index",
    );
  });

  it("reports the native direct-Codex sandbox when no incompatible srt policy is configured", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "sandbox")).toMatchObject({ status: "ok" });
    expect(sectionById(report, "sandbox").details.join("\n")).toContain("workspace-write sandbox with network disabled");
  });

  it("reports the Codex-native posture even when the mono-agent sandbox is explicitly off", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "off" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "sandbox").status).toBe("ok");
    expect(sectionById(report, "sandbox").details.join("\n")).toContain("workspace-write sandbox with network disabled");
    expect(sectionById(report, "sandbox").details.join("\n")).toContain("explicitly off");
    expect(sectionById(report, "sandbox").details.join("\n")).not.toContain("cannot govern direct Codex");
  });

  it("reports direct Codex plan as native read-only with network disabled", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra", permissionMode: "plan" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "sandbox")).toMatchObject({ status: "ok" });
    expect(sectionById(report, "sandbox").details.join("\n")).toContain("read-only sandbox with network disabled");
  });

  it("warns explicitly when direct Codex bypasses its native sandbox", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra", permissionMode: "bypassPermissions" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "sandbox")).toMatchObject({ status: "waiting" });
    expect(sectionById(report, "sandbox").details.join("\n")).toContain("danger-full-access");
    expect(sectionById(report, "sandbox").details.join("\n")).toContain("no filesystem or network sandbox");
  });

  it("rejects restrictive mono-agent tool policy for direct Codex", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["Read"], disallowedTools: [] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "tools")).toMatchObject({ status: "error" });
    expect(sectionById(report, "tools").details.join("\n")).toContain("cannot enforce tools.allowedTools");
  });

  it("warns non-fatally when unsafe sandbox fallback is active", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: {
        mode: "native",
        fallback: "unsafe-host-process",
        unsafeAllowHostProcess: true,
        denyWrite: [".env", "secrets/**"],
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: unavailableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("waiting");
    const text = sandbox.details.join("\n");
    expect(text).not.toContain("[WARN] WARNING:");
    expect(text).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(text).toContain("Unsafe sandbox fallback is active");
    expect(text).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");
  });

  it("reports fail-closed sandbox unavailability without failing validation", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      sandbox: { mode: "native", fallback: "fail-closed" },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: unavailableSandboxEngine,
    });

    expect(report.ok).toBe(true);
    const sandbox = sectionById(report, "sandbox");
    expect(sandbox.status).toBe("waiting");
    expect(sandbox.details.join("\n")).toContain("commands fail closed with sandbox_unavailable");
  });

  it("does not warn about a channel secret supplied via env", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      telegram: { enabled: true, allowAllChats: true },
    });

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(true);
    expect(report.sections.find((section) => section.id === "secret-placement")).toBeUndefined();
  });
});

describe("validateMonoAgentFolder — observability exporter section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function writeExporterConfig(exporters?: unknown): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    return writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      ...(exporters === undefined ? {} : { observability: { exporters } }),
    });
  }

  it("reports disabled when no exporter is configured", async () => {
    const configPath = await writeExporterConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("disabled");
    expect(section.details.join("\n")).toMatch(/no observability exporter/iu);
    expect(report.ok).toBe(true);
  });

  it("reports ok when the Phoenix endpoint is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("ok");
    const text = section.details.join("\n");
    expect(text).toContain("http://127.0.0.1:6006/v1/traces");
    expect(text).toMatch(/JSONL artifacts remain local/iu);
    expect(text).not.toContain("[WARN] includeSensitiveData=true");
    expect(report.ok).toBe(true);
  });

  it("warns when sensitive data export is enabled but keeps the report ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const endpoint = "http://127.0.0.1:6006/v1/traces";
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint, includeSensitiveData: true }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("ok");
    const text = section.details.join("\n");
    expect(text).toContain("[WARN] includeSensitiveData=true");
    expect(text).toContain(endpoint);
    expect(text).toContain("user input");
    expect(text).toContain("assistant replies");
    expect(text).toContain("tool args/results");
    expect(text).toContain("system prompt");
    expect(text).toMatch(/JSONL artifacts remain local/iu);
    expect(report.ok).toBe(true);
  });

  it("reports waiting (not error) when the endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("waiting");
    const text = section.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toMatch(/ECONNREFUSED|not reachable|unreachable/iu);
    expect(text).toMatch(/JSONL artifacts remain local/iu);
    expect(report.ok).toBe(true);
  });

  it("reports waiting (not a false ok) when the endpoint rejects the protobuf POST with 415", async () => {
    // The old OPTIONS probe treated this endpoint as healthy; the real export
    // POST returns 415 (wrong content type). The probe now POSTs protobuf, so it
    // catches the export incompatibility instead of reporting a false ok.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 415 }));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("waiting");
    const text = section.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toContain("HTTP 415");
    expect(report.ok).toBe(true);
  });

  it("POSTs application/x-protobuf when probing (exercises the real export wire format)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-protobuf");
  });

  it("reports waiting when the endpoint responds but with a non-ok status (wrong path)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const configPath = await writeExporterConfig([{ type: "phoenix", endpoint: "http://127.0.0.1:6006/wrong" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("waiting");
    const text = section.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toContain("HTTP 404");
    // Still non-fatal: a wrong/unready endpoint never fails the report.
    expect(report.ok).toBe(true);
  });

  it("reports error (fails the report) for an invalid exporter type", async () => {
    const configPath = await writeExporterConfig([{ type: "bogus", endpoint: "http://127.0.0.1:6006/v1/traces" }]);

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const section = sectionById(report, "observability");
    expect(section.status).toBe("error");
    expect(report.ok).toBe(false);
  });
});

describe("validateMonoAgentFolder — runs health section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function writeRunsConfig(artifactDirName = "artifacts"): Promise<{
    readonly artifactDir: string;
    readonly configPath: string;
  }> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const artifactDir = join(dir, artifactDirName);
    const configPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: { dir: `./${artifactDirName}` },
    });
    return { artifactDir, configPath };
  }

  it("reports effective artifact retention settings", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: {
        dir: "./artifacts",
        retention: { maxAgeDays: 12, maxCount: 34, dryRun: true },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.details[0]).toBe("Artifact retention: maxAgeDays=12, maxCount=34, dryRun=true.");
    expect(runs.details[1]).toBe("Memory artifact retention: maxAgeDays=7, maxCount=5000, dryRun=true.");
    expect(report.ok).toBe(true);
  });

  it("reports recent status counts and a failure-kind breakdown from summaries", async () => {
    const { artifactDir, configPath } = await writeRunsConfig();
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeRunSummary(artifactDir, "succeeded.summary.json", {
      runId: "run-succeeded",
      conversationId: "chat",
      status: "succeeded",
      startedAt,
      durationMs: 1000,
      eventCount: 2,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "running.summary.json", {
      runId: "run-running",
      conversationId: "chat",
      status: "running",
      startedAt,
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "failed.summary.json", {
      runId: "run-failed",
      conversationId: "chat",
      status: "failed",
      failureKind: "usage_limit",
      startedAt,
      durationMs: 1000,
      eventCount: 3,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "unknown-failure.summary.json", {
      runId: "run-unknown",
      conversationId: "chat",
      status: "failed",
      failureKind: "provider_error",
      startedAt,
      durationMs: 1000,
      eventCount: 3,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "cancelled.summary.json", {
      runId: "run-cancelled",
      conversationId: "chat",
      status: "cancelled",
      failureKind: "cancelled",
      startedAt,
      durationMs: 500,
      eventCount: 1,
      artifactPaths: [],
    });
    await writeRunSummary(artifactDir, "interrupted.summary.json", {
      runId: "run-interrupted",
      conversationId: "chat",
      status: "interrupted",
      failureKind: "process_death",
      startedAt,
      durationMs: 500,
      eventCount: 1,
      artifactPaths: [],
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("waiting");
    const text = runs.details.join("\n");
    expect(text).toContain(`Artifact dir: ${artifactDir}`);
    expect(text).toContain("Recorded runs: 6 total; showing 6 recent (max 50).");
    expect(text).toContain("Last runs:");
    expect(text).toContain("Recent status counts: running=1, succeeded=1, failed=2, cancelled=1, interrupted=1.");
    expect(text).toContain("[WARN] Recent non-successful runs:");
    expect(text).toContain("[WARN] Cancelled recent runs: 1.");
    expect(text).toContain("[WARN] Interrupted recent runs: 1.");
    expect(text).toContain("[WARN] Failure kinds: cancelled=1, process_death=1, provider_error=1, usage_limit=1.");
    expect(text).toContain("Usage limit [usage_limit, 1 recent]");
    expect(text).toContain("Process death [process_death, 1 recent]");
    expect(text).toContain("Cancelled [cancelled, 1 recent]");
    expect(text).toContain("Unclassified failure (provider_error) [provider_error (unclassified), 1 recent]");
    expect(report.ok).toBe(true);
  });

  it("reports the exact run total when the recent list is capped", async () => {
    const { artifactDir, configPath } = await writeRunsConfig();
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    for (let index = 0; index < 55; index += 1) {
      await writeRunSummary(artifactDir, `run-${index}.summary.json`, {
        runId: `run-${index}`,
        conversationId: "chat",
        status: "succeeded",
        startedAt,
        durationMs: 1000,
        eventCount: 1,
        artifactPaths: [],
      });
    }

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("ok");
    expect(runs.details.join("\n")).toContain("Recorded runs: 55 total; showing 50 recent (max 50).");
    expect(report.ok).toBe(true);
  });

  it("warns when a running summary is older than the staleness threshold", async () => {
    const { artifactDir, configPath } = await writeRunsConfig();
    const staleStartedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await writeRunSummary(artifactDir, "stale.summary.json", {
      runId: "run-stale",
      conversationId: "chat",
      status: "running",
      startedAt: staleStartedAt,
      durationMs: 0,
      eventCount: 1,
      artifactPaths: [],
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("waiting");
    expect(runs.details.join("\n")).toContain("[WARN] Stale running runs older than 30m: run-stale");
    expect(report.ok).toBe(true);
  });

  it("treats missing and empty artifact directories as disabled and non-fatal", async () => {
    const { artifactDir, configPath } = await writeRunsConfig("missing-artifacts");

    const missing = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(missing, "runs").status).toBe("disabled");
    expect(sectionById(missing, "runs").details.join("\n")).toContain("No runs recorded yet.");
    expect(missing.ok).toBe(true);

    await mkdir(artifactDir, { recursive: true });
    const empty = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(empty, "runs").status).toBe("disabled");
    expect(sectionById(empty, "runs").details.join("\n")).toContain("No runs recorded yet.");
    expect(empty.ok).toBe(true);
  });

  it("does not add a network probe during liveness:false preflight", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { artifactDir, configPath } = await writeRunsConfig();
    await writeRunSummary(artifactDir, "succeeded.summary.json", {
      runId: "run-succeeded",
      conversationId: "chat",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      eventCount: 1,
      artifactPaths: [],
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runs = sectionById(report, "runs");
    expect(runs.status).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("validateMonoAgentFolder — bujo memory checks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function writeMinimalConfig(
    extra: Record<string, unknown> = {},
    options: { readonly seedManagedMemory?: boolean } = {},
  ): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const memoryValue = extra["memory"];
    const memory = typeof memoryValue === "object" && memoryValue !== null
      ? memoryValue as Record<string, unknown>
      : undefined;
    if (options.seedManagedMemory !== false
      && memory !== undefined && (memory["mode"] === "journal" || memory["mode"] === "bujo")
      && typeof memory["path"] === "string"
      && !(await pathExists(join(memory["path"], ".index")))) {
      const embeddingsValue = memory["embeddings"];
      const embeddings = typeof embeddingsValue === "object" && embeddingsValue !== null
        ? embeddingsValue as Record<string, unknown>
        : undefined;
      const embedding = embeddings !== undefined
        && typeof embeddings["provider"] === "string" && typeof embeddings["model"] === "string"
        ? {
            id: `${embeddings["provider"]}:${embeddings["model"]}`,
            dim: typeof embeddings["dim"] === "number" ? embeddings["dim"] : 768,
          }
        : undefined;
      await seedManagedMemoryFixture({
        root: memory["path"],
        tier: memory["mode"],
        ...(embedding === undefined ? {} : {
          embeddingModel: embedding.id,
          dimension: embedding.dim,
        }),
      });
    }
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "./IDENTITY.md" },
        ...extra,
      }),
    );
    return configPath;
  }

  function stubFetch(models: string[], dimension = 768): void {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["embedding"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/embed")) {
        return new Response(JSON.stringify({ embeddings: [new Array<number>(dimension).fill(0.01)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Ollama test request: ${url}`);
    }));
  }

  function stubLmStudioFetch(options: {
    readonly models?: readonly Readonly<Record<string, unknown>>[];
    readonly vector?: readonly number[];
    readonly status?: number;
    readonly error?: Error;
  } = {}) {
    const fetchSpy = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (options.error !== undefined) throw options.error;
      const url = String(input);
      const status = options.status ?? 200;
      if (url === "http://localhost:1234/api/v1/models") {
        return new Response(JSON.stringify({
          models: options.models ?? [
            { key: "text-embedding-test", type: "embedding" },
            { key: "chat-test", type: "llm" },
          ],
        }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://localhost:1234/v1/embeddings") {
        return new Response(JSON.stringify({
          data: [{ embedding: options.vector ?? [1, 0, 0, 0] }],
        }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected LM Studio test request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  async function writeLmStudioMemoryConfig(options: {
    readonly apiKeyEnv?: string;
    readonly dim?: number;
  } = {}): Promise<string> {
    return await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "lmstudio",
          model: "text-embedding-test",
          dim: options.dim ?? 4,
          ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }),
        },
      },
    });
  }

  const strictBujoLlm = { provider: "ollama", model: "nomic-embed-text:v1.5" } as const;

  it("reports a managed tier/model/dimension change as a pending rebuild before provider probes", async () => {
    const memoryPath = join(dir, "managed-memory");
    await safeRebuildMemoryIndex({
      root: memoryPath,
      tier: "journal",
      embeddings: {
        id: "ollama:old-embed",
        embed: async (texts) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
      },
      dim: 8,
    });
    const fetchSpy = vi.fn().mockRejectedValue(new Error("provider probe must not run"));
    vi.stubGlobal("fetch", fetchSpy);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: memoryPath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "new-embed", dim: 16 },
        llm: { provider: "ollama", model: "capture-model" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    const text = memory.details.join("\n");
    expect(text).toContain("active tier=journal, model=ollama:old-embed, dim=8");
    expect(text).toContain("configured tier=bujo, model=ollama:new-embed, dim=16");
    expect(text).toContain("mono-agent stop");
    expect(text).toContain("mono-agent memory rebuild");
    expect(text).toContain("mono-agent validate");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails an unmanaged Journal root with a missing manifest before provider probes", async () => {
    const memoryPath = join(dir, "missing-managed-manifest");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("provider probe must not run"));
    vi.stubGlobal("fetch", fetchSpy);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: memoryPath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    }, { seedManagedMemory: false });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toMatch(/managed.*metadata.*missing/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails malformed managed metadata before provider probes", async () => {
    const memoryPath = join(dir, "malformed-managed-manifest");
    await mkdir(join(memoryPath, ".index"), { recursive: true });
    await writeFile(join(memoryPath, ".index", "manifest.json"), "{not-json", "utf8");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("provider probe must not run"));
    vi.stubGlobal("fetch", fetchSpy);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: memoryPath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: strictBujoLlm,
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toMatch(/metadata.*invalid|unavailable/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turns native database smoke failure into a structured memory error", async () => {
    const openSpy = vi.spyOn(memoryStore, "openMemoryDb").mockImplementation(() => {
      throw Object.assign(new Error("hostile native loader detail /private/sentinel"), {
        code: "ERR_DLOPEN_FAILED",
      });
    });
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: dir,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });
    openSpy.mockRestore();

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toContain("native module is unavailable");
    expect(memory.details.join("\n")).toContain("Rebuild dependencies with the launch runtime");
    expect(memory.details.join("\n")).not.toContain("/private/sentinel");
  });

  it("accepts a managed generation whose configured identity matches before normal liveness checks", async () => {
    const memoryPath = join(dir, "matching-managed-memory");
    await safeRebuildMemoryIndex({
      root: memoryPath,
      tier: "journal",
      embeddings: {
        id: "ollama:nomic-embed-text:v1.5",
        embed: async (texts) => texts.map(() => Array.from({ length: 8 }, (_value, index) => index === 0 ? 1 : 0)),
      },
      dim: 8,
    });
    stubFetch(["nomic-embed-text:v1.5"], 8);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: memoryPath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5", dim: 8 },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(sectionById(report, "memory").status).toBe("ok");
    expect(fetch).toHaveBeenCalled();
  });

  it("passes the bujo memory section when Ollama is reachable and the embeddings model is present", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: strictBujoLlm,
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(memory.details.join("\n")).toContain("bujo");
  });

  it("reports the supermemory backend as reachable for any HTTP response without sending auth or data", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 405 }));
    vi.stubGlobal("fetch", fetchSpy);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const configPath = await writeMinimalConfig({
      memory: {
        backend: "supermemory",
        mode: "lite",
        path: dir,
        writeMode: "capture",
        supermemory: {
          baseUrl: "http://127.0.0.1:6767",
          container: "agent-alpha",
          apiKey: "fixture-key",
        },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("Backend: supermemory");
    expect(text).toContain("http://127.0.0.1:6767");
    expect(text).toContain("agent-alpha");
    expect(text).toContain("transport reachable");
    expect(text).toContain("HTTP 405");
    // bujo-only "Mode:" line is not used for external backends.
    expect(text).not.toMatch(/^Mode:/mu);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("http://127.0.0.1:6767");
    expect(init.method).toBe("HEAD");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3_000);
  });

  it.each([
    ["connection refusal", new Error("ECONNREFUSED"), "ECONNREFUSED"],
    ["abort", new DOMException("probe timed out", "AbortError"), "probe timed out"],
  ])("reports Supermemory %s as non-fatal waiting", async (_case, failure, expectedReason) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const configPath = await writeMinimalConfig({
      memory: {
        backend: "supermemory",
        mode: "lite",
        path: dir,
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(report.ok).toBe(true);
    const text = memory.details.join("\n");
    expect(text).toContain("[WARN] Supermemory is not reachable");
    expect(text).toContain(expectedReason);
    expect(text).toContain("memory.supermemory.baseUrl");
    expect(text).toContain("mono-agent validate");
    expect(text).toContain("capture and recall will degrade");
  });

  it("resolves the Supermemory validator from the explicit agent folder", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const packageRoot = join(
      dir,
      "node_modules",
      "@mono-agent",
      "memory-supermemory",
    );
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@mono-agent/memory-supermemory",
        version: agentAppPackageVersion(),
        type: "module",
        exports: {
          ".": { import: "./dist/index.js" },
          "./package.json": "./package.json",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(packageRoot, "dist", "index.js"),
      [
        "export const createSupermemoryStore = () => ({});",
        "export const validateSupermemoryConfig = () => ({",
        "  valid: false, errors: ['agent-local-validator'],",
        "});",
      ].join("\n"),
      "utf8",
    );
    const configPath = await writeMinimalConfig({
      memory: {
        backend: "supermemory",
        mode: "lite",
        path: dir,
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toContain("agent-local-validator");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns (status=waiting, no throw) when Ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: strictBujoLlm,
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    // unreachable Ollama => waiting (not error, not a throw)
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/not reachable|unreachable|ECONNREFUSED/iu);
    // overall report is still "ok" — a warn is non-fatal
    expect(report.ok).toBe(true);
  });

  it("warns when the embeddings model is not yet pulled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        return new Response(JSON.stringify({ error: "model not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected missing-model request: ${url}`);
    }));

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/nomic-embed-text/u);
    expect(text).toMatch(/not pulled|pull/iu);
    expect(report.ok).toBe(true);
  });

  it("warns when the chat LLM model is configured but not pulled", async () => {
    // Embeddings model present, chat model absent
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/qwen3:6b/u);
    expect(text).toMatch(/not pulled|pull/iu);
    expect(report.ok).toBe(true);
  });

  it("fails an unmanaged BuJo root before provider or writability probes", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);
    // A path *under an existing file* makes mkdir fail with ENOTDIR deterministically on every
    // platform and regardless of privileges. A hardcoded /proc path hangs on Linux CI runners.
    const blocker = join(dir, "blocker-bujo");
    await writeFile(blocker, "x");
    const unwritablePath = join(blocker, "root");

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: unwritablePath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: strictBujoLlm,
      },
    }, { seedManagedMemory: false });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toMatch(/managed.*metadata.*missing/iu);
    expect(fetch).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
  });

  it("warns on journal mode when Ollama is unreachable (journal also needs embeddings)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    const text = memory.details.join("\n");
    expect(text).toMatch(/not reachable|unreachable|ECONNREFUSED/iu);
    expect(report.ok).toBe(true);
  });

  it("passes journal mode when Ollama is reachable and embeddings model is present", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(memory.details.join("\n")).toContain("journal");
  });

  it("does NOT probe Ollama when embeddings provider is openai", async () => {
    // fetch is NOT stubbed — if the Ollama probe were attempted it would fail and warn.
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).not.toMatch(/ollama/iu);
    expect(text).not.toMatch(/WARN/iu);
  });

  it("does NOT probe Ollama for an agent-host chat LLM when embeddings provider is openai", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("agent-host:pi:openai-codex:gpt-5.5");
    expect(text).not.toMatch(/pull|not pulled|WARN/iu);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT check an agent-host chat LLM against Ollama when embeddings provider is ollama", async () => {
    stubFetch(["nomic-embed-text:v1.5"]);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("agent-host:pi:openai-codex:gpt-5.5");
    expect(text).not.toMatch(/pi:openai-codex:gpt-5\.5.*pull|not pulled|WARN/iu);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks Ollama embeddings and chat models against their own endpoints", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://localhost:11435/api/tags") {
        return new Response(JSON.stringify({ models: [{ name: "qwen3.6:latest" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://localhost:11434/api/tags") {
        return new Response(JSON.stringify({ models: [{ name: "nomic-embed-text:v1.5" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://localhost:11434/api/show") {
        return new Response(JSON.stringify({ capabilities: ["embedding"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://localhost:11434/api/embed") {
        return new Response(JSON.stringify({ embeddings: [new Array<number>(768).fill(0.01)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected endpoint-specific Ollama request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text:v1.5",
          endpoint: "http://localhost:11434",
        },
        llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11435" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).not.toMatch(/not pulled|WARN/iu);
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/embed", expect.anything());
    expect(fetch).toHaveBeenCalledWith("http://localhost:11435/api/tags", expect.anything());
  });

  it("probes only the exact keyless LM Studio model with the configured dimension", async () => {
    const fetchSpy = stubLmStudioFetch();
    const configPath = await writeLmStudioMemoryConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
    );
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toMatch(/Authorization|11434|ollama/iu);
  });

  it("uses the resolved LM Studio apiKeyEnv bearer token for exact-model proof", async () => {
    const fetchSpy = stubLmStudioFetch();
    const configPath = await writeLmStudioMemoryConfig({ apiKeyEnv: "LM_STUDIO_API_KEY" });

    const report = await validateMonoAgentFolder({
      env: { LM_STUDIO_API_KEY: "effective-token" },
      cwd: dir,
      configPath,
    });

    expect(sectionById(report, "memory").status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    for (const call of fetchSpy.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer effective-token" }),
      }));
    }
  });

  it("waits without a keyless probe when the declared LM Studio apiKeyEnv is missing", async () => {
    const fetchSpy = stubLmStudioFetch();
    const configPath = await writeLmStudioMemoryConfig({ apiKeyEnv: "LM_STUDIO_API_KEY" });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/LM_STUDIO_API_KEY.*no non-empty value.*no keyless probe/isu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports LM Studio HTTP 401 as an actionable authentication wait", async () => {
    stubLmStudioFetch({ status: 401 });
    const configPath = await writeLmStudioMemoryConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/LM Studio authentication failed.*HTTP 401.*apiKeyEnv/isu);
  });

  it("reports an unavailable LM Studio service without probing Ollama", async () => {
    const fetchSpy = stubLmStudioFetch({ error: new Error("ECONNREFUSED") });
    const configPath = await writeLmStudioMemoryConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/LM Studio not reachable.*Start LM Studio/isu);
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toMatch(/11434|ollama/iu);
  });

  it("accepts a manual LM Studio model when its exact embedding probe succeeds despite catalog metadata", async () => {
    const fetchSpy = stubLmStudioFetch({ models: [{ key: "text-embedding-test", type: "llm" }] });
    const configPath = await writeLmStudioMemoryConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:1234/v1/embeddings", expect.anything());
    expect(fetchSpy).not.toHaveBeenCalledWith("http://localhost:1234/api/v1/models", expect.anything());
  });

  it("accepts a manual Ollama model without scanning unrelated catalog entries", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://localhost:11434/api/embed") {
        return new Response(JSON.stringify({ embeddings: [new Array<number>(768).fill(0.01)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Doctor must not scan Ollama catalog for exact-model readiness: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "manual-embedding-model", dim: 768 },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(sectionById(report, "memory").status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:11434/api/embed", expect.anything());
  });

  it.each([
    { label: "malformed", vector: [] as number[], detail: /invalid embedding vector/iu },
    { label: "wrong-dimension", vector: [1, 0], detail: /returned dimension 2.*configured dimension is 4/iu },
  ])("reports a $label LM Studio embedding result as waiting", async ({ vector, detail }) => {
    stubLmStudioFetch({ vector });
    const configPath = await writeLmStudioMemoryConfig();

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(detail);
  });

  it("passes lite mode without any Ollama probe (lite needs no embeddings)", async () => {
    // fetch is NOT stubbed — if the probe were attempted it would throw
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: dir,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).toContain("lite");
    expect(report.ok).toBe(true);
  });

  it("warns for lite mode when the memory root is not writable", async () => {
    // See the bujo variant above: a path under an existing file fails mkdir with ENOTDIR
    // deterministically; a hardcoded /proc path hangs on Linux CI runners.
    const blocker = join(dir, "blocker-lite");
    await writeFile(blocker, "x");
    const unwritablePath = join(blocker, "root");

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: unwritablePath,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toMatch(/writable|mkdir/iu);
    expect(report.ok).toBe(true);
  });

  it("does not create a missing lite memory root when filesystem writes are disabled", async () => {
    const memoryPath = join(dir, "missing-lite-memory");
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "lite",
        path: memoryPath,
        writeMode: "append-host-summary",
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      allowFilesystemWrites: false,
    });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("waiting");
    expect(memory.details.join("\n")).toContain("Consumer validation is read-only and did not create it");
    expect(await pathExists(memoryPath)).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("fails without creating an unmanaged Journal root when filesystem writes are disabled", async () => {
    const memoryPath = join(dir, "missing-journal-memory");
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "journal",
        path: memoryPath,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    }, { seedManagedMemory: false });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      allowFilesystemWrites: false,
    });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toMatch(/managed.*metadata.*missing/iu);
    expect(await pathExists(memoryPath)).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("reports consolidation cadence for bujo with a chat LLM (auto-scheduled)", async () => {
    stubFetch(["nomic-embed-text:v1.5", "qwen3:6b"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toMatch(/consolidation/iu);
    expect(text).toContain("0 */2 * * *");
    expect(text).toMatch(/auto/iu);
  });

  it("reports a configuration error instead of downgrading bujo without a chat LLM", async () => {
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        // No llm config
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    expect(report.ok).toBe(false);
    const core = sectionById(report, "core");
    expect(core.status).toBe("error");
    expect(core.details.join("\n")).toMatch(/bujo.*requires.*memory\.llm/iu);
  });

  it("reports custom consolidation cron when configured", async () => {
    stubFetch(["nomic-embed-text:v1.5", "qwen3:6b"]);

    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
        consolidation: { cron: "0 */4 * * *" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    const text = memory.details.join("\n");
    expect(text).toContain("0 */4 * * *");
    expect(text).not.toMatch(/reflection|migration/iu);
  });

  it("fails the memory section preflight for a malformed consolidation cron", async () => {
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
        consolidation: { cron: "61 * * * *" },
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
    });

    const memory = sectionById(report, "memory");
    expect(report.ok).toBe(false);
    expect(memory.status).toBe("error");
    expect(memory.details).toContain("Consolidation: 61 * * * * (auto).");
    expect(memory.details).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /^\[ERROR\] memory\.consolidation\.cron is invalid: .*range 0-59/u,
      ),
    ]));
  });

  it("preflights an explicitly configured cron even while consolidation is disabled", async () => {
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
        consolidation: { enabled: false, cron: "0 0 * FOO *" },
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
    });

    const memory = sectionById(report, "memory");
    expect(report.ok).toBe(false);
    expect(memory.status).toBe("error");
    expect(memory.details).toContain("Consolidation: disabled.");
    expect(memory.details).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /^\[ERROR\] memory\.consolidation\.cron is invalid: .*resolve alias "foo"/u,
      ),
    ]));
  });

  it("rejects hashed consolidation fields that have no stable per-instance seed", async () => {
    const configPath = await writeMinimalConfig({
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "qwen3:6b" },
        consolidation: { cron: "H * * * *" },
      },
    });

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
    });

    const memory = sectionById(report, "memory");
    expect(report.ok).toBe(false);
    expect(memory.status).toBe("error");
    expect(memory.details).toContain(
      '[ERROR] memory.consolidation.cron is invalid: Hashed "H" cron fields require a non-empty hashSeed.',
    );
  });
});

describe("validateMonoAgentFolder — liveness:false (start preflight)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the Phoenix probe — exporter stays ok and fetch is never called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "observability").status).toBe("ok");
    expect(report.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips the Ollama probe — memory stays ok, no WARNs, fetch never called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await seedManagedMemoryFixture({
      root: dir,
      tier: "bujo",
      embeddingModel: "ollama:nomic-embed-text:v1.5",
    });
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    // The descriptive (non-probe) detail lines still render.
    expect(memory.details.join("\n")).toContain("bujo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips the Supermemory probe — config stays ok and fetch is never called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        backend: "supermemory",
        mode: "lite",
        path: dir,
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767", container: "agent-alpha" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("ok");
    expect(memory.details.join("\n")).toContain("liveness probe skipped");
    expect(memory.details.join("\n")).not.toMatch(/WARN/iu);
    expect(report.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails an unmanaged memory root before local or network probes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: join(blocker, "root"),
        writeMode: "append-host-summary",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: { provider: "ollama", model: "nomic-embed-text:v1.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toMatch(/managed.*metadata.*missing/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("yields the same ok verdict as a full run when only waiting differs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" }] },
    });

    const live = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: true });
    const fast = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(live.ok).toBe(true);
    expect(fast.ok).toBe(true);
    // The full run downgrades the exporter to waiting; the fast run keeps it ok —
    // either way the report passes, which is what the gate relies on.
    expect(sectionById(live, "observability").status).toBe("waiting");
    expect(sectionById(fast, "observability").status).toBe("ok");
  });
});

describe("validateMonoAgentFolder — provider credentials section", () => {
  const FUTURE = 4_102_444_800_000; // 2100-01-01, comfortably valid
  const PAST = 1_000_000_000_000; // 2001-09, comfortably expired

  async function writeAuthStore(providers: Record<string, unknown>): Promise<string> {
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify(providers, null, 2), { mode: 0o600 });
    return authPath;
  }

  async function writeModelsStore(providerIds: string[]): Promise<void> {
    const models = { providers: Object.fromEntries(providerIds.map((id) => [id, {}])) };
    await writeFile(join(dir, "models.json"), JSON.stringify(models, null, 2));
  }

  async function writeCredConfig(extra: Record<string, unknown>): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    return writeConfig({
      context: { identityPath: "./IDENTITY.md" },
      ...extra,
    });
  }

  async function writeDirectOpenCodeState(
    providers: Record<string, unknown>,
    options: { readonly marker?: boolean } = {},
  ): Promise<Record<string, string>> {
    const home = join(dir, "opencode-home");
    const data = join(home, ".local", "share", "opencode");
    await mkdir(data, { recursive: true });
    if (options.marker !== false) await writeFile(join(data, "opencode.db"), "");
    await writeFile(join(data, "auth.json"), JSON.stringify(providers));
    return { HOME: home };
  }

  it("rejects a models.json-only custom primary even when its exact model row exists", async () => {
    const authPath = await writeAuthStore({ "openai-codex": { type: "oauth", expires: FUTURE, refresh: "r" } });
    await writeFile(join(dir, "models.json"), JSON.stringify({
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          models: [{ id: "qwen3.6" }],
        },
      },
    }));
    const configPath = await writeCredConfig({
      runtime: { model: "pi:ollama:qwen3.6", fallbackModels: ["pi:openai-codex:gpt-5.5"] },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain("pi model not found: ollama:qwen3.6");
    expect(runtime.details.join("\n")).toContain("models.json is not a mono-agent runtime source");
    expect(runtime.details.join("\n")).toContain("add providers.local");

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/Primary pi:ollama:qwen3\.6: no Pi credentials found for provider `ollama` in the auth store/u);
    expect(text).toMatch(/Fallback pi:openai-codex:gpt-5\.5: OAuth credentials for `openai-codex` present \(token valid/u);
    expect(report.ok).toBe(false);
  });

  it("rejects an unknown exact model under an authenticated built-in Pi provider", async () => {
    const authPath = await writeAuthStore({ "opencode-go": { type: "api_key", key: "sk-opencode" } });
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:not-in-the-catalog" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain("pi model not found: opencode-go:not-in-the-catalog");
    expect(sectionById(report, "credentials").status).toBe("ok");
    expect(report.ok).toBe(false);
  });

  it("rejects an unknown exact Pi fallback before execution", async () => {
    const authPath = await writeAuthStore({
      "openai-codex": { type: "oauth", expires: FUTURE, refresh: "r" },
      "opencode-go": { type: "api_key", key: "sk-opencode" },
    });
    const configPath = await writeCredConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["pi:opencode-go:not-in-the-catalog"],
      },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const runtime = sectionById(report, "runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.details.join("\n")).toContain(
      "Fallback model pi:opencode-go:not-in-the-catalog: pi model not found: opencode-go:not-in-the-catalog",
    );
    expect(sectionById(report, "credentials").status).toBe("ok");
    expect(report.ok).toBe(false);
  });

  it("rejects an unknown exact Pi agent-host memory LLM before execution", async () => {
    const authPath = await writeAuthStore({ "opencode-go": { type: "api_key", key: "sk-opencode" } });
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-only" },
        llm: { provider: "agent-host", model: "pi:opencode-go:not-in-the-catalog" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "runtime").status).toBe("ok");
    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toContain(
      "Agent-host memory LLM pi:opencode-go:not-in-the-catalog: pi model not found: opencode-go:not-in-the-catalog",
    );
    expect(sectionById(report, "credentials").status).toBe("ok");
    expect(report.ok).toBe(false);
  });

  it("rejects a disabled providers.local model row on an agent-host memory LLM", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      providers: {
        local: [{
          id: "local-compat",
          type: "openai_compat",
          baseUrl: "http://127.0.0.1:11434",
          models: [{ name: "blocked", enabled: false }],
        }],
      },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "test-only" },
        llm: { provider: "agent-host", model: "pi:local-compat:blocked" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const memory = sectionById(report, "memory");
    expect(memory.status).toBe("error");
    expect(memory.details.join("\n")).toContain(
      "model `blocked` is disabled in providers.local for provider `local-compat`",
    );
    expect(report.ok).toBe(false);
  });

  it("passes when OpenCode-Go API key credentials are present in the Pi auth store", async () => {
    const authPath = await writeAuthStore({ "opencode-go": { type: "api_key", key: "sk-opencode" } });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details.join("\n")).toMatch(/Primary pi:opencode-go:kimi-k2\.6: API key credentials for `opencode-go` present/u);
    expect(report.ok).toBe(true);
  });

  it("fails closed on a group-readable Pi auth store and recommends explicit hardening", async () => {
    const authPath = await writeAuthStore({
      "opencode-go": { type: "api_key", key: "group-readable-secret-sentinel" },
    });
    await chmod(authPath, 0o644);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain("permissions are not owner-only");
    expect(text).toContain("intentionally never trusted for credential detection");
    expect(text).toContain("mono-agent auth login opencode-go --pi-auth-path");
    expect(text).not.toContain("group-readable-secret-sentinel");
    expect(report.ok).toBe(true);
  });

  it("fails closed on a symbolic-link Pi auth store without exposing its contents", async () => {
    const targetPath = join(dir, "real-auth.json");
    const authPath = join(dir, "auth.json");
    await writeFile(targetPath, JSON.stringify({
      "opencode-go": { type: "api_key", key: "symlink-secret-sentinel" },
    }), { mode: 0o600 });
    await symlink(targetPath, authPath);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain("configured entry is a symbolic link");
    expect(text).not.toContain("symlink-secret-sentinel");
  });

  it("fails closed on a hard-linked Pi auth store without exposing its contents", async () => {
    const targetPath = join(dir, "linked-auth.json");
    const authPath = join(dir, "auth.json");
    await writeFile(targetPath, JSON.stringify({
      "opencode-go": { type: "api_key", key: "hardlink-secret-sentinel" },
    }), { mode: 0o600 });
    await link(targetPath, authPath);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain("file has multiple hard links");
    expect(text).not.toContain("hardlink-secret-sentinel");
  });

  it("fails closed before parsing an oversized Pi auth store", async () => {
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, Buffer.alloc(1_048_577, 0x78), { mode: 0o600 });
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    expect(creds.details.join("\n")).toContain("exceeds the 1 MiB inspection limit");
  });

  it("fails closed on a malformed owner-only Pi auth store", async () => {
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, "{malformed-secret-sentinel", { mode: 0o600 });
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain("not a valid JSON object");
    expect(text).not.toContain("malformed-secret-sentinel");
  });

  it("flags missing OpenCode-Go API key credentials with an API-key hint", async () => {
    const authPath = await writeAuthStore({});
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/no Pi API key credentials found for provider `opencode-go`/u);
    expect(text).toMatch(/OPENCODE_API_KEY/u);
    expect(text).not.toMatch(/pi-ai login opencode-go/u);
    expect(report.ok).toBe(true);
  });

  it("recognizes an OpenCode-Go key in the resolved environment without exposing it", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
    });

    const report = await validateMonoAgentFolder({
      env: { OPENCODE_API_KEY: "hidden-opencode-key" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const credentials = sectionById(report, "credentials");
    expect(credentials.status).toBe("ok");
    expect(credentials.details.join("\n")).toContain("resolved environment (OPENCODE_API_KEY)");
    expect(credentials.details.join("\n")).not.toContain("hidden-opencode-key");
  });

  it("does not treat an empty Pi auth object as an authenticated API-key provider", async () => {
    const authPath = await writeAuthStore({ "opencode-go": {} });
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const credentials = sectionById(report, "credentials");
    expect(credentials.status).toBe("waiting");
    expect(credentials.details.join("\n")).toContain("unsupported or missing type");
  });

  it("verifies exact direct OpenCode provider IDs and a safe minimum CLI version", async () => {
    const configPath = await writeCredConfig({
      runtime: {
        model: "opencode:github-copilot:gpt-5.1",
        executionMode: "cli",
        fallbackModels: ["opencode:openai:gpt-5.1"],
      },
      tools: { allowedTools: ["*"] },
    });
    const env = await writeDirectOpenCodeState({
      "github-copilot": { type: "oauth", refresh: "secret", access: "secret", expires: FUTURE },
      openai: { type: "api", key: "secret" },
    });
    const statusExec = vi.fn(async () => ({ stdout: "1.15.13\n" }));

    const report = await validateMonoAgentFolder({
      env: { ...env, PATH: "/test/bin" },
      cwd: dir,
      configPath,
      liveness: true,
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details).toContain(
      "Primary opencode:github-copilot:gpt-5.1: provider `github-copilot` credential present in the standard OpenCode auth store; stable OpenCode CLI >=1.15.0 detected without a model turn. Credential detected; live model verification is still pending.",
    );
    expect(creds.details).toContain(
      "Fallback opencode:openai:gpt-5.1: provider `openai` credential present in the standard OpenCode auth store; stable OpenCode CLI >=1.15.0 detected without a model turn. Credential detected; live model verification is still pending.",
    );
    expect(creds.details.join("\n")).not.toContain("secret");
    expect(statusExec).toHaveBeenCalledOnce();
    expect(statusExec).toHaveBeenCalledWith(
      "opencode",
      ["--version"],
      expect.objectContaining({
        timeout: 5_000,
        maxBuffer: 65_536,
        encoding: "utf8",
        env: { PATH: "/test/bin" },
      }),
    );
  });

  it("keeps static direct OpenCode validation waiting until the minimum CLI version can be verified", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      tools: { allowedTools: ["*"] },
    });
    const env = await writeDirectOpenCodeState({
      "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
    });
    const statusExec = vi.fn(async () => ({ stdout: "must not run" }));

    const report = await validateMonoAgentFolder({
      env,
      cwd: dir,
      configPath,
      liveness: false,
      sdkAuthStatusExecFile: statusExec,
    });

    const credentials = sectionById(report, "credentials");
    expect(credentials.status).toBe("waiting");
    expect(credentials.details.join("\n")).toContain(
      "required stable OpenCode CLI >=1.15.0 is unverified during static validation",
    );
    expect(credentials.details.join("\n")).toContain("No OpenCode process was launched");
    expect(statusExec).not.toHaveBeenCalled();
  });

  it.each(["1.14.9", "1.15.0-beta.1", "not-a-version"])(
    "keeps direct OpenCode waiting when CLI version %s is unsupported",
    async (version) => {
      const configPath = await writeCredConfig({
        runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
        tools: { allowedTools: ["*"] },
      });
      const env = await writeDirectOpenCodeState({
        "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
      });
      const statusExec = vi.fn(async () => ({ stdout: `${version}\n` }));

      const report = await validateMonoAgentFolder({
        env,
        cwd: dir,
        configPath,
        liveness: true,
        sdkAuthStatusExecFile: statusExec,
      });

      const credentials = sectionById(report, "credentials");
      expect(credentials.status).toBe("waiting");
      expect(credentials.details.join("\n")).toContain(
        "stable OpenCode CLI >=1.15.0 could not be verified",
      );
      expect(credentials.details.join("\n")).toContain(
        "No model turn or mutation-capable OpenCode command was run",
      );
      expect(statusExec).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["OAuth without access", { type: "oauth", refresh: "r", expires: FUTURE }],
    ["OAuth with no usable token", { type: "oauth", refresh: " ", access: "", expires: FUTURE }],
    ["OAuth with fractional expiry", { type: "oauth", refresh: "r", access: "a", expires: 1.5 }],
    ["API with an empty key", { type: "api", key: "" }],
    ["API with a whitespace key", { type: "api", key: "  " }],
    ["API with non-string metadata", { type: "api", key: "secret", metadata: { tenant: 42 } }],
    ["well-known without token", { type: "wellknown", key: "secret" }],
    ["well-known with whitespace token", { type: "wellknown", key: "secret", token: "  " }],
    ["unknown credential type", { type: "cookie", value: "secret" }],
  ])("rejects malformed direct OpenCode auth entry: %s", async (_label, credential) => {
    const configPath = await writeCredConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      tools: { allowedTools: ["*"] },
    });
    const env = await writeDirectOpenCodeState({ "github-copilot": credential });
    const statusExec = vi.fn(async () => ({ stdout: "must not run" }));

    const report = await validateMonoAgentFolder({
      env,
      cwd: dir,
      configPath,
      liveness: false,
      sdkAuthStatusExecFile: statusExec,
    });

    const credentials = sectionById(report, "credentials");
    expect(credentials.status).toBe("waiting");
    expect(credentials.details.join("\n")).toContain(
      "auth.json is malformed or contains an unsupported credential entry",
    );
    expect(credentials.details.join("\n")).not.toContain("secret");
    expect(statusExec).not.toHaveBeenCalled();
  });

  it("warns when direct OpenCode does not report the referenced provider credential", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "opencode:openrouter:anthropic/claude-3.5-sonnet", executionMode: "cli" },
      tools: { allowedTools: ["*"] },
    });

    const env = await writeDirectOpenCodeState({
      "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
    });
    const statusExec = vi.fn(async () => ({ stdout: "1.15.13\n" }));
    const report = await validateMonoAgentFolder({
      env,
      cwd: dir,
      configPath,
      liveness: true,
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    expect(creds.details.join("\n")).toContain(
      "no exact credential entry exists for provider `openrouter`",
    );
    expect(statusExec).toHaveBeenCalledOnce();
  });

  it("surfaces a missing OpenCode migration marker without launching a process", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      tools: { allowedTools: ["*"] },
    });
    const env = await writeDirectOpenCodeState({
      "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: FUTURE },
    }, { marker: false });
    const statusExec = vi.fn(async () => ({ stdout: "must not run" }));

    const report = await validateMonoAgentFolder({
      env,
      cwd: dir,
      configPath,
      liveness: false,
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    expect(creds.details.join("\n")).toContain("opencode db migrate --pure");
    expect(creds.details.join("\n")).toContain("No OpenCode process was launched");
    expect(statusExec).not.toHaveBeenCalled();
  });

  it("flags an expired OAuth token as waiting with a re-auth hint (the 10-day silent-degradation case)", async () => {
    const authPath = await writeAuthStore({ "openai-codex": { type: "oauth", expires: PAST, refresh: "r" } });
    await writeModelsStore(["opencode-go"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6", fallbackModels: ["pi:openai-codex:gpt-5.5"] },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/WARN/u);
    expect(text).toMatch(/expired/u);
    expect(text).toMatch(/mono-agent auth login openai-codex --pi-auth-path/u);
    expect(text).not.toMatch(/pi-ai login openai-codex/u);
    expect(text).not.toMatch(/npx @earendil-works\/pi-ai/u);
    expect(text).toMatch(/not ready until a request succeeds/u);
    // waiting is non-fatal — the report still passes, but the degradation is now visible.
    expect(report.ok).toBe(true);
  });

  it("flags a referenced OAuth provider that is absent from the auth store", async () => {
    const authPath = await writeAuthStore({ anthropic: { type: "oauth", expires: FUTURE } });
    await writeModelsStore(["opencode-go"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6", fallbackModels: ["pi:openai-codex:gpt-5.5"] },
      providers: { piAuthPath: authPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/no Pi credentials found for provider `openai-codex`/u);
    expect(report.ok).toBe(true);
  });

  it("includes the agent-host memory LLM in the credential check", async () => {
    const authPath = await writeAuthStore({ "openai-codex": { type: "oauth", expires: PAST } });
    await writeModelsStore(["opencode-go"]);
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:kimi-k2.6" },
      providers: { piAuthPath: authPath },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    expect(creds.details.join("\n")).toMatch(/Memory LLM pi:openai-codex:gpt-5\.5: stored OAuth credential for `openai-codex` has no usable access or refresh token/u);
  });

  it("checks credentials for enabled static Pi, direct OpenCode, and SDK trigger models", async () => {
    const authPath = await writeAuthStore({});
    const openCodeEnv = await writeDirectOpenCodeState({
      openrouter: { type: "api", key: "opencode-secret-sentinel" },
    });
    const configPath = await writeCredConfig({
      runtime: { model: "pi:local-base:primary" },
      providers: {
        piAuthPath: authPath,
        local: [
          { id: "local-base", type: "openai_compat", baseUrl: "http://127.0.0.1:11434" },
          {
            id: "local-secure",
            type: "openai_compat",
            baseUrl: "http://127.0.0.1:11434",
            apiKeyEnv: "LOCAL_TRIGGER_API_KEY",
          },
        ],
      },
      tools: { allowedTools: ["*"] },
      webhook: {
        enabled: true,
        endpoints: [
          {
            name: "local",
            path: "/local",
            mode: "sync",
            model: "pi:local-secure:private-model",
          },
          {
            name: "opencode",
            path: "/opencode",
            mode: "sync",
            model: "opencode:openrouter:provider-model",
          },
        ],
      },
      cron: {
        jobs: [
          {
            id: "claude",
            enabled: true,
            expression: "0 7 * * *",
            prompt: "Summarize.",
            model: "claude:claude-sonnet-4-6",
          },
          {
            id: "pi-built-in",
            enabled: true,
            expression: "0 8 * * *",
            prompt: "Summarize.",
            model: "pi:opencode-go:kimi-k2.6",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({
      env: openCodeEnv,
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain(
      "webhook.endpoints[0] pi:local-secure:private-model: provider `local-secure` declares apiKeyEnv `LOCAL_TRIGGER_API_KEY`",
    );
    expect(text).toContain(
      "webhook.endpoints[1] opencode:openrouter:provider-model: credentials and migration marker are present",
    );
    expect(text).toContain(
      "cron.jobs[0] claude:claude-sonnet-4-6: no SDK credential in the resolved env",
    );
    expect(text).toContain(
      "cron.jobs[1] pi:opencode-go:kimi-k2.6: no Pi API key credentials found for provider `opencode-go`",
    );
    expect(text).not.toContain("opencode-secret-sentinel");
    expect(report.ok).toBe(true);
  });

  it("ignores credentials and model resolution for a globally disabled webhook", async () => {
    const authPath = await writeAuthStore({});
    const configPath = await writeCredConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      providers: { piAuthPath: authPath },
      webhook: {
        enabled: false,
        endpoints: [
          {
            name: "unknown-pi",
            path: "/unknown-pi",
            mode: "sync",
            model: "pi:opencode-go:not-in-the-catalog",
          },
          {
            name: "missing-claude-auth",
            path: "/missing-claude-auth",
            mode: "sync",
            model: "claude:claude-sonnet-4-6",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "runtime").status).toBe("ok");
    expect(sectionById(report, "channel:webhook").status).toBe("disabled");
    const credentialText = sectionById(report, "credentials").details.join("\n");
    expect(credentialText).not.toContain("webhook.endpoints");
    expect(credentialText).not.toContain("not-in-the-catalog");
    expect(credentialText).not.toContain("claude-sonnet-4-6");
    expect(report.ok).toBe(true);
  });

  // E1 (headline): a `claude:*` model with no discoverable env credential must WARN
  // at validate time so the fresh user isn't blindsided by the opaque first-turn crash.
  it("warns (waiting) when a claude:* model has no ANTHROPIC_API_KEY in the resolved env", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/\[WARN\] Primary claude:claude-sonnet-4-6: no SDK credential in the resolved env/u);
    expect(text).toMatch(/ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN/u);
    // The warning stays honest: a `claude /login` session and a Bedrock/Vertex
    // configuration authenticate outside the checked keys and can't be verified here.
    expect(text).toMatch(/claude \/login/u);
    expect(text).toMatch(/Bedrock\/Vertex/u);
    // waiting is non-fatal — validate still passes, but the trap is now visible.
    expect(report.ok).toBe(true);
  });

  it("does not warn when a claude:* model has ANTHROPIC_API_KEY set", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
    });

    const report = await validateMonoAgentFolder({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).not.toMatch(/WARN/u);
    expect(text).toMatch(/Primary claude:claude-sonnet-4-6: SDK credential present in the resolved env \(ANTHROPIC_API_KEY\)/u);
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN as a claude:* env credential", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "claude:claude-sonnet-4-6" },
    });

    const report = await validateMonoAgentFolder({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details.join("\n")).toMatch(/SDK credential present in the resolved env \(CLAUDE_CODE_OAUTH_TOKEN\)/u);
  });

  it("warns (waiting) when a codex:* model has no OPENAI_API_KEY, naming the codex login path", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "codex:gpt-5.5" },
      tools: { allowedTools: ["*"] },
    });
    const statusExec = vi.fn(async () => ({ stdout: "logged in" }));

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/\[WARN\] Primary codex:gpt-5\.5: no SDK credential in the resolved env \(checked OPENAI_API_KEY\)/u);
    expect(text).toMatch(/codex login/u);
    expect(statusExec).not.toHaveBeenCalled();
    expect(report.ok).toBe(true);
  });

  it("does not warn when a codex:* model has OPENAI_API_KEY set", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "codex:gpt-5.5" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({
      env: { OPENAI_API_KEY: "sk-test" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details.join("\n")).not.toMatch(/WARN/u);
  });

  it("verifies Codex and Claude external logins live once per SDK across fallback, memory, and trigger refs", async () => {
    const configPath = await writeCredConfig({
      runtime: {
        model: "codex:gpt-5.6-terra",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      tools: { allowedTools: ["*"] },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
        llm: { provider: "agent-host", model: "claude:claude-sonnet-4-6" },
      },
      webhook: {
        enabled: true,
        endpoints: [{
          name: "claude",
          path: "/claude",
          mode: "sync",
          model: "claude:claude-sonnet-4-6",
        }],
      },
    });
    const validationEnv = { PATH: "/test/bin", HOME: join(dir, "test-home") };
    const calls: Array<{
      readonly file: string;
      readonly args: readonly string[];
      readonly options: Parameters<SdkAuthStatusExecFile>[2];
    }> = [];
    const statusExec: SdkAuthStatusExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      return file === "claude"
        ? { stdout: JSON.stringify({ loggedIn: true }) }
        : { stdout: "Logged in using ChatGPT" };
    };

    const report = await validateMonoAgentFolder({
      env: validationEnv,
      cwd: dir,
      configPath,
      liveness: true,
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details).toContain(
      "Primary codex:gpt-5.6-terra: external sign-in detected by read-only `codex login status`; credentials are not verified until a live model turn succeeds.",
    );
    expect(creds.details).toContain(
      "Fallback claude:claude-sonnet-4-6: external sign-in detected by read-only `claude auth status --json`; credentials are not verified until a live model turn succeeds.",
    );
    expect(creds.details).toContain(
      "Memory LLM claude:claude-sonnet-4-6: external sign-in detected by read-only `claude auth status --json`; credentials are not verified until a live model turn succeeds.",
    );
    expect(creds.details).toContain(
      "webhook.endpoints[0] claude:claude-sonnet-4-6: external sign-in detected by read-only `claude auth status --json`; credentials are not verified until a live model turn succeeds.",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map(({ file }) => file).sort()).toEqual(["claude", "codex"]);
    expect(calls.find(({ file }) => file === "codex")?.args).toEqual(["login", "status"]);
    expect(calls.find(({ file }) => file === "claude")?.args).toEqual(["auth", "status", "--json"]);
    for (const call of calls) {
      expect(call.options).toMatchObject({
        cwd: dir,
        env: validationEnv,
        timeout: 5_000,
        maxBuffer: 65_536,
        encoding: "utf8",
      });
    }
  });

  it("keeps failed SDK status checks waiting and requires Claude loggedIn to be boolean true", async () => {
    const configPath = await writeCredConfig({
      runtime: {
        model: "codex:gpt-5.6-terra",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      tools: { allowedTools: ["*"] },
      memory: {
        mode: "bujo",
        path: dir,
        writeMode: "append-host-summary",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test" },
        llm: { provider: "agent-host", model: "claude:claude-sonnet-4-6" },
      },
    });
    const calls: string[] = [];
    const statusExec: SdkAuthStatusExecFile = async (file) => {
      calls.push(file);
      if (file === "codex") {
        throw new Error("not logged in");
      }
      return { stdout: JSON.stringify({ loggedIn: "true" }) };
    };

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: true,
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain("External login was not verified by `codex login status`");
    expect(text).toContain("External login was not verified by `claude auth status --json`");
    expect(text).not.toContain("external login verified by read-only");
    expect(calls.sort()).toEqual(["claude", "codex"]);
  });

  it("accepts a successful live model check as proof of an external Codex login", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      tools: { allowedTools: ["*"] },
    });

    const statusExec = vi.fn(async () => {
      throw new Error("verified refs must not need an external-login status check");
    });
    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: true,
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      sdkAuthStatusExecFile: statusExec,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    expect(creds.details).toContain(
      "Primary codex:gpt-5.6-terra: credentials verified by a successful live model check.",
    );
    expect(creds.details.join("\n")).not.toContain("codex login");
    expect(statusExec).not.toHaveBeenCalled();
    expect(report.ok).toBe(true);
  });

  // E2: a fully-valid `providers.local` ollama provider with no key declaration is
  // keyless — with an empty Pi store it must not get unrelated auth-store advice.
  it("does not warn for a pi:ollama model configured via providers.local with an empty pi store", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:ollama:gemma4:31b" },
      providers: {
        local: [
          { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).not.toMatch(/WARN/u);
    expect(text).not.toMatch(/no Pi credentials found/u);
    expect(text).toMatch(/Primary pi:ollama:gemma4:31b: provider `ollama` configured via config providers\.local \(keyless local provider; no API key declared\)/u);
    expect(report.ok).toBe(true);
  });

  it("reports a declared but unresolved local-provider apiKeyEnv as waiting", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:local-secure:private-model" },
      providers: {
        local: [{
          id: "local-secure",
          type: "openai_compat",
          baseUrl: "http://127.0.0.1:11434",
          apiKeyEnv: "LOCAL_PROVIDER_API_KEY",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toContain("declares apiKeyEnv `LOCAL_PROVIDER_API_KEY`");
    expect(text).toContain("Set LOCAL_PROVIDER_API_KEY before starting");
    expect(text).not.toContain("keyless local provider");
    expect(report.ok).toBe(true);
  });

  it.each([
    {
      name: "a resolved apiKeyEnv",
      provider: { apiKeyEnv: "LOCAL_PROVIDER_API_KEY" },
      env: { LOCAL_PROVIDER_API_KEY: "env-secret-sentinel" },
      secret: "env-secret-sentinel",
    },
    {
      name: "an inline fallback when apiKeyEnv is absent",
      provider: { apiKeyEnv: "LOCAL_PROVIDER_API_KEY", apiKey: "inline-secret-sentinel" },
      env: {},
      secret: "inline-secret-sentinel",
    },
  ])("reports $name generically without exposing the key", async ({ provider, env, secret }) => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:local-secure:private-model" },
      providers: {
        local: [{
          id: "local-secure",
          type: "openai_compat",
          baseUrl: "http://127.0.0.1:11434",
          ...provider,
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env, cwd: dir, configPath, liveness: false });

    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).toContain("provider `local-secure` configured via config providers.local (API key configured)");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("keyless local provider");
    expect(report.ok).toBe(true);
  });

  it("gives providers.local precedence over a same-ID built-in provider for credential reporting", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:opencode-go:private-model" },
      providers: {
        local: [{
          id: "opencode-go",
          type: "openai_compat",
          baseUrl: "http://127.0.0.1:11434",
        }],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "runtime").status).toBe("ok");
    const creds = sectionById(report, "credentials");
    expect(creds.status).toBe("ok");
    const text = creds.details.join("\n");
    expect(text).toContain("provider `opencode-go` configured via config providers.local (keyless local provider");
    expect(text).not.toContain("no Pi API key credentials");
    expect(report.ok).toBe(true);
  });

  // Regression: a DISABLED providers.local entry must NOT report a clean OK — the
  // runtime throws `provider disabled: ollama` on the first turn, so the union
  // must name that rather than treating it as a keyless-provider success.
  it("warns (waiting) for a pi:ollama model whose providers.local entry is disabled", async () => {
    const configPath = await writeCredConfig({
      runtime: { model: "pi:ollama:gemma4:31b" },
      providers: {
        local: [
          {
            id: "ollama",
            type: "ollama",
            baseUrl: "http://localhost:11434",
            enabled: false,
            apiKeyEnv: "DISABLED_PROVIDER_KEY",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({
      env: { DISABLED_PROVIDER_KEY: "disabled-secret-sentinel" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const creds = sectionById(report, "credentials");
    expect(creds.status).not.toBe("ok");
    expect(creds.status).toBe("waiting");
    const text = creds.details.join("\n");
    expect(text).toMatch(/\[WARN\] Primary pi:ollama:gemma4:31b: provider `ollama` is configured in providers\.local but disabled/u);
    expect(text).toMatch(/provider disabled: ollama/u);
    // It must NOT claim the keyless-provider success path for a disabled provider.
    expect(text).not.toMatch(/keyless local provider/u);
    expect(text).not.toMatch(/API key configured/u);
    expect(text).not.toContain("disabled-secret-sentinel");
    expect(sectionById(report, "runtime").status).toBe("error");
    expect(report.ok).toBe(false);
  });
});

describe("validateMonoAgentFolder — tools guardrails & channel cross-checks", () => {
  async function writeToolsConfig(
    tools: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    return writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools,
      ...extra,
    });
  }

  it("flags an empty allowlist as waiting (the no-tools trap), never failing the report", async () => {
    const configPath = await writeToolsConfig({ allowedTools: [] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/cannot read files/u);
    // A deliberately chat-only agent is legitimate: waiting never fails validate.
    expect(report.ok).toBe(true);
  });

  it("renders allow-all ('*') cleanly as 'All tools allowed.' (status ok)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["*"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details).toContain("All tools allowed.");
    // Never the raw sentinel echo, and no "except" clause when nothing is disallowed.
    expect(tools.details.join("\n")).not.toMatch(/Allowed tools: \*/u);
    expect(tools.details.join("\n")).not.toMatch(/except/u);
    expect(report.ok).toBe(true);
  });

  it("folds disallowedTools into the allow-all line (no separate Disallowed line)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["*"], disallowedTools: ["Bash"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details).toContain("All tools allowed (except: Bash).");
    // The disallow list is folded into the allow-all line; it must not ALSO print separately.
    expect(tools.details.join("\n")).not.toMatch(/Disallowed tools:/u);
    expect(report.ok).toBe(true);
  });

  it("fails closed when a direct Codex model is configured with a restrictive tool policy", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["Read", "Glob", "Grep"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("error");
    expect(tools.details.join("\n")).toContain("Direct Codex model codex:gpt-5.6-terra cannot enforce");
    expect(tools.details.join("\n")).toContain('allowedTools: ["*"] with no disallowedTools');
  });

  it("accepts direct Codex only with exact allow-all and no disallowed tools", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "codex:gpt-5.6-terra" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    expect(sectionById(report, "tools")).toMatchObject({ status: "ok" });
  });

  it("fails closed when direct OpenCode is configured with a restrictive tool policy", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["Read", "Glob", "Grep"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("error");
    expect(tools.details.join("\n")).toContain("Direct OpenCode model opencode:github-copilot:gpt-5.1 cannot enforce");
    expect(tools.details.join("\n")).toContain('allowedTools: ["*"] with no disallowedTools');
  });

  it("accepts a minimal direct OpenCode host and suppresses implicit app-owned MCP tools", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(true);
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toContain("MCP runtime options");
    expect(tools.details.join("\n")).not.toContain("AskUser");
    expect(tools.details.join("\n")).not.toContain("RunHistory");
  });

  it("fails closed when direct OpenCode would receive configured MCP servers", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: { filesystem: { command: "mcp-filesystem" } },
    }));
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"], mcpConfigPath },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("error");
    expect(tools.details.join("\n")).toContain("cannot safely consume MCP runtime options from tools.mcpConfigPath (filesystem)");
  });

  it("validates request-context MCP names and requires stdio transports", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: { remote: { type: "http", url: "https://mcp.example.test" } },
    }));
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: {
        allowedTools: ["*"],
        mcpConfigPath,
        mcpRequestContextServers: ["missing", "remote"],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("error");
    expect(tools.details.join("\n")).toContain('names unknown MCP server "missing"');
    expect(tools.details.join("\n")).toContain('entry "remote" must reference a stdio MCP server');
  });

  it("rejects unknown and unsupported continuation MCP servers", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        remote: { type: "http", url: "https://mcp.example.test" },
        events: { type: "sse", url: "http://127.0.0.1:8123/events" },
      },
    }));
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: {
        allowedTools: ["*"],
        mcpConfigPath,
        continuationServers: ["missing", "remote", "events"],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const tools = sectionById(report, "tools");
    expect(report.ok).toBe(false);
    expect(tools.status).toBe("error");
    expect(tools.details.join("\n")).toContain('names unknown MCP server "missing"');
    expect(tools.details.join("\n")).toContain('entry "remote" must reference a stdio or loopback HTTP MCP server');
    expect(tools.details.join("\n")).toContain('entry "events" must reference a stdio or loopback HTTP MCP server');
  });

  it("accepts stdio and loopback HTTP continuation MCP servers", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        worker: { command: "local-worker" },
        control: { type: "http", url: "http://[::1]:8123/mcp" },
      },
    }));
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: {
        allowedTools: ["*"],
        mcpConfigPath,
        continuationServers: ["worker", "control"],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(report.ok).toBe(true);
    expect(sectionById(report, "tools").status).toBe("ok");
  });

  it("rejects continuation MCP declarations the canonical runtime drops or reinterprets", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        missingCommand: { type: "stdio" },
        blankCommand: { type: "stdio", command: "   " },
        conflictingStdio: {
          type: "stdio",
          command: "local-worker",
          url: "https://mcp.example.test",
        },
        conflictingHttp: {
          type: "http",
          command: "local-worker",
          url: "http://127.0.0.1:8123/mcp",
        },
        "bad name": { command: "local-worker" },
      },
    }));
    const configPath = await writeConfig({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "./IDENTITY.md" },
      tools: {
        allowedTools: ["*"],
        mcpConfigPath,
        continuationServers: [
          "missingCommand",
          "blankCommand",
          "conflictingStdio",
          "conflictingHttp",
          "bad name",
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const details = sectionById(report, "tools").details.join("\n");
    expect(report.ok).toBe(false);
    expect(details.match(/must reference a stdio or loopback HTTP MCP server/gu)).toHaveLength(4);
    expect(details).toContain('entry "bad name" is not a runtime-valid MCP server name');
  });

  it.each([
    ["memory recall", {
      memory: { mode: "lite", path: ".mono-agent/memory", recallTool: { enabled: true } },
    }, "memory.recallTool"],
    ["hosted Supermemory MCP", {
      memory: {
        backend: "supermemory",
        mode: "lite",
        writeMode: "capture",
        supermemory: {
          baseUrl: "https://api.supermemory.ai",
          apiKey: "test-only-secret",
          exposeMcpServer: true,
        },
      },
    }, "memory.supermemory.exposeMcpServer"],
  ])("fails closed when direct OpenCode would receive %s", async (_label, extra, source) => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      ...extra,
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "tools").details.join("\n")).toContain(source);
  });

  it("fails closed when direct OpenCode would receive adapter send-tool MCP", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "opencode:github-copilot:gpt-5.1", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: ["*"] },
      telegram: { enabled: true, allowAllChats: true },
    });

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:test-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(report.ok).toBe(false);
    expect(sectionById(report, "tools").details.join("\n")).toContain("adapter send tools (TelegramSendMessage");
  });

  it("rejects an explicit empty tool list for Claude CLI", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const configPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6", executionMode: "cli" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: [] },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(report.ok).toBe(false);
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("error");
    expect(tools.details.join("\n")).toContain("Claude CLI model claude:claude-sonnet-4-6 cannot enforce an empty");
    expect(tools.details.join("\n")).toContain("omitting --tools enables Claude Code's default tool set");
  });

  it("keeps an explicit empty tool list valid for Claude SDK and a Claude SDK fallback", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const sdkConfigPath = await writeConfig({
      runtime: { model: "claude:claude-sonnet-4-6", executionMode: "sdk" },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: [] },
    });

    const sdkReport = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath: sdkConfigPath, liveness: false });
    expect(sdkReport.ok).toBe(true);
    expect(sectionById(sdkReport, "tools")).toMatchObject({ status: "waiting" });

    const fallbackConfigPath = await writeConfig({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      context: { identityPath: "./IDENTITY.md" },
      tools: { allowedTools: [] },
    });
    const fallbackReport = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath: fallbackConfigPath,
      liveness: false,
    });
    expect(fallbackReport.ok).toBe(true);
    expect(sectionById(fallbackReport, "tools")).toMatchObject({ status: "waiting" });
  });

  it("does not fire Direction B under allow-all (send tools are allowed by '*')", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["*"] },
      { telegram: { enabled: true, allowAllChats: true } },
    );

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(sectionById(report, "channel:telegram").status).not.toBe("disabled");
    const tools = sectionById(report, "tools");
    // Under allow-all every send tool is allowed, so the "enabled without a send tool" hint
    // must NOT fire and must not downgrade the status.
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toMatch(/telegram is enabled without/u);
    expect(report.ok).toBe(true);
  });

  it("passes a valid safe-tool allowlist (status ok)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["Read", "Glob", "Grep"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(report.ok).toBe(true);
  });

  it.each([
    {
      label: "Slack",
      tools: { allowedTools: ["SlackSendMessage"] },
      extra: {
        slack: { enabled: true, allowedChannelIds: ["C1"] },
        sandbox: { mode: "native", fallback: "fail-closed", network: { mode: "localhost" } },
      },
      env: { MONO_AGENT_SLACK_BOT_TOKEN: "xoxb-test", MONO_AGENT_SLACK_APP_TOKEN: "xapp-test" },
      tool: "SlackSendMessage",
      host: "slack.com",
    },
    {
      label: "Telegram",
      tools: { allowedTools: ["TelegramSendMessage"] },
      extra: {
        telegram: { enabled: true, allowAllChats: true },
        sandbox: { mode: "native", fallback: "fail-closed", network: { mode: "localhost" } },
      },
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      tool: "TelegramSendMessage",
      host: "api.telegram.org",
    },
    {
      label: "AskUser",
      tools: { allowedTools: ["AskUser"] },
      extra: {
        sandbox: {
          mode: "native",
          fallback: "fail-closed",
          network: { mode: "allowlist", allowlist: ["api.telegram.org"] },
        },
      },
      env: {},
      tool: "AskUser",
      host: "127.0.0.1",
    },
  ])("warns when native sandbox networking blocks the $label tool endpoint", async ({ tools: policy, extra, env, tool, host }) => {
    const configPath = await writeToolsConfig(policy, extra);

    const report = await validateMonoAgentFolder({
      env,
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toContain(tool);
    expect(tools.details.join("\n")).toContain(`host "${host}"`);
    expect(tools.details.join("\n")).toContain(`add "${host}" to sandbox.network.allowlist`);
  });

  it("passes when the native sandbox allowlist contains every enabled adapter-send endpoint", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["SlackSendMessage", "TelegramSendMessage", "AskUser"] },
      {
        slack: { enabled: true, allowedChannelIds: ["C1"] },
        telegram: { enabled: true, allowAllChats: true },
        sandbox: {
          mode: "native",
          fallback: "fail-closed",
          network: { mode: "allowlist", allowlist: ["slack.com", "api.telegram.org", "127.0.0.1"] },
        },
      },
    );

    const report = await validateMonoAgentFolder({
      env: {
        MONO_AGENT_SLACK_BOT_TOKEN: "xoxb-test",
        MONO_AGENT_SLACK_APP_TOKEN: "xapp-test",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token",
      },
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toContain("Native sandbox network policy blocks");
  });

  it("accepts the default 127.0.0.1 AskUser bridge when localhost is explicitly allowlisted", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["AskUser"] },
      {
        sandbox: {
          mode: "native",
          fallback: "fail-closed",
          network: { mode: "allowlist", allowlist: ["localhost"] },
        },
      },
    );

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toContain("Native sandbox network policy blocks");
  });

  it("recommends a valid localhost allowlist spelling for an IPv6 loopback bridge", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["AskUser"] },
      {
        interaction: { bridge: { host: "::1" } },
        sandbox: {
          mode: "native",
          fallback: "fail-closed",
          network: { mode: "allowlist", allowlist: ["api.telegram.org"] },
        },
      },
    );

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    const details = sectionById(report, "tools").details.join("\n");
    expect(details).toContain('host "::1"');
    expect(details).toContain('add "localhost" to sandbox.network.allowlist');
    expect(details).not.toContain('add "::1" to sandbox.network.allowlist');
  });

  it("does not apply adapter endpoint checks when the mono-agent sandbox is off", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["TelegramSendMessage"] },
      {
        telegram: { enabled: true, allowAllChats: true },
        sandbox: { mode: "off" },
      },
    );

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toContain("api.telegram.org");
    expect(tools.details.join("\n")).not.toContain("sandbox.network.allowlist");
  });

  it("does not require an adapter endpoint for an explicitly denied tool", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["Read", "TelegramSendMessage"], disallowedTools: ["TelegramSendMessage"] },
      {
        telegram: { enabled: true, allowAllChats: true },
        sandbox: { mode: "native", fallback: "fail-closed", network: { mode: "localhost" } },
      },
    );

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
      sandboxEngine: availableSandboxEngine,
    });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toContain("api.telegram.org");
    expect(tools.details.join("\n")).not.toContain("Native sandbox network policy blocks");
  });

  it("flags an unknown tool name with a did-you-mean suggestion (waiting)", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["read"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/Unknown tool name "read".*did you mean Read/u);
    expect(report.ok).toBe(true);
  });

  it("recognizes NodeRepl as a built-in tool", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["NodeRepl"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).not.toContain("Unknown tool");
  });

  it("notes MemoryRecall as a harmless no-op (status ok) when recall is enabled", async () => {
    // recallTool enabled → MemoryRecall is auto-provisioned; listing it is redundant
    // but harmless, so it is an INFO note that does not downgrade the tools status.
    const configPath = await writeToolsConfig(
      { allowedTools: ["MemoryRecall", "Read"] },
      { memory: { mode: "lite", path: dir, recallTool: { enabled: true } } },
    );

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toMatch(/has no effect|already on/u);
    expect(report.ok).toBe(true);
  });

  it("flags MemoryRecall in allowedTools as waiting when recall is not enabled", async () => {
    // No recallTool.enabled → recall will not work despite the allowlist entry.
    const configPath = await writeToolsConfig({ allowedTools: ["MemoryRecall"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/recall will not work|recallTool/u);
    expect(report.ok).toBe(true);
  });

  it("skips MCP tool names (unvalidatable offline) but keeps ok when a real tool is present", async () => {
    const configPath = await writeToolsConfig({ allowedTools: ["mcp__foo__bar", "Read"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toMatch(/cannot be validated offline/u);
    expect(report.ok).toBe(true);
  });

  it("Direction A: warns when a send tool is allowed but its channel is disabled", async () => {
    // `Read` keeps the allowlist non-empty and known, so the ONLY reason for
    // waiting is the cross-check (not the empty-allowlist or unknown-name checks).
    const configPath = await writeToolsConfig({ allowedTools: ["TelegramSendMessage", "Read"] });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });

    expect(sectionById(report, "channel:telegram").status).toBe("disabled");
    const tools = sectionById(report, "tools");
    expect(tools.status).toBe("waiting");
    expect(tools.details.join("\n")).toMatch(/telegram channel is disabled/u);
    expect(report.ok).toBe(true);
  });

  it("Direction B: hints (status unchanged) when a channel is enabled without a send tool allowed", async () => {
    const configPath = await writeToolsConfig(
      { allowedTools: ["Read", "Glob", "Grep"] },
      { telegram: { enabled: true, allowAllChats: true } },
    );

    const report = await validateMonoAgentFolder({
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "123:env-bot-token" },
      cwd: dir,
      configPath,
      liveness: false,
    });

    expect(sectionById(report, "channel:telegram").status).not.toBe("disabled");
    const tools = sectionById(report, "tools");
    // A hint must NOT downgrade the status — replies still work.
    expect(tools.status).toBe("ok");
    expect(tools.details.join("\n")).toMatch(/telegram is enabled without/u);
    expect(report.ok).toBe(true);
  });
});
