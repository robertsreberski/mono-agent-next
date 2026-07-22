import { sanitizeTerminalText } from "../ui/terminal-text.js";

export interface ParsedArgs {
  readonly endpoint?: string;
  readonly tokenEnvironment?: string;
  readonly registryDirectories: readonly string[];
  readonly operatorId?: string;
  readonly conversationId?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly help: boolean;
}

export type ParseArgsResult = ParsedArgs | { readonly error: string };

const VALUE_FLAGS = new Map<string, Exclude<keyof ParsedArgs, "help" | "registryDirectories">>([
  ["--endpoint", "endpoint"],
  ["--token-env", "tokenEnvironment"],
  ["--agent", "operatorId"],
  ["--conversation", "conversationId"],
  ["--title", "title"],
  ["--model", "model"],
  ["--effort", "effort"],
]);

/** Parse `mono-agent-tui` arguments without accessing the process or filesystem. */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const values: {
    -readonly [Key in Exclude<keyof ParsedArgs, "help" | "registryDirectories">]?: string;
  } = {};
  const registryDirectories: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "-h" || flag === "--help") {
      help = true;
      continue;
    }
    const key = flag === undefined ? undefined : VALUE_FLAGS.get(flag);
    if (key !== undefined || flag === "--registry") {
      const value = argv[index + 1]?.trim();
      if (value === undefined || value.length === 0) {
        return { error: `${String(flag)} requires a value` };
      }
      if (flag === "--registry") registryDirectories.push(value);
      else if (key !== undefined) values[key] = value;
      index += 1;
      continue;
    }
    return { error: `unknown argument: ${String(flag)}` };
  }

  if (values.endpoint !== undefined && registryDirectories.length > 0) {
    return { error: "--endpoint and --registry are mutually exclusive" };
  }
  if (values.tokenEnvironment !== undefined && values.endpoint === undefined) {
    return { error: "--token-env requires --endpoint" };
  }
  return { ...values, registryDirectories, help };
}

export const HELP_TEXT = `Usage: mono-agent-tui [options]

Connection:
  --endpoint <url>       Connect directly to a loopback operator endpoint.
  --token-env <name>     Read the bearer token from this environment variable.
                         Defaults to required MONO_AGENT_OPERATOR_TOKEN.
  --registry <dir>       Discover running agents in a registry (repeatable).
  --agent <id>           Select one discovered agent by id.
  (neither)              Discover through the operator library's default registry.

Session:
  --conversation <id>    Conversation id (default: tui-<random uuid>).
  --model <ref>          Initial per-turn model override, when eligible.
  --effort <level>       Initial per-turn effort override, when eligible.
  --title <text>         Header title (default: mono-agent).
  -h, --help             Show this help and exit.

Inside the console, /model and /effort change eligible overrides, /cancel or
Escape cancels an active turn, and /exit or /quit closes only this renderer.
`;

export function exitWithError(message: string): never {
  process.stderr.write(`mono-agent-tui: ${sanitizeTerminalText(message)}\n`);
  process.stderr.write(HELP_TEXT);
  process.exit(2);
}
