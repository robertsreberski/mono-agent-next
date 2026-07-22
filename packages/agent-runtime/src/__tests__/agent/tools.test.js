import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeSandbox, testSandboxPolicy as failClosedSandboxPolicy } from "../helpers/fake-sandbox.js";
import {
  bashToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  readToolImpl,
  normalizeBashTimeoutMs,
  resolveRgPath,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "../../agent/tools/index.js";
import {
  configureToolRuntime,
  resetToolRuntime,
} from "../../agent/tools/shared/runtime-context.js";

const tempDirs = [];
let previousPath = process.env.PATH;

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-tools-"));
  tempDirs.push(dir);
  // The fake sandbox fixture gives these tests realistic root/write/network
  // enforcement without a workspace dependency — see helpers/fake-sandbox.js.
  configureToolRuntime({ workspace: dir, sandbox: createFakeSandbox() });
  return dir;
}

function writeFile(path, content = "") {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  resetToolRuntime();
  resolveRgPath({ refresh: true });
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("ai tool helpers", () => {
  it("normalizes small bash timeout values as seconds", () => {
    expect(normalizeBashTimeoutMs(30)).toBe(30000);
    expect(normalizeBashTimeoutMs(120)).toBe(120000);
    expect(normalizeBashTimeoutMs(120000)).toBe(120000);
    expect(normalizeBashTimeoutMs(999999)).toBe(120000);
  });

  it("glob excludes generated and vendor paths by default", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "app.ts"), "source");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "vendor");
    writeFile(join(root, "dist", "assets", "app.js"), "bundle");
    writeFile(join(root, "src", "app.ts.map"), "sourcemap");

    const result = await globToolImpl({ path: root, pattern: "**/*" });

    expect(result).toContain("src/app.ts");
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/assets");
    expect(result).not.toContain("app.ts.map");
    expect(result).toContain("Excluded directories:");
  });

  it("glob caps broad result previews", async () => {
    const root = tempWorkspace();
    for (let index = 0; index < 5; index += 1) {
      writeFile(join(root, "src", `file-${index}.ts`), "source");
    }

    const result = await globToolImpl({ path: root, pattern: "**/*", max_matches: 2 });

    expect((result.match(/src\/file-/g) || [])).toHaveLength(2);
    expect(result).toContain("[truncated Glob result: showing 2 of 5 lines");
  });

  it("uses the packaged ripgrep binary when PATH does not provide rg", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "packaged.ts"), "packaged needle");
    process.env.PATH = "";
    resolveRgPath({ refresh: true });

    const globResult = await globToolImpl({ path: root, pattern: "src/*.ts" });
    const grepResult = await grepToolImpl({ path: root, pattern: "packaged needle" });

    expect(globResult).toContain("src/packaged.ts");
    expect(grepResult).toContain("src/packaged.ts");
  });

  it("grep excludes generated and vendor paths and caps output", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "needle vendor");
    writeFile(join(root, "dist", "bundle.js"), "needle bundle");
    writeFile(join(root, "src", "bundle.js.map"), "needle map");

    const result = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 });

    expect(result).toMatch(/src\/(one|two)\.ts/);
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/bundle");
    expect(result).not.toContain("bundle.js.map");
    expect(result).toContain("[truncated Grep result: showing 1 of 2 lines");
  });

  it("resolves relative file paths and shell commands from the configured workspace", async () => {
    const root = tempWorkspace();

    const writeResult = await writeToolImpl({ file_path: "src/relative.txt", content: "hello" });
    const readResult = await readToolImpl({ file_path: "src/relative.txt" });
    const bashResult = await bashToolImpl({ command: "pwd && test -f src/relative.txt && echo ok" });

    expect(writeResult).toContain(join(root, "src", "relative.txt"));
    expect(readResult).toContain("1\thello");
    expect(bashResult).toContain(root);
    expect(bashResult).toContain("ok");
  });

  it("prefers an explicit tool workdir over the default workspace", async () => {
    const root = tempWorkspace();
    const project = mkdtempSync(resolve("/tmp", "agent-runtime-project-tools-"));
    tempDirs.push(project);
    writeFile(join(project, "src", "project.txt"), "from project");

    const writeResult = await writeToolImpl({ file_path: "src/new.txt", content: "new", workdir: project });
    const readResult = await readToolImpl({ file_path: "src/project.txt", workdir: project });
    const globResult = await globToolImpl({ path: ".", pattern: "src/*.txt", workdir: project });
    const bashResult = await bashToolImpl({ command: "pwd && test -f src/project.txt && echo ok", workdir: project });

    expect(writeResult).toContain(join(project, "src", "new.txt"));
    expect(readResult).toContain("1\tfrom project");
    expect(globResult).toContain("src/project.txt");
    expect(globResult).not.toContain(root);
    expect(bashResult).toContain(project);
    expect(bashResult).toContain("ok");
  });

  it("bounds Read output by default and warns on repeated ranges", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "large.txt"), Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n"));

    const first = await readToolImpl({ file_path: "src/large.txt" });
    const second = await readToolImpl({ file_path: "src/large.txt" });

    expect(first).toContain("240\tline 240");
    expect(first).not.toContain("241\tline 241");
    expect(first).toContain("Next unread line: 241");
    expect(second).toContain("already read");
  });

  it("reads PNG files as an image result instead of line-numbered text", async () => {
    const root = tempWorkspace();
    // PNG signature + start of IHDR — binary bytes that are garbage as utf8.
    const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(join(root, "shot.png"), pngBytes);

    const result = await readToolImpl({ file_path: "shot.png" });

    expect(typeof result).not.toBe("string");
    expect(result.kind).toBe("image");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(pngBytes.toString("base64"));
  });

  it("reads JPEG files as image/jpeg content", async () => {
    const root = tempWorkspace();
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    writeFileSync(join(root, "photo.JPG"), jpgBytes);

    const result = await readToolImpl({ file_path: "photo.JPG" });

    expect(result.kind).toBe("image");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data).toBe(jpgBytes.toString("base64"));
  });

  it("still reads non-image files as line-numbered text", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "note.txt"), "hello world");

    const result = await readToolImpl({ file_path: "src/note.txt" });

    expect(typeof result).toBe("string");
    expect(result).toContain("1\thello world");
  });

  it("supports bounded grep output modes", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");

    const filesOnly = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 });
    const content = await grepToolImpl({ path: root, pattern: "needle", output_mode: "content", head_limit: 2 });

    expect(filesOnly).toMatch(/src\/(one|two)\.ts/);
    expect(filesOnly).not.toContain("needle one");
    expect(content).toContain("src/one.ts:1:needle one");
    expect(content).toContain("src/two.ts:1:needle two");
  });

  it("keeps bash head and tail when truncating large output", async () => {
    const root = tempWorkspace();
    const dataDir = mkdtempSync(resolve("/tmp", "agent-runtime-tool-artifacts-"));
    tempDirs.push(dataDir);
    configureToolRuntime({ toolArtifactDir: dataDir, runId: "run-tools" });

    const result = await bashToolImpl({
      command: "printf 'HEAD'; printf '%04000d' 0; printf 'TAIL'",
      max_output_chars: 500,
      workdir: root,
    });

    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
    expect(result).toContain("Full output saved to:");
  });

  it("routes bash execution through the configured sandbox engine", async () => {
    const root = tempWorkspace();
    const result = await bashToolImpl(
      { command: "echo unsandboxed", workdir: root },
      {
        sandboxPolicy: failClosedSandboxPolicy({ root }),
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return {
              ...command,
              command: process.execPath,
              args: ["-e", "console.log('sandboxed bash')"],
              sandboxed: true,
            };
          },
        },
      },
    );

    expect(result).toContain("sandboxed bash");
  });

  it("kills the bash process group on timeout", async () => {
    const root = tempWorkspace();
    const marker = `agent-runtime-bash-timeout-${process.pid}-${Date.now()}`;

    const result = await bashToolImpl({
      command: `${process.execPath} -e "setTimeout(() => {}, 5000)" ${marker}`,
      timeout: 1,
      workdir: root,
    });

    expect(result).toContain("Command timed out after 1000ms");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const processes = execFileSync("ps", ["axww", "-o", "command="], { encoding: "utf8" });
    expect(processes).not.toContain(marker);
  });

  it("denies network tools when sandbox policy blocks network", async () => {
    const root = tempWorkspace();
    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const fetchResult = await webFetchToolImpl({ url: "https://example.com" }, { sandboxPolicy });
    const searchResult = await webSearchToolImpl({ query: "mono agent" }, { sandboxPolicy });

    expect(fetchResult).toContain("Network access denied by sandbox policy");
    expect(searchResult).toContain("Network access denied by sandbox policy");
  });

  it("rejects non-http WebFetch URLs before calling fetch", async () => {
    const result = await webFetchToolImpl({ url: "file:///etc/passwd" });

    expect(result).toBe("Error: WebFetch only supports http(s) URLs.");
  });

  it("retries a transient WebFetch error and returns the eventual success", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response("recovered body", { status: 200 });
    };
    try {
      const result = await webFetchToolImpl({ url: "https://example.com" }, { retryDelaysMs: [0, 0] });
      expect(result).toContain("recovered body");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("gives up after exhausting WebFetch retries on a persistent transient error", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const err = new Error("read ECONNRESET");
      err.code = "ECONNRESET";
      throw err;
    };
    try {
      const result = await webFetchToolImpl({ url: "https://example.com" }, { retryDelaysMs: [0, 0] });
      expect(result).toContain("Error fetching URL");
      expect(calls).toBe(3); // initial attempt + 2 retries
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry a non-transient WebFetch error", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("certificate has expired");
    };
    try {
      const result = await webFetchToolImpl({ url: "https://example.com" }, { retryDelaysMs: [0, 0] });
      expect(result).toBe("Error fetching URL: certificate has expired");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a clean error when ripgrep is unavailable", async () => {
    const root = tempWorkspace();
    configureToolRuntime({ workspace: root, ripgrepPath: join(root, "missing-rg") });
    process.env.PATH = "";
    resolveRgPath({ refresh: true });

    const globResult = await globToolImpl({ path: root, pattern: "**/*" });
    const grepResult = await grepToolImpl({ path: root, pattern: "needle" });

    expect(globResult).toContain("ripgrep (rg) is not available");
    expect(globResult).not.toContain("ENOENT");
    expect(grepResult).toContain("ripgrep (rg) is not available");
    expect(grepResult).not.toContain("ENOENT");
  });

  it("rejects absolute paths outside the workspace boundary", async () => {
    tempWorkspace();
    const outside = "/etc/agent-runtime-not-real";
    const outsideFile = `${outside}/secret.txt`;

    const readResult = await readToolImpl({ file_path: outsideFile });
    const writeResult = await writeToolImpl({ file_path: `${outside}/new.txt`, content: "x" });
    const editResult = await editToolImpl({ file_path: outsideFile, old_string: "do", new_string: "x" });
    const globResult = await globToolImpl({ path: outside, pattern: "**/*" });
    const grepResult = await grepToolImpl({ path: outside, pattern: "do" });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
    expect(globResult).toContain("Path not allowed");
    expect(grepResult).toContain("Path not allowed");
  });

  it("uses sandbox policy roots instead of permissive default roots", async () => {
    const root = tempWorkspace();
    const outsideTmpFile = join(resolve("/tmp"), `mono-agent-outside-${process.pid}.txt`);
    writeFile(outsideTmpFile, "outside");

    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const readResult = await readToolImpl({ file_path: outsideTmpFile });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: "/tmp" });

    expect(readResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("treats explicit empty sandbox roots as deny-all", async () => {
    const root = tempWorkspace();
    const rootFile = join(root, "secret.txt");
    writeFile(rootFile, "secret");
    const sandboxPolicy = failClosedSandboxPolicy({
      root,
      readableRoots: [],
      writableRoots: [],
    });

    const readResult = await readToolImpl({ file_path: rootFile }, { sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: join(root, "new.txt"), content: "x" }, { sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: root }, { sandboxPolicy });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("applies per-call sandbox policy to file and shell tools", async () => {
    const root = tempWorkspace();
    const outsideTmpFile = join(resolve("/tmp"), `mono-agent-outside-call-${process.pid}.txt`);
    writeFile(outsideTmpFile, "outside");
    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const readResult = await readToolImpl({ file_path: outsideTmpFile }, { sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: outsideTmpFile, content: "x" }, { sandboxPolicy });
    const globResult = await globToolImpl({ path: "/tmp", pattern: "**/*" }, { sandboxPolicy });
    const grepResult = await grepToolImpl({ path: "/tmp", pattern: "outside" }, { sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: "/tmp" }, { sandboxPolicy });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(globResult).toContain("Path not allowed");
    expect(grepResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("enforces a context-configured sandbox policy on bash and network tools without per-call options", async () => {
    const root = tempWorkspace();
    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const fetchResult = await webFetchToolImpl({ url: "https://example.com" });
    const searchResult = await webSearchToolImpl({ query: "mono agent" });
    const bashResult = await bashToolImpl(
      { command: "echo host", workdir: root },
      {
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return {
              ...command,
              command: process.execPath,
              args: ["-e", "console.log('context sandboxed')"],
              sandboxed: true,
            };
          },
        },
      },
    );

    expect(fetchResult).toContain("Network access denied by sandbox policy");
    expect(searchResult).toContain("Network access denied by sandbox policy");
    expect(bashResult).toContain("context sandboxed");
  });

  it("does not let a per-call policy weaken the context-configured sandbox policy", async () => {
    const root = tempWorkspace();
    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const fetchResult = await webFetchToolImpl(
      { url: "https://example.com" },
      { sandboxPolicy: { mode: "off" } },
    );

    expect(fetchResult).toContain("Network access denied by sandbox policy");
  });

  it("rejects symlink escapes when sandbox policy is configured", async () => {
    const root = tempWorkspace();
    const outside = mkdtempSync(resolve("/tmp", "mono-agent-outside-"));
    tempDirs.push(outside);
    writeFile(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "linked-outside"));

    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const readResult = await readToolImpl({ file_path: "linked-outside/secret.txt" });

    expect(readResult).toContain("Path not allowed");
  });

  it("keeps following workspace symlinks when no sandbox policy is configured", async () => {
    const root = tempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "mono-agent-linked-"));
    tempDirs.push(outside);
    writeFile(join(outside, "linked.txt"), "linked content");
    symlinkSync(outside, join(root, "linked-dep"));

    const readResult = await readToolImpl({ file_path: "linked-dep/linked.txt" });

    expect(readResult).toContain("linked content");
  });

  it("runs an empty bash command without sandbox argument validation errors", async () => {
    const root = tempWorkspace();

    const result = await bashToolImpl({ command: "", workdir: root });

    expect(result).toBe("(no output)");
  });

  it("honors sandbox writable roots separately from readable roots", async () => {
    const root = tempWorkspace();
    const readable = mkdtempSync(resolve("/tmp", "mono-agent-readable-"));
    tempDirs.push(readable);
    writeFile(join(readable, "note.txt"), "read only");

    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({
        root,
        readableRoots: [root, readable],
        writableRoots: [root],
      }),
    });

    const readResult = await readToolImpl({ file_path: join(readable, "note.txt") });
    const writeResult = await writeToolImpl({ file_path: join(readable, "new.txt"), content: "x" });
    const editResult = await editToolImpl({ file_path: join(readable, "note.txt"), old_string: "read", new_string: "write" });

    expect(readResult).toContain("1\tread only");
    expect(writeResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
  });

  it("enforces sandbox denyWrite for file tool writes inside writable roots", async () => {
    const root = tempWorkspace();
    writeFile(join(root, ".env"), "TOKEN=old");
    writeFile(join(root, ".env.local"), "TOKEN=local");
    writeFile(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFile(join(root, ".git", "hooks", "pre-commit"), "echo old\n");

    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const writeResult = await writeToolImpl({ file_path: ".env", content: "TOKEN=new" }, { sandboxPolicy });
    const envLocalResult = await writeToolImpl({ file_path: ".env.local", content: "TOKEN=new" }, { sandboxPolicy });
    const editResult = await editToolImpl({
      file_path: ".git/config",
      old_string: "repositoryformatversion",
      new_string: "changed",
    }, { sandboxPolicy });
    const hookResult = await editToolImpl({
      file_path: ".git/hooks/pre-commit",
      old_string: "echo old",
      new_string: "echo changed",
    }, { sandboxPolicy });
    const allowedWriteResult = await writeToolImpl({ file_path: "notes.txt", content: "ok" }, { sandboxPolicy });

    expect(writeResult).toContain("Path not allowed");
    expect(envLocalResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
    expect(hookResult).toContain("Path not allowed");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("TOKEN=old");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("TOKEN=local");
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toContain("repositoryformatversion");
    expect(readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8")).toContain("echo old");
    expect(allowedWriteResult).toContain("Successfully wrote");
  });

  it("rejects bash workdir outside the workspace boundary", async () => {
    tempWorkspace();

    const result = await bashToolImpl({ command: "pwd", workdir: "/etc/agent-runtime-not-real" });

    expect(result).toContain("Working directory not allowed");
  });
});
