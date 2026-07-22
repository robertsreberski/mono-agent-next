import { Container, matchesKey, SelectList, Text, TruncatedText, TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, SelectItem, SlashCommand, Terminal } from "@earendil-works/pi-tui";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import { EFFORT_LEVELS } from "@mono-agent/config";

import type { TuiHistoryStore } from "../agent/history.js";
import { discoverInstances, resolveInstanceApiKey, toInstance } from "../data/instances.js";
import type { DiscoveredInstance } from "../data/instances.js";
import { RemoteAgentResponder } from "../remote/client.js";
import { selectListTheme, styles } from "./theme.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatView, type ChatTurnSettledEvent } from "./views/chat.js";
import { ConfigView } from "./views/config.js";
import { PickerView } from "./views/picker.js";
import { ReplayView } from "./views/replay.js";

export type TuiViewId = "chat" | "picker" | "replay" | "config";

export interface TuiAppLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface ConfigurationProposalCard {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly details: readonly string[];
  /** Exact, host-bounded Role body that will replace the named canonical section. */
  readonly role?: { readonly location: string; readonly proposedBody: string };
}

export interface ConfigurationProposalResult {
  readonly message: string;
  readonly kind?: "applied" | "rejected" | "rolled_back" | "error";
  /** Fresh endpoint proven ready after apply, or after restoring the old config. */
  readonly connection?: { readonly baseUrl: string; readonly apiKey?: string };
}

export interface TuiConfigurationController {
  /** Opaque capability id; the daemon derives an owner-only proposal sink from it. */
  readonly sessionId: string;
  /** Stable base for configuration-only conversations; ordinary chat never uses it. */
  readonly conversationId: string;
  /** Effective configured identity destination shown honestly to the operator. */
  readonly roleLocation: string;
  /** When present, boot immediately starts the recorded self-configuration guide turn. */
  readonly initialPrompt?: string;
  /** Prompt used to open the dedicated self-configuration session. */
  readonly prompt: string;
  /** Repeated operator-phase instruction for the persistent conversation. */
  readonly operatorPrompt: string;
  takeProposal(): Promise<ConfigurationProposalCard | undefined>;
  approve(id: string): Promise<ConfigurationProposalResult>;
  reject(id: string): Promise<ConfigurationProposalResult>;
  /** Revoke an attempt that cannot reach its operator/proposal phase. */
  abandon(): Promise<void>;
}

export interface MonoAgentTuiAppOptions {
  readonly terminal: Terminal;
  /** In-process responder (embedded mode); mutually exclusive with connection/discovery. */
  readonly responder?: AgentResponder;
  /** Direct remote connection (from `mono-agent tui` after resolution). */
  readonly connection?: { readonly baseUrl: string; readonly apiKey?: string };
  /** Discovery mode: open on the instance picker over these registries (`registryDirs` union beats the single `registryDir`). */
  readonly discovery?: {
    readonly registryDir?: string;
    readonly registryDirs?: readonly string[];
    readonly staleAfterMs?: number;
  };
  /** Identity + data roots of the selected instance (replay/config views). */
  readonly instance?: {
    readonly label?: string;
    readonly artifactDir?: string;
    readonly configPath?: string;
  };
  readonly conversationId?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly initialStatusText?: string;
  readonly history?: TuiHistoryStore;
  readonly config?: { readonly path: string; readonly cwd: string; readonly env: Record<string, string | undefined> };
  readonly logger?: TuiAppLogger;
  readonly env?: Record<string, string | undefined>;
  /** Test seam: coalescing window for streamed markdown; 0 = synchronous. */
  readonly flushIntervalMs?: number;
  /** Host-owned configuration lifecycle; normally paired with a remote background connection. */
  readonly configuration?: TuiConfigurationController;
}

const VIEW_ORDER: readonly TuiViewId[] = ["chat", "replay", "config", "picker"];

/** Sentinel `SelectItem.value` for the model picker's "clear override" row (never a real model ref). */
const MODEL_PICKER_DEFAULT_VALUE = "tui-model-picker:__default__";
/** Sentinel `SelectItem.value` for the effort picker's "clear override" row (never a real level). */
const EFFORT_PICKER_DEFAULT_VALUE = "tui-effort-picker:__default__";
/**
 * The effort a toggle-reasoning model's "thinking on" row sends: `"high"` maps
 * to thinking-on via the harness's `thinkingLevelForEffort`. "thinking off"
 * sends `"none"` (→ thinking-off). A toggle model has no graded levels, so
 * these two + the clear-override row are all it offers.
 */
const TOGGLE_THINKING_ON_EFFORT = "high";
const TOGGLE_THINKING_OFF_EFFORT = "none";

class ConfigurationReviewPager implements Component {
  private offset = 0;
  private renderedLines: readonly string[] = [];

  constructor(
    private readonly text: string,
    private readonly pageRows: number,
  ) {}

  scrollPage(direction: -1 | 1): void {
    const maxOffset = Math.max(0, this.renderedLines.length - this.pageRows);
    const step = Math.max(1, this.pageRows - 1);
    this.offset = Math.max(0, Math.min(maxOffset, this.offset + direction * step));
  }

  invalidate(): void {
    this.renderedLines = [];
  }

