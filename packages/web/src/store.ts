import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseAskSnapshot, parseTurnRequest, type OperatorMessage } from "@mono-agent/operator";

import type { StartWebTurnInput, StoredWebState, WebMessage, WebThread } from "./contracts.js";
import { WebProductError } from "./errors.js";

const STATE_FILE = "state.json";
const MARKER_FILE = ".mono-agent-web-state";
const LEASE_FILE = "lease.sqlite";
const MARKER_CONTENT = '{"kind":"mono-agent-web-state","schemaVersion":1}\n';
const EMPTY_STATE: StoredWebState = Object.freeze({ schemaVersion: 1, threads: [], messages: [] });

export interface DurableWebStoreOptions {
  readonly clock?: () => Date;
  /** Deterministic durability-fault seam used by focused crash-safety tests. */
  readonly afterStateRename?: () => void | Promise<void>;
}

class StateCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super("State rename completed but directory durability could not be proven.", { cause });
    this.name = "StateCommitUncertainError";
  }
}

export class DurableWebStore {
  readonly directory: string;
  readonly statePath: string;
  private state: StoredWebState;
  private readonly clock: () => Date;
  private readonly lease: DatabaseSync;
  private readonly afterStateRename: (() => void | Promise<void>) | undefined;
  private operation = Promise.resolve();
  private closed = false;
  private poisoned: WebProductError | undefined;

  private constructor(
    directory: string,
    state: StoredWebState,
    lease: DatabaseSync,
    options: DurableWebStoreOptions,
  ) {
    this.directory = directory;
    this.statePath = join(directory, STATE_FILE);
    this.lease = lease;
    this.state = state;
    this.clock = options.clock ?? (() => new Date());
    this.afterStateRename = options.afterStateRename;
  }

  static async open(directory: string, options: DurableWebStoreOptions = {}): Promise<DurableWebStore> {
    const root = resolve(directory);
    await prepareDirectory(root);
    await prepareMarker(root);
    await prepareLeaseDatabase(root);
    const lease = acquireLease(root);
    try {
      const state = await loadState(root);
      const store = new DurableWebStore(root, state, lease, options);
      await store.recoverInterruptedTurns();
      return store;
    } catch (error) {
      releaseLease(lease);
      throw error;
    }
  }

  listThreads(): readonly WebThread[] {
    this.assertReadable();
    return clone(this.state.threads.filter((thread) => thread.deletedAt === undefined));
  }

  getThread(id: string): WebThread | undefined {
    this.assertReadable();
    const thread = this.state.threads.find((candidate) => candidate.id === id && candidate.deletedAt === undefined);
    return thread === undefined ? undefined : clone(thread);
  }

  findThreadByOperatorConversation(agentId: string, conversationId: string): WebThread | undefined {
    this.assertReadable();
    const thread = this.state.threads.find((candidate) =>
      candidate.agentId === agentId && candidate.operatorConversationId === conversationId
    );
    return thread === undefined ? undefined : clone(thread);
  }

  getThreadDetail(id: string): { readonly thread: WebThread; readonly messages: readonly WebMessage[] } | undefined {
    const thread = this.getThread(id);
    if (thread === undefined) return undefined;
    return {
      thread,
      messages: clone(this.state.messages.filter((message) => message.threadId === id)),
    };
  }

  createThread(agentId: string, title = "New conversation"): Promise<WebThread> {
    return this.mutate((draft) => {
      const now = this.clock().toISOString();
      const id = randomUUID();
      const thread: WebThread = {
        id,
        agentId,
        operatorConversationId: `web:${id}`,
        title: cleanTitle(title),
        createdAt: now,
        updatedAt: now,
        status: "idle",
      };
      draft.threads.push(thread);
      return thread;
    });
  }

