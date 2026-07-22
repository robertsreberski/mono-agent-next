import { chmod, link, mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openContinuationStore,
  type ContinuationOriginContextReference,
  type DurableContinuationRecord,
} from "../continuation-store.js";
import { loadLegacyStore } from "../continuation-store-records.js";
import { MAX_RECORD_BYTES } from "../continuation-store-types.js";
import { canonicalContinuationJson, continuationDigest } from "../continuations.js";

const fixtures: string[] = [];
const fixedNow = (): Date => new Date("2026-07-16T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("continuation origin-context record store", () => {
  it("does not create legacy records-v2 state for a fresh empty v3 store", async () => {
    const stateDir = fixture("fresh-empty");

    const first = await openContinuationStore(stateDir);
    await expect(first.stats()).resolves.toMatchObject({ format: "per-record-v3", records: 0 });
    expect(await readdir(stateDir)).not.toContain("records-v2");
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: false });

    await first.mutate(() => undefined);
    await first.activateOriginContextGroup({
      claimFingerprint: hash("no-op-activation"),
      activatedAt: "2026-07-14T12:01:00.000Z",
    });
    expect(await readdir(stateDir)).not.toContain("records-v2");

    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.stats()).resolves.toMatchObject({ format: "per-record-v3", records: 0 });
    expect(await readdir(stateDir)).not.toContain("records-v2");
  });

  it("cleans incomplete v3 temporaries without treating them as committed rollback evidence", async () => {
    const stateDir = fixture("fresh-temporary-cleanup");
    await openContinuationStore(stateDir);
    await writeFile(join(stateDir, "records-v3", ".orphan-record.tmp"), "incomplete\n", { mode: 0o600 });
    await writeFile(
      join(stateDir, "origin-context-groups-v1", ".orphan-activation.tmp"),
      "incomplete\n",
      { mode: 0o600 },
    );

    const restarted = await openContinuationStore(stateDir);

    await expect(restarted.stats()).resolves.toMatchObject({ records: 0 });
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
    expect(await readdir(join(stateDir, "origin-context-groups-v1"))).toEqual([]);
    expect(await readdir(stateDir)).not.toContain("records-v2");
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: false });
  });

  it("rejects unsafe linked v3 temporaries without installing the rollback guard", async () => {
    const stateDir = fixture("unsafe-temporary-cleanup");
    await openContinuationStore(stateDir);
    const activationSource = join(stateDir, "activation-temporary-source");
    const activationTemporary = join(stateDir, "origin-context-groups-v1", ".linked-activation.tmp");
    await writeFile(activationSource, "incomplete\n", { mode: 0o600 });
    await link(activationSource, activationTemporary);

    await expect(openContinuationStore(stateDir)).rejects.toThrow("exactly one filesystem link");
    expect(await readdir(stateDir)).not.toContain("records-v2");

    await rm(activationTemporary);
    await rm(activationSource);
    const recordSource = join(stateDir, "record-temporary-source");
    const recordTemporary = join(stateDir, "records-v3", ".linked-record.tmp");
    await writeFile(recordSource, "incomplete\n", { mode: 0o600 });
    await link(recordSource, recordTemporary);

    await expect(openContinuationStore(stateDir)).rejects.toThrow("exactly one filesystem link");
    expect(await readdir(stateDir)).not.toContain("records-v2");
  });

  it("installs the rollback guard lazily before the first v3 record", async () => {
    const stateDir = fixture("lazy-guard");
    const store = await openContinuationStore(stateDir);
    expect(await readdir(stateDir)).not.toContain("records-v2");

    await store.mutate((records) => {
      records.set("first-record", durableRecord("first-record", {
        originContextState: "legacy_missing",
        synthesisDeferrals: 0,
      }) as unknown as DurableContinuationRecord);
    });

    await expect(readFile(
      join(stateDir, "records-v2", "UPGRADED-TO-RECORDS-V3"),
      "utf8",
    )).resolves.toBe(
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
    );
    expect(await readdir(join(stateDir, "records-v3"))).toHaveLength(1);
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: true });
    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get("first-record")).resolves.toMatchObject({
      continuationId: "first-record",
      originContextState: "legacy_missing",
    });
  });

  it("recovers and migrates an interrupted v2 write while an existing v3 store was still empty", async () => {
    const stateDir = fixture("empty-v3-rollback");
    await openContinuationStore(stateDir);
    expect(await readdir(stateDir)).not.toContain("records-v2");

    const legacy = durableRecord("rolled-back-record", {
      historyBoundary: "run-rolled-back-record",
    });
    await writeFile(join(stateDir, "continuation-transaction-v2.json"), `${JSON.stringify({
      schemaVersion: 2,
      generation: "rolled-back-generation",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [legacy],
      deletes: [],
    }, null, 2)}\n`, { mode: 0o600 });

    const reopened = await openContinuationStore(stateDir);
    await expect(reopened.get("rolled-back-record")).resolves.toMatchObject({
      continuationId: "rolled-back-record",
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    });
    await expect(stat(
      join(stateDir, "records-v2", "UPGRADED-TO-RECORDS-V3"),
    )).resolves.toBeDefined();
    expect(await readdir(join(stateDir, "records-v3"))).toHaveLength(1);
  });

  it("finishes a guarded partial rollback migration after a crash before manifest commit", async () => {
    const stateDir = fixture("guarded-partial-migration");
    await openContinuationStore(stateDir);
    const legacyRecordsDir = join(stateDir, "records-v2");
    const firstLegacy = durableRecord("guarded-first", {
      historyBoundary: "run-guarded-first",
    });
    const secondLegacy = durableRecord("guarded-second", {
      historyBoundary: "run-guarded-second",
    });
    await writeRecord(legacyRecordsDir, firstLegacy);
    await writeRecord(legacyRecordsDir, secondLegacy);
    await writeRecord(join(stateDir, "records-v3"), {
      ...firstLegacy,
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    });
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );

    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get("guarded-first")).resolves.toMatchObject({
      continuationId: "guarded-first",
      originContextState: "legacy_missing",
    });
    await expect(restarted.get("guarded-second")).resolves.toMatchObject({
      continuationId: "guarded-second",
      originContextState: "legacy_missing",
    });
    expect(await readdir(join(stateDir, "records-v3"))).toHaveLength(2);
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: true });
  });

  it("rejects unsafe activation temporary debris before fencing a legacy migration", async () => {
    const stateDir = fixture("legacy-unsafe-activation-temporary");
    const groupsDir = join(stateDir, "origin-context-groups-v1");
    await mkdir(groupsDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await writeFile(join(stateDir, "continuations-v1.json"), JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: { legacy: durableRecord("legacy") },
    }), { mode: 0o600 });
    const source = join(stateDir, "activation-temporary-source");
    const temporary = join(groupsDir, ".linked-activation.tmp");
    await writeFile(source, "incomplete\n", { mode: 0o600 });
    await link(source, temporary);

    await expect(openContinuationStore(stateDir)).rejects.toThrow("exactly one filesystem link");
    await expect(stat(join(stateDir, "records-v2"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
    await expect(stat(join(stateDir, "continuation-store-v3.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits normalized migration before retained-terminal and activation projections", async () => {
    const stateDir = fixture("migration-phase-barrier");
    await openContinuationStore(stateDir, { now: fixedNow });
    const legacyRecordsDir = join(stateDir, "records-v2");
    const reference = {
      schemaVersion: 1 as const,
      digest: hash("migration-phase-snapshot"),
      bytes: 128,
      messageCount: 2,
    };
    const active = preparedRecord("migration-active", reference);
    const terminal = durableRecord("migration-terminal", {
      historyBoundary: "run-migration-terminal",
      state: "delivered",
      resultPayload: { retained: true },
      synthesizedText: "retained answer",
    });
    await writeRecord(legacyRecordsDir, active as unknown as Record<string, unknown>);
    await writeRecord(legacyRecordsDir, terminal);
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );

    const groupIdentity = {
      originRunId: active.originRunId,
      originConversationId: active.originConversationId,
      historyBoundary: active.historyBoundary as string,
    };
    const groupKey = continuationDigest(
      `mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`,
    );
    await writeFile(
      join(stateDir, "origin-context-groups-v1", `${groupKey}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        groupKey,
        ...groupIdentity,
        snapshotDigest: reference.digest,
        memberCount: 2,
        memberSetDigest: hash("intentionally-wrong-member-set"),
        activatedAt: "2026-07-14T12:01:00.000Z",
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    await expect(openContinuationStore(stateDir, {
      retention: { terminalMaxRecords: 1 },
      now: fixedNow,
    })).rejects.toThrow("member set does not match durable records");

    const materializedActive = JSON.parse(await readFile(
      join(stateDir, "records-v3", recordFileName("migration-active")),
      "utf8",
    )) as Record<string, unknown>;
    const materializedTerminal = JSON.parse(await readFile(
      join(stateDir, "records-v3", recordFileName("migration-terminal")),
      "utf8",
    )) as Record<string, unknown>;
    expect(materializedActive).toMatchObject({
      continuationId: "migration-active",
      originContextState: "pending",
      synthesisDeferrals: 0,
    });
    expect(materializedTerminal).toMatchObject({
      continuationId: "migration-terminal",
      resultPayload: { retained: true },
      synthesizedText: "retained answer",
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    });
    expect(materializedTerminal).not.toHaveProperty("compactedAt");
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: true });

    await rm(join(stateDir, "origin-context-groups-v1", `${groupKey}.json`));
    const restarted = await openContinuationStore(stateDir, {
      retention: { terminalMaxRecords: 1 },
      now: fixedNow,
    });
    await expect(restarted.get("migration-active")).resolves.toMatchObject({
      originContextState: "pending",
    });
    await expect(restarted.get("migration-terminal")).resolves.toMatchObject({
      state: "delivered",
      compactedAt: expect.any(String),
    });
    await expect(restarted.get("migration-terminal")).resolves.not.toHaveProperty("resultPayload");

    const reopened = await openContinuationStore(stateDir, {
      retention: { terminalMaxRecords: 1 },
      now: fixedNow,
    });
    await expect(reopened.list()).resolves.toHaveLength(2);
  });

  it("replays a valid v2 transaction even when an interrupted migration already installed the guard", async () => {
    const stateDir = fixture("guarded-v2-transaction");
    await openContinuationStore(stateDir);
    const legacyRecordsDir = join(stateDir, "records-v2");
    await mkdir(legacyRecordsDir, { mode: 0o700 });
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
    const admitted = durableRecord("guarded-transaction-record", {
      historyBoundary: "run-guarded-transaction-record",
    });
    await writeFile(join(stateDir, "continuation-transaction-v2.json"), `${JSON.stringify({
      schemaVersion: 2,
      generation: "guarded-v2-generation",
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [admitted],
      deletes: [],
    }, null, 2)}\n`, { mode: 0o600 });

    const migrated = await openContinuationStore(stateDir);
    await expect(migrated.get("guarded-transaction-record")).resolves.toMatchObject({
      continuationId: "guarded-transaction-record",
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    });
    await expect(stat(join(stateDir, "continuation-transaction-v2.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a malformed v2 transaction after an interrupted migration installed the guard", async () => {
    const stateDir = fixture("guarded-malformed-v2-transaction");
    await openContinuationStore(stateDir);
    const legacyRecordsDir = join(stateDir, "records-v2");
    await mkdir(legacyRecordsDir, { mode: 0o700 });
    await writeFile(
      join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
      { mode: 0o600 },
    );
    const transactionPath = join(stateDir, "continuation-transaction-v2.json");
    await writeFile(transactionPath, "{}\n", { mode: 0o600 });

    await expect(openContinuationStore(stateDir)).rejects.toThrow("malformed schema");
    await expect(stat(transactionPath)).resolves.toBeDefined();
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: false });
  });

  it("rejects an oversized transaction generation before replay can publish an unreadable manifest", async () => {
    const stateDir = fixture("oversized-v3-generation");
    await mkdir(stateDir, { mode: 0o700 });
    const transactionPath = join(stateDir, "continuation-transaction-v3.json");
    await writeFile(transactionPath, JSON.stringify({
      schemaVersion: 3,
      generation: "g".repeat((1024 * 1024) + 1),
      createdAt: "2026-07-14T12:00:00.000Z",
      writes: [],
      deletes: [],
    }), { mode: 0o600 });

    await expect(openContinuationStore(stateDir)).rejects.toThrow("malformed schema");
    await expect(stat(transactionPath)).resolves.toBeDefined();
    await expect(stat(join(stateDir, "continuation-store-v3.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
  });

  it("does not complete migration when a legacy record exceeds the v3 per-record safety limit", async () => {
    const stateDir = fixture("oversized-legacy-record");
    await openContinuationStore(stateDir);
    const oversized = durableRecord("oversized-legacy", {
      historyBoundary: "run-oversized-legacy",
      state: "delivered",
      resultPayload: "x".repeat((2 * 1024 * 1024) + 1),
    });
    await writeRecord(join(stateDir, "records-v2"), oversized);

    await expect(openContinuationStore(stateDir)).rejects.toThrow("exceeds its 2097152 byte safety limit");
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: false });
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
  });

  it("rejects an oversized record embedded in the v1 monolith before migration completion", async () => {
    const stateDir = fixture("oversized-v1-record");
    await openContinuationStore(stateDir);
    const oversized = durableRecord("oversized-v1", {
      historyBoundary: "run-oversized-v1",
      state: "delivered",
      resultPayload: "x".repeat((2 * 1024 * 1024) + 1),
    });
    await writeFile(join(stateDir, "continuations-v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: { "oversized-v1": oversized },
    })}\n`, { mode: 0o600 });

    await expect(openContinuationStore(stateDir, { now: fixedNow })).rejects.toThrow(
      "Continuation legacy record exceeds its 2097152 byte safety limit: oversized-v1",
    );
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: false });
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
  });

  it("rejects a legacy record that crosses the v3 limit only after default normalization", async () => {
    const stateDir = fixture("normalization-oversized-v1-record");
    await openContinuationStore(stateDir);
    const record = durableRecord("normalization-oversized-v1", {
      historyBoundary: "run-normalization-oversized-v1",
      resultPayload: "",
    });
    const emptyPayloadBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    record.resultPayload = "x".repeat(MAX_RECORD_BYTES - emptyPayloadBytes);
    expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8")).toBe(MAX_RECORD_BYTES);
    await writeFile(join(stateDir, "continuations-v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: { "normalization-oversized-v1": record },
    })}\n`, { mode: 0o600 });

    await expect(openContinuationStore(stateDir)).rejects.toThrow(
      "Continuation normalized record exceeds its 2097152 byte safety limit: normalization-oversized-v1",
    );
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: false });
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
  });

  it("preflights retained tombstone growth before fencing or materializing legacy state", async () => {
    const stateDir = fixture("retention-growth-preflight");
    await mkdir(stateDir, { mode: 0o700 });
    const record = durableRecord("retention-growth", {
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
      state: "delivered",
      lastError: {
        code: "retained_terminal",
        reason: "",
        at: "2026-07-14T12:00:00.000Z",
      },
    });
    const emptyReasonBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    (record.lastError as Record<string, unknown>).reason = "x".repeat(MAX_RECORD_BYTES - emptyReasonBytes);
    expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8")).toBe(MAX_RECORD_BYTES);
    await writeFile(join(stateDir, "continuations-v1.json"), JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-14T12:00:00.000Z",
      records: { "retention-growth": record },
    }), { mode: 0o600 });

    await expect(openContinuationStore(stateDir, { now: fixedNow })).rejects.toThrow(
      "Continuation retained record exceeds its 2097152 byte safety limit: retention-growth",
    );
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
    await expect(stat(join(stateDir, "records-v2"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(stateDir, "continuation-store-v3.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized legacy monolith before allocating or publishing migrated state", async () => {
    const legacyPath = fixture("oversized-legacy-monolith");
    await writeFile(legacyPath, "{}\n", { mode: 0o600 });
    await truncate(legacyPath, (256 * 1024 * 1024) + 1);

    await expect(loadLegacyStore(legacyPath)).rejects.toThrow("268435456 byte safety limit");
  });

  it("does not reinterpret a disappearing v1 monolith as an empty legacy store", async () => {
    const missingLegacyPath = fixture("missing-legacy-monolith");

    await expect(loadLegacyStore(missingLegacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a fieldless v3 manifest as permanently fenced and never reopens stale legacy records", async () => {
    const stateDir = fixture("fieldless-manifest");
    const first = await openContinuationStore(stateDir);
    await first.mutate((records) => {
      records.set("native-v3", durableRecord("native-v3", {
        originContextState: "legacy_missing",
        synthesisDeferrals: 0,
      }) as unknown as DurableContinuationRecord);
    });
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.rollbackGuardRequired;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await writeRecord(join(stateDir, "records-v2"), durableRecord("stale-legacy", {
      historyBoundary: "run-stale-legacy",
    }));

    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get("native-v3")).resolves.toBeDefined();
    await expect(restarted.get("stale-legacy")).resolves.toBeUndefined();
    await expect(readFile(manifestPath, "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: true });
  });

  it("does not reopen legacy migration after retention removes every migrated record", async () => {
    const stateDir = fixture("retained-empty-migration");
    await openContinuationStore(stateDir);
    await writeRecord(join(stateDir, "records-v2"), durableRecord("expired-legacy", {
      historyBoundary: "run-expired-legacy",
      state: "expired",
    }));

    const migrated = await openContinuationStore(stateDir, {
      retention: { terminalMaxRecords: 0 },
    });
    await expect(migrated.stats()).resolves.toMatchObject({ records: 0 });
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: true });

    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get("expired-legacy")).resolves.toBeUndefined();
    await expect(restarted.stats()).resolves.toMatchObject({ records: 0 });
  });

  it("fails before publishing a first v3 record when the lazy guard cannot be created", async () => {
    const stateDir = fixture("guard-failure");
    const store = await openContinuationStore(stateDir);
    const legacyRecordsPath = join(stateDir, "records-v2");
    await writeFile(legacyRecordsPath, "not a directory\n", { mode: 0o600 });

    await expect(store.mutate((records) => {
      records.set("must-not-commit", durableRecord("must-not-commit", {
        originContextState: "legacy_missing",
        synthesisDeferrals: 0,
      }) as unknown as DurableContinuationRecord);
    })).rejects.toThrow();
    expect(await readdir(join(stateDir, "records-v3"))).toEqual([]);
    await expect(stat(join(stateDir, "continuation-transaction-v3.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await rm(legacyRecordsPath);
    const restarted = await openContinuationStore(stateDir);
    expect(await readdir(stateDir)).not.toContain("records-v2");
  });

  it("serializes concurrent first record commit and origin activation behind one rollback fence", async () => {
    const stateDir = fixture("concurrent-first-commit");
    const store = await openContinuationStore(stateDir);
    const snapshot = originContext("run-group", "slack:D1:1.1#2026-07-14");
    const pin = await store.stageOriginContext(snapshot);
    let releaseMutation!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => { releaseMutation = resolve; });
    let mutatorEntered!: () => void;
    const entered = new Promise<void>((resolve) => { mutatorEntered = resolve; });
    const mutation = store.mutate(async (records) => {
      mutatorEntered();
      await mutationBlocked;
      records.set("concurrent-first", preparedRecord("concurrent-first", pin.reference));
    });
    await entered;
    const activation = store.activateOriginContextGroup({
      claimFingerprint: hash("fingerprint-concurrent-first"),
      activatedAt: "2026-07-14T12:01:00.000Z",
    });
    releaseMutation();
    await Promise.all([mutation, activation]);
    await pin.release();

    await expect(store.get("concurrent-first")).resolves.toMatchObject({ originContextState: "pinned" });
    await expect(readFile(join(stateDir, "continuation-store-v3.json"), "utf8")
      .then((value) => JSON.parse(value) as Record<string, unknown>))
      .resolves.toMatchObject({ rollbackGuardRequired: true });
    await expect(readFile(
      join(stateDir, "records-v2", "UPGRADED-TO-RECORDS-V3"),
      "utf8",
    )).resolves.toBe(
      "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n",
    );
    expect(await readdir(join(stateDir, "origin-context-groups-v1"))).toEqual([]);
    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get("concurrent-first")).resolves.toMatchObject({ originContextState: "pinned" });
  });

  it("preflights activation size before publishing an unrecoverable group marker", async () => {
    const stateDir = fixture("activation-size-preflight");
    const store = await openContinuationStore(stateDir);
    const snapshot = originContext("run-activation-size", "slack:D1:1.1#2026-07-14");
    const pin = await store.stageOriginContext(snapshot);
    const record = preparedRecord("activation-size-record", pin.reference, {
      originRunId: "run-activation-size",
      historyBoundary: "run-activation-size",
      updatedAt: "2026-01-01",
      resultPayload: "",
    });
    const emptyPayloadBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    record.resultPayload = "x".repeat(MAX_RECORD_BYTES - emptyPayloadBytes);
    expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8")).toBe(MAX_RECORD_BYTES);
    await store.mutate((records) => records.set(record.continuationId, record));
    await pin.release();

    await expect(store.activateOriginContextGroup({
      claimFingerprint: record.claimFingerprint,
      activatedAt: "2026-07-14T12:01:00.000Z",
    })).rejects.toThrow(
      "Continuation activated record exceeds its 2097152 byte safety limit: activation-size-record",
    );
    expect(await readdir(join(stateDir, "origin-context-groups-v1"))).toEqual([]);
    await expect(store.get(record.continuationId)).resolves.toMatchObject({ originContextState: "pending" });

    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get(record.continuationId)).resolves.toMatchObject({ originContextState: "pending" });
  });

  it("retains a shared staged blob until every concurrent pin is released", async () => {
    const stateDir = fixture("shared-pin");
    const store = await openContinuationStore(stateDir);
    const snapshot = originContext("run-shared", "slack:D1:1.1#2026-07-14");
    const first = await store.stageOriginContext(snapshot);
    const second = await store.stageOriginContext(snapshot);

    // The first capability can fail before publishing a record while another
    // capability still owns the same content-addressed staging lease.
    await first.release();
    await expect(store.loadOriginContext(second.reference)).resolves.toEqual(snapshot);

    await store.mutate((records) => {
      records.set("shared-pin-record", preparedRecord("shared-pin-record", second.reference));
    });
    await second.release();
    await expect(store.loadOriginContext(second.reference)).resolves.toEqual(snapshot);
  });

  it("normalizes both sides of an interrupted v2-to-v3 migration and installs a fail-closed rollback guard", async () => {
    const stateDir = fixture("normalized-migration");
    const legacy = durableRecord("migration-record", {
      historyBoundary: "run-migration-record",
    });
    const normalized = {
      ...legacy,
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    };
    await writeRecord(join(stateDir, "records-v2"), legacy);
    await writeRecord(join(stateDir, "records-v3"), normalized);

    const first = await openContinuationStore(stateDir);
    await expect(first.get("migration-record")).resolves.toMatchObject({
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    });
    expect(await readdir(join(stateDir, "records-v2"))).toContain("UPGRADED-TO-RECORDS-V3");
    expect(await readdir(join(stateDir, "records-v3"))).toHaveLength(1);
    await expect(stat(join(stateDir, "continuation-store-v3.json"))).resolves.toBeDefined();

    // A second open proves that the crash-restart path no longer compares the
    // persisted defaults against the semantically equivalent omitted fields.
    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.get("migration-record")).resolves.toMatchObject({
      originContextState: "legacy_missing",
      synthesisDeferrals: 0,
    });
    const preservedV2 = JSON.parse(await readFile(
      join(stateDir, "records-v2", recordFileName("migration-record")),
      "utf8",
    )) as Record<string, unknown>;
    expect(preservedV2).not.toHaveProperty("originContextState");
  });

  it("does not let an unsafe referenced origin blob poison startup or escape the unavailable fallback", async () => {
    const stateDir = fixture("unsafe-blob");
    const store = await openContinuationStore(stateDir);
    const snapshot = originContext("run-unsafe", "slack:D1:1.1#2026-07-14");
    const pin = await store.stageOriginContext(snapshot);
    const aliasReference = { ...pin.reference, digest: "f".repeat(64) } as ContinuationOriginContextReference;
    await store.mutate((records) => {
      records.set("unsafe-record", preparedRecord("unsafe-record", pin.reference, { originContextState: "pinned" }));
      records.set("unsafe-alias", preparedRecord("unsafe-alias", aliasReference, { originContextState: "pinned" }));
    });
    await pin.release();

    const blob = join(stateDir, "origin-context-v1", `${pin.reference.digest}.json`);
    const secondLink = join(stateDir, "origin-context-v1", `${aliasReference.digest}.json`);
    await link(blob, secondLink);
    expect((await stat(blob)).nlink).toBe(2);

    const restarted = await openContinuationStore(stateDir);
    await expect(restarted.loadOriginContext(pin.reference)).resolves.toBeUndefined();
    await expect(restarted.get("unsafe-record")).resolves.toMatchObject({
      originContextState: "pinned",
      originContextDigest: pin.reference.digest,
    });
  });

  it("publishes a group through one compact commit point and recovers before materialization", async () => {
    const stateDir = fixture("group-commit");
    const store = await openContinuationStore(stateDir);
    const snapshot = originContext("run-group", "slack:D1:1.1#2026-07-14");
    const pin = await store.stageOriginContext(snapshot);
    const padding = "x".repeat(900_000);
    const count = 20;
    await store.mutate((records) => {
      for (let index = 0; index < count; index += 1) {
        const id = `group-${String(index).padStart(2, "0")}`;
        records.set(id, preparedRecord(id, pin.reference, {
          resultPayload: { padding },
          claimFingerprint: hash(`claim-${id}`),
        }));
      }
      records.set("group-expired", durableRecord("group-expired", {
        originRunId: "run-group",
        originConversationId: "slack:D1:1.1#2026-07-14",
        historyBoundary: "run-group",
        originContextState: "abandoned",
        synthesisDeferrals: 0,
        state: "expired",
      }) as unknown as DurableContinuationRecord);
    });
    await pin.release();

    // Prevent record materialization after the group marker fsync. The public
    // method still succeeds because activation is already durably committed.
    const recordsDir = join(stateDir, "records-v3");
    if (process.platform !== "win32") await chmod(recordsDir, 0o500);
    try {
      await store.activateOriginContextGroup({
        claimFingerprint: hash("claim-group-00"),
        activatedAt: "2026-07-14T12:01:00.000Z",
      });
    } finally {
      if (process.platform !== "win32") await chmod(recordsDir, 0o700);
    }
    expect((await store.list()).filter((record) => record.state !== "expired")
      .every((record) => record.originContextState === "pinned")).toBe(true);
    const [marker] = await readdir(join(stateDir, "origin-context-groups-v1"));
    expect(marker).toBeDefined();
    expect((await stat(join(stateDir, "origin-context-groups-v1", marker as string))).size).toBeLessThan(64 * 1024);

    // Simulate a process restart. Recovery replays any interrupted bounded
    // transaction, projects the one marker over the whole >16 MiB member set,
    // materializes the remainder, then removes the marker.
    const restarted = await openContinuationStore(stateDir);
    const recovered = await restarted.list();
    expect(recovered).toHaveLength(count + 1);
    expect(recovered.filter((record) => record.state !== "expired")
      .every((record) => record.originContextState === "pinned")).toBe(true);
    expect(recovered.find((record) => record.continuationId === "group-expired")).toMatchObject({
      state: "expired",
      originContextState: "abandoned",
    });
    expect(await readdir(join(stateDir, "origin-context-groups-v1"))).toEqual([]);
  }, 30_000);
});

function fixture(label: string): string {
  const path = join(tmpdir(), `mono-agent-origin-store-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fixtures.push(path);
  return path;
}

async function writeRecord(directory: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(
    join(directory, recordFileName(String(record.continuationId))),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function recordFileName(id: string): string {
  return `${continuationDigest(id)}.json`;
}

function originContext(runId: string, conversationId: string) {
  const capturedAt = "2026-07-14T12:00:00.000Z";
  return {
    schemaVersion: 1 as const,
    conversationId,
    originRunId: runId,
    historyBoundary: runId,
    capturedAt,
    messages: [
      { role: "user" as const, content: "Delegate the durable task.", timestamp: capturedAt, runId },
      { role: "assistant" as const, content: "I will return with the result.", timestamp: capturedAt, runId },
    ],
  };
}

function preparedRecord(
  id: string,
  reference: ContinuationOriginContextReference,
  overrides: Partial<DurableContinuationRecord> = {},
): DurableContinuationRecord {
  return durableRecord(id, {
    originRunId: "run-group",
    originConversationId: "slack:D1:1.1#2026-07-14",
    replyToConversationId: "slack:D1:1.1",
    historyBoundary: "run-group",
    originContextState: "pending",
    originContextRef: reference,
    originContextDigest: reference.digest,
    originContextMessageCount: reference.messageCount,
    originContextFingerprint: hash(`origin-${id}`),
    originContextBindingMac: hash(`mac-${id}`),
    synthesisDeferrals: 0,
    ...overrides,
  }) as unknown as DurableContinuationRecord;
}

function durableRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = "2026-07-14T12:00:00.000Z";
  return {
    continuationId: id,
    serverName: "a8c-control",
    originRunId: `run-${id}`,
    originConversationId: "slack:D1:1.1",
    replyToConversationId: "slack:D1:1.1",
    mode: "reply",
    taskKey: `task-${id}`,
    taskHash: hash(`task-${id}`),
    claimFingerprint: hash(`fingerprint-${id}`),
    resultTokenHash: hash(`token-${id}`),
    createdAt: now,
    updatedAt: now,
    deadline: "2026-07-14T13:00:00.000Z",
    state: "claimed",
    synthesisAttempts: 0,
    deliveryAttempts: 0,
    ...overrides,
  };
}

function hash(value: string): string {
  return continuationDigest(value);
}
