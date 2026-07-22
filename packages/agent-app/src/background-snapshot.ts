import { createHmac } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { accountHomeDirectory } from "./account-home.js";
import { loadAppCoreConfig } from "./app-config.js";
import {
  loadBackgroundSnapshotKey,
  loadOrCreateBackgroundSnapshotKey,
} from "./background-snapshot-key.js";
import {
  fingerprintBackgroundOperationalEnvironment,
  isBackgroundOperationalEnvName,
  selectBackgroundOperationalEnvironment,
} from "./background-environment.js";
import { readCliConfigSnapshot, readCliDotenvSnapshot } from "./first-run-readiness.js";

export const BACKGROUND_SNAPSHOT_SCHEMA = "mono-agent.background-snapshot.v1";
const MAX_ENCODED_BACKGROUND_SNAPSHOT_LENGTH = 32_768;

/**
 * Secret-free evidence for the exact durable inputs a worker observed.
 * Secret-bearing files use identity/version metadata plus a keyed commitment;
 * plaintext and offline-testable content digests never enter argv or traces.
 */
export interface BackgroundSnapshot {
  readonly schema: typeof BACKGROUND_SNAPSHOT_SCHEMA;
  readonly configPath: string;
  readonly configFingerprint: string;
  readonly dotenvPath: string;
  readonly dotenvFingerprint: string;
  readonly identityPath: string;
  readonly identityFingerprint: string;
  readonly soulPath?: string;
  readonly soulFingerprint?: string;
  readonly mcpConfigPath?: string;
  readonly mcpConfigFingerprint?: string;
  readonly operationalEnvironmentFingerprint: string;
}

/**
 * Encode the secret-free approved snapshot for the owner-private LaunchAgent
 * ProgramArguments. base64url keeps the value XML/shell inert while remaining
 * visible and deterministic for diagnostics.
 */
export function encodeBackgroundSnapshot(snapshot: BackgroundSnapshot): string {
  return Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64url");
}

/** Fail closed when an internal managed-worker snapshot argument is malformed. */
export function decodeBackgroundSnapshot(encoded: string): BackgroundSnapshot {
  if (
    encoded.length === 0
    || encoded.length > MAX_ENCODED_BACKGROUND_SNAPSHOT_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new Error("The managed background snapshot argument is malformed.");
  }
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw new Error("non-canonical base64url");
    }
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The managed background snapshot argument is malformed.");
  }
  const snapshot = backgroundSnapshotFromMetadata({ backgroundSnapshot: parsed });
  if (snapshot === undefined) {
    throw new Error("The managed background snapshot argument has an invalid schema.");
  }
  return snapshot;
}

export interface MaterializedBackgroundRuntimeInputs {
  /** Owner-only immutable copy read by every app/channel config loader. */
  readonly configPath: string;
  /** Frozen effective environment; Identity/Soul/MCP config resolve to owner-only copies. */
  readonly environment: Record<string, string | undefined>;
  dispose(): Promise<void>;
}

export interface CaptureBackgroundSnapshotInput {
  readonly cwd: string;
  readonly configPath: string;
  readonly envFile?: string;
  /** Effective worker environment after dotenv loading/sanitisation. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Test/internal seam. Production uses the owner-only per-config key. */
  readonly proofKey?: Uint8Array;
}

export interface CaptureDurableBackgroundSnapshotInput {
  readonly cwd: string;
  readonly configPath: string;
  readonly envFile?: string;
  /** The exact non-secret values materialised into the LaunchAgent plist. */
  readonly operationalEnvironment: Readonly<Record<string, string | undefined>>;
  /** Test/internal seam. Production uses the owner-only per-config key. */
  readonly proofKey?: Uint8Array;
}

export interface DurableBackgroundInputs {
  /** Exact environment a managed worker reconstructs from dotenv + plist. */
  readonly environment: Readonly<Record<string, string>>;
  /** Snapshot captured with that same reconstructed environment. */
  readonly snapshot: BackgroundSnapshot;
  /** Internal setup guard only; contains a digest and must never be serialized. */
  readonly configSourceFingerprint: string;
}

/**
 * Reconstruct the worker environment without inheriting shell credentials or
 * config overrides, then attest it. This mirrors managed-worker startup:
 * operational plist values exist first and dotenv fills every other key.
 */
export async function captureDurableBackgroundSnapshot(
  input: CaptureDurableBackgroundSnapshotInput,
): Promise<BackgroundSnapshot> {
  return (await captureDurableBackgroundInputs(input)).snapshot;
}

