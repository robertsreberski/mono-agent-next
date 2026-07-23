import type {
  JsonValue,
  RuntimeToolCall,
  RuntimeToolResult,
  RuntimeToolResultPart,
} from "@mono-agent/module-sdk";

const TOOL_DETAIL_PAYLOAD_BYTES = 4 * 1024;
export const OPEN_WEBUI_TOOL_DETAIL_FRAME_BYTES = 64 * 1024;

/**
 * Render one completed host-owned tool for Open WebUI without asking the HTTP
 * client to execute it. File bytes are never copied into the response and each
 * JSON field is projected through a small UTF-8 preview boundary before HTML
 * escaping.
 */
export function renderOpenWebUiToolDetail(
  call: RuntimeToolCall,
  result: RuntimeToolResult,
): string {
  const argumentsJson = boundedJson(call.input);
  const resultJson = boundedJson(projectResult(result));
  const rendered = details(call, result, argumentsJson, resultJson);
  if (Buffer.byteLength(rendered, "utf8") <= OPEN_WEBUI_TOOL_DETAIL_FRAME_BYTES) {
    return rendered;
  }
  return details(
    call,
    result,
    JSON.stringify({ truncated: true }),
    JSON.stringify({ truncated: true, isError: result.isError === true }),
  );
}

function details(
  call: RuntimeToolCall,
  result: RuntimeToolResult,
  argumentsJson: string,
  resultJson: string,
): string {
  return [
    `<details type="tool_calls" done="true" id="${escapeAttribute(call.id)}" name="${escapeAttribute(call.name)}" arguments="${escapeAttribute(argumentsJson)}">`,
    `<summary>${result.isError === true ? "Tool Error" : "Tool Executed"}</summary>`,
    escapeText(resultJson),
    "</details>",
    "",
  ].join("\n");
}

function boundedJson(value: JsonValue): string;
function boundedJson(value: Readonly<Record<string, JsonValue>>): string;
function boundedJson(value: JsonValue | Readonly<Record<string, JsonValue>>): string {
  const rendered = JSON.stringify(value);
  const originalBytes = Buffer.byteLength(rendered, "utf8");
  if (originalBytes <= TOOL_DETAIL_PAYLOAD_BYTES) return rendered;
  const preview = utf8Prefix(rendered, TOOL_DETAIL_PAYLOAD_BYTES);
  return JSON.stringify({
    __monoAgentTruncation: {
      truncated: true,
      originalBytes,
      retainedBytes: Buffer.byteLength(preview, "utf8"),
    },
    preview,
  });
}

function projectResult(result: RuntimeToolResult): Readonly<Record<string, JsonValue>> {
  return {
    callId: result.callId,
    isError: result.isError === true,
    content: result.content.map(projectResultPart),
  };
}

function projectResultPart(part: RuntimeToolResultPart): JsonValue {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "json":
      return { type: "json", value: part.value };
    case "file": {
      const sizeBytes = typeof part.data === "string"
        ? Buffer.byteLength(part.data, "utf8")
        : part.data.byteLength;
      return {
        type: "file",
        mediaType: part.mediaType,
        sizeBytes,
        bytesOmitted: true,
        ...(part.name === undefined ? {} : { name: part.name }),
      };
    }
    case "artifact":
      return {
        type: "artifact",
        ref: {
          id: part.ref.id,
          sha256: part.ref.sha256,
          sizeBytes: part.ref.sizeBytes,
          mediaType: part.ref.mediaType,
          ...(part.ref.fileName === undefined ? {} : { fileName: part.ref.fileName }),
        },
        ...(part.preview === undefined ? {} : { preview: part.preview }),
      };
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
