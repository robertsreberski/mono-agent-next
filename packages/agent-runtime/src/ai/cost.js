// @ts-check

// pi 0.80 moved the static catalog reads off the pi-ai root (`getModel` is now
// deprecated/compat-only). `getBuiltinModel(provider, id)` from `providers/all`
// is the non-deprecated replacement with the same signature and the same
// undefined-on-miss behavior the pricing lookup below relies on.
import { calculateCost as calculatePiCost } from "@earendil-works/pi-ai";
import { getBuiltinModel as getPiModel } from "@earendil-works/pi-ai/providers/all";

/**
 * @typedef {Object} ParsedModelReference
 * @property {string|null} sdk
 * @property {string} [provider]
 * @property {string} model
 */

/**
 * @typedef {Object} NormalizedPricing
 * @property {number|null} input
 * @property {number|null} cacheRead
 * @property {number|null} cacheWrite
 * @property {number|null} output
 * @property {string} source
 * @property {boolean} priced
 */

/**
 * @typedef {Object} PricingInputRow
 * Duck-typed pricing row a host (or the pi catalog) supplies: either
 * camelCase or the provider's `*_per_million` snake_case spelling.
 * @property {number|string} [input]
 * @property {number|string} [input_per_million]
 * @property {number|string} [cacheRead]
 * @property {number|string} [cachedInput]
 * @property {number|string} [cached_input_per_million]
 * @property {number|string} [cacheWrite]
 * @property {number|string} [cache_write_per_million]
 * @property {number|string} [cache_creation_per_million]
 * @property {number|string} [output]
 * @property {number|string} [output_per_million]
 */

// STATIC FALLBACK, consulted only AFTER pi's live catalog (piCatalogPricing via
// getBuiltinModel("anthropic", ...)). pi's anthropic catalog already carries the
// same per-million rates for the currently-shipping models, so this table only
// wins for Claude ids pi's catalog does not (yet) know — newer/renamed models
// added here before they land in a pinned pi-ai release. STALENESS: these are
// hand-maintained USD/1M-token rates and can drift from Anthropic's published
// pricing; treat them as a best-effort backstop for cost DIAGNOSTICS only (never
// control flow), and refresh when bumping pi-ai or when Anthropic reprices.
const CLAUDE_PRICING = {
  "claude-haiku-4-5-20251001": { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
  "claude-haiku-4-5": { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-sonnet-4": { input: 3.0, cacheRead: 0.3, cacheWrite: 3.75, output: 15.0 },
  "claude-opus-4-7": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  "claude-opus-4-5": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
};

/**
 * @param {*} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
function rate(value, fallback = 0) {
  const n = finiteOrNull(value);
  return n == null ? fallback : n;
}

/**
 * @param {PricingInputRow|null|undefined} pricing
 * @param {Object} [options]
 * @param {string} [options.source]
 * @param {boolean} [options.priced]
 * @param {number} [options.missing]
 * @returns {NormalizedPricing|null}
 */
function normalizePricing(pricing, { source, priced = true, missing = 0 } = {}) {
  if (!pricing || typeof pricing !== "object") return null;
  const input = rate(pricing.input ?? pricing.input_per_million, missing);
  const cacheRead = rate(
    pricing.cacheRead
      ?? pricing.cachedInput
      ?? pricing.cached_input_per_million,
    input,
  );
  const cacheWrite = rate(
    pricing.cacheWrite
      ?? pricing.cache_write_per_million
      ?? pricing.cache_creation_per_million,
    missing,
  );
  const output = rate(pricing.output ?? pricing.output_per_million, missing);
  return { input, cacheRead, cacheWrite, output, source, priced };
}

/**
 * @param {string} source
 * @returns {NormalizedPricing}
 */
function zeroPricing(source) {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, source, priced: true };
}

/**
 * @returns {NormalizedPricing}
 */
function unknownPricing() {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, source: "unknown", priced: false };
}

/**
 * @param {string} reference
 * @returns {ParsedModelReference|null}
 */
function parseReference(reference) {
  if (typeof reference !== "string" || !reference.trim()) return null;
  if (reference.startsWith("vercel:")) {
    const rest = reference.slice("vercel:".length);
    const i = rest.indexOf(":");
    return i > 0 ? { sdk: "pi", provider: rest.slice(0, i), model: rest.slice(i + 1) } : null;
  }
  if (reference.startsWith("codex:")) {
    return { sdk: "pi", provider: "openai-codex", model: reference.slice("codex:".length) };
  }
  if (reference.startsWith("openai:")) {
    return { sdk: "pi", provider: "openai", model: reference.slice("openai:".length) };
  }
  if (reference.startsWith("pi:")) {
    const rest = reference.slice("pi:".length);
    const i = rest.indexOf(":");
    return i > 0 ? { sdk: "pi", provider: rest.slice(0, i), model: rest.slice(i + 1) } : null;
  }
  const i = reference.indexOf(":");
  if (i <= 0) return { sdk: null, model: reference };
  return { sdk: reference.slice(0, i), model: reference.slice(i + 1) };
}

/**
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isPrivateHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost"
      || host === "host.docker.internal"
      || host === "::1"
      || host.startsWith("127.")
      || host.startsWith("10.")
      || host.startsWith("192.168.")
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  } catch {
    return false;
  }
}

/**
 * @param {PricingInputRow} [pricing]
 * @returns {boolean}
 */
