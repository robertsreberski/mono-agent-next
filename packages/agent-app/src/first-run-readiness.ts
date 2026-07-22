import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";

import type { ValidationReport } from "./doctor.js";
import { validateMonoAgentFolder } from "./doctor.js";
import { selectBackgroundOperationalEnvironment } from "./background-environment.js";
import { initializeFirstRunManagedMemory } from "./first-run-managed-memory.js";
import type { SecretPersistenceOutcome } from "./init.js";
import { piAuthPathForSetup } from "./provider-setup.js";
import type { WizardPlan } from "./wizard/answers.js";

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface CliDotenvSnapshot {
  readonly env: Readonly<Record<string, string>>;
  /** Opaque content + mode fingerprint; never contains a plaintext dotenv value. */
  readonly fingerprint: string;
}

export interface CliConfigSnapshot {
  /** Exact UTF-8 bytes read from the regular config file. Config never contains persisted secrets. */
  readonly contents: string;
  readonly digest: string;
  /** Content plus file identity/mode fingerprint used to detect edits and replacement. */
  readonly fingerprint: string;
}

let exactProcessEnvironmentTail: Promise<void> = Promise.resolve();

function replaceProcessEnvironment(env: CliEnvironment): void {
  const next = new Map(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  for (const name of Object.keys(process.env)) {
    if (!next.has(name)) delete process.env[name];
  }
  for (const [name, value] of next) process.env[name] = value;
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

const DEFAULT_CRON_DIRECTORY = "cron";
const MAX_STAGED_FILES = 256;
const MAX_STAGED_DIRECTORY_ENTRIES = 4_096;
const MAX_STAGED_FILE_BYTES = 1_048_576;
const MAX_STAGED_TOTAL_BYTES = 8 * 1_048_576;

interface StagingFileBudget {
  count: number;
  bytes: number;
}

function throwIfStagingAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function stagingRelativePath(
  root: string,
  candidate: string,
  label: string,
  allowRoot = false,
  rootDescription = "its source root",
): string {
  const pathRelative = relative(root, candidate);
  if ((!allowRoot && pathRelative.length === 0) || escapesRoot(pathRelative)) {
    throw new Error(`Refusing to stage ${label} outside ${rootDescription}.`);
  }
  return pathRelative;
}

function consumeStagingBudget(budget: StagingFileBudget, path: string, bytes: number): void {
  if (bytes > MAX_STAGED_FILE_BYTES) {
    throw new Error(`Refusing to stage ${path} because it exceeds ${MAX_STAGED_FILE_BYTES} bytes.`);
  }
  if (budget.count >= MAX_STAGED_FILES) {
    throw new Error(`Refusing to stage more than ${MAX_STAGED_FILES} existing/generated files.`);
  }
  if (budget.bytes + bytes > MAX_STAGED_TOTAL_BYTES) {
    throw new Error(`Refusing to stage more than ${MAX_STAGED_TOTAL_BYTES} total file bytes.`);
  }
  budget.count += 1;
  budget.bytes += bytes;
}

function pathSegments(pathRelative: string): string[] {
  return pathRelative.length === 0 ? [] : pathRelative.split(sep).filter((part) => part.length > 0);
}

async function existingDirectoryWithoutSymlinks(
  canonicalRoot: string,
  pathRelative: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let current = canonicalRoot;
  for (const segment of pathSegments(pathRelative)) {
    throwIfStagingAborted(signal);
    const next = join(current, segment);
    let pathStat;
    try {
      pathStat = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (pathStat.isSymbolicLink()) {
      throw new Error(`Refusing to stage symbolic-link ${label}: ${next}`);
    }
    if (!pathStat.isDirectory()) {
      throw new Error(`Refusing to stage non-directory ${label}: ${next}`);
    }
    current = next;
  }
  const canonical = await realpath(current);
  if (escapesRoot(relative(canonicalRoot, canonical))) {
    throw new Error(`Refusing to stage ${label} outside its source root: ${current}`);
  }
  return canonical;
}

async function readExistingStagingFile(options: {
  readonly canonicalRoot: string;
  readonly pathRelative: string;
  readonly label: string;
  readonly signal?: AbortSignal;
}): Promise<Buffer | undefined> {
  const segments = pathSegments(options.pathRelative);
  const fileName = segments.pop();
  if (fileName === undefined) {
    throw new Error(`Refusing to stage ${options.label} without a file name.`);
  }
  const parent = await existingDirectoryWithoutSymlinks(
    options.canonicalRoot,
    segments.join(sep),
    `${options.label} parent`,
    options.signal,
  );
  if (parent === undefined) return undefined;
  throwIfStagingAborted(options.signal);
  const path = join(parent, fileName);
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    throw new Error(`Refusing to stage symbolic-link ${options.label}: ${path}`);
  }
  if (!pathStat.isFile()) {
    throw new Error(`Refusing to stage non-regular ${options.label}: ${path}`);
  }

  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to stage symbolic-link ${options.label}: ${path}`);
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error(`Refusing to stage non-regular ${options.label}: ${path}`);
    }
    if (openedStat.size > MAX_STAGED_FILE_BYTES) {
      throw new Error(`Refusing to stage ${options.label} because it exceeds ${MAX_STAGED_FILE_BYTES} bytes: ${path}`);
    }
    const contents = await handle.readFile();
    throwIfStagingAborted(options.signal);
    if (contents.length > MAX_STAGED_FILE_BYTES) {
      throw new Error(`Refusing to stage ${options.label} because it exceeds ${MAX_STAGED_FILE_BYTES} bytes: ${path}`);
    }
    const currentStat = await lstat(path);
    if (
      currentStat.isSymbolicLink() ||
      !currentStat.isFile() ||
      currentStat.dev !== openedStat.dev ||
      currentStat.ino !== openedStat.ino
    ) {
      throw new Error(`Refusing to stage ${options.label} because it changed during preflight: ${path}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function writeStagedFile(options: {
  readonly stagingRoot: string;
  readonly pathRelative: string;
  readonly contents: Buffer;
  readonly budget: StagingFileBudget;
  readonly stagedPaths: Set<string>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (options.stagedPaths.has(options.pathRelative)) return;
  throwIfStagingAborted(options.signal);
  consumeStagingBudget(options.budget, options.pathRelative, options.contents.length);
  const path = resolve(options.stagingRoot, options.pathRelative);
  stagingRelativePath(
    options.stagingRoot,
    path,
    `file ${options.pathRelative}`,
    false,
    "the disposable agent folder",
  );
  await mkdir(dirname(path), { recursive: true });
  throwIfStagingAborted(options.signal);
  await writeFile(path, options.contents, { flag: "wx", mode: 0o600 });
  options.stagedPaths.add(options.pathRelative);
}

function effectiveCronDirectory(plan: WizardPlan, env: Readonly<Record<string, string | undefined>>): string {
  const envDirectory = env.MONO_AGENT_CRON_DIR?.trim();
  if (envDirectory !== undefined && envDirectory.length > 0) return envDirectory;
  const cron = (plan.configJson as Record<string, unknown>).cron;
  if (typeof cron === "object" && cron !== null && !Array.isArray(cron)) {
    const configured = (cron as Record<string, unknown>).dir;
    if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  }
  return DEFAULT_CRON_DIRECTORY;
}

async function stageExistingCronFiles(options: {
  readonly sourceRoot: string;
  readonly stagingRoot: string;
  readonly plan: WizardPlan;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly budget: StagingFileBudget;
  readonly stagedPaths: Set<string>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const configuredDirectory = effectiveCronDirectory(options.plan, options.env);
  if (isAbsolute(configuredDirectory)) {
    throw new Error(`Refusing to stage absolute cron directory ${configuredDirectory}.`);
  }
  const cronPath = resolve(options.sourceRoot, configuredDirectory);
  const cronRelative = stagingRelativePath(
    options.sourceRoot,
    cronPath,
    `cron directory ${configuredDirectory}`,
    true,
  );
  const sourceCronDirectory = await existingDirectoryWithoutSymlinks(
    options.sourceRoot,
    cronRelative,
    "cron directory",
    options.signal,
  );
  if (sourceCronDirectory === undefined) return;

  const names: string[] = [];
  let scannedEntries = 0;
  const directory = await opendir(sourceCronDirectory);
  for await (const entry of directory) {
    throwIfStagingAborted(options.signal);
    scannedEntries += 1;
    if (scannedEntries > MAX_STAGED_DIRECTORY_ENTRIES) {
      throw new Error(`Refusing to scan more than ${MAX_STAGED_DIRECTORY_ENTRIES} cron directory entries.`);
    }
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (!entry.isFile()) {
      const kind = entry.isSymbolicLink() ? "symbolic-link" : "non-regular";
      throw new Error(`Refusing to stage ${kind} cron job: ${join(sourceCronDirectory, entry.name)}`);
    }
    names.push(entry.name);
    if (names.length > MAX_STAGED_FILES) {
      throw new Error(`Refusing to stage more than ${MAX_STAGED_FILES} cron job files.`);
    }
  }

  for (const name of names.sort()) {
    throwIfStagingAborted(options.signal);
    const pathRelative = cronRelative.length === 0 ? name : join(cronRelative, name);
    const contents = await readExistingStagingFile({
      canonicalRoot: options.sourceRoot,
      pathRelative,
      label: `cron job ${name}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (contents === undefined) {
      throw new Error(`Cron job disappeared during staging: ${join(options.sourceRoot, pathRelative)}`);
    }
    await writeStagedFile({
      stagingRoot: options.stagingRoot,
      pathRelative,
      contents,
      budget: options.budget,
      stagedPaths: options.stagedPaths,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}

/**
 * Run one guided-init operation with exactly the durable worker environment.
 *
 * Provider SDKs and CLI bridges still consult `process.env` internally, so an
 * `env` argument used only for config loading is not enough. Guided init is a
 * single-purpose CLI path; serialize these temporary global swaps, hold the
 * selected environment for the whole async operation, and restore the complete
 * caller snapshot on every exit path.
 */
export async function withExactProcessEnvironment<T>(
  env: CliEnvironment,
  task: () => Promise<T>,
): Promise<T> {
  const predecessor = exactProcessEnvironmentTail;
  let release!: () => void;
  exactProcessEnvironmentTail = new Promise<void>((resolveTail) => {
    release = resolveTail;
  });
  await predecessor;

  const original = { ...process.env };
  try {
    replaceProcessEnvironment(env);
    return await task();
  } finally {
    try {
      replaceProcessEnvironment(original);
    } finally {
      release();
    }
  }
}

/**
 * Host variables required for the CLI and its child processes to operate. The
 * guided path deliberately does not inherit provider credentials or mono-agent
 * config from the invoking shell: a launchd worker cannot reproduce either.
 */
const MONO_AGENT_SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|CREDENTIAL|CREDENTIALS|PASSWORD|SECRET|TOKEN)$/u;
const SENSITIVE_DOTENV_NAME = /(api.?key|credential|password|secret|token)/iu;

/** Whether guided setup consumed any durable dotenv value that should be owner-only and untracked. */
export function hasSensitivePersistedEnvironmentValue(env: CliEnvironment): boolean {
  return Object.entries(env).some(
    ([name, value]) => SENSITIVE_DOTENV_NAME.test(name) && nonEmpty(value),
  );
}

/** Read and fingerprint dotenv without changing process.env. A missing file is empty. */
export async function readCliDotenvSnapshot(path: string): Promise<CliDotenvSnapshot> {
  let handle;
  try {
    // O_NONBLOCK matters before fstat: opening a FIFO read-only can otherwise
    // wait forever for a writer, preventing us from reaching the regular-file
    // check. It is a no-op for ordinary files.
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { env: {}, fingerprint: "missing" };
    }
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read dotenv path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to read dotenv path ${path} because it is not a regular file.`);
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const mode = fileStat.mode & 0o777;
    const env = Object.fromEntries(
      Object.entries(parseEnv(contents)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const digest = createHash("sha256").update(contents).digest("hex");
    return { env, fingerprint: `file:${mode.toString(8)}:${digest}` };
  } finally {
    await handle.close();
  }
}

/** Read a dotenv file without changing process.env. A missing file is empty. */
export async function readCliDotenvFile(path: string): Promise<Record<string, string>> {
  return { ...(await readCliDotenvSnapshot(path)).env };
}

/** Read one exact config snapshot without following the final path component. */
export async function readCliConfigSnapshot(path: string): Promise<CliConfigSnapshot> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read config path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to read config path ${path} because it is not a regular file.`);
    }
    const bytes = await handle.readFile();
    const pathStat = await lstat(path);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== fileStat.dev ||
      pathStat.ino !== fileStat.ino
    ) {
      throw new Error(`Refusing to read config path ${path} because it changed during setup.`);
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Refusing to read config path ${path} because it is not valid UTF-8.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mode = fileStat.mode & 0o777;
    return {
      contents,
      digest,
      fingerprint: [
        "file",
        fileStat.dev,
        fileStat.ino,
        fileStat.size,
        fileStat.mtimeMs,
        fileStat.ctimeMs,
        mode.toString(8),
        digest,
      ].join(":"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Build the durable environment proven by guided init and later used by its
 * immediate start. Shell-only provider credentials and MONO_AGENT_* overrides
 * are intentionally absent; only worker-operational host values survive.
 * Operational values win over dotenv exactly as `process.loadEnvFile` and the
 * launchd plist do, while entered secrets and resolved Pi auth remain explicit.
 */
export function effectiveFirstRunEnvironment(options: {
  readonly shellEnv: CliEnvironment;
  readonly dotenvEnv: CliEnvironment;
  readonly enteredSecrets?: CliEnvironment;
  readonly resolvedPiAuthPath?: string;
}): Record<string, string | undefined> {
  const operationalEnv = selectBackgroundOperationalEnvironment(options.shellEnv);
  return {
    ...options.dotenvEnv,
    ...operationalEnv,
    ...(options.enteredSecrets ?? {}),
    ...(options.resolvedPiAuthPath === undefined
      ? {}
      : { MONO_AGENT_PI_AUTH_PATH: options.resolvedPiAuthPath }),
  };
}

/**
 * Persisted mono-agent config overrides that could make the generated JSON say
 * something different from the runtime. Secret values and the selected Pi
 * credential-store path are data inputs, not config substitutions, so remain
 * allowed. Returned names are sorted for deterministic operator output.
 */
export function unexpectedPersistedMonoAgentOverrides(
  plan: WizardPlan,
  dotenvEnv: CliEnvironment,
): readonly string[] {
  const selectedSecrets = new Set(plan.secrets.map((secret) => secret.envVar));
  return Object.keys(dotenvEnv)
    .filter((name) =>
      name.startsWith("MONO_AGENT_") &&
      name !== "MONO_AGENT_PI_AUTH_PATH" &&
      !selectedSecrets.has(name) &&
      !MONO_AGENT_SECRET_ENV_NAME.test(name)
    )
    .sort();
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Selected secret names whose shell and persisted values would diverge. */
export function selectedSecretEnvironmentConflicts(
  plan: WizardPlan,
  shellEnv: CliEnvironment,
  dotenvEnv: CliEnvironment,
  enteredSecrets: CliEnvironment = {},
): readonly string[] {
  return [...new Set(plan.secrets.map((secret) => secret.envVar))].filter((name) => {
    const values = [shellEnv[name], dotenvEnv[name], enteredSecrets[name]].filter(nonEmpty);
    return new Set(values).size > 1;
  });
}

/** All selected secret values used by the live probe, including persisted ones. */
export function selectedSecretValues(
  plan: WizardPlan,
  env: CliEnvironment,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const secret of plan.secrets) {
    const value = env[secret.envVar];
    if (nonEmpty(value)) values[secret.envVar] = value;
  }
  return values;
}

/**
 * Resolve the one Pi credential store used by discovery, setup, validation and
 * runtime. Inputs are already ordered by their documented precedence.
 */
export function resolveEffectivePiAuthPath(options: {
  readonly cwd: string;
  readonly explicitPath?: string;
  readonly envPath?: string;
  readonly configPath?: string;
}): string {
  const selected = [options.explicitPath, options.envPath, options.configPath]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return piAuthPathForSetup(
    selected,
    options.cwd,
  );
}

/** Whether an exported shell override would select a different background store. */
export function piAuthPathBackgroundConflict(options: {
  readonly cwd: string;
  readonly shellPath?: string | undefined;
  readonly dotenvPath?: string | undefined;
  readonly configPath?: string | undefined;
}): boolean {
  if (!nonEmpty(options.shellPath)) return false;
  const interactive = resolveEffectivePiAuthPath({
    cwd: options.cwd,
    envPath: options.shellPath,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const background = resolveEffectivePiAuthPath({
    cwd: options.cwd,
    ...(nonEmpty(options.dotenvPath) ? { envPath: options.dotenvPath } : {}),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  return interactive !== background;
}

export interface FirstRunReadinessGate {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

const FIRST_RUN_DOCTOR_DETAIL_MAX_LENGTH = 300;

function firstActionableDoctorDetail(
  section: ValidationReport["sections"][number] | undefined,
): string | undefined {
  const details = (section?.details ?? [])
    .map((rawDetail) => rawDetail.replace(/\s+/gu, " ").trim())
    .filter((detail) => detail.length > 0);
  // Section summaries usually lead with neutral context (for example the
  // memory mode/path), while the real recovery action is a later [WARN]/[ERROR]
  // line. Preserve that doctor distinction in the wizard's one-line failure.
  const detail = details.find((candidate) => /^\[(?:WARN|ERROR)\]/u.test(candidate)) ?? details[0];
  if (detail === undefined) return undefined;
  if (detail.length <= FIRST_RUN_DOCTOR_DETAIL_MAX_LENGTH) return detail;
  return `${detail.slice(0, FIRST_RUN_DOCTOR_DETAIL_MAX_LENGTH - 1).trimEnd()}…`;
}

function expectationMismatchReason(
  expectation: WizardPlan["validateExpectations"][number],
  section: ValidationReport["sections"][number] | undefined,
): string {
  const actual = section?.status ?? "missing";
  const label = section?.label.trim() || "Missing validation section";
  const detail = firstActionableDoctorDetail(section);
  return [
    `${expectation.sectionId} must be ${expectation.mustBe}, but is ${actual} (${label} [${expectation.sectionId}]).`,
    detail,
    expectation.note?.trim(),
  ].filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

function firstRunConfigurationReasons(options: {
  readonly plan: WizardPlan;
  readonly report: ValidationReport;
  readonly secretPersistence: SecretPersistenceOutcome;
  readonly deferWaitingCredentials: boolean;
}): string[] {
  const reasons: string[] = [];
  const seenReasons = new Set<string>();
  const mismatchedSectionIds = new Set<string>();
  const addReason = (reason: string): void => {
    if (seenReasons.has(reason)) return;
    seenReasons.add(reason);
    reasons.push(reason);
  };

  const byId = new Map(options.report.sections.map((section) => [section.id, section]));
  for (const expectation of options.plan.validateExpectations) {
    const section = byId.get(expectation.sectionId);
    const actual = section?.status;
    if (
      actual === expectation.mustBe ||
      (options.deferWaitingCredentials && expectation.sectionId === "credentials" && actual === "waiting")
    ) {
      continue;
    }
    mismatchedSectionIds.add(expectation.sectionId);
    addReason(expectationMismatchReason(expectation, section));
  }

  if (!options.report.ok) {
    const errorSections = options.report.sections.filter((section) => section.status === "error");
    for (const section of errorSections) {
      if (mismatchedSectionIds.has(section.id)) continue;
      const detail = firstActionableDoctorDetail(section);
      addReason(
        `Validation error in ${section.label} [${section.id}].` +
          (detail === undefined ? " Doctor reported an error." : ` ${detail}`),
      );
    }
    if (errorSections.length === 0) {
      addReason("The complete generated configuration has validation errors.");
    }
  }

  if (options.secretPersistence.status === "refused") {
    addReason(
      `Secure secret persistence was refused${options.secretPersistence.reason === undefined ? "" : ` (${options.secretPersistence.reason})`}.` +
        (options.secretPersistence.detail === undefined ? "" : ` ${options.secretPersistence.detail}`),
    );
  }
  return reasons;
}

/**
 * Gate the generated capability configuration before any paid or slow model
 * checks. A waiting credential section is deliberately deferred to the exact
 * live route proof; every other selected expectation must already be ready.
 */
export function evaluateFirstRunConfigurationReadiness(options: {
  readonly plan: WizardPlan;
  readonly report: ValidationReport;
  readonly secretPersistence: SecretPersistenceOutcome;
}): FirstRunReadinessGate {
  const reasons = firstRunConfigurationReasons({
    ...options,
    deferWaitingCredentials: true,
  });
  return { ready: reasons.length === 0, reasons };
}

/** A first-run claim also requires exact live route proofs beyond generic operational readiness. */
export function evaluateFirstRunReadiness(options: {
  readonly plan: WizardPlan;
  readonly report: ValidationReport;
  readonly secretPersistence: SecretPersistenceOutcome;
  /** Exact persistent runtime routes proven by successful live no-tool turns. */
  readonly verifiedCredentialModelRefs?: readonly string[];
}): FirstRunReadinessGate {
  const reasons = firstRunConfigurationReasons({
    plan: options.plan,
    report: options.report,
    secretPersistence: options.secretPersistence,
    deferWaitingCredentials: false,
  });
  const verified = new Set(options.verifiedCredentialModelRefs ?? []);
  for (const modelRef of selectedPersistentRuntimeModelRefs(options.plan)) {
    if (!verified.has(modelRef)) {
      reasons.push(`Runtime route ${modelRef} has not completed its exact live readiness check.`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

function selectedPersistentRuntimeModelRefs(plan: WizardPlan): readonly string[] {
  const runtime = (plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const refs: string[] = [];
  if (typeof runtime.model === "string" && runtime.model.length > 0) refs.push(runtime.model);
  if (Array.isArray(runtime.fallbacks)) {
    for (const raw of runtime.fallbacks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const model = (raw as Record<string, unknown>).model;
      if (typeof model === "string" && model.length > 0) refs.push(model);
    }
  } else if (Array.isArray(runtime.fallbackModels)) {
    for (const model of runtime.fallbackModels) {
      if (typeof model === "string" && model.length > 0) refs.push(model);
    }
  }
  return [...new Set(refs)];
}

export interface ValidateWizardPlanInStagingOptions {
  readonly plan: WizardPlan;
  /** Folder whose existing relative context roots the generated plan references. */
  readonly sourceCwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly verifiedCredentialModelRefs: readonly string[];
  /** Cooperative cancellation checked between every staging phase and before returning validation. */
  readonly abortSignal?: AbortSignal;
  readonly validate?: typeof validateMonoAgentFolder;
}

/** Validate the full plan in a disposable folder before touching the target. */
export async function validateWizardPlanInStaging(
  options: ValidateWizardPlanInStagingOptions,
): Promise<ValidationReport> {
  throwIfStagingAborted(options.abortSignal);
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-first-run-"));
  const configPath = join(dir, "mono-agent.config.json");
  const budget: StagingFileBudget = { count: 0, bytes: 0 };
  const stagedPaths = new Set<string>();
  try {
    throwIfStagingAborted(options.abortSignal);
    const canonicalSourceCwd = options.sourceCwd === undefined
      ? undefined
      : await realpath(options.sourceCwd);
    if (canonicalSourceCwd !== undefined && !(await stat(canonicalSourceCwd)).isDirectory()) {
      throw new Error(`Staging source is not a directory: ${options.sourceCwd}`);
    }
    throwIfStagingAborted(options.abortSignal);
    await writeFile(configPath, `${JSON.stringify(options.plan.configJson, null, 2)}\n`, { mode: 0o600 });
    const existingIdentity = canonicalSourceCwd === undefined
      ? undefined
      : await readExistingStagingFile({
          canonicalRoot: canonicalSourceCwd,
          pathRelative: "IDENTITY.md",
          label: "existing identity",
          ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
        });
    await writeStagedFile({
      stagingRoot: dir,
      pathRelative: "IDENTITY.md",
      contents: existingIdentity ?? Buffer.from(
        "# First-run validation identity\n\nTemporary identity used only for setup validation.\n",
        "utf8",
      ),
      budget,
      stagedPaths,
      ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
    });
    throwIfStagingAborted(options.abortSignal);
    await mkdir(join(dir, ".mono-agent", "workspace"), { recursive: true });
    await mkdir(join(dir, ".mono-agent", "artifacts"), { recursive: true });
    const skillsRoot = options.plan.configJson.context?.skillsRoot;
    if (skillsRoot !== undefined) {
      const sourceSkillsRoot = canonicalSourceCwd === undefined ? undefined : resolve(canonicalSourceCwd, skillsRoot);
      let canonicalSourceSkillsRoot: string | undefined;
      if (sourceSkillsRoot !== undefined && canonicalSourceCwd !== undefined) {
        try {
          if (!(await stat(sourceSkillsRoot)).isDirectory()) {
            throw new Error(`Configured skills root is not a directory: ${sourceSkillsRoot}`);
          }
          canonicalSourceSkillsRoot = await realpath(sourceSkillsRoot);
          if (escapesRoot(relative(canonicalSourceCwd, canonicalSourceSkillsRoot))) {
            throw new Error(`Refusing to stage skills root outside the source agent folder: ${skillsRoot}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const stagedSkillsRoot = resolve(dir, skillsRoot);
      const stagedRelative = relative(dir, stagedSkillsRoot);
      if (stagedRelative.length === 0 || escapesRoot(stagedRelative)) {
        throw new Error(`Refusing to stage skills root outside the disposable agent folder: ${skillsRoot}`);
      }
      await mkdir(stagedSkillsRoot, { recursive: true });
      for (const skill of options.plan.configJson.context?.selectedSkills ?? []) {
        throwIfStagingAborted(options.abortSignal);
        const sourceSkillPath = sourceSkillsRoot === undefined ? undefined : resolve(sourceSkillsRoot, skill, "SKILL.md");
        const sourceRelative = sourceSkillsRoot === undefined || sourceSkillPath === undefined
          ? undefined
          : relative(sourceSkillsRoot, sourceSkillPath);
        const stagedSkillPath = resolve(stagedSkillsRoot, skill, "SKILL.md");
        const stagedSkillRelative = relative(stagedSkillsRoot, stagedSkillPath);
        if (
          (sourceRelative !== undefined && escapesRoot(sourceRelative)) || escapesRoot(stagedSkillRelative)
        ) {
          throw new Error(`Refusing to stage a skill outside its configured root: ${skill}`);
        }
        let contents: Buffer | undefined;
        if (canonicalSourceSkillsRoot !== undefined && sourceSkillPath !== undefined) {
          try {
            contents = await readSelectedSkillManifest(sourceSkillPath, canonicalSourceSkillsRoot);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (contents === undefined) {
          const stagedSkillRelativeFromRoot = relative(dir, stagedSkillPath);
          const generated = options.plan.files.find((file) =>
            relative(dir, resolve(dir, file.path)) === stagedSkillRelativeFromRoot
          );
          if (generated === undefined) {
            throw new Error(`Configured skill is neither present nor generated by the approved plan: ${skill}`);
          }
          contents = Buffer.from(generated.contents, "utf8");
        }
        await mkdir(dirname(stagedSkillPath), { recursive: true });
        // Materialize a fresh regular file. Copying a symlink here would let a
        // later generated-file write follow it outside the disposable tree.
        await writeFile(stagedSkillPath, contents, { flag: "wx", mode: 0o600 });
        stagedPaths.add(relative(dir, stagedSkillPath));
      }
    }

    if (
      canonicalSourceCwd !== undefined &&
      options.plan.validateExpectations.some((expectation) => expectation.sectionId === "channel:cron")
    ) {
      await stageExistingCronFiles({
        sourceRoot: canonicalSourceCwd,
        stagingRoot: dir,
        plan: options.plan,
        env: options.env,
        budget,
        stagedPaths,
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      });
    }

    for (const file of options.plan.files) {
      throwIfStagingAborted(options.abortSignal);
      const pathRelative = stagingRelativePath(
        dir,
        resolve(dir, file.path),
        `generated file ${file.path}`,
        false,
        "the disposable agent folder",
      );
      if (stagedPaths.has(pathRelative)) continue;
      const existingContents = canonicalSourceCwd === undefined
        ? undefined
        : await readExistingStagingFile({
            canonicalRoot: canonicalSourceCwd,
            pathRelative,
            label: `existing plan file ${file.path}`,
            ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
          });
      const contents = existingContents ?? Buffer.from(file.contents, "utf8");
      await writeStagedFile({
        stagingRoot: dir,
        pathRelative,
        contents,
        budget,
        stagedPaths,
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      });
    }
    throwIfStagingAborted(options.abortSignal);
    await initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: options.plan,
      env: options.env,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    });
    throwIfStagingAborted(options.abortSignal);
    const validation = await (options.validate ?? validateMonoAgentFolder)({
      cwd: dir,
      configPath,
      env: options.env,
      // Writes are confined to this disposable directory. Memory/sandbox
      // capabilities need their normal initialization path to prove readiness.
      allowFilesystemWrites: true,
      liveness: true,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
    });
    throwIfStagingAborted(options.abortSignal);
    return validation;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readSelectedSkillManifest(path: string, canonicalSkillsRoot: string): Promise<Buffer> {
  const canonicalParent = await realpath(dirname(path));
  if (escapesRoot(relative(canonicalSkillsRoot, canonicalParent))) {
    throw new Error(`Refusing to stage a skill manifest outside its configured root: ${path}`);
  }
  const canonicalPath = join(canonicalParent, "SKILL.md");
  let handle;
  try {
    handle = await open(
      canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to stage symbolic-link skill manifest: ${path}`);
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Refusing to stage non-regular skill manifest: ${path}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
