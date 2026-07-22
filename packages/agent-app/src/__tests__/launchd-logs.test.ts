import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  beginLaunchdLogMaintenanceIntent,
  clearLaunchdLogMaintenanceIntent,
  defaultLaunchdLogDependencies,
  inspectLaunchdLogs,
  launchdLogPathsForConfig,
  markLaunchdLogMaintenanceRestoring,
  markLaunchdLogMaintenanceStopped,
  markLaunchdLogMaintenanceStopping,
  readLaunchdLogMaintenanceIntent,
  rotateStoppedLaunchdLogs,
} from "../launchd-logs.js";
import type { LaunchdLogDependencies, LaunchdLogPolicy } from "../launchd-logs.js";
import type { LaunchdPaths } from "../launchd.js";

const POLICY: LaunchdLogPolicy = { maxBytes: 8, rotationCount: 3 };
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<LaunchdPaths> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-launchd-logs-")));
  tempDirs.push(home);
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const logDir = join(home, ".mono-agent", "logs");
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  return {
    launchAgentsDir,
    logDir,
    plistPath: join(launchAgentsDir, "com.mono-agent.test.plist"),
    stdoutPath: join(logDir, "com.mono-agent.test.out.log"),
    stderrPath: join(logDir, "com.mono-agent.test.err.log"),
  };
}

async function privateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function findTransactionArtifact(logDir: string, suffix: string): Promise<string> {
  const matches = (await readdir(logDir)).filter((name) =>
    name.startsWith(".mono-agent-launchd-log-") && name.endsWith(suffix));
  expect(matches).toHaveLength(1);
  return join(logDir, matches[0]!);
}

