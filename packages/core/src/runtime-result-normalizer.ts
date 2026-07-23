import {
  RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES,
  parseArtifactRef,
  parseRuntimeNativeToolDescriptor,
  type ArtifactRef,
  type ChannelCapabilities,
  type JsonObject,
  type JsonValue,
  type ModuleDiagnostic,
  type NormalizedAttachment,
  type RuntimeCompaction,
  type RuntimeCapabilities,
  type RuntimeModelValidation,
  type RuntimeNativeToolDescriptor,
  type RuntimeSession,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeToolResultPart,
  type RuntimeTurnEvent,
  type RuntimeTurnResult,
  type RuntimeUsage,
  type RuntimeUsageCost,
  type TurnContentPart,
  type TurnMessage,
} from "@mono-agent/module-sdk";

export const RUNTIME_RESULT_MAX_BYTES = 64 * 1024 * 1024;
export const RUNTIME_RESULT_MAX_ITEMS = 20_000;
export const RUNTIME_RESULT_MAX_MESSAGE_PARTS = 256;
export const RUNTIME_RESULT_MAX_TOOL_RESULT_PARTS = 128;
export const RUNTIME_RESULT_MAX_JSON_DEPTH = 32;
export const RUNTIME_RESULT_MAX_JSON_ITEMS = 10_000;
export const RUNTIME_RESULT_MAX_TEXT_BYTES = 1024 * 1024;
export const RUNTIME_RESULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
export const RUNTIME_RESULT_MAX_METADATA_BYTES = 256 * 1024;
export const RUNTIME_RESULT_MAX_STRUCTURED_OUTPUT_BYTES = 4 * 1024 * 1024;
export const RUNTIME_EVENT_MAX_BYTES = 32 * 1024 * 1024;
export const RUNTIME_EVENT_STREAM_MAX_BYTES = 64 * 1024 * 1024;
export const RUNTIME_EVENT_STREAM_MAX_EVENTS = 20_000;
export const RUNTIME_MODEL_VALIDATION_MAX_BYTES = 1024 * 1024;
export const RUNTIME_MODEL_VALIDATION_MAX_ITEMS = 128;
export const RUNTIME_TOOL_CALL_MAX_BYTES = 512 * 1024;
export const RUNTIME_CAPABILITIES_MAX_BYTES = 1024;

const MAX_IDENTIFIER_BYTES = 4_096;
const MAX_MEDIA_TYPE_BYTES = 255;
const MAX_FILE_NAME_BYTES = 255;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_PATH_SEGMENTS = 64;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu;

interface BoundaryState {
  readonly active: Set<object>;
  readonly boundaryLabel: string;
  readonly maxBytes: number;
  bytes: number;
  fileBytes: number;
  items: number;
  jsonItems: number;
}

export interface RuntimeTurnEventBoundary {
  bytes: number;
  events: number;
  violation: Error | undefined;
}

export function createRuntimeTurnEventBoundary(): RuntimeTurnEventBoundary {
  return {
    bytes: 0,
    events: 0,
    violation: undefined,
  };
}

/**
 * Copy and validate one result returned across the public open-runtime seam.
 * The returned graph shares no mutable byte arrays or objects with the runtime.
 */
