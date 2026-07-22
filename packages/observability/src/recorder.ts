import { join, resolve } from "node:path";

import { artifactDirForKind } from "./artifact-scope.js";
import {
  DEFAULT_MAX_STRING_BYTES,
  mkdir,
  safeArtifactName,
  sweepOrphanedAtomicWriteTemps,
  writeJsonAtomic,
} from "./artifact-fs.js";
import { errorFailureKind, errorToJson, redactJsonValue } from "./redaction.js";
import { normalizeFailoverHistory } from "./run-export-mapping.js";
import type { JsonlRunRecorderOptions, RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "./types.js";

// System prompts are bounded by their OWN cap, not the per-event `maxStringBytes`
// (default 4096) that bounds tool/message content — the compiled channel prompt
// (identity + skills + recalled memory) is large and would otherwise be gutted.
const SYSTEM_PROMPT_MAX_BYTES = 32_000;
const ARTIFACT_REDACTION_OPTIONS = Object.freeze({ contentPatternRedaction: true });

function redactArtifactValue<T>(value: T, maxStringBytes: number): T {
  return redactJsonValue(value, maxStringBytes, ARTIFACT_REDACTION_OPTIONS) as T;
}

// A run normally emits dozens to low hundreds of events. Scheduling a redacted
// JSONL snapshot every 25 events bounds the unscheduled crash tail without
// awaiting filesystem I/O in the synchronous event path; the time bound covers
// sparse runs. Filesystem failure and in-flight I/O remain best-effort.
// Exported from this module (but not the package entrypoint) so recorder tests
// can assert the exact internal policy without duplicating magic numbers.
export const RUN_CHECKPOINT_EVENT_INTERVAL = 25;
export const RUN_CHECKPOINT_TIME_INTERVAL_MS = 5_000;

// `redactJsonValue` is re-exported so existing importers (recorder.test.ts
// imports it via "../recorder.js") keep their import surface unchanged.
export { redactJsonValue };
export type { RedactJsonValueOptions } from "./redaction.js";

export type ObservabilityErrorCode = "invalid_recorder_options" | "artifact_write_failed";
export type ObservabilityErrorDetails = Record<string, unknown> & { readonly code: ObservabilityErrorCode };

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;
  readonly details: ObservabilityErrorDetails;

  constructor(code: ObservabilityErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ObservabilityError";
    this.code = code;
    this.details = { ...details, code };
  }
}

class JsonlRunRecorder implements RunRecorder {
  private readonly runId: string;
  private readonly conversationId: string;
  private readonly artifactDir: string;
  private readonly clock: () => number;
  private readonly maxStringBytes: number;
  private readonly startedAt: number;
  private readonly startedAtIso: string;
  private readonly events: RuntimeEventLike[] = [];
  private readonly userInput: string | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly isolated: boolean | undefined;
  private readonly source: string | undefined;
  private readonly sourceDetail: string | undefined;
  private preparePromise: Promise<void> | undefined;
  private terminalPromise: Promise<RunSummary> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private checkpointPromise: Promise<void> | undefined;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private checkpointRequested = false;
  private lastCheckpointAttemptEventCount = 0;

  constructor(options: JsonlRunRecorderOptions) {
    this.runId = normalizeId(options.runId, "runId");
    this.conversationId = normalizeId(options.conversationId, "conversationId");
    if (typeof options.artifactDir !== "string" || options.artifactDir.trim().length === 0) {
      throw new ObservabilityError("invalid_recorder_options", "artifactDir must be a non-empty path.");
    }
    if (options.maxStringBytes !== undefined && (!Number.isInteger(options.maxStringBytes) || options.maxStringBytes < 64)) {
      throw new ObservabilityError("invalid_recorder_options", "maxStringBytes must be an integer of at least 64.");
    }
    const artifactKind = normalizeArtifactKind(options.artifactKind);
    this.artifactDir = artifactDirForKind(resolve(options.artifactDir), artifactKind);
    this.clock = options.clock ?? (() => Date.now());
    this.maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
    this.userInput =
      typeof options.userInput === "string"
        ? redactArtifactValue(options.userInput, this.maxStringBytes)
        : undefined;
    this.systemPrompt =
      typeof options.systemPrompt === "string"
        ? redactArtifactValue(options.systemPrompt, SYSTEM_PROMPT_MAX_BYTES)
        : undefined;
    this.isolated = typeof options.isolated === "boolean" ? options.isolated : undefined;
    this.source =
      typeof options.source === "string" && options.source.length > 0
        ? redactArtifactValue(options.source, this.maxStringBytes)
        : undefined;
    this.sourceDetail =
      typeof options.sourceDetail === "string" && options.sourceDetail.length > 0
        ? redactArtifactValue(options.sourceDetail, this.maxStringBytes)
        : undefined;
    this.startedAt = this.clock();
    this.startedAtIso = new Date(this.startedAt).toISOString();
  }

