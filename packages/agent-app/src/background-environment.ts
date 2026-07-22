import { createHash } from "node:crypto";

export const MANAGED_BACKGROUND_WORKER_ENV = "MONO_AGENT_MANAGED_WORKER";

/**
 * Non-secret host variables that a managed worker may inherit durably.
 *
 * Provider credentials and MONO_AGENT_* config overrides deliberately do not
 * belong here: secrets come from the selected dotenv file and product config
 * comes from the committed JSON. Keeping this list shared between first-run
 * validation, launchd materialisation, and worker proof prevents the three
 * surfaces from quietly validating different environments.
 */
export const BACKGROUND_OPERATIONAL_ENV_NAMES = [
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
] as const;

const BACKGROUND_OPERATIONAL_ENV_SET: ReadonlySet<string> = new Set(BACKGROUND_OPERATIONAL_ENV_NAMES);

export function isBackgroundOperationalEnvName(name: string): boolean {
  return BACKGROUND_OPERATIONAL_ENV_SET.has(name);
}

/** Select a deterministic, non-secret environment suitable for a plist. */
export function selectBackgroundOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    BACKGROUND_OPERATIONAL_ENV_NAMES.flatMap((name) => {
      const value = env[name];
      return typeof value === "string" ? [[name, value] as const] : [];
    }),
  );
}

/** Opaque proof only; no environment value is written to trace metadata. */
export function fingerprintBackgroundOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const selected = selectBackgroundOperationalEnvironment(env);
  const hash = createHash("sha256");
  hash.update("mono-agent-background-operational-env-v1\0", "utf8");
  for (const name of BACKGROUND_OPERATIONAL_ENV_NAMES) {
    const value = selected[name];
    if (value === undefined) continue;
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}
