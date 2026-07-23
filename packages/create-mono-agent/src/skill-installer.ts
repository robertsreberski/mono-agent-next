import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPOSER_SKILL_TARGETS = ["claude", "codex", "both"] as const;
export type ComposerSkillTarget = (typeof COMPOSER_SKILL_TARGETS)[number];

const SKILL_NAME = "mono-agent-composer";
const MANIFEST_MAX_BYTES = 64 * 1024;
const JOURNAL_MAX_BYTES = 256 * 1024;
const SOURCE_MAX_FILES = 32;
const SOURCE_MAX_FILE_BYTES = 256 * 1024;
const SOURCE_MAX_TOTAL_BYTES = 1024 * 1024;
const SOURCE_MAX_PATH_BYTES = 512;
const SOURCE_MAX_DEPTH = 6;
const NO_FOLLOW = constants.O_NOFOLLOW;
const OPEN_DIRECTORY = constants.O_DIRECTORY;
const LOCK_NAME = ".mono-agent-composer.install-lock-v1";
const JOURNAL_NAME = ".mono-agent-composer.install-journal-v1";
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

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
  readonly skillName: typeof SKILL_NAME;
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

interface SourceDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

interface SourceFile extends SourceDescriptor {
  readonly bytes: Uint8Array;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

type DirectoryPrivacy = "authority" | "private";

interface RestoreAttempt {
  readonly attempt: number;
  readonly identity?: FileIdentity;
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

interface JournalHeader {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.composer-skill-install";
  readonly nonce: string;
  readonly ownerPid: number;
  readonly home: string;
  readonly homeIdentity: FileIdentity;
  readonly source: readonly SourceDescriptor[];
  readonly plans: readonly JournalPlan[];
}

interface JournalPlan {
  readonly target: "claude" | "codex";
  readonly productRoot: string;
  readonly productIdentity: FileIdentity;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly destination: string;
  readonly stage: string;
  readonly backup?: string;
  readonly priorIdentity?: FileIdentity;
}

interface JournalState {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly header: JournalHeader;
  readonly stages: ReadonlyMap<string, FileIdentity>;
  readonly reservationIntents: ReadonlySet<string>;
  readonly reservations: ReadonlyMap<string, FileIdentity>;
  readonly restoreAttempts: ReadonlyMap<string, RestoreAttempt>;
  readonly prepared: boolean;
  readonly committed: boolean;
}

interface InstallLock {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly nonce: string;
  readonly handle: FileHandle;
}

interface OpenJournal {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly nonce: string;
  readonly handle: FileHandle;
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

function assertSecurePlatform(): void {
  if (
    typeof process.getuid !== "function"
    || typeof NO_FOLLOW !== "number"
    || typeof OPEN_DIRECTORY !== "number"
  ) {
    throw new Error(
      "Composer skill installation is unsupported on this platform because current-UID, O_NOFOLLOW, and O_DIRECTORY proofs are required.",
    );
  }
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

async function validateExactTree(
  root: string,
  expectedRoot: FileIdentity,
  source: readonly SourceDescriptor[],
  ownerPrivate: boolean,
): Promise<void> {
  await assertDirectoryIdentity(root, expectedRoot, "skill tree");
  const expectedFiles = new Map(source.map((file) => [file.path, file]));
  const allowedDirectories = allowedSourceDirectories(source);
  const observed = await enumerateAndValidateTree(
    root,
    "",
    expectedFiles,
    allowedDirectories,
    ownerPrivate,
  );
  if (observed.size !== expectedFiles.size) {
    throw new Error("Skill tree does not match its exhaustive manifest.");
  }
  await assertDirectoryIdentity(root, expectedRoot, "skill tree");
}

async function enumerateAndValidateTree(
  root: string,
  relativeDirectory: string,
  expectedFiles: ReadonlyMap<string, SourceDescriptor>,
  allowedDirectories: ReadonlySet<string>,
  ownerPrivate: boolean,
): Promise<ReadonlySet<string>> {
  const directoryPath = relativeDirectory === ""
    ? root
    : join(root, ...relativeDirectory.split("/"));
  const directoryDetails = await lstat(directoryPath);
  assertRealDirectory(directoryDetails, "skill tree directory");
  if (ownerPrivate) assertOwnerPrivate(directoryDetails, "skill tree directory", true);
  const directoryIdentity = identityOf(directoryDetails);
  const directory = await opendir(directoryPath);
  const observed = new Set<string>();
  try {
    for await (const entry of directory) {
      const relativePath = safeRelativePath(
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`,
      );
      const path = join(root, ...relativePath.split("/"));
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        throw new Error(`Skill tree path ${relativePath} must not be a symbolic link.`);
      }
      if (details.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          throw new Error(`Skill tree contains undeclared directory ${relativePath}.`);
        }
        const nested = await enumerateAndValidateTree(
          root,
          relativePath,
          expectedFiles,
          allowedDirectories,
          ownerPrivate,
        );
        for (const value of nested) observed.add(value);
        continue;
      }
      if (!details.isFile()) {
        throw new Error(`Skill tree path ${relativePath} must be a regular file.`);
      }
      if (ownerPrivate) assertOwnerPrivate(details, `skill tree file ${relativePath}`, true);
      const expected = expectedFiles.get(relativePath);
      if (expected === undefined) {
        throw new Error(`Skill tree contains undeclared file ${relativePath}.`);
      }
      const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
      try {
        const bytes = await readExact(handle, expected.sizeBytes);
        const after = await handle.stat();
        if (!sameIdentity(details, after) || after.size !== expected.sizeBytes) {
          throw new Error(`Skill tree file ${relativePath} changed while it was read.`);
        }
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (digest !== expected.sha256) {
          throw new Error(`Skill tree file ${relativePath} does not match its manifest.`);
        }
      } finally {
        await handle.close();
      }
      observed.add(relativePath);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await assertDirectoryIdentity(directoryPath, directoryIdentity, "skill tree directory");
  return observed;
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

function parseSourceDescriptors(value: unknown, label: string): readonly SourceDescriptor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SOURCE_MAX_FILES) {
    throw new Error(`${label} exceeds its file-count bound.`);
  }
  let totalBytes = 0;
  let previousPath = "";
  const descriptors = value.map((entry, index): SourceDescriptor => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "sha256", "sizeBytes"])) {
      throw new Error(`${label} file ${String(index)} has an invalid shape.`);
    }
    const path = safeRelativePath(entry.path);
    if (index > 0 && path <= previousPath) {
      throw new Error(`${label} paths must be unique and sorted.`);
    }
    previousPath = path;
    if (typeof entry.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error(`${label} file ${path} has an invalid digest.`);
    }
    if (
      !Number.isSafeInteger(entry.sizeBytes)
      || (entry.sizeBytes as number) < 0
      || (entry.sizeBytes as number) > SOURCE_MAX_FILE_BYTES
    ) {
      throw new Error(`${label} file ${path} exceeds its byte bound.`);
    }
    totalBytes += entry.sizeBytes as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SOURCE_MAX_TOTAL_BYTES) {
      throw new Error(`${label} exceeds its aggregate byte bound.`);
    }
    return Object.freeze({
      path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes as number,
    });
  });
  return Object.freeze(descriptors);
}

async function acquireInstallLock(
  home: string,
  homeIdentity: FileIdentity,
): Promise<InstallLock> {
  const path = join(home, LOCK_NAME);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assertDirectoryIdentity(
      home,
      homeIdentity,
      "home directory",
      "authority",
    );
    const nonce = randomUUID().toLowerCase();
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      const details = await handle.stat();
      const identity = identityOf(details);
      await writeFully(handle, Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        kind: "mono-agent.composer-skill-lock",
        nonce,
        ownerPid: process.pid,
      })}\n`, "utf8"));
      await handle.sync();
      await syncDirectory(home);
      return Object.freeze({ path, identity, nonce, handle });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readOwnerFile(path, "install lock");
      const ownerPid = ownerPidFromRecord(existing.value, "install lock");
      if (pidIsAlive(ownerPid)) {
        throw new Error(`Another composer skill installation is active at ${path}.`);
      }
      await archiveExactFile(
        path,
        existing.identity,
        home,
        `.${SKILL_NAME}.lock-stale-${randomUUID().toLowerCase()}`,
        "stale install lock",
      );
    }
  }
  throw new Error("Composer skill install lock acquisition did not converge.");
}

async function releaseInstallLock(lock: InstallLock, home: string): Promise<void> {
  try {
    await lock.handle.close();
  } finally {
    await archiveExactFile(
      lock.path,
      lock.identity,
      home,
      `.${SKILL_NAME}.lock-released-${lock.nonce}`,
      "install lock",
    );
  }
}

async function createJournal(
  home: { readonly path: string; readonly identity: FileIdentity },
  nonce: string,
  source: readonly SourceDescriptor[],
  plans: readonly InstallPlan[],
): Promise<OpenJournal> {
  const path = join(home.path, JOURNAL_NAME);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
      | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  const identity = identityOf(await handle.stat());
  const header: JournalHeader = Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.composer-skill-install",
    nonce,
    ownerPid: process.pid,
    home: home.path,
    homeIdentity: home.identity,
    source: Object.freeze(source.map((entry) => Object.freeze({ ...entry }))),
    plans: Object.freeze(plans.map((plan): JournalPlan => Object.freeze({
      target: plan.authority.target,
      productRoot: plan.authority.productRoot,
      productIdentity: plan.authority.productIdentity,
      parent: plan.authority.parent,
      parentIdentity: plan.authority.parentIdentity,
      destination: plan.destination,
      stage: plan.stage,
      ...(plan.backup === undefined ? {} : { backup: plan.backup }),
      ...(plan.priorIdentity === undefined
        ? {}
        : { priorIdentity: plan.priorIdentity }),
    }))),
  });
  const journal = Object.freeze({ path, identity, nonce, handle });
  await appendJournal(journal, header);
  await syncDirectory(home.path);
  return journal;
}

async function appendJournal(journal: OpenJournal, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await writeFully(journal.handle, bytes);
  await journal.handle.sync();
}

async function recoverStaleJournal(
  home: string,
  homeIdentity: FileIdentity,
  allowCurrentProcess = false,
): Promise<readonly string[]> {
  const path = join(home, JOURNAL_NAME);
  const details = await lstatOrUndefined(path);
  if (details === undefined) return Object.freeze([]);
  await assertDirectoryIdentity(
    home,
    homeIdentity,
    "home directory",
    "authority",
  );
  const state = await readJournal(path, home, homeIdentity);
  if (!allowCurrentProcess && pidIsAlive(state.header.ownerPid)) {
    throw new Error(`An active install journal remains at ${path}.`);
  }
  if (state.committed) {
    for (const plan of state.header.plans) {
      const stageIdentity = state.stages.get(plan.target);
      if (stageIdentity === undefined) {
        throw journalRecoveryError(state, plan, "Committed journal is missing stage identity");
      }
      await assertJournalAuthority(state.header, plan);
      await validateExactTree(
        plan.destination,
        stageIdentity,
        state.header.source,
        true,
      );
    }
    await archiveJournal(state, home, "committed-recovered");
    return Object.freeze(state.header.plans.flatMap((plan) =>
      plan.backup === undefined ? [] : [plan.backup]));
  }

  const retained: string[] = [];
  for (const plan of [...state.header.plans].reverse()) {
    await assertJournalAuthority(state.header, plan);
    const stageIdentity = state.stages.get(plan.target);
    const reservationIdentity = state.reservations.get(plan.target);
    const restoreAttempt = state.restoreAttempts.get(plan.target);
    await collectExistingQuarantines(
      state,
      plan,
      stageIdentity,
      reservationIdentity,
      restoreAttempt,
      retained,
    );
    let destination = await lstatOrUndefined(plan.destination);
    const backup = plan.backup === undefined
      ? undefined
      : await lstatOrUndefined(plan.backup);

    if (plan.priorIdentity !== undefined && plan.backup !== undefined) {
      if (backup !== undefined) {
        assertRealDirectory(backup, "skill backup");
        assertOwnerPrivate(backup, "skill backup", true);
        if (!sameFileIdentity(identityOf(backup), plan.priorIdentity)) {
          throw journalRecoveryError(state, plan, "Backup identity is unknown");
        }
        if (destination !== undefined) {
          const destinationIdentity = identityOf(destination);
          if (restoreAttempt !== undefined) {
            if (
              restoreAttempt.identity !== undefined
              && sameFileIdentity(destinationIdentity, restoreAttempt.identity)
            ) {
              await assertEmptyDirectory(
                plan.destination,
                restoreAttempt.identity,
                "restore reservation",
              );
            } else if (
              restoreAttempt.identity === undefined
              && await inferredReservationIdentity(plan.destination) !== undefined
            ) {
              pushRetained(retained, await quarantineJournalTree(
                state,
                plan,
                destinationIdentity,
                `${plan.target}-restore-${String(restoreAttempt.attempt)}`,
              ));
              destination = undefined;
            } else {
              throw journalRecoveryError(
                state,
                plan,
                "Unknown destination prevents interrupted restore recovery",
              );
            }
          } else if (
            isKnownInstallIdentity(
              destinationIdentity,
              stageIdentity,
              reservationIdentity,
            )
            || (
              state.reservationIntents.has(plan.target)
              && await inferredReservationIdentity(plan.destination) !== undefined
            )
          ) {
            pushRetained(retained, await quarantineJournalTree(
              state,
              plan,
              destinationIdentity,
              `${plan.target}-new`,
            ));
            destination = undefined;
          } else {
            throw journalRecoveryError(
              state,
              plan,
              "Destination competitor prevents automatic backup restore",
            );
          }
        }
        if (destination === undefined) {
          await restoreExactBackup(state, plan);
        } else if (
          restoreAttempt?.identity !== undefined
          && sameFileIdentity(identityOf(destination), restoreAttempt.identity)
        ) {
          await restoreExactBackup(state, plan);
        } else {
          throw journalRecoveryError(
            state,
            plan,
            "Destination prevents exact backup restore",
          );
        }
      } else if (
        destination === undefined
        || !sameFileIdentity(identityOf(destination), plan.priorIdentity)
      ) {
        throw journalRecoveryError(state, plan, "Prior install is not recoverable");
      } else {
        assertRealDirectory(destination, "restored skill");
        assertOwnerPrivate(destination, "restored skill", true);
      }
    } else if (destination !== undefined) {
      const destinationIdentity = identityOf(destination);
      if (
        isKnownInstallIdentity(
          destinationIdentity,
          stageIdentity,
          reservationIdentity,
        )
        || (
          state.reservationIntents.has(plan.target)
          && await inferredReservationIdentity(plan.destination) !== undefined
        )
      ) {
        pushRetained(retained, await quarantineJournalTree(
          state,
          plan,
          destinationIdentity,
          `${plan.target}-new`,
        ));
      } else {
        throw journalRecoveryError(
          state,
          plan,
          "Unknown destination prevents automatic rollback",
        );
      }
    }

    if (stageIdentity !== undefined) {
      const stage = await lstatOrUndefined(plan.stage);
      if (
        stage !== undefined
        && sameFileIdentity(identityOf(stage), stageIdentity)
      ) {
        pushRetained(retained, await quarantineJournalTree(
          state,
          plan,
          stageIdentity,
          `${plan.target}-stage`,
          plan.stage,
        ));
      } else if (stage !== undefined) {
        // Never delete or move an identity that is not journal-authorized.
        pushRetained(retained, plan.stage);
      }
    } else if (await lstatOrUndefined(plan.stage) !== undefined) {
      // A crash can happen after mkdir and before the stage identity frame is
      // durable. Its deterministic path is reported but never moved or
      // recursively removed because the journal cannot authorize its inode.
      pushRetained(retained, plan.stage);
    }
    await assertJournalAuthority(state.header, plan);
  }
  await archiveJournal(state, home, state.prepared ? "rolled-back" : "abandoned");
  return Object.freeze(retained);
}

function isKnownInstallIdentity(
  candidate: FileIdentity,
  stage: FileIdentity | undefined,
  reservation: FileIdentity | undefined,
): boolean {
  return (stage !== undefined && sameFileIdentity(candidate, stage))
    || (reservation !== undefined && sameFileIdentity(candidate, reservation));
}

async function collectExistingQuarantines(
  state: JournalState,
  plan: JournalPlan,
  stageIdentity: FileIdentity | undefined,
  reservationIdentity: FileIdentity | undefined,
  restoreAttempt: RestoreAttempt | undefined,
  retained: string[],
): Promise<void> {
  const newQuarantine = quarantinePath(
    plan.parent,
    state.header.nonce,
    `${plan.target}-new`,
  );
  const newDetails = await lstatOrUndefined(newQuarantine);
  if (newDetails !== undefined) {
    const identity = identityOf(newDetails);
    if (
      isKnownInstallIdentity(identity, stageIdentity, reservationIdentity)
    ) {
      await assertDirectoryIdentity(
        newQuarantine,
        identity,
        "retained install quarantine",
        "private",
      );
    } else if (
      !state.reservationIntents.has(plan.target)
      || await inferredReservationIdentity(newQuarantine) === undefined
    ) {
      throw journalRecoveryError(state, plan, "Install quarantine identity is unknown");
    }
    pushRetained(retained, newQuarantine);
  }

  const stageQuarantine = quarantinePath(
    plan.parent,
    state.header.nonce,
    `${plan.target}-stage`,
  );
  const stageDetails = await lstatOrUndefined(stageQuarantine);
  if (stageDetails !== undefined) {
    if (
      stageIdentity === undefined
      || !sameFileIdentity(identityOf(stageDetails), stageIdentity)
    ) {
      throw journalRecoveryError(state, plan, "Stage quarantine identity is unknown");
    }
    await assertDirectoryIdentity(
      stageQuarantine,
      stageIdentity,
      "retained stage quarantine",
      "private",
    );
    pushRetained(retained, stageQuarantine);
  }

  if (restoreAttempt !== undefined) {
    for (let attempt = 0; attempt <= restoreAttempt.attempt; attempt += 1) {
      const restoreQuarantine = quarantinePath(
        plan.parent,
        state.header.nonce,
        `${plan.target}-restore-${String(attempt)}`,
      );
      if (await lstatOrUndefined(restoreQuarantine) === undefined) continue;
      if (await inferredReservationIdentity(restoreQuarantine) === undefined) {
        throw journalRecoveryError(
          state,
          plan,
          "Restore reservation quarantine identity is unknown",
        );
      }
      pushRetained(retained, restoreQuarantine);
    }
  }
}

async function restoreExactBackup(
  state: JournalState,
  plan: JournalPlan,
): Promise<void> {
  if (plan.backup === undefined || plan.priorIdentity === undefined) return;
  await assertJournalAuthority(state.header, plan);
  await assertDirectoryIdentity(
    plan.backup,
    plan.priorIdentity,
    "skill backup",
    "private",
  );

  let attempt = state.restoreAttempts.get(plan.target);
  let reservationIdentity: FileIdentity;
  const destination = await lstatOrUndefined(plan.destination);
  if (destination !== undefined) {
    if (
      attempt?.identity === undefined
      || !sameFileIdentity(identityOf(destination), attempt.identity)
    ) {
      throw journalRecoveryError(
        state,
        plan,
        "Unknown destination remains before backup restore",
      );
    }
    reservationIdentity = attempt.identity;
    await assertEmptyDirectory(
      plan.destination,
      reservationIdentity,
      "restore reservation",
    );
  } else {
    if (attempt === undefined) {
      attempt = Object.freeze({ attempt: 0 });
      await appendRecoveryJournal(state, Object.freeze({
        phase: "restore-intent",
        target: plan.target,
        attempt: attempt.attempt,
      }));
    } else if (
      attempt.identity === undefined
      && await lstatOrUndefined(quarantinePath(
        plan.parent,
        state.header.nonce,
        `${plan.target}-restore-${String(attempt.attempt)}`,
      )) !== undefined
    ) {
      attempt = Object.freeze({ attempt: attempt.attempt + 1 });
      await appendRecoveryJournal(state, Object.freeze({
        phase: "restore-intent",
        target: plan.target,
        attempt: attempt.attempt,
      }));
    } else if (attempt.identity !== undefined) {
      throw journalRecoveryError(
        state,
        plan,
        "Durable restore reservation disappeared",
      );
    }

    await assertJournalAuthority(state.header, plan);
    await assertPathAbsent(plan.destination, "restore reservation");
    await mkdir(plan.destination, { mode: 0o700 });
    await assertJournalAuthority(state.header, plan);
    const reservation = await lstat(plan.destination);
    assertRealDirectory(reservation, "restore reservation");
    assertOwnerPrivate(reservation, "restore reservation", true);
    reservationIdentity = identityOf(reservation);
    await assertEmptyDirectory(
      plan.destination,
      reservationIdentity,
      "restore reservation",
    );
    await syncDirectory(plan.parent);
    await appendRecoveryJournal(state, Object.freeze({
      phase: "restore-reserved",
      target: plan.target,
      attempt: attempt.attempt,
      identity: reservationIdentity,
    }));
  }

  await assertJournalAuthority(state.header, plan);
  await assertEmptyDirectory(
    plan.destination,
    reservationIdentity,
    "restore reservation",
  );
  await assertDirectoryIdentity(
    plan.backup,
    plan.priorIdentity,
    "skill backup",
    "private",
  );
  await assertJournalAuthority(state.header, plan);
  await rename(plan.backup, plan.destination);
  await assertJournalAuthority(state.header, plan);
  await assertDirectoryIdentity(
    plan.destination,
    plan.priorIdentity,
    "restored skill",
    "private",
  );
  await syncDirectory(plan.parent);
}

async function quarantineJournalTree(
  state: JournalState,
  plan: JournalPlan,
  identity: FileIdentity,
  label: string,
  path = plan.destination,
): Promise<string> {
  await assertJournalAuthority(state.header, plan);
  const quarantine = await quarantineExactTree(
    path,
    identity,
    plan.parent,
    state.header.nonce,
    label,
  );
  await assertJournalAuthority(state.header, plan);
  return quarantine;
}

function quarantinePath(parent: string, nonce: string, label: string): string {
  return join(parent, `.${SKILL_NAME}.quarantine-${nonce}-${label}`);
}

async function inferredReservationIdentity(
  path: string,
): Promise<FileIdentity | undefined> {
  const details = await lstatOrUndefined(path);
  if (
    details === undefined
    || details.isSymbolicLink()
    || !details.isDirectory()
  ) {
    return undefined;
  }
  try {
    assertOwnerPrivate(details, "inferred skill reservation", true);
    const identity = identityOf(details);
    await assertEmptyDirectory(path, identity, "inferred skill reservation");
    return identity;
  } catch {
    return undefined;
  }
}

function pushRetained(retained: string[], path: string): void {
  if (!retained.includes(path)) retained.push(path);
}

async function quarantineExactTree(
  path: string,
  identity: FileIdentity,
  parent: string,
  nonce: string,
  label: string,
): Promise<string> {
  await assertDirectoryIdentity(path, identity, "quarantined tree", "private");
  const quarantine = quarantinePath(parent, nonce, label);
  if (await lstatOrUndefined(quarantine) !== undefined) {
    throw new Error(`Recovery quarantine already exists at ${quarantine}.`);
  }
  await rename(path, quarantine);
  await assertDirectoryIdentity(quarantine, identity, "quarantined tree", "private");
  await syncDirectory(parent);
  return quarantine;
}

async function appendRecoveryJournal(
  state: JournalState,
  value: unknown,
): Promise<void> {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const details = await lstat(state.path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Install journal ${state.path} is no longer a regular file.`);
  }
  assertOwnerPrivate(details, "install journal", true);
  if (!sameFileIdentity(identityOf(details), state.identity)) {
    throw new Error(`Install journal ${state.path} changed identity.`);
  }
  if (details.size + frame.byteLength > JOURNAL_MAX_BYTES) {
    throw new Error(`Install journal ${state.path} exceeds its byte bound.`);
  }
  const handle = await open(
    state.path,
    constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!sameIdentity(details, opened)) {
      throw new Error(`Install journal ${state.path} changed while opening.`);
    }
    await writeFully(handle, frame);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await lstat(state.path);
  if (!sameFileIdentity(identityOf(after), state.identity)) {
    throw new Error(`Install journal ${state.path} changed after append.`);
  }
}

async function readJournal(
  path: string,
  expectedHome: string,
  expectedHomeIdentity: FileIdentity,
): Promise<JournalState> {
  const file = await readOwnerFile(path, "install journal");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n").slice(0, -1);
  if (lines.length < 1) throw new Error(`Install journal ${path} has no durable frame.`);
  const frames = lines.map((line) => JSON.parse(line) as unknown);
  const header = parseJournalHeader(frames[0], expectedHome, expectedHomeIdentity);
  const stages = new Map<string, FileIdentity>();
  const reservationIntents = new Set<string>();
  const reservations = new Map<string, FileIdentity>();
  const restoreAttempts = new Map<string, RestoreAttempt>();
  const backedUp = new Set<string>();
  const installed = new Set<string>();
  const plans = new Map(header.plans.map((plan) => [plan.target, plan]));
  let prepared = false;
  let committed = false;
  for (const frame of frames.slice(1)) {
    if (!isRecord(frame) || typeof frame.phase !== "string") {
      throw new Error(`Install journal ${path} contains an invalid frame.`);
    }
    if (committed) {
      throw new Error(`Install journal ${path} contains a frame after commit.`);
    }
    if (frame.phase === "stage-created") {
      if (
        prepared
        || !hasExactKeys(frame, ["phase", "target", "identity"])
      ) {
        throw new Error(`Install journal ${path} contains an invalid stage frame.`);
      }
      const target = journalTarget(frame.target);
      if (!plans.has(target)) {
        throw new Error(`Install journal ${path} stages an unplanned target.`);
      }
      const identity = parseIdentity(frame.identity, "journal frame identity");
      if (stages.has(target)) {
        throw new Error(`Install journal ${path} repeats stage-created.`);
      }
      stages.set(target, identity);
    } else if (frame.phase === "prepared") {
      if (
        prepared
        || !hasExactKeys(frame, ["phase"])
        || stages.size !== header.plans.length
      ) {
        throw new Error(`Install journal ${path} contains an invalid prepared frame.`);
      }
      prepared = true;
    } else if (frame.phase === "reservation-intent") {
      if (!prepared || !hasExactKeys(frame, ["phase", "target"])) {
        throw new Error(`Install journal ${path} contains an invalid reservation intent.`);
      }
      const target = journalTarget(frame.target);
      if (
        !plans.has(target)
        || reservationIntents.has(target)
        || backedUp.has(target)
        || reservations.has(target)
        || installed.has(target)
      ) {
        throw new Error(`Install journal ${path} repeats or misorders reservation intent.`);
      }
      reservationIntents.add(target);
    } else if (frame.phase === "backup-moved") {
      if (!prepared || !hasExactKeys(frame, ["phase", "target"])) {
        throw new Error(`Install journal ${path} contains an invalid backup frame.`);
      }
      const target = journalTarget(frame.target);
      const plan = plans.get(target);
      if (
        plan?.priorIdentity === undefined
        || !reservationIntents.has(target)
        || backedUp.has(target)
        || reservations.has(target)
      ) {
        throw new Error(`Install journal ${path} contains an invalid backup transition.`);
      }
      backedUp.add(target);
    } else if (frame.phase === "reserved") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase", "target", "identity"])
      ) {
        throw new Error(`Install journal ${path} contains an invalid reservation frame.`);
      }
      const target = journalTarget(frame.target);
      const plan = plans.get(target);
      if (
        plan === undefined
        || !reservationIntents.has(target)
        || reservations.has(target)
        || installed.has(target)
        || (plan.priorIdentity !== undefined && !backedUp.has(target))
      ) {
        throw new Error(`Install journal ${path} contains an invalid reservation transition.`);
      }
      reservations.set(
        target,
        parseIdentity(frame.identity, "journal frame identity"),
      );
    } else if (frame.phase === "restore-intent") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase", "target", "attempt"])
        || !Number.isSafeInteger(frame.attempt)
        || (frame.attempt as number) < 0
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore intent.`);
      }
      const target = journalTarget(frame.target);
      const plan = plans.get(target);
      const previous = restoreAttempts.get(target);
      const expectedAttempt = previous === undefined ? 0 : previous.attempt + 1;
      if (
        plan?.priorIdentity === undefined
        || !reservationIntents.has(target)
        || frame.attempt !== expectedAttempt
        || previous?.identity !== undefined
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore transition.`);
      }
      restoreAttempts.set(target, Object.freeze({
        attempt: frame.attempt as number,
      }));
    } else if (frame.phase === "restore-reserved") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase", "target", "attempt", "identity"])
        || !Number.isSafeInteger(frame.attempt)
        || (frame.attempt as number) < 0
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore reservation.`);
      }
      const target = journalTarget(frame.target);
      const previous = restoreAttempts.get(target);
      if (
        previous === undefined
        || previous.attempt !== frame.attempt
        || previous.identity !== undefined
      ) {
        throw new Error(`Install journal ${path} contains an invalid restore reservation transition.`);
      }
      restoreAttempts.set(target, Object.freeze({
        attempt: previous.attempt,
        identity: parseIdentity(frame.identity, "journal restore identity"),
      }));
    } else if (frame.phase === "installed") {
      if (!prepared || !hasExactKeys(frame, ["phase", "target"])) {
        throw new Error(`Install journal ${path} contains an invalid installed frame.`);
      }
      const target = journalTarget(frame.target);
      if (!reservations.has(target) || installed.has(target)) {
        throw new Error(`Install journal ${path} contains an invalid install transition.`);
      }
      installed.add(target);
    } else if (frame.phase === "committed") {
      if (
        !prepared
        || !hasExactKeys(frame, ["phase"])
        || installed.size !== header.plans.length
      ) {
        throw new Error(`Install journal ${path} contains an invalid commit frame.`);
      }
      committed = true;
    } else {
      throw new Error(`Install journal ${path} contains an unsupported phase.`);
    }
  }
  return Object.freeze({
    path,
    identity: file.identity,
    header,
    stages,
    reservationIntents,
    reservations,
    restoreAttempts,
    prepared,
    committed,
  });
}