/**
 * Reconstruct and attest one indivisible durable worker input. Returning the
 * environment with its snapshot prevents callers from accidentally validating
 * one environment and launching with a shell-enriched variant.
 */
export async function captureDurableBackgroundInputs(
  input: CaptureDurableBackgroundSnapshotInput,
): Promise<DurableBackgroundInputs> {
  const cwd = resolve(input.cwd);
  const environment = await loadDurableBackgroundEnvironment(input);
  const configPath = resolve(cwd, input.configPath);
  const configBefore = await readCliConfigSnapshot(configPath);
  const snapshot = await captureBackgroundSnapshot({
    cwd,
    configPath: input.configPath,
    ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
    env: environment,
    ...(input.proofKey === undefined ? {} : { proofKey: input.proofKey }),
  });
  const configAfter = await readCliConfigSnapshot(configPath);
  if (configBefore.fingerprint !== configAfter.fingerprint) {
    throw new Error("Refusing to prove background readiness because the config changed during durable capture.");
  }
  return { environment, snapshot, configSourceFingerprint: configAfter.fingerprint };
}

export async function loadDurableBackgroundEnvironment(
  input: Pick<CaptureDurableBackgroundSnapshotInput, "cwd" | "envFile" | "operationalEnvironment">,
): Promise<Record<string, string>> {
  const cwd = resolve(input.cwd);
  const dotenvPath = resolve(cwd, input.envFile ?? ".env");
  const dotenv = await readCliDotenvSnapshot(dotenvPath);
  const operational = selectBackgroundOperationalEnvironment(input.operationalEnvironment);
  return { ...dotenv.env, ...operational };
}

export async function captureBackgroundSnapshot(
  input: CaptureBackgroundSnapshotInput,
): Promise<BackgroundSnapshot> {
  const cwd = resolve(input.cwd);
  const configPath = resolve(cwd, input.configPath);
  const dotenvPath = resolve(cwd, input.envFile ?? ".env");
  const proofKey = normalizeProofKey(
    input.proofKey ?? await loadOrCreateBackgroundSnapshotKey(configPath),
  );
  const [config, dotenv, dotenvFingerprint] = await Promise.all([
    readRegularFileProof(configPath, "config", proofKey),
    readCliDotenvSnapshot(dotenvPath),
    fingerprintOptionalRegularFile(dotenvPath, "dotenv", proofKey),
  ]);
  assertDotenvMatchesEffectiveEnvironment(dotenv.env, input.env, dotenvPath);
  const core = await loadAppCoreConfig({ cwd, configPath, env: input.env });
  const identityPath = resolve(core.context.identityPath);
  const identityFingerprint = await fingerprintRegularFile(identityPath, "identity", proofKey);
  const soulPath = core.context.soulPath === undefined ? undefined : resolve(core.context.soulPath);
  const soulFingerprint = soulPath === undefined
    ? undefined
    : await fingerprintRegularFile(soulPath, "soul", proofKey);
  const mcpConfigPath = core.tools.mcpConfigPath === undefined ? undefined : resolve(core.tools.mcpConfigPath);
  const mcpConfigFingerprint = mcpConfigPath === undefined
    ? undefined
    : await fingerprintRegularFile(mcpConfigPath, "MCP config", proofKey);
  // The config determines Identity/Soul/MCP paths and the effective env
  // determines the loaded config. Re-read every durable input after resolution so a
  // rename/write racing this capture cannot produce a self-inconsistent proof.
  const [
    configAfter,
    dotenvAfter,
    dotenvFingerprintAfter,
    identityAfter,
    soulAfter,
    mcpConfigAfter,
  ] = await Promise.all([
    readRegularFileProof(configPath, "config", proofKey),
    readCliDotenvSnapshot(dotenvPath),
    fingerprintOptionalRegularFile(dotenvPath, "dotenv", proofKey),
    fingerprintRegularFile(identityPath, "identity", proofKey),
    soulPath === undefined ? Promise.resolve(undefined) : fingerprintRegularFile(soulPath, "soul", proofKey),
    mcpConfigPath === undefined
      ? Promise.resolve(undefined)
      : fingerprintRegularFile(mcpConfigPath, "MCP config", proofKey),
  ]);
  if (
    config.fingerprint !== configAfter.fingerprint
    || dotenv.fingerprint !== dotenvAfter.fingerprint
    || dotenvFingerprint !== dotenvFingerprintAfter
    || identityFingerprint !== identityAfter
    || soulFingerprint !== soulAfter
    || mcpConfigFingerprint !== mcpConfigAfter
  ) {
    throw new Error("Refusing to prove background readiness because a durable input changed during startup capture.");
  }
  assertDotenvMatchesEffectiveEnvironment(dotenvAfter.env, input.env, dotenvPath);
  return {
    schema: BACKGROUND_SNAPSHOT_SCHEMA,
    configPath,
    configFingerprint: config.fingerprint,
    dotenvPath,
    dotenvFingerprint,
    identityPath,
    identityFingerprint,
    ...(soulPath === undefined || soulFingerprint === undefined ? {} : { soulPath, soulFingerprint }),
    ...(mcpConfigPath === undefined || mcpConfigFingerprint === undefined
      ? {}
      : { mcpConfigPath, mcpConfigFingerprint }),
    operationalEnvironmentFingerprint: fingerprintBackgroundOperationalEnvironment(input.env),
  };
}

