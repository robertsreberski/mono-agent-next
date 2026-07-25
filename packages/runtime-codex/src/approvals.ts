// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import { parseApprovalDecision } from "@mono-agent/module-sdk";
import type {
  ApprovalRequest,
  RuntimeNativeToolDescriptor,
  RuntimeTurnContext,
} from "@mono-agent/module-sdk";

import type {
  JsonRpcMessage,
  JsonRpcServerRequest,
} from "./json-rpc.js";
import {
  runtimeCodexCommandEscalationTool,
  runtimeCodexFileChangeEscalationTool,
} from "./model.js";

type CodexApprovalOutcome = "allow" | "deny" | "cancel";

const APPROVAL_SUMMARY_MAX_BYTES = 16_000;
const MAX_TRACKED_APPROVAL_ITEMS = 64;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const DIRECTIONAL_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/iu;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function approvalCallId(params: Record<string, unknown>): string {
  for (const key of ["approvalId", "itemId", "callId"]) {
    const candidate = params[key];
    if (
      typeof candidate === "string"
      && candidate.length <= 256
      && IDENTIFIER.test(candidate)
    ) {
      return candidate;
    }
  }
  return `codex-call-${randomUUID()}`;
}

function approvalText(value: unknown): string | readonly string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (
    Array.isArray(value)
    && value.length > 0
    && value.every((candidate) => typeof candidate === "string")
  ) {
    return [...value];
  }
  return undefined;
}

function approvalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface FileChangeAuthority {
  readonly path: string;
  readonly kind?: string;
}

export type CodexItemEvidence =
  | {
      readonly type: "commandExecution";
      readonly command?: string;
      readonly cwd?: string;
    }
  | {
      readonly type: "fileChange";
      readonly changes: readonly FileChangeAuthority[];
    };

function fileChangeAuthority(
  value: unknown,
): readonly FileChangeAuthority[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: FileChangeAuthority[] = [];
  for (const candidate of value) {
    const change = record(candidate);
    if (
      typeof change.path !== "string"
      || change.path.trim() === ""
    ) {
      return undefined;
    }
    changes.push({
      path: change.path,
      ...(typeof change.kind === "string" ? { kind: change.kind } : {}),
    });
  }
  return changes;
}

function exactApprovalSummary(
  title: string,
  authority: Record<string, unknown>,
  secret: string | undefined,
): string | undefined {
  let encoded: string;
  try {
    encoded = JSON.stringify(authority);
  } catch {
    return undefined;
  }
  if (
    encoded === undefined
    || DIRECTIONAL_CONTROLS.test(encoded)
    || BEARER_TOKEN.test(encoded)
    || (secret !== undefined && secret.length > 0 && encoded.includes(secret))
  ) {
    return undefined;
  }
  encoded = encoded
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const summary = `${title}\nExact authority JSON: ${encoded}`;
  return Buffer.byteLength(summary, "utf8") <= APPROVAL_SUMMARY_MAX_BYTES
    ? summary
    : undefined;
}

function commandApprovalSummary(
  params: Record<string, unknown>,
  evidence: CodexItemEvidence | undefined,
  secret: string | undefined,
): string | undefined {
  const command = approvalText(params.command)
    ?? (evidence?.type === "commandExecution" ? evidence.command : undefined);
  if (command === undefined) return undefined;
  const cwd = approvalString(params.cwd)
    ?? (evidence?.type === "commandExecution" ? evidence.cwd : undefined);
  return exactApprovalSummary(
    "Codex requests permission to execute a command.",
    {
      command,
      cwd: cwd ?? null,
      reason: approvalString(params.reason) ?? null,
      networkApprovalContext: params.networkApprovalContext ?? null,
      additionalPermissions: params.additionalPermissions ?? null,
    },
    secret,
  );
}

function fileChangeApprovalSummary(
  params: Record<string, unknown>,
  evidence: CodexItemEvidence | undefined,
  secret: string | undefined,
): string | undefined {
  const fileChanges = record(params.fileChanges);
  const legacyChanges = Object.keys(fileChanges)
    .sort()
    .map((path) => ({ path }));
  const changes = legacyChanges.length > 0
    ? legacyChanges
    : evidence?.type === "fileChange"
      ? evidence.changes
      : [];
  const grantRoot = approvalString(params.grantRoot);
  if (changes.length === 0 && grantRoot === undefined) return undefined;
  return exactApprovalSummary(
    "Codex requests permission to change files.",
    {
      changes,
      grantRoot: grantRoot ?? null,
      reason: approvalString(params.reason) ?? null,
    },
    secret,
  );
}

function approvalRouteMatches(
  method: string,
  params: Record<string, unknown>,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  if (threadId === undefined) return false;
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return params.conversationId === threadId;
  }
  return params.threadId === threadId
    && turnId !== undefined
    && params.turnId === turnId;
}

