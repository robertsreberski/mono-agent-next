import { posix } from "node:path";

/**
 * @param {readonly { readonly path: string; readonly route?: string }[]} documents
 * @returns {void}
 */
export function assertUniqueDocumentLocations(documents) {
  assertUniqueValues(documents, (document) => document.path, "document path");
  assertUniqueValues(
    documents.filter((document) => document.route !== undefined),
    (document) => normalizeRoute(document.route),
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
  const links = [];
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
      links.push({ label: match[1], href: match[2] });
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
  const openingAtEnd = activeFence(markdown, endOffset);
  const prefix = openingAtStart === undefined
    ? ""
    : `${syntheticFence(openingAtStart)}\n`;
  const suffix = openingAtEnd === undefined
    ? ""
    : `\n${syntheticFence(openingAtEnd)}`;
  return `${prefix}${markdown.slice(startOffset, endOffset)}${suffix}`;
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
 * @returns {{ readonly line: string; readonly marker: string } | undefined}
 */
function activeFence(markdown, offset) {
  let active;
  for (const line of markdown.slice(0, offset).split("\n")) {
    const fence = markdownFence(line);
    if (fence === undefined) continue;
    if (active === undefined) active = { marker: fence.marker };
    else if (closesFence(fence, active.marker)) active = undefined;
  }
  return active;
}

/**
 * @param {string} line
 * @returns {{ readonly marker: string; readonly trailing: string } | undefined}
 */
function markdownFence(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  return match === null ? undefined : { marker: match[1], trailing: match[2] };
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
 * @param {{ readonly marker: string }} fence
 * @returns {string}
 */
function syntheticFence(fence) {
  return fence.marker.charAt(0).repeat(3);
}
