import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { GeneratedFile } from "./modules/types.js";
import { readVerifiedFile, secureFileReplace } from "./secure-file-replace.js";

export const PROJECT_SKILL_VERSION = "1.2.0";
export const PROJECT_SKILL_MANIFEST_PATH = "skills/.mono-agent-managed.json";

export const PROJECT_SKILL_NAMES = [
  "mono-agent-configure",
  "mono-agent-memory",
] as const;

export type ProjectSkillName = (typeof PROJECT_SKILL_NAMES)[number];

interface BundledProjectSkill {
  readonly name: ProjectSkillName;
  readonly contents: string;
}

const CONFIGURE_SKILL = `---
name: mono-agent-configure
description: Safely refine this agent's identity and config from the local mono-agent TUI.
version: ${PROJECT_SKILL_VERSION}
---

# Configure this agent

Use this skill when the operator asks to configure, tune, or change this agent.

1. Treat the current resolved config, the configured identity document's \`## Role\` (normally \`IDENTITY.md → ## Role\`), and validation output as operational truth. Memory may recall preferences, but never use memory as proof that a change is active.
2. This is a dedicated, multi-turn SELF-CONFIG session, separate from ordinary chat. On the opening turn only, show a compact user-led map of all capability areas: identity and knowledge; runtime and models; skills, tools, MCP servers, and plugins; memory; channels, APIs, and A2A; automation and proactive work; security, sandboxing, and secrets; observability and operations; and acceptance criteria. Then let the operator choose where to start. Do not repeat the map on later turns.
3. Build the operator's workflow conversationally, one focused question at a time: trigger → context/data → tools/actions → delivery → memory → safety/operations → success checks. Do not turn the map into a long questionnaire. A turn may explore, explain, or ask the next question without making a proposal.
4. Approval, rejection, a no-proposal turn, \`done\`, and \`no changes\` do not end SELF-CONFIG. Continue from the host outcome and suggest the next relevant area. Only quitting the TUI session exits self-configuration. If the reply is an ordinary task, do not execute it with configuration authority; help translate it into the desired agent workflow, or tell the operator to quit SELF-CONFIG before running the task.
5. Never ask for API keys, OAuth tokens, passwords, bot tokens, or other secrets in chat. Explain the exact masked mono-agent auth or owner-only .env flow instead.
6. For one decision-complete, safe local checkpoint, call ProposeAgentConfiguration once with a short rationale, an RFC 6902 JSON Patch against mono-agent.config.json, and optionally a replacement body for the configured identity document's \`## Role\` (normally \`IDENTITY.md → ## Role\`). A Role-only proposal uses an empty patch. Keep each proposal coherent and incremental; continue the conversation after the host reports its outcome.
7. Do not claim the proposal was applied. The local host validates it, shows an out-of-band review, requires the operator to approve it, commits files atomically, restarts the authoritative background agent, and proves readiness. A failed restart restores the approved files and attempts to restore the previous daemon before reporting recovery instructions.
8. Keep config proposals to the host's documented low-risk allowlist: public name; effort, turn/session UX; selected project skills and disclosure; memory size or MemoryRecall enablement; and tool-policy tightening. Paths, memory tier/capture behavior, external MCP servers, plugins, channels or cron/proactive jobs, tool/runtime permissions, model-route or provider posture, embeddings/LLM endpoints, exporters, sandboxing, and network exposure require the explicit guided flow named by the host. Explain those capabilities and their prerequisites, but do not smuggle them into a proposal.

Keep proposals minimal. Preserve unrelated config, existing knowledge references, and every identity section except the optional Role body. Treat every non-command operator message in this session as self-configuration input. The host, not the model, owns session exit and proposal settlement.
`;

