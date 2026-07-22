import { userInfo } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLaunchdMaintenancePlistXml,
  buildLaunchdMaintenanceProgramArguments,
  buildPlistXml,
  buildLaunchdProgramArguments,
  buildWebLaunchdProgramArguments,
  buildWebPlistXml,
  defaultPathEnv,
  deriveLaunchdLabel,
  deriveLaunchdMaintenanceLabel,
  domainTarget,
  escapeXml,
  launchdMaintenancePathsFor,
  launchdPathsFor,
  MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV,
  parseLaunchdManagedWorkerDefinition,
  parseLaunchdServicePid,
  serviceTarget,
} from "../launchd.js";
import type { MaintenancePlistInput, PlistInput, WebPlistInput } from "../launchd.js";

function plistInput(overrides: Partial<PlistInput> = {}): PlistInput {
  return {
    label: "com.mono-agent.demo-0a1b2c3d",
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/app/dist/cli.js",
    configPath: "/work/demo/mono-agent.config.json",
    cwd: "/work/demo",
    expectedBackgroundSnapshot: "approved-background-snapshot",
    expectedManagedRuntimeLaunch: "finalized-runtime-proof",
    stdoutPath: "/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.out.log",
    stderrPath: "/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.err.log",
    environment: { PATH: "/usr/bin:/bin" },
    ...overrides,
  };
}

function maintenanceInput(overrides: Partial<MaintenancePlistInput> = {}): MaintenancePlistInput {
  return {
    label: "com.mono-agent-maintenance.demo-0a1b2c3d",
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/app/dist/cli.js",
    configPath: "/work/demo/mono-agent.config.json",
    cwd: "/work/demo",
    controllerCliPath: "/checkout/packages/agent-app/dist/cli.js",
    agentCwd: "/work/demo",
    agentPath: "/custom/bin:/usr/bin:/bin",
    environment: {
      PATH: "/usr/bin:/bin",
      [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1",
    },
    intervalSeconds: 300,
    ...overrides,
  };
}

function webInput(overrides: Partial<WebPlistInput> = {}): WebPlistInput {
  return {
    label: "com.mono-agent-web",
    nodePath: "/managed/bin/node",
    cliPath: "/managed/node_modules/@mono-agent/agent-app/dist/cli.js",
    cwd: "/home/u/.mono-agent/web",
    host: "0.0.0.0",
    port: 5050,
    stdoutPath: "/home/u/.mono-agent/web/logs/web.out.log",
    stderrPath: "/home/u/.mono-agent/web/logs/web.err.log",
    environment: { HOME: "/home/u", PATH: "/usr/bin:/bin" },
    ...overrides,
  };
}

describe("deriveLaunchdLabel", () => {
  it("is deterministic for the same resolved config path", () => {
    const a = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    const b = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    expect(a).toBe(b);
  });

  it("differs for different config paths and only uses launchd-legal chars", () => {
    const a = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    const b = deriveLaunchdLabel("/work/other/mono-agent.config.json");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^com\.mono-agent\.[a-z0-9-]+-[0-9a-f]{8}$/u);
    expect(b).toMatch(/^com\.mono-agent\.[a-z0-9-]+-[0-9a-f]{8}$/u);
  });

  it("sanitizes folder names with spaces, symbols, and casing", () => {
    const label = deriveLaunchdLabel("/work/My Agent & Co!/mono-agent.config.json");
    expect(label).toMatch(/^com\.mono-agent\.my-agent-co-[0-9a-f]{8}$/u);
  });

  it("falls back to 'agent' when the folder sanitizes to empty", () => {
    const label = deriveLaunchdLabel("/&&&/mono-agent.config.json");
    expect(label).toMatch(/^com\.mono-agent\.agent-[0-9a-f]{8}$/u);
  });
});

