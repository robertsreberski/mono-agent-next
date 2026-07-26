// SPDX-License-Identifier: MIT
import {
  AgentConfigError,
  composeAgentConfigSchema,
  createAgentHost,
  diagnoseAgent,
  explainAgentConfig,
  inspectAgent,
  type AgentHost,
  type LoadedAgentConfig,
  type LoadedAgentModule,
  type ModuleKind,
  runAgentModuleCommand,
  validateAgentConfig,
} from "@mono-agent/core";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

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
type FlagKey = Extract<ArgumentKey, "json" | "write">;
type ValueKey = Exclude<ArgumentKey, FlagKey>;

interface ParseSpec {
  readonly context?: "module command" | "route";
  readonly flag?: FlagKey;
  readonly positional?: "command" | "path";
  readonly module?: "optional" | "required";
}

interface CommandDescriptor {
  readonly words: readonly string[];
  readonly parse?: ParseSpec;
  run(options: ParsedCommand, io: ResolvedCliIo): Promise<number>;
}

class UsageError extends Error {}

const CLI_OPTIONS = {
  config: { type: "string", short: "c", key: "configPath" },
  json: { type: "boolean", key: "json" },
  write: { type: "boolean", key: "write" },
  module: { type: "string", key: "module" },
  name: { type: "string", key: "command" },
  "input-json": { type: "string", key: "input" },
} as const;

const ARGUMENT_MESSAGES: Record<ValueKey, readonly [value: string, required: string]> = {
  configPath: ["--config requires a path", "--config is required"],
  module: ["--module requires one instance id", "--module is required"],
  command: ["--name requires one command name", "--name is required"],
  input: ["--input-json requires one JSON value", "--input-json is required"],
};

const ROUTE_PARSE = { context: "route", positional: "command", module: "optional" } as const;

