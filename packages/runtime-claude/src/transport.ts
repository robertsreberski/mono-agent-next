import type { JsonSchema, JsonValue, RuntimeUsage } from "@mono-agent/module-sdk";

import { claudeProcessEnvironment } from "./environment.js";

export interface ClaudeTransportRequest {
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly sessionId?: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly responseSchema?: JsonSchema;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface ClaudeTransportControl {
  interrupt(): Promise<void>;
  sendInput?(text: string, receivedAt: string): Promise<boolean>;
}

export interface ClaudeTransportEvents {
  text(delta: string): void | Promise<void>;
  thinking(delta: string): void | Promise<void>;
  session(id: string): void | Promise<void>;
  usage(usage: RuntimeUsage): void | Promise<void>;
  control(control: ClaudeTransportControl): void;
}

export interface ClaudeTransportResult {
  readonly text: string;
  readonly sessionId: string;
  readonly usage?: RuntimeUsage;
  readonly structuredOutput?: JsonValue;
  readonly stopReason?: string;
}

export class ClaudeSessionUnavailableError extends Error {
  constructor() {
    super("Claude provider session is unavailable");
    this.name = "ClaudeSessionUnavailableError";
  }
}

export interface ClaudeTransport {
  run(request: ClaudeTransportRequest, events: ClaudeTransportEvents): Promise<ClaudeTransportResult>;
}

function ownDataString(value: unknown, key: PropertyKey): string | undefined {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function isClaudeSessionUnavailable(
  value: unknown,
  sessionId: string | undefined,
): boolean {
  if (value instanceof ClaudeSessionUnavailableError) return true;
  if (sessionId === undefined) return false;
  const message = typeof value === "string"
    ? value
    : ownDataString(value, "message");
  if (message === undefined) return false;
  const prefix = `Session ${sessionId} not found`;
  return message === prefix
    || message === `${prefix} in any project directory`
    || message === `${prefix} (no projects directory)`
    || message.startsWith(`${prefix} in project directory for `);
}

export function claudeEnvironment(auth: { method: "oauth-token" | "api-key"; token: string } | undefined): NodeJS.ProcessEnv {
  if (auth === undefined) return claudeProcessEnvironment();
  return claudeProcessEnvironment(auth.method === "oauth-token"
    ? { CLAUDE_CODE_OAUTH_TOKEN: auth.token }
    : { ANTHROPIC_API_KEY: auth.token });
}