export function captureApprovalEvidence(
  message: JsonRpcMessage,
  evidence: Map<string, CodexItemEvidence>,
): void {
  const params = record(message.params);
  if (message.method === "item/started") {
    const item = record(params.item);
    if (typeof item.id !== "string") return;
    let next: CodexItemEvidence | undefined;
    if (item.type === "commandExecution") {
      const command = approvalString(item.command);
      const cwd = approvalString(item.cwd);
      next = {
        type: "commandExecution",
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
      };
    } else if (item.type === "fileChange") {
      const changes = fileChangeAuthority(item.changes);
      if (changes !== undefined) next = { type: "fileChange", changes };
    }
    if (
      next !== undefined
      && (evidence.has(item.id) || evidence.size < MAX_TRACKED_APPROVAL_ITEMS)
    ) {
      evidence.set(item.id, next);
    }
    return;
  }
  if (
    message.method === "item/fileChange/patchUpdated"
    && typeof params.itemId === "string"
  ) {
    const changes = fileChangeAuthority(params.changes);
    if (
      changes !== undefined
      && (
        evidence.has(params.itemId)
        || evidence.size < MAX_TRACKED_APPROVAL_ITEMS
      )
    ) {
      evidence.set(params.itemId, { type: "fileChange", changes });
    }
  }
}

async function coreApproval(
  context: RuntimeTurnContext,
  signal: AbortSignal,
  descriptor: RuntimeNativeToolDescriptor,
  callId: string,
  summary: string,
  timeoutMs: number,
): Promise<CodexApprovalOutcome> {
  if (signal.aborted) return "cancel";
  if (context.requestApproval === undefined) return "deny";
  const request: ApprovalRequest = {
    interactionId: `codex-${randomUUID()}`,
    callId,
    toolId: descriptor.id,
    displayName: descriptor.displayName,
    effects: descriptor.effects,
    summary,
    requestedAt: new Date().toISOString(),
  };
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const callback = Promise.resolve()
      .then(async () => context.requestApproval?.(request, signal))
      .then((decision) => {
        if (decision === undefined) return "deny" as const;
        const parsed = parseApprovalDecision(decision, request);
        return parsed.decision === "allow_once"
          ? "allow" as const
          : "deny" as const;
      })
      .catch(() => "deny" as const);
    const timeout = new Promise<"deny">((resolve) => {
      timer = setTimeout(() => resolve("deny"), timeoutMs);
      timer.unref?.();
    });
    const cancelled = new Promise<"cancel">((resolve) => {
      abortHandler = () => resolve("cancel");
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    });
    const outcome = await Promise.race([callback, timeout, cancelled]);
    return signal.aborted ? "cancel" : outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function v2ApprovalResponse(outcome: CodexApprovalOutcome): {
  readonly decision: "accept" | "decline" | "cancel";
} {
  return {
    decision: outcome === "allow"
      ? "accept"
      : outcome === "cancel"
        ? "cancel"
        : "decline",
  };
}

function v2CommandApprovalResponse(
  outcome: CodexApprovalOutcome,
  params: Record<string, unknown>,
): { readonly decision: "accept" | "decline" | "cancel" } {
  if (
    outcome === "allow"
    && Array.isArray(params.availableDecisions)
    && !params.availableDecisions.includes("accept")
  ) {
    return { decision: "decline" };
  }
  return v2ApprovalResponse(outcome);
}

function legacyApprovalResponse(outcome: CodexApprovalOutcome): {
  readonly decision: "approved" | "abort" | {
    readonly denied: { readonly rejection: string };
  };
} {
  return {
    decision: outcome === "allow"
      ? "approved"
      : outcome === "cancel"
        ? "abort"
        : { denied: { rejection: "Denied by mono-agent policy" } },
  };
}

export async function handleCodexServerRequest(
  message: JsonRpcServerRequest,
  context: RuntimeTurnContext,
  signal: AbortSignal,
  threadId: string | undefined,
  turnId: string | undefined,
  evidence: ReadonlyMap<string, CodexItemEvidence>,
  secret: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const params = record(message.params);
  const itemEvidence = typeof params.itemId === "string"
    ? evidence.get(params.itemId)
    : undefined;
  const routeMatches = approvalRouteMatches(
    message.method,
    params,
    threadId,
    turnId,
  );

  if (message.method === "item/commandExecution/requestApproval") {
    const summary = commandApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexCommandEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return v2CommandApprovalResponse(outcome, params);
  }
  if (message.method === "item/fileChange/requestApproval") {
    const summary = fileChangeApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexFileChangeEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return v2ApprovalResponse(outcome);
  }
  if (message.method === "execCommandApproval") {
    const summary = commandApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexCommandEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return legacyApprovalResponse(outcome);
  }
  if (message.method === "applyPatchApproval") {
    const summary = fileChangeApprovalSummary(params, itemEvidence, secret);
    const outcome = routeMatches && summary !== undefined
      ? await coreApproval(
          context,
          signal,
          runtimeCodexFileChangeEscalationTool,
          approvalCallId(params),
          summary,
          timeoutMs,
        )
      : "deny";
    return legacyApprovalResponse(outcome);
  }
  if (message.method === "item/permissions/requestApproval") {
    // The provider protocol has no explicit denial variant for permission
    // profiles. An empty, turn-scoped grant is the protocol-correct
    // fail-closed response; runtime-codex never echoes requested authority.
    return {
      permissions: {},
      scope: "turn",
      strictAutoReview: true,
    };
  }
  throw new Error(`Unsupported Codex server request: ${message.method}`);
}
