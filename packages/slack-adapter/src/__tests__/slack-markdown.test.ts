import { describe, expect, it } from "vitest";

import {
  formatMarkdownForSlack,
  normalizeSlackMarkdownToMarkdown,
} from "../slack-markdown.js";

describe("formatMarkdownForSlack", () => {
  it("translates common Markdown inline styles to Slack mrkdwn", () => {
    expect(formatMarkdownForSlack("**bold** __also bold__ *italic* ~~gone~~")).toBe(
      "*bold* *also bold* _italic_ ~gone~",
    );
  });

  it("translates Markdown links and escapes Slack control characters", () => {
    expect(
      formatMarkdownForSlack("Read [the report](https://example.com?a=1&b=2) <soon> & carefully"),
    ).toBe(
      "Read <https://example.com?a=1&amp;b=2|the report> &lt;soon&gt; &amp; carefully",
    );
  });

  it("preserves balanced parentheses in Markdown link destinations", () => {
    expect(
      formatMarkdownForSlack("Read [Wikipedia](https://en.wikipedia.org/wiki/Parenthesis_(rhetoric))"),
    ).toBe("Read <https://en.wikipedia.org/wiki/Parenthesis_(rhetoric)|Wikipedia>");
    expect(
      formatMarkdownForSlack("Read [nested](https://example.com/a_(b_(c)))"),
    ).toBe("Read <https://example.com/a_(b_(c))|nested>");
    expect(
      formatMarkdownForSlack("Read [escaped](https://example.com/a\\))"),
    ).toBe("Read <https://example.com/a)|escaped>");
    expect(
      formatMarkdownForSlack("Read [escaped](https://example.com/a\\(b)"),
    ).toBe("Read <https://example.com/a(b|escaped>");
    expect(
      formatMarkdownForSlack(String.raw`Read [escaped](https://example.com/a\\\(b)`),
    ).toBe(String.raw`Read <https://example.com/a\(b|escaped>`);
  });

  it("formats headings while preserving list and quote shape", () => {
    expect(
      formatMarkdownForSlack("## Summary\n- first item\n> quoted **text**"),
    ).toBe(
      "*Summary*\n- first item\n> quoted *text*",
    );
  });

  it("preserves inline and fenced code blocks", () => {
    const markdown = "Use `**literal** <value>`\n```ts\nconst value = \"<raw>\";\n```";

    expect(formatMarkdownForSlack(markdown)).toBe(markdown);
  });

  it("keeps inline code separate from generated Slack links", () => {
    expect(formatMarkdownForSlack("Use `[raw](value)` and [real](https://example.com)")).toBe(
      "Use `[raw](value)` and <https://example.com|real>",
    );
  });

  it("restores nested protected segments without leaking sentinel tokens", () => {
    // A link inside bold nests one protected token inside another token's
    // payload; ascending-order restore left the inner token unrestored and
    // leaked U+E000/U+E001 sentinels into delivered Slack messages.
    expect(formatMarkdownForSlack("**see [x](https://u.example)**")).toBe(
      "*see <https://u.example|x>*",
    );
    expect(
      formatMarkdownForSlack("**[a](https://a.example)** and __[b](https://b.example)__"),
    ).toBe("*<https://a.example|a>* and *<https://b.example|b>*");
    expect(formatMarkdownForSlack("**see [x](https://u.example)**")).not.toMatch(/[]/u);
  });
});

describe("normalizeSlackMarkdownToMarkdown", () => {
  it("normalizes Slack standup-style bullets, links, nbsp indentation, and emphasis", () => {
    const slack = [
      "\u2022 Example 2.0 release lead / release wrangling",
      "\u00a0\u00a0\u25e6 Cut and coordinated <https://code.example.test/example/project/releases/tag/2.0-beta|Example 2.0-beta>, including <https://issues.example.test/browse/EXAMPLE-1081|EXAMPLE-1081>.",
      "",
      "\u2022 _Example.com / Example launch work_",
      "\u00a0\u00a0\u25e6 Landed <https://code.example.test/example/theme/pull/42|theme update>.",
    ].join("\n");

    expect(normalizeSlackMarkdownToMarkdown(slack)).toBe(
      [
        "- Example 2.0 release lead / release wrangling",
        "  - Cut and coordinated [Example 2.0-beta](https://code.example.test/example/project/releases/tag/2.0-beta), including [EXAMPLE-1081](https://issues.example.test/browse/EXAMPLE-1081).",
        "",
        "- *Example.com / Example launch work*",
        "  - Landed [theme update](https://code.example.test/example/theme/pull/42).",
      ].join("\n"),
    );
  });

  it("translates Slack inline styles and escapes back to standard Markdown text", () => {
    expect(
      normalizeSlackMarkdownToMarkdown("*bold* _italic_ ~gone~ <https://example.com?a=1&amp;b=2|the report> &lt;soon&gt; &amp; carefully"),
    ).toBe(
      "**bold** *italic* ~~gone~~ [the report](https://example.com?a=1&b=2) <soon> & carefully",
    );
  });

  it("preserves inline and fenced code while normalizing surrounding Slack text", () => {
    const slack = "Use `<https://example.com|literal>`\n```txt\n*literal* <raw>\n```\n*outside*";

    expect(normalizeSlackMarkdownToMarkdown(slack)).toBe(
      "Use `<https://example.com|literal>`\n```txt\n*literal* <raw>\n```\n**outside**",
    );
  });

  it("emits valid Markdown destinations for Slack links with parentheses", () => {
    expect(
      normalizeSlackMarkdownToMarkdown(
        "<https://en.wikipedia.org/wiki/Parenthesis_(rhetoric)|Wikipedia>",
      ),
    ).toBe("[Wikipedia](https://en.wikipedia.org/wiki/Parenthesis_%28rhetoric%29)");
  });

  it("normalizes nonbreaking spaces outside, but not inside, protected code", () => {
    const nonbreakingSpace = "\u00a0";
    const slack = `outside${nonbreakingSpace}text \`inline${nonbreakingSpace}code\`\n\`\`\`txt\nfenced${nonbreakingSpace}code\n\`\`\``;

    expect(normalizeSlackMarkdownToMarkdown(slack)).toBe(
      `outside text \`inline${nonbreakingSpace}code\`\n\`\`\`txt\nfenced${nonbreakingSpace}code\n\`\`\``,
    );
  });
});
