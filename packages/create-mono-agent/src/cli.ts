import { runCli, type CliIo } from "@mono-agent/cli";
import { resolve } from "node:path";

import {
  scaffoldAgent,
  type InstallPackageManager,
  type PackageInstaller,
} from "./scaffold.js";
import {
  PROJECT_TEMPLATES,
  isProjectTemplate,
  type ProjectTemplate,
} from "./templates.js";

export interface CreateMonoAgentCliOptions {
  invocationName?: string;
  delegate?: typeof runCli;
  installer?: PackageInstaller;
}

class CreateUsageError extends Error {}

export async function runCreateMonoAgentCli(
  argv: readonly string[],
  io: CliIo = {},
  options: CreateMonoAgentCliOptions = {},
): Promise<number> {
  const invocationName = options.invocationName ?? "create-mono-agent";
  const isCreateInvocation = invocationName.startsWith("create-mono-agent");
  const isInitCommand = argv[0] === "init" || argv[0] === "setup";

  if (!isCreateInvocation && !isInitCommand) {
    return (options.delegate ?? runCli)(argv, io);
  }

  const scaffoldArgs = isInitCommand ? argv.slice(1) : argv;
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
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
  return error instanceof Error ? error.message : String(error);
}

function createUsage(): string {
  return [
    "Usage:",
    "  npm create mono-agent@latest [directory] [-- --template <minimal|personal|multi-runtime>]",
    "  create-mono-agent [directory] [--template <minimal|personal|multi-runtime>] [--install] [--package-manager <pnpm|npm>]",
    "  mono-agent init [directory] [--template <minimal|personal|multi-runtime>] [--install] [--package-manager <pnpm|npm>] [--name <package-name>]",
    "  mono-agent setup [directory] [--template <minimal|personal|multi-runtime>] [--install] [--package-manager <pnpm|npm>] [--name <package-name>]",
    "",
    "The default template is minimal.",
    "Package installation never runs unless --install is supplied.",
    "",
  ].join("\n");
}
