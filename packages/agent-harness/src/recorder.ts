import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";

export class NoopRunRecorder implements RunRecorder {
  private readonly runId: string;
  private readonly conversationId: string;
  private readonly isolated: boolean | undefined;
  private readonly startedAt = Date.now();
  private eventCount = 0;
  private terminalPromise: Promise<RunSummary> | undefined;

  constructor(input: { readonly runId: string; readonly conversationId: string; readonly isolated?: boolean }) {
    this.runId = input.runId;
    this.conversationId = input.conversationId;
    this.isolated = input.isolated;
  }

  onEvent(_event: RuntimeEventLike): void {
    if (this.terminalPromise !== undefined) return;
    this.eventCount += 1;
  }

  async start(): Promise<RunSummary> {
    return this.summary("running", undefined, {});
  }

  async prepareFinish(_result: RuntimeResultLike): Promise<void> {}

  async commitFinish(result: RuntimeResultLike): Promise<RunSummary> {
    this.terminalPromise ??= Promise.resolve(
      this.summary(result.cancelled === true ? "cancelled" : result.failureKind !== undefined || result.error !== undefined ? "failed" : "succeeded", result.failureKind ?? undefined, result),
    );
    return await this.terminalPromise;
  }

  async finish(result: RuntimeResultLike): Promise<RunSummary> {
    await this.prepareFinish(result);
    return await this.commitFinish(result);
  }

  async fail(error: unknown): Promise<RunSummary> {
    this.terminalPromise ??= Promise.resolve(
      this.summary("failed", error instanceof Error ? error.name : "exception", {}),
    );
    return await this.terminalPromise;
  }

  private summary(status: RunSummary["status"], failureKind: string | undefined, result: RuntimeResultLike): RunSummary {
    return {
      runId: this.runId,
      conversationId: this.conversationId,
      status,
      ...(failureKind === undefined || failureKind === null || failureKind === "" ? {} : { failureKind }),
      durationMs: Math.max(0, Date.now() - this.startedAt),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.cost === undefined ? {} : { cost: result.cost }),
      ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
      ...(typeof result.isolated === "boolean" ? { isolated: result.isolated } : this.isolated === undefined ? {} : { isolated: this.isolated }),
      eventCount: this.eventCount,
      artifactPaths: [],
      ...(result.runtimeWarnings === undefined ? {} : { runtimeWarnings: result.runtimeWarnings }),
      ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      ...(result.capabilitiesUsed === undefined ? {} : { capabilitiesUsed: result.capabilitiesUsed }),
    };
  }
}
