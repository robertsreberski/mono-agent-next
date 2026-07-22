import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SandboxCommand } from "@mono-agent/module-sdk/internal";

import {
  openSandboxSrt,
  parseSandboxSrtConfig,
  type SandboxSrtConfig,
} from "../index.js";

const roots: string[] = [];

afterEach(async () => {
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

const FAKE_SRT = `#!/bin/sh
if [ "$1" != "--settings" ] || [ ! -f "$2" ]; then
  printf '%s' 'invalid fake SRT invocation' >&2
  exit 97
fi
shift 2
exec "$@"`;

interface Fixture {
  readonly root: string;
  readonly executable: string;
  readonly settings: string;
  readonly executableHash: string;
  readonly settingsHash: string;
}

async function createFixture(): Promise<Fixture> {
  const authored = await mkdtemp(join(tmpdir(), "mono-agent-sandbox-srt-test-"));
  const root = await realpath(authored);
  roots.push(root);
  const executable = join(root, "srt");
  const settings = join(root, "settings.json");
  await writeFile(executable, FAKE_SRT, { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(settings, "{\"filesystem\":{}}\n", { mode: 0o600 });
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
