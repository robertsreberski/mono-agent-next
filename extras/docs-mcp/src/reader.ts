// SPDX-License-Identifier: MIT
import { posix } from "node:path";

import type { DocsCorpus, DocsCorpusChunk, DocsCorpusDocument, DocsCorpusHeading } from "./corpus.js";
import {
  balanceFences,
  findDocumentByLogicalPath,
  markdownLinks,
  normalizeRoute,
  safeDecode,
} from "./markdown-helpers.js";
import type {
  MonoAgentDocsErrorCode,
  MonoAgentDocsErrorResult,
  MonoAgentDocsInternalLink,
  MonoAgentDocsNavigation,
  MonoAgentDocsReadResult,
  MonoAgentDocsSearchHit,
} from "./types.js";

export const MONO_AGENT_DOCS_CHUNK_URI_PREFIX = "mono-agent-docs://chunk/";

const DOCS_ORIGIN = "https://mono-agent-docs.vercel.app";
const SEARCH_MARKDOWN_LIMIT = 3_000;
const READ_MARKDOWN_LIMIT = 10_000;
const FENCE_BALANCE_RESERVE = 200;

interface WindowRequest {
  readonly mode: "backward" | "center" | "forward";
  readonly startOffset: number;
  readonly endOffset: number;
  readonly limit: number;
}

interface MarkdownWindow {
  readonly markdown: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly truncatedBefore: boolean;
  readonly truncatedAfter: boolean;
}

interface ResolvedTarget {
  readonly document: DocsCorpusDocument;
  readonly headingPath: readonly string[];
  readonly anchor?: string;
  readonly request: WindowRequest;
}

export class MonoAgentDocsReader {
  readonly #corpus: DocsCorpus;

  constructor(corpus: DocsCorpus) {
    this.#corpus = corpus;
  }

  searchHit(chunk: DocsCorpusChunk, rank: number): MonoAgentDocsSearchHit {
    const document = this.#corpus.documentsById.get(chunk.documentId);
    if (document === undefined) throw new Error(`Unknown documentation document ${chunk.documentId}.`);
    const window = markdownWindow(document, {
      mode: "center",
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      limit: SEARCH_MARKDOWN_LIMIT,
    });
    const hitCanonicalUrl = canonicalUrl(document, chunk.anchor);
    return {
      rank,
      chunkId: chunk.id,
      readTarget: `${MONO_AGENT_DOCS_CHUNK_URI_PREFIX}${chunk.id}`,
      source: chunk.source,
      path: chunk.path,
      title: chunk.title,
      headingPath: chunk.headingPath,
      ...(hitCanonicalUrl === undefined ? {} : { canonicalUrl: hitCanonicalUrl }),
      markdown: window.markdown,
      truncatedBefore: window.truncatedBefore,
      truncatedAfter: window.truncatedAfter,
      internalLinks: this.internalLinks(document, window.markdown),
    };
  }

  read(target: string): MonoAgentDocsReadResult | MonoAgentDocsErrorResult {
    let resolved: ResolvedTarget;
    let window: MarkdownWindow;
    try {
      resolved = this.resolveTarget(target);
      window = markdownWindow(resolved.document, resolved.request);
    } catch (error) {
      if (error instanceof DocsTargetError) return this.errorResult(target, error.code, error.message);
      if (error instanceof DocsWindowError) return this.errorResult(target, "target_not_found", error.message);
      throw error;
    }
    const previousTarget = window.truncatedBefore
      ? documentTarget(resolved.document.id, "end", window.startOffset)
      : undefined;
    const nextTarget = window.truncatedAfter
      ? documentTarget(resolved.document.id, "start", window.endOffset)
      : undefined;
    const readCanonicalUrl = canonicalUrl(resolved.document, resolved.anchor);
    const navigationActions: MonoAgentDocsNavigation["nextActions"] = [
      ...(previousTarget === undefined ? [] : [{
        kind: "previous" as const,
        description: "Read the immediately preceding non-overlapping window in this document.",
        arguments: { action: "read" as const, target: previousTarget },
      }]),
      ...(nextTarget === undefined ? [] : [{
        kind: "next" as const,
        description: "Continue with the immediately following non-overlapping window in this document.",
        arguments: { action: "read" as const, target: nextTarget },
      }]),
    ];
    return {
      schema: "mono-agent.docs.v2",
      action: "read",
      docsVersion: this.#corpus.manifest.docsVersion,
      corpusDigest: this.#corpus.manifest.corpusDigest,
      target,
      source: resolved.document.source,
      path: resolved.document.path,
      title: resolved.document.title,
      headingPath: resolved.headingPath,
      ...(readCanonicalUrl === undefined ? {} : { canonicalUrl: readCanonicalUrl }),
      markdown: window.markdown,
      truncatedBefore: window.truncatedBefore,
      truncatedAfter: window.truncatedAfter,
      ...(previousTarget === undefined ? {} : { previousTarget }),
      ...(nextTarget === undefined ? {} : { nextTarget }),
      internalLinks: this.internalLinks(resolved.document, window.markdown),
      navigation: {
        guidance: navigationActions.length === 0
          ? "This is the complete document window. Follow any internalLinks with action=read, or use action=search for another concept."
          : "Expanded documentation window. Use the exact previous/next action to continue without overlap; follow internalLinks with action=read.",
        nextActions: navigationActions,
      },
    };
  }

