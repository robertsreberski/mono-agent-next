import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";

import {
  WEB_MAX_FILES_PER_TURN,
  WEB_MAX_LIVE_INPUTS_PER_THREAD,
  WEB_MAX_TURN_ATTACHMENT_BYTES,
  WEB_MAX_TURN_TEXT_CHARACTERS,
  type WebAgentSummary,
  type WebAttachment,
  type WebMessage,
  type WebMessagePart,
  type WebMessageStatus,
  type WebNotificationTriggerKind,
  type WebQuote,
  type WebRunState,
  type WebThread,
  type WebThreadDetail,
} from "./contracts.js";
import { WebConsoleError } from "./errors.js";
import { prepareWebStatePaths, type WebStatePathOptions, type WebStatePaths } from "./state-paths.js";

interface AgentRow {
  source_id: string;
  label: string;
  status: string;
  pinned: number;
  health: string | null;
  supports_attachments: number;
  models_json: string | null;
  default_model: string | null;
  default_effort: string | null;
  efforts_json: string | null;
  model_options_json: string | null;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  source_id: string;
  title: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  trigger_kind: string | null;
  can_send: number;
  can_upload: number;
  message_count: number;
}

interface NotificationDeliveryRow {
  source_id: string;
  delivery_key: string;
  thread_id: string;
  trigger_kind: string;
  payload_sha256: string;
  created_at: string;
  completed_at: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  parts_json: string;
  created_at: string;
  updated_at: string;
  status: string;
}

interface TurnRow {
  id: string;
  thread_id: string;
  status: string;
  model: string | null;
  effort: string | null;
  assistant_message_id: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface LiveInputRow {
  id: string;
  thread_id: string;
  message_id: string;
  active_turn_id: string | null;
  text: string;
  model: string | null;
  effort: string | null;
  status: "offered" | "queued";
  created_at: string;
  updated_at: string;
}

export interface StoredAttachment {
  readonly id: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "document";
  readonly status: "staged" | "committed";
  readonly uploaded: boolean;
  readonly storageName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AttachmentRow {
  id: string;
  thread_id: string | null;
  message_id: string | null;
  name: string;
  content_type: string;
  size_bytes: number;
  kind: string;
  status: string;
  uploaded: number;
  storage_name: string;
  created_at: string;
  updated_at: string;
}

export interface OpenWebStoreOptions extends WebStatePathOptions {
  readonly clock?: () => Date;
}

export interface CreateStoredUploadInput {
  readonly name: string;
  readonly contentType: string;
  readonly kind: "image" | "document";
  readonly declaredSize?: number;
}

export interface BeginStoredTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly quote?: WebQuote;
  readonly model?: string;
  readonly effort?: string;
}

export interface BeginStoredTurnResult {
  readonly turnId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly quote?: WebQuote;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly attachments: readonly StoredAttachment[];
  readonly thread: WebThread;
}

export interface StoredLiveInput {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly status: "offered" | "queued";
  readonly createdAt: string;
}

export interface ReserveStoredLiveInputResult {
  readonly input: StoredLiveInput;
  readonly message: WebMessage;
  readonly thread: WebThread;
  readonly offered: boolean;
}

export interface ReserveWebNotificationInput {
  readonly sourceId: string;
  readonly deliveryKey: string;
  readonly triggerKind: WebNotificationTriggerKind;
  readonly text: string;
}

export interface WebNotificationReservation extends ReserveWebNotificationInput {
  readonly threadId: string;
  readonly payloadSha256: string;
  readonly duplicate: boolean;
}

export interface CompleteWebNotificationResult {
  readonly thread: WebThread;
  readonly duplicate: boolean;
}

export class WebStore {
  readonly paths: WebStatePaths;
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private closed = false;

  private constructor(database: DatabaseSync, paths: WebStatePaths, clock: () => Date) {
    this.database = database;
    this.paths = paths;
    this.clock = clock;
  }

  static async open(options: OpenWebStoreOptions = {}): Promise<WebStore> {
    const paths = await prepareWebStatePaths(options);
    return WebStore.openPrepared(paths, options);
  }

