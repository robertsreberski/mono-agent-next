// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import {
  parseRouteIdentity,
  type JsonObject,
  type RuntimeSession,
  type RouteIdentity,
} from "@mono-agent/module-sdk";

import {
  EXECUTION_STATE_PREFIXES,
  conversationStateKey,
  sessionStateKey,
} from "./execution-store.js";

import {
  CONVERSATION_PAGE_SIZE,
  CONVERSATION_TEXT_MAX_BYTES,
  CONVERSATION_TITLE_MAX_BYTES,
} from "./execution-journal-constants.js";

import {
  parseConversationRecord,
  assertConversationKeyAuthority,
  chunkCanonicalTranscript,
  parseProviderSessionRecord,
  parseSessionMetadata,
  sameRoute,
  boundedIdentifier,
  boundedConversationId,
  boundedText,
  canonicalNow,
  canonicalTimestamp,
  ownDataRecord,
} from "./execution-codec.js";

import {
  parseCanonicalTranscript,
  type CanonicalTranscript,
} from "./execution-transcript.js";

import type {
  ConversationRecord,
  ConversationView,
} from "./execution-journal-records.js";

import {
  ExecutionJournalConcern,
  type ExecutionJournalDependencies,
} from "./execution-journal-concern.js";

export class ExecutionConversationJournal extends ExecutionJournalConcern {
  constructor(dependencies: ExecutionJournalDependencies) {
    super(dependencies);
  }

