// Shared pi error-normalization helpers.
//
// Extracted so the pi-native bridge does not have to import from a sibling
// provider module. The message normalizer unwraps nested provider error
// envelopes; the context-limit classifier delegates to the runtime-wide
// taxonomy so every bridge makes the same fallback decision.

import { isContextLimitFailureText } from "../failure.js";

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function normalizePiErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const codexMatch = /^Codex error:\s*(\{[\s\S]*\})$/i.exec(text);
  const parsed = tryParseJson(codexMatch ? codexMatch[1] : text);
  const nested = parsed?.error || parsed;
  if (typeof nested?.message === "string" && nested.message.trim()) return nested.message.trim();
  if (typeof nested?.error?.message === "string" && nested.error.message.trim()) return nested.error.message.trim();
  return text;
}

export function isContextLimitError(message) {
  return isContextLimitFailureText(message);
}

// Best-effort extraction of the model's real context-window ceiling from an
// overflow error. Providers usually state the limit ("maximum context length is
// 200000 tokens", "context window of 128000", "this model supports at most
// 32768 tokens"). We use the discovered value to lower the proactive compaction
// trigger on the running model so a wrong/default contextWindow self-corrects.
// Returns the smallest plausible token count found, or null.
export function parseContextLimitFromError(message) {
  const text = String(message || "");
  if (!text) return null;
  // Capture a number that sits next to context/window/token wording, tolerating
  // separators in large numbers (e.g. "128,000" or "128 000"). Phrases like
  // "however you requested 210000 tokens" would over-count the limit, so we
  // anchor on max/limit/context/window wording and take the smallest match.
  const patterns = [
    /(?:maximum|max(?:imum)?)\s+context\s+(?:length|window)\s*(?:is|of|=|:)?\s*([\d][\d,_ ]*)/ig,
    /context\s+(?:length|window|budget)\s*(?:is|of|=|:)?\s*([\d][\d,_ ]*)/ig,
    /(?:maximum|max(?:imum)?|at most|supports?(?:\s+up\s+to)?)\s+([\d][\d,_ ]*)\s*(?:input\s+)?tokens?/ig,
    /(?:token|context)\s+limit\s*(?:is|of|=|:)?\s*([\d][\d,_ ]*)/ig,
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(String(m[1]).replace(/[,_ ]/g, ""));
      // Guard against matching small token counts (e.g. "8 tokens") that are not
      // a real window; a context window is at least a few thousand tokens.
      if (Number.isFinite(n) && n >= 1000) found.push(n);
    }
  }
  if (found.length === 0) return null;
  return Math.min(...found);
}
