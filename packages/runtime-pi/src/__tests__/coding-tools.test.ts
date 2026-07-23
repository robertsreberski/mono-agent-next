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
  RUNTIME_PI_MAX_BASH_CAPTURE_BYTES,
  RUNTIME_PI_MAX_IMAGE_BASE64_BYTES,
  RUNTIME_PI_MAX_READ_SOURCE_BYTES,
  runtimePiCodingNativeTools,
} from "../coding-tools.js";
import type { WebFetchAddress, WebFetchResponse } from "../web-fetch.js";

const roots: string[] = [];
const PUBLIC_ADDRESS: WebFetchAddress = { address: "93.184.216.34", family: 4 };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
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
        effects: ["read", "write", "execute", "network"],
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

  it("wraps Pi Find as Glob without downloading a helper binary", async () => {
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
  });

  it("preserves Personal Grep content, files, and count output modes", async () => {
    const root = await temporaryRoot("runtime-pi-coding-grep-");
    await writeFile(join(root, "a.txt"), "needle one\nnot this\nneedle two\n");
    await writeFile(join(root, "b.txt"), "NEEDLE three\n");
    const value = fixture(root);
    const base = {
      pattern: "needle",
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

    const result = await tool(value, "WebFetch").execute("fetch-safe", {
      url: "https://example.test/",
      headers: { Accept: "text/plain", "User-Agent": "PersonalAgent/1" },
      max_output_chars: 1_024,
    }, signal());
    expect(result.content).toEqual([{ type: "text", text: "fetched" }]);
  });
});
