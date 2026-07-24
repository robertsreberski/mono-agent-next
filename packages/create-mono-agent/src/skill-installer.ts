import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NO_FOLLOW,
  SKILL_NAME,
  acquireInstallLock,
  allowedSourceDirectories,
  archiveExactFile,
  assertDirectoryIdentity,
  assertEmptyDirectory,
  assertOwnerPrivate,
  assertPathAbsent,
  assertRealDirectory,
  assertSecurePlatform,
  hasCode,
  hasExactKeys,
  identityOf,
  isRecord,
  lstatOrUndefined,
  parseSourceDescriptors,
  readBounded,
  readExact,
  releaseInstallLock,
  safeRelativePath,
  sameFileIdentity,
  sameIdentity,
  syncDirectory,
  validateExactTree,
  writeFully,
  type FileIdentity,
  type SourceDescriptor,
} from "./skill-installer/fs.ts";
import {
  appendJournal,
  createJournal,
  recoverStaleJournal,
  type OpenJournal,
} from "./skill-installer/journal.ts";

export const COMPOSER_SKILL_TARGETS = ["claude", "codex", "both"] as const;

export type ComposerSkillTarget = (typeof COMPOSER_SKILL_TARGETS)[number];

const MANIFEST_MAX_BYTES = 64 * 1024;

const DEFAULT_SOURCE_DIRECTORY = fileURLToPath(
  new URL("../skills/mono-agent-composer/", import.meta.url),
);

const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL("../skills/mono-agent-composer.manifest.json", import.meta.url),
);

export interface InstallComposerSkillOptions {
  readonly target?: ComposerSkillTarget;
  readonly force?: boolean;
}

export interface ComposerSkillInstallResult {
  readonly skillName: "mono-agent-composer";
  readonly target: ComposerSkillTarget;
  readonly installations: readonly {
    readonly target: Exclude<ComposerSkillTarget, "both">;
    readonly destination: string;
    readonly replaced: boolean;
  }[];
  /** Owner-private old/staged trees retained instead of pathname-recursive deletion. */
  readonly retainedRecoveryPaths: readonly string[];
}

interface InstallerTestHooks {
  readonly beforeCommit?: (context: InstallHookContext) => void | Promise<void>;
  readonly afterBackup?: (context: InstallHookContext) => void | Promise<void>;
  readonly afterReservationCreatedBeforeJournal?:
    (context: InstallHookContext) => void | Promise<void>;
  readonly beforePublish?: (context: InstallHookContext) => void | Promise<void>;
  readonly afterPublish?: (context: InstallHookContext) => void | Promise<void>;
}

interface InstallerTestControls {
  readonly homeDirectory?: string;
  readonly sourceDirectory?: string;
  readonly manifestPath?: string;
  readonly hooks?: InstallerTestHooks;
}

interface InstallHookContext {
  readonly target: "claude" | "codex";
  readonly destination: string;
  readonly stage: string;
  readonly backup?: string;
}

interface SourceFile extends SourceDescriptor {
  readonly bytes: Uint8Array;
}

interface Authority {
  readonly target: "claude" | "codex";
  readonly home: string;
  readonly homeIdentity: FileIdentity;
  readonly productRoot: string;
  readonly productIdentity: FileIdentity;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
}

interface InstallPlan {
  readonly authority: Authority;
  readonly destination: string;
  readonly stage: string;
  readonly backup?: string;
  readonly priorIdentity?: FileIdentity;
  stageIdentity?: FileIdentity;
  reservationIdentity?: FileIdentity;
}

export function installComposerSkill(
  options: InstallComposerSkillOptions = {},
): Promise<ComposerSkillInstallResult> {
  return installComposerSkillInternal(options, {});
}

/**
 * Package-internal test seam. It is deliberately absent from the root export
 * map, so the shipped install contract remains bundled-only.
 */
export function installComposerSkillForTesting(
  options: InstallComposerSkillOptions,
  controls: InstallerTestControls,
): Promise<ComposerSkillInstallResult> {
  return installComposerSkillInternal(options, controls);
}

