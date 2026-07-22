const RECALL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from",
  "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with",
]);

export function relevanceTokens(text: string): ReadonlySet<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return new Set(tokens
    .filter((token) => token.length > 1 && !RECALL_STOP_WORDS.has(token))
    .map(canonicalRelevanceToken));
}

function canonicalRelevanceToken(token: string): string {
  if (token === "decision" || token === "decided" || token === "decides" || token === "deciding") return "decide";
  if (token === "preferences" || token === "preferred" || token === "prefers") return "prefer";
  if (token === "manager" || token === "managers" || token === "managed" || token === "manages" || token === "managing") return "manage";
  if (token === "leader" || token === "leaders" || token === "led" || token === "leads" || token === "leading") return "lead";
  if (token === "base" || token === "based" || token === "live" || token === "located" || token === "location" || token === "lived" || token === "lives" || token === "living") return "locate";
  if (token === "mentored" || token === "mentors" || token === "mentoring") return "mentor";
  return token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
}

export function tokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap;
}

/**
 * Require an oriented relation phrase in the query. For active relation
 * labels, `seed ... relation` asks for an outgoing edge and `relation ...
 * seed` asks for an incoming edge. When both endpoints are named, the query
 * must preserve the stored src -> relation -> dst order. This intentionally
 * rejects ambiguous/passive phrasing rather than reversing graph semantics.
 */
export function relationDirectionMatches(
  query: string,
  seedName: string,
  relatedName: string,
  relation: string,
  seedIsSource: boolean,
  seedId: string,
  relatedId: string,
  referenceIsUnique: (entityId: string, words: readonly string[]) => boolean,
  queryEntityIds: ReadonlySet<string>,
): boolean {
  if (DISALLOWED_RELATION_LANGUAGE.test(query.normalize("NFKC"))) return false;
  const queryWords = canonicalWords(query);
  const seedMatch = entityPhraseMatch(queryWords, seedId, seedName, referenceIsUnique);
  if (seedMatch === undefined) return false;
  const seedPosition = seedMatch.position;
  const relationPhrases = normalizedRelationPhrases(relation);
  if (relationPhrases.length === 0) return false;
  const relationTokens = new Set(relationPhrases.flat());
  const relationMatch = firstPhraseMatch(queryWords, relationPhrases);
  if (relationMatch === undefined) return false;
  const relationPosition = relationMatch.position;
  if ([...queryEntityIds].some((id) => id !== seedId && id !== relatedId)) return false;
  const relatedPosition = entityPhrasePosition(queryWords, relatedId, relatedName, referenceIsUnique);
  const possessiveRole = possessiveRoleAfter(queryWords, seedMatch);
  if (possessiveRole !== undefined) {
    // `Morgan's manager/mentor/lead` asks for the incoming role-holder.
    // Other predicates later in the question (for example `based`) describe
    // the related memory and must not authorize an unrelated seed edge.
    if (relatedPosition < 0 && (
      hasMismatchedPossessiveSubject(queryWords, seedMatch)
      || !possessiveTailIsOpen(queryWords.slice(possessiveRole.position + 1))
    )) return false;
    return relationTokens.has(possessiveRole.token) && !seedIsSource;
  }
  if (relatedPosition < 0 && hasMismatchedUnresolvedEndpoint(queryWords, relationMatch, seedIsSource)) return false;

  if (relatedPosition >= 0) {
    return seedIsSource
      ? seedPosition < relationPosition && relationPosition < relatedPosition
      : relatedPosition < relationPosition && relationPosition < seedPosition;
  }
  return seedIsSource ? seedPosition < relationPosition : relationPosition < seedPosition;
}

export function canonicalWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).map(canonicalRelevanceToken);
}

export const GENERIC_ENTITY_PREFIXES = new Set(["company", "concept", "org", "organization", "person", "project", "team"]);
export const QUERY_NAME_PREFIXES = new Set([
  "can", "could", "did", "do", "does", "how", "is", "show", "what", "when", "where", "which", "who", "why", "would",
]);

