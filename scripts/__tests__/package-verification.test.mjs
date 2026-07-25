// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { findPackageVerificationErrors } from "../lib/package-verification.mjs";

describe("publishable package verification contract", () => {
  it("accepts independent build, typecheck, and non-vacuous test scripts", () => {
    expect(findPackageVerificationErrors({
      packagePath: "packages/example",
      manifest: {
        scripts: {
          build: "tsc -p tsconfig.build.json",
          typecheck: "tsc -p tsconfig.json --noEmit",
          test: "vitest run --expect.requireAssertions",
        },
      },
    })).toEqual([]);
  });

  it("reports every missing verification lane", () => {
    expect(findPackageVerificationErrors({
      packagePath: "packages/example",
      manifest: { scripts: { build: " " } },
    })).toEqual([
      "packages/example/package.json must define a non-empty build script.",
      "packages/example/package.json must define a non-empty typecheck script.",
      "packages/example/package.json must define a non-empty test script.",
    ]);
  });

  it("rejects Vitest's successful no-test escape hatch", () => {
    expect(findPackageVerificationErrors({
      packagePath: "extras/example",
      manifest: {
        scripts: {
          build: "tsc",
          typecheck: "tsc --noEmit",
          test: "vitest run --passWithNoTests --expect.requireAssertions src/__tests__",
        },
      },
    })).toEqual([
      "extras/example/package.json test script must fail when no tests are discovered.",
    ]);
  });
});
