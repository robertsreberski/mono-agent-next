import type {
  RuntimeCapabilities,
  RuntimeNativeToolDescriptor,
} from "@mono-agent/module-sdk";
import { describe, expect, it } from "vitest";

import {
  nativeToolAllowed,
  runtimeNativeToolPolicyIssue,
} from "../native-tool-policy.js";
import type { AgentConfig } from "../types.js";

const capabilities: RuntimeCapabilities = {
  tools: true,
  mcp: true,
  attachments: true,
  approvals: true,
  structuredOutput: true,
  sandbox: true,
  sessions: true,
};

const callbackTool: RuntimeNativeToolDescriptor = {
  id: "runtime.node-repl",
  displayName: "Node REPL",
  effects: ["read", "write", "execute"],
  approval: "core-callback",
  sandbox: "core-executor",
};

describe("runtime native-tool policy intersection", () => {
  it("lets a Core callback enforce deny and request-local narrowing", () => {
    const config = policyConfig({
      tools: { default: "deny", allow: [] },
      approvals: { default: "deny" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [callbackTool],
      capabilities,
      config,
      requestToolPolicy: { deny: [callbackTool.id] },
      hasInteractionHandler: false,
    })).toBeUndefined();
    expect(nativeToolAllowed(
      callbackTool.id,
      config,
      { deny: [callbackTool.id] },
    )).toBe(false);
  });

  it("requires an interaction surface before a callback-governed ask route", () => {
    const config = policyConfig({
      tools: { default: "allow", deny: [] },
      approvals: { default: "ask" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [callbackTool],
      capabilities,
      config,
      hasInteractionHandler: false,
    })).toMatch(/approval interaction handler/u);
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [callbackTool],
      capabilities,
      config,
      hasInteractionHandler: true,
    })).toBeUndefined();
  });

  it("rejects runtime-enforced approval under ask and needs no handler for an already denied callback tool", () => {
    const askConfig = policyConfig({
      tools: { default: "allow", deny: [] },
      approvals: { default: "ask" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [{
        ...callbackTool,
        approval: "runtime-enforced",
        sandbox: "runtime-enforced",
      }],
      capabilities,
      config: askConfig,
      hasInteractionHandler: true,
    })).toMatch(/cannot enforce approval prompts/u);

    const deniedConfig = policyConfig({
      tools: { default: "deny", allow: [] },
      approvals: { default: "ask" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [callbackTool],
      capabilities,
      config: deniedConfig,
      hasInteractionHandler: false,
    })).toBeUndefined();
  });

  it("rejects a runtime-enforced tool when Core cannot narrow it", () => {
    const config = policyConfig({
      tools: { default: "deny", allow: [] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [{
        ...callbackTool,
        approval: "runtime-enforced",
        sandbox: "runtime-enforced",
      }],
      capabilities,
      config,
      hasInteractionHandler: false,
    })).toMatch(/cannot enforce the effective Core tool policy/u);
  });

  it("rejects duplicate native and Core-routed tool identities", () => {
    const config = policyConfig({
      tools: { default: "allow", deny: [] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [callbackTool],
      capabilities,
      config,
      routedToolIds: [callbackTool.id],
      hasInteractionHandler: false,
    })).toMatch(/conflicts with a Core-routed tool identity/u);
  });

  it("requires honest approval and selected-sandbox capabilities", () => {
    const askConfig = policyConfig({
      tools: { default: "allow", deny: [] },
      approvals: { default: "ask" },
      sandbox: { mode: "off" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [{ ...callbackTool, approval: "unsupported" }],
      capabilities,
      config: askConfig,
      hasInteractionHandler: true,
    })).toMatch(/cannot enforce approval prompts/u);

    const sandboxConfig = policyConfig({
      tools: { default: "allow", deny: [] },
      approvals: { default: "allow" },
      sandbox: { $use: "@fixture/sandbox" },
    });
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [{ ...callbackTool, sandbox: "unsupported" }],
      capabilities,
      config: sandboxConfig,
      hasInteractionHandler: false,
    })).toMatch(/cannot enforce the selected sandbox policy/u);
    expect(runtimeNativeToolPolicyIssue({
      nativeTools: [{ ...callbackTool, sandbox: "runtime-enforced" }],
      capabilities: { ...capabilities, sandbox: false },
      config: sandboxConfig,
      hasInteractionHandler: false,
    })).toMatch(/conflicts with the runtime sandbox capability/u);
  });
});

function policyConfig(policy: AgentConfig["policy"]): AgentConfig {
  return {
    configVersion: 1,
    agent: {
      id: "native-policy",
      name: "Native policy",
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: { main: { $use: "@fixture/runtime" } },
    routing: {
      primary: { runtime: "main", model: "fixture:model" },
      fallbacks: [],
    },
    policy,
  };
}
