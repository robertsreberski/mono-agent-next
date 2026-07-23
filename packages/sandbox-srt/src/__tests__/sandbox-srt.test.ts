import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { chmod, link, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleCommand, ModuleLogger } from "@mono-agent/module-sdk";
import type { SandboxCommand } from "@mono-agent/module-sdk/internal";

import {
  openSandboxSrt,
  parseSandboxSrtConfig,
  type SandboxSrtConfig,
} from "../index.js";

const spawnBoundary = vi.hoisted(() => ({
  beforeSpawn: undefined as (() => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...arguments_: unknown[]) => {
      spawnBoundary.beforeSpawn?.();
      return Reflect.apply(actual.spawn, actual, arguments_);
    },
  };
});

const roots: string[] = [];
const logger: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

afterEach(async () => {
  spawnBoundary.beforeSpawn = undefined;
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("sandbox-srt", () => {
  it("strictly requires pinned executable and settings configuration", async () => {
    const fixture = await createFixture();
    expect(parseSandboxSrtConfig(config(fixture)).limits.defaultTimeoutMs).toBe(120_000);
    expect(() => parseSandboxSrtConfig({ ...config(fixture), unknown: true })).toThrow(/unknown field/u);
    expect(() => parseSandboxSrtConfig({ ...config(fixture), executable: { path: "relative", sha256: "bad" } }))
      .toThrow(/SHA-256/u);
    expect(() => parseSandboxSrtConfig({
      ...config(fixture),
      limits: { defaultTimeoutMs: 100, maxTimeoutMs: 10 },
    })).toThrow(/must not exceed/u);
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
    ]) {
      expect(() => parseSandboxSrtConfig(config(fixture, {
        environment: { inherit: [], allow: [name] },
      }))).toThrow(/reserved for the host runtime/u);
      expect(() => parseSandboxSrtConfig(config(fixture, {
        environment: { inherit: [name], allow: [] },
      }))).toThrow(/reserved for the host runtime/u);
    }
  });

  it("exposes read-only status before start without executing the selected SRT", async () => {
    const fixture = await createFixture({
      executable: `#!/bin/sh
touch "$0.invoked"
exit 0`,
      settings: "{\"network\":\"none\"}\n",
    });
    const sandbox = await openSandboxSrt({ config: config(fixture) });
    try {
      const result = await statusCommand(sandbox).run(undefined, commandContext());
      expect(result).toEqual({
        status: "ready",
        mode: "native",
        integrity: "verified",
        networkAvailability: "settings-controlled",
        activeCommands: 0,
        executableSha256: fixture.executableHash,
        settingsSha256: fixture.settingsHash,
      });
      await expect(sandbox.diagnostics({
        signal: new AbortController().signal,
        verbose: false,
      })).resolves.toEqual([{
        code: "sandbox-srt.integrity",
        severity: "info",
        message: "SRT executable and settings integrity is verified.",
      }]);
      await expect(readFile(`${fixture.executable}.invoked`)).rejects.toThrow();
    } finally {
      await sandbox.stop();
    }
  });

  it("strictly rejects hostile status input and honors cancellation", async () => {
    const fixture = await createFixture();
    const sandbox = await openSandboxSrt({ config: config(fixture) });
    try {
      const command = statusCommand(sandbox);
      let reads = 0;
      const accessor = Object.defineProperty({}, "unexpected", {
        enumerable: true,
        get() {
          reads += 1;
          return true;
        },
      });
      await expect(command.run(accessor, commandContext())).rejects.toThrow(/unknown field/u);
      expect(reads).toBe(0);
      await expect(command.run(new Proxy({}, {}), commandContext()))
        .rejects.toThrow(/plain object/u);

      const symbolic: Record<PropertyKey, unknown> = {};
      symbolic[Symbol("extra")] = true;
      await expect(command.run(symbolic, commandContext())).rejects.toThrow(/unknown field/u);

      const controller = new AbortController();
      const reason = new Error("sandbox status cancelled");
      controller.abort(reason);
      await expect(command.run(undefined, commandContext(controller.signal)))
        .rejects.toBe(reason);
    } finally {
      await sandbox.stop();
    }
  });

  it("returns bounded degraded and closed status without raw integrity errors", async () => {
    const fixture = await createFixture();
    const sandbox = await openSandboxSrt({ config: config(fixture) });
    const command = statusCommand(sandbox);
    await writeFile(
      fixture.settings,
      `{"network":"none","secret":"do-not-return","path":${JSON.stringify(fixture.root)}}\n`,
      { mode: 0o600 },
    );
    await chmod(fixture.settings, 0o600);

    const degraded = await command.run(undefined, commandContext());
    expect(degraded).toMatchObject({
      status: "degraded",
      mode: "native",
      integrity: "unverified",
      networkAvailability: "unavailable",
      code: "sandbox_integrity_unverified",
      message: "The selected SRT executable or settings could not be verified.",
    });
    expect(JSON.stringify(degraded)).not.toContain("do-not-return");
    expect(JSON.stringify(degraded)).not.toContain(fixture.root);
    await expect(sandbox.diagnostics({
      signal: new AbortController().signal,
      verbose: false,
    })).resolves.toEqual([{
      code: "sandbox-srt.integrity",
      severity: "error",
      message: "SRT executable or settings integrity could not be proven.",
    }]);

    await sandbox.stop();
    await expect(command.run(undefined, commandContext())).resolves.toMatchObject({
      status: "closed",
      mode: "native",
      integrity: "closed",
      networkAvailability: "unavailable",
      code: "sandbox_closed",
    });
  });

  it("uses an argument-vector SRT launch and an explicit environment allowlist", async () => {
    const fixture = await createFixture();
    const previous = process.env.SANDBOX_SRT_INHERITED_TEST;
    process.env.SANDBOX_SRT_INHERITED_TEST = "from-host";
    const sandbox = await openSandboxSrt({
      config: config(fixture, {
        environment: { inherit: ["SANDBOX_SRT_INHERITED_TEST"], allow: ["SAFE_INPUT"] },
      }),
    });
    try {
      const literal = "$(touch /tmp/must-not-run); hello world";
      const vector = await sandbox.execute(command(fixture.root, "/usr/bin/printf", ["%s", literal]));
      expect(text(vector.stdout)).toBe(literal);
      expect(vector.exitCode).toBe(0);

      const environment = await sandbox.execute({
        ...command(fixture.root, "/bin/sh", [
          "-c",
          "printf '%s|%s|%s' \"$SAFE_INPUT\" \"$SANDBOX_SRT_INHERITED_TEST\" \"${HOME-unset}\"",
        ]),
        environment: { SAFE_INPUT: "from-request" },
      });
      expect(text(environment.stdout)).toBe("from-request|from-host|unset");
      await expect(sandbox.execute({
        ...command(fixture.root, "/usr/bin/true"),
        environment: { SECRET_NOT_ALLOWED: "no" },
      })).rejects.toMatchObject({ code: "invalid_command" });
    } finally {
      await sandbox.stop();
      if (previous === undefined) delete process.env.SANDBOX_SRT_INHERITED_TEST;
      else process.env.SANDBOX_SRT_INHERITED_TEST = previous;
    }
  });

  it("rejects runtime preloader environment before NODE_OPTIONS can import code", async () => {
    const fixture = await createFixture();
    const injectedModule = join(fixture.root, "injected-before-srt.mjs");
    const marker = join(fixture.root, "injected-before-srt");
    await writeFile(
      injectedModule,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "preloader-ran");`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const injectedValue = `--import=${pathToFileURL(injectedModule).href}`;
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = injectedValue;
    try {
      await expect(openSandboxSrt({
        config: config(fixture, {
          environment: { inherit: ["NODE_OPTIONS"], allow: [] },
        }),
      })).rejects.toThrow(/reserved for the host runtime/u);

      const sandbox = await openSandboxSrt({ config: config(fixture) });
      try {
        for (const name of [
          "NODE_OPTIONS",
          "NODE_PATH",
          "LD_PRELOAD",
          "LD_AUDIT",
          "DYLD_INSERT_LIBRARIES",
          "DYLD_LIBRARY_PATH",
        ]) {
          await expect(sandbox.execute({
            ...command(fixture.root, "/usr/bin/true"),
            environment: { [name]: name === "NODE_OPTIONS" ? injectedValue : "injected" },
          })).rejects.toMatchObject({ code: "invalid_command" });
        }
      } finally {
        await sandbox.stop();
      }
      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });

  it("fails closed instead of launching a non-Node interpreter script", async () => {
    const fixture = await createFixture({
      executable: `#!/bin/sh
touch "$0.invoked"
exec "$@"`,
    });
    const sandbox = await openSandboxSrt({ config: config(fixture) });
    try {
      await expect(sandbox.execute(command(fixture.root, "/usr/bin/true")))
        .rejects.toMatchObject({ code: "sandbox_unavailable" });
      await expect(readFile(`${fixture.executable}.invoked`)).rejects.toThrow();
    } finally {
      await sandbox.stop();
    }
  });

  it("rejects static, dynamic, and file-URL local dependencies before dependency code runs", async () => {
    for (const importKind of ["static", "dynamic", "file"] as const) {
      const fixture = await createFixture({
        executable: dependentFakeSrt(importKind),
      });
      const dependency = join(fixture.root, "mutable-support.mjs");
      const marker = join(fixture.root, `${importKind}-dependency-ran`);
      await writeFile(
        dependency,
        "export const initiallyReviewed = true;\n",
        { mode: 0o600 },
      );
      const sandbox = await openSandboxSrt({ config: config(fixture) });
      try {
        await writeFile(
          dependency,
          [
            'import { writeFileSync } from "node:fs";',
            `writeFileSync(${JSON.stringify(marker)}, "dependency-secret");`,
          ].join("\n"),
          { mode: 0o600 },
        );
        const result = await sandbox.execute(command(fixture.root, "/usr/bin/true"));
        expect(result).toMatchObject({ exitCode: 126, timedOut: false });
        expect(text(result.stdout)).toBe("");
        expect(text(result.stderr)).toBe(
          "The bound SRT entrypoint is not self-contained.",
        );
        expect(JSON.stringify(result)).not.toContain(fixture.root);
        expect(JSON.stringify(result)).not.toContain("dependency-secret");
        await expect(readFile(marker)).rejects.toThrow();
      } finally {
        await sandbox.stop();
      }
    }
  });

  it("passes the exact pinned policy to SRT for fail-closed network decisions", async () => {
    const deniedFixture = await createFixture({ settings: "{\"network\":\"none\"}\n" });
    const denied = await openSandboxSrt({ config: config(deniedFixture) });
    try {
      const result = await denied.execute(command(
        deniedFixture.root,
        "/mono-agent-test/network-probe",
      ));
      expect(result.exitCode).toBe(77);
      expect(text(result.stderr)).toBe("network denied by pinned policy");
      expect(await denied.health({ signal: new AbortController().signal })).toMatchObject({
        status: "healthy",
        details: {
          integrity: "verified",
          activeCommands: 0,
          executableSha256: deniedFixture.executableHash,
          settingsSha256: deniedFixture.settingsHash,
        },
      });
    } finally {
      await denied.stop();
    }

    const allowedFixture = await createFixture({ settings: "{\"network\":\"all\"}\n" });
    const allowed = await openSandboxSrt({ config: config(allowedFixture) });
    try {
      const result = await allowed.execute(command(
        allowedFixture.root,
        "/mono-agent-test/network-probe",
      ));
      expect(result.exitCode).toBe(0);
      expect(text(result.stdout)).toBe("network allowed by pinned policy");
    } finally {
      await allowed.stop();
    }

    const malformedFixture = await createFixture({ settings: "{\"network\":\"unknown\"}\n" });
    const malformed = await openSandboxSrt({ config: config(malformedFixture) });
    try {
      const result = await malformed.execute(command(
        malformedFixture.root,
        "/mono-agent-test/network-probe",
      ));
      expect(result.exitCode).toBe(78);
      expect(text(result.stderr)).toBe("network policy is unsupported");
    } finally {
      await malformed.stop();
    }
  });

  it("bounds stdin, argument bytes, output, timeout, and cancellation", async () => {
    const fixture = await createFixture();
    const sandbox = await openSandboxSrt({
      config: config(fixture, {
        limits: {
          defaultTimeoutMs: 500,
          maxTimeoutMs: 1_000,
          maxOutputBytes: 64,
          maxInputBytes: 4,
          maxArguments: 4,
          maxArgumentBytes: 128,
        },
      }),
    });
    try {
      await expect(sandbox.execute({
        ...command(fixture.root, "/bin/cat"),
        stdin: Buffer.from("too long"),
      })).rejects.toMatchObject({ code: "invalid_command" });
      await expect(sandbox.execute(command(fixture.root, "/bin/echo", ["1", "2", "3", "4", "5"])))
        .rejects.toMatchObject({ code: "invalid_command" });
      await expect(sandbox.execute(command(fixture.root, "/bin/sh", ["-c", "while :; do printf 0123456789; done"])))
        .rejects.toMatchObject({ code: "output_limit_exceeded" });

      const timedOut = await sandbox.execute({
        ...command(fixture.root, "/bin/sleep", ["2"]),
        timeoutMs: 20,
      });
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.exitCode).toBeNull();

      const controller = new AbortController();
      const reason = new Error("cancelled by test");
      const running = sandbox.execute({
        ...command(fixture.root, "/bin/sleep", ["2"]),
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(reason), 20);
      await expect(running).rejects.toBe(reason);
    } finally {
      await sandbox.stop();
    }
  });

  it("fails closed when configured digests, file modes, links, or paths are unsafe", async () => {
    const wrongDigest = await createFixture();
    await expect(openSandboxSrt({
      config: { ...config(wrongDigest), executable: { path: wrongDigest.executable, sha256: "0".repeat(64) } },
    })).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const wrongMode = await createFixture();
    await chmod(wrongMode.settings, 0o644);
    await expect(openSandboxSrt({ config: config(wrongMode) })).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const hardLinked = await createFixture();
    await link(hardLinked.executable, join(hardLinked.root, "srt-hard-link"));
    await expect(openSandboxSrt({ config: config(hardLinked) })).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const symlinked = await createFixture();
    const symlinkPath = join(symlinked.root, "srt-link");
    await symlink(symlinked.executable, symlinkPath);
    await expect(openSandboxSrt({
      config: { ...config(symlinked), executable: { path: symlinkPath, sha256: symlinked.executableHash } },
    })).rejects.toMatchObject({ code: "sandbox_unavailable" });

    const absent = await createFixture();
    await rm(absent.executable);
    await expect(openSandboxSrt({ config: config(absent) })).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });

  it("pins filesystem identity and content before every run and reports unhealthy after mutation", async () => {
    const executableMutation = await createFixture();
    const sandbox = await openSandboxSrt({ config: config(executableMutation) });
    try {
      await writeFile(executableMutation.executable, `${FAKE_SRT}\n# mutation\n`, { mode: 0o700 });
      await chmod(executableMutation.executable, 0o700);
      await expect(sandbox.execute(command(executableMutation.root, "/usr/bin/true")))
        .rejects.toMatchObject({ code: "sandbox_unavailable" });
      expect((await sandbox.health({ signal: new AbortController().signal })).status).toBe("unhealthy");
    } finally {
      await sandbox.stop();
    }

    const settingsMutation = await createFixture();
    const second = await openSandboxSrt({ config: config(settingsMutation) });
    try {
      await writeFile(settingsMutation.settings, "{\"changed\":true}\n", { mode: 0o600 });
      await chmod(settingsMutation.settings, 0o600);
      await expect(second.execute(command(settingsMutation.root, "/usr/bin/true")))
        .rejects.toMatchObject({ code: "sandbox_unavailable" });
    } finally {
      await second.stop();
    }

    const identityMutation = await createFixture();
    const third = await openSandboxSrt({ config: config(identityMutation) });
    try {
      const replacement = join(identityMutation.root, "replacement-srt");
      await writeFile(replacement, FAKE_SRT, { mode: 0o700 });
      await chmod(replacement, 0o700);
      await rename(replacement, identityMutation.executable);
      await expect(third.execute(command(identityMutation.root, "/usr/bin/true")))
        .rejects.toMatchObject({ code: "sandbox_unavailable" });
    } finally {
      await third.stop();
    }
  });

  it("binds the verified executable and settings across the verify-to-spawn boundary", async () => {
    const fixture = await createFixture({ settings: "{\"network\":\"none\"}\n" });
    const replacementExecutable = join(fixture.root, "replacement-srt");
    const replacementSettings = join(fixture.root, "replacement-settings.json");
    await writeFile(replacementExecutable, MALICIOUS_FAKE_SRT, { mode: 0o700 });
    await chmod(replacementExecutable, 0o700);
    await writeFile(
      replacementSettings,
      "{\"network\":\"all\",\"secret\":\"must-not-escape\"}\n",
      { mode: 0o600 },
    );
    await chmod(replacementSettings, 0o600);
    const sandbox = await openSandboxSrt({ config: config(fixture) });
    try {
      spawnBoundary.beforeSpawn = () => {
        spawnBoundary.beforeSpawn = undefined;
        renameSync(replacementExecutable, fixture.executable);
        renameSync(replacementSettings, fixture.settings);
      };
      const result = await sandbox.execute(command(
        fixture.root,
        "/mono-agent-test/network-probe",
      ));
      expect(result.exitCode).toBe(77);
      expect(text(result.stderr)).toBe("network denied by pinned policy");
      expect(text(result.stdout)).not.toContain("malicious executable ran");
      expect(JSON.stringify(result)).not.toContain("must-not-escape");
      expect(await sandbox.health({ signal: new AbortController().signal })).toMatchObject({
        status: "unhealthy",
        details: { integrity: "unverified" },
      });
    } finally {
      await sandbox.stop();
    }
  });

  it("rejects non-canonical working directories and operations after stop", async () => {
    const fixture = await createFixture();
    const linkPath = join(fixture.root, "cwd-link");
    await symlink(fixture.root, linkPath);
    const sandbox = await openSandboxSrt({ config: config(fixture) });
    await expect(sandbox.execute(command(linkPath, "/usr/bin/true"))).rejects.toMatchObject({ code: "invalid_command" });
    await sandbox.stop();
    await expect(sandbox.execute(command(fixture.root, "/usr/bin/true"))).rejects.toMatchObject({ code: "closed" });
  });
});

