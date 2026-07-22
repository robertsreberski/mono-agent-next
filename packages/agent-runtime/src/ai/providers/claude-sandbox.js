import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";
import { resolveSandboxPolicy } from "../../agent/tools/shared/tool-context.js";

export const CLAUDE_SANDBOX_POLICY_UNSUPPORTED =
  "Claude SDK/CLI cannot enforce mono-agent's native srt sandbox scopes. Remove the mono-agent sandbox policy or use a Pi runtime for exact readableRoots, writableRoots, denyWrite, and network rules.";

/**
 * Claude owns its built-in tool subprocesses, so mono-agent's runtime tool
 * context cannot wrap them with the configured srt engine. An explicit `off`
 * policy is inert and remains valid; every enforcing mono-agent mode must fail
 * before the provider starts instead of silently running outside that policy.
 */
export function claudeSandboxPolicyProblem(options) {
  const effectivePolicy = resolveSandboxPolicy(
    options?.toolContext,
    options?.sandboxPolicy,
  );
  return effectivePolicy !== undefined
    ? CLAUDE_SANDBOX_POLICY_UNSUPPORTED
    : null;
}

/** Typed provider result used by Claude bridges for fail-closed capability paths. */
export function claudeCapabilityMismatchResult({
  model,
  effort,
  sdk,
  providerSessionId = null,
  durationMs = 0,
  outputSchema,
  error,
  errorCode,
}) {
  return {
    text: null,
    structuredResult: undefined,
    structuredResultSource: null,
    events: [],
    usage: {},
    durationMs,
    numTurns: 0,
    model,
    effort: effort || null,
    sdk,
    providerSessionId,
    provider_session_id: providerSessionId,
    cancelled: false,
    error,
    failureKind: "skipped_capability_mismatch",
    diagnostics: { claude_error_code: errorCode },
    capabilitiesUsed: buildCapabilitiesUsed({
      promptCacheActive: null,
      thinkingEnabled: null,
      structuredOutputEnforced: !!outputSchema,
      subagentInvoked: null,
      mcpServersUsed: [],
      nativeSubagentsUsed: [],
      toolCompactionApplied: false,
      contextCompactionApplied: null,
    }),
  };
}

/** Typed provider result used by both Claude bridges for the sandbox path. */
export function claudeSandboxCapabilityMismatchResult(options) {
  return claudeCapabilityMismatchResult({
    ...options,
    error: CLAUDE_SANDBOX_POLICY_UNSUPPORTED,
    errorCode: "claude_sandbox_policy_unsupported",
  });
}