  async start(): Promise<RunSummary> {
    const events = [...this.events];
    this.lastCheckpointAttemptEventCount = events.length;
    this.clearCheckpointTimer();
    return await this.enqueueArtifactWrite(this.buildSummary("running", undefined, {}), events);
  }

  onEvent(event: RuntimeEventLike): void {
    if (this.terminalPromise !== undefined) return;
    const redacted = redactArtifactValue(event, this.maxStringBytes);
    const timestamp = redacted.timestamp;
    const hasUsableTimestamp = typeof timestamp === "string" || typeof timestamp === "number";
    this.events.push(
      hasUsableTimestamp ? redacted : { ...redacted, timestamp: new Date(this.clock()).toISOString() },
    );
    try {
      if (this.events.length - this.lastCheckpointAttemptEventCount >= RUN_CHECKPOINT_EVENT_INTERVAL) {
        this.requestCheckpoint();
      } else {
        this.armCheckpointTimer();
      }
    } catch {
      // Incremental checkpoint scheduling is best-effort and must not turn an
      // otherwise accepted runtime event into a run failure.
    }
  }

  async prepareFinish(_result: RuntimeResultLike): Promise<void> {
    // Keep preparation non-terminal: it may yield for filesystem setup, giving
    // the harness a real cancellation checkpoint without exposing a succeeded
    // run before history/memory persistence has had a chance to emit warnings.
    await this.prepareArtifactDirectory();
  }

  async commitFinish(result: RuntimeResultLike): Promise<RunSummary> {
    return await this.commitTerminal(() => {
      const status = result.cancelled === true ? "cancelled" : runtimeFailureKind(result) === undefined ? "succeeded" : "failed";
      return this.buildSummary(status, runtimeFailureKind(result), result);
    });
  }

  async finish(result: RuntimeResultLike): Promise<RunSummary> {
    await this.prepareFinish(result);
    return await this.commitFinish(result);
  }

  async fail(error: unknown): Promise<RunSummary> {
    return await this.commitTerminal(() => {
      const failureKind = errorFailureKind(error);
      return this.buildSummary("failed", failureKind, {
        diagnostics: {
          error: redactArtifactValue(errorToJson(error), this.maxStringBytes),
        },
      });
    });
  }

  private async commitTerminal(build: () => RunSummary): Promise<RunSummary> {
    // Assign before awaiting so concurrent/repeated terminal calls share one
    // write and can never publish conflicting terminal summaries. Queue it
    // behind any already-scheduled running checkpoint so that checkpoint can
    // never race in later and downgrade the terminal summary back to running.
    if (this.terminalPromise === undefined) {
      this.clearCheckpointTimer();
      this.checkpointRequested = false;
      const summary = build();
      this.terminalPromise = this.enqueueArtifactWrite(summary, [...this.events]);
    }
    return await this.terminalPromise;
  }