  static async openPrepared(paths: WebStatePaths, options: Pick<OpenWebStoreOptions, "clock"> = {}): Promise<WebStore> {
    const existing = await lstat(paths.database).catch(() => undefined);
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new WebConsoleError("invalid_state_database", "Web state database must be a regular file.", 409);
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (existing !== undefined && currentUid !== undefined && existing.uid !== currentUid) {
      throw new WebConsoleError("invalid_state_owner", "Web state database is not owned by the current user.", 409);
    }
    const database = new DatabaseSync(paths.database, { timeout: 5_000 });
    const store = new WebStore(database, paths, options.clock ?? (() => new Date()));
    try {
      store.initialize();
      await Promise.all([
        chmod(paths.database, 0o600),
        chmod(`${paths.database}-wal`, 0o600).catch(ignoreMissing),
        chmod(`${paths.database}-shm`, 0o600).catch(ignoreMissing),
      ]);
      store.recoverInterruptedTurns();
      store.recoverLiveInputs();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  replaceAgents(agents: readonly WebAgentSummary[]): void {
    this.transaction(() => {
      this.database.prepare("UPDATE agents SET status = 'offline'").run();
      const statement = this.database.prepare(`
        INSERT INTO agents (
          source_id, label, status, health, supports_attachments, models_json,
          default_model, default_effort, efforts_json, model_options_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          label = excluded.label,
          status = excluded.status,
          health = excluded.health,
          supports_attachments = excluded.supports_attachments,
          models_json = excluded.models_json,
          default_model = excluded.default_model,
          default_effort = excluded.default_effort,
          efforts_json = excluded.efforts_json,
          model_options_json = excluded.model_options_json,
          updated_at = excluded.updated_at
      `);
      for (const agent of agents) {
        statement.run(
          agent.sourceId,
          agent.label,
          agent.status,
          agent.health ?? null,
          agent.supportsAttachments ? 1 : 0,
          stringifyOptional(agent.models),
          agent.defaultModel ?? null,
          agent.defaultEffort ?? null,
          stringifyOptional(agent.efforts),
          stringifyOptional(agent.modelOptions),
          agent.updatedAt,
        );
      }
    });
  }

  listAgents(): WebAgentSummary[] {
    const rows = this.database.prepare(agentSelectSql("ORDER BY pinned DESC, a.label COLLATE NOCASE, a.source_id")).all() as unknown as AgentRow[];
    return rows.map(mapAgent);
  }

  getAgent(sourceId: string): WebAgentSummary | undefined {
    const row = this.database.prepare(agentSelectSql("WHERE a.source_id = ?")).get(sourceId) as unknown as AgentRow | undefined;
    return row === undefined ? undefined : mapAgent(row);
  }

  setAgentPinned(sourceId: string, pinned: boolean): WebAgentSummary {
    if (this.getAgent(sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    const key = agentPinSettingKey(sourceId);
    if (pinned) this.setSetting(key, "1");
    else this.database.prepare("DELETE FROM settings WHERE key = ?").run(key);
    const agent = this.getAgent(sourceId);
    if (agent === undefined) throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    return agent;
  }

  reserveNotification(input: ReserveWebNotificationInput): WebNotificationReservation {
    if (this.getAgent(input.sourceId) === undefined) {
      throw new WebConsoleError("agent_not_found", "The notification agent is no longer available.", 404);
    }
    if (input.deliveryKey.length === 0 || input.deliveryKey.length > 1_024) {
      throw new WebConsoleError("invalid_notification", "Notification deliveryKey must contain 1 to 1024 characters.", 400);
    }
    if (input.text.trim().length === 0) {
      throw new WebConsoleError("invalid_notification", "Notification text cannot be empty.", 400);
    }
    const threadId = notificationThreadId(input.sourceId, input.deliveryKey);
    const payloadSha256 = notificationPayloadSha256(input.triggerKind, input.text);
    const existing = this.database.prepare(`
      SELECT * FROM notification_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get(input.sourceId, input.deliveryKey) as unknown as NotificationDeliveryRow | undefined;
    if (existing !== undefined) {
      if (existing.thread_id !== threadId
        || existing.trigger_kind !== input.triggerKind
        || existing.payload_sha256 !== payloadSha256) {
        throw new WebConsoleError(
          "notification_idempotency_conflict",
          "The notification delivery key was already used with different content.",
          409,
        );
      }
      if (existing.completed_at !== null && this.getThread(existing.thread_id) === undefined) {
        throw new WebConsoleError("storage_corrupt", "A completed notification is missing its conversation.", 500);
      }
      return { ...input, threadId, payloadSha256, duplicate: existing.completed_at !== null };
    }
    const now = this.now();
    this.database.prepare(`
      INSERT INTO notification_deliveries (
        source_id, delivery_key, thread_id, trigger_kind, payload_sha256, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(input.sourceId, input.deliveryKey, threadId, input.triggerKind, payloadSha256, now);
    return { ...input, threadId, payloadSha256, duplicate: false };
  }

  completeNotification(reservation: WebNotificationReservation): CompleteWebNotificationResult {
    const existing = this.database.prepare(`
      SELECT * FROM notification_deliveries WHERE source_id = ? AND delivery_key = ?
    `).get(reservation.sourceId, reservation.deliveryKey) as unknown as NotificationDeliveryRow | undefined;
    if (existing === undefined
      || existing.thread_id !== reservation.threadId
      || existing.trigger_kind !== reservation.triggerKind
      || existing.payload_sha256 !== reservation.payloadSha256) {
      throw new WebConsoleError("notification_reservation_lost", "The notification reservation is no longer valid.", 409);
    }
    if (existing.completed_at !== null) {
      return { thread: this.requireThread(existing.thread_id), duplicate: true };
    }
    const now = this.now();
    const turnId = randomUUID();
    const assistantMessageId = randomUUID();
    const title = reservation.triggerKind === "cron" ? "Cron notification" : "Webhook notification";
    this.transaction(() => {
      if (this.getThread(reservation.threadId) !== undefined) {
        throw new WebConsoleError("notification_idempotency_conflict", "The notification conversation already exists.", 409);
      }
      this.database.prepare(`
        INSERT INTO threads (
          id, source_id, conversation_id, title, title_manual, trigger_kind, archived_at,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, 1)
      `).run(
        reservation.threadId,
        reservation.sourceId,
        `web:${reservation.threadId}`,
        title,
        reservation.triggerKind,
        now,
        now,
      );
      this.database.prepare(`
        INSERT INTO turns (
          id, thread_id, status, text, model, effort, assistant_message_id,
          started_at, finished_at, error_code, error_message
        ) VALUES (?, ?, 'complete', '', NULL, NULL, ?, ?, ?, NULL, NULL)
      `).run(turnId, reservation.threadId, assistantMessageId, now, now);
      this.database.prepare(`
        INSERT INTO messages (
          id, thread_id, turn_id, role, parts_json, created_at, updated_at, status
        ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, 'complete')
      `).run(
        assistantMessageId,
        reservation.threadId,
        turnId,
        JSON.stringify([{ type: "text", text: reservation.text } satisfies WebMessagePart]),
        now,
        now,
      );
      this.database.prepare(`
        INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at)
        VALUES ('thread', ?, 1, 'notification_created', ?)
      `).run(reservation.threadId, now);
      this.database.prepare(`
        UPDATE notification_deliveries SET completed_at = ?
        WHERE source_id = ? AND delivery_key = ? AND completed_at IS NULL
      `).run(now, reservation.sourceId, reservation.deliveryKey);
    });
    return { thread: this.requireThread(reservation.threadId), duplicate: false };
  }

  createThread(sourceId: string): WebThread {
    const agent = this.getAgent(sourceId);
    if (agent === undefined) {
      throw new WebConsoleError("agent_not_found", "The selected agent is no longer available.", 404);
    }
    const id = randomUUID();
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO threads (
          id, source_id, conversation_id, title, title_manual, archived_at,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, 'New conversation', 0, NULL, ?, ?, 1)
      `).run(id, sourceId, `web:${id}`, now, now);
      this.database.prepare("INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at) VALUES ('thread', ?, 1, 'created', ?)")
        .run(id, now);
      this.setSetting("current_thread_id", id);
    });
    return this.requireThread(id);
  }

  listThreads(): WebThread[] {
    const rows = this.database.prepare(threadSelectSql("ORDER BY t.updated_at DESC, t.id")).all() as unknown as ThreadRow[];
    return rows.map((row) => this.mapThread(row));
  }

  getThread(id: string): WebThread | undefined {
    const row = this.database.prepare(threadSelectSql("WHERE t.id = ?")).get(id) as unknown as ThreadRow | undefined;
    return row === undefined ? undefined : this.mapThread(row);
  }

  getThreadDetail(id: string): WebThreadDetail | undefined {
    const thread = this.getThread(id);
    if (thread === undefined) return undefined;
    const rows = this.database.prepare(`
      SELECT m.* FROM messages m
      LEFT JOIN turns t ON t.id = m.turn_id
      WHERE m.thread_id = ?
      ORDER BY COALESCE(t.started_at, m.created_at),
        CASE WHEN m.turn_id IS NOT NULL AND m.role = 'user' THEN 0
             WHEN m.turn_id IS NOT NULL AND m.role = 'system' THEN 1
             WHEN m.turn_id IS NOT NULL THEN 2
             ELSE 3 END,
        m.created_at, m.rowid
    `).all(id) as unknown as MessageRow[];
    return { thread, messages: rows.map((row) => this.mapMessage(row)) };
  }

  currentThreadId(): string | undefined {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = 'current_thread_id'").get() as unknown as { value: string } | undefined;
    if (row === undefined || this.getThread(row.value) === undefined) return undefined;
    return row.value;
  }

  selectThread(id: string): void {
    this.requireThread(id);
    this.setSetting("current_thread_id", id);
  }

  patchThread(id: string, patch: { readonly title?: string; readonly archived?: boolean }): WebThread {
    const current = this.requireThread(id);
    const now = this.now();
    const title = patch.title === undefined ? undefined : normalizeTitle(patch.title);
    const archivedAt = patch.archived === undefined ? undefined : patch.archived ? now : null;
    this.transaction(() => {
      const sets = ["updated_at = ?", "revision = revision + 1"];
      const values: Array<string | null> = [now];
      if (title !== undefined) {
        sets.push("title = ?", "title_manual = 1");
        values.push(title);
      }
      if (archivedAt !== undefined) {
        sets.push("archived_at = ?");
        values.push(archivedAt);
      }
      values.push(id);
      this.database.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      this.recordThreadRevision(id, title !== undefined ? "title_changed" : patch.archived ? "archived" : "unarchived", now);
      if (patch.archived === true && this.currentThreadId() === id) {
        this.database.prepare("DELETE FROM settings WHERE key = 'current_thread_id'").run();
      }
    });
    return { ...this.requireThread(id), sourceId: current.sourceId };
  }

  async deleteArchivedThread(id: string): Promise<{ readonly orphanedFiles: number }> {
    const thread = this.requireThread(id);
    if (thread.archivedAt === null) {
      throw new WebConsoleError("thread_not_archived", "Archive the conversation before deleting it.", 409);
    }
    const attachments = this.database.prepare("SELECT * FROM attachments WHERE thread_id = ?")
      .all(id) as unknown as AttachmentRow[];
    this.transaction(() => {
      this.database.prepare("DELETE FROM notification_deliveries WHERE thread_id = ?").run(id);
      this.database.prepare("DELETE FROM revisions WHERE entity_kind = 'thread' AND entity_id = ?").run(id);
      this.database.prepare("DELETE FROM threads WHERE id = ?").run(id);
      this.database.prepare("DELETE FROM settings WHERE key = 'current_thread_id' AND value = ?").run(id);
    });

    let orphanedFiles = 0;
    for (const row of attachments) {
      await unlink(this.attachmentPath(mapStoredAttachment(row))).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") orphanedFiles += 1;
      });
    }
    return { orphanedFiles };
  }

  createUpload(input: CreateStoredUploadInput): StoredAttachment {
    const id = randomUUID();
    const now = this.now();
    const storageName = `${id}.bin`;
    this.database.prepare(`
      INSERT INTO attachments (
        id, thread_id, message_id, name, content_type, size_bytes, kind,
        status, uploaded, storage_name, created_at, updated_at
      ) VALUES (?, NULL, NULL, ?, ?, ?, ?, 'staged', 0, ?, ?, ?)
    `).run(id, input.name, input.contentType, input.declaredSize ?? 0, input.kind, storageName, now, now);
    return this.requireStoredAttachment(id);
  }

  markUploadComplete(id: string, sizeBytes: number): StoredAttachment {
    const attachment = this.requireStoredAttachment(id);
    if (attachment.status !== "staged" || attachment.threadId !== undefined) {
      throw new WebConsoleError("attachment_committed", "A committed attachment cannot be replaced.", 409);
    }
    const now = this.now();
    this.database.prepare("UPDATE attachments SET size_bytes = ?, uploaded = 1, updated_at = ? WHERE id = ?")
      .run(sizeBytes, now, id);
    return this.requireStoredAttachment(id);
  }

  getStoredAttachment(id: string): StoredAttachment | undefined {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as unknown as AttachmentRow | undefined;
    return row === undefined ? undefined : mapStoredAttachment(row);
  }

  stagedUploadUsage(): { readonly count: number; readonly bytes: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
      FROM attachments WHERE status = 'staged' AND thread_id IS NULL
    `).get() as unknown as { count: number; bytes: number };
    return row;
  }

  attachmentPath(attachment: Pick<StoredAttachment, "storageName">): string {
    return resolve(this.paths.uploads, attachment.storageName);
  }

  async removeStagedAttachment(id: string): Promise<void> {
    const attachment = this.requireStoredAttachment(id);
    if (attachment.status !== "staged" || attachment.threadId !== undefined) {
      throw new WebConsoleError("attachment_committed", "Committed attachments are retained with their conversation.", 409);
    }
    await unlink(this.attachmentPath(attachment)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }

  async purgeStagedAttachments(before: string): Promise<number> {
    const rows = this.database.prepare(`
      SELECT * FROM attachments
      WHERE status = 'staged' AND thread_id IS NULL AND created_at < ?
    `).all(before) as unknown as AttachmentRow[];
    if (rows.length === 0) return 0;
    for (const row of rows) {
      await unlink(this.attachmentPath(mapStoredAttachment(row))).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    this.transaction(() => {
      const remove = this.database.prepare("DELETE FROM attachments WHERE id = ? AND status = 'staged' AND thread_id IS NULL");
      for (const row of rows) remove.run(row.id);
    });
    return rows.length;
  }

  async purgePartialUploadFiles(before?: string): Promise<number> {
    const entries = await readdir(this.paths.uploads, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}\.bin\.partial-[0-9a-f-]{36}$/iu.test(entry.name)) continue;
      const path = resolve(this.paths.uploads, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (before !== undefined && info.mtime.toISOString() >= before) continue;
      await unlink(path);
      removed += 1;
    }
    return removed;
  }

  async purgeUnreferencedAttachmentFiles(): Promise<number> {
    const referenced = new Set(
      (this.database.prepare("SELECT storage_name FROM attachments").all() as unknown as Array<{ storage_name: string }>)
        .map((row) => row.storage_name),
    );
    const entries = await readdir(this.paths.uploads, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}\.bin$/iu.test(entry.name) || referenced.has(entry.name)) continue;
      const path = resolve(this.paths.uploads, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await unlink(path);
      removed += 1;
    }
    return removed;
  }

  beginTurn(input: BeginStoredTurnInput): BeginStoredTurnResult {
    const thread = this.requireThread(input.threadId);
    if (thread.archivedAt !== null) {
      throw new WebConsoleError("thread_archived", "Unarchive this conversation before sending another message.", 409);
    }
    if (!thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    const active = this.database.prepare("SELECT id FROM turns WHERE thread_id = ? AND status = 'running'").get(input.threadId);
    if (active !== undefined) {
      throw new WebConsoleError("turn_active", "This conversation already has an active turn.", 409);
    }
    const uniqueIds = [...new Set(input.attachmentIds)];
    if (uniqueIds.length !== input.attachmentIds.length || uniqueIds.length > WEB_MAX_FILES_PER_TURN) {
      throw new WebConsoleError("attachment_limit", `A turn accepts at most ${WEB_MAX_FILES_PER_TURN} distinct attachments.`, 400);
    }
    const attachments = uniqueIds.map((id) => this.requireStoredAttachment(id));
    if (attachments.length > 0 && !thread.canUpload) {
      throw new WebConsoleError("attachments_unsupported", "This agent does not advertise web attachment support.", 409);
    }
    for (const attachment of attachments) {
      if (attachment.status !== "staged" || attachment.threadId !== undefined || !attachment.uploaded) {
        throw new WebConsoleError("attachment_unavailable", `Attachment ${attachment.id} is not ready.`, 409);
      }
    }
    const aggregateBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (aggregateBytes > WEB_MAX_TURN_ATTACHMENT_BYTES) {
      throw new WebConsoleError("attachment_aggregate_limit", "The turn's attachments exceed the 64 MiB aggregate limit.", 413);
    }
    if (input.text.trim().length === 0 && attachments.length === 0) {
      throw new WebConsoleError("empty_turn", "Enter a message or attach at least one file.", 400);
    }
    if (input.quote !== undefined) {
      if (input.quote.text.trim().length === 0 || input.quote.messageId.trim().length === 0) {
        throw new WebConsoleError("invalid_quote", "Quoted text and its source message are required.", 400);
      }
      const source = this.database.prepare(
        "SELECT id FROM messages WHERE id = ? AND thread_id = ?",
      ).get(input.quote.messageId, input.threadId);
      if (source === undefined) {
        throw new WebConsoleError(
          "invalid_quote",
          "The quoted message does not belong to this conversation.",
          400,
        );
      }
    }

    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO turns (
          id, thread_id, status, text, model, effort, assistant_message_id,
          started_at, finished_at, error_code, error_message
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(turnId, input.threadId, input.text, input.model ?? null, input.effort ?? null, assistantMessageId, now);

      const userParts: WebMessagePart[] = [
        ...(input.quote === undefined
          ? []
          : [{ type: "telemetry" as const, event: QUOTE_TELEMETRY_EVENT, data: input.quote }]),
        ...(input.text.length === 0 ? [] : [{ type: "text" as const, text: input.text }]),
      ];
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 'complete')
      `).run(userMessageId, input.threadId, turnId, JSON.stringify(userParts), now, now);
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'assistant', '[]', ?, ?, 'running')
      `).run(assistantMessageId, input.threadId, turnId, now, now);

      const commitAttachment = this.database.prepare(`
        UPDATE attachments
        SET thread_id = ?, message_id = ?, status = 'committed', updated_at = ?
        WHERE id = ?
      `);
      for (const attachment of attachments) {
        commitAttachment.run(input.threadId, userMessageId, now, attachment.id);
      }

      const title = deriveAutomaticTitle(input.text, attachments);
      this.database.prepare(`
        UPDATE threads
        SET title = CASE WHEN title_manual = 0 AND title = 'New conversation' THEN ? ELSE title END,
            updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(title, now, input.threadId);
      this.recordThreadRevision(input.threadId, "turn_started", now);
      this.setSetting("current_thread_id", input.threadId);
    });

    return {
      turnId,
      conversationId: `web:${input.threadId}`,
      text: input.text,
      ...(input.quote === undefined ? {} : { quote: input.quote }),
      userMessageId,
      assistantMessageId,
      attachments: attachments.map((attachment) => this.requireStoredAttachment(attachment.id)),
      thread: this.requireThread(input.threadId),
    };
  }

  reserveLiveInput(threadId: string, text: string): ReserveStoredLiveInputResult {
    const thread = this.requireThread(threadId);
    if (thread.archivedAt !== null) {
      throw new WebConsoleError("thread_archived", "Unarchive this conversation before sending another message.", 409);
    }
    if (!thread.canSend) {
      throw new WebConsoleError("agent_offline", "This agent is offline. The conversation remains available read-only.", 409);
    }
    if (text.trim().length === 0) {
      throw new WebConsoleError("empty_turn", "Enter a message.", 400);
    }
    if (text.length > AGENT_LIVE_INPUT_MAX_CHARACTERS) {
      throw new WebConsoleError(
        "turn_text_too_large",
        `A live follow-up may contain at most ${AGENT_LIVE_INPUT_MAX_CHARACTERS} characters.`,
        413,
      );
    }
    const usage = this.database.prepare(
      "SELECT COUNT(*) AS count FROM live_inputs WHERE thread_id = ?",
    ).get(threadId) as unknown as { count: number };
    if (usage.count >= WEB_MAX_LIVE_INPUTS_PER_THREAD) {
      throw new WebConsoleError("live_input_queue_full", "Too many follow-up messages are waiting.", 429);
    }
    const active = this.database.prepare(
      "SELECT id, model, effort FROM turns WHERE thread_id = ? AND status = 'running'",
    ).get(threadId) as unknown as Pick<TurnRow, "id" | "model" | "effort"> | undefined;
    const id = randomUUID();
    const messageId = randomUUID();
    const now = this.now();
    const status = active === undefined ? "queued" : "offered";
    const parts: WebMessagePart[] = [
      liveInputTelemetry(status === "offered" ? "pending" : "queued"),
      { type: "text", text },
    ];
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 'complete')
      `).run(messageId, threadId, active?.id ?? null, JSON.stringify(parts), now, now);
      this.database.prepare(`
        INSERT INTO live_inputs (
          id, thread_id, message_id, active_turn_id, text, model, effort, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        threadId,
        messageId,
        active?.id ?? null,
        text,
        active?.model ?? null,
        active?.effort ?? null,
        status,
        now,
        now,
      );
      const title = deriveAutomaticTitle(text, []);
      this.database.prepare(`
        UPDATE threads
        SET title = CASE WHEN title_manual = 0 AND title = 'New conversation' THEN ? ELSE title END,
            updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(title, now, threadId);
      this.recordThreadRevision(threadId, "live_input_received", now);
      this.setSetting("current_thread_id", threadId);
    });
    const stored = this.requireLiveInput(id);
    return {
      input: mapLiveInput(stored),
      message: this.requireMessage(messageId),
      thread: this.requireThread(threadId),
      offered: status === "offered",
    };
  }

  markLiveInputApplied(id: string): WebMessage | undefined {
    const row = this.getLiveInput(id);
    if (row === undefined) return undefined;
    const message = this.requireMessage(row.message_id);
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("UPDATE messages SET parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(withLiveInputStatus(message.parts, "applied")), now, row.message_id);
      this.database.prepare("DELETE FROM live_inputs WHERE id = ?").run(id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.thread_id);
      this.recordThreadRevision(row.thread_id, "live_input_applied", now);
    });
    return this.requireMessage(row.message_id);
  }

  queueLiveInput(id: string): WebMessage | undefined {
    const row = this.getLiveInput(id);
    if (row === undefined) return undefined;
    const message = this.requireMessage(row.message_id);
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE live_inputs SET status = 'queued', active_turn_id = NULL, updated_at = ? WHERE id = ?
      `).run(now, id);
      this.database.prepare("UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(withLiveInputStatus(message.parts, "queued")), now, row.message_id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.thread_id);
      this.recordThreadRevision(row.thread_id, "live_input_queued", now);
    });
    return this.requireMessage(row.message_id);
  }

  cancelLiveInput(id: string): WebMessage | undefined {
    const row = this.getLiveInput(id);
    if (row === undefined) return undefined;
    const message = this.requireMessage(row.message_id);
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(withLiveInputStatus(message.parts, "cancelled")), now, row.message_id);
      this.database.prepare("DELETE FROM live_inputs WHERE id = ?").run(id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.thread_id);
      this.recordThreadRevision(row.thread_id, "live_input_cancelled", now);
    });
    return this.requireMessage(row.message_id);
  }

  cancelLiveInputs(threadId: string): WebMessage[] {
    const rows = this.database.prepare(
      "SELECT * FROM live_inputs WHERE thread_id = ? ORDER BY created_at, rowid",
    ).all(threadId) as unknown as LiveInputRow[];
    if (rows.length === 0) return [];
    const now = this.now();
    this.transaction(() => {
      const update = this.database.prepare(
        "UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        const message = this.requireMessage(row.message_id);
        update.run(JSON.stringify(withLiveInputStatus(message.parts, "cancelled")), now, row.message_id);
      }
      this.database.prepare("DELETE FROM live_inputs WHERE thread_id = ?").run(threadId);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, threadId);
      this.recordThreadRevision(threadId, "live_inputs_cancelled", now);
    });
    return rows.map((row) => this.requireMessage(row.message_id));
  }

  queuedLiveInputThreadIds(): string[] {
    return (this.database.prepare(`
      SELECT thread_id FROM live_inputs WHERE status = 'queued'
      GROUP BY thread_id ORDER BY MIN(created_at), thread_id
    `).all() as unknown as Array<{ thread_id: string }>).map((row) => row.thread_id);
  }

  promoteNextQueuedLiveInput(threadId: string): BeginStoredTurnResult | undefined {
    const active = this.database.prepare(
      "SELECT id FROM turns WHERE thread_id = ? AND status = 'running'",
    ).get(threadId);
    if (active !== undefined) return undefined;
    const row = this.database.prepare(`
      SELECT * FROM live_inputs
      WHERE thread_id = ? AND status = 'queued'
      ORDER BY created_at, rowid LIMIT 1
    `).get(threadId) as unknown as LiveInputRow | undefined;
    if (row === undefined) return undefined;
    const thread = this.requireThread(threadId);
    if (!thread.canSend || thread.archivedAt !== null) return undefined;
    const turnId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = this.now();
    const userMessage = this.requireMessage(row.message_id);
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO turns (
          id, thread_id, status, text, model, effort, assistant_message_id,
          started_at, finished_at, error_code, error_message
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(turnId, threadId, row.text, row.model, row.effort, assistantMessageId, now);
      this.database.prepare("UPDATE messages SET turn_id = ?, parts_json = ?, updated_at = ? WHERE id = ?")
        .run(turnId, JSON.stringify(withoutLiveInputTelemetry(userMessage.parts)), now, row.message_id);
      this.database.prepare(`
        INSERT INTO messages (id, thread_id, turn_id, role, parts_json, created_at, updated_at, status)
        VALUES (?, ?, ?, 'assistant', '[]', ?, ?, 'running')
      `).run(assistantMessageId, threadId, turnId, now, now);
      this.database.prepare("DELETE FROM live_inputs WHERE id = ?").run(row.id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, threadId);
      this.recordThreadRevision(threadId, "turn_started", now);
    });
    return {
      turnId,
      conversationId: `web:${threadId}`,
      text: row.text,
      userMessageId: row.message_id,
      assistantMessageId,
      attachments: [],
      thread: this.requireThread(threadId),
    };
  }

  applyStreamFrame(turnId: string, frame: AgentStreamWireFrame): WebMessage {
    return this.applyStreamFrames(turnId, [frame]);
  }

  applyStreamFrames(turnId: string, frames: readonly AgentStreamWireFrame[]): WebMessage {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "running") return this.requireMessage(turn.assistant_message_id);
    const message = this.requireMessage(turn.assistant_message_id);
    const parts = [...message.parts];
    let actualModel: string | undefined;
    let actualEffort: string | undefined;
    for (const frame of frames) {
      if (frame.kind === "status") {
        parts.push({ type: "telemetry", event: "status", data: { text: frame.text } });
      } else if (frame.kind === "append") {
        appendTextPart(parts, "text", frame.delta);
      } else if (frame.kind === "replace") {
        replaceWholeText(parts, frame.text);
      } else if (frame.kind === "event") {
        applyEvent(parts, frame.event);
        if (frame.event.type === "runtime_telemetry" && frame.event.kind === "run_config") {
          if (typeof frame.event.data?.model === "string") actualModel = frame.event.data.model;
          if (typeof frame.event.data?.effort === "string") actualEffort = frame.event.data.effort;
        }
      }
    }
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("UPDATE messages SET parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(parts), now, message.id);
      if (actualModel !== undefined || actualEffort !== undefined) {
        this.database.prepare(`
          UPDATE turns SET
            model = CASE WHEN ? IS NULL THEN model ELSE ? END,
            effort = CASE WHEN ? IS NULL THEN effort ELSE ? END
          WHERE id = ?
        `).run(actualModel ?? null, actualModel ?? null, actualEffort ?? null, actualEffort ?? null, turnId);
      }
    });
    return this.requireMessage(message.id);
  }

  completeTurn(turnId: string, finalText?: string, metadata?: Readonly<Record<string, unknown>>): WebThreadDetail {
    const runtime = runtimeMetadata(metadata);
    return this.finishTurn(turnId, "complete", finalText, undefined, undefined, runtime);
  }

  failTurn(turnId: string, error: { readonly message: string; readonly code?: string; readonly cancelled?: boolean }): WebThreadDetail {
    return this.finishTurn(
      turnId,
      error.cancelled === true ? "cancelled" : "failed",
      undefined,
      error.code,
      error.message,
      undefined,
    );
  }

  interruptTurn(turnId: string, message = "The web service stopped before this turn completed."): WebThreadDetail {
    return this.finishTurn(turnId, "interrupted", undefined, "interrupted", message, undefined);
  }

  activeTurn(threadId: string): { readonly id: string; readonly conversationId: string } | undefined {
    const row = this.database.prepare("SELECT id FROM turns WHERE thread_id = ? AND status = 'running'").get(threadId) as unknown as { id: string } | undefined;
    return row === undefined ? undefined : { id: row.id, conversationId: `web:${threadId}` };
  }

  listActiveTurnIds(): string[] {
    const rows = this.database.prepare("SELECT id FROM turns WHERE status = 'running'").all() as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  threadIdForTurn(turnId: string): string | undefined {
    const row = this.database.prepare("SELECT thread_id FROM turns WHERE id = ?").get(turnId) as unknown as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  private initialize(): void {
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      const versionRow = this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
      if (versionRow.user_version > 3) {
        throw new WebConsoleError(
          "unsupported_storage_schema",
          `Web state schema ${versionRow.user_version} is newer than supported schema 3.`,
          500,
        );
      }
      if (versionRow.user_version < 0) {
        throw new WebConsoleError("storage_corrupt", "Web state schema version is invalid.", 500);
      }
      const migrating = versionRow.user_version < 3;
      if (migrating) this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        health TEXT,
        supports_attachments INTEGER NOT NULL DEFAULT 0,
        models_json TEXT,
        default_model TEXT,
        default_effort TEXT,
        efforts_json TEXT,
        model_options_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        conversation_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        title_manual INTEGER NOT NULL DEFAULT 0,
        trigger_kind TEXT CHECK (trigger_kind IN ('cron', 'webhook')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        assistant_message_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_per_thread
        ON turns(thread_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_by_thread ON messages(thread_id, created_at);
      CREATE TABLE IF NOT EXISTS live_inputs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        active_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        text TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL CHECK (status IN ('offered', 'queued')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS live_inputs_by_thread
        ON live_inputs(thread_id, status, created_at);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0,
        storage_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(message_id, created_at);
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revisions_by_entity ON revisions(entity_kind, entity_id, revision);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        source_id TEXT NOT NULL REFERENCES agents(source_id),
        delivery_key TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'webhook')),
        payload_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (source_id, delivery_key)
      );
      `);
        if (versionRow.user_version === 1) {
          const columns = this.database.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>;
          if (!columns.some((column) => column.name === "trigger_kind")) {
            this.database.exec(
              "ALTER TABLE threads ADD COLUMN trigger_kind TEXT CHECK (trigger_kind IN ('cron', 'webhook'))",
            );
          }
        }
        if (migrating) this.database.exec("PRAGMA user_version = 3; COMMIT");
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        throw error;
      }
      this.validateStorage();
    } catch (error) {
      if (error instanceof WebConsoleError) throw error;
      throw new WebConsoleError("storage_corrupt", `Unable to initialize web state: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  private validateStorage(): void {
    const check = this.database.prepare("PRAGMA quick_check(1)").get() as unknown as Record<string, unknown> | undefined;
    if (check === undefined || !Object.values(check).includes("ok")) {
      throw new WebConsoleError("storage_corrupt", "Web state failed SQLite integrity validation.", 500);
    }
    const requiredTables = new Set([
      "agents",
      "threads",
      "turns",
      "messages",
      "live_inputs",
      "attachments",
      "revisions",
      "settings",
      "notification_deliveries",
    ]);
    const tables = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>;
    for (const table of tables) requiredTables.delete(table.name);
    if (requiredTables.size > 0) {
      throw new WebConsoleError("storage_corrupt", `Web state is missing tables: ${[...requiredTables].join(", ")}.`, 500);
    }
    const messages = this.database.prepare("SELECT id, parts_json FROM messages").all() as unknown as Array<{ id: string; parts_json: string }>;
    for (const message of messages) {
      try {
        parseParts(message.parts_json);
      } catch {
        throw new WebConsoleError("storage_corrupt", `Message ${message.id} contains invalid persisted parts.`, 500);
      }
    }
  }

  private recoverInterruptedTurns(): void {
    const active = this.listActiveTurnIds();
    for (const turnId of active) {
      this.interruptTurn(turnId, "The web service restarted before this turn completed.");
    }
  }

  private recoverLiveInputs(): void {
    const rows = this.database.prepare(
      "SELECT * FROM live_inputs WHERE status = 'offered' ORDER BY created_at, rowid",
    ).all() as unknown as LiveInputRow[];
    if (rows.length === 0) return;
    const now = this.now();
    const threadIds = new Set(rows.map((row) => row.thread_id));
    this.transaction(() => {
      const updateInput = this.database.prepare(`
        UPDATE live_inputs SET status = 'queued', active_turn_id = NULL, updated_at = ? WHERE id = ?
      `);
      const updateMessage = this.database.prepare(
        "UPDATE messages SET turn_id = NULL, parts_json = ?, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        const persisted = this.database.prepare("SELECT parts_json FROM messages WHERE id = ?")
          .get(row.message_id) as unknown as { parts_json: string } | undefined;
        if (persisted === undefined) {
          throw new WebConsoleError("storage_corrupt", `Live input ${row.id} has no message.`, 500);
        }
        updateInput.run(now, row.id);
        updateMessage.run(
          JSON.stringify(withLiveInputStatus(parseParts(persisted.parts_json), "queued")),
          now,
          row.message_id,
        );
      }
      for (const threadId of threadIds) {
        this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(now, threadId);
        this.recordThreadRevision(threadId, "live_inputs_recovered", now);
      }
    });
  }

  private finishTurn(
    turnId: string,
    status: Exclude<WebMessageStatus, "running">,
    finalText?: string,
    errorCode?: string,
    errorMessage?: string,
    runtime?: { readonly model?: string; readonly effort?: string },
  ): WebThreadDetail {
    const turn = this.requireTurn(turnId);
    const existing = this.requireMessage(turn.assistant_message_id);
    if (turn.status !== "running") {
      return this.requireThreadDetail(turn.thread_id);
    }
    const parts = [...existing.parts];
    if (finalText !== undefined && finalText.length > 0) reconcileFinalText(parts, finalText);
    if (errorMessage !== undefined) {
      parts.push({ type: "error", ...(errorCode === undefined ? {} : { code: errorCode }), message: errorMessage });
    }
    const now = this.now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE turns SET status = ?, finished_at = ?, error_code = ?, error_message = ?,
          model = CASE WHEN ? IS NULL THEN model ELSE ? END,
          effort = CASE WHEN ? IS NULL THEN effort ELSE ? END
        WHERE id = ?
      `).run(
        status,
        now,
        errorCode ?? null,
        errorMessage ?? null,
        runtime?.model ?? null,
        runtime?.model ?? null,
        runtime?.effort ?? null,
        runtime?.effort ?? null,
        turnId,
      );
      this.database.prepare("UPDATE messages SET parts_json = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(parts), status, now, existing.id);
      this.database.prepare("UPDATE threads SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, turn.thread_id);
      this.recordThreadRevision(turn.thread_id, `turn_${status}`, now);
    });
    return this.requireThreadDetail(turn.thread_id);
  }

  private mapThread(row: ThreadRow): WebThread {
    const runState = this.latestRunState(row.id);
    const preview = this.lastMessagePreview(row.id);
    return {
      id: row.id,
      sourceId: row.source_id,
      title: row.title,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      ...(row.trigger_kind === "cron" || row.trigger_kind === "webhook"
        ? { trigger: { kind: row.trigger_kind } }
        : {}),
      ...(preview === undefined ? {} : { lastMessagePreview: preview }),
      messageCount: row.message_count,
      runState,
      canSend: row.can_send === 1,
      canUpload: row.can_upload === 1,
    };
  }

  private mapMessage(row: MessageRow): WebMessage {
    const attachments = this.database.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id")
      .all(row.id) as unknown as AttachmentRow[];
    const storedParts = parseParts(row.parts_json);
    const quote = quoteFromParts(storedParts);
    const liveInputStatus = liveInputStatusFromParts(storedParts);
    return {
      id: row.id,
      threadId: row.thread_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      role: normalizeRole(row.role),
      ...(quote === undefined ? {} : { quote }),
      parts: storedParts.filter(
        (part) => part.type !== "telemetry"
          || (part.event !== QUOTE_TELEMETRY_EVENT && part.event !== LIVE_INPUT_TELEMETRY_EVENT),
      ),
      attachments: attachments.map((attachment) => toWebAttachment(mapStoredAttachment(attachment))),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: normalizeMessageStatus(row.status),
      ...(liveInputStatus === undefined ? {} : { liveInputStatus }),
    };
  }

  private latestRunState(threadId: string): WebRunState {
    const row = this.database.prepare("SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as unknown as TurnRow | undefined;
    if (row === undefined) return { status: "idle" };
    const status = normalizeRunStatus(row.status);
    return {
      id: row.id,
      status,
      startedAt: row.started_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.error_message === null
        ? {}
        : { error: { ...(row.error_code === null ? {} : { code: row.error_code }), message: row.error_message } }),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.effort === null ? {} : { effort: row.effort }),
    };
  }

