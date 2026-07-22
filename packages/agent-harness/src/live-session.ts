import { AgentResponseCancelledError } from "@mono-agent/agent-contracts";

import type { AgentHarnessRequest, AgentHarnessResponse } from "./types.js";

/**
 * Serializes turns per conversation while letting different conversations run
 * concurrently. A second message for a conversation whose turn is in flight is
 * *queued* and answered after the current turn finishes (queue-after-turn),
 * rather than rejected or run in parallel.
 *
 * The queue is deliberately decoupled from provider-session lifetime: it owns
 * only turn ordering. Whether a turn resumes a warm provider session or replays
 * history is decided by the runner (`MonoAgentHarness.run`) on each turn, so a
 * session that dies/evicts mid-queue simply demotes the next turn to a fresh
 * run — queued follow-ups are never silently dropped.
 */
export interface LiveSessionManager {
  /** Enqueue a turn; resolves when *this* turn completes (after any ahead of it). */
  enqueue(conversationId: string, request: AgentHarnessRequest): Promise<AgentHarnessResponse>;
  /** Abort an uncommitted in-flight turn and reject every queued turn for the conversation. */
  cancel(conversationId: string, reason?: unknown): void;
  /** Number of turns queued behind the active one. */
  pendingCount(conversationId: string): number;
  /**
   * Abort uncommitted work, refuse further turns, and wait for any turn that
   * already crossed its durable commit boundary to finish publishing.
   */
  dispose(): Promise<void>;
}

export interface LiveSessionManagerOptions {
  /** Executes a single turn — typically `MonoAgentHarness.run`. */
  readonly run: (request: AgentHarnessRequest, lifecycle: LiveSessionRunLifecycle) => Promise<AgentHarnessResponse>;
  /**
   * Max turns queued behind the active one per conversation. Beyond this, new
   * enqueues are rejected (cancelled) so a stuck active turn cannot retain
   * unbounded follow-ups. Default 100.
   */
  readonly maxPendingPerConversation?: number;
}

/** Internal commit handshake between the serialized queue and the harness. */
export interface LiveSessionRunLifecycle {
  /** Cancellation is too late once durable conversation state starts committing. */
  markCommitted(): void;
}

const DEFAULT_MAX_PENDING_PER_CONVERSATION = 100;

interface QueuedTurn {
  readonly request: AgentHarnessRequest;
  readonly resolve: (response: AgentHarnessResponse) => void;
  readonly reject: (error: unknown) => void;
  /** Removes the while-queued abort listener (no-op once detached). */
  detachAbort: () => void;
}

interface ConversationQueue {
  readonly pending: QueuedTurn[];
  draining: boolean;
  drainPromise: Promise<void> | undefined;
  activeController: AbortController | undefined;
  activeTurn: QueuedTurn | undefined;
  activeCommitted: boolean;
}

