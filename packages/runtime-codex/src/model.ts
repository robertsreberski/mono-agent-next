import type {
  ModuleDiagnostic,
  RuntimeCapabilities,
  RuntimeModelValidation,
  RuntimeModelValidationRequest,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";

import { parseRuntimeCodexConfig } from "./config.js";

const CONTROL = /[\u0000-\u001f\u007f]/;

export const runtimeCodexCapabilities: RuntimeCapabilities = Object.freeze({
  tools: false,
  mcp: false,
  attachments: false,
  approvals: false,
  structuredOutput: true,
  sandbox: false,
  sessions: true,
  liveInput: true,
});

export const runtimeCodexNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([]);

function diagnostic(message: string): ModuleDiagnostic {
  return {
    code: "runtime-codex.model",
    severity: "error",
    message,
  };
}

export function isRuntimeCodexModel(model: string): boolean {
  return model.length > 0
    && model.length <= 256
    && model.trim() === model
    && !CONTROL.test(model);
}

export function validateRuntimeCodexModel(
  request: RuntimeModelValidationRequest,
): RuntimeModelValidation {
  // Definition validation receives parsed config from Core, but re-parsing
  // keeps direct callers on the same deterministic schema boundary.
  parseRuntimeCodexConfig(request.config);
  if (!isRuntimeCodexModel(request.model)) {
    return {
      supported: false,
      diagnostics: [diagnostic("Codex model identifier is invalid")],
    };
  }
  return {
    supported: true,
    capabilities: runtimeCodexCapabilities,
    nativeTools: runtimeCodexNativeTools,
  };
}
