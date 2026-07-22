export type MonoAgentDocsScope = "all" | "docs";

export interface MonoAgentDocsSearchAction {
  readonly action: "search";
  readonly query: string;
  readonly limit?: number;
  readonly scope?: MonoAgentDocsScope;
}

export interface MonoAgentDocsReadAction {
  readonly action: "read";
  /**
   * A target returned by this MCP: a chunk URI, document continuation URI,
   * logical corpus path, docs route, or canonical documentation URL.
   */
  readonly target: string;
}

export type MonoAgentDocsInput = MonoAgentDocsSearchAction | MonoAgentDocsReadAction;

export interface MonoAgentDocsInternalLink {
  readonly label: string;
  readonly href: string;
  readonly readTarget: string;
}

export interface MonoAgentDocsNavigationAction {
  readonly kind: "next" | "previous" | "read" | "search";
  readonly description: string;
  readonly arguments: MonoAgentDocsInput;
}

export interface MonoAgentDocsNavigation {
  readonly guidance: string;
  readonly nextActions: readonly MonoAgentDocsNavigationAction[];
}

export interface MonoAgentDocsSearchHit {
  readonly rank: number;
  readonly chunkId: string;
  readonly readTarget: string;
  readonly source: "docs";
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly canonicalUrl?: string;
  readonly markdown: string;
  readonly truncatedBefore: boolean;
  readonly truncatedAfter: boolean;
  readonly internalLinks: readonly MonoAgentDocsInternalLink[];
}

export interface MonoAgentDocsSearchResult {
  readonly schema: "mono-agent.docs.v2";
  readonly action: "search";
  readonly docsVersion: string;
  readonly corpusDigest: string;
  readonly retrievalMode: "hybrid";
  readonly query: string;
  readonly scope: MonoAgentDocsScope;
  readonly results: readonly MonoAgentDocsSearchHit[];
  readonly navigation: MonoAgentDocsNavigation;
}

export interface MonoAgentDocsReadResult {
  readonly schema: "mono-agent.docs.v2";
  readonly action: "read";
  readonly docsVersion: string;
  readonly corpusDigest: string;
  readonly target: string;
  readonly source: "docs";
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly canonicalUrl?: string;
  readonly markdown: string;
  readonly truncatedBefore: boolean;
  readonly truncatedAfter: boolean;
  readonly previousTarget?: string;
  readonly nextTarget?: string;
  readonly internalLinks: readonly MonoAgentDocsInternalLink[];
  readonly navigation: MonoAgentDocsNavigation;
}

export type MonoAgentDocsErrorCode = "target_not_found" | "unsupported_target";

export interface MonoAgentDocsErrorResult {
  readonly schema: "mono-agent.docs.v2";
  readonly action: "read";
  readonly docsVersion: string;
  readonly corpusDigest: string;
  readonly target: string;
  readonly error: {
    readonly code: MonoAgentDocsErrorCode;
    readonly message: string;
  };
  readonly navigation: MonoAgentDocsNavigation;
}
