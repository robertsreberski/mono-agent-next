import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
  agentAttachmentKindFromMimeType,
  decodeAgentAttachmentText,
  type AgentAttachment,
  type AgentRequestBase,
} from "../index.js";

describe("multimodal attachment contracts", () => {
  it("shares the default Telegram-compatible size and MIME policy", () => {
    expect(DEFAULT_AGENT_ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST).toContain("image/png");
    expect(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST).toContain("text/plain");
    expect(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST).toContain("audio/ogg");
    expect(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST).toContain("video/mp4");
  });

  it("classifies images and decodes only text MIME payloads", () => {
    const bytes = new TextEncoder().encode("hello, web");

    expect(agentAttachmentKindFromMimeType(" IMAGE/PNG ")).toBe("image");
    expect(agentAttachmentKindFromMimeType("application/pdf")).toBe("document");
    expect(decodeAgentAttachmentText("TEXT/PLAIN", bytes)).toBe("hello, web");
    expect(decodeAgentAttachmentText("application/json", bytes)).toBeUndefined();
    expect(decodeAgentAttachmentText(
      "text/plain",
      Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]),
    )).toBe("\ufeffhi");
  });

  it("models image and document attachments", () => {
    const image: AgentAttachment = {
      kind: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
      name: "screenshot.png",
      sizeBytes: 5,
    };
    const document: AgentAttachment = {
      kind: "document",
      mimeType: "application/pdf",
      data: "JVBERi0=",
      text: "extracted text",
    };
    expect(image.kind).toBe("image");
    expect(document.text).toBe("extracted text");
  });

  it("extends AgentRequestBase with an optional attachments array", () => {
    const withAttachments: AgentRequestBase = {
      conversationId: "c:1",
      text: "describe this",
      abortSignal: new AbortController().signal,
      attachments: [
        { kind: "image", mimeType: "image/jpeg", data: "Zm9v" },
      ],
    };
    // Backward compatible: omitting attachments is still valid.
    const withoutAttachments: AgentRequestBase = {
      conversationId: "c:2",
      text: "hi",
      abortSignal: new AbortController().signal,
    };
    expect(withAttachments.attachments?.[0]?.kind).toBe("image");
    expect(withoutAttachments.attachments).toBeUndefined();
  });

  it("keeps reply targets and continuation synthesis controls host-side", () => {
    const request: AgentRequestBase = {
      conversationId: "slack:C1:thread#2026-07-14",
      text: "synthesize the completed delegation",
      abortSignal: new AbortController().signal,
      replyTo: { conversationId: "slack:C1:thread" },
      continuation: {
        continuationId: "continuation-1",
        originRunId: "run-origin",
        originContextPolicy: "detached_latest",
        toolsDisabled: true,
        deferHistoryCommit: true,
      },
    };

    expect(request.replyTo?.conversationId).toBe("slack:C1:thread");
    expect(request.continuation?.originRunId).toBe("run-origin");
  });
});
