import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireWebStateLease,
  defaultWebStateDir,
  prepareWebStatePaths,
  resetWebState,
  resolveWebStatePaths,
} from "../state-paths.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("web state ownership", () => {
  it("creates an owner-private marked layout and ignores environment redirection", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const stateDir = join(base, "state");
    const paths = await prepareWebStatePaths({ stateDir });

    expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.uploads)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.logs)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(paths.marker, "utf8"))).toEqual({ schema: 1, kind: "mono-agent-web-state" });
    expect(resolveWebStatePaths({ env: { MONO_AGENT_WEB_STATE_DIR: join(base, "evil") } }).root).toBe(defaultWebStateDir());
  });

  it("will not adopt an existing unmarked or symlinked directory", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const unmarked = join(base, "unmarked");
    await mkdir(unmarked);
    await expect(prepareWebStatePaths({ stateDir: unmarked })).rejects.toMatchObject({ code: "invalid_state_root" });

    const real = join(base, "real");
    await mkdir(real);
    const linked = join(base, "linked");
    await symlink(real, linked);
    await expect(prepareWebStatePaths({ stateDir: linked })).rejects.toMatchObject({ code: "invalid_state_root" });
  });

  it("resets only console data while preserving the root marker and lifecycle files", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const paths = await prepareWebStatePaths({ stateDir: join(base, "state") });
    await writeFile(paths.database, "db", { mode: 0o600 });
    await writeFile(paths.notificationIngress, "{}", { mode: 0o600 });
    await writeFile(join(paths.uploads, "orphan.bin"), "bytes", { mode: 0o600 });
    await writeFile(join(paths.root, "worker.lock"), "lifecycle", { mode: 0o600 });

    await resetWebState({ stateDir: paths.root });

    expect(await readFile(paths.marker, "utf8")).toContain("mono-agent-web-state");
    expect(await readFile(join(paths.root, "worker.lock"), "utf8")).toBe("lifecycle");
    await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.notificationIngress)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(paths.uploads)).toEqual([]);
  });

  it("uses the service lease as an atomic reset exclusion boundary", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const paths = await prepareWebStatePaths({ stateDir: join(base, "state") });
    const lease = await acquireWebStateLease(paths);
    const preparedAt = Date.now();
    await expect(prepareWebStatePaths({ stateDir: paths.root })).resolves.toMatchObject({ root: paths.root });
    expect(Date.now() - preparedAt).toBeLessThan(1_000);
    await expect(acquireWebStateLease(paths)).rejects.toMatchObject({ code: "web_service_running" });
    await expect(resetWebState({ stateDir: paths.root })).rejects.toMatchObject({ code: "web_service_running" });
    await lease.release();
    await expect(resetWebState({ stateDir: paths.root })).resolves.toBeUndefined();
  });

  it("rejects owner-writable-looking marker substitutions", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const paths = await prepareWebStatePaths({ stateDir: join(base, "state") });
    await chmod(paths.marker, 0o600);
    const replacement = join(base, "replacement");
    await writeFile(replacement, "{}", { mode: 0o600 });
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.marker);
    await symlink(replacement, paths.marker);
    await expect(resetWebState({ stateDir: paths.root })).rejects.toMatchObject({ code: "invalid_state_root" });
  });

  it("uses an OS-released SQLite lock across processes without stale cleanup", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const paths = await prepareWebStatePaths({ stateDir: join(base, "state") });
    const script = [
      'import { DatabaseSync } from "node:sqlite";',
      "const database = new DatabaseSync(process.argv[1], { timeout: 0 });",
      'database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");',
      'process.stdout.write("locked\\n");',
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, paths.leaseDatabase], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await once(child.stdout, "data");
    await expect(acquireWebStateLease(paths)).rejects.toMatchObject({ code: "web_service_running" });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const lease = await acquireWebStateLease(paths);
    await lease.release();
  });
});
