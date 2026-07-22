/**
 * Precision-first evidence gate for automatic prompt injection.
 *
 * Recognized `DirectFactQuery` shapes (query -> one acceptable record):
 *
 * 1. named-property: `What is Morgan's phone number?`
 *    -> `Morgan's phone number is 555-0100.`
 * 2. choice: `What deployment color did Morgan select?`
 *    -> `Morgan selected cobalt as the deployment color.`
 * 3. event-time: `When does the release train depart now?`
 *    -> `The release train now leaves on Thursday.`
 * 4. copular-time: `What day is the API launch?`
 *    -> `The API launch date is 2026-08-14.`
 * 5. location: `Where does Morgan work?`
 *    -> `Morgan works in Amsterdam.`
 *
 * `parseDirectFactQuery` accepts only those finite query grammars;
 * `matchesDirectFact` then requires one record to satisfy the corresponding
 * fact grammar, subject, property/predicate, and answer kind. Shared
 * canonicalization permits documented aliases without loosening that pairing.
 * Ambiguous relations, unsafe clauses, reported speech, negation, and unknown
 * values therefore fail closed instead of being automatically injected.
 *
 * This is intentionally not a general natural-language parser. A semantically
 * relevant record outside these shapes remains available through the default-on
 * MemoryRecall tool.
 */

export interface RecallEvidenceHit {
  readonly record: { readonly text: string };
}

const STOP_CONCEPTS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does",
  "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our",
  "please", "remind", "show", "status", "that", "the", "this", "to", "was", "we", "were",
  "what", "when", "where", "which", "who", "with", "would", "you", "person", "project",
  "repeated", "tell", "event",
]);

const ENTITY_EXCLUSIONS = new Set([
  "what", "which", "who", "where", "when", "how", "does", "did", "the", "project",
  "remind", "show", "tell", "please",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december",
]);

const DAY_OR_MONTH = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/iu;
const DATE_VALUE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/u;
const TIME_VALUE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:noon|midnight)\b/iu;
const PHONE_VALUE = /\b(?:\+?\d[\d .()-]{5,}\d|\d{3}[- .]\d{3,})\b/u;
const SELF_RELATIVE_MESSAGE = /\b(?:your|my)\s+(?:last|previous|most recent|immediately preceding)\s+(?:message|reply|response)\b/iu;
const CURRENT_CONVERSATION = /\b(?:current|this)\s+(?:conversation|chat|thread)\b/iu;
const BARE_SEND_OR_SAY = /^\s*what did you (?:just\s+)?(?:send|say)(?:\s+just now)?\s*[?!.]*\s*$/iu;
const SEND_OR_SAY_RELATIVE = /^\s*what did you (?:send|say)\s+(?:in\s+)?(?:the\s+)?(?:last|previous|most recent|immediately preceding)\s+(?:message|reply|response)\s*[?!.]*\s*$/iu;
const UNQUALIFIED_RELATIVE_MESSAGE = /^\s*(?:what (?:was|is)|repeat|show me)\s+(?:the\s+)?(?:last|previous|most recent|immediately preceding)\s+(?:message|reply|response)\s*[?!.]*\s*$/iu;
const DURABLE_HISTORY_QUALIFIER = /\b(?:archive|archived|history|historical|yesterday|last\s+(?:week|month|year))\b|\b(?:in|during|from)\s+(?:19|20)\d{2}\b/iu;

/** True when the answer belongs to active conversation history, never durable memory. */
export function isConversationRelativeQuery(query: string): boolean {
  const normalized = query.normalize("NFKC");
  if (DURABLE_HISTORY_QUALIFIER.test(normalized)) return false;
  return SELF_RELATIVE_MESSAGE.test(normalized)
    || CURRENT_CONVERSATION.test(normalized)
    || BARE_SEND_OR_SAY.test(normalized)
    || SEND_OR_SAY_RELATIVE.test(normalized)
    || UNQUALIFIED_RELATIVE_MESSAGE.test(normalized);
}

// Ambiguous roles and relations are explicit-tool territory. In particular,
// automatic context never tries to resolve who/manager/lead/approval queries.
const ACTOR_OR_RELATION_QUERY = /\b(?:who|whose|manager|manages?|managed|lead|leads|leading|led|approve|approves|approved|approving|approval)\b/iu;
const UNSAFE_FACT_LANGUAGE = /\b(?:and|but|or|while|whereas|although|because|if|unless|since|that|which|who|after|before)\b|[,:;\n\r]/iu;
const REPORTED_OR_DITRANSITIVE = /\b(?:gave|give|gives|told|tell|tells|asked|ask|asks|said|say|says|reported|reports|discussed|discusses|mentioned|mentions|informed|informs|showed|shows|sent|sends)\b/iu;
const NEGATION_OR_UNKNOWN = /\b(?:no|not|never|neither|unknown|unset|tbd|none)\b/iu;

