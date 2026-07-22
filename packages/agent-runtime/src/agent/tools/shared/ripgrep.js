import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import {
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_FILES,
  DEFAULT_MAX_SEARCH_CHARS,
  DEFAULT_MAX_SEARCH_LINES,
} from "./constants.js";
import { boundedInt } from "./dedup.js";
import { writeToolArtifact } from "./output-truncation.js";
import { readToolRuntime } from "./runtime-context.js";

const requireFromHere = createRequire(import.meta.url);

// Lazy so the message respects whatever runtimeBrand the host configured.
export function ripgrepMissingMessage(ctx) {
  const brand = (ctx ?? readToolRuntime()).runtimeBrand;
  return `Error: ripgrep (rg) is not available. Configure ripgrepPath via configureToolRuntime() or install ripgrep on PATH; run \`${brand.doctorCommand}\` for details.`;
}

// Mutable cache of the resolved ripgrep binary path. Stored on an object so
// callers can read the latest value without re-importing the module.
//
// KNOWN cross-runtime sharing (pre-existing, out of scope for the per-instance
// ToolContext work): this cache is MODULE-LEVEL, not per-ToolContext. The first
// resolveRgPath call to resolve a non-undefined value wins process-wide, so two
// createRuntime instances configured with DIFFERENT ripgrepPath values share
// whichever binary was resolved first (a later instance's ripgrepPath is
// ignored unless it passes `{refresh: true}`). Unlike workspace/repoRoot/
// sandbox/brand — which are fully isolated per instance via ToolContext — the
// ripgrep binary path is effectively global. In practice every runtime in a
// process resolves the same vendored/PATH binary, so this is benign; it is
// documented (and asserted as a known-shared cache in the two-runtimes
// isolation test) rather than fixed, since a per-instance rg cache would be a
// larger change with no real-world payoff today.
export const cachedRgPath = { value: undefined };

function packagedRgPath() {
  try {
    // Resolve the platform package relative to @vscode/ripgrep itself. pnpm's
    // strict layout does not expose this optional transitive dependency from
    // agent-runtime, and importing the wrapper eagerly would throw when a
    // consumer intentionally installs with optional dependencies omitted.
    const wrapperEntry = requireFromHere.resolve("@vscode/ripgrep");
    const requireFromRipgrep = createRequire(wrapperEntry);
    const arch = process.env.npm_config_arch || process.arch;
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    const platformPackage = `@vscode/ripgrep-${process.platform}-${arch}`;
    const candidate = requireFromRipgrep.resolve(`${platformPackage}/bin/${binaryName}`);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function rgFromPath() {
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `rg${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {{refresh?: boolean, ctx?: any}} [options]
 */
export function resolveRgPath({ refresh = false, ctx } = {}) {
  if (!refresh && cachedRgPath.value !== undefined) return cachedRgPath.value;
  const { ripgrepPath } = ctx ?? readToolRuntime();
  if (ripgrepPath) {
    cachedRgPath.value = existsSync(ripgrepPath) ? ripgrepPath : null;
  } else {
    cachedRgPath.value = packagedRgPath() || rgFromPath() || null;
  }
  return cachedRgPath.value;
}

export function excludedGlobArgs() {
  const args = [];
  for (const dir of DEFAULT_EXCLUDED_DIRS) {
    args.push("--glob", `!${dir}/**`, "--glob", `!**/${dir}/**`);
  }
  for (const filePattern of DEFAULT_EXCLUDED_FILES) args.push("--glob", `!${filePattern}`);
  return args;
}

export function normalizeGlobPattern(pattern) {
  const raw = String(pattern || "**/*").trim().replace(/^\.\//, "");
  return raw || "**/*";
}

/**
 * @param {any} rawLines
 * @param {{label?: string, noMatches?: string, maxLines?: number, maxChars?: number, offset?: number, ctx?: any}} [options]
 */
export function formatSearchLines(rawLines, {
  label,
  noMatches,
  maxLines = DEFAULT_MAX_SEARCH_LINES,
  maxChars = DEFAULT_MAX_SEARCH_CHARS,
  offset = 0,
  ctx,
} = {}) {
  const lines = Array.isArray(rawLines) ? rawLines.filter(Boolean) : String(rawLines || "").trim().split("\n").filter(Boolean);
  if (!lines.length) return noMatches;
  const start = boundedInt(offset, 0, { min: 0 });
  const total = lines.length;
  const slice = lines.slice(start);
  const kept = [];
  let chars = 0;
  const lineLimit = boundedInt(maxLines, DEFAULT_MAX_SEARCH_LINES, { min: 1 });
  const charLimit = boundedInt(maxChars, DEFAULT_MAX_SEARCH_CHARS, { min: 200 });
  for (const line of slice) {
    if (kept.length >= lineLimit || chars + line.length + 1 > charLimit) break;
    kept.push(line);
    chars += line.length + 1;
  }
  if (kept.length === slice.length) return kept.join("\n");
  const fullText = lines.join("\n");
  const artifact = writeToolArtifact(label, fullText, ctx);
  const suffix = [
    `[truncated ${label || "search"} result: showing ${kept.length} of ${total} lines after excluding generated/vendor paths.`,
    start ? `Offset ${start} was applied.` : null,
    artifact ? `Full output saved to: ${artifact.path}` : null,
    "Use a narrower path, glob, or pattern for the full result.]",
  ].filter(Boolean).join(" ");
  return `${kept.join("\n")}\n\n${suffix}`;
}

/**
 * @param {string} text
 * @param {{label?: string, noMatches?: string, maxLines?: number, maxChars?: number, offset?: number, ctx?: any}} [options]
 */
export function capLines(text, {
  label,
  noMatches,
  maxLines = DEFAULT_MAX_SEARCH_LINES,
  maxChars = DEFAULT_MAX_SEARCH_CHARS,
  offset = 0,
  ctx,
} = {}) {
  return formatSearchLines(String(text || "").trim().split("\n").filter(Boolean), {
    label,
    noMatches,
    maxLines,
    maxChars,
    offset,
    ctx,
  });
}

export function excludedPathSummary() {
  return `Excluded directories: ${DEFAULT_EXCLUDED_DIRS.join(", ")}; excluded files: ${DEFAULT_EXCLUDED_FILES.join(", ")}.`;
}