  private lastMessagePreview(threadId: string): string | undefined {
    const row = this.database.prepare("SELECT parts_json FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as unknown as { parts_json: string } | undefined;
    if (row === undefined) return undefined;
    const text = parseParts(row.parts_json)
      .filter((part): part is Extract<WebMessagePart, { type: "text" | "reasoning" }> => part.type === "text" || part.type === "reasoning")
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    return text.length === 0 ? undefined : text.slice(0, 160);
  }

  private requireThread(id: string): WebThread {
    const thread = this.getThread(id);
    if (thread === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return thread;
  }

  private requireThreadDetail(id: string): WebThreadDetail {
    const detail = this.getThreadDetail(id);
    if (detail === undefined) throw new WebConsoleError("thread_not_found", "Conversation not found.", 404);
    return detail;
  }

  private requireTurn(id: string): TurnRow {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRow | undefined;
    if (row === undefined) throw new WebConsoleError("turn_not_found", "Turn not found.", 404);
    return row;
  }

  private requireMessage(id: string): WebMessage {
    const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow | undefined;
    if (row === undefined) throw new WebConsoleError("message_not_found", "Message not found.", 404);
    return this.mapMessage(row);
  }

  private getLiveInput(id: string): LiveInputRow | undefined {
    return this.database.prepare("SELECT * FROM live_inputs WHERE id = ?")
      .get(id) as unknown as LiveInputRow | undefined;
  }

  private requireLiveInput(id: string): LiveInputRow {
    const row = this.getLiveInput(id);
    if (row === undefined) throw new WebConsoleError("live_input_not_found", "Live input not found.", 404);
    return row;
  }

  private requireStoredAttachment(id: string): StoredAttachment {
    const attachment = this.getStoredAttachment(id);
    if (attachment === undefined) throw new WebConsoleError("attachment_not_found", "Attachment not found.", 404);
    return attachment;
  }

  private recordThreadRevision(threadId: string, event: string, now: string): void {
    const row = this.database.prepare("SELECT revision FROM threads WHERE id = ?").get(threadId) as unknown as { revision: number };
    this.database.prepare("INSERT INTO revisions (entity_kind, entity_id, revision, event, created_at) VALUES ('thread', ?, ?, ?, ?)")
      .run(threadId, row.revision, event, now);
  }

  private setSetting(key: string, value: string): void {
    this.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function threadSelectSql(suffix: string): string {
  return `
    SELECT t.id, t.source_id, t.title, t.trigger_kind, t.archived_at, t.created_at, t.updated_at, t.revision,
           CASE WHEN a.status = 'online' OR a.status = 'degraded' THEN 1 ELSE 0 END AS can_send,
           CASE WHEN (a.status = 'online' OR a.status = 'degraded') AND a.supports_attachments = 1 THEN 1 ELSE 0 END AS can_upload,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
    FROM threads t JOIN agents a ON a.source_id = t.source_id
    ${suffix}
  `;
}

function agentSelectSql(suffix: string): string {
  return `
    SELECT a.*,
           CASE WHEN EXISTS (
             SELECT 1 FROM settings s
             WHERE s.key = 'agent_pin:' || a.source_id AND s.value = '1'
           ) THEN 1 ELSE 0 END AS pinned
    FROM agents a
    ${suffix}
  `;
}

function agentPinSettingKey(sourceId: string): string {
  return `agent_pin:${sourceId}`;
}

function notificationThreadId(sourceId: string, deliveryKey: string): string {
  const digest = createHash("sha256")
    .update(sourceId)
    .update("\0")
    .update(deliveryKey)
    .digest("hex")
    .slice(0, 32);
  return `notification-${digest}`;
}

function notificationPayloadSha256(kind: WebNotificationTriggerKind, text: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(text)
    .digest("hex");
}

function mapAgent(row: AgentRow): WebAgentSummary {
  const models = parseStringArray(row.models_json);
  const efforts = parseStringArray(row.efforts_json);
  const modelOptions = parseRecord(row.model_options_json);
  return {
    sourceId: row.source_id,
    label: row.label,
    status: row.status === "online" || row.status === "degraded" ? row.status : "offline",
    pinned: row.pinned === 1,
    ...(row.health === null ? {} : { health: row.health }),
    supportsAttachments: row.supports_attachments === 1,
    ...(models === undefined ? {} : { models }),
    ...(row.default_model === null ? {} : { defaultModel: row.default_model }),
    ...(row.default_effort === null ? {} : { defaultEffort: row.default_effort }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(modelOptions === undefined ? {} : { modelOptions }),
    updatedAt: row.updated_at,
  };
}

function mapStoredAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    kind: row.kind === "image" ? "image" : "document",
    status: row.status === "committed" ? "committed" : "staged",
    uploaded: row.uploaded === 1,
    storageName: row.storage_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLiveInput(row: LiveInputRow): StoredLiveInput {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toWebAttachment(attachment: StoredAttachment): WebAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    status: attachment.status,
    uploaded: attachment.uploaded,
    createdAt: attachment.createdAt,
    ...(attachment.uploaded ? { contentUrl: `/api/v1/uploads/${encodeURIComponent(attachment.id)}/content` } : {}),
  };
}

function applyEvent(parts: WebMessagePart[], event: AgentStreamEvent): void {
  if (event.type === "assistant_thought") {
    appendTextPart(parts, "reasoning", event.text);
    return;
  }
  if (event.type === "tool_call_started") {
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name,
      ...(event.arguments === undefined ? {} : { args: event.arguments }),
      status: "running",
    });
    return;
  }
  if (event.type === "tool_call_progress") {
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name ?? existingToolName(parts, event.id) ?? "Tool",
      ...(event.partialResult === undefined ? {} : { result: event.partialResult }),
      status: "running",
    });
    return;
  }
  if (event.type === "tool_call_completed") {
    upsertToolCall(parts, {
      type: "tool-call",
      toolCallId: event.id,
      toolName: event.name ?? existingToolName(parts, event.id) ?? "Tool",
      ...(event.arguments === undefined ? {} : { args: event.arguments }),
      ...(event.content === undefined ? {} : { result: event.content }),
      status: event.isError === true ? "failed" : "complete",
    });
    return;
  }
  if (event.type === "runtime_telemetry" && event.kind === "context_compaction") {
    upsertContextCompaction(parts, event);
    return;
  }
  parts.push({ type: "telemetry", event: event.type, data: event });
}

function contextCompactionOperationId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "runtime_telemetry" || event.kind !== "context_compaction") return undefined;
  const data = event.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const operationId = (data as Record<string, unknown>).operationId;
  return typeof operationId === "string" && operationId.length > 0 ? operationId : undefined;
}