  private armCheckpointTimer(): void {
    if (
      this.terminalPromise !== undefined
      || this.checkpointTimer !== undefined
      || this.events.length <= this.lastCheckpointAttemptEventCount
    ) {
      return;
    }
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      try {
        this.requestCheckpoint();
      } catch {
        // Incremental persistence is best-effort. A timer/checkpoint failure
        // must never surface as an uncaught exception or change the run result.
      }
    }, RUN_CHECKPOINT_TIME_INTERVAL_MS);
    // A pending checkpoint is useful only while the process remains alive; it
    // must not keep an otherwise-idle agent process open by itself.
    const timer = this.checkpointTimer;
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  private clearCheckpointTimer(): void {
    if (this.checkpointTimer === undefined) return;
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
  }

  private requestCheckpoint(): void {
    if (this.terminalPromise !== undefined || this.events.length <= this.lastCheckpointAttemptEventCount) {
      return;
    }
    if (this.checkpointPromise !== undefined) {
      // Coalesce any number of threshold/timer hits while one snapshot is in
      // flight. Its completion schedules one newest-state follow-up.
      this.checkpointRequested = true;
      this.clearCheckpointTimer();
      return;
    }

    this.clearCheckpointTimer();
    this.checkpointRequested = false;
    const events = [...this.events];
    this.lastCheckpointAttemptEventCount = events.length;
    const write = this.enqueueArtifactWrite(this.buildSummary("running", undefined, {}), events);
    let tracked: Promise<void>;
    tracked = write.then(
      () => this.checkpointSettled(tracked),
      () => this.checkpointSettled(tracked),
    );
    this.checkpointPromise = tracked;
    // Checkpoint failures are intentionally swallowed: onEvent is synchronous
    // and incremental persistence must not create an unhandled rejection. A
    // later event/timer or the required terminal write gets a fresh attempt.
    void tracked.catch(() => undefined);
  }

  private checkpointSettled(checkpoint: Promise<void>): void {
    if (this.checkpointPromise !== checkpoint) return;
    this.checkpointPromise = undefined;
    if (this.terminalPromise !== undefined) {
      this.checkpointRequested = false;
      this.clearCheckpointTimer();
      return;
    }
    if (this.events.length <= this.lastCheckpointAttemptEventCount) {
      this.checkpointRequested = false;
      return;
    }
    const writeImmediately =
      this.checkpointRequested
      || this.events.length - this.lastCheckpointAttemptEventCount >= RUN_CHECKPOINT_EVENT_INTERVAL;
    this.checkpointRequested = false;
    if (writeImmediately) {
      this.requestCheckpoint();
    } else {
      this.armCheckpointTimer();
    }
  }

  private buildSummary(status: RunSummary["status"], failureKind: string | undefined, result: RuntimeResultLike): RunSummary {
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    // System prompt may arrive via the recorder option (memory path, a constant)
    // or via the finished result (channel path, the compiled context prompt). The
    // result wins when present; both are bounded by the dedicated prompt cap.
    const systemPrompt =
      typeof result.systemPrompt === "string"
        ? redactArtifactValue(result.systemPrompt, SYSTEM_PROMPT_MAX_BYTES)
        : this.systemPrompt;
    // Underlying provider/runtime message (the "why" behind `failureKind`) and the
    // router's per-attempt failover detail. Both ride on the runtime result but were
    // historically dropped here, leaving a failed trace with only the collapsed kind.
    const error =
      typeof result.error === "string" && result.error.trim().length > 0
        ? redactArtifactValue(result.error, this.maxStringBytes)
        : undefined;
    const normalizedFailoverHistory = normalizeFailoverHistory(result.failoverHistory);
    const failoverHistory = normalizedFailoverHistory === undefined
      ? undefined
      : redactArtifactValue(normalizedFailoverHistory, this.maxStringBytes);
    const isolated = typeof result.isolated === "boolean" ? result.isolated : this.isolated;
    const summary: RunSummary = {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(failureKind === undefined ? {} : { failureKind: redactArtifactValue(failureKind, this.maxStringBytes) }),
      ...(error === undefined ? {} : { error }),
      ...(failoverHistory === undefined ? {} : { failoverHistory }),
      startedAt: this.startedAtIso,
      ...(status === "running" ? {} : { endedAt: nowIso }),
      updatedAt: nowIso,
      durationMs: Math.max(0, now - this.startedAt),
      ...(result.usage === undefined ? {} : { usage: redactArtifactValue(result.usage, this.maxStringBytes) }),
      ...(result.cost === undefined ? {} : { cost: redactArtifactValue(result.cost, this.maxStringBytes) }),
      ...(typeof result.model === "string" && result.model.length > 0
        ? { model: redactArtifactValue(result.model, this.maxStringBytes) }
        : {}),
      ...(result.providerSessionId === undefined
        ? {}
        : {
            providerSessionId: typeof result.providerSessionId === "string"
              ? redactArtifactValue(result.providerSessionId, this.maxStringBytes)
              : result.providerSessionId,
          }),
      ...(isolated === undefined ? {} : { isolated }),
      eventCount: this.events.length,
      artifactPaths: this.artifactPaths(),
      ...(this.userInput === undefined ? {} : { userInput: this.userInput }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(typeof result.effort === "string"
        ? { effort: redactArtifactValue(result.effort, this.maxStringBytes) }
        : {}),
      ...(this.source === undefined ? {} : { source: this.source }),
      ...(this.sourceDetail === undefined ? {} : { sourceDetail: this.sourceDetail }),
      ...(result.runtimeWarnings === undefined
        ? {}
        : { runtimeWarnings: redactArtifactValue(result.runtimeWarnings, this.maxStringBytes) }),
      ...(result.diagnostics === undefined
        ? {}
        : { diagnostics: redactArtifactValue(result.diagnostics, this.maxStringBytes) }),
      ...(result.capabilitiesUsed === undefined
        ? {}
        : { capabilitiesUsed: redactArtifactValue(result.capabilitiesUsed, this.maxStringBytes) }),
    };
    return summary;
  }

  private artifactPaths(): readonly string[] {
    const base = safeArtifactName(this.runId);
    return [join(this.artifactDir, `${base}.events.jsonl`), join(this.artifactDir, `${base}.summary.json`)];
  }

  private enqueueArtifactWrite(summary: RunSummary, events: readonly RuntimeEventLike[]): Promise<RunSummary> {
    const write = this.writeTail.then(async () => await this.writeArtifacts(summary, events));
    // Keep the queue usable after a best-effort checkpoint failure. The caller
    // still observes its own write rejection when the write is required
    // (start/finalization), while later writes are not poisoned by it.
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async writeArtifacts(summary: RunSummary, events: readonly RuntimeEventLike[]): Promise<RunSummary> {
    const [eventsPath, summaryPath] = summary.artifactPaths;
    if (eventsPath === undefined || summaryPath === undefined) {
      throw new ObservabilityError("artifact_write_failed", "Recorder artifact paths were not generated.");
    }
    try {
      await this.prepareArtifactDirectory();
      // The summary and event array were snapshotted together before this
      // asynchronous write entered the queue, so eventCount can never describe
      // a newer/older in-memory state than its companion JSONL contents.
      const eventsJsonl = events.map((event) => JSON.stringify(event)).join("\n");
      await writeJsonAtomic(eventsPath, eventsJsonl.length === 0 ? "" : `${eventsJsonl}\n`);
      await writeJsonAtomic(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      return summary;
    } catch (error) {
      throw new ObservabilityError("artifact_write_failed", "Unable to write run artifacts.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async prepareArtifactDirectory(): Promise<void> {
    this.preparePromise ??= (async () => {
      await mkdir(this.artifactDir, { recursive: true });
      await sweepOrphanedAtomicWriteTemps(this.artifactDir);
    })();
    await this.preparePromise;
  }
}

export function createJsonlRunRecorder(options: JsonlRunRecorderOptions): RunRecorder {
  return new JsonlRunRecorder(options);
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ObservabilityError("invalid_recorder_options", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function normalizeArtifactKind(value: JsonlRunRecorderOptions["artifactKind"]): "agent" | "memory" {
  if (value === undefined || value === "agent" || value === "memory") {
    return value ?? "agent";
  }
  throw new ObservabilityError("invalid_recorder_options", "artifactKind must be \"agent\" or \"memory\".", {
    field: "artifactKind",
  });
}

function runtimeFailureKind(result: RuntimeResultLike): string | undefined {
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return result.failureKind;
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return "runtime_error";
  }
  return undefined;
}
