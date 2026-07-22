import { describe, expect, it } from "vitest";

import { badge, channelBadge, computeColorEnabled, healthBadge, isColorEnabled, keyValue, rule, style } from "../ui.js";

describe("computeColorEnabled", () => {
  it("disables color when NO_COLOR is set (any value), even with a TTY", () => {
    expect(computeColorEnabled({ NO_COLOR: "" }, true)).toBe(false);
    expect(computeColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("forces color on/off via FORCE_COLOR regardless of TTY", () => {
    expect(computeColorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(computeColorEnabled({ FORCE_COLOR: "true" }, undefined)).toBe(true);
    expect(computeColorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(computeColorEnabled({ FORCE_COLOR: "false" }, true)).toBe(false);
  });

  it("falls back to TTY-ness when neither variable is set", () => {
    expect(computeColorEnabled({}, true)).toBe(true);
    expect(computeColorEnabled({}, false)).toBe(false);
    expect(computeColorEnabled({}, undefined)).toBe(false);
  });

  it("lets NO_COLOR win over FORCE_COLOR", () => {
    expect(computeColorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });
});

describe("styling helpers with color disabled (the vitest non-TTY harness)", () => {
  it("reports color disabled so output stays plain in tests and pipes", () => {
    expect(isColorEnabled()).toBe(false);
  });

  it("renders style helpers as the identity function", () => {
    expect(style.green("ok")).toBe("ok");
    expect(style.bold("x")).toBe("x");
    expect(style.dim("y")).toBe("y");
    expect(style.red("z")).toBe("z");
  });

  it("falls back to equal-width ASCII status tags", () => {
    expect(badge("ok")).toBe("[ok]    ");
    expect(badge("waiting")).toBe("[wait]  ");
    expect(badge("disabled")).toBe("[off]   ");
    expect(badge("error")).toBe("[error] ");
    // All four tags share one column width so badged lines stay aligned.
    const widths = new Set([badge("ok"), badge("waiting"), badge("disabled"), badge("error")].map((b) => b.length));
    expect(widths).toEqual(new Set([8]));
  });

  it("aligns key/value rows to the widest label", () => {
    expect(keyValue([["a", "1"], ["bbb", "2"]])).toBe("a    1\nbbb  2\n");
    expect(keyValue([])).toBe("");
  });

  it("indents key/value rows when asked, preserving alignment", () => {
    expect(keyValue([["a", "1"], ["bbb", "2"]], 2)).toBe("  a    1\n  bbb  2\n");
  });
});

describe("section rules and domain badges", () => {
  it("renders a labeled divider that ends with a newline and keeps the label verbatim", () => {
    const out = rule("instance");
    expect(out).toContain("── instance ");
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toMatch(/─/u);
  });

  it("renders an unlabeled divider as a run of dashes", () => {
    const out = rule();
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trim()).toMatch(/^─+$/u);
  });

  it("maps channel kinds to the right badge", () => {
    expect(channelBadge("running")).toBe(badge("ok"));
    expect(channelBadge("waiting_for_config")).toBe(badge("waiting"));
    expect(channelBadge("disabled")).toBe(badge("disabled"));
    expect(channelBadge("stopped")).toBe(badge("disabled"));
    expect(channelBadge("degraded")).toBe(badge("waiting"));
    expect(channelBadge("crashed")).toBe(badge("error"));
    expect(channelBadge("mystery")).toBe(badge("waiting"));
  });

  it("maps health words to the right badge", () => {
    expect(healthBadge("running")).toBe(badge("ok"));
    expect(healthBadge("stale")).toBe(badge("waiting"));
    expect(healthBadge("stopped")).toBe(badge("disabled"));
    expect(healthBadge("dead")).toBe(badge("error"));
  });
});
