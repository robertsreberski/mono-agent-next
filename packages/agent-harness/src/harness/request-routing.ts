import { deriveRunSource } from "@mono-agent/observability";
import {
  modelReferenceKey,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

import type { AgentHarnessRequest } from "../types.js";
import { isRecord } from "./value-utils.js";

export function createDefaultRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derives a run's `source` (and optional `sourceDetail`) from its request
 * metadata, for the recorder factory input. Priority order mirrors how each
 * channel/trigger stamps `request.metadata`:
 *  1. `metadata.source === "web"` or `"tui"` (the operator endpoint injects this)
 *  2. `metadata.cron` present → "cron", detail = `metadata.cron.jobId` (string)
 *  3. `metadata.webhook` present → "webhook", detail = `metadata.webhook.endpointName` (string)
 *  4. `metadata.slack` / `metadata.telegram` present → that channel name
 *  5. otherwise falls back to {@link deriveRunSource}'s conversationId-prefix
 *     derivation, so unrecognized/legacy metadata still gets a best-effort source.
 * Never throws — `metadata` is `Record<string, unknown> | undefined` and any
 * unexpected shape (e.g. `cron` not itself a record) just falls through.
 */
export function runSourceFromRequest(
  request: Pick<AgentHarnessRequest, "conversationId" | "metadata">,
): { readonly source?: string; readonly sourceDetail?: string } {
  const metadata = request.metadata;
  if (isRecord(metadata)) {
    if (metadata.source === "web") {
      return { source: "web" };
    }
    if (metadata.source === "tui") {
      return { source: "tui" };
    }
    if (isRecord(metadata.cron)) {
      const jobId = metadata.cron.jobId;
      return { source: "cron", ...(typeof jobId === "string" ? { sourceDetail: jobId } : {}) };
    }
    if (isRecord(metadata.webhook)) {
      const endpointName = metadata.webhook.endpointName;
      return { source: "webhook", ...(typeof endpointName === "string" ? { sourceDetail: endpointName } : {}) };
    }
    if (isRecord(metadata.slack)) {
      return { source: "slack" };
    }
    if (isRecord(metadata.telegram)) {
      return { source: "telegram" };
    }
  }
  return { source: deriveRunSource(request.conversationId) };
}

/**
 * A cron/proactive request carries a `cron` metadata block (set by the cron
 * scheduler when it fires a job). Used to scope the proactive-session-isolation
 * opt-in to scheduled runs without touching interactive turns.
 */
export function isCronRequest(request: AgentHarnessRequest): boolean {
  return isRecord(request.metadata) && request.metadata.cron !== undefined;
}

/**
 * Whether the request carries a per-turn MODEL override that resolves to a
 * model DIFFERENT from the harness default. The override may be pinned by a
 * trigger (`metadata.webhook`/`metadata.cron`) or picked interactively from the
 * web console (`metadata.web`), TUI (`metadata.tui`), or Telegram
 * (`metadata.telegram`). Only a different model
 * forces session isolation — it
 * runs on a different model (often a different runtime), and the provider session
 * is keyed by conversationId + bound to a model, so resuming or persisting it
 * against the shared session would mix two models' lineage (durable-session
 * corruption / wrong-runtime disposal).
 *
 * A SAME-MODEL override (e.g. an endpoint redundantly naming the host default)
 * leaves the runtime/model chain unchanged, so it must keep the shared continuous
 * session like an ordinary turn. An effort-only override carries no model string;
 * an unparseable string is ignored downstream (warn+ignore → the turn runs on the
 * default), so both are treated as "no model override" here. This keys off the
 * SAME canonical `modelReferenceKey` comparison the harness uses to decide whether
 * to switch runtimes (`sameRuntimeModel`), so the isolation decision and the
 * runtime/session-key decision can never disagree.
 */
export function requestOverridesModel(request: AgentHarnessRequest, defaultModel: RuntimeModelReference): boolean {
  const metadata = request.metadata;
  if (!isRecord(metadata)) {
    return false;
  }
  const source = isRecord(metadata.webhook)
    ? metadata.webhook
    : isRecord(metadata.cron)
      ? metadata.cron
      : isRecord(metadata.web)
        ? metadata.web
        : isRecord(metadata.tui)
          ? metadata.tui
          : isRecord(metadata.telegram)
            ? metadata.telegram
            : undefined;
  if (source === undefined || typeof source.model !== "string" || source.model.trim().length === 0) {
    return false;
  }
  try {
    return modelReferenceKey(parseMonoRuntimeModelReference(source.model)) !== modelReferenceKey(defaultModel);
  } catch {
    // An unparseable override is warned-and-ignored downstream, so the turn runs
    // on the default model — i.e. no model change, no isolation.
    return false;
  }
}