  private resolveTarget(rawTarget: string): ResolvedTarget {
    const target = rawTarget.trim();
    if (target.length === 0 || target.length > 2_000) {
      throw new DocsTargetError("unsupported_target", "Documentation read target must contain between 1 and 2,000 characters.");
    }

    const chunkMatch = /^mono-agent-docs:\/\/chunk\/([a-f0-9]{64})$/u.exec(target);
    if (chunkMatch !== null) return this.resolveChunk(chunkMatch[1]!);
    if (/^[a-f0-9]{64}$/u.test(target)) return this.resolveChunk(target);

    const continuationMatch = /^mono-agent-docs:\/\/document\/([a-f0-9]{64})\?(start|end)=(\d+)$/u.exec(target);
    if (continuationMatch !== null) {
      const document = this.#corpus.documentsById.get(continuationMatch[1]!);
      if (document === undefined) {
        throw new DocsTargetError("target_not_found", `Unknown mono-agent documentation document ${continuationMatch[1]}.`);
      }
      const offset = Number(continuationMatch[3]);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > document.markdown.length) {
        throw new DocsTargetError("target_not_found", `Continuation offset ${continuationMatch[3]} is outside ${document.path}.`);
      }
      const mode = continuationMatch[2] === "start" ? "forward" : "backward";
      const heading = headingAt(document, offset === document.markdown.length ? Math.max(0, offset - 1) : offset);
      return {
        document,
        headingPath: heading?.headingPath ?? [],
        ...(heading === undefined ? {} : { anchor: heading.anchor }),
        request: { mode, startOffset: offset, endOffset: offset, limit: READ_MARKDOWN_LIMIT },
      };
    }

    if (target.startsWith("mono-agent-docs://")) {
      throw new DocsTargetError(
        "unsupported_target",
        "Unsupported mono-agent-docs URI. Use a chunk URI or continuation target returned by this tool.",
      );
    }