const ALIASES: Readonly<Record<string, string>> = {
  based: "location", city: "location", located: "location", location: "location",
  office: "location", venue: "location", where: "location", held: "location",
  car: "vehicle", cars: "vehicle", automobile: "vehicle", vehicle: "vehicle",
  changes: "deploy", change: "deploy", deployed: "deploy", deployment: "deploy",
  deployments: "deploy", released: "deploy", releasing: "deploy", rollout: "deploy",
  rollouts: "deploy", shipped: "deploy", shipping: "deploy",
  chose: "choose", chosen: "choose", chooses: "choose", picked: "choose",
  selecting: "choose", selected: "choose", select: "choose",
  colour: "color", shade: "color",
  departed: "depart", departure: "depart", departs: "depart", leave: "depart", leaves: "depart",
  date: "temporal", day: "temporal", when: "temporal",
  favourite: "preference", favorite: "preference", preferred: "preference", prefers: "preference",
  phone: "phone", telephone: "phone",
  time: "time_of_day",
};

/**
 * Singular tokens whose trailing `s` must survive the narrow suffix heuristic.
 * Both concept and proper-name canonicalization consult this one list; add a
 * documented entry here instead of embedding another literal carve-out.
 */
const TRAILING_S_SINGULARS = new Set([
  "atlas", // Proper noun; stripping the suffix would corrupt the anchor to "atla".
]);

type AnswerKind = "generic" | "location" | "temporal" | "time";

type DirectFactQuery =
  | { readonly kind: "named-property"; readonly subject: string; readonly property: string; readonly answerKind: AnswerKind }
  | { readonly kind: "choice"; readonly subject: string; readonly property: string }
  | { readonly kind: "event-time"; readonly subject: string; readonly predicate: string; readonly answerKind: "temporal" | "time" }
  | { readonly kind: "copular-time"; readonly subject: string; readonly answerKind: "temporal" | "time" }
  | { readonly kind: "location"; readonly subject: string; readonly predicate: string };

/** Return score-ordered records that independently match a canonical direct fact. */
export function selectAnswerBearingRecallHits<T extends RecallEvidenceHit>(
  query: string,
  hits: readonly T[],
): readonly T[] {
  if (hits.length === 0 || isConversationRelativeQuery(query)) return [];
  const directFact = parseDirectFactQuery(query);
  if (directFact === undefined) return [];
  return hits.filter((hit) => matchesDirectFact(directFact, hit.record.text));
}

export function hasAutomaticRecallEvidence(query: string, hits: readonly RecallEvidenceHit[]): boolean {
  return selectAnswerBearingRecallHits(query, hits).length > 0;
}

function parseDirectFactQuery(rawQuery: string): DirectFactQuery | undefined {
  const query = normalizeQuestion(rawQuery);
  if (query === undefined || ACTOR_OR_RELATION_QUERY.test(query)) return undefined;

  const namedProperty = parseNamedPropertyQuery(query);
  if (namedProperty !== undefined) return namedProperty;

  const choice = /^(?:what|which)\s+(.+?)\s+did\s+([A-Z][A-Za-z0-9-]*)\s+(select|choose|pick)$/iu.exec(query);
  if (choice !== null) {
    return {
      kind: "choice",
      subject: canonicalName(choice[2]!.toLowerCase()),
      property: canonicalPhrase(choice[1]!),
    };
  }

  const eventTime = /^(when|what\s+day|which\s+day|what\s+time)\s+does\s+(?:the\s+)?(.+?)\s+(?:now\s+)?(leave|depart|start|launch)(?:\s+now)?$/iu.exec(query);
  if (eventTime !== null) {
    return {
      kind: "event-time",
      subject: canonicalPhrase(eventTime[2]!),
      predicate: canonicalPredicate(eventTime[3]!),
      answerKind: /time/iu.test(eventTime[1]!) ? "time" : "temporal",
    };
  }

  const copularTime = /^(when\s+is|what\s+(?:date|day|time)\s+is)\s+(?:the\s+)?(.+)$/iu.exec(query);
  if (copularTime !== null) {
    return {
      kind: "copular-time",
      subject: canonicalTemporalSubject(copularTime[2]!),
      answerKind: /time/iu.test(copularTime[1]!) ? "time" : "temporal",
    };
  }

  const location = /^where\s+does\s+([A-Z][A-Za-z0-9-]*)\s+(work|live)$/iu.exec(query);
  if (location !== null) {
    return {
      kind: "location",
      subject: canonicalName(location[1]!.toLowerCase()),
      predicate: canonicalPredicate(location[2]!),
    };
  }

  return undefined;
}

