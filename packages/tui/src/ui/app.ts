// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";

import {
  Container,
  Editor,
  Markdown,
  matchesKey,
  Text,
  TUI,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  availableOperatorActions,
  assertOperatorIdentity,
  evaluateOperatorRuntimeOverride,
  initialOperatorState,
  OPERATOR_LIMITS,
  parseTurnRequest,
  reduceOperatorFrame,
  type OperatorAction,
  type OperatorAskAnswerRequest,
  type OperatorClient,
  type OperatorConversationState,
  type OperatorAttachment,
  type DiscoveredOperator,
  type OperatorFrame,
  type OperatorInfo,
  type OperatorQuote,
} from "@mono-agent/operator";

import { parseTuiAskAnswer } from "./ask-answer.js";
import {
  attachmentMediaType,
  buildTurnRequest,
  boundedStatus,
  boundedView,
  errorMessage,
  latestActivity,
  toolResultText,
} from "./format.js";
import { editorTheme, markdownTheme, style } from "./theme.js";
import { sanitizeTerminalText } from "./terminal-text.js";

const MAX_INLINE_ATTACHMENT_BYTES = 512 * 1_024;
const MAX_TRANSCRIPT_CHILDREN = 256;
export interface MonoAgentTuiAppOptions {
  readonly terminal: Terminal;
  readonly client: OperatorClient;
  readonly conversationId: string;
  readonly title?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Present only for registry discovery; binds endpoint responses to that descriptor. */
  readonly discoveredOperator?: DiscoveredOperator;
}

/** Terminal-only presentation over the shared operator client and reducer. */
export class MonoAgentTuiApp {
  private readonly options: MonoAgentTuiAppOptions;
  private readonly tui: TUI;
  private readonly transcript = new Container();
  private readonly header = new Text();
  private readonly status = new Text();
  private readonly editor: Editor;
  private state: OperatorConversationState;
  private info: OperatorInfo | undefined;
  private assistant: Markdown | undefined;
  private turnAbort: AbortController | undefined;
  private preflightAbort: AbortController | undefined;
  private turnStarting = false;
  private runtimeOverride: string | undefined;
  private modelOverride: string | undefined;
  private effortOverride: string | undefined;
  private attachments: OperatorAttachment[] = [];
  private quote: OperatorQuote | undefined;
  private stopped = false;
  private exitResolve: (() => void) | undefined;
  private readonly exitPromise: Promise<void>;

  constructor(options: MonoAgentTuiAppOptions) {
    this.options = options;
    this.state = initialOperatorState(options.conversationId);
    this.runtimeOverride = options.runtime;
    this.modelOverride = options.model;
    this.effortOverride = options.effort;
    this.tui = new TUI(options.terminal);
    this.editor = new Editor(this.tui, editorTheme);
    this.editor.onSubmit = (value) => { void this.submit(value); };
    this.exitPromise = new Promise((resolve) => { this.exitResolve = resolve; });

    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.addInputListener((data) => this.handleGlobalInput(data));
  }

  async start(): Promise<void> {
    this.tui.start();
    this.tui.setFocus(this.editor);
    this.setStatus("connecting…");
    try {
      const info = await this.options.client.getInfo();
      if (this.options.discoveredOperator !== undefined) {
        assertOperatorIdentity(this.options.discoveredOperator, info);
      }
      this.info = info;
      this.validateInitialOverrides();
      this.renderHeader();
      this.setStatus(this.statusText("ready"));
    } catch (error) {
      this.addNotice(errorMessage(error), "error");
      this.setStatus("connection failed · /exit closes the renderer");
      throw error;
    } finally {
      this.tui.requestRender();
    }
  }

