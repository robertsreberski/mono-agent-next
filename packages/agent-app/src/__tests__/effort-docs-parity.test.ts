import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { allConfigReferenceFields } from "../config-reference.js";
import { renderHelpTopic } from "../cli.js";

/** The `help init` detail view carries the per-route ultra-effort contract. */
function initHelpText(): string {
  const result = renderHelpTopic("init");
  if (!result.ok) {
    throw new Error(`expected \`help init\` to resolve, got: ${result.message}`);
  }
  return result.text;
}

const here = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

function normalizeProse(value: string): string {
  return value
    .replaceAll("`", "")
    .replace(/^\s*\/\/\s?/gmu, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function normalizeClause(value: string): string {
  return value.replaceAll("`", "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isCodeLikeMultilineClause(value: string): boolean {
  return /(?:\/\/|[{}]|"[^"\n]+"\s*:|\b(?:const|let|return)\b)/u.test(value);
}

function guardSentences(value: string): readonly string[] {
  const source = value.replaceAll("`", "").toLowerCase();
  const lineSentences = source
    .split(/\r?\n/gu)
    .flatMap((line) => line.split(/[.!?]+/u));
  const wrappedProseSentences = source
    .split(/[.!?]+/u)
    .filter((sentence) => !isCodeLikeMultilineClause(sentence));
  return [...new Set([...lineSentences, ...wrappedProseSentences].map(normalizeClause))];
}

type PiLowRelationKind = "copula" | "targeted" | "outcome";
type ReasoningState = "yes" | "no" | "unknown";

interface PiLowRelation {
  readonly end: number;
  readonly index: number;
  readonly kind: PiLowRelationKind;
}

interface LowMention {
  readonly end: number;
  readonly index: number;
}

interface GuardContext {
  readonly ownerPi: boolean;
  readonly reasoning: ReasoningState;
  readonly sourceUltra: boolean;
}

const PI_LOW_RELATIONS: readonly {
  readonly forms: readonly string[];
  readonly kind: PiLowRelationKind;
}[] = [
  { kind: "copula", forms: ["is", "are", "was", "were"] },
  {
    kind: "targeted",
    forms: [
      "map", "maps", "mapped", "mapping",
      "interpret", "interprets", "interpreted", "interpreting",
      "equate", "equates", "equated", "equating",
      "set", "sets", "setting",
      "treat", "treats", "treated", "treating",
      "translate", "translates", "translated", "translating",
      "convert", "converts", "converted", "converting",
      "turn", "turns", "turned", "turning",
      "render", "renders", "rendered", "rendering",
      "assign", "assigns", "assigned", "assigning",
    ],
  },
  {
    kind: "outcome",
    forms: [
      "use", "uses", "used", "using",
      "make", "makes", "made", "making",
      "get", "gets", "got", "getting",
      "select", "selects", "selected", "selecting",
      "mean", "means", "meant", "meaning",
      "yield", "yields", "yielded", "yielding",
      "result", "results", "resulted", "resulting",
      "become", "becomes", "became", "becoming",
      "apply", "applies", "applied", "applying",
      "run", "runs", "ran", "running",
      "produce", "produces", "produced", "producing",
      "give", "gives", "gave", "given", "giving",
      "choose", "chooses", "chose", "chosen", "choosing",
      "force", "forces", "forced", "forcing",
      "default", "defaults", "defaulted", "defaulting",
      "fall", "falls", "fell", "fallen", "falling",
    ],
  },
];

const RELATION_FORMS = PI_LOW_RELATIONS.flatMap(({ forms }) => forms).join("|");
const PREDICATE_CONTINUATION = new RegExp(
  String.raw`\s+\b(?:and|but)\b\s+(?=(?:(?:instead|then|also|still|directly|currently|simply)\s+)*(?:(?:it|(?:all\s+)?pi(?:\s+routes?)?)\s+)?(?:${RELATION_FORMS})\b)`,
  "u",
);
const OTHER_EFFORT = /\b(?:off|none|minimal|low|medium|high|xhigh|max)\b/u;
const LOW_BOUNDARY_WORDS: ReadonlySet<string> = new Set([
  "and", "are", "as", "but", "by", "for", "from", "if", "into", "is", "on",
  "only", "rather", "than", "to", "was", "were", "when", "while", "with",
  ...PI_LOW_RELATIONS.flatMap(({ forms }) => forms),
]);

// This finite relation-frame grammar is deliberately narrower than natural
// language. It binds Pi ownership, ultra source, LOW effort target, polarity,
// and reasoning qualification in one clause before reporting a contradiction.

function splitGuardClauses(sentence: string): readonly string[] {
  return sentence
    .split(/\s*;\s*|\s*:\s+(?=\S)|\s*,\s*(?:and|but|while|whereas|although|though)\s+/u)
    .flatMap((clause) => clause.split(PREDICATE_CONTINUATION))
    .map(normalizeClause)
    .filter((clause) => clause.length > 0);
}

function relationMatches(clause: string): readonly PiLowRelation[] {
  const lowPhrases = typedLowMentions(clause);
  const matches = PI_LOW_RELATIONS.flatMap(({ forms, kind }) => {
    const pattern = new RegExp(String.raw`\b(?:${forms.join("|")})\b`, "gu");
    return [...clause.matchAll(pattern)].map((match) => {
      const text = match[0] ?? "";
      const index = match.index ?? 0;
      return { end: index + text.length, index, kind };
    });
  });
  return matches
    .filter((relation) =>
      !lowPhrases.some((low) => relation.index > low.index && relation.index < low.end)
    )
    .sort((left, right) => left.index - right.index);
}

function typedLowMentions(clause: string): readonly LowMention[] {
  const mentions: LowMention[] = [];
  for (const match of clause.matchAll(/\blow\b(?:\s+(thinking|effort|mode|setting|level))?/gu)) {
    const text = match[0] ?? "";
    const index = match.index ?? 0;
    const end = index + text.length;
    if (match[1] === undefined) {
      if (/^[-\p{L}\p{N}_]/u.test(clause.slice(end))) continue;
      const nextWord = /^\s+([a-z][a-z-]*)\b/u.exec(clause.slice(end))?.[1];
      if (nextWord !== undefined && !LOW_BOUNDARY_WORDS.has(nextWord)) continue;
    }
    mentions.push({ end, index });
  }
  return mentions;
}

function hasUltraSource(value: string): boolean {
  return /\b(?:direct(?:ly\s+configured)?\s+)?ultra\b(?!\s+(?:support|capability|option|keyword|handling|route))\b/u.test(
    value,
  );
}

function relationIsNegated(clause: string, relation: PiLowRelation): boolean {
  const prefix = clause.slice(Math.max(0, relation.index - 120), relation.index);
  return /\b(?:cannot|can't|can\s+not|doesn't|does\s+not|don't|do\s+not|didn't|did\s+not|won't|will\s+not|wouldn't|would\s+not|couldn't|could\s+not|shouldn't|should\s+not|isn't|is\s+not|aren't|are\s+not|wasn't|was\s+not|weren't|were\s+not|not|never)(?:\s+(?:be|been|being|have|has|had|ever|directly|currently|actually|simply|just)){0,6}\s*$/u.test(
    prefix,
  ) || /\bno\s+pi(?:\s+[\w*:'-]+){0,4}\s*$/u.test(prefix);
}

function lowIsAffirmativeAt(clause: string, lowIndex: number): boolean {
  const prefix = clause.slice(Math.max(0, lowIndex - 88), lowIndex);
  return !/\b(?:no|not|never)(?:\s+[\w-]+){0,4}\s*$/u.test(prefix) &&
    !/\b(?:rather\s+than|instead\s+of|different\s+from|distinct\s+from|unrelated\s+to|separate\s+from)\s*$/u.test(
      prefix,
    );
}

function reasoningStateInClause(
  clause: string,
  inherited: ReasoningState,
  explicitPi: boolean,
): ReasoningState {
  if (
    /\bnon[- ]reasoning(?:-capable)?\s+(?:pi\b|(?:pi\s+)?routes?\b)/u.test(clause) ||
    /\bpi\b[^,;:]{0,56}\b(?:without\s+reasoning|is\s+(?:not|never)\s+reasoning-capable)\b/u.test(clause) ||
    /\bwithout\s+reasoning\b[^,;:]{0,40}\bpi\b/u.test(clause) ||
    /\b(?:not\s+reasoning-capable|non[- ]reasoning)\s+(?:pi\s+)?routes?\b/u.test(clause)
  ) {
    return "no";
  }
  if (
    /(?<!non-)\breasoning-capable\s+pi\b/u.test(clause) ||
    /\bpi\b\s+(?:is|remains)\s+reasoning-capable\b/u.test(clause) ||
    /\b(?:for|on)\s+(?:a\s+)?reasoning-capable\s+(?:pi\b|(?:pi\s+)?(?:routes?|models?)\b)/u.test(clause) ||
    /\b(?:only\s+)?(?:when|if)\s+reasoning-capable\b/u.test(clause)
  ) {
    return "yes";
  }
  return explicitPi ? "unknown" : inherited;
}

function sourceSegmentUsesUltra(
  clause: string,
  relation: PiLowRelation,
  targetStart: number,
  context: GuardContext,
): boolean {
  const argumentsText = clause.slice(relation.end, targetStart);
  const prefix = clause.slice(0, relation.index);
  if (hasUltraSource(argumentsText)) return true;
  if (/\bit\b/u.test(argumentsText)) {
    return context.sourceUltra || hasUltraSource(prefix);
  }
  if (OTHER_EFFORT.test(argumentsText)) return false;
  return hasUltraSource(prefix) || context.sourceUltra;
}

function targetedRelationHasFrame(
  clause: string,
  relation: PiLowRelation,
  context: GuardContext,
): boolean {
  for (const low of typedLowMentions(clause)) {
    if (!lowIsAffirmativeAt(clause, low.index)) continue;
    if (low.index > relation.index) {
      const lead = clause.slice(relation.end, low.index);
      const target = /\b(?:to|as|with|into)\s+(?:(?:the|a|an|its|directly|configured|effective)\s+)*$/u.exec(
        lead,
      );
      if (target !== null) {
        const targetStart = relation.end + (target.index ?? 0);
        if (sourceSegmentUsesUltra(clause, relation, targetStart, context)) return true;
      }
      continue;
    }

    const sourceTail = clause.slice(relation.end);
    if (/\bfrom\s+(?:direct(?:ly\s+configured)?\s+)?ultra\b/u.test(sourceTail)) {
      return true;
    }
  }
  return false;
}

function outcomeRelationHasFrame(
  clause: string,
  relation: PiLowRelation,
  context: GuardContext,
): boolean {
  const prefix = clause.slice(0, relation.index);
  for (const low of typedLowMentions(clause)) {
    if (!lowIsAffirmativeAt(clause, low.index)) continue;
    if (low.index < relation.index) {
      const sourceTail = clause.slice(relation.end);
      if (/\b(?:for|from)\s+(?:direct(?:ly\s+configured)?\s+)?ultra\b/u.test(sourceTail)) {
        return true;
      }
      continue;
    }

    const beforeLow = clause.slice(relation.end, low.index);
    const afterLow = clause.slice(low.end);
    const sourceAfterTarget = /\b(?:for|with|when|from|of)\s+(?:direct(?:ly\s+configured)?\s+)?ultra\b/u.test(
      afterLow,
    );
    if (
      hasUltraSource(beforeLow) ||
      sourceAfterTarget ||
      hasUltraSource(prefix) ||
      (context.sourceUltra && !OTHER_EFFORT.test(beforeLow) && !OTHER_EFFORT.test(afterLow))
    ) {
      return true;
    }
  }
  return false;
}

function copulaRelationHasFrame(
  clause: string,
  relation: PiLowRelation,
  context: GuardContext,
): boolean {
  const prefix = clause.slice(0, relation.index);
  const suffix = clause.slice(relation.end);
  for (const low of typedLowMentions(clause)) {
    if (!lowIsAffirmativeAt(clause, low.index)) continue;
    if (low.index > relation.index) {
      const predicateLead = clause.slice(relation.end, low.index);
      if (!/^\s*(?:(?:currently|directly|effectively|always|now|still|simply|just)\s+){0,3}(?:the\s+)?$/u.test(predicateLead)) {
        continue;
      }
      const sourceAfterTarget = /\b(?:for|with)\s+(?:direct(?:ly\s+configured)?\s+)?ultra\b/u.test(
        clause.slice(low.end),
      );
      const inheritedPronoun = context.sourceUltra && /^\s*it\s*$/u.test(prefix);
      if (hasUltraSource(prefix) || sourceAfterTarget || inheritedPronoun) return true;
      continue;
    }

    const ultra = /\bultra\b/gu.exec(suffix);
    if (ultra === null) continue;
    const inverseLead = suffix.slice(0, ultra.index);
    if (
      /^\s*(?:(?:currently|directly|effectively|always|now|still|simply|just)\s+){0,3}(?:(?:the\s+)?result\s+of\s+(?:direct(?:ly\s+configured)?\s+)?|(?:the\s+)?same(?:\s+effort)?\s+as\s+)?$/u.test(
        inverseLead,
      )
    ) {
      return true;
    }
  }
  return false;
}

function relationHasPiUltraLowFrame(
  clause: string,
  relation: PiLowRelation,
  context: GuardContext,
): boolean {
  if (!context.ownerPi || context.reasoning === "yes" || relationIsNegated(clause, relation)) {
    return false;
  }
  if (relation.kind === "targeted") return targetedRelationHasFrame(clause, relation, context);
  if (relation.kind === "outcome") return outcomeRelationHasFrame(clause, relation, context);
  return copulaRelationHasFrame(clause, relation, context);
}

function unqualifiedPiLowClaims(value: string): readonly string[] {
  const claims: string[] = [];
  for (const sentence of guardSentences(value)) {
    let inherited: GuardContext = { ownerPi: false, reasoning: "unknown", sourceUltra: false };
    for (const clause of splitGuardClauses(sentence)) {
      const relations = relationMatches(clause);
      const explicitPi = /\bpi\b/u.test(clause);
      const otherRuntimeOwner = !explicitPi && /\b(?:claude|codex|opencode)\b/u.test(clause);
      const explicitUltra = hasUltraSource(clause);
      const inheritsOwner = inherited.ownerPi && !otherRuntimeOwner && relations.length > 0;
      const reasoning = reasoningStateInClause(
        clause,
        explicitPi ? "unknown" : inherited.reasoning,
        explicitPi,
      );
      const context: GuardContext = {
        ownerPi: explicitPi || inheritsOwner,
        reasoning,
        sourceUltra: explicitUltra || (inheritsOwner && inherited.sourceUltra),
      };
      if (relations.some((relation) => relationHasPiUltraLowFrame(clause, relation, context))) {
        claims.push(normalizeClause(clause));
      }

      if (explicitPi || inheritsOwner) {
        inherited = context;
      } else if (otherRuntimeOwner) {
        inherited = { ownerPi: false, reasoning: "unknown", sourceUltra: false };
      }
    }
  }
  return [...new Set(claims)];
}

interface ContractSurface {
  readonly label: string;
  readonly path: string;
  readonly tableRow?: string;
}

const STATIC_CONTRACT_SURFACES: readonly ContractSurface[] = [
  { path: "packages/config/README.md", label: "config package README" },
  { path: "docs/channels/cron.md", label: "canonical cron guide" },
  { path: "docs/channels/webhook.md", label: "canonical webhook guide" },
  { path: "docs/config/blueprint.md", label: "canonical config blueprint" },
  { path: "docs/config/env-vars.md", label: "canonical environment reference" },
  { path: "docs/config/reference.md", label: "generated config reference" },
  { path: "docs/observability/cli-reference.md", label: "canonical CLI reference" },
  {
    path: "docs/reference/feature-registry.md",
    label: "feature registry runtime.effort row",
    tableRow: "runtime.effort",
  },
  {
    path: "docs/reference/feature-registry.md",
    label: "feature registry runtime.per-trigger-model row",
    tableRow: "runtime.per-trigger-model",
  },
  {
    path: "docs/runtime/execution-effort-permissions.md",
    label: "canonical runtime effort guide",
  },
  { path: "docs/runtime/index.md", label: "canonical runtime index" },
  {
    path: "packages/agent-app/schema/mono-agent.config.schema.json",
    label: "generated config schema",
  },
  {
    path: "packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md",
    label: "composer feature coverage",
  },
  {
    path: "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md",
    label: "composer config blueprint",
  },
];

function readContractSurface(surface: ContractSurface): readonly [string, string] {
  const contents = readRepoFile(surface.path);
  if (surface.tableRow === undefined) {
    return [contents, surface.label];
  }

  const prefix = `| \`${surface.tableRow}\` |`;
  const rows = contents.split(/\r?\n/gu).filter((line) => line.startsWith(prefix));
  expect(rows, `${surface.label} must resolve to exactly one table row`).toHaveLength(1);
  return [rows[0] ?? "", surface.label];
}

function expectUltraRouteContract(value: string, label: string): void {
  const prose = normalizeProse(value);
  for (const fact of [
    "reasoning-capable pi:* maps ultra to low",
    "pi without reasoning uses off",
    "direct codex:* forwards ultra unchanged",
    "mono-agent rejects ultra on its claude sdk route because the pinned sdk public contract ends at max",
    "the sdk javascript itself forwards the value",
    "the claude cli route passes --effort ultra",
    "sdk-bundled 2.1.206 and local 2.1.210",
    "warn that it is unknown, ignore it, and use default effort",
    "direct opencode rejects explicit effort",
  ]) {
    expect(prose, `${label} is missing: ${fact}`).toContain(fact);
  }
  expect(prose, `${label} must explain the escalation-only rank`).toMatch(
    /(?:effortrank places ultra above max only so keyword escalation cannot downgrade|ranking above max only prevents keyword downgrade)/u,
  );
  expect(
    unqualifiedPiLowClaims(value),
    `${label} contains a recognized unqualified Pi ultra-to-LOW mapping`,
  ).toEqual([]);
}

describe("ultra effort documentation parity", () => {
  it.each([
    "Direct ultra currently maps to LOW thinking on Pi.",
    "When ultra is configured directly, Pi maps it to LOW thinking.",
    "Pi uses LOW thinking when ultra is configured directly.",
    "LOW thinking on Pi is the result of direct ultra configuration.",
    "Direct ultra means LOW thinking for Pi.",
    "Pi selects LOW thinking for directly configured ultra.",
    "Direct ultra makes Pi thinking LOW.",
    "Pi gets LOW thinking with direct ultra.",
    "For direct ultra, Pi thinking is LOW.",
    "On Pi, ultra is LOW.",
    "On Pi, LOW is ultra.",
    "Pi accepts ultra and maps to LOW.",
    "On Pi, ultra becomes LOW.",
    "Pi interprets directly configured ultra as LOW thinking.",
    "Pi equates ultra with LOW thinking.",
    "Pi does not use OFF for ultra; instead, it maps it to LOW.",
    "Compared with reasoning-capable Codex, Pi maps ultra to LOW.",
    "Even when Pi is not reasoning-capable, ultra maps to LOW.",
    "Pi and reasoning-capable Codex map ultra to LOW.",
    "Reasoning-capable Pi differs: Pi without reasoning maps ultra to LOW.",
    "Reasoning-capable Pi maps ultra to LOW; non-reasoning routes map it to LOW.",
    "Reasoning-capable Pi maps ultra to LOW and all Pi routes map ultra to LOW.",
    "On Pi, the LOW setting is used for ultra.",
    "Pi maps both ultra and max to LOW.",
    "Pi is using LOW thinking for ultra.",
    "LOW is mapped from ultra by Pi.",
    "On Pi, LOW mode is selected for ultra.",
    "Pi accepts ultra; it is LOW.",
  ])("detects an unqualified Pi mapping regardless of word order: %s", (claim) => {
    const findings = unqualifiedPiLowClaims(claim);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("low");
  });

  it.each([
    ["A non-reasoning-capable Pi maps ultra to LOW.", "a non-reasoning-capable pi maps ultra to low"],
    [
      "Pi does not use OFF for ultra and instead maps it to LOW.",
      "instead maps it to low",
    ],
    [
      "Reasoning-capable Pi maps ultra to LOW, and all Pi routes map ultra to LOW.",
      "all pi routes map ultra to low",
    ],
  ])("keeps qualifier and negation scope local: %s", (claim, expected) => {
    expect(unqualifiedPiLowClaims(claim)).toEqual([expected]);
  });

  it.each([
    "Reasoning-capable pi:* maps ultra to LOW.",
    "For reasoning-capable Pi, ultra maps to LOW.",
    "Without reasoning, Pi maps ultra to OFF, not LOW.",
    "Pi does not map ultra to LOW.",
    "Pi thinking is not LOW for direct ultra.",
    "Pi's LOW mode differs from ultra.",
    "Reasoning-capable Pi uses ultra and maps it to LOW.",
    "Pi maps ultra not to LOW but to OFF.",
    "Pi maps ultra to OFF rather than LOW.",
    "Pi maps ultra to OFF, and LOW maps to medium in the ranking.",
    "On Pi, ultra is different from LOW.",
    "Pi maps ultra to OFF, although LOW remains available.",
    "Pi maps ultra to LOW only when reasoning-capable.",
    "Pi cannot map ultra to LOW.",
    "No Pi route maps ultra to LOW.",
    "Pi maps ultra to OFF, with LOW available as a separate effort level.",
    "On Pi, ultra is unsupported, with LOW available as a separate effort level.",
    "On Pi, LOW is not ultra.",
    "On Pi, LOW isn't ultra.",
    "On Pi, ultra cannot be mapped to LOW.",
    "Pi uses a LOW timeout when ultra is configured.",
    "Pi maps ultra to LOW for reasoning-capable routes.",
    "Pi maps ultra to LOW on reasoning-capable routes.",
    "Ultra is mapped to LOW by reasoning-capable Pi.",
    "Pi with ultra support maps max to LOW.",
    "Pi supports ultra; it uses LOW for max.",
    "Pi uses a LOW-latency path for ultra.",
  ])("allows an explicitly qualified or negated Pi mapping: %s", (claim) => {
    expect(unqualifiedPiLowClaims(claim)).toEqual([]);
  });

  it("accepts the exact documented Pi route split without leaking qualification across clauses", () => {
    expect(
      unqualifiedPiLowClaims(
        "Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF.",
      ),
    ).toEqual([]);
  });

  it("does not mistake separate model and effort config lines for a mapping claim", () => {
    expect(
      unqualifiedPiLowClaims(`{
        "model": "pi:openai-codex:gpt-5.6-sol",
        "effort": "medium" // none|low|medium|high|max|ultra
      }`),
    ).toEqual([]);
  });

  it("keeps canonical docs, generated reference, CLI help, and composer references route-specific", () => {
    const runtimeEffort = allConfigReferenceFields().find(
      (field) => field.jsonPath === "runtime.effort",
    );
    expect(runtimeEffort).toBeDefined();

    const surfaces = [
      ...STATIC_CONTRACT_SURFACES.map(readContractSurface),
      [runtimeEffort?.description ?? "", "config reference source"],
      [initHelpText(), "built CLI help source"],
    ] as const;

    for (const [surface, label] of surfaces) {
      expectUltraRouteContract(surface, label);
    }
  });
});