export function normalizeRuntimeTurnResult(value: unknown): RuntimeTurnResult {
  const state = boundaryState(RUNTIME_RESULT_MAX_BYTES, "result");
  const result = record(value, "runtime turn result");
  assertKeys(
    result,
    ["status", "message", "structuredOutput", "usage", "session", "metadata"],
    "runtime turn result",
  );
  const status = enumValue(
    result.status,
    ["completed", "cancelled", "max-turns"] as const,
    "runtime turn result.status",
    state,
  );
  const message = result.message === undefined
    ? undefined
    : normalizeTurnMessage(result.message, state, "runtime turn result.message");
  if (status === "completed" && message === undefined) {
    fail("runtime turn result.message", "is required for a completed result");
  }
  if (status !== "completed" && result.structuredOutput !== undefined) {
    fail("runtime turn result.structuredOutput", "is only valid for a completed result");
  }
  const structuredOutput = result.structuredOutput === undefined
    ? undefined
    : normalizeBoundedJson(
      result.structuredOutput,
      state,
      "runtime turn result.structuredOutput",
      RUNTIME_RESULT_MAX_STRUCTURED_OUTPUT_BYTES,
    );
  const usage = result.usage === undefined
    ? undefined
    : normalizeUsage(result.usage, state);
  const session = result.session === undefined
    ? undefined
    : normalizeSession(result.session, state);
  const metadata = result.metadata === undefined
    ? undefined
    : normalizeBoundedJsonObject(
      result.metadata,
      state,
      "runtime turn result.metadata",
      RUNTIME_RESULT_MAX_METADATA_BYTES,
    );

  charge(state, 32, "runtime turn result");
  if (status === "completed") {
    return {
      status,
      message: message!,
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      ...(usage === undefined ? {} : { usage }),
      ...(session === undefined ? {} : { session }),
      ...(metadata === undefined ? {} : { metadata }),
    };
  }
  return {
    status,
    ...(message === undefined ? {} : { message }),
    ...(usage === undefined ? {} : { usage }),
    ...(session === undefined ? {} : { session }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/**
 * Copy and validate one event before it crosses from an open runtime into Core.
 * The supplied boundary is attempt-scoped. Any violation poisons it permanently,
 * including when a runtime catches the rejection and continues.
 */
export function normalizeRuntimeTurnEvent(
  value: unknown,
  boundary: RuntimeTurnEventBoundary,
): RuntimeTurnEvent {
  if (boundary.violation !== undefined) {
    throw new TypeError("runtime event stream boundary was already violated", {
      cause: boundary.violation,
    });
  }
  if (boundary.events >= RUNTIME_EVENT_STREAM_MAX_EVENTS) {
    const error = new RangeError(
      `runtime event stream exceeds the ${RUNTIME_EVENT_STREAM_MAX_EVENTS}-event boundary`,
    );
    boundary.violation = error;
    throw error;
  }

  try {
    const state = boundaryState(RUNTIME_EVENT_MAX_BYTES, "event");
    const event = normalizeTurnEvent(value, state);
    if (boundary.bytes + state.bytes > RUNTIME_EVENT_STREAM_MAX_BYTES) {
      throw new RangeError(
        `runtime event stream exceeds the ${RUNTIME_EVENT_STREAM_MAX_BYTES}-byte cumulative boundary`,
      );
    }
    boundary.events += 1;
    boundary.bytes += state.bytes;
    return event;
  } catch (error) {
    const violation = error instanceof Error
      ? error
      : new TypeError("runtime event stream boundary was violated");
    boundary.violation = violation;
    throw violation;
  }
}

export function assertRuntimeTurnEventBoundaryHealthy(
  boundary: RuntimeTurnEventBoundary,
): void {
  if (boundary.violation !== undefined) {
    throw new TypeError("runtime event stream boundary was violated", {
      cause: boundary.violation,
    });
  }
}

/** Copy and validate a runtime-originated tool call before policy or execution. */
export function normalizeRuntimeToolCall(value: unknown): RuntimeToolCall {
  const state = boundaryState(RUNTIME_TOOL_CALL_MAX_BYTES, "tool-call");
  const call = normalizeToolCall(value, state, "runtime tool call");
  charge(state, 16, "runtime tool call");
  return call;
}

/** Copy one immutable routing authority snapshot from a created runtime. */
export function normalizeRuntimeCapabilities(
  value: unknown,
  path = "runtime capabilities",
): RuntimeCapabilities {
  return normalizeRuntimeCapabilitiesValue(
    value,
    boundaryState(RUNTIME_CAPABILITIES_MAX_BYTES, "capabilities"),
    path,
  );
}

/** Copy and validate the exact authority claims exposed by an open channel. */
export function normalizeChannelCapabilities(
  value: unknown,
  path = "channel capabilities",
): ChannelCapabilities {
  const input = record(value, path);
  const required = [
    "attachments",
    "liveInput",
    "askUser",
    "proactive",
    "runtimeControl",
    "verbatim",
    "cancellation",
  ] as const;
  assertKeys(input, [...required, "approvals"], path);

  const normalized = {} as Record<(typeof required)[number], boolean>;
  for (const key of required) {
    const capability = ownDataProperty(input, key, path, true);
    if (typeof capability !== "boolean") fail(`${path}.${key}`, "must be boolean");
    normalized[key] = capability;
  }

  const approvals = ownDataProperty(input, "approvals", path);
  if (approvals !== undefined && typeof approvals !== "boolean") {
    fail(`${path}.approvals`, "must be boolean");
  }
  return {
    ...normalized,
    approvals: approvals === true,
  };
}

/**
 * Copy and validate the common result shape returned by definition validators,
 * instance validators, and live preflight checks.
 */
export function normalizeRuntimeModelValidation(
  value: unknown,
  path = "runtime model validation",
): RuntimeModelValidation {
  const state = boundaryState(RUNTIME_MODEL_VALIDATION_MAX_BYTES, "model-validation");
  const input = record(value, path);
  assertKeys(input, ["supported", "capabilities", "nativeTools", "diagnostics"], path);
  const supported = ownDataProperty(input, "supported", path, true);
  if (typeof supported !== "boolean") fail(`${path}.supported`, "must be boolean");
  const capabilitiesValue = ownDataProperty(input, "capabilities", path);
  const nativeToolsValue = ownDataProperty(input, "nativeTools", path);
  const diagnosticsValue = ownDataProperty(input, "diagnostics", path);
  const capabilities = capabilitiesValue === undefined
    ? undefined
    : normalizeRuntimeCapabilitiesValue(capabilitiesValue, state, `${path}.capabilities`);
  const nativeToolsInput = nativeToolsValue === undefined
    ? undefined
    : ownDataArray(
      nativeToolsValue,
      `${path}.nativeTools`,
      RUNTIME_MODEL_VALIDATION_MAX_ITEMS,
    );
  const diagnosticsInput = diagnosticsValue === undefined
    ? undefined
    : ownDataArray(
      diagnosticsValue,
      `${path}.diagnostics`,
      RUNTIME_MODEL_VALIDATION_MAX_ITEMS,
  );
  const nativeTools = nativeToolsInput?.map((descriptor, index) => {
    const detached = detachRuntimeNativeToolDescriptor(
      descriptor,
      `${path}.nativeTools[${index}]`,
    );
    let parsed: RuntimeNativeToolDescriptor;
    try {
      parsed = parseRuntimeNativeToolDescriptor(detached);
    } catch (error) {
      throw new TypeError(`${path}.nativeTools[${index}] is invalid`, { cause: error });
    }
    charge(
      state,
      utf8Bytes(parsed.id)
        + utf8Bytes(parsed.displayName)
        + parsed.effects.reduce((bytes, effect) => bytes + utf8Bytes(effect), 0)
        + utf8Bytes(parsed.approval)
        + utf8Bytes(parsed.sandbox)
        + 32,
      `${path}.nativeTools[${index}]`,
    );
    return parsed;
  });
  const diagnostics = diagnosticsInput?.map((diagnostic, index) =>
    normalizeDiagnostic(diagnostic, state, `${path}.diagnostics[${index}]`));
  addItems(
    state,
    (nativeTools?.length ?? 0) + (diagnostics?.length ?? 0),
    path,
    false,
  );
  charge(state, 16, path);
  return {
    supported,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(nativeTools === undefined ? {} : { nativeTools }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function normalizeTurnEvent(
  value: unknown,
  state: BoundaryState,
): RuntimeTurnEvent {
  const path = "runtime turn event";
  const input = record(value, path);
  const type = enumValue(
    input.type,
    [
      "text-delta",
      "thinking-delta",
      "tool-call",
      "tool-result",
      "usage",
      "diagnostic",
      "session",
      "compaction",
    ] as const,
    `${path}.type`,
    state,
  );
  if (type === "text-delta" || type === "thinking-delta") {
    assertKeys(input, ["type", "delta"], path);
    return {
      type,
      delta: text(
        input.delta,
        `${path}.delta`,
        RUNTIME_RESULT_MAX_TEXT_BYTES,
        state,
        true,
      ),
    };
  }
  if (type === "tool-call") {
    assertKeys(input, ["type", "call"], path);
    return {
      type,
      call: normalizeToolCall(input.call, state, `${path}.call`),
    };
  }
  if (type === "tool-result") {
    assertKeys(input, ["type", "result"], path);
    return {
      type,
      result: normalizeToolResult(input.result, state, `${path}.result`),
    };
  }
  if (type === "usage") {
    assertKeys(input, ["type", "usage"], path);
    return {
      type,
      usage: normalizeUsage(input.usage, state, `${path}.usage`),
    };
  }
  if (type === "diagnostic") {
    assertKeys(input, ["type", "diagnostic"], path);
    return {
      type,
      diagnostic: normalizeDiagnostic(input.diagnostic, state, `${path}.diagnostic`),
    };
  }
  if (type === "session") {
    assertKeys(input, ["type", "session"], path);
    return {
      type,
      session: normalizeSession(input.session, state, `${path}.session`),
    };
  }
  assertKeys(input, ["type", "compaction"], path);
  return {
    type,
    compaction: normalizeCompaction(input.compaction, state, `${path}.compaction`),
  };
}

function normalizeRuntimeCapabilitiesValue(
  value: unknown,
  state: BoundaryState,
  path: string,
): RuntimeCapabilities {
  const input = record(value, path);
  const required = [
    "tools",
    "mcp",
    "attachments",
    "approvals",
    "structuredOutput",
    "sandbox",
    "sessions",
  ] as const;
  assertKeys(input, [...required, "artifactResults", "liveInput"], path);
  const normalized = {} as Record<(typeof required)[number], boolean>;
  for (const key of required) {
    const capability = ownDataProperty(input, key, path, true);
    if (typeof capability !== "boolean") fail(`${path}.${key}`, "must be boolean");
    normalized[key] = capability;
  }
  const artifactResults = ownDataProperty(input, "artifactResults", path);
  if (artifactResults !== undefined && typeof artifactResults !== "boolean") {
    fail(`${path}.artifactResults`, "must be boolean when present");
  }
  const liveInput = ownDataProperty(input, "liveInput", path);
  if (liveInput !== undefined && typeof liveInput !== "boolean") {
    fail(`${path}.liveInput`, "must be boolean when present");
  }
  charge(state, 64, path);
  return {
    ...normalized,
    artifactResults: artifactResults === true,
    ...(liveInput === undefined ? {} : { liveInput }),
  };
}

function normalizeDiagnostic(
  value: unknown,
  state: BoundaryState,
  path: string,
): ModuleDiagnostic {
  const input = record(value, path);
  assertKeys(input, ["code", "severity", "message", "path", "hint"], path);
  const code = ownDataProperty(input, "code", path, true);
  const severity = ownDataProperty(input, "severity", path, true);
  const message = ownDataProperty(input, "message", path, true);
  const diagnosticPathValue = ownDataProperty(input, "path", path);
  const hint = ownDataProperty(input, "hint", path);
  const diagnosticPathInput = diagnosticPathValue === undefined
    ? undefined
    : ownDataArray(diagnosticPathValue, `${path}.path`, MAX_DIAGNOSTIC_PATH_SEGMENTS);
  const diagnosticPath = diagnosticPathInput?.map((segment, index) => {
    if (typeof segment === "string") {
      return text(segment, `${path}.path[${index}]`, MAX_IDENTIFIER_BYTES, state);
    }
    if (typeof segment === "number" && Number.isSafeInteger(segment)) {
      charge(state, 16, `${path}.path[${index}]`);
      return segment;
    }
    return fail(`${path}.path[${index}]`, "must be a string or safe integer");
  });
  if (diagnosticPath !== undefined) {
    addItems(state, diagnosticPath.length, `${path}.path`, false);
  }
  return {
    code: text(code, `${path}.code`, MAX_IDENTIFIER_BYTES, state),
    severity: enumValue(
      severity,
      ["info", "warning", "error"] as const,
      `${path}.severity`,
      state,
    ),
    message: text(
      message,
      `${path}.message`,
      MAX_DIAGNOSTIC_MESSAGE_BYTES,
      state,
    ),
    ...(diagnosticPath === undefined ? {} : { path: diagnosticPath }),
    ...(hint === undefined
      ? {}
      : {
          hint: text(
            hint,
            `${path}.hint`,
            MAX_DIAGNOSTIC_MESSAGE_BYTES,
            state,
            true,
          ),
        }),
  };
}

function normalizeTurnMessage(
  value: unknown,
  state: BoundaryState,
  path: string,
): TurnMessage {
  const input = record(value, path);
  assertKeys(input, ["id", "role", "content", "name", "createdAt"], path);
  const role = enumValue(
    input.role,
    ["system", "user", "assistant", "tool"] as const,
    `${path}.role`,
    state,
  );
  const contentInput = ownDataArray(
    input.content,
    `${path}.content`,
    RUNTIME_RESULT_MAX_MESSAGE_PARTS,
  );
  addItems(state, contentInput.length, `${path}.content`, false);
  const content = contentInput.map((part, index) =>
    normalizeContentPart(part, state, `${path}.content[${index}]`));
  return {
    ...(input.id === undefined
      ? {}
      : { id: text(input.id, `${path}.id`, MAX_IDENTIFIER_BYTES, state, true) }),
    role,
    content,
    ...(input.name === undefined
      ? {}
      : { name: text(input.name, `${path}.name`, MAX_IDENTIFIER_BYTES, state, true) }),
    ...(input.createdAt === undefined
      ? {}
      : {
          createdAt: text(
            input.createdAt,
            `${path}.createdAt`,
            MAX_IDENTIFIER_BYTES,
            state,
            true,
          ),
        }),
  };
}

function normalizeContentPart(
  value: unknown,
  state: BoundaryState,
  path: string,
): TurnContentPart {
  const input = record(value, path);
  if (input.type === "text") {
    assertKeys(input, ["type", "text"], path);
    return {
      type: "text",
      text: text(input.text, `${path}.text`, RUNTIME_RESULT_MAX_TEXT_BYTES, state),
    };
  }
  if (input.type === "image" || input.type === "file") {
    const type = input.type;
    assertKeys(input, ["type", "mediaType", "data", "name"], path);
    const data = fileData(input.data, `${path}.data`, state);
    const mediaType = mediaTypeValue(input.mediaType, `${path}.mediaType`, state);
    if (type === "file" && input.name === undefined) {
      fail(`${path}.name`, "is required for a file part");
    }
    const name = input.name === undefined
      ? undefined
      : fileName(input.name, `${path}.name`, state);
    if (type === "file") {
      return {
        type,
        mediaType,
        data,
        name: name!,
      };
    }
    return {
      type,
      mediaType,
      data,
      ...(name === undefined ? {} : { name }),
    };
  }
  if (input.type === "attachment") {
    assertKeys(input, ["type", "attachment"], path);
    return {
      type: "attachment",
      attachment: normalizeAttachment(input.attachment, state, `${path}.attachment`),
    };
  }
  if (input.type === "tool-call") {
    assertKeys(input, ["type", "call"], path);
    return {
      type: "tool-call",
      call: normalizeToolCall(input.call, state, `${path}.call`),
    };
  }
  if (input.type === "tool-result") {
    assertKeys(input, ["type", "result"], path);
    return {
      type: "tool-result",
      result: normalizeToolResult(input.result, state, `${path}.result`),
    };
  }
  fail(`${path}.type`, "is not a supported turn content type");
}

function normalizeAttachment(
  value: unknown,
  state: BoundaryState,
  path: string,
): NormalizedAttachment {
  const input = record(value, path);
  assertKeys(input, ["id", "kind", "name", "mediaType", "sizeBytes", "data"], path);
  const data = fileData(input.data, `${path}.data`, state, true);
  const sizeBytes = nonNegativeSafeInteger(input.sizeBytes, `${path}.sizeBytes`);
  if (sizeBytes !== data.byteLength) {
    fail(`${path}.sizeBytes`, "must equal the attachment byte length");
  }
  return {
    id: text(input.id, `${path}.id`, MAX_IDENTIFIER_BYTES, state),
    kind: enumValue(
      input.kind,
      ["image", "audio", "file"] as const,
      `${path}.kind`,
      state,
    ),
    name: fileName(input.name, `${path}.name`, state),
    mediaType: mediaTypeValue(input.mediaType, `${path}.mediaType`, state),
    sizeBytes,
    data,
  };
}

function normalizeToolCall(
  value: unknown,
  state: BoundaryState,
  path: string,
): RuntimeToolCall {
  const input = record(value, path);
  assertKeys(input, ["id", "name", "input"], path);
  return {
    id: text(input.id, `${path}.id`, MAX_IDENTIFIER_BYTES, state),
    name: text(input.name, `${path}.name`, MAX_IDENTIFIER_BYTES, state),
    input: normalizeBoundedJson(
      input.input,
      state,
      `${path}.input`,
      RUNTIME_RESULT_MAX_METADATA_BYTES,
    ),
  };
}

function normalizeToolResult(
  value: unknown,
  state: BoundaryState,
  path: string,
): RuntimeToolResult {
  const input = record(value, path);
  assertKeys(input, ["callId", "content", "isError"], path);
  const contentInput = ownDataArray(
    input.content,
    `${path}.content`,
    RUNTIME_RESULT_MAX_TOOL_RESULT_PARTS,
  );
  addItems(state, contentInput.length, `${path}.content`, false);
  const content = contentInput.map((part, index) =>
    normalizeToolResultPart(part, state, `${path}.content[${index}]`));
  if (input.isError !== undefined && typeof input.isError !== "boolean") {
    fail(`${path}.isError`, "must be boolean when present");
  }
  return {
    callId: text(input.callId, `${path}.callId`, MAX_IDENTIFIER_BYTES, state),
    content,
    ...(input.isError === undefined ? {} : { isError: input.isError }),
  };
}

function normalizeToolResultPart(
  value: unknown,
  state: BoundaryState,
  path: string,
): RuntimeToolResultPart {
  const input = record(value, path);
  if (input.type === "text") {
    assertKeys(input, ["type", "text"], path);
    return {
      type: "text",
      text: text(input.text, `${path}.text`, RUNTIME_RESULT_MAX_TEXT_BYTES, state),
    };
  }
  if (input.type === "json") {
    assertKeys(input, ["type", "value"], path);
    if (!Object.hasOwn(input, "value")) fail(`${path}.value`, "is required");
    return {
      type: "json",
      value: normalizeBoundedJson(
        input.value,
        state,
        `${path}.value`,
        RUNTIME_RESULT_MAX_STRUCTURED_OUTPUT_BYTES,
      ),
    };
  }
  if (input.type === "file") {
    assertKeys(input, ["type", "mediaType", "data", "name"], path);
    const name = input.name === undefined
      ? undefined
      : fileName(input.name, `${path}.name`, state);
    return {
      type: "file",
      mediaType: mediaTypeValue(input.mediaType, `${path}.mediaType`, state),
      data: fileData(input.data, `${path}.data`, state),
      ...(name === undefined ? {} : { name }),
    };
  }
  if (input.type === "artifact") {
    assertKeys(input, ["type", "ref", "preview"], path);
    let ref: ArtifactRef;
    try {
      ref = parseArtifactRef(input.ref);
    } catch (error) {
      throw new TypeError(`${path}.ref is invalid`, { cause: error });
    }
    chargeArtifactRef(ref, state, `${path}.ref`);
    const preview = input.preview === undefined
      ? undefined
      : text(
        input.preview,
        `${path}.preview`,
        RUNTIME_TOOL_ARTIFACT_PREVIEW_MAX_BYTES,
        state,
        true,
      );
    return {
      type: "artifact",
      ref,
      ...(preview === undefined ? {} : { preview }),
    };
  }
  fail(`${path}.type`, "is not a supported tool-result content type");
}

function normalizeSession(
  value: unknown,
  state: BoundaryState,
  path = "runtime turn result.session",
): RuntimeSession {
  const input = record(value, path);
  assertKeys(
    input,
    [
      "id",
      "route",
      "runtimeInstanceId",
      "provider",
      "model",
      "createdAt",
      "expiresAt",
      "metadata",
    ],
    path,
  );
  const route = input.route === undefined
    ? undefined
    : normalizeRoute(input.route, state, `${path}.route`);
  const metadata = input.metadata === undefined
    ? undefined
    : normalizeBoundedJsonObject(
      input.metadata,
      state,
      `${path}.metadata`,
      RUNTIME_RESULT_MAX_METADATA_BYTES,
    );
  return {
    id: text(input.id, `${path}.id`, MAX_IDENTIFIER_BYTES, state),
    ...(route === undefined ? {} : { route }),
    ...(input.runtimeInstanceId === undefined
      ? {}
      : {
          runtimeInstanceId: text(
            input.runtimeInstanceId,
            `${path}.runtimeInstanceId`,
            MAX_IDENTIFIER_BYTES,
            state,
          ),
        }),
    ...(input.provider === undefined
      ? {}
      : {
          provider: text(
            input.provider,
            `${path}.provider`,
            MAX_IDENTIFIER_BYTES,
            state,
            true,
          ),
        }),
    ...(input.model === undefined
      ? {}
      : { model: text(input.model, `${path}.model`, MAX_IDENTIFIER_BYTES, state) }),
    ...(input.createdAt === undefined
      ? {}
      : {
          createdAt: text(
            input.createdAt,
            `${path}.createdAt`,
            MAX_IDENTIFIER_BYTES,
            state,
            true,
          ),
        }),
    ...(input.expiresAt === undefined
      ? {}
      : {
          expiresAt: text(
            input.expiresAt,
            `${path}.expiresAt`,
            MAX_IDENTIFIER_BYTES,
            state,
            true,
          ),
        }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function normalizeRoute(
  value: unknown,
  state: BoundaryState,
  path: string,
): { readonly runtimeInstanceId: string; readonly model: string } {
  const input = record(value, path);
  assertKeys(input, ["runtimeInstanceId", "model"], path);
  return {
    runtimeInstanceId: text(
      input.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
      MAX_IDENTIFIER_BYTES,
      state,
    ),
    model: text(input.model, `${path}.model`, MAX_IDENTIFIER_BYTES, state),
  };
}

function normalizeUsage(
  value: unknown,
  state: BoundaryState,
  path = "runtime turn result.usage",
): RuntimeUsage {
  const input = record(value, path);
  assertKeys(
    input,
    [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "contextWindow",
      "contextUsed",
      "cost",
      "compaction",
      "sessionEvicted",
    ],
    path,
  );
  const optionalNumbers = [
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "contextWindow",
    "contextUsed",
  ] as const;
  const output: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    contextWindow?: number;
    contextUsed?: number;
    cost?: RuntimeUsageCost;
    compaction?: RuntimeCompaction;
    sessionEvicted?: boolean;
  } = {
    inputTokens: nonNegativeFiniteNumber(input.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeFiniteNumber(input.outputTokens, `${path}.outputTokens`),
  };
  for (const key of optionalNumbers) {
    const candidate = input[key];
    if (candidate !== undefined) output[key] = nonNegativeFiniteNumber(candidate, `${path}.${key}`);
  }
  if (input.sessionEvicted !== undefined) {
    if (typeof input.sessionEvicted !== "boolean") {
      fail(`${path}.sessionEvicted`, "must be boolean when present");
    }
    output.sessionEvicted = input.sessionEvicted;
  }
  if (input.cost !== undefined) {
    output.cost = normalizeUsageCost(input.cost, state, `${path}.cost`);
  }
  if (input.compaction !== undefined) {
    output.compaction = normalizeCompaction(input.compaction, state, `${path}.compaction`);
  }
  charge(state, 128, path);
  return output;
}

function normalizeUsageCost(
  value: unknown,
  state: BoundaryState,
  path = "runtime turn result.usage.cost",
): RuntimeUsageCost {
  const input = record(value, path);
  assertKeys(input, ["currency", "input", "output", "cacheRead", "cacheWrite", "total"], path);
  if (input.currency !== "USD") fail(`${path}.currency`, "must be USD");
  const output: {
    currency: "USD";
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  } = {
    currency: "USD",
    total: nonNegativeFiniteNumber(input.total, `${path}.total`),
  };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const candidate = input[key];
    if (candidate !== undefined) output[key] = nonNegativeFiniteNumber(candidate, `${path}.${key}`);
  }
  charge(state, 64, path);
  return output;
}

function normalizeCompaction(
  value: unknown,
  state: BoundaryState,
  path = "runtime turn result.usage.compaction",
): RuntimeCompaction {
  const input = record(value, path);
  assertKeys(
    input,
    ["compacted", "tokensBefore", "tokensAfter", "summaryTokens", "firstRetainedMessageId"],
    path,
  );
  if (typeof input.compacted !== "boolean") fail(`${path}.compacted`, "must be boolean");
  const output: {
    compacted: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
    summaryTokens?: number;
    firstRetainedMessageId?: string;
  } = { compacted: input.compacted };
  for (const key of ["tokensBefore", "tokensAfter", "summaryTokens"] as const) {
    const candidate = input[key];
    if (candidate !== undefined) output[key] = nonNegativeFiniteNumber(candidate, `${path}.${key}`);
  }
  if (input.firstRetainedMessageId !== undefined) {
    output.firstRetainedMessageId = text(
      input.firstRetainedMessageId,
      `${path}.firstRetainedMessageId`,
      MAX_IDENTIFIER_BYTES,
      state,
    );
  }
  charge(state, 64, path);
  return output;
}

function normalizeBoundedJsonObject(
  value: unknown,
  state: BoundaryState,
  path: string,
  maxBytes: number,
): JsonObject {
  const normalized = normalizeBoundedJson(value, state, path, maxBytes);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    fail(path, "must be a JSON object");
  }
  return normalized as JsonObject;
}

function normalizeBoundedJson(
  value: unknown,
  state: BoundaryState,
  path: string,
  maxBytes: number,
): JsonValue {
  const startBytes = state.bytes;
  const startJsonItems = state.jsonItems;
  const normalized = normalizeJson(value, state, path, 0);
  if (state.bytes - startBytes > maxBytes) {
    fail(path, `exceeds the ${maxBytes}-byte boundary`);
  }
  if (state.jsonItems - startJsonItems > RUNTIME_RESULT_MAX_JSON_ITEMS) {
    fail(path, `exceeds the ${RUNTIME_RESULT_MAX_JSON_ITEMS}-item JSON boundary`);
  }
  return normalized;
}

function normalizeJson(
  value: unknown,
  state: BoundaryState,
  path: string,
  depth: number,
): JsonValue {
  if (value === null || typeof value === "boolean") {
    charge(state, 8, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite JSON numbers");
    charge(state, 16, path);
    return value;
  }
  if (typeof value === "string") {
    charge(state, utf8Bytes(value), path);
    return value;
  }
  if (depth >= RUNTIME_RESULT_MAX_JSON_DEPTH) {
    fail(path, `exceeds the JSON depth boundary of ${RUNTIME_RESULT_MAX_JSON_DEPTH}`);
  }
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) {
    fail(path, "must contain only JSON values");
  }
  if (state.active.has(value)) fail(path, "must not contain cycles");
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = ownDataArray(value, path, RUNTIME_RESULT_MAX_JSON_ITEMS);
      addItems(state, entries.length, path, true);
      return entries.map((entry, index) =>
        normalizeJson(entry, state, `${path}[${index}]`, depth + 1));
    }
    const input = record(value, path);
    const entries = Object.entries(input);
    addItems(state, entries.length, path, true);
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of entries) {
      if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
      charge(state, utf8Bytes(key), path);
      output[key] = normalizeJson(entry, state, `${path}.${key}`, depth + 1);
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function fileData(
  value: unknown,
  path: string,
  state: BoundaryState,
  requireBytes: true,
): Uint8Array;
function fileData(
  value: unknown,
  path: string,
  state: BoundaryState,
  requireBytes?: false,
): Uint8Array | string;
function fileData(
  value: unknown,
  path: string,
  state: BoundaryState,
  requireBytes = false,
): Uint8Array | string {
  if (value instanceof Uint8Array) {
    if (value.byteLength > RUNTIME_RESULT_MAX_FILE_BYTES) {
      fail(path, `exceeds the ${RUNTIME_RESULT_MAX_FILE_BYTES}-byte file boundary`);
    }
    state.fileBytes += value.byteLength;
    if (state.fileBytes > RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES) {
      fail(path, `exceeds the ${RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES}-byte total file boundary`);
    }
    charge(state, value.byteLength, path);
    return new Uint8Array(value);
  }
  if (!requireBytes && typeof value === "string") {
    const bytes = utf8Bytes(value);
    if (bytes > RUNTIME_RESULT_MAX_FILE_BYTES) {
      fail(path, `exceeds the ${RUNTIME_RESULT_MAX_FILE_BYTES}-byte file boundary`);
    }
    state.fileBytes += bytes;
    if (state.fileBytes > RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES) {
      fail(path, `exceeds the ${RUNTIME_RESULT_MAX_TOTAL_FILE_BYTES}-byte total file boundary`);
    }
    charge(state, bytes, path);
    return value;
  }
  fail(path, requireBytes ? "must be a Uint8Array" : "must be a string or Uint8Array");
}

function chargeArtifactRef(ref: ArtifactRef, state: BoundaryState, path: string): void {
  charge(
    state,
    utf8Bytes(ref.id)
      + utf8Bytes(ref.sha256)
      + utf8Bytes(ref.mediaType)
      + (ref.fileName === undefined ? 0 : utf8Bytes(ref.fileName))
      + 32,
    path,
  );
}

function mediaTypeValue(value: unknown, path: string, state: BoundaryState): string {
  const mediaType = text(value, path, MAX_MEDIA_TYPE_BYTES, state);
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) fail(path, "must be a bounded IANA media type");
  return mediaType;
}

function fileName(value: unknown, path: string, state: BoundaryState): string {
  const name = text(value, path, MAX_FILE_NAME_BYTES, state);
  if (
    name === "."
    || name === ".."
    || /[/\\\u0000-\u001f\u007f]/u.test(name)
  ) {
    fail(path, "must be a path-free display name");
  }
  return name;
}

function text(
  value: unknown,
  path: string,
  maxBytes: number,
  state: BoundaryState,
  allowEmpty = false,
): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (!allowEmpty && value.length === 0) fail(path, "must not be empty");
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) fail(path, `exceeds the ${maxBytes}-byte boundary`);
  charge(state, bytes, path);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  state: BoundaryState,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `must be one of ${allowed.join(", ")}`);
  }
  charge(state, utf8Bytes(value), path);
  return value as T[number];
}

function nonNegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(path, "must be a non-negative finite number");
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value;
}

function ownDataArray(
  value: unknown,
  path: string,
  maxItems: number,
): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    fail(`${path}.length`, "must be an own data property");
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    fail(`${path}.length`, "must be a non-negative safe integer");
  }
  if (length > maxItems) fail(path, `exceeds the ${maxItems}-item boundary`);
  const allowed = new Set(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  assertKeys(value as unknown as Record<string, unknown>, [...allowed], path);

  const detached: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    detached.push(ownDataProperty(
      value as unknown as Record<string, unknown>,
      String(index),
      path,
      true,
    ));
  }
  return detached;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(path, "contains an unknown symbol key");
    if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be a data property");
    }
    detached[key] = descriptor.value;
  }
  return detached;
}

