/** Browser API version. It is independent from the agent operator wire version. */
export const WEB_API_VERSION = 1 as const;

export type WebTurnStatus = "idle" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

export interface WebAgent {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly online: boolean;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface WebThread {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: WebTurnStatus;
  readonly activeTurnId?: string;
}

export interface WebMessage {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: Exclude<WebTurnStatus, "idle">;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface WebThreadDetail {
  readonly thread: WebThread;
  readonly messages: readonly WebMessage[];
}

export interface WebBootstrap {
  readonly version: typeof WEB_API_VERSION;
  readonly agents: readonly WebAgent[];
  readonly threads: readonly WebThread[];
}

export interface CreateWebThreadInput {
  readonly agentId: string;
  readonly title?: string;
}

export interface StartWebTurnInput {
  readonly text: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface StoredWebState {
  readonly schemaVersion: 1;
  readonly threads: readonly WebThread[];
  readonly messages: readonly WebMessage[];
}