function upsertContextCompaction(
  parts: WebMessagePart[],
  event: Extract<AgentStreamEvent, { type: "runtime_telemetry" }>,
): void {
  const operationId = contextCompactionOperationId(event);
  const next: WebMessagePart = { type: "telemetry", event: event.type, data: event };
  if (operationId === undefined) {
    parts.push(next);
    return;
  }
  const index = parts.findIndex(
    (part) => part.type === "telemetry" && contextCompactionOperationId(part.data) === operationId,
  );
  if (index < 0) parts.push(next);
  else parts[index] = next;
}

function existingToolName(parts: readonly WebMessagePart[], id: string): string | undefined {
  const existing = parts.find((part) => part.type === "tool-call" && part.toolCallId === id);
  return existing?.type === "tool-call" ? existing.toolName : undefined;
}

function upsertToolCall(parts: WebMessagePart[], next: Extract<WebMessagePart, { type: "tool-call" }>): void {
  const index = parts.findIndex((part) => part.type === "tool-call" && part.toolCallId === next.toolCallId);
  if (index < 0) {
    parts.push(next);
    return;
  }
  const previous = parts[index];
  if (previous?.type === "tool-call") parts[index] = { ...previous, ...next };
}

function appendTextPart(parts: WebMessagePart[], type: "text" | "reasoning", delta: string): void {
  const last = parts.at(-1);
  if (last?.type === type) {
    parts[parts.length - 1] = { type, text: `${last.text}${delta}` };
    return;
  }
  parts.push({ type, text: delta });
}

