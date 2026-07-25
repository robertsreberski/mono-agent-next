import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
  RuntimeNativeToolDescriptor,
  RuntimeToolResult,
} from "@mono-agent/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capRuntimePiAgentResult,
  createRuntimePiCodingTools,
  grepOutputMode,
  RUNTIME_PI_MAX_BASH_CAPTURE_BYTES,
  RUNTIME_PI_MAX_IMAGE_BASE64_BYTES,
  RUNTIME_PI_MAX_READ_SOURCE_BYTES,
  runRuntimePiGlobTraversal,
  runtimePiCodingNativeTools,
} from "../coding-tools.js";
import type { WebFetchAddress, WebFetchResponse } from "../web-fetch.js";

const childProcessControl = vi.hoisted(() => ({
  actual: undefined as ((...args: unknown[]) => unknown) | undefined,
  override: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessControl.actual = (...args: unknown[]) =>
    Reflect.apply(actual.spawn, actual, args);
  return {
    ...actual,
    spawn: (...args: unknown[]) => childProcessControl.override === undefined
      ? childProcessControl.actual?.(...args)
      : childProcessControl.override(...args),
  };
});

const roots: string[] = [];
const PUBLIC_ADDRESS: WebFetchAddress = { address: "93.184.216.34", family: 4 };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  childProcessControl.override = undefined;
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface FakeRipgrepCall {
  readonly args: readonly string[];
  readonly command: string;
  readonly options: unknown;
}

const FAKE_RIPGREP_PROGRAM = [
  "const { join } = require('node:path');",
  "const input = JSON.parse(process.argv[1]);",
  "const match = (path, line, text) => `${JSON.stringify({",
  "  type: 'match',",
  "  data: { path: { text: path }, lines: { text }, line_number: line },",
  "})}\\n`;",
  "const records = input.oversized",
  "  ? [match(input.path, 1, `needle ${'x'.repeat(512 * 1024)}\\n`)]",
  "  : [",
  "      match(join(input.path, 'a.txt'), 1, 'needle one\\n'),",
  "      match(join(input.path, 'a.txt'), 3, 'needle two\\n'),",
  "      ...(input.ignoreCase",
  "        ? [match(join(input.path, 'b.txt'), 1, 'NEEDLE three\\n')]",
  "        : []),",
  "    ];",
  "const first = records[0];",
  "process.stdout.on('error', () => process.exit(0));",
  "process.stdout.write(first.slice(0, Math.floor(first.length / 2)));",
  "setImmediate(() => {",
  "  process.stdout.write(first.slice(Math.floor(first.length / 2)));",
  "  for (const record of records.slice(1)) process.stdout.write(record);",
  "});",
].join("\n");

function installFakeRipgrep(): { readonly calls: FakeRipgrepCall[] } {
  const calls: FakeRipgrepCall[] = [];
  childProcessControl.override = (...spawnArgs: unknown[]) => {
    const [command, args, options] = spawnArgs;
    if (command !== "rg"
      || !Array.isArray(args)
      || !args.every((value) => typeof value === "string")) {
      throw new Error("Unexpected fake ripgrep invocation.");
    }
    const stringArgs = args as string[];
    calls.push({ command, args: [...stringArgs], options });
    const separator = stringArgs.indexOf("--");
    if (separator < 0 || stringArgs.length !== separator + 3) {
      throw new Error("Fake ripgrep requires a bounded pattern and path.");
    }
    const searchPath = stringArgs[separator + 2] as string;
    const actualSpawn = childProcessControl.actual;
    if (actualSpawn === undefined) {
      throw new Error("Actual child-process spawn is unavailable.");
    }
    return actualSpawn(
      process.execPath,
      [
        "-e",
        FAKE_RIPGREP_PROGRAM,
        JSON.stringify({
          path: searchPath,
          ignoreCase: stringArgs.includes("--ignore-case"),
          oversized: searchPath.endsWith("oversized-line.txt"),
        }),
      ],
      options,
    );
  };
  return { calls };
}

function fixture(
  workspaceDirectory: string,
  overrides: {
    readonly authorize?: (
      descriptor: RuntimeNativeToolDescriptor,
      callId: string,
      summary: string,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly webFetchRequest?: (
      url: URL,
      address: WebFetchAddress,
      headers: Headers,
      signal: AbortSignal,
    ) => Promise<WebFetchResponse>;
    readonly glob?: {
      readonly maxVisitedEntries?: number;
      readonly timeoutMs?: number;
    };
  } = {},
): {
  readonly tools: Map<string, AgentTool>;
  readonly authorize: ReturnType<typeof vi.fn>;
  readonly attempts: ReturnType<typeof vi.fn>;
  readonly results: RuntimeToolResult[];
  readonly turn: AbortController;
} {
  const authorize = vi.fn(overrides.authorize ?? (async () => undefined));
  const attempts = vi.fn();
  const results: RuntimeToolResult[] = [];
  const turn = new AbortController();
  const tools = createRuntimePiCodingTools({
    workspaceDirectory,
    turnSignal: turn.signal,
    authorize,
    record: (result) => results.push(result),
    onToolAttempt: attempts,
    ...(overrides.glob === undefined ? {} : { glob: overrides.glob }),
    webFetch: {
      resolve: async () => [PUBLIC_ADDRESS],
      request: overrides.webFetchRequest ?? (async () => ({
        url: "https://example.test/",
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/plain" }),
        body: new TextEncoder().encode("fetched"),
      })),
    },
  });
  return {
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    authorize,
    attempts,
    results,
    turn,
  };
}

function tool(fixtureValue: ReturnType<typeof fixture>, name: string): AgentTool {
  const selected = fixtureValue.tools.get(name);
  if (selected === undefined) throw new Error(`Missing ${name} fixture tool.`);
  return selected;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("Personal-compatible Pi coding tools", () => {
  it("advertises exact PascalCase authority descriptors", () => {
    expect(runtimePiCodingNativeTools).toEqual([
      {
        id: "Read",
        displayName: "Read",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "unsupported",
      },
      {
        id: "Write",
        displayName: "Write",
        effects: ["write"],
        approval: "core-callback",
        sandbox: "unsupported",
      },
      {
        id: "Glob",
        displayName: "Glob",
        effects: ["read"],
        approval: "core-callback",
        sandbox: "unsupported",
      },
      {
        id: "Grep",
        displayName: "Grep",
        effects: ["read", "execute"],
        approval: "core-callback",
        sandbox: "unsupported",
      },
      {
        id: "Bash",
        displayName: "Bash",
        effects: ["read", "write", "execute", "network"],
        approval: "core-callback",
        sandbox: "unsupported",
      },
      {
        id: "WebFetch",
        displayName: "Web Fetch",
        effects: ["network"],
        approval: "core-callback",
        sandbox: "unsupported",
      },
    ]);
  });

  it("bounds image payloads before they reach the model or runtime result", () => {
    const accepted = "a".repeat(RUNTIME_PI_MAX_IMAGE_BASE64_BYTES);
    const oversized = `${accepted}aaaa`;
    expect(capRuntimePiAgentResult({
      content: [{ type: "image", data: accepted, mimeType: "image/png" }],
      details: {},
    }, 1_024).content).toEqual([
      { type: "image", data: accepted, mimeType: "image/png" },
    ]);
    expect(capRuntimePiAgentResult({
      content: [{ type: "image", data: oversized, mimeType: "image/png" }],
      details: {},
    }, 1_024).content).toEqual([{
      type: "text",
      text: expect.stringContaining("Image omitted"),
    }]);

    for (const maxBytes of [1, 2, 8, 32]) {
      const bounded = capRuntimePiAgentResult({
        content: [{ type: "text", text: "é".repeat(100) }],
        details: {},
      }, maxBytes);
      const text = bounded.content
        .map((part) => part.type === "text" ? part.text : "")
        .join("");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(maxBytes);
      expect(text).not.toContain("\uFFFD");
    }
  });

  it("approves before effects and preserves arbitrary absolute paths", async () => {
    const workspace = await temporaryRoot("runtime-pi-coding-workspace-");
    const outside = await temporaryRoot("runtime-pi-coding-outside-");
    const target = join(outside, "nested", "note.txt");
    const denied = fixture(workspace, {
      authorize: async () => {
        throw new Error("denied by test");
      },
    });

    await expect(tool(denied, "Write").execute("write-denied", {
      file_path: target,
      content: "must not exist",
      workdir: workspace,
    }, signal())).rejects.toThrow("denied by test");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(denied.attempts).not.toHaveBeenCalled();

    const approved = fixture(workspace);
    await tool(approved, "Write").execute("write-approved", {
      file_path: target,
      content: "one\ntwo\nthree",
      workdir: workspace,
    }, signal());
    expect(await readFile(target, "utf8")).toBe("one\ntwo\nthree");
    expect(approved.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Write", effects: ["write"] }),
      "write-approved",
      expect.stringContaining(target),
      expect.any(AbortSignal),
    );

    const read = await tool(approved, "Read").execute("read-approved", {
      file_path: target,
      offset: 1,
      start_line: 2,
      limit: 1,
      max_output_chars: 1_024,
      workdir: workspace,
    }, signal());
    expect(read.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("two"),
    }));
    expect(JSON.stringify(read.content)).not.toContain("one");
    expect(approved.results).toContainEqual(expect.objectContaining({
      callId: "read-approved",
    }));

    const imagePath = join(outside, "one-pixel.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlHkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const image = await tool(approved, "Read").execute("read-image", {
      file_path: imagePath,
      max_output_chars: 1_024,
      workdir: workspace,
    }, signal());
    expect(image.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("Read image file [image/png]"),
    }));

    const bmpPath = join(outside, "unsupported.bmp");
    const bmpHeader = Buffer.alloc(26);
    bmpHeader.write("BM", 0, "ascii");
    bmpHeader.writeUInt32LE(26, 10);
    bmpHeader.writeUInt32LE(12, 14);
    bmpHeader.writeUInt16LE(1, 22);
    bmpHeader.writeUInt16LE(24, 24);
    await writeFile(bmpPath, bmpHeader);
    const bmp = await tool(approved, "Read").execute("read-bmp", {
      file_path: bmpPath,
      max_output_chars: 1_024,
      workdir: workspace,
    }, signal());
    expect(bmp.content).toEqual([{
      type: "text",
      text: "Read image file [image/bmp]\n"
        + "[Image omitted: configure an imageProcessor to convert BMP images.]",
    }]);

    const oversizedPath = join(outside, "oversized-source.txt");
    await writeFile(oversizedPath, "");
    await truncate(oversizedPath, RUNTIME_PI_MAX_READ_SOURCE_BYTES + 1);
    await expect(tool(approved, "Read").execute("read-oversized", {
      file_path: oversizedPath,
      max_output_chars: 1_024,
      workdir: workspace,
    }, signal())).rejects.toThrow("source must be a regular file no larger");
  });

  it("normalizes observed legacy offsets and rejects conflicts before approval", async () => {
    const root = await temporaryRoot("runtime-pi-coding-invalid-");
    const value = fixture(root);
    await writeFile(join(root, "one.txt"), "first\nsecond\nthird\n");
    for (const offset of [-1, -5_000, 0]) {
      const result = await tool(value, "Read").execute(`read-${String(offset)}`, {
        file_path: "one.txt",
        offset,
        limit: 1,
      }, signal());
      expect(result.content).toContainEqual(expect.objectContaining({
        type: "text",
        text: expect.stringContaining("first"),
      }));
    }
    const positive = await tool(value, "Read").execute("read-positive", {
      file_path: "one.txt",
      offset: 1,
      limit: 1,
    }, signal());
    expect(positive.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("second"),
    }));
    const approvedCalls = value.authorize.mock.calls.length;

    await expect(tool(value, "Write").execute("write-conflict", {
      path: "one.txt",
      file_path: "two.txt",
      content: "value",
    }, signal())).rejects.toThrow("path and file_path conflict");
    await expect(tool(value, "Read").execute("read-conflict", {
      file_path: "one.txt",
      offset: -1,
      start_line: 2,
    }, signal())).rejects.toThrow("offset and start_line conflict");
    expect(value.authorize).toHaveBeenCalledTimes(approvedCalls);
  });

  it("runs bounded local Glob traversal without a helper binary", async () => {
    const root = await temporaryRoot("runtime-pi-coding-glob-");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "one.txt"), "one");
    await writeFile(join(root, "src", "two.ts"), "two");
    await writeFile(join(root, "node_modules", "pkg", "hidden.txt"), "hidden");
    const value = fixture(root);

    const result = await tool(value, "Glob").execute("glob", {
      pattern: "**/*.txt",
      path: root,
      limit: 100,
      max_output_chars: 4_096,
      workdir: root,
    }, signal());

    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
    expect(text).toContain("src/one.txt");
    expect(text).not.toContain("node_modules");
    expect(value.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Glob", effects: ["read"] }),
      "glob",
      expect.any(String),
      expect.any(AbortSignal),
    );

    const budgeted = fixture(root, {
      glob: { maxVisitedEntries: 1, timeoutMs: 1_000 },
    });
    await expect(tool(budgeted, "Glob").execute("glob-budget", {
      pattern: "**/*.missing",
      path: root,
      limit: 100,
      workdir: root,
    }, signal())).rejects.toThrow("traversal exceeded the 1-entry limit");

    const orderingRoot = await temporaryRoot("runtime-pi-coding-glob-order-");
    for (const [directory, file] of [
      ["w", "w.txt"],
      ["a", "a.txt"],
      ["m", "m.txt"],
    ] as const) {
      await mkdir(join(orderingRoot, directory), { recursive: true });
      await writeFile(join(orderingRoot, directory, file), file);
    }
    const full = await runRuntimePiGlobTraversal("**/*.txt", orderingRoot, {
      ignore: [],
      limit: 100,
      maxVisitedEntries: 100,
      signal: AbortSignal.timeout(1_000),
    });
    const limited = await runRuntimePiGlobTraversal("**/*.txt", orderingRoot, {
      ignore: [],
      limit: 1,
      maxVisitedEntries: 100,
      signal: AbortSignal.timeout(1_000),
    });
    expect(limited).toEqual(full.slice(0, 1));
    expect(limited).toEqual([join(orderingRoot, "a", "a.txt")]);

    const deadline = AbortSignal.timeout(1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    await expect(runRuntimePiGlobTraversal("**/*", root, {
      ignore: [],
      limit: 100,
      maxVisitedEntries: 100,
      signal: deadline,
    })).rejects.toMatchObject({ name: "TimeoutError" });

    const cancellation = new AbortController();
    const cancelledTraversal = runRuntimePiGlobTraversal("**/*", root, {
      ignore: [],
      limit: 100,
      maxVisitedEntries: 100,
      signal: cancellation.signal,
    });
    queueMicrotask(() => cancellation.abort(new Error("cancelled traversal")));
    await expect(cancelledTraversal).rejects.toThrow("cancelled traversal");
  });

  it("preserves Personal Grep content, files, and count output modes", async () => {
    const root = await temporaryRoot("runtime-pi-coding-grep-");
    const fakeRipgrep = installFakeRipgrep();
    await writeFile(join(root, "a.txt"), "needle one\nnot this\nneedle two\n");
    await writeFile(join(root, "b.txt"), "NEEDLE three\n");
    const value = fixture(root);
    const base = {
      pattern: "-needle",
      path: root,
      head_limit: 100,
      max_output_chars: 8_192,
      workdir: root,
    };

    const content = await tool(value, "Grep").execute("grep-content", {
      ...base,
      output_mode: "content",
      context: 0,
    }, signal());
    expect(content.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: expect.stringMatching(/a\.txt:1: needle one/u),
    }));

    const files = await tool(value, "Grep").execute("grep-files", {
      ...base,
      output_mode: "files_with_matches",
      case_insensitive: true,
      glob: "*.txt",
    }, signal());
    expect(files.content).toEqual([{
      type: "text",
      text: "a.txt\nb.txt",
    }]);

    const count = await tool(value, "Grep").execute("grep-count", {
      ...base,
      output_mode: "count",
      case_insensitive: true,
    }, signal());
    expect(count.content).toEqual([{
      type: "text",
      text: "a.txt:2\nb.txt:1",
    }]);

    await writeFile(join(root, "oversized-line.txt"), `needle ${"x".repeat(512 * 1024)}\n`);
    const boundedStream = await tool(value, "Grep").execute("grep-bounded-stream", {
      ...base,
      path: join(root, "oversized-line.txt"),
      output_mode: "content",
    }, signal());
    expect(boundedStream.content).toEqual([{
      type: "text",
      text: expect.stringContaining("Ripgrep output exceeded the bounded stream limit"),
    }]);

    await writeFile(
      join(root, "dense.txt"),
      Array.from({ length: 10 }, (_, index) => `needle ${String(index)}`).join("\n"),
    );
    for (const output_mode of ["files_with_matches", "count"] as const) {
      const partial = await tool(value, "Grep").execute(`grep-partial-${output_mode}`, {
        ...base,
        output_mode,
        head_limit: 2,
        case_insensitive: true,
      }, signal());
      expect(partial.content).toContainEqual(expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/^\[PARTIAL Grep projection:.*incomplete\./u),
      }));
    }

    for (const outputMode of ["files_with_matches", "count"] as const) {
      const partialWithoutParsedMatches = grepOutputMode({
        content: [{ type: "text", text: "truncated before a complete match record" }],
        details: {
          truncation: { truncated: true },
          matchLimitReached: 2,
        },
      }, outputMode);
      expect(partialWithoutParsedMatches.content).toEqual([{
        type: "text",
        text: expect.stringMatching(
          /^\[PARTIAL Grep projection:.*\nNo complete match records were available/u,
        ),
      }]);
      expect(partialWithoutParsedMatches.content).not.toEqual([{
        type: "text",
        text: "No matches found.",
      }]);
    }

    const commonArgs = [
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      "--max-columns",
      "4096",
      "--max-columns-preview",
    ];
    const caseInsensitiveArgs = [
      ...commonArgs,
      "--ignore-case",
      "--",
      "-needle",
      root,
    ];
    const options = { stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    expect(fakeRipgrep.calls.map(({ command, options: spawnOptions }) => ({
      command,
      options: spawnOptions,
    }))).toEqual(Array.from({ length: 6 }, () => ({ command: "rg", options })));
    expect(fakeRipgrep.calls.map(({ args }) => args)).toEqual([
      [...commonArgs, "--", "-needle", root],
      [
        ...commonArgs,
        "--ignore-case",
        "--glob",
        "*.txt",
        "--",
        "-needle",
        root,
      ],
      caseInsensitiveArgs,
      [...commonArgs, "--", "-needle", join(root, "oversized-line.txt")],
      caseInsensitiveArgs,
      caseInsensitiveArgs,
    ]);
  });

  it("fails explicitly when ripgrep is absent from PATH", async () => {
    const root = await temporaryRoot("runtime-pi-coding-grep-missing-");
    const emptyBin = join(root, "empty-bin");
    await mkdir(emptyBin);
    vi.stubEnv("PATH", emptyBin);
    const value = fixture(root);

    await expect(tool(value, "Grep").execute("grep-missing", {
      pattern: "needle",
      path: root,
      output_mode: "content",
      workdir: root,
    }, signal())).rejects.toThrow(
      "Grep failed: ripgrep (rg) is required but was not found on PATH.",
    );
    expect(value.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Grep", effects: ["read", "execute"] }),
      "grep-missing",
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("normalizes and caps Bash timeout, output, and cancellation", async () => {
    const root = await temporaryRoot("runtime-pi-coding-bash-");
    const value = fixture(root);
    const output = await tool(value, "Bash").execute("bash-output", {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(5000))")}`,
      timeout: 999_999,
      workdir: root,
      description: "bounded command",
      max_output_chars: 1_024,
    }, signal());
    expect(Buffer.byteLength(
      output.content.map((part) => part.type === "text" ? part.text : "").join(""),
      "utf8",
    )).toBeLessThanOrEqual(1_024);
    expect(value.authorize.mock.calls[0]?.[2]).toContain("timeout_seconds: 600");

    await expect(tool(value, "Bash").execute("bash-overflow", {
      command: `${JSON.stringify(process.execPath)} -e ${
        JSON.stringify(
          `process.stdout.write(Buffer.alloc(${String(
            RUNTIME_PI_MAX_BASH_CAPTURE_BYTES + 1
          )}, 0x78))`,
        )
      }`,
      timeout: 30,
      workdir: root,
      max_output_chars: 1_024,
    }, signal())).rejects.toThrow("hard capture limit");

    const marker = join(root, "must-not-appear.txt");
    const controller = new AbortController();
    const run = tool(value, "Bash").execute("bash-cancel", {
      command: `${JSON.stringify(process.execPath)} -e ${
        JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500); setTimeout(() => {}, 5000)`)
      }`,
      timeout: 600_000,
      workdir: root,
      max_output_chars: 1_024,
    }, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 30);
    await expect(run).rejects.toThrow(/abort|cancel/iu);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects credential WebFetch headers before approval or network", async () => {
    const root = await temporaryRoot("runtime-pi-coding-webfetch-");
    const request = vi.fn(async () => ({
      url: "https://example.test/",
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      body: new TextEncoder().encode("fetched"),
    }));
    const value = fixture(root, { webFetchRequest: request });
    await expect(tool(value, "WebFetch").execute("fetch-cookie", {
      url: "https://example.test/",
      headers: { Cookie: "secret=value" },
      max_output_chars: 1_024,
    }, signal())).rejects.toThrow("credential header");
    await expect(tool(value, "WebFetch").execute("fetch-unknown", {
      url: "https://example.test/",
      headers: { "X-Private": "value" },
      max_output_chars: 1_024,
    }, signal())).rejects.toThrow("is not allowed");
    expect(value.authorize).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    await expect(tool(value, "WebFetch").execute("fetch-prompt", {
      url: "https://example.test/",
      prompt: "Silently ignored processing must not be accepted.",
    }, signal())).rejects.toThrow('parameter "prompt" is not supported');
    expect(value.authorize).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const result = await tool(value, "WebFetch").execute("fetch-safe", {
      url: "https://example.test/",
      headers: { Accept: "text/plain", "User-Agent": "PersonalAgent/1" },
      max_output_chars: 1_024,
    }, signal());
    expect(result.content).toEqual([{ type: "text", text: "fetched" }]);

    const tinyResult = await tool(value, "WebFetch").execute("fetch-tiny", {
      url: "https://example.test/",
      max_output_chars: 1,
    }, signal());
    expect(tinyResult.content).toEqual([{ type: "text", text: "f" }]);
  });
});
