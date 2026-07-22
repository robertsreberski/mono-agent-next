import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryCompletedTurn } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CompletedTurnIntakeManager,
  auditCompletedTurnIntake,
  inspectCompletedTurnIntake,
  resolveCompletedTurnIntake,
  retryCompletedTurnIntake,
  type CompletedTurnIntakeSnapshot,
} from "../capture-intake.js";
import { parseDailyFile } from "../grammar.js";
import { createBujoMemoryStore } from "../store.js";
import { fakeEmbeddings } from "./helpers.js";

const FIXED = new Date("2026-07-12T09:00:00.000Z");

function root(): string {
  return mkdtempSync(join(tmpdir(), "bujo-intake-"));
}

function turn(overrides: Partial<MemoryCompletedTurn> = {}): MemoryCompletedTurn {
  return {
    runId: "run-0001",
    conversationId: "conversation-0001",
    summary: "User prefers durable memory admission.",
    captureText: "User: remember durable memory admission.\nAssistant: acknowledged.",
    ...overrides,
  };
}

function manager(
  memoryRoot: string,
  overrides: Partial<ConstructorParameters<typeof CompletedTurnIntakeManager>[0]> = {},
): CompletedTurnIntakeManager {
  return new CompletedTurnIntakeManager({
    root: memoryRoot,
    clock: () => FIXED,
    writeSummary: async () => {},
    capture: async () => "captured",
    ...overrides,
  });
}

