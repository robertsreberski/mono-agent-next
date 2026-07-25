// SPDX-License-Identifier: MIT

// A per-turn `{runtime, model}` selection that is not a configured route used to
// be absorbed by the fallback chain: `routeCandidates` builds
// `[requested, ...fallbacks]`, so a bogus model quietly degraded to fallback #1
// and the turn was reported as a success. The operator surface only appeared to
// reject it because the operator *client* filters against advertised models —
// Core itself rejected nothing.

import { describe, expect, it } from "vitest";

import { assertConfiguredRoute, routeCandidates } from "../host-routing.js";
import { AgentConfigError } from "../index.js";
import type { AgentSubmitInput, LoadedAgentConfig } from "../types.js";

const config = {
  raw: {
    routing: {
      primary: { runtime: "pi", model: "openai-codex:gpt-5.6-sol" },
      fallbacks: [
        { runtime: "pi", model: "github-copilot:gemini-3.1-pro-preview" },
        { runtime: "claude", model: "claude-opus-5" },
      ],
    },
  },
} as unknown as LoadedAgentConfig;

const submit = (overrides: Partial<AgentSubmitInput>): AgentSubmitInput => ({
  conversationId: "conversation-a",
  text: "say ok",
  ...overrides,
});

describe("per-turn route selection", () => {
  it("accepts a selection that names any configured route", () => {
    expect(() => assertConfiguredRoute(config, submit({}))).not.toThrow();
    expect(() => assertConfiguredRoute(config, submit({
      runtime: "pi", model: "openai-codex:gpt-5.6-sol",
    }))).not.toThrow();
    expect(() => assertConfiguredRoute(config, submit({
      runtime: "claude", model: "claude-opus-5",
    }))).not.toThrow();
  });

  it("accepts a model-only selection resolved against the primary runtime", () => {
    expect(() => assertConfiguredRoute(config, submit({
      model: "github-copilot:gemini-3.1-pro-preview",
    }))).not.toThrow();
  });

  it("rejects a model that exists in no configured route", () => {
    expect(() => assertConfiguredRoute(config, submit({
      model: "totally-not-a-real-model-xyz",
    }))).toThrow(AgentConfigError);
  });

  it("rejects a v0-style runtime-qualified model value", () => {
    // `model: "pi:openai-codex:gpt-5.5"` in route frontmatter was neither
    // rejected at load nor at dispatch; the route just answered on a different
    // model.
    let raised: AgentConfigError | undefined;
    try {
      assertConfiguredRoute(config, submit({ model: "pi:openai-codex:gpt-5.5" }));
    } catch (error) {
      raised = error as AgentConfigError;
    }
    expect(raised).toBeInstanceOf(AgentConfigError);
    expect(raised?.issues).toEqual([{
      path: "model",
      message: "pi:pi:openai-codex:gpt-5.5 is not declared in routing.primary or routing.fallbacks",
      code: "unconfigured_route",
    }]);
  });

  it("rejects a configured model paired with the wrong runtime", () => {
    expect(() => assertConfiguredRoute(config, submit({
      runtime: "claude", model: "openai-codex:gpt-5.6-sol",
    }))).toThrow(AgentConfigError);
  });

  it("would otherwise have degraded to fallback #1 and reported success", () => {
    // The exact absorption this rejection exists to prevent.
    const candidates = routeCandidates(config, submit({ model: "totally-not-a-real-model-xyz" }));
    expect(candidates[1]).toEqual({ runtime: "pi", model: "github-copilot:gemini-3.1-pro-preview" });
  });
});
