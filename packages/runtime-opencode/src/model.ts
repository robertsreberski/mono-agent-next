import type {
  ModuleDiagnostic,
  RuntimeCapabilities,
  RuntimeModelValidation,
  RuntimeModelValidationRequest,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";

import { parseRuntimeOpenCodeConfig } from "./config.js";

const CONTROL = /[\u0000-\u001f\u007f]/;

export const runtimeOpenCodeCapabilities: RuntimeCapabilities = Object.freeze({
  tools: false,
  mcp: false,
  attachments: false,
  approvals: false,
  structuredOutput: false,
  sandbox: false,
  sessions: true,
  liveInput: false,
});

/**
 * OpenCode-native tools are disabled through the process's highest-precedence
 * inline config and dedicated deny-all agent. Any tool event is a fatal
 * protocol violation, so this contract truthfully exposes no native tools.
 */
export const runtimeOpenCodeNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([]);

function diagnostic(message: string): ModuleDiagnostic {
  return {
    code: "runtime-opencode.model",
    severity: "error",
    message,
  };
}

export function isRuntimeOpenCodeModel(model: string): boolean {
  const slash = model.indexOf("/");
  return slash > 0
    && slash < model.length - 1
    && model.length <= 512
    && model.trim() === model
    && !CONTROL.test(model);
}

export function validateRuntimeOpenCodeModel(
  request: RuntimeModelValidationRequest,
): RuntimeModelValidation {
  parseRuntimeOpenCodeConfig(request.config);
  if (!isRuntimeOpenCodeModel(request.model)) {
    return {
      supported: false,
      diagnostics: [
        diagnostic("OpenCode model must use provider/model"),
      ],
    };
  }
  return {
    supported: true,
    capabilities: runtimeOpenCodeCapabilities,
    nativeTools: runtimeOpenCodeNativeTools,
  };
}