describe("completed-turn durable intake", () => {
  it("treats a pre-upgrade root with no intake tree as a valid empty state", () => {
    const memoryRoot = root();
    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: true,
      inspection: { snapshot: { pending: 0, dead: 0, resolved: 0, transitioning: 0 } },
    });
    expect(existsSync(join(memoryRoot, ".capture-intake"))).toBe(false);
  });

  it("publishes an owner-only pending record before admission returns", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, { capture: async () => await new Promise<never>(() => {}) });

    const admitted = intake.admit(turn());

    expect(admitted.admissionStatus).toBe("admitted");
    expect(admitted.bytesWritten).toBeGreaterThan(0);
    expect(existsSync(admitted.source)).toBe(true);
    expect(lstatSync(admitted.source).mode & 0o777).toBe(0o600);
    for (const path of [
      join(memoryRoot, ".capture-intake"),
      join(memoryRoot, ".capture-intake", "pending"),
      join(memoryRoot, ".capture-intake", "dead"),
      join(memoryRoot, ".capture-intake", "resolved"),
      join(memoryRoot, ".capture-intake", "ledger"),
    ]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
    const ledgerPath = join(memoryRoot, ".capture-intake", "ledger", `${admitted.id.slice(0, 2)}.log`);
    expect(lstatSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(memoryRoot, ".capture-intake", "ledger-v1.catalog")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(memoryRoot, ".capture-intake-v1")).mode & 0o777).toBe(0o600);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 1, due: 1 });
    intake.abortForShutdown(false);
  });

  it("notifies metadata-only observers across admission, processing, and shutdown transitions", async () => {
    const memoryRoot = root();
    const observations: Array<{
      readonly pending: number;
      readonly resolved: number;
      readonly retrying: number;
      readonly shutdown: string;
    }> = [];
    let intake: CompletedTurnIntakeManager | undefined;
    intake = manager(memoryRoot, {
      onChange: () => {
        const snapshot = intake?.snapshot();
        if (snapshot !== undefined) observations.push(snapshot);
      },
    });

    intake.admit(turn({ runId: "metadata-notifications" }));
    await intake.flush();
    intake.finishShutdown();

    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ pending: 1, resolved: 0, retrying: 0, shutdown: "running" }),
      expect.objectContaining({ pending: 1, resolved: 0, retrying: 1, shutdown: "running" }),
      expect.objectContaining({ pending: 0, resolved: 1, shutdown: "running" }),
      expect.objectContaining({ pending: 0, resolved: 1, retrying: 0, shutdown: "drained" }),
    ]));
    expect(observations.length).toBeGreaterThanOrEqual(7);
  });

  it("keeps 4,096-entry runtime snapshots disk-free across provider-separated transitions", async () => {
    const memoryRoot = root();
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let summaryStarted!: () => void;
    const summaryEntered = new Promise<void>((resolve) => { summaryStarted = resolve; });
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    let captureStarted!: () => void;
    const captureEntered = new Promise<void>((resolve) => { captureStarted = resolve; });
    const observations: CompletedTurnIntakeSnapshot[] = [];
    let intake!: CompletedTurnIntakeManager;
    intake = manager(memoryRoot, {
      resolvedRetention: 4_096,
      writeSummary: async () => {
        summaryStarted();
        await summaryGate;
      },
      capture: async () => {
        captureStarted();
        await captureGate;
        return "captured";
      },
      onChange: () => observations.push(intake.snapshot()),
    });
    const internals = intake as unknown as {
      runtimeRecords: Map<string, {
        state: "resolved";
        admittedAt: string;
        resolvedAt: string;
      }>;
      refreshRuntimeCacheFromDisk(): void;
    };
    for (let index = 0; index < 4_095; index += 1) {
      const id = String(index).padStart(64, "0");
      internals.runtimeRecords.set(id, {
        state: "resolved",
        admittedAt: FIXED.toISOString(),
        resolvedAt: new Date(FIXED.getTime() + index).toISOString(),
      });
    }
    const refresh = vi.spyOn(internals, "refreshRuntimeCacheFromDisk");

    intake.admit(turn({ runId: "runtime-cache-4096" }));
    await summaryEntered;
    expect(intake.snapshot()).toMatchObject({ pending: 1, resolved: 4_095, retrying: 1 });
    releaseSummary();
    await captureEntered;
    expect(intake.snapshot()).toMatchObject({ pending: 1, resolved: 4_095, retrying: 1 });
    releaseCapture();
    await intake.flush();
    expect(intake.snapshot()).toMatchObject({ pending: 0, resolved: 4_096, retrying: 0 });

    const intakePath = join(memoryRoot, ".capture-intake");
    const hiddenPath = join(memoryRoot, ".capture-intake-hidden");
    renameSync(intakePath, hiddenPath);
    try {
      for (let index = 0; index < 1_000; index += 1) {
        expect(intake.snapshot().resolved).toBe(4_096);
      }
    } finally {
      renameSync(hiddenPath, intakePath);
    }
    expect(refresh).not.toHaveBeenCalled();
    expect(observations.length).toBeLessThanOrEqual(7);
    intake.finishShutdown();
  });

  it("notifies observers when exhausted work becomes a durable dead letter", async () => {
    const memoryRoot = root();
    const observations: Array<{ readonly pending: number; readonly dead: number }> = [];
    let intake: CompletedTurnIntakeManager | undefined;
    intake = manager(memoryRoot, {
      maxAttempts: 1,
      capture: async () => { throw new Error("provider unavailable"); },
      onChange: () => {
        const snapshot = intake?.snapshot();
        if (snapshot !== undefined) observations.push(snapshot);
      },
    });

    intake.admit(turn({ runId: "dead-letter-notification" }));
    await intake.flush();

    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ pending: 1, dead: 0 }),
      expect.objectContaining({ pending: 0, dead: 1 }),
    ]));
    intake.finishShutdown();
  });

  it("keeps durable intake authoritative when a change observer throws", async () => {
    const memoryRoot = root();
    const warnings: string[] = [];
    const intake = manager(memoryRoot, {
      onChange: () => { throw new Error("private observer failure"); },
      warn: (message) => warnings.push(message),
    });

    intake.admit(turn({ runId: "throwing-observer" }));
    await intake.flush();

    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    expect(warnings).toContain("completed-turn intake state notification failed; durable state remains authoritative.");
    expect(warnings.join(" ")).not.toContain("private observer failure");
    intake.finishShutdown();
  });

  it("deduplicates exact run payloads and rejects conflicting reuse", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const first = intake.admit(turn());
    const duplicate = intake.admit(turn());

    expect(duplicate).toMatchObject({ id: first.id, admissionStatus: "duplicate", bytesWritten: 0 });
    expect(() => intake.admit(turn({ summary: "Conflicting summary." }))).toThrow(/conflicts/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(1);
    intake.abortForShutdown(false);
  });

  it.each([
    ["reserved delimiter", { summary: "unsafe <!--mem summary" }],
    ["bidi control", { summary: "unsafe \u202e summary" }],
    ["Unicode line separator", { summary: "unsafe\u2028summary" }],
    ["Unicode paragraph separator", { summary: "unsafe\u2029summary" }],
    ["surrogate", { captureText: "unsafe \ud800 capture" }],
  ] as const)("rejects %s before publishing an intake record", (_label, overrides) => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    expect(() => intake.admit(turn(overrides))).toThrow(/completed-turn|reserved/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(0);
    intake.abortForShutdown(false);
  });

  it("admits ordinary Unicode formatting used by joined emoji", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const input = turn({
      summary: "Family preference: 👨‍👩‍👧‍👦 trips.",
      captureText: "User: remember the 👨‍👩‍👧‍👦 trip preference.",
    });
    const admitted = intake.admit(input);
    expect(readFileSync(admitted.source, "utf8")).toContain("👨‍👩‍👧‍👦");
    await intake.flush();
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(true);
    intake.finishShutdown();
  });

  it("restarts after provider outage without rewriting an already durable summary", async () => {
    const memoryRoot = root();
    let now = FIXED;
    const summaries: string[] = [];
    const first = manager(memoryRoot, {
      clock: () => now,
      retryBaseMs: 5,
      writeSummary: async (_turn, id) => { summaries.push(id); },
      capture: async () => { throw new Error("provider unavailable"); },
    });
    first.admit(turn());
    await first.flush();
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot).toMatchObject({ pending: 1, due: 0 });
    first.finishShutdown();

    now = new Date(FIXED.getTime() + 5);
    const capture = vi.fn(async () => "captured" as const);
    const restarted = manager(memoryRoot, {
      clock: () => now,
      retryBaseMs: 5,
      writeSummary: async (_turn, id) => { summaries.push(id); },
      capture,
    });
    await restarted.flush();

    expect(capture).toHaveBeenCalledOnce();
    expect(summaries).toHaveLength(1);
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    restarted.finishShutdown();
  });

  it("preempts a later wake when a new failed turn schedules an earlier retry", async () => {
    const memoryRoot = root();
    let now = FIXED;
    let farAttempts = 0;
    let earlierAttempts = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const intake = manager(memoryRoot, {
      clock: () => now,
      retryBaseMs: 10,
      retryMaxMs: 1_000,
      capture: async (input) => {
        if (input.runId === "far-future-retry") {
          farAttempts += 1;
          throw new Error("provider unavailable");
        }
        earlierAttempts += 1;
        if (earlierAttempts === 1) throw new Error("retry once");
        return "captured";
      },
    });
    try {
      intake.admit(turn({ runId: "far-future-retry" }));
      await intake.flush();
      now = new Date(now.getTime() + 10);
      await intake.flush();
      now = new Date(now.getTime() + 20);
      await intake.flush();
      expect(farAttempts).toBe(3); // the existing record now owns a +40ms wake

      intake.admit(turn({ runId: "earlier-retry", conversationId: "conversation-0002" }));
      await waitUntil(() => earlierAttempts === 1 && intake.snapshot().retrying === 0);

      // Do not flush or restart: only the replacement +10ms wake may retry it.
      now = new Date(now.getTime() + 10);
      await vi.advanceTimersByTimeAsync(10);
      await waitUntil(() => earlierAttempts === 2 && intake.snapshot().retrying === 0);

      expect(intake.snapshot()).toMatchObject({ pending: 1, resolved: 1, retrying: 0 });
      expect(farAttempts).toBe(3);
    } finally {
      intake.finishShutdown();
      vi.useRealTimers();
    }
  });

  it("retries a crash after summary persistence without duplicating the run-derived audit", async () => {
    const memoryRoot = root();
    const durableIds = new Set<string>();
    let calls = 0;
    const intake = manager(memoryRoot, {
      retryBaseMs: 1,
      writeSummary: async (_turn, id) => {
        calls += 1;
        durableIds.add(id);
      },
      afterSummaryPersisted: () => { throw new Error("crash after append"); },
    });
    intake.admit(turn());
    await intake.flush();
    intake.finishShutdown();
    expect(calls).toBe(1);
    expect(durableIds.size).toBe(1);

    const now = new Date(FIXED.getTime() + 1);
    const restarted = manager(memoryRoot, {
      clock: () => now,
      writeSummary: async (_turn, id) => {
        calls += 1;
        // The store callback uses this same run id to detect the already-appended bullet.
        durableIds.add(id);
      },
    });
    await restarted.flush();
    expect(calls).toBe(2);
    expect(durableIds.size).toBe(1);
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot.resolved).toBe(1);
    restarted.finishShutdown();
  });

  it("keeps every admitted record durable under worker pressure and rejects capacity explicitly", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, {
      maxActiveRecords: 3,
      capture: async () => await new Promise<never>(() => {}),
    });
    for (let index = 0; index < 3; index += 1) {
      intake.admit(turn({ runId: `run-${index}`, conversationId: `c-${index}` }));
    }
    expect(() => intake.admit(turn({ runId: "run-overflow" }))).toThrow(/full/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(3);
    intake.abortForShutdown(false);
  });

  it("prunes rich receipts while preserving permanent exact idempotency", async () => {
    const memoryRoot = root();
    let now = FIXED;
    const summaries = vi.fn(async () => {});
    const captures = vi.fn(async () => "captured" as const);
    const intake = manager(memoryRoot, {
      resolvedRetention: 2,
      clock: () => now,
      writeSummary: summaries,
      capture: captures,
    });
    const admissions = [];
    for (let index = 0; index < 3; index += 1) {
      admissions.push(intake.admit(turn({ runId: `retained-${index}` })));
      await intake.flush();
      now = new Date(now.getTime() + 1);
    }
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot.resolved).toBe(2);
    expect(intake.snapshot().resolved).toBe(2);
    expect(intake.admit(turn({ runId: "retained-2" }))).toMatchObject({ admissionStatus: "duplicate" });
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${admissions[0]!.id}.json`))).toBe(false);
    expect(intake.admit(turn({ runId: "retained-0" }))).toMatchObject({ admissionStatus: "duplicate" });
    await intake.flush();
    expect(summaries).toHaveBeenCalledTimes(3);
    expect(captures).toHaveBeenCalledTimes(3);
    intake.finishShutdown();
  });

  it("repairs a partial trailing ledger entry and backfills from durable state", async () => {
    const memoryRoot = root();
    const first = manager(memoryRoot);
    const admitted = first.admit(turn({ runId: "partial-ledger" }));
    await first.flush();
    first.finishShutdown();
    const ledgerPath = join(memoryRoot, ".capture-intake", "ledger", `${admitted.id.slice(0, 2)}.log`);
    appendFileSync(ledgerPath, admitted.id.slice(0, 19));

    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    const recovered = manager(memoryRoot);
    expect(readFileSync(ledgerPath, "utf8").length % 129).toBe(0);
    expect(recovered.admit(turn({ runId: "partial-ledger" }))).toMatchObject({ admissionStatus: "duplicate" });
    recovered.finishShutdown();
  });

  it("fails closed when a deleted shard held an already-pruned commitment", async () => {
    const memoryRoot = root();
    const captures = vi.fn(async () => "captured" as const);
    const intake = manager(memoryRoot, { resolvedRetention: 1, capture: captures });
    const firstInput = turn({ runId: "ledger-delete-pruned-a" });
    const first = intake.admit(firstInput);
    await intake.flush();
    const firstShard = first.id.slice(0, 2);
    const secondInput = turn({ runId: runIdInShard(firstShard, "ledger-delete-pruned-b") });
    const second = intake.admit(secondInput);
    await intake.flush();
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${first.id}.json`))).toBe(false);
    const firstLedger = join(memoryRoot, ".capture-intake", "ledger", `${firstShard}.log`);
    unlinkSync(firstLedger);
    const thirdRunId = runIdOutsideShard(firstShard, "ledger-delete-pruned-c");
    expect(() => intake.admit(turn({ runId: thirdRunId }))).toThrow(/shard is missing/iu);

    expect(existsSync(firstLedger)).toBe(false);
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${second.id}.json`))).toBe(true);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    expect(() => intake.admit(firstInput)).toThrow(/shard is missing/iu);
    expect(captures).toHaveBeenCalledTimes(2);
    intake.finishShutdown();
  });

  it("retires no rich receipt when a permanent commitment conflicts", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, { resolvedRetention: 1 });
    const firstInput = turn({ runId: "ledger-conflict-before-prune" });
    const first = intake.admit(firstInput);
    await intake.flush();
    const firstShard = first.id.slice(0, 2);
    const firstLedger = join(memoryRoot, ".capture-intake", "ledger", `${firstShard}.log`);
    writeFileSync(firstLedger, `${first.id}${"f".repeat(64)}\n`, { mode: 0o600 });
    const secondRunId = runIdOutsideShard(firstShard, "ledger-conflict-successor");
    const second = intake.admit(turn({ runId: secondRunId }));

    await intake.flush();

    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.resolved).toBe(2);
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${first.id}.json`))).toBe(true);
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${second.id}.json`))).toBe(true);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    expect(() => intake.admit(firstInput)).toThrow(/conflicts|integrity/iu);
    intake.finishShutdown();
  });

  it("rejects a valid-looking shard replacement that drops a pruned commitment", async () => {
    const memoryRoot = root();
    const captures = vi.fn(async () => "captured" as const);
    const intake = manager(memoryRoot, { resolvedRetention: 1, capture: captures });
    const firstInput = turn({ runId: "ledger-replacement-a" });
    const first = intake.admit(firstInput);
    await intake.flush();
    const shardName = first.id.slice(0, 2);
    const secondInput = turn({ runId: runIdInShard(shardName, "ledger-replacement-b") });
    const second = intake.admit(secondInput);
    await intake.flush();
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${first.id}.json`))).toBe(false);
    const secondReceipt = JSON.parse(readFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${second.id}.json`),
      "utf8",
    )) as { payloadHash: string };
    const shardPath = join(memoryRoot, ".capture-intake", "ledger", `${shardName}.log`);
    writeFileSync(shardPath, `${second.id}${secondReceipt.payloadHash}\n`, { mode: 0o600 });

    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    expect(() => intake.admit(firstInput)).toThrow(/truncated|integrity.*catalog/iu);
    expect(captures).toHaveBeenCalledTimes(2);
    intake.finishShutdown();
    expect(() => manager(memoryRoot)).toThrow(/truncated|integrity.*catalog/iu);
  });

  it("advances a lagging catalog only from exact materialized suffix receipts", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const first = intake.admit(turn({ runId: "catalog-lag-a" }));
    await intake.flush();
    const catalogPath = join(memoryRoot, ".capture-intake", "ledger-v1.catalog");
    const catalogBefore = readFileSync(catalogPath, "utf8");
    const secondInput = turn({ runId: runIdInShard(first.id.slice(0, 2), "catalog-lag-b") });
    intake.admit(secondInput);
    await intake.flush();
    writeFileSync(catalogPath, catalogBefore, { mode: 0o600 });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    intake.finishShutdown();

    const recovered = manager(memoryRoot);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(true);
    expect(recovered.admit(secondInput)).toMatchObject({ admissionStatus: "duplicate" });
    recovered.finishShutdown();
  });

  it("rejects a catalog-ahead recovery entry without a materialized receipt", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn({ runId: "unowned-suffix-base" }));
    await intake.flush();
    intake.finishShutdown();
    const shardName = admitted.id.slice(0, 2);
    const injectedRunId = runIdInShard(shardName, "unowned-suffix");
    const injectedId = createHash("sha256").update(injectedRunId).digest("hex");
    const injectedPayloadHash = createHash("sha256").update("not-materialized").digest("hex");
    appendFileSync(
      join(memoryRoot, ".capture-intake", "ledger", `${shardName}.log`),
      `${injectedId}${injectedPayloadHash}\n`,
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    expect(() => manager(memoryRoot)).toThrow(/no exact materialized receipt/iu);
  });

  it("initializes and backfills a pre-ledger intake tree from a still-materialized record", () => {
    const memoryRoot = root();
    const input = turn({ runId: "upgrade-backfill" });
    const id = writePreLedgerPending(memoryRoot, input);
    mkdirSync(join(memoryRoot, ".capture-intake", "ledger"), { mode: 0o700 });
    writeFileSync(join(memoryRoot, ".capture-intake", "ledger", "00.log"), "", { mode: 0o600 });
    const ledgerPath = join(memoryRoot, ".capture-intake", "ledger", `${id.slice(0, 2)}.log`);

    const upgraded = manager(memoryRoot);
    expect(upgraded.admit(input)).toMatchObject({ admissionStatus: "duplicate" });
    expect(existsSync(ledgerPath)).toBe(true);
    expect(existsSync(join(memoryRoot, ".capture-intake", "ledger-v1.catalog"))).toBe(true);
    expect(readdirSync(join(memoryRoot, ".capture-intake", "ledger"))).toContain(`${id.slice(0, 2)}.log`);
    upgraded.abortForShutdown(false);
  });

  it("rejects a missing external catalog once any historical commitment exists", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn({ runId: "missing-external-marker" }));
    await intake.flush();
    intake.finishShutdown();
    unlinkSync(join(memoryRoot, ".capture-intake", "ledger-v1.catalog"));

    expect(() => manager(memoryRoot)).toThrow(/lost.*catalog|missing.*catalog/iu);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
  });

  it("rejects whole-ledger deletion after an older commitment lost its rich receipt", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, { resolvedRetention: 1 });
    const first = intake.admit(turn({ runId: "whole-ledger-a" }));
    await intake.flush();
    const secondRunId = runIdInShard(first.id.slice(0, 2), "whole-ledger-b");
    intake.admit(turn({ runId: secondRunId }));
    await intake.flush();
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${first.id}.json`))).toBe(false);
    intake.finishShutdown();
    rmSync(join(memoryRoot, ".capture-intake", "ledger"), { recursive: true });

    expect(() => manager(memoryRoot)).toThrow(/shard is missing/iu);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
  });

  it("rejects combined ledger and catalog deletion after rich-receipt pruning", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot, { resolvedRetention: 1 });
    const first = intake.admit(turn({ runId: "delete-both-a" }));
    await intake.flush();
    intake.admit(turn({ runId: runIdInShard(first.id.slice(0, 2), "delete-both-b") }));
    await intake.flush();
    expect(existsSync(join(memoryRoot, ".capture-intake", "resolved", `${first.id}.json`))).toBe(false);
    intake.finishShutdown();
    rmSync(join(memoryRoot, ".capture-intake", "ledger"), { recursive: true });
    unlinkSync(join(memoryRoot, ".capture-intake", "ledger-v1.catalog"));

    expect(existsSync(join(memoryRoot, ".capture-intake-v1"))).toBe(true);
    expect(() => manager(memoryRoot)).toThrow(/initialized.*lost.*catalog/iu);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
  });

  it("rejects whole-intake deletion when the root schema marker proves prior initialization", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn({ runId: "whole-intake-delete" }));
    await intake.flush();
    intake.finishShutdown();
    rmSync(join(memoryRoot, ".capture-intake"), { recursive: true });

    expect(existsSync(join(memoryRoot, ".capture-intake-v1"))).toBe(true);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    expect(() => manager(memoryRoot)).toThrow(/initialized.*layout is missing/iu);
  });

  it("rejects deletion of the root-level schema marker after ledger history exists", async () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn({ runId: "missing-schema-marker" }));
    await intake.flush();
    intake.finishShutdown();
    unlinkSync(join(memoryRoot, ".capture-intake-v1"));

    expect(() => manager(memoryRoot)).toThrow(/nonempty.*missing.*schema marker/iu);
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
  });

  it("deduplicates independent manager admissions and rejects their payload conflict", () => {
    const memoryRoot = root();
    const blocked = async () => await new Promise<never>(() => {});
    const first = manager(memoryRoot, { capture: blocked });
    const second = manager(memoryRoot, { capture: blocked });

    expect(first.admit(turn({ runId: "multi-manager" })).admissionStatus).toBe("admitted");
    expect(second.admit(turn({ runId: "multi-manager" })).admissionStatus).toBe("duplicate");
    expect(() => second.admit(turn({ runId: "multi-manager", summary: "conflict" }))).toThrow(/conflicts/iu);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(1);
    first.abortForShutdown(false);
    second.abortForShutdown(false);
  });

  it("keeps normal admission and snapshots off unrelated historical ledger shards", () => {
    const memoryRoot = root();
    const blocked = async () => await new Promise<never>(() => {});
    const intake = manager(memoryRoot, { capture: blocked });
    const first = intake.admit(turn({ runId: "bounded-normal-path" }));
    const corruptShard = first.id.startsWith("aa") ? "bb" : "aa";
    writeFileSync(
      join(memoryRoot, ".capture-intake", "ledger", `${corruptShard}.log`),
      `${"f".repeat(128)}\n`,
      { mode: 0o600 },
    );
    let index = 0;
    let nextRunId: string;
    do {
      nextRunId = `bounded-normal-path-${index}`;
      index += 1;
    } while (createHash("sha256").update(nextRunId).digest("hex").startsWith(corruptShard));

    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(1);
    expect(intake.admit(turn({ runId: nextRunId }))).toMatchObject({ admissionStatus: "admitted" });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
    intake.abortForShutdown(false);
  });

  it.each(["corrupt", "permissions", "symlink", "hardlink"] as const)(
    "rejects an unsafe %s permanent ledger shard",
    (kind) => {
      const memoryRoot = root();
      const intake = manager(memoryRoot);
      const admitted = intake.admit(turn({ runId: `ledger-${kind}` }));
      intake.finishShutdown();
      const ledgerPath = join(memoryRoot, ".capture-intake", "ledger", `${admitted.id.slice(0, 2)}.log`);
      if (kind === "corrupt") writeFileSync(ledgerPath, `${"f".repeat(128)}\n`, { mode: 0o600 });
      if (kind === "permissions") chmodSync(ledgerPath, 0o644);
      if (kind === "hardlink") linkSync(ledgerPath, join(memoryRoot, "outside-ledger-hardlink"));
      if (kind === "symlink") {
        const target = join(memoryRoot, "outside-ledger");
        writeFileSync(target, readFileSync(ledgerPath), { mode: 0o600 });
        unlinkSync(ledgerPath);
        symlinkSync(target, ledgerPath);
      }

      expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
      expect(() => manager(memoryRoot)).toThrow(/ledger|canonical file/iu);
    },
  );

  it.each(["corrupt", "permissions", "symlink", "hardlink"] as const)(
    "rejects an unsafe %s permanent ledger catalog",
    (kind) => {
      const memoryRoot = root();
      const intake = manager(memoryRoot);
      intake.admit(turn({ runId: `catalog-${kind}` }));
      intake.finishShutdown();
      const catalogPath = join(memoryRoot, ".capture-intake", "ledger-v1.catalog");
      if (kind === "corrupt") writeFileSync(catalogPath, "valid-looking but incomplete\n", { mode: 0o600 });
      if (kind === "permissions") chmodSync(catalogPath, 0o644);
      if (kind === "hardlink") linkSync(catalogPath, join(memoryRoot, "outside-catalog-hardlink"));
      if (kind === "symlink") {
        const target = join(memoryRoot, "outside-catalog");
        writeFileSync(target, readFileSync(catalogPath), { mode: 0o600 });
        unlinkSync(catalogPath);
        symlinkSync(target, catalogPath);
      }

      expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
      expect(() => manager(memoryRoot)).toThrow(/catalog|canonical file|ledger/iu);
    },
  );

  it("retires an exact orphan catalog temp before writable startup", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn({ runId: "catalog-temp" }));
    intake.finishShutdown();
    const temp = join(
      memoryRoot,
      ".capture-intake",
      ".ledger-v1.catalog-00000000-0000-4000-8000-000000000000.tmp",
    );
    writeFileSync(temp, "partial catalog", { mode: 0o600 });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: false,
      counts: { pending: 1, temporary: 1 },
    });

    const recovered = manager(memoryRoot);
    expect(existsSync(temp)).toBe(false);
    expect(recovered.admit(turn({ runId: "catalog-temp" }))).toMatchObject({
      id: admitted.id,
      admissionStatus: "duplicate",
    });
    recovered.abortForShutdown(false);
  });

  it("moves exhausted work to dead, supports stopped-store retry, and resolves successfully", async () => {
    const memoryRoot = root();
    const first = manager(memoryRoot, {
      maxAttempts: 1,
      capture: async () => { throw new Error("offline"); },
    });
    const admitted = first.admit(turn());
    await first.flush();
    first.finishShutdown();
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, dead: 1 });

    expect(retryCompletedTurnIntake(memoryRoot, { id: admitted.id, now: FIXED })).toEqual({ retried: 1 });
    const restarted = manager(memoryRoot);
    await restarted.flush();
    restarted.finishShutdown();
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ dead: 0, resolved: 1 });
  });

  it("supports explicit stopped-store resolution without claiming capture", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();

    expect(resolveCompletedTurnIntake(memoryRoot, admitted.id, "operator_accepted", FIXED)).toEqual({ resolved: true });
    const receiptPath = join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      outcome: "operator_resolved",
      reason: "operator_accepted",
    });
    expect(readFileSync(receiptPath, "utf8")).not.toContain(turn().summary);
  });

  it("recovers a crash after resolved publication by keeping the higher transition revision", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();
    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "resolved",
        id: admitted.id,
        payloadHash: pending["payloadHash"],
        admittedAt: pending["admittedAt"],
        resolvedAt: FIXED.toISOString(),
        revision: 1,
        attempt: 0,
        outcome: "summary_only",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: true,
      inspection: { snapshot: { pending: 0, resolved: 1, transitioning: 1 } },
    });
    const recovered = manager(memoryRoot);
    expect(existsSync(admitted.source)).toBe(false);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    recovered.finishShutdown();
  });

  it("retires a lower pending transition before later pruning can expose it on restart", async () => {
    const memoryRoot = root();
    const captures: string[] = [];
    let firstId = "";
    let failRetirement = true;
    const first = manager(memoryRoot, {
      resolvedRetention: 1,
      capture: async (input) => {
        captures.push(input.runId);
        return "captured";
      },
      beforeStateSourceRetirement: (id, state) => {
        if (failRetirement && id === firstId && state === "resolved") {
          failRetirement = false;
          throw new Error("simulated source-retirement fault");
        }
      },
    });
    const firstTurn = turn({ runId: "transition-prune-a" });
    const admitted = first.admit(firstTurn);
    firstId = admitted.id;
    await first.flush();

    expect(captures.filter((runId) => runId === firstTurn.runId)).toHaveLength(1);
    expect(first.snapshot()).toMatchObject({ pending: 0, resolved: 1, transitioning: 1 });
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({
      pending: 0,
      resolved: 1,
      transitioning: 1,
    });

    const secondTurn = turn({ runId: "transition-prune-b" });
    first.admit(secondTurn);
    await first.flush();
    expect(first.snapshot()).toMatchObject({ pending: 0, resolved: 1, transitioning: 0 });
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({
      pending: 0,
      resolved: 1,
      transitioning: 0,
    });
    expect(existsSync(admitted.source)).toBe(false);
    first.finishShutdown();

    const restarted = manager(memoryRoot, {
      resolvedRetention: 1,
      capture: async (input) => {
        captures.push(input.runId);
        return "captured";
      },
    });
    expect(restarted.admit(firstTurn)).toMatchObject({ admissionStatus: "duplicate" });
    await restarted.flush();
    expect(captures.filter((runId) => runId === firstTurn.runId)).toHaveLength(1);
    expect(restarted.snapshot()).toMatchObject({ pending: 0, resolved: 1, transitioning: 0 });
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({
      pending: 0,
      resolved: 1,
      transitioning: 0,
    });
    restarted.finishShutdown();
  });

  it("recovers a crash after dead-letter retry publication by keeping the newer pending revision", async () => {
    const memoryRoot = root();
    const first = manager(memoryRoot, {
      maxAttempts: 1,
      capture: async () => { throw new Error("offline"); },
    });
    const admitted = first.admit(turn());
    await first.flush();
    first.finishShutdown();
    const deadPath = join(memoryRoot, ".capture-intake", "dead", `${admitted.id}.json`);
    const dead = JSON.parse(readFileSync(deadPath, "utf8")) as Record<string, unknown>;
    const pending = { ...dead };
    delete pending["deadAt"];
    delete pending["lastError"];
    Object.assign(pending, {
      state: "pending",
      revision: Number(dead["revision"]) + 1,
      attempt: 0,
      nextAttemptAt: FIXED.toISOString(),
    });
    writeFileSync(
      join(memoryRoot, ".capture-intake", "pending", `${admitted.id}.json`),
      `${JSON.stringify(pending, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: true,
      inspection: { snapshot: { pending: 1, dead: 0, transitioning: 1 } },
    });
    const recovered = manager(memoryRoot);
    expect(existsSync(deadPath)).toBe(false);
    await recovered.flush();
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, dead: 0, resolved: 1 });
    recovered.finishShutdown();
  });

  it("rejects ambiguous equal-revision state duplicates", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();
    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "resolved",
        id: admitted.id,
        payloadHash: pending["payloadHash"],
        admittedAt: pending["admittedAt"],
        resolvedAt: FIXED.toISOString(),
        revision: 0,
        attempt: 0,
        outcome: "summary_only",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(() => manager(memoryRoot)).toThrow(/equal revision/iu);
  });

  it("rejects a forged gapped transition revision", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    const admitted = intake.admit(turn());
    intake.finishShutdown();
    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(memoryRoot, ".capture-intake", "resolved", `${admitted.id}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "resolved",
        id: admitted.id,
        payloadHash: pending["payloadHash"],
        admittedAt: pending["admittedAt"],
        resolvedAt: FIXED.toISOString(),
        revision: 9,
        attempt: 0,
        outcome: "summary_only",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({ valid: false, issues: ["state_conflict"] });
    expect(() => manager(memoryRoot)).toThrow(/revision gap/iu);
  });

  it.each(["corrupt", "symlink", "hardlink", "oversize", "permissions"] as const)(
    "fails intake audit for %s durable state",
    (kind) => {
      const memoryRoot = root();
      const intake = manager(memoryRoot);
      const admitted = intake.admit(turn());
      intake.finishShutdown();
      if (kind === "corrupt") writeFileSync(admitted.source, "not json\n", { mode: 0o600 });
      if (kind === "oversize") writeFileSync(admitted.source, "x".repeat(700 * 1024), { mode: 0o600 });
      if (kind === "permissions") chmodSync(admitted.source, 0o644);
      if (kind === "symlink") {
        const target = join(memoryRoot, "outside.json");
        writeFileSync(target, "{}\n", { mode: 0o600 });
        unlinkSync(admitted.source);
        symlinkSync(target, admitted.source);
      }
      if (kind === "hardlink") linkSync(admitted.source, join(memoryRoot, "outside-hardlink.json"));

      expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
        valid: false,
        counts: { pending: 1 },
      });
    },
  );

  it("rejects a symlinked intake ancestor", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn());
    intake.finishShutdown();
    const pending = join(memoryRoot, ".capture-intake", "pending");
    const moved = join(memoryRoot, "moved-pending");
    renameSync(pending, moved);
    symlinkSync(moved, pending);

    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({ valid: false, issues: ["invalid_layout"] });
  });

  it("rejects unknown entries at the intake root", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn());
    intake.finishShutdown();
    writeFileSync(join(memoryRoot, ".capture-intake", "unexpected"), "x", { mode: 0o600 });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED).valid).toBe(false);
  });

  it("validates and retires an orphan atomic temp during writable startup", () => {
    const memoryRoot = root();
    const intake = manager(memoryRoot);
    intake.admit(turn());
    intake.finishShutdown();
    const temp = join(
      memoryRoot,
      ".capture-intake",
      "pending",
      ".0000000000000000000000000000000000000000000000000000000000000000.json-00000000-0000-4000-8000-000000000000.tmp",
    );
    writeFileSync(temp, '{"partial":', { mode: 0o600 });
    expect(auditCompletedTurnIntake(memoryRoot, FIXED)).toMatchObject({
      valid: false,
      counts: { pending: 1, temporary: 1 },
      issues: ["invalid_record"],
    });

    const recovered = manager(memoryRoot);
    expect(existsSync(temp)).toBe(false);
    recovered.finishShutdown();
  });
});

