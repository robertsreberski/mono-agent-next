// SPDX-License-Identifier: MIT

import type { CronJob } from "./jobs.js";
import type {
  DurableClockRegression,
  DurableEnvelope,
  DurableHealthIssue,
} from "./scheduler-durable.js";
import type {
  CronInvocationResult,
  CronInvocationSource,
  CronTimerHandle,
} from "./scheduler.js";

export interface PendingInvocation {
  readonly job: CronJob;
  readonly scheduledAt: string;
  readonly source: CronInvocationSource;
  readonly idempotencyKey: string;
  readonly resolve: (result: CronInvocationResult) => void;
}

interface ActiveInvocation {
  readonly controller: AbortController;
  readonly idempotencyKey: string;
  readonly settled: Promise<void>;
  readonly releasePending: boolean;
}

export interface JobState {
  timer: CronTimerHandle | undefined;
  target: Date | undefined;
  active: ActiveInvocation | undefined;
  pending: PendingInvocation[];
  durable: DurableEnvelope;
  mutation: Promise<void>;
  emitted: number;
  lastResult?: CronInvocationResult;
  observedClockMs: number;
  pendingClockRegression?: DurableClockRegression;
  persistenceError?: string;
  unsettledIssue?: DurableHealthIssue;
  reconciling: boolean;
  reconcileRequested?: CronInvocationSource;
  reconcileDone?: Promise<void>;
  foreignBlocked: boolean;
  scheduleTransition: boolean;
  generationFenced: boolean;
}
