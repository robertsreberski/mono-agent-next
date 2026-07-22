import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import { Icon } from "./Icon";

const announce = (message: string) => {
  window.dispatchEvent(
    new CustomEvent("mono-agent:notice", { detail: { message, tone: "error" } }),
  );
};

export function AttachmentErrorListener() {
  useAuiEvent("composer.attachmentAddError", ({ reason, message }) => {
    announce(
      reason === "not-accepted"
        ? "That file type is not supported by this agent."
        : message || "The attachment could not be uploaded.",
    );
  });
  return null;
}

function AttachmentChip({ removable }: { readonly removable: boolean }) {
  const aui = useAui();
  const status = useAuiState((state) => state.attachment.status);
  const type = useAuiState((state) => state.attachment.type);
  const name = useAuiState((state) => state.attachment.name);
  const content = useAuiState((state) => state.attachment.content);
  const isUploading = status.type === "running";
  const isError = status.type === "incomplete";
  const progress = isUploading ? status.progress : 100;
  const isMessageAttachment = aui.attachment.source === "message";
  const image = content?.find((part) => part.type === "image");
  const file = content?.find((part) => part.type === "file");
  const href = image?.type === "image" ? image.image : file?.type === "file" ? file.data : undefined;
  const chipContent = (
    <>
      <span className="attachment-icon">
        {image?.type === "image" && href ? (
          <img src={href} alt="" loading="lazy" />
        ) : (
          <Icon name={type === "image" ? "spark" : "file"} size={15} />
        )}
      </span>
      <span className="attachment-name">
        <AttachmentPrimitive.Name />
      </span>
    </>
  );

  return (
    <AttachmentPrimitive.Root
      className={`attachment-chip${isError ? " is-error" : ""}`}
      aria-label={`${type} attachment${isUploading ? `, ${progress}% uploaded` : ""}`}
    >
      {isMessageAttachment && href ? (
        <a
          className="attachment-link"
          href={href}
          target={type === "image" ? "_blank" : undefined}
          rel={type === "image" ? "noreferrer" : undefined}
          download={type === "image" ? undefined : name}
          aria-label={`${type === "image" ? "Open" : "Download"} ${name}`}
        >
          {chipContent}
        </a>
      ) : (
        chipContent
      )}
      {isUploading && (
        <span
          className="attachment-progress"
          style={{ "--upload-progress": `${progress}%` } as React.CSSProperties}
          aria-hidden="true"
        />
      )}
      {isError && <span className="attachment-error">Upload failed</span>}
      {removable && (
        <AttachmentPrimitive.Remove className="icon-button attachment-remove" aria-label="Remove file">
          <Icon name="close" size={14} />
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
}

export function ComposerAttachments() {
  return (
    <div className="composer-attachments">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentChip removable />}
      </ComposerPrimitive.Attachments>
    </div>
  );
}

export function UserMessageAttachments() {
  return (
    <div className="message-attachments">
      <MessagePrimitive.Attachments>
        {() => <AttachmentChip removable={false} />}
      </MessagePrimitive.Attachments>
    </div>
  );
}
