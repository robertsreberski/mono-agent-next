import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { MonoAgentConfigJson } from "@mono-agent/config";
import type { SettingsJsonValue } from "@mono-agent/agent-contracts";

export const DEFAULT_FINAL_DEMO_DEPLOY_MODEL = "gemma4:31b";
export const DEFAULT_FINAL_DEMO_DEPLOY_MODEL_REFERENCE = "pi:ollama:gemma4:31b";
export const DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_FINAL_DEMO_DEPLOY_CONFIG_PATH = ".mono-agent/deploy/final-agent-gemma4.config.json";

const DEPLOY_WORKSPACE_DIR = "./.mono-agent/deploy/workspace";
// Memory v2: `memory.path` is a root *directory* (holds memory.db + daily/), not a markdown file.
const DEPLOY_MEMORY_PATH = "./.mono-agent/deploy/memory";
const DEPLOY_ARTIFACT_DIR = "./.mono-agent/deploy/artifacts";
const DEPLOY_TRACE_REGISTRY_DIR = "./.mono-agent/trace-sources";
const DEPLOY_TRACE_SOURCE_ID = "final-agent-gemma4";
const DEPLOY_TRACE_SOURCE_LABEL = "Final Agent Demo (Gemma 4)";

export type OllamaReadiness =
  | { readonly kind: "ready"; readonly model: string; readonly baseUrl: string }
  | { readonly kind: "server_unavailable"; readonly model: string; readonly baseUrl: string; readonly reason: string }
  | { readonly kind: "model_missing"; readonly model: string; readonly baseUrl: string; readonly availableModels: readonly string[] };

export interface FinalDemoDeploymentOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly ollamaBaseUrl?: string;
  readonly configPath?: string;
  readonly a2aPort?: number;
}

export interface CheckOllamaModelOptions {
  readonly model?: string;
  readonly ollamaBaseUrl?: string;
}

export interface FinalDemoDeploymentFiles {
  readonly configPath: string;
  readonly memoryPath: string;
  readonly workspaceDir: string;
  readonly artifactDir: string;
  readonly traceRegistryDir: string;
}

export type FinalDemoDeploymentConfig = MonoAgentConfigJson & {
  readonly channels: {
    readonly plugins: readonly [{
      readonly package: "@mono-agent/a2a-adapter";
      readonly config: {
        readonly provider: {
          readonly enabled: true;
          readonly host: "127.0.0.1";
          readonly port: number;
        };
        readonly agent: {
          readonly name: string;
          readonly description: string;
          readonly version: string;
        };
        readonly skill: {
          readonly id: string;
          readonly name: string;
          readonly description: string;
          readonly tags: readonly string[];
        };
        readonly consumer: {
          readonly remoteAgentUrls: readonly string[];
          readonly timeoutMs: number;
        };
      };
    }];
  };
};

export function buildFinalDemoDeploymentConfig(
  options: FinalDemoDeploymentOptions,
): FinalDemoDeploymentConfig {
  const model = normalizeModel(options.model);
  const ollamaBaseUrl = normalizeBaseUrl(options.ollamaBaseUrl);
  const modelReference = modelReferenceFor(model);
  return {
    runtime: {
      model: modelReference,
      executionMode: "sdk",
      workspace: DEPLOY_WORKSPACE_DIR,
      session: { mode: "continuous", idleTimeoutMs: 1_800_000 },
    },
    providers: {
      local: [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: ollamaBaseUrl,
          enabled: true,
          models: [
            {
              name: model,
              displayName: displayNameForModel(model),
              capabilities: capabilitiesForModel(model),
            },
          ],
        },
      ],
    },
    context: {
      identityPath: "./demos/final-agent/IDENTITY.example.md",
      selectedSkills: [],
    },
    memory: {
      mode: "lite",
      path: DEPLOY_MEMORY_PATH,
      maxBytes: 64_000,
      writeMode: "disabled",
    },
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: DEPLOY_ARTIFACT_DIR,
    },
    traceability: {
      registryDir: DEPLOY_TRACE_REGISTRY_DIR,
      sourceId: DEPLOY_TRACE_SOURCE_ID,
      sourceLabel: DEPLOY_TRACE_SOURCE_LABEL,
      heartbeatMs: 10_000,
      staleAfterMs: 30_000,
    },
    channels: {
      plugins: [{
        package: "@mono-agent/a2a-adapter",
        config: {
          provider: {
            enabled: true,
            host: "127.0.0.1",
            port: options.a2aPort ?? 0,
          },
          agent: {
            name: "Final Agent Demo (Gemma 4)",
            description: "Local final demo deployed with Ollama Gemma 4.",
            version: "0.1.0",
          },
          skill: {
            id: "final-agent-gemma4",
            name: "Final Agent Demo",
            description: "Runs the configured final demo runtime over local A2A text requests.",
            tags: ["agent", "a2a", "gemma4", "ollama"],
          },
          consumer: {
            remoteAgentUrls: [],
            timeoutMs: 30_000,
          },
        },
      }],
    },
  };
}

