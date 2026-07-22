import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const BUILD_MARKER_FILENAME = ".mono-agent-build.json";
export const BUILD_LOCK_FILENAME = ".mono-agent-build.lock";
export const BUILD_MARKER_SCHEMA_VERSION = 2;

const BUILD_MARKER_KEYS = Object.freeze([
  "schemaVersion",
  "gitSha",
  "completedAt",
  "nodeVersion",
  "nodeAbi",
  "sourceState",
  "outputDigest",
  "dependencyDigest",
]);
const MAX_BUILD_MARKER_BYTES = 4_096;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const NODE_ABI_PATTERN = /^\d+$/u;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const MAX_DEPENDENCY_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_UINT64 = (1n << 64n) - 1n;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record, expectedKeys) {
  const actualKeys = Object.keys(record);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(record, key));
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw new Error("unsafe build directory");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function bestEffortSyncDirectory(path) {
  try {
    syncDirectory(path);
  } catch {
    // Preserve the original operation error.
  }
}

function unlinkAndSync(path, directory, options = {}) {
  let removed = false;
  try {
    unlinkSync(path);
    removed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (removed && options.syncDirectory !== false) syncDirectory(directory);
  return removed;
}

export function parseBuildMarker(value) {
  if (!isRecord(value)
    || !hasExactKeys(value, BUILD_MARKER_KEYS)
    || value.schemaVersion !== BUILD_MARKER_SCHEMA_VERSION
    || typeof value.gitSha !== "string"
    || !SHA_PATTERN.test(value.gitSha)
    || !isCanonicalInstant(value.completedAt)
    || typeof value.nodeVersion !== "string"
    || !NODE_VERSION_PATTERN.test(value.nodeVersion)
    || typeof value.nodeAbi !== "string"
    || !NODE_ABI_PATTERN.test(value.nodeAbi)
    || (value.sourceState !== "clean" && value.sourceState !== "dirty")
    || typeof value.outputDigest !== "string"
    || !DIGEST_PATTERN.test(value.outputDigest)
    || typeof value.dependencyDigest !== "string"
    || !DIGEST_PATTERN.test(value.dependencyDigest)) {
    return null;
  }
  return {
    schemaVersion: BUILD_MARKER_SCHEMA_VERSION,
    gitSha: value.gitSha,
    completedAt: value.completedAt,
    nodeVersion: value.nodeVersion,
    nodeAbi: value.nodeAbi,
    sourceState: value.sourceState,
    outputDigest: value.outputDigest,
    dependencyDigest: value.dependencyDigest,
  };
}

export function parseBuildMarkerText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BUILD_MARKER_BYTES) {
    return null;
  }
  try {
    const marker = parseBuildMarker(JSON.parse(text));
    if (marker === null || text !== `${JSON.stringify(marker)}\n`) return null;
    return marker;
  } catch {
    return null;
  }
}

export function buildMarkerPath(repo) {
  return join(repo, BUILD_MARKER_FILENAME);
}

export function buildLockPath(repo) {
  return join(repo, BUILD_LOCK_FILENAME);
}

export function clearBuildMarker(repo, options = {}) {
  unlinkAndSync(buildMarkerPath(repo), repo, options);
}

