import type { MonoAgentConfig } from "@mono-agent/config";
import { listRecordedRuns } from "@mono-agent/observability";
import { serializeTraceSpans } from "@mono-agent/observability/otel";

import {
  describeSensitiveDataExportWarning,
  isAppCoreConfigError,
  phoenixAppBaseUrl,
  resolveAppArtifactDir,
  resolveAppObservabilityExporters,
} from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { ValidationSection } from "./doctor-types.js";
import { buildRunsHealthDisplay, RUNS_HEALTH_MAX_RUNS } from "./runs-health.js";

const EXPORTER_PROBE_TIMEOUT_MS = 3_000;
const LOCAL_ARTIFACTS_NOTE = "JSONL artifacts remain local (the exporter is additive; export failures never affect them).";

export async function runsSection(
  input: MonoAgentAppConfigInput,
  config: MonoAgentConfig | undefined,
): Promise<ValidationSection> {
  const artifactDir = await resolveAppArtifactDir(input);
  const { totalRuns, runs, warnings } = await listRecordedRuns({
    artifactDir,
    maxRuns: RUNS_HEALTH_MAX_RUNS,
    scope: "agent",
  });
  const display = buildRunsHealthDisplay({ artifactDir, totalRuns, runs, warnings });
  const retentionDetails = config === undefined
    ? []
    : [
        `Artifact retention: maxAgeDays=${config.artifacts.retention.maxAgeDays}, maxCount=${config.artifacts.retention.maxCount}, dryRun=${config.artifacts.retention.dryRun ? "true" : "false"}.`,
        `Memory artifact retention: maxAgeDays=${config.artifacts.memoryRetention.maxAgeDays}, maxCount=${config.artifacts.memoryRetention.maxCount}, dryRun=${config.artifacts.memoryRetention.dryRun ? "true" : "false"}.`,
      ];
  return { id: "runs", label: "Runs health", status: display.status, details: [...retentionDetails, ...display.details] };
}

/** Validate exporter shape and optionally probe the exact OTLP protobuf endpoint. */
export async function exporterSection(
  input: MonoAgentAppConfigInput,
  liveness: boolean,
): Promise<ValidationSection> {
  let exporters;
  try {
    exporters = await resolveAppObservabilityExporters(input);
  } catch (error) {
    if (!isAppCoreConfigError(error)) throw error;
    return { id: "observability", label: "Observability exporter", status: "error", details: [error.message] };
  }

  if (exporters.length === 0) {
    return {
      id: "observability",
      label: "Observability exporter",
      status: "disabled",
      details: ["No observability exporter configured."],
    };
  }

  const exporter = exporters[0]!;
  const details: string[] = [`Exporter: ${exporter.type} -> ${exporter.endpoint}`];
  const appUrl = phoenixAppBaseUrl(exporter.endpoint);
  if (appUrl !== undefined) details.push(`Phoenix app: ${appUrl}`);
  if (exporter.includeSensitiveData) details.push(describeSensitiveDataExportWarning(exporter.endpoint));

  if (!liveness) {
    details.push(LOCAL_ARTIFACTS_NOTE);
    return { id: "observability", label: "Observability exporter", status: "ok", details };
  }

  const probeError = await probeExporterEndpoint(exporter.endpoint);
  if (probeError !== undefined) {
    details.push(
      `[WARN] Phoenix export not confirmed at ${exporter.endpoint} (${probeError}); exports will fail until it accepts OTLP protobuf. This is non-fatal.`,
      LOCAL_ARTIFACTS_NOTE,
    );
    return { id: "observability", label: "Observability exporter", status: "waiting", details };
  }

  details.push(LOCAL_ARTIFACTS_NOTE);
  return { id: "observability", label: "Observability exporter", status: "ok", details };
}

async function probeExporterEndpoint(endpoint: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, EXPORTER_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: serializeTraceSpans([]),
      signal: controller.signal,
    });
    return response.ok ? undefined : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
}