  render(width: number): string[] {
    this.renderedLines = wrapConfigurationReviewText(this.text, width);
    const maxOffset = Math.max(0, this.renderedLines.length - this.pageRows);
    this.offset = Math.min(this.offset, maxOffset);

    const visible = this.renderedLines.slice(this.offset, this.offset + this.pageRows);
    while (visible.length < this.pageRows) visible.push(" ".repeat(width));

    const total = this.renderedLines.length;
    const start = total === 0 ? 0 : this.offset + 1;
    const end = Math.min(total, this.offset + this.pageRows);
    const indicator = new TruncatedText(
      styles.dim(`review lines ${start}-${end}/${total} · pgup/pgdn scroll`),
      1,
      0,
    ).render(width)[0] ?? " ".repeat(width);
    return [...visible, indicator];
  }
}

const CONFIGURATION_REVIEW_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap without Text's whitespace trimming so every approved printable grapheme remains visible. */
function wrapConfigurationReviewText(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const wrapped: string[] = [];
  for (const logicalLine of text.split("\n")) {
    if (logicalLine.length === 0) {
      wrapped.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const { segment } of CONFIGURATION_REVIEW_GRAPHEMES.segment(logicalLine)) {
      const segmentWidth = visibleWidth(segment);
      if (current.length > 0 && currentWidth + segmentWidth > contentWidth) {
        wrapped.push(current);
        current = "";
        currentWidth = 0;
      }
      current += segment;
      currentWidth += segmentWidth;
    }
    wrapped.push(current);
  }
  return wrapped.map((line) => {
    const withMargins = ` ${line} `;
    return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
  });
}