describe("BujoMemoryStore completed-turn integration", () => {
  it("rejects admission from read-only and closed stores", async () => {
    const memoryRoot = root();
    const writable = createBujoMemoryStore({ root: memoryRoot, clock: () => FIXED });
    await writable.close();
    await expect(writable.persistCompletedTurn(turn())).rejects.toThrow(/closing or closed/iu);

    const readOnly = createBujoMemoryStore({ root: memoryRoot, readOnly: true, clock: () => FIXED });
    await expect(readOnly.persistCompletedTurn(turn())).rejects.toThrow(/read-only/iu);
    await readOnly.close();
  });

  it("requires stopped-store ownership for retry and resolve operations", async () => {
    const memoryRoot = root();
    const store = createBujoMemoryStore({ root: memoryRoot, clock: () => FIXED });
    await expect(Promise.resolve().then(() => retryCompletedTurnIntake(memoryRoot))).rejects.toThrow(/active memory writer/iu);
    await store.close();
  });

  it.each(["lite", "journal", "bujo"] as const)(
    "persists a run-derived summary exactly once in the %s tier",
    async (tier) => {
      const memoryRoot = root();
      const llm = { id: "strict-empty", complete: async () => JSON.stringify({ memories: [], entities: [], relations: [] }) };
      const store = createBujoMemoryStore({
        root: memoryRoot,
        tier,
        clock: () => FIXED,
        ...(tier === "lite" ? {} : { embeddings: fakeEmbeddings(64), dim: 64 }),
        ...(tier === "bujo" ? { llm } : {}),
      });
      const input = tier === "bujo"
        ? turn({ runId: `run-${tier}` })
        : {
            runId: `run-${tier}`,
            conversationId: "conversation-0001",
            summary: "User prefers durable memory admission.",
          };
      const admitted = await store.persistCompletedTurn(input);
      await store.flush();
      const duplicate = await store.persistCompletedTurn(input);
      await store.flush();

      expect(admitted.admissionStatus).toBe("admitted");
      expect(duplicate.admissionStatus).toBe("duplicate");
      const directory = tier === "bujo" ? "audit" : "daily";
      const bullets = parseDailyFile(readFileSync(join(memoryRoot, directory, "2026-07-12.md"), "utf8")).bullets;
      expect(bullets.filter((bullet) => bullet.id === `R-${admitted.id}`)).toHaveLength(1);
      if (tier !== "bujo") {
        const hits = await store.recall("User prefers durable memory admission", { topK: 5 });
        expect(hits.some((hit) => hit.record.text.includes("durable memory admission"))).toBe(true);
      }
      expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
      await store.close();
    },
  );

  it("publishes admission immediately while coalescing ordinary transition snapshots", async () => {
    const memoryRoot = root();
    const store = createBujoMemoryStore({ root: memoryRoot, clock: () => FIXED });
    const runtime = store as unknown as {
      publishRuntimeSnapshot(state: "running" | "closed"): void;
    };
    const writes = vi.spyOn(runtime, "publishRuntimeSnapshot");

    await store.persistCompletedTurn({
      runId: "bounded-runtime-publications",
      conversationId: "conversation-0001",
      summary: "Runtime publication remains bounded.",
    });
    expect(writes).toHaveBeenCalledTimes(1);

    await store.flush();
    expect(writes).toHaveBeenCalledTimes(2);

    await store.close();
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it("drains an admitted Journal turn into its vector before immediate close", async () => {
    const memoryRoot = root();
    const base = fakeEmbeddings(64);
    let embeddedTexts = 0;
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "journal",
      dim: 64,
      embeddings: {
        ...base,
        embed: async (texts) => {
          embeddedTexts += texts.length;
          return await base.embed(texts);
        },
      },
      clock: () => FIXED,
    });

    await store.persistCompletedTurn({
      runId: "journal-immediate-close",
      conversationId: "conversation-0001",
      summary: "User prefers durable memory admission.",
    });
    await store.close();

    expect(embeddedTexts).toBe(1);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
  });

  it("bounds hung provider teardown and leaves the admitted turn pending for restart", async () => {
    const memoryRoot = root();
    const warnings: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: "hung",
        complete: async () => {
          await gate; // deliberately ignores the intake abort signal
          return JSON.stringify({ memories: [], entities: [], relations: [] });
        },
      },
      clock: () => FIXED,
      backgroundDrainTimeoutMs: 20,
      logger: { warn: (message) => warnings.push(message) },
    });
    const admission = await store.persistCompletedTurn(turn({ runId: "run-hung" }));
    await waitUntil(() => store.queueSnapshot().intake?.retrying === 1);
    const pendingBefore = readFileSync(admission.source, "utf8");

    const started = performance.now();
    await store.close();

    expect(performance.now() - started).toBeLessThan(500);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot.pending).toBe(1);
    expect(store.queueSnapshot().intake).toMatchObject({ pending: 1, shutdown: "timed_out" });
    expect(warnings.join(" ")).not.toContain(turn().captureText);
    release();
    await waitUntil(() => store.queueSnapshot().intake?.retrying === 0);
    expect(readFileSync(admission.source, "utf8")).toBe(pendingBefore);
  });

  it("keeps malformed strict output pending as a whole retry with sanitized health", async () => {
    const memoryRoot = root();
    const warnings: string[] = [];
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: "partial",
        complete: async () => JSON.stringify({
          memories: [
            { type: "note", text: "Valid-looking secret marker.", salience: 0.7, isInsight: false, entityIds: [] },
            { type: "note" },
          ],
          entities: [],
          relations: [],
        }),
      },
      clock: () => FIXED,
      logger: { warn: (message) => warnings.push(message) },
    });
    await store.persistCompletedTurn(turn({ runId: "strict-partial" }));
    await store.flush();

    const inspection = inspectCompletedTurnIntake(memoryRoot, FIXED);
    expect(inspection.snapshot).toMatchObject({ pending: 1, resolved: 0, due: 0 });
    expect(inspection.items[0]).toMatchObject({ attempt: 1, lastError: "model_output" });
    expect(warnings.join(" ")).not.toContain("Valid-looking secret marker");
    expect(existsSync(join(memoryRoot, "daily"))).toBe(false);
    await store.close();
  });

  it("does not duplicate the real audit bullet after a crash-window summary replay", async () => {
    const memoryRoot = root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: "crash-window",
        complete: async () => {
          await gate;
          return JSON.stringify({ memories: [], entities: [], relations: [] });
        },
      },
      clock: () => FIXED,
      backgroundDrainTimeoutMs: 20,
    });
    const admitted = await first.persistCompletedTurn(turn({ runId: "run-audit-crash-window" }));
    await waitUntil(() => first.queueSnapshot().intake?.retrying === 1);
    await first.close();
    release();
    await waitUntil(() => first.queueSnapshot().intake?.retrying === 0);

    const pending = JSON.parse(readFileSync(admitted.source, "utf8")) as Record<string, unknown>;
    pending["summaryWritten"] = false;
    pending["revision"] = 0;
    pending["attempt"] = 0;
    pending["nextAttemptAt"] = FIXED.toISOString();
    delete pending["lastError"];
    writeFileSync(admitted.source, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
    const auditPath = join(memoryRoot, "audit", "2026-07-12.md");
    expect(parseDailyFile(readFileSync(auditPath, "utf8")).bullets).toHaveLength(1);

    const restarted = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: { id: "crash-window", complete: async () => JSON.stringify({ memories: [], entities: [], relations: [] }) },
      clock: () => FIXED,
    });
    await restarted.flush();

    expect(parseDailyFile(readFileSync(auditPath, "utf8")).bullets).toHaveLength(1);
    expect(inspectCompletedTurnIntake(memoryRoot, FIXED).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    await restarted.close();
  });

  it("does not duplicate semantic capture after commit-before-resolution failure", async () => {
    const memoryRoot = root();
    let now = FIXED;
    let llmCalls = 0;
    const llm = {
      id: "semantic-crash-window",
      complete: async (prompt: string) => {
        llmCalls += 1;
        return prompt.includes("Extract one bounded") ? JSON.stringify({
            memories: [{
              type: "note",
              text: "Morgan prefers deterministic semantic replay.",
              salience: 0.8,
              isInsight: false,
              entityIds: [],
            }],
            entities: [],
            relations: [],
          })
          : JSON.stringify([{ index: 0, action: "add" }]);
      },
    };
    const store = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm,
      clock: () => now,
    });
    type CaptureCallback = (
      input: MemoryCompletedTurn,
      id: string,
      admittedAt: string,
      signal: AbortSignal,
    ) => Promise<"captured" | "summary_only">;
    const internal = store as unknown as {
      completedTurnIntake: { capture: CaptureCallback };
    };
    const original = internal.completedTurnIntake.capture.bind(internal.completedTurnIntake);
    internal.completedTurnIntake.capture = async (...args) => {
      const outcome = await original(...args);
      throw new Error(`simulated crash after ${outcome}`);
    };

    await store.persistCompletedTurn(turn({ runId: "semantic-commit-crash" }));
    await store.flush();
    const dailyPath = join(memoryRoot, "daily", "2026-07-12.md");
    const first = parseDailyFile(readFileSync(dailyPath, "utf8")).bullets;
    expect(first).toHaveLength(1);

    await store.close();
    now = new Date(FIXED.getTime() + 60_000);
    let restartLlmCalls = 0;
    const restarted = createBujoMemoryStore({
      root: memoryRoot,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: {
        id: llm.id,
        complete: async () => {
          restartLlmCalls += 1;
          throw new Error("retained plan replay must not call the model");
        },
      },
      clock: () => now,
    });
    await restarted.flush();

    const replayed = parseDailyFile(readFileSync(dailyPath, "utf8")).bullets;
    expect(replayed).toEqual(first);
    expect(llmCalls).toBe(1);
    expect(restartLlmCalls).toBe(0);
    expect(inspectCompletedTurnIntake(memoryRoot, now).snapshot).toMatchObject({ pending: 0, resolved: 1 });
    await restarted.close();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function runIdOutsideShard(shard: string, prefix: string): string {
  for (let index = 0; index < 10_000; index += 1) {
    const runId = `${prefix}-${index}`;
    if (!createHash("sha256").update(runId).digest("hex").startsWith(shard)) return runId;
  }
  throw new Error("could not derive a test run id outside the selected ledger shard");
}