function reconcileFinalText(parts: WebMessagePart[], finalText: string): void {
  const textIndexes = parts
    .map((part, index) => part.type === "text" ? index : -1)
    .filter((index) => index >= 0);
  if (textIndexes.length === 0) {
    parts.push({ type: "text", text: finalText });
    return;
  }
  const streamed = textIndexes.map((index) => {
    const part = parts[index];
    return part?.type === "text" ? part.text : "";
  }).join("");
  if (streamed === finalText) return;
  let offset = 0;
  for (let position = 0; position < textIndexes.length; position += 1) {
    const index = textIndexes[position] as number;
    const previous = parts[index];
    const finalSegment = position === textIndexes.length - 1
      ? finalText.slice(offset)
      : finalText.slice(offset, offset + (previous?.type === "text" ? previous.text.length : 0));
    parts[index] = { type: "text", text: finalSegment };
    offset += finalSegment.length;
  }
}

/** Replace the whole assistant text while retaining non-text transcript parts. */
function replaceWholeText(parts: WebMessagePart[], text: string): void {
  let lastTextIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") {
      lastTextIndex = index;
      break;
    }
  }
  if (lastTextIndex < 0) {
    parts.push({ type: "text", text });
    return;
  }
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type !== "text") continue;
    if (index === lastTextIndex) parts[index] = { type: "text", text };
    else parts.splice(index, 1);
  }
}

