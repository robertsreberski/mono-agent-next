import { useId } from "react";

import type { Telemetry } from "../../types";
import { Icon } from "../Icon";
import { Popover } from "../Popover";

export interface ContextDisplayProps {
  /** Current-turn telemetry only. Do not pass the preceding turn while pending. */
  readonly telemetry?: Telemetry;
  /** True until the active turn reports trustworthy current-turn context. */
  readonly pending?: boolean;
  /** Advertised window for the selected model, used only when telemetry omits it. */
  readonly modelContextWindow?: number;
  readonly unavailableReason?: string;
  readonly className?: string;
  readonly popoverId?: string;
}

const compactCount = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(value);
};

const knownCount = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const knownWindow = (value: number | undefined): number | undefined => {
  const count = knownCount(value);
  return count !== undefined && count > 0 ? count : undefined;
};

const joinClassNames = (...values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(" ");

export function ContextDisplay({
  telemetry,
  pending = false,
  modelContextWindow,
  unavailableReason,
  className,
  popoverId,
}: ContextDisplayProps) {
  const generatedId = useId().replaceAll(":", "");
  const reportedWindow = knownWindow(telemetry?.contextWindow);
  const advertisedWindow = knownWindow(modelContextWindow);
  const contextWindow = reportedWindow ?? advertisedWindow;
  const contextUsed = pending ? undefined : knownCount(telemetry?.contextUsed);
  const percent =
    contextUsed === undefined || contextWindow === undefined
      ? undefined
      : Math.min(100, (contextUsed / contextWindow) * 100);
  const roundedPercent = percent === undefined ? undefined : Math.round(percent);
  const triggerState = pending
    ? "Context pending"
    : contextUsed === undefined
      ? "Context unavailable"
      : `Context ${compactCount(contextUsed)}`;
  const trigger = (
    <>
      <Icon name="spark" size={14} className="context-display-icon" />
      <span className="context-display-trigger-tokens" data-slot="context-display-total">
        {triggerState}
      </span>
      {roundedPercent !== undefined && (
        <span className="context-display-trigger-percent" data-slot="context-display-percent">
          {roundedPercent}%
        </span>
      )}
      <Icon name="chevron" size={13} />
    </>
  );

  return (
    <Popover
      id={popoverId ?? `context-display-${generatedId}`}
      triggerLabel="Context usage"
      triggerClassName={joinClassNames("context-display-trigger", className)}
      panelClassName="context-display-popover"
      placement="bottom-end"
      trigger={trigger}
    >
      <div className="context-display-content" data-slot="context-display-content">
        <h2 className="context-display-title">Context usage</h2>

        {pending && (
          <p className="context-display-status" data-context-state="pending">
            Exact context telemetry is not available for the active response yet.
          </p>
        )}
        {!pending && contextUsed === undefined && (
          <p
            className="context-display-status"
            data-context-state="unavailable"
            data-slot="context-display-unavailable"
          >
            {unavailableReason
              ?? "Exact context telemetry is not available for this conversation yet."}
          </p>
        )}

        {percent !== undefined && contextWindow !== undefined && contextUsed !== undefined && (
          <div className="context-display-window" data-slot="context-display-window">
            <div className="context-display-window-summary">
              <span>
                {compactCount(contextUsed)} of {compactCount(contextWindow)} tokens
              </span>
              <span className="context-display-percent">{roundedPercent}%</span>
            </div>
            <div
              className="context-display-progress"
              role="progressbar"
              aria-label="Context window used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Number(percent.toFixed(1))}
              aria-valuetext={`${compactCount(contextUsed)} of ${compactCount(contextWindow)} tokens (${roundedPercent}%)`}
            >
              <span
                className="context-display-progress-value"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {(telemetry !== undefined || contextWindow !== undefined) && (
          <dl className="context-display-breakdown" data-slot="context-display-breakdown">
            {telemetry !== undefined && (
              <>
                <ContextRow label="Input" value={telemetry.inputTokens.toLocaleString()} />
                <ContextRow label="Output" value={telemetry.outputTokens.toLocaleString()} />
              </>
            )}
            <ContextRow
              label="Used"
              value={
                pending
                  ? "Pending"
                  : contextUsed === undefined
                    ? "Unavailable"
                    : contextUsed.toLocaleString()
              }
            />
            <ContextRow
              label={reportedWindow === undefined && advertisedWindow !== undefined
                ? "Window (model)"
                : "Window"}
              value={contextWindow?.toLocaleString() ?? "Unavailable"}
            />
            {telemetry !== undefined && (
              <>
                <ContextRow label="Compaction" value={telemetry.compacted ? "Applied" : "No"} />
                <ContextRow label="Session" value={telemetry.sessionEvicted ? "Renewed" : "Retained"} />
              </>
            )}
          </dl>
        )}
      </div>
    </Popover>
  );
}

function ContextRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="context-display-breakdown-row" data-slot="context-display-breakdown-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
