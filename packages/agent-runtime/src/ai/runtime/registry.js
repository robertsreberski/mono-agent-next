// @ts-check

import { COMMON_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";

/**
 * `RuntimeModelRef` is referenced inline (not aliased with a top-level
 * `@typedef`) so this barrel does not re-export a second `RuntimeModelRef`
 * type alongside model-refs.js's — that duplicate `export *` re-export is a
 * TS2308 ambiguity. The canonical export stays in model-refs.js/types.js.
 * @typedef {import('../types.js').RuntimeBridge} RuntimeBridge
 * @typedef {import('../types.js').RuntimeBridgeDescriptor} RuntimeBridgeDescriptor
 * @typedef {import('../types.js').RuntimeBridgeId} RuntimeBridgeId
 */

/**
 * @typedef {Object} BridgeSpec
 * @property {RuntimeBridgeId} id
 * @property {(ref: (import('../types.js').RuntimeModelRef|undefined), options?: Object) => boolean} supports
 * @property {(ref?: import('../types.js').RuntimeModelRef) => Object} capabilities
 * @property {(options?: Object) => Promise<RuntimeBridge>} load
 */

// CLI bridges are checked first when execution_mode='cli'. Without that flag
// the resolver falls through to the SDK bridges below, preserving the
// pre-Phase-2 behaviour for any agent that hasn't opted in.
/** @type {Object<string, BridgeSpec>} */
const builtinBridgeSpecs = {
  "claude-code": {
    id: "claude-code",
    supports: (ref, options) => ref?.sdk === "claude" && options?.executionMode === "cli",
    // The claude CLI resumes prior sessions via `--resume <sessionId>`.
    capabilities: () => ({
      kind: "claude-code",
      runtime: "cli",
      ...COMMON_CAPABILITIES,
      supports_session_resume: true,
      // The one-shot CLI bridge has no bidirectional stdin steering channel.
      supports_live_input: false,
    }),
    load: async () => (await import("../providers/claude-cli.js")).claudeCodeRuntimeBridge,
  },
  "codex-app": {
    id: "codex-app",
    supports: (ref, options) => ref?.sdk === "codex" && options?.executionMode === "cli",
    // The codex-app bridge keeps the app-server subprocess + thread alive
    // across turns when options.sessionKeepAlive is set.
    capabilities: () => {
      const { kind: _sdkKind, ...capabilities } = runtimeCapabilities("codex");
      return { kind: "codex-app", ...capabilities };
    },
    load: async () => (await import("../providers/codex-app.js")).codexAppRuntimeBridge,
  },
  "opencode-app": {
    id: "opencode-app",
    supports: (ref, options) => ref?.sdk === "opencode" && options?.executionMode === "cli",
    capabilities: () => {
      const { kind: _sdkKind, ...capabilities } = runtimeCapabilities("opencode");
      return { kind: "opencode-app", ...capabilities };
    },
    load: async () => (await import("../providers/opencode-app.js")).opencodeAppRuntimeBridge,
  },
  claude: {
    id: "claude",
    supports: (ref) => ref?.sdk === "claude",
    capabilities: () => runtimeCapabilities("claude"),
    load: async () => (await import("../providers/claude-sdk.js")).claudeRuntimeBridge,
  },
  pi: {
    id: "pi",
    supports: (ref) => ref?.sdk === "pi",
    capabilities: () => runtimeCapabilities("pi"),
    // The pi-native AgentHarness bridge is the sole pi runtime path. The
    // hand-rolled pi-sdk bridge was removed once native reached parity.
    load: async () => (await import("../providers/pi-native.js")).piNativeRuntimeBridge,
  },
};

/**
 * @returns {Array<RuntimeBridgeDescriptor>}
 */
export function listRuntimeBridges() {
  return Object.values(builtinBridgeSpecs).map((bridge) => ({
    id: bridge.id,
    supports: bridge.supports,
    capabilities: bridge.capabilities,
  }));
}

/**
 * @param {import('../types.js').RuntimeModelRef} modelRef
 * @param {Object} [options]
 * @returns {Promise<RuntimeBridge>}
 */
export async function resolveRuntimeBridge(modelRef, options = {}) {
  for (const spec of Object.values(builtinBridgeSpecs)) {
    if (spec.supports(modelRef, options)) return spec.load(options);
  }
  throw new Error(`unsupported sdk: ${modelRef?.sdk || "unknown"}`);
}

export { RUNTIME_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";
