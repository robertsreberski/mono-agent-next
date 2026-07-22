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

export class AgentAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAdmissionError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