async function installComposerSkillInternal(
  options: InstallComposerSkillOptions,
  controls: InstallerTestControls,
): Promise<ComposerSkillInstallResult> {
  assertSecurePlatform();
  const target = parseTarget(options.target ?? "both");
  const force = options.force ?? false;
  if (typeof force !== "boolean") throw new TypeError("force must be a boolean");
  const homeAuthority = await secureHome(controls.homeDirectory ?? homedir());
  const lock = await acquireInstallLock(homeAuthority.path, homeAuthority.identity);
  const recoveredPaths: string[] = [];
  let journal: OpenJournal | undefined;
  try {
    recoveredPaths.push(...await recoverStaleJournal(
      homeAuthority.path,
      homeAuthority.identity,
    ));
    const source = await loadSource(
      controls.sourceDirectory ?? DEFAULT_SOURCE_DIRECTORY,
      controls.manifestPath ?? DEFAULT_MANIFEST_PATH,
    );
    const targetNames = target === "both"
      ? ["claude", "codex"] as const
      : [target];
    const nonce = randomUUID().toLowerCase();
    const plans: InstallPlan[] = [];
    for (const targetName of targetNames) {
      const authority = await prepareAuthority(homeAuthority, targetName);
      const destination = join(authority.parent, SKILL_NAME);
      const priorIdentity = await inspectDestination(destination, force);
      plans.push({
        authority,
        destination,
        stage: join(
          authority.parent,
          `.${SKILL_NAME}.stage-${nonce}-${targetName}`,
        ),
        ...(priorIdentity === undefined
          ? {}
          : {
              priorIdentity,
              backup: join(
                authority.parent,
                `.${SKILL_NAME}.backup-${nonce}-${targetName}`,
              ),
            }),
      });
    }
    journal = await createJournal(
      homeAuthority,
      nonce,
      source.map(sourceDescriptor),
      plans,
    );
    for (const plan of plans) {
      plan.stageIdentity = await createStage(plan, source, journal);
    }
    await appendJournal(journal, Object.freeze({ phase: "prepared" }));

    for (const plan of plans) {
      await controls.hooks?.beforeCommit?.(hookContext(plan));
    }
    for (const plan of plans) {
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.stage,
        plan.stageIdentity!,
        source,
        true,
      );
      await assertDestinationInitial(plan);
    }

    for (const plan of plans) {
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.stage,
        plan.stageIdentity!,
        source,
        true,
      );
      await assertDestinationInitial(plan);
      if (plan.backup !== undefined) {
        await assertPathAbsent(plan.backup, "skill backup");
      }
      await appendJournal(journal, Object.freeze({
        phase: "reservation-intent",
        target: plan.authority.target,
      }));

      // Bracket the first data-moving mutation again. With two targets, the
      // earlier validation pass can otherwise be arbitrarily far from target
      // two's backup rename.
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.stage,
        plan.stageIdentity!,
        source,
        true,
      );
      await assertDestinationInitial(plan);
      if (plan.priorIdentity !== undefined && plan.backup !== undefined) {
        await assertPathAbsent(plan.backup, "skill backup");
        await rename(plan.destination, plan.backup);
        await assertAuthority(plan.authority);
        await assertDirectoryIdentity(
          plan.backup,
          plan.priorIdentity,
          "skill backup",
          "private",
        );
        await syncDirectory(plan.authority.parent);
        await appendJournal(journal, Object.freeze({
          phase: "backup-moved",
          target: plan.authority.target,
        }));
        await controls.hooks?.afterBackup?.(hookContext(plan));
      }
      await assertAuthority(plan.authority);
      if (plan.priorIdentity === undefined) {
        await assertDestinationInitial(plan);
      } else {
        await assertPathAbsent(plan.destination, "skill destination reservation");
      }
      try {
        await mkdir(plan.destination, { mode: 0o700 });
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          throw new Error(
            `Skill destination appeared before reservation; retained recovery path: ${plan.backup ?? plan.stage}`,
          );
        }
        throw error;
      }
      await assertAuthority(plan.authority);
      const reservation = await lstat(plan.destination);
      assertRealDirectory(reservation, "skill destination reservation");
      assertOwnerPrivate(reservation, "skill destination reservation", true);
      plan.reservationIdentity = identityOf(reservation);
      await assertEmptyDirectory(
        plan.destination,
        plan.reservationIdentity,
        "skill destination reservation",
      );
      await controls.hooks?.afterReservationCreatedBeforeJournal?.(
        hookContext(plan),
      );
      await syncDirectory(plan.authority.parent);
      await appendJournal(journal, Object.freeze({
        phase: "reserved",
        target: plan.authority.target,
        identity: plan.reservationIdentity,
      }));
    }

    for (const plan of plans) {
      await controls.hooks?.beforePublish?.(hookContext(plan));
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.stage,
        plan.stageIdentity!,
        source,
        true,
      );
      await assertEmptyDirectory(
        plan.destination,
        plan.reservationIdentity!,
        "skill destination reservation",
      );
      await assertAuthority(plan.authority);
      // mkdir atomically reserves an absent canonical name. Portable Node does
      // not expose renameat2(RENAME_NOREPLACE)/renamex_np(RENAME_EXCL), so the
      // final same-UID check-to-rename interval is bounded but not eliminable.
      // The owner-controlled parent and external cooperative lock are the
      // security boundary; a substitution observed by either adjacent check
      // fails closed and is never recursively removed.
      await rename(plan.stage, plan.destination);
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.destination,
        plan.stageIdentity!,
        source,
        true,
      );
      await syncDirectory(plan.authority.parent);
      await appendJournal(journal, Object.freeze({
        phase: "installed",
        target: plan.authority.target,
      }));
      await controls.hooks?.afterPublish?.(hookContext(plan));
    }

    for (const plan of plans) {
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.destination,
        plan.stageIdentity!,
        source,
        true,
      );
    }
    await appendJournal(journal, Object.freeze({ phase: "committed" }));
    for (const plan of plans) {
      await assertAuthority(plan.authority);
      await validateExactTree(
        plan.destination,
        plan.stageIdentity!,
        source,
        true,
      );
    }
    await journal.handle.close();
    const journalArchive = await archiveExactFile(
      journal.path,
      journal.identity,
      homeAuthority.path,
      `.${SKILL_NAME}.journal-committed-${nonce}`,
      "install journal",
    );
    journal = undefined;
    await assertAuthority(homeAuthority);
    const retainedRecoveryPaths = [
      ...recoveredPaths,
      ...plans.flatMap((plan) => plan.backup === undefined ? [] : [plan.backup]),
    ];
    // The committed journal is an owner-private decision record, not a recovery
    // payload. It is intentionally retained but omitted from recoveryPaths.
    void journalArchive;
    return Object.freeze({
      skillName: SKILL_NAME,
      target,
      installations: Object.freeze(plans.map((plan) => Object.freeze({
        target: plan.authority.target,
        destination: plan.destination,
        replaced: plan.priorIdentity !== undefined,
      }))),
      retainedRecoveryPaths: Object.freeze(retainedRecoveryPaths),
    });
  } catch (error) {
    try {
      await journal?.handle.close();
    } catch {
      // Recovery reads only the last fully fsynced newline-delimited frame.
    }
    journal = undefined;
    try {
      recoveredPaths.push(...await recoverStaleJournal(
        homeAuthority.path,
        homeAuthority.identity,
        true,
      ));
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Skill installation failed: ${errorMessage(error)} Automatic recovery refused an unknown identity: ${errorMessage(recoveryError)}`,
      );
    }
    if (recoveredPaths.length > 0) {
      throw new Error(
        `${errorMessage(error)} Retained recovery paths: ${[...new Set(recoveredPaths)].join(", ")}.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    try {
      await journal?.handle.close();
    } catch {
      // The journal remains durable for the next locked recovery pass.
    }
    await releaseInstallLock(lock, homeAuthority.path);
  }
}

