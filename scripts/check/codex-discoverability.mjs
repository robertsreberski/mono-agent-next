#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoots = ["skills", "packages/create-mono-agent/skills"];
const requiredSymlinks = new Map([
  [".agents/skills", "../skills"],
  [".claude/skills", "../skills"],
  [".claude/agents", "../agents"],
  [".codex/agents", "../agents"],
]);

export async function scanCodexDiscoverability(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const findings = [];

  for (const [path, expectedTarget] of requiredSymlinks) {
    findings.push(...await checkSymlink(cwd, path, expectedTarget));
  }
  if (await pathExists(cwd, ".codex/skills")) {
    findings.push(finding(".codex/skills", "legacy-codex-skills-path", "Use .agents/skills for Codex repo skills to avoid duplicate discovery."));
  }

  for (const skillDir of await discoverSkillDirs(cwd)) {
    findings.push(...await checkSkill(cwd, skillDir));
  }

  findings.push(...await checkAgentTemplates(cwd));
  return findings.sort(compareFindings);
}

export async function runCheckCodexDiscoverability(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const findings = await scanCodexDiscoverability({ cwd });
    stdout.write(renderCodexDiscoverabilityReport(findings));
    return { exitCode: findings.length === 0 ? 0 : 1, findings };
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 1, findings: [] };
  }
}

export function renderCodexDiscoverabilityReport(findings) {
  if (findings.length === 0) {
    return "Codex discoverability check passed\n";
  }

  const lines = [
    "Codex discoverability check failed",
    `Findings: ${findings.length}`,
  ];
  for (const item of findings.sort(compareFindings)) {
    lines.push(`  ${item.file} label=${item.label} ${item.message}`);
  }
  return `${lines.join("\n")}\n`;
}

async function discoverSkillDirs(cwd) {
  const dirs = [];
  for (const root of skillRoots) {
    let entries;
    try {
      entries = await readdir(resolve(cwd, root), { withFileTypes: true });
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillDir = join(root, entry.name);
      if (await pathExists(cwd, join(skillDir, "SKILL.md"))) {
        dirs.push(skillDir);
      }
    }
  }
  return dirs.sort();
}

async function checkSkill(cwd, skillDir) {
  const findings = [];
  const skillPath = join(skillDir, "SKILL.md");
  const markdown = await readFile(resolve(cwd, skillPath), "utf8");
  const frontmatter = readFrontmatter(markdown);
  const expectedName = basename(skillDir);

  if (frontmatter.name !== expectedName) {
    findings.push(finding(skillPath, "skill-name-mismatch", `Expected frontmatter name "${expectedName}".`));
  }
  if (!frontmatter.description) {
    findings.push(finding(skillPath, "skill-description-missing", "Skill frontmatter must include description."));
  }

  const openaiPath = join(skillDir, "agents/openai.yaml");
  if (!(await pathExists(cwd, openaiPath))) {
    findings.push(finding(openaiPath, "openai-yaml-missing", "Add Codex UI metadata for this skill."));
    return findings;
  }

  const openaiYaml = await readFile(resolve(cwd, openaiPath), "utf8");
  if (!/^interface:\s*$/mu.test(openaiYaml)) {
    findings.push(finding(openaiPath, "openai-yaml-interface-missing", "agents/openai.yaml must define an interface block."));
  }

  const displayName = readQuotedYamlField(openaiYaml, "display_name");
  const shortDescription = readQuotedYamlField(openaiYaml, "short_description");
  const defaultPrompt = readQuotedYamlField(openaiYaml, "default_prompt");
  if (!displayName) {
    findings.push(finding(openaiPath, "openai-yaml-display-name-missing", "interface.display_name must be quoted and non-empty."));
  }
  if (!shortDescription) {
    findings.push(finding(openaiPath, "openai-yaml-short-description-missing", "interface.short_description must be quoted and non-empty."));
  } else if (shortDescription.length < 25 || shortDescription.length > 64) {
    findings.push(finding(openaiPath, "openai-yaml-short-description-length", "interface.short_description must be 25-64 characters."));
  }
  if (!defaultPrompt) {
    findings.push(finding(openaiPath, "openai-yaml-default-prompt-missing", "interface.default_prompt must be quoted and non-empty."));
  } else if (!defaultPrompt.includes(`$${expectedName}`)) {
    findings.push(finding(openaiPath, "openai-yaml-default-prompt-skill", `interface.default_prompt must mention $${expectedName}.`));
  }

  return findings;
}

