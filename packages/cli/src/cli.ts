import {
  composeAgentConfigSchema,
  createAgentHost,
  explainAgentConfig,
  inspectAgent,
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

interface ParsedOptions {
  configPath: string;
  json: boolean;
  write: boolean;
  path?: string;
}

interface ParsedModuleCommandOptions {
  readonly configPath: string;
  readonly module: string;
  readonly command: string;
  readonly input?: unknown;
}

class UsageError extends Error {}

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
    if (argv[0] === "validate") {
      const options = parseOptions(argv.slice(1), resolvedIo.cwd, {
        json: true,
        write: false,
        positional: false,
      });
      return await runValidate(options, resolvedIo);
    }

    if (argv[0] === "config" && argv[1] === "schema") {
      const options = parseOptions(argv.slice(2), resolvedIo.cwd, {
        json: false,
        write: true,
        positional: false,
      });
      return await runSchema(options, resolvedIo);
    }

    if (argv[0] === "config" && argv[1] === "explain") {
      const options = parseOptions(argv.slice(2), resolvedIo.cwd, {
        json: true,
        write: false,
        positional: true,
      });
      return await runExplain(options, resolvedIo);
    }

    if (argv[0] === "inspect") {
      const options = parseOptions(argv.slice(1), resolvedIo.cwd, {
        json: true,
        write: false,
        positional: false,
      });
      const inspection = await inspectAgent(options.configPath);
      resolvedIo.stdout(`${stringifyJson(inspection, options.json ? undefined : 2)}\n`);
      return 0;
    }

    if (argv[0] === "module" && argv[1] === "command") {
      return await runModuleCommand(parseModuleCommandOptions(argv.slice(2), resolvedIo.cwd), resolvedIo);
    }

    if (argv[0] === "start") {
      const options = parseOptions(argv.slice(1), resolvedIo.cwd, {
        json: false,
        write: false,
        positional: false,
      });
      return await runStart(options, resolvedIo);
    }

    throw new UsageError(`Unknown command: ${argv.join(" ")}`);
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

async function runValidate(options: ParsedOptions, io: ResolvedCliIo): Promise<number> {
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

async function runSchema(options: ParsedOptions, io: ResolvedCliIo): Promise<number> {
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

async function runExplain(options: ParsedOptions, io: ResolvedCliIo): Promise<number> {
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
  if (options.json) {
    io.stdout(`${stringifyJson(explanation)}\n`);
  } else {
    io.stdout(`${stringifyJson(explanation, 2)}\n`);
  }
  return 0;
}

async function runStart(options: ParsedOptions, io: ResolvedCliIo): Promise<number> {
  const validation = await validateAgentConfig(options.configPath);
  if (!validation.ok) {
    io.stderr(renderIssues(validation.issues));
    return 1;
  }

  const host = await createAgentHost(options.configPath);
  await host.start();
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

async function runModuleCommand(options: ParsedModuleCommandOptions, io: ResolvedCliIo): Promise<number> {
  const host = await createAgentHost(options.configPath);
  try {
    const result = await host.runModuleCommand(options.module, options.command, options.input);
    io.stdout(`${stringifyJson({ ok: true, ...result })}\n`);
    return 0;
  } finally {
    await host.stop();
  }
}

function parseModuleCommandOptions(argv: readonly string[], cwd: string): ParsedModuleCommandOptions {
  let configPath: string | undefined;
  let module: string | undefined;
  let command: string | undefined;
  let input: unknown;
  let inputSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = argv[index + 1];
    if (argument === "--config" || argument === "-c") {
      if (configPath !== undefined || next === undefined || next.startsWith("-")) {
        throw new UsageError("--config requires one path");
      }
      configPath = isAbsolute(next) ? next : resolve(cwd, next);
      index += 1;
      continue;
    }
    if (argument === "--module") {
      if (module !== undefined || next === undefined || next.startsWith("-")) {
        throw new UsageError("--module requires one instance id");
      }
      module = next;
      index += 1;
      continue;
    }
    if (argument === "--name") {
      if (command !== undefined || next === undefined || next.startsWith("-")) {
        throw new UsageError("--name requires one command name");
      }
      command = next;
      index += 1;
      continue;
    }
    if (argument === "--input-json") {
      if (inputSeen || next === undefined) throw new UsageError("--input-json requires one JSON value");
      try {
        input = JSON.parse(next) as unknown;
      } catch {
        throw new UsageError("--input-json must be valid JSON");
      }
      inputSeen = true;
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown module command option: ${argument}`);
  }
  if (configPath === undefined) throw new UsageError("--config is required");
  if (module === undefined) throw new UsageError("--module is required");
  if (command === undefined) throw new UsageError("--name is required");
  return { configPath, module, command, ...(inputSeen ? { input } : {}) };
}

function parseOptions(
  argv: readonly string[],
  cwd: string,
  allowed: { json: boolean; write: boolean; positional: boolean },
): ParsedOptions {
  let configValue: string | undefined;
  let json = false;
  let write = false;
  let path: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--config" || argument === "-c") {
      if (configValue !== undefined) {
        throw new UsageError("--config may be supplied only once");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--config requires a path");
      }
      configValue = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--config=")) {
      if (configValue !== undefined) {
        throw new UsageError("--config may be supplied only once");
      }
      configValue = argument.slice("--config=".length);
      if (configValue.length === 0) {
        throw new UsageError("--config requires a path");
      }
      continue;
    }
    if (argument === "--json") {
      if (!allowed.json || json) {
        throw new UsageError(`${argument} is not valid here`);
      }
      json = true;
      continue;
    }
    if (argument === "--write") {
      if (!allowed.write || write) {
        throw new UsageError(`${argument} is not valid here`);
      }
      write = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option: ${argument}`);
    }
    if (!allowed.positional || path !== undefined) {
      throw new UsageError(`Unexpected argument: ${argument}`);
    }
    path = argument;
  }

  if (configValue === undefined) {
    throw new UsageError("--config is required");
  }

  return {
    configPath: isAbsolute(configValue) ? configValue : resolve(cwd, configValue),
    json,
    write,
    ...(path === undefined ? {} : { path }),
  };
}

async function writeSchemaFile(outputPath: string, contents: string): Promise<void> {
  const outputDirectory = dirname(outputPath);
  try {
    const directoryStat = await lstat(outputDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`Schema directory is not a real directory: ${outputDirectory}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  }

  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      throw new Error(`Schema target is not a regular file: ${outputPath}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  const temporaryPath = join(outputDirectory, `.mono-agent.config.schema.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw error;
      }
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
    "  mono-agent config schema --config <file> [--write]",
    "  mono-agent config explain --config <file> [path] [--json]",
    "  mono-agent inspect --config <file> [--json]",
    "  mono-agent module command --config <file> --module <id> --name <command> [--input-json <json>]",
    "  mono-agent start --config <file>",
    "  mono-agent --version",
    "",
  ].join("\n");
}
