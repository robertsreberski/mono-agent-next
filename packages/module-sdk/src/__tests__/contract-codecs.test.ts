// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  AGENT_INTERACTION_LIMITS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES,
  assertApprovalDecision,
  assertApprovalRequest,
  assertArtifactRef,
  assertAskUserAnswer,
  assertAskUserRequest,
  assertRouteIdentity,
  assertRuntimeNativeToolDescriptor,
  defineModuleSchema,
  defineRuntimeModule,
  parseApprovalDecision,
  parseApprovalRequest,
  parseArtifactRef,
  parseAskUserAnswer,
  parseAskUserRequest,
  parseRouteIdentity,
  parseRuntimeNativeToolDescriptor,
  type ApprovalRequest,
  type AskUserRequest,
  type RuntimeSession,
  type RuntimeToolResult,
} from "../index.js";

const REQUESTED_AT = "2026-07-23T12:00:00.000Z";
const ANSWERED_AT = "2026-07-23T12:00:01.000Z";

const ASK_USER_REQUEST = {
  interactionId: "ask-1",
  questions: [
    {
      id: "target",
      prompt: "Which target should be used?",
      choices: [
        { value: "staging", label: "Staging", description: "Use the staging service." },
        { value: "production", label: "Production" },
      ],
      allowFreeText: false,
      multiple: false,
    },
    {
      id: "notes",
      prompt: "Anything else?",
      allowFreeText: true,
      multiple: false,
    },
  ],
  requestedAt: REQUESTED_AT,
} satisfies AskUserRequest;

const APPROVAL_REQUEST = {
  interactionId: "approval-1",
  callId: "call-1",
  toolId: "core__shell",
  displayName: "Run shell command",
  effects: ["read", "execute"],
  summary: "Inspect the selected project.",
  requestedAt: REQUESTED_AT,
} satisfies ApprovalRequest;

