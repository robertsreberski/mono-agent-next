import { describe, expect, it } from "vitest";

import {
  appendCanonicalTranscript,
  assertCanonicalTranscriptAppendOnly,
  decodeCanonicalTranscript,
  encodeCanonicalTranscript,
  parseCanonicalTranscript,
  type CanonicalTranscript,
} from "../transcript.js";

const artifact = {
  id: "artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 12,
  mediaType: "text/plain",
  fileName: "note.txt",
} as const;

describe("canonical transcript codec", () => {
  it("round-trips only text and immutable artifact references", () => {
    const transcript: CanonicalTranscript = {
      schemaVersion: 1,
      kind: "mono-agent.canonical-transcript",
      conversationId: "conversation-1",
      revision: 1,
      entries: [
        {
          kind: "message",
          entryId: "entry-user",
          runId: "run-1",
          requestId: "request-1",
          conversationId: "conversation-1",
          recordedAt: "2026-07-23T10:00:00.000Z",
          role: "user",
          content: [
            { type: "text", text: "Please inspect this." },
            { type: "artifact", ref: artifact, name: "note.txt" },
          ],
        },
        {
          kind: "interaction",
          entryId: "entry-ask",
          runId: "run-1",
          requestId: "request-1",
          conversationId: "conversation-1",
          recordedAt: "2026-07-23T10:00:01.000Z",
          evidence: {
            kind: "ask-user",
            interactionId: "ask-1",
            phase: "answered",
            requestedAt: "2026-07-23T10:00:00.100Z",
            settledAt: "2026-07-23T10:00:00.900Z",
            questionCount: 1,
            answeredQuestionCount: 1,
          },
          content: [{ type: "text", text: "Question: proceed? Answer: yes." }],
        },
        {
          kind: "verbatim",
          entryId: "entry-verbatim",
          runId: "run-1",
          requestId: "request-1",
          conversationId: "conversation-1",
          recordedAt: "2026-07-23T10:00:02.000Z",
          role: "assistant",
          text: "Delivered exactly.",
        },
      ],
    };

    expect(decodeCanonicalTranscript(encodeCanonicalTranscript(transcript))).toEqual(transcript);
    expect(encodeCanonicalTranscript(transcript)).not.toContain(new Uint8Array([1, 2, 3]));
  });

  it("rejects unknown schemas, binary-bearing parts, sparse arrays, and accessors", () => {
    expect(() => parseCanonicalTranscript({
      schemaVersion: 2,
      kind: "mono-agent.canonical-transcript",
      conversationId: "conversation-1",
      revision: 1,
      entries: [],
    })).toThrow(/unsupported schema/u);

    const binaryPart = baseTranscript([{
      kind: "message",
      entryId: "entry-1",
      runId: "run-1",
      requestId: "request-1",
      conversationId: "conversation-1",
      recordedAt: "2026-07-23T10:00:00.000Z",
      role: "user",
      content: [{ type: "file", data: new Uint8Array([1]) }],
    }]);
    expect(() => parseCanonicalTranscript(binaryPart)).toThrow(/unknown field|type is invalid/u);

    const sparse = new Array(1);
    expect(() => parseCanonicalTranscript(baseTranscript(sparse))).toThrow(/own data property/u);

    const accessor = baseTranscript([]);
    Object.defineProperty(accessor, "revision", { enumerable: true, get: () => 1 });
    expect(() => parseCanonicalTranscript(accessor)).toThrow(/own data property/u);
  });

  it("increments exactly one revision and preserves conversation authority", () => {
    const first = appendCanonicalTranscript(undefined, "conversation-1", [{
      kind: "verbatim",
      entryId: "entry-1",
      runId: "run-1",
      requestId: "request-1",
      conversationId: "conversation-1",
      recordedAt: "2026-07-23T10:00:00.000Z",
      role: "user",
      text: "original",
    }]);
    expect(first.revision).toBe(1);
    const second = appendCanonicalTranscript(first, "conversation-1", []);
    expect(second.revision).toBe(2);
    expect(() => assertCanonicalTranscriptAppendOnly(first, {
      ...second,
      entries: [],
    })).toThrow(/cannot truncate/u);
    const original = first.entries[0];
    if (original?.kind !== "verbatim") throw new Error("expected verbatim fixture entry");
    expect(() => assertCanonicalTranscriptAppendOnly(first, {
      ...second,
      entries: [{
        ...original,
        text: "rewritten",
      }],
    })).toThrow(/cannot rewrite/u);
    expect(() => appendCanonicalTranscript(second, "conversation-2", [])).toThrow(
      /conversation identity/u,
    );
  });
});

function baseTranscript(entries: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mono-agent.canonical-transcript",
    conversationId: "conversation-1",
    revision: 1,
    entries,
  };
}
