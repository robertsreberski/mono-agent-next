import { describe, expect, it } from "vitest";

import {
  parseManagedRuntimeAttestationProbeArgs,
  runManagedRuntimeAttestationProbe,
} from "../managed-runtime-attestation-probe.mjs";

function sink() {
  let text = "";
  return {
    write(chunk) { text += String(chunk); },
    get text() { return text; },
  };
}

describe("managed runtime attestation probe", () => {
  it("fails closed before imports for malformed or relative private inputs", async () => {
    const out = sink();
    const result = await runManagedRuntimeAttestationProbe([
      "/repo",
      "/runtime/cli.js",
      "/agent",
      "relative-config.json",
      "",
      "private_snapshot",
      "137",
    ], out, { HOME: "/home/u" });
    expect(result).toBe(1);
    expect(out.text).toBe('{"schemaVersion":1,"status":"unsafe"}\n');
    expect(out.text).not.toContain("relative-config");
    expect(out.text).not.toContain("private_snapshot");
  });

  it("does not trust or require ambient HOME when validating arguments", () => {
    expect(parseManagedRuntimeAttestationProbeArgs([
      "/missing/deploy",
      "/missing/runtime/cli.js",
      "/missing/agent",
      "/missing/agent/mono-agent.config.json",
      "",
      "approved_snapshot",
      "137",
    ])).toEqual({
      repo: "/missing/deploy",
      runtimeCliPath: "/missing/runtime/cli.js",
      cwd: "/missing/agent",
      configPath: "/missing/agent/mono-agent.config.json",
      envFile: "",
      expectedSnapshot: "approved_snapshot",
      nodeAbi: "137",
    });
  });
});