describe("AskUser codecs", () => {
  it("parses, copies, and freezes one bounded request and matching answer", () => {
    const request = parseAskUserRequest(ASK_USER_REQUEST);
    const answer = parseAskUserAnswer({
      interactionId: "ask-1",
      answers: {
        target: ["staging"],
        notes: ["No additional notes."],
      },
      answeredAt: ANSWERED_AT,
    }, request);

    expect(request).toEqual(ASK_USER_REQUEST);
    expect(answer.answers).toEqual({
      target: ["staging"],
      notes: ["No additional notes."],
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.questions)).toBe(true);
    expect(Object.isFrozen(request.questions[0]?.choices)).toBe(true);
    expect(Object.isFrozen(answer.answers)).toBe(true);
    expect(Object.isFrozen(answer.answers.target)).toBe(true);
    expect(() => assertAskUserRequest(request)).not.toThrow();
    expect(() => assertAskUserAnswer(answer, request)).not.toThrow();
  });

  it("rejects unknown fields, non-canonical timestamps, duplicates, and byte overflow", () => {
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      transport: "telegram",
    })).toThrow('contains unknown field "transport"');
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      requestedAt: "2026-07-23T12:00:00Z",
    })).toThrow("must be a canonical UTC timestamp");
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      questions: [
        ASK_USER_REQUEST.questions[0],
        { ...ASK_USER_REQUEST.questions[0] },
      ],
    })).toThrow("must be unique");
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      questions: [{
        id: "large",
        prompt: "é".repeat(
          Math.floor(AGENT_INTERACTION_LIMITS.askPromptBytes / 2) + 1,
        ),
        allowFreeText: true,
        multiple: false,
      }],
    })).toThrow(
      `must be at most ${String(AGENT_INTERACTION_LIMITS.askPromptBytes)} UTF-8 bytes`,
    );
  });

  it("requires usable questions and semantically valid complete answers", () => {
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      questions: [{
        id: "unanswerable",
        prompt: "Cannot answer",
        allowFreeText: false,
        multiple: false,
      }],
    })).toThrow("must contain a choice when free text is disabled");
    expect(() => parseAskUserAnswer({
      interactionId: "ask-1",
      answers: { target: ["unknown"], notes: ["ok"] },
      answeredAt: ANSWERED_AT,
    }, ASK_USER_REQUEST)).toThrow("must match one of the request choices");
    expect(() => parseAskUserAnswer({
      interactionId: "ask-1",
      answers: { target: ["staging", "production"], notes: ["ok"] },
      answeredAt: ANSWERED_AT,
    }, ASK_USER_REQUEST)).toThrow(
      "must contain exactly one value for a single-select question",
    );
    expect(() => parseAskUserAnswer({
      interactionId: "ask-1",
      answers: { target: ["staging"] },
      answeredAt: ANSWERED_AT,
    }, ASK_USER_REQUEST)).toThrow(
      "must answer every request question exactly once",
    );
    expect(() => parseAskUserAnswer({
      interactionId: "ask-other",
      answers: { target: ["staging"], notes: ["ok"] },
      answeredAt: ANSWERED_AT,
    }, ASK_USER_REQUEST)).toThrow("does not match the request");
  });

  it("accepts multiple selections only for questions that declare them", () => {
    const multipleRequest = parseAskUserRequest({
      interactionId: "ask-multiple",
      requestedAt: REQUESTED_AT,
      questions: [{
        id: "targets",
        prompt: "Which targets?",
        choices: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
        allowFreeText: false,
        multiple: true,
      }],
    });
    const answer = parseAskUserAnswer({
      interactionId: multipleRequest.interactionId,
      answers: { targets: ["staging", "production"] },
      answeredAt: ANSWERED_AT,
    }, multipleRequest);

    expect(answer.answers.targets).toEqual(["staging", "production"]);
    expect(parseAskUserAnswer(answer, multipleRequest)).toEqual(answer);

    const singleRequest = parseAskUserRequest({
      ...multipleRequest,
      questions: multipleRequest.questions.map((question) => ({
        ...question,
        multiple: false,
      })),
    });
    expect(() => parseAskUserAnswer({
      ...answer,
      answers: { targets: ["staging", "production"] },
    }, singleRequest)).toThrow(
      "must contain exactly one value for a single-select question",
    );
  });

  it("represents every valid identifier as a prototype-safe answer key", () => {
    const request = parseAskUserRequest({
      interactionId: "prototype-safe",
      requestedAt: REQUESTED_AT,
      questions: ["constructor", "prototype"].map((id) => ({
        id,
        prompt: `Answer ${id}`,
        allowFreeText: true,
        multiple: false,
      })),
    });
    const answer = parseAskUserAnswer({
      interactionId: request.interactionId,
      answers: Object.fromEntries([
        ["constructor", ["constructor value"]],
        ["prototype", ["prototype value"]],
      ]),
      answeredAt: ANSWERED_AT,
    }, request);

    expect(Object.getPrototypeOf(answer.answers)).toBeNull();
    expect(answer.answers["constructor" as string]).toEqual(["constructor value"]);
    expect(answer.answers["prototype" as string]).toEqual(["prototype value"]);
  });

  it("rejects sparse or accessor-backed contract records and arrays without invoking getters", () => {
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      questions: new Array(1),
    })).toThrow(/questions\.0.*required/u);

    let questionReads = 0;
    const questions = [ASK_USER_REQUEST.questions[0]] as unknown[];
    Object.defineProperty(questions, "0", {
      enumerable: true,
      configurable: true,
      get() {
        questionReads += 1;
        return ASK_USER_REQUEST.questions[0];
      },
    });
    expect(() => parseAskUserRequest({
      ...ASK_USER_REQUEST,
      questions,
    })).toThrow(/questions\.0.*data property/u);
    expect(questionReads).toBe(0);

    let interactionReads = 0;
    const request = { ...ASK_USER_REQUEST };
    Object.defineProperty(request, "interactionId", {
      enumerable: true,
      configurable: true,
      get() {
        interactionReads += 1;
        return "ask-1";
      },
    });
    expect(() => parseAskUserRequest(request)).toThrow(/interactionId.*data property/u);
    expect(interactionReads).toBe(0);
  });
});

describe("approval codecs", () => {
  it("accepts only one-shot allow or deny decisions", () => {
    const request = parseApprovalRequest(APPROVAL_REQUEST);
    const decision = parseApprovalDecision({
      interactionId: "approval-1",
      decision: "allow_once",
      decidedAt: ANSWERED_AT,
      reason: "Approved for this call.",
    }, request);

    expect(request.effects).toEqual(["read", "execute"]);
    expect(decision.decision).toBe("allow_once");
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(60_000);
    expect(() => assertApprovalRequest(request)).not.toThrow();
    expect(() => assertApprovalDecision(decision, request)).not.toThrow();
  });

  it("rejects persistent approval, duplicate effects, mismatches, and oversized summaries", () => {
    expect(() => parseApprovalDecision({
      interactionId: "approval-1",
      decision: "always",
      decidedAt: ANSWERED_AT,
    }, APPROVAL_REQUEST)).toThrow("must be one of allow_once, deny");
    expect(() => parseApprovalRequest({
      ...APPROVAL_REQUEST,
      effects: ["read", "read"],
    })).toThrow("must not contain duplicate effects");
    expect(() => parseApprovalRequest({
      ...APPROVAL_REQUEST,
      callId: "call_x|fc_y",
    })).toThrow("approval request.callId contains unsupported characters");
    expect(() => parseApprovalDecision({
      interactionId: "approval-other",
      decision: "deny",
      decidedAt: ANSWERED_AT,
    }, APPROVAL_REQUEST)).toThrow("does not match the request");
    expect(() => parseApprovalRequest({
      ...APPROVAL_REQUEST,
      summary: "é".repeat(
        Math.floor(AGENT_INTERACTION_LIMITS.approvalSummaryBytes / 2) + 1,
      ),
    })).toThrow(
      `must be at most ${String(AGENT_INTERACTION_LIMITS.approvalSummaryBytes)} UTF-8 bytes`,
    );
    expect(() => parseApprovalRequest({
      ...APPROVAL_REQUEST,
      effects: new Array(1),
    })).toThrow(/effects\.0.*required/u);
  });
});

