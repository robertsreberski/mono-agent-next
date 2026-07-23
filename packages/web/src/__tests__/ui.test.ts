import { describe, expect, it } from "vitest";

import type { WebMessage } from "../contracts.js";
import {
  WEB_APP_JS,
  WEB_TELEMETRY_TEXT_BOUND,
  presentWebMessage,
} from "../ui.js";

describe("web telemetry presentation", () => {
  it("keeps exact message text separate from bounded, numeric-only telemetry", () => {
    const exactText = "<script>not markup</script>\nSecond & final line";
    const message = {
      text: exactText,
      telemetry: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
        contextWindow: Number.MAX_SAFE_INTEGER,
        contextUsed: Number.MAX_SAFE_INTEGER,
        compacted: true,
        sessionEvicted: true,
        providerSecret: "sk-live-must-not-render",
      },
    } as unknown as Pick<WebMessage, "text" | "telemetry">;

    const presentation = presentWebMessage(message);
    const telemetryText = presentation.telemetry.join(" · ");
    expect(presentation.body).toBe(exactText);
    expect(presentation.telemetry).toEqual([
      "Usage: 9007199254740991 input · 9007199254740991 output",
      "Context: 9007199254740991 / 9007199254740991",
      "Events: context compacted, provider session evicted",
    ]);
    expect(telemetryText).not.toContain("sk-live-must-not-render");
    expect(telemetryText.length).toBeLessThanOrEqual(WEB_TELEMETRY_TEXT_BOUND);
  });

  it("embeds and uses the same presentation helper in the shipped browser UI", () => {
    expect(WEB_APP_JS).toContain(presentWebMessage.toString());
    expect(WEB_APP_JS).toContain("body.textContent = presentation.body");
    expect(WEB_APP_JS).toContain('presentation.telemetry.join(" · ")');
  });
});
