// @ts-check

import { posix } from "node:path";

/** @typedef {{ readonly indent: string; readonly marker: string; readonly trailing: string }} MarkdownFence */

/**
 * @param {readonly { readonly path: string; readonly route?: string }[]} documents
 * @returns {void}
 */
export function assertUniqueDocumentLocations(documents) {
  assertUniqueValues(documents, (document) => document.path, "document path");
  assertUniqueValues(
    documents.flatMap((document) => document.route === undefined ? [] : [document.route]),
    (route) => normalizeRoute(route),
    "document route",
  );
}

/**
 * @template T
 * @param {string} path
 * @param {ReadonlyMap<string, T>} documentsByPath
 * @returns {T | undefined}
 */
export function findDocumentByLogicalPath(path, documentsByPath) {
  const candidates = [
    path,
    `${path}.md`,
    `${path}.mdx`,
    posix.join(path, "index.md"),
    posix.join(path, "index.mdx"),
  ];
  return candidates.map((candidate) => documentsByPath.get(candidate)).find((candidate) => candidate !== undefined);
}

/**
 * @param {string} markdown
 * @returns {readonly { readonly label: string; readonly href: string }[]}
 */
export function markdownLinks(markdown) {
  /** @type {Array<{ readonly label: string; readonly href: string }>} */
  const links = [];
  /** @type {string | undefined} */
  let fenceMarker;
  for (const line of markdown.split("\n")) {
    const fence = markdownFence(line);
    if (fenceMarker !== undefined) {
      if (fence !== undefined && closesFence(fence, fenceMarker)) {
        fenceMarker = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      fenceMarker = fence.marker;
      continue;
    }
    const pattern = /(?<!!)\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gu;
    for (const match of line.matchAll(pattern)) {
      const label = match[1];
      const href = match[2];
      if (label !== undefined && href !== undefined) links.push({ label, href });
    }
  }
  return links;
}

/**
 * @param {string} markdown
 * @param {number} startOffset
 * @param {number} endOffset
 * @returns {string}
 */
export function balanceFences(markdown, startOffset, endOffset) {
  const openingAtStart = activeFence(markdown, startOffset);
  /** @type {string | undefined} */
  let openingMarker = openingAtStart?.marker;
  const lines = markdown.slice(startOffset, endOffset).split("\n");
  const startsAtLineBoundary = startOffset === 0 || markdown[startOffset - 1] === "\n";
  const endsAtLineBoundary = endOffset === markdown.length || markdown[endOffset - 1] === "\n";
  /** @type {string | undefined} */
  let renderMarker = openingMarker === undefined
    ? undefined
    : safeSyntheticFence(lines, 0, openingMarker, "", startsAtLineBoundary, endsAtLineBoundary);
  /** @type {string[]} */
  const output = renderMarker === undefined ? [] : [renderMarker];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isCompleteLine = completeSliceLine(index, lines.length, startsAtLineBoundary, endsAtLineBoundary);
    const fence = isCompleteLine ? markdownFence(line) : undefined;
    if (openingMarker === undefined) {
      if (fence === undefined) {
        output.push(line);
      } else {
        openingMarker = fence.marker;
        renderMarker = safeSyntheticFence(
          lines,
          index + 1,
          openingMarker,
          fence.trailing,
          startsAtLineBoundary,
          endsAtLineBoundary,
        );
        output.push(`${fence.indent}${renderMarker}${fence.trailing}`);
      }
      continue;
    }
    if (fence !== undefined && closesFence(fence, openingMarker)) {
      output.push(`${fence.indent}${renderMarker ?? syntheticFence(openingMarker)}`);
      openingMarker = undefined;
      renderMarker = undefined;
    } else {
      output.push(line);
    }
  }
  if (openingMarker !== undefined) output.push(renderMarker ?? syntheticFence(openingMarker));
  return output.join("\n");
}

/**
 * @param {string} route
 * @returns {string}
 */
