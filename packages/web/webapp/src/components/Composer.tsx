import {
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useConsole } from "../console";
import {
  useAttachmentPreparation,
  useFailedComposerDraft,
} from "../runtime";
import type { Ask, AskQuestion } from "../types";
import {
  AttachmentErrorListener,
  ComposerAttachments,
} from "./Attachments";
import {
  ComposerTriggerPopover,
  type ComposerTriggerCommand,
} from "./assistant-ui/ComposerTriggerPopover";
import { ComposerQuotePreview } from "./assistant-ui/Quote";
import { Icon } from "./Icon";

export const OPEN_RUN_SETTINGS_EVENT = "mono-agent:run-settings";

interface BuildComposerCommandsOptions {
  readonly attachmentCount: number;
  readonly canCancel: boolean;
  readonly canCreateConversation: boolean;
  readonly hasRunSettings: boolean;
  readonly isRunning: boolean;
  readonly createConversation: () => void;
  readonly openRunSettings: () => void;
  readonly stopResponse: () => void;
}

export function buildComposerCommands({
  attachmentCount,
  canCancel,
  canCreateConversation,
  hasRunSettings,
  isRunning,
  createConversation,
  openRunSettings,
  stopResponse,
}: BuildComposerCommandsOptions): readonly ComposerTriggerCommand[] {
  return [
    ...(!isRunning && hasRunSettings
      ? [{
          id: "settings",
          label: "Run settings",
          description: "Choose the model and reasoning effort",
          icon: "settings" as const,
          execute: openRunSettings,
        }]
      : []),
    ...(isRunning && canCancel
      ? [{
          id: "stop",
          label: "Stop response",
          description: "Cancel the current agent run",
          icon: "stop" as const,
          execute: stopResponse,
        }]
      : []),
    ...(!isRunning && canCreateConversation && attachmentCount === 0
      ? [{
          id: "new",
          label: "New conversation",
          description: "Start a clean conversation with this agent",
          icon: "spark" as const,
          execute: createConversation,
        }]
      : []),
  ];
}

function AskUser() {
  const consoleState = useConsole();
  const ask = consoleState.detail?.thread.pendingAsk;
  return ask === undefined ? null : <AskUserForm key={ask.interactionId} ask={ask} />;
}

