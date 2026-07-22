import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  type FileHandle,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { probeMemoryEmbeddingSelection } from "./memory-embedding-service.js";
import type { WizardPlan } from "./wizard/answers.js";

const DEFAULT_MANAGED_MEMORY_DIMENSION = 768;
const FIRST_RUN_EMBEDDING_PROBE_TIMEOUT_MS = 5_000;
const FIRST_RUN_OPENAI_PROBE_TEXT = "mono-agent managed-memory first-run embedding readiness probe";
export const FIRST_RUN_MEMORY_INITIALIZING_MARKER = ".first-run-memory-initializing";
export const FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX = `${FIRST_RUN_MEMORY_INITIALIZING_MARKER}.released-`;
const FIRST_RUN_MANAGED_MEMORY_OVERRIDE_KEYS = [
  "MONO_AGENT_MEMORY_BACKEND",
  "MONO_AGENT_MEMORY_MODE",
  "MONO_AGENT_MEMORY_PATH",
  "MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER",
  "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
  "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
] as const;

export interface FirstRunManagedMemoryHooks {
  /** Test seam for an external creator winning the absent-root race. */
  readonly beforeRootClaim?: (root: string) => void | Promise<void>;
  /** Test seam after this helper has exclusively claimed the final root. */
  readonly afterRootClaim?: (root: string) => void | Promise<void>;
  /** Test seam immediately before the identity-fenced rebuild. */
  readonly beforeRebuild?: (stagingRoot: string) => void | Promise<void>;
  /** Test seam after the complete generation exists but before atomic publication. */
  readonly beforePromotion?: (stagingRoot: string, finalRoot: string) => void | Promise<void>;
  /** Test seam after manifest authority exists but before source-link cleanup/directory fsync. */
  readonly afterManifestLinked?: (finalRoot: string) => void | Promise<void>;
  /** Test seam immediately before the exact initialization marker release boundary. */
  readonly beforeMarkerRelease?: (markerPath: string) => void | Promise<void>;
  /** Test seam after the marker name is quarantined but before its identity is revalidated. */
  readonly afterMarkerQuarantined?: (releasedPath: string, markerPath: string) => void | Promise<void>;
}

