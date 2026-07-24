import {
  MAX_RUN_MS,
  WebhookConfigError,
  parseWebhookMode,
  parseWebhookPath,
  type WebhookConfig,
} from "./config.js";
import { MAX_WEBHOOK_ROUTE_PROMPT_LENGTH } from "./limits.js";
import {
  MAX_WEBHOOK_ROUTES,
  MAX_WEBHOOK_ROUTE_BYTES,
  assertRoutesUnique,
  parseWebhookNotify,
  type WebhookRoute,
} from "./routes.js";

const MAX_ROUTE_IDENTIFIER_LENGTH = 512;

export function normalizeWebhookRoutes(
  config: WebhookConfig,
  supplied: readonly WebhookRoute[] | undefined,
): readonly WebhookRoute[] {
  if (config.routesDirectory !== undefined && supplied === undefined) {
    throw new Error("Webhook directory-backed config requires loaded routes.");
  }
  const candidates: readonly WebhookRoute[] = supplied ?? [Object.freeze({
    name: "default",
    path: config.path,
    mode: config.defaultMode,
    prompt: "",
    source: "config:path",
  })];
  if (candidates.length < 1 || candidates.length > MAX_WEBHOOK_ROUTES) {
    throw new Error(`Webhook channel requires between 1 and ${String(MAX_WEBHOOK_ROUTES)} routes.`);
  }
  const routes: WebhookRoute[] = [];
  for (const candidate of candidates) {
    let notify;
    try {
      notify = parseWebhookNotify(candidate.notify, "Webhook route notify");
    } catch (error: unknown) {
      if (error instanceof WebhookConfigError) throw error;
      throw new Error("Webhook route configuration is invalid.");
    }
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(candidate.name)
      || parseWebhookPath(candidate.path) !== candidate.path
      || parseWebhookMode(candidate.mode) !== candidate.mode
      || typeof candidate.prompt !== "string"
      || candidate.prompt.length > MAX_WEBHOOK_ROUTE_PROMPT_LENGTH
      || Buffer.byteLength(candidate.prompt, "utf8") > MAX_WEBHOOK_ROUTE_BYTES
      || (candidate.runtime !== undefined && !validRouteString(candidate.runtime))
      || (candidate.model !== undefined && !validRouteString(candidate.model))
      || (candidate.effort !== undefined && !validRouteString(candidate.effort))
      || (candidate.maxRunMs !== undefined
        && (!Number.isSafeInteger(candidate.maxRunMs)
          || candidate.maxRunMs < 1
          || candidate.maxRunMs > MAX_RUN_MS))
    ) {
      throw new Error("Webhook route configuration is invalid.");
    }
    routes.push(Object.freeze({
      ...candidate,
      ...(notify === undefined ? {} : { notify }),
    }));
  }
  assertRoutesUnique(routes);
  return Object.freeze(routes);
}

function validRouteString(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_ROUTE_IDENTIFIER_LENGTH
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
