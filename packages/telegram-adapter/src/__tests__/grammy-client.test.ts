import { createServer } from "node:http";
import { once } from "node:events";

import { GrammyError, HttpError } from "grammy";
import type { Api, ApiClientOptions } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { createGrammyTelegramApi, createTelegramMessageSender } from "../grammy-client.js";
import { TelegramApiError } from "../telegram-error.js";

interface RecordedCall {
  args: unknown[];
}

function recordingApi(
  handlers: {
    sendMessage?: (...args: unknown[]) => unknown;
    editMessageText?: (...args: unknown[]) => unknown;
    editMessageTextInline?: (...args: unknown[]) => unknown;
    deleteMessage?: (...args: unknown[]) => unknown;
  },
): { api: Api; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const api = {
    async sendMessage(...args: unknown[]) {
      calls.push({ args });
      return handlers.sendMessage?.(...args);
    },
    async editMessageText(...args: unknown[]) {
      calls.push({ args });
      return handlers.editMessageText?.(...args);
    },
    async editMessageTextInline(...args: unknown[]) {
      calls.push({ args });
      return handlers.editMessageTextInline?.(...args);
    },
    async deleteMessage(...args: unknown[]) {
      calls.push({ args });
      return handlers.deleteMessage?.(...args);
    },
  } as unknown as Api;
  return { api, calls };
}

describe("createGrammyTelegramApi", () => {
  it("creates a TelegramMessageSender from a bot token", () => {
    const client = createTelegramMessageSender(" 123:abc ");

    expect(typeof client.sendMessage).toBe("function");
    expect(typeof client.editMessageText).toBe("function");
    expect(typeof client.deleteMessage).toBe("function");
  });

  it("rejects blank bot tokens", () => {
    expect(() => createTelegramMessageSender(" ")).toThrow(/bot token is required/u);
  });

  it("translates sendMessage params into grammY positional args plus options", async () => {
    const { api, calls } = recordingApi({
      sendMessage: (chat_id, text) => ({
        message_id: 7,
        chat: { id: chat_id },
        text,
      }),
    });
    const client = createGrammyTelegramApi(api);

    const message = await client.sendMessage({
      chat_id: 42,
      text: "hi",
      parse_mode: "MarkdownV2",
      reply_to_message_id: 5,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    });

    expect(calls[0]?.args[0]).toBe(42);
    expect(calls[0]?.args[1]).toBe("hi");
    expect(calls[0]?.args[2]).toEqual({
      parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
    });
    expect(message.message_id).toBe(7);
  });

  it("translates editMessageText params into grammY positional args", async () => {
    const { api, calls } = recordingApi({ editMessageText: () => true });
    const client = createGrammyTelegramApi(api);

    const result = await client.editMessageText({
      chat_id: 1,
      message_id: 9,
      text: "x",
      parse_mode: "MarkdownV2",
    });

    expect(calls[0]?.args.slice(0, 3)).toEqual([1, 9, "x"]);
    expect(calls[0]?.args[3]).toEqual({ parse_mode: "MarkdownV2" });
    expect(result).toBe(true);
  });

  it("editMessageText forwards reply_markup to grammY's options", async () => {
    const { api, calls } = recordingApi({ editMessageText: () => true });
    const client = createGrammyTelegramApi(api);

    const reply_markup = { inline_keyboard: [[{ text: "Yes", callback_data: "reply:v1:0" }]] };
    const result = await client.editMessageText({
      chat_id: 1,
      message_id: 9,
      text: "x",
      parse_mode: "MarkdownV2",
      reply_markup,
    });

    expect(calls[0]?.args.slice(0, 3)).toEqual([1, 9, "x"]);
    expect(calls[0]?.args[3]).toEqual({ parse_mode: "MarkdownV2", reply_markup });
    expect(result).toBe(true);
  });

  it("routes inline-message edits to editMessageTextInline", async () => {
    const { api, calls } = recordingApi({ editMessageTextInline: () => true });
    const client = createGrammyTelegramApi(api);

    const result = await client.editMessageText({
      inline_message_id: "inline-1",
      text: "x",
      parse_mode: "MarkdownV2",
    });

    expect(calls[0]?.args.slice(0, 2)).toEqual(["inline-1", "x"]);
    expect(calls[0]?.args[2]).toEqual({ parse_mode: "MarkdownV2" });
    expect(result).toBe(true);
  });

  it("translates deleteMessage params into grammY positional args", async () => {
    const { api, calls } = recordingApi({ deleteMessage: () => true });
    const client = createGrammyTelegramApi(api);

    await expect(client.deleteMessage?.({ chat_id: 1, message_id: 9 })).resolves.toBe(true);

    expect(calls[0]?.args.slice(0, 2)).toEqual([1, 9]);
  });

  it("maps a GrammyError to a TelegramApiError carrying retry_after", async () => {
    const { api } = recordingApi({
      sendMessage: () => {
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 3",
            parameters: { retry_after: 3 },
          },
          "sendMessage",
          {},
        );
      },
    });
    const client = createGrammyTelegramApi(api);

    const error = await client
      .sendMessage({ chat_id: 1, text: "x" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({
      kind: "telegram",
      method: "sendMessage",
      errorCode: 429,
      telegramDescription: "Too Many Requests: retry after 3",
      retryAfterMs: 3000,
    });
  });

  it("maps an HttpError to a network TelegramApiError", async () => {
    const { api } = recordingApi({
      editMessageText: () => {
        throw new HttpError("Network request failed", new Error("ECONNRESET"));
      },
    });
    const client = createGrammyTelegramApi(api);

    const error = await client
      .editMessageText({ chat_id: 1, message_id: 2, text: "x" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).kind).toBe("network");
  });

  it("maps an aborted request to an aborted TelegramApiError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { api } = recordingApi({
      sendMessage: () => {
        throw new DOMException("Aborted", "AbortError");
      },
    });
    const client = createGrammyTelegramApi(api);

    const error = await client
      .sendMessage({ chat_id: 1, text: "x" }, { signal: controller.signal })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).kind).toBe("aborted");
  });
});