export function normalizeRoute(route) {
  const decoded = safeDecode(route).replace(/\/{2,}/gu, "/");
  const withoutIndex = decoded.replace(/\/index(?:\.html)?\/?$/u, "/");
  return withoutIndex === "/" ? "/" : `/${withoutIndex.replace(/^\/+|\/+$/gu, "")}/`;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * @template T
 * @param {readonly T[]} records
 * @param {(record: T) => string} keyFor
 * @param {string} kind
 * @returns {void}
 */
function assertUniqueValues(records, keyFor, kind) {
  const keys = new Set();
  for (const record of records) {
    const key = keyFor(record);
    if (keys.has(key)) {
      throw new Error(`Documentation corpus contains duplicate ${kind} ${key}.`);
    }
    keys.add(key);
  }
}

/**
 * @param {string} markdown
 * @param {number} offset
 * @returns {{ readonly marker: string } | undefined}
 */
function activeFence(markdown, offset) {
  /** @type {{ readonly marker: string } | undefined} */
  let active;
  const prefix = markdown.slice(0, offset);
  const lines = prefix.split("\n");
  const completeLineCount = offset === markdown.length || markdown[offset - 1] === "\n"
    ? lines.length
    : lines.length - 1;
  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index] ?? "";
    const fence = markdownFence(line);
    if (fence === undefined) continue;
    if (active === undefined) active = { marker: fence.marker };
    else if (closesFence(fence, active.marker)) active = undefined;
  }
  return active;
}

/**
 * @param {string} line
 * @returns {MarkdownFence | undefined}
 */
function markdownFence(line) {
  const match = /^(\s{0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  const marker = match?.[2];
  return marker === undefined
    ? undefined
    : { indent: match?.[1] ?? "", marker, trailing: match?.[3] ?? "" };
}

/**
 * @param {{ readonly marker: string; readonly trailing: string }} candidate
 * @param {string} openingMarker
 * @returns {boolean}
 */
function closesFence(candidate, openingMarker) {
  return candidate.marker[0] === openingMarker[0]
    && candidate.marker.length >= openingMarker.length
    && candidate.trailing.trim().length === 0;
}

/**
 * Select a delimiter that cannot be closed by any complete content line in the
 * visible part of this source fence. The content itself remains byte-for-byte
 * unchanged; only the excerpt's synthetic wrapper may use another marker.
 *
 * @param {readonly string[]} lines
 * @param {number} startIndex
 * @param {string} openingMarker
 * @param {string} openingTrailing
 * @param {boolean} startsAtLineBoundary
 * @param {boolean} endsAtLineBoundary
 * @returns {string}
 */
function safeSyntheticFence(
  lines,
  startIndex,
  openingMarker,
  openingTrailing,
  startsAtLineBoundary,
  endsAtLineBoundary,
) {
  let longestBacktick = 2;
  let longestTilde = 2;
  for (let index = startIndex; index < lines.length; index += 1) {
    const fence = markdownFence(lines[index] ?? "");
    if (fence === undefined) continue;
    const isCompleteLine = completeSliceLine(index, lines.length, startsAtLineBoundary, endsAtLineBoundary);
    if (isCompleteLine && closesFence(fence, openingMarker)) break;
    if (fence.trailing.trim().length !== 0) continue;
    if (fence.marker[0] === "`") longestBacktick = Math.max(longestBacktick, fence.marker.length);
    else longestTilde = Math.max(longestTilde, fence.marker.length);
  }

  const backtick = "`".repeat(longestBacktick + 1);
  const tilde = "~".repeat(longestTilde + 1);
  if (openingTrailing.includes("`")) return tilde;
  if (backtick.length < tilde.length) return backtick;
  if (tilde.length < backtick.length) return tilde;
  return openingMarker[0] === "~" ? tilde : backtick;
}

/**
 * @param {number} index
 * @param {number} lineCount
 * @param {boolean} startsAtLineBoundary
 * @param {boolean} endsAtLineBoundary
 * @returns {boolean}
 */
function completeSliceLine(index, lineCount, startsAtLineBoundary, endsAtLineBoundary) {
  return (index > 0 || startsAtLineBoundary)
    && (index < lineCount - 1 || endsAtLineBoundary);
}

/**
 * @param {string} marker
 * @returns {string}
 */
function syntheticFence(marker) {
  return marker.charAt(0).repeat(3);
}