  async waitUntilExit(): Promise<void> {
    await this.exitPromise;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Disconnecting a stream can cancel that turn at the channel boundary;
    // this product never sends an agent-process or service stop request.
    this.turnAbort?.abort("renderer exited");
    this.preflightAbort?.abort("renderer exited");
    this.turnAbort = undefined;
    this.preflightAbort = undefined;
    this.tui.stop();
    this.exitResolve?.();
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, "escape")) {
      if (this.turnAbort !== undefined) void this.cancelTurn();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.turnAbort !== undefined) void this.cancelTurn();
      else this.stop();
      return { consume: true };
    }
    return undefined;
  }

  private async submit(raw: string): Promise<void> {
    const value = raw.trim();
    if (value.length === 0 || this.stopped) return;
    this.editor.setText("");
    this.editor.addToHistory(value);

    if (value.startsWith("/")) {
      await this.command(value.slice(1));
      return;
    }
    if (this.turnStarting) {
      this.addNotice("A turn is starting; wait for identity verification to finish.", "warning");
      return;
    }
    if (this.turnAbort !== undefined) {
      await this.offerLiveInput(value);
      return;
    }
    await this.runTurn(value);
  }

  private async command(value: string): Promise<void> {
    const [name = "", ...rest] = value.split(/\s+/u);
    const argument = rest.join(" ").trim();
    switch (name.toLowerCase()) {
      case "exit":
      case "quit":
        this.stop();
        return;
      case "cancel":
        await this.cancelTurn();
        return;
      case "runtime":
        this.setRuntime(argument);
        return;
      case "model":
        this.setModel(argument);
        return;
      case "effort":
        this.setEffort(argument);
        return;
      case "answer":
        await this.answerAsk(argument);
        return;
      case "attach":
        await this.attachFile(argument);
        return;
      case "quote":
        this.setQuote(argument);
        return;
      case "send":
        await this.runTurn(argument);
        return;
      case "replay":
        await this.showReplay();
        return;
      case "config":
        await this.showConfig();
        return;
      case "health":
        await this.showHealth();
        return;
      case "help":
        this.addNotice('/attach <path> · /quote <message-id>[=<text>] · /send [text] · /replay · /config · /health · /runtime <instance|default> · /model <ref|default> · /effort <level|default> · /answer {"question":"value","other":["value"]} · /cancel · /exit');
        return;
      default:
        this.addNotice(`Unknown command /${name}. Run /help.`, "warning");
    }
  }

  private async runTurn(text: string): Promise<void> {
    if (this.turnStarting || this.turnAbort !== undefined) {
      this.addNotice("A turn is starting or already active; wait for it to finish or cancel it.", "warning");
      return;
    }
    this.turnStarting = true;
    try {
      await this.refreshDiscoveredIdentity();
    } catch (error) {
      if (!this.stopped) {
        this.addNotice(errorMessage(error), "error");
        this.setStatus("identity verification failed · turn not started");
      }
      return;
    } finally {
      this.turnStarting = false;
    }
    if (this.stopped) return;
    if (!this.can("start_turn")) {
      this.addNotice("The selected agent is not ready to start a turn.", "warning");
      return;
    }
    if (text.length === 0 && this.attachments.length === 0) {
      this.addNotice("Enter text or queue an attachment before sending.", "warning");
      return;
    }
    if (this.attachments.length > 0 && !this.can("attach")) {
      this.addNotice("Queued attachments are no longer accepted by this agent.", "warning");
      return;
    }
    if (this.quote !== undefined && !this.can("quote")) {
      this.addNotice("The selected agent no longer accepts quotes.", "warning");
      return;
    }
    const turnAttachments = [...this.attachments];
    const turnQuote = this.quote;
    const request = buildTurnRequest(text, turnAttachments, turnQuote, {
      conversationId: this.options.conversationId,
      ...(this.runtimeOverride === undefined ? {} : { runtime: this.runtimeOverride }),
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
      metadata: { source: "tui" },
    });
    if (Buffer.byteLength(JSON.stringify(request)) > OPERATOR_LIMITS.requestBytes) {
      this.addNotice("Queued input exceeds the shared operator request bound; remove an attachment or shorten the text.", "warning");
      return;
    }
    const inputSummary = [
      text,
      turnAttachments.length === 0 ? "" : `[attachments: ${turnAttachments.map((item) => item.name).join(", ")}]`,
      turnQuote === undefined ? "" : `[quote: ${turnQuote.messageId}]`,
    ].filter(Boolean).join("\n");
    this.addTranscriptChild(new Text(
      style.user(`you  ${sanitizeTerminalText(inputSummary, { multiline: true })}`),
      1,
      1,
    ));
    this.assistant = new Markdown("", 1, 0, markdownTheme, { color: style.assistant });
    this.addTranscriptChild(this.assistant);
    const controller = new AbortController();
    this.turnAbort = controller;
    this.setStatus(this.statusText("starting turn…"));

    try {
      let accepted = false;
      const frames = this.options.client.streamTurn(request, { signal: controller.signal });
      for await (const frame of frames) {
        if (frame.type === "accepted" && !accepted) {
          accepted = true;
          this.attachments = [];
          this.quote = undefined;
        }
        this.state = reduceOperatorFrame(this.state, frame);
        this.present(frame);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.addNotice(errorMessage(error), "error");
        this.setStatus(this.statusText("turn failed"));
      }
    } finally {
      if (this.turnAbort === controller) this.turnAbort = undefined;
      this.assistant = undefined;
      this.tui.requestRender();
    }
  }

  private async refreshDiscoveredIdentity(): Promise<void> {
    const expected = this.options.discoveredOperator;
    if (expected === undefined) return;
    const controller = new AbortController();
    this.preflightAbort = controller;
    try {
      const info = await this.options.client.getInfo(controller.signal);
      assertOperatorIdentity(expected, info);
      const decision = evaluateOperatorRuntimeOverride(info, {
        ...(this.runtimeOverride === undefined ? {} : { runtime: this.runtimeOverride }),
        ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
        ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
      });
      if (!decision.allowed) throw new Error(decision.message);
      this.info = info;
      this.runtimeOverride = decision.intent.runtime;
      this.modelOverride = decision.intent.model;
      this.effortOverride = decision.intent.effort;
      this.renderHeader();
    } finally {
      if (this.preflightAbort === controller) this.preflightAbort = undefined;
    }
  }

  private renderHeader(): void {
    this.header.setText(style.bold(style.accent(
      `${sanitizeTerminalText(this.options.title ?? "mono-agent")} · ${sanitizeTerminalText(this.info!.agent.label)}`,
    )));
    this.tui.requestRender();
  }

  private present(frame: OperatorFrame): void {
    switch (frame.type) {
      case "accepted":
        this.setStatus(this.statusText(`turn ${frame.turnId} streaming`));
        break;
      case "delta":
        if (frame.target === "assistant") {
          this.assistant?.setText(sanitizeTerminalText(this.state.assistantText, { multiline: true }));
        }
        this.setStatus(this.statusText(
          frame.target === "thought"
            ? `reasoning… ${boundedStatus(frame.text)}`
            : latestActivity(this.state, "streaming…"),
        ));
        break;
      case "activity":
        this.setStatus(this.statusText(frame.text));
        break;
      case "tool_call":
        this.addNotice(boundedView(
          `tool ${frame.call.name} started\n${frame.call.inputOmitted
            ? "[input omitted by operator boundary]"
            : JSON.stringify(frame.call.input, null, 2)}`,
        ));
        this.setStatus(this.statusText(`calling ${frame.call.name}…`));
        break;
      case "tool_result":
        this.addNotice(
          boundedView(`tool ${frame.result.callId} ${frame.result.isError === true ? "failed" : "completed"}\n${toolResultText(frame.result)}`),
          frame.result.isError === true ? "warning" : "info",
        );
        this.setStatus(this.statusText(
          `tool ${frame.result.callId} ${frame.result.isError === true ? "failed" : "completed"}`,
        ));
        break;
      case "compaction": {
        const counts = frame.compaction.tokensBefore === undefined
          ? ""
          : ` · ${String(frame.compaction.tokensBefore)} → ${String(frame.compaction.tokensAfter ?? "?")} tokens`;
        const label = frame.compaction.compacted ? "context compacted" : "context compaction skipped";
        this.addNotice(`${label}${counts}`);
        this.setStatus(this.statusText(`${label}${counts}`));
        break;
      }
      case "ask_user":
        this.addAsk(frame);
        this.setStatus(this.statusText('awaiting answer · /answer {"q":"v","q2":["v1","v2"]}'));
        break;
      case "capabilities":
        this.setStatus(this.statusText("capabilities updated"));
        break;
      case "usage": {
        const total = frame.usage.inputTokens + frame.usage.outputTokens;
        const context = frame.usage.contextUsed === undefined || frame.usage.contextWindow === undefined
          ? ""
          : ` · context ${String(frame.usage.contextUsed)}/${String(frame.usage.contextWindow)}`;
        this.setStatus(this.statusText(`${String(total)} tokens${context}`));
        break;
      }
      case "completed":
        this.assistant?.setText(sanitizeTerminalText(
          this.state.assistantText || frame.finalMessage.text,
          { multiline: true },
        ));
        this.setStatus(this.statusText(`completed · ${frame.stopReason}`));
        break;
      case "error":
        this.addNotice(frame.error.message, frame.cancelled ? "warning" : "error");
        this.setStatus(this.statusText(frame.cancelled ? "cancelled" : `error · ${frame.error.code}`));
        break;
    }
    this.tui.requestRender();
  }

  private addAsk(frame: Extract<OperatorFrame, { type: "ask_user" }>): void {
    const lines = [
      ...frame.ask.questions.flatMap((question) => [
        `? ${sanitizeTerminalText(question.id)}: ${sanitizeTerminalText(question.prompt, { multiline: true })}`,
        ...(question.choices ?? []).map((choice) =>
          `    ${sanitizeTerminalText(choice.value)} — ${sanitizeTerminalText(choice.label)}`
        ),
        `    ${question.multiple ? "choose one or more" : "choose one"}${question.allowFreeText ? " · free text accepted" : ""}`,
      ]),
      "Answer every question in one command:",
      '    /answer {"question":"value","other-question":["value-1","value-2"]}',
      "Legacy question=value; other=value remains available for simple values.",
    ];
    this.addTranscriptChild(new Text(style.warning(lines.join("\n")), 1, 1));
  }

  private async offerLiveInput(text: string): Promise<void> {
    if (!this.can("offer_live_input")) {
      this.addNotice("A turn is active and this agent does not accept live input.", "warning");
      return;
    }
    try {
      const result = await this.options.client.offerLiveInput(this.options.conversationId, {
        id: crypto.randomUUID(),
        text,
        receivedAt: new Date().toISOString(),
      });
      this.addNotice(`live input ${result.status}`);
    } catch (error) {
      if (!this.stopped) this.addNotice(errorMessage(error), "warning");
    }
  }

  private async cancelTurn(): Promise<void> {
    if (this.turnAbort === undefined) {
      this.addNotice("No turn is active.", "warning");
      return;
    }
    if (!this.can("cancel_turn")) {
      this.addNotice("The selected agent does not permit cancellation.", "warning");
      return;
    }
    const result = await this.options.client.cancelConversation(
      this.options.conversationId,
      { reason: "operator cancelled from TUI" },
    ).catch((error: unknown) => {
      this.addNotice(errorMessage(error), "warning");
      return undefined;
    });
    if (result?.status === "accepted") {
      // Keep consuming the shared stream until its authoritative cancelled
      // terminal frame reaches the shared reducer.
      this.setStatus(this.statusText("cancelling…"));
    } else if (result !== undefined) {
      this.addNotice(`cancel ${result.status}`, "warning");
    }
  }

  private setRuntime(value: string): void {
    if (!this.can("set_runtime")) {
      this.addNotice("The selected agent does not permit runtime overrides.", "warning");
      return;
    }
    if (value.length === 0) {
      this.addNotice("Use /runtime <configured-instance|default>.", "warning");
      return;
    }
    const decision = evaluateOperatorRuntimeOverride(this.info!, {
      ...(value === "default" ? {} : { runtime: value }),
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
    });
    if (!decision.allowed) {
      this.addNotice(decision.message, "warning");
      return;
    }
    this.runtimeOverride = decision.intent.runtime;
    this.modelOverride = decision.intent.model;
    this.effortOverride = decision.intent.effort;
    this.setStatus(this.statusText(value === "default" ? "runtime override cleared" : `runtime ${value}`));
  }

  private setModel(value: string): void {
    if (!this.can("set_model")) {
      this.addNotice("The selected agent does not permit model overrides.", "warning");
      return;
    }
    if (value.length === 0) {
      const choices = this.info?.models?.map((model) => model.id).join(", ");
      this.addNotice(choices === undefined
        ? "No model allowlist advertised; enter a non-empty model reference."
        : `Models: ${choices.length === 0 ? "none advertised" : choices}`);
      return;
    }
    const decision = evaluateOperatorRuntimeOverride(this.info!, {
      ...(this.runtimeOverride === undefined ? {} : { runtime: this.runtimeOverride }),
      ...(value === "default"
        ? {}
        : {
            model: value,
            ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
          }),
    });
    if (!decision.allowed) {
      this.addNotice(decision.message, "warning");
      return;
    }
    this.runtimeOverride = decision.intent.runtime;
    this.modelOverride = decision.intent.model;
    this.effortOverride = decision.intent.effort;
    if (value === "default") this.effortOverride = undefined;
    this.setStatus(this.statusText(value === "default" ? "model override cleared" : `model ${value}`));
  }

  private validateInitialOverrides(): void {
    const decision = evaluateOperatorRuntimeOverride(this.info!, {
      ...(this.runtimeOverride === undefined ? {} : { runtime: this.runtimeOverride }),
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
    });
    if (!decision.allowed) {
      throw new Error(decision.message);
    }
    this.runtimeOverride = decision.intent.runtime;
    this.modelOverride = decision.intent.model;
    this.effortOverride = decision.intent.effort;
  }

  private setEffort(value: string): void {
    if (!this.can("set_effort")) {
      this.addNotice("The selected agent does not permit effort overrides.", "warning");
      return;
    }
    const effectiveModel = this.modelOverride ?? this.info?.defaults?.model;
    const efforts = this.info?.models?.find((model) => model.id === effectiveModel)?.efforts;
    if (value.length === 0) {
      this.addNotice(efforts === undefined
        ? "No effort allowlist advertised; enter a non-empty effort value."
        : `Effort levels: ${efforts.length === 0 ? "none advertised" : efforts.join(", ")}`);
      return;
    }
    const decision = evaluateOperatorRuntimeOverride(this.info!, {
      ...(this.runtimeOverride === undefined ? {} : { runtime: this.runtimeOverride }),
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(value === "default" ? {} : { effort: value }),
    });
    if (!decision.allowed) {
      this.addNotice(decision.message, "warning");
      return;
    }
    this.runtimeOverride = decision.intent.runtime;
    this.modelOverride = decision.intent.model;
    this.effortOverride = decision.intent.effort;
    this.setStatus(this.statusText(value === "default" ? "effort override cleared" : `effort ${value}`));
  }

  private async answerAsk(value: string): Promise<void> {
    if (!this.can("answer_ask") || this.state.pendingAsk === undefined) {
      this.addNotice("There is no answerable question.", "warning");
      return;
    }
    let request: OperatorAskAnswerRequest;
    try {
      request = parseTuiAskAnswer(value, this.state.pendingAsk);
    } catch (error) {
      this.addNotice(errorMessage(error), "warning");
      return;
    }
    try {
      const result = await this.options.client.answerAsk(
        this.options.conversationId,
        request,
      );
      if (result.status === "accepted") {
        const { pendingAsk: _pendingAsk, ...next } = this.state;
        this.state = { ...next, status: next.activeTurnId === undefined ? next.status : "streaming" };
      }
      this.addNotice(`answer ${result.status}`);
    } catch (error) {
      if (!this.stopped) this.addNotice(errorMessage(error), "warning");
    }
  }

  private async attachFile(path: string): Promise<void> {
    if (!this.can("attach")) {
      this.addNotice("The selected agent does not accept attachments.", "warning");
      return;
    }
    if (path.length === 0) {
      this.addNotice("Use /attach <path>. Inline attachments are limited to 512 KiB each.", "warning");
      return;
    }
    if (this.attachments.length >= 4) {
      this.addNotice("At most four attachments may be queued for one turn.", "warning");
      return;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_INLINE_ATTACHMENT_BYTES) {
        throw new Error("Attachment must be a regular file no larger than 512 KiB.");
      }
      const data = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        throw new Error("Attachment changed while it was read.");
      }
      const name = basename(path);
      if (
        name.length === 0
        || name.length > 1_024
        || name === "."
        || name === ".."
        || /[\\/\u0000-\u001f\u007f]/u.test(name)
      ) {
        throw new Error("Attachment filename is not safe for the operator protocol.");
      }
      const mediaType = attachmentMediaType(name);
      const url = `data:${mediaType};base64,${data.toString("base64")}`;
      if (url.length > OPERATOR_LIMITS.attachmentUrlCharacters) {
        throw new Error("Encoded attachment exceeds the operator protocol bound.");
      }
      const candidate: OperatorAttachment = {
        id: crypto.randomUUID(),
        name,
        mediaType,
        sizeBytes: data.byteLength,
        url,
      };
      const attachments = [...this.attachments, candidate];
      parseTurnRequest({ conversationId: this.options.conversationId, input: { attachments } });
      if (Buffer.byteLength(JSON.stringify({
        conversationId: this.options.conversationId,
        input: { attachments },
      })) > OPERATOR_LIMITS.requestBytes) {
        throw new Error("Queued attachments exceed the shared operator request bound.");
      }
      this.attachments.push(candidate);
      this.addNotice(`queued attachment ${name} (${String(data.byteLength)} bytes)`);
    } catch (error) {
      this.addNotice(errorMessage(error), "warning");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private setQuote(value: string): void {
    if (!this.can("quote")) {
      this.addNotice("The selected agent does not accept quotes.", "warning");
      return;
    }
    if (value === "clear") {
      this.quote = undefined;
      this.addNotice("quote cleared");
      return;
    }
    const separator = value.indexOf("=");
    const messageId = (separator < 0 ? value : value.slice(0, separator)).trim();
    const text = separator < 0 ? undefined : value.slice(separator + 1);
    if (messageId.length === 0) {
      this.addNotice("Use /quote <message-id>[=<quoted text>] or /quote clear. Replay shows message ids.", "warning");
      return;
    }
    const quote: OperatorQuote = {
      conversationId: this.options.conversationId,
      messageId,
      ...(text === undefined ? {} : { text }),
    };
    try {
      parseTurnRequest({ conversationId: this.options.conversationId, input: { text: "quote validation", quote } });
      this.quote = quote;
      this.addNotice(`queued quote ${messageId}`);
    } catch (error) {
      this.addNotice(errorMessage(error), "warning");
    }
  }

  private async showReplay(): Promise<void> {
    if (!this.can("view_replay")) {
      this.addNotice("The selected agent does not expose replay.", "warning");
      return;
    }
    try {
      const replay = await this.options.client.getReplay(this.options.conversationId);
      const lines = replay.messages.slice(-100).map((message) =>
        `${message.role}${message.id === undefined ? "" : ` ${message.id}`}: ${message.text}`
      );
      this.addNotice(boundedView(lines.length === 0 ? "Replay is empty." : lines.join("\n")));
    } catch (error) {
      this.addNotice(errorMessage(error), "error");
    }
  }

  private async showConfig(): Promise<void> {
    if (!this.can("view_config")) {
      this.addNotice("The selected agent does not expose a redacted config view.", "warning");
      return;
    }
    try {
      const config = await this.options.client.getConfig();
      this.addNotice(boundedView(`config ${config.revision} (${config.generatedAt})\n${JSON.stringify(config.value, null, 2)}`));
    } catch (error) {
      this.addNotice(errorMessage(error), "error");
    }
  }

  private async showHealth(): Promise<void> {
    if (!this.can("view_health")) {
      this.addNotice("The selected agent does not expose health.", "warning");
      return;
    }
    try {
      const health = await this.options.client.getHealth();
      const details = health.details.map((item) =>
        `${item.id}: ${item.status}${item.message === undefined ? "" : ` — ${item.message}`}`
      );
      this.addNotice(boundedView(`${health.status} (${health.checkedAt})${details.length === 0 ? "" : `\n${details.join("\n")}`}`));
    } catch (error) {
      this.addNotice(errorMessage(error), "error");
    }
  }

  private can(action: OperatorAction): boolean {
    const capabilities = this.state.capabilities ?? this.info?.capabilities;
    return capabilities !== undefined
      && availableOperatorActions(this.state, capabilities).includes(action);
  }

  private statusText(prefix: string): string {
    const runtime = this.runtimeOverride ?? this.info?.defaults?.runtime;
    const model = this.modelOverride ?? this.info?.defaults?.model;
    const effort = this.effortOverride ?? this.info?.defaults?.effort;
    return [prefix, runtime, model, effort].filter((value): value is string => value !== undefined).join(" · ");
  }

  private setStatus(value: string): void {
    this.status.setText(style.muted(sanitizeTerminalText(value)));
    this.tui.requestRender();
  }

  private addNotice(value: string, kind: "info" | "warning" | "error" = "info"): void {
    const paint = kind === "error" ? style.error : kind === "warning" ? style.warning : style.muted;
    this.addTranscriptChild(new Text(paint(sanitizeTerminalText(value, { multiline: true })), 1, 1));
    this.tui.requestRender();
  }

  private addTranscriptChild(child: Component): void {
    this.transcript.addChild(child);
    while (this.transcript.children.length > MAX_TRANSCRIPT_CHILDREN) {
      const oldest = this.transcript.children.find((candidate) => candidate !== this.assistant);
      if (oldest === undefined) break;
      this.transcript.removeChild(oldest);
    }
  }
}
