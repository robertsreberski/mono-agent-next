import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

function createFakeRuntime(result: RuntimeResult = { text: "ok" }) {
  const calls: FakeRuntimeCall[] = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return result;
      },
    },
  };
}

/** Builds an identity file plus a skills root holding `<name>/SKILL.md` for each name. */
async function fixture(skillNames: readonly string[]): Promise<{ identityPath: string; skillsRoot: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-skill-disclosure-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  const skillsRoot = join(dir, "skills");
  for (const name of skillNames) {
    await mkdir(join(skillsRoot, name), { recursive: true });
    await writeFile(join(skillsRoot, name, "SKILL.md"), `# ${name}\n\nThe ${name} skill body.\n`, "utf8");
  }
  return { identityPath, skillsRoot };
}

function request(conversationId = "conv-1", userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness progressive skill disclosure wiring", () => {
  it("index mode (opt-in) threads discovered skill names + skillsRoot so ReadSkill can be created", async () => {
    const { identityPath, skillsRoot } = await fixture(["research", "writing"]);
    const fake = createFakeRuntime();
    const harness = createAgentHarness({
      identityPath, runtime: fake.runtime, model, executionMode: "sdk", skillsRoot, skillDisclosure: "index",
    });

    await harness.run(request());

    const options = fake.calls[0]?.options as Record<string, unknown>;
    expect(options.skills).toEqual([{ name: "research" }, { name: "writing" }]);
    expect(options.skillsRoot).toBe(skillsRoot);
    expect(fake.calls[0]?.prompt).toContain("call `ReadSkill` with its name");
    expect(fake.calls[0]?.prompt).not.toContain(join(skillsRoot, "research", "SKILL.md"));
  });

  it("does not thread skills/skillsRoot when no skillsRoot is configured (legacy behavior)", async () => {
    const { identityPath } = await fixture([]);
    const fake = createFakeRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk" });

    await harness.run(request());

    const options = fake.calls[0]?.options as Record<string, unknown>;
    expect(options.skills).toBeUndefined();
    expect(options.skillsRoot).toBeUndefined();
  });

  it("full disclosure mode (the default, unset) does NOT create ReadSkill (no skills/skillsRoot threaded)", async () => {
    const { identityPath, skillsRoot } = await fixture(["research"]);
    const fake = createFakeRuntime();
    // skillDisclosure unset — the default is "full", so ReadSkill must NOT be wired
    // even when a skillsRoot is configured (byte-for-byte legacy behavior).
    const harness = createAgentHarness({
      identityPath, runtime: fake.runtime, model, executionMode: "sdk", skillsRoot,
    });

    await harness.run(request());

    const options = fake.calls[0]?.options as Record<string, unknown>;
    expect(options.skills).toBeUndefined();
    expect(options.skillsRoot).toBeUndefined();
    expect(fake.calls[0]?.prompt).not.toContain("call `ReadSkill` with its name");
  });
});
