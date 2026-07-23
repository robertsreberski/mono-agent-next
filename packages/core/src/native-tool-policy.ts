import type {
  RuntimeCapabilities,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";

import type { AgentConfig, AgentSubmitInput } from "./types.js";

export interface RuntimeNativeToolPolicyInput {
  readonly nativeTools: readonly RuntimeNativeToolDescriptor[];
  readonly capabilities?: RuntimeCapabilities;
  readonly config: AgentConfig;
  readonly requestToolPolicy?: AgentSubmitInput["toolPolicy"];
  readonly routedToolIds?: readonly string[];
  /**
   * `undefined` means the caller is doing config-time validation and cannot
   * know which submit/channel interaction surface will be used.
   */
  readonly hasInteractionHandler?: boolean;
}

/**
 * Return the first reason a runtime-owned tool surface cannot be narrowed to
 * the effective Core policy. A runtime with a `core-callback` descriptor asks
 * Core before every native invocation, so Core can enforce allow, deny, ask,
 * and request-local tool narrowing without trusting provider prompt behavior.
 */
export function runtimeNativeToolPolicyIssue(
  input: RuntimeNativeToolPolicyInput,
): string | undefined {
  const sandboxSelected = !(
    "mode" in input.config.policy.sandbox
    && input.config.policy.sandbox.mode === "off"
  );

  for (const tool of input.nativeTools) {
    if (input.routedToolIds?.includes(tool.id) === true) {
      return `native tool ${tool.id} conflicts with a Core-routed tool identity`;
    }
    const toolAllowed = nativeToolAllowed(
      tool.id,
      input.config,
      input.requestToolPolicy,
    );
    const effectful = tool.effects.length > 0;

    if (tool.approval !== "unsupported"
      && input.capabilities !== undefined
      && !input.capabilities.approvals) {
      return `native tool ${tool.id} conflicts with the runtime approval capability`;
    }

    if (!toolAllowed && tool.approval !== "core-callback") {
      return `native tool ${tool.id} cannot enforce the effective Core tool policy`;
    }

    if (effectful && input.config.policy.approvals.default === "deny"
      && tool.approval !== "core-callback") {
      return `native tool ${tool.id} cannot enforce approval denial`;
    }

    if (effectful && toolAllowed
      && input.config.policy.approvals.default === "ask") {
      if (tool.approval !== "core-callback") {
        return `native tool ${tool.id} cannot enforce approval prompts`;
      }
      if (input.hasInteractionHandler === false) {
        return `native tool ${tool.id} requires an approval interaction handler`;
      }
    }

    if (effectful && sandboxSelected) {
      if (tool.sandbox === "unsupported") {
        return `native tool ${tool.id} cannot enforce the selected sandbox policy`;
      }
      if (input.capabilities !== undefined && !input.capabilities.sandbox) {
        return `native tool ${tool.id} conflicts with the runtime sandbox capability`;
      }
    }
  }
  return undefined;
}

export function nativeToolAllowed(
  toolId: string,
  config: AgentConfig,
  requestToolPolicy?: AgentSubmitInput["toolPolicy"],
): boolean {
  const global = config.policy.tools;
  const globallyAllowed = global.default === "allow"
    ? !(global.deny ?? []).includes(toolId)
    : (global.allow ?? []).includes(toolId);
  if (!globallyAllowed) return false;
  if (requestToolPolicy?.allow !== undefined
    && !requestToolPolicy.allow.includes(toolId)) {
    return false;
  }
  return !(requestToolPolicy?.deny ?? []).includes(toolId);
}