function boundaryState(maxBytes: number, boundaryLabel: string): BoundaryState {
  return {
    active: new Set(),
    boundaryLabel,
    maxBytes,
    bytes: 0,
    fileBytes: 0,
    items: 0,
    jsonItems: 0,
  };
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(path, "contains an unknown symbol key");
    if (UNSAFE_KEYS.has(key)) fail(path, `contains unsafe key ${JSON.stringify(key)}`);
    if (!allowedKeys.has(key)) fail(path, `contains unknown key ${JSON.stringify(key)}`);
  }
}

function ownDataProperty(
  value: Record<string, unknown>,
  key: string,
  path: string,
  required = false,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) fail(`${path}.${key}`, "is required");
    return undefined;
  }
  if (!("value" in descriptor)) fail(`${path}.${key}`, "must be a data property");
  return descriptor.value;
}

function detachRuntimeNativeToolDescriptor(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  const input = record(value, path);
  const keys = ["id", "displayName", "effects", "approval", "sandbox"] as const;
  assertKeys(input, keys, path);
  return {
    id: ownDataProperty(input, "id", path, true),
    displayName: ownDataProperty(input, "displayName", path, true),
    effects: ownDataArray(
      ownDataProperty(input, "effects", path, true),
      `${path}.effects`,
      4,
    ),
    approval: ownDataProperty(input, "approval", path, true),
    sandbox: ownDataProperty(input, "sandbox", path, true),
  };
}

function addItems(
  state: BoundaryState,
  count: number,
  path: string,
  json: boolean,
): void {
  state.items += count;
  if (json) state.jsonItems += count;
  if (state.items > RUNTIME_RESULT_MAX_ITEMS) {
    fail(
      path,
      `exceeds the ${RUNTIME_RESULT_MAX_ITEMS}-item ${state.boundaryLabel} boundary`,
    );
  }
}

function charge(state: BoundaryState, bytes: number, path: string): void {
  state.bytes += bytes;
  if (state.bytes > state.maxBytes) {
    fail(
      path,
      `exceeds the ${state.maxBytes}-byte ${state.boundaryLabel} boundary`,
    );
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}
