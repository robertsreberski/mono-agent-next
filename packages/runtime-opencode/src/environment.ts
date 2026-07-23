const OPERATIONAL_ENVIRONMENT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
] as const;

export const OPEN_CODE_TOOL_FREE_AGENT = "mono-agent-runtime";

export interface OpenCodeIsolatedDirectories {
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly state: string;
}

export interface OpenCodeProcessEnvironmentOptions {
  readonly agentName?: string;
  readonly directories?: OpenCodeIsolatedDirectories;
  readonly serverUsername?: string;
  readonly serverPassword?: string;
}

export function openCodeToolFreeConfig(
  agentName = OPEN_CODE_TOOL_FREE_AGENT,
): string {
  return JSON.stringify({
    permission: { "*": "deny" },
    // OpenCode still accepts this legacy switch. Keep it as a second layer so
    // tool definitions are removed as well as denied at execution time.
    tools: { "*": false },
    agent: {
      [agentName]: {
        description: "Tool-free mono-agent runtime bridge",
        mode: "primary",
        permission: { "*": "deny" },
      },
    },
  });
}

export const OPEN_CODE_TOOL_FREE_CONFIG = openCodeToolFreeConfig();

export function openCodeProcessEnvironment(
  explicit: Readonly<Record<string, string>> = {},
  ambient: NodeJS.ProcessEnv = process.env,
  options: OpenCodeProcessEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of OPERATIONAL_ENVIRONMENT) {
    const value = ambient[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) environment[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) environment[name] = value;
  if (options.directories !== undefined) {
    environment.HOME = options.directories.home;
    environment.XDG_CONFIG_HOME = options.directories.config;
    environment.XDG_DATA_HOME = options.directories.data;
    environment.XDG_CACHE_HOME = options.directories.cache;
    environment.XDG_STATE_HOME = options.directories.state;
    delete environment.OPENCODE_CONFIG;
    delete environment.OPENCODE_CONFIG_DIR;
  }
  // These process-owned values are written last so config-provided environment
  // entries cannot widen the server, plugin, or tool boundary.
  environment.OPENCODE_CONFIG_CONTENT = openCodeToolFreeConfig(
    options.agentName ?? OPEN_CODE_TOOL_FREE_AGENT,
  );
  environment.OPENCODE_PERMISSION = JSON.stringify({ "*": "deny" });
  environment.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
  environment.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
  environment.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
  environment.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "true";
  environment.OPENCODE_DISABLE_AUTOUPDATE = "true";
  environment.OPENCODE_PURE = "true";
  if (options.serverUsername !== undefined) {
    environment.OPENCODE_SERVER_USERNAME = options.serverUsername;
  }
  if (options.serverPassword !== undefined) {
    environment.OPENCODE_SERVER_PASSWORD = options.serverPassword;
  }
  return environment;
}
