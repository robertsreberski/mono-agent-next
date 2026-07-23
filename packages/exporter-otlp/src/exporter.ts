import type {
  JsonObject,
  JsonValue,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
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
  readonly redactedValues: number;
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
  private redactedRecords = 0;
  private redactedValues = 0;
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
    this.activeRequestController?.abort(new Error("Exporter is stopping."));

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
        throw new OtlpExporterError("OTLP_REDIRECT_REJECTED", "The OTLP collector redirect is not allowed.");
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

const MAX_RECORD_NODES = 10_000;

// Intentionally closed and high confidence. Every expression requires a
// credential-specific prefix, length, and alphabet; prefix mentions in prose
// do not match. Quantifiers are bounded to keep scanning time predictable.
const CONTENT_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{48}\b/gu,
  /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{47,511}[A-Za-z0-9]\b/gu,
  /\bghp_[A-Za-z0-9]{36}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{19,511}[A-Za-z0-9]\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
  /\bxapp-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
] as const;

function prepareRecord(
  record: ExportRecord,
  includeSensitiveData: boolean,
  contentPatternRedaction: boolean,
  maxRecordBytes: number,
): PreparedRecord | undefined {
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
    const state: CloneState = {
      remainingNodes: MAX_RECORD_NODES,
      remainingBytes: maxRecordBytes,
      redactedValues: 0,
      contentPatternRedaction,
    };
    consumeBytes(state, Buffer.byteLength(record.name, "utf8"));
    const cloned: ExportRecord = {
      name: redactString(record.name, state),
      timestamp: record.timestamp,
      attributes: cloneJson(record.attributes, state, 0) as JsonObject,
      ...(includeSensitiveData && record.body !== undefined
        ? { body: cloneJson(record.body, state, 0) }
        : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
    return { record: cloned, bytes, redactedValues: state.redactedValues };
  } catch {
    return undefined;
  }
}

interface CloneState {
  remainingNodes: number;
  remainingBytes: number;
  redactedValues: number;
  readonly contentPatternRedaction: boolean;
}

function cloneJson(value: unknown, state: CloneState, depth: number): JsonValue {
  if (depth > 32) throw new Error("JSON nesting limit exceeded");
  if (state.remainingNodes <= 0) throw new Error("JSON node limit exceeded");
  state.remainingNodes -= 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    consumeBytes(state, Buffer.byteLength(value, "utf8"));
    return redactString(value, state);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((nested) => cloneJson(nested, state, depth + 1));
  }
  if (!isPlainObject(value)) throw new Error("JSON object must be plain");
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    consumeBytes(state, Buffer.byteLength(key, "utf8"));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("JSON object must contain only data properties");
    }
    output[key] = cloneJson(descriptor.value, state, depth + 1);
  }
  return output;
}

function consumeBytes(state: CloneState, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > state.remainingBytes) {
    throw new Error("JSON byte limit exceeded");
  }
  state.remainingBytes -= bytes;
}

function redactString(value: string, state: CloneState): string {
  if (!state.contentPatternRedaction) return value;
  let redacted = value;
  for (const pattern of CONTENT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      state.redactedValues += 1;
      return "[redacted]";
    });
  }
  return redacted;
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
