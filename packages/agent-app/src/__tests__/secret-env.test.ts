import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SecretEnvConcurrentModificationError,
  initMonoAgentFolder,
  mergeSecretEnvFile,
  secretEnvLockPathFor,
  verifySecretEnvPersistenceGuard,
} from "../init.js";

let dir: string;
const SECRET_IGNORE_BLOCK = "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-secret-env-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("mergeSecretEnvFile", () => {
  it("round-trips dotenv-sensitive values without exposing them in its result", async () => {
    const envPath = join(dir, ".env");
    const values = {
      SPACE: "  padded value  ",
      HASH: "token#fragment",
      DOLLAR: "$not-expanded/${still-data}",
      EQUALS: "left=right=again",
      BACKSLASH: String.raw`literal\n\path`,
      NEWLINE: "line one\nline two",
      SINGLE_QUOTE: "it's-secret",
      DOUBLE_QUOTE: 'say "secret"',
      BOTH_QUOTES: `it's a "secret"`,
    };

    const result = await mergeSecretEnvFile(envPath, values);

    expect(parseEnv(await readFile(envPath, "utf8"))).toMatchObject(values);
    expect(JSON.stringify(result)).not.toContain("token#fragment");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(SECRET_IGNORE_BLOCK);
    expect(result.changes).toContainEqual({ path: envPath, kind: "created", sensitive: true });
  });

  it("preserves comments, exports, and non-empty values while filling empty placeholders", async () => {
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      [
        "# retain this header",
        "export KEEP = 'operator-value' # retain inline",
        "EMPTY=",
        "COMMENTED= # fill this",
        'QUOTED="" # fill quoted',
        "",
      ].join("\n"),
    );

    const result = await mergeSecretEnvFile(envPath, {
      KEEP: "must-not-win",
      EMPTY: "now-set",
      COMMENTED: "hash#safe",
      QUOTED: "quoted-set",
    });
    const contents = await readFile(envPath, "utf8");

    expect(parseEnv(contents)).toMatchObject({
      KEEP: "operator-value",
      EMPTY: "now-set",
      COMMENTED: "hash#safe",
      QUOTED: "quoted-set",
    });
    expect(contents).toContain("# retain this header");
    expect(contents).toContain("export KEEP = 'operator-value' # retain inline");
    expect(contents).toContain("# fill this");
    expect(contents).toContain("# fill quoted");
    expect(result.valuesChanged).toBe(3);
  });

  it("preserves mixed line endings and ignores assignment-shaped text inside multiline values", async () => {
    const envPath = join(dir, ".env");
    const originalPrefix = "OTHER='first\r\nTOKEN=\nlast'\r\n";
    await writeFile(envPath, `${originalPrefix}EMPTY=\nTAIL=kept`);

    await mergeSecretEnvFile(envPath, { TOKEN: "real-token", EMPTY: "filled" });
    const contents = await readFile(envPath, "utf8");

    expect(contents.startsWith(originalPrefix)).toBe(true);
    expect(parseEnv(contents)).toMatchObject({
      OTHER: "first\nTOKEN=\nlast",
      TOKEN: "real-token",
      EMPTY: "filled",
      TAIL: "kept",
    });
  });

  it("refuses an env symlink without modifying its target", async () => {
    const victimPath = join(dir, "victim.txt");
    const envPath = join(dir, ".env");
    await writeFile(victimPath, "do-not-touch\n");
    await symlink(victimPath, envPath);

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-env-path",
    });
    expect(await readFile(victimPath, "utf8")).toBe("do-not-touch\n");
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a non-regular env path", async () => {
    const envPath = join(dir, ".env");
    await mkdir(envPath);

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-env-path",
    });
  });

  it("refuses an unsafe gitignore without creating the env file", async () => {
    const envPath = join(dir, ".env");
    const victimPath = join(dir, "ignore-victim.txt");
    await writeFile(victimPath, "keep\n");
    await symlink(victimPath, join(dir, ".gitignore"));

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-gitignore-path",
    });
    expect(await readFile(victimPath, "utf8")).toBe("keep\n");
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a non-regular gitignore path", async () => {
    const envPath = join(dir, ".env");
    await mkdir(join(dir, ".gitignore"));

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-gitignore-path",
    });
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a git-tracked env before changing either file", async () => {
    const envPath = join(dir, ".env");
    await run("git", ["init", "-q"], dir);
    await writeFile(envPath, "TOKEN=tracked-value\n");
    await run("git", ["add", ".env"], dir);

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "replacement" })).rejects.toMatchObject({ code: "tracked-env" });
    expect(await readFile(envPath, "utf8")).toBe("TOKEN=tracked-value\n");
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses persistence in a group/world-writable parent before creating files", async () => {
    const envPath = join(dir, ".env");
    await chmod(dir, 0o777);

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-env-path",
      message: expect.stringContaining("owned by the current user and not group/world-writable"),
    });
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a multiply-linked env without changing either alias", async () => {
    const envPath = join(dir, ".env");
    const aliasPath = join(dir, "env-alias");
    await writeFile(envPath, "TOKEN=operator\n", { mode: 0o600 });
    await link(envPath, aliasPath);

    await expect(mergeSecretEnvFile(envPath, { SECOND: "secret" })).rejects.toMatchObject({
      code: "unsafe-env-path",
      message: expect.stringContaining("hard-link identity is unsafe"),
    });
    expect(await readFile(envPath, "utf8")).toBe("TOKEN=operator\n");
    expect(await readFile(aliasPath, "utf8")).toBe("TOKEN=operator\n");
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a multiply-linked gitignore before committing an env", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    const aliasPath = join(dir, "gitignore-alias");
    await writeFile(ignorePath, "dist/\n", { mode: 0o644 });
    await link(ignorePath, aliasPath);

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-gitignore-path",
      message: expect.stringContaining("hard-link identity is unsafe"),
    });
    expect(await readFile(ignorePath, "utf8")).toBe("dist/\n");
    expect(await readFile(aliasPath, "utf8")).toBe("dist/\n");
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("operates on the canonical parent while preserving reported paths", async () => {
    const physical = join(dir, "physical");
    const alias = join(dir, "agent-link");
    await mkdir(physical, { mode: 0o700 });
    await symlink(physical, alias);
    const envPath = join(alias, ".env");
    let observedPath = "";

    const result = await mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      beforeCommit(targetPath) {
        if (targetPath === envPath) observedPath = targetPath;
      },
    });

    expect(observedPath).toBe(envPath);
    expect(result.changes).toContainEqual({ path: envPath, kind: "created", sensitive: true });
    expect(parseEnv(await readFile(join(physical, ".env"), "utf8"))).toMatchObject({ TOKEN: "secret" });
    expect((await readdir(physical)).filter((name) => name.includes("mono-agent-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("adds one exact root env ignore rule and leaves it stable on subsequent merges", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    await writeFile(ignorePath, "dist/\n.env.local\n");

    await mergeSecretEnvFile(envPath, { TOKEN: "first" });
    const first = await readFile(ignorePath, "utf8");
    const second = await mergeSecretEnvFile(envPath, { TOKEN: "must-not-replace" });

    expect(first).toBe(`dist/\n.env.local\n${SECRET_IGNORE_BLOCK}`);
    expect(await readFile(ignorePath, "utf8")).toBe(first);
    expect(second.changes).toContainEqual({ path: ignorePath, kind: "unchanged" });
    expect(second.valuesChanged).toBe(0);
  });

  it("places the exact env ignore after a later negation", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    await run("git", ["init", "-q"], dir);
    await writeFile(ignorePath, "/.env\n!/.env\n");

    await mergeSecretEnvFile(envPath, { TOKEN: "secret" });

    expect(await readFile(ignorePath, "utf8")).toBe(`/.env\n!/.env\n${SECRET_IGNORE_BLOCK}`);
    await expect(run("git", ["check-ignore", "--quiet", "--no-index", ".env"], dir)).resolves.toBeUndefined();
  });

  it("removes group/world write access from the gitignore guard", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    await writeFile(envPath, "TOKEN=operator\n", { mode: 0o600 });
    await writeFile(ignorePath, SECRET_IGNORE_BLOCK, { mode: 0o644 });
    await chmod(ignorePath, 0o666);

    const result = await mergeSecretEnvFile(envPath, {}, { secureExistingFile: true });

    expect(await readFile(ignorePath, "utf8")).toBe(SECRET_IGNORE_BLOCK);
    expect((await stat(ignorePath)).mode & 0o777).toBe(0o644);
    expect(result.changes).toContainEqual({ path: ignorePath, kind: "updated" });
  });

  it("fails before modifying anything when a value has no lossless Node dotenv representation", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    await writeFile(envPath, "KEEP=original\n");
    await writeFile(ignorePath, "dist/\n");

    await expect(mergeSecretEnvFile(envPath, { TOKEN: ` both ' and " quotes ` })).rejects.toMatchObject({
      code: "unrepresentable-secret-value",
    });
    expect(await readFile(envPath, "utf8")).toBe("KEEP=original\n");
    expect(await readFile(ignorePath, "utf8")).toBe("dist/\n");
  });

  it("keeps the original env and removes its exclusive temp file when a write seam fails", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TOKEN=\n");
    await writeFile(join(dir, ".gitignore"), "/.env\n");

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      beforeCommit(targetPath) {
        if (targetPath === envPath) throw new Error("injected write failure");
      },
    })).rejects.toThrow("injected write failure");

    expect(await readFile(envPath, "utf8")).toBe("TOKEN=\n");
    expect((await readdir(dir)).filter((name) => name.includes("mono-agent-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("detects concurrent replacement and never overwrites the newer env", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TOKEN=\n");
    await writeFile(join(dir, ".gitignore"), "/.env\n");

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      async beforeCommit(targetPath) {
        if (targetPath === envPath) await writeFile(envPath, "TOKEN=concurrent\n");
      },
    })).rejects.toBeInstanceOf(SecretEnvConcurrentModificationError);

    expect(await readFile(envPath, "utf8")).toBe("TOKEN=concurrent\n");
    expect((await readdir(dir)).filter((name) => name.includes("mono-agent-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves a writer that wins after the final optimistic check", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TOKEN=original\n", { mode: 0o600 });

    await expect(mergeSecretEnvFile(envPath, { SECOND: "mono-agent" }, {
      async beforePromotion(targetPath) {
        if (targetPath === envPath) {
          await writeFile(envPath, "TOKEN=CONCURRENT_LAST_WINDOW\n", { mode: 0o600 });
        }
      },
    })).rejects.toBeInstanceOf(SecretEnvConcurrentModificationError);

    expect(await readFile(envPath, "utf8")).toBe("TOKEN=CONCURRENT_LAST_WINDOW\n");
    expect((await readdir(dir)).filter((name) => name.includes("mono-agent-") && name.endsWith(".backup"))).toEqual([]);
  });

  it("rejects a hard-link alias added before claim and reports the retained inode", async () => {
    const envPath = join(dir, ".env");
    const aliasPath = join(dir, "concurrent-env-alias");
    const original = "TOKEN=original\n";
    await writeFile(envPath, original, { mode: 0o600 });
    await writeFile(join(dir, ".gitignore"), SECRET_IGNORE_BLOCK);

    let failure: unknown;
    try {
      await mergeSecretEnvFile(envPath, { SECOND: "secret" }, {
        async beforePromotion(targetPath) {
          if (targetPath === envPath) await link(envPath, aliasPath);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const recoveryPath = (failure as SecretEnvConcurrentModificationError).recoveryPath;
    expect(recoveryPath).toBeDefined();
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(aliasPath, "utf8")).toBe(original);
    expect(await readFile(recoveryPath!, "utf8")).toBe(original);
    expect((await stat(recoveryPath!)).nlink).toBe(2);
    await rm(recoveryPath!);
  });

  it("surfaces the owner-only recovery copy when promotion fails after claiming the target", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TOKEN=original\n", { mode: 0o600 });

    let failure: unknown;
    try {
      await mergeSecretEnvFile(envPath, { SECOND: "mono-agent" }, {
        beforeInstallLink() {
          const error = new Error("injected install failure") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const recoveryPath = (failure as SecretEnvConcurrentModificationError).recoveryPath;
    expect(recoveryPath).toBeDefined();
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recoveryPath!, "utf8")).toBe("TOKEN=original\n");
    expect((await stat(recoveryPath!)).mode & 0o777).toBe(0o600);
    expect((failure as Error).message).toContain(recoveryPath!);
    await rm(recoveryPath!, { force: true });
  });

  it("detects and preserves a writer using the claimed env inode through an open descriptor", async () => {
    const envPath = join(dir, ".env");
    const concurrent = "TOKEN=OPEN_FD_CONCURRENT\n";
    await writeFile(envPath, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(join(dir, ".gitignore"), SECRET_IGNORE_BLOCK);
    const held = await open(envPath, "r+");

    let failure: unknown;
    try {
      await mergeSecretEnvFile(envPath, { SECOND: "mono-agent" }, {
        async afterInstallLink() {
          await held.truncate(0);
          await held.write(concurrent, 0, "utf8");
          await held.sync();
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      await held.close();
    }

    expect(failure).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const recoveryPath = (failure as SecretEnvConcurrentModificationError).recoveryPath;
    expect(recoveryPath).toBeDefined();
    expect(await readFile(recoveryPath!, "utf8")).toBe(concurrent);
    expect((await stat(recoveryPath!)).mode & 0o777).toBe(0o600);
    expect(parseEnv(await readFile(envPath, "utf8"))).toMatchObject({
      TOKEN: "original",
      SECOND: "mono-agent",
    });
    await rm(recoveryPath!, { force: true });
  });

  it("revalidates the committed ignore file immediately before promoting a secret", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    await writeFile(ignorePath, "/.env\n");

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      async beforeCommit(targetPath) {
        if (targetPath === envPath) await writeFile(ignorePath, "dist/\n");
      },
    })).rejects.toBeInstanceOf(SecretEnvConcurrentModificationError);

    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(ignorePath, "utf8")).toBe("dist/\n");
    expect((await readdir(dir)).filter((name) => name.endsWith(".mono-agent.lock"))).toEqual([]);
    expect((await readdir(dir)).filter((name) => name.includes("mono-agent-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("rechecks git tracking after the write seam and leaves a newly tracked env unchanged", async () => {
    const envPath = join(dir, ".env");
    await run("git", ["init", "-q"], dir);
    await writeFile(envPath, "TOKEN=\n", { mode: 0o600 });
    await writeFile(join(dir, ".gitignore"), "/.env\n");

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      async beforeCommit(targetPath) {
        if (targetPath === envPath) await run("git", ["add", "-f", ".env"], dir);
      },
    })).rejects.toMatchObject({ code: "tracked-env" });

    expect(await readFile(envPath, "utf8")).toBe("TOKEN=\n");
    await expect(run("git", ["ls-files", "--error-unmatch", ".env"], dir)).resolves.toBeUndefined();
    expect((await readdir(dir)).filter((name) => name.endsWith(".mono-agent.lock"))).toEqual([]);
  });

  it("serializes the complete merge so concurrent writers cannot lose an update", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "BASE=kept\n", { mode: 0o600 });
    await writeFile(join(dir, ".gitignore"), "/.env\n");
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      markFirstReady = resolve;
    });

    const first = mergeSecretEnvFile(envPath, { FIRST: "one" }, {
      async beforeCommit(targetPath) {
        if (targetPath !== envPath) return;
        markFirstReady();
        await firstMayCommit;
      },
    });
    await firstReady;

    await expect(mergeSecretEnvFile(envPath, { SECOND: "two" }))
      .rejects.toBeInstanceOf(SecretEnvConcurrentModificationError);
    releaseFirst();
    await first;

    // Retrying after the first transaction releases its lock merges against the
    // committed snapshot instead of overwriting it.
    await mergeSecretEnvFile(envPath, { SECOND: "two" });
    expect(parseEnv(await readFile(envPath, "utf8"))).toMatchObject({
      BASE: "kept",
      FIRST: "one",
      SECOND: "two",
    });
    expect((await readdir(dir)).filter((name) => name.endsWith(".mono-agent.lock"))).toEqual([]);
  });

  it("fails closed with manual recovery for a durable lock whose owner process is dead", async () => {
    const envPath = join(dir, ".env");
    const lockPath = await secretEnvLockPathFor(envPath);
    if (typeof process.getuid !== "function") throw new Error("This regression requires a POSIX uid.");
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: deadProcessId(),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ownerUid: process.getuid(),
      token: "crashed-owner-token",
    })}\n`, { mode: 0o600 });

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "recovered" })).rejects.toMatchObject({
      code: "unsafe-lock-path",
      message: expect.stringContaining("remove the stale lock manually and retry"),
    });
    expect(await readFile(lockPath, "utf8")).toContain("crashed-owner-token");
    await rm(lockPath, { force: true });
    await mergeSecretEnvFile(envPath, { TOKEN: "recovered" });
    expect(parseEnv(await readFile(envPath, "utf8"))).toMatchObject({ TOKEN: "recovered" });
  });

  it("refuses an unprovable lock with actionable recovery guidance", async () => {
    const envPath = join(dir, ".env");
    const lockPath = await secretEnvLockPathFor(envPath);
    await writeFile(lockPath, "not a durable owner record\n", { mode: 0o600 });

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-lock-path",
      message: expect.stringContaining("remove the stale lock manually and retry"),
    });
    expect(await readFile(lockPath, "utf8")).toBe("not a durable owner record\n");
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(lockPath, { force: true });
  });

  it("refuses a lock symlink without removing or modifying its target", async () => {
    const envPath = join(dir, ".env");
    const lockPath = await secretEnvLockPathFor(envPath);
    const victimPath = join(dir, "lock-victim.txt");
    await writeFile(victimPath, "do-not-touch\n");
    await symlink(victimPath, lockPath);

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" })).rejects.toMatchObject({
      code: "unsafe-lock-path",
    });
    expect(await readFile(victimPath, "utf8")).toBe("do-not-touch\n");
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(lockPath, { force: true });
  });

  it("makes the ignore rule durable before committing any secret value", async () => {
    const envPath = join(dir, ".env");
    let observedIgnore = "";

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      async beforeCommit(targetPath) {
        if (targetPath !== envPath) return;
        observedIgnore = await readFile(join(dir, ".gitignore"), "utf8");
        throw new Error("stop before env commit");
      },
    })).rejects.toThrow("stop before env commit");

    expect(observedIgnore).toBe(SECRET_IGNORE_BLOCK);
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps transaction temp and lock artifacts out of the Git index", async () => {
    const envPath = join(dir, ".env");
    await run("git", ["init", "-q"], dir);

    await mergeSecretEnvFile(envPath, { TOKEN: "TOP_SECRET_SENTINEL_185" }, {
      async beforeCommit(targetPath) {
        if (targetPath === envPath) await run("git", ["add", "-A"], dir);
      },
    });

    const indexed = await runOutput("git", ["ls-files"], dir);
    expect(indexed).not.toContain(".env.mono-agent");
    expect(indexed).not.toContain("..env.mono-agent");
    expect(indexed).not.toContain(".env\n");
    expect(await secretEnvLockPathFor(envPath)).not.toContain(dir);
  });

  it("tightens an existing env to mode 0600 even when operator values win", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "TOKEN=operator-value\n", { mode: 0o644 });
    // writeFile's creation mode is filtered through the process umask. Make the
    // permissive precondition explicit so this test is deterministic when the
    // full suite runs under an owner-only umask.
    await chmod(envPath, 0o644);

    const result = await mergeSecretEnvFile(envPath, { TOKEN: "must-not-win" });

    expect(await readFile(envPath, "utf8")).toBe("TOKEN=operator-value\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(result.valuesChanged).toBe(0);
    expect(result.changes).toContainEqual({ path: envPath, kind: "updated", sensitive: true });
  });

  it("hardens an existing provider dotenv without resubmitting or rewriting its value", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "OPENAI_API_KEY=operator-provider-key\n", { mode: 0o644 });
    await chmod(envPath, 0o644);

    const result = await mergeSecretEnvFile(envPath, {}, { secureExistingFile: true });

    expect(await readFile(envPath, "utf8")).toBe("OPENAI_API_KEY=operator-provider-key\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(result.valuesChanged).toBe(0);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(SECRET_IGNORE_BLOCK);
  });

  it("refuses secure-existing mode for a tracked provider dotenv", async () => {
    const envPath = join(dir, ".env");
    await run("git", ["init", "-q"], dir);
    await writeFile(envPath, "OPENAI_API_KEY=tracked-provider-key\n", { mode: 0o600 });
    await run("git", ["add", "-f", ".env"], dir);

    await expect(mergeSecretEnvFile(envPath, {}, { secureExistingFile: true }))
      .rejects.toMatchObject({ code: "tracked-env" });
    expect(await readFile(envPath, "utf8")).toBe("OPENAI_API_KEY=tracked-provider-key\n");
  });

  it("detects post-commit tracking, mode, and ignore-rule drift", async () => {
    const envPath = join(dir, ".env");
    const ignorePath = join(dir, ".gitignore");
    await run("git", ["init", "-q"], dir);
    await mergeSecretEnvFile(envPath, { TOKEN: "secret" });

    expect(await verifySecretEnvPersistenceGuard(envPath)).toBe(true);
    await writeFile(ignorePath, `${SECRET_IGNORE_BLOCK}# harmless trailing comment\n`);
    expect(await verifySecretEnvPersistenceGuard(envPath)).toBe(true);
    await run("git", ["add", "-f", ".env"], dir);
    expect(await verifySecretEnvPersistenceGuard(envPath)).toBe(false);
    await run("git", ["rm", "--cached", "-q", "-f", ".env"], dir);
    await chmod(envPath, 0o644);
    expect(await verifySecretEnvPersistenceGuard(envPath)).toBe(false);
    await chmod(envPath, 0o600);
    await writeFile(ignorePath, "!/.env\n");
    expect(await verifySecretEnvPersistenceGuard(envPath)).toBe(false);
  });

  it("fails closed on Windows and when owner-only permissions are otherwise unsupported", async () => {
    const envPath = join(dir, ".env");

    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      platform: "win32",
    })).rejects.toMatchObject({ code: "owner-only-permissions-unsupported" });
    await expect(mergeSecretEnvFile(envPath, { TOKEN: "secret" }, {
      ownerOnlyPermissionsSupported: false,
    })).rejects.toMatchObject({ code: "owner-only-permissions-unsupported" });
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("performs a dry-run without touching files or claiming persisted values", async () => {
    const envPath = join(dir, ".env");

    const result = await mergeSecretEnvFile(envPath, { TOKEN: "secret" }, { dryRun: true });

    expect(result.valuesChanged).toBe(1);
    expect(result.changes).toEqual([
      { path: join(dir, ".gitignore"), kind: "planned-create" },
      { path: envPath, kind: "planned-create", sensitive: true },
    ]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("initMonoAgentFolder secret outcome", () => {
  it("reports applied secret and ignore-file changes without exposing values", async () => {
    const envPath = join(dir, ".env");
    const result = await initMonoAgentFolder({ dir, secretValues: { TOKEN: "secret-value" } });

    expect(result.secretPersistence).toEqual({ status: "persisted", path: envPath, changed: true });
    expect(result.secretsPersisted).toBe(true);
    expect(result.created).toEqual(expect.arrayContaining([envPath, join(dir, ".gitignore")]));
    expect(result.changes).toEqual(expect.arrayContaining([
      { path: join(dir, ".gitignore"), kind: "created" },
      { path: envPath, kind: "created", sensitive: true },
    ]));
    expect(JSON.stringify(result.secretPersistence)).not.toContain("secret-value");
  });

  it("returns a refusal status without claiming persistence", async () => {
    const envPath = join(dir, ".env");
    const victimPath = join(dir, "victim.txt");
    await writeFile(victimPath, "safe\n");
    await symlink(victimPath, envPath);

    const result = await initMonoAgentFolder({ dir, secretValues: { TOKEN: "TOP_SECRET_SENTINEL_185" } });

    expect(result.secretPersistence).toEqual({
      status: "refused",
      path: envPath,
      changed: false,
      reason: "unsafe-env-path",
      detail: `Automatic secret persistence refused unsafe path ${envPath}.`,
    });
    expect(result.secretsPersisted).toBe(false);
    expect(await readFile(victimPath, "utf8")).toBe("safe\n");
  });

  it("returns actionable external stale-lock guidance through the public init outcome", async () => {
    if (typeof process.getuid !== "function") throw new Error("This regression requires a POSIX uid.");
    const envPath = join(dir, ".env");
    const lockPath = await secretEnvLockPathFor(envPath);
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: deadProcessId(),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ownerUid: process.getuid(),
      token: "public-outcome-stale-lock",
    })}\n`, { mode: 0o600 });

    const result = await initMonoAgentFolder({ dir, secretValues: { TOKEN: "TOP_SECRET_SENTINEL_185" } });

    expect(result.secretPersistence).toMatchObject({
      status: "refused",
      path: envPath,
      changed: false,
      reason: "unsafe-lock-path",
      detail: expect.stringContaining(lockPath),
    });
    expect(result.secretPersistence.detail).toContain("remove the stale lock manually and retry");
    expect(JSON.stringify(result.secretPersistence)).not.toContain("TOP_SECRET_SENTINEL_185");
    await rm(lockPath, { force: true });
  });

  it("reports provider-dotenv hardening even when no module secret value changed", async () => {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "ANTHROPIC_API_KEY=operator-provider-key\n", { mode: 0o644 });
    await chmod(envPath, 0o644);

    const result = await initMonoAgentFolder({ dir, secureExistingDotenv: true });

    expect(result.secretPersistence).toEqual({ status: "persisted", path: envPath, changed: false });
    expect(result.secretsPersisted).toBe(false);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("atomically refuses a guided config path won by another writer", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const concurrent = '{"runtime":{"model":"pi:ollama:concurrent"}}\n';
    await writeFile(configPath, concurrent, { mode: 0o600 });

    await expect(initMonoAgentFolder({ dir, requireConfigCreation: true }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect((await readdir(dir)).filter((name) => name.includes("mono-agent-") && name.endsWith(".tmp"))).toEqual([]);
  });
});

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, [...args], { cwd }, (error) => {
      if (error === null) resolveRun();
      else rejectRun(error);
    });
  });
}

function runOutput(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error === null) resolveRun(stdout);
      else rejectRun(error);
    });
  });
}

function deadProcessId(): number {
  for (const candidate of [2_147_483_647, 999_999_937, 99_999_937]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("Unable to find a dead PID for the stale-lock regression.");
}