function parseTarget(value: unknown): ComposerSkillTarget {
  if (value === "claude" || value === "codex" || value === "both") return value;
  throw new TypeError("target must be claude, codex, or both");
}

async function secureHome(path: string): Promise<{
  readonly path: string;
  readonly identity: FileIdentity;
}> {
  const requested = resolve(path);
  const details = await lstat(requested);
  assertRealDirectory(details, "home directory");
  assertOwnerPrivate(details, "home directory", false);
  const canonical = await realpath(requested);
  const canonicalDetails = await lstat(canonical);
  assertRealDirectory(canonicalDetails, "home directory");
  if (!sameIdentity(details, canonicalDetails)) {
    throw new Error("home directory changed identity while it was resolved");
  }
  return Object.freeze({ path: canonical, identity: identityOf(details) });
}

async function prepareAuthority(
  home: { readonly path: string; readonly identity: FileIdentity },
  target: "claude" | "codex",
): Promise<Authority> {
  await assertDirectoryIdentity(
    home.path,
    home.identity,
    "home directory",
    "authority",
  );
  const productRoot = join(home.path, target === "claude" ? ".claude" : ".codex");
  const productIdentity = await ensureAuthorityDirectory(
    productRoot,
    `${target} directory`,
  );
  const parent = join(productRoot, "skills");
  const parentIdentity = await ensureAuthorityDirectory(
    parent,
    `${target} skills directory`,
  );
  const authority = Object.freeze({
    target,
    home: home.path,
    homeIdentity: home.identity,
    productRoot,
    productIdentity,
    parent,
    parentIdentity,
  });
  await assertAuthority(authority);
  return authority;
}

