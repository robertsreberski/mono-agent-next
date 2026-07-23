import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentValidationResult } from "@mono-agent/core";

import {
  LAUNCHCTL_PATH,
  ServiceMacosDriftError,
  ServiceMacosMutationDisabledError,
  applyServiceMacosPlan,
  inspectServiceMacos,
  parseServiceMacosConfig,
  planServiceMacos,
  planServiceMacosRemoval,
  recoverServiceMacosTransactions,
  removeServiceMacosPlan,
  runServiceMacosCli,
  type CommandResult,
  type CommandRunner,
  type ServiceMacosRuntimePaths,
} from "../index.js";
import {
  SimulatedServiceMacosCrash,
  installServiceMacosTransactionTestHook,
} from "../transaction-test-hooks.js";
import { bindServiceLogs, maintainServiceLogs, readServiceReadiness, resetServiceLogs, writeServiceReadiness } from "../logs.js";

const validAgent = async (): Promise<AgentValidationResult> => ({ ok: true, issues: [] });
const FAKE_SERVICE_PID = 2_147_483_647;

afterEach(() => {
  installServiceMacosTransactionTestHook(undefined);
});

describe("service-macos config", () => {
  it("strictly accepts the v1 desired-state shape", () => {
    expect(parseServiceMacosConfig({
      configVersion: 1,
      services: {
        "personal-agent": {
          agentConfig: "/Users/example/personal-agent/mono-agent.config.json",
          startAtLogin: true,
          restartPolicy: "on-failure",
          logs: { directory: "/Users/example/.mono-agent/logs" },
        },
      },
    }).services["personal-agent"]).toMatchObject({
      startAtLogin: true,
      restartPolicy: "on-failure",
      logs: { maxBytes: 10_485_760, retainFiles: 5 },
    });
    expect(() => parseServiceMacosConfig({ configVersion: 1, services: {}, inferred: true })).toThrow(/unknown field/u);
    expect(() => parseServiceMacosConfig({
      configVersion: 1,
      services: { bad: { agentConfig: "relative.json", startAtLogin: true, restartPolicy: "always", logs: { directory: "/tmp" } } },
    })).toThrow(/absolute path/u);
  });
});

