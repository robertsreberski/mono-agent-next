// SPDX-License-Identifier: MIT
import type { Exporter } from "@mono-agent/module-sdk/internal";
import { errorMessage } from "./errors.js";
import type { HostLifecycleCalls } from "./host-lifecycle.js";
import type { AgentResponse, AgentSubmitInput, RuntimeRoute } from "./types.js";

interface ExportContext {
  readonly agentId: string;
  readonly lifecycle: HostLifecycleCalls;
  exporters(): ReadonlyMap<string, Exporter>;
  recordFailure(message: string): void;
}

/**
 * Owns bounded turn telemetry export. Every exporter is attempted; a rejection
 * or throw is recorded to health rather than failing the settled turn.
 */
export class HostExport {
  constructor(private readonly context: ExportContext) {}
  async emit(
    name: string,
    input: AgentSubmitInput,
    route: RuntimeRoute,
    response: AgentResponse,
  ): Promise<void> {
    if (this.context.exporters().size === 0) return;
    const record = {
      name,
      timestamp: new Date().toISOString(),
      attributes: {
        agentId: this.context.agentId,
        conversationId: input.conversationId,
        runtime: route.runtime,
        model: route.model,
        status: response.status,
      },
    } as const;
    for (const [instanceId, exporter] of this.context.exporters()) {
      try {
        const result = await this.context.lifecycle.run(
          `exporter ${instanceId} export`,
          (signal) => exporter.export({ records: [record], signal }),
        );
        if (result === undefined) {
          throw new Error(`exporter ${instanceId} returned no result`);
        }
        if (result.rejected > 0) this.context.recordFailure(`exporter ${instanceId} rejected a turn record`);
      } catch (error) {
        this.context.recordFailure(`exporter ${instanceId}: ${errorMessage(error)}`);
      }
    }
  }
}
