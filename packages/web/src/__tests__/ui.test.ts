import { describe, expect, it } from "vitest";

import {
  availableOperatorActions,
} from "@mono-agent/operator";
import {
  FIXTURE_CAPABILITIES,
  MULTI_QUESTION_ASK_USER_TURN_FRAMES,
} from "@mono-agent/operator/testing";

import type { WebMessage } from "../contracts.js";
import {
  WEB_APP_JS,
  WEB_INDEX_HTML,
  WEB_TELEMETRY_TEXT_BOUND,
  presentWebMessage,
  webOperatorConversationState,
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

  it("embeds shared action eligibility for persisted AskUser product state", () => {
    const askFrame = MULTI_QUESTION_ASK_USER_TURN_FRAMES.find(
      (frame) => frame.type === "ask_user",
    );
    expect(askFrame?.type).toBe("ask_user");
    const webState = webOperatorConversationState({
      id: "fixture-thread",
      operatorConversationId: "fixture-conversation",
      status: "running",
      activeTurnId: "multi-ask-turn",
      pendingAsk: askFrame!.ask,
    });

    expect(webState).toMatchObject({
      conversationId: "fixture-conversation",
      status: "awaiting_user",
      activeTurnId: "multi-ask-turn",
      pendingAsk: askFrame!.ask,
    });
    expect(availableOperatorActions(webState, FIXTURE_CAPABILITIES)).toContain("answer_ask");
    expect(WEB_APP_JS).toContain(availableOperatorActions.toString());
    expect(WEB_APP_JS).toContain(webOperatorConversationState.toString());
    expect(WEB_APP_JS).not.toContain("const capability =");
    expect(() => new Function(WEB_APP_JS)).not.toThrow();
  });

  it("exposes runtime-instance, model, and effort controls together", () => {
    expect(WEB_INDEX_HTML).toContain('id="runtime" aria-label="Runtime instance override"');
    expect(WEB_APP_JS).toContain('{ runtime: runtime.value.trim() }');
    expect(WEB_APP_JS).toContain('can("set_runtime")');
  });
});