describe("launchdPathsFor", () => {
  it("places the plist and logs under the home directory", () => {
    const paths = launchdPathsFor("com.mono-agent.demo-0a1b2c3d", "/home/u");
    expect(paths.plistPath).toBe("/home/u/Library/LaunchAgents/com.mono-agent.demo-0a1b2c3d.plist");
    expect(paths.stdoutPath).toBe("/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.out.log");
    expect(paths.stderrPath).toBe("/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.err.log");
    expect(paths.launchAgentsDir).toBe("/home/u/Library/LaunchAgents");
    expect(paths.logDir).toBe("/home/u/.mono-agent/logs");
  });

  it("uses the OS account home instead of an ambient HOME override", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/untrusted-mono-agent-home";
    try {
      const paths = launchdPathsFor("com.mono-agent.demo-0a1b2c3d");
      const accountHome = userInfo().homedir;
      expect(paths.launchAgentsDir).toBe(resolve(accountHome, "Library", "LaunchAgents"));
      expect(paths.logDir).toBe(resolve(accountHome, ".mono-agent", "logs"));
      expect(paths.launchAgentsDir).not.toContain(process.env.HOME);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});

describe("launchd maintenance identity", () => {
  it("derives a stable helper label outside fleet instance discovery", () => {
    const main = "com.mono-agent.demo-0a1b2c3d";
    expect(deriveLaunchdMaintenanceLabel(main)).toBe("com.mono-agent-maintenance.demo-0a1b2c3d");
    expect(deriveLaunchdMaintenanceLabel(main)).not.toMatch(/^com\.mono-agent\./u);
    expect(() => deriveLaunchdMaintenanceLabel("org.example.agent")).toThrow(/canonical mono-agent label/u);
    expect(() => deriveLaunchdMaintenanceLabel("com.mono-agent.")).toThrow(/canonical mono-agent label/u);
    expect(() => deriveLaunchdMaintenanceLabel("com.mono-agent.Demo"))
      .toThrow(/canonical mono-agent label/u);
  });

  it("places the helper plist beside the main LaunchAgent", () => {
    expect(launchdMaintenancePathsFor("com.mono-agent.demo-0a1b2c3d", "/home/u")).toEqual({
      label: "com.mono-agent-maintenance.demo-0a1b2c3d",
      plistPath: "/home/u/Library/LaunchAgents/com.mono-agent-maintenance.demo-0a1b2c3d.plist",
    });
  });
});

describe("escapeXml", () => {
  it("escapes all five XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("buildPlistXml", () => {
  it("clears launchd's inherited environment before running the foreground worker", () => {
    const xml = buildPlistXml(plistInput());
    expect(xml).toContain("<string>/usr/bin/env</string>");
    expect(xml).toContain("<string>-i</string>");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/app/dist/cli.js</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--foreground</string>");
    expect(xml).toContain("<string>--config</string>");
    expect(xml).toContain("<string>/work/demo/mono-agent.config.json</string>");
    // Argument order: env, -i, explicit values, node, cli, start, flags.
    expect(xml.indexOf("/usr/bin/env")).toBeLessThan(xml.indexOf("-i"));
    expect(xml.indexOf("-i")).toBeLessThan(xml.indexOf("PATH=/usr/bin:/bin"));
    expect(xml.indexOf("PATH=/usr/bin:/bin")).toBeLessThan(xml.indexOf("/usr/local/bin/node"));
    expect(xml.indexOf("start")).toBeLessThan(xml.indexOf("--foreground"));
    expect(xml.indexOf("--foreground")).toBeLessThan(xml.indexOf("--config"));
    expect(xml).toContain("<string>--expected-background-snapshot</string>");
    expect(xml).toContain("<string>approved-background-snapshot</string>");
    expect(xml).toContain("<string>--expected-managed-runtime-launch</string>");
    expect(xml).toContain("<string>finalized-runtime-proof</string>");
  });

  it("passes --env-file to the worker when set", () => {
    const xml = buildPlistXml(plistInput({ envFile: "/work/demo/.env.local" }));
    expect(xml).toContain("<string>--env-file</string>");
    expect(xml).toContain("<string>/work/demo/.env.local</string>");
    expect(buildPlistXml(plistInput())).not.toContain("--env-file");
  });

  it("restarts only on crash and runs at load", () => {
    const xml = buildPlistXml(plistInput());
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
    expect(xml).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(xml).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
  });

  it("restores only explicit operational values as env -i arguments", () => {
    const xml = buildPlistXml(plistInput({
      environment: { HOME: "/home/u", PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
    }));
    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<string>HOME=/home/u</string>");
    expect(xml).toContain("<string>PATH=/usr/bin:/bin:/opt/homebrew/bin</string>");
    expect(xml.indexOf("HOME=/home/u")).toBeLessThan(xml.indexOf("PATH=/usr/bin"));
  });

  it("sorts mixed-case environment names by code unit independent of host locale", () => {
    const args = buildLaunchdProgramArguments(plistInput({
      environment: {
        ComSpec: "/second",
        COMSPEC: "/first",
        PATH: "/usr/bin:/bin",
      },
    }));
    expect(args.slice(2, 5)).toEqual([
      "COMSPEC=/first",
      "ComSpec=/second",
      "PATH=/usr/bin:/bin",
    ]);
  });

  it("XML-escapes paths that contain ampersands", () => {
    const xml = buildPlistXml(plistInput({ cwd: "/work/A & B", configPath: "/work/A & B/mono-agent.config.json" }));
    expect(xml).toContain("<string>/work/A &amp; B</string>");
    expect(xml).not.toMatch(/<string>[^<]*\s&\s[^<]*<\/string>/u);
  });

  it.each([
    ["config path", { configPath: "/work/agent\nprivate/config.json" }],
    ["working directory", { cwd: "/work/agent\tprivate" }],
    ["environment value", { environment: { PATH: "/usr/bin\n/private" } }],
    ["log path", { stdoutPath: "/tmp/agent\rprivate.log" }],
  ])("rejects controls in %s before writing a managed plist", (_label, overrides) => {
    expect(() => buildPlistXml(plistInput(overrides))).toThrow(/must not contain control characters/u);
  });

  it("rejects environment names outside the producer/checker grammar", () => {
    expect(() => buildLaunchdProgramArguments(plistInput({
      environment: { "PATH=shadow": "/private", PATH: "/usr/bin:/bin" },
    }))).toThrow(/portable identifier grammar/u);
  });
});

describe("buildWebPlistXml", () => {
  it("runs the web worker through env -i with only explicit operational values", () => {
    const args = buildWebLaunchdProgramArguments(webInput());
    expect(args).toEqual([
      "/usr/bin/env",
      "-i",
      "HOME=/home/u",
      "PATH=/usr/bin:/bin",
      "/managed/bin/node",
      "/managed/node_modules/@mono-agent/agent-app/dist/cli.js",
      "web",
      "run",
      "--host",
      "0.0.0.0",
      "--port",
      "5050",
    ]);
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("MONO_AGENT_WEB_AUTH_TOKEN");
  });

  it("keeps the console label outside agent fleet discovery and emits KeepAlive launchd XML", () => {
    const input = webInput();
    expect(input.label).not.toMatch(/^com\.mono-agent\./u);
    const xml = buildWebPlistXml(input);
    expect(xml).toContain("<string>com.mono-agent-web</string>");
    expect(xml).toContain("<string>web</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
  });

  it("rejects an ephemeral or out-of-range managed port", () => {
    expect(() => buildWebPlistXml(webInput({ port: 0 }))).toThrow(/between 1 and 65535/u);
    expect(() => buildWebPlistXml(webInput({ port: 65_536 }))).toThrow(/between 1 and 65535/u);
  });
});

describe("buildLaunchdMaintenancePlistXml", () => {
  it("pins a closed one-shot command with no helper logs or KeepAlive", () => {
    const input = maintenanceInput();
    const args = buildLaunchdMaintenanceProgramArguments(input);
    const xml = buildLaunchdMaintenancePlistXml(input);

    expect(args).toEqual([
      "/usr/bin/env",
      "-i",
      `${MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV}=1`,
      "PATH=/usr/bin:/bin",
      "/usr/local/bin/node",
      "/opt/app/dist/cli.js",
      "__launchd-log-maintenance",
      "--config",
      "/work/demo/mono-agent.config.json",
      "--controller-cli",
      "/checkout/packages/agent-app/dist/cli.js",
      "--agent-cwd",
      "/work/demo",
      "--agent-path",
      "/custom/bin:/usr/bin:/bin",
    ]);
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>StartInterval</key>\n  <integer>300</integer>");
    expect(xml).toContain("<key>StandardOutPath</key>\n  <string>/dev/null</string>");
    expect(xml).toContain("<key>StandardErrorPath</key>\n  <string>/dev/null</string>");
    expect(xml).not.toContain("<key>KeepAlive</key>");
    expect(xml).not.toContain("--env-file");
    expect(xml).not.toContain("--expected-background-snapshot");
  });

  it("rejects invalid intervals and control characters", () => {
    expect(() => buildLaunchdMaintenancePlistXml(maintenanceInput({ intervalSeconds: 0 })))
      .toThrow(/positive safe integer/u);
    expect(() => buildLaunchdMaintenancePlistXml(maintenanceInput({ cwd: "/work/bad\npath" })))
      .toThrow(/control characters/u);
  });
});

describe("parseLaunchdServicePid", () => {
  it("extracts a positive top-level pid from launchctl print output", () => {
    expect(parseLaunchdServicePid("service = {\n\tpid = 4321\n\tlast exit code = 0\n}\n")).toBe(4321);
  });

  it("rejects absent, zero, and inline pid-like noise", () => {
    expect(parseLaunchdServicePid("state = waiting\n")).toBeUndefined();
    expect(parseLaunchdServicePid("pid = 0\n")).toBeUndefined();
    expect(parseLaunchdServicePid("note = pid = 999\n")).toBeUndefined();
  });
});

describe("parseLaunchdManagedWorkerDefinition", () => {
  function launchctlPrint(input: PlistInput): string {
    const args = buildLaunchdProgramArguments(input).map((argument) => `\t\t${argument}`).join("\n");
    return `gui/501/${input.label} = {\n`
      + `\tpath = /home/u/Library/LaunchAgents/${input.label}.plist\n`
      + "\tprogram = /usr/bin/env\n"
      + `\targuments = {\n${args}\n\t}\n`
      + `\tworking directory = ${input.cwd}\n`
      + `\tstdout path = ${input.stdoutPath}\n`
      + `\tstderr path = ${input.stderrPath}\n`
      + "\tpid = 4321\n}\n";
  }

  it("strictly reads the exact loaded managed-worker definition", () => {
    const input = plistInput({
      envFile: "/work/demo/.env.production",
      environment: { MONO_AGENT_MANAGED_WORKER: "1", PATH: "/usr/bin:/bin" },
    });
    expect(parseLaunchdManagedWorkerDefinition(launchctlPrint(input))).toEqual({
      plistPath: `/home/u/Library/LaunchAgents/${input.label}.plist`,
      nodePath: input.nodePath,
      cliPath: input.cliPath,
      configPath: input.configPath,
      cwd: input.cwd,
      envFile: input.envFile,
      expectedBackgroundSnapshot: input.expectedBackgroundSnapshot,
      expectedManagedRuntimeLaunch: input.expectedManagedRuntimeLaunch,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      environment: input.environment,
    });
  });

  it("rejects loaded definitions missing the runtime proof or carrying an unknown environment", () => {
    const input = plistInput({
      environment: { MONO_AGENT_MANAGED_WORKER: "1", PATH: "/usr/bin:/bin" },
    });
    const valid = launchctlPrint(input);
    expect(parseLaunchdManagedWorkerDefinition(
      valid.replace(/\n\t\t--expected-managed-runtime-launch\n\t\tfinalized-runtime-proof/u, ""),
    )).toBeUndefined();
    expect(parseLaunchdManagedWorkerDefinition(
      valid.replace("\t\tPATH=/usr/bin:/bin", "\t\tPRIVATE_TOKEN=secret\n\t\tPATH=/usr/bin:/bin"),
    )).toBeUndefined();
  });
});

describe("defaultPathEnv", () => {
  it("falls back to a sane PATH when none is present", () => {
    expect(defaultPathEnv({})).toContain("/usr/bin");
    expect(defaultPathEnv({})).toContain("/opt/homebrew/bin");
  });

  it("keeps the current PATH first and appends missing extras", () => {
    const result = defaultPathEnv({ PATH: "/custom/bin" });
    expect(result.startsWith("/custom/bin")).toBe(true);
    expect(result).toContain("/opt/homebrew/bin");
  });

  it("does not duplicate extras already present", () => {
    const result = defaultPathEnv({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(result.split(":").filter((part) => part === "/opt/homebrew/bin")).toHaveLength(1);
  });
});

describe("launchctl targets", () => {
  it("builds gui domain and service targets", () => {
    expect(domainTarget(501)).toBe("gui/501");
    expect(serviceTarget("com.mono-agent.demo-0a1b2c3d", 501)).toBe("gui/501/com.mono-agent.demo-0a1b2c3d");
  });
});