function AskUserForm({ ask }: { readonly ask: Ask }) {
  const consoleState = useConsole();
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const answersRef = useRef<Record<string, readonly string[]>>({});
  const answerGeneration = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const setQuestionAnswers = useCallback((questionId: string, values: readonly string[]) => {
    const next = { ...answersRef.current, [questionId]: values };
    answersRef.current = next;
    answerGeneration.current += 1;
    setAnswers(next);
  }, []);
  const clearAnswers = useCallback(() => {
    answersRef.current = {};
    setAnswers({});
  }, []);
  const navigationBlocker = useMemo(() => ({
    // The server interaction itself is keyed separately by ConsoleProvider.
    // This blocker owns only locally authored answer occurrences.
    hasPending: () => Object.values(answersRef.current).some((values) => values.length > 0),
    pendingKey: () => String(answerGeneration.current),
    discard: clearAnswers,
  }), [clearAnswers]);
  useEffect(
    () => consoleState.registerNavigationBlocker(navigationBlocker),
    [consoleState.registerNavigationBlocker, navigationBlocker],
  );
  const valid = ask.questions.every((question) => (answers[question.id]?.length ?? 0) > 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    try {
      if (await consoleState.answerAsk(answers)) clearAnswers();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="ask-card" onSubmit={(event) => void submit(event)}>
      <header>
        <span>Input needed</span>
        <small>{ask.questions.length} question{ask.questions.length === 1 ? "" : "s"}</small>
      </header>
      {ask.questions.map((question) => (
        <AskQuestionField
          key={question.id}
          question={question}
          values={answers[question.id] ?? []}
          onChange={(values) => setQuestionAnswers(question.id, values)}
        />
      ))}
      <button className="primary" type="submit" disabled={!valid || submitting}>
        {submitting ? "Submitting…" : "Submit answer"}
      </button>
    </form>
  );
}

function AskQuestionField({
  question,
  values,
  onChange,
}: {
  readonly question: AskQuestion;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
}) {
  const custom =
    values.find((value) => !question.choices?.some((choice) => choice.value === value)) ?? "";
  return (
    <fieldset>
      <legend>{question.prompt}</legend>
      {question.choices?.map((choice) => {
        const checked = values.includes(choice.value);
        return (
          <label className={`ask-choice${checked ? " is-selected" : ""}`} key={choice.value}>
            <input
              type={question.multiple ? "checkbox" : "radio"}
              name={question.id}
              checked={checked}
              onChange={() => onChange(
                question.multiple
                  ? checked
                    ? values.filter((value) => value !== choice.value)
                    : [...values, choice.value]
                  : [choice.value]
              )}
            />
            <span>
              <strong>{choice.label}</strong>
              {choice.description && <small>{choice.description}</small>}
            </span>
          </label>
        );
      })}
      {question.allowFreeText && (
        <label className="ask-custom">
          <span>Other</span>
          <textarea
            rows={2}
            value={custom}
            onChange={(event) => {
              const choices =
                values.filter((value) => question.choices?.some((choice) => choice.value === value));
              const value = event.target.value;
              onChange(
                value.trim()
                  ? question.multiple ? [...choices, value] : [value]
                  : choices,
              );
            }}
          />
        </label>
      )}
    </fieldset>
  );
}

function FailedDraftRecovery() {
  const consoleState = useConsole();
  const aui = useAui();
  const { draft, clear } = useFailedComposerDraft();
  const composerEmpty = useAuiState((state) => state.composer.isEmpty);
  const runtimeThreadId = useAuiState((state) => state.threads.mainThreadId);
  const restoring = useRef<number | undefined>(undefined);
  const restore = useCallback(async () => {
    if (draft === undefined || restoring.current === draft.id) return;
    const composer = aui.composer();
    const state = composer.getState();
    if (!state.isEmpty || state.quote !== undefined) {
      consoleState.reportError(
        "Your current draft must be sent or cleared before restoring the failed message.",
      );
      return;
    }
    restoring.current = draft.id;
    try {
      composer.setText(draft.text);
      for (const attachment of draft.attachments) {
        await composer.addAttachment({
          id: attachment.id,
          type: attachment.type,
          name: attachment.name,
          ...(attachment.contentType === undefined
            ? {}
            : { contentType: attachment.contentType }),
          content: attachment.content,
        });
      }
      if (draft.quote !== undefined) composer.setQuote(draft.quote);
      clear(draft);
    } catch (cause) {
      consoleState.reportError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "Could not restore the failed message.",
      );
    } finally {
      restoring.current = undefined;
    }
  }, [aui, clear, consoleState, draft]);

  useEffect(() => {
    if (
      draft !== undefined
      && runtimeThreadId === draft.threadId
      && consoleState.detail?.thread.id === draft.threadId
      && composerEmpty
      && !consoleState.submitting
      && aui.composer().getState().quote === undefined
    ) {
      void restore();
    }
  }, [
    aui,
    composerEmpty,
    consoleState.detail?.thread.id,
    consoleState.submitting,
    draft,
    restore,
    runtimeThreadId,
  ]);

  return draft === undefined ? null : (
    <div className="composer-recovery" role="status">
      <span>The failed message is saved.</span>
      <button type="button" onClick={() => void restore()}>
        Restore failed message
      </button>
    </div>
  );
}