    let pathAndFragment = target;
    if (/^https?:\/\//u.test(target)) {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        throw new DocsTargetError("unsupported_target", `Unsupported documentation URL ${target}.`);
      }
      if (url.origin !== DOCS_ORIGIN) {
        throw new DocsTargetError("unsupported_target", "Only canonical mono-agent documentation URLs can be read offline.");
      }
      pathAndFragment = `${url.pathname}${url.hash}`;
    } else if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
      throw new DocsTargetError("unsupported_target", `Unsupported documentation target scheme in ${target}.`);
    }

    const hashAt = pathAndFragment.indexOf("#");
    const rawPath = hashAt === -1 ? pathAndFragment : pathAndFragment.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : safeDecode(pathAndFragment.slice(hashAt + 1));
    const document = rawPath.startsWith("/")
      ? this.#corpus.documentsByRoute.get(normalizeRoute(rawPath))
      : findDocumentByLogicalPath(safeDecode(rawPath), this.#corpus.documentsByPath);
    if (document === undefined) {
      throw new DocsTargetError("target_not_found", `No version-matched mono-agent document matches ${rawPath || target}.`);
    }
    const heading = fragment.length === 0
      ? undefined
      : document.headings.find((candidate) => candidate.anchor === fragment);
    if (fragment.length > 0 && heading === undefined) {
      throw new DocsTargetError("target_not_found", `No heading #${fragment} exists in ${document.path}.`);
    }
    return {
      document,
      headingPath: heading?.headingPath ?? [],
      ...(heading === undefined ? {} : { anchor: heading.anchor }),
      request: {
        mode: "forward",
        startOffset: heading?.startOffset ?? 0,
        endOffset: heading?.startOffset ?? 0,
        limit: READ_MARKDOWN_LIMIT,
      },
    };
  }

  private resolveChunk(chunkId: string): ResolvedTarget {
    const chunk = this.#corpus.chunksById.get(chunkId);
    if (chunk === undefined) {
      throw new DocsTargetError("target_not_found", `Unknown mono-agent documentation chunk ${chunkId}.`);
    }
    const document = this.#corpus.documentsById.get(chunk.documentId);
    if (document === undefined) throw new Error(`Unknown documentation document ${chunk.documentId}.`);
    return {
      document,
      headingPath: chunk.headingPath,
      ...(chunk.anchor === undefined ? {} : { anchor: chunk.anchor }),
      request: {
        mode: "center",
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        limit: READ_MARKDOWN_LIMIT,
      },
    };
  }

  private internalLinks(source: DocsCorpusDocument, markdown: string): readonly MonoAgentDocsInternalLink[] {
    const links: MonoAgentDocsInternalLink[] = [];
    const seen = new Set<string>();
    for (const link of markdownLinks(markdown)) {
      const target = this.resolveInternalLink(source, link.href);
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      links.push({ label: link.label, href: link.href, readTarget: target });
    }
    return links;
  }

  private resolveInternalLink(source: DocsCorpusDocument, href: string): string | undefined {
    const hashAt = href.indexOf("#");
    const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : safeDecode(href.slice(hashAt + 1));
    let target: DocsCorpusDocument | undefined;
    if (rawPath.length === 0) {
      target = source;
    } else if (/^https?:\/\//u.test(rawPath)) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return undefined;
      }
      if (url.origin !== DOCS_ORIGIN) return undefined;
      target = this.#corpus.documentsByRoute.get(normalizeRoute(url.pathname));
    } else if (/^[a-z][a-z0-9+.-]*:/iu.test(rawPath)) {
      return undefined;
    } else if (rawPath.startsWith("/")) {
      target = this.#corpus.documentsByRoute.get(normalizeRoute(rawPath));
    } else {
      const logicalPath = posix.normalize(posix.join(posix.dirname(source.path), safeDecode(rawPath)));
      target = findDocumentByLogicalPath(logicalPath, this.#corpus.documentsByPath);
      if (target === undefined && source.route !== undefined) {
        const url = new URL(rawPath, new URL(source.route, `${DOCS_ORIGIN}/`));
        target = this.#corpus.documentsByRoute.get(normalizeRoute(url.pathname));
      }
    }
    if (target === undefined) return undefined;
    if (fragment.length > 0 && !target.headings.some((heading) => heading.anchor === fragment)) return undefined;
    return `${target.path}${fragment.length === 0 ? "" : `#${fragment}`}`;
  }

  private errorResult(target: string, code: MonoAgentDocsErrorCode, message: string): MonoAgentDocsErrorResult {
    return {
      schema: "mono-agent.docs.v2",
      action: "read",
      docsVersion: this.#corpus.manifest.docsVersion,
      corpusDigest: this.#corpus.manifest.corpusDigest,
      target,
      error: { code, message },
      navigation: {
        guidance: "This target cannot be read from the version-matched offline corpus. Search for the concept, then read a returned readTarget exactly.",
        nextActions: [{
          kind: "search",
          description: "Find a valid version-matched document target.",
          arguments: { action: "search", query: target.slice(0, 500) || "mono-agent configuration" },
        }],
      },
    };
  }
}

class DocsTargetError extends Error {
  constructor(readonly code: MonoAgentDocsErrorCode, message: string) {
    super(message);
    this.name = "DocsTargetError";
  }
}

class DocsWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsWindowError";
  }
}

