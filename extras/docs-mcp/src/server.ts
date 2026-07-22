import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { docsMcpPackageVersion } from "./package-version.js";
import { loadDefaultDocsSearchIndex } from "./search.js";
import type {
  MonoAgentDocsErrorResult,
  MonoAgentDocsInternalLink,
  MonoAgentDocsNavigation,
  MonoAgentDocsReadResult,
  MonoAgentDocsSearchHit,
  MonoAgentDocsSearchResult,
} from "./types.js";

export const MONO_AGENT_DOCS_TOOL_NAME = "mono_agent_docs";

const docsInputSchema = z.object({
  action: z.enum(["search", "read"]).describe("Use search to find sections, then read to expand an exact target."),
  query: z.string().min(3).max(500).optional().describe("Required for action=search: natural-language question or exact mono-agent config, package, environment, or CLI identifier."),
  limit: z.number().int().min(1).max(8).optional().describe("For action=search: maximum distinct sections (default 5)."),
  scope: z.enum(["all", "docs"]).optional().describe("For action=search: the version-matched public documentation corpus."),
  target: z.string().min(1).max(2_000).optional().describe("Required for action=read: use a readTarget, previousTarget, nextTarget, logical corpus path, docs route, or canonical docs URL."),
}).strict();
const internalLinkSchema = z.object({
  label: z.string(),
  href: z.string(),
  readTarget: z.string(),
});
const navigationArgumentsSchema = z.object({
  action: z.enum(["search", "read"]),
  query: z.string().optional(),
  limit: z.number().int().optional(),
  scope: z.enum(["all", "docs"]).optional(),
  target: z.string().optional(),
});
const navigationActionSchema = z.object({
  kind: z.enum(["next", "previous", "read", "search"]),
  description: z.string(),
  arguments: navigationArgumentsSchema,
});
const navigationSchema = z.object({
  guidance: z.string(),
  nextActions: z.array(navigationActionSchema),
});
const searchHitSchema = z.object({
  rank: z.number().int().positive(),
  chunkId: z.string(),
  readTarget: z.string(),
  source: z.literal("docs"),
  path: z.string(),
  title: z.string(),
  headingPath: z.array(z.string()),
  canonicalUrl: z.string().optional(),
  markdown: z.string().max(3_000),
  truncatedBefore: z.boolean(),
  truncatedAfter: z.boolean(),
  internalLinks: z.array(internalLinkSchema),
});
const commonOutputFields = {
  schema: z.literal("mono-agent.docs.v2"),
  docsVersion: z.string(),
  corpusDigest: z.string(),
};
const errorSchema = z.object({
  code: z.enum(["target_not_found", "unsupported_target"]),
  message: z.string(),
});
const docsOutputSchema = z.object({
  ...commonOutputFields,
  action: z.enum(["search", "read"]),
  retrievalMode: z.literal("hybrid").optional(),
  query: z.string().optional(),
  scope: z.enum(["all", "docs"]).optional(),
  results: z.array(searchHitSchema).optional(),
  target: z.string().optional(),
  source: z.literal("docs").optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  headingPath: z.array(z.string()).optional(),
  canonicalUrl: z.string().optional(),
  markdown: z.string().max(10_000).optional(),
  truncatedBefore: z.boolean().optional(),
  truncatedAfter: z.boolean().optional(),
  previousTarget: z.string().optional(),
  nextTarget: z.string().optional(),
  internalLinks: z.array(internalLinkSchema).optional(),
  error: errorSchema.optional(),
  navigation: navigationSchema,
});

export function createMonoAgentDocsMcpServer(): McpServer {
  const server = new McpServer({ name: "mono-agent-docs", version: docsMcpPackageVersion() });
  server.registerTool(
    MONO_AGENT_DOCS_TOOL_NAME,
    {
      title: "Search and read mono-agent documentation",
      description: [
        "Primary version-matched reference for building and configuring mono-agent.",
        "First call {\"action\":\"search\",\"query\":\"...\"}; search returns 2-3k Markdown excerpts as a map.",
        "Then call {\"action\":\"read\",\"target\":\"<readTarget>\"} for an anchored window up to 10k characters.",
        "Follow internalLinks with action=read and continue long documents with the exact previousTarget/nextTarget actions in navigation.",
        "All retrieval and link resolution is offline and restricted to the version-matched v1 documentation corpus.",
      ].join(" "),
      inputSchema: docsInputSchema,
      outputSchema: docsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const index = await loadDefaultDocsSearchIndex();
      let result;
      if (input.action === "search") {
        if (input.query === undefined) throw new Error("mono_agent_docs action=search requires query.");
        result = await index.search({
          query: input.query,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
        });
      } else {
        if (input.target === undefined) throw new Error("mono_agent_docs action=read requires target.");
        result = index.read(input.target);
      }
      return {
        content: resultContent(result),
        structuredContent: result as unknown as Record<string, unknown>,
        ...(isErrorResult(result) ? { isError: true } : {}),
      };
    },
  );

  server.registerResource(
    "mono-agent-documentation-chunk",
    new ResourceTemplate("mono-agent-docs://chunk/{chunkId}", { list: undefined }),
    {
      title: "Expanded mono-agent documentation window",
      description: "A versioned chunk reference expanded to the same guided reading window returned by mono_agent_docs action=read.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const index = await loadDefaultDocsSearchIndex();
      const result = index.read(uri.href);
      if (isErrorResult(result)) throw new Error(result.error.message);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: formatReadResource(result) }],
      };
    },
  );
  return server;
}