function deriveAutomaticTitle(text: string, attachments: readonly StoredAttachment[]): string {
  const candidate = text.trim().length > 0 ? text : attachments[0]?.name ?? "New conversation";
  return normalizeTitle(candidate.replace(/\s+/gu, " ").slice(0, 80));
}

function normalizeTitle(value: string): string {
  const title = value.trim().replace(/\s+/gu, " ").slice(0, 120);
  if (title.length === 0) throw new WebConsoleError("invalid_title", "A conversation title cannot be empty.", 400);
  return title;
}

function parseParts(value: string): WebMessagePart[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new WebConsoleError("storage_corrupt", "Persisted message parts are not valid JSON.", 500);
  }
  if (!Array.isArray(parsed) || !parsed.every(isWebMessagePart)) {
    throw new WebConsoleError("storage_corrupt", "Persisted message parts have an invalid shape.", 500);
  }
  quoteFromParts(parsed);
  return parsed;
}

const QUOTE_TELEMETRY_EVENT = "quote";
const LIVE_INPUT_TELEMETRY_EVENT = "live_input";

type WebLiveInputStatus = NonNullable<WebMessage["liveInputStatus"]>;

function liveInputTelemetry(status: WebLiveInputStatus): WebMessagePart {
  return { type: "telemetry", event: LIVE_INPUT_TELEMETRY_EVENT, data: { status } };
}

