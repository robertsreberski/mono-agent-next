import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  AGENT_LIVE_INPUT_MAX_MESSAGES,
  type AgentLiveInputOffer,
  type AgentLiveInputRequest,
  type AgentLiveInputSettlement,
} from "@mono-agent/agent-contracts";
import type { RuntimeLiveInputMessage } from "@mono-agent/runtime-adapter";

export interface AppliedLiveInput {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
}

export interface LiveInputMailbox extends AsyncIterable<RuntimeLiveInputMessage> {
  offer(request: AgentLiveInputRequest): AgentLiveInputOffer;
  markUnsupported(): void;
  close(reason?: "closed" | "failed"): void;
  cancel(): void;
  applied(): readonly AppliedLiveInput[];
}

interface LiveInputEntry {
  readonly request: AgentLiveInputRequest;
  readonly settled: Promise<AgentLiveInputSettlement>;
  readonly resolve: (settlement: AgentLiveInputSettlement) => void;
  applied: boolean;
  settledFlag: boolean;
}

interface MailboxConsumer {
  cursor: number;
  closed: boolean;
  waiting: ((result: IteratorResult<RuntimeLiveInputMessage>) => void) | undefined;
}

type MailboxState = "open" | "unsupported" | "closed" | "failed" | "cancelled";

export function createLiveInputMailbox(runId: string): LiveInputMailbox {
  const entries: LiveInputEntry[] = [];
  const entriesById = new Map<string, LiveInputEntry>();
  const consumers = new Set<MailboxConsumer>();
  let state: MailboxState = "open";

  const settle = (entry: LiveInputEntry, result: AgentLiveInputSettlement): void => {
    if (entry.settledFlag) return;
    entry.settledFlag = true;
    entry.resolve(result);
  };

  const runtimeMessage = (entry: LiveInputEntry): RuntimeLiveInputMessage => ({
    body: entry.request.text,
    id: entry.request.id,
    receivedAt: entry.request.receivedAt,
    acknowledge: () => {
      if (!entry.applied) {
        entry.applied = true;
        settle(entry, { status: "applied", runId });
      }
    },
    // A rejection belongs to one provider attempt. The entry stays available
    // to a later iterator so router failover/resume replay cannot lose it.
    reject: () => undefined,
  });

  const nextFor = (consumer: MailboxConsumer): IteratorResult<RuntimeLiveInputMessage> | undefined => {
    if (consumer.closed) return { done: true, value: undefined };
    const entry = entries[consumer.cursor];
    if (entry !== undefined) {
      consumer.cursor += 1;
      return { done: false, value: runtimeMessage(entry) };
    }
    return state === "open" ? undefined : { done: true, value: undefined };
  };

  const wakeConsumers = (): void => {
    for (const consumer of consumers) {
      const waiting = consumer.waiting;
      if (waiting === undefined) continue;
      const result = nextFor(consumer);
      if (result === undefined) continue;
      consumer.waiting = undefined;
      waiting(result);
    }
  };

  const finish = (nextState: Exclude<MailboxState, "open">): void => {
    if (state !== "open") return;
    state = nextState;
    for (const entry of entries) {
      if (entry.applied) continue;
      if (nextState === "cancelled") {
        settle(entry, { status: "discarded", reason: "cancelled" });
      } else {
        settle(entry, {
          status: "requeue",
          reason: nextState === "unsupported" ? "unsupported" : nextState === "failed" ? "failed" : "closed",
        });
      }
    }
    wakeConsumers();
  };

  return {
    offer(request): AgentLiveInputOffer {
      const existing = entriesById.get(request.id);
      if (existing !== undefined) return { status: "accepted", settled: existing.settled };
      if (state !== "open") {
        return {
          status: "unavailable",
          reason: state === "unsupported" ? "unsupported" : "inactive",
        };
      }
      if (
        request.id.trim().length === 0
        || request.text.trim().length === 0
        || request.receivedAt.trim().length === 0
        || Number.isNaN(Date.parse(request.receivedAt))
      ) {
        return { status: "unavailable", reason: "invalid" };
      }
      if (request.text.length > AGENT_LIVE_INPUT_MAX_CHARACTERS) {
        return { status: "unavailable", reason: "too_large" };
      }
      if (entries.length >= AGENT_LIVE_INPUT_MAX_MESSAGES) {
        return { status: "unavailable", reason: "full" };
      }
      let resolve!: (settlement: AgentLiveInputSettlement) => void;
      const settled = new Promise<AgentLiveInputSettlement>((resolvePromise) => {
        resolve = resolvePromise;
      });
      const entry: LiveInputEntry = {
        request,
        settled,
        resolve,
        applied: false,
        settledFlag: false,
      };
      entries.push(entry);
      entriesById.set(request.id, entry);
      wakeConsumers();
      return { status: "accepted", settled };
    },
    markUnsupported(): void {
      finish("unsupported");
    },
    close(reason = "closed"): void {
      finish(reason);
    },
    cancel(): void {
      finish("cancelled");
    },
    applied(): readonly AppliedLiveInput[] {
      return entries
        .filter((entry) => entry.applied)
        .map((entry) => ({
          id: entry.request.id,
          text: entry.request.text,
          receivedAt: entry.request.receivedAt,
        }));
    },
    [Symbol.asyncIterator](): AsyncIterator<RuntimeLiveInputMessage> {
      const consumer: MailboxConsumer = { cursor: 0, closed: false, waiting: undefined };
      consumers.add(consumer);
      return {
        next(): Promise<IteratorResult<RuntimeLiveInputMessage>> {
          const immediate = nextFor(consumer);
          if (immediate !== undefined) return Promise.resolve(immediate);
          return new Promise<IteratorResult<RuntimeLiveInputMessage>>((resolve) => {
            consumer.waiting = resolve;
          });
        },
        return(): Promise<IteratorResult<RuntimeLiveInputMessage>> {
          consumer.closed = true;
          consumers.delete(consumer);
          const waiting = consumer.waiting;
          consumer.waiting = undefined;
          waiting?.({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}
