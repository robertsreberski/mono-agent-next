import { describe, expect, it } from "vitest";

import { renderTelegramMarkdown } from "../telegram-markdown.js";

describe("renderTelegramMarkdown", () => {
  it("renders bold using MarkdownV2 single-asterisk syntax", () => {
    expect(renderTelegramMarkdown("**bold**")).toBe("*bold*");
  });

  it("preserves inline code spans", () => {
    expect(renderTelegramMarkdown("Run `npm i` now")).toBe("Run `npm i` now");
  });

  it("keeps parenthesized URLs intact by escaping the inner parens", () => {
    const out = renderTelegramMarkdown(
      "See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)).",
    );
    // The whole URL survives (old regex converter truncated it at the first ")").
    expect(out).toContain("https://en.wikipedia.org/wiki/Foo_\\(bar\\)");
    expect(out).not.toContain("Foo_(bar)");
  });

  it("resolves overlapping emphasis into valid, non-overlapping markup", () => {
    const out = renderTelegramMarkdown("**bold _and** italic_");
    // Old converter emitted overlapping <b>/<i> → invalid → raw-markdown fallback.
    expect(out).not.toContain("**");
    expect(out).toBe("*bold \\_and* italic\\_");
  });

  it("renders bold spanning multiple lines", () => {
    expect(renderTelegramMarkdown("**line one\nline two**")).toBe(
      "*line one\nline two*",
    );
  });

  it("escapes MarkdownV2 reserved characters in prose", () => {
    expect(renderTelegramMarkdown("Cost is 5_000 (approx) > 4.")).toBe(
      "Cost is 5\\_000 \\(approx\\) \\> 4\\.",
    );
  });

  it("escapes table pipes instead of leaking raw markdown", () => {
    const out = renderTelegramMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("\\|");
    expect(out).not.toMatch(/(^|\n)\| A \| B \|/);
  });

  it("trims the trailing newline the converter appends", () => {
    expect(renderTelegramMarkdown("hello")).toBe("hello");
  });

  it("returns an empty string for empty input", () => {
    expect(renderTelegramMarkdown("")).toBe("");
  });
});