describe("sendDocument document shapes", () => {
  function documentApi(): { api: Api; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const api = {
      async sendDocument(...args: unknown[]) {
        calls.push({ args });
        return { message_id: 5, chat: { id: args[0] } };
      },
    } as unknown as Api;
    return { api, calls };
  }

  it("passes a string document (file_id / URL / file:// URI) through untouched", async () => {
    const { api, calls } = documentApi();
    const sender = createGrammyTelegramApi(api);

    await sender.sendDocument!({ chat_id: 42, document: "file:///tmp/transcript.md", caption: "done" });

    expect(calls[0]?.args[1]).toBe("file:///tmp/transcript.md");
  });

  it("wraps raw bytes in an InputFile with the filename", async () => {
    const { api, calls } = documentApi();
    const sender = createGrammyTelegramApi(api);

    await sender.sendDocument!({ chat_id: 42, document: new Uint8Array([1, 2]), filename: "t.md" });

    const uploaded = calls[0]?.args[1] as { filename?: string };
    expect(uploaded).not.toBeTypeOf("string");
    expect(uploaded.filename).toBe("t.md");
  });
});

describe("createTelegramMessageSender client options", () => {
  it("preserves grammY's default fetch while applying apiRoot", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          result: { message_id: 7, chat: { id: 42 }, text: "hello" },
        }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("expected an address for the Telegram test server");
    }

    try {
      const sender = createTelegramMessageSender("123456:token", {
        apiRoot: `http://127.0.0.1:${String(address.port)}`,
      });

      const sent = await sender.sendMessage({ chat_id: 42, text: "hello" });

      expect(sent.message_id).toBe(7);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/bot123456:token/sendMessage");
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ chat_id: 42, text: "hello" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("passes a supplied fetch seam through the grammY JSON request path", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        result: { message_id: 8, chat: { id: 42 }, text: "proxied" },
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as NonNullable<ApiClientOptions["fetch"]>;
    const sender = createTelegramMessageSender("123456:token", {
      apiRoot: "https://telegram.invalid",
      fetchImpl,
    });

    const sent = await sender.sendMessage({ chat_id: 42, text: "proxied" });

    expect(sent.message_id).toBe(8);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://telegram.invalid/bot123456:token/sendMessage");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: 42, text: "proxied" });
  });

  it("passes a supplied fetch seam through grammY's streamed multipart path", async () => {
    const requests: Array<{ contentType: string; body: Buffer }> = [];
    const fetchImpl = vi.fn(async (_url: Parameters<NonNullable<ApiClientOptions["fetch"]>>[0], init) => {
      const chunks: Buffer[] = [];
      const body = init?.body as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        contentType: headers?.["content-type"] ?? "",
        body: Buffer.concat(chunks),
      });
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 9, chat: { id: 42 } },
      }), { status: 200, headers: { "content-type": "application/json" } }) as never;
    }) as unknown as NonNullable<ApiClientOptions["fetch"]>;
    const sender = createTelegramMessageSender("123456:token", { fetchImpl });

    const sent = await sender.sendDocument!({
      chat_id: 42,
      document: new Uint8Array([65, 66, 67]),
      filename: "proof.txt",
      caption: "attached",
    });

    expect(sent.message_id).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    const payload = requests[0]?.body.toString("utf8") ?? "";
    expect(payload).toContain("proof.txt");
    expect(payload).toContain("attached");
    expect(payload).toContain("ABC");
  });
});
