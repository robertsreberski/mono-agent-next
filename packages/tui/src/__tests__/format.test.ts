import { describe, expect, it } from "vitest";

import { formatDateClock, formatDurationMs } from "../ui/format.js";

describe("formatDurationMs", () => {
  it("never renders an impossible 60s remainder near minute boundaries", () => {
    expect(formatDurationMs(119_800)).toBe("1m 59s"); // round() would say "1m 60s"
    expect(formatDurationMs(119_999)).toBe("1m 59s");
    expect(formatDurationMs(120_000)).toBe("2m");
  });

  it("formats the sub-minute ranges", () => {
    expect(formatDurationMs(42)).toBe("42ms");
    expect(formatDurationMs(1_500)).toBe("1.5s");
    expect(formatDurationMs(60_000)).toBe("1m");
  });
});

describe("formatDateClock", () => {
  // Timezone-agnostic: derive the expected string from the same local-time
  // getters the implementation uses, rather than hardcoding a zone-dependent
  // wall-clock string.
  function expectedLocal(iso: string): string {
    const date = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  it("formats a valid ISO timestamp as local MM-DD HH:MM", () => {
    const iso = "2026-07-02T12:34:56.000Z";
    expect(formatDateClock(iso)).toBe(expectedLocal(iso));
  });

  it("returns an empty string for an absent timestamp", () => {
    expect(formatDateClock(undefined)).toBe("");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatDateClock("not-a-date")).toBe("");
  });
});