export async function checkOllamaModel(
  options: CheckOllamaModelOptions = {},
): Promise<OllamaReadiness> {
  const model = normalizeModel(options.model);
  const baseUrl = normalizeBaseUrl(options.ollamaBaseUrl);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/tags`);
  } catch (error) {
    return {
      kind: "server_unavailable",
      model,
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      kind: "server_unavailable",
      model,
      baseUrl,
      reason: `Ollama returned HTTP ${response.status}.`,
    };
  }

  try {
    const parsed = await response.json() as unknown;
    const availableModels = modelNamesFromTagsResponse(parsed);
    if (availableModels.includes(model)) {
      return { kind: "ready", model, baseUrl };
    }
    return { kind: "model_missing", model, baseUrl, availableModels };
  } catch (error) {
    return {
      kind: "server_unavailable",
      model,
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function writeFinalDemoDeploymentFiles(
  options: FinalDemoDeploymentOptions,
): Promise<FinalDemoDeploymentFiles> {
  const cwd = resolve(options.cwd);
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_FINAL_DEMO_DEPLOY_CONFIG_PATH);
  const memoryPath = resolve(cwd, DEPLOY_MEMORY_PATH);
  const workspaceDir = resolve(cwd, DEPLOY_WORKSPACE_DIR);
  const artifactDir = resolve(cwd, DEPLOY_ARTIFACT_DIR);
  const traceRegistryDir = resolve(cwd, DEPLOY_TRACE_REGISTRY_DIR);
  const config = buildFinalDemoDeploymentConfig(options);

  await Promise.all([
    mkdir(dirname(configPath), { recursive: true }),
    // memoryPath is now the memory root directory itself; the engine creates memory.db inside it.
    mkdir(memoryPath, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(artifactDir, { recursive: true }),
    mkdir(traceRegistryDir, { recursive: true }),
  ]);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8" });
  return { configPath, memoryPath, workspaceDir, artifactDir, traceRegistryDir };
}

export function modelReferenceFor(model: string): string {
  return `pi:ollama:${normalizeModel(model)}`;
}

function normalizeModel(value: string | undefined): string {
  const normalized = value?.trim() ?? DEFAULT_FINAL_DEMO_DEPLOY_MODEL;
  if (normalized.length === 0) {
    return DEFAULT_FINAL_DEMO_DEPLOY_MODEL;
  }
  return normalized;
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = value?.trim() ?? DEFAULT_FINAL_DEMO_OLLAMA_BASE_URL;
  return normalized.replace(/\/+$/u, "");
}

function displayNameForModel(model: string): string {
  if (model === DEFAULT_FINAL_DEMO_DEPLOY_MODEL) {
    return "Gemma 4 31B";
  }
  return model;
}

function capabilitiesForModel(model: string): Record<string, SettingsJsonValue> {
  if (model.startsWith("gemma4:")) {
    return {
      family: "gemma4",
      context_window: 256_000,
      reasoning: true,
      reasoning_mode: "toggle",
      vision: true,
      json_mode: true,
    };
  }
  return {
    family: model.split(":")[0] ?? "ollama",
    reasoning: true,
    reasoning_mode: "toggle",
    json_mode: true,
  };
}

function modelNamesFromTagsResponse(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }
  const names: string[] = [];
  for (const item of value.models) {
    if (!isRecord(item)) {
      continue;
    }
    const name = typeof item.name === "string"
      ? item.name
      : typeof item.model === "string"
        ? item.model
        : undefined;
    if (name !== undefined && name.trim().length > 0) {
      names.push(name.trim());
    }
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