function pricingHasRates(pricing = {}) {
  return [
    pricing.input_per_million,
    pricing.cached_input_per_million,
    pricing.cache_write_per_million,
    pricing.output_per_million,
  ].some((value) => finiteOrNull(value) != null);
}

/**
 * Live pricing from pi-ai's builtin catalog (getBuiltinModel). Handles two
 * shapes:
 *   - sdk "pi": `parsed.provider` is the pi provider id (openai, openai-codex,
 *     github-copilot, custom, ...). Codex/openai references route here via
 *     parseReference (codex:* -> openai-codex, openai:* -> openai), so they get
 *     the SAME catalog treatment — priced when pi's catalog has that model
 *     (openai gpt-* do), unpriced (-> falls through to unknown) when it does not
 *     (e.g. openai-codex `gpt-5-codex` is not in the pinned catalog).
 *   - sdk "claude": looked up under pi's "anthropic" provider (its models carry
 *     `cost`), so pi's live rates win over the static CLAUDE_PRICING fallback.
 * @param {ParsedModelReference|null|undefined} parsed
 * @returns {import("@earendil-works/pi-ai").Model<any>|null}
 */
function piCatalogModel(parsed) {
  if (!parsed?.model) return null;
  let provider;
  if (parsed.sdk === "pi" && parsed.provider) provider = parsed.provider;
  else if (parsed.sdk === "claude") provider = "anthropic";
  else return null;
  try {
    // `provider` may be a caller-supplied id (custom providers included), wider
    // than pi-ai's built-in KnownProvider catalog union; the catalog lookup
    // itself is the runtime check, guarded by the catch below.
    return getPiModel(/** @type {*} */ (provider), parsed.model) || null;
  } catch {
    return null;
  }
}

/**
 * @param {ParsedModelReference|null|undefined} parsed
 * @returns {NormalizedPricing|null}
 */
function piCatalogPricing(parsed) {
  const model = piCatalogModel(parsed);
  return model?.cost ? normalizePricing(model.cost, { source: "pi-catalog" }) : null;
}

/**
 * @param {ParsedModelReference|null|undefined} parsed
 * @returns {NormalizedPricing|null}
 */
function claudePricing(parsed) {
  if (parsed?.sdk !== "claude") return null;
  return normalizePricing(CLAUDE_PRICING[parsed.model], { source: "claude-table" });
}

// `resolveCustomPricing(parsed) -> NormalizedPricing | null` lets a host plug
// in user-defined pricing tables. Hosts query custom model/provider stores
// in src/core/custom-pricing.js and passes the closure in via `generateResponse`.
// The pricing helpers below (`normalizePricing`, `zeroPricing`, `unknownPricing`,
// `pricingHasRates`, `isPrivateHost`, `parseReference`) are exported so hosts
// can build their own resolvers without re-implementing the row-shape conversion.
/**
 * @param {Object} [options]
 * @param {(parsed: ParsedModelReference) => (NormalizedPricing|null)} [options.resolveCustomPricing]
 * @param {string} [options.model]
 * @returns {NormalizedPricing}
 */
export function resolvePricing({ resolveCustomPricing, model } = {}) {
  const parsed = parseReference(model);
  if (!parsed) return unknownPricing();
  const custom = typeof resolveCustomPricing === "function"
    ? resolveCustomPricing(parsed)
    : null;
  return custom
    || piCatalogPricing(parsed)
    || claudePricing(parsed)
    || unknownPricing();
}

/**
 * @param {any} model
 * @param {{input: number, output: number, cacheRead: number, cacheWrite: number}} usage
 * @returns {number}
 */
function estimatePiCatalogCost(model, usage) {
  return calculatePiCost(model, {
    ...usage,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
}

export { normalizePricing, zeroPricing, unknownPricing, pricingHasRates, isPrivateHost, parseReference };

/**
 * @param {Object} [options]
 * @param {(parsed: ParsedModelReference) => (NormalizedPricing|null)} [options.resolveCustomPricing]
 * @param {string} [options.model]
 * @param {number} [options.inputTokens]
 * @param {number} [options.outputTokens]
 * @param {number} [options.cachedTokens]
 * @param {number} [options.cacheWriteTokens]
 * @param {number} [options.cacheCreationTokens]
 * @returns {number|null}
 */
export function estimateCost({
  resolveCustomPricing,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  cacheCreationTokens = 0,
} = {}) {
  const cacheRead = Math.max(0, Number(cachedTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteTokens ?? cacheCreationTokens) || 0);
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const parsed = parseReference(model);
  const customPricing = parsed && typeof resolveCustomPricing === "function"
    ? resolveCustomPricing(parsed)
    : null;
  const piModel = customPricing ? null : piCatalogModel(parsed);
  if (piModel?.cost) {
    return estimatePiCatalogCost(piModel, { input, output, cacheRead, cacheWrite });
  }
  const pricing = customPricing
    || claudePricing(parsed)
    || unknownPricing();
  if (!pricing?.priced) return null;
  const parts = [
    [input, pricing.input],
    [cacheRead, pricing.cacheRead],
    [cacheWrite, pricing.cacheWrite],
    [output, pricing.output],
  ];
  let total = 0;
  for (const [tokens, price] of parts) {
    if (tokens <= 0) continue;
    const priceNumber = finiteOrNull(price);
    if (priceNumber == null) return null;
    total += (tokens / 1_000_000) * priceNumber;
  }
  return total;
}