const DISALLOWED_RELATION_LANGUAGE = /\b(?:no|not|never|no\s+longer|cannot|did|former|formerly|previously|historically|once|used\s+to|may|might|could|would|should|possibly|perhaps)\b|\b(?:doesn|isn|didn|can|couldn|wouldn|shouldn|wasn|weren|hasn|haven|hadn|won|don)[’']?t\b/iu;
const RELATION_AUXILIARIES = new Set(["a", "an", "are", "did", "do", "does", "is", "the", "was", "were"]);
const POLAR_QUERY_AUXILIARIES = new Set(["am", "are", "do", "does", "has", "have", "is", "was", "were"]);
const OPEN_ENDPOINT_QUESTION_WORDS = new Set(["what", "which", "who"]);
const OPEN_ENDPOINT_WORDS = new Set([
  "a", "an", "any", "anybody", "anyone", "company", "concept", "entity", "org", "organization", "person", "project", "somebody", "someone", "team", "the", "what", "which", "who",
]);

export function normalizedRelationPhrases(relation: string): string[][] {
  const normalized = relation.normalize("NFKC");
  if (DISALLOWED_RELATION_LANGUAGE.test(normalized)) return [];
  const phrase = canonicalWords(normalized).filter((word) => !RELATION_AUXILIARIES.has(word));
  if (phrase.length === 0) return [];
  // Location questions conventionally omit the stored preposition:
  // `lives in` / `based in` may be queried as `Where does X live?`.
  if (phrase.length === 2 && phrase[0] === "locate" && phrase[1] === "in") return [phrase, ["locate"]];
  return [phrase];
}

function hasMismatchedUnresolvedEndpoint(
  queryWords: readonly string[],
  relation: { readonly position: number; readonly length: number },
  seedIsSource: boolean,
): boolean {
  const possibleEndpoint = seedIsSource
    ? queryWords.slice(relation.position + relation.length)
    : queryWords.slice(POLAR_QUERY_AUXILIARIES.has(queryWords[0] ?? "") ? 1 : 0, relation.position);
  if (possibleEndpoint.length === 0 || possibleEndpoint.some((word) => OPEN_ENDPOINT_QUESTION_WORDS.has(word))) return false;
  return possibleEndpoint.some((word) => !OPEN_ENDPOINT_WORDS.has(word));
}

function entityPhraseMatch(
  queryWords: readonly string[],
  entityId: string,
  name: string,
  referenceIsUnique: (entityId: string, words: readonly string[]) => boolean,
): { readonly position: number; readonly length: number } | undefined {
  for (const variant of entityNameVariants(name)) {
    const position = phrasePosition(queryWords, variant);
    if (position < 0) continue;
    if (referenceIsUnique(entityId, variant)) return { position, length: variant.length };
  }
  return undefined;
}

function entityPhrasePosition(
  queryWords: readonly string[],
  entityId: string,
  name: string,
  referenceIsUnique: (entityId: string, words: readonly string[]) => boolean,
): number {
  return entityPhraseMatch(queryWords, entityId, name, referenceIsUnique)?.position ?? -1;
}

const POSSESSIVE_INCOMING_ROLES = new Set(["lead", "manage", "mentor"]);
const POSSESSIVE_PROPERTY_STARTERS = new Set([
  "choose", "decide", "have", "know", "leave", "like", "locate", "need", "own", "plan", "prefer", "report", "start", "use", "want", "work",
]);
const POSSESSIVE_PROPERTY_MODIFIERS = new Set(["currently", "now"]);

function possessiveRoleAfter(
  queryWords: readonly string[],
  seed: { readonly position: number; readonly length: number },
): { readonly token: string; readonly position: number } | undefined {
  const possessive = seed.position + seed.length;
  if (queryWords[possessive] !== "s") return undefined;
  for (let position = possessive + 1; position < Math.min(queryWords.length, possessive + 6); position += 1) {
    const token = queryWords[position] ?? "";
    if (POSSESSIVE_INCOMING_ROLES.has(token)) return { token, position };
  }
  return undefined;
}

function possessiveTailIsOpen(tail: readonly string[]): boolean {
  let index = 0;
  while (POSSESSIVE_PROPERTY_MODIFIERS.has(tail[index] ?? "")) index += 1;
  const first = tail[index];
  return first === undefined || POSSESSIVE_PROPERTY_STARTERS.has(first);
}

function hasMismatchedPossessiveSubject(
  queryWords: readonly string[],
  seed: { readonly position: number; readonly length: number },
): boolean {
  if (!POLAR_QUERY_AUXILIARIES.has(queryWords[0] ?? "")) return false;
  return queryWords.slice(1, seed.position).some((word) => !OPEN_ENDPOINT_WORDS.has(word));
}

export function entityNameVariants(name: string): string[][] {
  const full = canonicalWords(name);
  if (full.length <= 1 || !GENERIC_ENTITY_PREFIXES.has(full[0] ?? "")) return full.length === 0 ? [] : [full];
  return [full, full.slice(1)];
}

function phrasePosition(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return index;
  }
  return -1;
}

function firstPhraseMatch(
  words: readonly string[],
  phrases: readonly (readonly string[])[],
): { readonly position: number; readonly length: number } | undefined {
  return phrases
    .map((phrase) => ({ position: phrasePosition(words, phrase), length: phrase.length }))
    .filter((match) => match.position >= 0)
    .sort((left, right) => left.position - right.position || right.length - left.length)[0];
}

export function startsUppercase(value: string): boolean {
  const first = value[0];
  return first !== undefined && first === first.toLocaleUpperCase("en-US") && first !== first.toLocaleLowerCase("en-US");
}

export function lexicalEvidence(queryTokens: ReadonlySet<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const documentTokens = relevanceTokens(text);
  let matches = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) matches += 1;
  }
  // Two distinct meaningful terms are enough for full lexical confidence; a
  // one-term query still requires that exact term.
  return Math.min(1, matches / Math.min(2, queryTokens.size));
}
