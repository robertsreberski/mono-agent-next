import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import process from "node:process";

import {
  composerSkillDestinations,
  installComposerSkill,
} from "./install-skill.js";
import type { InstallSkillOptions, InstallSkillResult, InstallSkillTarget } from "./install-skill.js";

export const DOCS_MCP_SERVER_NAME = "mono-agent-docs";
const DOCS_MCP_PACKAGE = "@mono-agent/docs-mcp";

type HarnessTarget = Exclude<InstallSkillTarget, "both">;
type PairingState = "paired" | "already-current" | "upgraded" | "skipped-missing";

export interface DocsMcpPairingStatus {
  readonly target: HarnessTarget;
  readonly state: PairingState;
  readonly command: string;
}

export interface InstallComposerCompanionResult extends InstallSkillResult {
  readonly pairings: readonly DocsMcpPairingStatus[];
}

export interface DocsMcpEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface DocsMcpHarnessAdapter {
  readonly target: HarnessTarget;
  isAvailable(): Promise<boolean>;
  read(): Promise<DocsMcpEntry | undefined>;
  add(entry: DocsMcpEntry): Promise<void>;
  remove(): Promise<void>;
}

export interface DocsMcpPairingDependencies {
  readonly harnesses: Readonly<Record<HarnessTarget, DocsMcpHarnessAdapter>>;
  isNpxAvailable(): Promise<boolean>;
}

export interface InstallComposerCompanionOptions extends InstallSkillOptions {
  readonly pairDocsMcp: boolean;
  readonly docsMcpVersion?: string;
}