function withoutLiveInputTelemetry(parts: readonly WebMessagePart[]): WebMessagePart[] {
  return parts.filter(
    (part) => part.type !== "telemetry" || part.event !== LIVE_INPUT_TELEMETRY_EVENT,
  );
}

function withLiveInputStatus(
  parts: readonly WebMessagePart[],
  status: WebLiveInputStatus,
): WebMessagePart[] {
  return [liveInputTelemetry(status), ...withoutLiveInputTelemetry(parts)];
}

function liveInputStatusFromParts(parts: readonly WebMessagePart[]): WebLiveInputStatus | undefined {
  const markers = parts.filter(
    (part): part is Extract<WebMessagePart, { type: "telemetry" }> =>
      part.type === "telemetry" && part.event === LIVE_INPUT_TELEMETRY_EVENT,
  );
  if (markers.length === 0) return undefined;
  if (markers.length !== 1) {
    throw new WebConsoleError("storage_corrupt", "Persisted live-input metadata is duplicated.", 500);
  }
  const data = markers[0]?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new WebConsoleError("storage_corrupt", "Persisted live-input metadata is invalid.", 500);
  }
  const status = (data as Record<string, unknown>).status;
  if (status !== "pending" && status !== "applied" && status !== "queued" && status !== "cancelled") {
    throw new WebConsoleError("storage_corrupt", "Persisted live-input status is invalid.", 500);
  }
  return status;
}

