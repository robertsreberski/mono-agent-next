import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import type { CSSProperties } from "react";

import { useConsole } from "../console";
import { Icon } from "./Icon";

const DISCARDED_ATTACHMENT_MESSAGE = "Attachment preparation was discarded.";

/**
 * Keeps attachment failures on the console's existing error surface while
 * letting assistant-ui own file-picker, paste, and drop interactions.
 */
export function AttachmentErrorListener() {
  const consoleState = useConsole();
  useAuiEvent("composer.attachmentAddError", ({ message, reason }) => {
    // assistant-ui's public event omits the original Error. This exact message
    // is the inline adapter's intentional navigation-discard signal.
    if (message === DISCARDED_ATTACHMENT_MESSAGE) return;
    consoleState.reportError(
      reason === "not-accepted"
        ? "That file type is not supported by this agent."
        : message || "The attachment could not be prepared.",
    );
  });
  return null;
}

function ComposerAttachmentChip() {
  const status = useAuiState((state) => state.attachment.status);
  const type = useAuiState((state) => state.attachment.type);
  const name = useAuiState((state) => state.attachment.name);
  const content = useAuiState((state) => state.attachment.content);
  const isPreparing = status.type === "running";
  const isError = status.type === "incomplete";
  const progress = isPreparing ? status.progress : 100;
  const image = content?.find((part) => part.type === "image");
  const imageUrl = image?.type === "image" ? image.image : undefined;

  return (
    <AttachmentPrimitive.Root asChild>
      <div
        className={`attachment-chip${isError ? " is-error" : ""}`}
        aria-label={`${name}, ${type} attachment${isPreparing ? `, ${progress}% prepared` : ""}`}
        role="listitem"
      >
        <span className="attachment-icon" aria-hidden="true">
          {imageUrl === undefined
            ? <Icon name={type === "image" ? "spark" : "attach"} size={15} />
            : <img src={imageUrl} alt="" loading="lazy" />}
        </span>
        <span className="attachment-name" title={name}>
          <AttachmentPrimitive.Name />
        </span>
        {isPreparing && (
          <span
            className="attachment-progress"
            style={{ "--upload-progress": `${progress}%` } as CSSProperties}
            aria-hidden="true"
          />
        )}
        {isError && <span className="attachment-error">Preparation failed</span>}
        <AttachmentPrimitive.Remove
          className="icon-button attachment-remove"
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
        >
          <Icon name="close" size={14} />
        </AttachmentPrimitive.Remove>
      </div>
    </AttachmentPrimitive.Root>
  );
}

export function ComposerAttachments() {
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  if (attachmentCount === 0) return null;
  return (
    <div
      className="composer-attachments pending-files"
      aria-label="Files ready to send"
      role="list"
    >
      <ComposerPrimitive.Attachments>
        {() => <ComposerAttachmentChip />}
      </ComposerPrimitive.Attachments>
    </div>
  );
}