describe("route, artifact, and native tool contracts", () => {
  it("parses route-bound sessions, artifact references, and native authority metadata", () => {
    const route = parseRouteIdentity({
      runtimeInstanceId: "codex-primary",
      model: "gpt-5.6-codex",
    });
    const artifact = parseArtifactRef({
      id: "artifact-1",
      sha256: `sha256:${"a".repeat(64)}`,
      sizeBytes: 4_096,
      mediaType: "application/json",
      fileName: "result.json",
    });
    const tool = parseRuntimeNativeToolDescriptor({
      id: "codex__shell",
      displayName: "Shell",
      effects: ["read", "write", "execute", "network"],
      approval: "runtime-enforced",
      sandbox: "runtime-enforced",
    });
    const session: RuntimeSession = {
      id: "session-1",
      conversationId: "conversation-1",
      route,
    };
    const result: RuntimeToolResult = {
      callId: "call-1",
      content: [{ type: "artifact", ref: artifact, preview: "{\"ok\":true}" }],
    };

    expect(session.route).toEqual(route);
    expect(session.conversationId).toBe("conversation-1");
    expect(result.content[0]?.type).toBe("artifact");
    expect(tool.effects).toHaveLength(4);
    expect(RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES).toBe(16_384);
    expect(() => assertRouteIdentity(route)).not.toThrow();
    expect(() => assertArtifactRef(artifact)).not.toThrow();
    expect(() => assertRuntimeNativeToolDescriptor(tool)).not.toThrow();
  });

  it("rejects ambiguous digests, path-like names, and unsupported authority claims", () => {
    expect(() => parseArtifactRef({
      id: "artifact-1",
      sha256: `sha256:${"A".repeat(64)}`,
      sizeBytes: 1,
      mediaType: "text/plain",
    })).toThrow("must be a lowercase SHA-256 digest");
    expect(() => parseArtifactRef({
      id: "artifact-1",
      sha256: `sha256:${"a".repeat(64)}`,
      sizeBytes: 1,
      mediaType: "text/plain",
      fileName: "../secret",
    })).toThrow("must be a base name");
    expect(() => parseRuntimeNativeToolDescriptor({
      id: "shell",
      displayName: "Shell",
      effects: ["execute"],
      approval: "host-maybe",
      sandbox: "runtime-enforced",
    })).toThrow(
      "must be one of core-callback, runtime-enforced, unsupported",
    );
  });

  it("keeps pure validation on the definition and live preflight on the instance", async () => {
    const definition = defineRuntimeModule({
      manifest: {
        packageName: "@example/runtime",
        packageVersion: "1.0.0",
        apiVersion: 1,
        kind: "runtime",
        responsibility: "Exercises route validation.",
        capabilities: [],
      },
      schema: defineModuleSchema({
        jsonSchema: { type: "object" },
        parse: () => ({ prefix: "example:" }),
      }),
      validateModel({ model, config }) {
        const prefix = (config as { prefix: string }).prefix;
        return { supported: model.startsWith(prefix) };
      },
      create: () => ({
        capabilities: {
          tools: false,
          mcp: false,
          attachments: false,
          approvals: false,
          structuredOutput: false,
          sandbox: false,
          sessions: false,
        },
        preflightModel: async ({ model }) => ({
          supported: model === "example:model",
          diagnostics: [],
        }),
        async runTurn() {
          return {
            status: "completed",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          };
        },
      }),
    });
    const validation = definition.validateModel?.({
      model: "example:model",
      config: { prefix: "example:" },
    });
    const runtime = await definition.create({} as never);
    const preflight = await runtime.preflightModel?.({
      model: "example:model",
      signal: new AbortController().signal,
    });

    expect(validation?.supported).toBe(true);
    expect(preflight?.supported).toBe(true);
  });
});
