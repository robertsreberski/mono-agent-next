import type {
  ModuleDiagnostic,
  RuntimeCapabilities,
  RuntimeModelValidation,
  RuntimeModelValidationRequest,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";

import {
  parseRuntimeClaudeConfig,
  type RuntimeClaudeConfig,
} from "./config.js";

const NO_NATIVE_TOOLS: readonly RuntimeNativeToolDescriptor[] = Object.freeze([]);

function diagnostic(
  code: string,
  severity: ModuleDiagnostic["severity"],
  message: string,
): ModuleDiagnostic {
  return { code, severity, message };
}

export function isClaudeModelIdentifier(model: string): boolean {
  return /^(?:claude-[a-z0-9][a-z0-9.-]*|opus|sonnet|haiku)$/.test(model)
    && model.length <= 256;
}

export function claudeRuntimeCapabilities(
  config: Pick<RuntimeClaudeConfig, "mode">,
): RuntimeCapabilities {
  return {
    tools: false,
    mcp: false,
    attachments: false,
    approvals: false,
    structuredOutput: true,
    sandbox: false,
    sessions: true,
    liveInput: config.mode === "sdk",
  };
}

/**
 * Validate a Claude route using only deterministic model and parsed-config
 * syntax. This function intentionally has no access to credentials, the
 * filesystem, processes, or the network.
 */
export function validateClaudeModel(
  request: RuntimeModelValidationRequest,
): RuntimeModelValidation {
  const config = parseRuntimeClaudeConfig(request.config);
  if (!isClaudeModelIdentifier(request.model)) {
    return {
      supported: false,
      diagnostics: [
        diagnostic(
          "runtime-claude.model",
          "error",
          "Claude model identifier is invalid",
        ),
      ],
    };
  }
  return {
    supported: true,
    capabilities: claudeRuntimeCapabilities(config),
    nativeTools: NO_NATIVE_TOOLS,
  };
}
