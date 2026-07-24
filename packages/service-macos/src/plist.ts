import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ServiceMacosLogsConfig, ServiceMacosServiceConfig } from "./config.js";
export interface ServiceMacosRuntimePaths {
  readonly nodePath: string; readonly runnerScriptPath: string;
  readonly launchAgentsDirectory: string; readonly uid: number;
}
export interface ServiceMacosTarget {
  readonly serviceId: string; readonly label: string; readonly plistPath: string;
  readonly launchdDomain: string; readonly launchdTarget: string;
  readonly stdoutPath: string; readonly stderrPath: string; readonly readinessPath: string;
}
export interface ServiceRunnerBinding {
  readonly targetKind: ServiceMacosServiceConfig["target"]["kind"];
  readonly targetConfig: string;
  readonly targetConfigDigest: string;
  readonly directDependencyName: "@mono-agent/core" | "@mono-agent/web";
  readonly directDependencyVersion: string;
  readonly packageManifestDigest: string;
  readonly lockfilePath: string; readonly lockfileDigest: string;
  readonly nodePath: string; readonly nodeDigest: string;
  readonly runnerScriptPath: string; readonly runnerScriptDigest: string;
  readonly logsDirectoryIdentity: string;
  readonly environmentFileDigest?: string;
}
export interface ServiceRunnerActivation {
  readonly schemaVersion: 1;
  readonly binding: ServiceRunnerBinding;
  readonly logs: ServiceMacosLogsConfig & {
    readonly directoryIdentity: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
    readonly readinessPath: string;
  };
}
export interface EncodedServiceRunnerActivation {
  readonly encoded: string; readonly readinessToken: string;
}
export function serviceTarget(serviceId: string, service: ServiceMacosServiceConfig, runtime: ServiceMacosRuntimePaths): ServiceMacosTarget {
  const label = `ai.mono-agent.${serviceId}`;
  const launchdDomain = `gui/${String(runtime.uid)}`;
  return Object.freeze({
    serviceId,
    label,
    plistPath: join(runtime.launchAgentsDirectory, `${label}.plist`),
    launchdDomain,
    launchdTarget: `${launchdDomain}/${label}`,
    stdoutPath: join(service.logs.directory, `${serviceId}.stdout.log`),
    stderrPath: join(service.logs.directory, `${serviceId}.stderr.log`),
    readinessPath: join(service.logs.directory, `${serviceId}.ready.json`),
  });
}
export function renderServicePlist(
  target: ServiceMacosTarget,
  service: ServiceMacosServiceConfig,
  runtime: ServiceMacosRuntimePaths,
  binding: ServiceRunnerBinding,
): string {
  const activation = encodeServiceRunnerActivation(target, service.logs, binding);
  const args = [
    runtime.nodePath,
    runtime.runnerScriptPath,
    "run-service",
    "--config",
    service.target.config,
    "--activation",
    activation.encoded,
    ...(service.environmentFile === undefined ? [] : ["--environment-file", service.environmentFile]),
  ];
  const keepAlive = service.restartPolicy === "always"
    ? "<true/>"
    : service.restartPolicy === "on-failure"
      ? "<dict><key>SuccessfulExit</key><false/></dict>"
      : "<false/>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(target.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(dirname(service.target.config))}</string>
  <key>RunAtLoad</key>
  ${service.startAtLogin ? "<true/>" : "<false/>"}
  <key>KeepAlive</key>
  ${keepAlive}
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(target.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(target.stderrPath)}</string>
</dict>
</plist>
`;
}
export function encodeServiceRunnerActivation(
  target: ServiceMacosTarget,
  logs: ServiceMacosLogsConfig,
  binding: ServiceRunnerBinding,
): EncodedServiceRunnerActivation {
  const runnerBinding: ServiceRunnerBinding = Object.freeze({
    targetKind: binding.targetKind,
    targetConfig: binding.targetConfig,
    targetConfigDigest: binding.targetConfigDigest,
    directDependencyName: binding.directDependencyName,
    directDependencyVersion: binding.directDependencyVersion,
    packageManifestDigest: binding.packageManifestDigest,
    lockfilePath: binding.lockfilePath,
    lockfileDigest: binding.lockfileDigest,
    nodePath: binding.nodePath,
    nodeDigest: binding.nodeDigest,
    runnerScriptPath: binding.runnerScriptPath,
    runnerScriptDigest: binding.runnerScriptDigest,
    logsDirectoryIdentity: binding.logsDirectoryIdentity,
    ...(binding.environmentFileDigest === undefined ? {} : {
      environmentFileDigest: binding.environmentFileDigest,
    }),
  });
  const activation: ServiceRunnerActivation = Object.freeze({
    schemaVersion: 1,
    binding: runnerBinding,
    logs: Object.freeze({
      ...logs,
      directoryIdentity: binding.logsDirectoryIdentity,
      stdoutPath: target.stdoutPath,
      stderrPath: target.stderrPath,
      readinessPath: target.readinessPath,
    }),
  });
  const encoded = Buffer.from(JSON.stringify(activation)).toString("base64url");
  return Object.freeze({
    encoded,
    readinessToken: createHash("sha256").update(encoded).digest("hex"),
  });
}
export function assertRuntimePaths(runtime: ServiceMacosRuntimePaths): void {
  for (const [field, path] of Object.entries({
    nodePath: runtime.nodePath,
    runnerScriptPath: runtime.runnerScriptPath,
    launchAgentsDirectory: runtime.launchAgentsDirectory,
  })) {
    if (!path.startsWith("/") || path.includes("\u0000")) throw new Error(`${field} must be an absolute path.`);
  }
  if (!Number.isSafeInteger(runtime.uid) || runtime.uid < 0) throw new Error("uid must be a non-negative integer.");
  if (basename(runtime.runnerScriptPath).length === 0) throw new Error("runnerScriptPath must name a file.");
}
function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
