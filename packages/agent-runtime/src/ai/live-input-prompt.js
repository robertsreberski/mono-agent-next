// Live-input prompt fragment used by AI providers when injecting human
// guidance mid-run. Lives in src/ai/ because providers are the only
// consumers; the queue/normalize/supports helpers stay in core/live-input.js
// for the API + coordinator + worker callers that don't need this string.

// A host or run `prompts.liveInputGuidance(body)` override, when supplied,
// replaces the default guidance wrapper below; otherwise the default is used.
/**
 * @param {string} text
 * @param {import('./types.js').RuntimePromptOverrides} [prompts]
 * @returns {string}
 */
export function formatLiveInputGuidance(text, prompts) {
  if (typeof prompts?.liveInputGuidance === "function") {
    return prompts.liveInputGuidance(String(text || ""));
  }
  return [
    "Live guidance from the user:",
    String(text || ""),
    "",
    "Apply this guidance before continuing. It may correct, narrow, or override your current approach.",
    "Keep satisfying the original task and existing comments except where this live guidance conflicts with them.",
    "When there is a conflict, the newest human live guidance wins. Do not discard the broader task unless the user explicitly asks to replace it.",
  ].join("\n");
}
