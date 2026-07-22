/** Maximum model completion accepted by the loose JSON decoder (256 KiB in JS characters). */
export const MAX_MODEL_JSON_CHARS = 256 * 1024;

/**
 * At most this many bracket candidates are scanned concurrently. This keeps a
 * malformed prefix with thousands of unmatched openers linear while retaining
 * enough nesting for ordinary model-authored JSON.
 */
export const MAX_OVERLAPPING_JSON_CANDIDATES = 64;

interface CandidateScan {
  readonly start: number;
  readonly stack: Array<"[" | "{">;
  inString: boolean;
  escaped: boolean;
}

export interface JsonLooseScanDiagnostics<T> {
  readonly value: T | undefined;
  readonly characters: number;
  readonly candidateSteps: number;
  readonly parseAttempts: number;
  readonly rejectedForSize: boolean;
}

/** Extract the largest top-level JSON object/array from an LLM completion, tolerating prose/code fences. */
export function parseJsonLoose<T>(text: string): T | undefined {
  return parseJsonLooseWithDiagnostics<T>(text).value;
}

/**
 * Parse one exact bounded JSON value while rejecting duplicate object keys and
 * pathological nesting. Used only by strong model-output contracts; legacy
 * compatibility surfaces retain the loose decoder below.
 */
export function parseJsonExact<T>(text: string): T {
  if (text.length > MAX_MODEL_JSON_CHARS) throw new Error("JSON exceeds the model-output bound");
  let cursor = 0;
  const skipWhitespace = (): void => {
    while (cursor < text.length && /[\t\n\r ]/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const parseStringToken = (): string => {
    if (text[cursor] !== '"') throw new Error("expected a JSON string");
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor]!;
      cursor += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return JSON.parse(text.slice(start, cursor)) as string;
      }
      if (char.charCodeAt(0) < 0x20) throw new Error("unescaped control in JSON string");
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (depth: number): void => {
    if (depth > 64) throw new Error("JSON nesting exceeds the model-output bound");
    skipWhitespace();
    const char = text[cursor];
    if (char === '"') {
      parseStringToken();
      return;
    }
    if (char === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = parseStringToken();
        if (keys.has(key)) throw new Error("duplicate JSON object key");
        keys.add(key);
        skipWhitespace();
        if (text[cursor] !== ":") throw new Error("expected a JSON object colon");
        cursor += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw new Error("expected a JSON object comma");
        cursor += 1;
      }
    }
    if (char === "[") {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw new Error("expected a JSON array comma");
        cursor += 1;
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(cursor))?.[0];
    if (number === undefined) throw new Error("invalid JSON value");
    cursor += number.length;
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== text.length) throw new Error("trailing data after JSON value");
  return JSON.parse(text) as T;
}

/** Internal-module diagnostic surface used to prove bounded linear scan work without wall-clock assertions. */
export function parseJsonLooseWithDiagnostics<T>(text: string): JsonLooseScanDiagnostics<T> {
  // Reject before fence discovery, slicing, or JSON.parse. Model output is an
  // untrusted boundary and callers do not need arbitrarily large payloads.
  if (text.length > MAX_MODEL_JSON_CHARS) {
    return { value: undefined, characters: 0, candidateSteps: 0, parseAttempts: 0, rejectedForSize: true };
  }

  const body = firstFenceBody(text);
  const active: CandidateScan[] = [];
  let best: { readonly value: unknown; readonly len: number } | undefined;
  let candidateSteps = 0;
  let parseAttempts = 0;

  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (ch === undefined) break;

    // Advance candidates that began before this character. Every candidate
    // owns its string/escape state, so malformed prose before a real payload
    // cannot hide a later object. The active set is hard bounded above.
    for (let candidateIndex = active.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = active[candidateIndex]!;
      candidateSteps += 1;
      const outcome = advanceCandidate(candidate, ch);
      if (outcome === "continue") continue;
      active.splice(candidateIndex, 1);
      if (outcome === "invalid") continue;

      const slice = body.slice(candidate.start, index + 1);
      try {
        parseAttempts += 1;
        const value = JSON.parse(slice) as unknown;
        if (best === undefined || slice.length > best.len) best = { value, len: slice.length };
      } catch {
        // Balanced punctuation is not necessarily JSON; keep scanning.
      }
    }

    if (ch !== "[" && ch !== "{") continue;
    if (active.length >= MAX_OVERLAPPING_JSON_CANDIDATES) {
      // Prefer recent starts so a valid value after a long unmatched prefix is
      // still considered. Only pathological >64-deep JSON loses its outermost
      // candidate; inner candidates remain recoverable.
      active.shift();
    }
    active.push({ start: index, stack: [ch], inString: false, escaped: false });
  }

  return {
    value: best?.value as T | undefined,
    characters: body.length,
    candidateSteps,
    parseAttempts,
    rejectedForSize: false,
  };
}

function advanceCandidate(candidate: CandidateScan, ch: string): "continue" | "complete" | "invalid" {
  if (candidate.inString) {
    if (candidate.escaped) candidate.escaped = false;
    else if (ch === "\\") candidate.escaped = true;
    else if (ch === '"') candidate.inString = false;
    return "continue";
  }
  if (ch === '"') {
    candidate.inString = true;
    return "continue";
  }
  if (ch === "[" || ch === "{") {
    candidate.stack.push(ch);
    return "continue";
  }
  if (ch !== "]" && ch !== "}") return "continue";

  const open = candidate.stack.at(-1);
  if ((ch === "]" && open !== "[") || (ch === "}" && open !== "{")) return "invalid";
  candidate.stack.pop();
  return candidate.stack.length === 0 ? "complete" : "continue";
}

/** Return the first fenced body, or only its remainder when model output truncates before the closing fence. */
function firstFenceBody(text: string): string {
  const fence = text.indexOf("```");
  if (fence === -1) return text;
  let start = fence + 3;
  if (text.slice(start, start + 4).toLocaleLowerCase("en-US") === "json") start += 4;
  while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
  const end = text.indexOf("```", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}
