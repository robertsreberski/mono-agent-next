import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyManagedRuntimeClosureForProvenance } from "./background-runtime.js";
import type { ManagedRuntimeProvenanceVerificationDeps } from "./background-runtime.js";
import { agentAppPackageVersion } from "./package-version.js";

const PACKAGE_NAME = "@mono-agent/agent-app";
const MARKER_SCHEMAS = new Set(["mono-agent.managed-runtime.v4", "mono-agent.managed-runtime.v5"]);
const PROVISIONAL_INSTALLED_AT = "1970-01-01T00:00:00.000Z";
const UNMANAGED_DETAIL = "Runtime provenance: dev (unmanaged).";
const MARKER_MAX_BYTES = 16 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const MARKER_COMMON_KEYS = [
  "schema",
  "packageName",
  "closureManifestSha256",
  "executionProofSha256",
  "packageVersion",
  "cliSha256",
  "sourceClosureSha256",
  "nodeAbi",
  "platform",
  "arch",
  "installedAt",
] as const;

interface RuntimeMarker {
  readonly schema: "mono-agent.managed-runtime.v4" | "mono-agent.managed-runtime.v5";
  readonly packageName: typeof PACKAGE_NAME;
  readonly closureManifestSha256: string;
  readonly executionProofSha256: string;
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly sourceClosureSha256: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly installedAt: string;
  readonly reuseProofSha256?: string;
}

interface DirectoryProof {
  readonly path: string;
  readonly details: BigIntStats;
  readonly ownerPrivate: boolean;
}

/**
 * Describe the code producing this report. Marker contents are operator-facing
 * only after the managed layout, private ancestry, package, CLI, and closure
 * manifest all agree; every missing or unsafe shape fails closed to dev mode.
 */
export async function runtimeProvenanceDetail(
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  deps: ManagedRuntimeProvenanceVerificationDeps = {},
): Promise<string> {
  try {
    const layout = managedLayout(resolve(packageRoot));
    if (layout === undefined) return UNMANAGED_DETAIL;

    const privateProofs = await captureDirectoryProofs(layout.privateDirectories, true);
    const packageProofs = await captureDirectoryProofs([
      layout.nodeModulesRoot,
      layout.packageScopeRoot,
      layout.packageRoot,
      join(layout.packageRoot, "dist"),
    ], false);
    if (await realpath(layout.packageRoot) !== layout.packageRoot) return UNMANAGED_DETAIL;

    const marker = runtimeMarkerFromJson(
      JSON.parse((await readStableFile(layout.markerPath, MARKER_MAX_BYTES, true)).toString("utf8")) as unknown,
    );
    if (marker === undefined) return UNMANAGED_DETAIL;

    const installedVersion = agentAppPackageVersion();
    const closureId = `${marker.cliSha256}-${marker.sourceClosureSha256}`;
    if (
      installedVersion === undefined
      || marker.packageVersion !== installedVersion
      || marker.nodeAbi !== process.versions.modules
      || marker.platform !== process.platform
      || marker.arch !== process.arch
      || basename(layout.installRoot) !== closureId
      || basename(layout.versionAbiRoot) !== `${marker.platform}-${marker.arch}-abi-${marker.nodeAbi}`
      || basename(layout.versionRoot) !== marker.packageVersion
    ) {
      return UNMANAGED_DETAIL;
    }

    if (!await verifyManagedRuntimeClosureForProvenance({
      packageRoot: layout.packageRoot,
      packageVersion: marker.packageVersion,
      cliSha256: marker.cliSha256,
      sourceClosureSha256: marker.sourceClosureSha256,
      closureManifestSha256: marker.closureManifestSha256,
      executionProofSha256: marker.executionProofSha256,
      nodeAbi: marker.nodeAbi,
      platform: marker.platform,
      arch: marker.arch,
      installedAt: marker.installedAt,
    }, deps)) return UNMANAGED_DETAIL;

    await verifyDirectoryProofs([...privateProofs, ...packageProofs]);
    return `Runtime provenance: managed closure ${closureId} (`
      + `${PACKAGE_NAME} ${marker.packageVersion}; ${marker.platform}-${marker.arch}; `
      + `Node ABI ${marker.nodeAbi}; installed ${marker.installedAt}).`;
  } catch {
    return UNMANAGED_DETAIL;
  }
}

