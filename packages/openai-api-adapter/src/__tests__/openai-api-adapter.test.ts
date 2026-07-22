import dns from "node:dns";

import { describe, expect, it, vi } from "vitest";

import { isWildcardHost, type AgentResponder } from "@mono-agent/agent-contracts";

import {
  DEFAULT_MAX_TOOL_PAYLOAD_BYTES,
  MAX_TOOL_SSE_FRAME_BYTES,
  startOpenAIApiAdapter,
  type OpenAIApiChatRequest,
} from "../index.js";

describe("OpenAI API adapter", () => {
  it("serves OpenAI-compatible model discovery for OpenWebUI", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      const response = await fetch(`${server.baseUrl}/models`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        object: "list",
        data: [
          expect.objectContaining({
            id: "agent",
            object: "model",
            owned_by: "host",
          }),
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it("maps chat completion requests into structural responder calls", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push({
          conversationId: request.conversationId,
          text: request.text,
          metadata: request.metadata?.openaiApi,
        });
        await stream.append(`echo: ${request.text}`);
        return { metadata: { ok: true } };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          user: "openwebui-user",
          metadata: { conversation_id: "chat-1" },
          messages: [
            { role: "system", content: "You are concise." },
            { role: "user", content: "Hello Mono" },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toMatchObject({
        object: "chat.completion",
        model: "agent",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "echo: system: You are concise.\nuser: Hello Mono",
            },
            finish_reason: "stop",
          },
        ],
      });
      expect(json).not.toHaveProperty("usage");
      expect(seen).toEqual([
        expect.objectContaining({
          conversationId: "chat-1",
          text: "system: You are concise.\nuser: Hello Mono",
          metadata: expect.objectContaining({
            model: "agent",
            stream: false,
            path: "/v1/chat/completions",
            requestId: expect.any(String),
          }),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["absent", {}, {}],
    [
      "explicit defaults",
      {
        temperature: 1,
        top_p: 1,
        max_tokens: null,
        max_completion_tokens: null,
        stop: null,
        seed: null,
        logit_bias: null,
        presence_penalty: 0,
        frequency_penalty: 0,
      },
      {
        temperature: 1,
        top_p: 1,
        max_tokens: null,
        max_completion_tokens: null,
        stop: null,
        seed: null,
        logit_bias: null,
        presence_penalty: 0,
        frequency_penalty: 0,
      },
    ],
  ])("keeps %s sampling parameters quiet", async (_label, parameters, expectedParameters) => {
    const seenParameters: unknown[] = [];
    const warn = vi.fn();
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seenParameters.push(request.metadata.openaiApi.parameters);
        await stream.append("defaults accepted");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
      logger: { warn },
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Use defaults" }],
          ...parameters,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("defaults accepted");
      expect(body).not.toContain("Warning:");
      expect(body).not.toContain("sampling parameters");
      expect(seenParameters).toEqual([expectedParameters]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("warns that non-default and adversarial sampling parameters are not applied", async () => {
    const seenParameters: unknown[] = [];
    const warn = vi.fn();
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seenParameters.push(request.metadata.openaiApi.parameters);
        await stream.append("runtime response");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
      logger: { warn },
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Ignore unsupported controls" }],
          temperature: 0.2,
          top_p: "1",
          max_tokens: 512,
          max_completion_tokens: null,
          stop: ["END"],
          seed: null,
          logit_bias: {},
          presence_penalty: 0,
          frequency_penalty: 0,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(
        "Warning: OpenAI API sampling parameters are currently unsupported and were not applied: temperature, top_p, max_tokens, stop, logit_bias.",
      );
      expect(body).toContain("runtime response");
      expect(body).not.toContain("max_completion_tokens");
      expect(body).not.toContain("presence_penalty");
      expect(body).not.toContain("frequency_penalty");
      expect(seenParameters).toEqual([
        {
          temperature: 0.2,
          top_p: "1",
          max_tokens: 512,
          max_completion_tokens: null,
          stop: ["END"],
          seed: null,
          logit_bias: {},
          presence_penalty: 0,
          frequency_penalty: 0,
        },
      ]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "OpenAI API sampling parameters were ignored.",
        expect.objectContaining({
          requestId: expect.any(String),
          conversationId: expect.any(String),
          warningKind: "openai_api_sampling_parameters_ignored",
          ignoredParameters: ["temperature", "top_p", "max_tokens", "stop", "logit_bias"],
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("END");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("0.2");
    } finally {
      await server.stop();
    }
  });

  it("keeps absent and explicit-default non-stream sampling parameters quiet", async () => {
    const seenParameters: unknown[] = [];
    const warn = vi.fn();
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seenParameters.push(request.metadata.openaiApi.parameters);
        await stream.append("defaults accepted");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
      logger: { warn },
    });

    try {
      const requests = [
        {},
        {
          stream: false,
          temperature: 1,
          top_p: 1,
          max_tokens: null,
          max_completion_tokens: null,
          stop: null,
          seed: null,
          logit_bias: null,
          presence_penalty: 0,
          frequency_penalty: 0,
        },
      ];
      const bodies: Record<string, unknown>[] = [];
      for (const parameters of requests) {
        const response = await fetch(`${server.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "agent",
            messages: [{ role: "user", content: "Use defaults" }],
            ...parameters,
          }),
        });
        expect(response.status).toBe(200);
        bodies.push(await response.json() as Record<string, unknown>);
      }

      for (const body of bodies) {
        expect(body).toMatchObject({
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "defaults accepted" } }],
        });
        expect(body).not.toHaveProperty("mono_agent");
      }
      expect(seenParameters).toEqual([
        {},
        {
          temperature: 1,
          top_p: 1,
          max_tokens: null,
          max_completion_tokens: null,
          stop: null,
          seed: null,
          logit_bias: null,
          presence_penalty: 0,
          frequency_penalty: 0,
        },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["omitted without an operator logger", undefined, false],
    ["false with an operator logger", false, true],
  ] as const)("returns a names-only warning extension when non-stream mode is %s", async (
    _label,
    streamValue,
    withLogger,
  ) => {
    const lifecycle: string[] = [];
    const warn = vi.fn(() => lifecycle.push("warn"));
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(_request, stream) {
        lifecycle.push("respond");
        await stream.append("runtime response");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
      ...(withLogger ? { logger: { warn } } : {}),
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          ...(streamValue === undefined ? {} : { stream: streamValue }),
          messages: [{ role: "user", content: "Ignore unsupported controls" }],
          temperature: 0.2,
          stop: ["DO_NOT_LEAK_STOP_VALUE"],
          logit_bias: { DO_NOT_LEAK_LOGIT_KEY: 99 },
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "runtime response" } }],
        mono_agent: {
          events: [
            {
              type: "runtime_warning",
              warningKind: "openai_api_sampling_parameters_ignored",
              message:
                "OpenAI API sampling parameters are currently unsupported and were not applied: temperature, stop, logit_bias.",
              metadata: {
                openaiApi: {
                  ignoredParameters: ["temperature", "stop", "logit_bias"],
                },
              },
            },
          ],
        },
      });
      expect(lifecycle).toEqual(withLogger ? ["warn", "respond"] : ["respond"]);
      if (withLogger) {
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
          "OpenAI API sampling parameters were ignored.",
          expect.objectContaining({
            warningKind: "openai_api_sampling_parameters_ignored",
            ignoredParameters: ["temperature", "stop", "logit_bias"],
          }),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      const serializedWarning = JSON.stringify((body.mono_agent as { events: unknown }).events);
      expect(serializedWarning).not.toContain("0.2");
      expect(serializedWarning).not.toContain("DO_NOT_LEAK_STOP_VALUE");
      expect(serializedWarning).not.toContain("DO_NOT_LEAK_LOGIT_KEY");
      expect(serializedWarning).not.toContain("99");
    } finally {
      await server.stop();
    }
  });

  it("accepts chat completion requests posted directly to the configured base URL", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push({
          conversationId: request.conversationId,
          text: request.text,
          metadata: request.metadata?.openaiApi,
        });
        await stream.append("base url ok");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(server.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          metadata: { conversation_id: "chat-base" },
          messages: [{ role: "user", content: "Hello base URL" }],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        object: "chat.completion",
        model: "agent",
        choices: [
          {
            message: {
              role: "assistant",
              content: "base url ok",
            },
          },
        ],
      });
      expect(seen).toEqual([
        expect.objectContaining({
          conversationId: "chat-base",
          text: "user: Hello base URL",
          metadata: expect.objectContaining({
            path: "/v1",
          }),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("omits authorization metadata when API key auth is configured", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        seen.push((request.metadata as { readonly openaiApi: { readonly headers: unknown } }).openaiApi.headers);
        await stream.append("ok");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      apiKey: "redacted-value",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer redacted-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "Hello Mono" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(expect.not.objectContaining({
        authorization: expect.anything(),
      }));
    } finally {
      await server.stop();
    }
  });

  it("rejects chat completion requests for a different model", async () => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "other-model",
          messages: [{ role: "user", content: "Hello Mono" }],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["tools", []],
    ["tool_choice", "auto"],
    ["functions", []],
    ["function_call", "auto"],
    ["response_format", { type: "json_object" }],
    ["audio", { voice: "alloy" }],
    ["modalities", ["text", "audio"]],
  ])("rejects unsupported request field %s", async (field, value) => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "Hello Mono" }],
          [field]: value,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("accepts OpenWebUI image_url content parts as structural attachments", async () => {
    const seen: unknown[] = [];
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seen.push({
          text: request.text,
          imageAttachments: request.imageAttachments,
          attachments: request.attachments,
          metadata: request.metadata.openaiApi,
        });
        await stream.append("image received");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this" },
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,iVBORw0KGgo=",
                    detail: "high",
                  },
                },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [
          {
            message: {
              content: "image received",
            },
          },
        ],
      });
      expect(seen).toEqual([
        {
          text: "user: Describe this",
          imageAttachments: [
            {
              type: "image",
              source: "image_url",
              url: "data:image/png;base64,iVBORw0KGgo=",
              urlKind: "data",
              mediaType: "image/png",
              detail: "high",
              messageRole: "user",
              messageIndex: 0,
              contentPartIndex: 1,
            },
          ],
          // The base64 data: image is also forwarded on the shared attachments
          // contract so it reaches the agent through the generic responder/harness.
          attachments: [
            { kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
          metadata: expect.objectContaining({
            attachments: {
              count: 1,
              images: [
                {
                  type: "image",
                  source: "image_url",
                  urlKind: "data",
                  mediaType: "image/png",
                  detail: "high",
                  messageRole: "user",
                  messageIndex: 0,
                  contentPartIndex: 1,
                },
              ],
            },
          }),
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("bridges only base64 data: images to request.attachments (remote URLs stay metadata-only)", async () => {
    const seen: Array<{ imageAttachments: unknown; attachments: unknown }> = [];
    const responder: AgentResponder<OpenAIApiChatRequest> = {
      async respond(request, stream) {
        seen.push({ imageAttachments: request.imageAttachments, attachments: request.attachments });
        await stream.append("ok");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({ host: "127.0.0.1", port: 0, modelId: "agent", responder });

    try {
      await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                // Remote URL: structural only, NOT bridged to shared attachments.
                { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
                // Parameterized base64 data URL: bridged (F157 parser must accept it).
                { type: "image_url", image_url: { url: "data:image/png;charset=utf-8;base64,iVBORw0KGgo=" } },
              ],
            },
          ],
        }),
      });

      // Both images are in the full structural list.
      expect((seen[0]?.imageAttachments as unknown[]).length).toBe(2);
      // Only the base64 data: image reaches the shared attachments contract.
      expect(seen[0]?.attachments).toEqual([
        { kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed image_url content parts", async () => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this" },
                { type: "image_url", image_url: { url: "" } },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("rejects unsupported message content part types other than text and image_url", async () => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Transcribe this" },
                { type: "input_audio", input_audio: { data: "abc", format: "wav" } },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it.each(["tool_calls", "function_call"])("rejects unsupported assistant message %s", async (field) => {
    const responder = countingResponder();
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder: responder.responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [
            { role: "user", content: "Hello Mono" },
            {
              role: "assistant",
              content: null,
              [field]: field === "tool_calls" ? [] : { name: "lookup", arguments: "{}" },
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
        },
      });
      expect(responder.calls).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("streams Chat Completions Server-Sent Events when requested", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.append("hello");
        await stream.append(" stream");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Stream it" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const body = await response.text();
      expect(body).toContain("\"object\":\"chat.completion.chunk\"");
      expect(body).toContain("\"role\":\"assistant\"");
      expect(body).toContain("\"content\":\"hello\"");
      expect(body).toContain("\"content\":\" stream\"");
      expect(body).toContain("\"finish_reason\":\"stop\"");
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("opens the SSE stream before the responder setup resolves", async () => {
    const releaseRespond = deferred<void>();
    const responder: AgentResponder = {
      async respond(_request, stream) {
        // Simulate slow agent setup latency before any streaming happens.
        await releaseRespond.promise;
        await stream.append("hello after setup");
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Stream early" }],
        }),
      });

      // Headers must be visible immediately, before the responder resolves.
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");

      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("Expected a streaming response body.");
      }
      // The assistant-role chunk must reach the client before setup completes,
      // proving the stream opened eagerly. The stream opens with a real `data:`
      // chunk — NOT a leading SSE comment (": open"), which some OpenAI-compatible
      // clients (Open WebUI) mishandle when it precedes the first data event.
      const earlyBody = await readUntil(reader, "\"role\":\"assistant\"");
      expect(earlyBody.startsWith("data:")).toBe(true);
      expect(earlyBody).not.toContain(": open");
      expect(earlyBody).toContain("\"object\":\"chat.completion.chunk\"");
      expect(earlyBody).not.toContain("hello after setup");

      releaseRespond.resolve(undefined);
      const body = earlyBody + await readRemaining(reader);
      expect(body).toContain("\"content\":\"hello after setup\"");
      expect(body).toContain("\"finish_reason\":\"stop\"");
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      releaseRespond.resolve(undefined);
      await server.stop();
    }
  });

  it("streams thoughts and internally executed tools without client tool calls or duplicate final text", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({ type: "assistant_thought", text: "checking available context" });
        await stream.event?.({
          type: "tool_call_started",
          id: "call-1",
          name: "mcp__context_example__search",
          arguments: { query: "OpenWebUI tool rendering" },
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-1",
          content: { matches: 2 },
          isError: false,
        });
        await stream.append("Final answer.");
        return { text: "Final answer." };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Show progress" }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("\"reasoning_content\":\"checking available context\"");
      expect(body).not.toContain("Running mcp__context_example__search...");
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
      expect(body).toContain("id=\\\"call-1\\\"");
      expect(body).toContain("name=\\\"mcp__context_example__search\\\"");
      expect(body).toContain("OpenWebUI tool rendering");
      expect(body).toContain("{\\\"matches\\\":2}");
      expect(body).not.toContain("\"tool_calls\"");
      expect(body).not.toContain("\"finish_reason\":\"tool_calls\"");
      expect(body.match(/"content":"Final answer\."/gu)).toHaveLength(1);
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it.each([
    {
      label: "ASCII-heavy",
      payload: "x".repeat(256 * 1024 + 512),
    },
    {
      label: "HTML/JSON/control-escape-heavy",
      payload: "\\\"\u0000\n\r\t&<>".repeat(32 * 1024),
    },
  ])("bounds the complete SSE frame for simultaneous $label tool payloads", async ({ payload }) => {
    const argumentTail = "ARGUMENT-TAIL-MUST-NOT-LEAK";
    const resultTail = "RESULT-TAIL-MUST-NOT-LEAK";
    const argumentsValue = Object.freeze({
      query: `${payload}${argumentTail}`,
    });
    const resultValue = Object.freeze({
      output: `${payload}${resultTail}`,
    });
    const argumentsSnapshot = structuredClone(argumentsValue);
    const resultSnapshot = structuredClone(resultValue);
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "call-oversized",
          name: "read_large_payload",
          arguments: argumentsValue,
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-oversized",
          content: resultValue,
          isError: false,
        });
        return { text: "bounded" };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await postChat(server.baseUrl, {
        stream: true,
        messages: [{ role: "user", content: "Bound the tool payloads" }],
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      const payloads = sseDataPayloads(body);
      expect(payloads.at(-1)).toBe("[DONE]");
      const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload) as Record<string, unknown>);
      const detailsFrames = toolDetailsSseFrames(body);
      expect(detailsFrames).toHaveLength(1);
      expect(Buffer.byteLength(detailsFrames[0]!, "utf8")).toBeLessThanOrEqual(
        MAX_TOOL_SSE_FRAME_BYTES,
      );
      const details = toolDetailsContent(chunks);
      const projected = parseToolDetails(details);
      const argumentsJson = JSON.stringify(argumentsValue);
      const resultJson = JSON.stringify(resultValue);

      expectAccurateToolPayloadProjection(
        projected.arguments,
        Buffer.byteLength(argumentsJson, "utf8"),
      );
      expectAccurateToolPayloadProjection(
        projected.result,
        Buffer.byteLength(resultJson, "utf8"),
      );
      expect(projected.arguments.__monoAgentTruncation.maxBytes)
        .toBeLessThan(DEFAULT_MAX_TOOL_PAYLOAD_BYTES);
      expect(projected.arguments.__monoAgentTruncation.maxBytes).toBeGreaterThan(0);
      expect(projected.result.__monoAgentTruncation.maxBytes)
        .toBe(projected.arguments.__monoAgentTruncation.maxBytes);
      expect(body).not.toContain(argumentTail);
      expect(body).not.toContain(resultTail);
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
      expect(argumentsValue).toEqual(argumentsSnapshot);
      expect(resultValue).toEqual(resultSnapshot);
    } finally {
      await server.stop();
    }
  });

  it("maximizes retained payload across a raw/projection transition", async () => {
    const argumentsValue = "a".repeat(400_000);
    const resultValue = "\"".repeat(80_000);
    const defaultObservation = await observeStreamedToolDetails({
      argumentsValue,
      resultValue,
    });
    const lowerCapObservation = await observeStreamedToolDetails({
      argumentsValue,
      resultValue,
      maxToolPayloadBytes: 100_000,
    });

    expect(defaultObservation.frameBytes).toBeLessThanOrEqual(MAX_TOOL_SSE_FRAME_BYTES);
    expect(lowerCapObservation.frameBytes).toBeLessThanOrEqual(MAX_TOOL_SSE_FRAME_BYTES);
    expect(defaultObservation.terminalDone).toBe(true);
    expect(lowerCapObservation.terminalDone).toBe(true);
    expect(lowerCapObservation.resultText).toBe(resultValue);

    const lowerArguments = parseToolPayloadProjection(lowerCapObservation.argumentsText);
    expect(lowerArguments.__monoAgentTruncation).toMatchObject({
      maxBytes: 100_000,
      originalBytes: 400_000,
      retainedBytes: 100_000,
      omittedBytes: 300_000,
    });
    expect(retainedToolDetailsBytes(lowerCapObservation)).toBe(180_000);
    expect(defaultObservation.resultText).toBe(resultValue);
    const defaultArguments = parseToolPayloadProjection(defaultObservation.argumentsText);
    const selectedMaxBytes = defaultArguments.__monoAgentTruncation.maxBytes;
    expect(selectedMaxBytes).toBeGreaterThanOrEqual(100_000);
    expect(selectedMaxBytes).toBeLessThan(DEFAULT_MAX_TOOL_PAYLOAD_BYTES);
    expect(defaultArguments.__monoAgentTruncation.retainedBytes).toBe(selectedMaxBytes);
    expect(retainedToolDetailsBytes(defaultObservation)).toBe(selectedMaxBytes + 80_000);
    expect(hypotheticalToolDetailsFrameBytes(
      defaultObservation,
      defaultObservation.argumentsText,
      defaultObservation.resultText,
    )).toBe(defaultObservation.frameBytes);

    const nextMaxBytes = selectedMaxBytes + 1;
    const nextArgumentsText = JSON.stringify({
      __monoAgentTruncation: {
        truncated: true,
        maxBytes: nextMaxBytes,
        originalBytes: 400_000,
        retainedBytes: nextMaxBytes,
        omittedBytes: 400_000 - nextMaxBytes,
      },
      preview: "a".repeat(nextMaxBytes),
    });
    expect(hypotheticalToolDetailsFrameBytes(
      defaultObservation,
      nextArgumentsText,
      resultValue,
    )).toBeGreaterThan(MAX_TOOL_SSE_FRAME_BYTES);
  });

  it.each([
    {
      label: "result control payload",
      argumentsValue: "a".repeat(400_000),
      resultValue: "\n".repeat(80_000),
      exactField: "result" as const,
    },
    {
      label: "arguments control payload",
      argumentsValue: "\t".repeat(80_000),
      resultValue: "a".repeat(400_000),
      exactField: "arguments" as const,
    },
  ])("does not lose retained bytes around the $label transition", async (testCase) => {
    const belowTransition = await observeStreamedToolDetails({
      argumentsValue: testCase.argumentsValue,
      resultValue: testCase.resultValue,
      maxToolPayloadBytes: 79_999,
    });
    const atTransition = await observeStreamedToolDetails({
      argumentsValue: testCase.argumentsValue,
      resultValue: testCase.resultValue,
      maxToolPayloadBytes: 80_000,
    });
    const defaultObservation = await observeStreamedToolDetails({
      argumentsValue: testCase.argumentsValue,
      resultValue: testCase.resultValue,
    });

    for (const observation of [belowTransition, atTransition, defaultObservation]) {
      expect(observation.frameBytes).toBeLessThanOrEqual(MAX_TOOL_SSE_FRAME_BYTES);
      expect(observation.terminalDone).toBe(true);
    }
    expect(retainedToolDetailsBytes(atTransition))
      .toBeGreaterThanOrEqual(retainedToolDetailsBytes(belowTransition));
    expect(retainedToolDetailsBytes(defaultObservation))
      .toBeGreaterThanOrEqual(retainedToolDetailsBytes(atTransition));
    if (testCase.exactField === "result") {
      expect(atTransition.resultText).toBe(testCase.resultValue);
    } else {
      expect(atTransition.argumentsText).toBe(testCase.argumentsValue);
    }
  });

  it("searches a raw transition even when the zero-budget frame does not fit", async () => {
    const argumentsValue = "x";
    const resultValue = "r".repeat(400_000);
    const toolCallId = "call-transition";
    const zeroBudget = await observeStreamedToolDetails({
      argumentsValue,
      resultValue,
      maxToolPayloadBytes: 0,
      toolCallId,
    });
    const oneByteBudget = await observeStreamedToolDetails({
      argumentsValue,
      resultValue,
      maxToolPayloadBytes: 1,
      toolCallId,
    });
    expect(zeroBudget.frameBytes).toBeGreaterThan(oneByteBudget.frameBytes);

    const paddingBytes = MAX_TOOL_SSE_FRAME_BYTES - oneByteBudget.frameBytes;
    expect(paddingBytes).toBeGreaterThan(0);
    const transitionObservation = await observeStreamedToolDetails({
      argumentsValue,
      resultValue,
      toolCallId: `${toolCallId}${"i".repeat(paddingBytes)}`,
    });

    expect(transitionObservation.frameBytes).toBe(MAX_TOOL_SSE_FRAME_BYTES);
    expect(transitionObservation.terminalDone).toBe(true);
    expect(transitionObservation.argumentsText).toBe(argumentsValue);
    expect(parseToolPayloadProjection(
      transitionObservation.resultText,
    ).__monoAgentTruncation).toMatchObject({
      maxBytes: 1,
      originalBytes: 400_000,
      retainedBytes: 1,
      omittedBytes: 399_999,
    });
  });

  it("preserves a leading U+FEFF while truncating on UTF-8 code-point boundaries", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "call-unicode",
          name: "unicode_tool",
          arguments: "\uFEFFA🧠Z",
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-unicode",
          content: "\uFEFFX€Z",
        });
        return { text: "done" };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      maxToolPayloadBytes: 4,
      responder,
    });

    try {
      const response = await postChat(server.baseUrl, {
        stream: true,
        messages: [{ role: "user", content: "Unicode boundary" }],
      });
      const projected = parseToolDetails(toolDetailsContent(
        sseDataPayloads(await response.text())
          .filter((payload) => payload !== "[DONE]")
          .map((payload) => JSON.parse(payload) as Record<string, unknown>),
      ));

      expect(projected.arguments.preview).toBe("\uFEFFA");
      expect(projected.arguments.__monoAgentTruncation).toMatchObject({
        truncated: true,
        maxBytes: 4,
        originalBytes: 9,
        retainedBytes: 4,
        omittedBytes: 5,
      });
      expect(projected.result.preview).toBe("\uFEFFX");
      expect(projected.result.__monoAgentTruncation).toMatchObject({
        truncated: true,
        maxBytes: 4,
        originalBytes: 8,
        retainedBytes: 4,
        omittedBytes: 4,
      });
      expect(projected.arguments.preview).not.toContain("�");
      expect(projected.result.preview).not.toContain("�");
      expect(projected.arguments.preview).not.toMatch(/\p{Cs}/u);
      expect(projected.result.preview).not.toMatch(/\p{Cs}/u);
    } finally {
      await server.stop();
    }
  });

  it("emits metadata-only streaming projections at a zero cap without mutating inputs", async () => {
    const argumentTail = "ZERO-CAP-ARGUMENT-TAIL";
    const resultTail = "ZERO-CAP-RESULT-TAIL";
    const argumentsValue = Object.freeze({ query: `secret-${argumentTail}` });
    const resultValue = Object.freeze({ output: `secret-${resultTail}` });
    const argumentsSnapshot = structuredClone(argumentsValue);
    const resultSnapshot = structuredClone(resultValue);
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "call-zero-cap",
          name: "metadata_only",
          arguments: argumentsValue,
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-zero-cap",
          content: resultValue,
        });
        return { text: "done" };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      maxToolPayloadBytes: 0,
      responder,
    });

    try {
      const response = await postChat(server.baseUrl, {
        stream: true,
        messages: [{ role: "user", content: "Metadata only" }],
      });
      const body = await response.text();
      const detailsFrames = toolDetailsSseFrames(body);
      expect(detailsFrames).toHaveLength(1);
      expect(Buffer.byteLength(detailsFrames[0]!, "utf8"))
        .toBeLessThanOrEqual(MAX_TOOL_SSE_FRAME_BYTES);
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
      const projected = parseToolDetails(toolDetailsContent(
        sseDataPayloads(body)
          .filter((payload) => payload !== "[DONE]")
          .map((payload) => JSON.parse(payload) as Record<string, unknown>),
      ));
      const argumentsJson = JSON.stringify(argumentsValue);
      const resultJson = JSON.stringify(resultValue);

      expect(projected.arguments.preview).toBe("");
      expect(projected.arguments.__monoAgentTruncation).toEqual({
        truncated: true,
        maxBytes: 0,
        originalBytes: Buffer.byteLength(argumentsJson, "utf8"),
        retainedBytes: 0,
        omittedBytes: Buffer.byteLength(argumentsJson, "utf8"),
      });
      expect(projected.result.preview).toBe("");
      expect(projected.result.__monoAgentTruncation).toEqual({
        truncated: true,
        maxBytes: 0,
        originalBytes: Buffer.byteLength(resultJson, "utf8"),
        retainedBytes: 0,
        omittedBytes: Buffer.byteLength(resultJson, "utf8"),
      });
      expect(body).not.toContain(argumentTail);
      expect(body).not.toContain(resultTail);
      expect(argumentsValue).toEqual(argumentsSnapshot);
      expect(resultValue).toEqual(resultSnapshot);
    } finally {
      await server.stop();
    }
  });

  it("preserves exact small tool payloads without truncation metadata", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "call-small",
          name: "small_tool",
          arguments: "🧠",
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-small",
          content: "éé",
        });
        return { text: "done" };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      maxToolPayloadBytes: 4,
      responder,
    });

    try {
      const response = await postChat(server.baseUrl, {
        stream: true,
        messages: [{ role: "user", content: "Small payload" }],
      });
      const details = parseToolDetailsText(toolDetailsContent(
        sseDataPayloads(await response.text())
          .filter((payload) => payload !== "[DONE]")
          .map((payload) => JSON.parse(payload) as Record<string, unknown>),
      ));

      expect(details).toEqual({ arguments: "🧠", result: "éé" });
      expect(JSON.stringify(details)).not.toContain("__monoAgentTruncation");
    } finally {
      await server.stop();
    }
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    DEFAULT_MAX_TOOL_PAYLOAD_BYTES + 1,
  ])("rejects invalid maxToolPayloadBytes configuration (%s)", async (maxToolPayloadBytes) => {
    await expect(startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      maxToolPayloadBytes,
      responder: echoResponder(),
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("does not apply the SSE tool cap to non-streaming responses", async () => {
    const finalText = `non-streaming ${"🧠".repeat(32)}`;
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-json",
          arguments: "x".repeat(256 * 1024 + 1),
          content: "y".repeat(256 * 1024 + 1),
        });
        await stream.append(finalText);
        return { text: finalText };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      maxToolPayloadBytes: 0,
      responder,
    });

    try {
      const response = await postChat(server.baseUrl, {
        stream: false,
        messages: [{ role: "user", content: "JSON response" }],
      });

      expect(response.status).toBe(200);
      const json = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(json.choices[0]?.message.content).toBe(finalText);
      expect(JSON.stringify(json)).not.toContain("__monoAgentTruncation");
    } finally {
      await server.stop();
    }
  });

  it("streams genuine thought but no synthetic tool progress before the tool completes", async () => {
    const releaseTool = deferred<void>();
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "call-1",
          name: "mcp__context_example__search",
          arguments: { query: "OpenWebUI tool rendering" },
        });
        await stream.event?.({ type: "assistant_thought", text: "waiting for the tool result" });
        await releaseTool.promise;
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-1",
          content: { matches: 2 },
          isError: false,
        });
        return { text: "Final answer." };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Show progress" }],
        }),
      });

      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("Expected a streaming response body.");
      }
      const earlyBody = await readUntil(
        reader,
        "\"reasoning_content\":\"waiting for the tool result\"",
      );
      expect(earlyBody).not.toContain("Running mcp__context_example__search...");
      expect(earlyBody).not.toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");

      releaseTool.resolve(undefined);
      const body = earlyBody + await readRemaining(reader);
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
      expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      releaseTool.resolve(undefined);
      await server.stop();
    }
  });

  it("preserves a genuine runtime thought that happens to mention a tool start", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({ type: "assistant_thought", text: "Running mcp__context_example__search..." });
        await stream.event?.({
          type: "tool_call_started",
          id: "call-1",
          name: "mcp__context_example__search",
          arguments: { query: "OpenWebUI tool rendering" },
        });
        await stream.event?.({
          type: "tool_call_completed",
          id: "call-1",
          content: { matches: 2 },
          isError: false,
        });
        return { text: "Final answer." };
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          stream: true,
          messages: [{ role: "user", content: "Show progress" }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body.match(/"reasoning_content":"Running mcp__context_example__search\.\.\."/gu)).toHaveLength(1);
      expect(body).toContain("<details type=\\\"tool_calls\\\" done=\\\"true\\\"");
    } finally {
      await server.stop();
    }
  });

  it("requires bearer auth when an API key is configured", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      apiKey: "redacted-value",
      responder: echoResponder(),
    });

    try {
      const unauthorized = await fetch(`${server.baseUrl}/models`);
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });

      const authorized = await fetch(`${server.baseUrl}/models`, {
        headers: { Authorization: "Bearer redacted-value" },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("routes models and chat completions at the root when basePath is '/'", async () => {
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      basePath: "/",
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      expect(server.baseUrl).toBe(server.url);

      const models = await fetch(`${server.url}/models`);
      expect(models.status).toBe(200);
      await expect(models.json()).resolves.toMatchObject({ object: "list" });

      const chat = await fetch(`${server.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "root path" }],
        }),
      });
      expect(chat.status).toBe(200);
      await expect(chat.json()).resolves.toMatchObject({
        choices: [{ message: { content: "echo: user: root path" } }],
      });

      const base = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "root base" }],
        }),
      });
      expect(base.status).toBe(200);
      await expect(base.json()).resolves.toMatchObject({
        choices: [{ message: { content: "echo: user: root base" } }],
      });
    } finally {
      await server.stop();
    }
  });

  it.each(["/v1?foo=bar", "/v1#frag", "no-leading-slash"])(
    "rejects a basePath that is not a clean absolute path (%s)",
    async (basePath) => {
      await expect(
        startOpenAIApiAdapter({
          host: "127.0.0.1",
          port: 0,
          basePath,
          modelId: "agent",
          responder: echoResponder(),
        }),
      ).rejects.toMatchObject({ code: "invalid_config" });
    },
  );

  it("aborts the responder when the client disconnects mid-request", async () => {
    let abortObserved!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve, reject) => {
          request.abortSignal.addEventListener("abort", () => {
            abortObserved();
            reject(new Error("aborted by client"));
          });
        });
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    try {
      const controller = new AbortController();
      const pending = fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "hang" }],
        }),
        signal: controller.signal,
      });
      const settled = pending.catch(() => undefined);

      // Give the request time to reach the responder, then disconnect.
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();

      await abortSeen;
      await settled;
    } finally {
      await server.stop();
    }
  });

  it("aborts active requests and bounds shutdown even when a streaming responder hangs", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        requestSignal = request.abortSignal;
        requestStarted();
        await new Promise<never>(() => undefined);
        return {};
      },
    };
    const server = await startOpenAIApiAdapter({
      host: "127.0.0.1",
      port: 0,
      modelId: "agent",
      responder,
    });

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "agent",
        stream: true,
        messages: [{ role: "user", content: "hang forever" }],
      }),
    });
    await started;

    const outcome = await Promise.race([
      server.stop().then(() => "stopped" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    expect(outcome).toBe("stopped");
    expect(requestSignal?.aborted).toBe(true);
    await response.body?.cancel().catch(() => undefined);
  });

  it("rejects non-loopback binds unless explicitly allowed", async () => {
    await expect(
      startOpenAIApiAdapter({
        host: "0.0.0.0",
        port: 0,
        modelId: "agent",
        responder: echoResponder(),
      }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it.each(["127.attacker.example", "127.0.0.1.attacker.example", "localhost.attacker.example"])(
    "rejects loopback-looking hostnames before DNS resolution (%s)",
    async (host) => {
      await expect(
        startOpenAIApiAdapter({
          host,
          port: 0,
          modelId: "agent",
          responder: echoResponder(),
        }),
      ).rejects.toMatchObject({ code: "unsafe_host" });
    },
  );

  it("rejects an explicitly allowed non-loopback bind without bearer auth", async () => {
    await expect(
      startOpenAIApiAdapter({
        host: "0.0.0.0",
        port: 0,
        allowNonLoopback: true,
        modelId: "agent",
        responder: echoResponder(),
      }),
    ).rejects.toMatchObject({ code: "missing_required_config" });
  });

  it("requires bearer auth when localhost resolves to a non-loopback address after consent", async () => {
    const originalLookup = dns.lookup;
    dns.lookup = wildcardLocalhostLookup as typeof dns.lookup;
    try {
      await expect(
        startOpenAIApiAdapter({
          host: "localhost",
          // Let the kernel choose atomically. Reserving and releasing a fixed
          // port before this bind races every parallel package test/process.
          port: 0,
          allowNonLoopback: true,
          modelId: "agent",
          responder: echoResponder(),
        }),
      ).rejects.toMatchObject({ code: "missing_required_config" });
    } finally {
      dns.lookup = originalLookup;
    }
  });

  it("advertises concrete usable URLs instead of a wildcard bind address", async () => {
    const server = await startOpenAIApiAdapter({
      host: "0.0.0.0",
      port: 0,
      allowNonLoopback: true,
      apiKey: "test-key",
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(server.baseUrl).toBe(server.baseUrls[0]);
      expect(server.baseUrls.length).toBeGreaterThan(0);
      expect(server.baseUrls.every((url) => !url.includes("0.0.0.0"))).toBe(true);
      const models = await fetch(`${server.baseUrl}/models`, {
        headers: { authorization: "Bearer test-key" },
      });
      expect(models.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("advertises only concrete URLs for an IPv4-mapped IPv6 wildcard bind", async () => {
    const server = await startOpenAIApiAdapter({
      host: "[::ffff:0.0.0.0]",
      port: 0,
      allowNonLoopback: true,
      apiKey: "test-key",
      modelId: "agent",
      responder: echoResponder(),
    });

    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(server.baseUrl).toBe(server.baseUrls[0]);
      expect(server.baseUrls.every((url) => !isWildcardHost(new URL(url).hostname))).toBe(true);
      expect(server.baseUrls.every((url) => !url.includes("::ffff:0"))).toBe(true);
      const models = await fetch(`${server.baseUrl}/models`, {
        headers: { authorization: "Bearer test-key" },
      });
      expect(models.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  describe("conversation session continuity", () => {
    it("derives the conversation id from x-openwebui-chat-id and sends only the latest user message", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "system", content: "You are concise." },
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        }, { "x-openwebui-chat-id": "owui-chat-1" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "owui-chat-1", text: "C" }]);
      } finally {
        await server.stop();
      }
    });

    it("accepts the generic x-conversation-id header", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        }, { "x-conversation-id": "generic-1" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "generic-1", text: "C" }]);
      } finally {
        await server.stop();
      }
    });

    it("prefers body metadata conversation ids over headers", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          metadata: { conversation_id: "body-id" },
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        }, { "x-openwebui-chat-id": "header-id" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "body-id", text: "C" }]);
      } finally {
        await server.stop();
      }
    });

    it("keeps the full transcript on the first turn of a stable conversation", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "system", content: "You are concise." },
            { role: "user", content: "Hello" },
          ],
        }, { "x-openwebui-chat-id": "owui-first" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          { conversationId: "owui-first", text: "system: You are concise.\nuser: Hello" },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("joins multiple trailing user messages into one turn", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "X" },
            { role: "user", content: "Y" },
          ],
        }, { "x-openwebui-chat-id": "owui-multi" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "owui-multi", text: "X\nY" }]);
      } finally {
        await server.stop();
      }
    });

    it("falls back to the full transcript when no user message follows the last assistant message", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
          ],
        }, { "x-openwebui-chat-id": "owui-continue" });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          { conversationId: "owui-continue", text: "user: A\nassistant: B" },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("keeps full-transcript flattening for requests without any conversation id", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          {
            conversationId: expect.stringMatching(/^openai-api:/u),
            text: "user: A\nassistant: B\nuser: C",
          },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("treats body.user as a conversation id but keeps the full transcript", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          user: "owui-user",
          messages: [
            { role: "user", content: "A" },
            { role: "assistant", content: "B" },
            { role: "user", content: "C" },
          ],
        });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([
          { conversationId: "owui-user", text: "user: A\nassistant: B\nuser: C" },
        ]);
      } finally {
        await server.stop();
      }
    });

    it("applies latest-message extraction to body metadata conversation ids", async () => {
      const capture = capturingResponder();
      const server = await startOpenAIApiAdapter({
        host: "127.0.0.1",
        port: 0,
        modelId: "agent",
        responder: capture.responder,
      });

      try {
        const response = await postChat(server.baseUrl, {
          metadata: { conversation_id: "chat-2" },
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello" },
            { role: "user", content: "Next" },
          ],
        });

        expect(response.status).toBe(200);
        expect(capture.seen).toEqual([{ conversationId: "chat-2", text: "Next" }]);
      } finally {
        await server.stop();
      }
    });
  });
});