describe("service-macos reconciliation", () => {
  it("keeps inspect and plan filesystem-read-only while binding exact targets and inputs", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.root);
    const observations = await inspectServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    });
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const after = await snapshot(fixture.root);
    expect(after).toEqual(before);
    expect(observations[0]).toMatchObject({
      target: {
        serviceId: "personal-agent",
        label: "ai.mono-agent.personal-agent",
        plistPath: join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist"),
        launchdDomain: `gui/${String(fixture.runtime.uid)}`,
        launchdTarget: `gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`,
      },
      file: { exists: false },
      loaded: false,
    });
    expect(plan.entries[0]).toMatchObject({ action: "create" });
    expect(plan.fingerprint).toMatch(/^service-macos:v1:[a-f0-9]{64}$/u);
    expect(plan.entries[0]?.desiredPlist).toContain(`<string>${fixture.runtime.nodePath}</string>`);
    expect(fixture.runner.calls.every((call) => call.command === LAUNCHCTL_PATH && call.arguments_[0] === "print")).toBe(true);
  });

  it("requires explicit mutation authorization and performs argument-vector launchctl calls", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const before = await snapshot(fixture.root);
    fixture.runner.calls.length = 0;
    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    })).rejects.toBeInstanceOf(ServiceMacosMutationDisabledError);
    expect(await snapshot(fixture.root)).toEqual(before);
    expect(fixture.runner.calls).toHaveLength(0);

    const observations = await applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    });
    const plistPath = plan.entries[0]!.target.plistPath;
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    expect(observations[0]).toMatchObject({ file: { exists: true }, loaded: true });
    expect(fixture.runner.calls).toContainEqual({
      command: LAUNCHCTL_PATH,
      arguments_: ["bootstrap", `gui/${String(fixture.runtime.uid)}`, plistPath],
    });
  });

  it("does not clobber an operator change after planning", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const plistPath = plan.entries[0]!.target.plistPath;
    await writeFile(plistPath, "operator-owned-change", { mode: 0o600 });
    fixture.runner.calls.length = 0;
    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toBeInstanceOf(ServiceMacosDriftError);
    expect(await readFile(plistPath, "utf8")).toBe("operator-owned-change");
    expect(fixture.runner.calls.every((call) => call.arguments_[0] === "print")).toBe(true);
  });

  it("rejects replacement of the planned LaunchAgents directory before mutation", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const originalDirectory = `${fixture.runtime.launchAgentsDirectory}.planned`;
    await rename(fixture.runtime.launchAgentsDirectory, originalDirectory);
    await mkdir(fixture.runtime.launchAgentsDirectory, { mode: 0o700 });
    fixture.runner.calls.length = 0;

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/protected directory changed after planning/iu);
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([]);
    expect(fixture.runner.calls).toHaveLength(0);
  });

  it("refuses to stop a loaded label that has no managed plist", async () => {
    const fixture = await createFixture();
    fixture.runner.loaded.add(`gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`);
    await expect(planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    })).rejects.toThrow(/no managed plist/u);
    expect(fixture.runner.calls.every((call) => call.arguments_[0] === "print")).toBe(true);
  });

  it("validates with a protected environment but never expands its secret into the plan or plist", async () => {
    const fixture = await createFixture();
    const environmentFile = join(fixture.root, ".env");
    const secret = "not-for-plist-7ab247";
    await writeFile(environmentFile, `SERVICE_MACOS_TEST_SECRET=${secret}\n`, { mode: 0o600 });
    const raw = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    raw.services["personal-agent"]!.environmentFile = environmentFile;
    await writeFile(fixture.configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    let validatedSecret: string | undefined;
    const ambient = process.env.SERVICE_MACOS_TEST_SECRET;
    process.env.SERVICE_MACOS_TEST_SECRET = "ambient-must-not-win";
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner,
      async validateAgent(_path, options) {
        validatedSecret = options?.environment?.SERVICE_MACOS_TEST_SECRET;
        return { ok: true, issues: [] };
      },
    }).finally(() => {
      if (ambient === undefined) delete process.env.SERVICE_MACOS_TEST_SECRET;
      else process.env.SERVICE_MACOS_TEST_SECRET = ambient;
    });
    expect(validatedSecret).toBe(secret);
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(plan.entries[0]?.desiredPlist).toContain(environmentFile);
    expect(plan.entries[0]?.binding.environmentFileDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("restores the prior plist when replacement activation fails", async () => {
    const fixture = await createFixture();
    const installed = await installManagedFixture(fixture);
    const plistPath = installed.entries[0]!.target.plistPath;
    const prior = await readFile(plistPath, "utf8");
    await mutateAgent(fixture, "replacement");
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    fixture.runner.failNextBootstrap = true;
    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/bootstrap/u);
    expect(await readFile(plistPath, "utf8")).toBe(prior);
    expect(fixture.runner.loaded).toContain(`gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`);
  });

  it("rolls back a launchd-loaded runner that exits before exact-input readiness", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    fixture.runner.unhealthyPrints = 1;
    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/exited before readiness/u);
    await expect(access(plan.entries[0]!.target.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.runner.loaded).not.toContain(plan.entries[0]!.target.launchdTarget);
  });

  it("does not report an unhealthy already-desired service as a noop success", async () => {
    const fixture = await createFixture();
    const install = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    });
    await applyServiceMacosPlan(install, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent, allowMutation: true,
    });
    const noop = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    });
    expect(noop.entries[0]?.action).toBe("noop");
    fixture.runner.unhealthyPrints = 2;
    await expect(applyServiceMacosPlan(noop, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent, allowMutation: true,
    })).rejects.toThrow(/Observed launchd or plist state drifted/u);
  });

  it("makes the runner reject config mutation between plan and bootstrap", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const encoded = /<string>--activation<\/string>\s*<string>([A-Za-z0-9_-]+)<\/string>/u
      .exec(plan.entries[0]!.desiredPlist)?.[1];
    expect(encoded).toBeDefined();
    const agentConfig = plan.entries[0]!.service.agentConfig;
    await writeFile(agentConfig, "{\"changed\":true}\n", { mode: 0o600 });
    let stderr = "";
    await expect(runServiceMacosCli([
      "run-service", "--config", agentConfig, "--activation", encoded!,
    ], {
      stderr: (value) => { stderr += value; },
    })).resolves.toBe(1);
    expect(stderr).toMatch(/Runner inputs do not match the planned activation/u);
  });

  it("rejects writable service, agent, environment, and runtime inputs", async () => {
    const service = await createFixture();
    await chmod(service.configPath, 0o666);
    await expect(inspectServiceMacos(service.configPath, {
      runtime: service.runtime,
      runner: service.runner,
    })).rejects.toThrow(/protected/u);

    const agent = await createFixture();
    const agentPath = join(agent.root, "agent", "mono-agent.config.json");
    await chmod(agentPath, 0o666);
    await expect(planServiceMacos(agent.configPath, {
      runtime: agent.runtime, runner: agent.runner, validateAgent: validAgent,
    })).rejects.toThrow(/protected/u);

    for (const name of ["package.json", "pnpm-lock.yaml"]) {
      const project = await createFixture();
      await chmod(join(project.root, "agent", name), 0o666);
      await expect(planServiceMacos(project.configPath, {
        runtime: project.runtime, runner: project.runner, validateAgent: validAgent,
      })).rejects.toThrow(/protected/u);
    }

    const runtime = await createFixture();
    await chmod(runtime.runtime.runnerScriptPath, 0o666);
    await expect(planServiceMacos(runtime.configPath, {
      runtime: runtime.runtime, runner: runtime.runner, validateAgent: validAgent,
    })).rejects.toThrow(/protected/u);

    const nodeRuntime = await createFixture();
    await chmod(nodeRuntime.runtime.nodePath, 0o666);
    await expect(planServiceMacos(nodeRuntime.configPath, {
      runtime: nodeRuntime.runtime, runner: nodeRuntime.runner, validateAgent: validAgent,
    })).rejects.toThrow(/protected/u);

    const environment = await createFixture();
    const environmentPath = join(environment.root, ".env");
    await writeFile(environmentPath, "TOKEN=value\n", { mode: 0o644 });
    await chmod(environmentPath, 0o644);
    const raw = JSON.parse(await readFile(environment.configPath, "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    raw.services["personal-agent"]!.environmentFile = environmentPath;
    await writeFile(environment.configPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    await expect(planServiceMacos(environment.configPath, {
      runtime: environment.runtime, runner: environment.runner, validateAgent: validAgent,
    })).rejects.toThrow(/protected/u);
  });

  it("enforces configured log rotation, retention, and protected modes", async () => {
    const fixture = await createFixture();
    const stdoutPath = join(fixture.root, "logs", "personal-agent.stdout.log");
    const stderrPath = join(fixture.root, "logs", "personal-agent.stderr.log");
    const directory = await lstat(join(fixture.root, "logs"), { bigint: true });
    const logs = {
      directory: join(fixture.root, "logs"),
      directoryIdentity: [directory.dev, directory.ino, directory.uid, directory.mode & 0o777n].join(":"),
      stdoutPath,
      stderrPath,
      readinessPath: join(fixture.root, "logs", "personal-agent.ready.json"),
      maxBytes: 4,
      retainFiles: 2,
    };
    const proof = "a".repeat(64);
    await writeFile(
      logs.readinessPath,
      `${JSON.stringify({ event: "started", serviceMacosProof: proof, pid: 42 })}\n`,
      { mode: 0o600 },
    );
    expect(await readServiceReadiness(logs, proof, 42, fixture.runtime.uid)).toBe(true);
    await writeServiceReadiness(logs, proof, 43, fixture.runtime.uid);
    expect(await readServiceReadiness(logs, proof, 42, fixture.runtime.uid)).toBe(false);
    expect(await readServiceReadiness(logs, proof, 43, fixture.runtime.uid)).toBe(true);
    for (const value of ["abcdefgh", "ijklmnop", "qrstuvwx"]) {
      await writeFile(stdoutPath, value, { mode: 0o600 });
      await resetServiceLogs(logs, fixture.runtime.uid);
    }
    expect(await readFile(stdoutPath, "utf8")).toBe("");
    let archives = (await readdir(logs.directory)).filter((name) => name.endsWith(".mono-agent-log"));
    expect(archives).toHaveLength(2);
    expect((await Promise.all(archives.map(async (name) => await readFile(join(logs.directory, name), "utf8")))))
      .toEqual(expect.arrayContaining(["mnop", "uvwx"]));

    await writeFile(stdoutPath, "12345", { mode: 0o600 });
    await maintainServiceLogs(logs, fixture.runtime.uid);
    expect(await readFile(stdoutPath, "utf8")).toBe("");
    archives = (await readdir(logs.directory)).filter((name) => name.endsWith(".mono-agent-log"));
    expect(archives).toHaveLength(2);
    await writeFile(stderrPath, "", { mode: 0o600 });
    await expect(bindServiceLogs({ ...logs, retainFiles: 1 }, fixture.runtime.uid)).rejects.toThrow(/retention decrease/u);
    await writeFile(stderrPath, "unsafe", { mode: 0o644 });
    await chmod(stderrPath, 0o644);
    await expect(maintainServiceLogs(logs, fixture.runtime.uid)).rejects.toThrow(/owner-private/u);
  });

  it("ignores foreign archive names and rejects replacement of bound log inputs", async () => {
    const fixture = await createFixture();
    const directory = await lstat(join(fixture.root, "logs"), { bigint: true });
    const stdoutPath = join(fixture.root, "logs", "personal-agent.stdout.log");
    const logs = {
      directory: join(fixture.root, "logs"),
      directoryIdentity: [directory.dev, directory.ino, directory.uid, directory.mode & 0o777n].join(":"),
      stdoutPath, stderrPath: join(fixture.root, "logs", "personal-agent.stderr.log"),
      readinessPath: join(fixture.root, "logs", "personal-agent.ready.json"), maxBytes: 4, retainFiles: 2,
    };
    const operator = `${stdoutPath}.00000000000000000000------------------------------------.mono-agent-log`;
    await writeFile(operator, "operator", { mode: 0o600 });
    await maintainServiceLogs(logs, fixture.runtime.uid);
    expect((await readdir(logs.directory)).filter((name) => /^[^.].*\.mono-agent-log$/u.test(name))).toHaveLength(1);
    expect(await readFile(operator, "utf8")).toBe("operator");

    await writeFile(stdoutPath, "bound live", { mode: 0o600 });
    await writeFile(logs.stderrPath, "", { mode: 0o600 });
    const binding = await bindServiceLogs(logs, fixture.runtime.uid);
    const replacement = join(logs.directory, ".replacement");
    await writeFile(replacement, "operator live replacement", { mode: 0o600 });
    await rename(replacement, stdoutPath);
    await expect(maintainServiceLogs(logs, fixture.runtime.uid, binding)).rejects.toThrow(/bound live log/u);
    expect(await readFile(stdoutPath, "utf8")).toBe("operator live replacement");
    await unlink(stdoutPath);
    await expect(maintainServiceLogs(logs, fixture.runtime.uid, binding)).rejects.toThrow(/disappeared/u);

    const original = `${logs.directory}.original`;
    const victim = join(fixture.root, "victim");
    await rename(logs.directory, original);
    await mkdir(victim, { mode: 0o700 });
    await writeFile(join(victim, "personal-agent.stdout.log"), "victim survives", { mode: 0o600 });
    await symlink(victim, logs.directory);
    await expect(maintainServiceLogs(logs, fixture.runtime.uid)).rejects.toThrow(/planned protected/u);
    expect(await readFile(join(victim, "personal-agent.stdout.log"), "utf8")).toBe("victim survives");
  });

  it("rejects a retention decrease with excess managed slots before mutation", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.root, "logs", "personal-agent.stdout.log.2.mono-agent-log"),
      "retained",
      { mode: 0o600 },
    );
    fixture.runner.calls.length = 0;
    await expect(planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    })).rejects.toThrow(/retention decrease/u);
    expect(fixture.runner.calls.every((call) => call.arguments_[0] === "print")).toBe(true);
  });

  it("kickstarts a valid service configured not to run automatically at login", async () => {
    const fixture = await createFixture();
    const raw = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    raw.services["personal-agent"]!.startAtLogin = false;
    raw.services["personal-agent"]!.restartPolicy = "never";
    await writeFile(fixture.configPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    });
    await applyServiceMacosPlan(plan, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent, allowMutation: true,
    });
    expect(fixture.runner.calls).toContainEqual({
      command: LAUNCHCTL_PATH, arguments_: ["kickstart", plan.entries[0]!.target.launchdTarget],
    });
  });

  it("observes an exited exact job honestly and plans a bounded restart", async () => {
    const fixture = await createFixture();
    const install = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    });
    await applyServiceMacosPlan(install, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent, allowMutation: true,
    });
    const target = install.entries[0]!.target.launchdTarget;
    fixture.runner.exited.add(target);
    const restart = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
    });
    expect(restart.entries[0]).toMatchObject({
      action: "restart", observed: { loaded: true, launchdState: "exited", ready: false },
    });
    await applyServiceMacosPlan(restart, {
      runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent, allowMutation: true,
    });
    expect(fixture.runner.exited).not.toContain(target);
  });

  it("restores the prior loaded service when bootstrap exits zero without retaining it", async () => {
    const fixture = await createFixture();
    const installed = await installManagedFixture(fixture);
    const plistPath = installed.entries[0]!.target.plistPath;
    const prior = await readFile(plistPath, "utf8");
    const priorInode = (await lstat(plistPath, { bigint: true })).ino;
    const target = `gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`;
    await mutateAgent(fixture, "not-retained");
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    fixture.runner.skipNextBootstrapLoad = true;

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/did not retain/u);
    expect(await readFile(plistPath, "utf8")).toBe(prior);
    expect((await lstat(plistPath, { bigint: true })).ino).toBe(priorInode);
    expect(fixture.runner.loaded).toContain(target);
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([
      "ai.mono-agent.personal-agent.plist",
    ]);
  });

  it("fingerprints explicit removal and prevents launchd resurrection", async () => {
    const fixture = await createFixture();
    const installPlan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    await applyServiceMacosPlan(installPlan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    });
    const plistPath = installPlan.entries[0]!.target.plistPath;
    const removalPlan = await planServiceMacosRemoval(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    });
    expect(removalPlan).toMatchObject({
      operation: "remove",
      entries: [{ serviceId: "personal-agent", action: "remove", observed: { loaded: true } }],
    });
    expect(removalPlan.fingerprint).toMatch(/^service-macos:remove:v1:[a-f0-9]{64}$/u);

    await expect(removeServiceMacosPlan(removalPlan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    })).rejects.toBeInstanceOf(ServiceMacosMutationDisabledError);

    const observations = await removeServiceMacosPlan(removalPlan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    });
    expect(observations).toEqual([
      expect.objectContaining({ file: { exists: false }, loaded: false }),
    ]);
    await expect(access(plistPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.runner.loaded).not.toContain(`gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`);

    const idempotent = await planServiceMacosRemoval(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    });
    expect(idempotent.entries[0]?.action).toBe("noop");
  });

  it("rejects removal drift before mutation and restores a loaded service after a bounded failure", async () => {
    const drift = await createFixture();
    const plistPath = join(drift.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "managed plist", { mode: 0o600 });
    drift.runner.loaded.add(`gui/${String(drift.runtime.uid)}/ai.mono-agent.personal-agent`);
    const driftPlan = await planServiceMacosRemoval(drift.configPath, {
      runtime: drift.runtime,
      runner: drift.runner,
    });
    await writeFile(plistPath, "operator replacement", { mode: 0o600 });
    drift.runner.calls.length = 0;
    await expect(removeServiceMacosPlan(driftPlan, {
      runtime: drift.runtime,
      runner: drift.runner,
      allowMutation: true,
    })).rejects.toBeInstanceOf(ServiceMacosDriftError);
    expect(await readFile(plistPath, "utf8")).toBe("operator replacement");
    expect(drift.runner.calls.every((call) => call.arguments_[0] === "print")).toBe(true);

    const rollback = await createFixture();
    const installed = await installManagedFixture(rollback);
    const rollbackPath = installed.entries[0]!.target.plistPath;
    const prior = await readFile(rollbackPath, "utf8");
    const launchdTarget = `gui/${String(rollback.runtime.uid)}/ai.mono-agent.personal-agent`;
    const rollbackPlan = await planServiceMacosRemoval(rollback.configPath, {
      runtime: rollback.runtime,
      runner: rollback.runner,
    });
    rollback.runner.failPrintAfter = 3;
    await expect(removeServiceMacosPlan(rollbackPlan, {
      runtime: rollback.runtime,
      runner: rollback.runner,
      allowMutation: true,
    })).rejects.toThrow(/launchctl print/u);
    expect(await readFile(rollbackPath, "utf8")).toBe(prior);
    expect(rollback.runner.loaded).toContain(launchdTarget);
  });

  it("fails closed when a loaded process cannot be identified before stop", async () => {
    for (const stdout of ["state = running\n", "state = mysterious\n"]) {
      const fixture = await createFixture();
      const installed = await installManagedFixture(fixture);
      const plistPath = installed.entries[0]!.target.plistPath;
      const prior = await readFile(plistPath, "utf8");
      const target = installed.entries[0]!.target.launchdTarget;
      const plan = await planServiceMacosRemoval(fixture.configPath, {
        runtime: fixture.runtime,
        runner: fixture.runner,
      });
      fixture.runner.printCount = 0;
      fixture.runner.printOverride = { count: 3, stdout };

      await expect(removeServiceMacosPlan(plan, {
        runtime: fixture.runtime,
        runner: fixture.runner,
        allowMutation: true,
      })).rejects.toThrow(/cannot prove prior process identity/iu);
      expect(await readFile(plistPath, "utf8")).toBe(prior);
      expect(fixture.runner.loaded).toContain(target);
    }
  });

  it("times out a hung injected launchctl call and completes rollback", async () => {
    const fixture = await createFixture();
    const installed = await installManagedFixture(fixture);
    const plistPath = installed.entries[0]!.target.plistPath;
    const prior = await readFile(plistPath, "utf8");
    const target = installed.entries[0]!.target.launchdTarget;
    const plan = await planServiceMacosRemoval(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    });
    fixture.runner.printCount = 0;
    fixture.runner.hangPrintAt = 3;

    await expect(removeServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    })).rejects.toThrow(/timed out after 5000 ms/u);
    expect(await readFile(plistPath, "utf8")).toBe(prior);
    expect(fixture.runner.loaded).toContain(target);
  }, 15_000);

  it("preserves a same-content replacement that races update after the final read", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "same bytes", { mode: 0o600 });
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    fixture.runner.printCount = 0;
    let replacementInode: bigint | undefined;
    fixture.runner.onPrint = async (count) => {
      if (count !== 2) return;
      const replacement = join(fixture.runtime.launchAgentsDirectory, ".operator-replacement");
      await writeFile(replacement, "same bytes", { mode: 0o600 });
      replacementInode = (await lstat(replacement, { bigint: true })).ino;
      await rename(replacement, plistPath);
    };

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toBeInstanceOf(ServiceMacosDriftError);

    expect(await readFile(plistPath, "utf8")).toBe("same bytes");
    expect((await lstat(plistPath, { bigint: true })).ino).toBe(replacementInode);
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([
      "ai.mono-agent.personal-agent.plist",
    ]);
  });

  it("preserves a replacement that races removal during the last launchctl observation", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "planned removal", { mode: 0o600 });
    const plan = await planServiceMacosRemoval(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    });
    fixture.runner.printCount = 0;
    fixture.runner.onPrint = async (count) => {
      if (count !== 2) return;
      const replacement = join(fixture.runtime.launchAgentsDirectory, ".operator-removal-replacement");
      await writeFile(replacement, "operator replacement", { mode: 0o600 });
      await rename(replacement, plistPath);
    };

    await expect(removeServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    })).rejects.toBeInstanceOf(ServiceMacosDriftError);
    expect(await readFile(plistPath, "utf8")).toBe("operator replacement");
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([
      "ai.mono-agent.personal-agent.plist",
    ]);
  });

  it("never removes an operator replacement that arrives before create rollback", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const plistPath = plan.entries[0]!.target.plistPath;
    fixture.runner.onBootstrap = async () => {
      const replacement = join(fixture.runtime.launchAgentsDirectory, ".operator-create-rollback");
      await writeFile(replacement, "operator survives rollback", { mode: 0o600 });
      await rename(replacement, plistPath);
    };
    fixture.runner.failNextBootstrap = true;

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/rollback/u);
    expect(await readFile(plistPath, "utf8")).toBe("operator survives rollback");
    await expect(inspectServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    })).rejects.toThrow(/Unresolved service transaction/u);
    await expect(recoverServiceMacosTransactions(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    })).rejects.toThrow(/not the transaction-published inode/u);
    expect(await readFile(plistPath, "utf8")).toBe("operator survives rollback");
  });

  it("preserves both prior and operator bytes when update rollback finds an occupied target", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "fingerprinted prior", { mode: 0o600 });
    const target = `gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`;
    fixture.runner.loaded.add(target);
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    fixture.runner.onBootstrap = async () => {
      const replacement = join(fixture.runtime.launchAgentsDirectory, ".operator-update-rollback");
      await writeFile(replacement, "operator update replacement", { mode: 0o600 });
      await rename(replacement, plistPath);
    };
    fixture.runner.failNextBootstrap = true;

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/rollback/u);
    expect(await readFile(plistPath, "utf8")).toBe("operator update replacement");
    const transaction = join(
      fixture.runtime.launchAgentsDirectory,
      ".ai.mono-agent.personal-agent.mono-agent-transaction",
    );
    expect(await readFile(join(transaction, "prior.plist"), "utf8")).toBe("fingerprinted prior");
    expect(fixture.runner.loaded).not.toContain(target);
  });

  it("never deletes a replacement created after removal quarantines the planned inode", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "fingerprinted removal prior", { mode: 0o600 });
    const target = `gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`;
    fixture.runner.loaded.add(target);
    const plan = await planServiceMacosRemoval(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
    });
    fixture.runner.onBootout = async () => {
      const replacement = join(fixture.runtime.launchAgentsDirectory, ".operator-after-quarantine");
      await writeFile(replacement, "operator after quarantine", { mode: 0o600 });
      await rename(replacement, plistPath);
    };

    await expect(removeServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    })).rejects.toThrow(/rollback/u);
    expect(await readFile(plistPath, "utf8")).toBe("operator after quarantine");
    const transaction = join(
      fixture.runtime.launchAgentsDirectory,
      ".ai.mono-agent.personal-agent.mono-agent-transaction",
    );
    expect(await readFile(join(transaction, "prior.plist"), "utf8")).toBe("fingerprinted removal prior");
    expect(fixture.runner.loaded).not.toContain(target);
  });

  it("recovers the fingerprinted prior plist after a crash immediately after quarantine", async () => {
    const fixture = await createFixture();
    const installed = await installManagedFixture(fixture);
    const plistPath = installed.entries[0]!.target.plistPath;
    const prior = await readFile(plistPath, "utf8");
    const target = `gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`;
    await mutateAgent(fixture, "crash-recovery");
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    installServiceMacosTransactionTestHook((point) => {
      if (point === "after-prior-quarantined") throw new SimulatedServiceMacosCrash(point);
    });

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toBeInstanceOf(SimulatedServiceMacosCrash);
    await expect(access(plistPath)).rejects.toMatchObject({ code: "ENOENT" });

    installServiceMacosTransactionTestHook((point) => {
      if (point === "after-restore-linked") throw new SimulatedServiceMacosCrash(point);
    });
    await expect(recoverServiceMacosTransactions(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    })).rejects.toBeInstanceOf(SimulatedServiceMacosCrash);
    expect((await lstat(plistPath, { bigint: true })).nlink).toBe(2n);

    installServiceMacosTransactionTestHook(undefined);
    const observations = await recoverServiceMacosTransactions(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    });
    expect(await readFile(plistPath, "utf8")).toBe(prior);
    expect(observations[0]).toMatchObject({ file: { exists: true }, loaded: true });
    expect(fixture.runner.loaded).toContain(target);
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([
      "ai.mono-agent.personal-agent.plist",
    ]);
  });

  it("rolls back a published desired plist after crash and preserves the prior inode", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "prior inode", { mode: 0o600 });
    const priorInode = (await lstat(plistPath, { bigint: true })).ino;
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    installServiceMacosTransactionTestHook((point) => {
      if (point === "after-desired-published") throw new SimulatedServiceMacosCrash(point);
    });
    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toBeInstanceOf(SimulatedServiceMacosCrash);
    expect(await readFile(plistPath, "utf8")).not.toBe("prior inode");

    installServiceMacosTransactionTestHook(undefined);
    await recoverServiceMacosTransactions(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    });
    expect(await readFile(plistPath, "utf8")).toBe("prior inode");
    expect((await lstat(plistPath, { bigint: true })).ino).toBe(priorInode);
  });

  it("recovers a crash while desired and canonical are still hard-linked", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "linked-phase prior", { mode: 0o600 });
    const priorInode = (await lstat(plistPath, { bigint: true })).ino;
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    installServiceMacosTransactionTestHook((point) => {
      if (point === "after-desired-linked") throw new SimulatedServiceMacosCrash(point);
    });
    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toBeInstanceOf(SimulatedServiceMacosCrash);

    installServiceMacosTransactionTestHook(undefined);
    await recoverServiceMacosTransactions(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    });
    expect(await readFile(plistPath, "utf8")).toBe("linked-phase prior");
    expect((await lstat(plistPath, { bigint: true })).ino).toBe(priorInode);
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([
      "ai.mono-agent.personal-agent.plist",
    ]);
  });

  it("retains transaction artifacts when the LaunchAgents parent is replaced mid-transaction", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    const originalDirectory = `${fixture.runtime.launchAgentsDirectory}.transaction`;
    installServiceMacosTransactionTestHook(async (point) => {
      if (point !== "after-journal-prepared") return;
      await rename(fixture.runtime.launchAgentsDirectory, originalDirectory);
      await mkdir(fixture.runtime.launchAgentsDirectory, { mode: 0o700 });
    });

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/directory changed|parent directory identity/u);
    expect(await readdir(fixture.runtime.launchAgentsDirectory)).toEqual([]);
    expect(await readdir(originalDirectory)).toEqual(expect.arrayContaining([
      ".ai.mono-agent.personal-agent.mono-agent-transaction",
      ".ai.mono-agent.personal-agent.mono-agent-transaction.lock",
    ]));
    expect(fixture.runner.calls.every((call) => call.arguments_[0] === "print")).toBe(true);
  });

  it("serializes concurrent reconcilers with an owner-private per-service lock", async () => {
    const fixture = await createFixture();
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
    });
    let releaseFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReachedJournal!: () => void;
    const firstAtJournal = new Promise<void>((resolve) => {
      firstReachedJournal = resolve;
    });
    let blocked = false;
    installServiceMacosTransactionTestHook(async (point) => {
      if (point !== "after-journal-prepared" || blocked) return;
      blocked = true;
      firstReachedJournal();
      await firstMayContinue;
    });
    const first = applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    });
    await firstAtJournal;

    await expect(applyServiceMacosPlan(plan, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      validateAgent: validAgent,
      allowMutation: true,
    })).rejects.toThrow(/mutation is active/u);
    releaseFirst();
    await first;
  });

  it("does not delete a live lock that replaces a stale lock during recovery", async () => {
    const fixture = await createFixture();
    const lock = join(
      fixture.runtime.launchAgentsDirectory,
      ".ai.mono-agent.personal-agent.mono-agent-transaction.lock",
    );
    await writeFile(lock, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: "00000000-0000-4000-8000-000000000001",
    })}\n`, { mode: 0o600 });
    const liveToken = "00000000-0000-4000-8000-000000000002";
    installServiceMacosTransactionTestHook(async (point) => {
      if (point !== "before-stale-lock-quarantine") return;
      const replacement = `${lock}.live`;
      await writeFile(replacement, `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        token: liveToken,
      })}\n`, { mode: 0o600 });
      await rename(replacement, lock);
    });

    await expect(recoverServiceMacosTransactions(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      allowMutation: true,
    })).rejects.toThrow(/changed during stale-lock recovery/u);
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({
      pid: process.pid,
      token: liveToken,
    });
    await unlink(lock);
  });
});

interface Fixture {
  readonly root: string;
  readonly configPath: string;
  readonly runtime: ServiceMacosRuntimePaths;
  readonly runner: FakeRunner;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-service-macos-"));
  const project = join(root, "agent");
  const launchAgentsDirectory = join(root, "LaunchAgents");
  const logs = join(root, "logs");
  await mkdir(project, { mode: 0o700 });
  await mkdir(launchAgentsDirectory, { mode: 0o700 });
  await mkdir(logs, { mode: 0o700 });
  const agentConfig = join(project, "mono-agent.config.json");
  await writeFile(agentConfig, "{}\n", { mode: 0o600 });
  await writeFile(join(project, "package.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", { mode: 0o600 });
  const nodePath = join(root, "node");
  await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const runnerScriptPath = join(root, "service-macos.js");
  await writeFile(runnerScriptPath, "// runner\n", { mode: 0o600 });
  const configPath = join(root, "service-macos.json");
  await writeFile(configPath, `${JSON.stringify({
    configVersion: 1,
    services: {
      "personal-agent": {
        agentConfig,
        startAtLogin: true,
        restartPolicy: "on-failure",
        logs: { directory: logs, maxBytes: 1_024, retainFiles: 2 },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Tests require a POSIX uid.");
  return {
    root,
    configPath,
    runtime: { nodePath, runnerScriptPath, launchAgentsDirectory, uid },
    runner: new FakeRunner(),
  };
}

async function installManagedFixture(fixture: Fixture): Promise<Awaited<ReturnType<typeof planServiceMacos>>> {
  const plan = await planServiceMacos(fixture.configPath, {
    runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent,
  });
  await applyServiceMacosPlan(plan, {
    runtime: fixture.runtime, runner: fixture.runner, validateAgent: validAgent, allowMutation: true,
  });
  return plan;
}

async function mutateAgent(fixture: Fixture, revision: string): Promise<void> {
  await writeFile(join(fixture.root, "agent", "mono-agent.config.json"), `${JSON.stringify({ revision })}\n`, { mode: 0o600 });
}

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; arguments_: readonly string[] }> = [];
  readonly loaded = new Set<string>();
  readonly exited = new Set<string>();
  readonly idle = new Set<string>();
  readonly plists = new Map<string, string>();
  failNextBootstrap = false;
  skipNextBootstrapLoad = false;
  failPrintAfter: number | undefined;
  printCount = 0;
  unhealthyPrints = 0;
  skipNextReadiness = false;
  hangPrintAt: number | undefined;
  printOverride: { readonly count: number; readonly stdout: string } | undefined;
  onPrint: ((count: number) => void | Promise<void>) | undefined;
  onBootout: (() => void | Promise<void>) | undefined;
  onBootstrap: (() => void | Promise<void>) | undefined;

  async run(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, arguments_: [...arguments_] });
    if (arguments_[0] === "print") {
      this.printCount += 1;
      await this.onPrint?.(this.printCount);
      if (this.hangPrintAt === this.printCount) {
        this.hangPrintAt = undefined;
        return await new Promise<CommandResult>(() => undefined);
      }
      if (this.failPrintAfter === 0) {
        this.failPrintAfter = undefined;
        return result(5, "inspection failed");
      }
      if (this.failPrintAfter !== undefined) this.failPrintAfter -= 1;
      if (!this.loaded.has(arguments_[1] ?? "")) return result(113);
      if (this.printOverride?.count === this.printCount) {
        return result(0, "", this.printOverride.stdout);
      }
      if (this.exited.has(arguments_[1] ?? "") || this.unhealthyPrints > 0) {
        this.unhealthyPrints -= 1;
        return result(0, "", "state = exited\nlast exit code = 1\n");
      }
      if (this.idle.has(arguments_[1] ?? "")) return result(0, "", "state = waiting\n");
      return result(0, "", `state = running\npid = ${String(FAKE_SERVICE_PID)}\n`);
    }
    if (arguments_[0] === "bootout") {
      await this.onBootout?.();
      this.loaded.delete(arguments_[1] ?? "");
      this.exited.delete(arguments_[1] ?? "");
      this.idle.delete(arguments_[1] ?? "");
      return result(0);
    }
    if (arguments_[0] === "bootstrap") {
      await this.onBootstrap?.();
      if (this.failNextBootstrap) {
        this.failNextBootstrap = false;
        return result(5, "activation failed");
      }
      if (this.skipNextBootstrapLoad) {
        this.skipNextBootstrapLoad = false;
        return result(0);
      }
      const plist = arguments_[2] ?? "";
      const label = plist.slice(plist.lastIndexOf("/") + 1, -".plist".length);
      const target = `${arguments_[1] ?? ""}/${label}`;
      this.loaded.add(target);
      this.plists.set(target, plist);
      const source = await readFile(plist, "utf8");
      if (/<key>RunAtLoad<\/key>\s*<true\/>/u.test(source)) await this.publishReadiness(target);
      else this.idle.add(target);
      return result(0);
    }
    if (arguments_[0] === "kickstart") {
      const target = arguments_[1] ?? "";
      if (!this.loaded.has(target)) return result(113);
      this.idle.delete(target);
      this.exited.delete(target);
      await this.publishReadiness(target);
      return result(0);
    }
    return result(64, "unexpected command");
  }

  private async publishReadiness(target: string): Promise<void> {
    if (this.skipNextReadiness) {
      this.skipNextReadiness = false;
      return;
    }
    const source = await readFile(this.plists.get(target)!, "utf8");
    const encoded = /<string>--activation<\/string>\s*<string>([A-Za-z0-9_-]+)<\/string>/u.exec(source)?.[1];
    if (encoded === undefined) return;
    const activation = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { logs: { readinessPath: string } };
    await writeFile(activation.logs.readinessPath, `${JSON.stringify({
      event: "started", serviceMacosProof: createHash("sha256").update(encoded).digest("hex"), pid: FAKE_SERVICE_PID,
    })}\n`, { mode: 0o600 });
  }
}

function result(exitCode: number, stderr = "", stdout = ""): CommandResult {
  return { exitCode, stdout, stderr };
}

async function snapshot(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  await walk(root, "", output);
  return output;
}

async function walk(root: string, relative: string, output: string[]): Promise<void> {
  const path = relative.length === 0 ? root : join(root, relative);
  const metadata = await stat(path);
  output.push(`${relative || "."}:${String(metadata.mode & 0o777)}:${String(metadata.size)}`);
  if (!metadata.isDirectory()) {
    output.push((await readFile(path)).toString("hex"));
    return;
  }
  for (const name of (await readdir(path)).sort()) {
    await walk(root, relative.length === 0 ? name : join(relative, name), output);
  }
}
