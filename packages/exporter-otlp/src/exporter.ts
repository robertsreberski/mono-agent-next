import type {
  JsonObject,
  JsonValue,
  ModuleHealth,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import type {
  ExportBatch,
  ExportRecord,
  ExportResult,
  Exporter,
} from "@mono-agent/module-sdk/internal";

import { parseEndpoint, type OtlpExporterConfig } from "./config.js";
import { OtlpExporterError, throwIfAborted } from "./errors.js";
import { serializeOtlpSpans } from "./otlp.js";
import {
  FetchOtlpTransport,
  type OtlpTransport,
  type OtlpTransportResponse,
} from "./transport.js";

interface QueuedRecord {
  readonly record: ExportRecord;
  readonly bytes: number;
  readonly wireBytes: number;
}

interface PreparedRecord {
  readonly record: ExportRecord;
  readonly bytes: number;
}

export interface OtlpExporterOptions {
  readonly transport?: OtlpTransport;
  readonly clock?: () => Date;
}

export class OtlpExporter implements Exporter {
  private readonly config: OtlpExporterConfig;
  private readonly transport: OtlpTransport;
  private readonly clock: () => Date;
  private readonly queue: QueuedRecord[] = [];
  private queuedBytes = 0;
  private deliveredRecords = 0;
  private rejectedRecords = 0;
  private droppedRecords = 0;
  private lastError: OtlpExporterError | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private pumpPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private activeRequestController: AbortController | undefined;
  private started = false;
  private closing = false;
  private closed = false;

  constructor(config: OtlpExporterConfig, options: OtlpExporterOptions = {}) {
    this.config = config;
    this.transport = options.transport ?? new FetchOtlpTransport();
    this.clock = options.clock ?? (() => new Date());
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
      const prepared = prepareRecord(input, this.config.includeSensitiveData);
      if (prepared === undefined || prepared.bytes > this.config.maxRecordBytes) {
        rejected += 1;
        continue;
      }
      let wireBytes: number;
      try {
        wireBytes = serializeOtlpSpans([prepared.record], this.config.projectName).byteLength;
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
      this.queue.push({ ...prepared, wireBytes });
      this.queuedBytes += prepared.bytes;
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
        throw new OtlpExporterError("OTLP_TIMEOUT", "OTLP flush exceeded its deadline.", error);
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
    this.activeRequestController?.abort(new Error("Exporter is stopping."));

    const timeout = AbortSignal.timeout(this.config.stopTimeoutMs);
    const combined = AbortSignal.any([context.signal, timeout]);
    let failure: unknown;
    try {
      await waitForPromise(this.pumpPromise, combined);
      await this.flushInternal(combined, true);
    } catch (error) {
      failure = timeout.aborted && !context.signal.aborted
        ? new OtlpExporterError("OTLP_TIMEOUT", "OTLP shutdown flush exceeded its deadline.", error)
        : error;
      this.droppedRecords += this.queue.length;
      this.queue.splice(0);
      this.queuedBytes = 0;
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
      summary: "The bounded OTLP queue is available.",
      details: this.healthDetails(),
    };
  }

  private kick(force = false, signal = new AbortController().signal): void {
    if (this.pumpPromise !== undefined || this.queue.length === 0 || this.closed) return;
    if (!force && (!this.started || this.closing)) return;
    const pump = this.runPump(signal).catch((error: unknown) => {
      this.lastError = normalizeTransportError(error);
    });
    this.pumpPromise = pump.finally(() => {
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
      const batch = this.selectBatch();
      try {
        await this.sendBatch(batch.map((item) => item.record), signal);
      } catch (error) {
        this.lastError = normalizeTransportError(error);
        return;
      }
      if (this.closed) return;
      for (let index = 0; index < batch.length; index += 1) {
        const removed = this.queue.shift();
        if (removed === undefined) {
          throw new OtlpExporterError("OTLP_FLUSH_FAILED", "The OTLP queue changed unexpectedly.");
        }
        this.queuedBytes -= removed.bytes;
      }
      this.deliveredRecords += batch.length;
      this.lastError = undefined;
    }
  }

  private selectBatch(): readonly QueuedRecord[] {
    const selected: QueuedRecord[] = [];
    let bytes = 0;
    for (const item of this.queue) {
      if (selected.length >= this.config.maxBatchRecords) break;
      if (selected.length > 0 && bytes + item.wireBytes > this.config.maxBatchBytes) break;
      selected.push(item);
      bytes += item.wireBytes;
    }
    return selected;
  }

  private async sendBatch(records: readonly ExportRecord[], signal: AbortSignal): Promise<void> {
    const body = serializeOtlpSpans(records, this.config.projectName);
    let url = new URL(this.config.endpoint);
    const headers: Record<string, string> = {
      ...this.config.headers,
      "content-type": "application/x-protobuf",
      "user-agent": "mono-agent-exporter-otlp/0.15.0",
      "x-project-name": this.config.projectName,
    };
    const credentialHeaders = new Set(Object.keys(this.config.headers));

    for (let redirects = 0; ; redirects += 1) {
      const response = await this.requestOnce(url, headers, body, signal);
      if (response.status >= 200 && response.status < 300) return;
      if (!isRedirect(response.status)) {
        throw new OtlpExporterError(
          "OTLP_HTTP_FAILED",
          `The OTLP collector returned HTTP ${response.status}.`,
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
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP collector redirect is not allowed.", error);
      }
      if (url.protocol === "https:" && next.protocol !== "https:") {
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP collector attempted a protocol downgrade.");
      }
      if (next.origin !== url.origin) {
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
        throw new OtlpExporterError("OTLP_TIMEOUT", "The OTLP request exceeded its deadline.", error);
      }
      if (signal.aborted) {
        throw new OtlpExporterError("OTLP_ABORTED", "The OTLP request was aborted.", error);
      }
      throw error;
    } finally {
      if (this.activeRequestController === controller) this.activeRequestController = undefined;
    }
  }

  private async flushInternal(signal: AbortSignal, duringStop = false): Promise<void> {
    throwIfAborted(signal);
    while (this.queue.length > 0) {
      this.kick(true, signal);
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
  }

  private healthDetails(): Readonly<Record<string, JsonValue>> {
    return {
      queuedRecords: this.queue.length,
      queuedBytes: this.queuedBytes,
      deliveredRecords: this.deliveredRecords,
      rejectedRecords: this.rejectedRecords,
      droppedRecords: this.droppedRecords,
    };
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new OtlpExporterError("OTLP_CLOSED", "The OTLP exporter is closed.");
    }
  }
}

function prepareRecord(record: ExportRecord, includeSensitiveData: boolean): PreparedRecord | undefined {
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.name !== "string" ||
    record.name.trim().length === 0 ||
    record.name.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(record.name) ||
    !isCanonicalTimestamp(record.timestamp) ||
    !isPlainObject(record.attributes) ||
    !Object.keys(record.attributes).every((key) =>
      key.length > 0 && key.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(key))
  ) {
    return undefined;
  }
  try {
    validateJson(record.attributes, 0);
    if (includeSensitiveData && record.body !== undefined) validateJson(record.body, 0);
    const cloned = JSON.parse(JSON.stringify({
      name: record.name,
      timestamp: record.timestamp,
      attributes: record.attributes,
      ...(includeSensitiveData && record.body !== undefined ? { body: record.body } : {}),
    })) as ExportRecord;
    const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
    return { record: cloned, bytes };
  } catch {
    return undefined;
  }
}

function validateJson(value: unknown, depth: number): asserts value is JsonValue {
  if (depth > 32) throw new Error("JSON nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
    return;
  }
  if (Array.isArray(value)) {
    for (const nested of value) validateJson(nested, depth + 1);
    return;
  }
  if (!isPlainObject(value)) throw new Error("JSON object must be plain");
  for (const nested of Object.values(value)) validateJson(nested, depth + 1);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  const milliseconds = date.valueOf();
  return (
    Number.isFinite(milliseconds) &&
    milliseconds >= 0 &&
    milliseconds <= 18_446_744_073_709 &&
    date.toISOString() === value
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeTransportError(error: unknown): OtlpExporterError {
  return error instanceof OtlpExporterError
    ? error
    : new OtlpExporterError("OTLP_HTTP_FAILED", "The OTLP collector request failed.", error);
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
      reject(new OtlpExporterError("OTLP_ABORTED", "The OTLP wait was aborted.", signal.reason));
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
