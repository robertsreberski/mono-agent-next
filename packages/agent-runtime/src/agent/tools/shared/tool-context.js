// Per-runtime-instance tool context.
//
// A ToolContext carries the configuration the kernel's internal tool helpers
// (output-truncation, ripgrep, path-resolver, pi-bridge, the tool impls) need
// to resolve workdirs, artifact paths, the ripgrep binary, sandbox policy, and
// host-specific brand strings. `createRuntime` builds ONE context per runtime
// instance and threads it to every bridge via `options.toolContext`; tools read
// from it instead of a process-global. This replaces the former one-per-process
// singleton (see runtime-context.js) that clobbered its fields when a
// long-lived host created more than one runtime.
//
// This module is pure: it owns no module-level state. The default/back-compat
// singleton lives in runtime-context.js, which builds its own ToolContext with
// createToolContext and mutates it with updateToolContext. Every internal read
// site falls back to that default via `ctx ?? readToolRuntime()`.
//
// Recognized keys:
//   workspace        — fallback for tool workdir resolution. Default: process.cwd().
//   repoRoot         — secondary allowed root (the host's installation root).
//                      Tool path-allowlist checks accept this in addition to workspace.
//   runId            — used as the subdirectory under toolArtifactDir for tool output.
//   toolArtifactDir  — root for {dir}/tool-output/{runId}/{file} artifact writes
//                      from capChars/formatSearchLines. Null = no persistence.
//   ripgrepPath      — absolute path to the ripgrep binary. When unset, falls
//                      back to vendored binary, then PATH lookup.
//   qaOutputDir      — fallback for normalizeMcpToolParams when the per-call
//                      runArtifactDir isn't supplied.
//   sandboxPolicy    — optional strict filesystem/process/network sandbox policy.
//   sandboxEngine    — optional concrete engine handed to the injected sandbox
//                      implementation when it prepares subprocess commands.
//   sandbox          — RuntimeSandbox implementation the policy is enforced
//                      through (see ../../sandbox-seam.js). Always resolved,
//                      like runtimeBrand: defaults to passthroughSandbox when
//                      a host doesn't inject a real one.
//   runtimeBrand     — resolved RuntimeBrand object (see runtime-brand.js).
//                      Internal helpers read it to stamp host-specific names
//                      (MCP client name, transcript schema id, doctor command).

// @ts-check

import { passthroughSandbox } from "../../sandbox-seam.js";
import { DEFAULT_RUNTIME_BRAND, resolveRuntimeBrand } from "../../../runtime-brand.js";

/** @typedef {import('../../../runtime-brand.js').RuntimeBrand} RuntimeBrand */
/** @typedef {import('../../sandbox-seam.js').SandboxPolicy} SandboxPolicy */
/** @typedef {import('../../sandbox-seam.js').RuntimeSandboxEngine} RuntimeSandboxEngine */
/** @typedef {import('../../sandbox-seam.js').RuntimeSandbox} RuntimeSandbox */

/**
 * @typedef {Object} ToolContext
 * @property {string} [workspace]
 * @property {string} [repoRoot]
 * @property {string} [runId]
 * @property {string} [toolArtifactDir]
 * @property {string} [ripgrepPath]
 * @property {string} [qaOutputDir]
 * @property {SandboxPolicy} [sandboxPolicy]
 * @property {RuntimeSandboxEngine} [sandboxEngine]
 * @property {RuntimeSandbox} sandbox
 * @property {RuntimeBrand} runtimeBrand
 */

// The data keys (everything except the always-resolved runtimeBrand). A fixed
// list — not `Object.keys(ctx)` — so an unknown key on `next` is ignored, matching
// the historical configureToolRuntime contract.
const TOOL_CONTEXT_KEYS = /** @type {const} */ ([
  "workspace",
  "repoRoot",
  "runId",
  "toolArtifactDir",
  "ripgrepPath",
  "qaOutputDir",
  "sandboxPolicy",
  "sandboxEngine",
]);

/**
 * Build a fresh ToolContext from a partial input. `runtimeBrand` is always
 * resolved (to the defaults when absent); the remaining keys default to
 * undefined and are copied from `input` when present.
 * @param {Partial<ToolContext>} [input]
 * @returns {ToolContext}
 */
export function createToolContext(input = {}) {
  /** @type {ToolContext} */
  const ctx = {
    workspace: undefined,
    repoRoot: undefined,
    runId: undefined,
    toolArtifactDir: undefined,
    ripgrepPath: undefined,
    qaOutputDir: undefined,
    sandboxPolicy: undefined,
    sandboxEngine: undefined,
    sandbox: passthroughSandbox,
    runtimeBrand: { ...DEFAULT_RUNTIME_BRAND },
  };
  return updateToolContext(ctx, input);
}

/**
 * Mutate an existing ToolContext in place with the keys present on `next`,
 * leaving untouched keys as-is. Mutating in place (rather than returning a
 * copy) is deliberate: `createRuntime` threads a single context object to its
 * bridges and `configureTools` updates that same reference so subsequent runs
 * observe the change — the instance-scoped equivalent of the old global
 * configureToolRuntime.
 * @param {ToolContext} ctx
 * @param {Partial<ToolContext>} [next]
 * @returns {ToolContext}
 */
export function updateToolContext(ctx, next = {}) {
  for (const key of TOOL_CONTEXT_KEYS) {
    // Per-key assignment across a heterogeneous record: TS can't correlate the
    // looked-up value type with `key` across two independent indexed accesses
    // (a known structural limitation, not a real type hazard here).
    if (key in next) ctx[key] = /** @type {any} */ (next)[key];
  }
  if (next.sandbox !== undefined) {
    ctx.sandbox = next.sandbox;
  }
  if (next.runtimeBrand !== undefined) {
    ctx.runtimeBrand = resolveRuntimeBrand(next.runtimeBrand);
  }
  return ctx;
}

/**
 * Reset every data key to undefined and the brand back to the defaults.
 * @param {ToolContext} ctx
 * @returns {ToolContext}
 */
export function resetToolContext(ctx) {
  for (const key of TOOL_CONTEXT_KEYS) {
    ctx[key] = /** @type {any} */ (undefined);
  }
  ctx.sandbox = passthroughSandbox;
  ctx.runtimeBrand = { ...DEFAULT_RUNTIME_BRAND };
  return ctx;
}

// Single source of truth for the sandbox policy a tool call runs under.
// Merging (rather than letting the per-call option shadow the context policy)
// keeps the guarantee monotonic (I13): a request-scoped policy can tighten the
// host-configured policy but never weaken or disable it. The merge itself is
// delegated to `ctx.sandbox.mergePolicies` (defaulting to passthroughSandbox)
// so the actual algorithm is host-injected, not hard-coded here.
/**
 * @param {ToolContext|undefined} ctx
 * @param {SandboxPolicy} [requestPolicy]
 * @returns {SandboxPolicy|undefined}
 */
export function resolveSandboxPolicy(ctx, requestPolicy = undefined) {
  const sandbox = ctx?.sandbox ?? passthroughSandbox;
  const merged = sandbox.mergePolicies(ctx?.sandboxPolicy ?? undefined, requestPolicy ?? undefined);
  return merged && merged.mode !== "off" ? merged : undefined;
}
