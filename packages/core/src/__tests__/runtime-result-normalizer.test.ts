// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  RUNTIME_EVENT_STREAM_MAX_EVENTS,
  RUNTIME_RESULT_MAX_BYTES,
  RUNTIME_RESULT_MAX_FILE_BYTES,
  RUNTIME_RESULT_MAX_MESSAGE_PARTS,
  RUNTIME_RESULT_MAX_METADATA_BYTES,
  RUNTIME_RESULT_MAX_TEXT_BYTES,
  RUNTIME_RESULT_MAX_TOOL_RESULT_PARTS,
  createRuntimeTurnEventBoundary,
  normalizeChannelCapabilities,
  normalizeModuleDiagnostic,
  normalizeRuntimeCapabilities,
  normalizeRuntimeModelValidation,
  normalizeRuntimeToolCall,
  normalizeRuntimeTurnEvent,
  normalizeRuntimeTurnResult,
} from "../runtime-result-normalizer.js";

const SESSION_AUTHORITY = Object.freeze({
  conversationId: "conversation-1",
  route: Object.freeze({
    runtimeInstanceId: "main",
    model: "fixture:model",
  }),
});

const normalizeResult = (value: unknown) =>
  normalizeRuntimeTurnResult(value, SESSION_AUTHORITY);

const normalizeEvent = (
  value: unknown,
  boundary: ReturnType<typeof createRuntimeTurnEventBoundary>,
) => normalizeRuntimeTurnEvent(value, boundary, SESSION_AUTHORITY);

