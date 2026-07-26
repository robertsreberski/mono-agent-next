// SPDX-License-Identifier: MIT
import type {
  JsonValue,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleHealth,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import type { ExportBatch, ExportResult, Exporter } from "@mono-agent/module-sdk/internal";

import { parseEndpoint, type OtlpExporterConfig } from "./config.js";
import { OtlpExporterError, throwIfAborted } from "./errors.js";
import { serializeOtlpSpans, type SequencedExportRecord } from "./otlp.js";
import { prepareRecord } from "./prepare.js";
import {
  FetchOtlpTransport,
  type OtlpTransport,
  type OtlpTransportResponse,
} from "./transport.js";
import { PACKAGE_VERSION } from "./version.js";

interface QueuedRecord extends SequencedExportRecord {
  readonly bytes: number;
  readonly wireBytes: number;
}

interface ActiveBatch {
  readonly records: readonly QueuedRecord[];
  readonly body: Uint8Array;
  retryAttempts: number;
  retryAt: number;
}

class OtlpDeliveryError extends Error {
  readonly exporterError: OtlpExporterError;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    exporterError: OtlpExporterError,
    retryable: boolean,
    retryAfterMs?: number,
  ) {
    super(exporterError.message, { cause: exporterError });
    this.name = "OtlpDeliveryError";
    this.exporterError = exporterError;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface OtlpExporterOptions {
  readonly transport?: OtlpTransport;
  readonly clock?: () => Date;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class OtlpExporter implements Exporter {
  private readonly config: OtlpExporterConfig;
  private readonly transport: OtlpTransport;
  private readonly clock: () => Date;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly queue: QueuedRecord[] = [];
  private activeBatch: ActiveBatch | undefined;
  private nextEnqueueSequence = 0n;
  private queuedBytes = 0;
  private deliveredRecords = 0;
  private rejectedRecords = 0;
  private droppedRecords = 0;
  private droppedBatches = 0;
  private retryAttempts = 0;
  private redactedRecords = 0;
  private redactedValues = 0;
  private lastError: OtlpExporterError | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private pumpPromise: Promise<void> | undefined;
  private activePumpController: AbortController | undefined;
  private stopPromise: Promise<void> | undefined;
  private activeRequestController: AbortController | undefined;
  private activeRetryController: AbortController | undefined;
  private started = false;
  private closing = false;
  private closed = false;

  constructor(config: OtlpExporterConfig, options: OtlpExporterOptions = {}) {
    this.config = config;
    this.transport = options.transport ?? new FetchOtlpTransport();
    this.clock = options.clock ?? (() => new Date());
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(context: { readonly signal: AbortSignal }): void {
    throwIfAborted(context.signal);
    this.assertOpen();
    if (this.started) return;
    this.started = true;
    this.interval = setInterval(() => {
      this.kick();
    }, this.config.flushIntervalMs);
    this.interval.unref();
    this.kick();
  }

  async export(batch: ExportBatch): Promise<ExportResult> {
    throwIfAborted(batch.signal);
    this.assertOpen();
    let accepted = 0;
    let rejected = 0;
    for (const input of batch.records) {
      const prepared = prepareRecord(
        input,
        this.config.includeSensitiveData,
        this.config.contentPatternRedaction,
        this.config.maxRecordBytes,
      );
      if (prepared === undefined || prepared.bytes > this.config.maxRecordBytes) {
        rejected += 1;
        continue;
      }
      let wireBytes: number;
      const enqueueSequence = this.nextEnqueueSequence;
      try {
        wireBytes = serializeOtlpSpans(
          [{ record: prepared.record, enqueueSequence }],
          this.config.projectName,
        ).byteLength;
      } catch {
        rejected += 1;
        continue;
      }
      if (wireBytes > this.config.maxBatchBytes) {
        rejected += 1;
        continue;
      }
      if (
        this.queue.length >= this.config.maxQueueRecords ||
        this.queuedBytes + prepared.bytes > this.config.maxQueueBytes
      ) {
        rejected += 1;
        continue;
      }
      this.queue.push({ ...prepared, wireBytes, enqueueSequence });
      this.nextEnqueueSequence += 1n;
      this.queuedBytes += prepared.bytes;
      if (prepared.redactedValues > 0) {
        this.redactedRecords += 1;
        this.redactedValues += prepared.redactedValues;
      }
      accepted += 1;
    }
    this.rejectedRecords += rejected;
    if (accepted > 0 && this.started) this.kick();
    return { accepted, rejected };
  }

  async flush(signal: AbortSignal): Promise<void> {
    this.assertOpen();
    const timeout = AbortSignal.timeout(this.config.flushTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      await this.flushInternal(combined);
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new OtlpExporterError("OTLP_TIMEOUT", "OTLP flush exceeded its deadline.");
      }
      throw error;
    }
  }

  stop(context: ModuleStopContext): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.stopPromise !== undefined) return this.stopPromise;
    const stopping = this.stopOnce(context);
    this.stopPromise = stopping;
    return stopping;
  }

  private async stopOnce(context: ModuleStopContext): Promise<void> {
    this.closing = true;
    if (this.interval !== undefined) clearInterval(this.interval);
    this.activePumpController?.abort(new Error("Exporter is stopping."));
    this.activeRequestController?.abort(new Error("Exporter is stopping."));
    this.activeRetryController?.abort(new Error("Exporter is stopping."));

    const timeout = AbortSignal.timeout(this.config.stopTimeoutMs);
    const combined = AbortSignal.any([context.signal, timeout]);
    let failure: unknown;
    try {
      await waitForPromise(this.pumpPromise, combined);
      await this.flushInternal(combined, true);
    } catch (error) {
      failure = timeout.aborted && !context.signal.aborted
        ? new OtlpExporterError("OTLP_TIMEOUT", "OTLP shutdown flush exceeded its deadline.")
        : error;
      this.activePumpController?.abort(new Error("Exporter shutdown flush ended."));
      this.activeRequestController?.abort(new Error("Exporter shutdown flush ended."));
      this.activeRetryController?.abort(new Error("Exporter shutdown flush ended."));
      this.droppedBatches += this.countQueuedBatches();
      this.droppedRecords += this.queue.length;
      this.queue.splice(0);
      this.queuedBytes = 0;
      this.activeBatch = undefined;
    } finally {
      this.closed = true;
      this.started = false;
      this.closing = false;
    }
    if (failure !== undefined) throw failure;
  }

  health(context: { readonly signal: AbortSignal }): ModuleHealth {
    throwIfAborted(context.signal);
    const checkedAt = canonicalNow(this.clock);
    if (this.closed) {
      return {
        status: "unknown",
        checkedAt,
        summary: "The OTLP exporter is stopped.",
        details: this.healthDetails(),
      };
    }
    if (this.lastError !== undefined || this.droppedRecords > 0 || this.rejectedRecords > 0) {
      return {
        status: "degraded",
        checkedAt,
        summary: this.lastError?.message ?? "The OTLP exporter has rejected or dropped records.",
        details: this.healthDetails(),
      };
    }
    return {
      status: "healthy",
      checkedAt,
      summary: this.config.includeSensitiveData
        ? "The bounded OTLP queue is available; sensitive body export is enabled."
        : "The bounded OTLP queue is available.",
      details: this.healthDetails(),
    };
  }

  diagnostics(context: ModuleDiagnosticsContext): readonly ModuleDiagnostic[] {
    throwIfAborted(context.signal);
    const current = this.health(context);
    const diagnostics: ModuleDiagnostic[] = [];

    if (this.config.includeSensitiveData) {
      diagnostics.push({
        code: "exporter-otlp.sensitive-data",
        severity: "warning",
        message: this.config.contentPatternRedaction
          ? "Sensitive OTLP body export is enabled with bounded credential-pattern redaction."
          : "Sensitive OTLP body export is enabled without credential-pattern redaction.",
      });
    }

    if (current.status === "degraded") {
      diagnostics.push({
        code: "exporter-otlp.queue",
        severity: "error",
        message: "The bounded OTLP queue has rejected or dropped records, or retains a delivery failure.",
      });
    } else if (current.status === "unknown") {
      diagnostics.push({
        code: "exporter-otlp.lifecycle",
        severity: "info",
        message: "The OTLP exporter is stopped.",
      });
    } else if (diagnostics.length === 0) {
      diagnostics.push({
        code: "exporter-otlp.queue",
        severity: "info",
        message: "The bounded OTLP queue is available.",
      });
    }

    return Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic)));
  }

  private kick(force = false): void {
    if (this.pumpPromise !== undefined || this.queue.length === 0 || this.closed) return;
    if (!force && (!this.started || this.closing)) return;
    const controller = new AbortController();
    this.activePumpController = controller;
    const pump = this.runPump(controller.signal).catch((error: unknown) => {
      this.lastError = normalizeTransportError(error);
    });
    this.pumpPromise = pump.finally(() => {
      if (this.activePumpController === controller) this.activePumpController = undefined;
      this.pumpPromise = undefined;
    });
  }

  private async runPump(signal: AbortSignal): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      if (signal.aborted) {
        this.lastError = new OtlpExporterError(
          "OTLP_ABORTED",
          "The OTLP pump was aborted with records still queued.",
          signal.reason,
        );
        return;
      }
      const batch = this.activeBatch ?? this.createActiveBatch();
      const delayMs = Math.max(0, batch.retryAt - this.now());
      if (delayMs > 0) {
        try {
          await this.waitForRetry(delayMs, signal);
        } catch (error) {
          this.lastError = normalizeTransportError(error);
          return;
        }
      }
      try {
        await this.sendBatch(batch.body, signal);
      } catch (error) {
        const failure = classifyDeliveryError(error);
        this.lastError = failure.exporterError;
        if (signal.aborted || failure.exporterError.code === "OTLP_ABORTED") return;
        if (failure.retryable && batch.retryAttempts < this.config.maxRetryAttempts) {
          batch.retryAttempts += 1;
          this.retryAttempts += 1;
          batch.retryAt = this.now() +
            (failure.retryAfterMs ?? this.retryDelayMs(batch.retryAttempts));
          continue;
        }
        this.removeActiveBatch(false);
        continue;
      }
      if (this.closed) return;
      this.removeActiveBatch(true);
      this.lastError = undefined;
    }
  }

  private createActiveBatch(): ActiveBatch {
    const selected: QueuedRecord[] = [];
    let bytes = 0;
    for (const item of this.queue) {
      if (selected.length >= this.config.maxBatchRecords) break;
      if (selected.length > 0 && bytes + item.wireBytes > this.config.maxBatchBytes) break;
      selected.push(item);
      bytes += item.wireBytes;
    }
    if (selected.length === 0) {
      throw new OtlpExporterError("OTLP_FLUSH_FAILED", "The OTLP queue could not select a batch.");
    }
    const active = {
      records: Object.freeze(selected),
      body: serializeOtlpSpans(selected, this.config.projectName),
      retryAttempts: 0,
      retryAt: 0,
    };
    this.activeBatch = active;
    return active;
  }

  private removeActiveBatch(delivered: boolean): void {
    const active = this.activeBatch;
    if (active === undefined) {
      throw new OtlpExporterError("OTLP_FLUSH_FAILED", "The OTLP active batch is missing.");
    }
    for (const expected of active.records) {
      const removed = this.queue.shift();
      if (removed !== expected) {
        throw new OtlpExporterError("OTLP_FLUSH_FAILED", "The OTLP queue changed unexpectedly.");
      }
      this.queuedBytes -= removed.bytes;
    }
    if (delivered) {
      this.deliveredRecords += active.records.length;
    } else {
      this.droppedRecords += active.records.length;
      this.droppedBatches += 1;
    }
    this.activeBatch = undefined;
  }

  private countQueuedBatches(): number {
    let batches = 0;
    let selectedRecords = 0;
    let selectedBytes = 0;
    for (const item of this.queue) {
      if (
        selectedRecords === 0 ||
        selectedRecords >= this.config.maxBatchRecords ||
        selectedBytes + item.wireBytes > this.config.maxBatchBytes
      ) {
        batches += 1;
        selectedRecords = 1;
        selectedBytes = item.wireBytes;
      } else {
        selectedRecords += 1;
        selectedBytes += item.wireBytes;
      }
    }
    return batches;
  }

  private retryDelayMs(retryAttempt: number): number {
    const exponential = Math.min(
      this.config.maxRetryDelayMs,
      this.config.flushIntervalMs * (2 ** Math.max(0, retryAttempt - 1)),
    );
    const random = this.random();
    const sample = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
    return Math.max(1, Math.floor(exponential * (0.5 + sample * 0.5)));
  }

  private async waitForRetry(delayMs: number, parentSignal: AbortSignal): Promise<void> {
    throwIfAborted(parentSignal);
    const controller = new AbortController();
    this.activeRetryController = controller;
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = setTimeout(finish, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(new OtlpExporterError("OTLP_ABORTED", "The OTLP retry wait was aborted."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } finally {
      if (this.activeRetryController === controller) this.activeRetryController = undefined;
    }
  }

  private async sendBatch(body: Uint8Array, signal: AbortSignal): Promise<void> {
    let url = new URL(this.config.endpoint);
    const headers: Record<string, string> = {
      ...this.config.headers,
      "content-type": "application/x-protobuf",
      "user-agent": `mono-agent-exporter-otlp/${PACKAGE_VERSION}`,
      "x-project-name": this.config.projectName,
    };
    const credentialHeaders = new Set(Object.keys(this.config.headers));

    for (let redirects = 0; ; redirects += 1) {
      const response = await this.requestOnce(url, headers, body, signal);
      if (response.status >= 200 && response.status < 300) return;
      if (!isRedirect(response.status)) {
        const retryable = isRetryableStatus(response.status);
        throw new OtlpDeliveryError(
          new OtlpExporterError(
            "OTLP_HTTP_FAILED",
            `The OTLP collector returned HTTP ${response.status}.`,
          ),
          retryable,
          response.status === 429 || response.status === 503
            ? parseRetryAfter(
                response.headers["retry-after"],
                this.now(),
                this.config.maxRetryDelayMs,
              )
            : undefined,
        );
      }
      if (redirects >= this.config.maxRedirects) {
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP redirect limit was exceeded.");
      }
      const location = response.headers.location;
      if (location === undefined || location.length === 0 || location.length > 4_096) {
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP collector returned an invalid redirect.");
      }
      let next: URL;
      try {
        next = parseEndpoint(new URL(location, url).toString());
      } catch (error) {
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP collector redirect is not allowed.");
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP collector attempted a protocol downgrade.");
      }
      if (next.origin !== url.origin) {
        if (this.config.includeSensitiveData) {
          throw new OtlpExporterError(
            "OTLP_REDIRECT_REJECTED",
            "Cross-origin OTLP redirects are rejected when sensitive data export is enabled.",
          );
        }
        for (const name of credentialHeaders) delete headers[name];
      }
      url = next;
    }
  }

  private async requestOnce(
    url: URL,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array,
    parentSignal: AbortSignal,
  ): Promise<OtlpTransportResponse> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const controller = new AbortController();
    this.activeRequestController = controller;
    const signal = AbortSignal.any([parentSignal, timeout, controller.signal]);
    try {
      return await this.transport.send({ url: url.toString(), headers, body, signal });
    } catch (error) {
      if (timeout.aborted && !parentSignal.aborted && !controller.signal.aborted) {
        throw new OtlpExporterError("OTLP_TIMEOUT", "The OTLP request exceeded its deadline.");
      }
      if (signal.aborted) {
        throw new OtlpExporterError("OTLP_ABORTED", "The OTLP request was aborted.");
      }
      throw error;
    } finally {
      if (this.activeRequestController === controller) this.activeRequestController = undefined;
    }
  }

  private async flushInternal(signal: AbortSignal, duringStop = false): Promise<void> {
    throwIfAborted(signal);
    const droppedBeforeFlush = this.droppedRecords;
    while (this.queue.length > 0) {
      this.kick(true);
      await waitForPromise(this.pumpPromise, signal);
      throwIfAborted(signal);
      if (this.queue.length > 0) {
        throw new OtlpExporterError(
          "OTLP_FLUSH_FAILED",
          duringStop
            ? "The OTLP shutdown flush failed with records still queued."
            : "The OTLP flush failed with records still queued.",
          this.lastError,
        );
      }
    }
    if (this.droppedRecords > droppedBeforeFlush) {
      throw new OtlpExporterError(
        "OTLP_FLUSH_FAILED",
        duringStop
          ? "The OTLP shutdown flush exhausted delivery retries and dropped records."
          : "The OTLP flush exhausted delivery retries and dropped records.",
        this.lastError,
      );
    }
  }

  private healthDetails(): Readonly<Record<string, JsonValue>> {
    return {
      queuedRecords: this.queue.length,
      queuedBytes: this.queuedBytes,
      deliveredRecords: this.deliveredRecords,
      rejectedRecords: this.rejectedRecords,
      droppedRecords: this.droppedRecords,
      droppedBatches: this.droppedBatches,
      retryAttempts: this.retryAttempts,
      redactedRecords: this.redactedRecords,
      redactedValues: this.redactedValues,
      includeSensitiveData: this.config.includeSensitiveData,
      contentPatternRedaction: this.config.contentPatternRedaction,
      ...(this.config.includeSensitiveData
        ? {
            warning: this.config.contentPatternRedaction
              ? "Sensitive OTLP body export is enabled; retained text uses bounded credential-pattern redaction."
              : "Sensitive OTLP body export is enabled without credential-pattern redaction.",
          }
        : {}),
    };
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new OtlpExporterError("OTLP_CLOSED", "The OTLP exporter is closed.");
    }
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function classifyDeliveryError(error: unknown): OtlpDeliveryError {
  if (error instanceof OtlpDeliveryError) return error;
  const exporterError = normalizeTransportError(error);
  return new OtlpDeliveryError(
    exporterError,
    exporterError.code === "OTLP_HTTP_FAILED" || exporterError.code === "OTLP_TIMEOUT",
  );
}

function parseRetryAfter(
  value: string | undefined,
  now: number,
  maximumMs: number,
): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 128) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,10}$/u.test(trimmed)) {
    return Math.min(maximumMs, Number.parseInt(trimmed, 10) * 1_000);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return undefined;
  return Math.min(maximumMs, Math.max(0, timestamp - now));
}

function normalizeTransportError(error: unknown): OtlpExporterError {
  return error instanceof OtlpExporterError
    ? error
    : new OtlpExporterError("OTLP_HTTP_FAILED", "The OTLP collector request failed.");
}

function canonicalNow(clock: () => Date): string {
  const date = clock();
  if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) {
    throw new OtlpExporterError("OTLP_CONFIG_INVALID", "The OTLP exporter clock returned an invalid date.");
  }
  return date.toISOString();
}

async function waitForPromise(
  promise: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (promise === undefined) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(new OtlpExporterError("OTLP_ABORTED", "The OTLP wait was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
