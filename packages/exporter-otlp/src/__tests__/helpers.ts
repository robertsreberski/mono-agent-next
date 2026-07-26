// SPDX-License-Identifier: MIT
import type { ExportRecord } from "@mono-agent/module-sdk/internal";

import { parseOtlpExporterConfig } from "../config.js";
import { OtlpExporter } from "../exporter.js";
import type {
  OtlpTransport,
  OtlpTransportRequest,
  OtlpTransportResponse,
} from "../transport.js";

export const signal: AbortSignal = new AbortController().signal;

export class ScriptedTransport implements OtlpTransport {
  readonly requests: OtlpTransportRequest[] = [];
  private readonly handler: (
    request: OtlpTransportRequest,
    index: number,
  ) => OtlpTransportResponse | Promise<OtlpTransportResponse>;

  constructor(handler: ScriptedTransport["handler"]) {
    this.handler = handler;
  }

  send(request: OtlpTransportRequest): Promise<OtlpTransportResponse> {
    const snapshot: OtlpTransportRequest = {
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body),
    };
    const index = this.requests.push(snapshot) - 1;
    return Promise.resolve(this.handler(request, index));
  }
}

export function createExporter(
  transport: OtlpTransport,
  overrides: Readonly<Record<string, unknown>> = {},
): OtlpExporter {
  const config = parseOtlpExporterConfig({
    endpoint: "https://collector.example/v1/traces",
    projectName: "test-agent",
    maxQueueRecords: 10,
    maxQueueBytes: 64 * 1024,
    maxBatchRecords: 10,
    maxBatchBytes: 16 * 1024,
    maxRecordBytes: 8 * 1024,
    flushIntervalMs: 60_000,
    requestTimeoutMs: 1_000,
    flushTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    ...overrides,
  });
  return new OtlpExporter(config, {
    transport,
    clock: () => new Date("2026-07-23T12:00:00.000Z"),
    random: () => 0.5,
  });
}

export function record(
  name: string,
  overrides: Readonly<Record<string, ExportRecord["attributes"][string]>> = {},
): ExportRecord {
  return {
    name,
    timestamp: "2026-07-23T12:00:00.000Z",
    attributes: {
      "mono.agent.run_id": "run-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      runtime: "pi",
      model: "openai:gpt-5",
      status: "completed",
      attempt: 1,
      ...overrides,
    },
    body: { prompt: "sensitive-body" },
  };
}

export function largeRecord(name: string): ExportRecord {
  return {
    ...record(name),
    attributes: { payload: "x".repeat(500) },
  };
}

export function errorChain(value: unknown): string {
  const messages: string[] = [];
  let current = value;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

export function errorCodes(value: unknown): readonly unknown[] {
  const codes: unknown[] = [];
  let current = value;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    codes.push(Reflect.get(current, "code"));
    current = current.cause;
  }
  return codes;
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}