const MEMORY_SKILL = `---
name: mono-agent-memory
description: Choose, inspect, and tune mono-agent's built-in memory without guessing about stored state.
version: ${PROJECT_SKILL_VERSION}
---

# Configure memory

Use this skill when the operator asks how this agent should remember information.

- No memory: conversations do not create durable cross-session memory.
- Lite: deterministic lexical recall with the smallest dependency and operating surface.
- Journal: deterministic semantic recall and background indexing, without capture-model calls.
- BuJo: curated capture plus entity relationships; use it only when the extra model work and graph behavior are valuable.

MemoryRecall is a read-only tool and is enabled by default whenever a memory tier is configured. Use it to recover prior preferences, but inspect the current config and memory audit before describing what is active.

Never paste remembered private content into a config proposal. Never request embedding or provider secrets in chat. Hand credential setup to the masked guided flow.

Use ProposeAgentConfiguration only to adjust memory.maxBytes or memory.recallTool.enabled. Memory tier, path, write/capture behavior, consolidation, embeddings, LLM, provider, endpoint, and credential changes belong in the explicit guided flow. Explain prerequisite services and expected indexing/capture cost before handing Journal or BuJo setup to that flow. The host, not this skill, decides whether a candidate validates and can be applied.
`;

export const BUNDLED_PROJECT_SKILLS: readonly BundledProjectSkill[] = [
  { name: "mono-agent-configure", contents: CONFIGURE_SKILL },
  { name: "mono-agent-memory", contents: MEMORY_SKILL },
];

interface ManagedSkillManifest {
  readonly schema: "mono-agent.managed-project-skills.v1";
  readonly version: string;
  readonly skills: Readonly<Record<ProjectSkillName, { readonly sha256: string }>>;
}

export type ProjectSkillStatusKind = "ready" | "missing" | "stale" | "modified" | "collision";

export interface ProjectSkillStatus {
  readonly name: ProjectSkillName;
  readonly path: string;
  readonly status: ProjectSkillStatusKind;
  readonly installedSha256?: string;
  readonly expectedSha256: string;
}

export interface CheckProjectSkillsResult {
  readonly manifestPath: string;
  readonly manifestVersion?: string;
  readonly statuses: readonly ProjectSkillStatus[];
  readonly ok: boolean;
}

export interface UpdateProjectSkillsResult extends CheckProjectSkillsResult {
  readonly updated: readonly string[];
  readonly backupDir?: string;
}

export interface UpdateManagedProjectSkillsOptions {
  /** Fault-injection seam invoked before the built-in compare-and-swap writer. */
  readonly beforeActivate?: (path: string, contents: string) => Promise<void>;
  /** Fault-injection seam after target validation but before the old pathname is claimed. */
  readonly beforeTargetClaim?: (path: string) => Promise<void>;
  /** Fault-injection seam after staged-inode proof but before exclusive publication. */
  readonly beforePublish?: (path: string, temporaryPath: string) => Promise<void>;
}

