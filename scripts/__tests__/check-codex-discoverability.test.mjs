// SPDX-License-Identifier: MIT
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderCodexDiscoverabilityReport,
  runCheckCodexDiscoverability,
  scanCodexDiscoverability,
} from "../check-codex-discoverability.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-codex-discoverability", () => {
  it("accepts repo skills, Codex metadata, and TOML companions", async () => {
    const cwd = await tempRepo();
    await writeSkill(cwd, "skills/verify-green", "verify-green");
    await writeSkill(cwd, "packages/create-mono-agent/skills/mono-agent-composer", "mono-agent-composer");
    await writeAgentPair(cwd, "implementer");

    await symlink("../skills", join(cwd, ".agents", "skills"));
    await symlink("../skills", join(cwd, ".claude", "skills"));
    await symlink("../agents", join(cwd, ".claude", "agents"));
    await symlink("../agents", join(cwd, ".codex", "agents"));

    await expect(scanCodexDiscoverability({ cwd })).resolves.toEqual([]);
  });

  it("flags legacy Codex skill links, missing UI metadata, and missing TOML", async () => {
    const cwd = await tempRepo();
    await writeSkill(cwd, "skills/verify-green", "verify-green", { openaiYaml: false });
    await writeAgentMarkdown(cwd, "implementer");

    await symlink("../skills", join(cwd, ".agents", "skills"));
    await symlink("../skills", join(cwd, ".codex", "skills"));
    await symlink("../skills", join(cwd, ".claude", "skills"));
    await symlink("../agents", join(cwd, ".claude", "agents"));
    await symlink("../agents", join(cwd, ".codex", "agents"));

    const findings = await scanCodexDiscoverability({ cwd });
    const labels = findings.map((finding) => finding.label);

    expect(labels).toContain("legacy-codex-skills-path");
    expect(labels).toContain("openai-yaml-missing");
    expect(labels).toContain("codex-agent-toml-missing");
  });

  it("prints a stable report and returns non-zero on findings", async () => {
    const cwd = await tempRepo();
    await writeSkill(cwd, "skills/verify-green", "verify-green", {
      defaultPrompt: "Use this skill without the required skill mention.",
    });
    await writeAgentPair(cwd, "implementer");

    await symlink("../skills", join(cwd, ".agents", "skills"));
    await symlink("../skills", join(cwd, ".claude", "skills"));
    await symlink("../agents", join(cwd, ".claude", "agents"));
    await symlink("../agents", join(cwd, ".codex", "agents"));

    const stdout = sink();
    const stderr = sink();
    const result = await runCheckCodexDiscoverability({ cwd, stdout, stderr });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("Codex discoverability check failed");
    expect(stdout.text).toContain("label=openai-yaml-default-prompt-skill");
    expect(stderr.text).toBe("");
    expect(renderCodexDiscoverabilityReport([])).toBe("Codex discoverability check passed\n");
  });
});

async function tempRepo() {
  const dir = join(tmpdir(), `codex-discoverability-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  await mkdir(join(dir, ".agents"), { recursive: true });
  await mkdir(join(dir, ".claude"), { recursive: true });
  await mkdir(join(dir, ".codex"), { recursive: true });
  await mkdir(join(dir, "agents"), { recursive: true });
  await mkdir(join(dir, "skills"), { recursive: true });
  await mkdir(join(dir, "packages/create-mono-agent/skills"), { recursive: true });
  return dir;
}

async function writeSkill(cwd, skillDir, name, options = {}) {
  await mkdir(join(cwd, skillDir), { recursive: true });
  await writeFile(join(cwd, skillDir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: Use when testing ${name} discoverability.`,
    "---",
    "",
    "# Test Skill",
    "",
  ].join("\n"), "utf8");

  if (options.openaiYaml === false) {
    return;
  }

  await mkdir(join(cwd, skillDir, "agents"), { recursive: true });
  await writeFile(join(cwd, skillDir, "agents/openai.yaml"), [
    "interface:",
    "  display_name: \"Test Skill\"",
    "  short_description: \"Validate Codex skill metadata\"",
    `  default_prompt: "${options.defaultPrompt ?? `Use $${name} to validate Codex skill metadata.`}"`,
    "",
  ].join("\n"), "utf8");
}

async function writeAgentMarkdown(cwd, name) {
  await writeFile(join(cwd, "agents", `${name}.md`), [
    "---",
    `name: ${name}`,
    "description: Test agent template.",
    "---",
    "",
    "Agent body.",
    "",
  ].join("\n"), "utf8");
}

async function writeAgentPair(cwd, name) {
  await writeAgentMarkdown(cwd, name);
  await writeFile(join(cwd, "agents", `${name}.toml`), [
    `name = "${name}"`,
    "description = \"Test Codex custom agent.\"",
    "model_reasoning_effort = \"medium\"",
    "developer_instructions = \"\"\"",
    "Use this custom agent for tests.",
    "\"\"\"",
    "",
  ].join("\n"), "utf8");
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
