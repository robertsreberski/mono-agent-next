import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
  removeServiceMacosPlan,
  type CommandResult,
  type CommandRunner,
  type ServiceMacosRuntimePaths,
} from "../index.js";

const validAgent = async (): Promise<AgentValidationResult> => ({ ok: true, issues: [] });

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
    expect(plan.entries[0]?.desiredPlist).toContain(`<string>${process.execPath}</string>`);
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
    const plan = await planServiceMacos(fixture.configPath, {
      runtime: fixture.runtime,
      runner: fixture.runner,
      async validateAgent(_path, options) {
        validatedSecret = options?.environment?.SERVICE_MACOS_TEST_SECRET;
        return { ok: true, issues: [] };
      },
    });
    expect(validatedSecret).toBe(secret);
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(plan.entries[0]?.desiredPlist).toContain(environmentFile);
    expect(plan.entries[0]?.binding.environmentFileDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("restores the prior plist when replacement activation fails", async () => {
    const fixture = await createFixture();
    const plistPath = join(fixture.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(plistPath, "prior plist", { mode: 0o600 });
    fixture.runner.loaded.add(`gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`);
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
    expect(await readFile(plistPath, "utf8")).toBe("prior plist");
    expect(fixture.runner.loaded).toContain(`gui/${String(fixture.runtime.uid)}/ai.mono-agent.personal-agent`);
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
    const rollbackPath = join(rollback.runtime.launchAgentsDirectory, "ai.mono-agent.personal-agent.plist");
    await writeFile(rollbackPath, "rollback plist", { mode: 0o600 });
    const launchdTarget = `gui/${String(rollback.runtime.uid)}/ai.mono-agent.personal-agent`;
    rollback.runner.loaded.add(launchdTarget);
    const rollbackPlan = await planServiceMacosRemoval(rollback.configPath, {
      runtime: rollback.runtime,
      runner: rollback.runner,
    });
    rollback.runner.failPrintAfter = 2;
    await expect(removeServiceMacosPlan(rollbackPlan, {
      runtime: rollback.runtime,
      runner: rollback.runner,
      allowMutation: true,
    })).rejects.toThrow(/launchctl print/u);
    expect(await readFile(rollbackPath, "utf8")).toBe("rollback plist");
    expect(rollback.runner.loaded).toContain(launchdTarget);
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
    runtime: { nodePath: process.execPath, runnerScriptPath, launchAgentsDirectory, uid },
    runner: new FakeRunner(),
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; arguments_: readonly string[] }> = [];
  readonly loaded = new Set<string>();
  failNextBootstrap = false;
  failPrintAfter: number | undefined;

  async run(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, arguments_: [...arguments_] });
    if (arguments_[0] === "print") {
      if (this.failPrintAfter === 0) {
        this.failPrintAfter = undefined;
        return result(5, "inspection failed");
      }
      if (this.failPrintAfter !== undefined) this.failPrintAfter -= 1;
      return result(this.loaded.has(arguments_[1] ?? "") ? 0 : 113);
    }
    if (arguments_[0] === "bootout") {
      this.loaded.delete(arguments_[1] ?? "");
      return result(0);
    }
    if (arguments_[0] === "bootstrap") {
      if (this.failNextBootstrap) {
        this.failNextBootstrap = false;
        return result(5, "activation failed");
      }
      const plist = arguments_[2] ?? "";
      const label = plist.slice(plist.lastIndexOf("/") + 1, -".plist".length);
      this.loaded.add(`${arguments_[1] ?? ""}/${label}`);
      return result(0);
    }
    return result(64, "unexpected command");
  }
}

function result(exitCode: number, stderr = ""): CommandResult {
  return { exitCode, stdout: "", stderr };
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
