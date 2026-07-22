import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";

export type ModelSelectorEffortOption = {
  readonly id: string;
  readonly name: string;
};

export type ModelSelectorOption = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly efforts: readonly ModelSelectorEffortOption[];
};

export type ModelSelectorProps = {
  readonly models: readonly ModelSelectorOption[];
  readonly value: string;
  readonly effort: string;
  readonly onValueChange: (value: string) => void;
  readonly onEffortChange: (effort: string) => void;
  readonly disabled?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
};

const commandValue = (model: ModelSelectorOption, index: number) =>
  `model-${index}:${model.id || "automatic"}`;

/**
 * Controlled model and reasoning-effort picker adapted from assistant-ui's
 * Base UI model-selector registry component. The data-slot names intentionally
 * follow the upstream registry so styling and future source comparisons remain
 * straightforward.
 *
 * Source: https://r.assistant-ui.com/base/model-selector.json
 */
export function ModelSelector({
  models,
  value,
  effort,
  onValueChange,
  onEffortChange,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: ModelSelectorProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === value) ?? models[0],
    [models, value],
  );
  const activeEffort = selectedModel?.efforts.find((option) => option.id === effort);
  const selectedCommandValue = selectedModel
    ? commandValue(selectedModel, Math.max(models.indexOf(selectedModel), 0))
    : undefined;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!open) {
      setQuery("");
      return;
    }
    searchRef.current?.focus();
  }, [disabled, open, setOpen]);

  const selectModel = (model: ModelSelectorOption) => {
    onValueChange(model.id);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        ref={triggerRef}
        data-slot="model-selector-trigger"
        className="model-selector__trigger"
        aria-label="Model and reasoning effort"
        aria-haspopup="dialog"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span data-slot="model-selector-value" className="model-selector__value">
          <span className="model-selector__model-name">
            {selectedModel?.name ?? "Select model"}
          </span>
          {activeEffort && (
            <span className="model-selector__effort-value">{activeEffort.name}</span>
          )}
        </span>
        <Icon name="arrow-down" size={14} />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Backdrop
          data-slot="model-selector-backdrop"
          className="model-selector__backdrop"
        />
        <Popover.Positioner
          data-slot="model-selector-positioner"
          className="model-selector__positioner"
          align="start"
          side="bottom"
          sideOffset={6}
        >
          <Popover.Popup
            data-slot="model-selector-content"
            className="model-selector__content"
            aria-label="Model and reasoning effort"
          >
            <Command
              data-slot="model-selector-command"
              className="model-selector__command"
              label="Search models"
              loop
              shouldFilter
              {...(selectedCommandValue ? { defaultValue: selectedCommandValue } : {})}
            >
              <div
                data-slot="model-selector-search-wrapper"
                className="model-selector__search-wrapper"
              >
                <Icon name="search" size={15} />
                <Command.Input
                  ref={searchRef}
                  data-slot="model-selector-search"
                  className="model-selector__search"
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search models…"
                  aria-label="Search models"
                />
              </div>

              <Command.List
                data-slot="model-selector-list"
                className="model-selector__list"
              >
                <Command.Empty
                  data-slot="model-selector-empty"
                  className="model-selector__empty"
                >
                  No models found.
                </Command.Empty>
                <Command.Group
                  data-slot="model-selector-group"
                  className="model-selector__group"
                >
                  {models.map((model, index) => {
                    const selected = model.id === value;
                    return (
                      <Command.Item
                        key={`${model.id}:${model.name}`}
                        data-slot="model-selector-item"
                        data-model-selected={selected || undefined}
                        className="model-selector__item"
                        value={commandValue(model, index)}
                        keywords={[
                          model.id,
                          model.name,
                          ...(model.description ? [model.description] : []),
                        ]}
                        onSelect={() => selectModel(model)}
                      >
                        <span className="model-selector__item-copy">
                          <span className="model-selector__item-name">{model.name}</span>
                          {model.description && (
                            <span className="model-selector__item-description">
                              {model.description}
                            </span>
                          )}
                        </span>
                        {selected && (
                          <span
                            data-slot="model-selector-selected-indicator"
                            className="model-selector__selected-indicator"
                            aria-hidden="true"
                          >
                            <Icon name="check" size={15} />
                          </span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              </Command.List>

              {(selectedModel?.efforts.length ?? 0) > 0 && (
                <div
                  data-slot="model-selector-effort"
                  className="model-selector__effort"
                  onKeyDown={(event) => {
                    if (event.key === "Home" || event.key === "End") {
                      event.stopPropagation();
                    }
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      searchRef.current?.focus();
                    }
                  }}
                >
                  <span className="model-selector__effort-label">Thinking</span>
                  <RadioGroup
                    className="model-selector__effort-options"
                    value={activeEffort?.id ?? ""}
                    onValueChange={(nextEffort) => onEffortChange(nextEffort)}
                    aria-label="Reasoning effort"
                  >
                    {selectedModel?.efforts.map((option) => (
                      <Radio.Root
                        key={`${option.id}:${option.name}`}
                        data-slot="model-selector-effort-option"
                        className="model-selector__effort-option"
                        value={option.id}
                      >
                        {option.name}
                      </Radio.Root>
                    ))}
                  </RadioGroup>
                </div>
              )}
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