function wildcardLocalhostLookup(
  _hostname: string,
  options: unknown,
  callback?: unknown,
): void {
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") {
    throw new TypeError("dns.lookup callback is required");
  }
  queueMicrotask(() => {
    (done as (error: null, address: string, family: number) => void)(null, "0.0.0.0", 4);
  });
}

interface ParsedToolPayloadProjection {
  readonly __monoAgentTruncation: {
    readonly truncated: true;
    readonly maxBytes: number;
    readonly originalBytes: number;
    readonly retainedBytes: number;
    readonly omittedBytes: number;
  };
  readonly preview: string;
}

interface StreamedToolDetailsObservation {
  readonly argumentsText: string;
  readonly resultText: string;
  readonly chunk: Record<string, unknown>;
  readonly frameBytes: number;
  readonly terminalDone: boolean;
}

async function observeStreamedToolDetails(input: {
  readonly argumentsValue: unknown;
  readonly resultValue: unknown;
  readonly maxToolPayloadBytes?: number;
  readonly toolCallId?: string;
}): Promise<StreamedToolDetailsObservation> {
  const toolCallId = input.toolCallId ?? "call-transition";
  const responder: AgentResponder = {
    async respond(_request, stream) {
      await stream.event?.({
        type: "tool_call_started",
        id: toolCallId,
        name: "transition_probe",
        arguments: input.argumentsValue,
      });
      await stream.event?.({
        type: "tool_call_completed",
        id: toolCallId,
        content: input.resultValue,
      });
      return { text: "done" };
    },
  };
  const server = await startOpenAIApiAdapter({
    host: "127.0.0.1",
    port: 0,
    modelId: "agent",
    ...(input.maxToolPayloadBytes === undefined
      ? {}
      : { maxToolPayloadBytes: input.maxToolPayloadBytes }),
    responder,
  });

  try {
    const response = await postChat(server.baseUrl, {
      stream: true,
      messages: [{ role: "user", content: "Transition probe" }],
    });
    const body = await response.text();
    const frames = toolDetailsSseFrames(body);
    if (frames.length !== 1) {
      throw new Error(`Expected one tool-details SSE frame, received ${String(frames.length)}.`);
    }
    const chunks = sseDataPayloads(body)
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as Record<string, unknown>);
    const chunk = toolDetailsChunk(chunks);
    const content = toolDetailsContent([chunk]);
    const details = parseToolDetailsText(content);
    return {
      argumentsText: details.arguments,
      resultText: details.result,
      chunk,
      frameBytes: Buffer.byteLength(frames[0]!, "utf8"),
      terminalDone: body.trim().endsWith("data: [DONE]"),
    };
  } finally {
    await server.stop();
  }
}