function runIdInShard(shard: string, prefix: string): string {
  for (let index = 0; index < 100_000; index += 1) {
    const runId = `${prefix}-${index}`;
    if (createHash("sha256").update(runId).digest("hex").startsWith(shard)) return runId;
  }
  throw new Error("could not derive a test run id inside the selected ledger shard");
}

function writePreLedgerPending(memoryRoot: string, input: MemoryCompletedTurn): string {
  const payload = {
    runId: input.runId,
    conversationId: input.conversationId,
    summary: input.summary,
    ...(input.captureText === undefined ? {} : { captureText: input.captureText }),
  };
  const id = createHash("sha256").update(payload.runId).digest("hex");
  const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  for (const path of [
    join(memoryRoot, ".capture-intake"),
    join(memoryRoot, ".capture-intake", "pending"),
    join(memoryRoot, ".capture-intake", "dead"),
    join(memoryRoot, ".capture-intake", "resolved"),
  ]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(memoryRoot, ".capture-intake", "pending", `${id}.json`), `${JSON.stringify({
    schemaVersion: 1,
    state: "pending",
    id,
    payloadHash,
    ...payload,
    admittedAt: FIXED.toISOString(),
    revision: 0,
    attempt: 0,
    nextAttemptAt: FIXED.toISOString(),
    summaryWritten: false,
  }, null, 2)}\n`, { mode: 0o600 });
  return id;
}
