import { createRequire } from "node:module";

import { EFFORT_LEVELS } from "@mono-agent/config";

import { REMOVED_COMMANDS } from "./cli-args.js";
import { readinessProbeTimeoutDescription } from "./readiness-probe.js";
import * as ui from "./ui.js";

/** The grouped-summary buckets and their display order. */
type HelpGroupId = "Setup" | "Check" | "Run" | "Console" | "Observe" | "Maintain";

interface HelpEntry {
  /** Canonical command key (also the `help <command>` topic). */
  readonly command: string;
  /** Which summary-screen bucket this command belongs to. */
  readonly group: HelpGroupId;
  /**
   * Short summary-screen signature: command name plus its primary subcommand
   * shape only (e.g. `runs [report|audit]`). Full flag signatures live in the
   * detail view, not on the scannable summary.
   */
  readonly short: string;
  /** One-line description shown beside {@link short} on the summary screen. */
  readonly summary: string;
  /** True when a PR3 `--json` surface exists; renders a `[--json]` marker. */
  readonly json?: boolean;
  /** Full signature block for the `help <command>` detail view. */
  readonly signature: string;
  /** Detail lines for the `help <command>` view. */
  readonly lines: readonly string[];
}

const HELP_COMMANDS: readonly HelpEntry[] = [
  {
    command: "init",
    group: "Setup",
    short: "init",
    summary: "Scaffold a new agent (guided path runs live probes; --preset/--yes skip).",
    signature: "mono-agent init [--preset <id>] [--with <csv>] [--yes] [--auth] [--dry-run]\n" +
      "                [--name <display-name>] [--model <ref>] [--effort <level>]\n" +
      "                [--fallback <ref> [--fallback-effort <provider-default|level>]]...\n" +
      "                [--route-safety uniform|per-route-native]\n" +
      "                [--codex-auth browser|device] [--memory lite|journal|bujo]",
    lines: [
      "Fast scaffold-only path: flags or non-TTY input; without explicit --auth,",
      "it makes no provider call and never claims readiness. Bare init on a TTY runs",
      "a real no-tool model call per selected route before committing the scaffold,",
      `with timeouts of ${readinessProbeTimeoutDescription()}.`,
      "--preset seeds a blueprint; --with adds channels.",
      `Effort levels: ${EFFORT_LEVELS.join(", ")}; an omitted fallback effort uses that provider's default.`,
      "Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF; direct codex:* forwards ultra unchanged.",
      "Mono-agent rejects ultra on its Claude SDK route because the pinned SDK public contract ends at max (the SDK JavaScript itself forwards the value).",
      "The Claude CLI route passes --effort ultra, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort.",
      "Direct OpenCode rejects explicit effort. Ranking above max only prevents keyword downgrade.",
      "--auth runs supported provider auth/preflight before writing; --codex-auth device supports headless hosts.",
      "--dry-run previews only. Existing scaffold/config files are not overwritten;",
      "guided secret setup may securely update .env and .gitignore after explicit review.",
    ],
  },
  {
    command: "presets",
    group: "Setup",
    short: "presets list|show <id>",
    summary: "List the built-in setup presets, or show one's config.",
    json: true,
    signature: "mono-agent presets list | show <id> [--json]",
    lines: [
      "List the built-in setup presets, or show one's generated config,",
      ".env.example, and follow-up checklist.",
      "Both `list` and `show` accept --json for the machine-readable form.",
    ],
  },
  {
    command: "auth",
    group: "Setup",
    short: "auth login <provider>",
    summary: "Log in to a bundled Pi provider, or direct Codex.",
    signature: "mono-agent auth login <provider|codex> [--pi-auth-path <path>] [--api-key-stdin]\n" +
      "                       [--codex-auth browser|device] [--config <path>]",
    lines: [
      "Run a supported bundled Pi provider login, or direct Codex browser/device login.",
      "Pi credentials are promoted with owner-only no-clobber checks.",
      "API-key providers prompt securely on a TTY; --api-key-stdin explicitly reads a redirected secret.",
      "Path precedence: --pi-auth-path, MONO_AGENT_PI_AUTH_PATH, providers.piAuthPath, then Pi's default.",
      "Supported Pi targets: anthropic, github-copilot, openai-codex, and opencode-go.",
    ],
  },
  {
    command: "sandbox",
    group: "Setup",
    short: "sandbox status|setup|check",
    summary: "Inspect, install, or prove the pinned SRT sandbox.",
    json: true,
    signature: "mono-agent sandbox status | setup | check",
    lines: [
      "Inspect, install, or functionally prove the pinned SRT sandbox runtime.",
      "Managed setup is macOS-only and installs into the user's cache; it never changes PATH,",
      "global npm packages, system packages, or another user's files.",
      "Only the read-only `sandbox status` accepts --json.",
    ],
  },
  {
    command: "install-skill",
    group: "Setup",
    short: "install-skill",
    summary: "Install or refresh the composer skill and docs MCP.",
    json: true,
    signature: "mono-agent install-skill [--target claude|codex|both] [--force] [--no-docs-mcp]\n" +
      "                         --project (--check|--update)",
    lines: [
      "Copy the bundled mono-agent-composer skill into ~/.claude/skills and",
      "~/.agents/skills (default: both). Refuses to overwrite without --force.",
      "By default, pair exact-version mono-agent-docs with every available target",
      "CLI. --no-docs-mcp stays file-only; --force never replaces an unmanaged MCP.",
      "Project mode checks or safely updates the two managed skills generated",
      "by init; modified copies are never overwritten, updates retain backups,",
      "and user-level MCP configuration is not changed.",
      "Only the read-only `install-skill --project --check` accepts --json.",
    ],
  },
  {
    command: "validate",
    group: "Check",
    short: "validate",
    summary: "Load every config section; report what runs, waits, or fails.",
    json: true,
    signature: "mono-agent validate [--preset <id>] [--consumer <path>] [--config <path>] [--env-file <path>] [--json]",
    lines: [
      "Load every config section and report what would run, wait, or fail.",
      "--consumer validates another agent folder read-only, including its .env.",
      "With --preset, also report whether the preset's capabilities are live.",
      "`mono-agent doctor` is an alias for this command.",
    ],
  },
  {
    command: "config",
    group: "Check",
    short: "config",
    summary: "Print the resolved config field-by-field with provenance.",
    json: true,
    signature: "mono-agent config [--config <path>] [--env-file <path>] [--json]",
    lines: [
      "Print the resolved config field-by-field, tagging each value with where",
      "it came from (env / json / default), plus the channel summary. Read-only.",
    ],
  },
  {
    command: "start",
    group: "Run",
    short: "start",
    summary: "Start the agent as a background launchd service.",
    signature: "mono-agent start [--config <path>] [--env-file <path>] [--foreground]",
    lines: [
      "Start the agent as a background macOS service (launchd), print its",
      "instance info, and return. Re-running restarts the running instance.",
      "Refuses to start without a valid mono-agent.config.json in the folder.",
      "Use --foreground to run in the blocking foreground instead.",
    ],
  },
  {
    command: "restart",
    group: "Run",
    short: "restart",
    summary: "Restart this config's instance (starts it if stopped).",
    signature: "mono-agent restart [--config <path>] [--clear-sessions]",
    lines: [
      "Restart the background instance for this config (starts it if stopped).",
      "--clear-sessions clears persisted pi sessions and active conversation history",
      "so the agent starts fresh. Durable memory and run artifacts are untouched.",
    ],
  },
  {
    command: "stop",
    group: "Run",
    short: "stop",
    summary: "Stop the instance and remove its LaunchAgent.",
    signature: "mono-agent stop [--config <path>]",
    lines: ["Stop the background instance and remove its LaunchAgent."],
  },
  {
    command: "status",
    group: "Run",
    short: "status",
    summary: "Show this config's instance plus other running instances.",
    json: true,
    signature: "mono-agent status [--config <path>] [--json]",
    lines: ["Show this config's instance plus any other running instances."],
  },
  {
    command: "logs",
    group: "Run",
    short: "logs",
    summary: "Print (and optionally follow) the background log files.",
    signature: "mono-agent logs [--config <path>] [--follow|-f] [--lines <n>]",
    lines: ["Print (and optionally follow) the background instance's log files."],
  },
  {
    command: "tui",
    group: "Console",
    short: "tui",
    summary: "Operator console: live chat, recorded-run replay, config view.",
    signature: "mono-agent tui [--agent <label|sourceId>] [--conversation <id>]\n" +
      "               [--configure | --local]",
    lines: [
      "Open the operator console from any directory: live chat with structured",
      "thinking/tool/telemetry insight, recorded-run replay, and config view.",
      "Discovers running agents via the trace-source registry; one running",
      "agent connects directly, several open a picker.",
      "--configure opens the guided configuration chat on the authoritative",
      "background agent; --local is an ordinary in-process chat only.",
    ],
  },
  {
    command: "web",
    group: "Console",
    short: "web [start|stop|status|...]",
    summary: "Always-on assistant-ui console for every local agent.",
    signature: "mono-agent web [start|stop|restart|status|logs|run] [--host <addr>|--loopback] [--port <n>]\n" +
      "               web reset --all --yes",
    lines: [
      "Operate the always-on assistant-ui console for persistent conversations",
      "with every discovered local agent. Bare `web` prints status and help only.",
      "The default 0.0.0.0:5050 bind is reachable over LAN/Tailnet; --loopback",
      "narrows it to 127.0.0.1. There is no app login: network reachability is",
      "the access boundary. start/restart claim a conflict-free Tailscale Serve",
      "HTTPS port without replacing existing handlers; run stays in the foreground.",
    ],
  },
  {
    command: "runs",
    group: "Observe",
    short: "runs [report|audit]",
    summary: "Read-only reporting over local agent-run artifacts.",
    json: true,
    signature:
      "mono-agent runs [report|audit] [--artifacts <path> | --consumer <path>]\n" +
      "                [--since <iso>] [--until <iso>] [--by model|channel|failureKind]\n" +
      "                [--stale-after-ms <n>] [--include-memory] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Read-only, offline reporting over local agent-run summary artifacts.",
      "report (default): status/failure-kind rates, duration percentiles, and",
      "total/per-run cost, optionally windowed (--since/--until) and grouped (--by).",
      "audit: artifact integrity — parse failures, status/failure-kind histograms,",
      "stale running summaries (never rewritten), and per-failure-kind rates.",
      "--include-memory adds memory-run artifacts.",
    ],
  },
  {
    command: "backfill",
    group: "Observe",
    short: "backfill",
    summary: "Export recorded run artifacts to the Phoenix exporter.",
    signature:
      "mono-agent backfill (--run <id> | --all) [--since <iso>] [--until <iso>]\n" +
      "                    [--include-memory] [--dry-run] [--config <path>] [--env-file <path>]",
    lines: [
      "Export already-recorded agent-run artifacts to the configured Phoenix exporter",
      "with their historical timestamps. Trace ids are deterministic per run, so",
      "re-running overwrites rather than duplicating. --dry-run maps and",
      "serializes without sending. --include-memory adds memory-run artifacts",
      "for --all; explicit --run can target a memory run directly.",
    ],
  },
  {
    command: "memory",
    group: "Maintain",
    short: "memory <subcommand>",
    summary: "Preview and operate the configured memory store.",
    json: true,
    signature:
      "mono-agent memory [stats|today|show <date>|search <query>|top|audit|inspect [id]|retry [id]|resolve <id> <reason>|rebuild|rollback|adopt-replay]\n" +
      "mono-agent memory forget prepare --ids-file <file> --reason <slug> --plan <file>\n" +
      "mono-agent memory forget apply --plan <file> | forget restore --backup <dir>\n" +
      "                  [--limit <n>] [--strict] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Preview the configured memory store from an agent folder. Reads the",
      "memory block from mono-agent.config.json, not the standalone memory-bujo",
      "env workflow. Human-first output by default; audit --strict --json is a",
      "metadata-only health gate. Intake inspect/retry/resolve never print payload content.",
      "adopt-replay is an explicit stopped-agent, SSH-safe BuJo trust-on-first-use",
      "operation. It returns metadata only and requires rebuild before restart.",
      "forget uses an explicit, content-free plan plus a full owner-private backup;",
      "apply and restore require the configured agent to be stopped.",
    ],
  },
  {
    command: "continuations",
    group: "Maintain",
    short: "continuations <subcommand>",
    summary: "Inspect and operate the durable-continuation service.",
    json: true,
    signature:
      "mono-agent continuations [list [--limit <n>] [--cursor <opaque>]|health|retry <id>|cancel <id>|resolve <id> delivered|not-delivered|dead-lettered [delivery-id]] [--json]",
    lines: [
      "Inspect and operate the authenticated durable-continuation service.",
      "Ambiguous delivery cannot be retried until it is explicitly resolved;",
      "no command accepts or changes a channel destination.",
    ],
  },
];

