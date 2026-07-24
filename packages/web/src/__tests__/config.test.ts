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
      externalOrigins: [],
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

  it("accepts only an explicit exact no-auth mode without resolving a browser secret", () => {
    const options = { sourcePath: join(tmpdir(), "web.config.json"), environment: {} };
    expect(parseWebConfig({
      configVersion: 1,
      auth: { mode: "none" },
    }, options).auth).toEqual({ mode: "none" });
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: {},
    }, options)).toThrow(/auth\.token.*required/u);
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: { mode: "token" },
    }, options)).toThrow(/auth\.mode.*must equal "none"/u);
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: { mode: "none", token: { $env: "WEB_TEST_TOKEN" } },
    }, options)).toThrow(/must contain only mode/u);
  });

  it("bounds config input before parsing", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "web.config.json");
    await mkdir(root, { recursive: true });
    await writeFile(configPath, `{"padding":"${"x".repeat(1024 * 1024)}"}`);
    await expect(loadWebConfig(configPath)).rejects.toMatchObject({ code: "config_too_large" });
  });

  it("accepts only unique canonical HTTPS external proxy origins", () => {
    const options = {
      sourcePath: join(tmpdir(), "web.config.json"),
      environment: { WEB_TEST_TOKEN: "testtesttesttest" },
    };
    const base = {
      configVersion: 1,
      auth: { token: { $env: "WEB_TEST_TOKEN" } },
    };
    expect(parseWebConfig({
      ...base,
      externalOrigins: ["https://console.example.test"],
    }, options).externalOrigins).toEqual(["https://console.example.test"]);
    expect(() => parseWebConfig({
      ...base,
      externalOrigins: ["http://console.example.test"],
    }, options)).toThrow(/HTTPS origin/u);
    expect(() => parseWebConfig({
      ...base,
      externalOrigins: ["https://console.example.test/path"],
    }, options)).toThrow(/without credentials, path/u);
    expect(() => parseWebConfig({
      ...base,
      externalOrigins: ["https://console.example.test", "https://console.example.test"],
    }, options)).toThrow(/duplicates/u);
  });

  it("exports the strict authoring schema from the executable config contract", () => {
    expect(webConfigJsonSchema.required).toEqual(["configVersion", "auth"]);
    expect(webConfigJsonSchema.additionalProperties).toBe(false);
    expect(webConfigJsonSchema.properties.allowInsecureHttp.default).toBe(false);
    expect(webConfigJsonSchema.properties.externalOrigins.items.pattern).toBe("^https://");
    expect(webConfigJsonSchema.properties.auth.oneOf).toHaveLength(2);
    expect(webConfigJsonSchema.properties.auth.oneOf[0].properties.token.properties.$env.pattern).toContain("A-Za-z_");
    expect(webConfigJsonSchema.properties.auth.oneOf[1].properties.mode.const).toBe("none");
  });
});