const COMMANDS: readonly CommandDescriptor[] = [
  { words: ["validate"], parse: { flag: "json" }, run: runValidate },
  { words: ["doctor"], parse: { flag: "json" }, run: runDoctor },
  { words: ["config", "schema"], parse: { flag: "write" }, run: runSchema },
  { words: ["config", "explain"], parse: { flag: "json", positional: "path" }, run: runExplain },
  { words: ["inspect"], parse: { flag: "json" }, run: runInspect },
  { words: ["module", "command"], parse: { context: "module command", module: "required" }, run: runModuleCommand },
  {
    words: ["auth"],
    parse: { ...ROUTE_PARSE, module: "required" },
    run: (options, io) => runRoutedCommand("auth", "runtime", options, io),
  },
  { words: ["sandbox"], parse: ROUTE_PARSE, run: (options, io) => runRoutedCommand("sandbox", "sandbox", options, io) },
  { words: ["runs"], parse: ROUTE_PARSE, run: (options, io) => runRoutedCommand("runs", "state", options, io) },
  { words: ["memory"], parse: ROUTE_PARSE, run: (options, io) => runRoutedCommand("memory", "memory", options, io) },
  { words: ["start"], run: runStart },
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
    const route = COMMANDS.find(({ words }) => words.every((word, index) => argv[index] === word));
    if (route === undefined) throw new UsageError(`Unknown command: ${argv.join(" ")}`);
    return await route.run(parseArguments(argv.slice(route.words.length), resolvedIo.cwd, route.parse), resolvedIo);
  } catch (error) {
    if (error instanceof UsageError) {
      resolvedIo.stderr(`${error.message}\n\n${usage()}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) {
      resolvedIo.stderr(`${stringifyJson({
        ok: false,
        error: message,
        ...(error instanceof AgentConfigError ? { issues: error.issues } : {}),
      })}\n`);
    } else {
      resolvedIo.stderr(`mono-agent: ${message}\n${
        error instanceof AgentConfigError ? renderIssues(error.issues) : ""
      }`);
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
async function runInspect(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  io.stdout(`${stringifyJson(await inspectAgent(options.configPath), options.json ? undefined : 2)}\n`);
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
  const shutdown = listenForShutdown(io.signalSource);
  try {
    const host = await createAgentHost(validation.loaded);
    io.stdout(`${stringifyJson({ event: "started", ...host.startInfo })}\n`);
    await shutdown.requested;
    await stopHost(host);
    return 0;
  } finally {
    shutdown.dispose();
  }
}
async function runModuleCommand(options: ParsedCommand, io: ResolvedCliIo): Promise<number> {
  const result = await runAgentModuleCommand(options.configPath, options.module!, options.command!, options.input);
  io.stdout(`${stringifyJson({ ok: true, ...result })}\n`);
  return 0;
}
async function runRoutedCommand(route: string, slot: ModuleKind, options: ParsedCommand,
  io: ResolvedCliIo): Promise<number> {
  const loaded = await requireLoadedConfig(options.configPath);
  const selected = selectModule(loaded.modules, options.module, route, slot);
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
function parseArguments(argv: readonly string[], cwd: string, spec: ParseSpec = {}): ParsedCommand {
  const values = Object.create(null) as Partial<ParsedCommand> & Record<string, unknown>;
  const unknown = `Unknown${spec.context === undefined ? "" : ` ${spec.context}`} option`;
  const { tokens } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: false, allowPositionals: true, tokens: true });
  for (const token of tokens) {
    const argument = argv[token.index]!;
    if (token.kind !== "option") {
      if (!argument.startsWith("-") && token.kind === "positional" && spec.positional !== undefined
        && !Object.hasOwn(values, spec.positional)) {
        values[spec.positional] = token.value;
        continue;
      }
      const prefix = argument.startsWith("-") || token.kind === "option-terminator"
        || (spec.positional === undefined && spec.context !== undefined) ? unknown : "Unexpected argument";
      throw new UsageError(`${prefix}: ${argument}`);
    }
    const option = CLI_OPTIONS[token.name as keyof typeof CLI_OPTIONS];
    const inlineConfig = spec.context !== "module command" && argument.startsWith("--config=");
    const key = argument === token.rawName || inlineConfig ? option?.key : undefined;
    const allowed = key === "configPath"
      || key === spec.flag
      || (spec.module !== undefined && (key === "module" || key === "command" || key === "input"));
    if (key === undefined || !allowed) {
      if (key === "json" || key === "write") throw new UsageError(`${argument} is not valid here`);
      throw new UsageError(`${unknown}: ${argument}`);
    }
    if (Object.hasOwn(values, key)) {
      throw new UsageError(duplicateOptionMessage(key, argument, spec));
    }
    if (key === "json" || key === "write") {
      values[key] = true;
      continue;
    }
    const value = token.value;
    if (typeof value !== "string" || value.length === 0
      || (!inlineConfig && key !== "input" && value.startsWith("-"))) {
      throw new UsageError(valueErrorMessage(key, spec));
    }
    if (key === "input") {
      try {
        values.input = JSON.parse(value) as unknown;
      } catch {
        throw new UsageError("--input-json must be valid JSON");
      }
    } else if (key === "configPath") {
      values.configPath = resolveConfigPath(value, cwd);
    } else {
      values[key] = value;
    }
  }
  const required = requiredArgumentKeys(spec);
  for (const key of required) if (!Object.hasOwn(values, key)) throw new UsageError(ARGUMENT_MESSAGES[key][1]);
  if (spec.context === "route" && !Object.hasOwn(values, "command"))
    throw new UsageError("A module command name is required");
  return values as ParsedCommand;
}

function duplicateOptionMessage(key: ArgumentKey, argument: string, spec: ParseSpec): string {
  if (key === "configPath") {
    return spec.context === "module command"
      ? "--config requires one path"
      : "--config may be supplied only once";
  }
  if (key === "json" || key === "write") {
    return `${argument} is not valid here`;
  }
  return ARGUMENT_MESSAGES[key][0];
}

function valueErrorMessage(key: ValueKey, spec: ParseSpec): string {
  if (key === "configPath" && spec.context === "module command") {
    return "--config requires one path";
  }
  return ARGUMENT_MESSAGES[key][0];
}

function resolveConfigPath(value: string, cwd: string): string {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(cwd, value);
}

function requiredArgumentKeys(spec: ParseSpec): readonly ValueKey[] {
  if (spec.context === "module command") {
    return ["configPath", "module", "command"];
  }
  if (spec.module === "required") {
    return ["configPath", "module"];
  }
  return ["configPath"];
}

function selectModule(
  modules: readonly LoadedAgentModule[], instanceId: string | undefined, route: string, slot: ModuleKind,
): LoadedAgentModule {
  if (instanceId === undefined) {
    const candidates = modules.filter((module) => module.slot === slot);
    if (candidates.length === 0) throw new Error(`No ${slot} module is configured; ${route} is unavailable`);
    if (candidates.length > 1)
      throw new Error(`${route} requires --module because multiple ${slot} modules are configured`);
    return candidates[0]!;
  }
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
function listenForShutdown(signalSource: CliSignalSource): {
  readonly requested: Promise<void>;
  dispose(): void;
} {
  let signaled = false;
  let resolveRequest = (): void => undefined;
  const requested = new Promise<void>((resolvePromise) => {
    resolveRequest = resolvePromise;
  });
  const dispose = (): void => {
    signalSource.removeListener("SIGINT", onSignal);
    signalSource.removeListener("SIGTERM", onSignal);
  };
  const onSignal = (): void => {
    if (signaled) {
      return;
    }
    signaled = true;
    dispose();
    resolveRequest();
  };
  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);
  return { requested, dispose };
}

async function stopHost(host: AgentHost): Promise<void> {
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
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Agent drain and stop both failed");
  }
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
