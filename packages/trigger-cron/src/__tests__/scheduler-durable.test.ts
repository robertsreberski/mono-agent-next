// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { CronJob } from "../jobs.js";
import {
  createCronDurableScheduler,
  initialDurableRecord,
  type CronDurableStateCapability,
  type DurableJobRecord,
} from "../scheduler-durable.js";
import type { JobState } from "../scheduler-state.js";
import type { CronClock } from "../scheduler.js";

const NOW = "2026-07-23T08:00:00.000Z";
const LATER = "2026-07-23T08:01:00.000Z";
const LATEST = "2026-07-23T08:02:00.000Z";
const OWNER_ID = "00000000-0000-4000-8000-000000000000";
const IDEMPOTENCY_KEY = `cron:v1:${"a".repeat(64)}`;
const OTHER_IDEMPOTENCY_KEY = `cron:v1:${"b".repeat(64)}`;
const JOB: CronJob = {
  id: "heartbeat",
  expression: "* * * * *",
  timezone: "UTC",
  prompt: "check status",
  overlap: "skip",
  maxQueueDepth: 2,
  overflow: "drop-newest",
  maxRunMs: 20 * 60 * 1_000,
  source: "heartbeat.md",
};
const BASE_RECORD = initialDurableRecord(JOB, new Date(NOW));
const FULL_RECORD: DurableJobRecord = {
  ...BASE_RECORD,
  active: {
    ownerId: OWNER_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    scheduledAt: NOW,
    claimedAt: NOW,
  },
  lastOutcome: {
    status: "unknown",
    scheduledAt: NOW,
    idempotencyKey: OTHER_IDEMPOTENCY_KEY,
  },
  issue: {
    status: "rejected",
    observedAt: LATER,
    scheduledAt: NOW,
  },
  missed: {
    ranges: 1,
    atLeast: 1,
    from: NOW,
    through: LATER,
  },
  clockRegressions: 1,
  lastClockRegression: {
    from: LATEST,
    to: LATER,
  },
};
const EQUAL_MISSED_RANGE_RECORD: DurableJobRecord = {
  ...BASE_RECORD,
  missed: {
    ranges: 1,
    atLeast: 1,
    from: NOW,
    through: NOW,
  },
};