  importProactiveConversation(input: {
    readonly agentId: string;
    readonly conversationId: string;
    readonly title?: string;
    readonly updatedAt: string;
    readonly messages: readonly OperatorMessage[];
  }): Promise<{ readonly thread: WebThread; readonly created: boolean }> {
    return this.mutate((draft) => {
      const existing = draft.threads.find((thread) =>
        thread.agentId === input.agentId && thread.operatorConversationId === input.conversationId
      );
      if (existing !== undefined) return { thread: existing, created: false };
      const id = randomUUID();
      const thread: WebThread = {
        id,
        agentId: input.agentId,
        operatorConversationId: input.conversationId,
        proactive: true,
        title: cleanTitle(input.title ?? input.messages.find((message) => message.text.trim().length > 0)?.text ?? "Proactive update"),
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        status: "complete",
      };
      draft.threads.push(thread);
      input.messages.forEach((message, index) => {
        draft.messages.push({
          id: `proactive:${id}:${message.id ?? String(index)}`,
          ...(message.id === undefined ? {} : { operatorMessageId: message.id }),
          threadId: id,
          role: message.role,
          text: message.text,
          ...(message.attachments === undefined ? {} : { attachments: stripAttachmentData(message.attachments) }),
          createdAt: message.createdAt ?? input.updatedAt,
          updatedAt: message.createdAt ?? input.updatedAt,
          status: "complete",
        });
      });
      return { thread, created: true };
    });
  }

  startTurn(threadId: string, input: StartWebTurnInput | string): Promise<{ readonly thread: WebThread; readonly user: WebMessage; readonly assistant: WebMessage }> {
    return this.mutate((draft) => {
      const turnInput: StartWebTurnInput = typeof input === "string" ? { text: input } : input;
      const thread = requiredThread(draft, threadId);
      if (thread.status === "running") throw new WebProductError("turn_active", "This conversation already has an active turn.", 409);
      const now = this.clock().toISOString();
      const turnId = randomUUID();
      const user: WebMessage = {
        id: randomUUID(),
        threadId,
        turnId,
        role: "user",
        text: turnInput.text,
        ...(turnInput.attachments === undefined ? {} : { attachments: stripAttachmentData(turnInput.attachments) }),
        ...(turnInput.quote === undefined ? {} : { quote: turnInput.quote }),
        createdAt: now,
        updatedAt: now,
        status: "complete",
      };
      const assistant: WebMessage = {
        id: randomUUID(), threadId, turnId, role: "assistant", text: "", createdAt: now, updatedAt: now, status: "running",
      };
      Object.assign(thread, { status: "running", activeTurnId: turnId, updatedAt: now });
      delete (thread as { pendingAsk?: unknown }).pendingAsk;
      draft.messages.push(user, assistant);
      return { thread, user, assistant };
    });
  }

  updateAssistant(
    threadId: string,
    turnId: string,
    text: string,
    pendingAsk?: WebThread["pendingAsk"],
    operatorMessageId?: string,
  ): Promise<WebMessage> {
    return this.mutate((draft) => {
      const thread = requiredThread(draft, threadId);
      const message = requiredAssistant(draft, threadId, turnId);
      if (message.status !== "running") throw new WebProductError("turn_not_active", "The turn is no longer active.", 409);
      const updatedAt = this.clock().toISOString();
      Object.assign(message, { text, updatedAt });
      if (operatorMessageId !== undefined) Object.assign(message, { operatorMessageId });
      Object.assign(thread, { updatedAt });
      delete (thread as { pendingAsk?: unknown }).pendingAsk;
      if (pendingAsk !== undefined) Object.assign(thread, { pendingAsk });
      return message;
    });
  }

  clearPendingAsk(threadId: string): Promise<WebThread> {
    return this.mutate((draft) => {
      const thread = requiredThread(draft, threadId);
      delete (thread as { pendingAsk?: unknown }).pendingAsk;
      Object.assign(thread, { updatedAt: this.clock().toISOString() });
      return thread;
    });
  }

