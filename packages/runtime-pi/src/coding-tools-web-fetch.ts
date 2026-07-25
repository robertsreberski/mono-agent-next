import { Buffer } from "node:buffer";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

import { runtimePiWebFetchTool } from "./coding-tool-descriptors.js";
import {
  approvedExecution,
  combinedSignal,
  evidence,
  outputLimit,
  ownRecord,
  renamedTool,
  requiredString,
  toolError,
  type RuntimePiCodingToolsOptions,
} from "./coding-tools-shared.js";
import {
  fetchPublicWeb,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_URL_BYTES,
  type WebFetchInput,
} from "./web-fetch.js";

const WEB_FETCH_SAFE_HEADERS = new Set(["accept", "accept-language", "user-agent"]);
const WEB_FETCH_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

function headersRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw toolError("WebFetch", "headers must be an object.");
  }
  const record = ownRecord(
    value,
    "WebFetch headers",
    Reflect.ownKeys(value).flatMap((key) => typeof key === "string" ? [key] : []),
  );
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [key, headerValue] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) {
      throw toolError("WebFetch", `header ${JSON.stringify(key)} is duplicated.`);
    }
    seen.add(normalized);
    if (WEB_FETCH_CREDENTIAL_HEADERS.has(normalized)) {
      throw toolError("WebFetch", `credential header ${JSON.stringify(key)} is forbidden.`);
    }
    if (!WEB_FETCH_SAFE_HEADERS.has(normalized)) {
      throw toolError("WebFetch", `header ${JSON.stringify(key)} is not allowed.`);
    }
    if (typeof headerValue !== "string"
      || headerValue.includes("\r")
      || headerValue.includes("\n")
      || Buffer.byteLength(headerValue, "utf8") > 4 * 1024) {
      throw toolError("WebFetch", `header ${JSON.stringify(key)} must be a string.`);
    }
    output[key] = headerValue;
  }
  return Object.freeze(output);
}

export function createRuntimePiWebFetchAgentTool(
  options: RuntimePiCodingToolsOptions,
): AgentTool {
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1, maxLength: WEB_FETCH_MAX_URL_BYTES },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      max_output_chars: { type: "integer", minimum: 1, maximum: WEB_FETCH_MAX_OUTPUT_BYTES },
    },
  } as TSchema;
  const template: AgentTool = {
    name: "WebFetch",
    label: "Web Fetch",
    description:
      "Fetch bounded UTF-8 text from a public HTTPS URL with DNS-pinned SSRF protection.",
    parameters,
    async execute() {
      throw new Error("unreachable");
    },
  };
  return renamedTool(template, runtimePiWebFetchTool, parameters, async (
    toolCallId,
    params,
    signal,
  ) => {
    const input = ownRecord(params, "WebFetch", [
      "url", "headers", "max_output_chars",
    ]);
    const url = requiredString(input, "url", "WebFetch", WEB_FETCH_MAX_URL_BYTES);
    const headers = headersRecord(input.headers);
    const maxOutputBytes = outputLimit(input, "WebFetch");
    const fetchInput: WebFetchInput = {
      url,
      headers,
      maxOutputBytes,
    };
    const executionSignal = combinedSignal(options.turnSignal, signal);
    return approvedExecution(
      options,
      runtimePiWebFetchTool,
      toolCallId,
      [
        "Allow this DNS-pinned public HTTPS request?",
        evidence("url", url),
        `header_names: ${JSON.stringify(Object.keys(headers).map((name) => name.toLowerCase()).sort())}`,
      ].join("\n"),
      executionSignal,
      async () => ({
        content: [{
          type: "text",
          text: await fetchPublicWeb(fetchInput, {
            ...options.webFetch,
            signal: executionSignal,
          }),
        }],
        details: undefined,
      }),
    );
  });
}
