// Metadata-only live-input acknowledgement instrumentation.
//
// Provider bridges already call message.acknowledge() only after their native
// steering boundary accepts guidance. Wrapping that callback here creates one
// adapter-neutral `live_input_applied` event without copying the guidance body
// into runtime telemetry. A wrapper owns one logical-run dedupe set and is
// intentionally reused by the fallback router across provider attempts.

// @ts-check

const LIVE_INPUT_APPLIED_INSTRUMENTED = Symbol("mono-agent.live-input-applied-instrumented");

/**
 * @typedef {{body: string, id?: string, receivedAt?: string, acknowledge?: () => void, reject?: (reason?: unknown) => void}} RuntimeLiveInputMessage
 * @typedef {{type: "live_input_applied", inputId: string, receivedAt?: string}} LiveInputAppliedEvent
 */

/**
 * @param {AsyncIterable<RuntimeLiveInputMessage>|undefined} liveInput
 * @param {(event: LiveInputAppliedEvent) => void} onApplied
 * @returns {AsyncIterable<RuntimeLiveInputMessage>|undefined}
 */
export function instrumentLiveInputAppliedEvents(liveInput, onApplied) {
  if (liveInput === undefined || isInstrumented(liveInput)) return liveInput;

  const appliedInputIds = new Set();
  const instrumented = {
    [LIVE_INPUT_APPLIED_INSTRUMENTED]: true,
    [Symbol.asyncIterator]() {
      const iterator = liveInput[Symbol.asyncIterator]();
      let ordinal = 0;
      return {
        async next() {
          const next = await iterator.next();
          if (next.done === true) return next;
          ordinal += 1;
          const message = next.value;
          const inputId = stableInputId(message?.id, ordinal);
          const receivedAt = typeof message?.receivedAt === "string" && message.receivedAt.length > 0
            ? message.receivedAt
            : undefined;
          const acknowledge = typeof message?.acknowledge === "function"
            ? message.acknowledge.bind(message)
            : undefined;
          return {
            done: false,
            value: {
              ...message,
              acknowledge: () => {
                acknowledge?.();
                if (appliedInputIds.has(inputId)) return;
                appliedInputIds.add(inputId);
                try {
                  onApplied({
                    type: "live_input_applied",
                    inputId,
                    ...(receivedAt === undefined ? {} : { receivedAt }),
                  });
                } catch {
                  // Telemetry must never turn accepted guidance into a provider
                  // failure after the native steering call already succeeded.
                }
              },
            },
          };
        },
        async return(value) {
          return typeof iterator.return === "function"
            ? iterator.return(value)
            : { done: true, value };
        },
        async throw(error) {
          if (typeof iterator.throw === "function") return iterator.throw(error);
          throw error;
        },
      };
    },
  };
  return /** @type {AsyncIterable<RuntimeLiveInputMessage>} */ (instrumented);
}

/** @param {unknown} value */
function isInstrumented(value) {
  return typeof value === "object"
    && value !== null
    && value[LIVE_INPUT_APPLIED_INSTRUMENTED] === true;
}

/** @param {unknown} value @param {number} ordinal */
function stableInputId(value, ordinal) {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : `anonymous:${ordinal}`;
}
