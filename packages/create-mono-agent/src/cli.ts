// SPDX-License-Identifier: MIT
import { runCli, type CliIo } from "@mono-agent/cli";
import { resolve } from "node:path";

import {
  scaffoldAgent,
  type InstallPackageManager,
  type PackageInstaller,
} from "./scaffold.js";
import {
  COMPOSER_SKILL_TARGETS,
  installComposerSkill,
  type ComposerSkillTarget,
} from "./skill-installer.js";
import {
  PROJECT_TEMPLATES,
  isProjectTemplate,
  type ProjectTemplate,
} from "./templates.js";

export interface CreateMonoAgentCliOptions {
  invocationName?: string;
  delegate?: typeof runCli;
  installer?: PackageInstaller;
  skillInstaller?: typeof installComposerSkill;
}

class CreateUsageError extends Error {}

export async function runCreateMonoAgentCli(
  argv: readonly string[],
  io: CliIo = {},
  options: CreateMonoAgentCliOptions = {},
): Promise<number> {
  const invocationName = options.invocationName ?? "create-mono-agent";
  const isCreateInvocation = invocationName.startsWith("create-mono-agent");
  const isInitCommand = !isCreateInvocation
    && (argv[0] === "init" || argv[0] === "setup");
  const isInstallSkillCommand = !isCreateInvocation && argv[0] === "install-skill";

  if (!isCreateInvocation && !isInitCommand && !isInstallSkillCommand) {
    return (options.delegate ?? runCli)(argv, io);
  }

  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  if (isInstallSkillCommand) {
    try {
      const parsed = parseInstallSkillArgs(argv.slice(1));
      if (parsed.help) {
        stdout(installSkillUsage());
        return 0;
      }
      const result = await (options.skillInstaller ?? installComposerSkill)({
        target: parsed.target,
        force: parsed.force,
      });
      stdout(`${JSON.stringify({ event: "skill-installed", ...result })}\n`);
      return 0;
    } catch (error) {
      if (error instanceof CreateUsageError) {
        stderr(`${error.message}\n\n${installSkillUsage()}`);
        return 2;
      }
      stderr(`mono-agent install-skill: ${reasonOf(error)}\n`);
      return 1;
    }
  }

  const scaffoldArgs = isInitCommand ? argv.slice(1) : argv;
  const cwd = resolve(io.cwd ?? process.cwd());

  try {
    const parsed = parseScaffoldArgs(scaffoldArgs);
    if (parsed.help) {
      stdout(createUsage());
      return 0;
    }

    const result = await scaffoldAgent({
      targetDirectory: parsed.targetDirectory,
      cwd,
      ...(parsed.projectName === undefined ? {} : { projectName: parsed.projectName }),
      template: parsed.template,
      install: parsed.install,
      packageManager: parsed.packageManager,
      ...(options.installer === undefined ? {} : { installer: options.installer }),
    });
    stdout(`${JSON.stringify({ event: "scaffolded", ...result })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CreateUsageError) {
      stderr(`${error.message}\n\n${createUsage()}`);
      return 2;
    }
    stderr(`create-mono-agent: ${reasonOf(error)}\n`);
    return 1;
  }
}

interface ParsedInstallSkillArgs {
  readonly target: ComposerSkillTarget;
  readonly force: boolean;
  readonly help: boolean;
}

function parseInstallSkillArgs(argv: readonly string[]): ParsedInstallSkillArgs {
  let target: ComposerSkillTarget = "both";
  let targetSeen = false;
  let force = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--force") {
      if (force) throw new CreateUsageError("--force may be supplied only once");
      force = true;
      continue;
    }
    if (argument === "--target") {
      if (targetSeen) throw new CreateUsageError("--target may be supplied only once");
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        throw new CreateUsageError("--target requires claude, codex, or both");
      }
      if (!COMPOSER_SKILL_TARGETS.includes(candidate as ComposerSkillTarget)) {
        throw new CreateUsageError(`Unsupported skill target: ${candidate}`);
      }
      target = candidate as ComposerSkillTarget;
      targetSeen = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CreateUsageError(`Unknown option: ${argument}`);
    }
    throw new CreateUsageError(`Unexpected argument: ${argument}`);
  }
  if (
    help
    && argv.some((argument) =>
      argument !== "--help" && argument !== "-h" && argument !== "--")
  ) {
    throw new CreateUsageError("--help cannot be combined with install-skill arguments");
  }
  return { target, force, help };
}

interface ParsedScaffoldArgs {
  targetDirectory: string;
  projectName?: string;
  template: ProjectTemplate;
  install: boolean;
  packageManager: InstallPackageManager;
  help: boolean;
}

function parseScaffoldArgs(argv: readonly string[]): ParsedScaffoldArgs {
  let targetDirectory: string | undefined;
  let projectName: string | undefined;
  let template: ProjectTemplate = "minimal";
  let templateSeen = false;
  let install = false;
  let packageManager: InstallPackageManager = "pnpm";
  let packageManagerSeen = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--install") {
      if (install) throw new CreateUsageError("--install may be supplied only once");
      install = true;
      continue;
    }
    if (argument === "--template") {
      if (templateSeen) throw new CreateUsageError("--template may be supplied only once");
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        throw new CreateUsageError(`--template requires ${PROJECT_TEMPLATES.join(", ")}`);
      }
      template = parseTemplate(candidate);
      templateSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--package-manager") {
      if (packageManagerSeen) throw new CreateUsageError("--package-manager may be supplied only once");
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        throw new CreateUsageError("--package-manager requires npm or pnpm");
      }
      packageManager = parsePackageManager(candidate);
      packageManagerSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--name") {
      if (projectName !== undefined) throw new CreateUsageError("--name may be supplied only once");
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        throw new CreateUsageError("--name requires an npm package name");
      }
      projectName = candidate;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CreateUsageError(`Unknown option: ${argument}`);
    }
    if (targetDirectory !== undefined) {
      throw new CreateUsageError(`Unexpected argument: ${argument}`);
    }
    targetDirectory = argument;
  }

  if (help && argv.some((argument) => argument !== "--help" && argument !== "-h" && argument !== "--")) {
    throw new CreateUsageError("--help cannot be combined with scaffold arguments");
  }

  return {
    targetDirectory: targetDirectory ?? ".",
    ...(projectName === undefined ? {} : { projectName }),
    template,
    install,
    packageManager,
    help,
  };
}

function parseTemplate(value: string): ProjectTemplate {
  if (isProjectTemplate(value)) return value;
  throw new CreateUsageError(`Unsupported template: ${value}`);
}

function parsePackageManager(value: string): InstallPackageManager {
  if (value === "npm" || value === "pnpm") return value;
  throw new CreateUsageError(`Unsupported package manager: ${value}`);
}

function reasonOf(error: unknown): string {
  const reasons: string[] = [];
  collectReasons(error, reasons, new Set<unknown>(), 0);
  return [...new Set(reasons)].join(" | ");
}

function collectReasons(
  error: unknown,
  reasons: string[],
  seen: Set<unknown>,
  depth: number,
): void {
  if (reasons.length >= 8 || depth > 4 || seen.has(error)) return;
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    seen.add(error);
  }
  if (error instanceof Error) {
    if (error.message.length > 0) reasons.push(error.message.slice(0, 2_000));
    if (error instanceof AggregateError) {
      for (const nested of error.errors.slice(0, 8)) {
        collectReasons(nested, reasons, seen, depth + 1);
      }
    }
    if (error.cause !== undefined) {
      collectReasons(error.cause, reasons, seen, depth + 1);
    }
    return;
  }
  reasons.push(String(error).slice(0, 2_000));
}

function createUsage(): string {
  return [
    "Usage:",
    "  create-mono-agent [directory] [--template <minimal|personal|multi-runtime>] [--install] [--package-manager <pnpm|npm>]",
    "  mono-agent init [directory] [--template <minimal|personal|multi-runtime>] [--install] [--package-manager <pnpm|npm>] [--name <package-name>]",
    "  mono-agent setup [directory] [--template <minimal|personal|multi-runtime>] [--install] [--package-manager <pnpm|npm>] [--name <package-name>]",
    "  mono-agent install-skill [--target <claude|codex|both>] [--force]",
    "",
    "Source preview: use this executable from the built mono-agent-next checkout.",
    "Existing registry artifacts under these names belong to the predecessor repository.",
    "Do not use --install while the generated package pins remain unpublished.",
    "The default minimal template alone has a retained source-preview install recipe:",
    "after rendering it, follow docs/getting-started/install.md for the local-tarball flow.",
    "Other templates remain render-and-validate only until their closures have matching proofs.",
    "Package installation never runs unless --install is supplied.",
    "",
  ].join("\n");
}

function installSkillUsage(): string {
  return [
    "Usage:",
    "  mono-agent install-skill [--target <claude|codex|both>] [--force]",
    "",
    "Installs the bundled mono-agent-composer skill only.",
    "The default target is both. Existing installs require --force.",
    "This command does not install packages or pair the documentation MCP.",
    "",
  ].join("\n");
}
