/**
 * In-memory transcript store for the TUI history pane.
 *
 * Hosts that need persistence across TUI restarts can implement
 * TuiHistoryStore against their own backend (the harness has its own
 * conversation history; this store is purely for what the user sees).
 */

export type TuiHistoryRole = "user" | "assistant";

export type TuiHistoryStatus = "ok" | "cancelled" | "error";

export interface TuiHistoryMessage {
  readonly id: string;
  readonly role: TuiHistoryRole;
  readonly text: string;
  readonly timestamp: number;
  readonly conversationId?: string;
  readonly status?: TuiHistoryStatus;
  readonly metadata?: Record<string, unknown>;
}

export interface TuiHistoryStore {
  list(): readonly TuiHistoryMessage[];
  append(message: TuiHistoryMessage): void;
  remove(id: string): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export interface CreateInMemoryTuiHistoryOptions {
  readonly maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 500;

export function createInMemoryTuiHistory(
  options: CreateInMemoryTuiHistoryOptions = {},
): TuiHistoryStore {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new RangeError("maxMessages must be a positive integer.");
  }

  let messages: TuiHistoryMessage[] = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Swallow listener errors so one bad subscriber cannot break the
        // store; the TUI app re-renders on every notify anyway.
      }
    }
  };

  return {
    list(): readonly TuiHistoryMessage[] {
      return messages;
    },
    append(message: TuiHistoryMessage): void {
      messages = [...messages, message];
      if (messages.length > maxMessages) {
        messages = messages.slice(messages.length - maxMessages);
      }
      notify();
    },
    remove(id: string): void {
      const next = messages.filter((message) => message.id !== id);
      if (next.length === messages.length) {
        return;
      }
      messages = next;
      notify();
    },
    clear(): void {
      if (messages.length === 0) {
        return;
      }
      messages = [];
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
