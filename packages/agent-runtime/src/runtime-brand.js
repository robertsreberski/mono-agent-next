// @ts-check

// Host-customisable identity strings used by the runtime when it has to
// stamp a name onto something that leaves the process: MCP client name,
// transcript-snapshot schema id, temp-directory prefix, the doctor command
// suggested in tool error messages, etc.
//
// The runtime ships with neutral defaults. External hosts pass `runtimeBrand`
// to `createRuntime` to make the package look like theirs without forking
// string-by-string.

/**
 * @typedef {Object} RuntimeBrand
 * @property {string} schemaPrefix
 * @property {string} mcpClientName
 * @property {string} mcpClientVersion
 * @property {string} tempdirPrefix
 * @property {string} providerModelPrefix
 * @property {string} doctorCommand
 * @property {string} serviceName
 * @property {string} clientInfoName
 * @property {string} clientInfoTitle
 */

/** @type {RuntimeBrand} */
export const DEFAULT_RUNTIME_BRAND = Object.freeze({
  schemaPrefix: "agent_runtime",
  mcpClientName: "agent-runtime",
  mcpClientVersion: "0.1.0",
  tempdirPrefix: "agent-runtime-cli-",
  providerModelPrefix: "agent",
  doctorCommand: "agent-runtime doctor",
  // serviceName + clientInfo names propagated to provider SDKs that report
  // a client identity (Codex app-server, etc.).
  serviceName: "agent-runtime",
  clientInfoName: "agent-runtime",
  clientInfoTitle: "Agent Runtime",
});

/**
 * @param {Partial<RuntimeBrand>} [input]
 * @returns {RuntimeBrand}
 */
export function resolveRuntimeBrand(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_RUNTIME_BRAND };
  const out = { ...DEFAULT_RUNTIME_BRAND };
  for (const key of /** @type {Array<keyof RuntimeBrand>} */ (Object.keys(DEFAULT_RUNTIME_BRAND))) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}
