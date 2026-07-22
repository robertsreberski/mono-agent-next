import { createHash, randomBytes } from "node:crypto";
import { stat, readFile, unlink } from "node:fs/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isAbsolute } from "node:path";

import {
  createChannelUserCancelReason,
  isAgentResponseCancelledError,
  isChannelUserCancelReason,
  type ChannelAskSnapshot,
  type ChannelAskSubmission,
  type ChannelAskSubmissionResult,
} from "@mono-agent/agent-contracts";
import { run, type RunnerHandle, type RunOptions } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";

import {
  DEFAULT_MESSAGES,
  buildAgentRequest,
  downloadTelegramAttachments,
  finishSafely,
  mergeTelegramMessageInputs,
  normalizeTelegramMessageInput,
  resolveErrorText,
  type AgentRequest,
  type AgentResponder,
  type AgentResponse,
  type DownloadTelegramAttachmentsOptions,
  type TelegramAgentMessageInput,
  type TelegramAdapterLogger,
  type TelegramAdapterMessages,
  type TelegramAdapterStreamOptions,
  type TelegramFileDownloader,
} from "./adapter.js";
import { parseTelegramAskUserCallbackData, telegramAskUserCallbackData } from "./ask-user.js";
import { isTelegramReplyCallbackData } from "./reply-options.js";
import type { TelegramCommandConfig, TelegramReactionsConfig } from "./config.js";
import { createGrammyTelegramApi } from "./grammy-client.js";
import {
  createSecretSafeTelegramLogger,
  redactTelegramError,
  redactTelegramErrorMessage,
} from "./log-redaction.js";
import {
  TelegramMessageStream,
  type TelegramMessageStreamOptions,
} from "./message-stream.js";
import type { TelegramChatId, TelegramMessage, TelegramSendMessageParams, TelegramUpdate } from "./types.js";

type RunnerFetchOptions = NonNullable<NonNullable<RunOptions<Context>["runner"]>["fetch"]>;
type AllowedUpdates = NonNullable<RunnerFetchOptions["allowed_updates"]>;
type BotClientOptions = NonNullable<NonNullable<ConstructorParameters<typeof Bot>[1]>["client"]>;

const DEFAULT_INITIAL_STATUS_TEXT = "Thinking…";
// Quiet window after the last album message before we flush the group as one
// request. Telegram sends album parts back-to-back (sub-second), so ~1s is safe.
const DEFAULT_ALBUM_AGGREGATION_DELAY_MS = 1000;

// Lifecycle reaction emojis (when `reactions` is enabled): 👀 while the agent
// works, 👍 on success, 👎 on failure. Constrained to Telegram's allowed reaction
// set — ✅/❌ are NOT valid bot reactions, so the closest allowed emojis are used.
const REACTION_WORKING = "👀";
const REACTION_DONE = "👍";
const REACTION_ERROR = "👎";

// Bound on the in-memory set of already-answered callback keys so a long-running
// bot cannot grow it unbounded. A double-tap on an old question past this many
// distinct answered questions would simply re-run (acceptable, very rare).
const CALLBACK_DEDUPE_MAX = 200;
const RUNTIME_CALLBACK_PREFIX = "ma:";
const MODEL_CALLBACK_PREFIX = `${RUNTIME_CALLBACK_PREFIX}m:`;
const EFFORT_CALLBACK_PREFIX = `${RUNTIME_CALLBACK_PREFIX}e:`;
const RUNTIME_CANCEL_CALLBACK = `${RUNTIME_CALLBACK_PREFIX}cancel`;
const RUNTIME_CALLBACK_TOKEN_LENGTH = 16;
const TELEGRAM_BUTTON_LABEL_CODE_POINTS = 60;

interface TelegramAskPresentation {
  readonly chatId: TelegramChatId;
  readonly messageId: number;
  activeQuestionIndex: number;
  readonly selectedOptionIds: Set<string>;
}

function renderTelegramAsk(
  snapshot: ChannelAskSnapshot,
  selectedOptionIds: ReadonlySet<string>,
): {
  readonly text: string;
  readonly replyMarkup?: NonNullable<TelegramSendMessageParams["reply_markup"]>;
} {
  if (snapshot.status !== "pending") {
    const terminal = snapshot.status === "answered"
      ? "Answer recorded."
      : snapshot.status === "expired"
        ? "This question expired."
        : "This question was cancelled.";
    return { text: terminal };
  }
  const question = snapshot.questions[snapshot.activeQuestionIndex];
  if (question === undefined) return { text: "Answer recorded." };
  const lines = [
    `${question.header} · ${String(snapshot.activeQuestionIndex + 1)}/${String(snapshot.questions.length)}`,
    "",
    question.question,
    "",
    ...question.options.map((option, index) =>
      `${String(index + 1)}. ${option.label} — ${option.description}`
    ),
    "",
    question.multiSelect
      ? "Choose one or more, then tap Done. You can also type a custom reply below."
      : "Choose one option, or type a custom reply below.",
  ];
  const optionRows = question.options.map((option, optionIndex) => [{
    text: telegramButtonLabel(`${selectedOptionIds.has(option.id) ? "✓ " : ""}${option.label}`),
    callback_data: telegramAskUserCallbackData(snapshot.interactionId, snapshot.activeQuestionIndex, {
      kind: "option",
      optionIndex,
    }),
  }]);
  const finalRow = [
    {
      text: "Other",
      callback_data: telegramAskUserCallbackData(snapshot.interactionId, snapshot.activeQuestionIndex, { kind: "other" }),
    },
    ...(question.multiSelect
      ? [{
          text: "Done",
          callback_data: telegramAskUserCallbackData(snapshot.interactionId, snapshot.activeQuestionIndex, { kind: "done" }),
        }]
      : []),
  ];
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: [...optionRows, finalRow] } };
}

// grammY's Api client default `timeoutSeconds` is 500 (8m20s overall HTTP
// timeout). A half-open socket (after a network blip or host sleep) therefore
// hangs ~8 minutes before getUpdates errors. Cap the overall HTTP timeout at 50s
// so a dead long-poll is detected quickly and the auto-restart monitor can act.
const DEFAULT_API_TIMEOUT_SECONDS = 50;
// Long-poll timeout passed to the runner's getUpdates fetch (seconds). Shorter
// than the 50s client cap so a normal long-poll completes within the HTTP
// timeout; a stalled socket then fails fast instead of hanging.
const DEFAULT_LONG_POLL_TIMEOUT_SECONDS = 30;
// The runner self-retries transient getUpdates errors with exponential backoff
// for up to this window before its task rejects and the monitor takes over. Keep
// this below the 120s poll watchdog so an isolated transport timeout is absorbed
// in-place while a sustained outage still has a hard liveness bound.
const DEFAULT_RUNNER_MAX_RETRY_TIME_MS = 90_000;

// Auto-restart backoff bounds for the polling monitor (mirrors slack-adapter's
// socket-mode reconnect loop): start at 500ms, double on each consecutive
// failed restart, cap at 30s, reset to the initial delay after a clean restart.
const DEFAULT_RESTART_INITIAL_BACKOFF_MS = 500;
const DEFAULT_RESTART_MAX_BACKOFF_MS = 30_000;
// A restarted runner that stays up this long is treated as a clean restart, so
// the backoff resets to the initial delay. A runner that crashes again before
// this window keeps growing the backoff (avoids hammering a flapping connection).
const DEFAULT_RESTART_STABILITY_MS = 30_000;
// Poll-liveness watchdog: if no getUpdates call has RESOLVED within this window
// the runner is force-restarted, even though its task() never rejected. grammY's
// runner self-retries getUpdates internally, so a degraded connection can stop
// delivering updates WITHOUT the task rejecting — the crash-based auto-restart
// then never fires and the bot goes silently deaf. 120s comfortably clears the
// 30s long-poll heartbeat (DEFAULT_LONG_POLL_TIMEOUT_SECONDS) so a normal
// idle poll never trips it. Set pollWatchdogMs <= 0 to disable.
const DEFAULT_POLL_WATCHDOG_MS = 120_000;
// Cap the startup deleteWebhook call so a flaky network cannot block boot: the
// app awaits start() before reporting ready, and an unbounded deleteWebhook can
// hang ~50s (the Api client timeout), past the launcher's readiness deadline.
const DEFAULT_DELETE_WEBHOOK_TIMEOUT_MS = 5_000;

// Mirrors the harness LiveSessionManager's DEFAULT_MAX_PENDING_PER_CONVERSATION:
// the per-chat admission queue rejects past this depth so a flood of same-chat
// messages cannot grow the queue unbounded.
const DEFAULT_ADMISSION_QUEUE_MAX_DEPTH = 100;

/**
 * Thrown synchronously by {@link SerialQueue.run} when the queue is already at
 * its depth cap. The bot catches this sentinel to answer with the busy reply
 * instead of admitting an unbounded backlog.
 */
export class SerialQueueFullError extends Error {
  readonly code = "serial_queue_full" as const;

  constructor(maxDepth: number) {
    super(`Per-chat admission queue is full (max ${maxDepth} pending).`);
    this.name = "SerialQueueFullError";
  }
}

function isSerialQueueFullError(error: unknown): error is SerialQueueFullError {
  return error instanceof SerialQueueFullError;
}

/**
 * Outcome of a proactive {@link TelegramBotController.notify}: whether the nudge
 * reached the chat, plus a machine-readable reason for the silent-failure paths
 * (queue-full, cancelled, empty answer, responder/delivery failure). Structurally
 * matches the agent-app NotifyDeliveryResult so channel hooks can return it as-is.
 */
export interface TelegramNotifyResult {
  readonly delivered: boolean;
  readonly reason?: string;
}

/**
 * Options for {@link TelegramBotController.notify}. With `verbatim`, `text` is
 * posted to the chat UNCHANGED with no model call (native cron/webhook
 * notification — the producing run already wrote the message) and recorded to
 * the chat's history so a reply resumes with it in context. Without it, `text`
 * is run as a turn on the chat's harness and the agent's answer is delivered.
 */
export interface TelegramNotifyOptions {
  readonly verbatim?: boolean;
  /**
   * Post the notification silently (`disable_notification`) so it arrives without
   * a push sound. Set by the channel driver during configured quiet hours.
   */
  readonly silent?: boolean;
}

/**
 * Minimal per-conversation serial queue: each submitted task runs only after the
 * previous one settles, preserving arrival order. A task's failure does not
 * poison the queue (the chain swallows it; the caller still sees the rejection).
 *
 * The queue is bounded by {@link maxDepth}: once `depth` reaches the cap, `run`
 * rejects synchronously with a {@link SerialQueueFullError} BEFORE incrementing
 * or chaining, so an over-cap task never enters the chain (mirroring the harness
 * LiveSessionManager's maxPendingPerConversation rejection).
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private readonly maxDepth: number;

  constructor(maxDepth: number = DEFAULT_ADMISSION_QUEUE_MAX_DEPTH) {
    this.maxDepth = maxDepth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.depth >= this.maxDepth) {
      return Promise.reject(new SerialQueueFullError(this.maxDepth));
    }
    this.depth += 1;
    const result = this.tail.then(() => task());
    this.tail = result.then(() => undefined, () => undefined);
    void result.then(
      () => { this.depth -= 1; },
      () => { this.depth -= 1; },
    );
    return result;
  }

  /** True when no task is queued or running. */
  get idle(): boolean {
    return this.depth === 0;
  }

  get full(): boolean {
    return this.depth >= this.maxDepth;
  }
}

/**
 * Interceptor for blocking ask-the-user round-trips (the app's interaction
 * bridge). While an ask is pending on a conversation, the user's next plain-text
 * message RESOLVES it (consumed pre-admission, never queued as a turn) and
 * `/cancel` fails it.
 */
export interface TelegramPendingAsks {
  getPendingAsk(conversationId: string): ChannelAskSnapshot | undefined | Promise<ChannelAskSnapshot | undefined>;
  submitAskAnswers(input: ChannelAskSubmission): ChannelAskSubmissionResult | Promise<ChannelAskSubmissionResult>;
  cancel(conversationId: string): void;
}

/** One effort choice displayed by Telegram's per-chat runtime controls. */
export interface TelegramRuntimeEffortOption {
  readonly value: string;
  readonly label: string;
}

/** One configured runtime model and the effort choices it supports. */
export interface TelegramRuntimeModelOption {
  readonly value: string;
  readonly label: string;
  readonly efforts: readonly TelegramRuntimeEffortOption[];
}

/**
 * Display-ready model catalog supplied by the host. The adapter deliberately
 * does not discover models or accept arbitrary references: it only selects from
 * this configured primary/fallback list.
 */
export interface TelegramRuntimeControls {
  readonly defaultModel: string;
  readonly defaultEffort?: string;
  readonly models: readonly TelegramRuntimeModelOption[];
}

