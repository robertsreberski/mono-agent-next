import { basename, dirname, join } from "node:path";

import type { ServiceMacosServiceConfig } from "./config.js";

export interface ServiceMacosRuntimePaths {
  readonly nodePath: string;
  readonly runnerScriptPath: string;
  readonly launchAgentsDirectory: string;
  readonly uid: number;
}

export interface ServiceMacosTarget {
  readonly serviceId: string;
  readonly label: string;
  readonly plistPath: string;
  readonly launchdDomain: string;
  readonly launchdTarget: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
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
  });
}

export function renderServicePlist(
  target: ServiceMacosTarget,
  service: ServiceMacosServiceConfig,
  runtime: ServiceMacosRuntimePaths,
): string {
  const args = [
    runtime.nodePath,
    runtime.runnerScriptPath,
    "run-service",
    "--config",
    service.agentConfig,
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
  <string>${xml(dirname(service.agentConfig))}</string>
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