async function assertAuthority(
  authority: Authority | { readonly path: string; readonly identity: FileIdentity },
): Promise<void> {
  if ("target" in authority) {
    await assertDirectoryIdentity(
      authority.home,
      authority.homeIdentity,
      "home directory",
      "authority",
    );
    await assertDirectoryIdentity(
      authority.productRoot,
      authority.productIdentity,
      `${authority.target} directory`,
      "authority",
    );
    await assertDirectoryIdentity(
      authority.parent,
      authority.parentIdentity,
      `${authority.target} skills directory`,
      "authority",
    );
    return;
  }
  await assertDirectoryIdentity(
    authority.path,
    authority.identity,
    "home directory",
    "authority",
  );
}

async function ensureAuthorityDirectory(
  path: string,
  label: string,
): Promise<FileIdentity> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const details = await lstat(path);
  assertRealDirectory(details, label);
  assertOwnerPrivate(details, label, created);
  return identityOf(details);
}

async function inspectDestination(
  path: string,
  force: boolean,
): Promise<FileIdentity | undefined> {
  const details = await lstatOrUndefined(path);
  if (details === undefined) return undefined;
  assertRealDirectory(details, "skill destination");
  assertOwnerPrivate(details, "skill destination", true);
  if (!force) {
    throw new Error(`Skill destination ${path} already exists; use --force to replace it.`);
  }
  return identityOf(details);
}

async function assertDestinationInitial(plan: InstallPlan): Promise<void> {
  const details = await lstatOrUndefined(plan.destination);
  if (plan.priorIdentity === undefined) {
    if (details !== undefined) {
      throw new Error("Skill destination appeared before the atomic reservation.");
    }
    return;
  }
  if (details === undefined) throw recoveryPathError(plan, "Skill destination disappeared");
  assertRealDirectory(details, "skill destination");
  assertOwnerPrivate(details, "skill destination", true);
  if (!sameFileIdentity(identityOf(details), plan.priorIdentity)) {
    throw recoveryPathError(plan, "Skill destination changed identity");
  }
}