describe("cron durable scheduler decoder", () => {
  it("accepts the minimal canonical durable record through initialization", async () => {
    const boundary = durableBoundary(jsonBytes(BASE_RECORD));

    await expect(boundary.initialize()).resolves.toBeUndefined();
    expect(boundary.state.durable).toStrictEqual({
      record: BASE_RECORD,
      version: "v-hostile",
    });
    expect(boundary.writes).toBe(0);
  });

  it("accepts the complete canonical durable record through initialization", async () => {
    const boundary = durableBoundary(jsonBytes(FULL_RECORD));

    await expect(boundary.initialize()).resolves.toBeUndefined();
    expect(boundary.state.durable).toStrictEqual({
      record: FULL_RECORD,
      version: "v-hostile",
    });
    expect(boundary.writes).toBe(0);
  });

  it("accepts an equal missed-range boundary without inventing optional fields", async () => {
    const boundary = durableBoundary(jsonBytes(EQUAL_MISSED_RANGE_RECORD));

    await expect(boundary.initialize()).resolves.toBeUndefined();
    expect(boundary.state.durable).toStrictEqual({
      record: EQUAL_MISSED_RANGE_RECORD,
      version: "v-hostile",
    });
    expect(boundary.writes).toBe(0);
  });

  const malformed = [
    {
      name: "empty bytes",
      value: new Uint8Array(),
      error: /has an invalid size/u,
    },
    {
      name: "oversized bytes",
      value: new Uint8Array(16 * 1024 + 1),
      error: /has an invalid size/u,
    },
    {
      name: "invalid JSON at the exact byte ceiling",
      value: new Uint8Array(16 * 1024).fill(0x20),
      error: /is not valid JSON/u,
    },
    {
      name: "invalid UTF-8",
      value: Uint8Array.of(0x22, 0xc3, 0x28, 0x22),
      error: /is not valid UTF-8/u,
    },
    {
      name: "invalid JSON",
      value: Buffer.from("{", "utf8"),
      error: /is not valid JSON/u,
    },
    {
      name: "scalar JSON",
      value: jsonBytes(null),
      error: /must be an object/u,
    },
    {
      name: "array JSON",
      value: jsonBytes([]),
      error: /must be an object/u,
    },
    {
      name: "unknown top-level field",
      value: jsonBytes({ ...BASE_RECORD, untrusted: true }),
    },
    {
      name: "wrong schema",
      value: jsonBytes({ ...BASE_RECORD, schemaVersion: 2 }),
    },
    {
      name: "foreign job identity",
      value: jsonBytes({ ...BASE_RECORD, jobId: "foreign" }),
    },
    {
      name: "short schedule fingerprint",
      value: jsonBytes({ ...BASE_RECORD, scheduleFingerprint: "a".repeat(63) }),
    },
    {
      name: "empty schedule fingerprint",
      value: jsonBytes({ ...BASE_RECORD, scheduleFingerprint: "" }),
      error: /Cron durable scheduleFingerprint is invalid/u,
    },
    {
      name: "oversized schedule fingerprint",
      value: jsonBytes({ ...BASE_RECORD, scheduleFingerprint: "a".repeat(65) }),
      error: /Cron durable scheduleFingerprint is invalid/u,
    },
    {
      name: "uppercase schedule fingerprint",
      value: jsonBytes({ ...BASE_RECORD, scheduleFingerprint: "A".repeat(64) }),
    },
    {
      name: "schedule fingerprint with hostile prefix",
      value: jsonBytes({
        ...BASE_RECORD,
        scheduleFingerprint: `x${BASE_RECORD.scheduleFingerprint}`,
      }),
    },
    {
      name: "schedule fingerprint with hostile suffix",
      value: jsonBytes({
        ...BASE_RECORD,
        scheduleFingerprint: `${BASE_RECORD.scheduleFingerprint}x`,
      }),
    },
    {
      name: "array-valued schedule fingerprint",
      value: jsonBytes({ ...BASE_RECORD, scheduleFingerprint: [BASE_RECORD.scheduleFingerprint] }),
    },
    {
      name: "noncanonical watermark",
      value: jsonBytes({ ...BASE_RECORD, watermark: "2026-07-23T08:00:00Z" }),
    },
    {
      name: "negative clock-regression count",
      value: jsonBytes({ ...BASE_RECORD, clockRegressions: -1 }),
    },
    {
      name: "fractional clock-regression count",
      value: jsonBytes({ ...BASE_RECORD, clockRegressions: 0.5 }),
    },
    {
      name: "non-object active fence",
      value: jsonBytes({ ...BASE_RECORD, active: "active" }),
    },
    {
      name: "active fence with unknown field",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: NOW,
          claimedAt: NOW,
          untrusted: true,
        },
      }),
    },
    {
      name: "invalid active owner",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: "not-an-owner",
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "active owner with hostile prefix",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: `x${OWNER_ID}`,
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "active owner with hostile suffix",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: `${OWNER_ID}x`,
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "array-valued active owner",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: [OWNER_ID],
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "invalid active idempotency key",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: "cron:v1:wrong",
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "active idempotency key with hostile prefix",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: `x${IDEMPOTENCY_KEY}`,
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "active idempotency key with hostile suffix",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: `${IDEMPOTENCY_KEY}x`,
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "array-valued active idempotency key",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: [IDEMPOTENCY_KEY],
          scheduledAt: NOW,
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "invalid active scheduled timestamp",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: "tomorrow",
          claimedAt: NOW,
        },
      }),
    },
    {
      name: "invalid active claim timestamp",
      value: jsonBytes({
        ...BASE_RECORD,
        active: {
          ownerId: OWNER_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          scheduledAt: NOW,
          claimedAt: "tomorrow",
        },
      }),
    },
    {
      name: "invalid outcome status",
      value: jsonBytes({
        ...BASE_RECORD,
        lastOutcome: {
          status: "successful",
          scheduledAt: NOW,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      }),
    },
    {
      name: "invalid outcome idempotency key",
      value: jsonBytes({
        ...BASE_RECORD,
        lastOutcome: {
          status: "accepted",
          scheduledAt: NOW,
          idempotencyKey: "cron:v1:wrong",
        },
      }),
    },
    {
      name: "outcome idempotency key with hostile prefix",
      value: jsonBytes({
        ...BASE_RECORD,
        lastOutcome: {
          status: "accepted",
          scheduledAt: NOW,
          idempotencyKey: `x${IDEMPOTENCY_KEY}`,
        },
      }),
    },
    {
      name: "outcome idempotency key with hostile suffix",
      value: jsonBytes({
        ...BASE_RECORD,
        lastOutcome: {
          status: "accepted",
          scheduledAt: NOW,
          idempotencyKey: `${IDEMPOTENCY_KEY}x`,
        },
      }),
    },
    {
      name: "array-valued outcome idempotency key",
      value: jsonBytes({
        ...BASE_RECORD,
        lastOutcome: {
          status: "accepted",
          scheduledAt: NOW,
          idempotencyKey: [IDEMPOTENCY_KEY],
        },
      }),
    },
    {
      name: "invalid outcome timestamp",
      value: jsonBytes({
        ...BASE_RECORD,
        lastOutcome: {
          status: "accepted",
          scheduledAt: "tomorrow",
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      }),
    },
    {
      name: "invalid issue status",
      value: jsonBytes({
        ...BASE_RECORD,
        issue: {
          status: "successful",
          observedAt: NOW,
          scheduledAt: NOW,
        },
      }),
    },
    {
      name: "invalid issue observation timestamp",
      value: jsonBytes({
        ...BASE_RECORD,
        issue: {
          status: "unknown",
          observedAt: "tomorrow",
          scheduledAt: NOW,
        },
      }),
    },
    {
      name: "invalid issue schedule timestamp",
      value: jsonBytes({
        ...BASE_RECORD,
        issue: {
          status: "unknown",
          observedAt: NOW,
          scheduledAt: "tomorrow",
        },
      }),
    },
    {
      name: "zero missed range count",
      value: jsonBytes({
        ...BASE_RECORD,
        missed: {
          ranges: 0,
          atLeast: 1,
          from: NOW,
          through: LATER,
        },
      }),
    },
    {
      name: "zero missed lower bound",
      value: jsonBytes({
        ...BASE_RECORD,
        missed: {
          ranges: 1,
          atLeast: 0,
          from: NOW,
          through: LATER,
        },
      }),
    },
    {
      name: "reversed missed range",
      value: jsonBytes({
        ...BASE_RECORD,
        missed: {
          ranges: 1,
          atLeast: 1,
          from: LATER,
          through: NOW,
        },
      }),
    },
    {
      name: "non-regressing clock record",
      value: jsonBytes({
        ...BASE_RECORD,
        lastClockRegression: {
          from: NOW,
          to: LATER,
        },
      }),
    },
    {
      name: "equal clock-regression endpoints",
      value: jsonBytes({
        ...BASE_RECORD,
        lastClockRegression: {
          from: NOW,
          to: NOW,
        },
      }),
    },
  ];

  it.each(malformed)("rejects $name without writing a repair", async ({ value, error }) => {
    const boundary = durableBoundary(value);

    await expect(boundary.initialize()).rejects.toThrow(error);
    expect(boundary.writes).toBe(0);
  });
});