export interface CreateTelegramBotOptions {
  readonly botToken: string;
  readonly responder: AgentResponder;
  readonly allowedChatIds?: readonly TelegramChatId[];
  readonly allowAllChats?: boolean;
  readonly stream?: TelegramAdapterStreamOptions;
  readonly messages?: TelegramAdapterMessages;
  readonly logger?: TelegramAdapterLogger;
  /** Update types to long-poll for. Defaults to messages only. */
  readonly allowedUpdates?: readonly string[];
  /**
   * Custom command-menu entries. When non-empty the bot registers them (plus the
   * available built-ins) via `setMyCommands` at startup and dispatches each
   * command's `prompt` as a turn. Built-in start/help/cancel/new/model/effort cannot
   * be overridden.
   */
  readonly commands?: readonly TelegramCommandConfig[];
  /** Optional per-chat `/model` and `/effort` controls over a host-supplied catalog. */
  readonly runtimeControls?: TelegramRuntimeControls;
  /**
   * Per-state lifecycle reactions via `setMessageReaction` (👀 working, 👍 done,
   * 👎 error). Each state can be toggled independently; a disabled terminal state
   * clears the working reaction instead of leaving it. Best-effort, default off.
   */
  readonly reactions?: TelegramReactionsConfig;
  /**
   * Quiet window (ms) for aggregating a multi-photo/video album (messages sharing
   * a `media_group_id`) into one request. Defaults to 1000. Set 0 to flush on the
   * next tick (used by tests).
   */
  readonly albumAggregationDelayMs?: number;
  /** Delete any configured webhook before polling. Defaults to true. */
  readonly deleteWebhookOnStart?: boolean;
  /**
   * Bound (ms) for the startup `deleteWebhook` call so a flaky network cannot
   * stall boot. Defaults to {@link DEFAULT_DELETE_WEBHOOK_TIMEOUT_MS} (5000).
   */
  readonly deleteWebhookTimeoutMs?: number;
  /** Drop updates queued before start. Defaults to false. */
  readonly dropPendingUpdates?: boolean;
  /**
   * Outbound transport tuning. `ipFamily: 4` pins the Bot API HTTP client to
   * IPv4 (and `6` to IPv6) via a family-locked keep-alive https.Agent — a
   * workaround for networks whose IPv6 route to api.telegram.org is broken and
   * times out getUpdates. Omit for the default dual-stack behavior.
   */
  readonly transport?: { readonly ipFamily?: 4 | 6 };
  /**
   * Poll-liveness watchdog window (ms). If no getUpdates resolves within this
   * window the runner is force-restarted even though its task never rejected.
   * Defaults to {@link DEFAULT_POLL_WATCHDOG_MS} (120000). Set <= 0 to disable.
   */
  readonly pollWatchdogMs?: number;
  /**
   * Called once when polling becomes degraded after a successful start (the
   * runner's task rejects or the poll-liveness watchdog expires). The adapter
   * ALWAYS restarts afterwards, so a host should treat this as "degraded,
   * recovering" — not terminal — and pair it with {@link onPollingRecovered}.
   */
  readonly onPollingError?: (error: unknown) => void;
  /**
   * Called once when a (re)started runner stays up past the stability window and
   * completes a successful poll AFTER a prior failure — i.e. the poller has
   * recovered. Lets a host flip a "degraded" channel back to "running". Not
   * fired for the initial healthy start.
   */
  readonly onPollingRecovered?: () => void;
  /**
   * Inbound attachment download tuning (byte cap + MIME allowlist). Inbound
   * Telegram media bytes are fetched via the Bot API and inlined into
   * `request.attachments`; failures skip the attachment without failing the run.
   */
  readonly attachments?: DownloadTelegramAttachmentsOptions;
  /**
   * Pending-ask interceptor. Checked in `handleAgentMessage` BEFORE per-chat
   * admission — a reply sent while a turn is blocked on `AskUser` would
   * otherwise queue behind that very turn and deadlock until the ask times out.
   */
  readonly pendingAsks?: TelegramPendingAsks;
  /** Clear one host-owned conversation session for the built-in `/new` command. */
  readonly startNewSession?: (conversationId: string) => Promise<void>;
  /**
   * Base URL of a self-hosted Bot API server (e.g. `http://127.0.0.1:8081`).
   * Applied to every API call and to file downloads; a `--local` server's
   * absolute file paths are read straight from disk. Omit for api.telegram.org.
   */
  readonly apiRoot?: string;
  /** Test seam: build the grammY Bot (e.g. with a fake botInfo + transformer). */
  readonly botFactory?: (token: string) => Bot;
  /**
   * Test seam: override the file downloader (getFile + file URL fetch). Defaults
   * to one backed by `bot.api.getFile` and `fetch` against the Telegram file URL.
   */
  readonly fileDownloaderFactory?: (bot: Bot, token: string) => TelegramFileDownloader;
  /** Test seam: build the polling runner. Defaults to `@grammyjs/runner`'s `run`. */
  readonly runnerFactory?: (bot: Bot) => RunnerHandle;
}

export interface TelegramBotController {
  /** The configured grammY bot. Exposed mainly so tests can drive `handleUpdate`. */
  readonly bot: Bot;
  /** Start concurrent long polling. Idempotent while already running. */
  start(): Promise<void>;
  /** Stop polling and wait for the runner to settle. */
  stop(): Promise<void>;
  /**
   * Deliver a proactive notification to `chatId`, serialized through the same
   * per-chat queue as inbound messages. By default runs `text` as a turn and
   * delivers the answer; with `options.verbatim` posts `text` unchanged (no model
   * call) and records it to history. Used by cron/webhook nudges.
   */
  notify(chatId: TelegramChatId, text: string, options?: TelegramNotifyOptions): Promise<TelegramNotifyResult>;
  /**
   * Post (or edit in place) a short tool-progress status line, keyed per
   * `(chat, key)`. A terminal state (`done`/`failed`) writes the final text and
   * clears the tracking so the next job with the same key starts a new message.
   * Best-effort: a failed send/edit never throws.
   */
  postStatus(
    chatId: TelegramChatId,
    text: string,
    options: { readonly key: string; readonly state: "working" | "done" | "failed" },
  ): Promise<void>;
  /** Present or advance one bridge-owned AskUser interaction. */
  presentAsk(chatId: TelegramChatId, snapshot: ChannelAskSnapshot): Promise<void>;
  updateAsk(chatId: TelegramChatId, snapshot: ChannelAskSnapshot): Promise<void>;
  /**
   * Test seam: total in-flight AbortControllers tracked across all chats. Used to
   * assert the over-cap busy path does not leak an eagerly-created controller.
   */
  activeControllerCount(): number;
}

type TelegramControlCommand = "start" | "help" | "cancel" | "new";

interface TelegramRuntimeSelection {
  model?: string;
  effort?: string;
}

interface TelegramRuntimeControlCatalog {
  readonly controls: TelegramRuntimeControls;
  readonly modelByValue: ReadonlyMap<string, TelegramRuntimeModelOption>;
  readonly modelByToken: ReadonlyMap<string, TelegramRuntimeModelOption>;
  readonly modelTokenByValue: ReadonlyMap<string, string>;
  readonly effortByModelToken: ReadonlyMap<string, ReadonlyMap<string, TelegramRuntimeEffortOption>>;
}

function buildRuntimeControlCatalog(
  input: TelegramRuntimeControls | undefined,
): TelegramRuntimeControlCatalog | undefined {
  if (input === undefined) {
    return undefined;
  }
  const defaultModel = input.defaultModel.trim();
  if (defaultModel.length === 0) {
    throw new TypeError("Telegram runtimeControls.defaultModel must be a non-empty string.");
  }
  const models: TelegramRuntimeModelOption[] = [];
  const modelByValue = new Map<string, TelegramRuntimeModelOption>();
  for (const rawModel of input.models) {
    const value = rawModel.value.trim();
    const label = rawModel.label.trim();
    if (value.length === 0 || label.length === 0) {
      throw new TypeError("Telegram runtimeControls models require non-empty value and label strings.");
    }
    if (modelByValue.has(value)) {
      throw new TypeError(`Telegram runtimeControls contains duplicate model ${value}.`);
    }
    const effortValues = new Set<string>();
    const efforts = rawModel.efforts.map((rawEffort) => {
      const effortValue = rawEffort.value.trim();
      const effortLabel = rawEffort.label.trim();
      if (effortValue.length === 0 || effortLabel.length === 0) {
        throw new TypeError("Telegram runtimeControls efforts require non-empty value and label strings.");
      }
      if (effortValues.has(effortValue)) {
        throw new TypeError(`Telegram runtimeControls contains duplicate effort ${effortValue} for ${value}.`);
      }
      effortValues.add(effortValue);
      return { value: effortValue, label: effortLabel };
    });
    const model = { value, label, efforts };
    models.push(model);
    modelByValue.set(value, model);
  }
  if (!modelByValue.has(defaultModel)) {
    throw new TypeError("Telegram runtimeControls.defaultModel must appear in runtimeControls.models.");
  }

  const defaultEffort = input.defaultEffort?.trim();
  if (input.defaultEffort !== undefined && defaultEffort?.length === 0) {
    throw new TypeError("Telegram runtimeControls.defaultEffort must be non-empty when provided.");
  }
  const controls: TelegramRuntimeControls = {
    defaultModel,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    models,
  };
  const modelByToken = new Map<string, TelegramRuntimeModelOption>();
  const modelTokenByValue = new Map<string, string>();
  const effortByModelToken = new Map<string, ReadonlyMap<string, TelegramRuntimeEffortOption>>();
  // Process-local salt makes buttons from an earlier process stale and prevents
  // callers from constructing a valid token from a guessed configured ref.
  const callbackSalt = randomBytes(16);
  for (const model of models) {
    const modelToken = runtimeCallbackToken(callbackSalt, `model:${model.value}`);
    if (modelByToken.has(modelToken)) {
      throw new TypeError("Telegram runtimeControls model callback token collision.");
    }
    modelByToken.set(modelToken, model);
    modelTokenByValue.set(model.value, modelToken);
    const efforts = new Map<string, TelegramRuntimeEffortOption>();
    for (const effort of model.efforts) {
      const effortToken = runtimeCallbackToken(callbackSalt, `effort:${model.value}:${effort.value}`);
      if (efforts.has(effortToken)) {
        throw new TypeError("Telegram runtimeControls effort callback token collision.");
      }
      efforts.set(effortToken, effort);
    }
    effortByModelToken.set(modelToken, efforts);
  }
  return { controls, modelByValue, modelByToken, modelTokenByValue, effortByModelToken };
}

function runtimeCallbackToken(salt: Uint8Array, value: string): string {
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, RUNTIME_CALLBACK_TOKEN_LENGTH);
}

function telegramButtonLabel(value: string): string {
  const points = Array.from(value);
  return points.length <= TELEGRAM_BUTTON_LABEL_CODE_POINTS
    ? value
    : `${points.slice(0, TELEGRAM_BUTTON_LABEL_CODE_POINTS - 1).join("")}…`;
}

/**
 * Build a grammY bot that routes authorized text messages to an agent responder.
 *
 * grammY owns the transport and (via `@grammyjs/runner`) concurrent polling.
 * Middleware order is: authorization gate → built-in control commands →
 * agent run handler (`message:text`) → unsupported fallback (other messages).
 *
 * Concurrency is NOT rejected per chat. Every message is handed to the responder,
 * which routes through the runtime harness; the harness serializes per
 * conversation (queue-after-turn follow-ups answered on the warm session). For
 * each in-flight message the bot tracks an `AbortController` in a per-chat set so
 * `/cancel` can abort every live turn for the chat (in addition to clearing
 * queued follow-ups via `responder.cancel`).
 */
