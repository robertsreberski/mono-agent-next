export interface AgentConfigIssue {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export class AgentConfigError extends Error {
  readonly issues: readonly AgentConfigIssue[];

  constructor(message: string, issues: readonly AgentConfigIssue[]) {
    super(message);
    this.name = "AgentConfigError";
    this.issues = issues;
  }
}

export class AgentModuleError extends Error {
  readonly packageName?: string;
  readonly configPath?: string;

  constructor(message: string, options: { packageName?: string; configPath?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentModuleError";
    if (options.packageName !== undefined) this.packageName = options.packageName;
    if (options.configPath !== undefined) this.configPath = options.configPath;
  }
}

export type AgentAdmissionErrorCode =
  | "not_accepting"
  | "capacity_exceeded"
  | "request_conflict"
  | "request_in_progress"
  | "stale_admission"
  | "uncertain_admission";

export class AgentAdmissionError extends Error {
  readonly code: AgentAdmissionErrorCode;
  readonly requestId?: string;
  readonly runId?: string;

  constructor(
    code: AgentAdmissionErrorCode,
    message: string,
    context: { readonly requestId?: string; readonly runId?: string } = {},
  ) {
    super(message);
    this.name = "AgentAdmissionError";
    this.code = code;
    if (context.requestId !== undefined) this.requestId = context.requestId;
    if (context.runId !== undefined) this.runId = context.runId;
  }
}

export type RunExecutionStatus = "failed" | "uncertain";

export interface RunExecutionErrorOptions {
  readonly cause?: unknown;
  readonly requestId?: string;
  readonly runId?: string;
}

/**
 * Provider-neutral terminal failure from `AgentHost.submit`.
 *
 * `uncertain` means an externally visible effect or durable settlement could
 * not be proved and the caller must inspect the run before retrying.
 */
export class RunExecutionError extends Error {
  readonly status: RunExecutionStatus;
  readonly failureCode: string;
  readonly requestId?: string;
  readonly runId?: string;

  constructor(
    status: RunExecutionStatus,
    failureCode: string,
    message: string,
    options: RunExecutionErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunExecutionError";
    this.status = status;
    this.failureCode = failureCode;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.runId !== undefined) this.runId = options.runId;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