const FAKE_SRT = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const arguments_ = process.argv.slice(2);
if (arguments_[0] !== "--settings" || arguments_.length < 3) {
  process.stderr.write("invalid fake SRT invocation");
  process.exit(97);
}
const settings = arguments_[1];
const command = arguments_[2];
const commandArguments = arguments_.slice(3);
if (command === "/mono-agent-test/network-probe") {
  const policy = readFileSync(settings, "utf8").replace(/\\s/gu, "");
  if (policy === '{"network":"none"}') {
    process.stderr.write("network denied by pinned policy");
    process.exit(77);
  }
  if (policy === '{"network":"all"}') {
    process.stdout.write("network allowed by pinned policy");
    process.exit(0);
  }
  process.stderr.write("network policy is unsupported");
  process.exit(78);
}
const child = spawn(command, commandArguments, {
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(126));
child.once("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});`;

const MALICIOUS_FAKE_SRT = `#!/usr/bin/env node
process.stdout.write("malicious executable ran");
process.exit(0);`;

function dependentFakeSrt(importKind: "static" | "dynamic" | "file"): string {
  const importStatement = importKind === "static"
    ? 'import "./mutable-support.mjs";'
    : importKind === "dynamic"
      ? 'void import /* dependency edge */ ("./mutable-support.mjs");'
      : 'void import(new URL("./mutable-support.mjs", import.meta.url));';
  return `#!/usr/bin/env node
${importStatement}
process.stdout.write("unbundled entrypoint ran");
`;
}

interface Fixture {
  readonly root: string;
  readonly executable: string;
  readonly settings: string;
  readonly executableHash: string;
  readonly settingsHash: string;
}

async function createFixture(options: {
  readonly executable?: string;
  readonly settings?: string;
} = {}): Promise<Fixture> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-sandbox-srt-test-"));
  const root = await realpath(authored);
  roots.push(root);
  const executable = join(root, "srt");
  const settings = join(root, "settings.json");
  await writeFile(executable, options.executable ?? FAKE_SRT, { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(settings, options.settings ?? "{\"filesystem\":{}}\n", { mode: 0o600 });
  await chmod(settings, 0o600);
  return {
    root,
    executable,
    settings,
    executableHash: await sha256(executable),
    settingsHash: await sha256(settings),
  };
}

function config(
  fixture: Fixture,
  overrides: {
    readonly limits?: Partial<SandboxSrtConfig["limits"]>;
    readonly environment?: SandboxSrtConfig["environment"];
  } = {},
): Record<string, unknown> {
  return {
    executable: { path: fixture.executable, sha256: fixture.executableHash },
    settings: { path: fixture.settings, sha256: fixture.settingsHash },
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    ...(overrides.environment === undefined ? {} : { environment: overrides.environment }),
  };
}

function command(
  workingDirectory: string,
  executable: string,
  arguments_: readonly string[] = [],
): SandboxCommand {
  return {
    command: executable,
    arguments: arguments_,
    workingDirectory,
    signal: new AbortController().signal,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function statusCommand(sandbox: {
  readonly commands?: readonly ModuleCommand[];
}): ModuleCommand {
  const command = sandbox.commands?.find((candidate) =>
    candidate.name === "sandbox-srt:status");
  if (command === undefined) throw new Error("sandbox-srt:status command is absent");
  return command;
}

function commandContext(signal = new AbortController().signal) {
  return { signal, logger };
}
