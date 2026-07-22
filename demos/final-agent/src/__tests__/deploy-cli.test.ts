import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const deploymentMocks = vi.hoisted(() => ({
  checkOllamaModel: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock("../deployment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deployment.js")>()),
  checkOllamaModel: deploymentMocks.checkOllamaModel,
}));

import { parseDeployCliArgs } from "../deploy-cli.js";

const DEFAULT_ARGS = Object.freeze({
  model: "gemma4:31b",
  ollamaBaseUrl: "http://localhost:11434",
  noStart: false,
  help: false,
});

const HAPPY_PATH = Object.freeze({
  argv: Object.freeze([
    "--model",
    "  custom-model:latest  ",
    "--ollama-url",
    "  http://127.0.0.1:11435  ",
    "--config",
    "  ./custom-final-agent.json  ",
    "--a2a-port",
    "4317",
    "--no-start",
  ]),
  expected: Object.freeze({
    model: "custom-model:latest",
    ollamaBaseUrl: "http://127.0.0.1:11435",
    configPath: "./custom-final-agent.json",
    a2aPort: 4317,
    noStart: true,
    help: false,
  }),
});

const VALUE_FLAG_FAILURES = Object.freeze([
  Object.freeze({
    label: "--model",
    argv: Object.freeze(["--model"]),
    error: "--model requires a value.",
  }),
  Object.freeze({
    label: "--ollama-url",
    argv: Object.freeze(["--ollama-url", "   "]),
    error: "--ollama-url requires a value.",
  }),
  Object.freeze({
    label: "--config",
    argv: Object.freeze(["--config"]),
    error: "--config requires a value.",
  }),
  Object.freeze({
    label: "--a2a-port",
    argv: Object.freeze(["--a2a-port"]),
    error: "--a2a-port requires a value.",
  }),
]);

const VALID_PORT_BOUNDS = Object.freeze([
  Object.freeze({ label: "lower bound", value: "0", expected: 0 }),
  Object.freeze({ label: "upper bound", value: "65535", expected: 65_535 }),
]);

const INVALID_PORTS = Object.freeze([
  Object.freeze({
    label: "blank",
    value: "   ",
    error: "--a2a-port requires a value.",
  }),
  Object.freeze({
    label: "below the lower bound",
    value: "-1",
    error: "--a2a-port requires a numeric port.",
  }),
  Object.freeze({
    label: "above the upper bound",
    value: "65536",
    error: "--a2a-port must be between 0 and 65535.",
  }),
  Object.freeze({
    label: "non-numeric",
    value: "not-a-port",
    error: "--a2a-port requires a numeric port.",
  }),
  Object.freeze({
    label: "fractional",
    value: "4317.5",
    error: "--a2a-port requires a numeric port.",
  }),
]);

describe("final demo deploy CLI args", () => {
  it("does not execute deployment readiness when imported for argument parsing", () => {
    expect(deploymentMocks.checkOllamaModel).not.toHaveBeenCalled();
  });

  it("executes the actual --help entrypoint without readiness when the direct-run guard matches", async () => {
    const originalArgv = process.argv;
    const scriptPath = fileURLToPath(new URL("../deploy-cli.ts", import.meta.url));
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      process.argv = [process.execPath, scriptPath, "--help"];
      vi.resetModules();
      await import("../deploy-cli.js");
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Usage: pnpm run deploy:final -- [options]");
    expect(logs[0]).toContain("--no-start");
    expect(deploymentMocks.checkOllamaModel).not.toHaveBeenCalled();
  });

  it("parses the complete documented happy path without mutating its fixture", () => {
    expect(parseDeployCliArgs(HAPPY_PATH.argv)).toEqual(HAPPY_PATH.expected);
  });

  it("accepts pnpm's standalone -- separator before deploy options", () => {
    const argv = Object.freeze(["--", "--model", "after-separator", "--a2a-port", "9000"]);

    expect(parseDeployCliArgs(argv)).toEqual({
      ...DEFAULT_ARGS,
      model: "after-separator",
      a2aPort: 9000,
    });
  });

  it("sets --no-start without changing unrelated defaults", () => {
    expect(parseDeployCliArgs(Object.freeze(["--no-start"]))).toEqual({
      ...DEFAULT_ARGS,
      noStart: true,
    });
  });

  it.each(Object.freeze(["--help", "-h"]))("sets help for %s", (flag) => {
    expect(parseDeployCliArgs(Object.freeze([flag]))).toEqual({
      ...DEFAULT_ARGS,
      help: true,
    });
  });

  it.each(VALUE_FLAG_FAILURES)("rejects a missing or blank $label value", ({ argv, error }) => {
    expect(() => parseDeployCliArgs(argv)).toThrowError(new Error(error));
  });

  it.each(VALID_PORT_BOUNDS)("accepts the --a2a-port $label", ({ value, expected }) => {
    expect(parseDeployCliArgs(Object.freeze(["--a2a-port", value]))).toEqual({
      ...DEFAULT_ARGS,
      a2aPort: expected,
    });
  });

  it.each(INVALID_PORTS)("rejects an --a2a-port value $label", ({ value, error }) => {
    expect(() => parseDeployCliArgs(Object.freeze(["--a2a-port", value]))).toThrowError(new Error(error));
  });

  it("rejects unknown arguments with the offending token", () => {
    expect(() => parseDeployCliArgs(Object.freeze(["--bogus"]))).toThrowError(
      new Error("Unknown argument: --bogus"),
    );
  });
});
