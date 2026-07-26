// SPDX-License-Identifier: MIT
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentConfigError } from "../errors.js";
import { readAuthorityText } from "../host-instructions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host instructions", () => {
  it("classifies an authority size overflow with its exact observed byte count", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-instructions-"));
    roots.push(root);
    const path = join(root, "SKILL.md");
    await writeFile(path, "x".repeat(219_896));

    let failure: unknown;
    try {
      await readAuthorityText(path, 96_000, "context.skills.roots");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentConfigError);
    expect(failure).toMatchObject({
      name: "AgentConfigError",
      message: `Configured authority file exceeds its byte limit: ${path}`,
      issues: [{
        path: "context.skills.roots",
        message: "219896 bytes exceeds 96000",
        code: "size",
      }],
    });
  });
});
