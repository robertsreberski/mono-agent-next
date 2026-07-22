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

export function openCodeProcessEnvironment(
  explicit: Readonly<Record<string, string>> = {},
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of OPERATIONAL_ENVIRONMENT) {
    const value = ambient[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) environment[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) environment[name] = value;
  return environment;
}