export function acquireBuildLock(repo) {
  const path = buildLockPath(repo);
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`, "utf8");
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) {
      throw new Error("unsafe build lock");
    }
    syncDirectory(repo);
    return { fd, path, dev: stat.dev, ino: stat.ino, released: false };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original lock error.
      }
      try {
        unlinkSync(path);
        bestEffortSyncDirectory(repo);
      } catch {
        // Preserve the original lock error.
      }
    }
    throw error;
  }
}

export function releaseBuildLock(repo, lock) {
  if (!isRecord(lock) || lock.released === true || typeof lock.fd !== "number") {
    throw new Error("invalid build lock handle");
  }
  lock.released = true;
  let releaseError;
  try {
    const openStat = fstatSync(lock.fd, { bigint: true });
    const pathStat = lstatOrNull(lock.path);
    if (pathStat === null
      || !pathStat.isFile()
      || !sameIdentity(openStat, pathStat)
      || openStat.dev !== lock.dev
      || openStat.ino !== lock.ino) {
      throw new Error("build lock identity changed");
    }
    unlinkSync(lock.path);
    syncDirectory(repo);
  } catch (error) {
    releaseError = error;
  } finally {
    try {
      closeSync(lock.fd);
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError !== undefined) throw releaseError;
}

export function publishBuildMarker(repo, marker, options = {}) {
  const parsed = parseBuildMarker(marker);
  if (parsed === null) {
    throw new Error("refusing to publish an invalid build marker");
  }

  const destination = buildMarkerPath(repo);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(parsed)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    renamed = true;
    options.afterRename?.();
    syncDirectory(repo);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original publication error.
      }
    }
    if (renamed) {
      try {
        unlinkSync(destination);
      } catch {
        // The renamed marker may already have been removed.
      }
      bestEffortSyncDirectory(repo);
    } else {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary marker may never have been created.
      }
      bestEffortSyncDirectory(repo);
    }
    throw error;
  }
}

function buildLockIsAbsent(repo) {
  try {
    const stat = lstatSync(buildLockPath(repo));
    return stat === undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

/**
 * Read through one no-follow file descriptor so permissions, bytes, and the
 * returned fingerprint all describe the same inode. Only closed statuses and
 * a validated marker leave this boundary.
 */
export function readBuildMarker(repo, options = {}) {
  if (!buildLockIsAbsent(repo)) return { status: "unsafe" };

  const markerPath = buildMarkerPath(repo);
  let fd;
  try {
    fd = openSync(markerPath, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unsafe" };
  }

  try {
    const stat = fstatSync(fd, { bigint: true });
    const expectedUidValue = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const expectedUid = expectedUidValue === undefined ? undefined : BigInt(expectedUidValue);
    if (!stat.isFile()
      || stat.nlink !== 1n
      || stat.size <= 0n
      || stat.size > BigInt(MAX_BUILD_MARKER_BYTES)
      || (stat.mode & 0o077n) !== 0n
      || (expectedUid !== undefined && stat.uid !== expectedUid)) {
      return { status: "unsafe" };
    }
    const text = readFileSync(fd, "utf8");
    // Test seam for proving that a replaced or unlinked pathname cannot bless
    // bytes read from a now-stale file descriptor. Production leaves it unset.
    options.afterRead?.();
    const after = fstatSync(fd, { bigint: true });
    const current = lstatOrNull(markerPath);
    if (current === null
      || !current.isFile()
      || after.nlink !== 1n
      || current.nlink !== 1n
      || !sameFileState(stat, after)
      || !sameFileState(after, current)
      || (after.mode & 0o077n) !== 0n
      || (current.mode & 0o077n) !== 0n
      || (expectedUid !== undefined && (after.uid !== expectedUid || current.uid !== expectedUid))) {
      return { status: "unsafe" };
    }
    const marker = parseBuildMarkerText(text);
    if (marker === null) {
      return { status: "malformed" };
    }
    if (!buildLockIsAbsent(repo)) return { status: "unsafe" };
    return {
      status: "ok",
      marker,
      fingerprint: createHash("sha256").update(text).digest("hex"),
    };
  } catch {
    return { status: "unsafe" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The report is already closed; never replace it with a raw fs error.
    }
  }
}

function assertDirectory(path) {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isDirectory()) throw new Error("build output directory unavailable");
  return stat;
}

function outputRoots(repo) {
  const roots = new Set();
  for (const parentName of ["packages", "extras"]) {
    const parent = join(repo, parentName);
    assertDirectory(parent);
    const names = readdirSync(parent).sort(compareUtf8);
    for (const name of names) {
      const packageDirectory = join(parent, name);
      const packageStat = lstatOrNull(packageDirectory);
      if (packageStat === null) continue;
      if (packageStat.isSymbolicLink()) throw new Error("unsafe package directory");
      if (!packageStat.isDirectory()) continue;
      const manifest = lstatOrNull(join(packageDirectory, "package.json"));
      if (manifest === null) continue;
      if (!manifest.isFile()) throw new Error("unsafe package manifest");
      const dist = join(packageDirectory, "dist");
      const distStat = lstatOrNull(dist);
      if (distStat === null) continue;
      if (!distStat.isDirectory()) throw new Error("unsafe build output root");
      roots.add(dist);
    }
  }

  for (const required of [
    join(repo, "packages", "web", "webapp", "dist"),
    join(repo, "demos", "final-agent", "dist"),
  ]) {
    assertDirectory(required);
    roots.add(required);
  }
  return [...roots].sort((left, right) => compareUtf8(toRepoPath(repo, left), toRepoPath(repo, right)));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function toRepoPath(repo, path) {
  const value = relative(repo, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../") || value.includes("\0")) {
    throw new Error("unsafe build output path");
  }
  return value;
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function collectOutputTree(repo, roots) {
  const files = new Map();
  const directories = new Map();

  function visitDirectory(path) {
    const before = assertDirectory(path);
    const repoPath = toRepoPath(repo, path);
    if (directories.has(repoPath)) throw new Error("overlapping build output roots");
    directories.set(repoPath, statSignature(before));
    const names = readdirSync(path).sort(compareUtf8);
    for (const name of names) {
      const child = join(path, name);
      const stat = lstatSync(child, { bigint: true });
      if (stat.isDirectory()) {
        visitDirectory(child);
      } else if (stat.isFile()) {
        const childPath = toRepoPath(repo, child);
        if (files.has(childPath)) throw new Error("duplicate build output path");
        files.set(childPath, { path: child, signature: statSignature(stat) });
      } else {
        throw new Error("unsafe build output entry");
      }
    }
    const after = lstatSync(path, { bigint: true });
    if (!after.isDirectory() || !sameFileState(before, after)) {
      throw new Error("build output changed during traversal");
    }
  }

  for (const root of roots) visitDirectory(root);
  if (files.size === 0) throw new Error("build outputs are empty");
  return { files, directories };
}

function readStableOutputFile(path, expectedSignature, sync) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || statSignature(before) !== expectedSignature) {
      throw new Error("build output file changed");
    }
    const bytes = readFileSync(fd);
    if (sync) fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!after.isFile()
      || !current.isFile()
      || !sameFileState(before, after)
      || !sameFileState(after, current)) {
      throw new Error("build output file changed");
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function updateFramed(hash, bytes) {
  updateFrameLength(hash, BigInt(bytes.length));
  hash.update(bytes);
}

function updateFrameLength(hash, byteLength) {
  if (typeof byteLength !== "bigint" || byteLength < 0n || byteLength > MAX_UINT64) {
    throw new Error("unsafe framed payload length");
  }
  const lengthFrame = Buffer.allocUnsafe(8);
  lengthFrame.writeBigUInt64BE(byteLength);
  hash.update(lengthFrame);
}

export function computeBuildOutputDigest(repo, options = {}) {
  const sync = options.sync === true;
  const roots = outputRoots(repo);
  const initial = collectOutputTree(repo, roots);
  const hash = createHash("sha256");
  hash.update("mono-agent-build-output-v1\0", "utf8");

  const filePaths = [...initial.files.keys()].sort(compareUtf8);
  for (const repoPath of filePaths) {
    const entry = initial.files.get(repoPath);
    const bytes = readStableOutputFile(entry.path, entry.signature, sync);
    updateFramed(hash, Buffer.from(repoPath, "utf8"));
    updateFramed(hash, bytes);
  }

  if (sync) {
    const directoryPaths = [...initial.directories.keys()]
      .sort((left, right) => right.split("/").length - left.split("/").length || compareUtf8(left, right));
    for (const repoPath of directoryPaths) {
      const path = join(repo, ...repoPath.split("/"));
      syncDirectory(path);
      options.onDirectorySync?.(path);
    }

    // Fsyncing a new dist directory does not itself make the directory entry
    // durable. Flush every unique ancestor bottom-up through the repo root so
    // the complete output-root path is on stable storage before publication.
    const ancestors = new Set();
    for (const root of roots) {
      let current = dirname(root);
      while (true) {
        const repoPath = relative(repo, current);
        if (repoPath === ".." || repoPath.startsWith(`..${sep}`)) {
          throw new Error("unsafe build output ancestor");
        }
        ancestors.add(current);
        if (current === repo) break;
        current = dirname(current);
      }
    }
    const ancestorPaths = [...ancestors].sort((left, right) => {
      const leftDepth = toRepoPathOrRoot(repo, left).split("/").filter(Boolean).length;
      const rightDepth = toRepoPathOrRoot(repo, right).split("/").filter(Boolean).length;
      return rightDepth - leftDepth || compareUtf8(toRepoPathOrRoot(repo, left), toRepoPathOrRoot(repo, right));
    });
    for (const path of ancestorPaths) {
      syncDirectory(path);
      options.onDirectorySync?.(path);
    }
  }

  const finalRoots = outputRoots(repo);
  if (roots.length !== finalRoots.length
    || roots.some((root, index) => root !== finalRoots[index])) {
    throw new Error("build output roots changed during digest");
  }
  const final = collectOutputTree(repo, finalRoots);
  if (final.files.size !== initial.files.size || final.directories.size !== initial.directories.size) {
    throw new Error("build outputs changed during digest");
  }
  for (const [repoPath, entry] of initial.files) {
    if (final.files.get(repoPath)?.signature !== entry.signature) {
      throw new Error("build outputs changed during digest");
    }
  }
  for (const [repoPath, signature] of initial.directories) {
    if (final.directories.get(repoPath) !== signature) {
      throw new Error("build outputs changed during digest");
    }
  }
  return hash.digest("hex");
}

function toRepoPathOrRoot(repo, path) {
  return path === repo ? "" : toRepoPath(repo, path);
}

function assertDependencyDirectory(path) {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("runtime dependency directory unavailable or unsafe");
  }
  return stat;
}

function runtimeDependencyTopology(repo) {
  const dependencyRoots = [join(repo, "node_modules")];
  const workspaceRoots = [];
  assertDependencyDirectory(dependencyRoots[0]);

  for (const parentName of ["packages", "extras"]) {
    const parent = join(repo, parentName);
    const before = assertDependencyDirectory(parent);
    const names = readdirSync(parent).sort(compareUtf8);
    for (const name of names) {
      const packageDirectory = join(parent, name);
      const packageStat = lstatOrNull(packageDirectory);
      if (packageStat === null) continue;
      if (packageStat.isSymbolicLink()) throw new Error("unsafe workspace package directory");
      if (!packageStat.isDirectory()) continue;

      const manifest = lstatOrNull(join(packageDirectory, "package.json"));
      if (manifest === null) continue;
      if (!manifest.isFile() || manifest.isSymbolicLink()) {
        throw new Error("unsafe workspace package manifest");
      }
      workspaceRoots.push(packageDirectory);

      const nodeModules = join(packageDirectory, "node_modules");
      const dependencyStat = lstatOrNull(nodeModules);
      if (dependencyStat === null) continue;
      if (!dependencyStat.isDirectory() || dependencyStat.isSymbolicLink()) {
        throw new Error("unsafe package dependency root");
      }
      dependencyRoots.push(nodeModules);
    }
    const after = lstatSync(parent, { bigint: true });
    if (!after.isDirectory() || !sameFileState(before, after)) {
      throw new Error("workspace package topology changed during traversal");
    }
  }

  const sortRepoPaths = (left, right) => compareUtf8(toRepoPath(repo, left), toRepoPath(repo, right));
  return {
    dependencyRoots: dependencyRoots.sort(sortRepoPaths),
    workspaceRoots: workspaceRoots.sort(sortRepoPaths),
  };
}

function pathIsWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath));
}

function safeDependencySymlinkTarget(repo, topology, path, target) {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0") || isAbsolute(target)) {
    throw new Error("unsafe runtime dependency symlink");
  }
  const resolvedTarget = resolve(dirname(path), target);
  const relativeTarget = relative(repo, resolvedTarget);
  if (relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)) {
    throw new Error("runtime dependency symlink escapes repository");
  }
  const attestedDependencyTarget = topology.dependencyRoots.some(
    (root) => pathIsWithin(root, resolvedTarget),
  );
  const canonicalWorkspaceTarget = topology.workspaceRoots.includes(resolvedTarget);
  if (!attestedDependencyTarget && !canonicalWorkspaceTarget) {
    throw new Error("runtime dependency symlink target is not attested");
  }
  return target;
}

function dependencyMode(stat) {
  return Number(stat.mode & 0o7777n);
}

function isVitestCacheContainer(path) {
  return basename(path) === ".vite" && basename(dirname(path)) === "node_modules";
}

function isIgnoredVitestCacheDirectory(path, stat) {
  return basename(path) === "vitest"
    && isVitestCacheContainer(dirname(path))
    && stat.isDirectory()
    && !stat.isSymbolicLink();
}

function readStableDependencySymlink(repo, topology, path, expected) {
  if (!expected.isSymbolicLink()) throw new Error("runtime dependency entry changed");
  const target = safeDependencySymlinkTarget(repo, topology, path, readlinkSync(path, "utf8"));
  const current = lstatSync(path, { bigint: true });
  if (!current.isSymbolicLink()
    || !sameFileState(expected, current)
    || dependencyMode(current) !== dependencyMode(expected)) {
    throw new Error("runtime dependency symlink changed");
  }
  return target;
}

function collectRuntimeDependencyTree(repo, topology) {
  const entries = new Map();

  function addEntry(path, entry) {
    const repoPath = toRepoPath(repo, path);
    if (entries.has(repoPath)) throw new Error("overlapping runtime dependency roots");
    entries.set(repoPath, entry);
    return repoPath;
  }

  function visitDirectory(path, expected, workspaceRoot) {
    const before = expected ?? assertDependencyDirectory(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("unsafe runtime dependency directory");
    }
    const children = readdirSync(path)
      .sort(compareUtf8)
      .map((name) => {
        const child = join(path, name);
        return { name, child, stat: lstatSync(child, { bigint: true }) };
      });
    const attestedChildren = children.filter(
      ({ child, stat }) => !isIgnoredVitestCacheDirectory(child, stat),
    );

    // Vitest owns node_modules/.vite/vitest as mutable test state. Treat an
    // otherwise-empty .vite container as part of that excluded subtree so
    // creating the cache after a build does not alter the runtime digest.
    // Any sibling entry keeps .vite and that sibling inside the attestation.
    const omitDirectory = isVitestCacheContainer(path) && attestedChildren.length === 0;
    if (!omitDirectory) {
      addEntry(path, {
        type: "directory",
        path,
        signature: statSignature(before),
        mode: dependencyMode(before),
      });
    }
    for (const { name, child, stat } of attestedChildren) {
      // Canonical package-local node_modules directories are separate
      // attested roots. Other nested application node_modules trees are not
      // part of the published workspace-package runtime closure.
      if (workspaceRoot !== undefined && name === "node_modules") continue;
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visitDirectory(child, stat, workspaceRoot);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        addEntry(child, {
          type: "file",
          path: child,
          signature: statSignature(stat),
          mode: dependencyMode(stat),
        });
      } else if (stat.isSymbolicLink()) {
        addEntry(child, {
          type: "symlink",
          path: child,
          signature: statSignature(stat),
          mode: dependencyMode(stat),
          target: readStableDependencySymlink(repo, topology, child, stat),
        });
      } else {
        throw new Error("unsafe runtime dependency entry");
      }
    }
    const after = lstatSync(path, { bigint: true });
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || !sameFileState(before, after)
      || dependencyMode(after) !== dependencyMode(before)) {
      throw new Error("runtime dependency directory changed during traversal");
    }
  }

  for (const root of topology.dependencyRoots) visitDirectory(root, undefined, undefined);
  for (const root of topology.workspaceRoots) {
    visitDirectory(root, undefined, root);
  }
  return entries;
}

function readStableDependencyFile(entry, buffer, framedHash, onReadChunk) {
  let fd;
  try {
    fd = openSync(entry.path, constants.O_RDONLY | NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()
      || statSignature(before) !== entry.signature
      || dependencyMode(before) !== entry.mode
      || before.size < 0n
      || before.size > MAX_UINT64) {
      throw new Error("runtime dependency file changed");
    }
    if (framedHash !== undefined) updateFrameLength(framedHash, before.size);
    const contentHash = createHash("sha256");
    let bytesReadTotal = 0n;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytesReadTotal += BigInt(bytesRead);
      if (bytesReadTotal > before.size) throw new Error("runtime dependency file changed");
      const chunk = buffer.subarray(0, bytesRead);
      contentHash.update(chunk);
      framedHash?.update(chunk);
      onReadChunk?.(bytesRead);
    }
    if (bytesReadTotal !== before.size) throw new Error("runtime dependency file changed");
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(entry.path, { bigint: true });
    if (!after.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || !sameFileState(before, after)
      || !sameFileState(after, current)
      || dependencyMode(after) !== entry.mode
      || dependencyMode(current) !== entry.mode) {
      throw new Error("runtime dependency file changed");
    }
    return contentHash.digest("hex");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameRepoPaths(repo, initial, final) {
  return initial.length === final.length
    && initial.every((path, index) => toRepoPath(repo, path) === toRepoPath(repo, final[index]));
}

function sameDependencyTopology(repo, initial, final) {
  return sameRepoPaths(repo, initial.dependencyRoots, final.dependencyRoots)
    && sameRepoPaths(repo, initial.workspaceRoots, final.workspaceRoots);
}

function collectDeploymentState(repo) {
  const roots = outputRoots(repo);
  const outputs = collectOutputTree(repo, roots);
  const dependencyTopology = runtimeDependencyTopology(repo);
  const dependencies = collectRuntimeDependencyTree(repo, dependencyTopology);
  return { roots, outputs, dependencyTopology, dependencies };
}

function sameStringMap(initial, final) {
  if (initial.size !== final.size) return false;
  for (const [path, value] of initial) {
    if (final.get(path) !== value) return false;
  }
  return true;
}

function sameOutputMetadata(repo, initial, final) {
  if (!sameRepoPaths(repo, initial.roots, final.roots)
    || initial.outputs.files.size !== final.outputs.files.size
    || !sameStringMap(initial.outputs.directories, final.outputs.directories)) {
    return false;
  }
  for (const [path, entry] of initial.outputs.files) {
    if (final.outputs.files.get(path)?.signature !== entry.signature) return false;
  }
  return true;
}

function sameDependencyMetadata(repo, initial, final) {
  if (!sameDependencyTopology(repo, initial.dependencyTopology, final.dependencyTopology)
    || initial.dependencies.size !== final.dependencies.size) {
    return false;
  }
  for (const [path, entry] of initial.dependencies) {
    const current = final.dependencies.get(path);
    if (current === undefined
      || current.type !== entry.type
      || current.signature !== entry.signature
      || current.mode !== entry.mode
      || current.target !== entry.target) {
      return false;
    }
  }
  return true;
}

function updateFingerprintFields(hash, ...fields) {
  for (const field of fields) updateFramed(hash, Buffer.from(String(field), "utf8"));
}

/**
 * Return one stable metadata fingerprint spanning both deploy outputs and the
 * complete dependency/workspace closure. The function performs two full
 * metadata traversals and refuses a fingerprint if roots, paths, identities,
 * stat signatures, dependency modes, or symlink targets move between them.
 */
export function computeDeploymentStateFingerprint(repo, options = {}) {
  const initial = collectDeploymentState(repo);
  options.afterFirstPass?.();
  const final = collectDeploymentState(repo);
  if (!sameOutputMetadata(repo, initial, final)
    || !sameDependencyMetadata(repo, initial, final)) {
    throw new Error("deployment state changed during metadata fingerprint");
  }

  const hash = createHash("sha256");
  hash.update("mono-agent-deployment-state-v1\0", "utf8");
  for (const root of initial.roots) {
    updateFingerprintFields(hash, "output-root", toRepoPath(repo, root));
  }
  for (const path of [...initial.outputs.directories.keys()].sort(compareUtf8)) {
    updateFingerprintFields(hash, "output-directory", path, initial.outputs.directories.get(path));
  }
  for (const path of [...initial.outputs.files.keys()].sort(compareUtf8)) {
    updateFingerprintFields(hash, "output-file", path, initial.outputs.files.get(path).signature);
  }
  for (const root of initial.dependencyTopology.dependencyRoots) {
    updateFingerprintFields(hash, "dependency-root", toRepoPath(repo, root));
  }
  for (const root of initial.dependencyTopology.workspaceRoots) {
    updateFingerprintFields(hash, "workspace-root", toRepoPath(repo, root));
  }
  for (const path of [...initial.dependencies.keys()].sort(compareUtf8)) {
    const entry = initial.dependencies.get(path);
    updateFingerprintFields(
      hash,
      "dependency-entry",
      path,
      entry.type,
      entry.signature,
      entry.mode.toString(8).padStart(4, "0"),
    );
    if (entry.type === "symlink") updateFingerprintFields(hash, entry.target);
  }
  return hash.digest("hex");
}

/**
 * Attest the complete installed pnpm dependency topology without following
 * dependency symlinks. Exact workspace-package link targets are closed by
 * attesting each canonical package tree once, excluding node_modules
 * subtrees (the canonical package-local roots are scanned separately).
 * Every path and entry type is framed into
 * the digest; regular-file bytes and symlink target strings provide payloads.
 * A second complete traversal and byte read detects concurrent replacement,
 * identity, topology, target, or content changes and fails closed.
 */
export function computeRuntimeDependencyDigest(repo, options = {}) {
  const initialTopology = runtimeDependencyTopology(repo);
  const initial = collectRuntimeDependencyTree(repo, initialTopology);
  const hash = createHash("sha256");
  hash.update("mono-agent-runtime-dependency-v1\0", "utf8");
  const readBuffer = Buffer.allocUnsafe(MAX_DEPENDENCY_READ_CHUNK_BYTES);

  const paths = [...initial.keys()].sort(compareUtf8);
  for (const repoPath of paths) {
    const entry = initial.get(repoPath);
    updateFramed(hash, Buffer.from(repoPath, "utf8"));
    updateFramed(hash, Buffer.from(entry.type, "utf8"));
    updateFramed(hash, Buffer.from(entry.mode.toString(8).padStart(4, "0"), "ascii"));
    if (entry.type === "file") {
      entry.contentDigest = readStableDependencyFile(
        entry,
        readBuffer,
        hash,
        options.onFileReadChunk,
      );
    } else if (entry.type === "symlink") {
      updateFramed(hash, Buffer.from(entry.target, "utf8"));
    }
  }

  // Test seam for proving mutations between the stable passes fail closed.
  options.afterFirstPass?.();

  const finalTopology = runtimeDependencyTopology(repo);
  if (!sameDependencyTopology(repo, initialTopology, finalTopology)) {
    throw new Error("runtime dependency roots changed during digest");
  }
  const final = collectRuntimeDependencyTree(repo, finalTopology);
  if (initial.size !== final.size) throw new Error("runtime dependency topology changed during digest");

  for (const [repoPath, entry] of initial) {
    const current = final.get(repoPath);
    if (current === undefined
      || current.type !== entry.type
      || current.signature !== entry.signature
      || current.mode !== entry.mode
      || current.target !== entry.target) {
      throw new Error("runtime dependency entry changed during digest");
    }
    if (entry.type === "file") {
      const contentDigest = readStableDependencyFile(
        current,
        readBuffer,
        undefined,
        options.onFileReadChunk,
      );
      if (contentDigest !== entry.contentDigest) {
        throw new Error("runtime dependency content changed during digest");
      }
    }
  }
  return hash.digest("hex");
}
