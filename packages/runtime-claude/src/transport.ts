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

export interface ClaudeTransport {
  run(request: ClaudeTransportRequest, events: ClaudeTransportEvents): Promise<ClaudeTransportResult>;
}

export function claudeEnvironment(auth: { method: "oauth-token" | "api-key"; token: string } | undefined): NodeJS.ProcessEnv {
  if (auth === undefined) return claudeProcessEnvironment();
  return claudeProcessEnvironment(auth.method === "oauth-token"
    ? { CLAUDE_CODE_OAUTH_TOKEN: auth.token }
    : { ANTHROPIC_API_KEY: auth.token });
}
