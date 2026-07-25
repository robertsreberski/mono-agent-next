// SPDX-License-Identifier: MIT
import { Popover } from "@base-ui/react/popover";

import type { Telemetry } from "../../types";
import { Icon } from "../Icon";

const compactCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
};

const knownCount = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const knownWindow = (value: number | undefined): number | undefined => {
  const count = knownCount(value);
  return count !== undefined && count > 0 ? count : undefined;
};

/**
 * Reports only what the operator actually measured. A turn that never reported
 * context says so; it never falls back to a guess or a zero, because a zero
 * reads as a real measurement.
 */
export function ContextDisplay({
  telemetry,
  pending = false,
  modelContextWindow,
}: {
  readonly telemetry?: Telemetry;
  readonly pending?: boolean;
  readonly modelContextWindow?: number;
}) {
  const reportedWindow = knownWindow(telemetry?.contextWindow);
  const advertisedWindow = knownWindow(modelContextWindow);
  const contextWindow = reportedWindow ?? advertisedWindow;
  const contextUsed = pending ? undefined : knownCount(telemetry?.contextUsed);
  const percent = contextUsed === undefined || contextWindow === undefined
    ? undefined
    : Math.min(100, (contextUsed / contextWindow) * 100);
  const roundedPercent = percent === undefined ? undefined : Math.round(percent);

  return (
    <Popover.Root>
      <Popover.Trigger className="context-display-trigger" aria-label="Context usage">
        <Icon name="spark" size={14} className="context-display-icon" />
        <span className="context-display-trigger-state">
          {pending ? "Context pending" : contextUsed === undefined ? "Context" : compactCount(contextUsed)}
        </span>
        {roundedPercent !== undefined && (
          <span className="context-display-trigger-percent">{roundedPercent}%</span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="context-display-positioner" sideOffset={8} align="end">
          <Popover.Popup className="context-display-popover">
            <h2 className="context-display-title">Context usage</h2>

            {pending && (
              <p className="context-display-state-note">
                Exact context telemetry is not available for the active response yet.
              </p>
            )}
            {!pending && contextUsed === undefined && (
              <p className="context-display-unavailable">
                Exact context telemetry is not available for this conversation yet.
              </p>
            )}

            {percent !== undefined && contextWindow !== undefined && contextUsed !== undefined && (
              <div className="context-display-window">
                <div className="context-display-window-summary">
                  <span>{compactCount(contextUsed)} of {compactCount(contextWindow)} tokens</span>
                  <span className="context-display-percent">{roundedPercent}%</span>
                </div>
                <div
                  className="context-display-progress"
                  role="progressbar"
                  aria-label="Context window used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(percent.toFixed(1))}
                  aria-valuetext={`${compactCount(contextUsed)} of ${compactCount(contextWindow)} tokens`}
                >
                  <span className="context-display-progress-value" style={{ width: `${percent}%` }} />
                </div>
              </div>
            )}

            {telemetry !== undefined && (
              <dl className="context-display-breakdown">
                <div className="context-display-breakdown-row">
                  <dt>Input</dt><dd>{telemetry.inputTokens.toLocaleString()}</dd>
                </div>
                <div className="context-display-breakdown-row">
                  <dt>Output</dt><dd>{telemetry.outputTokens.toLocaleString()}</dd>
                </div>
                <div className="context-display-breakdown-row">
                  <dt>{reportedWindow === undefined && advertisedWindow !== undefined ? "Window (model)" : "Window"}</dt>
                  <dd>{contextWindow?.toLocaleString() ?? "Unavailable"}</dd>
                </div>
                <div className="context-display-breakdown-row">
                  <dt>Compaction</dt><dd>{telemetry.compacted ? "Applied" : "No"}</dd>
                </div>
                <div className="context-display-breakdown-row context-display-breakdown-total">
                  <dt>Session</dt><dd>{telemetry.sessionEvicted ? "Renewed" : "Retained"}</dd>
                </div>
              </dl>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