export function createTelegramBot(options: CreateTelegramBotOptions): TelegramBotController {
  const allowAllChats = options.allowAllChats === true;
  const allowedChatIds = new Set((options.allowedChatIds ?? []).map((id) => String(id)));
  if (!allowAllChats && allowedChatIds.size === 0) {
    throw new TypeError("createTelegramBot requires allowedChatIds or allowAllChats: true.");
  }

  const messages: Required<TelegramAdapterMessages> = { ...DEFAULT_MESSAGES, ...options.messages };
  const logger = createSecretSafeTelegramLogger(options.logger, [options.botToken]);
  const initialStatusText = options.stream?.initialStatusText ?? DEFAULT_INITIAL_STATUS_TEXT;
  const runtimeCatalog = buildRuntimeControlCatalog(options.runtimeControls);
  // Intentionally process-local: selections reset on restart and never alter the
  // configured host defaults. Each chat gets an independent override record.
  const runtimeSelections = new Map<string, TelegramRuntimeSelection>();
  // Per-chat set of AbortControllers for in-flight messages. The runtime harness
  // serializes turns per conversation, so we never reject concurrent messages —
  // we only track them so `/cancel` can abort every live turn for the chat.
  const activeControllers = new Map<string, Set<AbortController>>();

  /**
   * Create and register a fresh AbortController for a chat BEFORE the turn is
   * admitted to the per-chat queue. Registering eagerly means a /cancel can abort
   * a message that is still parked behind an earlier run (the controller would
   * otherwise not exist until the queue reached its runAgentTurn).
   */
  function registerController(chatId: TelegramChatId): AbortController {
    const key = String(chatId);
    const controller = new AbortController();
    const controllers = activeControllers.get(key);
    if (controllers === undefined) {
      activeControllers.set(key, new Set([controller]));
    } else {
      controllers.add(controller);
    }
    return controller;
  }

  /** Remove a controller from a chat's active set (no-op if already gone). */
  function unregisterController(chatId: TelegramChatId, controller: AbortController): void {
    const key = String(chatId);
    const set = activeControllers.get(key);
    if (set !== undefined) {
      set.delete(controller);
      if (set.size === 0) {
        activeControllers.delete(key);
      }
    }
  }
  // Per-conversation admission queue. grammY (via @grammyjs/runner) dispatches
  // updates concurrently, and the pre-respond work (status + attachment download)
  // is variable latency, so without this a later text-only message could reach
  // responder.respond() (and the harness FIFO) before an earlier still-downloading
  // media message in the same chat — and many same-chat downloads would run
  // unbounded. We serialize runAgentTurn per chat to preserve arrival order and
  // bound concurrent same-chat downloads. /cancel stays out-of-band (it never
  // enters this queue, so a queued turn can never block cancellation).
  const admissionQueues = new Map<string, SerialQueue>();
  // Set in stop() so a pending album timer (or a late update) cannot fire a turn
  // after the channel was torn down. Mirrors the slack/whatsapp adapters.
  let stopped = false;

  // Telegram delivers a multi-photo/video album as N separate messages sharing a
  // `media_group_id`, arriving back-to-back. We buffer them per group and flush
  // once after a short quiet window so the album becomes ONE request with all
  // attachments (the caption rides on only one message).
  //
  // To preserve arrival order, the FIRST part also RESERVES a per-chat admission
  // slot (`ready`): the admitted task awaits `ready.promise`, which resolves to
  // the actual album work (or a no-op). Reserving at album-start means a later
  // same-chat text message admitted while the album is still buffering lands
  // BEHIND the album's slot instead of overtaking it. `controller` is the eager
  // AbortController so /cancel can abort a parked-but-not-yet-flushed album.
  type AlbumWork = () => Promise<void>;
  const albumBuffers = new Map<string, {
    readonly ctx: Context;
    readonly messages: TelegramMessage[];
    timer: ReturnType<typeof setTimeout>;
    readonly controller: AbortController;
    readonly ready: { readonly promise: Promise<AlbumWork>; resolve: (work: AlbumWork) => void };
  }>();
  const noopAlbumWork: AlbumWork = () => Promise.resolve();
  const albumDelayMs = options.albumAggregationDelayMs ?? DEFAULT_ALBUM_AGGREGATION_DELAY_MS;

  const cancelChat = (chatId: TelegramChatId): void => {
    const conversationId = `telegram:${String(chatId)}`;
    const reason = createChannelUserCancelReason("Telegram");
    // Fail any pending ask first so a tool blocked on AskUser returns
    // "cancelled by user" instead of waiting out its timeout.
    options.pendingAsks?.cancel(conversationId);
    // Clear queued follow-ups (and signal the harness to abort the in-flight
    // turn) first, then abort every controller we are tracking for this chat.
    options.responder.cancel?.(conversationId, reason);
    const controllers = activeControllers.get(String(chatId));
    if (controllers !== undefined) {
      for (const controller of controllers) {
        controller.abort(reason);
      }
    }
    // Drop any album still buffering for this chat so /cancel does not leave it
    // to fire a turn after the user asked to stop. Settle the reserved admission
    // slot with a no-op so the parked admit() task does not hang the per-chat
    // queue. (Its eager controller was just aborted in the loop above.)
    for (const [key, buffer] of albumBuffers) {
      if (key.startsWith(`${String(chatId)}:`)) {
        clearTimeout(buffer.timer);
        albumBuffers.delete(key);
        buffer.ready.resolve(noopAlbumWork);
        unregisterController(chatId, buffer.controller);
      }
    }
  };

  async function finishCancelledUnlessAcknowledged(
    stream: TelegramMessageStream,
    signal: AbortSignal,
    error?: unknown,
  ): Promise<void> {
    const acknowledgedByCommand =
      isChannelUserCancelReason(signal.reason) ||
      (isAgentResponseCancelledError(error) && isChannelUserCancelReason(error.reason));
    if (!acknowledgedByCommand) {
      await finishSafely(stream, messages.cancelledText, logger);
    } else {
      await stream.dismissTransient();
    }
  }

  // Cap the Api client's overall HTTP timeout so a half-open getUpdates socket
  // fails in ~50s instead of grammY's 500s default — see DEFAULT_API_TIMEOUT_SECONDS.
  // The botFactory test seam owns full Bot construction, so the cap (and the
  // optional IPv4/IPv6 transport pin + apiRoot) is applied only on the default path.
  const { client: clientOptions, agent: transportAgent } = buildTelegramBotClientOptions({
    ...(options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
    ...(options.transport?.ipFamily === undefined ? {} : { ipFamily: options.transport.ipFamily }),
  });
  const bot =
    options.botFactory?.(options.botToken) ??
    new Bot(options.botToken, { client: clientOptions });
  // Poll-liveness heartbeat: stamp the time each getUpdates call RESOLVED. The
  // watchdog uses this to detect a runner that has gone silently deaf (connected
  // but no longer delivering) and force-restart it. Installed last so it is the
  // OUTERMOST transformer (grammY runs the most-recently-installed first), so it
  // observes every getUpdates resolution even beneath a test-injected transformer.
  let lastPollMs = Date.now();
  let activePollGeneration = 0;
  let successfulPollGeneration = 0;
  let handleSuccessfulPoll = (): void => undefined;
  bot.api.config.use(async (prev, method, payload, signal) => {
    const requestGeneration = activePollGeneration;
    const result = await prev(method, payload, signal);
    if (method === "getUpdates") {
      lastPollMs = Date.now();
      successfulPollGeneration = requestGeneration;
      handleSuccessfulPoll();
    }
    return result;
  });
  const sender = createGrammyTelegramApi(bot.api);
  const fileDownloader =
    options.fileDownloaderFactory?.(bot, options.botToken) ??
    createDefaultFileDownloader(bot, options.botToken, {
      ...(options.attachments?.downloadTimeoutMs !== undefined
        ? { downloadTimeoutMs: options.attachments.downloadTimeoutMs }
        : {}),
      ...(options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot }),
      ...(logger !== undefined ? { logger } : {}),
    });

  const isAuthorized = (chatId: TelegramChatId | undefined): boolean =>
    chatId !== undefined && (allowAllChats || allowedChatIds.has(String(chatId)));

  function runtimeSelectionFor(chatId: TelegramChatId): TelegramRuntimeSelection {
    return runtimeSelections.get(String(chatId)) ?? {};
  }

  function saveRuntimeSelection(chatId: TelegramChatId, selection: TelegramRuntimeSelection): void {
    const key = String(chatId);
    if (selection.model === undefined && selection.effort === undefined) {
      runtimeSelections.delete(key);
    } else {
      runtimeSelections.set(key, selection);
    }
  }

  function effectiveRuntimeModel(chatId: TelegramChatId): TelegramRuntimeModelOption | undefined {
    if (runtimeCatalog === undefined) {
      return undefined;
    }
    const selected = runtimeSelectionFor(chatId).model ?? runtimeCatalog.controls.defaultModel;
    return runtimeCatalog.modelByValue.get(selected);
  }

  function selectRuntimeModel(chatId: TelegramChatId, value: string | undefined): boolean {
    if (runtimeCatalog === undefined) {
      return false;
    }
    const selection = { ...runtimeSelectionFor(chatId) };
    if (value === undefined || value === runtimeCatalog.controls.defaultModel) {
      delete selection.model;
    } else {
      selection.model = value;
    }
    const target = runtimeCatalog.modelByValue.get(
      selection.model ?? runtimeCatalog.controls.defaultModel,
    );
    const effortCleared = selection.effort !== undefined
      && target?.efforts.some((effort) => effort.value === selection.effort) !== true;
    if (effortCleared) {
      delete selection.effort;
    }
    saveRuntimeSelection(chatId, selection);
    return effortCleared;
  }

  function selectRuntimeEffort(chatId: TelegramChatId, value: string | undefined): void {
    const selection = { ...runtimeSelectionFor(chatId) };
    if (value === undefined) {
      delete selection.effort;
    } else {
      selection.effort = value;
    }
    saveRuntimeSelection(chatId, selection);
  }

  function applyRuntimeSelection(
    chatId: TelegramChatId,
    telegram: AgentRequest["metadata"]["telegram"],
  ): void {
    const selection = runtimeSelections.get(String(chatId));
    if (selection?.model !== undefined) {
      telegram.model = selection.model;
    }
    if (selection?.effort !== undefined) {
      telegram.effort = selection.effort;
    }
  }

  function modelSelectionConfirmation(chatId: TelegramChatId, effortCleared: boolean): string {
    const model = effectiveRuntimeModel(chatId);
    const isDefault = runtimeSelectionFor(chatId).model === undefined;
    const base = isDefault
      ? `Model changed to the configured default: ${model?.label ?? "unknown"}.`
      : `Model changed to ${model?.label ?? "unknown"} for this chat until /model default or restart.`;
    return effortCleared
      ? `${base} The previous effort selection was reset because this model does not support it.`
      : base;
  }

  function effortSelectionConfirmation(chatId: TelegramChatId): string {
    const selection = runtimeSelectionFor(chatId);
    if (selection.effort === undefined) {
      const configured = runtimeCatalog?.controls.defaultEffort;
      return configured === undefined
        ? "Effort changed to the configured provider default."
        : `Effort changed to the configured default: ${configured}.`;
    }
    const model = effectiveRuntimeModel(chatId);
    const effort = model?.efforts.find((candidate) => candidate.value === selection.effort);
    return `Effort changed to ${effort?.label ?? selection.effort} for this chat until /effort default or restart.`;
  }

  function modelMenuMarkup(chatId: TelegramChatId): {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const catalog = runtimeCatalog as TelegramRuntimeControlCatalog;
    const selection = runtimeSelectionFor(chatId);
    const defaultModel = catalog.modelByValue.get(catalog.controls.defaultModel) as TelegramRuntimeModelOption;
    const rows: Array<Array<{ text: string; callback_data: string }>> = [[{
      text: telegramButtonLabel(`${selection.model === undefined ? "✓ " : ""}Default · ${defaultModel.label}`),
      callback_data: `${MODEL_CALLBACK_PREFIX}${catalog.modelTokenByValue.get(defaultModel.value) as string}`,
    }]];
    for (const model of catalog.controls.models) {
      if (model.value === catalog.controls.defaultModel) {
        continue;
      }
      rows.push([{
        text: telegramButtonLabel(`${selection.model === model.value ? "✓ " : ""}${model.label}`),
        callback_data: `${MODEL_CALLBACK_PREFIX}${catalog.modelTokenByValue.get(model.value) as string}`,
      }]);
    }
    rows.push([{ text: "Cancel", callback_data: RUNTIME_CANCEL_CALLBACK }]);
    return { inline_keyboard: rows };
  }

  function effortMenuMarkup(
    chatId: TelegramChatId,
    model: TelegramRuntimeModelOption,
  ): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    const catalog = runtimeCatalog as TelegramRuntimeControlCatalog;
    const selection = runtimeSelectionFor(chatId);
    const modelToken = catalog.modelTokenByValue.get(model.value) as string;
    const configuredDefault = catalog.controls.defaultEffort ?? "provider default";
    const rows: Array<Array<{ text: string; callback_data: string }>> = [[{
      text: telegramButtonLabel(`${selection.effort === undefined ? "✓ " : ""}Default · ${configuredDefault}`),
      callback_data: `${EFFORT_CALLBACK_PREFIX}${modelToken}:d`,
    }]];
    const effortTokens = catalog.effortByModelToken.get(modelToken) as ReadonlyMap<string, TelegramRuntimeEffortOption>;
    for (const [token, effort] of effortTokens) {
      rows.push([{
        text: telegramButtonLabel(`${selection.effort === effort.value ? "✓ " : ""}${effort.label}`),
        callback_data: `${EFFORT_CALLBACK_PREFIX}${modelToken}:${token}`,
      }]);
    }
    rows.push([{ text: "Cancel", callback_data: RUNTIME_CANCEL_CALLBACK }]);
    return { inline_keyboard: rows };
  }

  function commandArgument(ctx: Context): string {
    return typeof ctx.match === "string" ? ctx.match.trim() : "";
  }

  async function handleModelCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || runtimeCatalog === undefined) {
      return;
    }
    const argument = commandArgument(ctx);
    if (argument.length === 0) {
      const current = effectiveRuntimeModel(chatId);
      await ctx.reply(
        `Current model: ${current?.label ?? "unknown"}. Choose a configured model:`,
        { reply_markup: modelMenuMarkup(chatId) },
      );
      return;
    }
    if (argument.toLowerCase() === "default") {
      const effortCleared = selectRuntimeModel(chatId, undefined);
      await ctx.reply(modelSelectionConfirmation(chatId, effortCleared));
      return;
    }
    if (!runtimeCatalog.modelByValue.has(argument)) {
      await ctx.reply("That model is not available. Use /model to choose from the configured primary and fallbacks.");
      return;
    }
    const effortCleared = selectRuntimeModel(chatId, argument);
    await ctx.reply(modelSelectionConfirmation(chatId, effortCleared));
  }

  async function handleEffortCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || runtimeCatalog === undefined) {
      return;
    }
    const model = effectiveRuntimeModel(chatId);
    if (model === undefined) {
      await ctx.reply("Effort controls are unavailable for the current model.");
      return;
    }
    const argument = commandArgument(ctx);
    if (argument.toLowerCase() === "default") {
      selectRuntimeEffort(chatId, undefined);
      await ctx.reply(effortSelectionConfirmation(chatId));
      return;
    }
    if (model.efforts.length === 0) {
      await ctx.reply(`The current model (${model.label}) does not expose adjustable effort.`);
      return;
    }
    if (argument.length === 0) {
      await ctx.reply(
        `Choose effort for ${model.label}:`,
        { reply_markup: effortMenuMarkup(chatId, model) },
      );
      return;
    }
    const effort = model.efforts.find((candidate) =>
      candidate.value === argument || candidate.value === argument.toLowerCase()
    );
    if (effort === undefined) {
      await ctx.reply("That effort is not available for the current model. Use /effort to see its options.");
      return;
    }
    selectRuntimeEffort(chatId, effort.value);
    await ctx.reply(effortSelectionConfirmation(chatId));
  }

  async function handleNewSessionCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const conversationId = `telegram:${String(chatId)}`;
    if (options.startNewSession === undefined) {
      await ctx.reply(messages.newSessionErrorText);
      return;
    }
    cancelChat(chatId);
    try {
      await options.startNewSession(conversationId);
      await ctx.reply(messages.newSessionText);
    } catch (error) {
      logger?.warn?.("Telegram /new session reset failed.", { error: errorMessage(error) });
      await ctx.reply(messages.newSessionErrorText);
    }
  }

  const reactions = options.reactions;
  /**
   * Set (or clear, when `emoji` is undefined) the bot's reaction on a message.
   * Per-state gating is the caller's job; this only no-ops when the sender lacks
   * the method, and swallows a failure (e.g. missing permission) so it never
   * affects the turn. Telegram constrains reactions to a fixed emoji set.
   */
  async function applyReaction(
    chatId: TelegramChatId,
    messageId: number,
    emoji: string | undefined,
  ): Promise<void> {
    if (sender.setMessageReaction === undefined) {
      return;
    }
    try {
      await sender.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji === undefined ? [] : [{ type: "emoji", emoji }],
      });
    } catch (error) {
      logger?.debug?.("Telegram setMessageReaction failed (best-effort).", {
        error: errorMessage(error),
      });
    }
  }

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }
    if (!isAuthorized(chatId)) {
      await ctx.reply(messages.unauthorizedText);
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(messages.welcomeText);
  });
  bot.command("help", async (ctx) => {
    await ctx.reply(messages.helpText);
  });
  bot.command("cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      cancelChat(chatId);
    }
    await ctx.reply(messages.cancelledText);
  });
  bot.command("new", handleNewSessionCommand);
  if (runtimeCatalog !== undefined) {
    bot.command("model", handleModelCommand);
    bot.command("effort", handleEffortCommand);
  }

  // Custom config-driven commands. Registered before the catch-all `message`
  // handler so a `/cmd` is dispatched here (and never falls through to the agent
  // as raw text). A command with a `prompt` runs it as a turn through the same
  // per-chat queue as a typed message; a prompt-less command is menu-only and
  // just echoes its description. Built-in start/help/cancel/new/model/effort are reserved (config
  // validation rejects them), so these never shadow a built-in.
  const customCommands = options.commands ?? [];
  for (const command of customCommands) {
    const prompt = command.prompt;
    bot.command(command.command, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        return;
      }
      if (prompt === undefined) {
        await ctx.reply(command.description);
        return;
      }
      await notifyInteractive(chatId, prompt);
    });
  }

  const askPresentations = new Map<string, TelegramAskPresentation>();
  async function presentAsk(chatId: TelegramChatId, snapshot: ChannelAskSnapshot): Promise<void> {
    if (snapshot.message !== undefined) {
      await sender.sendMessage({ chat_id: chatId, text: snapshot.message });
    }
    const rendered = renderTelegramAsk(snapshot, new Set());
    const sent = await sender.sendMessage({
      chat_id: chatId,
      text: rendered.text,
      ...(rendered.replyMarkup === undefined ? {} : { reply_markup: rendered.replyMarkup }),
    });
    askPresentations.set(snapshot.interactionId, {
      chatId,
      messageId: sent.message_id,
      activeQuestionIndex: snapshot.activeQuestionIndex,
      selectedOptionIds: new Set(),
    });
  }
  async function updateAsk(chatId: TelegramChatId, snapshot: ChannelAskSnapshot): Promise<void> {
    const presentation = askPresentations.get(snapshot.interactionId);
    if (presentation === undefined || String(presentation.chatId) !== String(chatId)) return;
    if (presentation.activeQuestionIndex !== snapshot.activeQuestionIndex) {
      presentation.activeQuestionIndex = snapshot.activeQuestionIndex;
      presentation.selectedOptionIds.clear();
    }
    const rendered = renderTelegramAsk(snapshot, presentation.selectedOptionIds);
    await sender.editMessageText({
      chat_id: chatId,
      message_id: presentation.messageId,
      text: rendered.text,
      ...(rendered.replyMarkup === undefined ? {} : { reply_markup: rendered.replyMarkup }),
    });
    if (snapshot.status !== "pending") askPresentations.delete(snapshot.interactionId);
  }

  // Runtime controls, structured AskUser, and non-blocking reply options share
  // Telegram's callback_query stream. Unknown protocols are acknowledged only.
  const callbackHandlersEnabled = true;
  const answeredCallbacks = new Set<string>();
  const rememberAnswered = (key: string): void => {
    answeredCallbacks.add(key);
    if (answeredCallbacks.size > CALLBACK_DEDUPE_MAX) {
      const oldest = answeredCallbacks.values().next().value;
      if (oldest !== undefined) {
        answeredCallbacks.delete(oldest);
      }
    }
  };
  async function answerCallbackQuietly(ctx: Context, text?: string): Promise<void> {
    try {
      await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
    } catch (error) {
      logger?.debug?.("Telegram answerCallbackQuery failed (best-effort).", {
        error: errorMessage(error),
      });
    }
  }
  async function stripCallbackKeyboardQuietly(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup();
    } catch (error) {
      logger?.debug?.("Telegram editMessageReplyMarkup failed after callback (best-effort).", {
        error: errorMessage(error),
      });
    }
  }
  async function replaceRuntimeMenuQuietly(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.editMessageText(text);
    } catch (error) {
      logger?.debug?.("Telegram editMessageText failed after runtime selection; replying instead.", {
        error: errorMessage(error),
      });
      await stripCallbackKeyboardQuietly(ctx);
      await ctx.reply(text);
    }
  }
  async function deleteRuntimeMenuQuietly(ctx: Context): Promise<void> {
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger?.debug?.("Telegram deleteMessage failed after runtime-menu cancel; editing instead.", {
        error: errorMessage(error),
      });
      await replaceRuntimeMenuQuietly(ctx, "Selection cancelled.");
    }
  }
  async function expireRuntimeCallback(ctx: Context): Promise<void> {
    await answerCallbackQuietly(ctx, "This menu has expired.");
    await stripCallbackKeyboardQuietly(ctx);
  }
  async function handleRuntimeCallback(ctx: Context, chatId: TelegramChatId, data: string): Promise<boolean> {
    if (!data.startsWith(RUNTIME_CALLBACK_PREFIX)) {
      return false;
    }
    if (runtimeCatalog === undefined) {
      await expireRuntimeCallback(ctx);
      return true;
    }
    const messageId = ctx.callbackQuery?.message?.message_id;
    const dedupeKey = `${String(chatId)}:${messageId ?? "?"}`;
    if (answeredCallbacks.has(dedupeKey)) {
      await answerCallbackQuietly(ctx, "Already recorded.");
      return true;
    }

    if (data === RUNTIME_CANCEL_CALLBACK) {
      rememberAnswered(dedupeKey);
      await answerCallbackQuietly(ctx, "Cancelled.");
      await deleteRuntimeMenuQuietly(ctx);
      return true;
    }

    if (data.startsWith(MODEL_CALLBACK_PREFIX)) {
      const token = data.slice(MODEL_CALLBACK_PREFIX.length);
      const model = runtimeCatalog.modelByToken.get(token);
      if (token.length === 0 || model === undefined) {
        await expireRuntimeCallback(ctx);
        return true;
      }
      rememberAnswered(dedupeKey);
      const effortCleared = selectRuntimeModel(chatId, model.value);
      await answerCallbackQuietly(ctx, "Model updated.");
      await replaceRuntimeMenuQuietly(ctx, modelSelectionConfirmation(chatId, effortCleared));
      return true;
    }

    if (data.startsWith(EFFORT_CALLBACK_PREFIX)) {
      const parts = data.slice(EFFORT_CALLBACK_PREFIX.length).split(":");
      const [modelToken, effortToken] = parts;
      const model = modelToken === undefined ? undefined : runtimeCatalog.modelByToken.get(modelToken);
      const current = effectiveRuntimeModel(chatId);
      const effort = modelToken === undefined || effortToken === undefined
        ? undefined
        : runtimeCatalog.effortByModelToken.get(modelToken)?.get(effortToken);
      if (
        parts.length !== 2
        || model === undefined
        || current?.value !== model.value
        || (effortToken !== "d" && effort === undefined)
      ) {
        await expireRuntimeCallback(ctx);
        return true;
      }
      rememberAnswered(dedupeKey);
      selectRuntimeEffort(chatId, effortToken === "d" ? undefined : effort?.value);
      await answerCallbackQuietly(ctx, "Effort updated.");
      await replaceRuntimeMenuQuietly(ctx, effortSelectionConfirmation(chatId));
      return true;
    }

    await expireRuntimeCallback(ctx);
    return true;
  }
  if (callbackHandlersEnabled) {
    bot.on("callback_query:data", async (ctx) => {
      if (stopped) {
        return;
      }
      const chatId = ctx.chat?.id;
      const data = ctx.callbackQuery.data;
      if (chatId === undefined || !isAuthorized(chatId)) {
        await answerCallbackQuietly(ctx);
        return;
      }
      if (await handleRuntimeCallback(ctx, chatId, data)) {
        return;
      }
      const askCallback = parseTelegramAskUserCallbackData(data);
      if (askCallback !== undefined) {
        const conversationId = `telegram:${String(chatId)}`;
        const snapshot = await options.pendingAsks?.getPendingAsk(conversationId);
        if (
          snapshot === undefined
          || snapshot.interactionId !== askCallback.interactionId
          || snapshot.activeQuestionIndex !== askCallback.questionIndex
        ) {
          await answerCallbackQuietly(ctx, "This question has expired.");
          await stripCallbackKeyboardQuietly(ctx);
          return;
        }
        const question = snapshot.questions[snapshot.activeQuestionIndex];
        if (question === undefined) {
          await answerCallbackQuietly(ctx, "This question has expired.");
          return;
        }
        if (askCallback.action.kind === "other") {
          await answerCallbackQuietly(ctx, "Type your reply below.");
          await ctx.reply("Type your custom reply below.");
          return;
        }
        const messageId = ctx.callbackQuery.message?.message_id;
        let presentation = askPresentations.get(snapshot.interactionId);
        if (presentation === undefined && messageId !== undefined) {
          presentation = {
            chatId,
            messageId,
            activeQuestionIndex: snapshot.activeQuestionIndex,
            selectedOptionIds: new Set(),
          };
          askPresentations.set(snapshot.interactionId, presentation);
        }
        if (askCallback.action.kind === "option" && question.multiSelect) {
          const option = question.options[askCallback.action.optionIndex];
          if (option === undefined || presentation === undefined) {
            await answerCallbackQuietly(ctx, "This option has expired.");
            return;
          }
          if (presentation.selectedOptionIds.has(option.id)) presentation.selectedOptionIds.delete(option.id);
          else presentation.selectedOptionIds.add(option.id);
          await updateAsk(chatId, snapshot);
          await answerCallbackQuietly(ctx, "Selection updated.");
          return;
        }
        const selectedOptionIds = askCallback.action.kind === "option"
          ? [question.options[askCallback.action.optionIndex]?.id].filter((id): id is string => id !== undefined)
          : [...(presentation?.selectedOptionIds ?? [])];
        if (selectedOptionIds.length === 0) {
          await answerCallbackQuietly(ctx, "Choose at least one option.");
          return;
        }
        const result = await options.pendingAsks?.submitAskAnswers({
          conversationId,
          interactionId: snapshot.interactionId,
          answers: [{ questionId: question.id, selectedOptionIds }],
        });
        await answerCallbackQuietly(ctx, result?.accepted === true ? "Answer recorded." : "This question has expired.");
        return;
      }
      if (!isTelegramReplyCallbackData(data)) {
        await answerCallbackQuietly(ctx);
        return;
      }
      const messageId = ctx.callbackQuery.message?.message_id;
      const dedupeKey = `${String(chatId)}:${messageId ?? "?"}`;
      if (answeredCallbacks.has(dedupeKey)) {
        await answerCallbackQuietly(ctx, "Already recorded.");
        return;
      }
      // Claim synchronously (no await before this) so a near-simultaneous second
      // tap on the same question de-dupes instead of running a second turn.
      rememberAnswered(dedupeKey);
      const label = labelForCallbackData(ctx.callbackQuery.message?.reply_markup, data);
      await answerCallbackQuietly(ctx, label === undefined ? undefined : `You chose: ${label}`);
      if (label === undefined) {
        return;
      }
      // Strip the keyboard so the question cannot be answered twice (best-effort).
      await stripCallbackKeyboardQuietly(ctx);
      const conversationId = `telegram:${String(chatId)}`;
      const question = ctx.callbackQuery.message?.text;
      const syntheticText =
        question !== undefined && question.trim().length > 0
          ? `Re: "${question.trim()}" — I chose: ${label}`
          : `I chose: ${label}`;
      await notifyInteractive(chatId, syntheticText);
    });
  }

  // A single handler for every message type so all messages reach the per-chat
  // admission queue at the same middleware depth. Separate per-type handlers sit
  // at different filter positions, and grammY yields a microtask per non-matching
  // filter — so a later text message (matched by the first `message:text` filter)
  // could overtake an earlier document/photo (filtered one step further) before
  // admission, breaking arrival order. handleAgentMessage routes supported types
  // and replies unsupportedText for the rest (normalizeTelegramMessageInput
  // returns undefined), so a single `message` handler covers both cases.
  bot.on("message", async (ctx) => {
    await handleAgentMessage(ctx);
  });

  /**
   * Run a turn through the per-chat admission queue so same-chat turns serialize
   * (preserving harness FIFO arrival order and bounding concurrent same-chat
   * downloads). Cross-chat concurrency is preserved because queues are keyed per
   * chat id (the same key /cancel uses for activeControllers).
   *
   * The queue is bounded: a same-chat flood past the depth cap is rejected by
   * SerialQueue.run BEFORE the task enters the chain, so the over-cap message is
   * never admitted. On that rejected path the task body never runs — its eager
   * controller (and, for an album, its reserved slot) never reach the cleanup in
   * runAgentTurn/flushAlbum — so the caller supplies an `onReject` callback to
   * settle/unregister those eagerly-created resources, after which we reply with
   * the busy terminal instead of admitting an unbounded backlog.
   */
  async function admit(
    chatId: TelegramChatId,
    task: () => Promise<void>,
    onReject?: () => void | Promise<void>,
  ): Promise<void> {
    const key = String(chatId);
    let queue = admissionQueues.get(key);
    if (queue === undefined) {
      queue = new SerialQueue();
      admissionQueues.set(key, queue);
    }
    try {
      await queue.run(task);
    } catch (error) {
      if (isSerialQueueFullError(error)) {
        await onReject?.();
        return;
      }
      throw error;
    } finally {
      if (queue.idle && admissionQueues.get(key) === queue) {
        admissionQueues.delete(key);
      }
    }
  }

  async function handleAgentMessage(ctx: Context): Promise<void> {
    if (stopped) {
      return;
    }
    const message = ctx.message;
    const chatId = ctx.chat?.id;
    if (message === undefined || chatId === undefined) {
      return;
    }
    const telegramMessage = message as unknown as TelegramMessage;

    // A multi-photo/video album arrives as several messages sharing a
    // media_group_id; buffer them and flush once so the agent sees one request
    // with every attachment instead of N single-attachment turns.
    const groupId = telegramMessage.media_group_id;
    if (typeof groupId === "string" && groupId.length > 0) {
      bufferAlbumMessage(ctx, chatId, groupId, telegramMessage);
      return;
    }

    const captionCommand = controlCommandFromCaption(telegramMessage, ctx.me.username);
    if (captionCommand !== undefined) {
      await handleControlCommand(ctx, captionCommand);
      return;
    }

    // A plain-text reply while AskUser is pending is a custom answer. Consume it
    // before admission: the asking turn holds this chat's queue slot, so queueing
    // the reply behind it would deadlock. Slash commands remain commands.
    if (
      options.pendingAsks !== undefined &&
      typeof telegramMessage.text === "string" &&
      telegramMessage.text.trim().length > 0 &&
      !telegramMessage.text.trimStart().startsWith("/")
    ) {
      const conversationId = `telegram:${String(chatId)}`;
      const snapshot = await options.pendingAsks.getPendingAsk(conversationId);
      const question = snapshot?.questions[snapshot.activeQuestionIndex];
      if (snapshot !== undefined && question !== undefined) {
        const selectedOptionIds = question.multiSelect
          ? [...(askPresentations.get(snapshot.interactionId)?.selectedOptionIds ?? [])]
          : [];
        const result = await options.pendingAsks.submitAskAnswers({
          conversationId,
          interactionId: snapshot.interactionId,
          answers: [{
            questionId: question.id,
            selectedOptionIds,
            customReply: telegramMessage.text,
          }],
        });
        if (!result.accepted) {
          await ctx.reply(messages.busyText);
          return;
        }
        await applyReaction(chatId, telegramMessage.message_id, "👍");
        return;
      }
    }

    const input = normalizeTelegramMessageInput(telegramMessage);
    if (input === undefined) {
      await ctx.reply(messages.unsupportedText);
      return;
    }
    // Register the controller before admission so /cancel can abort this message
    // even while it is still parked behind an earlier same-chat run.
    const controller = registerController(chatId);
    const queueKey = String(chatId);
    let queue = admissionQueues.get(queueKey);
    if (queue === undefined) {
      queue = new SerialQueue();
      admissionQueues.set(queueKey, queue);
    }
    if (
      input.attachments.length === 0
      && typeof telegramMessage.text === "string"
      && telegramMessage.text.trim().length > 0
      && options.responder.offerLiveInput !== undefined
      && !queue.full
    ) {
      const decision = createDeferred<"run" | "applied" | "discarded">();
      const reserved = queue.run(async () => {
        const next = await decision.promise;
        if (next === "run") {
          await runAgentTurn(ctx, telegramMessage, input, controller);
          return;
        }
        if (reactions !== undefined) {
          if (next === "applied" && reactions.done) {
            await applyReaction(chatId, telegramMessage.message_id, REACTION_DONE);
          } else if (reactions.working) {
            await applyReaction(chatId, telegramMessage.message_id, undefined);
          }
        }
        unregisterController(chatId, controller);
      });
      let offer;
      try {
        offer = options.responder.offerLiveInput({
          conversationId: `telegram:${String(chatId)}`,
          id: `${String(chatId)}:${String(telegramMessage.message_id)}`,
          text: telegramMessage.text,
          receivedAt: new Date((telegramMessage.date ?? Math.floor(Date.now() / 1_000)) * 1_000).toISOString(),
        });
      } catch (error) {
        logger?.debug?.("Telegram live-input offer failed; running as a queued turn.", {
          error: errorMessage(error),
        });
        decision.resolve("run");
        try {
          await reserved;
        } finally {
          if (queue.idle && admissionQueues.get(queueKey) === queue) {
            admissionQueues.delete(queueKey);
          }
        }
        return;
      }
      if (offer.status === "accepted") {
        void offer.settled.then(
          (settlement) => decision.resolve(
            settlement.status === "requeue"
              ? "run"
              : settlement.status === "applied"
                ? "applied"
                : "discarded",
          ),
          () => decision.resolve("run"),
        );
        if (reactions?.working === true) {
          await applyReaction(chatId, telegramMessage.message_id, REACTION_WORKING);
        }
        void reserved.catch((error: unknown) => {
          logger?.error?.("Telegram deferred live-input fallback failed.", {
            error: errorMessage(error),
          });
        }).finally(() => {
          if (queue.idle && admissionQueues.get(queueKey) === queue) {
            admissionQueues.delete(queueKey);
          }
        });
        return;
      }
      decision.resolve("run");
      try {
        await reserved;
      } finally {
        if (queue.idle && admissionQueues.get(queueKey) === queue) {
          admissionQueues.delete(queueKey);
        }
      }
      return;
    }
    await admit(
      chatId,
      () => runAgentTurn(ctx, telegramMessage, input, controller),
      // Over-cap: the task was rejected before entering the queue, so runAgentTurn
      // (and its finally) never ran. Unregister the eagerly created controller so
      // it does not leak in activeControllers, then reply with the busy terminal.
      async () => {
        unregisterController(chatId, controller);
        await ctx.reply(messages.busyText);
      },
    );
  }

  function bufferAlbumMessage(
    ctx: Context,
    chatId: TelegramChatId,
    groupId: string,
    message: TelegramMessage,
  ): void {
    const key = `${String(chatId)}:${groupId}`;
    const schedule = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => {
        void flushAlbum(key);
      }, albumDelayMs);
      timer.unref?.();
      return timer;
    };
    const existing = albumBuffers.get(key);
    if (existing === undefined) {
      // First part of a new album: reserve a per-chat admission slot NOW so a
      // later same-chat message cannot overtake the album. Register the eager
      // controller (so /cancel can abort a parked album) and admit a task that
      // blocks on `ready.promise` — flushAlbum settles it with the real work
      // after the quiet window. The slot blocks only on the album timer, which
      // fires independently of queue progress, so there is no deadlock.
      const controller = registerController(chatId);
      const ready = createDeferred<AlbumWork>();
      const timer = schedule();
      albumBuffers.set(key, { ctx, messages: [message], timer, controller, ready });
      void admit(
        chatId,
        async () => {
          const work = await ready.promise;
          await work();
        },
        // Over-cap: the reserved album slot was rejected before entering the
        // queue, so flushAlbum's later run/settle never executes for it. Drop the
        // buffered album (clear its timer, remove it, settle the deferred), and
        // unregister the eager controller so it does not leak; then reply busy.
        async () => {
          const buffered = albumBuffers.get(key);
          if (buffered !== undefined) {
            clearTimeout(buffered.timer);
            albumBuffers.delete(key);
            buffered.ready.resolve(noopAlbumWork);
          } else {
            ready.resolve(noopAlbumWork);
          }
          unregisterController(chatId, controller);
          await ctx.reply(messages.busyText);
        },
      );
      return;
    }
    existing.messages.push(message);
    clearTimeout(existing.timer);
    existing.timer = schedule();
  }

  async function flushAlbum(key: string): Promise<void> {
    const buffer = albumBuffers.get(key);
    if (buffer === undefined) {
      return;
    }
    albumBuffers.delete(key);
    const { ctx, messages: parts, controller, ready } = buffer;
    const albumChatId = ctx.chat?.id;

    // The reserved admission slot is parked on `ready.promise`. EVERY exit below
    // must settle it (with real work or a no-op) or the per-chat queue hangs
    // forever. On a no-op exit, the eager controller never reaches runAgentTurn's
    // finally, so unregister it here to avoid leaking it in activeControllers; on
    // the run path it is reused (do not re-register) and runAgentTurn owns cleanup.
    const settleAsNoop = (): void => {
      ready.resolve(noopAlbumWork);
      if (albumChatId !== undefined) {
        unregisterController(albumChatId, controller);
      }
    };
    if (stopped) {
      settleAsNoop();
      return;
    }

    // A control command in any album caption controls the chat. The album itself
    // does not run, so settle the reserved slot with a no-op.
    for (const part of parts) {
      const command = controlCommandFromCaption(part, ctx.me.username);
      if (command !== undefined) {
        settleAsNoop();
        await handleControlCommand(ctx, command);
        return;
      }
    }

    const primary = parts[0];
    const input = mergeTelegramMessageInputs(parts);
    if (primary === undefined || input === undefined) {
      settleAsNoop();
      await ctx.reply(messages.unsupportedText);
      return;
    }
    // Fill the reserved slot with the real run so the album executes in its
    // arrival-order position (a later same-chat text admitted after this album
    // started buffering lands behind this slot).
    ready.resolve(() => runAgentTurn(ctx, primary, input, controller));
  }

  async function runAgentTurn(
    ctx: Context,
    message: TelegramMessage,
    input: TelegramAgentMessageInput,
    controller: AbortController,
  ): Promise<void> {
    const chatId = message.chat.id;
    // The AbortController is created and registered in activeControllers by the
    // caller BEFORE admission, so a /cancel can abort a message still parked in the
    // per-chat queue (the controller would otherwise not exist until the queue
    // reached this run). This function owns unregistering it in the finally below.

    // Download attachment bytes (best-effort) before handing the request to the
    // responder. Failures skip the attachment; the run proceeds regardless. The
    // download is tied to this message's abort signal.
    let resolvedAttachments: Awaited<ReturnType<typeof downloadTelegramAttachments>> = [];
    if (input.attachments.length > 0 && !controller.signal.aborted) {
      const downloadOptions: DownloadTelegramAttachmentsOptions = {
        ...options.attachments,
        ...(logger !== undefined ? { logger } : {}),
      };
      resolvedAttachments = await downloadTelegramAttachments(
        input.attachments,
        fileDownloader,
        controller.signal,
        downloadOptions,
      );
    }

    const request = buildAgentRequest(
      ctx.update as unknown as TelegramUpdate,
      message as unknown as TelegramMessage,
      input,
      controller.signal,
      resolvedAttachments,
    );
    applyRuntimeSelection(chatId, request.metadata.telegram);
    const stream = new TelegramMessageStream(
      buildStreamOptions(chatId, message.message_id, controller.signal),
    );

    // Tracks the lifecycle reaction to apply on teardown. Defaults to "error" so
    // an unexpected throw still lands on the 👎 reaction.
    let reactionOutcome: "done" | "error" | "cancelled" = "error";
    // Whether we set the working 👀, so a terminal state with its own reaction
    // disabled can CLEAR it rather than leave it lingering on the message.
    let workingReacted = false;
    try {
      // Parked-then-cancelled: /cancel aborted this controller while the message
      // waited behind an earlier same-chat run. Bail before any responder call so a
      // queued message is genuinely cancelled (not run on the warm session later).
      if (controller.signal.aborted) {
        reactionOutcome = "cancelled";
        await finishCancelledUnlessAcknowledged(stream, controller.signal);
        return;
      }
      // Acknowledge receipt with the working reaction before the (slower) status
      // post + agent run, so the user sees the bot picked up the message at once.
      if (reactions?.working === true) {
        await applyReaction(chatId, message.message_id, REACTION_WORKING);
        workingReacted = true;
      }
      try {
        await stream.status(initialStatusText);
      } catch (statusError) {
        logger?.warn?.("Telegram initial status send failed; continuing to the agent run.", {
          error: errorMessage(statusError),
        });
      }
      if (controller.signal.aborted) {
        reactionOutcome = "cancelled";
        await finishCancelledUnlessAcknowledged(stream, controller.signal);
        return;
      }

      let response: AgentResponse;
      try {
        response = await options.responder.respond(request, stream);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          reactionOutcome = "cancelled";
          await finishCancelledUnlessAcknowledged(stream, controller.signal, error);
          return;
        }
        logger?.error?.("Telegram bot responder failed.", { error: errorMessage(error) });
        const errorText = await resolveErrorText({
          configured: messages.errorText,
          error,
          request,
          logger,
        });
        await finishSafely(stream, errorText, logger);
        return;
      }

      if (controller.signal.aborted) {
        reactionOutcome = "cancelled";
        await finishCancelledUnlessAcknowledged(stream, controller.signal);
        return;
      }

      try {
        await stream.finish(response.text);
        reactionOutcome = "done";
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          reactionOutcome = "cancelled";
          return;
        }
        // The AI run succeeded; a delivery failure is degraded, never an error.
        logger?.error?.("Telegram final delivery failed after a successful AI run.", {
          error: errorMessage(error),
        });
      }
    } finally {
      // Apply the terminal reaction: 👍 on success / 👎 on failure when that state
      // is enabled; otherwise (or on cancel) clear the working 👀 if we set one, so
      // a disabled terminal state never leaves the message marked "working".
      if (reactions !== undefined) {
        const terminalEnabled =
          reactionOutcome === "done"
            ? reactions.done
            : reactionOutcome === "error"
              ? reactions.error
              : false;
        if (terminalEnabled) {
          await applyReaction(
            chatId,
            message.message_id,
            reactionOutcome === "done" ? REACTION_DONE : REACTION_ERROR,
          );
        } else if (workingReacted) {
          await applyReaction(chatId, message.message_id, undefined);
        }
      }
      unregisterController(chatId, controller);
    }
  }

  /**
   * Run a proactive (externally triggered) turn on a chat: a cron/webhook nudge
   * routed here so the message becomes a REAL turn on this chat's own harness
   * (same session + history + per-chat queue as inbound messages), delivered
   * through the normal stream. No inbound message, so the request carries
   * sentinel ids and the stream posts top-level (no reply-to). Best-effort: a
   * failed or empty turn posts nothing rather than an unprompted error.
   */
  async function runProactiveTurn(
    chatId: TelegramChatId,
    text: string,
    controller: AbortController,
    silent: boolean,
    includeRuntimeSelection: boolean,
  ): Promise<TelegramNotifyResult> {
    try {
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled" };
      }
      const conversationId = `telegram:${String(chatId)}`;
      const telegramMetadata: AgentRequest["metadata"]["telegram"] = {
        updateId: 0,
        chat: { id: chatId },
        message: { id: 0 },
      };
      if (includeRuntimeSelection) {
        applyRuntimeSelection(chatId, telegramMetadata);
      }
      const request: AgentRequest = {
        conversationId,
        replyTo: { conversationId },
        chatId,
        messageId: 0,
        updateId: 0,
        text,
        abortSignal: controller.signal,
        metadata: {
          telegram: telegramMetadata,
        },
      };
      const stream = new TelegramMessageStream(buildStreamOptions(chatId, undefined, controller.signal, silent, false));
      let response: AgentResponse;
      try {
        response = await options.responder.respond(request, stream);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled" };
        }
        logger?.error?.("Telegram proactive notify failed.", { error: errorMessage(error) });
        return { delivered: false, reason: "responder failed" };
      }
      const answer = response.text;
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled" };
      }
      if (answer === undefined || answer.trim().length === 0) {
        return { delivered: false, reason: "agent produced no answer" };
      }
      try {
        await stream.finish(answer);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled" };
        }
        // The AI run succeeded; a delivery failure is degraded, never an error.
        logger?.error?.("Telegram proactive delivery failed after a successful AI run.", {
          error: errorMessage(error),
        });
        return { delivered: false, reason: "delivery failed" };
      }
      return { delivered: true };
    } finally {
      unregisterController(chatId, controller);
    }
  }

  /**
   * Deliver `text` VERBATIM to `chatId`: post it unchanged through the normal
   * stream with NO model call (the producing cron/webhook run already wrote the
   * message), then record it to the chat's durable history via the responder so a
   * later reply resumes with it in context. Serialized through the per-chat queue
   * by {@link notify}. Best-effort: a history-record failure never fails an
   * already-delivered post.
   */
  async function runVerbatimDelivery(
    chatId: TelegramChatId,
    text: string,
    controller: AbortController,
    silent: boolean,
  ): Promise<TelegramNotifyResult> {
    try {
      if (controller.signal.aborted) {
        return { delivered: false, reason: "cancelled" };
      }
      if (text.trim().length === 0) {
        return { delivered: false, reason: "empty notification" };
      }
      const stream = new TelegramMessageStream(buildStreamOptions(chatId, undefined, controller.signal, silent, false));
      try {
        await stream.finish(text);
      } catch (error) {
        if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
          return { delivered: false, reason: "cancelled" };
        }
        logger?.error?.("Telegram verbatim notify delivery failed.", { error: errorMessage(error) });
        return { delivered: false, reason: "delivery failed" };
      }
      try {
        await options.responder.deliverVerbatim?.(`telegram:${String(chatId)}`, text);
      } catch (error) {
        logger?.warn?.("Telegram verbatim notify history record failed.", { error: errorMessage(error) });
      }
      return { delivered: true };
    } finally {
      unregisterController(chatId, controller);
    }
  }

  /**
   * Deliver a proactive notification to `chatId` by running it as a turn on this
   * chat through the same per-chat admission queue as inbound messages, so it
   * serializes with live traffic on the same conversation.
   */
  async function notifyInternal(
    chatId: TelegramChatId,
    text: string,
    notifyOptions?: TelegramNotifyOptions,
    includeRuntimeSelection = false,
  ): Promise<TelegramNotifyResult> {
    if (stopped) {
      return { delivered: false, reason: "adapter stopped" };
    }
    const controller = registerController(chatId);
    const silent = notifyOptions?.silent === true;
    // `admit` returns void, so capture the run's outcome in a closure variable.
    // It defaults to the queue-full reason and is only overwritten when the task
    // actually runs (an over-cap rejection settles via onReject, leaving it).
    let outcome: TelegramNotifyResult = { delivered: false, reason: "chat at concurrency cap" };
    await admit(
      chatId,
      async () => {
        outcome = notifyOptions?.verbatim === true
          ? await runVerbatimDelivery(chatId, text, controller, silent)
          : await runProactiveTurn(chatId, text, controller, silent, includeRuntimeSelection);
      },
      () => {
        unregisterController(chatId, controller);
        logger?.warn?.("Telegram proactive notify dropped: chat is at its concurrency cap.", {
          chatId: String(chatId),
        });
      },
    );
    return outcome;
  }

  async function notify(
    chatId: TelegramChatId,
    text: string,
    notifyOptions?: TelegramNotifyOptions,
  ): Promise<TelegramNotifyResult> {
    // Public cron/webhook notifications intentionally retain configured runtime
    // defaults instead of inheriting a human's interactive chat selection.
    return await notifyInternal(chatId, text, notifyOptions, false);
  }

  async function notifyInteractive(chatId: TelegramChatId, text: string): Promise<TelegramNotifyResult> {
    // Custom command prompts and AskButtons fallbacks are interactive Telegram
    // turns even though they have no inbound Message object.
    return await notifyInternal(chatId, text, undefined, true);
  }

  async function handleControlCommand(
    ctx: Context,
    command: TelegramControlCommand,
  ): Promise<void> {
    if (command === "start") {
      await ctx.reply(messages.welcomeText);
      return;
    }
    if (command === "help") {
      await ctx.reply(messages.helpText);
      return;
    }
    if (command === "new") {
      await handleNewSessionCommand(ctx);
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      cancelChat(chatId);
    }
    await ctx.reply(messages.cancelledText);
  }

  function buildStreamOptions(
    chatId: TelegramChatId,
    replyToMessageId: number | undefined,
    signal: AbortSignal,
    silent = false,
    showHintsOverride?: boolean,
  ): TelegramMessageStreamOptions {
    const streamOptions: TelegramMessageStreamOptions = {
      api: sender,
      chatId,
      abortSignal: signal,
      // Default to "typing…" + final-answer-only delivery (no streamed interim
      // edits); a tuning override can restore interim streaming.
      finalOnly: options.stream?.finalOnly ?? true,
    };
    if (silent) {
      streamOptions.silent = true;
    }
    // Proactive notifications have no inbound message to reply to, so the caller
    // may omit replyToMessageId (a top-level send rather than a threaded reply).
    if (replyToMessageId !== undefined) {
      streamOptions.replyToMessageId = replyToMessageId;
    }
    const tuning = options.stream;
    if (tuning?.initialStatusText !== undefined) {
      streamOptions.initialStatusText = tuning.initialStatusText;
    }
    if (tuning?.editDebounceMs !== undefined) {
      streamOptions.editDebounceMs = tuning.editDebounceMs;
    }
    if (tuning?.maxMessageChars !== undefined) {
      streamOptions.maxMessageChars = tuning.maxMessageChars;
    }
    if (tuning?.maxSendRetries !== undefined) {
      streamOptions.maxSendRetries = tuning.maxSendRetries;
    }
    if (tuning?.retryCapMs !== undefined) {
      streamOptions.retryCapMs = tuning.retryCapMs;
    }
    if (tuning?.retryBaseDelayMs !== undefined) {
      streamOptions.retryBaseDelayMs = tuning.retryBaseDelayMs;
    }
    const showHints = showHintsOverride ?? tuning?.showHints;
    if (showHints !== undefined) {
      streamOptions.showHints = showHints;
    }
    if (tuning?.formatMarkdown !== undefined) {
      streamOptions.formatMarkdown = tuning.formatMarkdown;
    }
    if (logger !== undefined) {
      streamOptions.logger = logger;
    }
    return streamOptions;
  }

  let runnerHandle: RunnerHandle | undefined;
  // Pending auto-restart timer (set while backing off after a polling crash).
  // Cleared by stop() and before each restart so at most one restart is queued.
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  // Fires once a restarted runner has stayed up for the stability window, at
  // which point the backoff resets to the initial delay. Cleared on the next
  // crash/restart and on stop().
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  // Current restart backoff (ms). Doubles on each consecutive crash that recurs
  // before the stability window; resets to the initial delay on a clean restart.
  let restartBackoffMs = DEFAULT_RESTART_INITIAL_BACKOFF_MS;
  // Recovery requires both a runner that crossed the stability window and a
  // successful poll completed by that same runner.
  let stableRunner: RunnerHandle | undefined;
  let runnerPollGeneration = 0;
  // Poll-liveness watchdog. Lifetime-scoped (armed at first spawn, cleared on
  // stop()) so it spans crash/backoff/restart cycles. `pollWatchdogMs <= 0`
  // disables it. `watchdogRestarting` prevents a second tick from stacking
  // another stop()/spawn while a forced restart is still settling.
  const pollWatchdogMs = options.pollWatchdogMs ?? DEFAULT_POLL_WATCHDOG_MS;
  let pollWatchdogTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogRestarting = false;
  // True once polling has crashed and not yet recovered. Gates onPollingRecovered
  // so it fires only after a real crash→recovery cycle, never on the initial start.
  let pollingDegraded = false;
  handleSuccessfulPoll = () => {
    if (runnerHandle !== undefined) {
      maybeCompletePollingRecovery(runnerHandle);
    }
  };

  /** Arm the lifetime-scoped poll-liveness watchdog (idempotent, no-op if disabled). */
  function startPollWatchdog(): void {
    if (pollWatchdogMs <= 0 || pollWatchdogTimer !== undefined) {
      return;
    }
    // Check a few times per window so a stall is caught within ~1/3 of it.
    const checkMs = Math.max(1_000, Math.floor(pollWatchdogMs / 3));
    pollWatchdogTimer = setInterval(() => {
      checkPollLiveness();
    }, checkMs);
    pollWatchdogTimer.unref?.();
  }

  function clearPollWatchdog(): void {
    if (pollWatchdogTimer !== undefined) {
      clearInterval(pollWatchdogTimer);
      pollWatchdogTimer = undefined;
    }
  }

  /**
   * Force-restart the current runner if no getUpdates has resolved within the
   * watchdog window. This covers the case the crash monitor cannot: grammY's
   * runner self-retries getUpdates internally, so a degraded connection can stop
   * delivering updates WITHOUT the task rejecting. We only act on a runner that
   * reports running (a crashed/stopped one is handled by the crash monitor), and
   * we go through a clean stop() + respawn so the crash monitor is not tripped.
   */
  function checkPollLiveness(): void {
    if (stopped || watchdogRestarting) {
      return;
    }
    const current = runnerHandle;
    if (current?.isRunning() !== true) {
      return;
    }
    const stalledMs = Date.now() - lastPollMs;
    if (stalledMs < pollWatchdogMs) {
      return;
    }
    watchdogRestarting = true;
    // Reset the window up front so the replacement runner gets a full grace
    // period and a slow stop() cannot let a later tick re-trigger.
    lastPollMs = Date.now();
    logger?.warn?.("Telegram poll liveness stalled; force-restarting the runner.", {
      stalledMs,
      thresholdMs: pollWatchdogMs,
    });
    markPollingDegraded(new Error(
      `Telegram poll liveness stalled for ${stalledMs}ms (threshold ${pollWatchdogMs}ms).`,
    ));
    void Promise.resolve(current.stop())
      .catch(() => undefined)
      .finally(() => {
        watchdogRestarting = false;
        // Only respawn if nothing else swapped/stopped the runner meanwhile. A
        // watchdog restart is a clean recovery, so reset the backoff (mirrors a
        // stable restart) rather than inheriting the crash backoff.
        if (!stopped && runnerHandle === current) {
          restartBackoffMs = DEFAULT_RESTART_INITIAL_BACKOFF_MS;
          spawnRunnerWithMonitor();
        }
      });
  }

  /**
   * Spawn a runner and attach the crash monitor. The runner's task rejects when
   * long polling dies (e.g. getUpdates ETIMEDOUT/EADDRNOTAVAIL after a network
   * blip or host sleep). Without auto-restart the runner just stops and the bot
   * goes silent until a full process restart — so on a crash (while not stopped)
   * we recreate the runner via the factory and re-attach the monitor, with
   * exponential backoff. Mirrors slack-adapter's socket-mode reconnect loop.
   */
  function spawnRunnerWithMonitor(): void {
    if (stabilityTimer !== undefined) {
      clearTimeout(stabilityTimer);
      stabilityTimer = undefined;
    }
    // Give the (re)spawned runner a full watchdog window before it can be judged
    // stalled, and ensure the lifetime-scoped watchdog is armed.
    lastPollMs = Date.now();
    startPollWatchdog();
    stableRunner = undefined;
    activePollGeneration += 1;
    runnerPollGeneration = activePollGeneration;
    runnerHandle = (options.runnerFactory ?? defaultRunnerFactory)(bot);
    const spawned = runnerHandle;
    // A runner that stays up for the stability window counts as a clean restart:
    // reset the backoff so a LATER, unrelated crash starts from the initial delay
    // again. Recovery also requires a successful getUpdates resolution from THIS
    // runner; merely remaining inside grammY's retry loop is not healthy polling.
    stabilityTimer = setTimeout(() => {
      stabilityTimer = undefined;
      if (!stopped && runnerHandle === spawned) {
        stableRunner = spawned;
        maybeCompletePollingRecovery(spawned);
      }
    }, DEFAULT_RESTART_STABILITY_MS);
    stabilityTimer.unref?.();
    // Only a REJECTION is a crash: grammY's runner task rejects when long polling
    // dies (getUpdates ETIMEDOUT/EADDRNOTAVAIL). A clean resolution means the
    // runner was stopped deliberately (stop() / a host-driven stop), so it is NOT
    // auto-restarted — matching the original .catch-only handling.
    runnerHandle.task?.()?.catch((error: unknown) => { onPollingCrashed(error); });
  }

  /**
   * Handle a runner task REJECTION: long polling crashed. If the adapter is
   * stopped this is the expected teardown path (no-op). Otherwise surface it
   * (logger + onPollingError) and schedule a backoff restart so the bot recovers
   * instead of going silent until a full process restart.
   */
  function onPollingCrashed(error: unknown): void {
    // The runner is no longer up, so cancel the pending stability reset: the
    // backoff must keep growing if this crash recurs before a runner stays up.
    if (stabilityTimer !== undefined) {
      clearTimeout(stabilityTimer);
      stabilityTimer = undefined;
    }
    stableRunner = undefined;
    if (stopped) {
      return;
    }
    if (!pollingDegraded) {
      logger?.error?.("Telegram polling stopped with an error; scheduling restart.", {
        error: errorMessage(error),
        restartInMs: restartBackoffMs,
      });
      // Mark degraded so the stability-window callback fires onPollingRecovered
      // once a restarted runner proves a healthy poll. The adapter always restarts
      // (capped backoff), so a crash is "degraded, recovering" to the host — never
      // terminal.
      markPollingDegraded(error);
    }
    scheduleRestart();
  }

  /** Emit one degraded edge for the current outage, even across runner churn. */
  function markPollingDegraded(error: unknown): void {
    if (pollingDegraded) {
      return;
    }
    pollingDegraded = true;
    try {
      options.onPollingError?.(redactTelegramError(error, [options.botToken]));
    } catch {
      // Host diagnostics are untrusted; polling recovery is already scheduled.
    }
  }

  /** Reset backoff and emit recovery once stability and a real poll are proven. */
  function maybeCompletePollingRecovery(spawned: RunnerHandle): void {
    if (
      stopped ||
      runnerHandle !== spawned ||
      stableRunner !== spawned ||
      successfulPollGeneration !== runnerPollGeneration
    ) {
      return;
    }
    restartBackoffMs = DEFAULT_RESTART_INITIAL_BACKOFF_MS;
    if (!pollingDegraded) {
      return;
    }
    pollingDegraded = false;
    try {
      options.onPollingRecovered?.();
    } catch {
      // Host diagnostics must not destabilize a healthy polling runner.
    }
  }

  /** Schedule a single backoff restart, growing the backoff for the next attempt. */
  function scheduleRestart(): void {
    if (restartTimer !== undefined) {
      return;
    }
    const delay = restartBackoffMs;
    // Grow the backoff now so a restart that itself crashes before resetting (via
    // a healthy spawn) backs off further next time.
    restartBackoffMs = Math.min(DEFAULT_RESTART_MAX_BACKOFF_MS, restartBackoffMs * 2);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (stopped) {
        return;
      }
      try {
        spawnRunnerWithMonitor();
      } catch (error) {
        // The factory threw synchronously (e.g. transient construction failure):
        // back off and try again rather than giving up.
        logger?.error?.("Telegram polling restart failed; backing off.", {
          error: errorMessage(error),
        });
        scheduleRestart();
      }
    }, delay);
    // Never let the restart timer keep the process alive on its own.
    restartTimer.unref?.();
  }

  // Tool-progress status messages, keyed `chat:key` → message_id for edit-in-place.
  const statusMessages = new Map<string, number>();

  return {
    bot,
    notify,
    async postStatus(chatId, text, statusOptions): Promise<void> {
      const key = `${String(chatId)}:${statusOptions.key}`;
      try {
        const existing = statusMessages.get(key);
        if (existing === undefined) {
          const sent = await sender.sendMessage({ chat_id: chatId, text });
          statusMessages.set(key, sent.message_id);
        } else {
          await sender.editMessageText({ chat_id: chatId, message_id: existing, text });
        }
      } catch (error) {
        // Best-effort by contract: a lost progress edit must never fail the
        // reporting tool (e.g. "message is not modified" on identical text).
        logger?.debug?.("Telegram postStatus failed (best-effort).", {
          error: errorMessage(error),
        });
      } finally {
        if (statusOptions.state !== "working") {
          statusMessages.delete(key);
        }
      }
    },
    presentAsk,
    updateAsk,
    activeControllerCount(): number {
      let total = 0;
      for (const set of activeControllers.values()) {
        total += set.size;
      }
      return total;
    },
    async start(): Promise<void> {
      if (runnerHandle?.isRunning() === true) {
        return;
      }
      // Re-arm message handling on a genuine (re)start: a prior stop() latches
      // `stopped = true`, and handleAgentMessage/flushAlbum early-return while it
      // is set. Resetting here (after the already-running no-op guard, before any
      // update can be dispatched by the new runner) means a restart actually
      // handles messages again instead of silently dropping every one.
      stopped = false;
      restartBackoffMs = DEFAULT_RESTART_INITIAL_BACKOFF_MS;
      // Clear any crash flag left over from a previous session: onPollingRecovered
      // must only fire for a crash→recovery within THIS run, never for a stale
      // crash that preceded a stop()/start() cycle.
      pollingDegraded = false;
      if ((options.deleteWebhookOnStart ?? true) === true) {
        // Bound + best-effort: the host awaits start() before reporting ready, so
        // an unbounded deleteWebhook over a flaky network could hang ~50s (the Api
        // client timeout) and blow past the launcher's readiness deadline. Cap it
        // and never reject so boot proceeds. This is safe for a polling bot with no
        // webhook configured (the call is a no-op). NOTE: if a webhook genuinely IS
        // set and this call is skipped/times out, getUpdates returns 409 and the
        // runner crash-restarts on a backoff — the backoff path does NOT re-issue
        // deleteWebhook, so polling only resumes once the webhook is cleared (a
        // later full start(), or its natural expiry). Deployments that use webhooks
        // should not rely on this fallback.
        try {
          // grammY types `signal` with the abort-controller shim, not the global
          // AbortSignal; the runtime value is identical (cf. grammy-client.ts).
          const timeoutSignal = AbortSignal.timeout(
            options.deleteWebhookTimeoutMs ?? DEFAULT_DELETE_WEBHOOK_TIMEOUT_MS,
          ) as unknown as Parameters<typeof bot.api.deleteWebhook>[1];
          await bot.api.deleteWebhook(
            { drop_pending_updates: options.dropPendingUpdates ?? false },
            timeoutSignal,
          );
        } catch (error) {
          logger?.warn?.("Telegram deleteWebhook failed or timed out at startup; continuing to poll.", {
            error: errorMessage(error),
          });
        }
      }
      // Register the command menu when host-backed controls are available.
      // Best-effort + bounded so a flaky network can't stall boot.
      if (options.startNewSession !== undefined || customCommands.length > 0 || runtimeCatalog !== undefined) {
        const menu = [
          { command: "help", description: "How to use this agent" },
          { command: "cancel", description: "Stop the current response" },
          ...(options.startNewSession === undefined
            ? []
            : [{ command: "new", description: "Start a fresh conversation session" }]),
          ...(runtimeCatalog === undefined
            ? []
            : [
                { command: "model", description: "Choose a model for this chat" },
                { command: "effort", description: "Choose reasoning effort" },
              ]),
          ...customCommands.map((command) => ({
            command: command.command,
            description: command.description,
          })),
        ];
        try {
          const timeoutSignal = AbortSignal.timeout(
            options.deleteWebhookTimeoutMs ?? DEFAULT_DELETE_WEBHOOK_TIMEOUT_MS,
          ) as unknown as Parameters<typeof bot.api.setMyCommands>[2];
          await bot.api.setMyCommands(menu, { scope: { type: "all_private_chats" } }, timeoutSignal);
        } catch (error) {
          logger?.warn?.("Telegram setMyCommands failed or timed out at startup; continuing.", {
            error: errorMessage(error),
          });
        }
      }
      // Spawn the runner with the auto-restart monitor attached: a late polling
      // crash is surfaced (logger + onPollingError) AND triggers a backoff
      // restart instead of leaving the bot silent. stop() settles the runner and
      // cancels any pending restart independently.
      spawnRunnerWithMonitor();
    },
    async stop(): Promise<void> {
      // Guard the timer/late-update paths first: a pending album timer must not
      // flush a turn after teardown. Clear every outstanding album timer and drop
      // the buffers (mirrors cancelChat's per-chat cleanup, but for all chats).
      stopped = true;
      // Cancel any pending auto-restart so a backoff timer cannot resurrect the
      // runner after shutdown. The `stopped` flag also short-circuits the monitor
      // and the timer callback, so a restart in flight when stop() runs is a no-op.
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      if (stabilityTimer !== undefined) {
        clearTimeout(stabilityTimer);
        stabilityTimer = undefined;
      }
      stableRunner = undefined;
      clearPollWatchdog();
      for (const buffer of albumBuffers.values()) {
        clearTimeout(buffer.timer);
        // Settle the reserved admission slot so the parked admit() task does not
        // hang the per-chat queue after teardown (no turn fires: stopped guard +
        // no-op work).
        buffer.ready.resolve(noopAlbumWork);
      }
      albumBuffers.clear();
      if (runnerHandle?.isRunning() === true) {
        await runnerHandle.stop();
      }
      runnerHandle = undefined;
      // Close any in-flight socket on the family-pinned agent (no-op when the
      // default dual-stack transport is used and no agent was created).
      transportAgent?.destroy();
    },
  };

  function defaultRunnerFactory(target: Bot): RunnerHandle {
    const defaultAllowed = callbackHandlersEnabled ? ["message", "callback_query"] : ["message"];
    const configuredAllowed = [...(options.allowedUpdates ?? defaultAllowed)];
    if (runtimeCatalog !== undefined && !configuredAllowed.includes("callback_query")) {
      configuredAllowed.push("callback_query");
    }
    const allowed = configuredAllowed as unknown as AllowedUpdates;
    return run(target, {
      runner: {
        // Self-retry transient getUpdates errors (network blips) with exponential
        // backoff before the task rejects and the monitor restarts the runner.
        // grammY otherwise prints the full nested transport error via
        // console.error, which can include the credential-bearing Bot API URL.
        // Terminal failures still flow through the adapter's redacted logger.
        silent: true,
        retryInterval: "exponential",
        maxRetryTime: DEFAULT_RUNNER_MAX_RETRY_TIME_MS,
        fetch: {
          allowed_updates: allowed,
          // Bound the long-poll below the Api client HTTP timeout so a stalled
          // socket fails fast instead of hanging on grammY's 500s default.
          timeout: DEFAULT_LONG_POLL_TIMEOUT_SECONDS,
        },
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return redactTelegramErrorMessage(error);
}

/** A promise plus its resolver, for an externally-settled deferred value. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Build the grammY client options for the default Bot construction. Extracted
 * (and exported) so the apiRoot/agent interplay is unit-testable — the botFactory
 * test seam otherwise owns the whole construction.
 *
 * grammY's node platform fetches with node-fetch, which rejects an agent whose
 * protocol mismatches the URL — so the family-locked keep-alive-off agent (see
 * the ipFamily rationale on {@link CreateTelegramBotOptions.transport}) must be
 * an `http.Agent` when the apiRoot is plain http (a loopback self-hosted server)
 * and an `https.Agent` otherwise.
 */
export function buildTelegramBotClientOptions(options: {
  readonly apiRoot?: string;
  readonly ipFamily?: 4 | 6;
}): { client: BotClientOptions; agent?: HttpAgent | HttpsAgent } {
  const client: BotClientOptions = { timeoutSeconds: DEFAULT_API_TIMEOUT_SECONDS };
  if (options.apiRoot !== undefined) {
    client.apiRoot = options.apiRoot;
  }
  if (options.ipFamily === undefined) {
    return { client };
  }
  const agentOptions = { family: options.ipFamily, keepAlive: false };
  const agent = options.apiRoot?.startsWith("http://") === true
    ? new HttpAgent(agentOptions)
    : new HttpsAgent(agentOptions);
  client.baseFetchConfig = { ...client.baseFetchConfig, agent };
  return { client, agent };
}

interface DefaultFileDownloaderOptions {
  /** Per-file download timeout (ms), composed with the run abort signal. Default 30000. */
  readonly downloadTimeoutMs?: number;
  /** Self-hosted Bot API server base URL; replaces api.telegram.org in file URLs. */
  readonly apiRoot?: string;
  readonly logger?: TelegramAdapterLogger;
}

/**
 * Default {@link TelegramFileDownloader}: resolve a `file_id` to a `file_path`
 * via `bot.api.getFile`, then download it from the Telegram file URL
 * (`https://api.telegram.org/file/bot<token>/<file_path>`) with `fetch`. Both
 * calls honor the request abort signal.
 *
 * The download is hardened against oversized/stale-`file_size` bodies: a
 * `Content-Length` header over the cap is rejected before reading the body, and
 * the body is streamed with a running byte counter that cancels the reader the
 * moment the cap is exceeded (so the whole payload is never buffered first). A
 * `downloadTimeoutMs` timer is composed with the run signal so a stalled
 * transfer is bounded by a dedicated timeout, not just the overall run.
 */
function createDefaultFileDownloader(
  bot: Bot,
  token: string,
  options?: DefaultFileDownloaderOptions,
): TelegramFileDownloader {
  const timeoutMs = options?.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return {
    async resolveFilePath(fileId, signal): Promise<string | undefined> {
      const file = await bot.api.getFile(fileId, signal as unknown as Parameters<typeof bot.api.getFile>[1]);
      return file.file_path;
    },
    async download(filePath, signal, maxBytes): Promise<Uint8Array> {
      // A `--local` self-hosted server downloads the file itself during getFile
      // and returns an ABSOLUTE path; the /file/ HTTP route is unavailable in
      // that mode, so the bytes are read straight from disk. Hosted and
      // non-local self-hosted servers return relative paths served over HTTP.
      if (isAbsolute(filePath)) {
        return await readLocalTelegramFile(filePath, signal, maxBytes, options?.logger);
      }
      const url = `${options?.apiRoot ?? "https://api.telegram.org"}/file/bot${token}/${filePath}`;
      const { signal: fetchSignal, cleanup } = composeDownloadSignal(signal, timeoutMs);
      try {
        const response = await fetch(url, fetchSignal === undefined ? {} : { signal: fetchSignal });
        if (!response.ok) {
          throw new Error(`Telegram file download failed with status ${response.status}.`);
        }
        // Early skip: a declared Content-Length over the cap means we never read
        // the body at all (the adapter turns the throw into a logged skip).
        if (maxBytes !== undefined) {
          const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error("Telegram file exceeded the configured byte cap (Content-Length).");
          }
        }
        return await readBodyWithCap(response, maxBytes);
      } finally {
        cleanup();
      }
    },
  };
}

/**
 * Read a `--local` Bot API server file from disk. The stat-before-read is the
 * local analog of the Content-Length early-skip (the declared file_size in the
 * update can be stale). A consumed read deletes the daemon's copy: the daemon
 * keeps downloads for up to ~25h, the harness persists its own copy into the
 * attachments dir before the model sees it, and getFile re-downloads on demand —
 * so the daemon file is a drained cache. Skip paths (over-cap, missing) never
 * delete.
 */
async function readLocalTelegramFile(
  filePath: string,
  signal: AbortSignal | undefined,
  maxBytes: number | undefined,
  logger: TelegramAdapterLogger | undefined,
): Promise<Uint8Array> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Telegram local file is missing (expired from the Bot API server cache?).");
    }
    throw error;
  }
  if (maxBytes !== undefined && size > maxBytes) {
    throw new Error("Telegram file exceeded the configured byte cap (local file size).");
  }
  const bytes = await readFile(filePath, signal === undefined ? {} : { signal });
  await unlink(filePath).catch((error: unknown) => {
    logger?.debug?.("Telegram local file cleanup failed (best-effort).", {
      error: redactTelegramErrorMessage(error),
    });
  });
  return new Uint8Array(bytes);
}