describe("inspectLaunchdLogs", () => {
  it("publishes, reports, and clears one owner-private maintenance lifecycle intent", async () => {
    const paths = await fixture();
    const intent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.test-0a1b2c3d",
      plistFingerprint: `1:2:3:${"a".repeat(64)}`,
    };

    await beginLaunchdLogMaintenanceIntent(paths, intent);
    const firstStoppedIntent = await markLaunchdLogMaintenanceStopped(paths, intent);
    const rearmedIntent = await markLaunchdLogMaintenanceStopping(paths, firstStoppedIntent);
    const stoppedIntent = await markLaunchdLogMaintenanceStopped(paths, rearmedIntent);
    const restoringIntent = await markLaunchdLogMaintenanceRestoring(paths, stoppedIntent);

    await expect(readLaunchdLogMaintenanceIntent(paths)).resolves.toEqual(restoringIntent);
    const inspection = await inspectLaunchdLogs(paths, POLICY);
    expect(inspection).toMatchObject({
      pendingMaintenance: true,
      needsMaintenance: true,
      canMaintain: true,
    });
    const marker = await findTransactionArtifact(paths.logDir, "-maintenance.v1.json");
    expect((await lstat(marker)).mode & 0o777).toBe(0o600);

    await clearLaunchdLogMaintenanceIntent(paths, restoringIntent);
    await expect(readLaunchdLogMaintenanceIntent(paths)).resolves.toBeUndefined();
  });

  it("reclaims a partial intent preparation without granting restore authority", async () => {
    const paths = await fixture();
    const intent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.test-0a1b2c3d",
      plistFingerprint: `1:2:3:${"0".repeat(64)}`,
    };
    await beginLaunchdLogMaintenanceIntent(paths, intent);
    const stopped = await markLaunchdLogMaintenanceStopped(paths, intent);
    const marker = await findTransactionArtifact(paths.logDir, "-maintenance.v1.json");
    await clearLaunchdLogMaintenanceIntent(paths, stopped);
    const nextPath = marker.replace(/-maintenance\.v1\.json$/u, "-maintenance.v1.next");
    await privateFile(nextPath, "{");

    await expect(inspectLaunchdLogs(paths, POLICY)).resolves.toMatchObject({
      pendingMaintenance: false,
      pendingTransaction: false,
      needsMaintenance: true,
      canMaintain: true,
    });
    await expect(readLaunchdLogMaintenanceIntent(paths)).resolves.toBeUndefined();
    await clearLaunchdLogMaintenanceIntent(paths);
    await expect(lstat(nextPath)).rejects.toMatchObject({ code: "ENOENT" });
    await privateFile(nextPath, "{");

    await beginLaunchdLogMaintenanceIntent(paths, intent);
    await expect(readLaunchdLogMaintenanceIntent(paths)).resolves.toEqual(intent);
    await expect(lstat(nextPath)).rejects.toMatchObject({ code: "ENOENT" });
    const recoveredStopped = await markLaunchdLogMaintenanceStopped(paths, intent);
    await privateFile(nextPath, "partial");
    await clearLaunchdLogMaintenanceIntent(paths, recoveredStopped);
    await expect(lstat(nextPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an exact helper cleanup before durable stopped-writer proof", async () => {
    const paths = await fixture();
    const intent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.test-0a1b2c3d",
      plistFingerprint: `1:2:3:${"1".repeat(64)}`,
    };
    await beginLaunchdLogMaintenanceIntent(paths, intent);

    await expect(clearLaunchdLogMaintenanceIntent(paths))
      .rejects.toThrow(/exact authenticated value/u);
    await expect(clearLaunchdLogMaintenanceIntent(paths, intent))
      .rejects.toThrow(/before durable stopped-writer proof/u);
    const stopped = await markLaunchdLogMaintenanceStopped(paths, intent);
    await clearLaunchdLogMaintenanceIntent(paths, stopped);
  });

  it("repairs a safe broad log directory before publishing maintenance intent", async () => {
    const paths = await fixture();
    const intent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.test-0a1b2c3d",
      plistFingerprint: `1:2:3:${"b".repeat(64)}`,
    };
    await chmod(paths.logDir, 0o500);

    await beginLaunchdLogMaintenanceIntent(paths, intent);
    const stoppedIntent = await markLaunchdLogMaintenanceStopped(paths, intent);

    expect((await lstat(paths.logDir)).mode & 0o777).toBe(0o700);
    await expect(readLaunchdLogMaintenanceIntent(paths)).resolves.toEqual(stoppedIntent);
    await clearLaunchdLogMaintenanceIntent(paths, stoppedIntent);
  });

  it("refuses to clear a different or pathname-replaced maintenance intent", async () => {
    const paths = await fixture();
    const intent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.test-0a1b2c3d",
      plistFingerprint: `1:2:3:${"c".repeat(64)}`,
    };
    await beginLaunchdLogMaintenanceIntent(paths, intent);
    const stoppedIntent = await markLaunchdLogMaintenanceStopped(paths, intent);
    await expect(clearLaunchdLogMaintenanceIntent(paths, {
      ...stoppedIntent,
      plistFingerprint: `1:2:3:${"d".repeat(64)}`,
    })).rejects.toThrow(/changed before cleanup/u);

    const marker = await findTransactionArtifact(paths.logDir, "-maintenance.v1.json");
    const displaced = `${marker}.displaced`;
    const defaults = defaultLaunchdLogDependencies();
    const deps: LaunchdLogDependencies = {
      ...defaults,
      beforeCommit: async (path) => {
        if (path !== marker) return;
        await rename(marker, displaced);
        await privateFile(marker, "competitor");
      },
    };
    await expect(clearLaunchdLogMaintenanceIntent(paths, stoppedIntent, deps))
      .rejects.toThrow(/changed before required cleanup/u);
    expect(await readFile(marker, "utf8")).toBe("competitor");
    expect(await readFile(displaced, "utf8")).toContain(intent.plistFingerprint);
  });

  it("namespaces maintenance and rotation artifacts for agents sharing one log directory", async () => {
    const first = await fixture();
    const second: LaunchdPaths = {
      ...first,
      plistPath: join(first.launchAgentsDir, "com.mono-agent.other.plist"),
      stdoutPath: join(first.logDir, "com.mono-agent.other.out.log"),
      stderrPath: join(first.logDir, "com.mono-agent.other.err.log"),
    };
    const firstIntent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.test-0a1b2c3d",
      plistFingerprint: `1:2:3:${"e".repeat(64)}`,
    };
    const secondIntent = {
      version: 1 as const,
      phase: "stopping" as const,
      label: "com.mono-agent.other-1a2b3c4d",
      plistFingerprint: `4:5:6:${"f".repeat(64)}`,
    };

    await beginLaunchdLogMaintenanceIntent(first, firstIntent);
    await beginLaunchdLogMaintenanceIntent(second, secondIntent);
    const firstStopped = await markLaunchdLogMaintenanceStopped(first, firstIntent);
    const secondStopped = await markLaunchdLogMaintenanceStopped(second, secondIntent);
    await expect(readLaunchdLogMaintenanceIntent(first)).resolves.toEqual(firstStopped);
    await expect(readLaunchdLogMaintenanceIntent(second)).resolves.toEqual(secondStopped);

    await clearLaunchdLogMaintenanceIntent(second, secondStopped);
    await expect(readLaunchdLogMaintenanceIntent(first)).resolves.toEqual(firstStopped);
    await expect(readLaunchdLogMaintenanceIntent(second)).resolves.toBeUndefined();

    await privateFile(second.stdoutPath, "0123456789");
    await rotateStoppedLaunchdLogs(second, POLICY);
    expect(await readFile(`${second.stdoutPath}.1`, "utf8")).toBe("23456789");
    await expect(readLaunchdLogMaintenanceIntent(first)).resolves.toEqual(firstStopped);
    await clearLaunchdLogMaintenanceIntent(first, firstStopped);
  });

  it("derives one label for a missing config through lexical and symlinked parent aliases", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-launchd-config-alias-")));
    tempDirs.push(root);
    const canonicalParent = join(root, "canonical-agent");
    const aliasParent = join(root, "agent-alias");
    await mkdir(canonicalParent, { mode: 0o700 });
    await symlink(canonicalParent, aliasParent);

    const canonical = await launchdLogPathsForConfig(join(canonicalParent, "missing.json"), root);
    const alias = await launchdLogPathsForConfig(join(aliasParent, "missing.json"), root);

    expect(alias.stdoutPath).toBe(canonical.stdoutPath);
    expect(alias.stderrPath).toBe(canonical.stderrPath);
  });

  it("reports exact active, retained, and total bytes without rotating at the exact cap", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "12345678");
    await privateFile(`${paths.stdoutPath}.1`, "abc");

    const inspection = await inspectLaunchdLogs(paths, POLICY);

    expect(inspection.stdout).toMatchObject({ activeBytes: 8, retainedBytes: 3, totalBytes: 11 });
    expect(inspection.stderr).toMatchObject({ activeBytes: 0, retainedBytes: 0, totalBytes: 0 });
    expect(inspection).toMatchObject({ present: true, canMaintain: true, needsMaintenance: false });
  });

  it("marks cap-plus-one and oversized retained generations for maintenance", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "123456789");
    await privateFile(paths.stderrPath, "ok");
    await privateFile(`${paths.stderrPath}.1`, "abcdefghij");

    const inspection = await inspectLaunchdLogs(paths, POLICY);

    expect(inspection.needsMaintenance).toBe(true);
    expect(inspection.stdout.files[0]).toMatchObject({ generation: 0, bytes: 9 });
    expect(inspection.stderr.files[1]).toMatchObject({ generation: 1, bytes: 10 });
  });

  it("reports broad permissions but never repairs them during read-only inspection", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "private");
    await chmod(paths.stdoutPath, 0o644);

    const inspection = await inspectLaunchdLogs(paths, POLICY);

    expect(inspection.stdout.files[0]).toMatchObject({ state: "repairable", bytes: 7 });
    expect(inspection.needsMaintenance).toBe(true);
    expect((await lstat(paths.stdoutPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("private");
  });

  it("marks owner-only but unusable modes as repairable without changing them", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "private");
    await chmod(paths.stdoutPath, 0o400);
    await chmod(paths.logDir, 0o500);
    try {
      const inspection = await inspectLaunchdLogs(paths, POLICY);

      expect(inspection.needsMaintenance).toBe(true);
      expect(inspection.issues.join(" ")).toContain("owner-only read/write/search");
      expect(inspection.stdout.files[0]).toMatchObject({ state: "repairable", bytes: 7 });
      expect((await lstat(paths.logDir)).mode & 0o777).toBe(0o500);
      expect((await lstat(paths.stdoutPath)).mode & 0o777).toBe(0o400);
    } finally {
      await chmod(paths.logDir, 0o700);
      await chmod(paths.stdoutPath, 0o600);
    }
  });

  it("rejects symlinks, hard links, and owner mismatches without reading their contents", async () => {
    const paths = await fixture();
    const outside = join(tempDirs.at(-1)!, "outside.log");
    await privateFile(outside, "outside-secret");
    await symlink(outside, paths.stdoutPath);
    await link(outside, `${paths.stderrPath}.1`);

    const linked = await inspectLaunchdLogs(paths, POLICY);
    expect(linked.canMaintain).toBe(false);
    expect(linked.issues.join(" ")).toMatch(/symbolic-link|filesystem link/u);
    expect(linked.stdout.byteAccountingComplete).toBe(false);
    expect(linked.stderr.byteAccountingComplete).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("outside-secret");
  });

  it("rejects a foreign-owned log after validating its current-user-owned directory", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "private");
    const defaults = defaultLaunchdLogDependencies();
    const currentUid = defaults.currentUid();
    if (currentUid === undefined) return;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      lstat: async (path) => {
        const details = await defaults.lstat(path);
        return path === paths.stdoutPath
          ? new Proxy(details, {
              get: (target, property) => {
                if (property === "uid") return currentUid + 1;
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          : details;
      },
    };

    const inspection = await inspectLaunchdLogs(paths, POLICY, deps);

    expect(inspection.stdout.files[0]).toMatchObject({ state: "unsafe" });
    expect(inspection.stdout.files[0]?.issue).toContain("not owned by the current user");
    expect(inspection.stdout.byteAccountingComplete).toBe(false);
    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow(/not owned by the current user/u);
  });

  it("accounts regular log bytes through metadata without reading file contents", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "private");
    const defaults = defaultLaunchdLogDependencies();
    let contentReads = 0;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      open: async (path, flags, mode) => {
        const handle = await defaults.open(path, flags, mode);
        if (path !== paths.stdoutPath) return handle;
        return new Proxy(handle, {
          get: (target, property) => {
            if (property === "read" || property === "readFile") {
              return async () => {
                contentReads += 1;
                throw new Error("inspection attempted a content read");
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };

    const inspection = await inspectLaunchdLogs(paths, POLICY, deps);

    expect(inspection.stdout.files[0]).toMatchObject({ state: "ok", bytes: 7 });
    expect(inspection.stdout.byteAccountingComplete).toBe(true);
    expect(contentReads).toBe(0);
  });

  it("rejects a symlinked canonical parent without following it", async () => {
    const paths = await fixture();
    const stateDir = dirname(paths.logDir);
    const displaced = join(tempDirs.at(-1)!, "displaced-state");
    await privateFile(paths.stdoutPath, "private");
    await rename(stateDir, displaced);
    await symlink(displaced, stateDir);

    const inspection = await inspectLaunchdLogs(paths, POLICY);

    expect(inspection.canMaintain).toBe(false);
    expect(inspection.issues.join(" ")).toMatch(/real directory|symbolic-link|non-canonical parent/u);
    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).rejects.toThrow(/real directory|symbolic-link|non-canonical/u);
    expect(await readFile(join(displaced, "logs", basename(paths.stdoutPath)), "utf8")).toBe("private");
  });

  it("does not block when a validated regular log is swapped for a fifo before open", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "private");
    const defaults = defaultLaunchdLogDependencies();
    let swapped = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      lstat: async (path) => {
        const details = await defaults.lstat(path);
        if (path === paths.stdoutPath && !swapped) {
          swapped = true;
          await rm(path);
          await execFileAsync("mkfifo", [path]);
        }
        return details;
      },
    };

    const inspection = await inspectLaunchdLogs(paths, POLICY, deps);

    expect(inspection.canMaintain).toBe(false);
    expect(inspection.stdout.files[0]).toMatchObject({ state: "unsafe" });
  });
});

