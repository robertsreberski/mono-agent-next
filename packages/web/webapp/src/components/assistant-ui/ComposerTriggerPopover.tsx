import {
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
} from "@assistant-ui/react";

import { Icon, type IconName } from "../Icon";

export interface ComposerTriggerCommand {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly execute: () => void;
}

export interface ComposerTriggerPopoverProps {
  readonly commands: readonly ComposerTriggerCommand[];
  readonly className?: string;
}

/**
 * Isolates assistant-ui's unstable slash-command API behind an app-owned
 * contract. Command syntax is removed before any UI command executes so it can
 * never leak into the model-visible message.
 */
export function ComposerTriggerPopover({
  commands,
  className,
}: ComposerTriggerPopoverProps) {
  const slash = unstable_useSlashCommandAdapter({
    commands,
    removeOnExecute: true,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
      aria-label="Commands"
      data-slot="composer-trigger-popover"
      className={[
        "composer-trigger-popover",
        className,
      ].filter(Boolean).join(" ")}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        onExecute={slash.action.onExecute}
        removeOnExecute={slash.action.removeOnExecute}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems aria-label="Available commands">
        {(items) => (
          <div className="composer-trigger-list" data-slot="composer-trigger-list">
            {items.map((item, index) => {
              const icon = isIconName(item.metadata?.icon)
                ? item.metadata.icon
                : "settings";
              return (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  className="composer-trigger-item"
                  data-slot="composer-trigger-item"
                >
                  <span
                    className="composer-trigger-item-icon"
                    data-command-icon={icon}
                    aria-hidden="true"
                  >
                    <Icon name={icon} size={16} />
                  </span>
                  <span className="composer-trigger-item-copy">
                    <strong>{item.label}</strong>
                    {item.description && <small>{item.description}</small>}
                  </span>
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              );
            })}
            {items.length === 0 && (
              <div
                className="composer-trigger-empty"
                data-slot="composer-trigger-empty"
                role="status"
              >
                No matching commands
              </div>
            )}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

function isIconName(value: unknown): value is IconName {
  return (
    value === "archive"
    || value === "attach"
    || value === "check"
    || value === "chevron"
    || value === "close"
    || value === "copy"
    || value === "more"
    || value === "quote"
    || value === "restore"
    || value === "send"
    || value === "settings"
    || value === "spark"
    || value === "stop"
    || value === "trash"
  );
}
