// SPDX-License-Identifier: MIT
import type { JsonObject, JsonValue, ModuleHealth } from "@mono-agent/module-sdk";
import { assertOwnKeys, ownDataRecord, snapshotBoundedValue } from "./bounded-value.js";
import { errorMessage } from "./errors.js";
import type { HostLifecycleCalls } from "./host-lifecycle.js";
import type { RunningModule } from "./host-types.js";
import type { AgentHealth } from "./types.js";

export type HostLifecycleState = "new" | "starting" | "running" | "draining" | "stopped" | "failed";
interface HealthSnapshot {
  readonly state: HostLifecycleState;
  readonly pending: number;
  readonly active: number;
  readonly running: readonly RunningModule[];
}

export class HostHealthMonitor {
  readonly #failures: string[] = [];
  constructor(
    readonly lifecycle: HostLifecycleCalls,
    readonly redact: (message: string) => string,
  ) {}
  record(message: string): void {
    this.#failures.push(this.redact(message).slice(0, 2_048));
    if (this.#failures.length > 50) this.#failures.shift();
  }
  async inspect(snapshot: HealthSnapshot): Promise<AgentHealth> {
    if (snapshot.state === "stopped" || snapshot.state === "failed") return {
      status: "stopped", accepting: false,
      pending: snapshot.pending, active: snapshot.active, modules: [],
    };
    const modules: AgentHealth["modules"][number][] = [];
    let degraded = this.#failures.length > 0;
    for (const running of snapshot.running) {
      if (running.instance.health === undefined) {
        modules.push({ kind: running.loaded.slot, instanceId: running.loaded.instanceId, status: "unknown" });
        continue;
      }
      try {
        const raw = await this.lifecycle.run(
          `${running.loaded.instanceId} health`,
          (signal) => running.instance.health?.({ signal }),
        );
        const health = normalizeModuleHealth(raw, `${running.loaded.instanceId} health`, this.redact);
        if (health.status !== "healthy") degraded = true;
        modules.push({
          kind: running.loaded.slot, instanceId: running.loaded.instanceId, status: health.status,
          detail: health as unknown as JsonObject,
        });
      } catch (error) {
        degraded = true;
        modules.push({
          kind: running.loaded.slot, instanceId: running.loaded.instanceId, status: "unhealthy",
          detail: { message: this.redact(errorMessage(error)) },
        });
      }
    }
    return {
      status: snapshot.state === "draining" ? "stopping" : degraded ? "degraded" : "healthy",
      accepting: snapshot.state === "running",
      pending: snapshot.pending, active: snapshot.active, modules,
    };
  }
}

export function normalizeModuleHealth(
  value: unknown, path: string, redact: (value: string) => string,
): ModuleHealth {
  const input = ownDataRecord(normalizeModuleJson(value, path, redact), path);
  assertOwnKeys(input, ["status", "checkedAt", "summary", "details"], path);
  if (!["healthy", "degraded", "unhealthy", "unknown"].includes(String(input.status)))
    throw new TypeError(`${path}.status is invalid`);
  if (typeof input.checkedAt !== "string" || input.checkedAt.length === 0)
    throw new TypeError(`${path}.checkedAt must be non-empty`);
  if (input.summary !== undefined && typeof input.summary !== "string")
    throw new TypeError(`${path}.summary must be text`);
  if (input.details !== undefined
    && (typeof input.details !== "object" || input.details === null || Array.isArray(input.details)))
    throw new TypeError(`${path}.details must be a JSON object`);
  return {
    status: input.status as ModuleHealth["status"], checkedAt: input.checkedAt,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.details === undefined ? {} : { details: input.details as JsonObject }),
  };
}
export function normalizeModuleJson(
  value: unknown, path: string, redact: (value: string) => string,
): JsonValue {
  const options = {
    path, maxBytes: 1024 * 1024, maxItems: 10_000, maxDepth: 32, label: "JSON",
    requireEnumerable: true, requireOrdinaryArrays: true,
  } as const;
  const snapshot = snapshotBoundedValue<JsonValue>(value, options).value;
  return snapshotBoundedValue<JsonValue>(redactJson(snapshot, redact), options).value;
}
export function redactJson(value: JsonValue, redact: (value: string) => string): JsonValue {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, redact));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [redact(key), redactJson(entry, redact)]));
}
/**
 * The module's own health summary, if it supplied one.
 *
 * Core stores the normalized ModuleHealth under `detail`; the operator
 * projection needs the module's sentence, not a recomputed counter.
 */
export function moduleHealthSummary(detail: JsonValue | undefined): string | undefined {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const summary = (detail as JsonObject).summary;
  return typeof summary === "string" && summary.length > 0 ? summary : undefined;
}
export function channelHealthProjection(
  health: AgentHealth, checkedAt = new Date().toISOString()): ModuleHealth {
  const unhealthy = health.modules.filter((module) => module.status !== "healthy");
  return {
    status: health.status === "healthy"
      ? "healthy"
      : health.status === "degraded" || health.status === "stopping"
        ? "degraded"
        : "unhealthy",
    checkedAt,
    summary: unhealthy.length === 0
      ? `${health.active} active, ${health.pending} pending`
      : unhealthy
          .map((module) => `${module.instanceId} ${module.status}${
            moduleHealthSummary(module.detail) === undefined
              ? ""
              : `: ${moduleHealthSummary(module.detail)!}`
          }`)
          .join("; "),
    details: {
      accepting: health.accepting,
      active: health.active,
      pending: health.pending,
      modules: health.modules.map((module) => ({
        kind: module.kind,
        instanceId: module.instanceId,
        status: module.status,
        ...(moduleHealthSummary(module.detail) === undefined
          ? {}
          : { summary: moduleHealthSummary(module.detail)! }),
      })),
    },
  };
}
