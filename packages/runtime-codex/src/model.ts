// SPDX-License-Identifier: MIT
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
  approvals: true,
  structuredOutput: true,
  sandbox: false,
  sessions: true,
  maxTurns: false,
  maxOutputTokens: false,
  liveInput: true,
});

export const runtimeCodexCommandExecutionTool: RuntimeNativeToolDescriptor =
  Object.freeze({
    id: "codex.command-execution",
    displayName: "Codex command execution",
    effects: Object.freeze(["read", "write", "execute"] as const),
    approval: "runtime-enforced",
    sandbox: "runtime-enforced",
  });

export const runtimeCodexImageViewTool: RuntimeNativeToolDescriptor =
  Object.freeze({
    id: "codex.image-view",
    displayName: "Codex image view",
    effects: Object.freeze(["read"] as const),
    approval: "runtime-enforced",
    sandbox: "runtime-enforced",
  });

export const runtimeCodexCommandEscalationTool: RuntimeNativeToolDescriptor =
  Object.freeze({
    id: "codex.command-escalation",
    displayName: "Codex command escalation",
    effects: Object.freeze(["read", "write", "execute", "network"] as const),
    approval: "core-callback",
    sandbox: "runtime-enforced",
  });

export const runtimeCodexFileChangeEscalationTool: RuntimeNativeToolDescriptor =
  Object.freeze({
    id: "codex.file-change-escalation",
    displayName: "Codex file change escalation",
    effects: Object.freeze(["write"] as const),
    approval: "core-callback",
    sandbox: "runtime-enforced",
  });

export const runtimeCodexNativeTools: readonly RuntimeNativeToolDescriptor[] =
  Object.freeze([
    runtimeCodexCommandExecutionTool,
    runtimeCodexImageViewTool,
    runtimeCodexCommandEscalationTool,
    runtimeCodexFileChangeEscalationTool,
  ]);

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
