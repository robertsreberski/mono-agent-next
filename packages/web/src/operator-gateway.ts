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
  type OperatorInfo,
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

  const verifiedConnection = async (agentId: string, signal?: AbortSignal) => {
    const { client, entry } = await connectionFor(agentId);
    const info = await client.getInfo(signal);
    assertIdentity(entry, info);
    return { client, entry, info };
  };

  return {
    async listAgents(): Promise<readonly WebAgent[]> {
      return Promise.all((await entries()).map(async (entry): Promise<WebAgent> => {
        const base: WebAgent = {
          id: entry.id,
          label: entry.label,
          endpoint: entry.endpoint,
          online: !entry.stale,
          pinned: false,
          capabilities: capabilityRecord(entry.capabilities),
        };
        if (entry.stale) return base;
        try {
          const client = createOperatorClientForEntry(entry, {
            env: options.environment,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          });
          const info = await client.getInfo();
          assertIdentity(entry, info);
          return {
            ...base,
            label: info.agent.label,
            capabilities: capabilityRecord(info.capabilities),
            ...(info.defaults === undefined ? {} : { defaults: info.defaults }),
            ...(info.models === undefined ? {} : { models: info.models }),
          };
        } catch {
          return { ...base, online: false };
        }
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
      const activeKey = conversationKey(input.agentId, input.conversationId);
      conversations.set(activeKey, active);
      try {
        const { client, info } = await verifiedConnection(input.agentId, input.signal);
        active.client = client;
        active.capabilities = info.capabilities;
        let overrides: OperatorRuntimeOverrideIntent = {};
        if (input.runtime !== undefined || input.model !== undefined || input.effort !== undefined) {
          const decision = evaluateOperatorRuntimeOverride(info, {
            ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
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
          input: {
            text: input.text,
            ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
            ...(input.quote === undefined ? {} : { quote: input.quote }),
          },
          ...overrides,
          metadata: { client: "web" },
        }, { signal: input.signal })) {
          active.state = reduceOperatorFrame(active.state, frame);
          state = active.state;
          if (input.onState !== undefined) {
            await input.onState(state);
          } else if (state.assistantText !== lastText) {
            lastText = state.assistantText;
            await input.onText(lastText);
          }
        }
        if (state.status === "cancelled") throw new WebProductError("operator_cancelled", state.lastError?.message ?? "Operator turn was cancelled.", 409);
        if (state.status !== "completed") throw new WebProductError("operator_turn_failed", state.lastError?.message ?? "Operator turn did not complete.", 502);
      } finally {
        if (conversations.get(activeKey) === active) conversations.delete(activeKey);
      }
    },

    async cancel(agentId: string, conversationId: string): Promise<void> {
      const active = conversations.get(conversationKey(agentId, conversationId));
      if (active === undefined || active.client === undefined) return;
      if (!availableOperatorActions(active.state, active.capabilities).includes("cancel_turn")) return;
      await active.client.cancelConversation(conversationId, { reason: "Cancelled by web operator." });
    },

    async discoverProactiveConversations() {
      const candidates = (await entries()).filter((entry) => !entry.stale);
      const settled = await Promise.allSettled(candidates.map(async (entry) => {
        const { client, info } = await verifiedConnection(entry.id);
        if (!info.capabilities.proactive || !info.capabilities.replay) return [];
        const listed = await client.getConversations();
        return await Promise.all(listed.conversations
          .filter((conversation) => conversation.triggerKind !== undefined)
          .map(async (conversation) => {
            const replay = await client.getReplay(conversation.id);
            return {
              agentId: entry.id,
              conversationId: conversation.id,
              ...(conversation.title === undefined ? {} : { title: conversation.title }),
              ...(conversation.triggerKind === undefined ? {} : { triggerKind: conversation.triggerKind }),
              updatedAt: conversation.updatedAt,
              messages: replay.messages,
            };
          }));
      }));
      return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    },

    async answerAsk(agentId, conversationId, request) {
      const active = conversations.get(conversationKey(agentId, conversationId));
      let client: OperatorClient;
      let capabilities: OperatorCapabilities;
      if (active?.client !== undefined && active.capabilities !== undefined) {
        client = active.client;
        capabilities = active.capabilities;
      } else {
        const verified = await verifiedConnection(agentId);
        client = verified.client;
        capabilities = verified.info.capabilities;
      }
      let state = active?.state;
      if (state === undefined) {
        const snapshot = await client.getPendingAsk(conversationId);
        state = {
          ...initialOperatorState(conversationId),
          ...(snapshot.ask === null ? {} : { pendingAsk: snapshot.ask }),
        };
      }
      if (!availableOperatorActions(state, capabilities).includes("answer_ask")) {
        throw new WebProductError("ask_unavailable", "This operator does not currently accept an AskUser answer.", 409);
      }
      const result = await client.answerAsk(conversationId, request);
      if (result.status === "accepted" && active !== undefined) {
        const { pendingAsk: _pendingAsk, ...next } = active.state;
        active.state = next;
      }
      return result;
    },

    async offerLiveInput(agentId, conversationId, text) {
      const active = conversations.get(conversationKey(agentId, conversationId));
      if (
        active?.client === undefined
        || !availableOperatorActions(active.state, active.capabilities).includes("offer_live_input")
      ) {
        throw new WebProductError("live_input_unavailable", "This operator does not currently accept live input.", 409);
      }
      return active.client.offerLiveInput(conversationId, {
        id: crypto.randomUUID(),
        text,
        receivedAt: new Date().toISOString(),
      });
    },

    async readReplay(agentId, conversationId) {
      const { client, info } = await verifiedConnection(agentId);
      if (!availableOperatorActions(initialOperatorState(conversationId), info.capabilities).includes("view_replay")) {
        throw new WebProductError("replay_unsupported", "This operator does not expose replay.", 409);
      }
      return client.getReplay(conversationId);
    },

    async readConfig(agentId) {
      const { client, info } = await verifiedConnection(agentId);
      if (!availableOperatorActions(initialOperatorState("web-config-view"), info.capabilities).includes("view_config")) {
        throw new WebProductError("config_unsupported", "This operator does not expose a redacted config view.", 409);
      }
      return client.getConfig();
    },

    async readHealth(agentId) {
      const { client, info } = await verifiedConnection(agentId);
      if (!availableOperatorActions(initialOperatorState("web-health-view"), info.capabilities).includes("view_health")) {
        throw new WebProductError("health_unsupported", "This operator does not expose health.", 409);
      }
      return client.getHealth();
    },
  };
}

function assertIdentity(entry: DiscoveredOperator, info: OperatorInfo): void {
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
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId.length}:${agentId}${conversationId}`;
}

function capabilityRecord(capabilities: DiscoveredOperator["capabilities"]): Readonly<Record<string, boolean>> {
  if (capabilities === undefined) return {};
  return Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([name, enabled]) => [name, enabled])));
}
