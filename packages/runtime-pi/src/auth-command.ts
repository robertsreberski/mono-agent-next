// SPDX-License-Identifier: MIT
import { isProxy } from "node:util/types";

import type {
  CredentialInfo,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  ModuleCommand,
} from "@mono-agent/module-sdk";

const ACTIONS = ["status", "models", "login"] as const;
const INPUT_KEYS = new Set(["action", "provider", "refresh"]);
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_STATUS_PROVIDERS = 128;
const MAX_MODEL_REFERENCES = 1_024;
const MAX_REFRESH_ERRORS = 128;

type RuntimePiAuthAction = (typeof ACTIONS)[number];

interface RuntimePiAuthCommandInput {
  readonly action: RuntimePiAuthAction;
  readonly provider?: string;
  readonly refresh: boolean;
}

export const runtimePiAuthCommandInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    action: { enum: ACTIONS, default: "status" },
    provider: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]{0,63}$",
    },
    refresh: { type: "boolean", default: false },
  },
});

export function createRuntimePiAuthCommands(
  credentials: Pick<CredentialStore, "list">,
  models: Models,
): readonly ModuleCommand[] {
  return Object.freeze([{
    name: "pi:auth",
    kind: "authentication",
    description:
      "Inspect redacted Pi credential status, discover bounded models, or report interactive login support.",
    inputSchema: runtimePiAuthCommandInputSchema,
    async run(input, context): Promise<JsonValue> {
      throwIfAborted(context.signal);
      const parsed = parseInput(input);
      if (parsed.action === "login") return loginUnsupported(parsed.provider);
      if (parsed.action === "models") {
        return await modelStatus(models, parsed, context.signal);
      }
      return await authStatus(credentials, models, parsed.provider, context.signal);
    },
  }] satisfies readonly ModuleCommand[]);
}

async function authStatus(
  credentials: Pick<CredentialStore, "list">,
  models: Models,
  requestedProvider: string | undefined,
  signal: AbortSignal,
): Promise<JsonValue> {
  let degraded = false;
  let listedCredentials: readonly CredentialInfo[] = [];
  try {
    listedCredentials = await credentials.list();
  } catch {
    degraded = true;
  }
  throwIfAborted(signal);

  const credentialTypes = new Map<string, CredentialInfo["type"]>();
  for (const credential of listedCredentials) {
    const providerId = ownProviderId(credential, "providerId");
    const type = ownCredentialType(credential);
    if (providerId === undefined || type === undefined) {
      degraded = true;
      continue;
    }
    credentialTypes.set(providerId, type);
  }

  let registeredProviders: readonly unknown[] = [];
  try {
    registeredProviders = models.getProviders();
  } catch {
    degraded = true;
  }
  const registeredIds = new Set<string>();
  for (const provider of registeredProviders) {
    const providerId = ownProviderId(provider, "id");
    if (providerId === undefined) {
      degraded = true;
      continue;
    }
    registeredIds.add(providerId);
  }

  const selected = [...registeredIds]
    .filter((providerId) =>
      requestedProvider === undefined || providerId === requestedProvider)
    .sort(compareText);
  const truncated = selected.length > MAX_STATUS_PROVIDERS;
  const providers = selected.slice(0, MAX_STATUS_PROVIDERS).map((providerId) => ({
    provider: providerId,
    registered: registeredIds.has(providerId),
    credential: credentialTypes.get(providerId) ?? "none",
    modelCount: boundedModelCount(models, providerId),
  }));

  return {
    action: "status",
    status: degraded ? "degraded" : "ready",
    ...(requestedProvider === undefined ? {} : { provider: requestedProvider }),
    providers,
    unregisteredCredentials: [...credentialTypes.keys()]
      .filter((providerId) => !registeredIds.has(providerId))
      .length,
    truncated,
    ...(degraded
      ? {
          code: "auth_status_unavailable",
          message: "Pi authentication status is partially unavailable.",
        }
      : {}),
  };
}