function retainedToolDetailsBytes(observation: StreamedToolDetailsObservation): number {
  return retainedToolPayloadTextBytes(observation.argumentsText)
    + retainedToolPayloadTextBytes(observation.resultText);
}

function retainedToolPayloadTextBytes(text: string): number {
  if (!text.startsWith("{\"__monoAgentTruncation\":")) {
    return Buffer.byteLength(text, "utf8");
  }
  return parseToolPayloadProjection(text).__monoAgentTruncation.retainedBytes;
}

function parseToolPayloadProjection(text: string): ParsedToolPayloadProjection {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Expected a tool-payload projection object.");
  }
  const projection = parsed as Partial<ParsedToolPayloadProjection>;
  const truncation = projection.__monoAgentTruncation;
  if (
    typeof projection.preview !== "string"
    || typeof truncation !== "object"
    || truncation === null
    || truncation.truncated !== true
    || typeof truncation.retainedBytes !== "number"
  ) {
    throw new Error("Expected tool-payload truncation metadata.");
  }
  return projection as ParsedToolPayloadProjection;
}

function hypotheticalToolDetailsFrameBytes(
  observation: StreamedToolDetailsObservation,
  argumentsText: string,
  resultText: string,
): number {
  const chunk = structuredClone(observation.chunk) as unknown as {
    choices: Array<{ delta: Record<string, unknown> }>;
  };
  const choice = chunk.choices[0];
  if (choice === undefined) {
    throw new Error("Expected one Chat Completions choice.");
  }
  choice.delta.content = [
    `<details type="tool_calls" done="true" id="call-transition" name="transition_probe" arguments="${escapeHtmlAttributeForTest(argumentsText)}">`,
    "<summary>Tool Executed</summary>",
    escapeHtmlTextForTest(resultText),
    "</details>",
    "",
  ].join("\n");
  return Buffer.byteLength(`data: ${JSON.stringify(chunk)}\n\n`, "utf8");
}

