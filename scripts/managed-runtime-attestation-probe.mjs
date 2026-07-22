#!/usr/bin/env node

import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const UNSAFE = '{"schemaVersion":1,"status":"unsafe"}\n';

function absoluteSafe(value) {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

export function parseManagedRuntimeAttestationProbeArgs(argv) {
  const [repo, runtimeCliPath, cwd, configPath, envFile, expectedSnapshot, nodeAbi, ...extra] = argv;
  if (extra.length > 0
    || !absoluteSafe(repo)
    || !absoluteSafe(runtimeCliPath)
    || !absoluteSafe(cwd)
    || !absoluteSafe(configPath)
    || !(envFile === "" || absoluteSafe(envFile))
    || typeof expectedSnapshot !== "string"
    || !/^[A-Za-z0-9_-]+$/u.test(expectedSnapshot)
    || typeof nodeAbi !== "string"
    || !/^\d+$/u.test(nodeAbi)) {
    return null;
  }
  return { repo, runtimeCliPath, cwd, configPath, envFile, expectedSnapshot, nodeAbi };
}

/**
 * Content-free read-only bridge between the fleet checker and the built
 * agent-app's managed-runtime/snapshot contracts.
 */
export async function runManagedRuntimeAttestationProbe(
  argv = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
) {
  const parsed = parseManagedRuntimeAttestationProbeArgs(argv);
  if (parsed === null) {
    stdout.write(UNSAFE);
    return 1;
  }
  const { repo, runtimeCliPath, cwd, configPath, envFile, expectedSnapshot, nodeAbi } = parsed;

  try {
    const dist = join(repo, "packages", "agent-app", "dist");
    const [runtimeModule, snapshotModule, snapshotKeyModule, packagesModule] = await Promise.all([
      import(pathToFileURL(join(dist, "background-runtime.js")).href),
      import(pathToFileURL(join(dist, "background-snapshot.js")).href),
      import(pathToFileURL(join(dist, "background-snapshot-key.js")).href),
      import(pathToFileURL(join(dist, "managed-runtime-packages.js")).href),
    ]);
    const proofKey = await snapshotKeyModule.loadBackgroundSnapshotKey(configPath);
    const durableInputs = await snapshotModule.captureDurableBackgroundInputs({
      cwd,
      configPath,
      ...(envFile === "" ? {} : { envFile }),
      operationalEnvironment: environment,
      proofKey,
    });
    const expected = snapshotModule.decodeBackgroundSnapshot(expectedSnapshot);
    if (JSON.stringify(durableInputs.snapshot) !== JSON.stringify(expected)) {
      stdout.write(UNSAFE);
      return 1;
    }
    const additionalPackages = await packagesModule.resolveConfiguredManagedRuntimePackages({
      cwd,
      configPath,
      env: durableInputs.environment,
    });
    const attestation = await runtimeModule.attestManagedBackgroundRuntime({
      currentCliPath: join(repo, "packages", "agent-app", "dist", "cli.js"),
      runtimeCliPath,
      nodeAbi,
      packageSource: join(repo, "packages", "agent-app"),
      additionalPackages,
    });
    if (attestation?.schema !== "mono-agent.managed-runtime-attestation.v1"
      || typeof attestation.fingerprint !== "string"
      || !/^[0-9a-f]{64}$/u.test(attestation.fingerprint)
      || typeof attestation.installedAt !== "string"
      || !Number.isFinite(Date.parse(attestation.installedAt))
      || new Date(Date.parse(attestation.installedAt)).toISOString() !== attestation.installedAt
      || Object.keys(attestation).length !== 3) {
      stdout.write(UNSAFE);
      return 1;
    }
    stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "ok",
      fingerprint: attestation.fingerprint,
      installedAt: attestation.installedAt,
    })}\n`);
    return 0;
  } catch {
    stdout.write(UNSAFE);
    return 1;
  }
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) process.exitCode = await runManagedRuntimeAttestationProbe();