const HELP_COMMANDS_BY_KEY = new Map(HELP_COMMANDS.map((entry) => [entry.command, entry]));

/** Display order of the summary-screen groups, with optional heading notes. */
const HELP_GROUPS: readonly { readonly id: HelpGroupId; readonly note?: string }[] = [
  { id: "Setup" },
  { id: "Check" },
  { id: "Run", note: "(background lifecycle is macOS/launchd; elsewhere use start --foreground)" },
  { id: "Console" },
  { id: "Observe" },
  { id: "Maintain" },
];

/** `help <alias>` resolves to the canonical command's detail view, noting the alias. */
const HELP_ALIASES = new Map<string, string>([
  ["doctor", "validate"],
  ["setup", "init"],
]);

const HELP_NOTES = `Background mode runs the agent under launchd, keeping it alive across logins
(auto-restarting only on crash) until you run stop. Secrets are read from the
.env file in the working directory, the same as foreground mode. The background
commands require macOS; elsewhere use start --foreground.

Init model references look like pi:<provider>:<model>, claude:claude-sonnet-4-6,
codex:gpt-5.6-terra, codex:gpt-5.6-sol, or opencode:<provider>:<model>. The init wizard
selects the live provider-declared default when available and falls back offline to
codex:gpt-5.6-terra. Direct and Pi OpenAI-Codex Sol choices remain selectable.
Direct GPT-5.6 routes require Codex CLI 0.144.0 or newer. Guided Pi authentication
covers Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go. Claude remains selectable;
direct opencode:<provider>:<model> refs are for
hand-authored runtime backend config and are rejected by guided selection/readiness.

Mixed fallback chains are allowed. runtime.routeSafety=uniform (the default)
requires one compatibility-preserving contract across every route;
per-route-native makes each route's exact safety boundary explicit (Pi SRT,
Claude provider-owned permissions, Codex native sandbox, or OpenCode native).

Native mono-agent srt policy is enforced by Pi-owned tools. In uniform mode,
Claude, direct Codex, and direct OpenCode cannot silently weaken that policy.
In per-route-native mode, validate reports each provider-owned safety contract
and rejects capabilities that the selected route cannot represent.
Direct OpenCode's bridge cannot enforce an explicit runtime.effort; omit effort and
configure runtime.permissionMode deliberately for hand-authored direct routes.
It is per-run/non-resumable and rejects MCP (including auto-provisioned memory
or send tools), positive maxTurns, index skill disclosure, structured output,
live input, fast mode, and native subagents instead of silently dropping them.

A .env file in the current folder is loaded automatically when present;
already-exported shell variables take precedence.
`;