describe("runtime result boundary", () => {
  it("copies a complete valid first-party result without sharing mutable bytes", () => {
    const file = new Uint8Array([1, 2, 3]);
    const value = {
      status: "completed",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "file",
            mediaType: "application/octet-stream",
            data: file,
            name: "result.bin",
          },
          {
            type: "tool-result",
            result: {
              callId: "call-1",
              content: [{ type: "json", value: { ok: true } }],
            },
          },
        ],
      },
      structuredOutput: { ok: true },
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        cost: { currency: "USD", total: 0.01 },
        compaction: { compacted: false },
      },
      session: {
        id: "session-1",
        conversationId: "conversation-1",
        route: { runtimeInstanceId: "main", model: "fixture:model" },
        metadata: { provider: "fixture" },
      },
      metadata: { stopReason: "end_turn" },
    };

    const normalized = normalizeResult(value);
    expect(normalized).toEqual(value);
    file[0] = 99;
    const part = normalized.message?.content[1];
    expect(part?.type === "file" && part.data instanceof Uint8Array
      ? [...part.data]
      : []).toEqual([1, 2, 3]);
  });

  it("enforces intrinsic runtime file lengths and rejects typed-array proxies", () => {
    const completedFile = (data: unknown) => ({
      status: "completed",
      message: {
        role: "assistant",
        content: [{
          type: "file",
          mediaType: "application/octet-stream",
          data,
          name: "result.bin",
        }],
      },
    });
    const oversized = new Uint8Array(RUNTIME_RESULT_MAX_FILE_BYTES + 1);
    Object.defineProperty(oversized, "byteLength", {
      configurable: true,
      value: 0,
    });

    expect(() => normalizeResult(completedFile(oversized))).toThrow(
      new RegExp(`${String(RUNTIME_RESULT_MAX_FILE_BYTES)}-byte boundary`, "u"),
    );
    expect(() => normalizeResult(
      completedFile(new Proxy(new Uint8Array([1, 2, 3]), {})),
    )).toThrow(/stable Uint8Array byte data/u);
  });

  it("requires an exact own-data conversation and route on every private session", () => {
    const resultWithSession = (session: unknown) => ({
      status: "completed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
      session,
    });
    const valid = {
      id: "session-1",
      conversationId: SESSION_AUTHORITY.conversationId,
      route: SESSION_AUTHORITY.route,
    };

    expect(() => normalizeResult(resultWithSession({ id: "legacy-session" })))
      .toThrow(/conversationId.*required/u);
    expect(() => normalizeResult(resultWithSession({
      ...valid,
      runtimeInstanceId: "main",
    }))).toThrow(/unknown key "runtimeInstanceId"/u);
    expect(() => normalizeResult(resultWithSession({
      ...valid,
      conversationId: "other-conversation",
    }))).toThrow(/conversationId.*active conversation/u);
    expect(() => normalizeResult(resultWithSession({
      ...valid,
      route: { runtimeInstanceId: "fallback", model: "fixture:model" },
    }))).toThrow(/route.*active runtime route/u);
    expect(() => normalizeResult(resultWithSession({
      ...valid,
      route: { runtimeInstanceId: "main", model: "fixture:other" },
    }))).toThrow(/route.*active runtime route/u);
    expect(() => normalizeResult(resultWithSession({ ...valid, id: "s".repeat(512) })))
      .not.toThrow();
    expect(() => normalizeResult(resultWithSession({ ...valid, id: "s".repeat(513) })))
      .toThrow(/session\.id.*512-byte boundary/u);

    let conversationReads = 0;
    const accessorSession = {
      id: "session-1",
      route: SESSION_AUTHORITY.route,
      get conversationId() {
        conversationReads += 1;
        return SESSION_AUTHORITY.conversationId;
      },
    };
    expect(() => normalizeResult(resultWithSession(accessorSession)))
      .toThrow(/conversationId.*data property/u);
    expect(conversationReads).toBe(0);

    let routeReads = 0;
    const accessorRoute = {
      get runtimeInstanceId() {
        routeReads += 1;
        return "main";
      },
      model: "fixture:model",
    };
    expect(() => normalizeResult(resultWithSession({
      id: "session-1",
      conversationId: SESSION_AUTHORITY.conversationId,
      route: accessorRoute,
    }))).toThrow(/route\.runtimeInstanceId.*data property/u);
    expect(routeReads).toBe(0);
  });

  it("rejects oversized text, part collections, metadata, files, and whole results", () => {
    const completed = (content: readonly unknown[], metadata?: unknown) => ({
      status: "completed",
      message: { role: "assistant", content },
      ...(metadata === undefined ? {} : { metadata }),
    });
    expect(() => normalizeResult(completed([
      { type: "text", text: "x".repeat(RUNTIME_RESULT_MAX_TEXT_BYTES + 1) },
    ]))).toThrow(/text.*byte boundary/u);
    expect(() => normalizeResult(completed(
      Array.from(
        { length: RUNTIME_RESULT_MAX_MESSAGE_PARTS + 1 },
        () => ({ type: "text", text: "x" }),
      ),
    ))).toThrow(/content.*item boundary/u);
    expect(() => normalizeResult(completed([{
      type: "tool-result",
      result: {
        callId: "call-1",
        content: Array.from(
          { length: RUNTIME_RESULT_MAX_TOOL_RESULT_PARTS + 1 },
          () => ({ type: "text", text: "x" }),
        ),
      },
    }]))).toThrow(/result\.content.*item boundary/u);
    expect(() => normalizeResult(completed(
      [{ type: "text", text: "ok" }],
      { detail: "x".repeat(RUNTIME_RESULT_MAX_METADATA_BYTES + 1) },
    ))).toThrow(/metadata.*byte boundary/u);
    expect(() => normalizeResult(completed([{
      type: "file",
      mediaType: "application/octet-stream",
      data: new Uint8Array(RUNTIME_RESULT_MAX_FILE_BYTES + 1),
      name: "large.bin",
    }]))).toThrow(
      new RegExp(`${String(RUNTIME_RESULT_MAX_FILE_BYTES)}-byte boundary`, "u"),
    );

    const repeated = "x".repeat(RUNTIME_RESULT_MAX_TEXT_BYTES);
    expect(() => normalizeResult(completed(
      Array.from(
        { length: Math.floor(RUNTIME_RESULT_MAX_BYTES / repeated.length) + 1 },
        () => ({ type: "text", text: repeated }),
      ),
    ))).toThrow(/result boundary/u);
  });

  it("rejects unsafe/deep JSON and oversized artifact previews", () => {
    const unsafe = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unsafe, "__proto__", {
      enumerable: true,
      value: "unsafe",
    });
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const result = (value: unknown) => ({
      status: "completed",
      message: {
        role: "assistant",
        content: [{
          type: "tool-result",
          result: { callId: "call-1", content: [{ type: "json", value }] },
        }],
      },
    });
    expect(() => normalizeResult(result(unsafe))).toThrow(/unsafe key/u);
    expect(() => normalizeResult(result(nested))).toThrow(/JSON depth boundary/u);
    expect(() => normalizeResult({
      status: "completed",
      message: {
        role: "assistant",
        content: [{
          type: "tool-result",
          result: {
            callId: "call-1",
            content: [{
              type: "artifact",
              ref: {
                id: "artifact-1",
                sha256: `sha256:${"a".repeat(64)}`,
                sizeBytes: 1,
                mediaType: "text/plain",
              },
              preview: "x".repeat(16_385),
            }],
          },
        }],
      },
    })).toThrow(/preview.*byte boundary/u);
  });

  it("rejects sparse and accessor-backed message or tool-result content", () => {
    const sparse = new Array<unknown>(1);
    expect(() => normalizeResult({
      status: "completed",
      message: { role: "assistant", content: sparse },
    })).toThrow(/content\.0.*required/u);

    let getterCalls = 0;
    const accessorContent = [{ type: "text", text: "safe" }] as unknown[];
    Object.defineProperty(accessorContent, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return { type: "text", text: "unsafe" };
      },
    });
    expect(() => normalizeResult({
      status: "completed",
      message: {
        role: "assistant",
        content: [{
          type: "tool-result",
          result: { callId: "call-1", content: accessorContent },
        }],
      },
    })).toThrow(/content\.0.*data property/u);
    expect(getterCalls).toBe(0);

    let typeReads = 0;
    const changingPart = {
      get type() {
        typeReads += 1;
        return typeReads === 1 ? "not-text" : typeReads === 2 ? "image" : "evil";
      },
      mediaType: "image/png",
      data: "x",
    };
    expect(() => normalizeResult({
      status: "completed",
      message: { role: "assistant", content: [changingPart] },
    })).toThrow(/content(?:\.0|\[0\])\.type.*data property/u);
    expect(typeReads).toBe(0);
  });
});

