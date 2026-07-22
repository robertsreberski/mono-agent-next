import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../");

describe("README usage contract", () => {
  it("conditionally includes the optional environment key under exactOptionalPropertyTypes", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const sample = readme.match(/```ts\n([\s\S]*?)\n```/u)?.[1];

    expect(sample).toBeDefined();
    expect(sample).toContain("const apiKey = process.env.MONO_AGENT_WEBHOOK_API_KEY;");
    expect(sample).toContain("...(apiKey === undefined ? {} : { apiKey }),");
    expect(sample).not.toContain("apiKey: process.env.MONO_AGENT_WEBHOOK_API_KEY");
  });
});