export function Composer() {
  const consoleState = useConsole();
  const aui = useAui();
  const attachmentPreparation = useAttachmentPreparation();
  const composerGeneration = useRef(0);
  const composerResetPending = useRef(false);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const composerSignature = useAuiState((state) => JSON.stringify({
    text: state.composer.text,
    attachments: state.composer.attachments.map((attachment) => attachment.id),
    quote: state.composer.quote === undefined
      ? undefined
      : {
          messageId: state.composer.quote.messageId,
          text: state.composer.quote.text,
        },
  }));
  const previousComposerSignature = useRef(composerSignature);
  if (previousComposerSignature.current !== composerSignature) {
    previousComposerSignature.current = composerSignature;
    composerGeneration.current += 1;
    composerResetPending.current = false;
  }
  const canAttach =
    !isRunning
    && consoleState.selectedAgent?.capabilities.attachments === true;
  const canSteer =
    isRunning
    && consoleState.selectedAgent?.capabilities.liveInput === true;
  const canCancel =
    isRunning
    && consoleState.selectedAgent?.capabilities.cancellation === true;
  const navigationBlocker = useMemo(() => ({
    hasPending: () => {
      const state = aui.composer().getState();
      return (
        (
          !composerResetPending.current
          && (
            state.text.length > 0
            || state.attachments.length > 0
            || state.quote !== undefined
          )
        )
        || attachmentPreparation.hasPending
      );
    },
    pendingKey: () => {
      return JSON.stringify({
        composerGeneration: composerGeneration.current,
        ...(attachmentPreparation.pendingVersion === undefined
          ? {}
          : { attachmentPreparationVersion: attachmentPreparation.pendingVersion }),
      });
    },
    discard: async () => {
      // File picker, paste, and drop all share the adapter boundary. Abort and
      // settle every read before resetting the originating composer.
      await attachmentPreparation.abortPending();
      composerResetPending.current = true;
      try {
        await aui.composer().reset();
      } catch (cause) {
        composerResetPending.current = false;
        throw cause;
      }
    },
  }), [attachmentPreparation, aui]);
  useEffect(
    () => consoleState.registerNavigationBlocker(navigationBlocker),
    [consoleState.registerNavigationBlocker, navigationBlocker],
  );
  const commands = useMemo(() => buildComposerCommands({
    attachmentCount,
    canCancel,
    canCreateConversation: consoleState.selectedAgent?.online === true,
    hasRunSettings:
      consoleState.selectedAgent?.capabilities.runtimeOverrides === true,
    isRunning,
    createConversation: () => {
      void consoleState.createThread();
    },
    openRunSettings: () => {
      window.dispatchEvent(new Event(OPEN_RUN_SETTINGS_EVENT));
    },
    stopResponse: () => {
      void consoleState.cancel();
    },
  }), [
    attachmentCount,
    canCancel,
    consoleState.cancel,
    consoleState.createThread,
    consoleState.selectedAgent,
    isRunning,
  ]);
  const placeholder = useMemo(() => {
    const agentLabel = consoleState.selectedAgent?.label ?? "the agent";
    if (consoleState.selectedAgent?.online === false) return `${agentLabel} is offline`;
    if (isRunning && canSteer) return `Steer ${agentLabel} while it works…`;
    if (isRunning) return "The agent is working…";
    return `Message ${agentLabel}…`;
  }, [canSteer, consoleState.selectedAgent, isRunning]);

  return (
    <div className="composer-area">
      <AskUser />
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="composer composer-root">
          <ComposerTriggerPopover commands={commands} />
          <FailedDraftRecovery />
          <ComposerQuotePreview />
          <ComposerPrimitive.AttachmentDropzone
            className="composer-dropzone"
            disabled={!canAttach}
          >
            <AttachmentErrorListener />
            <ComposerAttachments />
            <div className="composer-input-row">
              <ComposerPrimitive.Input
                id="composer-input"
                className="composer-input"
                placeholder={placeholder}
                rows={1}
                submitMode="enter"
                aria-label="Message"
                disabled={isRunning && !canSteer}
                addAttachmentOnPaste={canAttach}
                unstable_insertNewlineOnTouchEnter
                unstable_focusOnRunStart={false}
                unstable_focusOnScrollToBottom={false}
                unstable_focusOnThreadSwitched={false}
              />
            </div>
            <div className="composer-toolbar">
              <div className="composer-tools">
                {canAttach && (
                  <ComposerPrimitive.AddAttachment
                    className="icon-button composer-tool"
                    aria-label="Attach files"
                    title="Attach files"
                    multiple
                  >
                    <Icon name="attach" size={17} />
                  </ComposerPrimitive.AddAttachment>
                )}
                <span className="composer-hint">
                  {isRunning
                    ? canSteer ? "Enter to steer this run" : "Live input unavailable"
                    : "Enter to send · / for commands"}
                </span>
              </div>
              <div className="composer-actions">
                <ComposerPrimitive.Send
                  className="send-button composer-send"
                  aria-label={isRunning ? "Send live follow-up" : "Send message"}
                  disabled={!canSend || (isRunning && !canSteer)}
                >
                  <Icon name="send" size={16} />
                </ComposerPrimitive.Send>
                {canCancel && (
                  <ComposerPrimitive.Cancel
                    className="stop-button composer-stop"
                    aria-label="Stop response"
                  >
                    <Icon name="stop" size={14} />
                    <span>Stop</span>
                  </ComposerPrimitive.Cancel>
                )}
              </div>
            </div>
          </ComposerPrimitive.AttachmentDropzone>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </div>
  );
}