/**
 * Freeze the exact config and context bytes attested by `snapshot` before any
 * app/channel loader runs. The app advertises the canonical config path, but
 * reads this private copy so an edit/revert during startup cannot produce a
 * mixed worker while retaining the old trace proof.
 */
export async function materializeBackgroundRuntimeInputs(input: {
  readonly snapshot: BackgroundSnapshot;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Managed worker home; defaults to the current OS user's home. */
  readonly homeDir?: string;
  /** Test seam; production defaults below the current user's home. */
  readonly runtimeRoot?: string;
  /** Test/internal seam. Workers otherwise load the existing owner-only key. */
  readonly proofKey?: Uint8Array;
}): Promise<MaterializedBackgroundRuntimeInputs> {
  const snapshot = input.snapshot;
  const cwd = resolve(input.cwd);
  const proofKey = normalizeProofKey(
    input.proofKey ?? await loadBackgroundSnapshotKey(snapshot.configPath),
  );
  const root = await ensureRuntimeInputsRoot(input.runtimeRoot, input.homeDir);
  const directory = await mkdtemp(join(root, "worker-"));
  await chmod(directory, 0o700);
  let disposed = false;
  try {
    const [config, dotenvFingerprint, identity, soul, mcpConfig] = await Promise.all([
      readRegularFileProof(snapshot.configPath, "config", proofKey),
      fingerprintOptionalRegularFile(snapshot.dotenvPath, "dotenv", proofKey),
      readRegularFileProof(snapshot.identityPath, "identity", proofKey),
      snapshot.soulPath === undefined
        ? Promise.resolve(undefined)
        : readRegularFileProof(snapshot.soulPath, "soul", proofKey),
      snapshot.mcpConfigPath === undefined
        ? Promise.resolve(undefined)
        : readRegularFileProof(snapshot.mcpConfigPath, "MCP config", proofKey),
    ]);
    if (
      config.fingerprint !== snapshot.configFingerprint
      || dotenvFingerprint !== snapshot.dotenvFingerprint
      || identity.fingerprint !== snapshot.identityFingerprint
      || (snapshot.soulPath === undefined) !== (snapshot.soulFingerprint === undefined)
      || (snapshot.soulPath !== undefined
        && (soul === undefined || soul.fingerprint !== snapshot.soulFingerprint))
      || (snapshot.mcpConfigPath === undefined) !== (snapshot.mcpConfigFingerprint === undefined)
      || (snapshot.mcpConfigPath !== undefined
        && (mcpConfig === undefined || mcpConfig.fingerprint !== snapshot.mcpConfigFingerprint))
    ) {
      throw new Error("Refusing to materialize background runtime inputs because the approved snapshot changed.");
    }

    const configPath = join(directory, "mono-agent.config.json");
    const identityPath = join(directory, "IDENTITY.md");
    const soulPath = soul === undefined ? undefined : join(directory, "SOUL.md");
    const mcpConfigPath = mcpConfig === undefined ? undefined : join(directory, "mcp-config.json");
    await writeFile(configPath, config.bytes, { flag: "wx", mode: 0o400 });
    await writeFile(identityPath, identity.bytes, { flag: "wx", mode: 0o400 });
    if (soulPath !== undefined && soul !== undefined) {
      await writeFile(soulPath, soul.bytes, { flag: "wx", mode: 0o400 });
    }
    if (mcpConfigPath !== undefined && mcpConfig !== undefined) {
      await writeFile(mcpConfigPath, mcpConfig.bytes, { flag: "wx", mode: 0o400 });
    }
    await Promise.all([
      chmod(configPath, 0o400),
      chmod(identityPath, 0o400),
      ...(soulPath === undefined ? [] : [chmod(soulPath, 0o400)]),
      ...(mcpConfigPath === undefined ? [] : [chmod(mcpConfigPath, 0o400)]),
    ]);

    const [copiedConfig, copiedIdentity, copiedSoul, copiedMcpConfig] = await Promise.all([
      readFile(configPath),
      readFile(identityPath),
      soulPath === undefined ? Promise.resolve(undefined) : readFile(soulPath),
      mcpConfigPath === undefined ? Promise.resolve(undefined) : readFile(mcpConfigPath),
    ]);
    if (
      !copiedConfig.equals(config.bytes)
      || !copiedIdentity.equals(identity.bytes)
      || (soul !== undefined && (copiedSoul === undefined || !copiedSoul.equals(soul.bytes)))
      || (mcpConfig !== undefined
        && (copiedMcpConfig === undefined || !copiedMcpConfig.equals(mcpConfig.bytes)))
    ) {
      throw new Error("The private background runtime input copy failed exact verification.");
    }

    // Re-attest every canonical input after materialisation. File fingerprints
    // include ctime, so even an edit followed by byte-for-byte restoration is
    // detected rather than accepted as the approved snapshot.
    const after = await captureBackgroundSnapshot({
      cwd,
      configPath: snapshot.configPath,
      envFile: snapshot.dotenvPath,
      env: input.env,
      proofKey,
    });
    if (!sameBackgroundSnapshot(after, snapshot)) {
      throw new Error("Refusing to start because durable inputs changed while the private runtime snapshot was created.");
    }
    await chmod(directory, 0o500);
    return {
      configPath,
      environment: {
        ...input.env,
        MONO_AGENT_IDENTITY_PATH: identityPath,
        ...(soulPath === undefined ? {} : { MONO_AGENT_SOUL_PATH: soulPath }),
        ...(mcpConfigPath === undefined ? {} : { MONO_AGENT_MCP_CONFIG_PATH: mcpConfigPath }),
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await chmod(directory, 0o700).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function assertDotenvMatchesEffectiveEnvironment(
  dotenv: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
  dotenvPath: string,
): void {
  const dotenvNames = new Set(Object.keys(dotenv));
  for (const [name, value] of Object.entries(dotenv)) {
    // launchd explicitly materialises operational values and Node's dotenv
    // semantics leave them in precedence. Every other dotenv entry must be the
    // value the worker is actually about to use.
    if (!isBackgroundOperationalEnvName(name) && env[name] !== value) {
      throw new Error(
        `Refusing to prove background readiness because the effective ${name} value does not match ${dotenvPath}.`,
      );
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined
      && !isBackgroundOperationalEnvName(name)
      && !dotenvNames.has(name)
    ) {
      throw new Error(
        `Refusing to prove background readiness because the effective ${name} value is not present in ${dotenvPath}.`,
      );
    }
  }
}

export function sameBackgroundSnapshot(left: BackgroundSnapshot, right: BackgroundSnapshot): boolean {
  return left.schema === right.schema
    && left.configPath === right.configPath
    && left.configFingerprint === right.configFingerprint
    && left.dotenvPath === right.dotenvPath
    && left.dotenvFingerprint === right.dotenvFingerprint
    && left.identityPath === right.identityPath
    && left.identityFingerprint === right.identityFingerprint
    && left.soulPath === right.soulPath
    && left.soulFingerprint === right.soulFingerprint
    && left.mcpConfigPath === right.mcpConfigPath
    && left.mcpConfigFingerprint === right.mcpConfigFingerprint
    && left.operationalEnvironmentFingerprint === right.operationalEnvironmentFingerprint;
}

/** Fail-closed parser for untrusted trace-source metadata. */
export function backgroundSnapshotFromMetadata(metadata: Record<string, unknown> | undefined): BackgroundSnapshot | undefined {
  const value = metadata?.backgroundSnapshot;
  if (!isRecord(value) || value.schema !== BACKGROUND_SNAPSHOT_SCHEMA) return undefined;
  const allowedFields = new Set([
    "schema",
    "configPath",
    "configFingerprint",
    "dotenvPath",
    "dotenvFingerprint",
    "identityPath",
    "identityFingerprint",
    "soulPath",
    "soulFingerprint",
    "mcpConfigPath",
    "mcpConfigFingerprint",
    "operationalEnvironmentFingerprint",
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) return undefined;
  const fields = [
    "configPath",
    "configFingerprint",
    "dotenvPath",
    "dotenvFingerprint",
    "identityPath",
    "identityFingerprint",
    "operationalEnvironmentFingerprint",
  ] as const;
  if (fields.some((field) => typeof value[field] !== "string" || value[field].length === 0)) return undefined;
  if (
    (value.soulPath === undefined) !== (value.soulFingerprint === undefined)
    || (value.soulPath !== undefined && (typeof value.soulPath !== "string" || value.soulPath.length === 0))
    || (value.soulFingerprint !== undefined
      && (typeof value.soulFingerprint !== "string" || value.soulFingerprint.length === 0))
  ) return undefined;
  if (
    (value.mcpConfigPath === undefined) !== (value.mcpConfigFingerprint === undefined)
    || (value.mcpConfigPath !== undefined
      && (typeof value.mcpConfigPath !== "string" || value.mcpConfigPath.length === 0))
    || (value.mcpConfigFingerprint !== undefined
      && (typeof value.mcpConfigFingerprint !== "string" || value.mcpConfigFingerprint.length === 0))
  ) return undefined;
  return {
    schema: BACKGROUND_SNAPSHOT_SCHEMA,
    configPath: value.configPath as string,
    configFingerprint: value.configFingerprint as string,
    dotenvPath: value.dotenvPath as string,
    dotenvFingerprint: value.dotenvFingerprint as string,
    identityPath: value.identityPath as string,
    identityFingerprint: value.identityFingerprint as string,
    ...(value.soulPath === undefined
      ? {}
      : { soulPath: value.soulPath as string, soulFingerprint: value.soulFingerprint as string }),
    ...(value.mcpConfigPath === undefined
      ? {}
      : {
          mcpConfigPath: value.mcpConfigPath as string,
          mcpConfigFingerprint: value.mcpConfigFingerprint as string,
        }),
    operationalEnvironmentFingerprint: value.operationalEnvironmentFingerprint as string,
  };
}

async function fingerprintRegularFile(path: string, label: string, proofKey: Buffer): Promise<string> {
  return (await readRegularFileProof(path, label, proofKey)).fingerprint;
}

async function fingerprintOptionalRegularFile(path: string, label: string, proofKey: Buffer): Promise<string> {
  try {
    return await fingerprintRegularFile(path, label, proofKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function readRegularFileProof(
  path: string,
  label: string,
  proofKey: Buffer,
): Promise<{ readonly bytes: Buffer; readonly fingerprint: string }> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read ${label} path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`Refusing to read ${label} path ${path} because it is not a regular file.`);
    }
    const bytes = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || !sameRegularFileVersion(before, afterHandle)
      || !sameRegularFileVersion(before, afterPath)
    ) {
      throw new Error(`Refusing to read ${label} path ${path} because it changed during startup.`);
    }
    return { bytes, fingerprint: [
      "file",
      before.dev.toString(),
      before.ino.toString(),
      before.size.toString(),
      before.mtimeNs.toString(),
      before.ctimeNs.toString(),
      before.mode.toString(8),
      createHmac("sha256", proofKey)
        .update("mono-agent.background-file.v1\0", "utf8")
        .update(label, "utf8")
        .update("\0", "utf8")
        .update(path, "utf8")
        .update("\0", "utf8")
        .update(bytes)
        .digest("hex"),
    ].join(":") };
  } finally {
    await handle.close();
  }
}

function sameRegularFileVersion(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode;
}

function normalizeProofKey(value: Uint8Array): Buffer {
  if (value.byteLength !== 32) {
    throw new Error("The background snapshot proof key must contain exactly 32 bytes.");
  }
  return Buffer.from(value);
}

async function ensureRuntimeInputsRoot(runtimeRoot: string | undefined, homeDir: string | undefined): Promise<string> {
  if (runtimeRoot !== undefined) {
    await mkdir(resolve(runtimeRoot), { recursive: true, mode: 0o700 });
    const canonical = await realpath(resolve(runtimeRoot));
    await assertPrivateDirectory(canonical, "background runtime input root");
    return canonical;
  }
  const home = await realpath(resolve(homeDir ?? accountHomeDirectory()));
  let current = home;
  for (const segment of [".mono-agent", "runtime-inputs"]) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertPrivateDirectory(current, "background runtime input root");
  }
  return current;
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} ${path} must be a real directory.`);
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} ${path} must be owned by the current user.`);
  }
  await chmod(path, 0o700);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
