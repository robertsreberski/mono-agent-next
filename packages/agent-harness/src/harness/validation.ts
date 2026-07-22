import { assertAgentContinuationOriginContext } from "@mono-agent/agent-contracts";

import type { AgentHarnessOptions, AgentHarnessRequest } from "../types.js";

export function validateOptions(options: AgentHarnessOptions): void {
  if (typeof options.identityPath !== "string" || options.identityPath.trim().length === 0) {
    throw new TypeError("identityPath must be a non-empty path.");
  }
  if (typeof options.runtime?.run !== "function") {
    throw new TypeError("runtime must expose run().");
  }
  if (typeof options.model !== "object" || options.model === null) {
    throw new TypeError("model must be a parsed runtime model reference.");
  }
  if (
    options.executionMode !== undefined &&
    (typeof options.executionMode !== "string" || options.executionMode.length === 0)
  ) {
    throw new TypeError("executionMode must be an optional non-empty string.");
  }
  if (options.mcpRequestContext !== undefined) {
    if (!Array.isArray(options.mcpRequestContext.serverNames)
      || options.mcpRequestContext.serverNames.some((name) => typeof name !== "string" || name.trim().length === 0)) {
      throw new TypeError("mcpRequestContext.serverNames must contain non-empty strings.");
    }
    if (typeof options.mcpRequestContext.runOutputRoot !== "string"
      || options.mcpRequestContext.runOutputRoot.trim().length === 0) {
      throw new TypeError("mcpRequestContext.runOutputRoot must be a non-empty path.");
    }
  }
  if (options.continuationContext !== undefined) {
    if (!Array.isArray(options.continuationContext.serverNames)
      || options.continuationContext.serverNames.some((name) => typeof name !== "string" || name.trim().length === 0)) {
      throw new TypeError("continuationContext.serverNames must contain non-empty strings.");
    }
    if (typeof options.continuationContext.capabilityIssuer?.issueContinuationClaimCapability !== "function") {
      throw new TypeError("continuationContext.capabilityIssuer must issue continuation claim capabilities.");
    }
  }
}

export function validateRequest(request: AgentHarnessRequest): void {
  if (typeof request.conversationId !== "string" || request.conversationId.trim().length === 0) {
    throw new TypeError("conversationId must be a non-empty string.");
  }
  if (typeof request.userMessage !== "string") {
    throw new TypeError("userMessage must be a string.");
  }
  // Attachment-only turns (e.g. a Slack/Telegram file upload with no caption)
  // are valid: applyAttachments() synthesizes a non-empty prompt referencing the
  // files. Only reject when there is neither text nor any attachment.
  const hasAttachments = Array.isArray(request.attachments) && request.attachments.length > 0;
  if (request.userMessage.trim().length === 0 && !hasAttachments) {
    throw new TypeError("userMessage must be a non-empty string unless attachments are provided.");
  }
  if (!(request.abortSignal instanceof AbortSignal)) {
    throw new TypeError("abortSignal is required.");
  }
  if (request.replyTo !== undefined
    && (typeof request.replyTo.conversationId !== "string" || request.replyTo.conversationId.trim().length === 0)) {
    throw new TypeError("replyTo.conversationId must be a non-empty string.");
  }
  if (request.continuation !== undefined) {
    const continuation = request.continuation;
    if (typeof continuation.continuationId !== "string" || continuation.continuationId.trim().length === 0
      || typeof continuation.originRunId !== "string" || continuation.originRunId.trim().length === 0
      || (continuation.originContextPolicy !== "pinned" && continuation.originContextPolicy !== "detached_latest")
      || (continuation.historyBoundary !== undefined
        && (typeof continuation.historyBoundary !== "string" || continuation.historyBoundary.trim().length === 0))
      || (continuation.originContextPolicy === "pinned" && continuation.originContext === undefined)
      || (continuation.originContextPolicy === "detached_latest" && continuation.originContext !== undefined)
      || continuation.toolsDisabled !== true
      || continuation.deferHistoryCommit !== true) {
      throw new TypeError("continuation must contain valid host-only synthesis controls.");
    }
    if (continuation.originContext !== undefined) assertAgentContinuationOriginContext(continuation.originContext);
  }
}
