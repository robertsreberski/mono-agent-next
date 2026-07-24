import {
  access,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCurrentRunFiles,
  readCurrentRunOutputAttachment,
} from "../current-run-output.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("current-run output reads", () => {
  it("returns detached bounded bytes without exposing an absolute path", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "transcript.md"), "transcript");

    const attachment = await readCurrentRunOutputAttachment(
      root,
      "transcript.md",
      options(10),
    );

    expect(new TextDecoder().decode(attachment.data)).toBe("transcript");
    expect(attachment).toMatchObject({
      id: expect.stringMatching(/^current-run-output:[a-f0-9]{32}$/u),
      kind: "file",
      name: "transcript.md",
      mediaType: "application/octet-stream",
      sizeBytes: 10,
    });
    expect(attachment.id).not.toContain(root);
    expect(attachment.name).not.toContain(root);
  });

  it.each([
    "../transcript.md",
    "/tmp/transcript.md",
    "nested/transcript.md",
    "nested\\transcript.md",
    ".",
    "..",
    " transcript.md",
    "transcript.md ",
    "bad\u0000name",
  ])("rejects non-basename output authority: %s", async (name) => {
    const root = await fixtureRoot();
    await expect(readCurrentRunOutputAttachment(
      root,
      name,
      options(100),
    )).rejects.toThrow(/safe basename/u);
  });

  it("enforces exact bounds with a max-plus-one read", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "exact.txt"), "1234");
    await writeFile(join(root, "large.txt"), "12345");

    await expect(readCurrentRunOutputAttachment(
      root,
      "exact.txt",
      options(4),
    )).resolves.toMatchObject({ sizeBytes: 4 });
    await expect(readCurrentRunOutputAttachment(
      root,
      "large.txt",
      options(4),
    )).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects symbolic links and multiply linked files", async () => {
    const root = await fixtureRoot();
    const target = join(root, "target.txt");
    await writeFile(target, "secret");
    await symlink(target, join(root, "symbolic.txt"));
    await link(target, join(root, "hard-linked.txt"));

    await expect(readCurrentRunOutputAttachment(
      root,
      "symbolic.txt",
      options(100),
    )).rejects.toMatchObject({ code: "wrong_type" });
    await expect(readCurrentRunOutputAttachment(
      root,
      "hard-linked.txt",
      options(100),
    )).rejects.toMatchObject({ code: "multiple_links" });
  });

  it("withholds bytes when the output pathname is replaced during the read", async () => {
    const root = await fixtureRoot();
    const path = join(root, "transcript.md");
    await writeFile(path, "original");

    await expect(readCurrentRunOutputAttachment(
      root,
      "transcript.md",
      {
        ...options(100),
        async beforePathIdentityCheck() {
          await rename(path, join(root, "original.md"));
          await writeFile(path, "replacement");
        },
      },
    )).rejects.toMatchObject({ code: "identity_changed" });
  });

  it("binds authority to the exact current run output root", async () => {
    const firstRun = await fixtureRoot();
    const secondRun = await fixtureRoot();
    await writeFile(join(firstRun, "transcript.md"), "first");
    await writeFile(join(secondRun, "transcript.md"), "second-secret");
    await writeFile(join(secondRun, "second-only.md"), "must-not-cross-runs");

    const attachment = await readCurrentRunOutputAttachment(
      firstRun,
      "transcript.md",
      options(100),
    );
    expect(new TextDecoder().decode(attachment.data)).toBe("first");
    await expect(readCurrentRunOutputAttachment(
      firstRun,
      "second-only.md",
      options(100),
    )).rejects.toMatchObject({ code: "missing" });
  });

  it("withholds bytes after a cross-run output directory swap", async () => {
    const projectRoot = await fixtureRoot();
    const first = await createCurrentRunFiles({
      projectRoot, runId: "run-first", conversationId: "first",
      attachments: [], signal: new AbortController().signal,
    });
    const second = await createCurrentRunFiles({
      projectRoot, runId: "run-second", conversationId: "second",
      attachments: [], signal: new AbortController().signal,
    });
    await writeFile(join(first.runOutputDir, "result.txt"), "first");
    await writeFile(join(second.runOutputDir, "result.txt"), "second-secret");
    const held = `${first.runOutputDir}-held`;
    await rename(first.runOutputDir, held);
    await rename(second.runOutputDir, first.runOutputDir);
    await rename(held, second.runOutputDir);

    await expect(first.readOutput("result.txt", options(100))).rejects.toThrow(
      /root changed identity/u,
    );
  });

  it("honors the active turn cancellation signal", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "transcript.md"), "content");
    const controller = new AbortController();
    controller.abort();

    await expect(readCurrentRunOutputAttachment(
      root,
      "transcript.md",
      { maxBytes: 100, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects invalid roots and byte limits before reading", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "transcript.md"), "content");

    await expect(readCurrentRunOutputAttachment(
      "relative/output",
      "transcript.md",
      options(100),
    )).rejects.toThrow(/normalized absolute path/u);
    await expect(readCurrentRunOutputAttachment(
      root,
      "transcript.md",
      options(0),
    )).rejects.toThrow(/positive safe integer/u);
  });
});