function parseNamedPropertyQuery(query: string): DirectFactQuery | undefined {
  const anchor = singleNamedAnchor(query);
  if (anchor === undefined) return undefined;

  const simple = /^(what|where|when)\s+(?:is|was)\s+([A-Z][A-Za-z0-9-]*(?:['’]s)?)\s+(.+)$/iu.exec(query);
  if (simple !== null && possessiveSubject(simple[2]!) === anchor) {
    const questionWord = simple[1]!.toLowerCase();
    const property = canonicalPhrase(simple[3]!);
    return {
      kind: "named-property",
      subject: anchor,
      property,
      answerKind: questionWord === "where"
        ? "location"
        : questionWord === "when"
          ? "temporal"
          : answerKindForProperty(property),
    };
  }

  const aspect = /^(?:what|which)\s+(.+?)\s+(?:is|was)\s+([A-Z][A-Za-z0-9-]*(?:['’]s)?)\s+(.+)$/iu.exec(query);
  if (aspect !== null && possessiveSubject(aspect[2]!) === anchor) {
    const property = canonicalPhrase(`${aspect[3]!} ${aspect[1]!}`);
    return {
      kind: "named-property",
      subject: anchor,
      property,
      answerKind: answerKindForProperty(property),
    };
  }
  return undefined;
}

function matchesDirectFact(query: DirectFactQuery, rawText: string): boolean {
  const text = normalizeFactText(rawText);
  if (text === undefined) return false;

  if (query.kind === "named-property") {
    const match = /^([A-Z][A-Za-z0-9-]*)['’]s\s+(.+?)\s+(?:is|was)\s+(.+)$/iu.exec(text);
    if (match === null) return false;
    if (canonicalName(match[1]!.toLowerCase()) !== query.subject) return false;
    if (canonicalPhrase(match[2]!) !== query.property) return false;
    if (query.answerKind !== "location" && properNameConcepts(text, true).size > 1) return false;
    return hasAnswerValue(query.answerKind, query.property, match[3]!);
  }

  if (query.kind === "choice") {
    const match = /^([A-Z][A-Za-z0-9-]*)\s+(selected|chose|picked)\s+(.+?)\s+as\s+(?:the\s+)?(.+)$/iu.exec(text);
    return match !== null
      && canonicalName(match[1]!.toLowerCase()) === query.subject
      && canonicalPhrase(match[4]!) === query.property
      && properNameConcepts(text, true).size <= 1
      && hasAnswerValue("generic", query.property, match[3]!);
  }

  if (query.kind === "event-time") {
    const match = /^(?:the\s+)?(.+?)\s+(?:now\s+)?(leaves|departs|starts|launches)\s+(?:on|at)\s+(.+)$/iu.exec(text);
    return match !== null
      && canonicalPhrase(match[1]!) === query.subject
      && canonicalPredicate(match[2]!) === query.predicate
      && hasAnswerValue(query.answerKind, "temporal", match[3]!);
  }

  if (query.kind === "copular-time") {
    const match = /^(?:the\s+)?(.+?)\s+(?:is|was)\s+(.+)$/iu.exec(text);
    return match !== null
      && canonicalTemporalSubject(match[1]!) === query.subject
      && hasAnswerValue(query.answerKind, "temporal", match[2]!);
  }

  const match = /^([A-Z][A-Za-z0-9-]*)\s+(works|lives)\s+(in|at)\s+(.+)$/iu.exec(text);
  return match !== null
    && canonicalName(match[1]!.toLowerCase()) === query.subject
    && canonicalPredicate(match[2]!) === query.predicate
    && hasAnswerValue("location", "location", `${match[3]!} ${match[4]!}`);
}

function normalizeQuestion(value: string): string | undefined {
  const normalized = value.trim().replace(/[?!.]+$/u, "").replace(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeFactText(value: string): string | undefined {
  const normalized = value.trim()
    .replace(/\b([ap])\.m\./giu, "$1m")
    .replace(/[?!.]+$/u, "")
    .replace(/\s+/gu, " ");
  if (normalized.length === 0
    || /[?!.]/u.test(normalized)
    || UNSAFE_FACT_LANGUAGE.test(normalized)
    || REPORTED_OR_DITRANSITIVE.test(normalized)
    || NEGATION_OR_UNKNOWN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function hasAnswerValue(kind: AnswerKind, property: string, rawValue: string): boolean {
  const value = rawValue.trim();
  if (value.length === 0 || REPORTED_OR_DITRANSITIVE.test(value) || NEGATION_OR_UNKNOWN.test(value)) return false;
  if (property.split(" ").includes("phone")) return PHONE_VALUE.test(value);
  if (kind === "location") return /^(?:in|at)\s+\S+/iu.test(value);
  if (kind === "time") return TIME_VALUE.test(value);
  if (kind === "temporal") return TIME_VALUE.test(value) || DATE_VALUE.test(value) || DAY_OR_MONTH.test(value);
  return /[A-Za-z0-9]/u.test(value);
}

function answerKindForProperty(property: string): AnswerKind {
  const words = new Set(property.split(" "));
  if (words.has("time_of_day")) return "time";
  if (words.has("temporal")) return "temporal";
  if (words.has("location")) return "location";
  return "generic";
}

function possessiveSubject(token: string): string {
  const lower = token.toLowerCase().replace(/[’']/gu, "");
  return canonicalName(lower);
}

function singleNamedAnchor(text: string): string | undefined {
  const anchors = [...properNameConcepts(text)];
  return anchors.length === 1 ? anchors[0] : undefined;
}

function canonicalTemporalSubject(text: string): string {
  return canonicalPhrase(text).replace(/(?:^|\s)(?:temporal|time_of_day)$/u, "").trim();
}

function canonicalPredicate(value: string): string {
  const word = canonicalConcept(value.toLowerCase());
  if (word === "depart") return "depart";
  if (/^(?:start|starts)$/u.test(word)) return "start";
  if (/^(?:launch|launches)$/u.test(word)) return "launch";
  if (/^(?:work|works)$/u.test(word)) return "work";
  if (/^(?:live|lives)$/u.test(word)) return "live";
  return word;
}

function canonicalPhrase(text: string): string {
  return [...concepts(text)].join(" ");
}

export function automaticRecallEvidenceProfile(query: string): {
  readonly anchors: readonly string[];
  readonly required: readonly string[];
} {
  const anchors = properNameConcepts(query);
  const required = concepts(query);
  for (const anchor of anchors) required.delete(anchor);
  if (/\bwho\b/iu.test(query)) required.add("actor");
  if (/\bwhere\b|\bcity\b|\bvenue\b|\bheld\b/iu.test(query)) required.add("location");
  if (/\bwhen\b|\bwhat\s+day\b/iu.test(query)) required.add("temporal");
  if (/\bwhat\s+time\b/iu.test(query)) {
    required.delete("temporal");
    required.add("time_of_day");
  }
  if (/\bphone\s+number\b/iu.test(query)) required.delete("number");
  return { anchors: [...anchors].sort(), required: [...required].sort() };
}

function concepts(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    if (raw.length <= 1 || STOP_CONCEPTS.has(raw)) continue;
    const concept = canonicalConcept(raw);
    if (!STOP_CONCEPTS.has(concept)) out.add(concept);
  }
  return out;
}

function properNameConcepts(text: string, document = false): Set<string> {
  const out = new Set<string>();
  const tokens = text.match(/[A-Za-z][A-Za-z0-9]*/gu) ?? [];
  for (const [index, raw] of tokens.entries()) {
    const lower = raw.toLowerCase();
    if (ENTITY_EXCLUSIONS.has(lower)) continue;
    const proper = /^[A-Z]/u.test(raw) || /^[A-Z0-9]{2,}$/u.test(raw);
    if (!proper) continue;
    if (document && index === 0 && ["database", "nightly", "release", "project", "the"].includes(lower)) continue;
    out.add(canonicalName(lower));
  }
  return out;
}

function canonicalConcept(token: string): string {
  const alias = ALIASES[token];
  if (alias !== undefined) return alias;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4 && !TRAILING_S_SINGULARS.has(token)) return token.slice(0, -1);
  return token;
}

function canonicalName(token: string): string {
  if (token.endsWith("s") && token.length > 5 && !TRAILING_S_SINGULARS.has(token)) return token.slice(0, -1);
  return token;
}