  finishTurn(
    threadId: string,
    turnId: string,
    status: "complete" | "failed" | "cancelled" | "interrupted",
    error?: { readonly code: string; readonly message: string },
  ): Promise<WebMessage> {
    return this.mutate((draft) => {
      const thread = requiredThread(draft, threadId);
      const message = requiredAssistant(draft, threadId, turnId);
      const now = this.clock().toISOString();
      Object.assign(message, { status, updatedAt: now, ...(error === undefined ? {} : { error }) });
      delete (thread as { activeTurnId?: string }).activeTurnId;
      delete (thread as { pendingAsk?: unknown }).pendingAsk;
      Object.assign(thread, { status, updatedAt: now });
      return message;
    });
  }

  deleteThread(threadId: string): Promise<void> {
    return this.mutate((draft) => {
      const index = draft.threads.findIndex((thread) => thread.id === threadId);
      if (index < 0) throw new WebProductError("thread_not_found", "Conversation not found.", 404);
      if (draft.threads[index]!.status === "running") {
        throw new WebProductError("turn_active", "Cancel the active turn before deleting this conversation.", 409);
      }
      const thread = draft.threads[index]!;
      if (thread.proactive === true && thread.operatorConversationId !== undefined) {
        Object.assign(thread, { deletedAt: this.clock().toISOString() });
      } else {
        draft.threads.splice(index, 1);
      }
      draft.messages = draft.messages.filter((message) => message.threadId !== threadId);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.operation;
    releaseLease(this.lease);
  }

  private async recoverInterruptedTurns(): Promise<void> {
    if (!this.state.threads.some((thread) => thread.status === "running")) return;
    await this.mutate((draft) => {
      const now = this.clock().toISOString();
      for (const thread of draft.threads) {
        if (thread.status !== "running") continue;
        const turnId = thread.activeTurnId;
        Object.assign(thread, { status: "interrupted", updatedAt: now });
        delete (thread as { activeTurnId?: string }).activeTurnId;
        delete (thread as { pendingAsk?: unknown }).pendingAsk;
        if (turnId !== undefined) {
          const message = draft.messages.find((candidate) => candidate.threadId === thread.id && candidate.turnId === turnId && candidate.role === "assistant");
          if (message?.status === "running") Object.assign(message, { status: "interrupted", updatedAt: now });
        }
      }
    });
  }

  private mutate<T>(operation: (draft: MutableState) => T): Promise<T> {
    if (this.closed) return Promise.reject(new WebProductError("store_closed", "Web state is closed.", 409));
    const result = this.operation.then(async () => {
      if (this.poisoned !== undefined) throw this.poisoned;
      const draft = clone(this.state) as MutableState;
      const value = operation(draft);
      validateState(draft);
      try {
        await writeStateAtomic(this.directory, draft, this.afterStateRename);
      } catch (error) {
        if (error instanceof StateCommitUncertainError) {
          this.poisoned = new WebProductError(
            "state_store_poisoned",
            "Web state commit became uncertain after rename; close and reopen before any further access.",
            503,
          );
          throw this.poisoned;
        }
        throw error;
      }
      this.state = freezeState(draft);
      return clone(value);
    });
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertReadable(): void {
    if (this.poisoned !== undefined) throw this.poisoned;
  }
}

type MutableState = {
  schemaVersion: 1;
  threads: WebThread[];
  messages: WebMessage[];
};

async function prepareDirectory(directory: string): Promise<void> {
  const existing = await lstat(directory).catch(() => undefined);
  if (existing === undefined) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } else {
    verifyOwnedDirectory(existing, directory);
  }
  const after = await lstat(directory);
  verifyOwnedDirectory(after, directory);
}

async function prepareMarker(directory: string): Promise<void> {
  const path = join(directory, MARKER_FILE);
  const existing = await lstat(path).catch(() => undefined);
  if (existing === undefined) {
    const handle = await openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(MARKER_CONTENT, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  verifyOwnedFile(existing, path);
  if ((await readFileNoFollow(path)) !== MARKER_CONTENT) {
    throw new WebProductError("invalid_state_directory", "Web state ownership marker is invalid.", 409);
  }
}

async function prepareLeaseDatabase(directory: string): Promise<void> {
  const path = join(directory, LEASE_FILE);
  const existing = await lstat(path).catch(() => undefined);
  if (existing !== undefined) {
    verifyOwnedFile(existing, path);
    return;
  }
  const handle = await openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const database = new DatabaseSync(path, { timeout: 0 });
  try {
    database.exec("PRAGMA journal_mode = DELETE; CREATE TABLE lease_guard (id INTEGER PRIMARY KEY CHECK (id = 1));");
  } finally {
    database.close();
  }
}

function acquireLease(directory: string): DatabaseSync {
  const path = join(directory, LEASE_FILE);
  const database = new DatabaseSync(path, { timeout: 0 });
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
    return database;
  } catch {
    database.close();
    throw new WebProductError("web_already_running", "This web data directory is already in use.", 409);
  }
}

function releaseLease(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

async function loadState(directory: string): Promise<StoredWebState> {
  const path = join(directory, STATE_FILE);
  const existing = await lstat(path).catch(() => undefined);
  if (existing === undefined) {
    await writeStateAtomic(directory, EMPTY_STATE);
    return EMPTY_STATE;
  }
  verifyOwnedFile(existing, path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFileNoFollow(path)) as unknown;
  } catch {
    throw new WebProductError("state_corrupt", "Web state is corrupt; refusing to overwrite it.", 409);
  }
  validateState(raw);
  return freezeState(raw as MutableState);
}

async function writeStateAtomic(
  directory: string,
  state: StoredWebState,
  afterRename?: () => void | Promise<void>,
): Promise<void> {
  const path = join(directory, STATE_FILE);
  const temp = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
  const handle = await openNoFollow(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temp, path);
    renamed = true;
    await afterRename?.();
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (!renamed) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    throw new StateCommitUncertainError(error);
  }
}

async function readFileNoFollow(path: string): Promise<string> {
  const handle = await openNoFollow(path, constants.O_RDONLY, 0o600);
  try {
    const before = await handle.stat();
    verifyOwnedFile(before, path);
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino) throw new WebProductError("state_changed", "Web state changed while reading.", 409);
    return content;
  } finally {
    await handle.close();
  }
}

function openNoFollow(path: string, flags: number, mode: number) {
  return open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
}

function verifyOwnedDirectory(info: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WebProductError("invalid_state_directory", `${path} must be a directory, not a link.`, 409);
  verifyOwnerAndMode(info.uid, info.mode, 0o700, path);
}

function verifyOwnedFile(info: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new WebProductError("invalid_state_file", `${path} must be a single-link regular file.`, 409);
  verifyOwnerAndMode(info.uid, info.mode, 0o600, path);
}

function verifyOwnerAndMode(uid: number | bigint, mode: number | bigint, expected: number, path: string): void {
  if (typeof process.geteuid === "function" && Number(uid) !== process.geteuid()) throw new WebProductError("invalid_state_owner", `${path} is not owned by the current user.`, 409);
  if ((Number(mode) & 0o777) !== expected) throw new WebProductError("invalid_state_mode", `${path} must have mode ${expected.toString(8)}.`, 409);
}

function requiredThread(state: MutableState, id: string): WebThread {
  const thread = state.threads.find((candidate) => candidate.id === id);
  if (thread === undefined) throw new WebProductError("thread_not_found", "Conversation not found.", 404);
  return thread;
}

function requiredAssistant(state: MutableState, threadId: string, turnId: string): WebMessage {
  const message = state.messages.find((candidate) => candidate.threadId === threadId && candidate.turnId === turnId && candidate.role === "assistant");
  if (message === undefined) throw new WebProductError("turn_not_found", "Turn not found.", 404);
  return message;
}

function validateState(raw: unknown): asserts raw is StoredWebState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalidState();
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.threads) || !Array.isArray(value.messages)) invalidState();
  const fields = Object.keys(value);
  if (fields.some((field) => !["schemaVersion", "threads", "messages"].includes(field))) invalidState();
  const threadIds = new Set<string>();
  for (const thread of value.threads as unknown[]) {
    const record = recordValue(thread);
    if (!record || !isString(record.id) || !isString(record.agentId) || !isString(record.title) || !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt) || !isStatus(record.status)) invalidState();
    if (Object.keys(record).some((field) => ![
      "id", "agentId", "operatorConversationId", "proactive", "title", "createdAt",
      "updatedAt", "deletedAt", "status", "activeTurnId", "pendingAsk",
    ].includes(field))) invalidState();
    if (threadIds.has(record.id)) invalidState();
    threadIds.add(record.id);
    if (record.operatorConversationId !== undefined && !isString(record.operatorConversationId)) invalidState();
    if (record.proactive !== undefined && record.proactive !== true) invalidState();
    if (record.deletedAt !== undefined && !isTimestamp(record.deletedAt)) invalidState();
    if (record.pendingAsk !== undefined) {
      try { parseAskSnapshot({ ask: record.pendingAsk }); } catch { invalidState(); }
    }
    if (record.activeTurnId !== undefined && !isString(record.activeTurnId)) invalidState();
    if (record.status === "running" && !isString(record.activeTurnId)) invalidState();
    if (record.status !== "running" && record.activeTurnId !== undefined) invalidState();
  }
  const messageIds = new Set<string>();
  for (const message of value.messages as unknown[]) {
    const record = recordValue(message);
    if (!record || !isString(record.id) || !isString(record.threadId) || !threadIds.has(record.threadId) || (record.role !== "user" && record.role !== "assistant") || !isString(record.text) || !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt) || !isStatus(record.status) || record.status === "idle") invalidState();
    if (Object.keys(record).some((field) => ![
      "id", "operatorMessageId", "threadId", "turnId", "role", "text", "attachments", "quote",
      "createdAt", "updatedAt", "status", "error",
    ].includes(field))) invalidState();
    if (messageIds.has(record.id)) invalidState();
    messageIds.add(record.id);
    if (record.operatorMessageId !== undefined && !isString(record.operatorMessageId)) invalidState();
    if (record.turnId !== undefined && !isString(record.turnId)) invalidState();
    if (record.attachments !== undefined || record.quote !== undefined) {
      try {
        parseTurnRequest({
          conversationId: "stored-web-message",
          input: {
            text: "stored",
            ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
            ...(record.quote === undefined ? {} : { quote: record.quote }),
          },
        });
      } catch { invalidState(); }
    }
    if (record.error !== undefined) {
      const error = recordValue(record.error);
      if (!error || Object.keys(error).some((field) => !["code", "message"].includes(field)) || !isString(error.code) || !isString(error.message)) invalidState();
    }
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isTimestamp(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function isStatus(value: unknown): boolean { return ["idle", "running", "complete", "failed", "cancelled", "interrupted"].includes(String(value)); }
function invalidState(): never { throw new WebProductError("state_corrupt", "Web state is corrupt; refusing to overwrite it.", 409); }

function cleanTitle(value: string): string {
  const title = value.trim().replace(/\s+/gu, " ");
  if (title.length === 0) return "New conversation";
  return title.slice(0, 120);
}

function stripAttachmentData(
  attachments: readonly NonNullable<StartWebTurnInput["attachments"]>[number][],
): NonNullable<WebMessage["attachments"]> {
  return attachments.map(({ url: _url, ...attachment }) => attachment);
}

function freezeState(state: MutableState): StoredWebState {
  return Object.freeze({ schemaVersion: 1, threads: Object.freeze(clone(state.threads)), messages: Object.freeze(clone(state.messages)) });
}

function clone<T>(value: T): T { return structuredClone(value); }
