import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  initMonoAgentFolder,
  mergeSecretEnvFile,
  SecretEnvConcurrentModificationError,
  secretEnvConcurrentModificationCause,
} from "../init.js";
import { acquireOwnerPrivateLock } from "../owner-private-lock.js";
import {
  PROJECT_SKILL_MANIFEST_PATH,
  updateManagedProjectSkills,
} from "../project-skills.js";
import { redactSecrets } from "../redact-secrets.js";
import { secureFileReplace } from "../secure-file-replace.js";
import { defaultAnswers } from "../wizard/answers.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const incarnation = {
  schema: "mono-agent.process-incarnation.v1" as const,
  bootSessionId: "security-primitives-test-boot",
  processStartId: "security-primitives-test-start",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mono-agent-security-primitives-"));
  roots.push(path);
  return path;
}

async function agentRoot(): Promise<string> {
  const path = await root();
  await initMonoAgentFolder({
    dir: path,
    answers: defaultAnswers({ name: "Security Test", purpose: "Exercise shared security primitives." }),
  });
  return path;
}

async function makeManagedSkillsStale(path: string): Promise<void> {
  const manifestPath = join(path, PROJECT_SKILL_MANIFEST_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  manifest.version = "0.0.0";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function isConfigureSkillPath(path: string): boolean {
  return basename(path) === "SKILL.md" && basename(dirname(path)) === "mono-agent-configure";
}

async function expectFifoRejectionWithoutBlocking(
  pending: Promise<unknown>,
  fifo: string | (() => Promise<string>),
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ readonly kind: "blocked" }>((resolveBlocked) => {
      timer = setTimeout(() => resolveBlocked({ kind: "blocked" }), 2_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "blocked") {
    const fifoPath = typeof fifo === "string" ? fifo : await fifo();
    await Promise.allSettled([
      execFileAsync("sh", ["-c", "printf x > \"$1\"", "sh", fifoPath]),
      pending,
    ]);
  }
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind === "rejected") expect(outcome.error).toBeInstanceOf(Error);
}

async function findFifo(path: string): Promise<string> {
  for (const entry of await readdir(path)) {
    const candidate = join(path, entry);
    if ((await lstat(candidate)).isFIFO()) return candidate;
  }
  throw new Error(`No FIFO remained available to unblock under ${path}.`);
}

describe("shared security primitives", () => {
  it("stages and exclusively publishes one durable private file", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");

    await secureFileReplace({
      path,
      contents: "managed\n",
      mode: 0o600,
      target: { expected: { kind: "missing" }, recovery: "preserve-current" },
    });

    expect(await readFile(path, "utf8")).toBe("managed\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("never commits or removes a replacement swapped onto the temporary pathname", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");
    const temporaryPath = join(dir, ".managed.tmp");

    await expect(secureFileReplace({
      path,
      temporaryPath,
      contents: "trusted\n",
      mode: 0o600,
      beforeCommit: async (temporary) => {
        await rename(temporary, `${temporary}.displaced`);
        await writeFile(temporary, "replacement\n", { mode: 0o600 });
      },
      target: { expected: { kind: "missing" }, recovery: "preserve-current" },
    })).rejects.toThrow("changed");

    expect(await readFile(temporaryPath, "utf8")).toBe("replacement\n");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never commits an in-place mutation of the staged inode", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");
    const temporaryPath = join(dir, ".managed.tmp");

    await expect(secureFileReplace({
      path,
      temporaryPath,
      contents: "trusted\n",
      mode: 0o600,
      beforeCommit: async (temporary) => {
        await writeFile(temporary, "mutated\n", { mode: 0o600 });
      },
      target: { expected: { kind: "missing" }, recovery: "preserve-current" },
    })).rejects.toThrow("contents changed");

    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects FIFO swaps without blocking shared file and owner readers", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");
    const temporaryPath = join(dir, ".managed.tmp");
    const fileReplacement = secureFileReplace({
      path,
      temporaryPath,
      contents: "trusted\n",
      mode: 0o600,
      beforeCommit: async (temporary) => {
        await rename(temporary, `${temporary}.displaced`);
        await execFileAsync("mkfifo", [temporary]);
      },
      target: { expected: { kind: "missing" }, recovery: "preserve-current" },
    });
    await expectFifoRejectionWithoutBlocking(fileReplacement, temporaryPath);

    const lockPath = join(dir, "fifo-owner.lock");
    await mkdir(lockPath, { mode: 0o700 });
    const ownerPath = join(lockPath, "owner.json");
    await execFileAsync("mkfifo", [ownerPath]);
    const lockReplacement = acquireOwnerPrivateLock({
      path: lockPath,
      label: "FIFO test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
    });
    await expectFifoRejectionWithoutBlocking(lockReplacement, ownerPath);
  });

  it.skipIf(process.platform === "win32")("rejects FIFO swaps without blocking secret target validation", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );

    const replacement = mergeSecretEnvFile(path, { SECOND: "managed" }, {
      beforePromotion: async (target) => {
        await rm(target);
        await execFileAsync("mkfifo", [target]);
      },
    });
    await expectFifoRejectionWithoutBlocking(replacement, () => findFifo(dir));
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects FIFO swaps without blocking managed target validation", async () => {
    const dir = await agentRoot();
    await makeManagedSkillsStale(dir);
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    let injected = false;
    const replacement = updateManagedProjectSkills(dir, {
      beforeTargetClaim: async (target) => {
        if (injected || !isConfigureSkillPath(target)) return;
        injected = true;
        await rm(target);
        await execFileAsync("mkfifo", [target]);
      },
    });
    await expectFifoRejectionWithoutBlocking(replacement, () => findFifo(dirname(path)));
    expect(injected).toBe(true);
    expect((await lstat(path)).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("rejects FIFO swaps without blocking managed rollback", async () => {
    const dir = await agentRoot();
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    await rm(path);
    let activations = 0;
    const replacement = updateManagedProjectSkills(dir, {
      beforeActivate: async () => {
        activations += 1;
        if (activations !== 2) return;
        await rm(path);
        await execFileAsync("mkfifo", [path]);
        throw new Error("injected failure after FIFO swap");
      },
    });
    await expectFifoRejectionWithoutBlocking(replacement, () => findFifo(dirname(path)));
    expect(activations).toBe(2);
    expect((await lstat(path)).isFIFO()).toBe(true);
  });

  it("rechecks staged secret bytes immediately before the caller's exclusive publication", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );

    let failure: unknown;
    try {
      await mergeSecretEnvFile(path, { SECOND: "managed" }, {
        async beforeInstallLink(_target, temporary) {
          await writeFile(temporary, "TOKEN=mutated\n", { mode: 0o600 });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const recoveryPath = (failure as SecretEnvConcurrentModificationError).recoveryPath;
    expect(recoveryPath).toBeDefined();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recoveryPath!, "utf8")).toBe("TOKEN=original\n");
  });

  it("keeps recovery evidence when an async publisher swaps in a same-byte inode", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );

    let failure: unknown;
    try {
      await mergeSecretEnvFile(path, { SECOND: "managed" }, {
        async beforeInstallLink(_target, temporary) {
          const intended = await readFile(temporary);
          await rename(temporary, `${temporary}.displaced`);
          await writeFile(temporary, intended, { mode: 0o600 });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).cause).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const cause = secretEnvConcurrentModificationCause(failure)!;
    expect(cause.recoveryPath).toBeDefined();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(cause.recoveryPath!, "utf8")).toBe("TOKEN=original\n");
  });

  it("restores secret edits written through an fd retained across target claim", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    const operatorEdit = "TOKEN=operator-edit\n";
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );
    let retained: FileHandle | undefined;

    try {
      await expect(mergeSecretEnvFile(path, { SECOND: "managed" }, {
        beforePromotion: async (target) => { retained = await open(target, "r+"); },
        beforeInstallLink: async () => {
          await retained!.truncate(0);
          await retained!.writeFile(operatorEdit);
          await retained!.sync();
        },
      })).rejects.toBeInstanceOf(SecretEnvConcurrentModificationError);
    } finally {
      await retained?.close();
    }

    expect(retained).toBeDefined();
    expect(await readFile(path, "utf8")).toBe(operatorEdit);
  });

  it("drops a revalidated superseded secret claim after an exclusive publication conflict", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    const concurrent = "TOKEN=concurrent-writer\n";
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );
    let failure: unknown;
    try {
      await mergeSecretEnvFile(path, { SECOND: "managed" }, {
        beforeInstallLink: async (target) => { await writeFile(target, concurrent, { mode: 0o600 }); },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SecretEnvConcurrentModificationError);
    expect((failure as SecretEnvConcurrentModificationError).recoveryPath).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(concurrent);
    expect((await readdir(dir)).filter((entry) => /^\.env\.mono-agent-.*\.backup$/u.test(entry))).toEqual([]);
  });

  it("preserves a managed skill created at the exclusive publication boundary", async () => {
    const dir = await agentRoot();
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    await rm(path);
    const operatorCopy = "# operator-created skill\n";
    let injected = false;

    await expect(updateManagedProjectSkills(dir, {
      beforePublish: async (target) => {
        if (injected || !isConfigureSkillPath(target)) return;
        injected = true;
        await writeFile(target, operatorCopy, { mode: 0o600 });
      },
    })).rejects.toThrow(/concurrently created/u);

    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe(operatorCopy);
  });

  it("restores an operator edit raced into the managed target-claim boundary", async () => {
    const dir = await agentRoot();
    await makeManagedSkillsStale(dir);
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    const operatorEdit = "# operator edit at target claim\n";
    let injected = false;

    await expect(updateManagedProjectSkills(dir, {
      beforeTargetClaim: async (target) => {
        if (injected || !isConfigureSkillPath(target)) return;
        injected = true;
        await writeFile(target, operatorEdit, { mode: 0o600 });
      },
    })).rejects.toThrow(/concurrently edited/u);

    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe(operatorEdit);
  });

  it("restores an operator edit written through an fd retained across target claim", async () => {
    const dir = await agentRoot();
    await makeManagedSkillsStale(dir);
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    const operatorEdit = "# operator edit through retained descriptor\n";
    let retained: FileHandle | undefined;

    try {
      await expect(updateManagedProjectSkills(dir, {
        beforeTargetClaim: async (target) => {
          if (retained !== undefined || !isConfigureSkillPath(target)) return;
          retained = await open(target, "r+");
        },
        beforePublish: async (target) => {
          if (retained === undefined || !isConfigureSkillPath(target)) return;
          await retained.truncate(0);
          await retained.writeFile(operatorEdit);
          await retained.sync();
        },
      })).rejects.toThrow(/concurrently edited/u);
    } finally {
      await retained?.close();
    }

    expect(retained).toBeDefined();
    expect(await readFile(path, "utf8")).toBe(operatorEdit);
  });

  it("restores the prior managed skill when the staged inode changes after proof", async () => {
    const dir = await agentRoot();
    await makeManagedSkillsStale(dir);
    const path = join(dir, "skills", "mono-agent-configure", "SKILL.md");
    const prior = await readFile(path, "utf8");
    let injected = false;

    await expect(updateManagedProjectSkills(dir, {
      beforePublish: async (target, temporary) => {
        if (injected || !isConfigureSkillPath(target)) return;
        injected = true;
        const intended = await readFile(temporary);
        await rename(temporary, `${temporary}.displaced`);
        await writeFile(temporary, intended, { mode: 0o600 });
      },
    })).rejects.toThrow(/changed during publication|publication failed/u);

    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe(prior);
  });

  it("serializes a private directory lock and releases only the acquired owner record", async () => {
    const dir = await root();
    const path = join(dir, "operation.lock");
    const options = {
      path,
      label: "Test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
      randomToken: () => "test-lock-token",
      ownerFields: () => ({ purpose: "regression" }),
      validateOwnerFields: (record: Readonly<Record<string, unknown>>) => record.purpose === "regression",
    };

    const held = await acquireOwnerPrivateLock(options);
    expect(held?.ownerPid).toBe(process.pid);
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({
      schema: "mono-agent.test-lock.v1",
      purpose: "regression",
      pid: process.pid,
    });
    await expect(acquireOwnerPrivateLock(options)).resolves.toBeUndefined();

    await held?.release();
    await held?.release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes a concurrent acquirer across the exact owner-publication interval", async () => {
    const dir = await root();
    const path = join(dir, "publication-interval.lock");
    const ownerPath = join(path, "owner.json");
    const temporaryPath = join(path, ".owner.mono-agent-publication.tmp");
    const content = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "publishing-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;
    const common = {
      path,
      label: "Publication-interval test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
    };
    let signalPublicationObserved!: () => void;
    const publicationObserved = new Promise<void>((resolveObserved) => { signalPublicationObserved = resolveObserved; });
    let resumeContender!: () => void;
    const publicationFinished = new Promise<void>((resolveFinished) => { resumeContender = resolveFinished; });
    let contender: Promise<Awaited<ReturnType<typeof acquireOwnerPrivateLock>>> | undefined;
    let contenderNow = 0;

    await mkdir(path, { mode: 0o700 });
    await secureFileReplace({
      path: ownerPath,
      temporaryPath,
      contents: content,
      mode: 0o600,
      target: {
        expected: { kind: "missing" },
        recovery: "preserve-current",
        afterPublish: async (publishedPath, stagedPath) => {
          expect((await lstat(publishedPath)).nlink).toBe(2);
          expect((await lstat(stagedPath)).nlink).toBe(2);
          contender = acquireOwnerPrivateLock({
            ...common,
            randomToken: () => "concurrent-owner",
            waitTimeoutMs: 10,
            pollIntervalMs: 1,
            now: () => contenderNow,
            sleep: async (milliseconds) => {
              expect(milliseconds).toBe(1);
              signalPublicationObserved();
              await publicationFinished;
              contenderNow = 10;
            },
          });
          void contender.catch(() => signalPublicationObserved());
          await publicationObserved;
        },
      },
    });

    expect((await lstat(ownerPath)).nlink).toBe(1);
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    resumeContender();
    expect(contender).toBeDefined();
    await expect(contender!).resolves.toBeUndefined();
    expect(await readFile(ownerPath, "utf8")).toBe(content);
  });

  it("never retries or accepts an arbitrary hard link to an owner record", async () => {
    const dir = await root();
    const path = join(dir, "arbitrary-owner-link.lock");
    const ownerPath = join(path, "owner.json");
    const aliasPath = join(path, "owner-copy.json");
    const content = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "hard-linked-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;
    let retried = false;
    await mkdir(path, { mode: 0o700 });
    await writeFile(ownerPath, content, { mode: 0o600 });
    await link(ownerPath, aliasPath);

    await expect(acquireOwnerPrivateLock({
      path,
      label: "Arbitrary-hard-link test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
      sleep: async () => { retried = true; },
    })).rejects.toThrow(/single-link regular file/u);

    expect(retried).toBe(false);
    expect((await lstat(ownerPath)).nlink).toBe(2);
    expect(await readFile(aliasPath, "utf8")).toBe(content);
  });

  it("recovers an exact-looking owner publication pair after ownerless grace", async () => {
    const dir = await root();
    const path = join(dir, "stuck-owner-publication.lock");
    const ownerPath = join(path, "owner.json");
    const temporaryPath = join(path, ".owner.mono-agent-publication.tmp");
    const content = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "stuck-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;
    await mkdir(path, { mode: 0o700 });
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await link(temporaryPath, ownerPath);
    await utimes(path, new Date(0), new Date(0));

    const held = await acquireOwnerPrivateLock({
      path,
      label: "Stuck-publication test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 0,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
      now: () => Date.now() + 60_000,
      randomToken: () => "recovered-owner",
    });

    expect(held?.ownerPid).toBe(process.pid);
    expect((await lstat(ownerPath)).nlink).toBe(1);
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await held?.release();
  });

  it("pins stale owner staging so a same-mtime restart cannot reuse its generation", async () => {
    const dir = await root();
    const path = join(dir, "restarted-owner-publication.lock");
    const ownerPath = join(path, "owner.json");
    const temporaryPath = join(path, ".owner.mono-agent-publication.tmp");
    const content = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "stale-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;
    const restarted = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "restarted-owner",
      createdAt: new Date(1).toISOString(),
      incarnation,
    })}\n`;
    await mkdir(path, { mode: 0o700 });
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await link(temporaryPath, ownerPath);
    await utimes(path, new Date(0), new Date(0));
    const original = await lstat(ownerPath, { bigint: true });

    await expect(acquireOwnerPrivateLock({
      path,
      label: "Restarted-publication test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 0,
      processIncarnation: incarnation,
      now: () => Date.now() + 60_000,
      randomToken: () => "replacement-owner",
      beforeStaleRename: async () => {
        await rm(ownerPath);
        await rm(temporaryPath);
        await writeFile(temporaryPath, restarted, { mode: 0o600 });
        await link(temporaryPath, ownerPath);
        await utimes(path, new Date(0), new Date(0));
        const replacement = await lstat(ownerPath, { bigint: true });
        expect(replacement.dev !== original.dev || replacement.ino !== original.ino).toBe(true);
      },
      staleRace: "return",
    })).resolves.toBeUndefined();

    expect(await readFile(temporaryPath, "utf8")).toBe(restarted);
    expect(await readFile(ownerPath, "utf8")).toBe(restarted);
    expect((await lstat(ownerPath)).nlink).toBe(2);
  });

  it("does not quarantine an in-place owner publication rewrite with restored directory mtime", async () => {
    const dir = await root();
    const path = join(dir, "rewritten-owner-publication.lock");
    const ownerPath = join(path, "owner.json");
    const temporaryPath = join(path, ".owner.mono-agent-publication.tmp");
    const content = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "stale-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;
    const rewritten = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "rewritten-owner",
      createdAt: new Date(1).toISOString(),
      incarnation,
    })}\n`;
    await mkdir(path, { mode: 0o700 });
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await link(temporaryPath, ownerPath);
    await utimes(path, new Date(0), new Date(0));
    const original = await lstat(ownerPath, { bigint: true });

    await expect(acquireOwnerPrivateLock({
      path,
      label: "Rewritten-publication test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 0,
      processIncarnation: incarnation,
      now: () => Date.now() + 60_000,
      randomToken: () => "replacement-owner",
      beforeStaleRename: async () => {
        await writeFile(temporaryPath, rewritten);
        await utimes(path, new Date(0), new Date(0));
      },
      staleRace: "return",
    })).resolves.toBeUndefined();

    const retained = await lstat(ownerPath, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: original.dev, ino: original.ino });
    expect(await readFile(temporaryPath, "utf8")).toBe(rewritten);
    expect(await readFile(ownerPath, "utf8")).toBe(rewritten);
    expect(retained.nlink).toBe(2n);
  });

  it("does not overwrite a competing owner published in the mkdir window", async () => {
    const dir = await root();
    const path = join(dir, "publication-race.lock");
    const competitor = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "competing-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;

    const held = await acquireOwnerPrivateLock({
      path,
      label: "Publication-race test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
      randomToken: () => "acquiring-owner",
      afterDirectoryCreated: async (lockPath) => {
        await writeFile(join(lockPath, "owner.json"), competitor, { mode: 0o600 });
      },
    });

    expect(held).toBeUndefined();
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(competitor);
  });

  it("preserves exact lock ownership when Windows cannot fsync a directory handle", async () => {
    const dir = await root();
    const path = join(dir, "windows-operation.lock");
    const unsupported = Object.assign(new Error("directory sync unsupported"), { code: "EINVAL" });
    const held = await acquireOwnerPrivateLock({
      path,
      label: "Windows test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      platform: "win32",
      syncDirectoryHandle: async () => { throw unsupported; },
    });

    expect(held).toBeDefined();
    expect((await lstat(path)).isDirectory()).toBe(true);
    await held?.release();
  });

  it("uses one bounded redactor for explicit, environment, header, and token-shaped secrets", () => {
    const explicit = "explicit-provider-secret";
    const environmental = "environment-provider-secret";
    const shortEnvironmental = "abc";
    const opaque = "abcdefghijklmnopqrstuvwxyz012345";
    const message = redactSecrets(
      `failed ${explicit} ${environmental} ${shortEnvironmental} Bearer bearer-value api_key=inline-value ${opaque}\nagain`,
      {
        fallback: "provider failed",
        secrets: [explicit],
        environment: { PROVIDER_SECRET: environmental, SHORT_API_KEY: shortEnvironmental },
      },
    );

    expect(message).not.toContain(explicit);
    expect(message).not.toContain(environmental);
    expect(message).not.toContain(shortEnvironmental);
    expect(message).not.toContain("bearer-value");
    expect(message).not.toContain("inline-value");
    expect(message).not.toContain(opaque);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(400);
  });

  it("keeps an existing redaction marker stable after an explicit secret replacement", () => {
    expect(redactSecrets("secret=fixture-secret", {
      fallback: "provider failed",
      environment: { PROVIDER_SECRET: "fixture-secret" },
    })).toBe("secret=[REDACTED]");
  });

  it("scrubs structured credentials and applies the same safe bound to fallbacks", () => {
    const structured = redactSecrets(
      'https://user:pass@example.test/?token=short-token https://username-token@example.test/ https://user@realm:opaque@host.test/ {"client_secret":"shh","refresh_token":"refresh-value"} Authorization: Basic dXNlcjpwYXNz',
      { fallback: "provider failed" },
    );
    expect(structured).not.toContain("user:pass");
    expect(structured).not.toContain("username-token");
    expect(structured).not.toContain("realm:opaque");
    expect(structured).not.toContain("short-token");
    expect(structured).not.toContain("shh");
    expect(structured).not.toContain("refresh-value");
    expect(structured).not.toContain("dXNlcjpwYXNz");

    const fallback = redactSecrets(" \n ", {
      fallback: `token=fallback-secret ${"word ".repeat(160)}`,
    });
    expect(fallback).not.toContain("fallback-secret");
    expect(fallback.length).toBeLessThanOrEqual(400);
  });

  it("snapshots an Error message once before redaction", () => {
    const error = new Error("unused");
    let reads = 0;
    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? "stable provider failure" : "unrecognized-secret";
      },
    });

    expect(redactSecrets(error, { fallback: "provider failed" })).toBe("stable provider failure");
    expect(reads).toBe(1);
  });
});
