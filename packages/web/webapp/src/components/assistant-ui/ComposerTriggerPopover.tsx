import {
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
} from "@assistant-ui/react";
import { Icon, type IconName } from "../Icon";

export interface ComposerTriggerCommand {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly execute: () => void;
}

export interface ComposerTriggerPopoverProps {
  readonly commands: readonly ComposerTriggerCommand[];
  readonly className?: string;
}

const iconNames = new Set<IconName>([
  "agent",
  "archive",
  "arrow-down",
  "attach",
  "check",
  "chevron",
  "close",
  "command",
  "copy",
  "file",
  "menu",
  "more",
  "new",
  "restore",
  "search",
  "send",
  "settings",
  "spark",
  "star",
  "stop",
  "threads",
]);

const commandIcon = (value: unknown): IconName =>
  typeof value === "string" && iconNames.has(value as IconName)
    ? value as IconName
    : "command";

/**
 * Slash-command picker isolated from the assistant-ui unstable trigger API.
 * Keep consumers on this small, app-owned contract so an upstream API change
 * only requires changes in this module.
 */
export function ComposerTriggerPopover({
  commands,
  className,
}: ComposerTriggerPopoverProps) {
  const slash = unstable_useSlashCommandAdapter({
    commands,
    // These commands mutate console UI state; they must never leave command
    // syntax behind in the model-visible prompt.
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
              const icon = commandIcon(item.metadata?.icon);
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