export interface InitializeFirstRunManagedMemoryOptions {
  readonly agentRoot: string;
  /** A plan returned by the init wizard composer, not an arbitrary loaded config. */
  readonly plan: WizardPlan;
  /** Effective init environment; identity-changing memory overrides fail closed. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly hooks?: FirstRunManagedMemoryHooks;
}

export interface InitializeFirstRunManagedMemoryResult {
  readonly initialized: boolean;
  readonly root?: string;
}

interface ClaimedDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DurableMarker {
  readonly handle: FileHandle;
  readonly identity: ClaimedDirectoryIdentity;
}

interface PinnedDirectoryIdentity extends ClaimedDirectoryIdentity {
  readonly path: string;
}

interface TreeEntryIdentity extends ClaimedDirectoryIdentity {
  readonly kind: "directory" | "file";
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

interface TreeEntrySnapshot extends TreeEntryIdentity {
  readonly pathRelative: string;
}

function escapesRoot(pathRelative: string): boolean {
  return pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative);
}

function pathSegments(pathRelative: string): readonly string[] {
  return pathRelative.length === 0 ? [] : pathRelative.split(sep).filter((part) => part.length > 0);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function canonicalAgentRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  const pathStat = await lstat(absolute);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error(`Refusing first-run managed memory because the agent root is not a real directory: ${absolute}`);
  }
  return await realpath(absolute);
}

async function pinRealDirectoryChain(root: string, target: string): Promise<readonly PinnedDirectoryIdentity[]> {
  const pathRelative = relative(root, target);
  if (escapesRoot(pathRelative)) {
    throw new Error("Refusing first-run managed memory outside the agent folder.");
  }
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing first-run managed memory through a symbolic-link or non-directory parent: ${root}`);
  }
  const pinned: PinnedDirectoryIdentity[] = [{ path: root, dev: rootStat.dev, ino: rootStat.ino }];
  let current = root;
  for (const segment of pathSegments(pathRelative)) {
    current = resolve(current, segment);
    const pathStat = await lstat(current);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new Error(`Refusing first-run managed memory through a symbolic-link or non-directory parent: ${current}`);
    }
    pinned.push({ path: current, dev: pathStat.dev, ino: pathStat.ino });
  }
  const canonicalTarget = await realpath(target);
  if (escapesRoot(relative(root, canonicalTarget))) {
    throw new Error("Refusing first-run managed memory through a parent outside the agent folder.");
  }
  return pinned;
}

async function assertPinnedDirectoryChain(pinned: readonly PinnedDirectoryIdentity[]): Promise<void> {
  for (const expected of pinned) {
    const current = await lstat(expected.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, expected)) {
      throw new Error("Refusing first-run managed memory because a pinned parent directory changed identity.");
    }
  }
}

async function assertExistingParentChainSafe(root: string, target: string): Promise<void> {
  const pathRelative = relative(root, target);
  if (escapesRoot(pathRelative)) {
    throw new Error("Refusing first-run managed memory outside the agent folder.");
  }
  let current = root;
  for (const segment of pathSegments(pathRelative)) {
    current = resolve(current, segment);
    const pathStat = await optionalLstat(current);
    if (pathStat === undefined) return;
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new Error(`Refusing first-run managed memory through a symbolic-link or non-directory parent: ${current}`);
    }
  }
}

function sameIdentity(pathStat: Stats, expected: ClaimedDirectoryIdentity): boolean {
  return pathStat.dev === expected.dev && pathStat.ino === expected.ino;
}

async function assertClaimedRoot(root: string, expected: ClaimedDirectoryIdentity): Promise<void> {
  const current = await lstat(root);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, expected)) {
    throw new Error("Refusing first-run managed memory because the claimed root changed identity.");
  }
}

async function cleanupEmptyClaimedRoot(root: string, expected: ClaimedDirectoryIdentity): Promise<void> {
  const current = await optionalLstat(root);
  if (
    current === undefined || current.isSymbolicLink() || !current.isDirectory()
    || !sameIdentity(current, expected)
  ) {
    return;
  }
  // Never recursively remove a directory merely because this helper created
  // its inode: another same-user process may have added content after claim.
  // rmdir is the final atomic emptiness check and preserves every raced file.
  try {
    await rmdir(root);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

async function createDurableMarker(path: string): Promise<DurableMarker> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile("initializing\n", "utf8");
    await handle.sync();
    const pathStat = await handle.stat();
    return { handle, identity: { dev: pathStat.dev, ino: pathStat.ino } };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeOwnedMarker(
  root: string,
  rootIdentity: ClaimedDirectoryIdentity,
  markerPath: string,
  marker: DurableMarker,
  beforeRelease?: (markerPath: string) => void | Promise<void>,
  afterQuarantined?: (releasedPath: string, markerPath: string) => void | Promise<void>,
): Promise<boolean> {
  const exactMarkerIsPublished = async (): Promise<boolean> => {
    const rootStat = await optionalLstat(root);
    const openedMarkerStat = await marker.handle.stat();
    const markerStat = await optionalLstat(markerPath);
    return rootStat !== undefined && !rootStat.isSymbolicLink() && rootStat.isDirectory()
      && sameIdentity(rootStat, rootIdentity)
      && openedMarkerStat.isFile() && openedMarkerStat.nlink === 1
      && sameIdentity(openedMarkerStat, marker.identity)
      && markerStat !== undefined && !markerStat.isSymbolicLink() && markerStat.isFile()
      && sameIdentity(markerStat, marker.identity);
  };
  if (!await exactMarkerIsPublished()) return false;
  await beforeRelease?.(markerPath);
  if (!await exactMarkerIsPublished()) return false;

  // Path unlink is intrinsically check-then-act. First atomically move the
  // candidate to an unguessable private name, then delete only if the moved
  // inode is still the marker pinned by our open handle. A racer is retained
  // at the private name instead of being unlinked as collateral cleanup.
  const releasedPath = join(root, `${FIRST_RUN_MEMORY_RELEASED_MARKER_PREFIX}${randomUUID()}`);
  try {
    await rename(markerPath, releasedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await afterQuarantined?.(releasedPath, markerPath);
  const rootStat = await optionalLstat(root);
  const releasedStat = await optionalLstat(releasedPath);
  const openedMarkerStat = await marker.handle.stat();
  if (
    rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory()
    || !sameIdentity(rootStat, rootIdentity)
    || releasedStat === undefined || releasedStat.isSymbolicLink() || !releasedStat.isFile()
    || !sameIdentity(releasedStat, marker.identity)
    || !openedMarkerStat.isFile() || openedMarkerStat.nlink !== 1
    || !sameIdentity(openedMarkerStat, marker.identity)
    || await optionalLstat(markerPath) !== undefined
  ) return false;
  await unlink(releasedPath);
  const unlinkedMarkerStat = await marker.handle.stat();
  return unlinkedMarkerStat.nlink === 0
    && await optionalLstat(markerPath) === undefined
    && await optionalLstat(releasedPath) === undefined;
}

function treeIdentity(pathStat: Stats): TreeEntryIdentity {
  if (pathStat.isSymbolicLink()) throw new Error("Refusing first-run managed memory through a staged symlink.");
  if (!pathStat.isDirectory() && !pathStat.isFile()) {
    throw new Error("Refusing first-run managed memory with a non-regular staged entry.");
  }
  return {
    kind: pathStat.isDirectory() ? "directory" : "file",
    dev: pathStat.dev,
    ino: pathStat.ino,
    size: pathStat.size,
    mtimeMs: pathStat.mtimeMs,
    mode: pathStat.mode & 0o777,
  };
}

async function snapshotTree(root: string): Promise<readonly TreeEntrySnapshot[]> {
  const entries: TreeEntrySnapshot[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const pathRelative = relativeDirectory.length === 0 ? name : join(relativeDirectory, name);
      const identity = treeIdentity(await lstat(path));
      entries.push({ pathRelative, ...identity });
      if (identity.kind === "directory") await walk(path, pathRelative);
    }
  };
  await walk(root, "");
  return entries;
}

function treeSignature(entries: readonly TreeEntrySnapshot[]): string {
  return JSON.stringify(entries.map((entry) => ({
    path: entry.pathRelative,
    kind: entry.kind,
    dev: entry.dev,
    ino: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    mode: entry.mode,
  })));
}

async function assertTreeEntry(path: string, expected: TreeEntryIdentity): Promise<void> {
  const actual = treeIdentity(await lstat(path));
  if (
    actual.kind !== expected.kind || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs || actual.mode !== expected.mode
  ) {
    throw new Error("Refusing first-run managed memory because the staged index changed concurrently.");
  }
}

async function linkStagedFile(
  source: string,
  destination: string,
  expected: TreeEntryIdentity,
  hooks: {
    readonly onLinkCreated?: () => void;
    readonly afterLinkVerified?: () => void | Promise<void>;
    readonly assertDestination?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  await assertTreeEntry(source, expected);
  await hooks.assertDestination?.();
  try {
    await link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to publish managed memory over an existing path: ${destination}`);
    }
    throw error;
  }
  // Creating the destination name is the authority commit point for the
  // manifest. Record it before any later identity/fsync/source-cleanup step can
  // fail, so outer recovery keeps the fail-closed marker once authority exists.
  hooks.onLinkCreated?.();
  const destinationStat = await lstat(destination);
  if (destinationStat.isSymbolicLink() || !destinationStat.isFile() || !sameIdentity(destinationStat, expected)) {
    throw new Error("First-run managed memory linked an unexpected staged file identity.");
  }
  await hooks.assertDestination?.();
  await hooks.afterLinkVerified?.();
  await fsyncPath(destination);
  await assertTreeEntry(source, expected);
  await unlink(source);
}

async function promoteManagedIndex(options: {
  readonly stagingRoot: string;
  readonly finalRoot: string;
  readonly snapshot: readonly TreeEntrySnapshot[];
  readonly onManifestPublished: () => void;
  readonly afterManifestLinked?: (finalRoot: string) => void | Promise<void>;
  readonly assertDestination: () => void | Promise<void>;
}): Promise<void> {
  const sourceIndex = join(options.stagingRoot, ".index");
  const finalIndex = join(options.finalRoot, ".index");
  const manifest = options.snapshot.find((entry) => entry.pathRelative === "manifest.json");
  if (manifest?.kind !== "file") {
    throw new Error("First-run managed memory staged index has no regular manifest.");
  }

  await options.assertDestination();
  try {
    await mkdir(finalIndex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to publish managed memory over an existing path: ${finalIndex}`);
    }
    throw error;
  }
  const finalIndexStat = await lstat(finalIndex);
  if (finalIndexStat.isSymbolicLink() || !finalIndexStat.isDirectory()) {
    throw new Error("Refusing first-run managed memory because the published index root is unsafe.");
  }
  const finalIndexIdentity = { dev: finalIndexStat.dev, ino: finalIndexStat.ino };
  const publishedDirectories = new Map<string, ClaimedDirectoryIdentity>([["", finalIndexIdentity]]);
  const assertPublishedTree = async (): Promise<void> => {
    await options.assertDestination();
    for (const [pathRelative, identity] of publishedDirectories) {
      await assertClaimedRoot(pathRelative.length === 0 ? finalIndex : join(finalIndex, pathRelative), identity);
    }
  };

  const directories = options.snapshot
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => left.pathRelative.split(sep).length - right.pathRelative.split(sep).length);
  for (const entry of directories) {
    await assertPublishedTree();
    await assertTreeEntry(join(sourceIndex, entry.pathRelative), entry);
    const destination = join(finalIndex, entry.pathRelative);
    try {
      await mkdir(destination, { mode: entry.mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to publish managed memory over an existing path: ${destination}`);
      }
      throw error;
    }
    const created = await lstat(destination);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("Refusing first-run managed memory because a published index directory is unsafe.");
    }
    publishedDirectories.set(entry.pathRelative, { dev: created.dev, ino: created.ino });
  }

  const ordinaryFiles = options.snapshot.filter((entry) =>
    entry.kind === "file" && entry.pathRelative !== "manifest.json"
  );
  for (const entry of ordinaryFiles) {
    await linkStagedFile(
      join(sourceIndex, entry.pathRelative),
      join(finalIndex, entry.pathRelative),
      entry,
      { assertDestination: assertPublishedTree },
    );
  }
  for (const entry of [...directories].reverse()) {
    await assertPublishedTree();
    await fsyncPath(join(finalIndex, entry.pathRelative));
  }
  await assertPublishedTree();
  await fsyncPath(finalIndex);
  await fsyncPath(options.finalRoot);

  // The manifest is the authority switch. Hard-linking it is atomic and
  // no-replace on every supported filesystem, unlike rename(directory), which
  // can silently replace an empty winner on macOS.
  await linkStagedFile(
    join(sourceIndex, manifest.pathRelative),
    join(finalIndex, manifest.pathRelative),
    manifest,
    {
      onLinkCreated: options.onManifestPublished,
      assertDestination: assertPublishedTree,
      ...(options.afterManifestLinked === undefined
        ? {}
        : { afterLinkVerified: async () => await options.afterManifestLinked?.(options.finalRoot) }),
    },
  );
  await assertPublishedTree();
  await fsyncPath(finalIndex);
  await fsyncPath(options.finalRoot);
  await fsyncPath(dirname(options.finalRoot));

  // Remove only exact helper-owned source paths. Rmdir is intentionally
  // non-recursive, so raced content remains untouched in the private staging
  // tree rather than being deleted as collateral cleanup.
  for (const entry of [...directories].reverse()) {
    try { await rmdir(join(sourceIndex, entry.pathRelative)); } catch { /* raced content remains fail-closed */ }
  }
  try { await rmdir(sourceIndex); } catch { /* raced content remains */ }
  try { await rmdir(options.stagingRoot); } catch { /* raced content remains */ }
}

