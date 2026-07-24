import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { type FormEvent, useMemo, useRef, useState } from "react";

import { useConsole } from "../console";
import type { Ask, AskQuestion } from "../types";
import { Icon } from "./Icon";

function AskUser() {
  const consoleState = useConsole();
  const ask = consoleState.detail?.thread.pendingAsk;
  return ask === undefined ? null : <AskUserForm key={ask.interactionId} ask={ask} />;
}

function AskUserForm({ ask }: { readonly ask: Ask }) {
  const consoleState = useConsole();
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const valid = ask.questions.every((question) => (answers[question.id]?.length ?? 0) > 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    try {
      await consoleState.answerAsk(answers);
      setAnswers({});
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
  const model = models?.find((candidate) =>
    candidate.id === (consoleState.model || consoleState.selectedAgent?.defaults?.model)
  );
  const efforts = model?.efforts;
  if (consoleState.selectedAgent?.capabilities.runtimeOverrides !== true) return null;
  return (
    <details className="composer-settings-menu">
      <summary title="Run settings" aria-label="Run settings">
        <Icon name="settings" size={16} />
        <span>Run settings</span>
        <Icon name="chevron" size={13} />
      </summary>
      <div className="composer-settings-panel">
        <label>
          <span>Model</span>
          {models === undefined ? (
            <input
              disabled={disabled}
              value={consoleState.model}
              onChange={(event) => {
                consoleState.setModel(event.target.value);
                consoleState.setEffort("");
              }}
              placeholder="Provider model ID"
            />
          ) : (
            <select
              disabled={disabled}
              value={consoleState.model}
              onChange={(event) => {
                consoleState.setModel(event.target.value);
                consoleState.setEffort("");
              }}
            >
              <option value="">Default model</option>
              {models.map((option) => (
                <option key={option.id} value={option.id}>{option.label ?? option.id}</option>
              ))}
            </select>
          )}
        </label>
        <label>
          <span>Reasoning effort</span>
          {efforts === undefined ? (
            <input
              disabled={disabled}
              value={consoleState.effort}
              onChange={(event) => consoleState.setEffort(event.target.value)}
              placeholder="Default"
            />
          ) : (
            <select
              disabled={disabled}
              value={consoleState.effort}
              onChange={(event) => consoleState.setEffort(event.target.value)}
            >
              <option value="">Default effort</option>
              {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          )}
        </label>
        <details className="composer-advanced">
          <summary>Advanced</summary>
          <label>
            <span>Runtime ID</span>
            <input
              disabled={disabled}
              value={consoleState.runtime}
              onChange={(event) => consoleState.setRuntime(event.target.value)}
              placeholder="Arbitrary runtime ID"
            />
          </label>
        </details>
        {disabled && <p>Run settings are locked while this response is active.</p>}
      </div>
    </details>
  );
}

export function Composer() {
  const consoleState = useConsole();
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
  const placeholder = useMemo(() => {
    if (isRunning && canSteer) return "Steer the active run…";
    if (isRunning) return "The agent is working…";
    return "Message the agent…";
  }, [canSteer, isRunning]);

  return (
    <div className="composer-area">
      <AskUser />
      <ComposerPrimitive.Root className="composer">
        <QuotePreview />
        {consoleState.pendingFiles.length > 0 && (
          <ul className="pending-files" aria-label="Files ready to upload">
            {consoleState.pendingFiles.map((file, index) => (
              <li key={`${file.name}:${index}`}>
                <Icon name="attach" size={13} />
                <span>{file.name}</span>
                <button
                  type="button"
                  onClick={() => consoleState.removeFile(index)}
                  aria-label={`Remove ${file.name}`}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
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
                    if (event.target.files) consoleState.addFiles(event.target.files);
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
