// SPDX-License-Identifier: MIT
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
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
      allowedHosts: [],
      externalOrigins: [],
      sourcePath: configPath,
    });
  });

  it("accepts exactly token authentication or explicit no-auth mode", () => {
    const sourcePath = join(tmpdir(), "web.config.json");
    expect(parseWebConfig({
      configVersion: 1,
      auth: { mode: "none" },
    }, { sourcePath, environment: {} }).auth).toEqual({ mode: "none" });

    const token = { token: { $env: "WEB_TEST_TOKEN" } };
    const options = { sourcePath, environment: { WEB_TEST_TOKEN: "testtesttesttest" } };
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: { ...token, mode: "none" },
    }, options)).toThrow(/exactly one/u);
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: { mode: "token" },
    }, options)).toThrow(/token authentication or mode/u);
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: { mode: "none", fallback: true },
    }, options)).toThrow(/unknown field/u);
    expect(() => parseWebConfig({
      configVersion: 1,
      auth: {},
    }, options)).toThrow(/token authentication or mode/u);
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

  it("normalizes and deduplicates exact direct-listener hostnames and IPs", () => {
    const base = { configVersion: 1, auth: { mode: "none" } };
    const options = { sourcePath: join(tmpdir(), "web.config.json"), environment: {} };

    expect(parseWebConfig({
      ...base,
      allowedHosts: [
        "Personal.Tailnet.TS.NET",
        "personal.tailnet.ts.net",
        "2001:DB8:0:0::1",
        "2001:db8::1",
        "::ffff:192.0.2.1",
      ],
    }, options).allowedHosts).toEqual([
      "personal.tailnet.ts.net",
      "2001:db8::1",
      "::ffff:c000:201",
    ]);

    for (const host of [
      "https://personal.tailnet.ts.net",
      "user@personal.tailnet.ts.net",
      "personal.tailnet.ts.net/path",
      "*.tailnet.ts.net",
      "personal.tailnet.ts.net:5050",
      "[personal.tailnet.ts.net]",
      "[127.0.0.1]",
      "[2001:db8::1]",
      "0.0.0.0",
      "::",
      "bad..host",
      "999.1.1.1",
      "fe80::1%en0",
    ]) {
      expect(() => parseWebConfig({ ...base, allowedHosts: [host] }, options)).toThrow(/allowedHosts/u);
    }
  });

  it("canonicalizes IPv6 listener spellings at config load", () => {
    const base = { configVersion: 1, auth: { mode: "none" } };
    const options = { sourcePath: join(tmpdir(), "web.config.json"), environment: {} };
    for (const [host, expected] of [
      ["0:0:0:0:0:0:0:1", "::1"],
      ["[0:0:0:0:0:0:0:0]", "::"],
      ["FD00:0:0:0:0:0:0:1", "fd00::1"],
    ] as const) {
      expect(parseWebConfig({
        ...base,
        listen: { host, port: 5050 },
      }, options).listen.host).toBe(expected);
    }
    expect(() => parseWebConfig({
      ...base,
      listen: { host: "fe80::1%en0", port: 5050 },
    }, options)).toThrow(/listen\.host.*interface zone/u);
  });

  it("exports the strict authoring schema from the executable config contract", () => {
    expect(webConfigJsonSchema.required).toEqual(["configVersion", "auth"]);
    expect(webConfigJsonSchema.additionalProperties).toBe(false);
    expect(webConfigJsonSchema.properties.allowInsecureHttp.default).toBe(false);
    expect(webConfigJsonSchema.properties.allowedHosts.default).toEqual([]);
    const allowedHostSchema = webConfigJsonSchema.properties.allowedHosts.items;
    const allowedHostPatterns = allowedHostSchema.oneOf
      .map((branch) => new RegExp(branch.pattern, "u"));
    const allowedHostFormats = allowedHostSchema.oneOf
      .map((branch) => branch.format);
    const forbiddenAllowedHosts = new Set<string>(allowedHostSchema.not.enum);
    const schemaAllows = (host: string): boolean =>
      !forbiddenAllowedHosts.has(host)
      && allowedHostPatterns.some((pattern, index) => {
        if (!pattern.test(host)) return false;
        const format = allowedHostFormats[index];
        if (format === "ipv4") return isIP(host) === 4;
        if (format === "ipv6") return isIP(host) === 6;
        return format === "hostname";
      });
    expect(schemaAllows("personal.tailnet.ts.net")).toBe(true);
    expect(schemaAllows("2001:db8::1")).toBe(true);
    expect(schemaAllows("::ffff:192.0.2.1")).toBe(true);
    for (const forbidden of [
      "https://personal.tailnet.ts.net",
      "user@personal.tailnet.ts.net",
      "personal.tailnet.ts.net/path",
      "*.tailnet.ts.net",
      "personal.tailnet.ts.net:5050",
      "face:5050",
      "0.0.0.0",
      "::",
      "[::]",
      "bad..host",
      "1:2:3:4:5:6:7:8:9",
      "0:0:0:0:0:0:0:0",
      "0::",
      "::0",
      "0:0::",
      "123",
      "1.2.3",
    ]) {
      expect(schemaAllows(forbidden)).toBe(false);
    }
    expect(webConfigJsonSchema.properties.externalOrigins.items.pattern).toBe("^https://");
    expect(webConfigJsonSchema.properties.auth.oneOf).toHaveLength(2);
    expect(webConfigJsonSchema.properties.auth.oneOf[0].properties.token.properties.$env.pattern).toContain("A-Za-z_");
    expect(webConfigJsonSchema.properties.auth.oneOf[1].properties.mode.const).toBe("none");
  });
});