/**
 * Compose a `downloadTimeoutMs` timer with the run abort signal into a single
 * signal for `fetch`. The returned `cleanup` clears the timer (and detaches the
 * forwarding listener) in every path so no timer leaks/keeps the loop alive.
 */
function composeDownloadSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal?: AbortSignal; cleanup: () => void } {
  const shouldUseTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!shouldUseTimeout) {
    if (externalSignal === undefined) {
      return { cleanup: () => undefined };
    }
    return { signal: externalSignal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Telegram file download timed out."));
  }, timeoutMs);
  timer.unref?.();

  const forwardAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

/**
 * Read a response body into a single `Uint8Array`, rejecting once `maxBytes` is
 * exceeded. Streams the body where possible so an oversized file is abandoned
 * without buffering the whole thing; falls back to an `arrayBuffer()` read (still
 * cap-checked) when the runtime exposes no readable stream.
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  const cap =
    maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : undefined;

  const body = response.body;
  if (body === null || typeof body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (cap !== undefined && bytes.byteLength > cap) {
      throw new Error("Telegram file exceeded the configured byte cap.");
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (cap !== undefined && total > cap) {
        await reader.cancel();
        throw new Error("Telegram file exceeded the configured byte cap.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Resolve the label of the button whose `callback_data` matches `data` by reading
 * the tapped message's own inline keyboard. Returns undefined when the keyboard or
 * a matching button is absent. Pure so it can be unit-tested directly.
 */
function labelForCallbackData(replyMarkup: unknown, data: string): string | undefined {
  const keyboard = (
    replyMarkup as
      | { inline_keyboard?: ReadonlyArray<ReadonlyArray<{ text?: unknown; callback_data?: unknown }>> }
      | undefined
  )?.inline_keyboard;
  if (!Array.isArray(keyboard)) {
    return undefined;
  }
  for (const row of keyboard) {
    for (const button of row) {
      if (button?.callback_data === data && typeof button.text === "string") {
        return button.text;
      }
    }
  }
  return undefined;
}

function controlCommandFromCaption(
  message: TelegramMessage,
  botUsername: string | undefined,
): TelegramControlCommand | undefined {
  if (message.text !== undefined || message.caption === undefined) {
    return undefined;
  }
  const match = message.caption.trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/u);
  const command = match?.[1]?.toLowerCase();
  const target = match?.[2]?.toLowerCase();
  if (target !== undefined) {
    if (botUsername === undefined || target !== botUsername.toLowerCase()) {
      return undefined;
    }
  }
  return command === "start" || command === "help" || command === "cancel" || command === "new"
    ? command
    : undefined;
}