function quoteFromParts(parts: readonly WebMessagePart[]): WebQuote | undefined {
  const markers = parts.filter(
    (part): part is Extract<WebMessagePart, { type: "telemetry" }> =>
      part.type === "telemetry" && part.event === QUOTE_TELEMETRY_EVENT,
  );
  if (markers.length === 0) return undefined;
  if (markers.length !== 1) {
    throw new WebConsoleError("storage_corrupt", "Persisted message quote metadata is duplicated.", 500);
  }
  const data = markers[0]?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new WebConsoleError("storage_corrupt", "Persisted message quote metadata has an invalid shape.", 500);
  }
  const quote = data as Record<string, unknown>;
  if (
    typeof quote.text !== "string" || quote.text.trim().length === 0 ||
    typeof quote.messageId !== "string" || quote.messageId.trim().length === 0
  ) {
    throw new WebConsoleError("storage_corrupt", "Persisted message quote metadata has an invalid shape.", 500);
  }
  return { text: quote.text, messageId: quote.messageId };
}

function isWebMessagePart(value: unknown): value is WebMessagePart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text" || part.type === "reasoning") return typeof part.text === "string";
  if (part.type === "tool-call") {
    return typeof part.toolCallId === "string"
      && typeof part.toolName === "string"
      && (part.status === "running" || part.status === "complete" || part.status === "failed");
  }
  if (part.type === "telemetry") return typeof part.event === "string";
  if (part.type === "error") return typeof part.message === "string" && (part.code === undefined || typeof part.code === "string");
  return false;
}

function parseStringArray(value: string | null): readonly string[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseRecord(value: string | null): WebAgentSummary["modelOptions"] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as NonNullable<WebAgentSummary["modelOptions"]>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeRole(value: string): WebMessage["role"] {
  return value === "assistant" || value === "system" ? value : "user";
}

function normalizeMessageStatus(value: string): WebMessageStatus {
  return value === "running" || value === "failed" || value === "cancelled" || value === "interrupted"
    ? value
    : "complete";
}

function normalizeRunStatus(value: string): WebRunState["status"] {
  return value === "running" || value === "failed" || value === "cancelled" || value === "interrupted"
    ? value
    : "complete";
}

function runtimeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): { readonly model?: string; readonly effort?: string } | undefined {
  const runtime = metadata?.runtime;
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) return undefined;
  const record = runtime as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model : undefined;
  const effort = typeof record.effort === "string" ? record.effort : undefined;
  return model === undefined && effort === undefined ? undefined : {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