async function createStage(
  plan: InstallPlan,
  source: readonly SourceFile[],
  journal: OpenJournal,
): Promise<FileIdentity> {
  await assertAuthority(plan.authority);
  await mkdir(plan.stage, { mode: 0o700 });
  const root = await lstat(plan.stage);
  assertRealDirectory(root, "skill stage");
  assertOwnerPrivate(root, "skill stage", true);
  const identity = identityOf(root);
  await appendJournal(journal, Object.freeze({
    phase: "stage-created",
    target: plan.authority.target,
    identity,
  }));
  const directories = sourceDirectories(source);
  for (const directory of directories) {
    await mkdir(join(plan.stage, ...directory.split("/")), { mode: 0o700 });
  }
  for (const file of source) {
    const handle = await open(
      join(plan.stage, ...file.path.split("/")),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await writeFully(handle, file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const directory of [...directories].sort((left, right) =>
    right.split("/").length - left.split("/").length)) {
    await syncDirectory(join(plan.stage, ...directory.split("/")));
  }
  await syncDirectory(plan.stage);
  await validateExactTree(plan.stage, identity, source, true);
  return identity;
}

async function loadSource(
  sourceDirectory: string,
  manifestPath: string,
): Promise<readonly SourceFile[]> {
  const source = resolve(sourceDirectory);
  const root = await lstat(source);
  assertRealDirectory(root, "skill source");
  const rootIdentity = identityOf(root);
  const canonical = await realpath(source);
  const descriptors = await readManifest(resolve(manifestPath));
  const files: SourceFile[] = [];
  const expected = new Map(descriptors.map((file) => [file.path, file]));
  const observed = await collectSourceFiles(
    canonical,
    "",
    expected,
    allowedSourceDirectories(descriptors),
    files,
  );
  if (observed.size !== expected.size) {
    throw new Error("Skill source does not match its exhaustive manifest.");
  }
  await assertDirectoryIdentity(source, rootIdentity, "skill source");
  return Object.freeze(files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function collectSourceFiles(
  root: string,
  relativeDirectory: string,
  expected: ReadonlyMap<string, SourceDescriptor>,
  allowedDirectories: ReadonlySet<string>,
  files: SourceFile[],
): Promise<ReadonlySet<string>> {
  const path = relativeDirectory === "" ? root : join(root, ...relativeDirectory.split("/"));
  const details = await lstat(path);
  assertRealDirectory(details, "skill source directory");
  const identity = identityOf(details);
  const directory = await opendir(path);
  const observed = new Set<string>();
  try {
    for await (const entry of directory) {
      const relativePath = safeRelativePath(
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`,
      );
      const entryPath = join(root, ...relativePath.split("/"));
      const entryDetails = await lstat(entryPath);
      if (entryDetails.isSymbolicLink()) {
        throw new Error(`Skill source path ${relativePath} must not be a symbolic link.`);
      }
      if (entryDetails.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          throw new Error(`Skill source contains undeclared directory ${relativePath}.`);
        }
        const nested = await collectSourceFiles(
          root,
          relativePath,
          expected,
          allowedDirectories,
          files,
        );
        for (const value of nested) observed.add(value);
        continue;
      }
      if (!entryDetails.isFile()) {
        throw new Error(`Skill source path ${relativePath} must be a regular file.`);
      }
      const descriptor = expected.get(relativePath);
      if (descriptor === undefined) {
        throw new Error(`Skill source contains undeclared file ${relativePath}.`);
      }
      const handle = await open(entryPath, constants.O_RDONLY | NO_FOLLOW);
      try {
        const bytes = await readExact(handle, descriptor.sizeBytes);
        const after = await handle.stat();
        if (!sameIdentity(entryDetails, after) || after.size !== descriptor.sizeBytes) {
          throw new Error(`Skill source file ${relativePath} changed while it was read.`);
        }
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (digest !== descriptor.sha256) {
          throw new Error(`Skill source file ${relativePath} does not match its manifest.`);
        }
        files.push(Object.freeze({ ...descriptor, bytes }));
      } finally {
        await handle.close();
      }
      observed.add(relativePath);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await assertDirectoryIdentity(path, identity, "skill source directory");
  return observed;
}

async function readManifest(path: string): Promise<readonly SourceDescriptor[]> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("Skill source manifest must be a regular file.");
  }
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const bytes = await readBounded(handle, MANIFEST_MAX_BYTES);
    const after = await handle.stat();
    if (!sameIdentity(details, after) || after.size !== bytes.byteLength) {
      throw new Error("Skill source manifest changed while it was read.");
    }
    const decoded = parseJson(bytes, "Skill source manifest");
    if (!isRecord(decoded) || !hasExactKeys(decoded, ["schemaVersion", "skillName", "files"])) {
      throw new Error("Skill source manifest has an invalid shape.");
    }
    if (decoded.schemaVersion !== 1 || decoded.skillName !== SKILL_NAME) {
      throw new Error("Skill source manifest has an unsupported identity.");
    }
    return parseSourceDescriptors(decoded.files, "Skill source manifest");
  } finally {
    await handle.close();
  }
}

function sourceDescriptor(file: SourceFile): SourceDescriptor {
  return Object.freeze({
    path: file.path,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  });
}

function sourceDirectories(source: readonly SourceDescriptor[]): readonly string[] {
  return [...allowedSourceDirectories(source)]
    .filter((path) => path !== "")
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth === 0 ? left.localeCompare(right) : depth;
    });
}

function hookContext(plan: InstallPlan): InstallHookContext {
  return Object.freeze({
    target: plan.authority.target,
    destination: plan.destination,
    stage: plan.stage,
    ...(plan.backup === undefined ? {} : { backup: plan.backup }),
  });
}

function recoveryPathError(plan: InstallPlan, message: string): Error {
  return new Error(
    `${message}; destination=${plan.destination}; stage=${plan.stage}; backup=${plan.backup ?? "none"}.`,
  );
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON.`, { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
