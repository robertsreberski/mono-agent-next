import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadDocsCorpus } from "../corpus.js";
import type { DocsCorpus, DocsCorpusChunk, DocsCorpusDocument } from "../corpus.js";
import { assertUniqueDocumentLocations } from "../markdown-helpers.js";
import { MONO_AGENT_DOCS_CHUNK_URI_PREFIX, MonoAgentDocsReader } from "../reader.js";
import { MonoAgentDocsSearchIndex } from "../search.js";
import { createMonoAgentDocsMcpServer, MONO_AGENT_DOCS_TOOL_NAME } from "../server.js";
import type { MonoAgentDocsReadResult, MonoAgentDocsSearchResult } from "../types.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const corpusDir = join(packageRoot, "dist", "corpus");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential("@mono-agent/docs-mcp", () => {
  it("builds a deterministic, checksummed corpus with documents and resolvable source positions", async () => {
    const before = await artifactDigests();
    await execFileAsync(process.execPath, [join(packageRoot, "scripts", "generate-corpus.mjs")], { cwd: packageRoot });
    const after = await artifactDigests();
    expect(after).toEqual(before);

    const corpus = await loadDocsCorpus(corpusDir);
    const paths = new Set(corpus.documents.map((document) => document.path));
    expect(paths).toContain("docs/reference/public-api.md");
    expect(paths).toContain("docs/tools/documentation-mcp.md");
    expect([...paths].some((path) => path.startsWith("docs/skills/"))).toBe(false);
    expect([...paths].some((path) => path.startsWith("docs/superpowers/"))).toBe(false);
    expect([...paths].some((path) => path.includes("website/"))).toBe(false);
    expect(corpus.chunks.some((chunk) => chunk.text.includes("```json") || chunk.text.includes("```bash"))).toBe(true);
    expect(corpus.manifest.schema).toBe("mono-agent.docs-corpus.v2");
    expect(corpus.manifest.chunkerVersion).toBe("markdown-blocks-v2");
    expect(corpus.manifest.documentCount).toBe(corpus.documents.length);
    expect(corpus.manifest.chunkCount).toBe(corpus.chunks.length);
    expect(corpus.manifest.model).toMatchObject({ version: "1.0.4", dimensions: 256 });
    expect(corpus.chunks.every((chunk) => {
      const document = corpus.documentsById.get(chunk.documentId);
      return document !== undefined && chunk.startOffset < chunk.endOffset && chunk.endOffset <= document.markdown.length;
    })).toBe(true);
  }, 60_000);

  it("fails closed when any generated artifact is corrupt", async () => {
    const copy = await mkdtemp(join(tmpdir(), "mono-agent-docs-corrupt-"));
    temporaryDirectories.push(copy);
    await cp(corpusDir, copy, { recursive: true });
    const path = join(copy, "documents.json");
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(path, bytes);
    await expect(loadDocsCorpus(copy)).rejects.toThrow(/checksum mismatch/u);
  });

  it("rejects every corrupt-corpus integrity class with its specific diagnostic", async () => {
    const cases: readonly {
      readonly label: string;
      readonly mutate: (copy: string) => Promise<string>;
    }[] = [
      {
        label: "non-finite-embedding",
        mutate: async (copy) => {
          const path = join(copy, "embeddings.f32");
          const bytes = Buffer.from(await readFile(path));
          bytes.writeFloatLE(Number.NaN, 0);
          await writeFile(path, bytes);
          await refreshManifestDigests(copy);
          return "Documentation embedding 0:0 is not finite.";
        },
      },
      {
        label: "embedding-byte-length",
        mutate: async (copy) => {
          const path = join(copy, "embeddings.f32");
          const bytes = await readFile(path);
          await writeFile(path, bytes.subarray(0, bytes.length - Float32Array.BYTES_PER_ELEMENT));
          await refreshManifestDigests(copy);
          return `Documentation embedding byte length mismatch: expected ${bytes.length}, received ${bytes.length - Float32Array.BYTES_PER_ELEMENT}.`;
        },
      },
      {
        label: "chunk-provenance",
        mutate: async (copy) => {
          const path = join(copy, "chunks.json");
          const chunks = JSON.parse(await readFile(path, "utf8")) as Array<{ id: string; path: string }>;
          chunks[0]!.path = `${chunks[0]!.path}.invalid`;
          await writeFile(path, `${JSON.stringify(chunks)}\n`, "utf8");
          await refreshManifestDigests(copy);
          return `Documentation chunk ${chunks[0]!.id} has invalid document provenance.`;
        },
      },
      {
        label: "duplicate-route",
        mutate: async (copy) => {
          const path = join(copy, "documents.json");
          const documents = JSON.parse(await readFile(path, "utf8")) as Array<{ route?: string }>;
          const routed = documents.filter((document): document is { route: string } => document.route !== undefined);
          routed[1]!.route = routed[0]!.route;
          await writeFile(path, `${JSON.stringify(documents)}\n`, "utf8");
          await refreshManifestDigests(copy);
          return `Documentation corpus contains duplicate document route ${routed[0]!.route}.`;
        },
      },
    ];

    for (const testCase of cases) {
      const copy = await copyCorpus(testCase.label);
      const expectedMessage = await testCase.mutate(copy);
      await expect(loadDocsCorpus(copy), testCase.label).rejects.toThrow(expectedMessage);
    }
  });

  it("rejects duplicate document paths before corpus artifacts are generated", () => {
    expect(() => assertUniqueDocumentLocations([
      { path: "docs/foo.md", route: "/foo/" },
      { path: "docs/foo.md", route: "/other/" },
    ])).toThrow("Documentation corpus contains duplicate document path docs/foo.md.");
  });

  it("fails the generator entrypoint before writes when documentation routes collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-docs-route-collision-"));
    temporaryDirectories.push(root);
    const docsRoot = join(root, "docs");
    const outputDirectory = join(root, "output");
    await mkdir(join(docsRoot, "foo"), { recursive: true });
    await Promise.all([
      writeFile(join(docsRoot, "foo.md"), "# Foo\n", "utf8"),
      writeFile(join(docsRoot, "foo", "index.md"), "# Foo index\n", "utf8"),
    ]);

    await expect(execFileAsync(process.execPath, [
      join(packageRoot, "scripts", "generate-corpus.mjs"),
      "--docs-root",
      docsRoot,
      "--output-directory",
      outputDirectory,
    ], { cwd: packageRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining("Documentation corpus contains duplicate document route /foo/."),
    });
    await expect(access(outputDirectory)).rejects.toThrow();
  });

  it("finds paraphrased concepts and exact identifiers as expanded, section-deduplicated excerpts", async () => {
    const index = new MonoAgentDocsSearchIndex(await loadDocsCorpus(corpusDir));
    const exact = await index.search({ query: "routing fallbacks", limit: 5 });
    expect(exact.schema).toBe("mono-agent.docs.v2");
    expect(exact.results).toHaveLength(5);
    expect(exact.results.every((result) => result.source === "docs")).toBe(true);
    expect(exact.results.some((result) => /fallback/iu.test(`${result.headingPath.join(" ")} ${result.markdown}`))).toBe(true);
    expect(exact.results.every((result) => result.markdown.length <= 3_000 && result.markdown.length > 1_200)).toBe(true);
    expect(exact.navigation.nextActions[0]?.arguments).toEqual({ action: "read", target: exact.results[0]?.readTarget });

    const semantic = await index.search({ query: "How can my agent answer people through Telegram?", limit: 5 });
    expect(semantic.results.some((result) => /telegram/iu.test(`${result.title} ${result.headingPath.join(" ")} ${result.markdown}`))).toBe(true);

    const docsOnly = await index.search({ query: "permanent first-run memory marker", limit: 8 });
    expect(docsOnly.results.every((result) => result.source === "docs")).toBe(true);
    expect(docsOnly.results.some((result) => result.path.includes("memory"))).toBe(true);
    const sections = docsOnly.results.map((result) => `${result.path}:${result.canonicalUrl?.split("#")[1] ?? "overview"}`);
    expect(new Set(sections).size).toBe(sections.length);
    const pathCounts = docsOnly.results.reduce(
      (counts, result) => counts.set(result.path, (counts.get(result.path) ?? 0) + 1),
      new Map<string, number>(),
    );
    expect(Math.max(...pathCounts.values())).toBeLessThanOrEqual(2);
  }, 30_000);

  it("reads chunk, path, link, and exact non-overlapping continuation targets", async () => {
    const index = new MonoAgentDocsSearchIndex(await loadDocsCorpus(corpusDir));
    const search = await index.search({ query: "channel-operator protocol", limit: 3 });
    const expanded = index.read(search.results[0]!.readTarget);
    expect("error" in expanded).toBe(false);
    if ("error" in expanded) throw new Error(expanded.error.message);
    expect(expanded.markdown.length).toBeGreaterThan(search.results[0]!.markdown.length);
    expect(expanded.markdown.length).toBeLessThanOrEqual(10_000);

    const linked = index.read("docs/tools/documentation-mcp.md");
    expect("error" in linked).toBe(false);
    if ("error" in linked) throw new Error(linked.error.message);
    const mcpLink = linked.internalLinks.find((link) => link.readTarget === "docs/tools/mcp.md");
    expect(mcpLink).toBeDefined();
    const followed = index.read(mcpLink!.readTarget);
    expect("error" in followed).toBe(false);
    if ("error" in followed) throw new Error(followed.error.message);
    expect(followed.path).toBe("docs/tools/mcp.md");

    for (const target of [
      "/tools/documentation-mcp/#tool-contract",
      "https://mono-agent-docs.vercel.app/tools/documentation-mcp/#tool-contract",
      "docs/tools/documentation-mcp.md#tool-contract",
    ]) {
      const anchored = index.read(target);
      expect("error" in anchored).toBe(false);
      if ("error" in anchored) throw new Error(anchored.error.message);
      expect(anchored.path).toBe("docs/tools/documentation-mcp.md");
      expect(anchored.headingPath).toEqual(["Tool contract"]);
      expect(anchored.markdown).toMatch(/^## Tool contract/mu);
    }

    const first = index.read("docs/reference/public-api.md");
    expect("error" in first).toBe(false);
    if ("error" in first) throw new Error(first.error.message);
    expect(first.previousTarget).toBeUndefined();
    expect(first.nextTarget).toMatch(/^mono-agent-docs:\/\/document\/[a-f0-9]{64}\?start=\d+$/u);
    const nextStart = /\?start=(\d+)$/u.exec(first.nextTarget!)?.[1];
    const second = index.read(first.nextTarget!);
    expect("error" in second).toBe(false);
    if ("error" in second) throw new Error(second.error.message);
    expect(second.previousTarget).toMatch(new RegExp(`\\?end=${nextStart}$`, "u"));
    expect(second.markdown).not.toBe(first.markdown);
    expect(second.navigation.nextActions.some((action) => action.arguments.action === "read")).toBe(true);
  });

  it("read returns a structured error for every unsupported and not-found target class", async () => {
    const corpus = await loadDocsCorpus(corpusDir);
    const index = new MonoAgentDocsSearchIndex(corpus);
    const document = corpus.documents[0]!;
    const cases = [
      { target: "x".repeat(2_001), code: "unsupported_target" },
      { target: "ftp://example.com/docs", code: "unsupported_target" },
      { target: "mono-agent-docs://chunk/not-a-digest", code: "unsupported_target" },
      {
        target: `mono-agent-docs://document/${document.id}?start=${document.markdown.length + 1}`,
        code: "target_not_found",
      },
      { target: "docs/does-not-exist.md", code: "target_not_found" },
      { target: "/does-not-exist/", code: "target_not_found" },
      { target: `${document.path}#does-not-exist`, code: "target_not_found" },
    ] as const;

    for (const testCase of cases) {
      const result = index.read(testCase.target);
      expect("error" in result, testCase.target).toBe(true);
      if (!("error" in result)) throw new Error(`Expected ${testCase.target} to fail.`);
      expect(result.error.code, testCase.target).toBe(testCase.code);
      expect(result.navigation.nextActions.length, testCase.target).toBeGreaterThan(0);
    }
  });

  it("keeps truncated and pathological read windows code-fence balanced", () => {
    const closedMarkdown = [
      "# Fixture",
      "",
      "## Long code",
      "",
      "```ts",
      "const value = 1;\n".repeat(1_200),
      "```",
      "",
      "Tail.",
    ].join("\n");
    const closed = corpusFixture(closedMarkdown, closedMarkdown.indexOf("const value") + 8_000);
    const closedReader = new MonoAgentDocsReader(closed.corpus);
    const closedResult = closedReader.read(`${MONO_AGENT_DOCS_CHUNK_URI_PREFIX}${closed.chunk.id}`);
    expect("error" in closedResult).toBe(false);
    if ("error" in closedResult) throw new Error(closedResult.error.message);
    expect(fenceMarkers(closedResult.markdown)).toHaveLength(2);

    const pathologicalFence = "`".repeat(1_500);
    const pathologicalMarkdown = [
      "# Fixture",
      "",
      "## Unclosed code",
      "",
      pathologicalFence,
      "x".repeat(15_000),
    ].join("\n");
    const pathological = corpusFixture(pathologicalMarkdown, pathologicalMarkdown.indexOf("x") + 7_000);
    const pathologicalReader = new MonoAgentDocsReader(pathological.corpus);
    const pathologicalResult = pathologicalReader.read(
      `${MONO_AGENT_DOCS_CHUNK_URI_PREFIX}${pathological.chunk.id}`,
    );
    expect("error" in pathologicalResult).toBe(false);
    if ("error" in pathologicalResult) throw new Error(pathologicalResult.error.message);
    expect(pathologicalResult.markdown.length).toBeLessThanOrEqual(10_000);
    expect(fenceMarkers(pathologicalResult.markdown).length % 2).toBe(0);

    const pathologicalSearchHit = pathologicalReader.searchHit(pathological.chunk, 1);
    expect(pathologicalSearchHit.markdown.length).toBeLessThanOrEqual(3_000);
    expect(fenceMarkers(pathologicalSearchHit.markdown).length % 2).toBe(0);
  });

  it("publishes only mono_agent_docs and gives MCP clients explicit search-to-read guidance", async () => {
    const server = createMonoAgentDocsMcpServer();
    const client = new Client({ name: "docs-mcp-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toContainEqual(expect.objectContaining({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        description: expect.stringContaining("First call"),
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
      }));
      expect(tools.tools.some((tool) => tool.name === "search_mono_agent_docs")).toBe(false);
      const docsTool = tools.tools.find((tool) => tool.name === MONO_AGENT_DOCS_TOOL_NAME);
      expect(docsTool?.inputSchema).toMatchObject({
        type: "object",
        required: ["action"],
        properties: {
          action: expect.objectContaining({ enum: ["search", "read"] }),
          query: expect.any(Object),
          target: expect.any(Object),
        },
      });
      expect(docsTool?.inputSchema.properties).not.toHaveProperty("scope");

      const response = await client.callTool({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        arguments: { action: "search", query: "channel-operator protocol", limit: 3 },
      }) as unknown as { content: Array<{ type: string; text?: string; uri?: string }>; structuredContent?: MonoAgentDocsSearchResult };
      expect(response.structuredContent?.results[0]?.markdown.length).toBeGreaterThan(1_200);
      expect(response.structuredContent).not.toHaveProperty("scope");
      expect(response.content.some((block) => block.type === "text" && block.text?.includes('"action":"read"'))).toBe(true);
      expect(response.content.some((block) => block.type === "resource_link")).toBe(true);
      const target = response.structuredContent?.results[0]?.readTarget;
      expect(target).toMatch(/^mono-agent-docs:\/\/chunk\/[a-f0-9]{64}$/u);

      const readResponse = await client.callTool({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        arguments: { action: "read", target },
      }) as unknown as { content: Array<{ type: string; text?: string }>; structuredContent?: MonoAgentDocsReadResult };
      expect(readResponse.structuredContent?.markdown.length).toBeGreaterThan(response.structuredContent!.results[0]!.markdown.length);
      expect(readResponse.content.some((block) => block.text?.includes("document window"))).toBe(true);

      const resource = await client.readResource({ uri: target! });
      expect(resource.contents[0]).toMatchObject({ uri: target, mimeType: "text/markdown" });
      const resourceText = "text" in resource.contents[0]! ? resource.contents[0].text : "";
      expect(resourceText.length).toBeGreaterThan(response.structuredContent!.results[0]!.markdown.length);

      const failed = await client.callTool({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        arguments: { action: "read", target: "https://example.com/docs" },
      }) as { isError?: boolean; structuredContent?: { error?: { code?: string }; navigation?: { nextActions?: unknown[] } } };
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent?.error?.code).toBe("unsupported_target");
      expect(failed.structuredContent?.navigation?.nextActions).not.toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  }, 30_000);

  it("serves the action contract over the packed clean-stdio command boundary", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, "dist", "cli.js")],
      cwd: packageRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "docs-mcp-stdio-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        arguments: { action: "search", query: "What command validates an agent configuration?", limit: 2 },
      }) as { structuredContent?: MonoAgentDocsSearchResult };
      expect(result.structuredContent?.results).toHaveLength(2);
      expect(result.structuredContent?.navigation.nextActions[0]?.arguments.action).toBe("read");
    } finally {
      await client.close();
    }
  }, 30_000);
});

