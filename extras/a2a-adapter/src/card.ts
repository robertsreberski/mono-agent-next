import type { AgentCard, AgentProvider, AgentSkill } from "@a2a-js/sdk";

import { A2AProviderError } from "./errors.js";
import {
  A2A_IDEMPOTENCY_EXTENSION_URI,
  A2A_IDEMPOTENCY_METADATA_KEY,
  A2A_IDEMPOTENCY_SCHEMA_VERSION,
} from "./idempotency.js";

export interface A2AAgentSkillOptions {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly examples?: readonly string[];
}

export interface A2AAgentCardOptions {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly publicBaseUrl: string;
  readonly requireBearer?: boolean;
  readonly provider?: {
    readonly organization: string;
    readonly url: string;
  };
  readonly skill: A2AAgentSkillOptions;
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  /** Advertise only when this provider has a durable idempotency stateDir. */
  readonly durableIdempotency?: boolean;
}

export function createA2AAgentCard(options: A2AAgentCardOptions): AgentCard {
  const publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl);
  const provider = providerFromOptions(options.provider);
  const skill = skillFromOptions(options.skill);
  const securitySchemes: AgentCard["securitySchemes"] = {};
  const securityRequirements: AgentCard["securityRequirements"] = [];

  if (options.requireBearer === true) {
    securitySchemes.bearer = {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: {
          description: "Bearer token required for A2A message and task endpoints.",
          scheme: "Bearer",
          bearerFormat: "opaque",
        },
      },
    };
    securityRequirements.push({ schemes: { bearer: { list: [] } } });
  }

  return {
    name: requireNonEmpty(options.name, "agent.name"),
    description: requireNonEmpty(options.description, "agent.description"),
    supportedInterfaces: [
      {
        url: `${publicBaseUrl}/a2a/json-rpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
      {
        url: `${publicBaseUrl}/a2a/rest`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "",
      },
    ],
    provider,
    version: requireNonEmpty(options.version, "agent.version"),
    ...(options.documentationUrl === undefined ? {} : { documentationUrl: options.documentationUrl }),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: options.durableIdempotency === true
        ? [
            {
              uri: A2A_IDEMPOTENCY_EXTENSION_URI,
              description: "Mono-agent stable logical dispatch idempotency with conflict detection and fail-closed restart recovery.",
              required: false,
              params: {
                schemaVersion: A2A_IDEMPOTENCY_SCHEMA_VERSION,
                metadataKey: A2A_IDEMPOTENCY_METADATA_KEY,
                activeAfterRestart: "idempotency_in_doubt",
              },
            },
          ]
        : [],
      extendedAgentCard: false,
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [skill],
    signatures: [],
    ...(options.iconUrl === undefined ? {} : { iconUrl: options.iconUrl }),
  };
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = requireNonEmpty(value, "publicBaseUrl");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new A2AProviderError("invalid_config", "A2A publicBaseUrl must be an absolute URL.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/u, "");
}

export function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new A2AProviderError(
      "missing_required_config",
      `A2A ${field} is required.`,
      { field },
    );
  }
  return trimmed;
}

function providerFromOptions(
  provider: A2AAgentCardOptions["provider"],
): AgentProvider | undefined {
  if (provider === undefined) {
    return undefined;
  }
  return {
    organization: requireNonEmpty(provider.organization, "provider.organization"),
    url: requireNonEmpty(provider.url, "provider.url"),
  };
}

function skillFromOptions(skill: A2AAgentSkillOptions): AgentSkill {
  return {
    id: requireNonEmpty(skill.id, "skill.id"),
    name: requireNonEmpty(skill.name, "skill.name"),
    description: requireNonEmpty(skill.description, "skill.description"),
    tags: [...(skill.tags ?? [])],
    examples: [...(skill.examples ?? [])],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    securityRequirements: [],
  };
}
