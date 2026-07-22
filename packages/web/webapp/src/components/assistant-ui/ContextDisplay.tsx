"use client";

import { Popover } from "@base-ui/react/popover";
import type { CSSProperties, ReactNode } from "react";
import type { ConsoleContextProjection } from "../../usage";
import { Icon } from "../Icon";

export interface ContextDisplayUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
}

export interface ContextDisplayProps {
  readonly context: ConsoleContextProjection;
  readonly processed?: ContextDisplayUsage;
  readonly conversationCost?: number;
  readonly className?: string;
}

interface ContextSegment {
  readonly key: keyof ContextDisplayUsage;
  readonly label: string;
  readonly tokens: number;
}

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(tokens);
};

const formatUsd = (cost: number): string => {
  const precision = cost > 0 && cost < 0.01 ? 4 : 2;
  return `$${cost.toFixed(precision)}`;
};

const tokenCount = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const knownCost = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const knownContextWindow = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
};

const joinClassNames = (...values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(" ");

const usageSegments = (usage: ContextDisplayUsage | undefined): ContextSegment[] => {
  const segments: ContextSegment[] = [
    { key: "input", label: "Input", tokens: tokenCount(usage?.input) },
    { key: "cachedInput", label: "Cache read", tokens: tokenCount(usage?.cachedInput) },
    { key: "cacheCreation", label: "Cache write", tokens: tokenCount(usage?.cacheCreation) },
    { key: "output", label: "Output", tokens: tokenCount(usage?.output) },
    { key: "reasoning", label: "Reasoning", tokens: tokenCount(usage?.reasoning) },
  ];
  return segments.filter((segment) => segment.tokens > 0);
};

const processedTotal = (usage: ContextDisplayUsage | undefined): number =>
  tokenCount(usage?.input) +
  tokenCount(usage?.cachedInput) +
  tokenCount(usage?.cacheCreation) +
  tokenCount(usage?.output);

function Breakdown({
  usage,
  total,
  totalLabel = "Total",
}: {
  readonly usage: ContextDisplayUsage | undefined;
  readonly total: number;
  readonly totalLabel?: string;
}) {
  return (
    <dl className="context-display-breakdown" data-slot="context-display-breakdown">
      {usageSegments(usage).map((segment) => (
        <div
          className="context-display-breakdown-row"
          data-slot="context-display-breakdown-row"
          data-segment={segment.key}
          key={segment.key}
        >
          <dt>{segment.label}</dt>
          <dd>{formatTokenCount(segment.tokens)}</dd>
        </div>
      ))}
      <div className="context-display-breakdown-row context-display-breakdown-total">
        <dt>{totalLabel}</dt>
        <dd>{formatTokenCount(total)}</dd>
      </div>
    </dl>
  );
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return <h3 className="context-display-section-title">{children}</h3>;
}

export function ContextDisplay({
  context,
  processed,
  conversationCost,
  className,
}: ContextDisplayProps) {
  const usage = context.usage;
  const totalTokens = tokenCount(usage?.total);
  const cost = knownCost(conversationCost);
  const windowTokens = knownContextWindow(usage?.contextWindow);
  const percent = usage === undefined || windowTokens === undefined
    ? undefined
    : Math.min((totalTokens / windowTokens) * 100, 100);
  const roundedPercent = percent === undefined ? undefined : Math.round(percent);
  const statusLabel = context.status === "updating"
    ? "Updating"
    : context.status === "awaiting_measurement"
      ? "Awaiting"
      : context.status === "last_measured"
        ? "Last measured"
        : undefined;
  const triggerContext = usage === undefined
    ? context.status === "updating"
      ? "updating"
      : context.status === "awaiting_measurement"
        ? "awaiting provider measurement"
        : "unavailable"
    : [
        `${formatTokenCount(totalTokens)} tokens`,
        ...(statusLabel === undefined ? [] : [statusLabel.toLowerCase()]),
        ...(roundedPercent === undefined ? [] : [`${roundedPercent}%`]),
      ].join(", ");
  const triggerSummary = [triggerContext, ...(cost === undefined ? [] : [formatUsd(cost)])].join(", ");
  const sectionTitle = context.status === "current"
    ? "Current context"
    : context.status === "updating"
      ? "Latest provider measurement"
      : "Last measured";
  const sectionAriaLabel = sectionTitle;

  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        className={joinClassNames("context-display-trigger", className)}
        data-slot="context-display-trigger"
        aria-label={`Context usage: ${triggerSummary}`}
      >
        <Icon name="spark" size={14} className="context-display-icon" />
        <span className="context-display-trigger-tokens" data-slot="context-display-total">
          {usage === undefined
            ? context.status === "updating" ? "Context updating…" : "Context —"
            : `Context ${formatTokenCount(totalTokens)}`}
        </span>
        {statusLabel !== undefined && (
          <span className="context-display-trigger-state" data-state={context.status}>
            {statusLabel}
          </span>
        )}
        {roundedPercent !== undefined && (
          <span className="context-display-trigger-percent" data-slot="context-display-percent">
            {roundedPercent}%
          </span>
        )}
        {cost !== undefined && (
          <span className="context-display-trigger-cost" data-slot="context-display-cost">
            {formatUsd(cost)}
          </span>
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner className="context-display-positioner" side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="context-display-popover">
            <Popover.Title className="context-display-title">Context usage</Popover.Title>

            {usage === undefined ? (
              <p className="context-display-unavailable" data-slot="context-display-unavailable">
                {context.reason ?? "Exact context usage has not been reported for this conversation."}
              </p>
            ) : (
              <section className="context-display-section" aria-label={sectionAriaLabel}>
                <SectionTitle>{sectionTitle}</SectionTitle>
                {context.reason !== undefined && context.status !== "current" && (
                  <p className="context-display-state-note">{context.reason}</p>
                )}
                {(context.measuredModel ?? usage.model) !== undefined && (
                  <p className="context-display-model">
                    <span>Measured model</span>
                    <code>{context.measuredModel ?? usage.model}</code>
                  </p>
                )}
                {windowTokens !== undefined && percent !== undefined && roundedPercent !== undefined && (
                  <div className="context-display-window" data-slot="context-display-window">
                    <div className="context-display-window-summary">
                      <span>{formatTokenCount(totalTokens)} of {formatTokenCount(windowTokens)} tokens</span>
                      <span className="context-display-percent">{roundedPercent}%</span>
                    </div>
                    <div
                      className="context-display-progress"
                      role="progressbar"
                      aria-label="Context window used"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Number(percent.toFixed(1))}
                      aria-valuetext={`${formatTokenCount(totalTokens)} of ${formatTokenCount(windowTokens)} tokens (${roundedPercent}%)`}
                    >
                      <span className="context-display-progress-value" style={{ width: `${percent}%` } as CSSProperties} />
                    </div>
                  </div>
                )}
                <Breakdown usage={usage} total={totalTokens} />
              </section>
            )}

            {processed !== undefined && (
              <section className="context-display-section" aria-label="Last turn processed">
                <SectionTitle>Last turn processed</SectionTitle>
                <Breakdown usage={processed} total={processedTotal(processed)} totalLabel="Processed total" />
              </section>
            )}

            {cost !== undefined && (
              <dl className="context-display-breakdown context-display-cost-breakdown">
                <div className="context-display-breakdown-row context-display-breakdown-cost">
                  <dt>Conversation cost</dt>
                  <dd>{formatUsd(cost)}</dd>
                </div>
              </dl>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