function escapeHtmlAttributeForTest(value: string): string {
  return escapeHtmlTextForTest(value).replace(/"/gu, "&quot;");
}

function escapeHtmlTextForTest(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function sseDataPayloads(body: string): readonly string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

function toolDetailsSseFrames(body: string): readonly string[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("<details type=\\\"tool_calls\\\""))
    .map((frame) => `${frame}\n\n`);
}

function expectAccurateToolPayloadProjection(
  projection: ParsedToolPayloadProjection,
  originalBytes: number,
): void {
  const retainedBytes = Buffer.byteLength(projection.preview, "utf8");
  expect(projection.__monoAgentTruncation).toEqual({
    truncated: true,
    maxBytes: projection.__monoAgentTruncation.maxBytes,
    originalBytes,
    retainedBytes,
    omittedBytes: originalBytes - retainedBytes,
  });
  expect(retainedBytes).toBeLessThanOrEqual(projection.__monoAgentTruncation.maxBytes);
}

function toolDetailsChunk(chunks: readonly Record<string, unknown>[]): Record<string, unknown> {
  for (const chunk of chunks) {
    const choices = chunk.choices;
    if (!Array.isArray(choices)) {
      continue;
    }
    const choice = choices[0];
    if (typeof choice !== "object" || choice === null) {
      continue;
    }
    const delta = (choice as { readonly delta?: unknown }).delta;
    if (typeof delta !== "object" || delta === null) {
      continue;
    }
    const content = (delta as { readonly content?: unknown }).content;
    if (typeof content === "string" && content.startsWith("<details type=\"tool_calls\"")) {
      return chunk;
    }
  }
  throw new Error("Expected one OpenWebUI tool details chunk.");
}

function toolDetailsContent(chunks: readonly Record<string, unknown>[]): string {
  const chunk = toolDetailsChunk(chunks);
  const choice = (chunk.choices as Array<{ readonly delta?: unknown }>)[0];
  const delta = choice?.delta as { readonly content?: unknown } | undefined;
  if (typeof delta?.content !== "string") {
    throw new Error("Expected OpenWebUI tool details content.");
  }
  return delta.content;
}

function parseToolDetails(content: string): {
  readonly arguments: ParsedToolPayloadProjection;
  readonly result: ParsedToolPayloadProjection;
} {
  const parsed = parseToolDetailsText(content);
  return {
    arguments: JSON.parse(parsed.arguments) as ParsedToolPayloadProjection,
    result: JSON.parse(parsed.result) as ParsedToolPayloadProjection,
  };
}

function parseToolDetailsText(content: string): {
  readonly arguments: string;
  readonly result: string;
} {
  const argumentsMatch = / arguments="([^"]*)">/u.exec(content);
  const summaryEnd = content.indexOf("</summary>\n");
  const detailsEnd = content.lastIndexOf("\n</details>");
  if (argumentsMatch?.[1] === undefined || summaryEnd < 0 || detailsEnd < 0) {
    throw new Error("OpenWebUI tool details chunk has an unexpected shape.");
  }
  return {
    arguments: decodeHtml(argumentsMatch[1]),
    result: decodeHtml(content.slice(summaryEnd + "</summary>\n".length, detailsEnd)),
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function echoResponder(): AgentResponder {
  return {
    async respond(request, stream) {
      await stream.append(`echo: ${request.text}`);
      return {};
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes(text)) {
    const next = await readNextChunk(reader, 1_000);
    if (next.done) {
      break;
    }
    body += decoder.decode(next.value, { stream: true });
  }
  body += decoder.decode();
  if (!body.includes(text)) {
    throw new Error(`Timed out before stream contained: ${text}`);
  }
  return body;
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return body + decoder.decode();
    }
    body += decoder.decode(next.value, { stream: true });
  }
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for stream chunk.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function postChat(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "agent", ...body }),
  });
}

function capturingResponder(): {
  readonly responder: AgentResponder;
  readonly seen: Array<{ conversationId: string; text: string }>;
} {
  const seen: Array<{ conversationId: string; text: string }> = [];
  return {
    seen,
    responder: {
      async respond(request, stream) {
        seen.push({ conversationId: request.conversationId, text: request.text });
        await stream.append("ok");
        return {};
      },
    },
  };
}

function countingResponder(): { readonly responder: AgentResponder; readonly calls: number } {
  const state = {
    calls: 0,
    responder: {
      async respond(_request, stream) {
        state.calls += 1;
        await stream.append("ok");
        return {};
      },
    } satisfies AgentResponder,
  };
  return state;
}
