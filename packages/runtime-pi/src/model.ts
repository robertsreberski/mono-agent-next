import type {
  ModuleDiagnostic,
  RuntimeModelValidation,
  RuntimeModelValidationRequest,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";

import { parsePiModelReference, parseRuntimePiConfig } from "./config.js";

export const runtimePiNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([]);

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
