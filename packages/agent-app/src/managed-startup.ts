import type { TraceSourceListItem } from "@mono-agent/observability";

/**
 * Durable proof that the current worker completed its full app lifecycle.
 * `metadata.reason` is intentionally excluded: later trace publications use
 * that field for their own diagnostic reason without revoking readiness.
 */
export function hasCompletedManagedStartup(
  source: Pick<TraceSourceListItem, "metadata">,
): boolean {
  const lifecycle = source.metadata?.lifecycle;
  return lifecycle !== null
    && typeof lifecycle === "object"
    && (lifecycle as Record<string, unknown>).startupCompleted === true;
}