describe("runtime live boundary", () => {
  it("copies and validates streamed events before exposing them", () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 2,
      compaction: { compacted: false },
    };
    const boundary = createRuntimeTurnEventBoundary();
    const normalized = normalizeEvent({
      type: "usage",
      usage,
    }, boundary);

    usage.inputTokens = 99;
    usage.compaction.compacted = true;
    expect(normalized).toEqual({
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        compaction: { compacted: false },
      },
    });
    expect(boundary).toMatchObject({ events: 1, violation: undefined });
  });

  it("rejects and poisons a session event for another conversation or route", () => {
    const boundary = createRuntimeTurnEventBoundary();
    expect(() => normalizeEvent({
      type: "session",
      session: {
        id: "session-1",
        conversationId: "other-conversation",
        route: SESSION_AUTHORITY.route,
      },
    }, boundary)).toThrow(/conversationId.*active conversation/u);
    expect(boundary.violation).toBeInstanceOf(Error);
    expect(() => normalizeEvent({
      type: "session",
      session: {
        id: "session-1",
        conversationId: SESSION_AUTHORITY.conversationId,
        route: SESSION_AUTHORITY.route,
      },
    }, boundary)).toThrow(/already violated/u);
  });

  it("accepts bounded transient activity and poisons oversized activity", () => {
    const boundary = createRuntimeTurnEventBoundary();
    expect(normalizeEvent({ type: "activity", text: "Transcribed 25%" }, boundary)).toEqual({
      type: "activity",
      text: "Transcribed 25%",
    });
    expect(() => normalizeEvent({
      type: "activity",
      text: "x".repeat(16 * 1024 + 1),
    }, boundary)).toThrow(/text.*byte boundary/u);
    expect(boundary.violation).toBeInstanceOf(Error);
  });

  it("poisons an event stream after a single, cumulative-byte, or count violation", () => {
    const oversized = createRuntimeTurnEventBoundary();
    expect(() => normalizeEvent({
      type: "text-delta",
      delta: "x".repeat(RUNTIME_RESULT_MAX_TEXT_BYTES + 1),
    }, oversized)).toThrow(/delta.*byte boundary/u);
    expect(() => normalizeEvent({
      type: "text-delta",
      delta: "valid",
    }, oversized)).toThrow(/already violated/u);

    const cumulative = createRuntimeTurnEventBoundary();
    const chunk = "x".repeat(RUNTIME_RESULT_MAX_TEXT_BYTES);
    let cumulativeFailure: unknown;
    for (let index = 0; index < 100; index += 1) {
      try {
        normalizeEvent({ type: "text-delta", delta: chunk }, cumulative);
      } catch (error) {
        cumulativeFailure = error;
        break;
      }
    }
    expect(cumulativeFailure).toBeInstanceOf(RangeError);
    expect(cumulativeFailure).toMatchObject({
      message: expect.stringMatching(/cumulative boundary/u),
    });

    const count = createRuntimeTurnEventBoundary();
    for (let index = 0; index < RUNTIME_EVENT_STREAM_MAX_EVENTS; index += 1) {
      normalizeEvent({
        type: "compaction",
        compaction: { compacted: false },
      }, count);
    }
    expect(() => normalizeEvent({
      type: "compaction",
      compaction: { compacted: false },
    }, count)).toThrow(/event boundary/u);
    expect(count.violation).toBeInstanceOf(Error);
  });

  it("strictly copies runtime tool calls before policy or execution", () => {
    const input = { nested: { allowed: true } };
    const normalized = normalizeRuntimeToolCall({
      id: "call-1",
      name: "server__tool",
      input,
    });
    input.nested.allowed = false;
    expect(normalized).toEqual({
      id: "call-1",
      name: "server__tool",
      input: { nested: { allowed: true } },
    });
    expect(() => normalizeRuntimeToolCall({
      id: "call-2",
      name: "server__tool",
      input: { value: "x".repeat(RUNTIME_RESULT_MAX_METADATA_BYTES + 1) },
    })).toThrow(/input.*byte boundary/u);
    expect(() => normalizeRuntimeToolCall({
      id: "call-3",
      name: "server__tool",
      input: {},
      unexpected: true,
    })).toThrow(/unknown key/u);
  });

  it("rejects malformed route-specific capability claims", () => {
    const capabilities = {
      tools: true,
      mcp: true,
      attachments: false,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
      liveInput: false,
    };
    const normalized = normalizeRuntimeModelValidation({
      supported: true,
      capabilities,
      diagnostics: [{
        code: "ready",
        severity: "info",
        message: "ready",
      }],
    });
    capabilities.attachments = true;
    expect(normalized.capabilities?.attachments).toBe(false);
    expect(() => normalizeRuntimeModelValidation({
      supported: true,
      capabilities: { ...capabilities, tools: "yes" },
    })).toThrow(/capabilities\.tools.*boolean/u);
    expect(() => normalizeRuntimeModelValidation({
      supported: true,
      capabilities,
      unexpected: true,
    })).toThrow(/unknown key/u);
  });
});