interface ManagedFileSnapshot {
  readonly path: string;
  readonly contents?: string;
  readonly mode?: number;
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function desiredManifest(): ManagedSkillManifest {
  return {
    schema: "mono-agent.managed-project-skills.v1",
    version: PROJECT_SKILL_VERSION,
    skills: Object.fromEntries(BUNDLED_PROJECT_SKILLS.map((skill) => [
      skill.name,
      { sha256: sha256(skill.contents) },
    ])) as ManagedSkillManifest["skills"],
  };
}

export function managedProjectSkillFiles(): readonly GeneratedFile[] {
  const manifest = desiredManifest();
  return [
    ...BUNDLED_PROJECT_SKILLS.map((skill) => ({
      path: `skills/${skill.name}/SKILL.md`,
      contents: skill.contents,
    })),
    {
      path: PROJECT_SKILL_MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
}

export async function checkManagedProjectSkills(cwd: string): Promise<CheckProjectSkillsResult> {
  const root = await canonicalManagedRoot(cwd);
  const manifestPath = join(root, PROJECT_SKILL_MANIFEST_PATH);
  await inspectManagedFileInside(root, manifestPath, "Managed project-skill manifest");
  const manifest = await readManifest(manifestPath);
  const desired = desiredManifest();
  const statuses: ProjectSkillStatus[] = [];

  for (const skill of BUNDLED_PROJECT_SKILLS) {
    const path = join(root, "skills", skill.name, "SKILL.md");
    await inspectManagedFileInside(root, path, `Managed project skill ${skill.name}`);
    const expectedSha256 = desired.skills[skill.name].sha256;
    const installed = await readOptional(path);
    if (installed === undefined) {
      statuses.push({ name: skill.name, path, status: "missing", expectedSha256 });
      continue;
    }
    const installedSha256 = sha256(installed);
    const recorded = manifest?.skills[skill.name]?.sha256;
    if (recorded === undefined) {
      statuses.push({ name: skill.name, path, status: "collision", installedSha256, expectedSha256 });
    } else if (installedSha256 !== recorded) {
      statuses.push({ name: skill.name, path, status: "modified", installedSha256, expectedSha256 });
    } else if (installedSha256 !== expectedSha256 || manifest?.version !== PROJECT_SKILL_VERSION) {
      statuses.push({ name: skill.name, path, status: "stale", installedSha256, expectedSha256 });
    } else {
      statuses.push({ name: skill.name, path, status: "ready", installedSha256, expectedSha256 });
    }
  }

  return {
    manifestPath,
    ...(manifest?.version === undefined ? {} : { manifestVersion: manifest.version }),
    statuses,
    ok: statuses.every((status) => status.status === "ready"),
  };
}

/** Fail before init writes anything when an existing skill would be claimed or overwritten. */
export async function assertManagedProjectSkillInitSafe(cwd: string): Promise<void> {
  const check = await checkManagedProjectSkills(cwd);
  const conflicts = check.statuses.filter((entry) => entry.status === "collision" || entry.status === "modified");
  if (conflicts.length === 0) return;
  throw new Error(
    `Project skill collision: ${conflicts.map((entry) => entry.path).join(", ")} contains operator-managed content. ` +
    "Move or rename the colliding skill, or keep it and select a different skill name; mono-agent will not overwrite it.",
  );
}

export async function updateManagedProjectSkills(
  cwd: string,
  options: UpdateManagedProjectSkillsOptions = {},
): Promise<UpdateProjectSkillsResult> {
  const root = await canonicalManagedRoot(cwd);
  return await withManagedProjectSkillLock(root, async () =>
    await updateManagedProjectSkillsUnlocked(root, options));
}

async function updateManagedProjectSkillsUnlocked(
  root: string,
  options: UpdateManagedProjectSkillsOptions,
): Promise<UpdateProjectSkillsResult> {
  const before = await checkManagedProjectSkills(root);
  const unsafe = before.statuses.filter((entry) => entry.status === "modified" || entry.status === "collision");
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to update operator-modified project skills: ${unsafe.map((entry) => `${entry.name} (${entry.path})`).join(", ")}. ` +
      "Copy your edits elsewhere or restore the recorded managed version, then retry.",
    );
  }

  const needsUpdate = before.statuses.filter((entry) => entry.status !== "ready");
  if (needsUpdate.length === 0) {
    return { ...before, updated: [] };
  }

  const changeId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = join(root, "skills", ".mono-agent-backups", changeId);
  await ensureOwnedManagedDirectoryInside(root, backupDir, "Managed project-skill backup directory");

  const skillTargets = BUNDLED_PROJECT_SKILLS.flatMap((skill) => {
    const status = needsUpdate.find((entry) => entry.name === skill.name);
    return status === undefined ? [] : [{ path: status.path, contents: skill.contents, name: skill.name }];
  });
  const manifestPath = join(root, PROJECT_SKILL_MANIFEST_PATH);
  const manifestContents = `${JSON.stringify(desiredManifest(), null, 2)}\n`;
  const snapshots = new Map<string, ManagedFileSnapshot>();
  for (const target of [...skillTargets, { path: manifestPath, contents: manifestContents, name: "manifest" }]) {
    snapshots.set(target.path, await snapshotManagedFile(root, target.path));
  }
  const afterSnapshots = await checkManagedProjectSkills(root);
  if (!isDeepStrictEqual(afterSnapshots, before)) {
    throw new Error("Managed project skills changed while the update was being prepared. No files were written; retry from the current copies.");
  }

  for (const status of needsUpdate) {
    const snapshot = snapshots.get(status.path)!;
    if (snapshot.contents !== undefined) {
      const backup = join(backupDir, status.name, "SKILL.md");
      await ensureOwnedManagedDirectoryInside(root, dirname(backup), "Managed project-skill backup directory");
      writeNewManagedFileSync(root, backup, snapshot.contents, snapshot.mode ?? 0o600);
    }
  }
  const manifestSnapshot = snapshots.get(manifestPath)!;
  if (manifestSnapshot.contents !== undefined) {
    writeNewManagedFileSync(
      root,
      join(backupDir, ".mono-agent-managed.json"),
      manifestSnapshot.contents,
      manifestSnapshot.mode ?? 0o600,
    );
  }

  const updated: string[] = [];
  const activated: Array<{ readonly path: string; readonly contents: string }> = [];
  try {
    for (const target of skillTargets) {
      await ensureOwnedManagedDirectoryInside(root, dirname(target.path), "Managed project-skill directory");
      await options.beforeActivate?.(target.path, target.contents);
      const snapshot = snapshots.get(target.path)!;
      await atomicWriteManagedExact(
        root,
        target.path,
        snapshot.contents,
        target.contents,
        snapshot.mode ?? 0o600,
        options,
      );
      activated.push({ path: target.path, contents: target.contents });
      updated.push(target.path);
    }
    await options.beforeActivate?.(manifestPath, manifestContents);
    await atomicWriteManagedExact(
      root,
      manifestPath,
      manifestSnapshot.contents,
      manifestContents,
      manifestSnapshot.mode ?? 0o600,
      options,
    );
    activated.push({ path: manifestPath, contents: manifestContents });

    const after = await checkManagedProjectSkills(root);
    if (!after.ok) {
      throw new Error("Managed project skill update did not verify.");
    }
    return { ...after, updated, backupDir };
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const activatedFile of [...activated].reverse()) {
      const snapshot = snapshots.get(activatedFile.path)!;
      try {
        await restoreManagedFile(root, snapshot, activatedFile.contents);
      } catch (rollbackError) {
        rollbackFailures.push(`${activatedFile.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Managed skill rollback was incomplete: ` +
        `${rollbackFailures.join("; ")}. Recover from ${backupDir}.`,
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Previous managed skill files were restored; ` +
      `the update remains retryable. Backups: ${backupDir}.`,
    );
  }
}

async function readManifest(path: string): Promise<ManagedSkillManifest | undefined> {
  const contents = await readOptional(path);
  if (contents === undefined) return undefined;
  try {
    const parsed = JSON.parse(contents) as Partial<ManagedSkillManifest>;
    if (parsed.schema !== "mono-agent.managed-project-skills.v1" || typeof parsed.version !== "string") {
      return undefined;
    }
    if (typeof parsed.skills !== "object" || parsed.skills === null) return undefined;
    return parsed as ManagedSkillManifest;
  } catch {
    return undefined;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  const snapshot = await readManagedSnapshot(path, "read");
  return snapshot?.contents.toString("utf8");
}

function readManagedSnapshot(path: string, operation: string): ReturnType<typeof readVerifiedFile> {
  return readVerifiedFile(path, {
    validate: (details) => assertManagedFileInfo(details, path),
    changedError: () => new Error(`Managed project skill changed while it was being ${operation}: ${path}`),
  });
}

async function canonicalManagedRoot(cwd: string): Promise<string> {
  const root = await realpath(resolve(cwd));
  assertManagedDirectoryInfo(await lstat(root), root, "Agent folder");
  return root;
}

async function inspectManagedFileInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await canonicalManagedRoot(root);
  const absolute = resolve(path);
  assertManagedPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`${label} must name a file inside the agent folder.`);
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    let info: Stats;
    try {
      info = await lstat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
      throw error;
    }
    assertManagedDirectoryInfo(info, parent, `${label} parent`);
  }
  try {
    assertManagedFileInfo(await lstat(absolute), absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}

async function ensureOwnedManagedDirectoryInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await canonicalManagedRoot(root);
  const absolute = resolve(path);
  assertManagedPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertManagedDirectoryInfo(await lstat(current), current, label);
  }
  return absolute;
}