async function checkAgentTemplates(cwd) {
  const findings = [];
  const agentDir = resolve(cwd, "agents");
  let entries;
  try {
    entries = await readdir(agentDir, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return [finding("agents", "agents-dir-missing", "Project agent templates directory is missing.")];
    }
    throw error;
  }

  const markdownNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name.slice(0, -".md".length))
    .sort();
  const tomlNames = new Set(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name.slice(0, -".toml".length)));

  for (const name of markdownNames) {
    const tomlPath = join("agents", `${name}.toml`);
    if (!tomlNames.has(name)) {
      findings.push(finding(tomlPath, "codex-agent-toml-missing", "Add a Codex custom-agent TOML companion for this Markdown template."));
      continue;
    }
    findings.push(...await checkAgentToml(cwd, name, tomlPath));
  }

  for (const name of [...tomlNames].sort()) {
    if (!markdownNames.includes(name)) {
      findings.push(finding(join("agents", `${name}.toml`), "codex-agent-toml-orphan", "Codex custom-agent TOML has no matching Markdown template."));
    }
  }

  return findings;
}

async function checkAgentToml(cwd, name, tomlPath) {
  const findings = [];
  const toml = await readFile(resolve(cwd, tomlPath), "utf8");

  if (readQuotedTomlField(toml, "name") !== name) {
    findings.push(finding(tomlPath, "codex-agent-name-mismatch", `Expected name = "${name}".`));
  }
  if (!readQuotedTomlField(toml, "description")) {
    findings.push(finding(tomlPath, "codex-agent-description-missing", "description must be set."));
  }
  if (!readQuotedTomlField(toml, "model_reasoning_effort")) {
    findings.push(finding(tomlPath, "codex-agent-effort-missing", "model_reasoning_effort must be set."));
  }
  if (!/^\s*developer_instructions\s*=\s*"""[\s\S]+?"""\s*$/mu.test(toml)) {
    findings.push(finding(tomlPath, "codex-agent-instructions-missing", "developer_instructions must be a non-empty multiline string."));
  }
  if (/^\s*model\s*=/mu.test(toml)) {
    findings.push(finding(tomlPath, "codex-agent-model-pinned", "Do not pin model; inherit the user's Codex session model."));
  }

  return findings;
}

async function checkSymlink(cwd, path, expectedTarget) {
  try {
    const stats = await lstat(resolve(cwd, path));
    if (!stats.isSymbolicLink()) {
      return [finding(path, "discoverability-link-not-symlink", `Expected symlink to ${expectedTarget}.`)];
    }
    const target = await readlink(resolve(cwd, path));
    if (target !== expectedTarget) {
      return [finding(path, "discoverability-link-target", `Expected symlink target ${expectedTarget}, got ${target}.`)];
    }
    return [];
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return [finding(path, "discoverability-link-missing", `Expected symlink to ${expectedTarget}.`)];
    }
    throw error;
  }
}

function readFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u.exec(markdown.replace(/\r\n?/gu, "\n"));
  if (match === null) {
    return {};
  }
  const fields = {};
  for (const rawLine of (match[1] ?? "").split("\n")) {
    const separator = rawLine.indexOf(":");
    if (separator === -1) {
      continue;
    }
    fields[rawLine.slice(0, separator).trim()] = stripQuotes(rawLine.slice(separator + 1).trim());
  }
  return fields;
}

function readQuotedYamlField(text, field) {
  return readQuotedField(text, field, ":");
}

function readQuotedTomlField(text, field) {
  return readQuotedField(text, field, "=");
}

function readQuotedField(text, field, separator) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*${escapedField}\\s*${escapedSeparator}\\s*"([^"]+)"\\s*$`, "mu").exec(text);
  return match?.[1] ?? "";
}

async function pathExists(cwd, path) {
  try {
    await lstat(resolve(cwd, path));
    return true;
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function finding(file, label, message) {
  return { file, label, message };
}

function compareFindings(left, right) {
  return left.file.localeCompare(right.file)
    || left.label.localeCompare(right.label)
    || left.message.localeCompare(right.message);
}

function isErrorWithCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runCheckCodexDiscoverability();
  process.exitCode = result.exitCode;
}