describe("channel capability boundary", () => {
  it("returns a detached exact-key boolean snapshot", () => {
    const capabilities = {
      attachments: false,
      liveInput: false,
      askUser: true,
      approvals: true,
      proactive: false,
      runtimeControl: false,
      verbatim: false,
      cancellation: true,
    };

    const normalized = normalizeChannelCapabilities(capabilities);
    capabilities.askUser = false;
    capabilities.approvals = false;

    expect(normalized).toEqual({
      attachments: false,
      liveInput: false,
      askUser: true,
      approvals: true,
      proactive: false,
      runtimeControl: false,
      verbatim: false,
      cancellation: true,
    });
    expect(normalized).not.toBe(capabilities);

    const { approvals: _legacyOmitted, ...legacy } = capabilities;
    void _legacyOmitted;
    expect(normalizeChannelCapabilities(legacy).approvals).toBe(false);
  });

  it("rejects missing, extra, non-boolean, accessor, symbol, and cyclic claims", () => {
    const valid = () => ({
      attachments: false,
      liveInput: false,
      askUser: false,
      approvals: false,
      proactive: false,
      runtimeControl: false,
      verbatim: false,
      cancellation: false,
    });

    const missing = valid() as Partial<ReturnType<typeof valid>>;
    delete missing.askUser;
    expect(() => normalizeChannelCapabilities(missing)).toThrow(/askUser.*required/u);

    expect(() => normalizeChannelCapabilities({
      ...valid(),
      unexpected: false,
    })).toThrow(/unknown key/u);

    expect(() => normalizeChannelCapabilities({
      ...valid(),
      approvals: "false",
    })).toThrow(/approvals.*boolean/u);

    let getterCalls = 0;
    const accessor = valid();
    Object.defineProperty(accessor, "askUser", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    expect(() => normalizeChannelCapabilities(accessor)).toThrow(/askUser.*data property/u);
    expect(getterCalls).toBe(0);

    const symbol = valid() as ReturnType<typeof valid> & Record<symbol, boolean>;
    symbol[Symbol("unexpected")] = false;
    expect(() => normalizeChannelCapabilities(symbol)).toThrow(/symbol key/u);

    const cyclic = valid() as Record<string, unknown>;
    cyclic.askUser = cyclic;
    expect(() => normalizeChannelCapabilities(cyclic)).toThrow(/askUser.*boolean/u);
  });
});

describe("runtime capability boundary", () => {
  const validCapabilities = () => ({
    tools: true,
    mcp: true,
    attachments: true,
    approvals: true,
    structuredOutput: true,
    sandbox: true,
    sessions: true,
    liveInput: false,
  });

  it("returns a detached exact-key capability snapshot", () => {
    const capabilities = validCapabilities();
    const normalized = normalizeRuntimeCapabilities(capabilities);
    capabilities.attachments = false;
    capabilities.liveInput = true;

    expect(normalized).toEqual({
      tools: true,
      mcp: true,
      attachments: true,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
      artifactResults: false,
      liveInput: false,
      maxTurns: false,
      maxOutputTokens: false,
    });
    expect(normalized).not.toBe(capabilities);
    expect(normalizeRuntimeCapabilities({
      ...validCapabilities(),
      artifactResults: true,
    })).toMatchObject({ artifactResults: true });
    expect(() => normalizeRuntimeCapabilities({
      ...validCapabilities(),
      artifactResults: "yes",
    })).toThrow(/artifactResults.*boolean/u);
  });

  it("rejects accessors, inherited claims, and hidden extra authority without reading them", () => {
    let getterCalls = 0;
    const accessor = validCapabilities();
    Object.defineProperty(accessor, "tools", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    expect(() => normalizeRuntimeCapabilities(accessor)).toThrow(/tools.*data property/u);
    expect(getterCalls).toBe(0);

    let optionalGetterCalls = 0;
    const optionalAccessor = validCapabilities();
    Object.defineProperty(optionalAccessor, "liveInput", {
      enumerable: true,
      get() {
        optionalGetterCalls += 1;
        return true;
      },
    });
    expect(() => normalizeRuntimeCapabilities(optionalAccessor))
      .toThrow(/liveInput.*data property/u);
    expect(optionalGetterCalls).toBe(0);

    expect(() => normalizeRuntimeCapabilities(Object.create(validCapabilities())))
      .toThrow(/plain object/u);

    const hiddenExtra = validCapabilities();
    Object.defineProperty(hiddenExtra, "unexpected", {
      enumerable: false,
      value: true,
    });
    expect(() => normalizeRuntimeCapabilities(hiddenExtra)).toThrow(/unknown key/u);
  });
});

describe("runtime model validation boundary", () => {
  it("normalizes standalone module diagnostics without invoking accessors", () => {
    const path = ["module", "runtime"];
    const normalized = normalizeModuleDiagnostic({
      code: "runtime_unavailable",
      severity: "warning",
      message: "Runtime is temporarily unavailable",
      path,
    }, "module health diagnostic");

    path[0] = "mutated";
    expect(normalized).toEqual({
      code: "runtime_unavailable",
      severity: "warning",
      message: "Runtime is temporarily unavailable",
      path: ["module", "runtime"],
    });

    let reads = 0;
    const hostile = Object.defineProperty({
      code: "runtime_unavailable",
      severity: "warning",
      path: [],
    }, "message", {
      enumerable: true,
      get() {
        reads += 1;
        return "unsafe";
      },
    });
    expect(() => normalizeModuleDiagnostic(hostile))
      .toThrow(/data property/u);
    expect(reads).toBe(0);
  });

  it("does not invoke accessors in the envelope or any normalized child", () => {
    const cases: readonly (() => {
      readonly value: unknown;
      readonly calls: () => number;
    })[] = [
      () => {
        let calls = 0;
        const value = {};
        Object.defineProperty(value, "supported", {
          enumerable: true,
          get() {
            calls += 1;
            return true;
          },
        });
        return { value, calls: () => calls };
      },
      () => {
        let calls = 0;
        const value = { supported: true };
        Object.defineProperty(value, "capabilities", {
          enumerable: true,
          get() {
            calls += 1;
            return {};
          },
        });
        return { value, calls: () => calls };
      },
      () => {
        let calls = 0;
        const capabilities = {
          tools: true,
          mcp: true,
          attachments: true,
          approvals: true,
          structuredOutput: true,
          sandbox: true,
          sessions: true,
        };
        Object.defineProperty(capabilities, "attachments", {
          enumerable: true,
          get() {
            calls += 1;
            return true;
          },
        });
        return {
          value: { supported: true, capabilities },
          calls: () => calls,
        };
      },
      () => {
        let calls = 0;
        const nativeTools: unknown[] = [];
        Object.defineProperty(nativeTools, "0", {
          enumerable: true,
          get() {
            calls += 1;
            return {};
          },
        });
        return {
          value: { supported: true, nativeTools },
          calls: () => calls,
        };
      },
      () => {
        let calls = 0;
        const descriptor = {
          displayName: "Tool",
          effects: ["read"],
          approval: "core-callback",
          sandbox: "core-executor",
        };
        Object.defineProperty(descriptor, "id", {
          enumerable: true,
          get() {
            calls += 1;
            return "tool";
          },
        });
        return {
          value: { supported: true, nativeTools: [descriptor] },
          calls: () => calls,
        };
      },
      () => {
        let calls = 0;
        const diagnostic = {
          code: "hostile",
          severity: "warning",
        };
        Object.defineProperty(diagnostic, "message", {
          enumerable: true,
          get() {
            calls += 1;
            return "hostile";
          },
        });
        return {
          value: { supported: true, diagnostics: [diagnostic] },
          calls: () => calls,
        };
      },
    ];

    for (const create of cases) {
      const testCase = create();
      expect(() => normalizeRuntimeModelValidation(testCase.value))
        .toThrow(/data property/u);
      expect(testCase.calls()).toBe(0);
    }
  });

  it("rejects prototype-provided fields and non-enumerable extra result fields", () => {
    expect(() => normalizeRuntimeModelValidation(Object.create({ supported: true })))
      .toThrow(/plain object/u);

    const result = { supported: true };
    Object.defineProperty(result, "unexpected", {
      enumerable: false,
      value: true,
    });
    expect(() => normalizeRuntimeModelValidation(result)).toThrow(/unknown key/u);

    const inheritedCapabilities = Object.create({
      tools: true,
      mcp: true,
      attachments: true,
      approvals: true,
      structuredOutput: true,
      sandbox: true,
      sessions: true,
    });
    expect(() => normalizeRuntimeModelValidation({
      supported: true,
      capabilities: inheritedCapabilities,
    })).toThrow(/plain object/u);
  });
});