const HELP_BANNER_SUBTITLE = "config-first agent host";

function helpBanner(): string {
  return `${ui.banner("mono-agent", HELP_BANNER_SUBTITLE)}\n`;
}

/**
 * Build the default grouped help summary: one scannable line per command under
 * its group heading, with `[--json]` markers on the PR3 JSON surfaces. Also used
 * by the error paths (unknown command / parse failure) so those stay short.
 */
export function renderHelp(): string {
  const width = HELP_COMMANDS.reduce((max, entry) => Math.max(max, entry.short.length), 0);
  let out = helpBanner();
  for (const group of HELP_GROUPS) {
    let heading = ui.style.bold(ui.style.cyan(group.id));
    if (group.note !== undefined) {
      heading += ` ${ui.style.dim(group.note)}`;
    }
    out += `${heading}\n`;
    for (const entry of HELP_COMMANDS.filter((candidate) => candidate.group === group.id)) {
      const shortColumn = ui.style.cyan(entry.short.padEnd(width));
      const jsonMarker = entry.json === true ? ui.style.dim("  [--json]") : "";
      out += `  ${shortColumn}  ${entry.summary}${jsonMarker}\n`;
    }
    out += "\n";
  }
  out += `${ui.style.dim("Run `mono-agent help <command>` for full flags and behavior notes.")}\n`;
  out += `${ui.style.dim("Run `mono-agent help notes` for model references, fallback chains, and env-file rules.")}\n`;
  return out;
}

