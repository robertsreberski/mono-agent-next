// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { HELP_TEXT, parseArgs } from "../bin/cli.js";

describe("parseArgs", () => {
  it("parses the direct endpoint contract", () => {
    expect(parseArgs([
      "--endpoint", "http://127.0.0.1:53210/operator",
      "--token-env", "OWNER_OPERATOR_TOKEN",
      "--conversation", "ops",
      "--runtime", "pi",
      "--model", "openai:gpt-5.6-sol",
      "--effort", "high",
    ])).toEqual({
      endpoint: "http://127.0.0.1:53210/operator",
      tokenEnvironment: "OWNER_OPERATOR_TOKEN",
      conversationId: "ops",
      runtime: "pi",
      model: "openai:gpt-5.6-sol",
      effort: "high",
      registryDirectories: [],
      help: false,
    });
  });

  it("supports repeated discovery roots", () => {
    expect(parseArgs(["--registry", "/one", "--registry", "/two", "--agent", "personal"])).toEqual({
      registryDirectories: ["/one", "/two"],
      operatorId: "personal",
      help: false,
    });
  });

  it("rejects ambiguous or incomplete connection flags", () => {
    expect(parseArgs(["--endpoint", "http://127.0.0.1:1", "--registry", "/tmp/agents"])).toEqual({
      error: "--endpoint and --registry are mutually exclusive",
    });
    expect(parseArgs(["--token-env", "OWNER_OPERATOR_TOKEN"])).toEqual({
      error: "--token-env requires --endpoint",
    });
    expect(parseArgs([
      "--endpoint", "http://127.0.0.1:1/operator", "--token", "raw-secret",
    ])).toEqual({ error: "unknown argument: --token" });
    expect(parseArgs(["--endpoint"])).toEqual({ error: "--endpoint requires a value" });
    expect(parseArgs(["--unknown"])).toEqual({ error: "unknown argument: --unknown" });
  });

  it("documents renderer-only exit semantics", () => {
    expect(parseArgs(["--help"])).toEqual({ registryDirectories: [], help: true });
    expect(HELP_TEXT).toContain("closes only this renderer");
    expect(HELP_TEXT).toContain("required MONO_AGENT_OPERATOR_TOKEN");
    expect(HELP_TEXT).not.toContain("responder");
    expect(HELP_TEXT).not.toContain("configure");
  });
});