describe("rotateStoppedLaunchdLogs", () => {
  it("tail-caps active logs and shifts at most three bounded owner-only generations", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    await privateFile(`${paths.stdoutPath}.1`, "abcdefghij");
    await privateFile(`${paths.stdoutPath}.2`, "KLM");
    await privateFile(`${paths.stdoutPath}.3`, "discard-me");

    const result = await rotateStoppedLaunchdLogs(paths, POLICY);

    expect(result).toEqual({ changed: true, replacedFiles: 4 });
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("");
    expect(await readFile(`${paths.stdoutPath}.1`, "utf8")).toBe("23456789");
    expect(await readFile(`${paths.stdoutPath}.2`, "utf8")).toBe("cdefghij");
    expect(await readFile(`${paths.stdoutPath}.3`, "utf8")).toBe("KLM");
    for (const path of [paths.stdoutPath, `${paths.stdoutPath}.1`, `${paths.stdoutPath}.2`, `${paths.stdoutPath}.3`]) {
      const details = await lstat(path);
      expect(details.size).toBeLessThanOrEqual(POLICY.maxBytes);
      expect(details.mode & 0o777).toBe(0o600);
      expect(details.nlink).toBe(1);
    }
  });

  it("caps an oversized existing .1 even when the active file is small", async () => {
    const paths = await fixture();
    await privateFile(paths.stderrPath, "active");
    await privateFile(`${paths.stderrPath}.1`, "0123456789");

    const result = await rotateStoppedLaunchdLogs(paths, POLICY);

    expect(result).toEqual({ changed: true, replacedFiles: 1 });
    expect(await readFile(paths.stderrPath, "utf8")).toBe("active");
    expect(await readFile(`${paths.stderrPath}.1`, "utf8")).toBe("23456789");
  });

  it("keeps every file bounded across repeated rotations", async () => {
    const paths = await fixture();
    for (const value of ["first-oversize", "second-oversize", "third-oversize", "fourth-oversize"]) {
      await privateFile(paths.stdoutPath, value);
      await rotateStoppedLaunchdLogs(paths, POLICY);
      for (const path of [paths.stdoutPath, `${paths.stdoutPath}.1`, `${paths.stdoutPath}.2`, `${paths.stdoutPath}.3`]) {
        const details = await lstat(path).catch(() => undefined);
        if (details !== undefined) expect(details.size).toBeLessThanOrEqual(POLICY.maxBytes);
      }
    }
    await expect(lstat(`${paths.stdoutPath}.4`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs owner-only permissions only after every path validates", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "small");
    await chmod(paths.stdoutPath, 0o644);

    const result = await rotateStoppedLaunchdLogs(paths, POLICY);

    expect(result).toEqual({ changed: true, replacedFiles: 0 });
    expect((await lstat(paths.stdoutPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("small");
  });

  it("does not repair an otherwise safe file when any peer path is unsafe", async () => {
    const paths = await fixture();
    const outside = join(tempDirs.at(-1)!, "outside.log");
    await privateFile(paths.stdoutPath, "small");
    await chmod(paths.stdoutPath, 0o644);
    await privateFile(outside, "linked");
    await link(outside, paths.stderrPath);

    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).rejects.toThrow(/exactly one filesystem link/u);
    expect((await lstat(paths.stdoutPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("small");
  });

  it("fails closed on symlink and hardlink competitors without modifying their target", async () => {
    const paths = await fixture();
    const outside = join(tempDirs.at(-1)!, "outside.log");
    await privateFile(outside, "outside-secret");
    await symlink(outside, paths.stdoutPath);

    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).rejects.toThrow(/non-symbolic-link/u);
    expect(await readFile(outside, "utf8")).toBe("outside-secret");

    await rm(paths.stdoutPath);
    await link(outside, paths.stdoutPath);
    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).rejects.toThrow(/exactly one filesystem link/u);
    expect(await readFile(outside, "utf8")).toBe("outside-secret");
  });

  it("detects a destination inode swap immediately before commit", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    await privateFile(`${paths.stdoutPath}.1`, "old-one");
    const displaced = `${paths.stdoutPath}.1.displaced`;
    const defaults = defaultLaunchdLogDependencies();
    let swapped = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      beforeCommit: async (path) => {
        if (path !== `${paths.stdoutPath}.1` || swapped) return;
        swapped = true;
        await rename(path, displaced);
        await privateFile(path, "attacker");
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow(/changed before commit/u);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("0123456789");
    expect(await readFile(`${paths.stdoutPath}.1`, "utf8")).toBe("attacker");
    expect(await readFile(displaced, "utf8")).toBe("old-one");
    // Earlier records may already be durably committed under the journal. The
    // retry contract is partial-but-idempotent, never an unjournaled rollback.
    expect(await readFile(`${paths.stdoutPath}.2`, "utf8")).toBe("old-one");
  });

  it("rejects an absent destination that appears immediately before commit", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const destination = `${paths.stdoutPath}.1`;
    const defaults = defaultLaunchdLogDependencies();
    const deps: LaunchdLogDependencies = {
      ...defaults,
      beforeCommit: async (path) => {
        if (path === destination) await privateFile(destination, "competitor");
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow(/changed before commit/u);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("0123456789");
    expect(await readFile(destination, "utf8")).toBe("competitor");
  });

  it("rejects a source that changes while its bounded tail is copied", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const defaults = defaultLaunchdLogDependencies();
    let changed = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      readTail: async (handle, size, maxBytes) => {
        const bytes = await defaults.readTail(handle, size, maxBytes);
        if (!changed) {
          changed = true;
          await privateFile(paths.stdoutPath, "source-changed");
        }
        return bytes;
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps))
      .rejects.toThrow(/changed while its bounded tail was copied/u);
    await expect(lstat(`${paths.stdoutPath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a substituted deterministic stage before target mutation and preserves the competitor", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const defaults = defaultLaunchdLogDependencies();
    const stagePath = join(paths.logDir, `.${basename(`${paths.stdoutPath}.1`)}.rotate.stage`);
    const displaced = `${stagePath}.displaced`;
    let swapped = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      beforeCommit: async (path) => {
        if (path !== `${paths.stdoutPath}.1` || swapped) return;
        swapped = true;
        await rename(stagePath, displaced);
        await privateFile(stagePath, "attacker");
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow(/changed before commit/u);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("0123456789");
    await expect(lstat(`${paths.stdoutPath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(stagePath, "utf8")).toBe("attacker");
    expect(await readFile(displaced, "utf8")).toBe("23456789");
  });

  it("preserves a deterministic stage-name competitor that appears before exclusive create", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const stagePath = join(paths.logDir, `.${basename(`${paths.stdoutPath}.1`)}.rotate.stage`);
    const defaults = defaultLaunchdLogDependencies();
    let collided = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      open: async (path, flags, mode) => {
        if (path === stagePath && !collided) {
          collided = true;
          await privateFile(stagePath, "competitor");
        }
        return await defaults.open(path, flags, mode);
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(stagePath, "utf8")).toBe("competitor");
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("0123456789");
    await expect(lstat(`${paths.stdoutPath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a canonical parent swap before commit without touching the redirected tree", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const stateDir = dirname(paths.logDir);
    const displaced = join(tempDirs.at(-1)!, "displaced-state");
    const attackerState = join(tempDirs.at(-1)!, "attacker-state");
    const attackerLogs = join(attackerState, "logs");
    await mkdir(attackerLogs, { recursive: true, mode: 0o700 });
    const attackerTarget = join(attackerLogs, basename(`${paths.stdoutPath}.1`));
    await privateFile(attackerTarget, "attacker");
    const defaults = defaultLaunchdLogDependencies();
    let swapped = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      beforeCommit: async () => {
        if (swapped) return;
        swapped = true;
        await rename(stateDir, displaced);
        await symlink(attackerState, stateDir);
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow(/real directory|changed/u);
    expect(await readFile(attackerTarget, "utf8")).toBe("attacker");
    expect(await readFile(join(displaced, "logs", basename(paths.stdoutPath)), "utf8")).toBe("0123456789");
  });

  it("rejects replacement of the canonical log-directory inode before commit", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const displaced = join(tempDirs.at(-1)!, "displaced-logs");
    const attackerTarget = join(paths.logDir, basename(`${paths.stdoutPath}.1`));
    const defaults = defaultLaunchdLogDependencies();
    let swapped = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      beforeCommit: async () => {
        if (swapped) return;
        swapped = true;
        await rename(paths.logDir, displaced);
        await mkdir(paths.logDir, { mode: 0o700 });
        await privateFile(attackerTarget, "attacker");
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow(/directory.*changed/u);
    expect(await readFile(attackerTarget, "utf8")).toBe("attacker");
    expect(await readFile(join(displaced, basename(paths.stdoutPath)), "utf8")).toBe("0123456789");
  });

  it("recovers a partial journaled shift exactly once on retry", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    await privateFile(`${paths.stdoutPath}.1`, "abcdefghij");
    await privateFile(`${paths.stdoutPath}.2`, "KLM");
    await privateFile(`${paths.stdoutPath}.3`, "discard-me");
    const defaults = defaultLaunchdLogDependencies();
    let committed = 0;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      rename: async (from, to) => {
        if (from.endsWith(".rotate.stage")) {
          committed += 1;
          if (committed === 3) throw new Error("injected mid-commit failure");
        }
        await defaults.rename(from, to);
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps)).rejects.toThrow("injected mid-commit failure");
    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).resolves.toMatchObject({ changed: true });

    expect(await readFile(paths.stdoutPath, "utf8")).toBe("");
    expect(await readFile(`${paths.stdoutPath}.1`, "utf8")).toBe("23456789");
    expect(await readFile(`${paths.stdoutPath}.2`, "utf8")).toBe("cdefghij");
    expect(await readFile(`${paths.stdoutPath}.3`, "utf8")).toBe("KLM");
    expect((await readdir(paths.logDir)).some((name) => name.endsWith("-rotation.v1.json"))).toBe(false);
  });

  it("recovers after directory fsync fails following a committed replacement", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const defaults = defaultLaunchdLogDependencies();
    let replacementCommitted = false;
    let injected = false;
    const deps: LaunchdLogDependencies = {
      ...defaults,
      rename: async (from, to) => {
        await defaults.rename(from, to);
        if (from.endsWith(".rotate.stage")) replacementCommitted = true;
      },
      syncHandle: async (handle) => {
        if (replacementCommitted && !injected) {
          injected = true;
          throw new Error("injected post-commit directory fsync failure");
        }
        await defaults.syncHandle(handle);
      },
    };

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, deps))
      .rejects.toThrow("injected post-commit directory fsync failure");
    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).resolves.toMatchObject({ changed: true });
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("");
    expect(await readFile(`${paths.stdoutPath}.1`, "utf8")).toBe("23456789");
  });

  it("reclaims a deterministic orphan stage before publishing a fresh transaction", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const orphan = join(paths.logDir, `.${basename(`${paths.stdoutPath}.3`)}.rotate.stage`);
    await privateFile(orphan, "orphan");

    await expect(rotateStoppedLaunchdLogs(paths, POLICY)).resolves.toMatchObject({ changed: true });

    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${paths.stdoutPath}.1`, "utf8")).toBe("23456789");
  });

  it.each([
    ["tail copy", (defaults: LaunchdLogDependencies): LaunchdLogDependencies => ({
      ...defaults,
      readTail: async () => { throw new Error("copy failed"); },
    }), /copy failed/u],
    ["fsync", (defaults: LaunchdLogDependencies): LaunchdLogDependencies => ({
      ...defaults,
      syncHandle: async () => { throw new Error("fsync failed"); },
    }), /fsync failed/u],
    ["rename", (defaults: LaunchdLogDependencies): LaunchdLogDependencies => ({
      ...defaults,
      rename: async () => { throw new Error("rename failed"); },
    }), /rename failed/u],
  ] as const)("surfaces %s failures instead of claiming success", async (_name, override, expected) => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, override(defaultLaunchdLogDependencies())))
      .rejects.toThrow(expected);
  });

  it("rejects an adversarial tail reader that exceeds the fixed cap before commit", async () => {
    const paths = await fixture();
    await privateFile(paths.stdoutPath, "0123456789");
    const defaults = defaultLaunchdLogDependencies();

    await expect(rotateStoppedLaunchdLogs(paths, POLICY, {
      ...defaults,
      readTail: async () => Buffer.alloc(POLICY.maxBytes + 1),
    })).rejects.toThrow(/oversized bounded tail/u);
    expect(await readFile(paths.stdoutPath, "utf8")).toBe("0123456789");
    await expect(lstat(`${paths.stdoutPath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
