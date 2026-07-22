import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentResponderLike } from "../agent/responder.js";

export interface ParsedArgs {
  readonly responder?: string;
  readonly config?: string;
  readonly title?: string;
  readonly conversationId?: string;
  readonly url?: string;
  readonly apiKey?: string;
  readonly registryDir?: string;
  readonly help: boolean;
}

export type ParseArgsResult = ParsedArgs | { readonly error: string };

const VALUE_FLAGS: Record<string, keyof Omit<ParsedArgs, "help">> = {
  "--responder": "responder",
  "--config": "config",
  "--title": "title",
  "--conversation": "conversationId",
  "--url": "url",
  "--api-key": "apiKey",
  "--registry-dir": "registryDir",
};

/**
 * Parse the `mono-agent-tui` argv (already stripped of `node` + script path).
 * Pure and side-effect free so it can be unit-tested without booting the CLI.
 */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  let help = false;
  const values: Partial<Record<keyof Omit<ParsedArgs, "help">, string>> = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      help = true;
      continue;
    }
    const key = flag === undefined ? undefined : VALUE_FLAGS[flag];
    if (key !== undefined) {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: `${flag} requires a value` };
      }
      values[key] = value;
      i++;
      continue;
    }
    return { error: `unknown argument: ${String(flag)}` };
  }

  if (values.responder !== undefined && values.url !== undefined) {
    return { error: "--responder and --url are mutually exclusive" };
  }

  return { help, ...values };
}

export const HELP_TEXT = `Usage: mono-agent-tui [options]

Connection (exactly one):
  --responder <file>      Path to an ESM module that default-exports an
                          AgentResponderLike, or exports
                          createResponder(env, cwd, configJson). In-process mode.
  --url <baseUrl>         Connect to a running agent's tui endpoint
                          (e.g. http://127.0.0.1:52341/gui).
  (neither)               Discover running agents from the trace-source
                          registry and open on the picker.

Options:
  --api-key <key>         Bearer key for --url when the agent sets tui.apiKey.
  --registry-dir <dir>    Trace-source registry directory (default:
                          ~/.mono-agent/trace-sources).
  --config <path>         Path to mono-agent.config.json. Enables the Config
                          view and is forwarded to createResponder().
  --conversation <id>     Conversation id (default: tui-local).
  --title <text>          Header title (default: "mono-agent").
  -h, --help              Show this help and exit.

Prefer \`mono-agent tui\` (from @mono-agent/agent-app): it resolves running
agents, endpoints, and keys automatically. This bin is the low-level surface
for custom hosts.
`;

export function exitWithError(message: string): never {
  process.stderr.write(`mono-agent-tui: ${message}\n`);
  process.stderr.write(HELP_TEXT);
  process.exit(2);
}

function isAgentResponderLike(value: unknown): value is AgentResponderLike {
  return typeof (value as { readonly respond?: unknown } | null | undefined)?.respond === "function";
}

/**
 * Resolve and import an `AgentResponderLike` from a host-supplied module.
 * Accepts either a `createResponder(env, cwd, configPath)` factory export or
 * a default-exported responder. Exits the process with a 2 on user error.
 */
export async function loadResponder(
  responderPath: string,
  configPath: string | undefined,
): Promise<AgentResponderLike> {
  const absolute = resolve(process.cwd(), responderPath);
  if (!existsSync(absolute)) {
    exitWithError(`responder file not found: ${absolute}`);
  }
  const moduleUrl = pathToFileURL(absolute).href;
  const moduleExports = (await import(moduleUrl)) as {
    default?: unknown;
    createResponder?: (
      env: Record<string, string | undefined>,
      cwd: string,
      configPath: string | undefined,
    ) => Promise<unknown> | unknown;
  };

  if (typeof moduleExports.createResponder === "function") {
    const result = await moduleExports.createResponder(
      { ...process.env },
      process.cwd(),
      configPath,
    );
    if (!isAgentResponderLike(result)) {
      exitWithError(`createResponder() from module ${absolute} did not return an AgentResponderLike.`);
    }
    return result;
  }
  if (isAgentResponderLike(moduleExports.default)) {
    return moduleExports.default;
  }
  exitWithError(
    `module ${absolute} did not export a default AgentResponderLike or createResponder().`,
  );
}
