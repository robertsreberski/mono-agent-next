import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";
import type { ConversationHistoryStore, HistoryMessage } from "@mono-agent/agent-harness";

const DAILY_BUCKET_SUFFIX_RE = /#\d{4}-\d{2}-\d{2}$/u;
const SLACK_PHYSICAL_CONVERSATION_RE = /^slack:([A-Za-z0-9_-]+):(\d+(?:\.\d+)?)$/u;
const VERBATIM_DELIVERY_STIMULUS = "[A scheduled or triggered task produced the message below, delivered to you proactively.]";

interface PostedReplyScope {
  readonly producerConversationId: string;
  readonly physicalConversationId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

export interface SlackPostedReplyHistoryOptions {
  readonly maxMessages: number;
  readonly rollover?: "none" | "daily";
  readonly rolloverTimezone?: string;
}

/**
 * App-private bridge between Slack's posted-message alias and canonical history.
 * It overlays one receipt-authenticated destination delivery while the aliased
 * reply is prepared, without ever writing that delivery into producer history.
 */
export function createSlackPostedReplyHistory(options: SlackPostedReplyHistoryOptions): {
  readonly wrapHistoryStore: (store: ConversationHistoryStore) => ConversationHistoryStore;
  readonly wrapResponder: (responder: AgentResponder) => AgentResponder;
} {
  if (!Number.isInteger(options.maxMessages) || options.maxMessages < 1) {
    throw new TypeError("Slack posted-reply history maxMessages must be a positive integer.");
  }
  const scopes = new AsyncLocalStorage<PostedReplyScope>();

  return {
    wrapHistoryStore(store) {
      return wrapHistoryStore(store, scopes, options);
    },
    wrapResponder(responder) {
      const dispose = (responder as AgentResponder & { dispose?: () => Promise<void> }).dispose;
      const startNewSession = (responder as AgentResponder & {
        startNewSession?: (conversationId: string) => Promise<void>;
      }).startNewSession;
      return {
        respond: async (request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> => {
          const scope = postedReplyScope(request);
          return scope === undefined
            ? await responder.respond(request, stream)
            : await scopes.run(scope, async () => await responder.respond(request, stream));
        },
        ...(responder.cancel === undefined ? {} : { cancel: responder.cancel.bind(responder) }),
        ...(responder.offerLiveInput === undefined
          ? {}
          : { offerLiveInput: responder.offerLiveInput.bind(responder) }),
        ...(responder.deliverVerbatim === undefined
          ? {}
          : { deliverVerbatim: responder.deliverVerbatim.bind(responder) }),
        ...(startNewSession === undefined
          ? {}
          : { startNewSession: startNewSession.bind(responder) }),
        ...(dispose === undefined ? {} : { dispose: dispose.bind(responder) }),
      } as AgentResponder;
    },
  };
}

function wrapHistoryStore(
  store: ConversationHistoryStore,
  scopes: AsyncLocalStorage<PostedReplyScope>,
  options: SlackPostedReplyHistoryOptions,
): ConversationHistoryStore {
  return {
    ...(store.providerSessionRetirement === undefined
      ? {}
      : { providerSessionRetirement: store.providerSessionRetirement }),
    async load(conversationId) {
      const canonical = await store.load(conversationId);
      const scope = scopes.getStore();
      if (scope === undefined || !matchesProducerConversation(conversationId, scope.producerConversationId)) {
        return canonical;
      }
      const delivery = await loadExactDelivery(store, scope, conversationId, options);
      if (delivery.length === 0) return canonical;
      const deliveryKey = delivery.find((message) => message.role === "assistant")?.idempotencyKey;
      if (deliveryKey !== undefined && canonical.some((message) => message.idempotencyKey === deliveryKey)) {
        return canonical;
      }
      return mergeHistory(canonical, delivery, options.maxMessages);
    },
    append: (conversationId, messages) => store.append(conversationId, messages),
    ...(store.reset === undefined
      ? {}
      : { reset: (conversationId: string) => store.reset!(conversationId) }),
    ...(store.prepareAppend === undefined
      ? {}
      : { prepareAppend: (conversationId: string, messages: readonly HistoryMessage[]) =>
          store.prepareAppend!(conversationId, messages) }),
    ...(store.beginProviderSessionTurn === undefined
      ? {}
      : { beginProviderSessionTurn: (conversationId: string, runId: string) =>
          store.beginProviderSessionTurn!(conversationId, runId) }),
  };
}

function postedReplyScope(request: AgentRequestBase): PostedReplyScope | undefined {
  if (request.continuation !== undefined) return undefined;
  const physicalConversationId = request.replyTo?.conversationId;
  if (physicalConversationId === undefined) return undefined;
  const parsed = SLACK_PHYSICAL_CONVERSATION_RE.exec(physicalConversationId);
  if (parsed === null) return undefined;
  const channelId = parsed[1];
  const threadTs = parsed[2];
  if (channelId === undefined || threadTs === undefined) return undefined;
  if (stripDailyBucket(request.conversationId) === physicalConversationId) return undefined;

  // Authenticate the alias as a genuine inbound Slack thread reply. Cron/webhook
  // requests can also carry replyTo, but do not have this host-built shape.
  const slack = plainRecord(request.metadata?.slack);
  const channel = plainRecord(slack?.channel);
  const message = plainRecord(slack?.message);
  if (channel?.id !== channelId
    || message?.threadTs !== threadTs
    || typeof message.ts !== "string"
    || message.ts === threadTs) {
    return undefined;
  }
  return {
    producerConversationId: request.conversationId,
    physicalConversationId,
    channelId,
    threadTs,
  };
}

async function loadExactDelivery(
  store: ConversationHistoryStore,
  scope: PostedReplyScope,
  producerConversationId: string,
  options: SlackPostedReplyHistoryOptions,
): Promise<readonly HistoryMessage[]> {
  const receiptKey = `adapter-send:slack:${scope.channelId}:${scope.threadTs}`;
  for (const candidate of destinationHistoryCandidates(scope, producerConversationId, options)) {
    const history = await store.load(candidate);
    const assistantIndex = history.findIndex(
      (message) => message.role === "assistant" && message.idempotencyKey === receiptKey,
    );
    if (assistantIndex < 0) continue;
    const assistant = history[assistantIndex];
    if (assistant === undefined) continue;
    const stimulus = history[assistantIndex - 1];
    return stimulus?.role === "user" && stimulus.content === VERBATIM_DELIVERY_STIMULUS
      ? [stimulus, assistant]
      : [assistant];
  }
  return [];
}

function destinationHistoryCandidates(
  scope: PostedReplyScope,
  producerConversationId: string,
  options: SlackPostedReplyHistoryOptions,
): readonly string[] {
  if (options.rollover !== "daily") return [scope.physicalConversationId];
  const seconds = Number(scope.threadTs);
  const sentAt = new Date(seconds * 1_000);
  const days = Number.isFinite(seconds) && !Number.isNaN(sentAt.getTime())
    ? [
        formatRolloverDay(sentAt, options.rolloverTimezone),
        formatRolloverDay(new Date(sentAt.getTime() + 86_400_000), options.rolloverTimezone),
      ]
    : [];
  const currentSuffix = DAILY_BUCKET_SUFFIX_RE.exec(producerConversationId)?.[0]?.slice(1);
  if (currentSuffix !== undefined) days.push(currentSuffix);
  return [...new Set(days)].map((day) => `${scope.physicalConversationId}#${day}`);
}

function mergeHistory(
  canonical: readonly HistoryMessage[],
  delivery: readonly HistoryMessage[],
  maxMessages: number,
): readonly HistoryMessage[] {
  return [...canonical, ...delivery]
    .map((message, index) => ({ message, index, time: historyTime(message) }))
    .sort((left, right) => left.time - right.time || left.index - right.index)
    .map(({ message }) => message)
    .slice(-maxMessages);
}

function historyTime(message: HistoryMessage): number {
  if (message.timestamp === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(message.timestamp);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function matchesProducerConversation(loaded: string, scoped: string): boolean {
  return stripDailyBucket(loaded) === stripDailyBucket(scoped);
}

function stripDailyBucket(conversationId: string): string {
  return conversationId.replace(DAILY_BUCKET_SUFFIX_RE, "");
}

function formatRolloverDay(date: Date, timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
