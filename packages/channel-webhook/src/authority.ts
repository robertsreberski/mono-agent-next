import { isIP } from "node:net";
import { hostname as systemHostname } from "node:os";

import { isLoopbackHost, type WebhookConfig } from "./config.js";

export function assertWebhookStartSafety(config: WebhookConfig): void {
  if (!isLoopbackHost(config.listen.host) && config.allowNonLoopback !== true) {
    throw new Error("The HTTP webhook channel may bind outside loopback only with explicit allowNonLoopback.");
  }
  if (
    typeof config.apiKey !== "string" ||
    config.apiKey.length === 0 ||
    config.apiKey.length > 4_096 ||
    /\s/u.test(config.apiKey)
  ) {
    throw new Error("Webhook API key is required and must be a non-empty bearer token.");
  }
  if (
    !isLoopbackHost(config.listen.host)
    && (
      config.apiKey.length < 32
      || typeof config.signatureSecret !== "string"
      || config.signatureSecret.length < 32
      || config.signatureSecret.length > 4_096
      || /\s/u.test(config.signatureSecret)
    )
  ) {
    throw new Error("A non-loopback webhook listener requires bearer and signature secrets of at least 32 characters.");
  }
}

export function isWebhookAuthorityAllowed(
  value: string | undefined,
  configuredHost: string,
  port: number,
): boolean {
  if (value === undefined) return false;
  let authority: URL;
  try {
    authority = new URL(`http://${value}`);
  } catch {
    return false;
  }
  if (
    authority.username !== ""
    || authority.password !== ""
    || authority.pathname !== "/"
    || authority.search !== ""
    || authority.hash !== ""
    || Number(authority.port || "80") !== port
  ) {
    return false;
  }
  const candidate = normalizeHost(authority.hostname);
  const configured = normalizeHost(configuredHost);
  if (configured === "0.0.0.0" || configured === "::") {
    return isLocalNetworkHost(candidate);
  }
  return isLoopbackHost(configured)
    ? isLoopbackHost(candidate)
    : candidate === configured;
}

export function webhookHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isLocalNetworkHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  const machine = systemHostname().toLowerCase();
  if (host === machine || host === `${machine}.local`) return true;
  if (isIP(host) === 4) {
    const [a = -1, b = -1] = host.split(".").map(Number);
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && (/^(?:fc|fd)/u.test(host) || /^fe[89ab]/u.test(host));
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/gu, "");
}
