import {
  OperatorDirectory,
  OperatorIdentityBindingError,
  availableOperatorActions,
  assertOperatorIdentity,
  createOperatorClientForEntry,
  discoverOperators,
  evaluateOperatorRuntimeOverride,
  initialOperatorState,
  reduceOperatorFrame,
  type DiscoveredOperator,
  type OperatorClient,
  type OperatorCapabilities,
  type OperatorConversationState,
  type OperatorRuntimeOverrideIntent,
} from "@mono-agent/operator";

import type { WebAgent } from "./contracts.js";
import { WebProductError } from "./errors.js";
import type { WebOperatorGateway, WebOperatorTurnInput } from "./service.js";

export interface CreateOperatorGatewayOptions {
  readonly registryDirectories: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Bind the web product to the one shared operator decoder, reducer and action
 * policy. This file deliberately contains no NDJSON or frame parser.
 */
export function createOperatorGateway(options: CreateOperatorGatewayOptions): WebOperatorGateway {
  const conversations = new Map<string, {
    state: OperatorConversationState;
    client?: OperatorClient;
    capabilities?: OperatorCapabilities;
  }>();

  const entries = async (): Promise<readonly DiscoveredOperator[]> => discoverOperators({
    registryDirectories: options.registryDirectories,
  });

  const selected = async (agentId: string): Promise<DiscoveredOperator> => {
    const entry = new OperatorDirectory(await entries()).select(agentId);
    if (entry.stale) throw new WebProductError("agent_offline", "Agent operator registry entry is stale.", 409);
    return entry;
  };

  const connectionFor = async (agentId: string) => {
    const entry = await selected(agentId);
    return {
      entry,
      client: createOperatorClientForEntry(entry, {
        env: options.environment,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
  };

  return {
    async listAgents(): Promise<readonly WebAgent[]> {
      return (await entries()).map((entry) => ({
        id: entry.id,
        label: entry.label,
        endpoint: entry.endpoint,
        online: !entry.stale,
        capabilities: capabilityRecord(entry.capabilities),
      }));
    },

    async runTurn(input: WebOperatorTurnInput): Promise<void> {
      let state = initialOperatorState(input.conversationId);
      if (!availableOperatorActions(state).includes("start_turn")) {
        throw new WebProductError("turn_unavailable", "The operator does not currently allow a new turn.", 409);
      }
      const active: {
        state: OperatorConversationState;
        client?: OperatorClient;
        capabilities?: OperatorCapabilities;
      } = { state };
      conversations.set(input.conversationId, active);
      try {
        const { client, entry } = await connectionFor(input.agentId);
        const info = await client.getInfo(input.signal);
        try {
          assertOperatorIdentity(entry, info);
        } catch (error) {
          if (error instanceof OperatorIdentityBindingError) {
            throw new WebProductError(
              "operator_identity_mismatch",
              `Operator process identity does not match its registry descriptor (${error.field}).`,
              502,
            );
          }
          throw error;
        }
        active.client = client;
        active.capabilities = info.capabilities;
        let overrides: OperatorRuntimeOverrideIntent = {};
        if (input.model !== undefined || input.effort !== undefined) {
          const decision = evaluateOperatorRuntimeOverride(info, {
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
          });
          if (!decision.allowed) {
            throw new WebProductError(
              decision.reason,
              decision.message,
              decision.reason === "runtime_overrides_unsupported" ? 409 : 400,
            );
          }
          overrides = decision.intent;
        }
        let lastText = "";
        for await (const frame of client.streamTurn({
          conversationId: input.conversationId,
          input: { text: input.text },
          ...overrides,
          metadata: { client: "web" },
        }, { signal: input.signal })) {
          state = reduceOperatorFrame(state, frame);
          active.state = state;
          if (state.assistantText !== lastText) {
            lastText = state.assistantText;
            await input.onText(lastText);
          }
        }
        if (state.status === "cancelled") throw new WebProductError("operator_cancelled", state.lastError?.message ?? "Operator turn was cancelled.", 409);
        if (state.status !== "completed") throw new WebProductError("operator_turn_failed", state.lastError?.message ?? "Operator turn did not complete.", 502);
      } finally {
        if (conversations.get(input.conversationId) === active) conversations.delete(input.conversationId);
      }
    },

    async cancel(_agentId: string, conversationId: string): Promise<void> {
      const active = conversations.get(conversationId);
      if (active === undefined || active.client === undefined) return;
      if (!availableOperatorActions(active.state, active.capabilities).includes("cancel_turn")) return;
      await active.client.cancelConversation(conversationId, { reason: "Cancelled by web operator." });
    },
  };
}

function capabilityRecord(capabilities: DiscoveredOperator["capabilities"]): Readonly<Record<string, boolean>> {
  if (capabilities === undefined) return {};
  return Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([name, enabled]) => [name, enabled])));
}
