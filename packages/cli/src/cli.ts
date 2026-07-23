import {
  composeAgentConfigSchema,
  createAgentHost,
  diagnoseAgent,
  explainAgentConfig,
  inspectAgent,
  type LoadedAgentConfig,
  type LoadedAgentModule,
  type ModuleKind,
  runAgentModuleCommand,
  validateAgentConfig,
} from "@mono-agent/core";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
const VERSION = "0.15.0";
export type CliSignal = "SIGINT" | "SIGTERM";
export interface CliSignalSource {
  once(signal: CliSignal, listener: () => void): unknown;
  removeListener(signal: CliSignal, listener: () => void): unknown;
}
export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
  signalSource?: CliSignalSource;
}
interface ResolvedCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  signalSource: CliSignalSource;
}
interface ParsedCommand {
  configPath: string;
  json?: boolean;
  write?: boolean;
  module?: string;
  command?: string;
  input?: unknown;
  path?: string;
}
type ArgumentKey = Exclude<keyof ParsedCommand, "path">;
interface ParseFlags {
  readonly json?: boolean;
  readonly write?: boolean;
  readonly path?: boolean;
  readonly moduleRequired?: boolean;
}
type ParseMode = "standard" | "module" | "route";
class UsageError extends Error {}
const OPTION_KEYS = new Map<string, ArgumentKey>([
  ["--config", "configPath"],
  ["-c", "configPath"],
  ["--json", "json"],
  ["--write", "write"],
  ["--module", "module"],
  ["--name", "command"],
  ["--input-json", "input"],
]);
const ARGUMENT_MESSAGES = {
  configPath: ["--config requires a path", "--config is required"],
  module: ["--module requires one instance id", "--module is required"],
  command: ["--name requires one command name", "--name is required"],
  input: ["--input-json requires one JSON value", "--input-json is required"],
  json: ["--json does not take a value", "--json is required"],
  write: ["--write does not take a value", "--write is required"],
} as const;
const COMMANDS: readonly (readonly [
  readonly string[],
  (argv: readonly string[], io: ResolvedCliIo) => Promise<number>,
])[] = [
  [["validate"], (argv, io) => runValidate(parseArguments(argv, io.cwd, "standard", { json: true }), io)],
  [["doctor"], (argv, io) => runDoctor(parseArguments(argv, io.cwd, "standard", { json: true }), io)],
  [["config", "schema"], (argv, io) => runSchema(parseArguments(argv, io.cwd, "standard", { write: true }), io)],
  [["config", "explain"], (argv, io) =>
    runExplain(parseArguments(argv, io.cwd, "standard", { json: true, path: true }), io)],
  [["inspect"], async (argv, io) => {
    const options = parseArguments(argv, io.cwd, "standard", { json: true });
    const inspection = await inspectAgent(options.configPath);
    io.stdout(`${stringifyJson(inspection, options.json ? undefined : 2)}\n`);
    return 0;
  }],
  [["module", "command"], (argv, io) => runModuleCommand(parseArguments(argv, io.cwd, "module"), io)],
  [["auth"], (argv, io) =>
    runRoutedCommand("auth", "runtime", parseArguments(argv, io.cwd, "route", { moduleRequired: true }), io)],
  [["sandbox"], (argv, io) =>
    runRoutedCommand("sandbox", "sandbox", parseArguments(argv, io.cwd, "route"), io)],
  [["runs"], (argv, io) => runRoutedCommand("runs", "state", parseArguments(argv, io.cwd, "route"), io)],
  [["memory"], (argv, io) => runRoutedCommand("memory", "memory", parseArguments(argv, io.cwd, "route"), io)],
  [["start"], (argv, io) => runStart(parseArguments(argv, io.cwd, "standard"), io)],
];
export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const resolvedIo: ResolvedCliIo = {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text)),
    cwd: resolve(io.cwd ?? process.cwd()),
    signalSource: io.signalSource ?? process,
  };
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    resolvedIo.stdout(usage());
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    resolvedIo.stdout(`${VERSION}\n`);
    return 0;
  }
  const wantsJson = argv.includes("--json");
  try {
    const route = COMMANDS.find(([words]) => words.every((word, index) => argv[index] === word));
    if (route === undefined) throw new UsageError(`Unknown command: ${argv.join(" ")}`);
    return await route[1](argv.slice(route[0].length), resolvedIo);
  } catch (error) {
    if (error instanceof UsageError) {
      resolvedIo.stderr(`${error.message}\n\n${usage()}`);
      return 2;
    }
    const message = reasonOf(error);
    if (wantsJson) {
      resolvedIo.stderr(`${stringifyJson({ ok: false, error: message })}\n`);
    } else {
      resolvedIo.stderr(`mono-agent: ${message}\n`);
    }
    return 1;
  }
}
async function runValidate(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const result = await validateAgentConfig(options.configPath);
  if (!result.ok) {
    if (options.json) {
      io.stdout(`${stringifyJson({ ok: false, configPath: options.configPath, issues: result.issues })}\n`);
    } else {
      io.stderr(renderIssues(result.issues));
    }
    return 1;
  }
  if (options.json) {
    io.stdout(`${stringifyJson({ ok: true, configPath: options.configPath, issues: [] })}\n`);
  } else {
    io.stdout(`Valid mono-agent config: ${options.configPath}\n`);
  }
  return 0;
}
async function runDoctor(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const validation = await validateAgentConfig(options.configPath);
  if (!validation.ok || validation.loaded === undefined) {
    const report = { ok: false, configPath: options.configPath, issues: validation.issues, diagnostics: [] };
    if (options.json) io.stdout(`${stringifyJson(report)}\n`);
    else io.stderr(renderIssues(validation.issues));
    return 1;
  }
  const diagnostics = await diagnoseAgent(validation.loaded, true);
  const report = {
    ok: diagnostics.every((module) =>
      module.diagnostics.every((diagnostic) => diagnostic.severity !== "error")),
    configPath: options.configPath,
    issues: [],
    diagnostics,
  };
  io.stdout(`${stringifyJson(report, options.json ? undefined : 2)}\n`);
  return report.ok ? 0 : 1;
}
async function runSchema(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const schema = await composeAgentConfigSchema(options.configPath);
  const rendered = `${stringifyJson(schema, 2)}\n`;
  if (!options.write) {
    io.stdout(rendered);
    return 0;
  }
  const outputPath = join(dirname(options.configPath), ".mono-agent", "mono-agent.config.schema.json");
  await writeSchemaFile(outputPath, rendered);
  io.stdout(`${stringifyJson({ ok: true, path: outputPath })}\n`);
  return 0;
}
async function runExplain(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const fullExplanation = await explainAgentConfig(options.configPath);
  let explanation = fullExplanation;
  if (options.path !== undefined) {
    const requestedPath = options.path;
    const entries = fullExplanation.entries.filter(
      (entry) => entry.path === requestedPath || entry.path.startsWith(`${requestedPath}.`),
    );
    if (entries.length === 0) throw new Error(`No config value exists at ${JSON.stringify(requestedPath)}`);
    explanation = { ...fullExplanation, entries };
  }
  io.stdout(`${stringifyJson(explanation, options.json ? undefined : 2)}\n`);
  return 0;
}
async function runStart(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const validation = await validateAgentConfig(options.configPath);
  if (!validation.ok) {
    io.stderr(renderIssues(validation.issues));
    return 1;
  }
  if (validation.loaded === undefined) {
    throw new Error("Agent validation succeeded without an immutable loaded configuration");
  }
  const host = await createAgentHost(validation.loaded);
  io.stdout(`${stringifyJson({ event: "started", ...host.startInfo })}\n`);
  await waitForShutdown(io.signalSource, async () => {
    const failures: unknown[] = [];
    try {
      await host.drain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await host.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Agent drain and stop both failed");
  });
  return 0;
}
async function runModuleCommand(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const result = await runAgentModuleCommand(options.configPath, options.module!, options.command!, options.input);
  io.stdout(`${stringifyJson({ ok: true, ...result })}\n`);
  return 0;
}
async function runRoutedCommand(
  route: string,
  slot: ModuleKind,
  options: ParsedCommand,
  io: ResolvedCliIo,
): Promise<number> {
  const loaded = await requireLoadedConfig(options.configPath);
  const selected = options.module === undefined
    ? onlyModule(loaded.modules.filter((module) => module.slot === slot), route, slot)
    : moduleInSlot(loaded.modules, options.module, route, slot);
  const result = await runAgentModuleCommand(loaded, selected.instanceId, options.command!, options.input);
  io.stdout(`${stringifyJson({ ok: true, route, ...result })}\n`);
  return 0;
}
async function requireLoadedConfig(configPath: string): Promise<LoadedAgentConfig> {
  const validation = await validateAgentConfig(configPath);
  if (!validation.ok) throw new Error(renderIssues(validation.issues).trimEnd());
  if (validation.loaded === undefined) throw new Error("Validation succeeded without an immutable loaded configuration");
  return validation.loaded;
}
function parseArguments(
  argv: readonly string[],
  cwd: string,
  mode: ParseMode,
  options: ParseFlags = {},
): ParsedCommand {
  const values = Object.create(null) as Partial<ParsedCommand> & Record<string, unknown>;
  const positional = mode === "route" ? "command" : mode === "standard" && options.path ? "path" : undefined;
  const unknown = mode === "module" ? "Unknown module command option"
    : mode === "route" ? "Unknown route option" : "Unknown option";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const inlineConfig = mode !== "module" && argument.startsWith("--config=");
    const key = inlineConfig ? "configPath" : OPTION_KEYS.get(argument);
    const allowed = key === "configPath"
      || (mode === "standard" ? key === "json" && options.json || key === "write" && options.write
        : key === "module" || key === "command" || key === "input");
    if (key === undefined || !allowed) {
      if ((key === "json" || key === "write") && mode === "standard") {
        throw new UsageError(`${argument} is not valid here`);
      }
      if (key === undefined && !argument.startsWith("-")
        && positional !== undefined && !Object.hasOwn(values, positional)) {
        values[positional] = argument;
        continue;
      }
      const prefix = argument.startsWith("-")
        || (positional === undefined && mode !== "standard")
        ? unknown
        : "Unexpected argument";
      throw new UsageError(`${prefix}: ${argument}`);
    }
    if (Object.hasOwn(values, key)) {
      throw new UsageError(key === "configPath" && mode !== "module"
        ? "--config may be supplied only once"
        : key === "json" || key === "write" ? `${argument} is not valid here`
          : key === "configPath" ? "--config requires one path" : ARGUMENT_MESSAGES[key][0]);
    }
    if (key === "json" || key === "write") {
      values[key] = true;
      continue;
    }
    const value = inlineConfig ? argument.slice("--config=".length) : argv[index + 1];
    if (value === undefined || value.length === 0 || (!inlineConfig && key !== "input" && value.startsWith("-"))) {
      throw new UsageError(key === "configPath" && mode === "module"
        ? "--config requires one path"
        : ARGUMENT_MESSAGES[key][0]);
    }
    if (!inlineConfig) index += 1;
    if (key === "input") {
      try {
        values.input = JSON.parse(value) as unknown;
      } catch {
        throw new UsageError("--input-json must be valid JSON");
      }
    } else {
      values[key] = key === "configPath" ? resolvePath(value, cwd) : value;
    }
  }
  const required: readonly ArgumentKey[] = mode === "module"
    ? ["configPath", "module", "command"]
    : mode === "route" && options.moduleRequired ? ["configPath", "module"] : ["configPath"];
  for (const key of required) if (!Object.hasOwn(values, key)) throw new UsageError(ARGUMENT_MESSAGES[key][1]);
  if (mode === "route" && !Object.hasOwn(values, "command")) {
    throw new UsageError("A module command name is required");
  }
  return values as ParsedCommand;
}
function resolvePath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}
function onlyModule(
  modules: readonly LoadedAgentModule[],
  route: string,
  slot: ModuleKind,
): LoadedAgentModule {
  if (modules.length === 0) throw new Error(`No ${slot} module is configured; ${route} is unavailable`);
  if (modules.length > 1) throw new Error(`${route} requires --module because multiple ${slot} modules are configured`);
  return modules[0]!;
}
function moduleInSlot(
  modules: readonly LoadedAgentModule[],
  instanceId: string,
  route: string,
  slot: ModuleKind,
): LoadedAgentModule {
  const selected = modules.find((module) => module.instanceId === instanceId && module.slot === slot);
  if (selected !== undefined) return selected;
  const actual = modules.filter((module) => module.instanceId === instanceId).map((module) => module.slot);
  if (actual.length === 0) throw new Error(`Selected module ${JSON.stringify(instanceId)} is not configured`);
  throw new Error(
    `Selected module ${JSON.stringify(instanceId)} is configured in the ${actual.join("/")} slot; ${route} requires ${slot}`,
  );
}
async function writeSchemaFile(outputPath: string, contents: string): Promise<void> {
  const outputDirectory = dirname(outputPath);
  try {
    const directoryStat = await lstat(outputDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`Schema directory is not a real directory: ${outputDirectory}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  }
  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      throw new Error(`Schema target is not a regular file: ${outputPath}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporaryPath = join(outputDirectory, `.mono-agent.config.schema.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}
async function waitForShutdown(signalSource: CliSignalSource, shutdown: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settling = false;
    const removeListeners = (): void => {
      signalSource.removeListener("SIGINT", onSignal);
      signalSource.removeListener("SIGTERM", onSignal);
    };
    const onSignal = (): void => {
      if (settling) return;
      settling = true;
      removeListeners();
      void shutdown().then(resolvePromise, rejectPromise);
    };
    signalSource.once("SIGINT", onSignal);
    signalSource.once("SIGTERM", onSignal);
  });
}
function renderIssues(issues: readonly unknown[]): string {
  if (issues.length === 0) return "Invalid mono-agent config.\n";
  return `${issues.map((issue) => `- ${renderIssue(issue)}`).join("\n")}\n`;
}
function renderIssue(issue: unknown): string {
  if (typeof issue === "string") return issue;
  if (issue !== null && typeof issue === "object") {
    const candidate = issue as { path?: unknown; message?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : stringifyJson(issue);
    return typeof candidate.path === "string" && candidate.path.length > 0
      ? `${candidate.path}: ${message}`
      : message;
  }
  return String(issue);
}
function stringifyJson(value: unknown, spaces?: number): string {
  return JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate, spaces) ?? "null";
}
function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function usage(): string {
  return [
    "Usage:",
    "  mono-agent validate --config <file> [--json]",
    "  mono-agent doctor --config <file> [--json]",
    "  mono-agent config schema --config <file> [--write]",
    "  mono-agent config explain --config <file> [path] [--json]",
    "  mono-agent inspect --config <file> [--json]",
    "  mono-agent module command --config <file> --module <id> --name <command> [--input-json <json>]",
    "  mono-agent auth <command> --config <file> --module <runtime-id> [--input-json <json>]",
    "  mono-agent sandbox <command> --config <file> [--input-json <json>]",
    "  mono-agent runs <command> --config <file> [--input-json <json>]",
    "  mono-agent memory <command> --config <file> [--input-json <json>]",
    "  mono-agent start --config <file>",
    "  mono-agent --version",
    "",
  ].join("\n");
}