function managedMemoryConfiguration(plan: WizardPlan): {
  readonly mode: "journal" | "bujo";
  readonly path: string;
  readonly provider: "ollama" | "lmstudio" | "openai";
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKeyEnv?: string;
  readonly embeddingId: string;
  readonly dimension: number;
} | undefined {
  const memory = plan.configJson.memory;
  if (memory === undefined || (memory.backend ?? "bujo") !== "bujo") return undefined;
  if (memory.mode !== "journal" && memory.mode !== "bujo") return undefined;
  if (!plan.selectedModules.some((module) => module.id === `memory:${memory.mode}`)) {
    throw new Error(`Refusing to initialize ${memory.mode} memory from a plan that did not select its built-in module.`);
  }
  if (typeof memory.path !== "string" || memory.path.trim().length === 0) {
    throw new Error(`First-run ${memory.mode} memory requires a configured path.`);
  }
  const provider = memory.embeddings?.provider;
  const model = memory.embeddings?.model;
  if (
    (provider !== "ollama" && provider !== "lmstudio" && provider !== "openai")
    || typeof model !== "string" || model.length === 0
  ) {
    throw new Error(`First-run ${memory.mode} memory requires a configured embedding provider and model.`);
  }
  const dimension = memory.embeddings?.dim ?? DEFAULT_MANAGED_MEMORY_DIMENSION;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`First-run ${memory.mode} memory requires a positive integer embedding dimension.`);
  }
  const endpoint = memory.embeddings?.endpoint?.trim();
  const apiKeyEnv = memory.embeddings?.apiKeyEnv?.trim();
  return {
    mode: memory.mode,
    path: memory.path,
    provider,
    model,
    ...(endpoint === undefined || endpoint.length === 0 ? {} : { endpoint }),
    ...(apiKeyEnv === undefined || apiKeyEnv.length === 0 ? {} : { apiKeyEnv }),
    embeddingId: `${provider}:${model}`,
    dimension,
  };
}