export async function installComposerCompanion(
  options: InstallComposerCompanionOptions,
  dependencies?: DocsMcpPairingDependencies,
): Promise<InstallComposerCompanionResult> {
  if (!options.pairDocsMcp) {
    const result = await installComposerSkill(options);
    return { ...result, pairings: [] };
  }
  const version = options.docsMcpVersion?.trim();
  if (version === undefined || version.length === 0) {
    throw new Error("Cannot pair @mono-agent/docs-mcp because the installed @mono-agent/agent-app version is unavailable.");
  }
  const homeDir = options.homeDir ?? homedir();
  if (dependencies === undefined && homeDir !== homedir()) {
    throw new Error("A custom homeDir requires injected MCP pairing dependencies.");
  }
  const activeDependencies = dependencies ?? realPairingDependencies(homeDir);
  const destinations = composerSkillDestinations(options.target, homeDir);
  if (!options.force) {
    for (const destination of destinations) {
      if (await pathExists(destination)) {
        throw new Error(`Destination ${destination} already exists. Re-run with --force to overwrite.`);
      }
    }
  }

  const selectedTargets = targetList(options.target);
  const availableTargets: HarnessTarget[] = [];
  const statuses: DocsMcpPairingStatus[] = [];
  for (const target of selectedTargets) {
    if (await activeDependencies.harnesses[target].isAvailable()) {
      availableTargets.push(target);
    } else {
      statuses.push({ target, state: "skipped-missing", command: manualPairingCommand(target, version) });
    }
  }
  if (availableTargets.length === 0) {
    throw new Error(`Cannot pair ${DOCS_MCP_SERVER_NAME}: none of the selected harness CLIs (${selectedTargets.join(", ")}) are available on PATH. Re-run with --no-docs-mcp to install only the skill.`);
  }
  if (!(await activeDependencies.isNpxAvailable())) {
    throw new Error("Cannot pair mono-agent-docs because npx is not available on PATH.");
  }

  const desiredEntry = managedEntry(version);
  const existingEntries = new Map<HarnessTarget, DocsMcpEntry | undefined>();
  for (const target of availableTargets) {
    const existing = await activeDependencies.harnesses[target].read();
    if (existing !== undefined && !isManagedEntry(existing)) {
      throw new Error(`MCP server name ${DOCS_MCP_SERVER_NAME} already exists in ${target} with an unmanaged configuration; remove or rename it manually. --force will not overwrite it.`);
    }
    existingEntries.set(target, existing);
  }

  const backupRoot = await mkdtemp(join(tmpdir(), "mono-agent-composer-install-"));
  const destinationBackups = new Map<string, string>();
  try {
    for (const [index, destination] of destinations.entries()) {
      if (await pathExists(destination)) {
        const backup = join(backupRoot, `skill-${index}`);
        await cp(destination, backup, { recursive: true, force: true });
        destinationBackups.set(destination, backup);
      }
    }

    const changedTargets: HarnessTarget[] = [];
    try {
      for (const target of availableTargets) {
        const adapter = activeDependencies.harnesses[target];
        const existing = existingEntries.get(target);
        if (existing !== undefined && entriesEqual(existing, desiredEntry)) {
          statuses.push({ target, state: "already-current", command: manualPairingCommand(target, version) });
          continue;
        }
        if (existing !== undefined) await adapter.remove();
        try {
          await adapter.add(desiredEntry);
        } catch (error) {
          if (existing !== undefined) {
            try {
              await adapter.add(existing);
            } catch (restoreError) {
              throw new Error(`${errorMessage(error)} Restoring the previous ${target} entry also failed: ${errorMessage(restoreError)}`);
            }
          }
          throw error;
        }
        changedTargets.push(target);
        const verified = await adapter.read();
        if (verified === undefined || !entriesEqual(verified, desiredEntry)) {
          throw new Error(`${target} did not persist the expected ${DOCS_MCP_SERVER_NAME} MCP configuration.`);
        }
        statuses.push({
          target,
          state: existing === undefined ? "paired" : "upgraded",
          command: manualPairingCommand(target, version),
        });
      }

      try {
        const skillResult = await installComposerSkill(options);
        return {
          ...skillResult,
          pairings: selectedTargets.map((target) => statuses.find((status) => status.target === target)!),
        };
      } catch (error) {
        await restoreDestinations(destinations, destinationBackups);
        throw error;
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const target of [...changedTargets].reverse()) {
        const adapter = activeDependencies.harnesses[target];
        try {
          await adapter.remove();
          const existing = existingEntries.get(target);
          if (existing !== undefined) await adapter.add(existing);
        } catch (rollbackError) {
          rollbackErrors.push(`${target}: ${errorMessage(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${errorMessage(error)} Rollback also failed (${rollbackErrors.join("; ")}).`);
      }
      throw error;
    }
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
}

function realPairingDependencies(homeDir: string): DocsMcpPairingDependencies {
  return {
    isNpxAvailable: () => executableAvailable("npx"),
    harnesses: {
      codex: {
        target: "codex",
        isAvailable: () => executableAvailable("codex"),
        read: readCodexEntry,
        add: async (entry) => runChecked("codex", ["mcp", "add", DOCS_MCP_SERVER_NAME, "--", entry.command, ...entry.args]),
        remove: async () => runChecked("codex", ["mcp", "remove", DOCS_MCP_SERVER_NAME]),
      },
      claude: {
        target: "claude",
        isAvailable: () => executableAvailable("claude"),
        read: () => readClaudeEntry(homeDir),
        add: async (entry) => runChecked("claude", ["mcp", "add", "--scope", "user", DOCS_MCP_SERVER_NAME, "--", entry.command, ...entry.args]),
        remove: async () => runChecked("claude", ["mcp", "remove", "--scope", "user", DOCS_MCP_SERVER_NAME]),
      },
    },
  };
}

async function readCodexEntry(): Promise<DocsMcpEntry | undefined> {
  const result = await runProcess("codex", ["mcp", "get", DOCS_MCP_SERVER_NAME, "--json"]);
  if (result.code !== 0) {
    if (/not found|no mcp server|does not exist/iu.test(`${result.stdout}\n${result.stderr}`)) return undefined;
    throw new Error(`codex mcp get failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("codex mcp get returned invalid JSON.");
  }
  return normalizeEntry(parsed, "Codex");
}

async function readClaudeEntry(homeDir: string): Promise<DocsMcpEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(homeDir, ".claude.json"), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("~/.claude.json is not valid JSON; refusing to change MCP configuration.");
  }
  if (!isObject(parsed) || !isObject(parsed.mcpServers)) return undefined;
  const candidate = parsed.mcpServers[DOCS_MCP_SERVER_NAME];
  return candidate === undefined ? undefined : normalizeEntry(candidate, "Claude");
}

function normalizeEntry(raw: unknown, label: string): DocsMcpEntry {
  if (!isObject(raw)) throw new Error(`${label} returned an invalid ${DOCS_MCP_SERVER_NAME} MCP configuration.`);
  const transport = isObject(raw.transport) ? raw.transport : raw;
  const type = transport.type;
  if (type !== undefined && type !== "stdio") {
    return { command: `<${String(type)}>`, args: [] };
  }
  if (typeof transport.command !== "string" || !Array.isArray(transport.args) || !transport.args.every((value) => typeof value === "string")) {
    throw new Error(`${label} returned an unrecognized ${DOCS_MCP_SERVER_NAME} MCP configuration.`);
  }
  const env = isObject(transport.env)
    ? Object.fromEntries(Object.entries(transport.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    command: transport.command,
    args: transport.args,
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
  };
}

function managedEntry(version: string): DocsMcpEntry {
  return { command: "npx", args: ["-y", `${DOCS_MCP_PACKAGE}@${version}`] };
}

function isManagedEntry(entry: DocsMcpEntry): boolean {
  return entry.command === "npx"
    && entry.args.length === 2
    && entry.args[0] === "-y"
    && /^@mono-agent\/docs-mcp@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u.test(entry.args[1] ?? "")
    && Object.keys(entry.env ?? {}).length === 0;
}

function entriesEqual(left: DocsMcpEntry, right: DocsMcpEntry): boolean {
  return left.command === right.command
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index])
    && Object.keys(left.env ?? {}).length === 0
    && Object.keys(right.env ?? {}).length === 0;
}

function targetList(target: InstallSkillTarget): readonly HarnessTarget[] {
  return target === "both" ? ["claude", "codex"] : [target];
}

function manualPairingCommand(target: HarnessTarget, version: string): string {
  const command = `npx -y ${DOCS_MCP_PACKAGE}@${version}`;
  return target === "claude"
    ? `claude mcp add --scope user ${DOCS_MCP_SERVER_NAME} -- ${command}`
    : `codex mcp add ${DOCS_MCP_SERVER_NAME} -- ${command}`;
}

async function restoreDestinations(destinations: readonly string[], backups: ReadonlyMap<string, string>): Promise<void> {
  for (const destination of destinations) {
    await rm(destination, { recursive: true, force: true });
    const backup = backups.get(destination);
    if (backup !== undefined) await cp(backup, destination, { recursive: true, force: true });
  }
}

async function executableAvailable(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return false;
}

async function runChecked(command: string, args: readonly string[]): Promise<void> {
  const result = await runProcess(command, args);
  if (result.code !== 0) {
    throw new Error(`${basename(command)} ${args.slice(0, 3).join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
}

async function runProcess(command: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout: stdout.slice(0, 65_536), stderr: stderr.slice(0, 65_536) });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