async function modelStatus(
  models: Models,
  input: RuntimePiAuthCommandInput,
  signal: AbortSignal,
): Promise<JsonValue> {
  let degraded = false;
  const errors: Array<{ provider: string; code: "model_discovery_failed" }> = [];
  if (input.refresh) {
    try {
      const result = await models.refresh({
        allowNetwork: true,
        force: true,
        signal,
      });
      throwIfAborted(signal);
      for (const providerId of result.errors.keys()) {
        if (!PROVIDER_ID.test(providerId)) {
          degraded = true;
          continue;
        }
        if (input.provider !== undefined && providerId !== input.provider) continue;
        if (errors.length < MAX_REFRESH_ERRORS) {
          errors.push({ provider: providerId, code: "model_discovery_failed" });
        }
        degraded = true;
      }
      if (result.errors.size > errors.length) degraded = true;
    } catch {
      throwIfAborted(signal);
      degraded = true;
    }
  }

  let catalog: readonly unknown[] = [];
  try {
    catalog = models.getModels(input.provider);
  } catch {
    degraded = true;
  }
  const references = new Set<string>();
  const inspectionLimit = Math.min(catalog.length, MAX_MODEL_REFERENCES + 1);
  for (let index = 0; index < inspectionLimit; index += 1) {
    const model = catalog[index];
    const providerId = ownProviderId(model, "provider");
    const modelId = ownModelId(model);
    if (providerId === undefined || modelId === undefined) {
      degraded = true;
      continue;
    }
    references.add(`${providerId}:${modelId}`);
  }
  const sorted = [...references].sort(compareText);
  const truncated = catalog.length > MAX_MODEL_REFERENCES
    || sorted.length > MAX_MODEL_REFERENCES;

  return {
    action: "models",
    status: degraded ? "degraded" : "ready",
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    refresh: input.refresh ? "requested" : "not-requested",
    total: catalog.length,
    models: sorted.slice(0, MAX_MODEL_REFERENCES),
    truncated,
    ...(errors.length === 0 ? {} : { errors }),
    ...(degraded
      ? {
          code: "model_discovery_unavailable",
          message: "Pi model discovery is partially unavailable.",
        }
      : {}),
  };
}

function loginUnsupported(provider: string | undefined): JsonValue {
  return {
    action: "login",
    status: "unsupported",
    ...(provider === undefined ? {} : { provider }),
    code: "interactive_login_unavailable",
    message: "Interactive Pi login is unavailable through module commands.",
  };
}

function parseInput(value: unknown): RuntimePiAuthCommandInput {
  const input = value === undefined ? {} : value;
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || isProxy(input)
    || (
      Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null
    )
  ) {
    invalid("Pi auth command input must be a plain object.");
  }

  const parsed: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !INPUT_KEYS.has(key)) {
      invalid("Pi auth command input contains an unknown field.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(`Pi auth command input.${key} must be an enumerable own data property.`);
    }
    parsed[key] = descriptor.value;
  }

  const action = parsed.action === undefined ? "status" : parsed.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as RuntimePiAuthAction)) {
    invalid(`Pi auth command action must be one of ${ACTIONS.join(", ")}.`);
  }
  const provider = parsed.provider;
  if (provider !== undefined && (typeof provider !== "string" || !PROVIDER_ID.test(provider))) {
    invalid("Pi auth command provider must be a bounded provider id.");
  }
  const refresh = parsed.refresh === undefined ? false : parsed.refresh;
  if (typeof refresh !== "boolean") {
    invalid("Pi auth command refresh must be a boolean.");
  }
  if (action !== "models" && Object.hasOwn(parsed, "refresh")) {
    invalid("Pi auth command refresh is supported only for the models action.");
  }
  return {
    action: action as RuntimePiAuthAction,
    ...(provider === undefined ? {} : { provider }),
    refresh,
  };
}

function ownProviderId(
  value: unknown,
  key: "id" | "provider" | "providerId",
): string | undefined {
  const candidate = ownDataValue(value, key);
  return typeof candidate === "string" && PROVIDER_ID.test(candidate)
    ? candidate
    : undefined;
}

function ownModelId(value: unknown): string | undefined {
  const candidate = ownDataValue(value, "id");
  return typeof candidate === "string"
    && candidate.length > 0
    && Buffer.byteLength(candidate, "utf8") <= 256
    && candidate.trim() === candidate
    && !/[\u0000-\u001f\u007f]/u.test(candidate)
    ? candidate
    : undefined;
}

function ownCredentialType(value: unknown): CredentialInfo["type"] | undefined {
  const candidate = ownDataValue(value, "type");
  return candidate === "api_key" || candidate === "oauth" ? candidate : undefined;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (
    (typeof value !== "object" && typeof value !== "function")
    || value === null
    || isProxy(value)
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function boundedModelCount(models: Models, providerId: string): number {
  try {
    return Math.min(models.getModels(providerId).length, Number.MAX_SAFE_INTEGER);
  } catch {
    return 0;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function invalid(message: string): never {
  throw new TypeError(message);
}