function durableBoundary(value: Uint8Array): {
  readonly initialize: () => Promise<void>;
  readonly state: JobState;
  readonly writes: number;
} {
  let writes = 0;
  const signal = new AbortController().signal;
  const capability: CronDurableStateCapability = {
    async read() {
      return {
        value: new Uint8Array(value),
        version: "v-hostile",
      };
    },
    async compareAndSwap() {
      writes += 1;
      throw new Error("malformed durable bytes must never be repaired");
    },
  };
  const state = createJobState();
  const scheduler = createCronDurableScheduler({
    instanceId: "cron",
    ownerId: OWNER_ID,
    clock: testClock,
    capability,
  });
  return {
    initialize: async () => {
      await scheduler.initializeJob(JOB, state, new Date(NOW), signal);
    },
    state,
    get writes() {
      return writes;
    },
  };
}

function createJobState(): JobState {
  return {
    timer: undefined,
    target: undefined,
    active: undefined,
    pending: [],
    durable: {
      record: BASE_RECORD,
      version: null,
    },
    mutation: Promise.resolve(),
    emitted: 0,
    observedClockMs: new Date(NOW).getTime(),
    reconciling: false,
    foreignBlocked: false,
    scheduleTransition: false,
    generationFenced: false,
  };
}

const testClock: CronClock = {
  now: () => new Date(NOW),
  setTimeout() {
    throw new Error("decoder tests do not arm timers");
  },
  clearTimeout() {},
};

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}