  async loadTranscript(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<CanonicalTranscript | undefined> {
    const normalizedId = boundedConversationId(conversationId, "conversationId");
    const record = await this.store.read(
      conversationStateKey(normalizedId),
      parseConversationRecord,
      signal,
    );
    if (record === undefined) return undefined;
    assertConversationKeyAuthority(record, normalizedId);
    const transcript = await this.loadConversationTranscript(record.value, signal);
    if (
      transcript.revision !== record.value.revision
      || transcript.entries.length !== record.value.entryCount
    ) {
      throw new Error("canonical transcript pointer does not match its artifact");
    }
    return transcript;
  }

  async openConversation(
    input: {
      readonly title?: string;
      readonly initialText?: string;
      readonly metadata?: JsonObject;
    },
    signal: AbortSignal,
  ): Promise<ConversationView> {
    const source = ownDataRecord(
      input,
      "open conversation",
      ["title", "initialText", "metadata"],
    );
    const title = source.title === undefined
      ? undefined
      : boundedText(
        source.title,
        "open conversation.title",
        CONVERSATION_TITLE_MAX_BYTES,
        true,
      );
    const initialText = source.initialText === undefined
      ? undefined
      : boundedText(
        source.initialText,
        "open conversation.initialText",
        CONVERSATION_TEXT_MAX_BYTES,
        true,
      );
    const metadata = source.metadata === undefined
      ? undefined
      : parseSessionMetadata(source.metadata, "open conversation.metadata");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const conversationId = `proactive:${randomUUID()}`;
      const createdAt = canonicalNow(this.clock);
      const transcript = parseCanonicalTranscript({
        schemaVersion: 1,
        kind: "mono-agent.canonical-transcript",
        conversationId,
        revision: 1,
        entries: initialText === undefined || initialText.length === 0
          ? []
          : [{
              kind: "verbatim",
              entryId: `${conversationId}:initial`,
              runId: `${conversationId}:open`,
              requestId: `${conversationId}:open`,
              conversationId,
              recordedAt: createdAt,
              role: "assistant",
              text: initialText,
            }],
      });
      const chunked = chunkCanonicalTranscript(transcript);
      const value: ConversationRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.conversation",
        conversationId,
        revision: transcript.revision,
        transcriptChunks: chunked.manifest,
        entryCount: transcript.entries.length,
        createdAt,
        updatedAt: createdAt,
        ...(title === undefined ? {} : { title }),
        ...(metadata === undefined ? {} : { metadata }),
      });
      const result = await this.store.transaction({
        puts: [{
          key: conversationStateKey(conversationId),
          expectedVersion: null,
          value,
        }],
        bytePuts: chunked.chunks.map((chunk) => ({
          key: chunk.descriptor.key,
          expectedVersion: null,
          value: chunk.bytes,
        })),
        signal,
      });
      if (result.status === "applied") {
        return Object.freeze({
          conversationId,
          createdAt,
          updatedAt: createdAt,
          transcript,
          ...(title === undefined ? {} : { title }),
          ...(metadata === undefined ? {} : { metadata }),
        });
      }
    }
    throw new Error("proactive conversation identity did not converge");
  }

  /**
   * Atomically confirm one transport delivery and append its destination
   * history. Neither the delivered receipt nor the transcript entry can become
   * durable without the other.
   */

  async loadConversation(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ConversationView | undefined> {
    const normalizedId = boundedConversationId(conversationId, "conversationId");
    const record = await this.store.read(
      conversationStateKey(normalizedId),
      parseConversationRecord,
      signal,
    );
    if (record === undefined) return undefined;
    assertConversationKeyAuthority(record, normalizedId);
    const transcript = await this.loadConversationTranscript(record.value, signal);
    const createdAt = record.value.createdAt
      ?? transcript.entries[0]?.recordedAt
      ?? record.value.updatedAt;
    return Object.freeze({
      conversationId: normalizedId,
      createdAt,
      updatedAt: record.value.updatedAt,
      transcript,
      ...(record.value.title === undefined ? {} : { title: record.value.title }),
      ...(record.value.metadata === undefined
        ? {}
        : { metadata: record.value.metadata }),
    });
  }

  async listConversations(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    readonly conversations: readonly Omit<ConversationView, "transcript">[];
    readonly nextCursor?: string;
  }> {
    const page = await this.store.scan(
      EXECUTION_STATE_PREFIXES.conversations,
      cursor,
      CONVERSATION_PAGE_SIZE,
      parseConversationRecord,
      signal,
    );
    const conversations = page.records.map((record) => {
      assertConversationKeyAuthority(record);
      const { value } = record;
      return Object.freeze({
        conversationId: value.conversationId,
        createdAt: value.createdAt ?? value.updatedAt,
        updatedAt: value.updatedAt,
        ...(value.title === undefined ? {} : { title: value.title }),
        ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
      });
    });
    return Object.freeze({
      conversations: Object.freeze(conversations),
      ...(page.cursor === undefined ? {} : { nextCursor: page.cursor }),
    });
  }


  async loadSession(
    conversationId: string,
    route: RouteIdentity,
    signal: AbortSignal,
  ): Promise<{ readonly value: RuntimeSession; readonly updatedAt: string } | undefined> {
    const normalizedConversationId = boundedConversationId(
      conversationId,
      "conversationId",
    );
    const normalizedRoute = parseRouteIdentity(route);
    const record = await this.store.read(
      sessionStateKey(
        normalizedConversationId,
        normalizedRoute.runtimeInstanceId,
        normalizedRoute.model,
      ),
      parseProviderSessionRecord,
      signal,
    );
    if (record === undefined) return undefined;
    if (
      record.value.conversationId !== normalizedConversationId
      || !sameRoute(record.value.route, normalizedRoute)
      || record.value.session.conversationId !== normalizedConversationId
      || !sameRoute(record.value.session.route, normalizedRoute)
    ) {
      throw new Error("provider session key does not match its stored authority");
    }
    return Object.freeze({
      value: record.value.session,
      updatedAt: record.value.updatedAt,
    });
  }

  /**
   * Delete only the exact provider session previously observed by a caller.
   * A missing session or concurrently replaced session is a harmless miss.
   */
  async evictSession(
    conversationId: string,
    route: RouteIdentity,
    expected: {
      readonly sessionId: string;
      readonly updatedAt: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> {
    const normalizedConversationId = boundedConversationId(
      conversationId,
      "conversationId",
    );
    const normalizedRoute = parseRouteIdentity(route);
    const expectedInput = ownDataRecord(
      expected,
      "expected session authority",
      ["sessionId", "updatedAt"],
    );
    const sessionId = boundedIdentifier(
      expectedInput.sessionId,
      "expected session authority.sessionId",
    );
    const updatedAt = canonicalTimestamp(
      expectedInput.updatedAt,
      "expected session authority.updatedAt",
    );
    const key = sessionStateKey(
      normalizedConversationId,
      normalizedRoute.runtimeInstanceId,
      normalizedRoute.model,
    );
    const record = await this.store.read(
      key,
      parseProviderSessionRecord,
      signal,
    );
    if (record === undefined) return false;
    if (
      record.value.conversationId !== normalizedConversationId
      || !sameRoute(record.value.route, normalizedRoute)
      || record.value.session.conversationId !== normalizedConversationId
      || !sameRoute(record.value.session.route, normalizedRoute)
    ) {
      throw new Error("provider session key does not match its stored authority");
    }
    if (
      record.value.session.id !== sessionId
      || record.value.updatedAt !== updatedAt
    ) {
      return false;
    }
    const result = await this.store.transaction({
      deletes: [{
        key,
        expectedVersion: record.version,
      }],
      signal,
    });
    return result.status === "applied";
  }

}