function firstRunEmbeddingApiKey(
  configured: NonNullable<ReturnType<typeof managedMemoryConfiguration>>,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (configured.apiKeyEnv === undefined) return undefined;
  const apiKey = env?.[configured.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `First-run ${configured.mode} memory declares apiKeyEnv ${configured.apiKeyEnv}, but the supplied effective ` +
      `environment has no non-empty value. Set ${configured.apiKeyEnv} and retry.`,
    );
  }
  return apiKey;
}

async function proveFirstRunEmbeddingSelection(
  configured: NonNullable<ReturnType<typeof managedMemoryConfiguration>>,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<void> {
  const apiKey = firstRunEmbeddingApiKey(configured, env);
  try {
    if (configured.provider === "ollama" || configured.provider === "lmstudio") {
      await probeMemoryEmbeddingSelection({
        provider: configured.provider,
        model: configured.model,
        expectedDimension: configured.dimension,
        timeoutMs: FIRST_RUN_EMBEDDING_PROBE_TIMEOUT_MS,
        ...(configured.endpoint === undefined ? {} : { endpoint: configured.endpoint }),
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      return;
    }

    if (apiKey === undefined) {
      throw new Error("OpenAI embeddings require apiKeyEnv pointing at a value in the supplied effective environment.");
    }
    const { createEmbeddingProvider } = await import("@mono-agent/memory/search");
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: configured.model,
      apiKey,
      timeoutMs: FIRST_RUN_EMBEDDING_PROBE_TIMEOUT_MS,
      ...(configured.endpoint === undefined ? {} : { endpoint: configured.endpoint }),
    });
    const vectors = await provider.embed([FIRST_RUN_OPENAI_PROBE_TEXT]);
    if (vectors.length !== 1 || vectors[0]?.length !== configured.dimension) {
      throw new Error(
        `OpenAI returned dimension ${vectors[0]?.length ?? "unknown"} for ${configured.model}; ` +
        `configured dimension is ${configured.dimension}.`,
      );
    }
  } catch (error) {
    throw new Error(
      `First-run ${configured.mode} memory embedding readiness failed for ${configured.embeddingId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertNoManagedMemoryIdentityOverrides(
  plan: WizardPlan,
  env: Readonly<Record<string, string | undefined>> | undefined,
): void {
  if (plan.configJson.memory === undefined || env === undefined) return;
  const override = FIRST_RUN_MANAGED_MEMORY_OVERRIDE_KEYS.find((key) => (env[key] ?? "").trim().length > 0);
  if (override !== undefined) {
    throw new Error(
      `Fresh managed memory init refuses ${override}; put the intended memory identity in the generated config.`,
    );
  }
}

async function resolveFirstRunManagedMemoryTarget(options: {
  readonly agentRoot: string;
  readonly plan: WizardPlan;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  readonly configured: NonNullable<ReturnType<typeof managedMemoryConfiguration>>;
  readonly agentRoot: string;
  readonly root: string;
} | undefined> {
  assertNoManagedMemoryIdentityOverrides(options.plan, options.env);
  const configured = managedMemoryConfiguration(options.plan);
  if (configured === undefined) return undefined;
  const agentRoot = await canonicalAgentRoot(options.agentRoot);
  if (isAbsolute(configured.path)) {
    throw new Error("Refusing first-run managed memory with an absolute path.");
  }
  const root = resolve(agentRoot, configured.path);
  const rootRelative = relative(agentRoot, root);
  if (rootRelative.length === 0 || escapesRoot(rootRelative)) {
    throw new Error("Refusing first-run managed memory outside the agent folder.");
  }
  await assertExistingParentChainSafe(agentRoot, dirname(root));
  return { configured, agentRoot, root };
}

/** Read-only refusal gate used before init writes any scaffold file. */
export async function preflightFirstRunManagedMemory(
  options: InitializeFirstRunManagedMemoryOptions,
): Promise<InitializeFirstRunManagedMemoryResult> {
  const target = await resolveFirstRunManagedMemoryTarget(options);
  if (target === undefined) return { initialized: false };
  if (await optionalLstat(target.root) !== undefined) {
    throw new Error(`Refusing to initialize managed memory because its root already exists: ${target.root}`);
  }
  return { initialized: false, root: target.root };
}

/**
 * Create the initial managed Journal/BuJo generation for a newly generated
 * init plan. This deliberately refuses every pre-existing memory root, claims
 * the final root exclusively with a fail-closed marker, builds in a private
 * same-parent directory, and publishes the manifest last with an atomic
 * no-replace hard link. The native memory implementation is dynamically loaded
 * only after confinement and the final root claim have been proven.
 */
export async function initializeFirstRunManagedMemory(
  options: InitializeFirstRunManagedMemoryOptions,
): Promise<InitializeFirstRunManagedMemoryResult> {
  const target = await resolveFirstRunManagedMemoryTarget(options);
  if (target === undefined) return { initialized: false };
  const { configured, agentRoot, root } = target;
  throwIfAborted(options.abortSignal);
  if (await optionalLstat(root) !== undefined) {
    throw new Error(`Refusing to initialize managed memory because its root already exists: ${root}`);
  }
  await proveFirstRunEmbeddingSelection(configured, options.env);
  throwIfAborted(options.abortSignal);
  const pinnedParents = await pinRealDirectoryChain(agentRoot, dirname(root));

  throwIfAborted(options.abortSignal);
  await options.hooks?.beforeRootClaim?.(root);
  throwIfAborted(options.abortSignal);
  if (await optionalLstat(root) !== undefined) {
    throw new Error(`Refusing to initialize managed memory because another creator won its root: ${root}`);
  }

  const stagingPrefix = join(dirname(root), `.${basename(root)}.first-run-`);
  let stagingRoot: string | undefined;
  let stagingIdentity: ClaimedDirectoryIdentity | undefined;
  let rootIdentity: ClaimedDirectoryIdentity | undefined;
  let marker: DurableMarker | undefined;
  const markerPath = join(root, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
  let published = false;
  try {
    await assertPinnedDirectoryChain(pinnedParents);
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to initialize managed memory because another creator won its root: ${root}`);
      }
      throw error;
    }
    const claimedRoot = await lstat(root);
    if (claimedRoot.isSymbolicLink() || !claimedRoot.isDirectory()) {
      throw new Error("Refusing first-run managed memory because the claimed root is not a real directory.");
    }
    rootIdentity = { dev: claimedRoot.dev, ino: claimedRoot.ino };
    const assertDestination = async (): Promise<void> => {
      await assertPinnedDirectoryChain(pinnedParents);
      await assertClaimedRoot(root, rootIdentity!);
    };
    await assertDestination();
    marker = await createDurableMarker(markerPath);
    await assertDestination();
    await fsyncPath(root);
    await fsyncPath(dirname(root));
    await options.hooks?.afterRootClaim?.(root);
    throwIfAborted(options.abortSignal);
    await assertDestination();

    await assertPinnedDirectoryChain(pinnedParents);
    stagingRoot = await mkdtemp(stagingPrefix);
    const claimedStat = await lstat(stagingRoot);
    if (claimedStat.isSymbolicLink() || !claimedStat.isDirectory()) {
      throw new Error("Refusing first-run managed memory because the private staging root is not a real directory.");
    }
    stagingIdentity = { dev: claimedStat.dev, ino: claimedStat.ino };

    // Keep native SQLite and the memory package out of dry/default init paths.
    // The import happens only after the target has been confined and claimed.
    const { safeRebuildMemoryIndex } = await import("@mono-agent/memory/bujo");
    await options.hooks?.beforeRebuild?.(stagingRoot);
    throwIfAborted(options.abortSignal);
    await assertDestination();
    await assertClaimedRoot(stagingRoot, stagingIdentity);
    if ((await readdir(stagingRoot)).length > 0) {
      throw new Error("Refusing first-run managed memory because the private staging root is no longer empty.");
    }

    let embedCalls = 0;
    await safeRebuildMemoryIndex({
      root: stagingRoot,
      tier: configured.mode,
      dim: configured.dimension,
      embeddings: {
        id: configured.embeddingId,
        embed: async () => {
          embedCalls += 1;
          throw new Error("First-run managed memory attempted to embed an empty source.");
        },
      },
    });
    if (embedCalls !== 0) {
      throw new Error("First-run managed memory invoked its no-call embedding provider.");
    }
    const sourceIndex = join(stagingRoot, ".index");
    const stagedSnapshot = await snapshotTree(sourceIndex);
    await options.hooks?.beforePromotion?.(stagingRoot, root);
    throwIfAborted(options.abortSignal);
    await assertDestination();
    await assertClaimedRoot(stagingRoot, stagingIdentity);
    if (treeSignature(await snapshotTree(sourceIndex)) !== treeSignature(stagedSnapshot)) {
      throw new Error("Refusing first-run managed memory because the staged index changed concurrently.");
    }
    const finalEntries = (await readdir(root)).sort();
    if (finalEntries.length !== 1 || finalEntries[0] !== FIRST_RUN_MEMORY_INITIALIZING_MARKER) {
      throw new Error("Refusing first-run managed memory because the claimed root changed before publication.");
    }
    await promoteManagedIndex({
      stagingRoot,
      finalRoot: root,
      snapshot: stagedSnapshot,
      onManifestPublished: () => { published = true; },
      assertDestination,
      ...(options.hooks?.afterManifestLinked === undefined
        ? {}
        : { afterManifestLinked: options.hooks.afterManifestLinked }),
    });
    await assertDestination();
    if (!await removeOwnedMarker(
      root,
      rootIdentity,
      markerPath,
      marker,
      options.hooks?.beforeMarkerRelease,
      options.hooks?.afterMarkerQuarantined,
    )) {
      throw new Error("First-run managed memory could not remove its exact initialization marker.");
    }
    await assertDestination();
    await fsyncPath(root);
    await fsyncPath(dirname(root));
    return { initialized: true, root };
  } catch (error) {
    let parentsStable = false;
    try {
      await assertPinnedDirectoryChain(pinnedParents);
      parentsStable = true;
    } catch {
      // Never follow a replaced parent for cleanup.
    }
    if (parentsStable) {
      if (!published && rootIdentity !== undefined && marker !== undefined) {
        await removeOwnedMarker(root, rootIdentity, markerPath, marker);
      }
      if (stagingRoot !== undefined && stagingIdentity !== undefined) {
        await cleanupEmptyClaimedRoot(stagingRoot, stagingIdentity);
      }
      if (!published && rootIdentity !== undefined) {
        await cleanupEmptyClaimedRoot(root, rootIdentity);
      }
    }
    throw error;
  } finally {
    await marker?.handle.close().catch(() => undefined);
  }
}
