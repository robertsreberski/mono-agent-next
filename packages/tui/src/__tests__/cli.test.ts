import { fileURLToPath } from "node:url";

import type { AgentMessageStream, AgentRequestBase } from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HELP_TEXT, loadResponder, parseArgs } from "../bin/cli.js";

const defaultFixture = fileURLToPath(new URL("./fixtures/responder-default.mjs", import.meta.url));
const factoryFixture = fileURLToPath(new URL("./fixtures/responder-factory.mjs", import.meta.url));
const invalidFixture = fileURLToPath(new URL("./fixtures/responder-invalid.mjs", import.meta.url));
const invalidFactoryFixture = fileURLToPath(
  new URL("./fixtures/responder-invalid-factory.mjs", import.meta.url),
);

function request(text: string): AgentRequestBase {
  return {
    conversationId: "aud-062",
    text,
    abortSignal: new AbortController().signal,
  };
}

const stream: AgentMessageStream = {
  append: async () => {},
};

afterEach(() => {
  delete process.env.AUD062_RESPONDER_MARKER;
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("parses in-process mode flags (legacy surface preserved)", () => {
    expect(
      parseArgs(["--responder", "./responder.js", "--config", "./mono-agent.config.json", "--title", "T", "--conversation", "c1"]),
    ).toEqual({
      help: false,
      responder: "./responder.js",
      config: "./mono-agent.config.json",
      title: "T",
      conversationId: "c1",
    });
  });

  it("parses remote mode flags", () => {
    expect(parseArgs(["--url", "http://127.0.0.1:5000/gui", "--api-key", "k"])).toEqual({
      help: false,
      url: "http://127.0.0.1:5000/gui",
      apiKey: "k",
    });
  });

  it("parses discovery flags and bare invocation", () => {
    expect(parseArgs([])).toEqual({ help: false });
    expect(parseArgs(["--registry-dir", "/tmp/registry"])).toEqual({
      help: false,
      registryDir: "/tmp/registry",
    });
  });

  it("rejects mixing --responder with --url", () => {
    expect(parseArgs(["--responder", "a.js", "--url", "http://x"])).toEqual({
      error: "--responder and --url are mutually exclusive",
    });
  });

  it("rejects flags missing their value and unknown flags", () => {
    expect(parseArgs(["--url"])).toEqual({ error: "--url requires a value" });
    expect(parseArgs(["--nope"])).toEqual({ error: "unknown argument: --nope" });
  });

  it("parses help", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });
});

describe("loadResponder", () => {
  it("loads and executes a default-exported responder fixture", async () => {
    const responder = await loadResponder(defaultFixture, undefined);

    await expect(responder.respond(request("hello"), stream)).resolves.toEqual({
      text: "default responder: hello",
    });
  });

  it("calls an async factory with a copied environment, cwd, and the config path", async () => {
    process.env.AUD062_RESPONDER_MARKER = "from parent process";
    const configPath = "./mono-agent.config.json";

    const responder = await loadResponder(factoryFixture, configPath);
    const response = await responder.respond(request("factory prompt"), stream);

    expect(JSON.parse(response.text ?? "{}")).toEqual({
      marker: "from parent process",
      cwd: process.cwd(),
      configPath,
      prompt: "factory prompt",
    });
    expect(process.env.AUD062_RESPONDER_MARKER).toBe("from parent process");
  });

  it("reports missing and malformed responder modules through the CLI error contract", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${String(code)}`);
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const missing = fileURLToPath(new URL("./fixtures/does-not-exist.mjs", import.meta.url));

    await expect(loadResponder(missing, undefined)).rejects.toThrow("process.exit:2");
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      `mono-agent-tui: responder file not found: ${missing}`,
    );
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(HELP_TEXT);

    stderr.mockClear();
    await expect(loadResponder(invalidFixture, undefined)).rejects.toThrow("process.exit:2");
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      `module ${invalidFixture} did not export a default AgentResponderLike or createResponder().`,
    );

    stderr.mockClear();
    await expect(loadResponder(invalidFactoryFixture, undefined)).rejects.toThrow("process.exit:2");
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      `createResponder() from module ${invalidFactoryFixture} did not return an AgentResponderLike.`,
    );
    expect(exit).toHaveBeenCalledTimes(3);
  });
});
