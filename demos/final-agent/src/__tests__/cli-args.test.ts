import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../cli-args.js";

describe("final demo CLI args", () => {
  it("accepts pnpm's standalone -- separator before demo options", () => {
    expect(parseCliArgs(["--", "--config", "./mono-agent.config.json"], "/repo")).toEqual({
      help: false,
      configPath: resolve("/repo", "./mono-agent.config.json"),
    });
  });

  it("resolves config paths from the supplied cwd", () => {
    expect(parseCliArgs(["--config", "./mono-agent.config.json"], "/repo")).toEqual({
      help: false,
      configPath: resolve("/repo", "./mono-agent.config.json"),
    });
  });

  it("rejects unknown arguments honestly", () => {
    expect(() => parseCliArgs(["--bogus"], "/repo")).toThrow(/Unknown argument: --bogus/u);
  });
});
