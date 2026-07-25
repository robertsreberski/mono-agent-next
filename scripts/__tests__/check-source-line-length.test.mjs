import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SOURCE_LINE_LENGTH_MAXIMUM,
  SOURCE_LINE_LENGTH_PATHS,
  collectSourceLineLengthFindings,
  runCheckSourceLineLength,
} from "../check-source-line-length.mjs";

describe("check-source-line-length", () => {
  it("checks exactly the two audited Core source files", () => {
    expect(SOURCE_LINE_LENGTH_PATHS).toEqual([
      "packages/core/src/current-run-output.ts",
      "packages/core/src/state-execution-client.ts",
    ]);
    expect(SOURCE_LINE_LENGTH_MAXIMUM).toBe(140);
  });

  it("accepts a line at the exact maximum", () => {
    const sources = new Map(SOURCE_LINE_LENGTH_PATHS.map((path) => [
      path,
      path === SOURCE_LINE_LENGTH_PATHS[0]
        ? `${"x".repeat(SOURCE_LINE_LENGTH_MAXIMUM)}\n`
        : "short\n",
    ]));

    expect(collectSourceLineLengthFindings(fixtureOptions(sources))).toEqual([]);
  });

  it("reports each overlong line and returns a failing status", () => {
    const sources = new Map(SOURCE_LINE_LENGTH_PATHS.map((path) => [
      path,
      path === SOURCE_LINE_LENGTH_PATHS[1]
        ? `short\n${"x".repeat(SOURCE_LINE_LENGTH_MAXIMUM + 1)}\n`
        : "short\n",
    ]));
    const stdout = sink();

    const result = runCheckSourceLineLength({
      ...fixtureOptions(sources),
      stdout,
    });

    expect(result).toEqual({
      exitCode: 1,
      findings: [{
        path: SOURCE_LINE_LENGTH_PATHS[1],
        line: 2,
        length: SOURCE_LINE_LENGTH_MAXIMUM + 1,
      }],
    });
    expect(stdout.text).toContain(
      `${SOURCE_LINE_LENGTH_PATHS[1]}:2 has 141 characters (maximum 140)`,
    );
  });
});

function fixtureOptions(sources) {
  const cwd = "/repo";
  return {
    cwd,
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
