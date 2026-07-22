import { EFFORT_LEVELS } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

/** One enabled trigger (cron job / webhook endpoint) carrying override strings. */
export interface TriggerOverrideEntry {
  /** Display name for the issue message, e.g. `cron job "digest"`. */
  readonly name: string;
  readonly model?: string;
  readonly effort?: string;
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

/**
 * Validate per-trigger `model`/`effort` overrides with the same parsers the
 * runtime applies at run time (`request-model-override.ts`), but at
 * validate/load time — so a typo'd cron `model` fails `mono-agent validate`
 * before the 3am job silently falls back to the default. At run time an
 * invalid value is still warn-and-ignored; this check only moves the discovery
 * forward, it never changes run behavior.
 */
export function findTriggerOverrideIssues(
  entries: readonly TriggerOverrideEntry[],
): readonly string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    if (entry.model !== undefined) {
      try {
        parseMonoRuntimeModelReference(entry.model);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        issues.push(`${entry.name} has an invalid model override "${entry.model}": ${reason}`);
      }
    }
    if (entry.effort !== undefined && !EFFORT_SET.has(entry.effort)) {
      issues.push(
        `${entry.name} has an invalid effort override "${entry.effort}". Valid: ${[...EFFORT_SET].join(", ")}.`,
      );
    }
  }
  return issues;
}
