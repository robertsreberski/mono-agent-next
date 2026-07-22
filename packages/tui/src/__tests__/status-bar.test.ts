import { describe, expect, it } from "vitest";

import { StatusBar } from "../ui/components/status-bar.js";
import { formatDurationMs, formatTokens } from "../ui/format.js";
import { stripAnsi } from "./test-terminal.js";

function render(bar: StatusBar, width = 80): string {
  return stripAnsi(bar.render(width).join("\n"));
}

describe("StatusBar", () => {
  it("hides the effort segment until set", () => {
    const bar = new StatusBar();
    expect(render(bar)).not.toContain("effort:");
  });

  it("renders the effort segment immediately after the model segment", () => {
    const bar = new StatusBar();
    bar.setModel("claude-fable-5");
    bar.setEffort("high");
    const text = render(bar);
    expect(text).toContain("effort:high");
    expect(text.indexOf("claude-fable-5")).toBeLessThan(text.indexOf("effort:high"));
  });

  it("persists the effort segment across turns until replaced", () => {
    const bar = new StatusBar();
    bar.setEffort("medium");
    bar.setEphemeral("some ephemeral turn status");
    expect(render(bar)).toContain("effort:medium");
    bar.setEffort("high");
    expect(render(bar)).toContain("effort:high");
    expect(render(bar)).not.toContain("effort:medium");
  });

  it("clears the effort segment when set to undefined", () => {
    const bar = new StatusBar();
    bar.setEffort("high");
    expect(render(bar)).toContain("effort:high");
    bar.setEffort(undefined);
    expect(render(bar)).not.toContain("effort:");
  });

  it("shows an active thinking segment without a chars/duration suffix", () => {
    const bar = new StatusBar();
    bar.setThinking({ chars: 12_300, active: true });
    const text = render(bar);
    expect(text).toContain(`∴ thinking ${formatTokens(12_300)}`);
    expect(text).not.toContain("chars");
  });

  it("shows a finalized thinking segment with chars and duration", () => {
    const bar = new StatusBar();
    bar.setThinking({ chars: 12_300, durationMs: 41_000, active: false });
    const text = render(bar);
    expect(text).toContain(`∴ ${formatTokens(12_300)} chars · ${formatDurationMs(41_000)}`);
  });

  it("omits the duration part when durationMs is absent", () => {
    const bar = new StatusBar();
    bar.setThinking({ chars: 500, active: false });
    const text = render(bar);
    expect(text).toContain(`∴ ${formatTokens(500)} chars`);
    // "chars ·" would only appear (immediately followed by a digit) if a
    // duration had been rendered; here it's the plain segment separator
    // ahead of the (digit-free) hint text.
    expect(text).not.toMatch(/chars\s*·\s*[-\d]/u);
  });

  it("clamps a negative duration to omitted", () => {
    const bar = new StatusBar();
    bar.setThinking({ chars: 500, durationMs: -5, active: false });
    const text = render(bar);
    expect(text).toContain(`∴ ${formatTokens(500)} chars`);
    expect(text).not.toMatch(/chars\s*·\s*[-\d]/u);
  });

  it("stays visible after the turn ends until the next turn's first thought replaces it", () => {
    const bar = new StatusBar();
    bar.setThinking({ chars: 12_300, active: true });
    bar.setThinking({ chars: 12_300, durationMs: 41_000, active: false });
    expect(render(bar)).toContain(`∴ ${formatTokens(12_300)} chars · ${formatDurationMs(41_000)}`);
    // Next turn's first thought replaces the whole segment.
    bar.setThinking({ chars: 3, active: true });
    const text = render(bar);
    expect(text).toContain(`∴ thinking ${formatTokens(3)}`);
    expect(text).not.toContain(formatDurationMs(41_000));
  });

  it("clears the thinking segment when set to undefined", () => {
    const bar = new StatusBar();
    bar.setThinking({ chars: 500, active: true });
    expect(render(bar)).toContain("∴");
    bar.setThinking(undefined);
    expect(render(bar)).not.toContain("∴");
  });

  it("does not disturb existing segment order/behavior", () => {
    const bar = new StatusBar();
    bar.setIdentity("agent@host");
    bar.setModel("claude-fable-5");
    bar.setEffort("high");
    bar.setUsage({ input: 900, output: 40, cacheRead: 100, cacheCreation: 0 }, 0.012);
    bar.setThinking({ chars: 200, active: true });
    bar.setProviderNote("answered by kimi (failover)");
    bar.setEphemeral("waiting for model…");
    // Wide enough that the joined segment line never wraps mid-token.
    const text = render(bar, 500);
    const order = [
      "agent@host",
      "claude-fable-5",
      "effort:high",
      "↑900",
      "$0.012",
      "∴ thinking",
      "answered by kimi",
      "waiting for model",
    ];
    let lastIndex = -1;
    for (const token of order) {
      const index = text.indexOf(token);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });
});