describe("current-run MCP files", () => {
  it("stages private attachments with opaque paths and a deeply frozen context", async () => {
    const projectRoot = await fixtureRoot();
    const files = await createCurrentRunFiles({
      projectRoot,
      runId: "run-safe",
      conversationId: "telegram:42",
      attachments: [attachment(
        "../../private-owner-id",
        "../../Voice\u0000 message.ogg",
        "audio/ogg",
        Uint8Array.of(1, 2, 3),
      )],
      signal: new AbortController().signal,
    });

    const staged = files.requestContext.attachments[0]!;
    expect(staged.path).toBe(join(
      projectRoot,
      ".mono-agent",
      "data",
      "core",
      "mcp-runs",
      "run-safe",
      "attachments",
      "attachment-000.ogg",
    ));
    expect(staged.path).not.toContain("private-owner-id");
    expect(staged.path).not.toContain("Voice message");
    expect(staged.name).toBe("Voice message.ogg");
    expect(await readFile(staged.path)).toEqual(Buffer.from([1, 2, 3]));
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
    expect((await stat(files.runOutputDir)).mode & 0o777).toBe(0o700);
    expect(staged.dev).toMatch(/^\d+$/u);
    expect(staged.ino).toMatch(/^[1-9]\d*$/u);
    expect(files.requestContext).toMatchObject({
      schemaVersion: 1,
      conversationId: "telegram:42",
      runId: "run-safe",
      attachmentsRoot: join(
        projectRoot,
        ".mono-agent",
        "data",
        "core",
        "mcp-runs",
        "run-safe",
        "attachments",
      ),
      allowedAttachmentPaths: [staged.path],
      allowedAttachmentIdentities: [{
        path: staged.path,
        dev: staged.dev,
        ino: staged.ino,
      }],
    });
    expect(Object.isFrozen(files)).toBe(true);
    expect(Object.isFrozen(files.requestContext)).toBe(true);
    expect(Object.isFrozen(files.requestContext.attachments)).toBe(true);
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.isFrozen(files.requestContext.allowedAttachmentIdentities[0])).toBe(true);

    await files.cleanup();
    await files.cleanup();
    await expect(access(join(
      projectRoot,
      ".mono-agent",
      "data",
      "core",
      "mcp-runs",
      "run-safe",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate attachment ids before creating run authority", async () => {
    const projectRoot = await fixtureRoot();
    const duplicate = attachment("same", "voice.ogg", "audio/ogg", Uint8Array.of(1));

    await expect(createCurrentRunFiles({
      projectRoot,
      runId: "run-duplicate",
      conversationId: "telegram:42",
      attachments: [duplicate, duplicate],
      signal: new AbortController().signal,
    })).rejects.toThrow(/ids must be unique/u);
    await expect(access(join(projectRoot, ".mono-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symbolic-link ancestor instead of staging outside Core data", async () => {
    const projectRoot = await fixtureRoot();
    const outside = await fixtureRoot();
    await mkdir(join(projectRoot, ".mono-agent"));
    await symlink(outside, join(projectRoot, ".mono-agent", "data"));
    await expect(createCurrentRunFiles({
      projectRoot, runId: "run-symbolic", conversationId: "telegram:42",
      attachments: [attachment("voice", "voice.ogg", "audio/ogg", Uint8Array.of(1))],
      signal: new AbortController().signal,
    })).rejects.toThrow(/must not traverse symbolic links/u);
    await expect(access(join(outside, "core"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".", ".."])("uses an opaque display fallback for unsafe basename %s", async (name) => {
    const files = await createCurrentRunFiles({
      projectRoot: await fixtureRoot(), runId: `run-${name.length}`,
      conversationId: "telegram:42",
      attachments: [attachment("voice", name, "audio/ogg", Uint8Array.of(1))],
      signal: new AbortController().signal,
    });
    expect(files.requestContext.attachments[0]!.name).toBe("attachment-0");
    await files.cleanup();
  });

  it("never unlinks a staged pathname whose identity was replaced", async () => {
    const projectRoot = await fixtureRoot();
    const files = await createCurrentRunFiles({
      projectRoot,
      runId: "run-replaced",
      conversationId: "telegram:42",
      attachments: [
        attachment("voice", "voice.m4a", "audio/mp4", Uint8Array.of(1, 2)),
      ],
      signal: new AbortController().signal,
    });
    const stagedPath = files.requestContext.attachments[0]!.path;
    const originalPath = join(files.requestContext.attachmentsRoot, "original.m4a");
    await rename(stagedPath, originalPath);
    await writeFile(stagedPath, "replacement");

    await expect(files.cleanup()).rejects.toThrow(/retained one or more unverified paths/u);

    expect(await readFile(stagedPath, "utf8")).toBe("replacement");
    expect(await readFile(originalPath)).toEqual(Buffer.from([1, 2]));
  });

  it("does not unlink a staged file after its link count changes", async () => {
    const projectRoot = await fixtureRoot();
    const files = await createCurrentRunFiles({
      projectRoot,
      runId: "run-linked",
      conversationId: "telegram:42",
      attachments: [
        attachment("voice", "voice.wav", "audio/wav", Uint8Array.of(7)),
      ],
      signal: new AbortController().signal,
    });
    const stagedPath = files.requestContext.attachments[0]!.path;
    const linkedPath = join(files.requestContext.attachmentsRoot, "linked.wav");
    await link(stagedPath, linkedPath);

    await expect(files.cleanup()).rejects.toThrow(/retained one or more unverified paths/u);

    expect(await readFile(stagedPath)).toEqual(Buffer.from([7]));
    expect(await readFile(linkedPath)).toEqual(Buffer.from([7]));
  });

  it("removes ordinary bounded run outputs before removing the run root", async () => {
    const projectRoot = await fixtureRoot();
    const files = await createCurrentRunFiles({
      projectRoot,
      runId: "run-output",
      conversationId: "telegram:42",
      attachments: [],
      signal: new AbortController().signal,
    });
    await writeFile(join(files.runOutputDir, "transcript.md"), "sensitive copy");

    await files.cleanup();

    await expect(access(join(
      projectRoot,
      ".mono-agent",
      "data",
      "core",
      "mcp-runs",
      "run-output",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unsafe output entries without following or deleting outside targets", async () => {
    const projectRoot = await fixtureRoot();
    const files = await createCurrentRunFiles({
      projectRoot,
      runId: "run-unsafe-output",
      conversationId: "telegram:42",
      attachments: [],
      signal: new AbortController().signal,
    });
    const outside = join(projectRoot, "outside.txt");
    const hardSource = join(projectRoot, "hard-source.txt");
    await writeFile(outside, "outside");
    await writeFile(hardSource, "hard");
    const symbolic = join(files.runOutputDir, "symbolic.txt");
    const hardLinked = join(files.runOutputDir, "hard-linked.txt");
    const nested = join(files.runOutputDir, "nested");
    await symlink(outside, symbolic);
    await link(hardSource, hardLinked);
    await mkdir(nested);
    await writeFile(join(nested, "nested.txt"), "nested");

    await expect(files.cleanup()).rejects.toThrow(/retained one or more unverified paths/u);

    expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readFile(hardLinked, "utf8")).toBe("hard");
    expect(await readFile(hardSource, "utf8")).toBe("hard");
    expect(await readFile(join(nested, "nested.txt"), "utf8")).toBe("nested");
  });

  it("restores a replacement raced between cleanup validation and claim", async () => {
    const projectRoot = await fixtureRoot();
    let raced = false;
    const originalPath = join(projectRoot, "owned-original.bin");
    const files = await createCurrentRunFiles({
      projectRoot, runId: "run-cleanup-race", conversationId: "cleanup-race",
      attachments: [attachment("voice", "voice.bin", "application/octet-stream", Uint8Array.of(9))],
      signal: new AbortController().signal,
      async testHook(phase, path) {
        if (phase !== "cleanup" || raced || !path.endsWith("attachment-000.bin")) return;
        raced = true;
        await rename(path, originalPath);
        await writeFile(path, "replacement");
      },
    });
    const stagedPath = files.requestContext.attachments[0]!.path;

    const firstCleanup = files.cleanup();
    await expect(firstCleanup).rejects.toThrow(/retained one or more unverified paths/u);
    expect(files.cleanup()).toBe(firstCleanup);
    expect(await readFile(stagedPath, "utf8")).toBe("replacement");
    expect(await readFile(originalPath)).toEqual(Buffer.from([9]));
    expect((await readdir(files.requestContext.attachmentsRoot))
      .some((name) => name.startsWith(".cleanup-"))).toBe(false);
  });

  it.each(["write", "sync", "stat", "path"] as const)(
    "removes staged bytes after a %s failure",
    async (phase) => {
      const projectRoot = await fixtureRoot();
      const runRoot = join(projectRoot, ".mono-agent", "data", "core", "mcp-runs", `run-${phase}`);
      await expect(createCurrentRunFiles({
        projectRoot, runId: `run-${phase}`, conversationId: "fault",
        attachments: [attachment("sensitive", "secret.bin", "application/octet-stream", Uint8Array.of(1, 2, 3))],
        signal: new AbortController().signal,
        testHook(hookPhase, path) {
          if (hookPhase === phase && path.endsWith("attachment-000.bin")) {
            throw new Error(`injected ${phase} failure`);
          }
        },
      })).rejects.toThrow(new RegExp(`injected ${phase} failure`, "u"));
      await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("removes a newly created run directory after directory setup fails", async () => {
    const projectRoot = await fixtureRoot();
    const runRoot = join(projectRoot, ".mono-agent", "data", "core", "mcp-runs", "run-directory-fault");
    await expect(createCurrentRunFiles({
      projectRoot, runId: "run-directory-fault", conversationId: "fault",
      attachments: [], signal: new AbortController().signal,
      testHook(phase, path) {
        if (phase === "directory" && path === runRoot) throw new Error("injected directory failure");
      },
    })).rejects.toThrow(/injected directory failure/u);
    await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects managed paths not owned by the effective user", async () => {
    const getUid = Reflect.get(process, "geteuid") as unknown;
    if (typeof getUid !== "function") return;
    const projectRoot = await fixtureRoot();
    const actual = (getUid as () => number)();
    const owner = vi.spyOn(
      process as unknown as { geteuid(): number },
      "geteuid",
    ).mockReturnValue(actual + 1);
    try {
      await expect(createCurrentRunFiles({
        projectRoot, runId: "run-wrong-owner", conversationId: "owner",
        attachments: [], signal: new AbortController().signal,
      })).rejects.toThrow(/owned by the effective user/u);
    } finally {
      owner.mockRestore();
    }
  });
});

function options(maxBytes: number): {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
} {
  return { maxBytes, signal: new AbortController().signal };
}

function attachment(
  id: string,
  name: string,
  mediaType: string,
  data: Uint8Array,
) {
  return {
    id,
    kind: "audio" as const,
    name,
    mediaType,
    sizeBytes: data.byteLength,
    data,
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-current-run-output-"));
  roots.push(root);
  return root;
}