async function artifactDigests(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ["documents.json", "chunks.json", "embeddings.f32", "manifest.json"]) {
    result[name] = createHash("sha256").update(await readFile(join(corpusDir, name))).digest("hex");
  }
  return result;
}

async function copyCorpus(label: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), `mono-agent-docs-${label}-`));
  temporaryDirectories.push(copy);
  await cp(corpusDir, copy, { recursive: true });
  return copy;
}

async function refreshManifestDigests(directory: string): Promise<void> {
  const documentsBytes = await readFile(join(directory, "documents.json"));
  const chunksBytes = await readFile(join(directory, "chunks.json"));
  const embeddingsBytes = await readFile(join(directory, "embeddings.f32"));
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    corpusDigest: string;
    artifacts: {
      documentsSha256: string;
      chunksSha256: string;
      embeddingsSha256: string;
    };
  };
  manifest.artifacts.documentsSha256 = createHash("sha256").update(documentsBytes).digest("hex");
  manifest.artifacts.chunksSha256 = createHash("sha256").update(chunksBytes).digest("hex");
  manifest.artifacts.embeddingsSha256 = createHash("sha256").update(embeddingsBytes).digest("hex");
  manifest.corpusDigest = createHash("sha256")
    .update(documentsBytes)
    .update(chunksBytes)
    .update(embeddingsBytes)
    .digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function corpusFixture(
  markdown: string,
  focusOffset: number,
): { readonly corpus: DocsCorpus; readonly chunk: DocsCorpusChunk } {
  const document: DocsCorpusDocument = {
    id: "a".repeat(64),
    source: "docs",
    path: "docs/fixture.md",
    title: "Fixture",
    route: "/fixture/",
    canonicalUrl: "https://mono-agent-docs.vercel.app/fixture/",
    markdown,
    headings: [],
    units: [],
  };
  const chunk: DocsCorpusChunk = {
    id: "b".repeat(64),
    documentId: document.id,
    source: "docs",
    path: document.path,
    title: document.title,
    headingPath: ["Fixture"],
    startOffset: focusOffset,
    endOffset: Math.min(markdown.length, focusOffset + 64),
    text: markdown.slice(focusOffset, focusOffset + 64),
    embeddingText: markdown.slice(focusOffset, focusOffset + 64),
  };
  return {
    chunk,
    corpus: {
      manifest: {
        schema: "mono-agent.docs-corpus.v2",
        docsVersion: "0.15.0",
        sourceDigest: "c".repeat(64),
        corpusDigest: "d".repeat(64),
        chunkerVersion: "markdown-blocks-v2",
        documentCount: 1,
        chunkCount: 1,
        model: {
          package: "@yarflam/potion-base-8m",
          version: "1.0.4",
          id: "minishlab/potion-base-8M",
          dimensions: 256,
        },
        artifacts: {
          documentsSha256: "e".repeat(64),
          chunksSha256: "f".repeat(64),
          embeddingsSha256: "0".repeat(64),
          byteOrder: "little-endian",
        },
      },
      documents: [document],
      chunks: [chunk],
      embeddings: [new Float32Array(256)],
      documentsById: new Map([[document.id, document]]),
      documentsByPath: new Map([[document.path, document]]),
      documentsByRoute: new Map([[document.route!, document]]),
      chunksById: new Map([[chunk.id, chunk]]),
    },
  };
}

function fenceMarkers(markdown: string): readonly string[] {
  return markdown.match(/^\s{0,3}(?:`{3,}|~{3,})/gmu) ?? [];
}
