// Module-level DEFAULT tool context — the back-compat layer over tool-context.js.
//
// Historically this file held the one-per-process tool-runtime singleton. That
// assumed one task per process, which is false in a long-lived multi-channel
// host: two `createRuntime` instances clobbered each other's workspace /
// repoRoot / sandboxPolicy / brand. The per-instance ToolContext (tool-context.js)
// fixes that — `createRuntime` now builds its own context and threads it to
// bridges as `options.toolContext`.
//
// This module survives as the DEFAULT context every internal read site falls
// back to when no per-instance context was threaded (`ctx ?? readToolRuntime()`).
// Hosts that only call the deep-path `configureToolRuntime` (e.g. worklab's
// worker.js / doctor.js) get byte-for-byte identical behavior to before: they
// configure this default context and the tools read it.
//
// The public exports are unchanged: configureToolRuntime / readToolRuntime /
// readRuntimeBrand / resetToolRuntime (plus the internal resolveSandboxPolicy
// default-context convenience). See tool-context.js for the recognized keys.

// @ts-check

import {
  createToolContext,
  resetToolContext,
  updateToolContext,
  resolveSandboxPolicy as resolveContextSandboxPolicy,
} from "./tool-context.js";
import { DEFAULT_RUNTIME_BRAND } from "../../../runtime-brand.js";

/** @typedef {import('./tool-context.js').ToolContext} ToolContext */
/**
 * @typedef {ToolContext} ToolRuntimeContext
 * Back-compat alias for the historical name.
 */

/** @type {ToolContext} */
const defaultContext = createToolContext({});

/**
 * @param {Partial<ToolContext>} [next]
 * @returns {void}
 */
export function configureToolRuntime(next = {}) {
  updateToolContext(defaultContext, next);
}

/**
 * @returns {ToolContext}
 */
export function readToolRuntime() {
  return defaultContext;
}

// Default-context convenience: resolves a request policy against the module
// default context. Internal read sites that carry a per-instance context call
// tool-context.js's `resolveSandboxPolicy(ctx, requestPolicy)` directly with
// `ctx ?? readToolRuntime()`; this wrapper preserves the historical
// single-argument signature for the default path.
/**
 * @param {import('../../sandbox-seam.js').SandboxPolicy} [requestPolicy]
 * @returns {import('../../sandbox-seam.js').SandboxPolicy|undefined}
 */
export function resolveSandboxPolicy(requestPolicy = undefined) {
  return resolveContextSandboxPolicy(defaultContext, requestPolicy);
}

/**
 * @returns {import('../../../runtime-brand.js').RuntimeBrand}
 */
export function readRuntimeBrand() {
  return defaultContext.runtimeBrand || { ...DEFAULT_RUNTIME_BRAND };
}

/**
 * @returns {void}
 */
export function resetToolRuntime() {
  resetToolContext(defaultContext);
}
