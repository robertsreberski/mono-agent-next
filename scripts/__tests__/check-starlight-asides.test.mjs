import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findEmptyStarlightAsides,
  runStarlightAsideCheck,
} from "../../website/scripts/check-starlight-asides.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-starlight-asides", () => {
  it("finds an opening fence immediately followed by its closing fence", () => {
    expect(findEmptyStarlightAsides([
      "# Page",
      "",
      ":::caution",
      ":::",
      "This paragraph was orphaned by the premature close.",
      "",
    ].join("\n"))).toEqual([{ line: 3, opening: ":::caution" }]);
  });

  it("fails a nested representative pre-fix document with an actionable relative path", () => {
    const docsRoot = temporaryDocs({
      "channels/broken.md": ":::note\n:::\nOrphaned note text.\n",
    });
    const stderr = sink();

    const result = runStarlightAsideCheck({ docsRoot, stdout: sink(), stderr });

    expect(result.exitCode).toBe(1);
    expect(result.matches).toEqual([{
      file: "channels/broken.md",
      line: 1,
      opening: ":::note",
    }]);
    expect(stderr.text).toContain("docs/channels/broken.md:1");
  });

  it("passes a nested document after the paragraph is moved inside the aside", () => {
    const docsRoot = temporaryDocs({
      "runtime/fixed.md": ":::note\nThe note text is inside the fence.\n:::\n",
    });
    const stdout = sink();

    const result = runStarlightAsideCheck({ docsRoot, stdout, stderr: sink() });

    expect(result).toMatchObject({ exitCode: 0, filesChecked: 1, matches: [] });
    expect(stdout.text).toContain("0 empty asides");
  });
});

function temporaryDocs(files) {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-asides-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
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
