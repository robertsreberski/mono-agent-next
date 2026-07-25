// SPDX-License-Identifier: MIT
import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SOURCE_LINE_LENGTH_EXEMPTIONS,
  SOURCE_LINE_LENGTH_MAXIMUM,
  collectSourceLineLengthFindings,
  listProductionSourcePaths,
  runCheckSourceLineLength,
} from "../check/source-line-length.mjs";

const AUDITED = "packages/core/src/state-execution-client.ts";
const CLEAN = "packages/core/src/effort.ts";

describe("check-source-line-length", () => {
  it("covers every production source file, not a hand-picked pair", () => {
    // The gate previously named exactly two files, so the 140-character limit
    // was not repo-wide and nothing stopped a new file exceeding it.
    const paths = listProductionSourcePaths(process.cwd());

    expect(paths.length).toBeGreaterThan(250);
    expect(paths).toContain(AUDITED);
    expect(paths.some((path) => path.includes("/__tests__/"))).toBe(false);
    expect(paths.some((path) => /\.test\.tsx?$/u.test(path))).toBe(false);
    expect(SOURCE_LINE_LENGTH_MAXIMUM).toBe(140);
  });

  it("keeps the exemption list sorted, unique, and inside the covered set", () => {
    const covered = new Set(listProductionSourcePaths(process.cwd()));

    expect([...SOURCE_LINE_LENGTH_EXEMPTIONS]).toEqual([...SOURCE_LINE_LENGTH_EXEMPTIONS].sort());
    expect(new Set(SOURCE_LINE_LENGTH_EXEMPTIONS).size).toBe(SOURCE_LINE_LENGTH_EXEMPTIONS.length);
    expect(SOURCE_LINE_LENGTH_EXEMPTIONS.filter((path) => !covered.has(path))).toEqual([]);
  });

  it("accepts a line at the exact maximum", () => {
    expect(collectSourceLineLengthFindings(fixtureOptions(
      new Map([[CLEAN, `${"x".repeat(SOURCE_LINE_LENGTH_MAXIMUM)}\n`]]),
      [CLEAN],
      [],
    ))).toEqual([]);
  });

  it("reports each overlong line and returns a failing status", () => {
    const stdout = sink();
    const result = runCheckSourceLineLength({
      ...fixtureOptions(
        new Map([[CLEAN, `short\n${"x".repeat(SOURCE_LINE_LENGTH_MAXIMUM + 1)}\n`]]),
        [CLEAN],
        [],
      ),
      stdout,
    });

    expect(result).toEqual({
      exitCode: 1,
      findings: [{ path: CLEAN, line: 2, length: SOURCE_LINE_LENGTH_MAXIMUM + 1 }],
    });
    expect(stdout.text).toContain(`${CLEAN}:2 has 141 characters (maximum 140)`);
  });

  it("tolerates an overlong line only in an exempted file", () => {
    expect(collectSourceLineLengthFindings(fixtureOptions(
      new Map([[AUDITED, `${"x".repeat(SOURCE_LINE_LENGTH_MAXIMUM + 1)}\n`]]),
      [AUDITED],
      [AUDITED],
    ))).toEqual([]);
  });

  it("fails an exemption whose file no longer exceeds the limit", () => {
    // The list may only shrink. Without this a file could be cleaned and its
    // exemption left behind, quietly re-permitting the next violation in it.
    const stdout = sink();
    const result = runCheckSourceLineLength({
      ...fixtureOptions(new Map([[AUDITED, "short\n"]]), [AUDITED], [AUDITED]),
      stdout,
    });

    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual([{
      path: AUDITED,
      line: 0,
      length: 0,
      staleExemption: true,
    }]);
    expect(stdout.text).toContain(
      `${AUDITED} no longer exceeds the limit; remove it from SOURCE_LINE_LENGTH_EXEMPTIONS`,
    );
  });
});

function fixtureOptions(sources, paths, exemptions) {
  const cwd = "/repo";
  return {
    cwd,
    paths,
    exemptions,
    readFile(path) {
      const source = sources.get(relative(cwd, path));
      if (source === undefined) throw new Error(`Unexpected source path ${path}`);
      return source;
    },
  };
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