function inspectManagedFileInsideSync(
  root: string,
  path: string,
  label: string,
  allowMissingTarget: boolean,
): string {
  const canonicalRoot = realpathSync(resolve(root));
  const absolute = resolve(path);
  assertManagedPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`${label} must name a file inside the agent folder.`);
  assertManagedDirectoryInfo(lstatSync(canonicalRoot), canonicalRoot, "Agent folder");
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    assertManagedDirectoryInfo(lstatSync(parent), parent, `${label} parent`);
  }
  try {
    assertManagedFileInfo(lstatSync(absolute), absolute);
  } catch (error) {
    if (!allowMissingTarget || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}

function writeNewManagedFileSync(root: string, path: string, contents: string, mode: number): void {
  const securePath = inspectManagedFileInsideSync(root, path, "Managed project-skill backup", true);
  let handle: number | undefined;
  try {
    handle = openSync(
      securePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    writeFileSync(handle, contents, "utf8");
    fchmodSync(handle, mode);
    fsyncSync(handle);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function assertManagedDirectoryInfo(info: Stats, path: string, label: string): void {
  if (!info.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${label} must be owned by the current user: ${path}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/world writable: ${path}`);
  }
}

function assertManagedPathInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside the agent folder: ${path}`);
  }
}

async function snapshotManagedFile(root: string, path: string): Promise<ManagedFileSnapshot> {
  await inspectManagedFileInside(root, path, "Managed project skill");
  const snapshot = await readManagedSnapshot(path, "snapshotted");
  return snapshot === undefined
    ? { path }
    : { path, contents: snapshot.contents.toString("utf8"), mode: Number(snapshot.details.mode & 0o777n) };
}

async function restoreManagedFile(
  root: string,
  snapshot: ManagedFileSnapshot,
  expectedCurrent: string,
): Promise<void> {
  if (snapshot.contents === undefined) {
    removeManagedFileExactSync(root, snapshot.path, expectedCurrent);
    return;
  }
  await atomicWriteManagedExact(
    root,
    snapshot.path,
    expectedCurrent,
    snapshot.contents,
    snapshot.mode ?? 0o600,
  );
}

async function atomicWriteManagedExact(
  root: string,
  path: string,
  expected: string | undefined,
  contents: string,
  mode = 0o600,
  hooks: Pick<UpdateManagedProjectSkillsOptions, "beforeTargetClaim" | "beforePublish"> = {},
): Promise<void> {
  const secureParent = await ensureOwnedManagedDirectoryInside(root, dirname(path), "Managed project-skill directory");
  const securePath = join(secureParent, basename(path));
  const temporary = join(secureParent, `.${randomUUID()}.mono-agent-tmp`);
  const initialInfo = await managedFileInfo(root, securePath, expected);
  const secureTemporary = inspectManagedFileInsideSync(root, temporary, "Managed project-skill temporary file", true);
  await secureFileReplace({
    path: securePath,
    temporaryPath: secureTemporary,
    contents,
    mode,
    validateTemporary: (details) => assertManagedFileInfo(details, secureTemporary),
    target: {
      expected: expected === undefined
        ? { kind: "missing" }
        : {
            kind: "present",
            validate: (candidate, moved) => managedReplacementMatches(candidate, expected, initialInfo, moved),
            invalidError: () => new Error(
              `Refusing to overwrite a concurrently edited managed project skill: ${securePath}`,
            ),
          },
      recovery: "restore-previous",
      ...(expected === undefined ? {} : { beforeClaim: () => hooks.beforeTargetClaim?.(securePath) }),
      beforePublish: (_targetPath, temporaryPath) => hooks.beforePublish?.(securePath, temporaryPath),
      makeError: ({ cause, recoveryPaths }) => managedPublicationError(securePath, cause, recoveryPaths),
    },
  });
}

async function managedFileInfo(
  root: string,
  path: string,
  expected: string | undefined,
): Promise<BigIntStats | undefined> {
  await inspectManagedFileInside(root, path, "Managed project skill");
  const snapshot = await readManagedSnapshot(path, "prepared for replacement");
  if (snapshot === undefined) {
    if (expected === undefined) return undefined;
    throw new Error(`Refusing to overwrite a concurrently edited managed project skill: ${path}`);
  }
  if (expected === undefined) {
    throw new Error(`Refusing to overwrite a concurrently created managed project skill: ${path}`);
  }
  if (snapshot.contents.toString("utf8") !== expected) {
    throw new Error(`Refusing to overwrite a concurrently edited managed project skill: ${path}`);
  }
  return snapshot.details;
}

// Keep this validator synchronous so the shared publisher's final proof and
// unlink stay adjacent; pathname races are retained at named recovery paths.
function managedReplacementMatches(
  path: string,
  expected: string,
  initialInfo: BigIntStats | undefined,
  moved = false,
): boolean {
  let sourceHandle: number | undefined;
  try {
    sourceHandle = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const openedBefore = fstatSync(sourceHandle, { bigint: true });
    assertManagedFileInfo(openedBefore, path);
    const current = readFileSync(sourceHandle, "utf8");
    const openedAfter = fstatSync(sourceHandle, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    return current === expected
      && initialInfo !== undefined
      && (moved
        ? sameMovedManagedBigIntMetadata(initialInfo, openedBefore)
        : sameManagedBigIntMetadata(initialInfo, openedBefore))
      && sameManagedBigIntMetadata(openedBefore, openedAfter)
      && sameManagedBigIntMetadata(openedAfter, named);
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
  }
}

function managedPublicationError(path: string, cause: unknown, recoveryPaths: readonly string[]): Error {
  const reason = (cause as NodeJS.ErrnoException).code === "EEXIST"
    ? `Refusing to overwrite a concurrently created managed project skill: ${path}.`
    : `Managed project-skill publication failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  const recovery = recoveryPaths.length === 0
    ? ""
    : ` Preserved recovery artifact${recoveryPaths.length === 1 ? "" : "s"}: ${recoveryPaths.join(", ")}.`;
  return new Error(`${reason}${recovery}`, { cause });
}

function removeManagedFileExactSync(
  root: string,
  path: string,
  expectedContents: string,
  expectedInfo?: BigIntStats,
  label = "Managed project skill",
): void {
  const securePath = inspectManagedFileInsideSync(root, path, label, false);
  let sourceHandle: number | undefined;
  try {
    sourceHandle = openSync(
      securePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const openedBefore = fstatSync(sourceHandle, { bigint: true });
    assertManagedFileInfo(openedBefore, securePath);
    const current = readFileSync(sourceHandle, "utf8");
    const openedAfter = fstatSync(sourceHandle, { bigint: true });
    const named = lstatSync(securePath, { bigint: true });
    if (
      current !== expectedContents
      || (expectedInfo !== undefined && !sameManagedBigIntMetadata(expectedInfo, openedBefore))
      || !sameManagedBigIntMetadata(openedBefore, openedAfter)
      || !sameManagedBigIntMetadata(openedAfter, named)
    ) {
      throw new Error(`${label} changed unexpectedly and was left untouched: ${path}`);
    }
    unlinkSync(securePath);
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
  }
}

function assertManagedFileInfo(info: Stats | BigIntStats, path: string): void {
  if (!info.isFile() || Number(info.nlink) !== 1) {
    throw new Error(`Managed project skill must be one regular file with one link: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && Number(info.uid) !== uid) {
    throw new Error(`Managed project skill must be owned by the current user: ${path}`);
  }
  if ((Number(info.mode) & 0o022) !== 0) {
    throw new Error(`Managed project skill must not be group/world writable: ${path}`);
  }
}

function sameManagedBigIntMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameMovedManagedBigIntMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function withManagedProjectSkillLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const skillsDir = await ensureOwnedManagedDirectoryInside(root, join(root, "skills"), "Managed project-skills directory");
  const lockPath = join(skillsDir, ".mono-agent-managed.lock");
  const contents = `${JSON.stringify({
    schema: "mono-agent.managed-project-skills-lock.v1",
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  })}\n`;
  let handle: number | undefined;
  let identity: BigIntStats | undefined;
  try {
    try {
      const secureLockPath = inspectManagedFileInsideSync(root, lockPath, "Managed project-skill lock", true);
      handle = openSync(
        secureLockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Another managed project-skill update owns ${lockPath}. Wait for it to finish.`);
      }
      throw error;
    }
    writeFileSync(handle, contents, "utf8");
    fchmodSync(handle, 0o600);
    fsyncSync(handle);
    const info = fstatSync(handle, { bigint: true });
    assertManagedFileInfo(info, lockPath);
    identity = info;
    closeSync(handle);
    handle = undefined;
    return await operation();
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (identity !== undefined) {
      removeManagedFileExactSync(root, lockPath, contents, identity, "Managed project-skill lock");
    }
  }
}

export async function managedProjectSkillsExist(cwd: string): Promise<boolean> {
  try {
    const root = await canonicalManagedRoot(cwd);
    const path = await inspectManagedFileInside(root, join(root, PROJECT_SKILL_MANIFEST_PATH), "Managed project-skill manifest");
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