function configurationProposalHasUnsafeReviewControls(proposal: ConfigurationProposalCard): boolean {
  const displayedText = [
    proposal.title,
    proposal.rationale,
    ...proposal.details,
    ...(proposal.role === undefined ? [] : [proposal.role.location, proposal.role.proposedBody]),
  ];
  return displayedText.some((value) => {
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      if (
        (codePoint <= 0x1f && codePoint !== 0x0a)
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || /\p{Bidi_Control}/u.test(character)
      ) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Root controller: owns the pi-tui instance, the view stack, connection state,
 * and global keys (view cycling, cancel, quit, thinking toggle, help).
 */
export class MonoAgentTuiApp {
  readonly tui: TUI;
  private readonly options: MonoAgentTuiAppOptions;
  private readonly header = new Text("", 1, 0);
  private readonly viewHost = new Container();
  private readonly statusBar = new StatusBar();
  private readonly chat: ChatView;
  private readonly picker: PickerView;
  private readonly replay: ReplayView;
  private readonly config: ConfigView;
  private view: TuiViewId = "chat";
  private helpVisible = false;
  private helpHandle: { hide(): void } | undefined;
  /** Candidate models advertised by the connected agent's `/v1/info` (primary first, then fallbacks). */
  private availableModels: readonly string[] = [];
  /** Per-model effort/reasoning/mode/label options from `/v1/info` (keyed by model ref); drives the model-aware effort picker + `/model` row annotations. */
  private modelOptions: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string }> = {};
  /** The connected agent's own default model ref (from `/v1/info`) — the effort picker's effective model when no `/model` override is active. */
  private agentModel: string | undefined;
  /** The single open picker/review overlay; only one at a time. */
  private activePicker: {
    readonly handle: OverlayHandle;
    readonly list: SelectList;
    readonly review?: ConfigurationReviewPager;
  } | undefined;
  private ctrlCArmedAt = 0;
  private exitResolve: (() => void) | undefined;
  private readonly exitPromise: Promise<void>;
  private stopped = false;
  private configurationResolutionActive = false;
  private stopAfterConfigurationResolution = false;

  constructor(options: MonoAgentTuiAppOptions) {
    this.options = options;
    this.tui = new TUI(options.terminal);
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });

    this.chat = new ChatView({
      tui: this.tui,
      statusBar: this.statusBar,
      conversationId: options.conversationId ?? "tui-local",
      ...(options.history === undefined ? {} : { history: options.history }),
      slashCommands: SLASH_COMMANDS,
      onSlashCommand: (command, args) => this.handleSlashCommand(command, args),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
      ...(options.configuration === undefined ? {} : {
        onTurnSettled: (event) => this.handleConfigurationTurnSettled(event),
      }),
    });
    this.picker = new PickerView({
      onSelect: (instance) => void this.connectTo(instance),
      onRefresh: () => void this.refreshInstances(),
    });
    this.replay = new ReplayView({ tui: this.tui });
    this.config = new ConfigView({ tui: this.tui, env: options.env ?? process.env });

    this.tui.addChild(this.header);
    this.tui.addChild(this.viewHost);
    this.tui.addChild(this.statusBar);
    this.tui.addInputListener((data) => this.handleGlobalInput(data));

    if (options.configuration !== undefined) {
      this.statusBar.setHint("SELF-CONFIG · only /quit, /exit, or ctrl+c x2 exits");
    }

    this.applyStaticIdentity();
    this.wireInitialMode();
  }

  start(): void {
    this.tui.start();
    this.showView(this.view);
    if (this.options.configuration?.initialPrompt !== undefined) {
      queueMicrotask(() => this.enterConfiguration());
    }
  }

  async waitUntilExit(): Promise<void> {
    await this.exitPromise;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    if (this.configurationResolutionActive) {
      this.stopAfterConfigurationResolution = true;
      this.chat.addNotice(
        "Configuration approval is still applying/restarting. This console will close after the host transaction settles; closing it does not send a background stop request.",
        "warning",
      );
      return;
    }
    this.finishStop();
  }

  private finishStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.chat.cancelActiveTurn();
    this.chat.finishConfigurationSession();
    this.tui.stop();
    this.exitResolve?.();
  }

  showView(view: TuiViewId): void {
    if (view === "picker" && this.options.configuration !== undefined) {
      this.statusBar.setEphemeral("this configuration console is pinned to its background agent");
      this.tui.requestRender();
      return;
    }
    this.view = view;
    this.viewHost.clear();
    const component: Component =
      view === "chat" ? this.chat : view === "picker" ? this.picker : view === "replay" ? this.replay : this.config;
    this.viewHost.addChild(component);
    this.tui.setFocus(view === "chat" ? this.chat.editor : component);
    this.updateHeader();
    this.tui.requestRender();
  }

  private wireInitialMode(): void {
    const { responder, connection, discovery, instance } = this.options;
    if (responder !== undefined) {
      this.chat.setResponder(responder);
    } else if (connection !== undefined) {
      this.setRemoteConnection(connection);
    }
    if (instance?.artifactDir !== undefined) {
      this.replay.setArtifactDir(instance.artifactDir);
    }
    const configPath = instance?.configPath ?? this.options.config?.path;
    if (configPath !== undefined) {
      this.config.setConfigPath(configPath, this.options.config?.cwd);
    }
    if (discovery !== undefined && responder === undefined && connection === undefined) {
      this.view = "picker";
      void this.refreshInstances();
    }
    if (this.options.initialStatusText !== undefined) {
      this.statusBar.setEphemeral(this.options.initialStatusText);
    }
  }

  private setRemoteConnection(connection: { readonly baseUrl: string; readonly apiKey?: string }): void {
    const remote = new RemoteAgentResponder({
      baseUrl: connection.baseUrl,
      ...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
    });
    this.chat.setResponder(remote);
    void remote
      .info()
      .then((info) => {
        this.applyAgentInfo(info);
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        this.chat.addNotice(
          `Could not reach the agent: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
  }

  private async refreshInstances(): Promise<void> {
    const discovery = this.options.discovery;
    const result = await discoverInstances({
      ...(discovery?.registryDir === undefined ? {} : { registryDir: discovery.registryDir }),
      ...(discovery?.registryDirs === undefined ? {} : { registryDirs: discovery.registryDirs }),
      ...(discovery?.staleAfterMs === undefined ? {} : { staleAfterMs: discovery.staleAfterMs }),
      env: this.options.env ?? process.env,
    }).catch((error: unknown) => {
      this.options.logger?.error?.("tui.discovery.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      const registryDirs = discovery?.registryDirs ?? (discovery?.registryDir === undefined ? [] : [discovery.registryDir]);
      return { instances: [], registryDir: registryDirs[0] ?? "", registryDirs, warnings: [] };
    });
    this.picker.setInstances(result.instances, result.registryDirs.join(", "));
    this.tui.requestRender();
  }

  private async connectTo(instance: DiscoveredInstance): Promise<void> {
    // A newly selected agent ends the previous agent's session-scoped /model
    // and /effort overrides right away -- synchronously, before any async info() round
    // trip. `applyAgentInfo` alone is NOT a sufficient choke point here: it
    // only runs once `info()` resolves successfully, but `setResponder` below
    // (has-endpoint branch) happens before that await, so a turn submitted
    // while info() is still in flight -- or after it fails -- would otherwise
    // still carry the old agent's override to the new one.
    this.chat.setModelOverride(undefined);
    this.chat.setEffortOverride(undefined);
    const normalized = toInstance(instance.source);
    if (normalized.tuiBaseUrl === undefined) {
      this.statusBar.setEphemeral("selected agent has no tui endpoint — replay/config only");
      this.chat.setResponder(undefined);
    } else {
      const apiKey = await resolveInstanceApiKey(normalized, this.options.env ?? process.env);
      const remote = new RemoteAgentResponder({
        baseUrl: normalized.tuiBaseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      this.chat.setResponder(remote);
      void remote
        .info()
        .then((info) => {
          this.applyAgentInfo(info);
          this.tui.requestRender();
        })
        .catch(() => undefined);
    }
    this.statusBar.setIdentity(instance.source.label);
    // artifactDir is a required manifest field and stands on its own — replay
    // must not be gated on the optional configPath (agentDir derives from it).
    this.replay.setArtifactDir(instance.source.artifactDir);
    this.config.setConfigPath(instance.source.configPath, normalized.agentDir);
    this.chat.addInfo(`connected to ${instance.source.label}`);
    this.showView("chat");
  }

  /**
   * Apply a `/v1/info` snapshot's model/effort to the status bar. Unlike the
   * per-turn finish-metadata correction in ChatView (a delta that never
   * clears), `info` is a full snapshot of the *newly selected agent* — an
   * absent `effort` here means this agent genuinely has none configured, so
   * clearing is correct: otherwise a stale effort from a previously
   * connected agent would misattribute to this one.
   */
  private applyAgentInfo(info: {
    readonly model?: string;
    readonly effort?: string;
    readonly models?: readonly string[];
    readonly modelOptions?: Record<string, { effortLevels?: readonly string[]; reasoning?: boolean; reasoningMode?: string; label?: string }>;
  }): void {
    // Routed through ChatView (not statusBar directly) so it can remember these
    // as the agent's defaults -- what a later /model|/effort default repaints
    // to, instead of leaving the last override string shown.
    this.chat.setDefaultEffort(info.effort);
    this.agentModel = info.model;
    if (info.model !== undefined) {
      this.chat.setDefaultModel(info.model);
    }
    // A full snapshot of the newly selected agent: an absent list/map means
    // this agent advertises none, so replace (not merge) — stale entries from a
    // previously connected agent must not leak into this one's pickers.
    this.availableModels = info.models ?? [];
    this.modelOptions = info.modelOptions ?? {};
  }

  private applyStaticIdentity(): void {
    const identity = this.options.instance?.label ?? this.options.title ?? "";
    if (identity.length > 0) {
      this.statusBar.setIdentity(identity);
    }
    this.updateHeader();
  }

  private updateHeader(): void {
    const title = this.options.title ?? "mono-agent";
    const subtitle = this.options.subtitle === undefined ? "" : ` ${styles.dim(this.options.subtitle)}`;
    const configurationMarker = this.options.configuration === undefined
      ? ""
      : ` ${styles.bold(styles.warning("[SELF-CONFIG]"))}`;
    const tabs = VIEW_ORDER.map((view) =>
      view === this.view ? styles.bold(styles.accent(`[${view}]`)) : styles.dim(view),
    ).join(" ");
    this.header.setText(`${styles.bold(title)}${configurationMarker}${subtitle}  ${tabs}`);
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    // Quit: double ctrl+c (single press arms + hints, mirrors pi's behavior).
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - this.ctrlCArmedAt < 1_500) {
        this.stop();
      } else {
        this.ctrlCArmedAt = now;
        this.statusBar.setEphemeral("press ctrl+c again to quit");
        this.tui.requestRender();
      }
      return { consume: true };
    }
    // The model/effort picker overlay is a modal: forward navigation/confirm to
    // its SelectList, esc cancels, and every other key is swallowed. This mirrors
    // replay.ts's key-capture pattern -- deliberately NOT the help overlay's
    // "any key closes" behaviour, which would dismiss the picker on arrows.
    if (this.activePicker !== undefined) {
      if (matchesKey(data, "escape")) {
        // Picker cancellation can carry meaning: on a configuration review it
        // is an explicit host-side rejection, not merely a cosmetic close.
        this.activePicker.list.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
      }
      if (
        this.activePicker.review !== undefined
        && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))
      ) {
        this.activePicker.review.scrollPage(matchesKey(data, "pageDown") ? 1 : -1);
        this.tui.requestRender();
        return { consume: true };
      }
      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "pageUp") ||
        matchesKey(data, "pageDown") ||
        matchesKey(data, "enter")
      ) {
        this.activePicker.list.handleInput(data);
        // A consumed key never reaches pi-tui's focused-component path (which is
        // what would otherwise schedule a paint), and SelectList.handleInput does
        // not self-render -- so without this the moved cursor never repaints in an
        // idle session (a streaming turn's animation would mask it, which is why it
        // only looks frozen once the conversation has gone quiet).
        this.tui.requestRender();
        return { consume: true };
      }
      return { consume: true };
    }
    if (this.helpVisible) {
      this.hideHelp();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.view === "chat" && this.chat.cancelActiveTurn()) {
        this.statusBar.setEphemeral("cancelling…");
        this.tui.requestRender();
        return { consume: true };
      }
      if (this.view === "replay" && this.replay.back()) {
        return { consume: true };
      }
      if (this.view !== "chat") {
        this.showView("chat");
        return { consume: true };
      }
      return undefined; // Editor may use Esc (autocomplete dismiss).
    }
    if (matchesKey(data, "tab") && this.globalShortcutsAllowedInChat()) {
      // In chat with unsubmitted text, Tab belongs to the editor
      // (autocomplete); an empty buffer has nothing to lose, so Tab cycles
      // views there too.
      this.cycleView(1);
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      this.cycleView(-1);
      return { consume: true };
    }
    if (matchesKey(data, "f2")) {
      this.showView("chat");
      return { consume: true };
    }
    if (matchesKey(data, "f3")) {
      this.showView("replay");
      return { consume: true };
    }
    if (matchesKey(data, "f4")) {
      this.showView("config");
      return { consume: true };
    }
    if (matchesKey(data, "f5")) {
      this.showView("picker");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      this.chat.toggleThinkingExpanded();
      return { consume: true };
    }
    if (data === "?" && this.globalShortcutsAllowedInChat()) {
      this.showHelp();
      return { consume: true };
    }
    return undefined;
  }

  /**
   * Tab/`?` act as global shortcuts (view cycling, help) everywhere except
   * chat with unsubmitted editor text -- there they pass through to the
   * editor instead (autocomplete completion / literal `?`). Shared by both
   * keys so the "empty editor" exception can't drift out of sync between them.
   */
  private globalShortcutsAllowedInChat(): boolean {
    return this.view !== "chat" || this.chat.isEditorEmpty();
  }

  private cycleView(direction: 1 | -1): void {
    const index = VIEW_ORDER.indexOf(this.view);
    const next = VIEW_ORDER[(index + direction + VIEW_ORDER.length) % VIEW_ORDER.length] ?? "chat";
    this.showView(next);
  }

  private handleSlashCommand(command: string, args: string): boolean {
    switch (command) {
      case "help":
        this.showHelp();
        return true;
      case "quit":
      case "exit":
        if (this.options.configuration !== undefined) {
          this.statusBar.setEphemeral("closing console; no background stop requested");
          this.tui.requestRender();
        }
        this.stop();
        return true;
      case "agents":
        if (this.options.configuration !== undefined) {
          this.chat.addNotice(
            "This self-configuration session is pinned to the background agent it can safely restart. Quit this session before choosing another agent.",
            "warning",
          );
          return true;
        }
        this.showView("picker");
        void this.refreshInstances();
        return true;
      case "replay":
        this.showView("replay");
        return true;
      case "config":
        this.showView("config");
        return true;
      case "configure":
        this.enterConfiguration();
        return true;
      case "cancel":
        if (!this.chat.cancelActiveTurn()) {
          this.statusBar.setEphemeral("no turn in flight");
          this.tui.requestRender();
        }
        return true;
      case "thinking":
        this.chat.toggleThinkingExpanded();
        return true;
      case "model":
        this.handleModelCommand(args);
        return true;
      case "effort":
        this.handleEffortCommand(args);
        return true;
      case "new": {
        this.chat.addInfo(`conversation continues under a fresh screen${args.length > 0 ? ` (${args})` : ""}`);
        return true;
      }
      default:
        return false;
    }
  }

  private showHelp(): void {
    const help = new Text(
      [
        styles.bold("mono-agent tui"),
        "",
        `${styles.accent("f2/f3/f4/f5")}  chat / replay / config / agents`,
        `${styles.accent("tab")}         next view (chat: only when the editor is empty) · ${styles.accent("shift+tab")} previous`,
        `${styles.accent("esc")}         cancel in-flight turn · back`,
        `${styles.accent("ctrl+t")}      expand/collapse thinking`,
        `${styles.accent("ctrl+c ×2")}   quit console only (does not stop agent)`,
        "",
        `${styles.accent("replay list")}    s source filter · x status filter · r refresh`,
        `${styles.accent("replay detail")}  ↑↓/pgup/pgdn/g/G step · [ ] turn · t/o/m/y/e/a filter · / search · n/N match · enter raw json · esc layers back`,
        "",
        `${styles.accent("/model")}      override this session's model — ${styles.accent("/model <ref>")} or a bare ${styles.accent(
          "/model",
        )} picker; ${styles.accent("/model default")} clears it`,
        styles.dim("an override to a different model runs each turn as a fresh provider session"),
        `${styles.accent("/effort")}     override this session's effort — ${styles.accent("/effort <level>")} or a bare ${styles.accent(
          "/effort",
        )} picker; ${styles.accent("/effort default")} clears it`,
        styles.dim("effort options are model-specific"),
        "",
        `${styles.accent("/help /agents /replay /config /configure /cancel /thinking /model /effort /quit")}`,
        styles.dim(this.options.configuration === undefined
          ? "/configure opens a dedicated self-configuration session; /quit closes only this console"
          : "[SELF-CONFIG] remains active after every decision; only /quit exits it"),
        "",
        styles.dim("any key closes this help"),
      ].join("\n"),
      2,
      1,
    );
    this.helpHandle = this.tui.showOverlay(help, { anchor: "center", width: 64 });
    this.helpVisible = true;
    this.tui.requestRender();
  }

  private hideHelp(): void {
    this.helpHandle?.hide();
    this.helpHandle = undefined;
    this.helpVisible = false;
    this.tui.requestRender();
  }

  /**
   * `/model` — with an argument, set (or, for `default`, clear) the session
   * model override directly; with no argument, open the picker overlay. An
   * override to a different model runs each turn as a fresh provider session.
   */
  private handleModelCommand(args: string): void {
    const arg = args.trim();
    if (arg.length > 0) {
      const override = arg === "default" ? undefined : arg;
      this.chat.setModelOverride(override);
      this.statusBar.setEphemeral(
        override === undefined ? "model override cleared" : `model override → ${override}`,
      );
      this.tui.requestRender();
      return;
    }
    this.showModelPicker();
  }

  private showModelPicker(): void {
    if (this.activePicker !== undefined) {
      return; // Already open.
    }
    if (this.availableModels.length === 0) {
      // Older agents (or embedded mode) advertise no candidate list; the direct
      // form still works. Use a persistent transcript notice (not a transient
      // ephemeral) so it doesn't read as "the picker is broken".
      this.chat.addNotice(
        "Model picker unavailable — this agent advertises no model list. Use /model <ref>, or update and restart the agent.",
        "warning",
      );
      this.tui.requestRender();
      return;
    }
    const current = this.chat.getModelOverride();
    const items: SelectItem[] = this.availableModels.map((model) => {
      const opts = this.modelOptions[model];
      // Prefer the friendly label for discovered local models; keep the ref as
      // the selection value so the override contract is unchanged. A dim
      // "· no thinking" flags models that don't support reasoning/effort.
      const base = opts?.label ?? model;
      const noThinking = opts?.reasoning === false ? styles.dim(" · no thinking") : "";
      return { value: model, label: `${withCurrentMarker(base, model === current)}${noThinking}` };
    });
    items.push({
      value: MODEL_PICKER_DEFAULT_VALUE,
      label: withCurrentMarker("— default (clear override) —", current === undefined),
    });

    this.openPickerOverlay("Session model override", items, (item) => {
      const choice = item.value === MODEL_PICKER_DEFAULT_VALUE ? undefined : item.value;
      this.chat.setModelOverride(choice);
      this.statusBar.setEphemeral(
        choice === undefined ? "model override cleared" : `model override → ${choice}`,
      );
    });
  }

  private enterConfiguration(): void {
    const configuration = this.options.configuration;
    if (configuration === undefined) {
      this.chat.addNotice(
        "Self-configuration is unavailable in this console. On macOS, open the managed agent with `mono-agent tui --configure`.",
        "warning",
      );
      return;
    }
    if (this.chat.isConfigurationSessionActive()) {
      this.chat.addInfo("Self-configuration is already active. Continue the conversation, or use /quit to exit it.");
      return;
    }
    if (this.chat.hasActiveTurn()) {
      this.chat.addNotice("Wait for the active turn to settle before starting self-configuration.", "warning");
      return;
    }
    this.showView("chat");
    this.chat.addInfo(
      `Dedicated self-configuration session for this agent. The guide will map the available capability areas, then help build your workflow by conversation. The effective Role is ${configuration.roleLocation}. Do not enter secrets. Every proposed file change requires separate host approval. Approval, rejection, done, and no changes all keep self-configuration active; only /quit, /exit, or ctrl+c twice exits the session. Quitting sends no background stop.`,
    );
    this.chat.beginConfiguration(configuration.prompt, {
      sessionId: configuration.sessionId,
      conversationId: configuration.conversationId,
      operatorPrompt: configuration.operatorPrompt,
    });
  }

  private async handleConfigurationTurnSettled(event: ChatTurnSettledEvent): Promise<void> {
    if (!event.configuration) return;
    const configuration = this.options.configuration;
    if (configuration === undefined) return;
    if (event.configurationPhase === "invitation") {
      if (event.status !== "ok") {
        try {
          await configuration.abandon();
          this.chat.addInfo("The opening guide turn did not complete. No changes were made; self-configuration remains active.");
          this.continueConfiguration(
            "The opening guide turn did not complete. No configuration changes were made. Help the operator continue from their next message.",
          );
        } catch (error) {
          this.chat.addNotice(
            `The failed guide turn could not rotate its proposal capability: ${error instanceof Error ? error.message : String(error)} Quit and reopen self-configuration before trying again.`,
            "error",
          );
        }
      } else {
        this.continueConfiguration();
      }
      return;
    }
    if (event.configurationCompletion === "no-changes") {
      try {
        await configuration.abandon();
        this.chat.addInfo("No changes were requested. Self-configuration remains active; continue with another area or /quit to exit.");
        this.continueConfiguration(
          "The operator completed that topic without requesting changes. No files changed. Continue self-configuration and offer the next relevant capability area.",
        );
      } catch (error) {
        this.chat.addNotice(
          `No files changed, but the proposal capability could not be rotated safely: ${error instanceof Error ? error.message : String(error)} Quit and reopen self-configuration before trying again.`,
          "error",
        );
      }
      return;
    }
    try {
      const proposal = await configuration.takeProposal();
      if (proposal !== undefined) {
        this.showConfigurationProposal(proposal);
        return;
      }
      this.chat.addInfo("No configuration change was proposed. Self-configuration remains active; keep exploring or /quit to exit.");
      this.continueConfiguration(
        "The previous turn produced no configuration proposal. No files changed. Continue the workflow conversation without repeating the opening capability map.",
      );
    } catch (error) {
      this.chat.addNotice(error instanceof Error ? error.message : String(error), "error");
      if (!isConfigurationRotationFailure(error)) {
        this.chat.addInfo("No files changed. Self-configuration remains active.");
        this.continueConfiguration(
          "The host could not accept the previous proposal. No files changed. Continue self-configuration and help the operator correct or refine the request.",
        );
      } else {
        this.chat.addNotice("Quit and reopen self-configuration before trying again.", "error");
      }
    }
  }

  private continueConfiguration(hostOutcome?: string): void {
    const configuration = this.options.configuration;
    if (configuration === undefined || this.stopped || this.stopAfterConfigurationResolution) return;
    this.chat.continueConfiguration({
      sessionId: configuration.sessionId,
      conversationId: configuration.conversationId,
      operatorPrompt: configuration.operatorPrompt,
    }, hostOutcome);
  }

  private showConfigurationProposal(proposal: ConfigurationProposalCard): void {
    if (this.activePicker !== undefined) {
      this.closePicker();
    }
    if (configurationProposalHasUnsafeReviewControls(proposal)) {
      this.chat.addNotice(
        "Configuration proposal review text contained unsafe terminal or bidi controls and was not displayed. The proposal is being rejected without approval.",
        "error",
      );
      void this.resolveConfigurationProposal(proposal, false);
      return;
    }
    const list = new SelectList([
      { value: "approve", label: "Approve, restart, and verify" },
      { value: "reject", label: "Reject; change nothing" },
    ], 2, selectListTheme);
    list.onSelect = (item: SelectItem) => {
      this.closePicker();
      void this.resolveConfigurationProposal(proposal, item.value === "approve");
    };
    list.onCancel = () => {
      this.closePicker();
      void this.resolveConfigurationProposal(proposal, false);
    };
    list.setSelectedIndex(1);

    const roleReview = proposal.role === undefined
      ? ""
      : [
          "",
          `Exact proposed Role body (${proposal.role.location})`,
          "--- begin exact Role body ---",
          proposal.role.proposedBody,
          "--- end exact Role body ---",
        ].join("\n");
    const review = new ConfigurationReviewPager([
      "Reason",
      proposal.rationale,
      "",
      "Changes",
      proposal.details.length === 0
        ? "• no mono-agent.config.json changes"
        : proposal.details.map((detail) => `• ${detail}`).join("\n"),
      roleReview,
    ].join("\n"), Math.max(1, Math.min(14, this.options.terminal.rows - 5)));
    const overlay = new Container();
    overlay.addChild(new TruncatedText(styles.bold(proposal.title), 1, 0));
    overlay.addChild(review);
    overlay.addChild(list);
    overlay.addChild(new TruncatedText(styles.dim("pgup/pgdn review · ↑↓ decision · enter select · esc rejects"), 1, 0));
    this.activePicker = {
      handle: this.tui.showOverlay(overlay, { anchor: "center", width: 76, nonCapturing: true }),
      list,
      review,
    };
    this.tui.requestRender();
  }

  private async resolveConfigurationProposal(
    proposal: ConfigurationProposalCard,
    approve: boolean,
  ): Promise<void> {
    const configuration = this.options.configuration;
    if (configuration === undefined) return;
    if (this.configurationResolutionActive) return;
    this.configurationResolutionActive = true;
    this.statusBar.setEphemeral(approve ? "validating and applying approved configuration…" : "rejecting proposal…");
    this.tui.requestRender();
    let hostOutcome: string | undefined;
    let continuationBlock: "endpoint" | "rotation" | undefined;
    try {
      const result = approve
        ? await configuration.approve(proposal.id)
        : await configuration.reject(proposal.id);
      if (result.connection !== undefined) {
        this.setRemoteConnection(result.connection);
      }
      if (approve && result.connection === undefined && result.kind === "error") {
        this.chat.setResponder(undefined);
        continuationBlock = "endpoint";
      }
      if (result.kind === "error" || result.kind === "rolled_back") {
        this.chat.addNotice(result.message, "error");
      } else {
        this.chat.addInfo(result.message);
      }
      if (isConfigurationRotationFailure(result.message)) {
        continuationBlock ??= "rotation";
      }
      hostOutcome = configurationOutcomeForNextTurn(approve, result.kind);
      if (continuationBlock === "endpoint") {
        this.chat.addNotice(
          "Self-configuration remains marked, but the agent endpoint could not be recovered. Perform manual recovery, then quit and reopen this session.",
          "error",
        );
      } else if (continuationBlock === "rotation") {
        this.chat.addNotice(
          "Self-configuration remains marked, but the proposal capability could not be rotated safely. Quit and reopen this session before trying again.",
          "error",
        );
      }
    } catch (error) {
      if (approve) {
        this.chat.setResponder(undefined);
        continuationBlock = "endpoint";
      } else if (isConfigurationRotationFailure(error)) {
        continuationBlock = "rotation";
      }
      this.chat.addNotice(error instanceof Error ? error.message : String(error), "error");
      if (continuationBlock !== undefined) {
        this.chat.addNotice("Quit and reopen self-configuration before trying again.", "error");
      } else {
        hostOutcome = "The host could not settle the previous proposal. No files changed. Help the operator refine or retry it.";
      }
    } finally {
      this.configurationResolutionActive = false;
      this.statusBar.setEphemeral("");
      this.tui.requestRender();
      if (this.stopAfterConfigurationResolution) {
        this.finishStop();
      } else if (continuationBlock === undefined) {
        this.continueConfiguration(hostOutcome);
      }
    }
  }

  /**
   * `/effort` — with an argument, set (or, for `default`, clear) the session
   * effort override directly; with no argument, open the model-aware picker.
   */
  private handleEffortCommand(args: string): void {
    const arg = args.trim();
    if (arg.length > 0) {
      const override = arg === "default" ? undefined : arg;
      this.chat.setEffortOverride(override);
      this.statusBar.setEphemeral(
        override === undefined ? "effort override cleared" : `effort override → ${override}`,
      );
      this.tui.requestRender();
      return;
    }
    this.showEffortPicker();
  }

  /**
   * Model-aware effort picker: the effective model is the `/model` override if
   * set, else the agent's default. The rows depend on that model's advertised
   * `reasoningMode`:
   * - `reasoning: false` / mode `"none"` / empty `effortLevels` → no adjustable
   *   effort, so we surface a persistent notice instead of an empty picker.
   * - mode `"toggle"` (binary-thinking local models, e.g. Ollama qwen3.6) → a
   *   two-row on/off picker; graded levels would misrepresent the model.
   * - mode `"effort"` with `effortLevels` → those graded levels (local models).
   * - no mode / no levels (cloud models) → the global {@link EFFORT_LEVELS} enum.
   */
  private showEffortPicker(): void {
    if (this.activePicker !== undefined) {
      return; // Already open.
    }
    const effectiveModel = this.chat.getModelOverride() ?? this.agentModel;
    const opts = effectiveModel === undefined ? undefined : this.modelOptions[effectiveModel];
    const unsupported =
      opts !== undefined &&
      (opts.reasoning === false ||
        opts.reasoningMode === "none" ||
        (opts.effortLevels !== undefined && opts.effortLevels.length === 0));
    if (unsupported) {
      const name = opts?.label ?? effectiveModel ?? "This model";
      this.chat.addNotice(`${name} does not support adjustable thinking/effort`, "warning");
      this.tui.requestRender();
      return;
    }
    const current = this.chat.getEffortOverride();
    // A toggle-reasoning model supports only on/off, so offer exactly that; an
    // existing non-"none" override reads as "on". Effort-mode + cloud models
    // keep the graded levels (per-model when advertised, else the global enum).
    const items: SelectItem[] =
      opts?.reasoningMode === "toggle"
        ? [
            {
              value: TOGGLE_THINKING_ON_EFFORT,
              label: withCurrentMarker(
                "thinking on",
                current !== undefined && current !== TOGGLE_THINKING_OFF_EFFORT,
              ),
            },
            {
              value: TOGGLE_THINKING_OFF_EFFORT,
              label: withCurrentMarker("thinking off", current === TOGGLE_THINKING_OFF_EFFORT),
            },
          ]
        : (opts?.effortLevels ?? EFFORT_LEVELS).map((level) => ({
            value: level,
            label: withCurrentMarker(level, level === current),
          }));
    items.push({
      value: EFFORT_PICKER_DEFAULT_VALUE,
      label: withCurrentMarker("— default (clear override) —", current === undefined),
    });

    this.openPickerOverlay("Session effort override", items, (item) => {
      const choice = item.value === EFFORT_PICKER_DEFAULT_VALUE ? undefined : item.value;
      this.chat.setEffortOverride(choice);
      this.statusBar.setEphemeral(
        choice === undefined ? "effort override cleared" : `effort override → ${choice}`,
      );
    });
  }

  /**
   * Open a modal select overlay (the model and effort pickers share this).
   * `onChoose` handles the picked item; the overlay always closes afterward.
   * nonCapturing keeps input routed through the global listener (which drives
   * the list explicitly and swallows the rest), so the overlay never contends
   * for focus with the chat editor underneath it.
   */
  private openPickerOverlay(title: string, items: SelectItem[], onChoose: (item: SelectItem) => void): void {
    const list = new SelectList(items, 10, selectListTheme);
    list.onSelect = (item: SelectItem) => {
      onChoose(item);
      this.closePicker();
    };
    list.onCancel = () => this.closePicker();
    // The current choice is called out by its `(current)` label; the cursor
    // opens at the top so navigation is predictable regardless of which entry
    // is current.
    list.setSelectedIndex(0);

    const overlay = new Container();
    overlay.addChild(new Text(styles.bold(title), 1, 0));
    overlay.addChild(list);
    overlay.addChild(new Text(styles.dim("↑↓ move · enter select · esc cancel"), 1, 0));

    this.activePicker = {
      handle: this.tui.showOverlay(overlay, { anchor: "center", width: 64, nonCapturing: true }),
      list,
    };
    this.tui.requestRender();
  }

  private closePicker(): void {
    this.activePicker?.handle.hide();
    this.activePicker = undefined;
    this.tui.requestRender();
  }
}

/** `<label> (current)` when this row is the active override, else `<label>`. */
function withCurrentMarker(label: string, isCurrent: boolean): string {
  return isCurrent ? `${label} (current)` : label;
}

function configurationOutcomeForNextTurn(
  approved: boolean,
  kind: ConfigurationProposalResult["kind"],
): string {
  if (!approved || kind === "rejected") {
    return "The operator rejected the previous proposal. No files changed. Continue self-configuration from their next message.";
  }
  if (kind === "rolled_back") {
    return "The operator approved the previous proposal, but startup verification failed. The host restored the prior files and recovered the previous agent. Continue self-configuration without assuming the rejected change is active.";
  }
  if (kind === "error") {
    return "The approved change did not produce a verified agent endpoint. Manual recovery is required before continuing.";
  }
  return "The operator approved the previous proposal. The host applied it, restarted the background agent, and verified the endpoint. Continue self-configuration using the updated setup.";
}

function isConfigurationRotationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("could not be rotated")
    || message.includes("re-entry is disabled")
    || message.includes("continuation is disabled");
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show keybindings and commands" },
  { name: "agents", description: "Pick another running agent" },
  { name: "replay", description: "Browse persisted run events" },
  { name: "config", description: "Read-only resolved config" },
  { name: "configure", description: "Open a dedicated host-approved self-configuration session" },
  { name: "cancel", description: "Cancel the in-flight turn" },
  { name: "thinking", description: "Expand/collapse thinking blocks" },
  { name: "model", description: "Override this session's model (no arg opens a picker)" },
  { name: "effort", description: "Override this session's effort (no arg opens a model-aware picker)" },
  { name: "new", description: "Visual break in the transcript" },
  { name: "quit", description: "Close this console; keep the background agent running" },
];