export function createLiveSessionManager(options: LiveSessionManagerOptions): LiveSessionManager {
  const conversations = new Map<string, ConversationQueue>();
  const maxPending = options.maxPendingPerConversation ?? DEFAULT_MAX_PENDING_PER_CONVERSATION;
  let disposed = false;

  function queueFor(conversationId: string): ConversationQueue {
    let queue = conversations.get(conversationId);
    if (queue === undefined) {
      queue = {
        pending: [],
        draining: false,
        drainPromise: undefined,
        activeController: undefined,
        activeTurn: undefined,
        activeCommitted: false,
      };
      conversations.set(conversationId, queue);
    }
    return queue;
  }

  function linkAbort(parent: AbortSignal, controller: AbortController): void {
    if (parent.aborted) {
      controller.abort(parent.reason);
      return;
    }
    parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  }

  async function drain(conversationId: string, queue: ConversationQueue): Promise<void> {
    if (queue.draining) {
      return;
    }
    queue.draining = true;
    try {
      while (queue.pending.length > 0) {
        const turn = queue.pending.shift() as QueuedTurn;
        // This turn is now active: drop its while-queued abort listener; the
        // controller linkage below owns abort from here.
        turn.detachAbort();
        const controller = new AbortController();
        linkAbort(turn.request.abortSignal, controller);
        queue.activeController = controller;
        queue.activeTurn = turn;
        queue.activeCommitted = false;
        try {
          const result = await options.run(
            { ...turn.request, abortSignal: controller.signal },
            {
              markCommitted(): void {
                if (queue.activeTurn === turn) queue.activeCommitted = true;
              },
            },
          );
          // Guard against a runner that ignores/races the abort and returns a
          // success despite an explicit cancel(): check the LOCAL controller
          // (the finally below clears queue.activeController) so a cancelled
          // active turn rejects rather than resolving success. This also covers
          // aborts propagated via request.abortSignal through linkAbort above.
          if (controller.signal.aborted && !queue.activeCommitted) {
            turn.reject(
              new AgentResponseCancelledError("Cancelled during active turn.", {
                reason: controller.signal.reason,
              }),
            );
          } else {
            turn.resolve(result);
          }
        } catch (error) {
          turn.reject(error);
        } finally {
          queue.activeController = undefined;
          queue.activeTurn = undefined;
          queue.activeCommitted = false;
        }
      }
    } finally {
      queue.draining = false;
      // Forget the conversation once fully idle so the map does not grow
      // unbounded. Safe: this runs synchronously after the while-exit, so no
      // enqueue can interleave between the empty check and the delete.
      if (queue.pending.length === 0 && queue.activeController === undefined && conversations.get(conversationId) === queue) {
        conversations.delete(conversationId);
      }
    }
  }

  function startDrain(conversationId: string, queue: ConversationQueue): void {
    if (queue.drainPromise !== undefined) {
      return;
    }
    const promise = drain(conversationId, queue);
    queue.drainPromise = promise;
    void promise.finally(() => {
      if (queue.drainPromise === promise) {
        queue.drainPromise = undefined;
      }
    }).catch(() => undefined);
  }

  return {
    enqueue(conversationId: string, request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
      if (disposed) {
        return Promise.reject(new AgentResponseCancelledError("Live session manager has been disposed."));
      }
      // Reject an already-aborted request up front: an abort listener added to an
      // already-aborted signal never fires, so it would otherwise sit in the
      // queue (consuming a pending slot behind active work) only to enter run()
      // cancelled. Rejecting here avoids retaining cancelled work entirely.
      if (request.abortSignal.aborted) {
        return Promise.reject(
          new AgentResponseCancelledError("Request was already aborted before enqueue.", {
            reason: request.abortSignal.reason,
          }),
        );
      }
      const queue = queueFor(conversationId);
      if (queue.pending.length >= maxPending) {
        return Promise.reject(
          new AgentResponseCancelledError(`Per-conversation queue is full (max ${maxPending} pending turns).`),
        );
      }
      const promise = new Promise<AgentHarnessResponse>((resolve, reject) => {
        const turn: QueuedTurn = { request, resolve, reject, detachAbort: () => {} };
        // While this turn is still queued (not yet active), an abort on its own
        // signal unlinks it and rejects immediately so a disconnected follow-up
        // is not retained behind a long-running active turn.
        const onAbort = (): void => {
          const index = queue.pending.indexOf(turn);
          if (index >= 0) {
            queue.pending.splice(index, 1);
            reject(new AgentResponseCancelledError("Cancelled while queued.", { reason: request.abortSignal.reason }));
          }
        };
        request.abortSignal.addEventListener("abort", onAbort, { once: true });
        turn.detachAbort = () => request.abortSignal.removeEventListener("abort", onAbort);
        queue.pending.push(turn);
      });
      startDrain(conversationId, queue);
      return promise;
    },
    cancel(conversationId: string, reason?: unknown): void {
      const queue = conversations.get(conversationId);
      if (queue === undefined) {
        return;
      }
      const activeCommitted = queue.activeCommitted;
      if (!activeCommitted) {
        queue.activeController?.abort(reason);
        // Settle the in-flight turn's promise directly: AbortController.abort()
        // cannot interrupt an arbitrary pending runner. After markCommitted(),
        // however, persistence is already atomic-in-progress and cancellation is
        // deliberately too late; that response is allowed to finish normally.
        queue.activeTurn?.reject(new AgentResponseCancelledError("Cancelled during active turn.", { reason }));
      }
      const dropped = queue.pending.splice(0);
      for (const turn of dropped) {
        turn.detachAbort();
        turn.reject(new AgentResponseCancelledError("Cancelled while queued.", { reason }));
      }
      // Evict the (possibly wedged) queue so future turns are not blocked by an
      // orphaned drain loop whose `draining` flag stays true while it is parked
      // inside an awaited run that ignored the abort. A subsequent enqueue() then
      // creates a fresh queue (draining=false) via queueFor() and drains
      // normally. The orphaned drain's own finally is guarded by the
      // `conversations.get(conversationId) === queue` identity check, so it will
      // not clobber a fresh queue. cancel() keeps accepting future turns — unlike
      // dispose(), we set no disposed flag; deleting the queue is sufficient.
      if (!activeCommitted) conversations.delete(conversationId);
    },
    pendingCount(conversationId: string): number {
      return conversations.get(conversationId)?.pending.length ?? 0;
    },
    async dispose(): Promise<void> {
      disposed = true;
      const committedDrains: Promise<void>[] = [];
      for (const [conversationId, queue] of conversations) {
        const activeCommitted = queue.activeCommitted;
        if (!activeCommitted) {
          queue.activeController?.abort();
          // Shutdown does not wait for an uncommitted runner to honor the abort.
          queue.activeTurn?.reject(new AgentResponseCancelledError("Live session manager has been disposed."));
        } else if (queue.drainPromise !== undefined) {
          // Once markCommitted() has fired, cancellation is deliberately too
          // late. Keep the continuation store alive until that turn finishes
          // history publication, recorder settlement, and origin activation.
          committedDrains.push(queue.drainPromise);
        }
        const dropped = queue.pending.splice(0);
        for (const turn of dropped) {
          turn.detachAbort();
          turn.reject(new AgentResponseCancelledError("Live session manager has been disposed."));
        }
        if (!activeCommitted) conversations.delete(conversationId);
      }
      await Promise.allSettled(committedDrains);
    },
  };
}
