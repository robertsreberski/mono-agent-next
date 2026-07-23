import type {
  ModuleDiagnostic,
  RuntimeModelValidation,
  RuntimeModelValidationRequest,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";

import { parsePiModelReference, parseRuntimePiConfig } from "./config.js";

export const runtimePiNodeReplTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "NodeRepl",
  displayName: "Node REPL",
  effects: Object.freeze(["read", "write", "execute", "network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiEditTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "Edit",
  displayName: "Edit",
  effects: Object.freeze(["read", "write"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiWebSearchTool: RuntimeNativeToolDescriptor = Object.freeze({
  id: "WebSearch",
  displayName: "Web Search",
  effects: Object.freeze(["network"] as const),
  approval: "core-callback",
  sandbox: "unsupported",
});

export const runtimePiNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([
    runtimePiNodeReplTool,
    runtimePiEditTool,
    runtimePiWebSearchTool,
  ]);

function diagnostic(message: string): ModuleDiagnostic {
  return {
    code: "runtime-pi.model",
    severity: "error",
    message,
  };
}

/**
 * Validate only the deterministic Pi route and config syntax available before
 * a runtime instance exists. Exact catalog, discovery, and auth checks belong
 * to the created instance's preflight.
 */
export function validateRuntimePiModel(
  request: RuntimeModelValidationRequest,
): RuntimeModelValidation {
  parseRuntimePiConfig(request.config);
  try {
    parsePiModelReference(request.model);
  } catch (error) {
    return {
      supported: false,
      diagnostics: [
        diagnostic(error instanceof Error ? error.message : String(error)),
      ],
    };
  }
  return {
    supported: true,
    nativeTools: runtimePiNativeTools,
  };
}
