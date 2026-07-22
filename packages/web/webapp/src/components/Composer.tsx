import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import { canUploadInConsole } from "../capabilities";
import { useConsoleStore } from "../console-store";
import { AttachmentErrorListener, ComposerAttachments } from "./Attachments";
import {
  ComposerTriggerPopover,
  type ComposerTriggerCommand,
} from "./assistant-ui/ComposerTriggerPopover";
import { Icon } from "./Icon";
import { ComposerQuotePreview } from "./assistant-ui/Quote";

interface BuildComposerCommandsOptions {
  readonly attachmentCount: number;
  readonly hasAgent: boolean;
  readonly hasRunSettings: boolean;
  readonly isRunning: boolean;
  readonly createConversation: () => void;
  readonly openRunSettings: () => void;
  readonly stopResponse: () => void;
}

export const buildComposerCommands = ({
  attachmentCount,
  hasAgent,
  hasRunSettings,
  isRunning,
  createConversation,
  openRunSettings,
  stopResponse,
}: BuildComposerCommandsOptions): readonly ComposerTriggerCommand[] => [
  ...(!isRunning && hasRunSettings
    ? [{
        id: "settings",
        label: "Run settings",
        description: "Choose the model and reasoning effort",
        icon: "settings",
        execute: openRunSettings,
      }]
    : []),
  ...(isRunning
    ? [{
        id: "stop",
        label: "Stop response",
        description: "Cancel the current agent run",
        icon: "stop",
        execute: stopResponse,
      }]
    : []),
  ...(!isRunning && hasAgent && attachmentCount === 0
    ? [{
        id: "new",
        label: "New conversation",
        description: "Start a clean conversation with this agent",
        icon: "new",
        execute: createConversation,
      }]
    : []),
];

export function Composer() {
  const store = useConsoleStore();
  const { connection, selectedAgent, selectedThread } = store;
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canUpload = !isRunning && canUploadInConsole(connection, selectedAgent, selectedThread);
  const canSend = useAuiState((state) => state.composer.canSend);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const commands = useMemo(() => buildComposerCommands({
    attachmentCount,
    hasAgent: selectedAgent !== null,
    hasRunSettings: store.modelOptions.length > 0 || store.effortOptions.length > 0,
    isRunning,
    createConversation: () => void store.createThread().catch(() => undefined),
    openRunSettings: () => window.dispatchEvent(new Event("mono-agent:run-settings")),
    stopResponse: () => void store.cancelTurn().catch(() => undefined),
  }), [attachmentCount, isRunning, selectedAgent, store]);
  const statusText =
    selectedAgent?.status === "offline"
      ? `${selectedAgent.label} is offline`
      : selectedThread?.archivedAt
        ? "Conversation archived"
        : undefined;

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="composer-root">
        <ComposerTriggerPopover commands={commands} />
        <ComposerQuotePreview />
        <ComposerPrimitive.AttachmentDropzone
          className="composer-dropzone"
          disabled={!canUpload}
        >
          <AttachmentErrorListener />
          <ComposerAttachments />
          <div className="composer-input-row">
            <ComposerPrimitive.Input
              id="composer-input"
              className="composer-input"
              placeholder={statusText ?? (isRunning
                ? `Steer ${selectedAgent?.label ?? "the agent"} while it works…`
                : `Message ${selectedAgent?.label ?? "an agent"}…`)}
              aria-label="Message"
              rows={1}
              addAttachmentOnPaste={canUpload}
              submitMode="enter"
              unstable_insertNewlineOnTouchEnter
              unstable_focusOnRunStart={false}
              unstable_focusOnScrollToBottom={false}
              unstable_focusOnThreadSwitched={false}
            />
          </div>
          <div className="composer-toolbar">
            <div className="composer-tools">
              {canUpload && (
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
                {statusText ?? (isRunning ? "Enter to steer this run" : "Enter to send · / for commands")}
              </span>
            </div>
            <div className="composer-actions">
              <ComposerPrimitive.Send
                className="composer-send"
                aria-label={isRunning ? "Send live follow-up" : "Send message"}
                disabled={!canSend}
              >
                <Icon name="send" size={16} />
              </ComposerPrimitive.Send>
              {isRunning && (
                <ComposerPrimitive.Cancel className="composer-stop" aria-label="Stop response">
                  <Icon name="stop" size={14} />
                  <span>Stop</span>
                </ComposerPrimitive.Cancel>
              )}
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
