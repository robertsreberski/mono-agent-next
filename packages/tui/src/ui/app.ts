import {
  Container,
  Editor,
  Markdown,
  matchesKey,
  Text,
  TUI,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  availableOperatorActions,
  assertOperatorIdentity,
  evaluateOperatorRuntimeOverride,
  initialOperatorState,
  reduceOperatorFrame,
  type OperatorAction,
  type OperatorCapabilities,
  type OperatorClient,
  type OperatorConversationState,
  type DiscoveredOperator,
  type OperatorFrame,
  type OperatorInfo,
} from "@mono-agent/operator";

import { editorTheme, markdownTheme, style } from "./theme.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export interface MonoAgentTuiAppOptions {
  readonly terminal: Terminal;
  readonly client: OperatorClient;
  readonly conversationId: string;
  readonly title?: string;
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
  private modelOverride: string | undefined;
  private effortOverride: string | undefined;
  private stopped = false;
  private exitResolve: (() => void) | undefined;
  private readonly exitPromise: Promise<void>;

  constructor(options: MonoAgentTuiAppOptions) {
    this.options = options;
    this.state = initialOperatorState(options.conversationId);
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
      case "model":
        this.setModel(argument);
        return;
      case "effort":
        this.setEffort(argument);
        return;
      case "answer":
        await this.answerAsk(argument);
        return;
      case "help":
        this.addNotice("/model <ref|default> · /effort <level|default> · /answer <question>=<value> · /cancel · /exit");
        return;
      default:
        this.addNotice(`Unknown command /${name}. Run /help.`, "warning");
    }
  }

  private async runTurn(text: string): Promise<void> {
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
    this.transcript.addChild(new Text(
      style.user(`you  ${sanitizeTerminalText(text, { multiline: true })}`),
      1,
      1,
    ));
    this.assistant = new Markdown("", 1, 0, markdownTheme, { color: style.assistant });
    this.transcript.addChild(this.assistant);
    const controller = new AbortController();
    this.turnAbort = controller;
    this.setStatus(this.statusText("starting turn…"));

    try {
      const frames = this.options.client.streamTurn({
        conversationId: this.options.conversationId,
        input: { text },
        ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
        ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
        metadata: { source: "tui" },
      }, { signal: controller.signal });
      for await (const frame of frames) {
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
        ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
        ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
      });
      if (!decision.allowed) throw new Error(decision.message);
      this.info = info;
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
          frame.target === "thought" ? "reasoning…" : this.latestActivity("streaming…"),
        ));
        break;
      case "activity":
        this.setStatus(this.statusText(frame.text));
        break;
      case "ask_user":
        this.addAsk(frame);
        this.setStatus(this.statusText("awaiting answer · /answer <question>=<value>"));
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
    const lines = frame.ask.questions.flatMap((question) => [
      `? ${sanitizeTerminalText(question.id)}: ${sanitizeTerminalText(question.prompt, { multiline: true })}`,
      ...(question.choices ?? []).map((choice) =>
        `    ${sanitizeTerminalText(choice.value)} — ${sanitizeTerminalText(choice.label)}`
      ),
    ]);
    this.transcript.addChild(new Text(style.warning(lines.join("\n")), 1, 1));
  }

  private async offerLiveInput(text: string): Promise<void> {
    if (!this.can("offer_live_input")) {
      this.addNotice("A turn is active and this agent does not accept live input.", "warning");
      return;
    }
    const result = await this.options.client.offerLiveInput(this.options.conversationId, {
      id: crypto.randomUUID(),
      text,
      receivedAt: new Date().toISOString(),
    });
    this.addNotice(`live input ${result.status}`);
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
    const decision = evaluateOperatorRuntimeOverride(this.info!, value === "default"
      ? {}
      : {
          model: value,
          ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
        });
    if (!decision.allowed) {
      this.addNotice(decision.message, "warning");
      return;
    }
    this.modelOverride = decision.intent.model;
    this.effortOverride = decision.intent.effort;
    if (value === "default") this.effortOverride = undefined;
    this.setStatus(this.statusText(value === "default" ? "model override cleared" : `model ${value}`));
  }

  private validateInitialOverrides(): void {
    const decision = evaluateOperatorRuntimeOverride(this.info!, {
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(this.effortOverride === undefined ? {} : { effort: this.effortOverride }),
    });
    if (!decision.allowed) {
      throw new Error(decision.message);
    }
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
      ...(this.modelOverride === undefined ? {} : { model: this.modelOverride }),
      ...(value === "default" ? {} : { effort: value }),
    });
    if (!decision.allowed) {
      this.addNotice(decision.message, "warning");
      return;
    }
    this.modelOverride = decision.intent.model;
    this.effortOverride = decision.intent.effort;
    this.setStatus(this.statusText(value === "default" ? "effort override cleared" : `effort ${value}`));
  }

  private async answerAsk(value: string): Promise<void> {
    if (!this.can("answer_ask") || this.state.pendingAsk === undefined) {
      this.addNotice("There is no answerable question.", "warning");
      return;
    }
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      this.addNotice("Use /answer <question-id>=<value>[,<value>].", "warning");
      return;
    }
    const questionId = value.slice(0, separator).trim();
    const answers = value.slice(separator + 1).split(",").map((answer) => answer.trim()).filter(Boolean);
    const result = await this.options.client.answerAsk(
      this.options.conversationId,
      {
        interactionId: this.state.pendingAsk.interactionId,
        answers: { [questionId]: answers },
      },
    );
    this.addNotice(`answer ${result.status}`);
  }

  private can(action: OperatorAction): boolean {
    const capabilities = this.state.capabilities ?? this.info?.capabilities ?? NO_CAPABILITIES;
    return availableOperatorActions(this.state, capabilities).includes(action);
  }

  private latestActivity(fallback: string): string {
    return this.state.activities.at(-1) ?? fallback;
  }

  private statusText(prefix: string): string {
    const model = this.modelOverride ?? this.info?.defaults?.model;
    const effort = this.effortOverride ?? this.info?.defaults?.effort;
    return [prefix, model, effort].filter((value): value is string => value !== undefined).join(" · ");
  }

  private setStatus(value: string): void {
    this.status.setText(style.muted(sanitizeTerminalText(value)));
    this.tui.requestRender();
  }

  private addNotice(value: string, kind: "info" | "warning" | "error" = "info"): void {
    const paint = kind === "error" ? style.error : kind === "warning" ? style.warning : style.muted;
    this.transcript.addChild(new Text(paint(sanitizeTerminalText(value)), 1, 1));
    this.tui.requestRender();
  }
}

const NO_CAPABILITIES: OperatorCapabilities = {
  attachments: false,
  liveInput: false,
  askUser: false,
  cancellation: false,
  quotes: false,
  runtimeOverrides: false,
  proactive: false,
  configView: false,
  replay: false,
  health: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
