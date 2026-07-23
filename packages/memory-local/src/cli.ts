import { isAbsolute } from "node:path";

import { MemoryLocalError } from "./errors.js";

export interface MemoryLocalCliOptions {
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
}

interface SnapshotCommand {
  readonly command: "snapshot-v0";
  readonly sourceRoot: string;
  readonly targetRoot: string;
}

interface AdoptCommand {
  readonly command: "adopt-v0";
  readonly liveSourceRoot: string;
  readonly targetRoot: string;
  readonly expectedSourceStateSha256: string;
  readonly expectedTreeSha256: string;
  readonly confirm: string;
}

type ParsedCommand = SnapshotCommand | AdoptCommand;

class UsageError extends Error {}

export async function runMemoryLocalCli(
  argv: readonly string[],
  options: MemoryLocalCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value: string) => process.stderr.write(value));
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(usage());
    return 0;
  }
  try {
    const parsed = parseCommand(argv);
    const migration = await import("./migration.js");
    const result = parsed.command === "snapshot-v0"
      ? await migration.snapshotV0MemoryLocalRoot(parsed)
      : await migration.adoptV0MemoryLocalCopy(parsed);
    stdout(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${usage()}`);
      return 2;
    }
    const code = error instanceof MemoryLocalError
      ? error.code
      : "memory_local_migration_failed";
    const message = error instanceof MemoryLocalError
      ? boundedMessage(error)
      : "Memory migration failed.";
    stderr(`${JSON.stringify({
      ok: false,
      error: {
        code,
        message,
      },
    })}\n`);
    return 1;
  }
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command !== "snapshot-v0" && command !== "adopt-v0") {
    throw new UsageError("Unknown command");
  }
  const values = new Map<string, string>();
  const allowed = command === "snapshot-v0"
    ? new Set(["--source-root", "--target-root"])
    : new Set([
        "--live-source-root",
        "--target-root",
        "--expected-source-state-sha256",
        "--expected-tree-sha256",
        "--confirm",
      ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag)) throw new UsageError("Unknown or misplaced option");
    if (values.has(flag)) throw new UsageError(`${flag} may be supplied only once`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`${flag} requires a value`);
    }
    values.set(flag, value);
  }
  if (command === "snapshot-v0") {
    return {
      command,
      sourceRoot: pathValue(values, "--source-root"),
      targetRoot: pathValue(values, "--target-root"),
    };
  }
  return {
    command,
    liveSourceRoot: pathValue(values, "--live-source-root"),
    targetRoot: pathValue(values, "--target-root"),
    expectedSourceStateSha256: required(values, "--expected-source-state-sha256"),
    expectedTreeSha256: required(values, "--expected-tree-sha256"),
    confirm: required(values, "--confirm"),
  };
}

function pathValue(values: ReadonlyMap<string, string>, flag: string): string {
  const value = required(values, flag);
  if (!isAbsolute(value)) throw new UsageError(`${flag} must be an absolute path`);
  return value;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new UsageError(`${flag} is required`);
  return value;
}

function usage(): string {
  return `Usage:
  mono-agent-memory-local snapshot-v0 --source-root <absolute-path> --target-root <absolute-path>
  mono-agent-memory-local adopt-v0 --live-source-root <absolute-path> --target-root <absolute-path> --expected-source-state-sha256 <source-sha256> --expected-tree-sha256 <tree-sha256> --confirm <same-tree-sha256>
`;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 1_024);
}
