// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";

import {
  MINIMUM_NODE_VERSION,
  SUPPORTED_NODE_ENGINE,
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  parseNodeVersion,
} from "../check/node-version.mjs";

describe("Node.js support floor", () => {
  test("keeps the exact v1 minimum and engine range together", () => {
    expect(MINIMUM_NODE_VERSION).toBe("22.19.0");
    expect(SUPPORTED_NODE_ENGINE).toBe(">=22.19.0");
  });

  test.each([
    ["20.20.2", false],
    ["22.18.0", false],
    ["22.19.0", true],
    ["v22.19.0", true],
    ["22.19.1", true],
    ["23.0.0", true],
    ["24.0.0", true],
  ])("classifies %s", (version, supported) => {
    expect(isSupportedNodeVersion(version)).toBe(supported);
  });

  test("fails clearly for an unsupported or malformed version", () => {
    expect(() => assertSupportedNodeVersion("22.18.0")).toThrow(
      /requires Node\.js >=22\.19\.0; current Node\.js is 22\.18\.0/u,
    );
    expect(() => parseNodeVersion("current")).toThrow(/Could not parse Node\.js version/u);
  });
});
