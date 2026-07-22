import { describe, expect, it } from "vitest";

import { redactJsonValue, truncateString } from "../redaction.js";

describe("redactJsonValue", () => {
  it("redacts sensitive keys", () => {
    expect(redactJsonValue({ apiKey: "fixture", token: "fixture", nested: { secret: "x" } })).toEqual({
      apiKey: "[redacted]",
      token: "[redacted]",
      nested: { secret: "[redacted]" },
    });
  });

  it.each([
    "credential",
    "serviceCredentials",
    "CREDENTIAL",
    "private_key",
    "private-key",
    "privateKey",
    "PRIVATE_KEY",
    "client_secret",
    "client-secret",
    "clientSecret",
    "CLIENT_SECRET",
    "bearer",
    "oauthBearer",
    "BEARER",
  ])("redacts the %s key family across common naming styles", (key) => {
    expect(redactJsonValue({ [key]: "fixture-value" })).toEqual({ [key]: "[redacted]" });
  });

  it("does not content-scan free text whose object keys are not sensitive", () => {
    const freeText =
      "credential=fixture private_key=fixture client_secret=fixture authorization=Bearer fixture-value";

    expect(redactJsonValue({ systemPrompt: freeText, userInput: freeText, toolOutput: freeText })).toEqual({
      systemPrompt: freeText,
      userInput: freeText,
      toolOutput: freeText,
    });
  });

  it("keeps numeric values under sensitive-looking keys (token COUNTS, not secrets)", () => {
    // `*_tokens` match /token/ but are usage counts we need for cost observability;
    // secrets are always strings, so only the string token is redacted.
    expect(
      redactJsonValue({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 8,
        credentialCount: 2,
        bearerCount: 1,
        cost_usd: 0.5,
        token: "fixture-value",
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 8,
      credentialCount: 2,
      bearerCount: 1,
      cost_usd: 0.5,
      token: "[redacted]",
    });
  });

  it("marks circular references as [circular]", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    expect(redactJsonValue(value)).toEqual({ name: "root", self: "[circular]" });
  });

  it("caps recursion at depth 12 with [max-depth]", () => {
    // Build a chain 0..13 deep so the value AT depth 12 is replaced.
    let leaf: Record<string, unknown> = { end: "deep" };
    for (let i = 0; i < 13; i += 1) {
      leaf = { child: leaf };
    }
    const redacted = redactJsonValue(leaf) as Record<string, unknown>;
    // Walk down 12 levels of `child`; the 12th nested value is replaced by the sentinel.
    let cursor: unknown = redacted;
    for (let i = 0; i < 12; i += 1) {
      cursor = (cursor as Record<string, unknown>).child;
    }
    expect(cursor).toBe("[max-depth]");
  });

  it("truncates Error messages through the same string budget", () => {
    const redacted = redactJsonValue(new Error("x".repeat(80)), 16) as { message?: unknown };

    expect(redacted.message).toBe(`${"x".repeat(16)}…[truncated 64 bytes]`);
  });

  it("bounds broad arrays and objects", () => {
    const redacted = redactJsonValue({
      entries: Array.from({ length: 2_000 }, (_, index) => ({ index, value: "x".repeat(4) })),
      object: Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`k${index}`, index])),
    }) as { entries: unknown[]; object: Record<string, unknown> };

    expect(redacted.entries).toHaveLength(1_001);
    expect(redacted.entries.at(-1)).toEqual("[max-items]");
    expect(Object.keys(redacted.object)).toHaveLength(1_001);
    expect(redacted.object.__truncated__).toBe("[max-keys]");
  });

  it("redacts high-confidence secret-shaped substrings from plain strings when opted in", () => {
    const fixtures = [
      ["sk", "-", "A".repeat(48)].join(""),
      ["sk", "-proj-", "B".repeat(64)].join(""),
      ["sk", "-svcacct-", "C".repeat(64)].join(""),
      ["ghp", "_", "B".repeat(36)].join(""),
      ["github", "_pat_", "C".repeat(24)].join(""),
      ["AK", "IA", "D".repeat(16)].join(""),
      ["xox", "a-", "E".repeat(24)].join(""),
      ["xox", "b-", "E".repeat(24)].join(""),
      ["xox", "p-", "E".repeat(24)].join(""),
      ["xox", "r-", "E".repeat(24)].join(""),
      ["xox", "s-", "E".repeat(24)].join(""),
      ["xapp", "-1-", "F".repeat(24)].join(""),
    ];
    const prose = `prefix ${fixtures.join(" middle ")} suffix`;

    expect(redactJsonValue(prose, 4_096, { contentPatternRedaction: true })).toBe(
      `prefix ${fixtures.map(() => "[redacted]").join(" middle ")} suffix`,
    );
  });

  it("leaves content scanning disabled by default", () => {
    const fixture = ["sk", "-", "A".repeat(48)].join("");
    expect(redactJsonValue(`plain key: ${fixture}`)).toBe(`plain key: ${fixture}`);
  });

  it("leaves ordinary prefix prose and near-miss token shapes untouched", () => {
    const prose = [
      "The sk- prefix is documented here.",
      "ghp_ is a token-family label.",
      "AKIA is also a personal name.",
      "xoxb- alone is not a credential.",
      "sk-SK-localization-resource-name",
      "sk-NO-translation-catalog-entry",
      "sk-proj-localization-resource-name-for-tests",
      "sk-svcacct-development-profile-name",
      ["sk", "-", "A".repeat(47)].join(""),
      ["sk", "-", "A".repeat(49)].join(""),
      ["ghp", "_", "A".repeat(35)].join(""),
      ["AK", "IA", "B".repeat(15)].join(""),
    ].join(" ");

    expect(redactJsonValue(prose, 4_096, { contentPatternRedaction: true })).toBe(prose);
  });

  it("preserves one stable truncation marker when scanning an already-truncated secret", () => {
    const fixture = ["xox", "b-", "A".repeat(24)].join("");
    const original = `prefix ${fixture} ${"x".repeat(256)}`;
    const truncated = truncateString(original, 64);
    const marker = truncated.slice(truncated.indexOf("…[truncated"));

    const once = redactJsonValue(truncated, 64, { contentPatternRedaction: true }) as string;
    const twice = redactJsonValue(once, 64, { contentPatternRedaction: true }) as string;

    expect(once).toBe(`prefix [redacted] ${"x".repeat(27)}${marker}`);
    expect(once.match(/…\[truncated/gu)).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("applies content-pattern scanning recursively without weakening key redaction", () => {
    const fixture = ["xox", "p-", "A".repeat(24)].join("");
    expect(
      redactJsonValue(
        { note: `credential: ${fixture}`, nested: [`again ${fixture}`], apiKey: "not-shape-dependent" },
        4_096,
        { contentPatternRedaction: true },
      ),
    ).toEqual({
      note: "credential: [redacted]",
      nested: ["again [redacted]"],
      apiKey: "[redacted]",
    });
  });
});

describe("truncateString", () => {
  it("returns the value unchanged at the maxStringBytes boundary", () => {
    const value = "a".repeat(64);
    expect(truncateString(value, 64)).toBe(value);
  });

  it("truncates one byte past the boundary with the UTF-8 byte count", () => {
    const value = "a".repeat(65);
    // Prior implementation used Buffer.byteLength(value, "utf8") === 65.
    expect(truncateString(value, 64)).toBe(`${value.slice(0, 64)}…[truncated 1 bytes]`);
  });

  it("keeps the retained text within the byte cap for multi-byte input (no split code points)", () => {
    // "😀" is 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes.
    const emoji = "😀".repeat(20); // 80 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(emoji).length).toBe(80);

    const out = truncateString(emoji, 64);
    const head = out.split("…[truncated")[0]!;
    // The kept head must not exceed the cap...
    expect(encoder.encode(head).length).toBeLessThanOrEqual(64);
    // ...and must remain whole emoji (4-byte boundary), not a split code point.
    expect(head).toBe("😀".repeat(16)); // 16 * 4 = 64 bytes
    expect(out).toBe(`${"😀".repeat(16)}…[truncated 16 bytes]`);
  });

  it("cuts CJK input on a UTF-8 boundary at or below the byte cap", () => {
    // Each CJK char is 3 UTF-8 bytes; 64 is not a multiple of 3.
    const cjk = "観".repeat(30); // 90 UTF-8 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(cjk).length).toBe(90);

    const out = truncateString(cjk, 64);
    const head = out.split("…[truncated")[0]!;
    // 21 chars = 63 bytes is the largest whole-character cut at or below 64.
    expect(encoder.encode(head).length).toBe(63);
    expect(encoder.encode(head).length).toBeLessThanOrEqual(64);
    expect(out).toBe(`${"観".repeat(21)}…[truncated 27 bytes]`);
  });

  it("preserves its canonical omitted-byte marker across repeated boundaries", () => {
    const once = truncateString("x".repeat(100_000), 4_096);
    const multibyteOnce = truncateString("観".repeat(100_000), 4_096);

    expect(once).toBe(`${"x".repeat(4_096)}…[truncated 95904 bytes]`);
    expect(truncateString(once, 4_096)).toBe(once);
    expect(multibyteOnce).toBe(`${"観".repeat(1_365)}…[truncated 295905 bytes]`);
    expect(truncateString(multibyteOnce, 4_096)).toBe(multibyteOnce);
  });

  it("does not trust a marker whose claimed original value fit within the boundary", () => {
    const impossibleMarker = `${"x".repeat(4_093)}…[truncated 1 bytes]`;

    expect(truncateString(impossibleMarker, 4_096)).toBe(
      `${"x".repeat(4_093)}……[truncated 19 bytes]`,
    );
  });
});