/** The outcome of resolving a `help <topic>` request. */
export type HelpTopicResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve a `help <topic>` request: `notes` prints the notes block, a command
 * (or its alias) prints that command's detail view, a removed command prints its
 * replacement pointer, and anything else is a usage error listing valid topics.
 */
export function renderHelpTopic(topic: string): HelpTopicResult {
  if (topic === "notes") {
    return { ok: true, text: `${helpBanner()}${ui.style.dim(HELP_NOTES)}` };
  }
  const removed = REMOVED_COMMANDS.get(topic);
  if (removed !== undefined) {
    return { ok: true, text: `${helpBanner()}${ui.style.dim(removed)}\n` };
  }
  const canonical = HELP_ALIASES.get(topic) ?? topic;
  const entry = HELP_COMMANDS_BY_KEY.get(canonical);
  if (entry === undefined) {
    return { ok: false, message: unknownHelpTopicMessage(topic) };
  }
  const aliasNote = canonical === topic ? undefined : `\`${topic}\` is an alias of \`${canonical}\`.`;
  return { ok: true, text: renderHelpEntryDetail(entry, aliasNote) };
}

function unknownHelpTopicMessage(topic: string): string {
  const topics = [...HELP_COMMANDS.map((entry) => entry.command), "notes"].join(", ");
  return `Unknown help topic \`${topic}\`. Valid topics: ${topics}.`;
}

/** Render one command's full signature + behavior notes (the `help <command>` view). */
function renderHelpEntryDetail(entry: HelpEntry, aliasNote: string | undefined): string {
  let out = helpBanner();
  if (aliasNote !== undefined) {
    out += `${ui.style.dim(aliasNote)}\n`;
  }
  const [first, ...rest] = entry.signature.split("\n");
  out += `  ${ui.style.bold(ui.style.cyan(first ?? ""))}\n`;
  for (const cont of rest) {
    out += `  ${ui.style.cyan(cont)}\n`;
  }
  for (const line of entry.lines) {
    out += `      ${ui.style.dim(line)}\n`;
  }
  return out;
}

/**
 * The published CLI version, read from this package's own package.json at
 * runtime. `../package.json` resolves the same from both `src/cli.ts` (tests) and
 * the built `dist/cli.js` (one level below the package root in both layouts), and
 * npm always ships package.json in the tarball. Best-effort: a read failure yields
 * "unknown" rather than crashing `--version`.
 */
export function monoAgentVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
