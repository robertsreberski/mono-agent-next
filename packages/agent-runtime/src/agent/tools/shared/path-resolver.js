import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readToolRuntime } from "./runtime-context.js";
import { resolveSandboxPolicy } from "./tool-context.js";

// Every read here falls back to the module-default context when no per-instance
// ToolContext is threaded (`ctx ?? readToolRuntime()`), so hosts that only call
// the deep-path configureToolRuntime keep their historical behavior.
function configured(ctx) {
  const { workspace, repoRoot } = ctx ?? readToolRuntime();
  return { workspace, repoRoot };
}

export function workspaceRoot(workdir, ctx) {
  const { workspace, repoRoot } = configured(ctx);
  return resolve(workdir || workspace || repoRoot || process.cwd());
}

export function resolveToolPath(path, workdir, ctx) {
  if (!path || typeof path !== "string") return path;
  return resolve(isAbsolute(path) ? path : resolve(workspaceRoot(workdir, ctx), path));
}

export function isPathAllowed(path, workdir, options = {}) {
  return isPathAllowedFor(path, workdir, "read", options);
}

export function isWritablePathAllowed(path, workdir, options = {}) {
  return isPathAllowedFor(path, workdir, "write", options);
}

function isPathAllowedFor(path, workdir, access, options) {
  const ctx = options.ctx;
  const r = resolveToolPath(path, workdir, ctx);
  const policy = resolveSandboxPolicy(ctx ?? readToolRuntime(), options.sandboxPolicy);
  if (policy) {
    const field = access === "write" ? policy.writableRoots : policy.readableRoots;
    return insideSandboxRoots(Array.isArray(field) ? field : [], r)
      && (access !== "write" || !sandboxDeniesWrite(policy, r, ctx));
  }
  const { workspace, repoRoot } = configured(ctx);
  return insideLegacyRoots([workdir, workspace, repoRoot, process.cwd(), "/tmp"], r);
}

export function isWorkdirAllowed(workdir, options = {}) {
  if (!workdir) return true;
  const ctx = options.ctx;
  const r = resolve(workdir);
  const policy = resolveSandboxPolicy(ctx ?? readToolRuntime(), options.sandboxPolicy);
  if (policy) {
    return insideSandboxRoots(Array.isArray(policy.readableRoots) ? policy.readableRoots : [], r);
  }
  const { workspace, repoRoot } = configured(ctx);
  return insideLegacyRoots([workspace, repoRoot, process.cwd(), "/tmp"], r);
}

// Sandbox roots also enforce realpath containment so a symlink inside an
// allowed root cannot escape to a target outside the policy.
function insideSandboxRoots(roots, target) {
  const allowedRoots = normalizeRoots(roots);
  const real = realTargetPath(target);
  return allowedRoots.some((root) => isInsidePath(root, target))
    && allowedRoots.some((root) => isInsidePath(root, real));
}

// Without a sandbox policy, keep the historical literal containment check —
// symlinks out of the workspace (npm link et al.) stay usable by default.
function insideLegacyRoots(roots, target) {
  const allowedRoots = [...new Set(roots.filter(Boolean).map((p) => resolve(p)))];
  return allowedRoots.some((root) => isInsidePath(root, target));
}

function normalizeRoots(paths) {
  const out = new Set();
  for (const path of paths.filter(Boolean)) {
    const resolved = resolve(path);
    out.add(resolved);
    out.add(realTargetPath(resolved));
  }
  return [...out];
}

export function isInsidePath(root, target) {
  if (!root || !target) return false;
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realTargetPath(target) {
  const resolved = resolve(target);
  if (existsSync(resolved)) {
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  let current = dirname(resolved);
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      try { return resolve(realpathSync(current), relative(current, resolved)); } catch { return resolved; }
    }
    current = dirname(current);
  }
  return resolved;
}

function sandboxDeniesWrite(policy, target, ctx) {
  const patterns = Array.isArray(policy.denyWrite) ? policy.denyWrite : [];
  if (patterns.length === 0) return false;
  const candidates = [...new Set([resolve(target), realTargetPath(target)])];
  return candidates.some((candidate) =>
    patterns.some((pattern) => denyWritePatternMatches(policy, pattern, candidate, ctx)));
}

function denyWritePatternMatches(policy, pattern, target, ctx) {
  if (!pattern || typeof pattern !== "string") return false;
  const normalizedPattern = normalizeMatchPath(pattern);
  if (isAbsolute(pattern)) {
    return globPatternMatches(normalizedPattern, normalizeMatchPath(target));
  }
  const root = resolve(policy.root || workspaceRoot(undefined, ctx));
  const rel = relative(root, resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return globPatternMatches(stripDotSlash(normalizedPattern), normalizeMatchPath(rel));
}

function normalizeMatchPath(path) {
  return path.replaceAll("\\", "/");
}

function stripDotSlash(path) {
  let out = path;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function globPatternMatches(pattern, target) {
  return globPatternToRegExp(pattern).test(target);
}

function globPatternToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExp(char) {
  return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
}
