import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordedRunListItem } from "@mono-agent/observability";

import { printAppStatus } from "../cli.js";
import type { ExporterStatus, MonoAgentApp, SandboxStatus, TraceabilityStatus } from "../app.js";
import type { ChannelId, ChannelStatus } from "../channels.js";

const OFF_SANDBOX_STATUS: SandboxStatus = {
  configured: false,
  configuredMode: undefined,
  effective: "off",
  engine: undefined,
  engineAvailable: undefined,
  fallback: undefined,
  fallbackActive: false,
  unsafeAllowHostProcess: false,
  detail: "Sandbox is off; commands run without mono-agent sandbox wrapping.",
};

function fakeApp(
  exporterStatus: ExporterStatus,
  traceabilityStatus?: TraceabilityStatus,
  selectedSkills: readonly string[] = [],
  sandboxStatus: SandboxStatus = OFF_SANDBOX_STATUS,
): MonoAgentApp {
  return {
    configPath: "/work/demo/mono-agent.config.json",
    traceabilityStatus: traceabilityStatus ?? {
      kind: "running",
      sourceId: "mono-agent-abc",
      registryDir: "/home/u/.mono-agent/trace-sources",
      artifactDir: "/work/demo/.mono-agent/artifacts",
    },
    exporterStatus,
    sandboxStatus,
    selectedSkills,
    channelStatus: () => ({ kind: "disabled", reason: "n/a" }),
    channelStatuses: () => new Map<ChannelId, ChannelStatus>(),
    startChannelIfConfigured: async () => ({ kind: "disabled", reason: "n/a" }),
    applyConfigChange: async () => ({ kind: "applied", message: "ok", transports: [] }),
    stop: async () => undefined,
  };
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

async function captureStatus(
  app: MonoAgentApp,
  runs: readonly RecordedRunListItem[] = [],
  totalRuns = runs.length,
): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  restore = () => spy.mockRestore();
  await printAppStatus(app, {
    nowMs: Date.parse("2026-06-24T08:00:00.000Z"),
    listRecordedRuns: async (options) => {
      expect(options.scope).toBe("agent");
      return { totalRuns, runs, warnings: [] };
    },
  });
  return chunks.join("");
}

describe("printAppStatus exporter line", () => {
  it("prints the configured exporter endpoint, app url, and local-artifacts note", async () => {
    const out = await captureStatus(
      fakeApp({ kind: "configured", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false }),
    );
    expect(out).toContain("observability");
    expect(out).toContain("http://127.0.0.1:6006/v1/traces");
    expect(out).toContain("app http://127.0.0.1:6006");
    expect(out).toContain("JSONL artifacts remain local at /work/demo/.mono-agent/artifacts");
    expect(out).not.toContain("[WARN] includeSensitiveData=true");
  });

  it("prints a warning when sensitive data export is enabled", async () => {
    const endpoint = "http://127.0.0.1:6006/v1/traces";
    const out = await captureStatus(
      fakeApp({ kind: "configured", endpoint, includeSensitiveData: true }),
    );
    expect(out).toContain("[WARN] includeSensitiveData=true");
    expect(out).toContain(endpoint);
    expect(out).toContain("user input");
    expect(out).toContain("assistant replies");
    expect(out).toContain("tool args/results");
    expect(out).toContain("system prompt");
  });

  it("prints a disabled exporter line when no exporter is configured", async () => {
    const out = await captureStatus(fakeApp({ kind: "disabled", reason: "No observability exporter configured." }));
    expect(out).toContain("observability");
    expect(out).toContain("disabled: No observability exporter configured.");
  });

  it("prints effective sandbox state and unsafe fallback warning", async () => {
    const out = await captureStatus(
      fakeApp(
        { kind: "disabled", reason: "No observability exporter configured." },
        undefined,
        [],
        {
          configured: true,
          configuredMode: "native",
          effective: "unsafe-host-process",
          engine: "srt",
          engineAvailable: false,
          fallback: "unsafe-host-process",
          fallbackActive: true,
          unsafeAllowHostProcess: true,
          detail:
            "Sandbox unsafe-host-process fallback is active because engine \"srt\" is unavailable; all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
          warning:
            "WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
        },
      ),
    );

    expect(out).toContain("sandbox");
    expect(out).toContain("effective: unsafe-host-process");
    expect(out).toContain("engine: srt (absent)");
    expect(out).toContain("fallback active: yes");
    expect(out).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(out).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");
  });

  it("prints active skills and compact recent runs for foreground status", async () => {
    const out = await captureStatus(
      fakeApp(
        { kind: "configured", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false },
        undefined,
        ["context-example", "todoist-cli"],
      ),
      [
        makeRun({
          runId: "run-usage",
          status: "failed",
          failureKind: "usage_limit",
          updatedAt: "2026-06-24T07:55:00.000Z",
        }),
        makeRun({
          runId: "run-ok",
          status: "succeeded",
          updatedAt: "2026-06-24T07:58:30.000Z",
        }),
      ],
      12,
    );

    expect(out).toContain("runs health");
    expect(out).toContain("Active skills: context-example, todoist-cli.");
    expect(out).toContain("Recorded runs: 12 total; showing 2 recent (max 50).");
    expect(out).toContain("Last runs: run-usage failed 5m ago, run-ok succeeded 1m ago.");
    expect(out).toContain("[WARN] Failure kinds: usage_limit=1.");
  });
});

function makeRun(overrides: Partial<RecordedRunListItem>): RecordedRunListItem {
  return {
    runId: "run",
    conversationId: "chat",
    status: "succeeded",
    durationMs: 1000,
    eventCount: 1,
    updatedAt: "2026-06-24T08:00:00.000Z",
    ...overrides,
  };
}