function resultContent(
  result: MonoAgentDocsSearchResult | MonoAgentDocsReadResult | MonoAgentDocsErrorResult,
): Array<
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly uri: string; readonly name: string; readonly description: string; readonly mimeType: string }
> {
  if (isErrorResult(result)) {
    return [{
      type: "text",
      text: `${result.navigation.guidance}\n\n${result.error.code}: ${result.error.message}\n\n${navigationText(result.navigation)}`,
    }];
  }
  if (result.action === "read") {
    return [
      { type: "text", text: formatReadHeader(result) },
      { type: "text", text: result.markdown },
      ...(result.internalLinks.length === 0 ? [] : [{
        type: "text" as const,
        text: internalLinksText(result.internalLinks),
      }]),
    ];
  }
  return [
    {
      type: "text",
      text: [
        result.navigation.guidance,
        `Search: ${JSON.stringify(result.query)} (${result.retrievalMode}, docs ${result.docsVersion}, scope ${result.scope})`,
        navigationText(result.navigation),
      ].join("\n\n"),
    },
    ...result.results.flatMap((hit) => [
      { type: "text" as const, text: formatSearchHit(hit) },
      {
        type: "resource_link" as const,
        uri: hit.readTarget,
        name: `${hit.title}: ${hit.headingPath.join(" > ") || "Overview"}`,
        description: `Rank ${hit.rank}; read for an expanded anchored window from ${hit.path}`,
        mimeType: "text/markdown",
      },
    ]),
  ];
}

function formatSearchHit(hit: MonoAgentDocsSearchHit): string {
  const heading = hit.headingPath.length === 0 ? "Overview" : hit.headingPath.join(" > ");
  return [
    `## ${hit.rank}. ${hit.title}`,
    `Source: ${hit.path}`,
    `Heading: ${heading}`,
    `Read next: ${formatAction({ action: "read", target: hit.readTarget })}`,
    ...(hit.canonicalUrl === undefined ? [] : [`Canonical URL: ${hit.canonicalUrl}`]),
    "",
    hit.markdown,
    ...(hit.internalLinks.length === 0 ? [] : ["", internalLinksText(hit.internalLinks)]),
  ].join("\n");
}

function formatReadHeader(result: MonoAgentDocsReadResult): string {
  return [
    result.navigation.guidance,
    `Document: ${result.title}`,
    `Source: ${result.path}`,
    `Heading: ${result.headingPath.join(" > ") || "Overview"}`,
    ...(result.canonicalUrl === undefined ? [] : [`Canonical URL: ${result.canonicalUrl}`]),
    navigationText(result.navigation),
  ].join("\n\n");
}

function formatReadResource(result: MonoAgentDocsReadResult): string {
  return [
    `# ${result.title}`,
    `Source: ${result.path}`,
    `Heading: ${result.headingPath.join(" > ") || "Overview"}`,
    ...(result.canonicalUrl === undefined ? [] : [`Canonical URL: ${result.canonicalUrl}`]),
    "",
    result.navigation.guidance,
    navigationText(result.navigation),
    "",
    result.markdown,
    ...(result.internalLinks.length === 0 ? [] : ["", internalLinksText(result.internalLinks)]),
  ].join("\n");
}

function internalLinksText(links: readonly MonoAgentDocsInternalLink[]): string {
  return [
    "Internal links in this excerpt (follow with mono_agent_docs):",
    ...links.map((link) => `- ${link.label}: ${formatAction({ action: "read", target: link.readTarget })}`),
  ].join("\n");
}

function navigationText(navigation: MonoAgentDocsNavigation): string {
  if (navigation.nextActions.length === 0) return "Next: search for another concept or follow an internal link.";
  return [
    "Exact next actions:",
    ...navigation.nextActions.map((action) => `- ${action.description} ${formatAction(action.arguments)}`),
  ].join("\n");
}

function formatAction(input: object): string {
  return JSON.stringify(input);
}

function isErrorResult(
  result: MonoAgentDocsSearchResult | MonoAgentDocsReadResult | MonoAgentDocsErrorResult,
): result is MonoAgentDocsErrorResult {
  return "error" in result;
}