function markdownWindow(document: DocsCorpusDocument, request: WindowRequest): MarkdownWindow {
  const markdown = document.markdown;
  const contentLimit = request.limit - FENCE_BALANCE_RESERVE;
  let startOffset: number;
  let endOffset: number;
  if (request.mode === "forward") {
    startOffset = clamp(request.startOffset, 0, markdown.length);
    endOffset = preferredEnd(markdown, startOffset, Math.min(markdown.length, startOffset + contentLimit));
  } else if (request.mode === "backward") {
    endOffset = clamp(request.endOffset, 0, markdown.length);
    startOffset = preferredStart(markdown, Math.max(0, endOffset - contentLimit), endOffset);
  } else {
    const focusStart = clamp(request.startOffset, 0, markdown.length);
    const focusEnd = clamp(Math.max(request.endOffset, focusStart), focusStart, markdown.length);
    const contextBefore = Math.max(0, Math.floor((contentLimit - Math.min(contentLimit, focusEnd - focusStart)) / 3));
    startOffset = preferredStart(markdown, Math.max(0, focusStart - contextBefore), focusStart);
    endOffset = preferredEnd(markdown, startOffset, Math.min(markdown.length, startOffset + contentLimit));
    if (endOffset < focusEnd) {
      endOffset = preferredEnd(markdown, focusEnd, Math.min(markdown.length, focusEnd + 1_000));
      startOffset = preferredStart(markdown, Math.max(0, endOffset - contentLimit), focusStart);
    }
  }
  if (startOffset === endOffset && markdown.length > 0) {
    if (startOffset === markdown.length) startOffset = preferredStart(markdown, Math.max(0, startOffset - contentLimit), startOffset);
    else endOffset = preferredEnd(markdown, startOffset, Math.min(markdown.length, startOffset + contentLimit));
  }
  let balanced = balanceFences(markdown, startOffset, endOffset).trim();
  for (let attempt = 0; balanced.length > request.limit && attempt < 4; attempt += 1) {
    const excess = balanced.length - request.limit + 16;
    const trimFromStart = request.mode === "backward"
      || (request.mode === "center"
        && (request.startOffset - startOffset) > (endOffset - request.endOffset));
    if (trimFromStart) {
      const nextStart = nextLineStart(markdown, Math.min(endOffset, startOffset + excess));
      startOffset = nextStart >= endOffset
        ? Math.min(endOffset - 1, startOffset + excess)
        : nextStart;
    } else {
      const previousEnd = previousLineEnd(markdown, Math.max(startOffset, endOffset - excess));
      endOffset = previousEnd <= startOffset
        ? Math.max(startOffset + 1, endOffset - excess)
        : previousEnd;
    }
    balanced = balanceFences(markdown, startOffset, endOffset).trim();
  }
  if (balanced.length > request.limit || endOffset <= startOffset) {
    throw new DocsWindowError(`Documentation window could not fit within its ${request.limit}-character limit.`);
  }
  return {
    markdown: balanced,
    startOffset,
    endOffset,
    truncatedBefore: startOffset > 0,
    truncatedAfter: endOffset < markdown.length,
  };
}

function preferredStart(markdown: string, desired: number, maximum: number): number {
  if (desired <= 0) return 0;
  const paragraph = markdown.lastIndexOf("\n\n", desired);
  if (paragraph >= Math.max(0, desired - 400)) return Math.min(maximum, paragraph + 2);
  const line = markdown.lastIndexOf("\n", desired);
  return line === -1 ? 0 : Math.min(maximum, line + 1);
}

function preferredEnd(markdown: string, minimum: number, desired: number): number {
  if (desired >= markdown.length) return markdown.length;
  const paragraph = markdown.lastIndexOf("\n\n", desired);
  if (paragraph > Math.max(minimum, desired - 400)) return paragraph + 2;
  const line = markdown.lastIndexOf("\n", desired);
  return line <= minimum ? desired : line + 1;
}

function nextLineStart(markdown: string, offset: number): number {
  const newline = markdown.indexOf("\n", offset);
  return newline === -1 ? markdown.length : newline + 1;
}

function previousLineEnd(markdown: string, offset: number): number {
  const newline = markdown.lastIndexOf("\n", offset);
  return newline === -1 ? 0 : newline + 1;
}

function headingAt(document: DocsCorpusDocument, offset: number): DocsCorpusHeading | undefined {
  return [...document.headings]
    .reverse()
    .find((heading) => heading.level >= 2 && heading.startOffset <= offset);
}

function canonicalUrl(document: DocsCorpusDocument, anchor?: string): string | undefined {
  if (document.canonicalUrl === undefined) return undefined;
  return `${document.canonicalUrl}${anchor === undefined ? "" : `#${anchor}`}`;
}

function documentTarget(documentId: string, direction: "end" | "start", offset: number): string {
  return `mono-agent-docs://document/${documentId}?${direction}=${offset}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