function managedLayout(packageRoot: string): {
  readonly packageRoot: string;
  readonly packageScopeRoot: string;
  readonly nodeModulesRoot: string;
  readonly installRoot: string;
  readonly versionAbiRoot: string;
  readonly versionRoot: string;
  readonly markerPath: string;
  readonly privateDirectories: readonly string[];
} | undefined {
  const packageScopeRoot = dirname(packageRoot);
  const nodeModulesRoot = dirname(packageScopeRoot);
  const installRoot = dirname(nodeModulesRoot);
  const versionAbiRoot = dirname(installRoot);
  const versionRoot = dirname(versionAbiRoot);
  const appRuntimeRoot = dirname(versionRoot);
  const runtimesRoot = dirname(appRuntimeRoot);
  const monoAgentRoot = dirname(runtimesRoot);

  if (
    basename(packageRoot) !== "agent-app"
    || basename(packageScopeRoot) !== "@mono-agent"
    || basename(nodeModulesRoot) !== "node_modules"
    || basename(appRuntimeRoot) !== "agent-app"
    || basename(runtimesRoot) !== "runtimes"
    || basename(monoAgentRoot) !== ".mono-agent"
    || join(installRoot, "node_modules", "@mono-agent", "agent-app") !== packageRoot
  ) {
    return undefined;
  }

  return {
    packageRoot,
    packageScopeRoot,
    nodeModulesRoot,
    installRoot,
    versionAbiRoot,
    versionRoot,
    markerPath: join(installRoot, ".mono-agent-runtime.json"),
    privateDirectories: [
      monoAgentRoot,
      runtimesRoot,
      appRuntimeRoot,
      versionRoot,
      versionAbiRoot,
      installRoot,
    ],
  };
}

function runtimeMarkerFromJson(value: unknown): RuntimeMarker | undefined {
  const marker = jsonRecord(value);
  const markerKeys = marker?.schema === "mono-agent.managed-runtime.v5"
    ? [...MARKER_COMMON_KEYS, "reuseProofSha256"]
    : MARKER_COMMON_KEYS;
  if (marker === undefined
    || Object.keys(marker).length !== markerKeys.length
    || !markerKeys.every((key) => Object.hasOwn(marker, key))) {
    return undefined;
  }
  const installedAtMs = typeof marker.installedAt === "string" ? Date.parse(marker.installedAt) : Number.NaN;
  if (
    !MARKER_SCHEMAS.has(String(marker.schema))
    || marker.packageName !== PACKAGE_NAME
    || typeof marker.packageVersion !== "string"
    || !EXACT_VERSION_PATTERN.test(marker.packageVersion)
    || typeof marker.cliSha256 !== "string"
    || !HASH_PATTERN.test(marker.cliSha256)
    || typeof marker.sourceClosureSha256 !== "string"
    || !HASH_PATTERN.test(marker.sourceClosureSha256)
    || typeof marker.closureManifestSha256 !== "string"
    || !HASH_PATTERN.test(marker.closureManifestSha256)
    || typeof marker.executionProofSha256 !== "string"
    || !HASH_PATTERN.test(marker.executionProofSha256)
    || (marker.schema === "mono-agent.managed-runtime.v5"
      && (typeof marker.reuseProofSha256 !== "string" || !HASH_PATTERN.test(marker.reuseProofSha256)))
    || typeof marker.nodeAbi !== "string"
    || typeof marker.platform !== "string"
    || typeof marker.arch !== "string"
    || typeof marker.installedAt !== "string"
    || !Number.isFinite(installedAtMs)
    || new Date(installedAtMs).toISOString() !== marker.installedAt
    || marker.installedAt === PROVISIONAL_INSTALLED_AT
  ) {
    return undefined;
  }
  return marker as unknown as RuntimeMarker;
}

async function captureDirectoryProofs(
  paths: readonly string[],
  ownerPrivate: boolean,
): Promise<readonly DirectoryProof[]> {
  const proofs: DirectoryProof[] = [];
  for (const path of paths) {
    const details = await lstat(path, { bigint: true });
    assertDirectory(details, ownerPrivate);
    proofs.push({ path, details, ownerPrivate });
  }
  return proofs;
}

async function verifyDirectoryProofs(proofs: readonly DirectoryProof[]): Promise<void> {
  for (const proof of proofs) {
    const current = await lstat(proof.path, { bigint: true });
    assertDirectory(current, proof.ownerPrivate);
    if (!sameIdentity(proof.details, current)) throw new Error("managed runtime directory changed");
  }
}

function assertDirectory(details: BigIntStats, ownerPrivate: boolean): void {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (
    !details.isDirectory()
    || details.isSymbolicLink()
    || (currentUid !== undefined && details.uid !== currentUid)
    || (ownerPrivate && (details.mode & 0o077n) !== 0n)
  ) {
    throw new Error("unsafe managed runtime directory");
  }
}

async function readStableFile(path: string, maxBytes: number, ownerPrivate: boolean): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW ?? 0)
    | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    assertFile(before, maxBytes, ownerPrivate);
    const contents = await handle.readFile();
    const [after, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    assertFile(after, maxBytes, ownerPrivate);
    assertFile(named, maxBytes, ownerPrivate);
    if (!sameIdentity(before, after) || !sameIdentity(before, named)) {
      throw new Error("managed runtime file changed");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function assertFile(details: BigIntStats, maxBytes: number, ownerPrivate: boolean): void {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1n
    || details.size > BigInt(maxBytes)
    || (currentUid !== undefined && details.uid !== currentUid)
    || (ownerPrivate && (details.mode & 0o077n) !== 0n)
  ) {
    throw new Error("unsafe managed runtime file");
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
