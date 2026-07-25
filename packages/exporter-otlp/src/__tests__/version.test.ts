// SPDX-License-Identifier: MIT
import packageManifest from "../../package.json" with { type: "json" };

import { describe, expect, it } from "vitest";

import { monoAgentModule } from "../index.js";
import { OTLP_INSTRUMENTATION_SCOPE } from "../otlp.js";
import { PACKAGE_VERSION } from "../version.js";
import {
  createExporter,
  record,
  ScriptedTransport,
  signal,
} from "./helpers.js";

describe("package version", () => {
  it("keeps the manifest, OTLP scope, and user agent aligned with package.json", async () => {
    expect(PACKAGE_VERSION).toBe(packageManifest.version);
    expect(monoAgentModule.manifest.packageVersion).toBe(packageManifest.version);
    expect(OTLP_INSTRUMENTATION_SCOPE.version).toBe(packageManifest.version);

    const transport = new ScriptedTransport(() => ({ status: 200, headers: {} }));
    const exporter = createExporter(transport);
    await exporter.export({ records: [record("version")], signal });
    await exporter.flush(signal);

    expect(transport.requests[0]?.headers["user-agent"])
      .toBe(`mono-agent-exporter-otlp/${packageManifest.version}`);
    await exporter.stop({ signal, reason: "shutdown" });
  });
});
