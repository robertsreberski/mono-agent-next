// SPDX-License-Identifier: MIT
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_RUN_ROOT_MAX_ENTRIES,
  createCurrentRunFiles,
  ensureCurrentRunRoot,
  recoverCurrentRunRoot,
} from "../current-run-output.js";
import {
  CURRENT_RUN_LEASE_APPLICATION_ID,
  CURRENT_RUN_LEASE_FILENAME,
  CurrentRunWorkspaceError,
  openCurrentRunWorkspace,
} from "../current-run-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("current-run workspace lease", () => {
  it("holds one private application-bound lease and removes it after clean close", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const leasePath = join(workspace.root.path, CURRENT_RUN_LEASE_FILENAME);
    const lease = await stat(leasePath);
    const bytes = await readFile(leasePath);

    expect(lease.mode & 0o777).toBe(0o600);
    expect(lease.nlink).toBe(1);
    expect(lease.size).toBe(4_096);
    expect(bytes.readUInt32BE(68)).toBe(CURRENT_RUN_LEASE_APPLICATION_ID);

    await workspace.close();
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second same-process owner without exposing the project path", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });

    const rejected = openCurrentRunWorkspace({ projectRoot });
    await expect(rejected).rejects.toMatchObject({
      name: "CurrentRunWorkspaceError",
      code: "busy",
    });
    await expect(rejected).rejects.not.toThrow(projectRoot);

    await workspace.close();
  });

  it("rejects a replaced visible lease before staging another run", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const leasePath = join(workspace.root.path, CURRENT_RUN_LEASE_FILENAME);
    const heldLeasePath = join(projectRoot, "held-lease.sqlite");
    const leaseBytes = await readFile(leasePath);
    await rename(leasePath, heldLeasePath);
    await writeFile(leasePath, leaseBytes, { mode: 0o600 });

    await expect(workspace.createRunFiles({
      runId: "run-after-lease-replacement",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(/lease identity changed/u);
    expect(await readFile(leasePath)).toEqual(leaseBytes);

    await rm(leasePath);
    await rename(heldLeasePath, leasePath);
    await workspace.close();
  });

  it("keeps the lease until every active run finishes cleanup", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const leasePath = join(workspace.root.path, CURRENT_RUN_LEASE_FILENAME);
    const first = await workspace.createRunFiles({
      runId: "run-active-first",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    const second = await workspace.createRunFiles({
      runId: "run-active-second",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    let closed = false;
    const closing = workspace.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(closed).toBe(false);
    expect(await access(leasePath).then(() => true)).toBe(true);

    await first.cleanup();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(await access(leasePath).then(() => true)).toBe(true);

    await second.cleanup();
    await closing;
    expect(closed).toBe(true);
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers valid residue under the retained lease before serving", async () => {
    const projectRoot = await fixtureRoot();
    const first = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: first.root,
      runId: "run-crashed",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    await writeFile(join(residue.runOutputDir, "result.txt"), "sensitive");
    const runRoot = join(first.root.path, "run-crashed");
    const leasePath = join(first.root.path, CURRENT_RUN_LEASE_FILENAME);

    await first.close();
    expect(await access(runRoot).then(() => true)).toBe(true);
    expect(await access(leasePath).then(() => true)).toBe(true);

    const recovered = await openCurrentRunWorkspace({ projectRoot });
    await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await recovered.close();
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers partial cleanup claims in known run layouts", async () => {
    const projectRoot = await fixtureRoot();
    const first = await openCurrentRunWorkspace({ projectRoot });
    const rootClaim = join(first.root.path, cleanupName("11111111"));
    const claimedRun = join(rootClaim, "entry");
    const attachments = join(claimedRun, "attachments");
    const fileClaim = join(attachments, cleanupName("22222222"));
    await privateDirectory(rootClaim);
    await privateDirectory(claimedRun);
    await privateDirectory(attachments);
    await privateDirectory(fileClaim);
    await writeFile(join(fileClaim, "entry"), "staged", { mode: 0o600 });

    await first.close();
    const recovered = await openCurrentRunWorkspace({ projectRoot });
    await expect(access(rootClaim)).rejects.toMatchObject({ code: "ENOENT" });
    await recovered.close();
  });

  it("leaves lease-free legacy residue untouched", async () => {
    const projectRoot = await fixtureRoot();
    const root = await ensureCurrentRunRoot(projectRoot);
    const legacy = join(root.path, "legacy-run");
    await privateDirectory(legacy);

    await expect(openCurrentRunWorkspace({ projectRoot })).rejects.toMatchObject({
      name: "CurrentRunWorkspaceError",
      code: "legacy_residue",
    });
    expect((await lstat(legacy)).isDirectory()).toBe(true);
    await expect(access(join(root.path, CURRENT_RUN_LEASE_FILENAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not repair unsafe legacy root permissions before refusing startup", async () => {
    const projectRoot = await fixtureRoot();
    const root = await ensureCurrentRunRoot(projectRoot);
    await chmod(root.path, 0o755);

    await expect(openCurrentRunWorkspace({ projectRoot }))
      .rejects.toThrow(/owner-private/u);
    expect((await stat(root.path)).mode & 0o777).toBe(0o755);
    await expect(access(join(root.path, CURRENT_RUN_LEASE_FILENAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mutate a statically unsafe recovery tree or an outside target", async () => {
    const projectRoot = await fixtureRoot();
    const outsideRoot = await fixtureRoot();
    const outside = join(outsideRoot, "outside.txt");
    await writeFile(outside, "outside");
    const first = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: first.root,
      runId: "run-unsafe",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    const symbolic = join(residue.runOutputDir, "symbolic.txt");
    await symlink(outside, symbolic);
    await first.close();

    await expect(openCurrentRunWorkspace({ projectRoot })).rejects.toMatchObject({
      name: "CurrentRunWorkspaceError",
      code: "unsafe",
    });
    expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("rejects multiply linked residue without deleting either name", async () => {
    const projectRoot = await fixtureRoot();
    const first = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: first.root,
      runId: "run-hard-linked",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    const file = join(residue.runOutputDir, "result.txt");
    const outside = join(projectRoot, "outside-link.txt");
    await writeFile(file, "sensitive");
    await link(file, outside);
    await first.close();

    await expect(openCurrentRunWorkspace({ projectRoot })).rejects.toMatchObject({
      code: "unsafe",
    });
    expect(await readFile(file, "utf8")).toBe("sensitive");
    expect(await readFile(outside, "utf8")).toBe("sensitive");
  });

  it("revalidates every identity before deleting any discovered residue", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: workspace.root,
      runId: "run-raced",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    const original = join(residue.runOutputDir, "result.txt");
    const held = join(projectRoot, "held.txt");
    await writeFile(original, "original");

    await expect(recoverCurrentRunRoot(
      workspace.root,
      CURRENT_RUN_LEASE_FILENAME,
      {
        async afterPreflight() {
          await rename(original, held);
          await writeFile(original, "replacement");
        },
      },
    )).rejects.toThrow(/changed after discovery|changed identity/u);
    expect(await readFile(original, "utf8")).toBe("replacement");
    expect(await readFile(held, "utf8")).toBe("original");
    await workspace.close();
  });

  it("restores a replacement raced into a deletion claim without deleting it", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: workspace.root,
      runId: "run-delete-raced",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    const original = join(residue.runOutputDir, "result.txt");
    const held = join(projectRoot, "held-during-delete.txt");
    await writeFile(original, "original");
    let raced = false;

    await expect(recoverCurrentRunRoot(
      workspace.root,
      CURRENT_RUN_LEASE_FILENAME,
      {
        async beforeDelete(path) {
          if (raced || path !== original) return;
          raced = true;
          await rename(original, held);
          await writeFile(original, "replacement");
        },
      },
    )).rejects.toThrow(/changed identity/u);
    expect(raced).toBe(true);
    expect(await readFile(original, "utf8")).toBe("replacement");
    expect(await readFile(held, "utf8")).toBe("original");
    await workspace.close();
  });

  it("does not repair root permissions during recovery preflight", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    await chmod(workspace.root.path, 0o755);

    await expect(recoverCurrentRunRoot(
      workspace.root,
      CURRENT_RUN_LEASE_FILENAME,
    )).rejects.toThrow(/Unsafe current-run directory/u);
    expect((await stat(workspace.root.path)).mode & 0o777).toBe(0o755);

    await chmod(workspace.root.path, 0o700);
    await workspace.close();
  });

  it("does not repair root permissions changed during recovery deletion", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: workspace.root,
      runId: "run-root-mode-raced",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    await writeFile(join(residue.runOutputDir, "result.txt"), "sensitive");
    let raced = false;

    await expect(recoverCurrentRunRoot(
      workspace.root,
      CURRENT_RUN_LEASE_FILENAME,
      {
        async beforeDelete() {
          if (raced) return;
          raced = true;
          await chmod(workspace.root.path, 0o755);
        },
      },
    )).rejects.toThrow(/Unsafe current-run directory/u);
    expect(raced).toBe(true);
    expect((await stat(workspace.root.path)).mode & 0o777).toBe(0o755);

    await chmod(workspace.root.path, 0o700);
    await workspace.close();
  });

  it("rejects an active lease pathname changed during recovery deletion", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const residue = await createCurrentRunFiles({
      root: workspace.root,
      runId: "run-lease-name-raced",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    await writeFile(join(residue.runOutputDir, "result.txt"), "sensitive");
    const leasePath = join(workspace.root.path, CURRENT_RUN_LEASE_FILENAME);
    const heldLeasePath = join(workspace.root.path, ".held-lease.sqlite");
    let raced = false;

    await expect(recoverCurrentRunRoot(
      workspace.root,
      CURRENT_RUN_LEASE_FILENAME,
      {
        async beforeDelete() {
          if (raced) return;
          raced = true;
          await rename(leasePath, heldLeasePath);
        },
      },
    )).rejects.toThrow(/leave only the active lease/u);
    expect(raced).toBe(true);
    expect((await stat(heldLeasePath)).isFile()).toBe(true);

    await rename(heldLeasePath, leasePath);
    await workspace.close();
  });

  it("enforces the root discovery bound before inspecting entries", async () => {
    const projectRoot = await fixtureRoot();
    const first = await openCurrentRunWorkspace({ projectRoot });
    await Promise.all(Array.from(
      { length: CURRENT_RUN_ROOT_MAX_ENTRIES },
      async (_value, index) => writeFile(join(first.root.path, `unknown-${index}`), ""),
    ));

    await expect(recoverCurrentRunRoot(first.root, CURRENT_RUN_LEASE_FILENAME))
      .rejects.toThrow(/root exceeds the entry limit/u);
    expect((await stat(join(first.root.path, "unknown-0"))).isFile()).toBe(true);
    await first.close();
  });

  it("uses a typed closed error after shutdown begins", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });
    const files = await workspace.createRunFiles({
      runId: "run-before-close",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    });
    await files.cleanup();
    await workspace.close();

    await expect(workspace.createRunFiles({
      runId: "run-late",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining<Partial<CurrentRunWorkspaceError>>({
      name: "CurrentRunWorkspaceError",
      code: "closed",
    }));
  });

  it("does not retain an active token after run setup rejects", async () => {
    const projectRoot = await fixtureRoot();
    const workspace = await openCurrentRunWorkspace({ projectRoot });

    await expect(workspace.createRunFiles({
      runId: "../invalid",
      conversationId: "conversation",
      attachments: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(/safe path segment/u);
    await workspace.close();
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-current-run-workspace-"));
  roots.push(root);
  return root;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
}

function cleanupName(prefix: string): string {
  return `.cleanup-${prefix}-1111-4111-8111-111111111111`;
}
