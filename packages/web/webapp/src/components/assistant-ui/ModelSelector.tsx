import { Command } from "cmdk";
import { useId } from "react";

import type { ModelOption } from "../../types";
import { Icon } from "../Icon";
import { Popover } from "../Popover";

export interface ModelRoute {
  readonly runtime: string;
  readonly id: string;
}

export interface ModelSelectorProps {
  /** The exact model catalog advertised by the selected agent. */
  readonly models?: readonly ModelOption[];
  /** An authored override. Undefined means follow the agent default. */
  readonly route?: ModelRoute;
  /** The advertised agent default, used only to validate effort choices in Automatic mode. */
  readonly defaultRoute?: ModelRoute;
  /** An authored effort override. The empty string means automatic. */
  readonly effort: string;
  /** Receives runtime and model together so an invalid partial route cannot be authored. */
  readonly onRouteChange: (route: ModelRoute | undefined) => void;
  readonly onEffortChange: (effort: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly popoverId?: string;
  /** Accessible name for both trigger and panel, for example "Run settings". */
  readonly triggerLabel?: string;
}

interface ModelSelectorPanelProps {
  readonly close: () => void;
  readonly effort: string;
  readonly effortModel: ModelOption | undefined;
  readonly models: readonly ModelOption[] | undefined;
  readonly onEffortChange: (effort: string) => void;
  readonly onRouteChange: (route: ModelRoute | undefined) => void;
  readonly selectedModel: ModelOption | undefined;
}

const routeKey = (route: ModelRoute): string =>
  JSON.stringify([route.runtime, route.id]);

const commandValue = (model: ModelOption, index: number): string =>
  `model-${index}:${routeKey(modelRoute(model))}`;

const modelRoute = (model: ModelOption): ModelRoute => ({
  runtime: model.runtime,
  id: model.id,
});

const modelName = (model: ModelOption): string => model.label ?? model.id;

const compactCount = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(value);
};

const effortLabel = (effort: string): string =>
  effort.length === 0 ? "Automatic" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;