function parseJournalHeader(
  value: unknown,
  expectedHome: string,
  expectedHomeIdentity: FileIdentity,
): JournalHeader {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "nonce",
      "ownerPid",
      "home",
      "homeIdentity",
      "source",
      "plans",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "mono-agent.composer-skill-install"
    || typeof value.nonce !== "string"
    || !UUID_PATTERN.test(value.nonce)
    || !Number.isSafeInteger(value.ownerPid)
    || (value.ownerPid as number) < 1
    || value.home !== expectedHome
  ) {
    throw new Error("Install journal has an invalid header.");
  }
  const homeIdentity = parseIdentity(value.homeIdentity, "journal home identity");
  if (!sameFileIdentity(homeIdentity, expectedHomeIdentity)) {
    throw new Error("Install journal home authority does not match.");
  }
  const source = parseSourceDescriptors(value.source, "Install journal source");
  if (!Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 2) {
    throw new Error("Install journal has an invalid target plan count.");
  }
  const seen = new Set<string>();
  const plans = value.plans.map((entry): JournalPlan => {
    if (!isRecord(entry)) throw new Error("Install journal contains an invalid target plan.");
    const baseKeys = [
      "target",
      "productRoot",
      "productIdentity",
      "parent",
      "parentIdentity",
      "destination",
      "stage",
    ] as const;
    const hasPrior = entry.priorIdentity !== undefined || entry.backup !== undefined;
    if (!hasExactKeys(
      entry,
      hasPrior ? [...baseKeys, "backup", "priorIdentity"] : baseKeys,
    )) {
      throw new Error("Install journal contains an invalid target plan shape.");
    }
    const target = journalTarget(entry.target);
    if (seen.has(target)) throw new Error("Install journal repeats a target plan.");
    seen.add(target);
    const productRoot = join(expectedHome, target === "claude" ? ".claude" : ".codex");
    const parent = join(productRoot, "skills");
    const destination = join(parent, SKILL_NAME);
    const stage = join(parent, `.${SKILL_NAME}.stage-${value.nonce}-${target}`);
    if (
      entry.productRoot !== productRoot
      || entry.parent !== parent
      || entry.destination !== destination
      || entry.stage !== stage
    ) {
      throw new Error("Install journal target paths escape their authority.");
    }
    const priorIdentity = entry.priorIdentity === undefined
      ? undefined
      : parseIdentity(entry.priorIdentity, "journal prior identity");
    const backup = priorIdentity === undefined
      ? undefined
      : join(parent, `.${SKILL_NAME}.backup-${value.nonce}-${target}`);
    if (entry.backup !== backup) {
      throw new Error("Install journal backup path does not match its authority.");
    }
    return Object.freeze({
      target,
      productRoot,
      productIdentity: parseIdentity(entry.productIdentity, "journal product identity"),
      parent,
      parentIdentity: parseIdentity(entry.parentIdentity, "journal parent identity"),
      destination,
      stage,
      ...(backup === undefined ? {} : { backup }),
      ...(priorIdentity === undefined ? {} : { priorIdentity }),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.composer-skill-install",
    nonce: value.nonce,
    ownerPid: value.ownerPid as number,
    home: expectedHome,
    homeIdentity,
    source,
    plans: Object.freeze(plans),
  });
}

async function assertJournalAuthority(
  header: JournalHeader,
  plan: JournalPlan,
): Promise<void> {
  await assertDirectoryIdentity(
    header.home,
    header.homeIdentity,
    "home directory",
    "authority",
  );
  await assertDirectoryIdentity(
    plan.productRoot,
    plan.productIdentity,
    `${plan.target} directory`,
    "authority",
  );
  await assertDirectoryIdentity(
    plan.parent,
    plan.parentIdentity,
    `${plan.target} skills directory`,
    "authority",
  );
}

async function archiveJournal(
  state: JournalState,
  home: string,
  disposition: string,
): Promise<string> {
  return archiveExactFile(
    state.path,
    state.identity,
    home,
    `.${SKILL_NAME}.journal-${disposition}-${state.header.nonce}`,
    "install journal",
  );
}

async function archiveExactFile(
  path: string,
  identity: FileIdentity,
  parent: string,
  archiveName: string,
  label: string,
): Promise<string> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} is no longer a regular file.`);
  }
  if (!sameFileIdentity(identityOf(details), identity)) {
    throw new Error(`${label} changed identity.`);
  }
  const archive = join(parent, archiveName);
  if (await lstatOrUndefined(archive) !== undefined) {
    throw new Error(`${label} archive already exists at ${archive}.`);
  }
  await rename(path, archive);
  const archived = await lstat(archive);
  if (!archived.isFile() || !sameFileIdentity(identityOf(archived), identity)) {
    throw new Error(`${label} archive changed identity.`);
  }
  await syncDirectory(parent);
  return archive;
}

async function readOwnerFile(
  path: string,
  label: string,
): Promise<{ readonly identity: FileIdentity; readonly bytes: Uint8Array; readonly value: unknown }> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  assertOwnerPrivate(details, label, true);
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const bytes = await readBounded(handle, JOURNAL_MAX_BYTES);
    const after = await handle.stat();
    if (!sameIdentity(details, after) || after.size !== bytes.byteLength) {
      throw new Error(`${label} changed while it was read.`);
    }
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")[0]!;
    return Object.freeze({
      identity: identityOf(details),
      bytes,
      value: line.length === 0 ? undefined : JSON.parse(line) as unknown,
    });
  } finally {
    await handle.close();
  }
}

function ownerPidFromRecord(value: unknown, label: string): number {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "nonce",
      "ownerPid",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "mono-agent.composer-skill-lock"
    || typeof value.nonce !== "string"
    || !UUID_PATTERN.test(value.nonce)
    || !Number.isSafeInteger(value.ownerPid)
    || (value.ownerPid as number) < 1
  ) {
    throw new Error(`${label} has an invalid owner record.`);
  }
  return value.ownerPid as number;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function assertEmptyDirectory(
  path: string,
  identity: FileIdentity,
  label: string,
): Promise<void> {
  await assertDirectoryIdentity(path, identity, label, "private");
  const directory = await opendir(path);
  try {
    if (await directory.read() !== null) throw new Error(`${label} is not empty.`);
  } finally {
    await directory.close();
  }
  await assertDirectoryIdentity(path, identity, label, "private");
}

async function assertDirectoryIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
  privacy?: DirectoryPrivacy,
): Promise<void> {
  const details = await lstat(path);
  assertRealDirectory(details, label);
  if (privacy !== undefined) {
    assertOwnerPrivate(details, label, privacy === "private");
  }
  if (!sameFileIdentity(identityOf(details), expected)) {
    throw new Error(`${label} changed identity.`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | OPEN_DIRECTORY | NO_FOLLOW);
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

async function writeFully(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) throw new Error("Secure file write made no progress.");
    offset += result.bytesWritten;
  }
}

async function readBounded(handle: FileHandle, maximumBytes: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error("Secure file exceeds its byte bound.");
  return new Uint8Array(buffer.subarray(0, offset));
}

async function readExact(handle: FileHandle, sizeBytes: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const { bytesRead } = await handle.read(buffer, offset, sizeBytes - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== sizeBytes) throw new Error("Skill file is shorter than its manifest.");
  const sentinel = Buffer.alloc(1);
  if ((await handle.read(sentinel, 0, 1, sizeBytes)).bytesRead !== 0) {
    throw new Error("Skill file is longer than its manifest.");
  }
  return new Uint8Array(buffer);
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

function allowedSourceDirectories(
  source: readonly SourceDescriptor[],
): ReadonlySet<string> {
  const directories = new Set<string>([""]);
  for (const file of source) {
    let parent = posix.dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  return directories;
}

function safeRelativePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || Buffer.byteLength(value, "utf8") > SOURCE_MAX_PATH_BYTES
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
  ) {
    throw new Error("Skill source manifest contains an unsafe path.");
  }
  const segments = value.split("/");
  if (
    segments.length > SOURCE_MAX_DEPTH
    || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." || segment.includes("\0"))
  ) {
    throw new Error("Skill source manifest contains an unsafe path.");
  }
  return value;
}

function parseIdentity(value: unknown, label: string): FileIdentity {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["device", "inode"])
    || !Number.isSafeInteger(value.device)
    || (value.device as number) < 0
    || !Number.isSafeInteger(value.inode)
    || (value.inode as number) < 1
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze({
    device: value.device as number,
    inode: value.inode as number,
  });
}

function journalTarget(value: unknown): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  throw new Error("Install journal target is invalid.");
}

function hookContext(plan: InstallPlan): InstallHookContext {
  return Object.freeze({
    target: plan.authority.target,
    destination: plan.destination,
    stage: plan.stage,
    ...(plan.backup === undefined ? {} : { backup: plan.backup }),
  });
}

function recoveryPathError(plan: InstallPlan | JournalPlan, message: string): Error {
  return new Error(
    `${message}; destination=${plan.destination}; stage=${plan.stage}; backup=${plan.backup ?? "none"}.`,
  );
}

function journalRecoveryError(
  state: JournalState,
  plan: JournalPlan,
  message: string,
): Error {
  return new Error(
    `${message}; journal=${state.path}; destination=${plan.destination}; stage=${plan.stage}; backup=${plan.backup ?? "none"}.`,
  );
}

function assertRealDirectory(details: Stats, label: string): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function assertOwnerPrivate(details: Stats, label: string, fullyPrivate: boolean): void {
  if (typeof process.getuid !== "function") {
    throw new Error(
      `${label} cannot be verified because current-UID proof is unavailable.`,
    );
  }
  if (details.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  const forbidden = fullyPrivate ? 0o077 : 0o022;
  if ((details.mode & forbidden) !== 0) {
    throw new Error(
      fullyPrivate
        ? `${label} must not grant group or other permissions.`
        : `${label} must not grant group or other write permissions.`,
    );
  }
}

function identityOf(details: Stats): FileIdentity {
  return Object.freeze({ device: details.dev, inode: details.ino });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  if (await lstatOrUndefined(path) !== undefined) {
    throw new Error(`${label} already exists at ${path}.`);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON.`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
