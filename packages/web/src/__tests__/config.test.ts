import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadWebConfig, parseWebConfig, webConfigJsonSchema } from "../config.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

afterEach(cleanup);

describe("web product config", () => {
  it("loads a strict independent config and resolves paths from the config file", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "web.config.json");
    await writeFile(configPath, JSON.stringify({
      $schema: "./web.config.schema.json",
      configVersion: 1,
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: { $env: "WEB_TEST_TOKEN" } },
      dataDirectory: "./private/web",
      agentRegistries: ["./agent-a/registry", "../shared/registry"],
    }));

    await expect(loadWebConfig(configPath, {
      environment: { WEB_TEST_TOKEN: "testtesttesttest" },
    })).resolves.toEqual({
      configVersion: 1,
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: "testtesttesttest" },
      allowInsecureHttp: false,
      dataDirectory: join(root, "private", "web"),
      agentRegistries: [join(root, "agent-a", "registry"), join(root, "..", "shared", "registry")],
      sourcePath: configPath,
    });
  });

  it("rejects unknown fields, literal secrets, and missing environment secrets", () => {
    const base = {
      configVersion: 1,
      auth: { token: { $env: "WEB_TEST_TOKEN" } },
    };
    const options = { sourcePath: join(tmpdir(), "web.config.json"), environment: { WEB_TEST_TOKEN: "testtesttesttest" } };

    expect(() => parseWebConfig({ ...base, mystery: true }, options)).toThrow(/unknown field/u);
    expect(() => parseWebConfig({ ...base, auth: { token: "committed-secret" } }, options)).toThrow(/must be an object/u);
    expect(() => parseWebConfig({ ...base, allowInsecureHttp: "yes" }, options)).toThrow(/must be a boolean/u);
    expect(() => parseWebConfig(base, { ...options, environment: {} })).toThrow(/must contain at least 16/u);
    expect(() => parseWebConfig({ ...base, listen: { host: "bad/host", port: 5050 } }, options)).toThrow(/listen\.host/u);
  });

  it("bounds config input before parsing", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "web.config.json");
    await mkdir(root, { recursive: true });
    await writeFile(configPath, `{"padding":"${"x".repeat(1024 * 1024)}"}`);
    await expect(loadWebConfig(configPath)).rejects.toMatchObject({ code: "config_too_large" });
  });

  it("exports the strict authoring schema from the executable config contract", () => {
    expect(webConfigJsonSchema.required).toEqual(["configVersion", "auth"]);
    expect(webConfigJsonSchema.additionalProperties).toBe(false);
    expect(webConfigJsonSchema.properties.allowInsecureHttp.default).toBe(false);
    expect(webConfigJsonSchema.properties.auth.properties.token.properties.$env.pattern).toContain("A-Za-z_");
  });
});
