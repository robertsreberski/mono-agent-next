import {
  AttachmentPrimitive,
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
import { useFailedComposerDraft } from "../runtime";
import type { Ask, AskQuestion } from "../types";
import { Icon } from "./Icon";
import { Popover } from "./Popover";

function AskUser() {
  const consoleState = useConsole();
  const ask = consoleState.detail?.thread.pendingAsk;
  return ask === undefined ? null : <AskUserForm key={ask.interactionId} ask={ask} />;
}

function AskUserForm({ ask }: { readonly ask: Ask }) {
  const consoleState = useConsole();
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const navigationBlocker = useMemo(() => ({
    // Keeping the server-side question visible is itself pending work. This
    // deliberately guards even before the first local choice is made.
    hasPending: () => true,
    discard: () => setAnswers({}),
  }), []);
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
      if (await consoleState.answerAsk(answers)) setAnswers({});
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
          onChange={(values) => setAnswers((current) => ({ ...current, [question.id]: values }))}
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

function QuotePreview() {
  return (
    <ComposerPrimitive.Quote className="composer-quote">
      <Icon name="quote" size={14} />
      <ComposerPrimitive.QuoteText className="composer-quote-text" />
      <ComposerPrimitive.QuoteDismiss
        className="composer-quote-dismiss"
        aria-label="Remove quote"
        title="Remove quote"
      >
        <Icon name="close" size={13} />
      </ComposerPrimitive.QuoteDismiss>
    </ComposerPrimitive.Quote>
  );
}

function RunSettings({ disabled }: { readonly disabled: boolean }) {
  const consoleState = useConsole();
  const models = consoleState.selectedAgent?.models;
  const selectedRuntime =
    consoleState.runtime || consoleState.selectedAgent?.defaults?.runtime || "";
  const selectedModel =
    consoleState.model || consoleState.selectedAgent?.defaults?.model || "";
  const model = models?.find((candidate) =>
    candidate.runtime === selectedRuntime && candidate.id === selectedModel
  );
  const efforts = model?.efforts ?? [];
  const selectedRoute = consoleState.runtime && consoleState.model
    ? routeKey(consoleState.runtime, consoleState.model)
    : "";
  if (consoleState.selectedAgent?.capabilities.runtimeOverrides !== true) return null;
  return (
    <Popover
      id="run-settings"
      triggerLabel="Run settings"
      triggerClassName="composer-settings-trigger"
      panelClassName="composer-settings-panel"
      placement="top-start"
      trigger={(
        <>
          <Icon name="settings" size={16} />
          <span>Run settings</span>
          <Icon name="chevron" size={13} />
        </>
      )}
    >
      {() => (
        <>
          <label>
            <span>Model</span>
            <select
              disabled={disabled || models === undefined}
              value={selectedRoute}
              onChange={(event) => {
                const route = models?.find(
                  (candidate) => routeKey(candidate.runtime, candidate.id) === event.target.value,
                );
                consoleState.setRuntime(route?.runtime ?? "");
                consoleState.setModel(route?.id ?? "");
                consoleState.setEffort("");
              }}
            >
              <option value="">
                {models === undefined ? "Model catalog unavailable" : "Default model"}
              </option>
              {models?.map((option) => (
                <option
                  key={routeKey(option.runtime, option.id)}
                  value={routeKey(option.runtime, option.id)}
                >
                  {option.label ?? option.id} — {option.runtime}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Reasoning effort</span>
            <select
              disabled={disabled || efforts.length === 0}
              value={consoleState.effort}
              onChange={(event) => consoleState.setEffort(event.target.value)}
            >
              <option value="">Default effort</option>
              {efforts.map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
          </label>
          {disabled && <p>Run settings are locked while this response is active.</p>}
        </>
      )}
    </Popover>
  );
}

function routeKey(runtime: string, model: string): string {
  return JSON.stringify([runtime, model]);
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

function PendingAttachments() {
  const count = useAuiState((state) => state.composer.attachments.length);
  return count === 0 ? null : (
    <ul className="pending-files" aria-label="Files ready to upload">
      <ComposerPrimitive.Attachments>
        {({ attachment }) => (
          <AttachmentPrimitive.Root asChild>
            <li>
              <Icon name="attach" size={13} />
              <span><AttachmentPrimitive.Name /></span>
              <AttachmentPrimitive.Remove
                aria-label={`Remove ${attachment.name}`}
                title={`Remove ${attachment.name}`}
              >
                <Icon name="close" size={12} />
              </AttachmentPrimitive.Remove>
            </li>
          </AttachmentPrimitive.Root>
        )}
      </ComposerPrimitive.Attachments>
    </ul>
  );
}

export function Composer() {
  const consoleState = useConsole();
  const aui = useAui();
  const fileInput = useRef<HTMLInputElement>(null);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
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
        state.text.length > 0
        || state.attachments.length > 0
        || state.quote !== undefined
      );
    },
    discard: async () => {
      await aui.composer().reset();
    },
  }), [aui]);
  useEffect(
    () => consoleState.registerNavigationBlocker(navigationBlocker),
    [consoleState.registerNavigationBlocker, navigationBlocker],
  );
  const addFiles = useCallback(async (files: FileList) => {
    for (const file of files) {
      try {
        await aui.composer().addAttachment(file);
      } catch (cause) {
        consoleState.reportError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : `Could not attach ${file.name}.`,
        );
      }
    }
  }, [aui, consoleState]);
  const placeholder = useMemo(() => {
    if (isRunning && canSteer) return "Steer the active run…";
    if (isRunning) return "The agent is working…";
    return "Message the agent…";
  }, [canSteer, isRunning]);

  return (
    <div className="composer-area">
      <AskUser />
      <ComposerPrimitive.Root className="composer">
        <FailedDraftRecovery />
        <QuotePreview />
        <PendingAttachments />
        <ComposerPrimitive.Input
          id="composer-input"
          className="composer-input"
          placeholder={placeholder}
          rows={1}
          submitMode="enter"
          aria-label="Message"
          disabled={isRunning && !canSteer}
          unstable_focusOnRunStart={false}
          unstable_focusOnScrollToBottom={false}
          unstable_focusOnThreadSwitched={false}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            {canAttach && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.target.files) void addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="composer-tool"
                  onClick={() => fileInput.current?.click()}
                  title="Attach files"
                  aria-label="Attach files"
                >
                  <Icon name="attach" size={16} />
                </button>
              </>
            )}
            <RunSettings disabled={isRunning} />
            <span className="composer-hint">
              {isRunning
                ? canSteer ? "Enter to steer this run" : "Live input unavailable"
                : "Enter to send · Shift+Enter for a new line"}
            </span>
          </div>
          <div className="composer-actions">
            <ComposerPrimitive.Send
              className="send-button"
              aria-label={isRunning ? "Send live input" : "Send message"}
              disabled={!canSend || (isRunning && !canSteer)}
            >
              <Icon name="send" size={16} />
            </ComposerPrimitive.Send>
            {canCancel && (
              <ComposerPrimitive.Cancel className="stop-button" aria-label="Stop response">
                <Icon name="stop" size={14} />
                <span>Stop</span>
              </ComposerPrimitive.Cancel>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
