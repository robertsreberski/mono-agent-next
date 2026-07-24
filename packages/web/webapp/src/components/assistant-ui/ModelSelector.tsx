import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Command } from "cmdk";
import { useMemo, useState } from "react";

import type { ModelOption } from "../../types";
import { Icon } from "../Icon";

/** `{ runtime, id }` is one atomic route; neither half is selectable alone. */
export interface ModelRoute {
  readonly runtime: string;
  readonly id: string;
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const routeKey = (route: ModelRoute): string => `${route.runtime}\0${route.id}`;
const modelName = (model: ModelOption): string => model.label ?? model.id;

export function ModelSelector({
  models,
  route,
  effort,
  disabled = false,
  onRouteChange,
  onEffortChange,
}: {
  readonly models: readonly ModelOption[];
  readonly route?: ModelRoute;
  readonly effort: string;
  readonly disabled?: boolean;
  readonly onRouteChange: (route: ModelRoute) => void;
  readonly onEffortChange: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => route === undefined
      ? undefined
      : models.find((model) => model.runtime === route.runtime && model.id === route.id),
    [models, route],
  );
  // Effort choices belong to the exact route. Offering a level the selected
  // model never advertised would only fail closed at the runtime boundary.
  const efforts = selected?.efforts ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="model-selector__trigger"
        disabled={disabled}
        aria-label="Run settings"
        title={disabled ? "Run settings are locked while a turn is running" : "Run settings"}
      >
        <span className="model-selector__value">
          <span className="model-selector__model-name">
            {selected === undefined ? "Automatic model" : modelName(selected)}
          </span>
          {effort !== "" && <span className="model-selector__effort-value">{EFFORT_LABELS[effort] ?? effort}</span>}
        </span>
        <Icon name="chevron" size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Backdrop className="model-selector__backdrop" />
        <Popover.Positioner className="model-selector__positioner" sideOffset={8} align="end">
          <Popover.Popup className="model-selector__content" data-slot="model-selector-content">
            <Command className="model-selector__command" label="Select a model">
              <div className="model-selector__search-wrapper">
                <Icon name="search" size={16} />
                <Command.Input
                  className="model-selector__search"
                  placeholder="Search models"
                  aria-label="Search models"
                />
              </div>
              <Command.List className="model-selector__list">
                <Command.Empty className="model-selector__empty">No matching models</Command.Empty>
                <Command.Group className="model-selector__group">
                  {models.map((model) => {
                    const isSelected = selected !== undefined
                      && selected.runtime === model.runtime
                      && selected.id === model.id;
                    return (
                      <Command.Item
                        key={routeKey(model)}
                        value={`${modelName(model)} ${model.runtime} ${model.id}`}
                        className="model-selector__item"
                        onSelect={() => {
                          onRouteChange({ runtime: model.runtime, id: model.id });
                          setOpen(false);
                        }}
                      >
                        <span className="model-selector__item-copy">
                          <span className="model-selector__item-name">{modelName(model)}</span>
                          <span className="model-selector__item-description">
                            {model.runtime} · {model.id}
                          </span>
                        </span>
                        {isSelected && (
                          <span className="model-selector__selected-indicator">
                            <Icon name="check" size={14} />
                          </span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              </Command.List>
            </Command>
            {efforts.length > 0 && (
              <div className="model-selector__effort">
                <span className="model-selector__effort-label" id="model-selector-effort-label">
                  Reasoning effort
                </span>
                <RadioGroup
                  className="model-selector__effort-options"
                  aria-labelledby="model-selector-effort-label"
                  value={effort}
                  onValueChange={(value) => onEffortChange(String(value))}
                >
                  <Radio.Root className="model-selector__effort-option" value="">
                    Automatic
                  </Radio.Root>
                  {efforts.map((level) => (
                    <Radio.Root key={level} className="model-selector__effort-option" value={level}>
                      {EFFORT_LABELS[level] ?? level}
                    </Radio.Root>
                  ))}
                </RadioGroup>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