const joinClassNames = (...values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(" ");

export function ModelSelector({
  models,
  route,
  defaultRoute,
  effort,
  onRouteChange,
  onEffortChange,
  disabled = false,
  className,
  popoverId,
  triggerLabel = "Model and reasoning effort",
}: ModelSelectorProps) {
  const generatedId = useId().replaceAll(":", "");
  const selectedModel = route === undefined
    ? undefined
    : models?.find((candidate) =>
        candidate.runtime === route.runtime && candidate.id === route.id
      );
  const effortModel = selectedModel ?? (
    defaultRoute === undefined
      ? undefined
      : models?.find((candidate) =>
          candidate.runtime === defaultRoute.runtime && candidate.id === defaultRoute.id
        )
  );
  const selectedEffort =
    effortModel?.efforts?.includes(effort) === true ? effort : "";
  const trigger = (
    <>
      <span className="model-selector__value" data-slot="model-selector-value">
        <span className="model-selector__model-name">
          {selectedModel === undefined ? "Automatic" : modelName(selectedModel)}
        </span>
        {selectedEffort.length > 0 && (
          <span className="model-selector__effort-value">
            {effortLabel(selectedEffort)}
          </span>
        )}
      </span>
      <Icon name="chevron" size={14} />
    </>
  );
  const triggerClassName = joinClassNames("model-selector__trigger", className);

  if (disabled) {
    return (
      <span className="popover-anchor">
        <button
          type="button"
          className={triggerClassName}
          aria-label={triggerLabel}
          title="Run settings are locked while this response is active."
          disabled
        >
          {trigger}
        </button>
      </span>
    );
  }

  return (
    <Popover
      id={popoverId ?? `model-selector-${generatedId}`}
      triggerLabel={triggerLabel}
      triggerClassName={triggerClassName}
      panelClassName="model-selector__content"
      placement="top-start"
      trigger={trigger}
    >
      {(close) => (
        <ModelSelectorPanel
          close={close}
          effort={selectedEffort}
          effortModel={effortModel}
          models={models}
          onEffortChange={onEffortChange}
          onRouteChange={onRouteChange}
          selectedModel={selectedModel}
        />
      )}
    </Popover>
  );
}

function ModelSelectorPanel({
  close,
  effort,
  effortModel,
  models,
  onEffortChange,
  onRouteChange,
  selectedModel,
}: ModelSelectorPanelProps) {
  const effortGroupId = useId();
  const selectedCommandValue = selectedModel === undefined
    ? "automatic"
    : commandValue(
        selectedModel,
        Math.max((models ?? []).indexOf(selectedModel), 0),
      );
  const selectRoute = (nextRoute: ModelRoute | undefined) => {
    onRouteChange(nextRoute);
    onEffortChange("");
    close();
  };

  return (
    <Command
      className="model-selector__command"
      data-slot="model-selector-command"
      label="Search models"
      loop
      defaultValue={selectedCommandValue}
    >
      <h2 className="model-selector__title">Model and reasoning effort</h2>
      <div
        className="model-selector__search-wrapper"
        data-slot="model-selector-search-wrapper"
      >
        <Command.Input
          className="model-selector__search"
          data-slot="model-selector-search"
          placeholder="Search models…"
          aria-label="Search models"
        />
      </div>

      <Command.List
        className="model-selector__list"
        data-slot="model-selector-list"
        aria-label="Models"
      >
        <Command.Empty
          className="model-selector__empty"
          data-slot="model-selector-empty"
        >
          No models found.
        </Command.Empty>
        <Command.Group className="model-selector__group" data-slot="model-selector-group">
          <Command.Item
            value="automatic"
            keywords={["Automatic", "agent", "default"]}
            data-model-selected={selectedModel === undefined || undefined}
            className="model-selector__item"
            onSelect={() => selectRoute(undefined)}
          >
            <span className="model-selector__item-copy">
              <span className="model-selector__item-name">Automatic</span>
              <span className="model-selector__item-description">
                Use the agent default
              </span>
            </span>
            {selectedModel === undefined && <SelectedIndicator />}
          </Command.Item>

          {(models ?? []).map((model, index) => {
            const route = modelRoute(model);
            const selected =
              selectedModel?.runtime === model.runtime && selectedModel.id === model.id;
            return (
              <Command.Item
                value={commandValue(model, index)}
                keywords={[
                  modelName(model),
                  model.id,
                  model.runtime,
                ]}
                key={routeKey(route)}
                data-model-selected={selected || undefined}
                className="model-selector__item"
                onSelect={() => selectRoute(route)}
              >
                <span className="model-selector__item-copy">
                  <span className="model-selector__item-name">{modelName(model)}</span>
                  <span className="model-selector__item-description">
                    <span>{model.runtime}</span>
                    {model.contextWindow !== undefined && (
                      <span>{compactCount(model.contextWindow)} context</span>
                    )}
                  </span>
                </span>
                {selected && <SelectedIndicator />}
              </Command.Item>
            );
          })}
        </Command.Group>
      </Command.List>

      {models === undefined && (
        <p className="model-selector__catalog-note">Model catalog unavailable.</p>
      )}
      {models?.length === 0 && (
        <p className="model-selector__catalog-note">No explicit models advertised.</p>
      )}

      {effortModel !== undefined && (effortModel.efforts?.length ?? 0) > 0 && (
        <fieldset
          className="model-selector__effort"
          data-slot="model-selector-effort"
          onKeyDown={(event) => {
            // Keep native radio-group keyboard handling inside the effort
            // control instead of letting cmdk move or execute a model item.
            event.stopPropagation();
          }}
        >
          <legend className="model-selector__effort-label">Thinking</legend>
          <div
            className="model-selector__effort-options"
            role="radiogroup"
            aria-label="Reasoning effort"
          >
            {["", ...(effortModel.efforts ?? [])].map((option) => (
              <label
                key={option || "automatic"}
                className="model-selector__effort-option"
                data-slot="model-selector-effort-option"
              >
                <input
                  type="radio"
                  name={effortGroupId}
                  value={option}
                  checked={effort === option}
                  onChange={() => onEffortChange(option)}
                />
                <span>{effortLabel(option)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </Command>
  );
}

function SelectedIndicator() {
  return (
    <span
      className="model-selector__selected-indicator"
      data-slot="model-selector-selected-indicator"
      aria-hidden="true"
    >
      <Icon name="check" size={15} />
    </span>
  );
}
